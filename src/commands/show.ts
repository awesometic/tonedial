// Active tone or preset preview. Axes lead; settings sit beside them when wide and below
// them when narrow. A nonempty artifact and recorded connections never prove native loading.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { CommandResult, Ctx } from "../cli.ts";
import { AXIS_DEFAULT, AXIS_GROUP, AXIS_KIND, AXIS_RISK_FROM, riskyAxes } from "../core/anchors.ts";
import { check as checkCombos, PERSONA_DESCRIPTION_MAX } from "../core/combos.ts";
import { ConfigError, isConfigV2, type Config } from "../core/config.ts";
import { compile, measure } from "../core/compile.ts";
import { withPreset, matchesPreset, inspectPresetLibrary, resolvePreset } from "../core/presets.ts";
import { toCompileInput } from "../core/resolve.ts";
import { inspectContextLayout } from "../core/seeds.ts";
import { catalogue, isLanguage, type Messages } from "../core/i18n.ts";
import { explainBlock, gaugeBlock, gaugeHeader } from "../ui/gauge.ts";
import { planConfig, sizeWarning } from "./compile.ts";
import { budget as budgetLine, combination, humanText, nextStep, riskWarnings } from "../ui/format.ts";
import { maxCells, truncate, wrap } from "../ui/width.ts";
import { inspectContextConsumers } from "../wiring/targets.ts";

