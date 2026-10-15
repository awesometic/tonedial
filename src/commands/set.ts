// `set`, `reset`, `address` and `persona`. Change state and recompile in one action, so they cannot
// drift apart.
//
// Warnings never block. A user is entitled to a combination that reads badly, and the tool's
// job is to say so. Every selected level remains unchanged, including contradictions.

import type { CommandResult, Ctx } from "../cli.ts";
import { AXIS_DEFAULT, AXIS_ORDER, riskyAxes, type Axes, type Level } from "../core/anchors.ts";
import { check as checkCombos, PERSONA_DESCRIPTION_MAX } from "../core/combos.ts";
import {
  AGE_BANDS, GENDERS, SPEECH_LEVELS,
  ConfigError, SETTING_KEYS, isAxis, nearest, nearestAxis, serializeConfig, type Config,
} from "../core/config.ts";
import { toCompileInput } from "../core/resolve.ts";
import { LANGUAGES, catalogue, isLanguage, type Messages } from "../core/i18n.ts";
import { presetSettings, resolvePreset } from "../core/presets.ts";
import { dial } from "../ui/dial.ts";
import { artifactSize, combination, humanText, riskWarnings } from "../ui/format.ts";
import { guardTerminal, interactive } from "../ui/prompt.ts";
import { createInterface } from "node:readline/promises";
import { cells, padEnd, truncate, wrap } from "../ui/width.ts";
import { applyPlanned, planArtifact, planConfig } from "./compile.ts";

/** A raw number is bucketed on write; the stored and compiled value is always the band. */
function bucketAge(value: string, t: Messages, asJson: boolean): string {
  if ((AGE_BANDS as readonly string[]).includes(value)) return value;
  const n = Number(value.replace(/s\+?$/, ""));
  if (!Number.isFinite(n)) {
    throw new ConfigError(t.persona.age(asJson ? value : humanText(value), AGE_BANDS));
  }
  if (n < 20) return "teens";
  if (n >= 50) return "50s+";
  return `${Math.floor(n / 10) * 10}s`;
}

/** The settable persona keys, in the order `set --help` and the error message list them. */
const PERSONA_FIELDS = ["age", "gender", "self_ref", "user_ref", "note", "user", "agent"] as const;

/** Report limitations in the final settings, never superseded interview answers. */
export function settingsWarnings(config: Config, t: Messages, asJson: boolean): string[] {
  const warnings: string[] = [];
  if (config.safeword && [...config.safeword].length < 4) {
    warnings.push(t.settings.safewordShort(asJson ? config.safeword : humanText(config.safeword)));
  }
  return warnings;
}

