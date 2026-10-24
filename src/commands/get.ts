// Read active settings without compiling, repairing, or interpreting stored text.

import type { CommandResult, Ctx } from "../cli.ts";
import { isAxis, ADDRESS_FREQUENCIES, AGE_BANDS, GENDERS, ConfigError, nearest, settingValues, type SettableKey } from "../core/config.ts";
import { LANGUAGES, catalogue, detectLanguage, isLanguage, type Catalogue } from "../core/i18n.ts";
import { humanText } from "../ui/format.ts";
import { maxCells, padEnd, wrap } from "../ui/width.ts";
import { planConfig } from "./compile.ts";

/** The same descriptions and allowed tokens serve key reads and command help. */
export function settingHelp(key: SettableKey, copy: Catalogue): string[] {
  if (isAxis(key)) {
    const hint = copy.axisHints[key]!;
    return [hint.owns, `1–5 · 1 ${hint.low} · 5 ${hint.high}`];
  }
  const choices = key === "address_frequency" ? ADDRESS_FREQUENCIES : key === "language" ? LANGUAGES : key === "persona.age" ? AGE_BANDS : key === "persona.gender" ? GENDERS : null;
  return [copy.settingHints[key], ...(choices ? [choices.join(" | ")] : [])];
}

export function runGet(ctx: Ctx, args: string[]): CommandResult {
  const { change, config } = planConfig(ctx);
  if (change.before === null) throw new ConfigError(ctx.t.test.missingConfig);
  const all = settingValues(config);
  const [requested] = args;
  if (requested !== undefined && !Object.hasOwn(all, requested)) {
    throw new ConfigError(ctx.t.axis.notSettable(ctx.asJson ? requested : humanText(requested), nearest(requested, Object.keys(all))));
  }
  const values = requested === undefined ? all : { [requested]: all[requested as SettableKey] };
  const column = Math.max(...Object.keys(values).map(key => maxCells(key)));
  const budget = ctx.ui.width - column - 4;
  const lines = Object.entries(values).flatMap(([key, value]) => {
    const text = value === null ? "—" : humanText(String(value));
    if (budget < 12) return [`  ${ctx.ui.accent(key)}`, ...wrap(text, ctx.ui.width - 4).map(line => `    ${line}`)];
    const [first, ...rest] = wrap(text, budget);
    return [`  ${ctx.ui.accent(padEnd(key, column))}  ${first ?? ""}`,
      ...rest.map(line => `${" ".repeat(column + 4)}${line}`)];
  });
  if (requested === undefined && !config.enabled) lines.unshift(`  ${ctx.ui.bold(ctx.t.delivery.status(false))}`, "");
  if (requested !== undefined) {
    const copy = catalogue(isLanguage(config.language) ? config.language : detectLanguage(ctx.env));
    lines.push("", ...settingHelp(requested as SettableKey, copy).flatMap(hint =>
      wrap(hint, ctx.ui.width - 2).map(line => `  ${ctx.ui.dim(line)}`)));
  }
  return { lines, json: { enabled: config.enabled, values } };
}
