import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";

import type { CommandResult, Ctx } from "../cli.ts";
import { AGENT_TOOLS, CONTEXT_ARTIFACT_FILENAME, LEGACY_CONTEXT_ARTIFACT_FILENAME, aliasesState, canonicalDestination, canonicalResourcePath, installShape, type AgentTool } from "../core/paths.ts";
import {
  ConfigError,
  isConfigV2,
  defaultConfig,
  parseConfig,
  requireConfigV2,
  serializeConfig,
  type ConfigV2,
  type LegacyOwnershipEvidence,
  type ManagedResource,
  type WiringV2,
} from "../core/config.ts";
import { OperationError } from "../core/operations.ts";
import { captureRawEntry, gate, planChange, planEntryRebuild, rawReadChange, rawReadCheck, type Change, type PlannedOperationAction, type RawEntryCapture } from "../wiring/apply.ts";
import { SKILL_NAME, TONE_COMMAND_MD, TONE_COMMAND_VERSION } from "../core/skill.ts";
import { planSelectedSkills, planSkillRemoval } from "../wiring/skill.ts";
import { planSeedChanges, seedFiles, SEED_VERSION } from "../core/seeds.ts";
import { TARGETS, assertDistinctHookTargets, ownedDelivery, parseToolSelection, planLegacyDeliveryRemoval, planOrderedDelivery, recordedHook, sameDelivery, wiredAt, wiringRemoved } from "../wiring/targets.ts";
import { hookCommand, ownedHook, withHook, withoutHook, type HookSpec } from "../wiring/hooks.ts";
import { assertRecordedTextAccess, assertRegisteredFileChange, contentHash, detachRegistration, recordFileChange, registrationKey } from "../wiring/ownership.ts";
import { pathLineState, rcPath, withPathLine } from "../wiring/shell.ts";
import { humanText, nativeSetup, receiptLines } from "../ui/format.ts";

/** The positional form names one target; lists belong to --tools. */
function selectTool(ctx: Ctx, named: string): AgentTool[] {
  if (!(AGENT_TOOLS as readonly string[]).includes(named)) {
    throw new ConfigError(ctx.t.wiring.unknownTool(named, AGENT_TOOLS));
  }
  return [named as AgentTool];
}

function artifact(ctx: Ctx): Change {
  const change = planChange(ctx.paths.tone, (before) => before, ctx.t, undefined, ctx.paths.root);
  if (change.before === null) throw new ConfigError(ctx.t.wiring.noArtifact);
  return change;
}

export async function runWire(ctx: Ctx, args: string[]): Promise<CommandResult> {
  if (args[0] !== undefined && ctx.flags.tools !== null) throw new ConfigError(ctx.t.errors.toolsAmbiguous);
  let selection = args[0] ?? ctx.flags.tools;
  if (selection === null) {
    if (ctx.flags.auto || !ctx.canPrompt) throw new ConfigError(ctx.t.errors.toolsRequired);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      selection = await rl.question(ctx.t.errors.toolsPrompt);
    } finally {
      rl.close();
    }
  }
  const tools = args[0] !== undefined ? selectTool(ctx, args[0]) : parseToolSelection(selection, false, ctx.t);
  return wireSelected(ctx, tools);
}

type ShellSelection = { path: string; id: string; destination: string; recorded: ManagedResource | undefined };
type NativeRebuildOptions = { explicitTools: boolean; preview: boolean; shell: ShellSelection | null; config: ConfigV2; configCapture: RawEntryCapture; configRead: Change };

class NativeOperationPending extends Error {
  readonly operationId: string;
  constructor(operationId: string, cause: unknown) {
    super("native operation needs recovery", { cause });
    this.operationId = operationId;
  }
}