export function runShow(ctx: Ctx, args: string[]): CommandResult {
  const { change: configChange, config } = planConfig(ctx);
  const ui = ctx.ui;
  const [slug] = args;
  const library = inspectPresetLibrary(ctx.paths.presets, ctx.t);
  const activeConflict = library.conflicts.some((conflict) => !conflict.resolved && conflict.slug === config.preset);

  // `show <slug>` previews a preset without activating it, so a user can look before they use.
  const preview = slug ? resolvePreset(ctx.paths.presets, slug, ctx.t, library)?.preset ?? null : null;
  // The real list, as every other call site passes: an empty one renders "Available:" with
  // nothing after it on a root that has all five bundled presets.
  if (slug && !preview) {
    throw new ConfigError(ctx.t.preset.unknown(slug, library.entries.map((entry) => entry.preset.slug)));
  }
  const shown = preview ? withPreset(config, preview) : config;
  const axes = shown.axes;

  const input = toCompileInput(shown);
  const artifact = compile(input);
  const size = measure(artifact);
  const artifactOnDisk = artifactExists(ctx);

  const activeName = preview
    ? preview.displayName
    : config.preset
      ? activeConflict ? config.preset : resolvePreset(ctx.paths.presets, config.preset, ctx.t, library)?.preset.displayName ?? config.preset
      : `(${ctx.t.preset.unsaved})`;
  const activePreset = config.preset && !activeConflict ? resolvePreset(ctx.paths.presets, config.preset, ctx.t, library)?.preset : null;
  const needsSave = preview === null && configChange.before !== null &&
    (config.unsaved || activePreset == null || !matchesPreset(config, activePreset));
  const status = preview ? ` (${ctx.t.preset.preview})` : config.preset && needsSave ? ` (${ctx.t.preset.unsaved})` : "";
  const saveCommand = activePreset && !activePreset.bundled
    ? "tonedial save"
    : 'tonedial save "My Tone"';

  const lines: string[] = [];
  const budget = budgetLine(size, ctx.t);
  // A display name has no length cap, so the title is the one row that can be pushed past the
  // budget by state alone. Truncating keeps the size at the right margin where it is read.
  const prefix = "ToneDial · show · ";
  const nameBudget = ctx.ui.width - maxCells(budget) - maxCells(status) - maxCells(prefix) - 4;
  if (nameBudget >= 2) {
    lines.push(titleRow(prefix + truncate(humanText(activeName), nameBudget) + status, budget, size.overCap, ctx));
  } else {
    const title = prefix + truncate(humanText(activeName), Math.max(2, ui.width - maxCells(status) - maxCells(prefix) - 2)) + status;
    for (const folded of wrap(title, ui.width - 2)) lines.push(`  ${ui.bold(folded)}`);
    for (const folded of wrap(budget, ui.width - 2)) lines.push(`  ${(size.overCap ? ui.error : ui.dim)(folded)}`);
  }

  const p = shown.persona;
  const personaSet = Boolean(p.age || p.gender || p.note || p.address || p.user || p.agent);
  const gauges = [gaugeHeader(ui, ctx.t), ...gaugeBlock(axes, ui)];
  const gaugeWidth = Math.max(...gauges.map((line) => maxCells(stripVTControlCharacters(line))));
  const detailWidth = ui.terminal && ui.width >= 119 ? ui.width - gaugeWidth - 4 : ui.width - 2;
  const details: string[] = [ui.bold(ctx.t.artifact.settingsHeading)];
  if (personaSet) {
    const bits = [
      p.age ? humanText(p.age) : null,
      p.gender ? humanText(p.gender) : null,
      p.address?.self_ref ? ctx.t.persona.callsItself(humanText(p.address.self_ref)) : null,
      p.address?.user_ref ? ctx.t.persona.callsYou(humanText(p.address.user_ref)) : null,
      p.note ? ctx.t.persona.noteChars([...p.note].length) : null,
      p.user && p.agent && !ctx.flags.verbose ? ctx.t.persona.descriptionCounts([...p.user].length, [...p.agent].length, PERSONA_DESCRIPTION_MAX) : null,
      p.user && !p.agent && !ctx.flags.verbose ? ctx.t.persona.descriptionChars("user", [...p.user].length) : null,
      p.agent && !p.user && !ctx.flags.verbose ? ctx.t.persona.descriptionChars("agent", [...p.agent].length) : null,
    ].filter(Boolean);
    if (bits.length) for (const folded of wrap(bits.join(" · "), detailWidth)) details.push(ui.dim(folded));
    if (ctx.flags.verbose) {
      for (const [field, value] of [["user", p.user], ["agent", p.agent]] as const) {
        if (value === null) continue;
        for (const folded of wrap(ctx.t.persona.descriptionFull(field, humanText(value)), detailWidth)) {
          details.push(ui.dim(folded));
        }
      }
    }
  }

  // Folded rather than laid out: the safeword is user text of unbounded length, so this row
  // can always exceed the budget and no amount of shortening the fixed words prevents it.
  const records = isConfigV2(config)
    ? [...new Set(Object.values(config.wiring.registrations).map((record) => `${record.target} (${record.scope})`))]
    : Object.keys(config.wiring);
  for (const text of [
    stateRow(shown, ctx.t), ctx.t.artifact.displaySettings(config.language),
    ctx.t.artifact.connectionRecords(records.map(humanText)),
  ]) for (const folded of wrap(text, detailWidth)) details.push(folded);
  // The config's presence cannot distinguish a prepared root from a legacy one. Use the same
  // layout decision as the mutation gate so fresh, prepared, and legacy roots stay distinct.
  if (!artifactOnDisk) {
    const known = inspectContextConsumers(ctx.paths, ctx.agent, config, ctx.env, ctx.t);
    const layout = inspectContextLayout(ctx.paths, configChange, ctx.t, {
      config: configChange.before === null ? null : config,
      expectedArtifact: preview ? compile(toCompileInput(config)) : artifact,
      ...known,
      consumerInspectionFailed: known.error !== null,
    });
    const advice = layout.kind === "fresh"
      ? ctx.t.artifact.notSetUp
      : layout.kind === "current"
        ? ctx.t.artifact.notWritten
        : ctx.t.errors.contextLayout(layout.kind, humanText(ctx.paths.root));
    // Layout guidance can carry an absolute state-root path. Keep that copy target whole while
    // folding its prose within the screen's two-cell indent.
    for (const line of advice.split("\n").flatMap((line) =>
      isAbsolute(line) ? [line] : wrap(line, ui.width - 2)
    )) {
      lines.push(`  ${ui.warn(line)}`);
    }
  }
  lines.push("");
  if (ui.terminal && ui.width >= 119) {
    for (let index = 0; index < Math.max(gauges.length, details.length); index++) {
      const row = gauges[index] ?? "";
      lines.push(details[index] === undefined ? row : `${row}${" ".repeat(gaugeWidth - maxCells(stripVTControlCharacters(row)) + 4)}${details[index]}`);
    }
  } else {
    lines.push(...gauges, "", ...details.map((line) => `  ${line}`));
  }
  lines.push("");

  if (ctx.flags.explain || ctx.flags.verbose) {
    // The hints are per-language and the language is a user setting, so `--explain` is the one
    // screen whose content depends on the catalogue. Nothing here reaches `tone.md`.
    lines.push(...explainBlock(ui, catalogue(isLanguage(config.language) ? config.language : "en")));
    if (needsSave) {
      lines.push("", ...wrap(ctx.t.preset.changesNotSaved, ui.width - 2).map((line) => `  ${ui.warn(line)}`),
        ...nextStep(saveCommand, ui).slice(1));
    }
  } else {
    // Keep the short legend and action together so a one-row persona still fits 80×24.
    const legend = ctx.t.artifact.movedFromDefault + (needsSave ? ` · ${ctx.t.preset.changesNotSaved}` : "");
    const [first, ...rest] = wrap(legend, ui.width - 4);
    lines.push(`  ${ui.accent("*")} ${ui.dim(first!)}`, ...rest.map((line) => `    ${ui.dim(line)}`),
      ...nextStep(preview ? `tonedial use ${preview.slug}` : needsSave ? saveCommand : "tonedial show --explain", ui).slice(1));
  }

  const combinations = checkCombos(axes, shown.persona, shown.speech_level);
  const warnings = combinations.map((w) => combination(w, ctx.t));
  if (personaSet) {
    warnings.push(ctx.t.notice.personaUnanchored);
  }
  warnings.push(...riskWarnings(axes, ctx.t));
  warnings.push(ctx.t.notice.modelExpectation);
  if (activeConflict && preview === null) warnings.push(ctx.t.preset.activeConflict(config.preset!));
  // Through the same owner every other command uses, rather than a sentence composed here.
  warnings.push(...sizeWarning(size, ctx.t));

  return {
    lines,
    json: {
      preset: preview ? preview.slug : config.preset,
      preview: preview !== null,
      activeKnown: preview !== null || !activeConflict,
      // Layered rather than flattened: the skill has to tell a forbidden contradiction from a
      // cosmetic one, and a joined string cannot carry that.
      combinations,
      unsaved: preview === null ? needsSave : false,
      axes,
      defaults: AXIS_DEFAULT,
      kinds: AXIS_KIND,
      groups: AXIS_GROUP,
      riskAxes: riskyAxes(axes),
      riskThresholds: AXIS_RISK_FROM,
      persona: shown.persona,
      safeword: shown.safeword,
      speech_level: shown.speech_level,
      // Interface language never changes the compiled tone.
      language: config.language,
      chars: size.chars,
      cap: size.cap,
      artifact: { exists: artifactOnDisk },
    },
    warnings,
  };
}

