// The bundled and user presets, with the active one marked.

import { existsSync } from "node:fs";

import type { CommandResult, Ctx } from "../cli.ts";
import { AXIS_DEFAULT, riskyAxes } from "../core/anchors.ts";
import { parseConfig, type Config } from "../core/config.ts";
import { applyPreset, inspectPresetLibrary, matchesPreset } from "../core/presets.ts";
import { nonDefaultAxes } from "../core/combos.ts";
import { catalogue, configLanguage, detectLanguage, isLanguage } from "../core/i18n.ts";
import { cells, maxCells, padEnd, truncate, wrap } from "../ui/width.ts";
import { nextStep, riskAxesShort, riskNotice } from "../ui/format.ts";
import { captureRawEntry, rawReadChange } from "../wiring/apply.ts";

export function runList(ctx: Ctx): CommandResult {
  let config: Config | null = null;
  // No config yet is a fresh machine, not damaged settings.
  let notSetUp = false;
  try {
    const capture = captureRawEntry(ctx.paths.config, ctx.t, { within: ctx.paths.root, allowLink: false });
    const read = rawReadChange(capture, ctx.t);
    if (read.before !== null) config = parseConfig(read.before, ctx.t);
    else notSetUp = true;
  } catch {
    notSetUp = !existsSync(ctx.paths.root);
    // The library remains usable; unknown active state is never a manufactured default.
  }
  const library = inspectPresetLibrary(ctx.paths.presets, ctx.t);
  const conflicts = library.conflicts.filter((conflict) => !conflict.resolved);
  const ambiguous = conflicts.some((conflict) => conflict.slug === config?.preset);
  const activeKnown = config !== null && !ambiguous;

  const rows = library.entries.map(({ preset: p, source }) => {
    const axes = applyPreset(p);
    const count = nonDefaultAxes(axes, AXIS_DEFAULT).length;
    return {
      slug: p.slug,
      displayName: p.displayName,
      bundled: p.bundled === true,
      nonDefaultAxes: count,
      riskAxes: riskyAxes(axes),
      source,
      available: true,
      active: activeKnown ? p.slug === config!.preset : null,
    };
  });

  const copy = catalogue(config && isLanguage(config.language) ? config.language : configLanguage(ctx.paths.config) ?? detectLanguage(ctx.env));

  // Suggest a look at a profile other than the one already applied.
  const preview = rows.find((row) => !row.active);
  const ui = ctx.ui;
  // The names line up beneath the longest slug; a longer one only pushes its own row.
  const slugWidth = Math.min(16, Math.max(...rows.map((r) => cells(r.slug))));
  return {
    lines: [
      ...rows.flatMap((r, index) => {
        // Same rule as `show`: the active row says when the current tone has drifted from it.
        const drifted = r.active && (config!.unsaved || !matchesPreset(config!, library.entries[index]!.preset));
        const states = [r.active ? ctx.t.preset.activeState : null, drifted ? ctx.t.preset.unsaved : null,
          r.bundled ? null : ctx.t.preset.yours].filter((state) => state !== null);
        const summary = copy.presets[r.slug] ?? ctx.t.preset.nonDefault(r.nonDefaultAxes);
        const values = library.entries[index]!.preset.values;
        const changed = Object.entries(values).filter(([axis, level]) => AXIS_DEFAULT[axis as keyof typeof AXIS_DEFAULT] !== level)
          .map(([axis, level]) => `${axis}=${level}`).join("  ");
        const head = `${padEnd(r.slug, slugWidth)}  `;
        // The name gives way first: "active" and "unsaved changes" are what a person scans for.
        const suffix = states.map((state) => ` · ${state}`).join("");
        const room = ui.width - 4 - maxCells(head);
        const title = room - maxCells(suffix) >= 2
          ? truncate(r.displayName, room - maxCells(suffix)) + suffix
          : truncate(r.displayName + suffix, Math.max(1, room));
        const used = 4 + maxCells(head) + maxCells(title);
        const risk = r.riskAxes.length ? riskAxesShort(r.riskAxes) : "";
        // The risk mark rides the title line when it fits: flush right on a terminal, two spaces
        // after the title elsewhere. Otherwise it takes its own line under the description.
        const beside = risk !== "" && used + 2 + maxCells(risk) <= ui.width;
        const gap = ui.terminal ? ui.width - used - maxCells(risk) : 2;
        return [
          `  ${r.active ? ui.accent("*") : " "} ${head}${ui.bold(title)}${beside ? " ".repeat(gap) + riskNotice(risk, ui) : ""}`,
          ...wrap(summary, ui.width - 4).map((line) => `    ${line}`),
          ...(risk !== "" && !beside
            ? wrap(risk, ui.width - 6).map((line, row) => `    ${row === 0 ? "" : "  "}${riskNotice(line, ui)}`) : []),
          ...(ctx.flags.verbose && changed ? wrap(changed, ui.width - 4).map((line) => `    ${ui.dim(line)}`) : []),
          ...(index < rows.length - 1 ? [""] : []),
        ];
      }),
      ...library.unavailable.flatMap((entry) => wrap(ctx.t.preset.unavailable(entry.slug, entry.reason), ui.width - 2)
        .map((line) => `  ${ui.warn(line)}`)),
      ...nextStep(preview ? `tonedial show ${preview.slug}` : "tonedial doctor", ui),
    ],
    json: {
      presets: [...rows, ...library.unavailable.map((entry) => ({ ...entry, available: false, active: null }))],
      active: config?.preset ?? null,
      activeKnown,
      skipped: library.unavailable.map((entry) => `${entry.slug}: ${entry.reason}`),
      conflicts: conflicts.map((conflict) => ({
        slug: conflict.slug, recoveredSlug: conflict.recovery.preset.slug, resolved: false,
      })),
    },
    warnings: [
      ...(config === null ? [notSetUp ? ctx.t.preset.notSetUp : ctx.t.preset.activeUnknown] : []),
      ...(ambiguous ? [ctx.t.preset.activeConflict(config!.preset!)] : []),
      ...conflicts.map((conflict) =>
        ctx.t.preset.conflict(conflict.slug, conflict.recovery.preset.slug)),
    ],
  };
}
