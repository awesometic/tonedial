// Neutral-width bar glyphs keep filled and empty cells aligned in CJK terminals.
// Risk uses theme red and a monochrome !; it never lowers a selected level.

import { AXIS_DEFAULT, AXIS_GROUP, AXIS_KIND, AXIS_ORDER, AXIS_RISK_FROM, riskyAxes, type Axes } from "../core/anchors.ts";
import { SETTING_KEYS } from "../core/config.ts";
import type { Catalogue, Messages } from "../core/i18n.ts";
import type { Palette } from "./style.ts";
import { cells, maxCells, padEnd, truncate, wrap } from "./width.ts";
import { stripVTControlCharacters } from "node:util";

const bar = (level: number) => "▮".repeat(level) + "▯".repeat(5 - level);

const GROUP_WIDTH = Math.max(...AXIS_ORDER.map((a) => cells(AXIS_GROUP[a])));
const AXIS_WIDTH = Math.max(...AXIS_ORDER.map((a) => cells(a)));

/** Labels for the two numeric columns, shared by static and interactive views. */
export function gaugeHeader(palette: Palette, t: Messages): string {
  const gutter = palette.width >= 46 ? GROUP_WIDTH + 1 : 0;
  const legend = ` · ${t.artifact.riskMarker}`;
  const prefix = palette.width >= 34
    ? `${" ".repeat(2 + gutter + AXIS_WIDTH + 2)}${padEnd(t.artifact.currentLevel, 10)}`
    : `${t.artifact.currentLevel} / `;
  const full = prefix + t.artifact.defaultLevel + legend;
  const header = maxCells(full) <= palette.width ? prefix + t.artifact.defaultLevel : prefix + t.artifact.defaultLevelShort;
  return palette.dim(truncate(header + legend, palette.width));
}

/**
 * One row per axis, grouped by observable. The group name appears on the first row of its
 * group and nowhere else, which is a level of hierarchy that costs no line of its own.
 */
export function gaugeBlock(axes: Axes, palette: Palette, cursor = -1): string[] {
  const lines: string[] = [];
  const risks = riskyAxes(axes);
  let lastGroup = "";

  for (const [index, axis] of AXIS_ORDER.entries()) {
    const level = axes[axis];
    const group = AXIS_GROUP[axis];
    const gutter = palette.width < 46 ? "" : `${group === lastGroup ? " ".repeat(GROUP_WIDTH) : padEnd(group, GROUP_WIDTH)} `;
    lastGroup = group;
    // The dial marks its row here rather than rendering its own block, so the interactive
    // screen and the printed one cannot drift apart. `cursor` is -1 for every static caller.
    const selected = index === cursor;
    const caret = selected ? palette.accent("> ") : "  ";

    const moved = level !== AXIS_DEFAULT[axis];
    const marker = moved ? palette.accent(`  *${AXIS_DEFAULT[axis]}`) : `   ${AXIS_DEFAULT[axis]}`;
    const risk = risks.includes(axis);
    // Narrow views keep current/default numbers and drop the group gutter, then the bar.
    const nameWidth = Math.min(AXIS_WIDTH, Math.max(2, palette.width - 10));
    const name = padEnd(truncate(axis, nameWidth), nameWidth);
    const gauge = palette.width >= 34 ? `${risk ? palette.risk(bar(level)) : selected || moved ? palette.accent(bar(level)) : bar(level)}  ` : "";
    const label = selected ? palette.bold(palette.accent(name)) : moved ? name : palette.dim(name);
    const current = risk ? palette.bold(palette.risk(`${level}!`)) : `${palette.bold(String(level))} `;
    const row = `${caret}${palette.dim(gutter)}${label}  ${gauge}${current}${marker}`;
    if (maxCells(stripVTControlCharacters(row)) <= palette.width) lines.push(row);
    else {
      const value = risk ? palette.risk(`${level}!`) : String(level);
      lines.push(palette.width < 4 ? value
        : `${selected ? palette.accent(">") : ""}${truncate(axis, Math.max(1, palette.width - (risk ? 3 : 2) - (selected ? 1 : 0)))}=${value}`);
    }
  }
  return lines;
}

/**
 * What `show --explain` adds: exactly what the gauge block dropped, plus the per-language hints.
 *
 * Nothing was lost when the legend moved — only relocated off a screen a user reads many times
 * a day onto one they read once. The hints are the reason `--explain` is worth a second command
 * rather than a longer first one: they say what each axis *observes*, which is the thing a
 * twelve-row gauge of English identifiers cannot convey to someone reading in Korean.
 *
 * **A hint never paraphrases its anchor.** An anchor is an instruction the agent reads; a hint
 * is an explanation a person reads. Blurring the two is how a per-language anchor set creeps
 * back in after the decision that collapsed them to one English set.
 */
export function explainBlock(palette: Palette, copy: Catalogue): string[] {
  // One catalogue, so the headers and the tables cannot come back in two languages: `ctx.t` is
  // resolved from a hardened read of the config that falls back to the machine locale, and the
  // hints from a full parse of it, and those two can disagree.
  const t = copy.cli;
  const permission = AXIS_ORDER.filter((a) => AXIS_KIND[a] === "permission");
  const lines = [...wrap(`* ${t.artifact.defaultMarker}`, palette.width - 2).map((line) => `  ${line}`), ""];
  const neutral = t.artifact.permissionAxes(permission);
  for (const folded of wrap(neutral, palette.width - 2)) lines.push(`  ${folded}`);

  /**
   * One shape for both tables: a label column, the line saying what the thing owns, and an
   * optional detail folded under it.
   *
   * The column is the widest label in its own table rather than the axis width, because a
   * settable key (`persona.self_ref`) is longer than any axis name and padding to a narrower
   * column pushes every description out of alignment. For the axis table the two are the same
   * number, so its rows are unchanged.
   */
  const table = (rows: readonly { label: string; owns: string; detail: string | null }[]): void => {
    const column = Math.max(AXIS_WIDTH, ...rows.map((r) => cells(r.label)));
    const budget = palette.width - column - 8;
    const gutter = " ".repeat(column);
    // Keep the label on its first row; narrow terminals fold both descriptions and detail.
    for (const { label, owns, detail } of rows) {
      const descriptions = wrap(owns, palette.width - column - 6);
      lines.push(`    ${palette.bold(padEnd(label, column))}  ${descriptions[0]}`);
      for (const folded of descriptions.slice(1)) lines.push(`    ${gutter}  ${folded}`);
      for (const folded of detail === null ? [] : wrap(detail, budget)) {
        lines.push(`    ${gutter}  ${folded}`);
      }
    }
  };

  {
    lines.push("", `  ${palette.bold(t.artifact.whatEachAxisObserves)}`, "");
    table(AXIS_ORDER.flatMap((axis) => {
      const hint = copy.axisHints[axis];
      return hint ? [{ label: axis, owns: hint.owns, detail: `1 ${hint.low}  ·  5 ${hint.high}` }] : [];
    }));

    lines.push("", `  ${palette.bold(t.artifact.whatElseIsSettable)}`, "");
    table(SETTING_KEYS.map((key) => ({ label: key, owns: copy.settingHints[key], detail: null })));
  }

  lines.push("", `  ${palette.bold(t.artifact.riskHeading)}`);
  for (const folded of wrap(t.notice.riskIntro, palette.width - 2)) lines.push(`  ${folded}`);
  lines.push(...wrap(Object.entries(AXIS_RISK_FROM).map(([axis, level]) => `${axis} ${level}+`).join(" · "), palette.width - 2)
    .map((line) => `  ${line}`));
  return lines;
}