/** The new data owner does not infer permission to alter an external consumer. */
export async function runRebuildNative(ctx: Ctx, legacy: LegacyOwnershipEvidence | null = null, previewConfig?: ConfigV2): Promise<CommandResult> {
  let tools: AgentTool[] = [];
  const explicitTools = ctx.flags.tools !== null;
  const pendingLines = receiptLines(ctx.t.recovery.nativePending, ctx.ui.width - 2).map(line => `  ${ctx.ui.warn(line)}`);
  try {
    if (previewConfig !== undefined && !ctx.flags.dryRun) throw new ConfigError(ctx.t.recovery.invalidOptions);
    const preview = previewConfig !== undefined;
    const configCapture = captureRawEntry(ctx.paths.config, ctx.t, { within: ctx.paths.root });
    const configRead = preview ? rawReadCheck(configCapture, ctx.t) : rawReadChange(configCapture, ctx.t);
    if (!preview && configRead.before === null) throw new ConfigError(ctx.t.recovery.sourceInvalid);
    const config = preview ? requireConfigV2(structuredClone(previewConfig!), ctx.t) : requireConfigV2(parseConfig(configRead.before!, ctx.t), ctx.t);
    const scope = ctx.agent.live ? "global" : "project";
    const destination = canonicalDestination(ctx.agent.root);
    tools = explicitTools ? parseToolSelection(ctx.flags.tools!, true, ctx.t) : AGENT_TOOLS.filter((tool) =>
      config.wiring.registrations[registrationKey(tool, scope, destination)]?.context === "pair");
    const attention: { tool: AgentTool | null; reason: string }[] = [];
    if (legacy && Object.keys(legacy.wiring).length > 0) attention.push({ tool: null, reason: explicitTools ? "unscoped-legacy-history" : "legacy-selection-required" });
    if (Object.values(config.wiring.registrations).some((registration) => registration.target !== "shell" &&
        (registration.scope !== scope || registration.destination !== destination))) attention.push({ tool: null, reason: "unselected-scopes" });
    if (ctx.flags.commands && !tools.includes("claude")) throw new ConfigError(ctx.t.errors.commandsNeedClaude);
    const shell = selectedShell(ctx, config.wiring, tools, explicitTools);
    if (tools.length === 0 && shell === null) return {
      lines: attention.length ? pendingLines : [],
      json: { nativeRepair: attention.length ? "attention" : "not-selected", applied: false, reason: "not-selected", tools: [], attention: attention.length > 0, issues: attention, activation: "unverified" },
    };
    const scopeExplicit = ctx.scopeExplicit ?? (ctx.flags.global || ctx.flags.here === true || ctx.flags.project !== null);
    if (ctx.flags.auto && !ctx.flags.dryRun && !scopeExplicit) throw new ConfigError(ctx.t.errors.scopeRequired);
    const result = await wireSelected({ ...ctx, contextChecks: [configRead] }, tools, { explicitTools, preview, shell, config, configCapture, configRead });
    const configured = result.json.applied === true || result.json.reason === "nothing";
    return {
      ...result,
      lines: [...result.lines, ...(attention.length ? pendingLines : [])],
      json: { ...result.json, nativeRepair: attention.length ? "attention" : configured ? "complete" : "not-applied", attention: attention.length > 0, issues: attention, activation: "unverified" },
    };
  } catch (cause) {
    // Parser errors and provider bodies stay out of every recovery result, including verbose
    // and JSON. The ordinary wire path keeps its existing diagnostics and preview contract.
    const reason = cause instanceof NativeOperationPending ? "native-operation-pending"
      : cause instanceof OperationError ? "operation-attention"
      : cause instanceof ConfigError ? "protected-native-resource" : "native-phase-failed";
    return {
      lines: pendingLines,
      json: { nativeRepair: "attention", applied: false, reason, tools,
        attention: true, issues: [{ tool: null, reason }], activation: "unverified",
        ...(cause instanceof NativeOperationPending ? { operationId: cause.operationId } : {}) },
    };
  }
}

