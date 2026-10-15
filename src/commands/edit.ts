// Preserve unvalidated edits, but require unchanged ownership before replacing live config.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";

import type { CommandResult, Ctx } from "../cli.ts";
import { CONFIG_SCHEMA, ConfigError, parseConfig, serializeConfig, type Config } from "../core/config.ts";
import {
  BUNDLED, SLUG_PATTERN, matchesPreset, withPreset, assertPresetSelection, customPresetDir, inspectPresetLibrary, parsePreset,
  preparePresetWrite, resolvePreset, type Preset, type PresetEntry,
} from "../core/presets.ts";
import { applyPlanned, planArtifact, planConfig } from "./compile.ts";
import { check as checkCombos } from "../core/combos.ts";
import { artifactSize, combination, humanText, riskWarnings } from "../ui/format.ts";
import { captureRawEntry, planChange, rawReadChange, rawReadCheck, type Change, type RawEntryCapture } from "../wiring/apply.ts";
import { emptyWiring } from "../wiring/ownership.ts";

/**
 * The editor to hand the file to. `$VISUAL` wins over `$EDITOR` by long convention — a user
 * who sets both means the first for interactive work, which this is.
 */
export function editorCommand(env: NodeJS.ProcessEnv): string[] | null {
  // Trimmed before the fallback. `VISUAL="  "` is truthy, so trimming afterwards let a
  // whitespace-only `$VISUAL` win the `||` and then collapse to nothing, masking a perfectly
  // good `$EDITOR` and reporting that no editor was set.
  const raw = env.VISUAL?.trim() || env.EDITOR?.trim() || "";
  if (!raw) return null;
  // Split on whitespace so `code --wait` and `emacsclient -nw` work. This is not a shell, and
  // it deliberately is not one: passing this through `sh -c` would make an editor setting a
  // path to arbitrary execution from whatever wrote the environment.
  return raw.split(/\s+/);
}

