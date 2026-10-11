// Packaged axis presets and the compatible custom preset library.

import { lstatSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { AXIS_DEFAULT, AXIS_ORDER, type Axes, type Level } from "./anchors.ts";
import { ConfigError, nearestAxis } from "./config.ts";
import type { Messages } from "./i18n.ts";
import { captureRawEntry, type RawEntryCapture } from "../wiring/apply.ts";

export const PRESET_SCHEMA = 1;
export const PRESET_MAX_BYTES = 64 * 1024;

export const customPresetDir = (presetsDir: string): string => join(presetsDir, "custom");
export const builtinPresetDir = (presetsDir: string): string => join(presetsDir, "builtin");

export type PresetSource = "custom" | "legacy" | "bundled";
export type PresetUnavailableReason = "invalid-name" | "unsafe-path" | "not-regular" | "too-large" | "unreadable" | "invalid-data";

/** Selection and precedence reads share the existing operation owner's captured evidence. */
export type PresetEntry = {
  preset: Preset;
  source: PresetSource;
  path: string | null;
  capture: RawEntryCapture | null;
  selectionReads: RawEntryCapture[];
  /** Read-only fallback exists, but the preferred path could not supply a gate witness. */
  blockedPreferredPath?: string;
};
export type UnavailablePreset = { slug: string; path: string; reason: PresetUnavailableReason };
export type PresetRecoveryCopy = {
  preset: Preset;
  path: string;
  contents: string;
  source: PresetEntry;
  existing: PresetEntry | null;
};
export type PresetConflict = {
  slug: string;
  preferred: PresetEntry;
  legacy: PresetEntry;
  recovery: PresetRecoveryCopy;
  resolved: boolean;
};
export type PresetLibrary = {
  entries: PresetEntry[];
  unavailable: UnavailablePreset[];
  conflicts: PresetConflict[];
  recoveryCopies: PresetRecoveryCopy[];
  cacheRecoveries: PresetRecoveryCopy[];
};

export type Preset = {
  schema: number;
  slug: string;
  displayName: string;
  values: Partial<Record<keyof Axes, Level>>;
  bundled?: boolean;
};

/**
 * Only the axes a preset moves are listed; the rest take their default at resolve time. That
 * is sparsity as storage, not as a compile rule — every axis is still emitted.
 */
const bundled = (slug: string, displayName: string, values: Preset["values"]): Preset => ({
  schema: PRESET_SCHEMA,
  slug,
  displayName,
  values,
  bundled: true,
});

export const BUNDLED: readonly Preset[] = [
  bundled("caring-brother", "Caring Brother", {
    formality: 1, verbosity: 4, profanity: 2, critique: 2, warmth: 5, conviction: 4, care: 5,
  }),
  bundled("bratty-kid", "Bratty Kid", {
    formality: 1, playfulness: 5, conviction: 2, care: 1, compliance: 1, refusal: 3, bravado: 3,
  }),
  bundled("eager-sycophant", "Eager Sycophant", {
    formality: 5, critique: 1, flattery: 5, warmth: 4, conviction: 1, compliance: 5,
  }),
  bundled("tough-love", "Tough Love", {
    formality: 2, critique: 5, warmth: 5, conviction: 4, care: 4,
  }),
  bundled("terse-operator", "Terse Operator", {
    verbosity: 1, playfulness: 1, warmth: 1, conviction: 5, care: 1,
  }),
];

/** Lowercase Latin letters, dashes, and digits. macOS normalises Unicode to NFD and Linux to
 *  NFC, which breaks preset export and import sharing, so a slug never carries either. */
export const SLUG_MAX = 32;

export const DISPLAY_NAME_MAX = 120;

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Retain legacy long names on read, but neutralize controls before any display. */
export function readDisplayName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || raw === "") return fallback;
  return raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim() || fallback;
}

export function slugify(displayName: string, t: Messages): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new ConfigError(t.preset.noLatin(displayName));
  if ([...displayName].length > DISPLAY_NAME_MAX) {
    throw new ConfigError(
      t.preset.nameTooLong([...displayName].length, DISPLAY_NAME_MAX),
    );
  }
  return slug.slice(0, SLUG_MAX).replace(/-+$/, "");
}