/** PATH repair stays at its recorded global profile; explicit none never reaches this file. */
function selectedShell(ctx: Ctx, wiring: WiringV2, tools: AgentTool[], explicitTools: boolean): ShellSelection | null {
  if (installShape(ctx.paths, undefined, ctx.env) !== "curl" || explicitTools && tools.length === 0) return null;
  const path = rcPath(ctx.agent, ctx.env);
  const destination = canonicalDestination(dirname(path));
  const id = registrationKey("shell", "global", destination);
  const recorded = wiring.registrations[id]?.resourceIds.map((key) => wiring.resources[key]!).find((resource) =>
    resource.kind === "shell" && resource.accessPaths?.[id]?.path === path);
  if (!explicitTools && (!ctx.agent.live || recorded === undefined)) return null;
  if (recorded && (recorded.managed.version !== 1 || recorded.managed.regionId !== "tonedial")) throw new ConfigError(ctx.t.errors.ownershipConflict(path));
  return { path, id, destination, recorded };
}

/** Explicit selection can recognize old bytes, never old creation flags or foreign entries. */
function rebuildLegacyDelivery(ctx: Ctx, tool: AgentTool, wiring: WiringV2, explicit: boolean): { change: Change | null; wiring: WiringV2 } {
  if (tool === "antigravity") return { change: null, wiring };
  const witnessed = planLegacyDeliveryRemoval(ctx.paths, ctx.agent, tool, wiring, ctx.env, ctx.t);
  if (witnessed) return witnessed;
  if (!explicit) return { change: null, wiring };
  const path = ctx.agent.wiredFile(tool);
  if (aliasesState(ctx.paths, path)) throw new ConfigError(ctx.t.errors.stateOverlap(path));
  const roots = [...new Set([ctx.paths.root, canonicalDestination(ctx.paths.root)])];
  const locations = roots.flatMap((root) => [join(root, LEGACY_CONTEXT_ARTIFACT_FILENAME), join(root, CONTEXT_ARTIFACT_FILENAME)]).map((tone) => wiredAt(tone, ctx.env));
  const change = planChange(path, (before) => {
    if (before === null) return null;
    let remaining = before;
    for (const where of locations) {
      if (tool === "codex") {
        const command = hookCommand(where.toneAbsolute, where.home);
        // The retained hook producer owns its historical matcher and complete handler shape.
        const template = JSON.parse(withHook(null, command, path, ctx.t)) as { hooks: { SessionStart: { matcher: string; hooks: HookSpec["handler"][] }[] } };
        const block = template.hooks.SessionStart[0]!;
        const exact: HookSpec = { matchers: [block.matcher], handler: block.hooks[0]! };
        const broad = ownedHook(remaining, command, path, ctx.t);
        const known = ownedHook(remaining, exact, path, ctx.t);
        if (broad !== known) throw new ConfigError(ctx.t.errors.ownershipConflict(path));
        if (known !== null) remaining = withoutHook(remaining, exact, path, ctx.t, "document");
      } else {
        remaining = wiringRemoved(TARGETS[tool], remaining, where, path, ctx.t) ?? "";
      }
    }
    const region = remaining === before && tool !== "codex" ? ownedDelivery(TARGETS[tool], before, locations[0]!, path, ctx.t) : null;
    const references = locations.flatMap((where) => [where.tonePath, where.toneAbsolute]);
    if (region !== null || references.some((value) => remaining.includes(value) || remaining.includes(JSON.stringify(value).slice(1, -1)))) {
      throw new ConfigError(ctx.t.errors.ownershipConflict(path));
    }
    return remaining;
  }, ctx.t);
  if (change.snapshot.symbolicLink) throw new ConfigError(ctx.t.errors.ownershipConflict(path));
  return { change: change.before === change.after ? null : { ...change, created: false, createdDir: false }, wiring };
}