export async function runEdit(ctx: Ctx, args: string[]): Promise<CommandResult> {
  const [what, slug] = args;

  if (what === "traits") throw new ConfigError(ctx.t.errors.traitsNotOnDisk);
  if (what !== undefined && what !== "preset") throw new ConfigError(ctx.t.errors.editTarget(what));
  if (what === "preset" && !slug) throw new ConfigError(ctx.t.errors.editNeedsSlug);

  const target = what === "preset"
    ? presetTarget(ctx, slug!)
    : { path: ctx.paths.config, kind: "config" as const };

  const editor = editorCommand(ctx.env);
  if (!editor) throw new ConfigError(ctx.t.errors.noEditor(target.path));

  // `--dry-run` means nothing is written, and an editor is a write with a person behind it.
  if (ctx.flags.dryRun) {
    return {
      lines: [`  ${ctx.ui.dim(ctx.t.errors.wouldOpen(humanText(editor[0]!), humanText(target.path)))}`],
      json: { path: target.path, editor: editor[0], opened: false, changed: false },
    };
  }

  const baseline = target.kind === "preset"
    ? rawReadChange(target.capture, ctx.t)
    : planChange(target.path, (before) => before, ctx.t, undefined, ctx.paths.root);
  const selectionReads = target.kind === "preset"
    ? target.selectionReads.filter((capture) => capture.path !== target.path).map((capture) => rawReadCheck(capture, ctx.t))
    : [];
  const before = baseline.before;

  // A preset edit may recompile the active artifact. Capture the config before the editor opens
  // so a concurrent state mutation is rejected by the same gate as a concurrent preset edit.
  const presetConfigRead = target.kind === "preset" ? planConfig(ctx) : null;

  // The editor receives a private temporary copy. The original remains untouched until the
  // shared gate revalidates its identity, so a concurrent edit cannot be overwritten by a
  // perfectly valid save made a moment earlier.
  const tempDir = mkdtempSync(join(tmpdir(), "tonedial-edit-"));
  const tempPath = join(tempDir, basename(target.path));
  writeFileSync(tempPath, before ?? "", { mode: 0o600 });
  let preserveTemp = false;
  try {
    // Preserve the human editor's descriptors. Only JSON reserves stdout for the result;
    // its editor still displays live on stderr rather than drawing into a captured buffer.
    const result = spawnSync(editor[0]!, [...editor.slice(1), tempPath], {
      stdio: ctx.asJson ? ["inherit", 2, 2] : "inherit",
    });
    if (result.error) throw new ConfigError(ctx.t.errors.editorFailed(editor[0]!, result.error.message));
    const after = existsSync(tempPath) ? readFileSync(tempPath, "utf8") : null;
    // Checked against the file, not against the exit code alone. An editor that saves and then
    // exits non-zero — or dies on a signal — leaves the change on disk, and reporting "nothing was
    // re-read" would tell the user the opposite of what happened while `tone.md` went stale.
    if (result.status !== 0 && after === before) {
      throw new ConfigError(ctx.t.errors.editorExited(editor[0]!, result.status ?? -1));
    }

    if (after === before) {
      return {
        lines: [`  ${ctx.ui.dim(ctx.t.errors.editUnchanged)}`],
        json: { path: target.path, editor: editor[0], opened: true, changed: false },
      };
    }

    // Ownership is checked before every config commit, including invalid settings and deletion.
    // A deleted editor copy has nothing to preserve, so its staging directory is cleaned up.
    preserveTemp = after !== null;
    if (target.kind === "config") checkWiringEdit(before, after, ctx);
    const commitRaw = async (contents: string | null): Promise<void> => {
      await applyPlanned(ctx, [...selectionReads, { ...baseline, after: contents }]);
      preserveTemp = false;
    };
    if (after === null) {
      await commitRaw(null);
      throw new ConfigError(ctx.t.errors.editDeleted(target.path));
    }

    // Ordinary invalid settings may keep their raw bytes only after ownership was proved.
    const lines: string[] = [];
    const commit = async (changes: Change[], finalChanges: Change[] = []): Promise<void> => {
      await applyPlanned(ctx, [...selectionReads, ...changes], finalChanges);
      preserveTemp = false;
    };

    if (target.kind === "config") {
      let config: Config;
      try {
        config = parseConfig(after, ctx.t);
      } catch (cause) {
        await commitRaw(after);
        throw cause;
      }
      const { change: toneChange, size } = planArtifact(ctx, config);
      await commit([toneChange], [{ ...baseline, after }]);
      lines.push(`  ${ctx.ui.dim(artifactSize(size, ctx.t))}`);
      return {
        lines,
        json: { path: target.path, editor: editor[0], opened: true, changed: true, chars: size.chars },
        warnings: stateWarnings(ctx, config),
      };
    }

  // **Refused, not dropped.** `parsePreset` returns the slug it was handed and ignores the one
  // in the file, so editing that field used to come back as a save where `displayName` took and
  // `slug` did not — a partial write reported as a success. Renaming is not implemented because
  // the slug is what `config.preset` and the wiring record point at; it is not one filename.
  // `parsePreset` first, so whatever is on disk has already been refused if it is not a preset
  // at all — reading a field off `JSON.parse("null")` is the crash this command was fixed for
  // once already.
    let preset;
    try {
      preset = parsePreset(after, slug!, ctx.t);
    } catch (cause) {
      await commitRaw(after);
      throw cause;
    }
    const edited = (JSON.parse(after) as Record<string, unknown>).slug;
    if (typeof edited === "string" && edited !== slug) {
      await commitRaw(after);
      throw new ConfigError(ctx.t.preset.slugNotEditable(slug!, edited));
    }
  // Round-tripped through `preparePresetWrite` so the file on disk is the serialization every other
  // path produces. A hand-edited file that parses can still differ in key order and spacing,
  // and byte identity is what `export` and the seed-refresh check both compare on.
    let prepared: { path: string; contents: string };
    try {
      // An existing file keeps its path and read-compatible label; this explicit edit also
      // permits repairing an invalid JSON document that the inventory could not parse.
      const existing = target.entry ?? {
        preset, path: target.path, source: target.path.startsWith(customPresetDir(ctx.paths.presets)) ? "custom" : "legacy",
        capture: target.capture, selectionReads: target.selectionReads,
      } satisfies PresetEntry;
      prepared = preparePresetWrite(ctx.paths.presets, preset, ctx.t, { existing });
    } catch (cause) {
      await commitRaw(after);
      throw cause;
    }
    const presetChange: Change = { ...baseline, after: prepared.contents };
    lines.push(`  ${ctx.ui.success(ctx.ui.bold(ctx.t.preset.editSaved(preset.slug)))}`);

    const configRead = presetConfigRead!;
    const config = configRead.config;
    const warnings: string[] = [];
    let applied = false;
    if (config.preset === preset.slug && !target.ambiguous) {
      let baselinePreset: Preset | null = null;
      if (!config.unsaved && before !== null) {
        try {
          baselinePreset = parsePreset(before, preset.slug, ctx.t);
        } catch (cause) {
          if (!(cause instanceof ConfigError)) throw cause;
          // A repaired invalid preset has no clean baseline that could authorize replacing
          // live axes. Keep them and reconcile their divergence from the repaired file.
        }
      }
      if (baselinePreset !== null && matchesPreset(config, baselinePreset)) {
        Object.assign(config, withPreset(config, preset));
        applied = true;
      }
      const wasUnsaved = config.unsaved;
      config.unsaved = !matchesPreset(config, preset);
      if (applied || config.unsaved !== wasUnsaved) {
        const { change: toneChange, size } = planArtifact(ctx, config);
        const finalConfig = { ...configRead.change, after: serializeConfig(config, ctx.t) };
        await commit([configRead.change, presetChange, toneChange], [finalConfig]);
        lines.push(`  ${ctx.ui.dim(artifactSize(size, ctx.t))}`);
        warnings.push(...stateWarnings(ctx, config));
      } else {
        await commit([configRead.change, presetChange]);
      }
      if (!applied) lines.push(`  ${ctx.t.preset.editAxesKept(config.unsaved)}`);
    } else {
      // An inactive preset owns neither the live axes nor their artifact.
      await commit([configRead.change, presetChange]);
      if (target.ambiguous && config.preset === preset.slug) warnings.push(ctx.t.preset.activeConflict(preset.slug));
    }
    return {
      lines,
      json: { path: target.path, editor: editor[0], opened: true, changed: true, slug: preset.slug, applied, unsaved: config.unsaved },
      warnings,
    };
  } catch (cause) {
    if (!preserveTemp) throw cause;
    const stale = cause instanceof ConfigError && [target.path, ctx.paths.config, ctx.paths.tone]
      .some((path) => cause.message === ctx.t.errors.staleTarget(path));
    if (stale) throw new ConfigError(ctx.t.errors.editConflict(tempPath), { cause });
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError(ctx.t.errors.editNotApplied(tempPath, reason), { cause });
  } finally {
    if (!preserveTemp) rmSync(tempDir, { recursive: true, force: true });
  }
}