function assign(config: Config, key: string, value: string, t: Messages, asJson: boolean): void {
  if (key === "guards") {
    throw new ConfigError(t.settings.guardsRetired);
  }

  if (key === "fixed_width") {
    throw new ConfigError(t.settings.fixedWidthRetired);
  }

  if (key === "safeword") {
    const phrase = value.trim();
    config.safeword = phrase === "" ? null : phrase;
    return;
  }

  if (key === "speech_level") {
    if (!(SPEECH_LEVELS as readonly string[]).includes(value)) {
      throw new ConfigError(t.settings.speechLevel(SPEECH_LEVELS));
    }
    config.speech_level = value as Config["speech_level"];
    return;
  }

  if (key === "language") {
    if (!isLanguage(value)) throw new ConfigError(t.errors.languageUnsupported(asJson ? value : humanText(value), LANGUAGES));
    config.language = value;
    return;
  }

  if (key.startsWith("persona.")) {
    const field = key.slice("persona.".length);
    const address = config.persona.address ?? { self_ref: null, user_ref: null };
    const empty = value.trim() === "";
    switch (field) {
      case "age":
        config.persona.age = empty ? null : bucketAge(value, t, asJson);
        break;
      case "gender":
        if (!empty && !(GENDERS as readonly string[]).includes(value)) {
          throw new ConfigError(t.persona.gender(GENDERS));
        }
        config.persona.gender = empty ? null : value;
        break;
      case "self_ref":
      case "user_ref":
        address[field] = empty ? null : value;
        config.persona.address = address.self_ref || address.user_ref ? address : null;
        break;
      case "note":
        config.persona.note = empty ? null : value;
        break;
      case "user":
      case "agent": {
        const description = value.trim();
        if (description === "") {
          config.persona[field] = null;
          break;
        }
        const count = [...description].length;
        if (count > PERSONA_DESCRIPTION_MAX) {
          throw new ConfigError(t.persona.descriptionOverCap(`persona.${field}`, count, PERSONA_DESCRIPTION_MAX));
        }
        config.persona[field] = description;
        break;
      }
      default:
        // Naming the fields, because the stored shape nests the two address terms under
        // `address` and someone who has read `config.json` reaches for `persona.address.user`
        // first. An axis error already states its range; this one owed the same.
        throw new ConfigError(t.persona.unknownField(asJson ? field : humanText(field), PERSONA_FIELDS));
    }
    return;
  }

  if (key.startsWith("subagent.")) {
    throw new ConfigError(t.axis.subagentUnsupported);
  }

  if (!isAxis(key)) {
    // Everything `set` takes. A bare `persona` matches nothing here, which is the right answer:
    // `persona.` does not read as a key a person would type, and naming one arbitrary field
    // would send them to the wrong one. The pointer in the message covers that case.
    const near = nearest(key, [...AXIS_ORDER, ...SETTING_KEYS]);
    throw new ConfigError(t.axis.notSettable(asJson ? key : humanText(key), near));
  }
  const level = Number(value);
  if (!Number.isInteger(level) || level < 1 || level > 5) {
    throw new ConfigError(t.axis.range(key, asJson ? value : humanText(value)));
  }
  // Only a real move marks the state unsaved. Setting an axis to the value it already holds
  // was flipping the generation comment from the preset's slug to `unsaved`.
  if (config.axes[key] !== level) {
    config.axes[key] = level as Level;
    config.unsaved = true;
  }
}

function comboWarnings(config: Config, t: Messages): string[] {
  return checkCombos(config.axes).map((w) => combination(w, t));
}

const UNSET = "—";

/**
 * What moved, one row each. A safeword and an address term are user text with no length limit,
 * so the value columns get whatever the key column leaves — truncated rather than folded,
 * because a movement reads as one line or not at all.
 */
function movementLines(moves: { key: string; from: string; to: string }[], ctx: Ctx, axes: Axes): string[] {
  const width = Math.max(...moves.map((m) => cells(m.key)), 0);
  const valueBudget = Math.max(8, (ctx.ui.width - 2 - width - 2 - 3) / 2);
  const risks = riskyAxes(axes);
  return moves.map((m) => {
    const risk = isAxis(m.key) && risks.includes(m.key);
    const current = truncate(humanText(m.to), valueBudget - (risk ? 1 : 0)) + (risk ? "!" : "");
    return `  ${padEnd(m.key, width)}  ${ctx.ui.dim(truncate(humanText(m.from), valueBudget))} ` +
      `${ctx.ui.dim("→")} ${ctx.ui.bold((risk ? ctx.ui.risk : ctx.ui.accent)(current))}`;
  });
}

/**
 * A key's current value, for display. `set` is the verb that turns the dial, so what it owes a
 * user is the movement rather than the list of keys touched — `warmth 3 → 5` is what someone
 * undoing a change needs, and the old value is on hand at exactly this moment and nowhere else.
 *
 * Returns `undefined` for a key this tool does not have, which `assign` then rejects by name.
 */
function readKey(config: Config, key: string, t: Messages): string | undefined {
  if (key === "safeword") return config.safeword ?? UNSET;
  if (key === "speech_level") return config.speech_level;
  if (key === "language") return config.language;
  if (key.startsWith("persona.")) {
    const field = key.slice("persona.".length);
    if (field === "age") return config.persona.age ?? UNSET;
    if (field === "gender") return config.persona.gender ?? UNSET;
    if (field === "self_ref") return config.persona.address?.self_ref ?? UNSET;
    if (field === "user_ref") return config.persona.address?.user_ref ?? UNSET;
    if (field === "note") {
      const note = config.persona.note;
      return note ? t.persona.noteChars([...note].length) : UNSET;
    }
    if (field === "user" || field === "agent") {
      const description = config.persona[field];
      return description ? t.persona.descriptionChars(field, [...description].length) : UNSET;
    }
    return undefined;
  }
  return isAxis(key) ? String(config.axes[key]) : undefined;
}