async function wireSelected(ctx: Ctx, tools: AgentTool[], rebuilding?: NativeRebuildOptions): Promise<CommandResult> {
  const artifactChange = rebuilding?.preview ? null : artifact(ctx);
  // Keep the per-tool planning immediately after the bounded artifact probe so an unsafe
  // artifact still fails before any
  // config, host, or seed planning, and never takes an interim legacy route.
  const configChange = rebuilding?.configRead ?? planChange(ctx.paths.config, (before) => before, ctx.t, undefined, ctx.paths.root);
  const config = rebuilding?.config ?? requireConfigV2(configChange.before === null ? defaultConfig() : parseConfig(configChange.before, ctx.t), ctx.t);
  const removals: Change[] = [];
  const plans = tools.map((tool) => {
    if (rebuilding) {
      const id = registrationKey(tool, ctx.agent.live ? "global" : "project", canonicalDestination(ctx.agent.root));
      for (const key of config.wiring.registrations[id]?.resourceIds ?? []) {
        const resource = config.wiring.resources[key]!;
        if (resource.kind !== "hook") continue;
        const path = resource.accessPaths?.[id]?.path ?? resource.path;
        const allowed = [ctx.agent.hookFile(tool), ctx.agent.wiredFile(tool)].some(candidate =>
          canonicalResourcePath(path) === canonicalResourcePath(candidate) &&
          canonicalDestination(dirname(path)) === canonicalDestination(dirname(candidate)));
        if (!allowed) throw new ConfigError(ctx.t.errors.ownershipConflict(path));
      }
    }
    const legacy = rebuilding ? rebuildLegacyDelivery(ctx, tool, config.wiring, rebuilding.explicitTools) : null;
    if (legacy) config.wiring = legacy.wiring;
    const combinedLegacy = legacy?.change && legacy.change.before !== legacy.change.after ? legacy.change : undefined;
    const plan = planOrderedDelivery(ctx.paths, ctx.agent, tool, config.wiring, ctx.env, ctx.t, process.execPath, combinedLegacy);
    if (rebuilding && plan.inherited && plan.change.before !== plan.change.after) throw new ConfigError(ctx.t.errors.ownershipConflict(plan.change.path));
    if (combinedLegacy && !plan.replacesLegacy) removals.push(combinedLegacy);
    config.wiring = plan.wiring;
    return plan;
  });
  assertDistinctHookTargets(tools.map((tool, index) => ({ tool, change: plans[index]!.change })), ctx.t);
  const changes = plans.flatMap((plan) => [...plan.checks, plan.change]);
  const seeds = rebuilding?.preview ? {
    changes: [] as Change[], records: config.managedSeeds,
    skillFiles: Object.fromEntries(seedFiles(ctx.paths, { native: tools.length > 0 }).filter((seed) => seed.id.startsWith("skill/"))
      .map((seed) => [relative(join(ctx.paths.skill, SKILL_NAME), seed.path), seed.contents])),
  } : planSeedChanges(ctx.paths, config.managedSeeds, { native: rebuilding ? tools.length > 0 : true }, ctx.t);
  config.managedSeeds = seeds.records;
  config.seedVersion = SEED_VERSION;
  let commandChange: Change | null = null;
  if (rebuilding && tools.includes("claude")) {
    const id = registrationKey("claude", ctx.agent.live ? "global" : "project", canonicalDestination(ctx.agent.root));
    const previous = config.wiring.registrations[id]?.resourceIds.map((key) => config.wiring.resources[key]!).find((resource) => resource.kind === "command");
    if (ctx.flags.commands || previous) {
      commandChange = planChange(ctx.agent.command("tone"), () => TONE_COMMAND_MD, ctx.t);
      if (commandChange.snapshot.symbolicLink || (commandChange.before !== null && (!previous || previous.expected.type !== "file" ||
          previous.expected.sha256 !== contentHash(commandChange.before)))) throw new ConfigError(ctx.t.errors.ownershipConflict(commandChange.path));
      if (previous) assertRecordedTextAccess(commandChange, previous, previous.accessPaths?.[id], ctx.t);
      config.wiring = recordFileChange(config.wiring, { target: "claude", scope: ctx.agent.live ? "global" : "project", destination: canonicalDestination(ctx.agent.root) },
        commandChange, "command", { version: TONE_COMMAND_VERSION }, ctx.t);
    }
  }
  const skillPlan = planSelectedSkills(ctx.agent, tools, join(ctx.paths.skill, SKILL_NAME), config.wiring, seeds.skillFiles, ctx.t);
  config.wiring = skillPlan.wiring;
  let shellChange: Change | null = null;
  if (rebuilding?.shell) {
    const selected = rebuilding.shell;
    if (aliasesState(ctx.paths, selected.path)) throw new ConfigError(ctx.t.errors.stateOverlap(selected.path));
    shellChange = planChange(selected.path, (before) => withPathLine(before, ctx.paths.bin, ctx.env.SHELL), ctx.t);
    if (plans.some((plan) => plan.change.realPath === shellChange!.realPath) || removals.some((change) => change.realPath === shellChange!.realPath) ||
        commandChange?.realPath === shellChange.realPath) {
      throw new ConfigError(ctx.t.errors.ownershipConflict(selected.path));
    }
    assertRegisteredFileChange(config.wiring, selected.id, shellChange, "shell", ctx.t);
    if (selected.recorded) {
      const expected = selected.recorded.expected;
      if (expected.type !== "file" || typeof expected.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(expected.sha256) ||
          (shellChange.before !== null && shellChange.before !== shellChange.after && contentHash(shellChange.before) !== expected.sha256)) {
        throw new ConfigError(ctx.t.errors.ownershipConflict(selected.path));
      }
    } else if (pathLineState(shellChange.before, ctx.paths.bin, ctx.env.SHELL) === "stale") {
      throw new ConfigError(ctx.t.errors.ownershipConflict(selected.path));
    }
    config.wiring = recordFileChange(config.wiring, { target: "shell", scope: "global", destination: selected.destination },
      shellChange, "shell", { version: 1, regionId: "tonedial" }, ctx.t);
  }
  const finalConfig = serializeConfig(config, ctx.t);
  const configRebuild = rebuilding ? planEntryRebuild(rebuilding.configCapture, finalConfig, ctx.t, { reason: "restore-config" }) : null;
  const finalChanges = rebuilding ? [] : [{ ...configChange, after: finalConfig }];
  const operationActions = [...skillPlan.actions, ...(configRebuild?.changed ? [configRebuild.action] : [])];
  let pendingOperation: string | null = null;

  const result = await gate([...(ctx.contextChecks ?? []), ...(artifactChange ? [artifactChange] : []), ...seeds.changes, ...changes, ...removals,
    ...(commandChange ? [commandChange] : []), ...(shellChange ? [shellChange] : [])], {
    paths: ctx.paths,
    operationActions,
    finalChanges,
    interactive: () => ctx.canPrompt,
    ...(ctx.canPrompt ? {} : { out: () => {} }),
    dryRun: ctx.flags.dryRun,
    t: ctx.t,
    auto: ctx.flags.auto,
    verbose: ctx.flags.verbose,
    ui: ctx.ui,
    heading: ctx.t.wiring.nativeHeading,
    ...(rebuilding ? { recoveryPresentation: {
      failureMessage: (operationId: string) => { pendingOperation = operationId; return ctx.t.recovery.nativePending; },
    }, retention: { kind: "migration" as const, reason: "delivery" as const } } : {}),
  }).catch((cause: unknown) => {
    if (pendingOperation !== null) throw new NativeOperationPending(pendingOperation, cause);
    throw cause;
  });

  const skills = result.applied || result.reason === "nothing" ? skillPlan.skills : [];
  const configured = result.applied || result.reason === "nothing";
  const routes = tools.map((tool, index) => ({
    tool,
    path: plans[index]!.change.path,
    inherited: plans[index]!.inherited,
    duplicates: plans[index]!.duplicates,
  }));

  return {
    lines: [...result.lines, ...(tools.length ? summary(ctx, result.reason, tools) :
      configured && shellChange ? [`  ${ctx.t.doctor.pathLineAt(humanText(shellChange.path))}`] : []),
      ...(configured ? nativeSetup(ctx.t, routes, ctx.agent.live).flatMap((line) =>
        receiptLines(line, ctx.ui.width - 2).map((folded) => `  ${folded}`)) : [])],
    json: {
      root: ctx.agent.root,
      live: ctx.agent.live,
      applied: result.applied,
      reason: result.reason,
      diff: result.diff,
      ...(rebuilding && result.operationId ? { operationId: result.operationId } : {}),
      skills,
      ...(rebuilding && shellChange ? { shell: { path: shellChange.path, configuration: configured ? "configured" : "not-applied" } } : {}),
      tools: routes.map((route) => ({
        ...route,
        delivery: "hook",
        configuration: configured ? "configured" : "not-applied",
        activation: "unverified",
      })),
    },
  };
}