/** The object boundary shared by on-disk reads and an import's own-slug lookup. */
export function presetObject(parsed: unknown, source: string, t: Messages): Record<string, unknown> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(t.preset.notAPreset(source));
  }
  return parsed as Record<string, unknown>;
}

export function parsePreset(text: string, slug: string, t: Messages): Preset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(t.preset.notJson(slug, (cause as Error).message));
  }
  const raw = presetObject(parsed, slug, t);
  if (raw.schema !== undefined && raw.schema !== PRESET_SCHEMA) {
    throw new ConfigError(t.preset.schemaMismatch(slug, JSON.stringify(raw.schema), PRESET_SCHEMA));
  }
  const values: Preset["values"] = {};
  const rawValues = raw.values === undefined ? {} : raw.values;
  if (typeof rawValues !== "object" || rawValues === null || Array.isArray(rawValues)) {
    throw new ConfigError(t.preset.notAPreset(slug));
  }
  for (const [axis, value] of Object.entries(rawValues)) {
    if (!(AXIS_ORDER as readonly string[]).includes(axis)) {
      throw new ConfigError(t.axis.unknown(`${slug}: ${axis}`, nearestAxis(axis)));
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
      throw new ConfigError(t.preset.badLevel(slug, axis, JSON.stringify(value) ?? "undefined"));
    }
    values[axis as keyof Axes] = value as Level;
  }
  return {
    schema: PRESET_SCHEMA,
    slug,
    displayName: readDisplayName(raw.displayName, slug),
    values,
  };
}

export function serializePreset(preset: Preset): string {
  const values: Record<string, Level> = {};
  for (const axis of AXIS_ORDER) {
    const v = preset.values[axis];
    if (v !== undefined) values[axis] = v;
  }
  return (
    JSON.stringify({ schema: PRESET_SCHEMA, slug: preset.slug, displayName: preset.displayName, values }, null, 2) +
    "\n"
  );
}

/** Bundled names recognized in the existing flat cache layout. */
export const LEGACY_BUILTIN_SLUGS: readonly string[] = [
  "caring-brother", "bratty-kid", "eager-sycophant", "tough-love", "terse-operator",
];

export type PresetSnapshotResult =
  | { capture: RawEntryCapture; text: string }
  | { reason: PresetUnavailableReason; capture?: RawEntryCapture }
  | { missing: true; capture: RawEntryCapture | null };

/** Bounded, regular UTF-8 reads, shared by inventory, recovery, and command selection. */
export function readPresetSnapshot(presetsDir: string, path: string, t: Messages): PresetSnapshotResult {
  try {
    const root = lstatSync(dirname(presetsDir), { throwIfNoEntry: false });
    if (root === undefined) return { missing: true, capture: null };
    const capture = captureRawEntry(path, t, { within: dirname(presetsDir), maxBytes: PRESET_MAX_BYTES, allowLink: false });
    if (capture.type === "missing") return { missing: true, capture };
    const bytes = capture.bytes!;
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) return { reason: "invalid-data", capture };
    return { capture, text };
  } catch {
    return { reason: "unreadable" };
  }
}

/** Preset semantics are axes; a display label and sparse default spelling do not change them. */
export function equivalentPresets(left: Preset, right: Preset): boolean {
  const a = applyPreset(left);
  const b = applyPreset(right);
  return AXIS_ORDER.every((axis) => a[axis] === b[axis]);
}

function recoveryCopy(
  presetsDir: string,
  source: PresetEntry,
  occupied: Map<string, PresetEntry | null>,
): PresetRecoveryCopy {
  const axes = applyPreset(source.preset);
  const hash = createHash("sha256").update(JSON.stringify(AXIS_ORDER.map((axis) => axes[axis]))).digest("hex").slice(0, 8);
  for (let attempt = 0; ; attempt++) {
    const suffix = `-recovered-${hash}${attempt === 0 ? "" : `-${attempt}`}`;
    const base = source.preset.slug.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "");
    const slug = `${base || "p"}${suffix}`;
    const existing = occupied.get(slug);
    if (occupied.has(slug) && (existing === null || existing === undefined || !equivalentPresets(existing.preset, source.preset))) continue;
    const preset = { ...source.preset, slug, bundled: false };
    const copy = {
      preset, path: existing?.path ?? join(customPresetDir(presetsDir), `${slug}.json`),
      contents: serializePreset(preset), source, existing: existing ?? null,
    };
    if (existing === undefined) occupied.set(slug, { preset, source: "custom", path: copy.path, capture: null, selectionReads: [] });
    return copy;
  }
}