/**
 * `tonedial set` with nothing after it opens the dial, on a terminal.
 *
 * It occupies a slot that was an error, so nothing that worked before behaves differently:
 * `tonedial set warmth=5` is still non-interactive, scriptable, and idempotent, which it has to
 * be because the skill and the slash command call it. Off a terminal this stays the error it
 * was rather than blocking on a question nobody can see.
 */
type Applied = {
  warnings: string[];
  changed: string[];
  moves: { key: string; from: string; to: string }[];
};

/**
 * Assign each pair, and record the movement each one actually made.
 *
 * Shared by `set` and `address` so that one write path leaves one kind of receipt. The
 * before-and-after read around `assign` is what turns "these keys were touched" into
 * `warmth 3 → 5`, and a second copy of it would be a second answer to what counts as a change.
 */
function applyPairs(config: Config, pairs: readonly (readonly [string, string])[], t: Messages, asJson: boolean): Applied {
  const settingsBefore = JSON.stringify(presetSettings(config));
  const changed: string[] = [];
  const moves: Applied["moves"] = [];

  for (const [key, value] of pairs) {
    const before = readKey(config, key, t);
    assign(config, key, value, t, asJson);
    changed.push(key);
    const after = readKey(config, key, t);
    // Only a real move. `set formality=3` on an axis already at 3 was reporting `3 → 3`, which
    // is the misleading `from` this line exists to prevent.
    if (before !== undefined && after !== undefined && before !== after) {
      moves.push({ key, from: before, to: after });
    }
  }

  if (settingsBefore !== JSON.stringify(presetSettings(config))) config.unsaved = true;
  return { warnings: settingsWarnings(config, t, asJson), changed, moves };
}

/** The same assignments and validation for direct tuning and preset creation. */
export function applyAssignments(config: Config, args: string[], t: Messages, asJson: boolean): Applied {
  const pairs = args.map((arg) => {
    const eq = arg.indexOf("=");
    if (eq < 1) throw new ConfigError(t.axis.needsPair(asJson ? arg : humanText(arg)));
    return [arg.slice(0, eq), arg.slice(eq + 1)] as const;
  });
  return applyPairs(config, pairs, t, asJson);
}

/** Recompile, write, and leave the receipt shared by set, address, and the dial. */
async function commit(
  ctx: Ctx,
  configChange: ReturnType<typeof planConfig>["change"],
  config: Config,
  applied: Applied,
): Promise<CommandResult> {
  const { change: toneChange, size } = planArtifact(ctx, config);
  const finalConfig = { ...configChange, after: serializeConfig(config, ctx.t) };
  await applyPlanned(ctx, [configChange, toneChange], [finalConfig]);
  return {
    lines: [
      `  ${ctx.ui.bold(finalConfig.before === finalConfig.after ? ctx.t.axis.settingsUnchanged : ctx.ui.success(ctx.t.axis.settingsSaved))}`,
      ...movementLines(applied.moves, ctx, config.axes),
      `  ${ctx.ui.success(toneChange.before === toneChange.after ? ctx.t.artifact.current : ctx.t.artifact.generated)}`,
      ...(ctx.flags.verbose ? [`  ${ctx.ui.dim(artifactSize(size, ctx.t))}`] : []),
    ],
    json: {
      changed: applied.changed,
      moves: applied.moves,
      config: toCompileInput(config),
      chars: size.chars,
    },
    warnings: [...applied.warnings, ...riskWarnings(config.axes, ctx.t), ...comboWarnings(config, ctx.t)],
  };
}

export async function runSet(ctx: Ctx, args: string[]): Promise<CommandResult> {
  if (!args.length) {
    if (!ctx.canPrompt || !interactive()) {
      throw new ConfigError(ctx.t.axis.needsArgument);
    }
    return runDial(ctx);
  }
  const { change: configChange, config } = planConfig(ctx);
  return commit(ctx, configChange, config, applyAssignments(config, args, ctx.t, ctx.asJson));
}

