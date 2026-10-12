// Initialize or rebuild application state; native setup requires selected tools.

import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { lstatSync, readdirSync } from "node:fs";

import type { CommandResult, Ctx } from "../cli.ts";
import { runAppRebuild } from "./rebuild.ts";
import { runRebuildNative } from "./wire.ts";
import { ConfigError, defaultConfig, requireConfigV2, safewordRejection, serializeConfig } from "../core/config.ts";
import { compile, measure } from "../core/compile.ts";
import { toCompileInput } from "../core/resolve.ts";
import { catalogue, configLanguage, detectLanguage, isLanguage, LANGUAGES, type Language } from "../core/i18n.ts";
import { AGENT_TOOLS, LEGACY_CONTEXT_ARTIFACT_FILENAME, canonicalDestination, connectionScopeFlag, exportAliasesState, installShape, onPath, projectTonePath, type AgentTool } from "../core/paths.ts";
import { BUNDLED, applyPreset } from "../core/presets.ts";
import { SEED_VERSION, inspectContextLayout, planSeedChanges } from "../core/seeds.ts";
import { inspectOperations } from "../core/operations.ts";
import { SKILL_NAME, TONE_COMMAND_MD, TONE_COMMAND_VERSION } from "../core/skill.ts";
import { budget, humanText, nativeSetup, receiptLines, recoveryRollbackLines, riskWarnings } from "../ui/format.ts";
import { riskyAxes } from "../core/anchors.ts";
import { padEnd, wrap } from "../ui/width.ts";
import { gate, planChange } from "../wiring/apply.ts";
import { spawnSync } from "node:child_process";
import { confirm } from "../ui/prompt.ts";
import { rcPath, withPathLine } from "../wiring/shell.ts";
import { planSelectedSkills } from "../wiring/skill.ts";
import { assertDistinctHookTargets, parseToolSelection, planOrderedDelivery } from "../wiring/targets.ts";
import { contentHash, recordFileChange, resourceKey } from "../wiring/ownership.ts";

