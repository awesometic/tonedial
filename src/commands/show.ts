// Active tone or preset preview. Axes lead; settings sit beside them when wide and below
// them when narrow. A nonempty artifact and recorded connections never prove native loading.

import { existsSync, readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

import type { CommandResult, Ctx } from "../cli.ts";
import { AXIS_DEFAULT, AXIS_GROUP, AXIS_KIND, AXIS_ORDER, AXIS_RISK_FROM, riskyAxes } from "../core/anchors.ts";
import { check as checkCombos, PERSONA_DESCRIPTION_MAX } from "../core/combos.ts";
import { PresetNotFound, settingValues } from "../core/config.ts";
import { compile, measure } from "../core/compile.ts";
import { withPreset, matchesPreset, inspectPresetLibrary, resolvePreset } from "../core/presets.ts";
import { toCompileInput } from "../core/resolve.ts";
import { inspectContextLayout } from "../core/seeds.ts";
import { AGENT_TOOLS } from "../core/paths.ts";
import { catalogue, isLanguage, type Messages } from "../core/i18n.ts";
import { explainBlock, gaugeBlock, gaugeHeader } from "../ui/gauge.ts";
import { planConfig } from "./compile.ts";
import { artifactSize, combination, humanText, isCopyableLine, nextStep, riskWarnings } from "../ui/format.ts";
import { maxCells, truncate, wrap } from "../ui/width.ts";
import { connections, riders, type Connection } from "../wiring/scopes.ts";
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
    throw new PresetNotFound(ctx.t, slug, library.entries.map((entry) => entry.preset.slug));
  }
  const shown = preview ? withPreset(config, preview) : config;
  const axes = shown.axes;
  const values = settingValues(shown);

  const input = toCompileInput(shown);
  const artifact = compile(input);
  const size = measure(artifact);
  const artifactOnDisk = artifactExists(ctx);
  // The config's presence cannot distinguish a prepared root from a legacy one. Use the same
  // layout decision as the mutation gate so fresh, prepared, and legacy roots stay distinct.
  let layout: ReturnType<typeof inspectContextLayout> | null = null;
  if (!artifactOnDisk) {
    const known = inspectContextConsumers(ctx.paths, ctx.agent, config, ctx.env, ctx.t);
    layout = inspectContextLayout(ctx.paths, configChange, ctx.t, {
      config: configChange.before === null ? null : config,
      expectedArtifact: preview ? compile(toCompileInput(config)) : artifact,
      ...known,
      consumerInspectionFailed: known.error !== null,
    });
  }
  const fresh = layout?.kind === "fresh";

  const activeName = preview
    ? preview.displayName
    : fresh ? `(${ctx.t.artifact.notSetUpTitle})` : config.preset
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
  const sizeLabel = artifactSize(size, ctx.t);
  // A display name has no length cap, so the title is the one row that can be pushed past the
  // budget by state alone. Truncating keeps the size at the right margin where it is read.
  const prefix = "ToneDial · show · ";
  const nameBudget = ctx.ui.width - maxCells(sizeLabel) - maxCells(status) - maxCells(prefix) - 2;
  if (nameBudget >= 2) {
    lines.push(titleRow(prefix + truncate(humanText(activeName), nameBudget) + status, sizeLabel, ctx));
  } else {
    const title = prefix + truncate(humanText(activeName), Math.max(2, ui.width - maxCells(status) - maxCells(prefix))) + status;
    for (const folded of wrap(title, ui.width)) lines.push(ui.bold(folded));
    for (const folded of wrap(sizeLabel, ui.width)) lines.push(ui.dim(folded));
  }
  // Paused delivery is the first thing to know about a tone that seems to have no effect.
  const paused = preview === null && !config.enabled;
  if (paused) lines.push(...wrap(ctx.t.delivery.offNotice, ui.width - 2).map((line) => `  ${ui.warn(line)}`));

  const { "persona.age": age, "persona.gender": gender, "persona.note": note,
    "persona.self_ref": selfRef, "persona.user_ref": userRef, "persona.user": user, "persona.agent": agent } = values;
  const personaSet = Boolean(age || gender || note || selfRef || userRef || user || agent);
  // A preview's values column holds the profile's levels, not the current tone's.
  const headerCopy = preview ? { ...ctx.t, artifact: { ...ctx.t.artifact, currentLevel: ctx.t.artifact.previewLevel } } : ctx.t;
  const moved = AXIS_ORDER.some((axis) => axes[axis] !== AXIS_DEFAULT[axis]);
  const gauges = [gaugeHeader(ui, headerCopy, { risk: riskyAxes(axes).length > 0 }), ...gaugeBlock(axes, ui, ctx.t)];
  const gaugeWidth = Math.max(...gauges.map((line) => maxCells(stripVTControlCharacters(line))));
  const detailWidth = ui.terminal && ui.width >= 119 ? ui.width - gaugeWidth - 4 : ui.width - 2;
  const details: string[] = [ui.bold(ctx.t.artifact.settingsHeading)];
  // A schema-1 preset stores axes only, so the persona, safeword and register on the screen would be
  // the current tone's, not the preset's. Say what applying it does instead of showing them as its own.
  const axisOnly = preview !== null && preview.settings === undefined;
  if (axisOnly) details.push(...wrap(ctx.t.preset.axisOnlyPreview, detailWidth).map((folded) => ui.dim(folded)));
  if (personaSet && !axisOnly) {
    const bits = [
      age ? ctx.t.persona.ageLabel(humanText(age)) : null,
      gender ? ctx.t.persona.genderLabel(humanText(gender)) : null,
      selfRef ? ctx.t.persona.callsItself(humanText(selfRef)) : null,
      userRef ? ctx.t.persona.callsYou(humanText(userRef)) : null,
      note ? ctx.t.persona.noteChars([...note].length) : null,
    ].filter(Boolean);
    if (bits.length) for (const folded of wrap(bits.join(" · "), detailWidth)) details.push(ui.dim(folded));
    // Each count sits with the text it measures, the way `save` reviews a profile.
    for (const [field, value] of [["agent", agent], ["user", user]] as const) {
      if (value === null) continue;
      const text = `${ctx.t.persona.descriptionFull(field, humanText(value))} (${[...value].length}/${PERSONA_DESCRIPTION_MAX})`;
      for (const folded of wrap(text, detailWidth)) {
        details.push(ui.dim(folded));
      }
    }
    if (note !== null) {
      for (const folded of wrap(ctx.t.persona.descriptionFull("note", humanText(note)), detailWidth)) details.push(ui.dim(folded));
    }
  }

  // Folded rather than laid out: the safeword is user text of unbounded length, so this row
  // can always exceed the budget and no amount of shortening the fixed words prevents it.
  // The interface language and the connections belong to the install, not to a preset, and the
  // language of a root that is not set up is a default no one chose.
  const rows = axisOnly ? [] : [stateRow(values, ctx.t), ...(fresh || preview !== null ? [] : [ctx.t.artifact.displaySettings(values.language)])];
  for (const text of rows) {
    for (const folded of wrap(text, detailWidth)) details.push(folded);
  }
  // Project connections an earlier version recorded on the global hook leave with that hook.
  const shared = new Set(AGENT_TOOLS.flatMap((tool) => riders(config, tool, ctx.env, ctx.cwd)).map((rider) => JSON.stringify(rider)));
  const recorded = connections(config).map((connection) =>
    shared.has(JSON.stringify(connection)) ? { ...connection, sharesGlobalHook: true as const } : connection);
  if (preview === null) details.push(...connectionRows(recorded, detailWidth, ctx.t));
  if (layout !== null) {
    const advice = layout.kind === "fresh"
      ? ctx.t.artifact.notSetUp
      : layout.kind === "current"
        ? ctx.t.artifact.notWritten
        : ctx.t.errors.contextLayout(layout.kind, humanText(ctx.paths.root));
    // Layout guidance can carry an absolute state-root path. Keep that copy target whole while
    // folding its prose within the screen's two-cell indent.
    for (const line of advice.split("\n").flatMap((line) =>
      isCopyableLine(line) ? [line] : wrap(line, ui.width - 2)
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
    // Keep the legend and save action together after the settings. A marker's key prints only
    // while the marker does: `*` beside a changed axis, nothing for a tone at its defaults.
    const legend = [moved ? ctx.t.artifact.movedFromDefault : null, needsSave ? ctx.t.preset.changesNotSaved : null].filter(Boolean).join(" · ");
    const [first, ...rest] = wrap(legend, ui.width - (moved ? 4 : 2));
    if (legend) lines.push(`  ${moved ? "* " : ""}${ui.dim(first!)}`, ...rest.map((line) => `  ${moved ? "  " : ""}${ui.dim(line)}`));
    lines.push(
      ...nextStep(preview ? `tonedial use ${preview.slug}` : fresh ? "tonedial init --tools none --global"
        : needsSave ? saveCommand : paused ? "tonedial on" : "tonedial show --explain", ui).slice(1));
  }

  const combinations = checkCombos(axes);
  const warnings = combinations.map((w) => combination(w, ctx.t));
  warnings.push(...riskWarnings(axes, ctx.t));
  if (activeConflict && preview === null) warnings.push(ctx.t.preset.activeConflict(config.preset!));

  return {
    lines,
    json: {
      preset: preview ? preview.slug : config.preset,
      preview: preview !== null,
      enabled: config.enabled,
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
      safeword: values.safeword,
      speech_level: values.speech_level,
      address_frequency: values.address_frequency,
      // Interface language never changes the compiled tone.
      language: values.language,
      chars: size.chars,
      artifact: { exists: artifactOnDisk },
      connections: recorded,
    },
    warnings,
  };
}

/**
 * The preset name reads as the title and the size sits at the right margin, which only works
 * while both fit — on anything narrower they fall back to a single space rather than pushing
 * the line past its budget. Right alignment is worth having and never worth an overflow.
 */
function titleRow(name: string, sizeLabel: string, ctx: Ctx): string {
  // Measured pessimistically. A display name is user text and may hold ambiguous-width
  // characters, so a gap sized by the narrow measure is a gap that overflows on the terminals
  // this contract exists for.
  // Flush left like every other command's banner.
  const used = maxCells(name) + maxCells(sizeLabel);
  const gap = used < ctx.ui.width ? " ".repeat(ctx.ui.width - used) : " ";
  return `${ctx.ui.bold(name)}${gap}${ctx.ui.dim(sizeLabel)}`;
}

/**
 * Scope, then each directory on its own copyable row, then the agents connected there.
 * Legacy records carry no scope or directory, so they keep the single summary row.
 */
function connectionRows(records: (Connection & { sharesGlobalHook?: true })[], width: number, t: Messages): string[] {
  if (records.length === 0 || records.some((record) => record.scope === null)) {
    return wrap(t.artifact.connectionRecords(records.map((record) => humanText(record.target))), width);
  }
  const rows = [t.artifact.connectionsHeading];
  let scope: Connection["scope"] = null;
  let destination: string | null = null;
  for (const record of records) {
    if (record.scope !== scope) rows.push(...wrap(t.artifact.connectionScope[record.scope!], width - 2).map((line) => `  ${line}`));
    if (record.scope !== scope || record.destination !== destination) {
      rows.push(`    ${humanText(record.destination!)}`);
      const here = records.filter((other) => other.scope === record.scope && other.destination === record.destination);
      const targets = here.filter((other) => !other.sharesGlobalHook).map((other) => humanText(other.target)).join(", ");
      for (const text of [...(targets ? [targets] : []), ...here.filter((other) => other.sharesGlobalHook)
        .map((other) => t.artifact.sharesGlobalHook(humanText(other.target)))]) {
        rows.push(...wrap(text, width - 6).map((line) => `      ${line}`));
      }
    }
    scope = record.scope;
    destination = record.destination;
  }
  return rows;
}

/**
 * Safeword and register on one row. Plain text, because it is folded before it is
 * painted and an escape sequence measures as characters while occupying no cell.
 */
function stateRow(values: ReturnType<typeof settingValues>, t: Messages): string {
  const safeword = values.safeword ? t.settings.safewordSet(humanText(values.safeword)) : t.settings.noSafeword;
  return `${safeword} · ${t.settings.register(values.speech_level)} · ${t.settings.addressUse(values.address_frequency)}`;
}

// Presence alone establishes neither current contents nor native loading.
function artifactExists(ctx: Ctx): boolean {
  return existsSync(ctx.paths.tone) && readFileSync(ctx.paths.tone, "utf8").length > 0;
}