/**
 * `tonedial address` — the two terms, and nothing else.
 *
 * Both are already reachable, as `set persona.self_ref` and `set persona.user_ref`. That is two
 * commands and two key names for the thing a person changes most often after the dial itself,
 * and the stored shape nests them under `address`, so the key someone reaches for first is the
 * one that does not exist. This is the same write, under the name they look for.
 *
 * The pair is taken together rather than one at a time. Half an address is the state where the
 * agent has been told what to call itself and not what to call the user, which reads as a
 * mistake rather than a choice — and taking both is what makes the interactive form able to
 * show each current value and keep it on an empty answer.
 */
export async function runAddress(ctx: Ctx, args: string[]): Promise<CommandResult> {
  const { change: configChange, config } = planConfig(ctx);
  const terms = args.length === 0 ? await askAddress(ctx, config) : args;
  if (terms.length !== 2) throw new ConfigError(ctx.t.persona.addressNeedsPair);
  const pairs = [
    ["persona.self_ref", terms[0]!],
    ["persona.user_ref", terms[1]!],
  ] as const;
  return commit(ctx, configChange, config, applyPairs(config, pairs, ctx.t, ctx.asJson));
}

/** Agent first, user second, like address's self/user pair. Apply only after both validate. */
export async function runPersona(ctx: Ctx, args: string[]): Promise<CommandResult> {
  const { change: configChange, config } = planConfig(ctx);
  try {
    const roles = args.length === 0 ? await askRoles(ctx, config) : args;
    if (roles.length !== 2) throw new ConfigError(ctx.t.persona.rolesNeedsPair);
    return commit(ctx, configChange, config, applyPairs(config, [
      ["persona.agent", roles[0]!], ["persona.user", roles[1]!],
    ], ctx.t, ctx.asJson));
  } catch (cause) {
    if (!(cause instanceof Error) || (cause as NodeJS.ErrnoException).code !== "ABORT_ERR") throw cause;
    return { lines: [`  ${ctx.t.axis.nothingChanged}`], json: { changed: [], moves: [], cancelled: true }, after: async () => 130 };
  }
}

async function askRoles(ctx: Ctx, config: Config): Promise<string[]> {
  if (!ctx.canPrompt || !interactive()) throw new ConfigError(ctx.t.persona.rolesNeedsPair);
  const release = guardTerminal();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const line of wrap(ctx.t.persona.rolesIntroduction, ctx.ui.width - 2)) process.stdout.write(`  ${line}\n`);
    const roles: string[] = [];
    for (const field of ["agent", "user"] as const) {
      const current = config.persona[field] ?? "";
      for (;;) {
        process.stdout.write("\n");
        for (const line of wrap(`${ctx.t.create[field]}${current ? `: ${humanText(current)}` : ""}`, ctx.ui.width - 2)) {
          process.stdout.write(`  ${line}\n`);
        }
        const answer = (await rl.question("  > ")).trim();
        const chosen = answer === '""' ? "" : answer || current;
        try {
          assign(structuredClone(config), `persona.${field}`, chosen, ctx.t, false);
          roles.push(chosen);
          process.stdout.write(`  ${ctx.t.create.descriptionCount([...chosen].length, PERSONA_DESCRIPTION_MAX)}\n`);
          break;
        } catch (cause) {
          if (!(cause instanceof ConfigError)) throw cause;
          for (const line of wrap(humanText(cause.message), ctx.ui.width - 2)) process.stdout.write(`  ${ctx.ui.warn(line)}\n`);
        }
      }
    }
    return roles;
  } finally {
    try { rl.close(); } finally { release(); }
  }
}

/**
 * The two questions, on a terminal.
 *
 * An empty answer keeps what is there, which is the opposite of what an empty answer means at
 * `init` — and why these are their own questions rather than that screen's. Clearing a term is
 * still one command away: `tonedial address "" ""`.
 */