export async function runInit(entry: Ctx, _args: string[]): Promise<CommandResult> {
  const operations = inspectOperations(entry.paths);
  const pending = operations.lock.state !== "none" || operations.journals.some(({ state }) => state === "pending" || state === "invalid");
  if (pending && (entry.flags.auto || !entry.canPrompt)) throw new ConfigError(entry.t.doctor.recoveryPending);
  // Package-only installation is still fresh setup; any saved app entry instead shares the
  // data-first existing-state owner. Probe entries without decoding or following links.
  const existing = [entry.paths.config, entry.paths.agents, entry.paths.tone,
    join(entry.paths.root, LEGACY_CONTEXT_ARTIFACT_FILENAME)]
    .some((path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined) || hasPresetState(entry.paths.presets);
  if (existing) return rebuildExisting(entry);
  if (pending) {
    throw new ConfigError(entry.t.doctor.recoveryPending);
  }
  const scopeExplicit = entry.scopeExplicit ?? (entry.flags.global || entry.flags.here === true || entry.flags.project !== null);
  if (entry.flags.auto && !entry.flags.dryRun && !scopeExplicit) throw new ConfigError(entry.t.errors.scopeRequired);
  // Everything down to `chooseLanguage` speaks `entry.t`, which came from the config or, when
  // there is no config yet, from the machine's locale. That is correct here and only here:
  // these refusals happen before `--lang` has been read, let alone validated.
  const selection = entry.flags.tools === null ? null : parseToolSelection(entry.flags.tools, true, entry.t);
  if (selection === null && (entry.flags.auto || !entry.canPrompt)) {
    throw new ConfigError(entry.t.errors.toolsRequired);
  }
  if (entry.flags.commands && selection !== null && !selection.includes("claude")) {
    throw new ConfigError(entry.t.errors.commandsNeedClaude);
  }
  if (!entry.agent.live && exportAliasesState(entry.paths, entry.agent.root)) {
    throw new ConfigError(entry.t.errors.stateOverlap(projectTonePath(entry.agent.root)));
  }
  const language = chooseLanguage(entry);
  const copy = catalogue(language);
  // From here the run speaks the language it was asked for. Without this rebinding the receipt
  // came back in two languages a sentence apart: the lines composed from `copy` in the chosen
  // one, and every line composed from `ctx.t` in English — because a fresh home has no config
  // for `ctx.t` to have read the language out of. `--lang ko` on a new machine printed its
  // seed list, its skill line, and its scope line in English.
  const ctx: Ctx = { ...entry, t: copy.cli };
  const doctorCommand = `tonedial doctor ${connectionScopeFlag(ctx.agent)} --json`;
  const lines: string[] = [];
  const addReceipt = (text: string, paint = (line: string) => line) => {
    lines.push(...receiptLines(text, ctx.ui.width - 2).map((line) => `  ${paint(line)}`));
  };
  if (ctx.flags.verbose) { addReceipt(copy.init.welcome, ctx.ui.accent); lines.push(""); }

  const configChange = planChange(ctx.paths.config, (before) => before, ctx.t, undefined, ctx.paths.root);
  const fresh = configChange.before === null;
  if (!fresh) throw new ConfigError(ctx.t.errors.staleTarget(ctx.paths.config));
  const saved = defaultConfig();
  const layout = inspectContextLayout(ctx.paths, configChange, ctx.t, {
    config: null,
    expectedArtifact: compile(toCompileInput(saved)),
    instructionRoots: [ctx.agent.root, ctx.cwd, ...(ctx.env.HOME ? [ctx.env.HOME] : [])],
    operations,
  });
  if (layout.cause === "operation") throw new ConfigError(ctx.t.doctor.recoveryPending);
  if (layout.cause === "overlap") throw new ConfigError(ctx.t.errors.stateInstructionOverlap(ctx.paths.root));
  if (layout.kind === "conflict") {
    const failed = layout.inspectionFailure;
    throw new ConfigError((failed ? `${ctx.t.errors.contextInspectionFailure(failed.path, failed.reason)}\n` : "") +
      ctx.t.errors.legacyMigrationBlocked(layout.migration.reason ?? layout.cause, ctx.paths.root, doctorCommand));
  }
  if (layout.kind === "fresh" && ctx.flags.migrateLegacy) throw new ConfigError(ctx.t.errors.migrationFresh);
  ctx.contextChecks = layout.checks;
  const introduction = scopeIntroduction(ctx, copy.init.scopeHeading);
  if (ctx.canPrompt) process.stdout.write(`${introduction.join("\n")}\n`);
  else lines.push(...introduction);

  // Non-interactive by flag, or interactive by prompt. Both reach the same state, which is what
  // lets `init` be scripted without becoming a second implementation of itself.
  const answers = await ask(ctx, copy, true, selection);
  const tools = selection ?? answers.tools!;
  if (ctx.flags.commands && !tools.includes("claude")) throw new ConfigError(ctx.t.errors.commandsNeedClaude);
  const config = requireConfigV2(saved, ctx.t);
  config.language = language;
  if (answers.preset) config.axes = applyPreset(BUNDLED.find((p) => p.slug === answers.preset)!);
  if (answers.preset) config.preset = answers.preset;
  if (answers.preset) config.unsaved = false;
  if (answers.userRef !== undefined || answers.selfRef !== undefined) {
    const address = config.persona.address ?? { self_ref: null, user_ref: null };
    if (answers.userRef !== undefined) address.user_ref = answers.userRef || null;
    if (answers.selfRef !== undefined) address.self_ref = answers.selfRef || null;
    config.persona.address = address.self_ref || address.user_ref ? address : null;
  }
  if (answers.safeword !== undefined) config.safeword = answers.safeword || null;

  // Compile the proposed state in memory. No file is created until every target has been
  // validated and the user has approved the same plan that includes state and agent files.
  const artifact = compile(toCompileInput(config));
  const size = measure(artifact);

  const seeds = planSeedChanges(ctx.paths, config.managedSeeds,
    { native: tools.length > 0 }, ctx.t);
  config.managedSeeds = seeds.records;
  if (ctx.flags.auto) {
    addReceipt(copy.init.autoChose(config.preset ?? BUNDLED[0]!.slug, tools.length ? tools.join(", ") : null));
  }
  // Keep each tool's capture with its ownership record, independent of seed-array positions.
  const perTool = tools.map((tool) => {
    const plan = planOrderedDelivery(ctx.paths, ctx.agent, tool, config.wiring, ctx.env, ctx.t);
    config.wiring = plan.wiring;
    return { tool, change: plan.change, checks: plan.checks, inherited: plan.inherited, duplicates: plan.duplicates };
  });
  assertDistinctHookTargets(perTool, ctx.t);
  const changes: ReturnType<typeof planChange>[] = seeds.changes.concat(perTool.flatMap((w) => [...w.checks, w.change]));
  // Only curl installs need shell setup; include it in the same preview/approval gate.
  let rcChange: ReturnType<typeof planChange> | null = null;
  if (tools.length > 0 && installShape(ctx.paths, undefined, ctx.env) === "curl") {
    rcChange = planChange(
      rcPath(ctx.agent, ctx.env),
      (before) => withPathLine(before, ctx.paths.bin, ctx.env.SHELL),
      ctx.t,
    );
    changes.push(rcChange);
    // Installation owns the command. Init offers shell setup; a missing or broken command
    // needs the fresh installer, never a shim mutation in application recovery.
  }

  // Claude Code only and off by default: the CLI is the source of truth and this is a fourth
  // window onto it, so someone who does not want one does not get one. Through the gate like
  // everything else, because `~/.claude/commands/tone.md` is a path a user may already have
  // their own command at — `tone` is generic enough that overwriting it silently would be the
  // mistake the skill's `foreign` check exists to prevent.
  const commandFile = ctx.flags.commands ? ctx.agent.command("tone") : null;
  const commandChange = commandFile ? planChange(commandFile, () => TONE_COMMAND_MD, ctx.t) : null;
  if (commandChange) {
    const recorded = config.wiring.resources[resourceKey(commandChange.realPath, "command")];
    if (commandChange.snapshot.symbolicLink || (commandChange.before !== null
      && (recorded?.expected.type !== "file" || recorded.expected.sha256 !== contentHash(commandChange.before)))) {
      throw new ConfigError(ctx.t.errors.ownershipConflict(commandChange.path));
    }
    changes.push(commandChange);
  }

  config.seedVersion = SEED_VERSION;
  const destination = canonicalDestination(ctx.agent.root);
  const scope = ctx.agent.live ? "global" : "project";
  if (rcChange) {
    config.wiring = recordFileChange(config.wiring, {
      target: "shell", scope: "global", destination: canonicalDestination(dirname(rcChange.path)),
    }, rcChange, "shell", { version: 1, regionId: "tonedial" }, ctx.t);
  }
  if (commandChange) {
    config.wiring = recordFileChange(config.wiring, { target: "claude", scope, destination }, commandChange, "command", { version: TONE_COMMAND_VERSION }, ctx.t);
  }
  const skillPlan = planSelectedSkills(ctx.agent, tools, join(ctx.paths.skill, SKILL_NAME), config.wiring, seeds.skillFiles, ctx.t);
  config.wiring = skillPlan.wiring;
  // Commit config last so its provenance describes resources already applied by this operation.
  changes.unshift(planChange(ctx.paths.tone, () => artifact, ctx.t, undefined, ctx.paths.root));
  const finalChanges = [{ ...configChange, after: serializeConfig(config, ctx.t) }];

  const wiring = await gate([...(ctx.contextChecks ?? []), ...changes], {
    paths: ctx.paths,
    operationActions: skillPlan.actions,
    finalChanges,
    interactive: () => ctx.canPrompt,
    ...(ctx.canPrompt ? {} : { out: () => {} }),
    dryRun: ctx.flags.dryRun,
    t: ctx.t,
    auto: ctx.flags.auto,
    verbose: ctx.flags.verbose,
    ui: ctx.ui,
    heading: ctx.t.wiring.planHeading,
  });

  const applied = wiring.applied || wiring.reason === "nothing";
  const skills = applied ? skillPlan.skills : [];

  lines.push(...wiring.lines);
  // A declined run is not a finished one. Saying so is the difference between a user who knows
  // nothing was wired and one who thinks it was.
  const status = applied
    ? copy.init.done
    : wiring.reason === "dry-run" ? ctx.t.wiring.dryRun : ctx.t.wiring.declined;
  lines.push("", `  ${ctx.ui.bold(ctx.ui.accent(`# ${copy.init.resultHeading}`))}`,
    `  ${ctx.ui.bold(applied ? ctx.ui.success(status) : status)}`);
  if (applied) {
    addReceipt(ctx.t.artifact.generated, ctx.ui.success);
  }
  if (ctx.flags.verbose) {
    lines.push(`  ${ctx.ui.dim(budget(size, ctx.t))}`);
    // The seed list grows with every bundled preset, so it folds like any other sentence.
    addReceipt(ctx.t.wiring.seeded(seeds.labels));
    if (skills.length) {
      addReceipt(ctx.t.wiring.skillState(skills.map((s) => `${s.tool} ${s.state}`).join(", ")));
    }
    if (commandFile) addReceipt(ctx.t.wiring.commandInstalled(humanText(commandFile)));
  }
  if (applied) {
    const routes = perTool.map(({ tool, change, inherited, duplicates }) => ({ tool, path: change.path, inherited, duplicates }));
    for (const message of nativeSetup(copy.cli, routes, ctx.agent.live)) {
      addReceipt(message);
    }
  }
  lines.push("");
  addReceipt(copy.init.risk, ctx.ui.warn);
  addReceipt(ctx.t.notice.modelExpectation);
  for (const notice of riskWarnings(config.axes, ctx.t)) addReceipt(notice, ctx.ui.risk);
  lines.push("");
  // Skills and controls invoke bare tonedial, so command reachability needs its own hint.
  if (onPath("tonedial", ctx.env) === null) {
    addReceipt(copy.init.installHint);
  } else if (applied) {
    lines.push(`  ${ctx.ui.accent("tonedial show")}`);
  }

  // Spread rather than assigned: `exactOptionalPropertyTypes` draws a line between "no handoff"
  // and "a handoff that is undefined", and the first one is what this means.
  const after = codexHandoff(ctx, applied, tools.includes("codex"));
  return {
    lines,
    ...(after ? { after } : {}),
    json: {
      language,
      seedVersion: SEED_VERSION,
      preset: config.preset,
      riskAxes: riskyAxes(config.axes),
      safeword: config.safeword,
      seeded: seeds.labels,
      tools,
      integrations: perTool.map(({ tool, change, inherited, duplicates }) => ({ tool, path: change.path, inherited, duplicates, configuration: applied ? "configured" : "not-applied", activation: "unverified" })),
      root: ctx.paths.root,
      agentRoot: ctx.agent.root,
      live: ctx.agent.live,
      scope: ctx.agent.live ? "global" : "project",
      scopeExplicit,
      context: { kind: layout.kind, cause: layout.cause, legacyWitness: layout.legacyWitness, legacyConsumers: layout.legacyConsumers, inspectionFailure: layout.inspectionFailure, migration: layout.migration },
      migration: { route: null, needed: false, applied: false, rollbackId: null },
      wired: wiring.applied,
      operationId: wiring.operationId ?? null,
      diff: wiring.diff,
      skills,
      commands: commandFile,
      chars: size.chars,
      notice: ctx.t.notice.risk,
    },
  };
}

function hasPresetState(path: string): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) return false;
  if (!entry.isDirectory() || entry.isSymbolicLink()) return true;
  return readdirSync(path, { withFileTypes: true }).some((child) =>
    ["custom", "builtin"].includes(child.name) && child.isDirectory() && !child.isSymbolicLink()
      ? readdirSync(join(path, child.name)).length > 0 : true);
}

