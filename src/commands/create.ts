// Build a complete profile in memory; approve one transaction after the interview.

import { createInterface } from "node:readline/promises";
import type { CommandResult, Ctx } from "../cli.ts";
import { ConfigError, serializeConfig } from "../core/config.ts";
import { check as checkCombos, PERSONA_DESCRIPTION_MAX } from "../core/combos.ts";
import { catalogue, isLanguage } from "../core/i18n.ts";
import { defaultProfileSettings, slugify } from "../core/presets.ts";
import { toCompileInput } from "../core/resolve.ts";
import { dial } from "../ui/dial.ts";
import { combination, humanText, riskWarnings } from "../ui/format.ts";
import { guardTerminal } from "../ui/prompt.ts";
import { wrap } from "../ui/width.ts";
import { planConfig } from "./compile.ts";
import { savePreset } from "./save.ts";
import { applyAssignments } from "./set.ts";

export async function runCreate(ctx: Ctx, args: string[]): Promise<CommandResult> {
  try {
    const state = planConfig(ctx);
    const { config } = state;
    const defaults = defaultProfileSettings(ctx.t).persona;
    config.persona.address = { self_ref: config.persona.address?.self_ref ?? defaults.address!.self_ref,
      user_ref: config.persona.address?.user_ref ?? defaults.address!.user_ref };
    config.persona.user ??= defaults.user;
    config.persona.agent ??= defaults.agent;
    let displayName = args[0]?.trim() ?? "";
    let slug = ctx.flags.slug ?? undefined;
    const warnings = applyAssignments(config, args.slice(1), ctx.t, ctx.asJson).warnings;

    if (ctx.canPrompt && !ctx.flags.auto && !ctx.flags.dryRun) {
      const release = guardTerminal();
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (const line of wrap(ctx.t.create.introduction, ctx.ui.width - 2)) process.stdout.write(`  ${line}\n`);
        const ask = async (label: string, current: string): Promise<string> => {
          process.stdout.write("\n");
          for (const line of wrap(`${label}${current ? `: ${humanText(current)}` : ""}`, ctx.ui.width - 2)) {
            process.stdout.write(`  ${line}\n`);
          }
          const answer = (await rl.question("  > ")).trim();
          return answer === '""' ? "" : answer || current;
        };
        displayName = await ask(ctx.t.create.name, displayName);
        if (!displayName) throw new ConfigError(ctx.t.create.needsName);
        let suggested = "";
        if (/[a-z0-9]/i.test(displayName)) suggested = slugify(displayName, ctx.t);
        slug = await ask(ctx.t.create.slug, slug ?? suggested);
        if (!slug) throw new ConfigError(ctx.t.preset.needsSlugArg);
        const fields: [string, string, string][] = [
          ["persona.self_ref", ctx.t.persona.askSelf, config.persona.address?.self_ref ?? ""],
          ["persona.user_ref", ctx.t.persona.askUser, config.persona.address?.user_ref ?? ""],
          ["persona.user", ctx.t.create.user, config.persona.user ?? ""],
          ["persona.agent", ctx.t.create.agent, config.persona.agent ?? ""],
          ["speech_level", ctx.t.create.register, config.speech_level],
          ["safeword", ctx.t.create.safeword, config.safeword ?? ""],
        ];
        for (const [key, label, value] of fields) {
          for (;;) {
            const chosen = await ask(label, value);
            try {
              const candidate = structuredClone(config);
              const applied = applyAssignments(candidate, [`${key}=${chosen}`], ctx.t, false);
              serializeConfig(candidate, ctx.t);
              Object.assign(config, candidate);
              warnings.push(...applied.warnings);
              if (key === "persona.user" || key === "persona.agent") {
                process.stdout.write(`  ${ctx.t.create.descriptionCount([...chosen].length, PERSONA_DESCRIPTION_MAX)}\n`);
              }
              break;
            } catch (cause) {
              if (!(cause instanceof ConfigError)) throw cause;
              for (const line of wrap(humanText(cause.message), ctx.ui.width - 2)) process.stdout.write(`  ${ctx.ui.warn(line)}\n`);
            }
          }
        }
      } finally {
        try { rl.close(); } finally { release(); }
      }
      const axes = await dial(config.axes, ctx.ui, catalogue(isLanguage(config.language) ? config.language : "en"),
        process.stdin, process.stdout, { presetName: humanText(displayName) });
      if (axes === null) return { lines: [`  ${ctx.t.create.notCreated}`], json: { created: false, cancelled: true } };
      config.axes = axes;
    }

    if (!displayName) throw new ConfigError(ctx.t.create.needsName);
    const result = await savePreset(ctx, displayName, state, { ...(slug === undefined ? {} : { slug }), create: true });
    return {
      ...result,
      json: { ...result.json, ...(result.json.created === true ? { config: toCompileInput(config) } : {}) },
      warnings: [...new Set([...warnings, ...(result.warnings ?? []), ...riskWarnings(config.axes, ctx.t),
        ...checkCombos(config.axes, config.persona, config.speech_level).map((notice) => combination(notice, ctx.t)),
        ctx.t.notice.modelExpectation])],
    };
  } catch (cause) {
    if (!(cause instanceof Error) || (cause as NodeJS.ErrnoException).code !== "ABORT_ERR") throw cause;
    return { lines: [`  ${ctx.t.create.notCreated}`], json: { created: false, cancelled: true }, after: async () => 130 };
  }
}
