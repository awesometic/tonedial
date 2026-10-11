// The bundled and user presets, with the active one marked.

import type { CommandResult, Ctx } from "../cli.ts";
import { AXIS_DEFAULT, riskyAxes } from "../core/anchors.ts";
import { parseConfig, type Config } from "../core/config.ts";
import { applyPreset, inspectPresetLibrary } from "../core/presets.ts";
import { nonDefaultAxes } from "../core/combos.ts";
import { catalogue, configLanguage, detectLanguage, isLanguage } from "../core/i18n.ts";
import { truncate, wrap } from "../ui/width.ts";
import { captureRawEntry, rawReadChange } from "../wiring/apply.ts";

export function runList(ctx: Ctx): CommandResult {
  let config: Config | null = null;
  try {
    const capture = captureRawEntry(ctx.paths.config, ctx.t, { within: ctx.paths.root, allowLink: false });
    const read = rawReadChange(capture, ctx.t);
    if (read.before !== null) config = parseConfig(read.before, ctx.t);
  } catch {
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

  return {
    lines: [
      `  ${ctx.ui.bold(ctx.t.help.groups.presets)}`,
      "",
      ...rows.flatMap((r, index) => {
        const name = r.active ? ctx.t.preset.active(r.displayName) : r.displayName;
        const ownership = r.bundled ? "" : ` (${ctx.t.preset.yours})`;
        const summary = copy.presets[r.slug] ?? ctx.t.preset.nonDefault(r.nonDefaultAxes);
        const values = library.entries[index]!.preset.values;
        const changed = Object.entries(values).filter(([axis, level]) => AXIS_DEFAULT[axis as keyof typeof AXIS_DEFAULT] !== level)
          .map(([axis, level]) => `${axis}=${level}`).join("  ");
        return [
          `  ${r.active ? ctx.ui.accent("*") : " "} ${ctx.ui.bold(truncate(name + ownership, ctx.ui.width - 4))}`,
          ...wrap(`${r.slug} · ${summary}`, ctx.ui.width - 4).map((line) => `    ${line}`),
          ...(r.riskAxes.length ? wrap(ctx.t.notice.riskAxes(r.riskAxes), ctx.ui.width - 4).map((line) => `    ${ctx.ui.risk(line)}`) : []),
          ...(ctx.flags.verbose && changed ? wrap(changed, ctx.ui.width - 4).map((line) => `    ${ctx.ui.dim(line)}`) : []),
          "",
        ];
      }),
      ...library.unavailable.flatMap((entry) => wrap(ctx.t.preset.unavailable(entry.slug, entry.reason), ctx.ui.width - 2)
        .map((line) => `  ${ctx.ui.warn(line)}`)),
      `  ${ctx.ui.accent("tonedial show <slug>")}`,
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
      ...(config === null ? [ctx.t.preset.activeUnknown] : []),
      ...(ambiguous ? [ctx.t.preset.activeConflict(config!.preset!)] : []),
      ...conflicts.map((conflict) =>
        ctx.t.preset.conflict(conflict.slug, conflict.recovery.preset.slug)),
    ],
  };
}