/** The notices every other state-changing command emits, through the same owners they use. */
function stateWarnings(ctx: Ctx, config: Config): string[] {
  const p = config.persona;
  return [
    ...checkCombos(config.axes, p, config.speech_level).map((w) => combination(w, ctx.t)),
    ...(p.age || p.gender || p.note || p.address || p.user || p.agent ? [ctx.t.notice.personaUnanchored] : []),
    ...riskWarnings(config.axes, ctx.t),
  ];
}

/**
 * Decode ownership through its existing schema owner, independently of ordinary settings.
 * A complete normalized graph must match; malformed JSON cannot prove even empty ownership.
 */
function checkWiringEdit(before: string | null, after: string | null, ctx: Ctx): void {
  const refusal = after === null ? ctx.t.errors.editDeletionRefused(ctx.paths.config) : ctx.t.config.wiringLost;
  const read = (text: string | null): unknown => {
    if (text === null) return emptyWiring();
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ConfigError(ctx.t.config.rootNotAnObject);
    }
    const source = raw as Record<string, unknown>;
    const config = parseConfig(JSON.stringify({ schema: source.schema, wiring: source.wiring }), ctx.t);
    if (config.schema === CONFIG_SCHEMA) return config.wiring;
    // Empty old maps carry no native authority. Nonempty old metadata stays opaque until an
    // approved migration, so changing its schema cannot silently change its interpretation.
    return Object.keys(config.wiring).length === 0 ? emptyWiring() : { schema: config.schema, wiring: config.wiring };
  };
  let unchanged: boolean;
  try {
    unchanged = isDeepStrictEqual(read(before), read(after));
  } catch (cause) {
    if (!(cause instanceof ConfigError) && !(cause instanceof SyntaxError)) throw cause;
    throw new ConfigError(refusal, { cause });
  }
  if (!unchanged) throw new ConfigError(refusal);
}

/**
 * A bundled preset is refused rather than opened. The seed check compares **content**, so an
 * edited bundled file reports as stale and the next `init` writes the original back over it —
 * the user would lose the edit to a command that never mentioned their file. `use` then `save`
 * under a new name keeps the change and is what the message says.
 */
function presetTarget(ctx: Ctx, slug: string): {
  path: string;
  kind: "preset";
  capture: RawEntryCapture;
  selectionReads: RawEntryCapture[];
  entry: PresetEntry | null;
  ambiguous: boolean;
} {
  // **Before the join, not after.** `edit preset ../../secret` resolved outside the presets
  // directory and handed that file to the editor; the slug check ran on the way back, by which
  // point the editor had already saved over it. A validated slug cannot contain a separator or
  // a dot, so checking here is what makes the join below safe rather than what reports it late.
  if (!SLUG_PATTERN.test(slug)) throw new ConfigError(ctx.t.preset.noSlug(slug));
  if (BUNDLED.some((p) => p.slug === slug)) throw new ConfigError(ctx.t.preset.bundledNotEditable(slug));
  
  const library = inspectPresetLibrary(ctx.paths.presets, ctx.t);
  const entry = resolvePreset(ctx.paths.presets, slug, ctx.t, library);
  if (entry !== null) assertPresetSelection(entry, ctx.t);
  const damaged = library.unavailable.find((candidate) => candidate.slug === slug);
  const path = entry?.path ?? damaged?.path;
  if (path === null || path === undefined) {
    throw new ConfigError(ctx.t.preset.unknown(slug, library.entries.map((candidate) => candidate.preset.slug)));
  }
  const capture = entry?.capture ?? captureRawEntry(path, ctx.t, { within: ctx.paths.root, maxBytes: 64 * 1024, allowLink: false });
  const selectionReads = entry?.selectionReads ?? [capture];
  return {
    path, kind: "preset", capture, selectionReads, entry,
    ambiguous: library.conflicts.some((conflict) => !conflict.resolved && conflict.slug === slug),
  };
}