export async function runUnwire(ctx: Ctx, args: string[]): Promise<CommandResult> {
  const tools = args[0] !== undefined ? selectTool(ctx, args[0]) : [...AGENT_TOOLS];
  const configChange = planChange(ctx.paths.config, (before) => before, ctx.t, undefined, ctx.paths.root);
  const config = configChange.before === null ? defaultConfig() : parseConfig(configChange.before, ctx.t);
  // Disconnect remains available on legacy roots. These are exact delivery identities, not
  // permission to read, rename, or delete either shared artifact.
  const shownPaths = [ctx.paths.tone, join(ctx.paths.root, LEGACY_CONTEXT_ARTIFACT_FILENAME)]
    .map((path) => wiredAt(path, ctx.env));
  const removeDelivery = (tool: AgentTool, before: string | null, path: string) =>
    shownPaths.reduce((text, where) => wiringRemoved(TARGETS[tool], text, where, path, ctx.t), before);
  const destination = canonicalDestination(ctx.agent.root);
  const scope = ctx.agent.live ? "global" : "project";
  const changes: Change[] = [];
  const operationActions: PlannedOperationAction[] = [];
  const unlinked: string[] = [];
  // Disconnecting everything refuses as a whole when any one tool cannot be identified, and the
  // refusal names the file. A partial disconnect would leave an install nobody can describe, and
  // the escape is already per-tool: `unwire <tool>` clears the ones that are still recognisable
  // and leaves the damaged one for a person to look at.
  for (const tool of tools) {
    const registrationId = registrationKey(tool, scope, destination);
    const registration = isConfigV2(config) ? config.wiring.registrations[registrationId] : undefined;
    const resources = registration && isConfigV2(config)
      ? registration.resourceIds.map((id) => ({ id, resource: config.wiring.resources[id]! }))
      : [];
    for (const { id, resource } of resources) {
      if (resource.kind === "skill" && isConfigV2(config)) {
        if (resource.consumers.some((consumer) => consumer !== registrationId)) continue;
        const skill = planSkillRemoval(resource.path, resource.expected.linkTarget ?? join(ctx.paths.skill, SKILL_NAME),
          registrationId, config.wiring, { boundary: ctx.agent.root }, ctx.t);
        if (skill.action) {
          operationActions.push(skill.action);
          unlinked.push(resource.path);
        }
        delete config.wiring.resources[id];
        continue;
      }
      // Unknown retained resources are not removal authority.
      if (resource.kind !== "hook" && resource.kind !== "command") continue;
      const access = resource.accessPaths?.[registrationId];
      const path = access?.path ?? resource.path;
      if (aliasesState(ctx.paths, path)) throw new ConfigError(ctx.t.errors.stateOverlap(path));
      const change = planChange(path, (before) => {
        if (before === null) return null;
        if (resource.kind === "command") {
          if (contentHash(before) !== resource.expected.sha256) throw new ConfigError(ctx.t.errors.ownershipConflict(path));
          return resource.created ? null : before;
        }
        const native = recordedHook(resource, registrationId);
        if (native) {
          const owned = ownedHook(before, native, path, ctx.t);
          const managed = resource.managedByRegistration?.[registrationId] ?? resource.managed;
          if (owned === null || contentHash(owned) !== managed.handlerSha256) {
            throw new ConfigError(ctx.t.errors.ownershipConflict(path));
          }
          const sharedHandler = resource.consumers.some((consumer) => consumer !== registrationId
            && sameDelivery(recordedHook(resource, consumer), native));
          const ownsFile = resource.created && contentHash(before) === resource.expected.sha256;
          const removal = { ...native };
          if (resource.consumers.some(consumer => consumer !== registrationId)) delete removal.documentDescription;
          return sharedHandler ? before : withoutHook(before, removal, path, ctx.t, ownsFile ? "content" : "document");
        }
        const owned = shownPaths.map((where) => ownedDelivery(TARGETS[tool], before, where, path, ctx.t))
          .find((delivery) => delivery !== null) ?? null;
        if (owned !== null && contentHash(owned) !== resource.managed.handlerSha256) {
          throw new ConfigError(ctx.t.errors.ownershipConflict(path));
        }
        return removeDelivery(tool, before, path);
      }, ctx.t);
      assertRecordedTextAccess(change, resource, access, ctx.t, true);
      // A shared physical file may carry more than one registration. Validate this registration's
      // lexical witness above, then leave the bytes alone while another consumer still owns the
      // physical resource.
      const shared = resource.consumers.some((consumer) => consumer !== registrationId);
      if (shared && !recordedHook(resource, registrationId)) continue;
      changes.push(withRecordedOwnership(change, {
        created: resource.created && change.before !== null && contentHash(change.before) === resource.expected.sha256,
        createdDir: resource.createdDir,
      }));
      if (isConfigV2(config)) {
        if (shared) resource.expected.sha256 = contentHash(change.after ?? "");
        else delete config.wiring.resources[id];
      }
    }
    if (registration && isConfigV2(config)) {
      config.wiring = detachRegistration(config.wiring, registrationId);
    } else {
      // Legacy cleanup has no destination provenance. Remove only positively matched content
      // and preserve the container and old state root without silently migrating its config.
      const path = ctx.agent.wiredFile(tool);
      if (aliasesState(ctx.paths, path)) throw new ConfigError(ctx.t.errors.stateOverlap(path));
      if (existsSync(path)) changes.push(withRecordedOwnership(
        planChange(path, (before) => removeDelivery(tool, before, path), ctx.t), undefined,
      ));
    }
  }
  // Disconnect is not initialization. Keep a missing/legacy config as read-only evidence;
  // otherwise an empty eject creates a config-only layout that subsequent init must refuse.
  const finalChanges = [{
    ...configChange,
    after: isConfigV2(config) && configChange.before !== null ? serializeConfig(config, ctx.t) : configChange.before,
  }];

  const result = await gate(changes, {
    paths: ctx.paths,
    operationActions,
    finalChanges,
    interactive: () => ctx.canPrompt,
    ...(ctx.canPrompt ? {} : { out: () => {} }),
    dryRun: ctx.flags.dryRun,
    t: ctx.t,
    auto: ctx.flags.auto,
    verbose: ctx.flags.verbose,
    ui: ctx.ui,
  });

  return {
    lines: [...result.lines, ...summary(ctx, result.reason, tools, "disconnect")],
    json: {
      unlinked: result.applied ? unlinked : [],
      root: ctx.agent.root,
      live: ctx.agent.live,
      applied: result.applied,
      reason: result.reason,
      diff: result.diff,
      tools,
    },
  };
}