function scopeIntroduction(ctx: Ctx, heading: string): string[] {
  return [
    `  ${ctx.ui.bold(ctx.ui.accent(`# ${heading}`))}`,
    `  ${ctx.agent.live ? ctx.t.wiring.scopeGlobal : ctx.t.wiring.scopeHere}`,
    `  ${humanText(ctx.agent.root)}`,
    `  ${ctx.t.wiring.stateRoot}`,
    `  ${humanText(ctx.paths.root)}`,
  ];
}

async function rebuildExisting(entry: Ctx): Promise<CommandResult> {
  const scopeExplicit = entry.scopeExplicit ?? (entry.flags.global || entry.flags.here === true || entry.flags.project !== null);
  const selection = entry.flags.tools === null ? null : parseToolSelection(entry.flags.tools, true, entry.t);
  if (selection === null && (entry.flags.auto || !entry.canPrompt)) throw new ConfigError(entry.t.errors.toolsRequired);
  const language = chooseLanguage(entry);
  const copy = catalogue(language);
  const ctx: Ctx = { ...entry, t: copy.cli };
  if (ctx.flags.commands && selection !== null && !selection.includes("claude")) throw new ConfigError(ctx.t.errors.commandsNeedClaude);
  const introduction = scopeIntroduction(ctx, copy.init.scopeHeading);
  if (ctx.canPrompt) process.stdout.write(`${introduction.join("\n")}\n`);
  const resultHeading = ctx.canPrompt && !ctx.flags.auto && !ctx.flags.dryRun
    ? ["", `  ${ctx.ui.bold(ctx.ui.accent(`# ${copy.init.resultHeading}`))}`] : [];
  const app = await runAppRebuild(ctx);
  const riskIntro = [
    ...receiptLines(copy.init.risk, ctx.ui.width - 2).map(line => `  ${ctx.ui.warn(line)}`),
    ...receiptLines(ctx.t.notice.modelExpectation, ctx.ui.width - 2).map(line => `  ${line}`),
  ];
  if (ctx.flags.dryRun) {
    const answers = await ask(ctx, copy, false, selection);
    const tools = selection ?? answers.tools!;
    if (ctx.flags.commands && !tools.includes("claude")) throw new ConfigError(ctx.t.errors.commandsNeedClaude);
    const native = await runRebuildNative({ ...ctx, flags: { ...ctx.flags, tools: tools.length ? tools.join(",") : "none" } }, app.legacy, app.proposedConfig);
    return {
      lines: [...(ctx.canPrompt ? [] : introduction), ...app.lines, ...native.lines, ...riskIntro],
      json: { ...app.json, agentRoot: ctx.agent.root, live: ctx.agent.live,
        scope: ctx.agent.live ? "global" : "project", scopeExplicit, language: app.proposedConfig.language,
        seedVersion: SEED_VERSION, tools, native: native.json,
        integrations: Array.isArray(native.json.tools) ? native.json.tools.filter(route => typeof route === "object" && route !== null) : [],
        nativeAttention: app.json.nativeAttention === true || native.json.attention === true,
        appHealthy: app.json.appRebuilt === true, wired: false },
      warnings: [...(app.warnings ?? []), ...(native.warnings ?? [])],
    };
  }
  if (app.rebuiltConfig === null) return { ...app, lines: [...(ctx.canPrompt ? [] : introduction), ...resultHeading, ...app.lines, ...riskIntro] };
  const answers = await ask(ctx, copy, false, selection);
  const tools = selection ?? answers.tools!;
  if (ctx.flags.commands && !tools.includes("claude")) throw new ConfigError(ctx.t.errors.commandsNeedClaude);
  const scoped: Ctx = { ...ctx, flags: { ...ctx.flags, tools: tools.length ? tools.join(",") : "none" } };
  const native = await runRebuildNative(scoped, app.legacy);
  const codexConfigured = Array.isArray(native.json.tools) && native.json.tools.some(route =>
    typeof route === "object" && route !== null && route.tool === "codex" && typeof route.path === "string");
  const after = codexHandoff(scoped, native.json.applied === true || native.json.reason === "nothing", codexConfigured);
  return {
    lines: [...(ctx.canPrompt ? [] : introduction), ...resultHeading, ...app.lines, ...native.lines,
      ...riskIntro,
      ...recoveryRollbackLines(ctx.t, app.json.operationId, native.json.operationId)],
    ...(after ? { after } : {}),
    json: {
      ...app.json,
      agentRoot: ctx.agent.root, live: ctx.agent.live, scope: ctx.agent.live ? "global" : "project", scopeExplicit,
      language: app.rebuiltConfig.language, seedVersion: SEED_VERSION,
      tools, appHealthy: app.json.appRebuilt === true, native: native.json,
      integrations: Array.isArray(native.json.tools) ? native.json.tools.filter(route => typeof route === "object" && route !== null) : [],
      nativeAttention: app.json.nativeAttention === true || native.json.attention === true,
      wired: native.json.applied === true,
      notice: ctx.t.notice.risk,
    },
    warnings: [...(app.warnings ?? []), ...(native.warnings ?? [])],
  };
}

/** Offer a post-receipt Codex handoff; the host owns hook-trust review and approval. */
function codexHandoff(
  ctx: Ctx,
  applied: boolean,
  codexConfigured: boolean,
): (() => Promise<void>) | undefined {
  if (!applied || !codexConfigured) return undefined;
  // `--auto` is the unattended path and `--dry-run` wrote nothing; neither has a question to ask.
  if (!ctx.canPrompt || ctx.flags.auto || ctx.flags.dryRun) return undefined;
  const codex = onPath("codex", ctx.env);
  if (codex === null) return undefined;
  // A recorded hash cannot verify the current definition's trust. Let the host own review.
  return async () => {
    // What is about to happen, before it happens. A prompt that only says "open Codex?" leaves
    // the person guessing whether their shell is coming back and what they are meant to do once
    // they are there — and the answer to the first one is what makes saying no safe.
    for (const folded of wrap(ctx.t.wiring.codexOpenSteps, ctx.ui.width - 2)) {
      process.stdout.write(`  ${folded}\n`);
    }
    if ((await confirm(`  ${ctx.t.wiring.codexOpen}`)) !== "yes") return;
    // Inherited stdio: this is a handoff, not a subprocess whose output this tool mediates.
    // Codex owns the terminal until the user leaves it, and its exit status is its own — the
    // setup it was opened to finish is already on disk and already reported.
    spawnSync(codex, [], { stdio: "inherit" });
  };
}

/** Explicit language, then saved choice, then locale; reject unsupported explicit values. */
function chooseLanguage(ctx: Ctx): Language {
  const requested = ctx.flags.lang;
  if (requested !== null) {
    if (!isLanguage(requested)) {
      throw new ConfigError(ctx.t.errors.languageUnsupported(requested, LANGUAGES));
    }
    return requested;
  }
  const chosen = configLanguage(ctx.paths.config);
  return chosen ?? detectLanguage(ctx.env);
}

type Answers = {
  preset?: string;
  userRef?: string;
  selfRef?: string;
  safeword?: string;
  tools?: AgentTool[];
};

/** The questions, asked only where there is a terminal to ask on and a reason to ask. */
async function ask(ctx: Ctx, copy: ReturnType<typeof catalogue>, fresh: boolean, selection: AgentTool[] | null): Promise<Answers> {
  if (!ctx.canPrompt || ctx.flags.auto || (ctx.flags.dryRun && selection !== null)) {
    // Re-running to refresh the seeds must not re-interrogate someone who already answered.
    return fresh ? { preset: BUNDLED[0]!.slug } : {};
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const questionText = (text: string) => wrap(text, ctx.ui.width - 2).map((line) => `  ${line}`).join("\n");
  try {
    const answers: Answers = {};
    if (fresh) {
    process.stdout.write(`\n  ${ctx.ui.bold(ctx.ui.accent(`# ${copy.init.toneHeading}`))}\n${ctx.ui.bold(questionText(copy.init.preset))}\n`);
    for (const [i, preset] of BUNDLED.entries()) {
      const summary = copy.presets[preset.slug] ?? "";
      const label = `    ${i + 1}. ${padEnd(preset.displayName, 18)} `;
      const description = wrap(summary, Math.max(1, ctx.ui.width - 26));
      process.stdout.write(`${label}${ctx.ui.dim(description[0]!)}\n`);
      for (const line of description.slice(1)) process.stdout.write(`                          ${ctx.ui.dim(line)}\n`);
    }
    const picked = Number((await rl.question("  > ")).trim());
    answers.preset = (BUNDLED[picked - 1] ?? BUNDLED[0]!).slug;

    answers.userRef = (await rl.question(`\n${ctx.ui.bold(questionText(copy.init.userRef))}\n  > `)).trim();
    answers.selfRef = (await rl.question(`\n${ctx.ui.bold(questionText(copy.init.selfRef))}\n  > `)).trim();

    process.stdout.write(`\n${questionText(copy.init.safeword)}\n${ctx.ui.dim(questionText(copy.init.safewordSkip))}\n`);
    const suggestion = copy.safewords[answers.preset];
    if (suggestion) process.stdout.write(`${ctx.ui.dim(questionText(copy.init.safewordSuggestion(suggestion)))}\n`);
    // Ask again rather than refuse at the end: the config's rules are not checked until it is
    // serialized, which is after every remaining question has been answered.
    for (;;) {
      answers.safeword = (await rl.question("  > ")).trim();
      // An empty answer is how a person declines a safeword, not a blank one.
      const rejection = answers.safeword === "" ? null : safewordRejection(answers.safeword, copy.cli);
      if (rejection === null) break;
      process.stdout.write(`${ctx.ui.error(questionText(rejection))}\n`);
    }

    }

    if (selection !== null) return answers;

    process.stdout.write(`\n  ${ctx.ui.bold(ctx.ui.accent(`# ${copy.init.connectionsHeading}`))}\n${questionText(copy.init.tools)}\n`);
    for (const [i, tool] of AGENT_TOOLS.entries()) {
      process.stdout.write(`    ${i + 1}. ${tool}\n`);
    }
    const chosen = (await rl.question("  > ")).trim();
    const names = chosen.split(",").map((name) => AGENT_TOOLS[Number(name.trim()) - 1] ?? name.trim()).join(",");
    answers.tools = parseToolSelection(chosen === "" ? "none" : names, true, ctx.t);

    return answers;
  } finally {
    rl.close();
  }
}
