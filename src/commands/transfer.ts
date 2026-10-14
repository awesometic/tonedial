// Import and export complete profiles, retaining support for older axis-only presets.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CommandResult, Ctx } from "../cli.ts";
import { ConfigError } from "../core/config.ts";
import { decodeUtf8, getBounded, urlIdentity } from "../core/net.ts";
import { truncate } from "../ui/width.ts";
import { humanText, nextStep } from "../ui/format.ts";
import {
  BUNDLED, PRESET_MAX_BYTES, SLUG_PATTERN, inspectPresetLibrary, parsePreset, presetObject, preparePresetWrite, resolvePreset, serializePreset,
} from "../core/presets.ts";
import { applyPlanned } from "./compile.ts";
import { planChange, rawReadChange, rawReadCheck } from "../wiring/apply.ts";

export function runExport(ctx: Ctx, args: string[]): CommandResult {
  const [slug] = args;
  if (!slug) throw new ConfigError(ctx.t.preset.needsSlugArg);
  const library = inspectPresetLibrary(ctx.paths.presets, ctx.t);
  const preset = resolvePreset(ctx.paths.presets, slug, ctx.t, library)?.preset;
  if (!preset) {
    throw new ConfigError(
      ctx.t.preset.unknown(slug, library.entries.map((entry) => entry.preset.slug)),
    );
  }
  const text = serializePreset(preset);
  return {
    lines: [text.trimEnd()],
    json: { slug: preset.slug, preset: JSON.parse(text) as unknown },
  };
}

/**
 * The most a preset may weigh. Ten hand-written ones run under a kilobyte; this is three orders
 * of magnitude of headroom and still small enough that nothing unbounded is ever buffered.
 */
export const IMPORT_MAX_BYTES = PRESET_MAX_BYTES;

/** How long to wait for a preset that is not on this machine. */
export const IMPORT_TIMEOUT_MS = 10_000;

/**
 * Fetch a preset over https.
 *
 * This read happens because a user typed a URL. The compile step has none and gains none —
 * `TONE.md` is still lookup and concatenation, still needs no key.
 *
 * Three bounds, each for a reason rather than for tidiness. **https only**, because a preset is
 * a file the user keeps and reads back for months. **The protocol re-checked after redirects**,
 * because `fetch` follows them and an https URL that lands on http is an https URL in name only.
 * **A size cap**, because the alternative is buffering whatever the other end sends.
 */
export async function fetchPreset(url: URL, t: Ctx["t"]): Promise<string> {
  // **https of what a user pastes**, which `getBounded` does not require of every caller — the
  // registry is a configured endpoint and an internal mirror over http is its operator's choice.
  // A preset is a file the user keeps and reads back for months.
  if (url.protocol !== "https:") throw new ConfigError(t.config.insecureUrl(urlIdentity(url.href, t)));
  return decodeUtf8(
    await getBounded(url.href, { maxBytes: IMPORT_MAX_BYTES, timeoutMs: IMPORT_TIMEOUT_MS }, t),
    t,
  );
}


/** A URL if this names one, `null` for a file; malformed URL syntax must not fall back to disk. */
export function asUrl(source: string): URL | null {
  // **`://`, not just a scheme.** A colon alone made `C:\\presets\\p.json` a URL with a
  // one-letter scheme, and requiring two characters before it still caught `dir:name/p.json`
  // and a file literally called `https:x.json` — colons are legal in POSIX filenames, and the
  // second of those went out as a real request to a host called `x.json`.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source.trimStart())) return null;
  return new URL(source);
}

export async function runImport(ctx: Ctx, args: string[]): Promise<CommandResult> {
  const [file] = args;
  if (!file) throw new ConfigError(ctx.t.config.importNeedsPath);

  let url: URL | null;
  try {
    url = asUrl(file);
  } catch (cause) {
    throw new ConfigError(ctx.t.config.invalidUrl, { cause });
  }
  const source = url === null ? file : urlIdentity(url.href, ctx.t);
  let text: string;
  if (url !== null) {
    text = await fetchPreset(url, ctx.t);
  } else {
    try {
      text = readFileSync(file, "utf8");
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException;
      // The path has its own copyable row; do not repeat it inside the OS diagnostic.
      const suffix = `, ${error.syscall} '${error.path}'`;
      const reason = error.path === file && error.message.endsWith(suffix)
        ? error.message.slice(0, -suffix.length) : error.message;
      throw new ConfigError(ctx.t.preset.unreadable(file, reason), { cause });
    }
  }

  // The slug comes from the file's own contents, not its filename: a preset that renames
  // itself on import is a preset whose exported identity did not survive the trip.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    // The parser's message quotes the input, which for a URL means echoing a prefix of whatever
    // that host returned — a readback of an internal service for anyone who can get this command
    // pointed at one. A file the user already has is theirs to see.
    throw new ConfigError(
      url === null ? ctx.t.preset.notJson(file, (cause as Error).message) : ctx.t.preset.notJsonRemote(source),
      { cause },
    );
  }
  const raw = presetObject(parsed, source, ctx.t);
  const slug = typeof raw.slug === "string" ? raw.slug : "";
  if (!SLUG_PATTERN.test(slug)) {
    throw new ConfigError(ctx.t.preset.noSlug(source));
  }
  if (BUNDLED.some((p) => p.slug === slug)) {
    throw new ConfigError(ctx.t.preset.bundledSlug(slug));
  }

  let preset: ReturnType<typeof parsePreset>;
  try {
    preset = parsePreset(text, slug, ctx.t);
  } catch (cause) {
    // Validation errors can quote a remote schema, axis or value, just as parser errors can.
    if (url === null || !(cause instanceof ConfigError)) throw cause;
    throw new ConfigError(ctx.t.preset.notAPreset(source), { cause });
  }
  const prepared = preparePresetWrite(ctx.paths.presets, preset, ctx.t);
  const baseline = prepared.capture === null
    ? planChange(prepared.path, (before) => before, ctx.t, undefined, ctx.paths.root)
    : rawReadChange(prepared.capture, ctx.t);
  const change = { ...baseline, after: prepared.contents };
  const selectionReads = prepared.selectionReads.filter((capture) => capture.path !== prepared.path)
    .map((capture) => rawReadCheck(capture, ctx.t));
  const existed = change.before !== null;
  await applyPlanned(ctx, [...selectionReads, change]);

  return {
    lines: [
      `  ${ctx.ui.success(ctx.ui.bold(ctx.t.preset.imported(slug, existed)))}`,
      `  ${truncate(humanText(preset.displayName), ctx.ui.width - 2)}`,
      `  ${ctx.t.preset.notApplied}`,
      // Where it came from, for the same reason the file path is already visible: a preset is
      // kept, and months later "where did this come from" is a question with an answer.
      // Paths can carry private values as well as query strings; public receipts name only origin.
      ...(url === null
        ? [`  ${humanText(resolve(file))}`]
        : [`  ${ctx.ui.dim(ctx.t.config.fetchedFrom(humanText(source)))}`]),
      ...nextStep(`tonedial show ${slug}`, ctx.ui),
    ],
    json: { slug, displayName: preset.displayName, replaced: existed, source },
    warnings: existed ? [ctx.t.preset.replaced(slug)] : [],
  };
}