/** The same, from what `wire` recorded when it was the only moment either fact was knowable. */
export function withRecordedOwnership(
  change: Change,
  record: { created: boolean; createdDir?: boolean } | undefined,
): Change {
  return { ...change, created: record?.created === true, createdDir: record?.createdDir === true };
}

function summary(ctx: Ctx, reason: string, tools: AgentTool[], action: "connect" | "disconnect" = "connect"): string[] {
  // Through the catalogue, not spliced in. An English literal dropped into a translated
  // sentence reads as a bug rather than as a missing translation.
  const named = tools.map((t) => TARGETS[t].label).join(", ");
  if (reason === "nothing") return receiptLines(action === "disconnect" ? ctx.t.wiring.alreadyDisconnected(named) : ctx.t.wiring.alreadyMatch(named), ctx.ui.width - 2)
    .map((line) => `  ${ctx.ui.bold(line)}`);
  if (reason === "dry-run") return [`  ${ctx.ui.warn(ctx.t.wiring.dryRun)}`];
  if (reason === "declined") return [`  ${ctx.t.wiring.declined}`];
  return [
    ...receiptLines(action === "disconnect" ? ctx.t.wiring.disconnected(named) : ctx.t.wiring.wroteInto(named), ctx.ui.width - 2)
      .map((line) => `  ${ctx.ui.success(ctx.ui.bold(line))}`),
  ];
}