/** Read-only discovery. A damaged sibling costs its own row and never creates a directory. */
export function inspectPresetLibrary(presetsDir: string, t: Messages): PresetLibrary {
  const unavailable: UnavailablePreset[] = [];
  const custom = new Map<string, PresetEntry>();
  const legacy = new Map<string, PresetEntry>();
  const occupied = new Map<string, PresetEntry | null>(BUNDLED.map((preset) => [preset.slug, null]));
  const customReads = new Map<string, RawEntryCapture>();
  for (const [dir, source, found] of [
    [customPresetDir(presetsDir), "custom", custom], [presetsDir, "legacy", legacy],
  ] as const) {
    let files: string[];
    try {
      if (lstatSync(dirname(presetsDir), { throwIfNoEntry: false }) === undefined) continue;
      const capture = captureRawEntry(dir, t, { within: dirname(presetsDir), allowLink: false, allowDirectory: true });
      if (capture.type === "missing") continue;
      if (capture.type !== "directory") {
        unavailable.push({ slug: basename(dir), path: dir, reason: "unsafe-path" });
        continue;
      }
      files = readdirSync(dir).sort();
    }
    catch { unavailable.push({ slug: basename(dir), path: dir, reason: "unreadable" }); continue; }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const slug = file.slice(0, -5);
      const path = join(dir, file);
      if (!SLUG_PATTERN.test(slug) || source === "custom" && BUNDLED.some((p) => p.slug === slug)) {
        unavailable.push({ slug: readDisplayName(slug, "unavailable"), path, reason: "invalid-name" });
        occupied.set(slug, null);
        continue;
      }
      const read = readPresetSnapshot(presetsDir, path, t);
      if (source === "custom" && "capture" in read && read.capture != null) customReads.set(slug, read.capture);
      if (!("text" in read)) {
        unavailable.push({ slug, path, reason: "reason" in read ? read.reason : "unreadable" });
        if (!occupied.has(slug)) occupied.set(slug, null);
        continue;
      }
      let preset: Preset;
      try { preset = parsePreset(read.text, slug, t); }
      catch { unavailable.push({ slug, path, reason: "invalid-data" }); if (!occupied.has(slug)) occupied.set(slug, null); continue; }
      const entry: PresetEntry = { preset, source, path, capture: read.capture, selectionReads: [read.capture] };
      found.set(slug, entry);
      if (!occupied.has(slug) || source === "custom") occupied.set(slug, entry);
    }
  }
  const entries: PresetEntry[] = BUNDLED.map((preset) => ({ preset, source: "bundled", path: null, capture: null, selectionReads: [] }));
  const conflicts: PresetConflict[] = [];
  const recoveryCopies: PresetRecoveryCopy[] = [];
  const cacheRecoveries: PresetRecoveryCopy[] = [];
  for (const slug of [...new Set([...custom.keys(), ...legacy.keys()])].sort()) {
    const preferred = custom.get(slug);
    const older = legacy.get(slug);
    const packaged = BUNDLED.find((p) => p.slug === slug);
    if (packaged !== undefined) {
      if (older !== undefined && LEGACY_BUILTIN_SLUGS.includes(slug) && !equivalentPresets(packaged, older.preset)) {
        const recovery = recoveryCopy(presetsDir, older, occupied);
        cacheRecoveries.push(recovery);
        if (recovery.existing?.capture == null) recoveryCopies.push(recovery);
      }
      continue;
    }
    if (preferred === undefined && older !== undefined) {
      const preferredPath = join(customPresetDir(presetsDir), `${slug}.json`);
      const higher = customReads.get(slug) ?? readPresetSnapshot(presetsDir, preferredPath, t);
      if ("type" in higher) older.selectionReads.push(higher);
      else if ("capture" in higher && higher.capture != null) older.selectionReads.push(higher.capture);
      else older.blockedPreferredPath = preferredPath;
    }
    entries.push(preferred ?? older!);
    if (preferred !== undefined && older !== undefined && !equivalentPresets(preferred.preset, older.preset)) {
      const recovery = recoveryCopy(presetsDir, older, occupied);
      const resolved = recovery.existing !== null && recovery.existing.capture !== null;
      conflicts.push({ slug, preferred, legacy: older, recovery, resolved });
      if (!resolved) recoveryCopies.push(recovery);
    }
  }
  return {
    entries, unavailable, conflicts, cacheRecoveries,
    recoveryCopies: recoveryCopies.filter((copy, index) => recoveryCopies.findIndex((candidate) => candidate.path === copy.path) === index),
  };
}