/**
 * The preset name reads as the title and the size sits at the right margin, which only works
 * while both fit — on anything narrower they fall back to a single space rather than pushing
 * the line past its budget. Right alignment is worth having and never worth an overflow.
 */
function titleRow(name: string, budget: string, overCap: boolean, ctx: Ctx): string {
  const paint = overCap ? ctx.ui.error : ctx.ui.dim;
  // Measured pessimistically. A display name is user text and may hold ambiguous-width
  // characters, so a gap sized by the narrow measure is a gap that overflows on the terminals
  // this contract exists for.
  const used = maxCells(name) + maxCells(budget) + 2;
  const gap = used <= ctx.ui.width ? " ".repeat(ctx.ui.width - used) : " ";
  return `  ${ctx.ui.bold(name)}${gap}${paint(budget)}`;
}

/**
 * Safeword and register on one row. Plain text, because it is folded before it is
 * painted and an escape sequence measures as characters while occupying no cell.
 */
function stateRow(config: Config, t: Messages): string {
  const safeword = config.safeword ? t.settings.safewordSet(humanText(config.safeword)).split(" — ")[0]! : t.settings.noSafeword.split(" — ")[0]!;
  return `${safeword} · ${t.settings.register(config.speech_level)}`;
}

// Presence alone establishes neither current contents nor native loading.
function artifactExists(ctx: Ctx): boolean {
  return existsSync(ctx.paths.tone) && readFileSync(ctx.paths.tone, "utf8").length > 0;
}
