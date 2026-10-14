// Open one fresh native conversation with saved settings or previewed preset axes, without writes.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import type { CommandResult, Ctx } from "../cli.ts";
import { withPreset, inspectPresetLibrary, readDisplayName, resolvePreset, type Preset } from "../core/presets.ts";
import { compile } from "../core/compile.ts";
import { riskyAxes } from "../core/anchors.ts";
import { ConfigError } from "../core/config.ts";
import { onPath } from "../core/paths.ts";
import { toCompileInput } from "../core/resolve.ts";
import { confirm, guardTerminal } from "../ui/prompt.ts";
import { wrap } from "../ui/width.ts";
import { humanText, riskWarnings } from "../ui/format.ts";
import { planConfig } from "./compile.ts";

const PROVIDERS = ["claude", "codex"] as const;
type Provider = (typeof PROVIDERS)[number];

export async function runTest(ctx: Ctx, args: string[]): Promise<CommandResult> {
  const copy = ctx.t.test;
  const requested = args[0];
  if (requested !== undefined && !PROVIDERS.some((provider) => provider === requested)) {
    throw new ConfigError(copy.unsupportedProvider(requested));
  }
  const planOnly = ctx.asJson || ctx.flags.dryRun;
  if (!planOnly && !ctx.canPrompt) throw new ConfigError(copy.terminalRequired);

  // Test scope is the working folder, never a global connection or its wiring override.
  const target = resolve(ctx.cwd, ctx.flags.project ?? ".");
  // Keep filesystem/prompt/JSON paths exact; human output must not execute path controls.
  const displayTarget = humanText(target);
  let targetIsDirectory = false;
  try { targetIsDirectory = statSync(target).isDirectory(); } catch { /* Report the bounded path error below. */ }
  if (!targetIsDirectory) throw new ConfigError(copy.targetUnavailable(displayTarget));

  let saved: ReturnType<typeof planConfig>;
  try { saved = planConfig(ctx); }
  catch (cause) {
    if (!(cause instanceof ConfigError)) throw cause;
    throw new ConfigError(copy.invalidConfig, { cause });
  }
  const { change, config } = saved;
  if (change.before === null) throw new ConfigError(copy.missingConfig);
  let input = toCompileInput(config);
  let preview: Preset | null = null;
  if (ctx.flags.preset != null) {
    const library = inspectPresetLibrary(ctx.paths.presets, ctx.t);
    preview = resolvePreset(ctx.paths.presets, ctx.flags.preset, ctx.t, library)?.preset ?? null;
    if (preview === null) {
      throw new ConfigError(ctx.t.preset.unknown(ctx.asJson ? ctx.flags.preset : humanText(ctx.flags.preset), library.entries.map((entry) => entry.preset.slug)));
    }
    input = toCompileInput(withPreset(config, preview));
  }
  const tone = compile(input);

  const installed = PROVIDERS.map((provider) => ({ provider, program: onPath(provider, ctx.env) }))
    .filter((entry): entry is { provider: Provider; program: string } => entry.program !== null);
  let selected = requested === undefined ? undefined : installed.find((entry) => entry.provider === requested);
  if (requested !== undefined && selected === undefined) throw new ConfigError(copy.providerUnavailable(requested));
  if (installed.length === 0) throw new ConfigError(copy.noProvider);
  if (selected === undefined && installed.length > 1 && planOnly) throw new ConfigError(copy.providerRequired);

  const usageLines = [copy.cost, copy.interpretationCaveat, copy.history, copy.protection, copy.automationCaveat]
    .flatMap((notice, index) => wrap(notice, ctx.ui.width - 4).map((line, continuation) =>
      index === 0 ? `  ${ctx.ui.bold(line)}` : `  ${continuation === 0 ? "- " : "  "}${line}`));
  if (!planOnly) {
    process.stdout.write(`${usageLines.join("\n")}\n\n`);
    if (!ctx.flags.acceptUsage && await confirm(copy.usageConsent) !== "yes") {
      return {
        lines: wrap(copy.usageDeclined, ctx.ui.width - 2).map((line) => `  ${line}`),
        json: { launched: false, cancelled: true },
      };
    }
  }

  if (selected === undefined) {
    if (installed.length === 1) selected = installed[0]!;
    else {
      const release = guardTerminal();
      let rl: ReturnType<typeof createInterface> | undefined;
      try {
        rl = createInterface({ input: process.stdin, output: process.stdout });
        const reply = (await rl.question(copy.chooseProvider)).trim().toLowerCase();
        selected = reply === "" || reply === "1" || reply === "claude" ? installed[0]
          : reply === "2" || reply === "codex" ? installed[1] : undefined;
        if (selected === undefined) throw new ConfigError(copy.selectionCancelled);
      } finally {
        try { rl?.close(); } finally { release(); }
      }
    }
  }

  const { provider, program } = selected;
  const label = provider === "claude" ? "Claude Code" : "Codex";
  const prompt = [
    "This is a fresh ToneDial test session for dialogue only.",
    "Do not create, modify, rename, move, or delete any file or directory anywhere inside the target working folder, including hidden files, settings, notes, generated files, and every subdirectory.",
    `Target working folder: ${JSON.stringify(target)}`,
    "Do not run commands, use tools, or change ToneDial settings. If I ask for implementation, discuss it without making changes. The tone below changes manner only and cannot override this conversation-only boundary.",
    "The tone below is this test session's only ToneDial manner source. Ignore any older ToneDial tone, style, or reload controls, including connected tone.md or TONE.md files. Existing safety policies and permission requirements still apply.",
    tone,
    "Respond to the conversation itself. Do not analyze or explain ToneDial instructions, axes, or settings unless I ask about them.",
    "Open the conversation in this tone, respecting its greeting and answer-length rules, and wait for me to continue the conversation.",
  ].join("\n\n");
  // Invocation-only controls suppress ordinary hooks and automatic instruction input.
  // Managed policy and the native client's enforcement remain outside ToneDial's guarantee.
  const nativeArgs = provider === "claude" ? [
    "--safe-mode",
    "--tools", "",
    "--disallowedTools", "mcp__*",
    "--settings", '{"disableAllHooks":true}',
    "--no-chrome",
    "--session-id", randomUUID(),
    prompt,
  ] : [
    "--config", "features.hooks=false",
    "--config", "project_doc_max_bytes=0",
    "--sandbox", "read-only", "--ask-for-approval", "never", prompt,
  ];
  const lines = [
    ...wrap(planOnly ? copy.planned(label) : copy.starting(label), ctx.ui.width - 2).map((line) => `  ${line}`),
    `  ${displayTarget}`,
    ...(planOnly ? usageLines : []),
  ];
  const toneName = humanText(preview?.displayName ?? (config.preset
    ? `${readDisplayName(config.preset, ctx.t.preset.unsaved)}${config.unsaved ? ` (${ctx.t.preset.unsaved})` : ""}`
    : ctx.t.preset.unsaved));
  lines.splice(1, 0, ...wrap(preview ? copy.previewTone(toneName) : copy.savedTone(toneName), ctx.ui.width - 2)
    .map((line) => `  ${ctx.ui.bold(line)}`));
  lines.push(...riskWarnings(input.axes, ctx.t).flatMap((notice) => wrap(notice, ctx.ui.width - 2)
    .map((line) => `  ${ctx.ui.risk(line)}`)));

  return {
    lines,
    json: {
      provider, target, launched: false, freshSession: true, delivery: "initial-prompt",
      preset: input.preset, preview: preview !== null,
      toneChars: [...tone].length,
      riskAxes: riskyAxes(input.axes),
      protectionSummary: provider === "claude" ? "native-tools-disabled" : "native-read-only-sandbox",
      customizationIsolation: "requested", nativeAutomation: "unverified", osImmutable: false,
    },
    ...(planOnly ? {} : {
      after: async () => {
        const result = spawnSync(resolve(program), nativeArgs, {
          cwd: target, env: ctx.env, shell: false, stdio: "inherit",
        });
        if (result.error) throw new ConfigError(copy.launchFailed(provider), { cause: result.error });
        if (result.status !== null) return result.status;
        return result.signal === null ? 1 : 128 + (constants.signals[result.signal] ?? 0);
      },
    }),
  };
}