async function askAddress(ctx: Ctx, config: Config): Promise<string[]> {
  if (!ctx.canPrompt || !interactive()) throw new ConfigError(ctx.t.persona.addressNeedsPair);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = async (question: string, current: string | null): Promise<string> => {
      process.stdout.write(`\n  ${question}\n`);
      const hint = current === null ? ctx.t.persona.addressNone : ctx.t.persona.addressKept(humanText(current));
      for (const line of wrap(hint, ctx.ui.width - 2)) process.stdout.write(`  ${ctx.ui.dim(line)}\n`);
      const reply = (await rl.question("  > ")).trim();
      return reply === "" ? current ?? "" : reply;
    };
    return [
      await ask(ctx.t.persona.askSelf, config.persona.address?.self_ref ?? null),
      await ask(ctx.t.persona.askUser, config.persona.address?.user_ref ?? null),
    ];
  } finally {
    rl.close();
  }
}

async function runDial(ctx: Ctx): Promise<CommandResult> {
  const { change: configChange, config } = planConfig(ctx);
  const presetName = config.preset ? resolvePreset(ctx.paths.presets, config.preset, ctx.t)?.preset.displayName ?? config.preset : undefined;
  const chosen = await dial(config.axes, ctx.ui, catalogue(isLanguage(config.language) ? config.language : "en"), process.stdin, process.stdout, {
    ...(presetName === undefined ? {} : { presetName: humanText(presetName) }),
  });

  if (chosen === null) {
    return { lines: [`  ${ctx.ui.dim(ctx.t.axis.nothingChanged)}`], json: { changed: [], moves: [], cancelled: true } };
  }

  const moves = AXIS_ORDER.filter((axis) => chosen[axis] !== config.axes[axis]).map((axis) => ({
    key: axis as string,
    from: String(config.axes[axis]),
    to: String(chosen[axis]),
  }));
  if (!moves.length) {
    return { lines: [`  ${ctx.ui.dim(ctx.t.axis.nothingChanged)}`], json: { changed: [], moves: [], cancelled: false } };
  }

  config.axes = chosen;
  config.unsaved = true;
  return commit(ctx, configChange, config, {
    warnings: [],
    changed: moves.map((move) => move.key),
    moves,
  });
}

export async function runReset(ctx: Ctx, args: string[]): Promise<CommandResult> {
  const { change: configChange, config } = planConfig(ctx);
  const [axis] = args;
  const before = axis !== undefined && isAxis(axis) ? config.axes[axis] : null;

  if (axis === undefined) {
    // Axis values only. Persona and safeword are user-level settings rather than a
    // personality, so a reset of the dial never touches them.
    config.axes = { ...AXIS_DEFAULT };
    config.preset = null;
    config.unsaved = false;
  } else {
    if (!isAxis(axis)) {
      throw new ConfigError(ctx.t.axis.unknown(ctx.asJson ? axis : humanText(axis), nearestAxis(axis)));
    }
    if (config.axes[axis] !== AXIS_DEFAULT[axis]) {
      config.axes[axis] = AXIS_DEFAULT[axis];
      config.unsaved = true;
    }
  }

  const { change: toneChange, size } = planArtifact(ctx, config);
  const finalConfig = { ...configChange, after: serializeConfig(config, ctx.t) };
  await applyPlanned(ctx, [configChange, toneChange], [finalConfig]);
  return {
    lines: [
      ...(axis
        ? [before === AXIS_DEFAULT[axis]
          ? `  ${ctx.t.axis.reset(axis, AXIS_DEFAULT[axis])}`
          : `  ${ctx.ui.bold(axis)} ${ctx.ui.dim(String(before))} ${ctx.ui.dim("→")} ${ctx.ui.bold(ctx.ui.accent(String(AXIS_DEFAULT[axis])))}`]
        : wrap(ctx.t.axis.resetAll, ctx.ui.width - 2).map(line => `  ${ctx.ui.bold(ctx.ui.success(line))}`)),
      `  ${ctx.ui.success(toneChange.before === toneChange.after ? ctx.t.artifact.current : ctx.t.artifact.generated)}`,
      ...(ctx.flags.verbose ? [`  ${ctx.ui.dim(artifactSize(size, ctx.t))}`] : []),
    ],
    json: { reset: axis ?? "all", chars: size.chars },
    warnings: [...riskWarnings(config.axes, ctx.t), ...comboWarnings(config, ctx.t)],
  };
}