export function resolvePreset(presetsDir: string, slug: string, t: Messages, library?: PresetLibrary): PresetEntry | null {
  if (!SLUG_PATTERN.test(slug)) return null;
  return (library ?? inspectPresetLibrary(presetsDir, t)).entries.find((entry) => entry.preset.slug === slug) ?? null;
}

/** A mutation may use fallback data only when the preferred path stays bound through its gate. */
export function assertPresetSelection(entry: PresetEntry, t: Messages): void {
  if (entry.blockedPreferredPath !== undefined) {
    throw new ConfigError(t.preset.unreadable(entry.blockedPreferredPath, "unreadable"));
  }
}

/** Prepare a user write at its resolved existing path or a new custom location. */
export function preparePresetWrite(
  presetsDir: string,
  preset: Preset,
  t: Messages,
  options: { existing?: PresetEntry } = {},
): { path: string; contents: string; capture: RawEntryCapture | null; selectionReads: RawEntryCapture[] } {
  // Here rather than at each caller, because this is the one join a user-supplied string
  // reaches. `slugify` truncates on the `save` route and `import` had no cap at all — a
  // 300-character slug matches the pattern, forms the filename, and reached `writeFileSync`
  // as an `ENAMETOOLONG` outside the `--json` envelope.
  const existing = options.existing ?? resolvePreset(presetsDir, preset.slug, t) ?? undefined;
  if (existing !== undefined) assertPresetSelection(existing, t);
  if (preset.slug.length > SLUG_MAX && existing?.preset.slug !== preset.slug) {
    throw new ConfigError(t.preset.slugTooLong(preset.slug.length, SLUG_MAX));
  }
  if ([...preset.displayName].length > DISPLAY_NAME_MAX && existing?.preset.displayName !== preset.displayName) {
    throw new ConfigError(t.preset.nameTooLong([...preset.displayName].length, DISPLAY_NAME_MAX));
  }
  // Checked where the path is built, not only at the call sites. A third caller — `doctor
  // --fix` writing a repaired preset — would otherwise inherit no guard at all, and this is
  // the one join in the tool that a user-supplied string reaches.
  if (!SLUG_PATTERN.test(preset.slug)) {
    throw new ConfigError(t.preset.noSlug(preset.slug));
  }
  if (BUNDLED.some((p) => p.slug === preset.slug)) throw new ConfigError(t.preset.bundledSlug(preset.slug));
  const path = existing?.path ?? join(customPresetDir(presetsDir), `${preset.slug}.json`);
  const read = existing?.capture === undefined ? readPresetSnapshot(presetsDir, path, t) : null;
  if (read !== null && "reason" in read) throw new ConfigError(t.preset.unavailable(preset.slug, read.reason));
  if (read !== null && "text" in read) {
    // A damaged user file is restored only through an explicitly selected recovery action.
    try { parsePreset(read.text, preset.slug, t); }
    catch { throw new ConfigError(t.preset.unavailable(preset.slug, "invalid-data")); }
  }
  const capture = existing?.capture ?? (read !== null && "capture" in read ? read.capture : null);
  return { path, contents: serializePreset(preset), capture, selectionReads: existing?.selectionReads ?? [] };
}

/** A preset's values over the defaults. Every axis ends up set, because every axis is emitted. */
export function applyPreset(preset: Preset): Axes {
  return { ...AXIS_DEFAULT, ...preset.values };
}
