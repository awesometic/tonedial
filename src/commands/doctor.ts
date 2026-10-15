// Diagnose application and native state; approved recovery owns repairs.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import type { CommandResult, Ctx } from "../cli.ts";
import { runAppRebuild } from "./rebuild.ts";
import { runRebuildNative } from "./wire.ts";
import { compile, measure } from "../core/compile.ts";
import { ConfigError, defaultConfig, isConfigV2, parseConfig, type Config, type ManagedResource, type WiringScope } from "../core/config.ts";
import { inspectOperations, inspectRollback } from "../core/operations.ts";
import { join, relative } from "node:path";

import { AGENT_TOOLS, CONTEXT_ARTIFACT_FILENAME, CONTEXT_GUIDE_FILENAME, UPDATE_COMMAND, connectionScopeFlag, onPath, readerPath, resolveAgentPaths, shimScript, installShape, type AgentTool, type InstallShape, canonicalDestination, shellQuote} from "../core/paths.ts";
import { SKILL_NAME } from "../core/skill.ts";
import { GUIDE_FORMAT_MARKER } from "../core/reader.ts";
import { inspect as inspectSkill, skillPath } from "../wiring/skill.ts";
import { candidateRcPaths, pathLineState, rcPath, withPathLine } from "../wiring/shell.ts";
import {
  SEED_VERSION,
  inspectContextLayout,
  inspectSeeds,
  recordedSeedSelection,
  type ContextLayoutInspection,
  type SeedInspection,
  type SeedState,
} from "../core/seeds.ts";
import { toCompileInput } from "../core/resolve.ts";
import { artifactSize, humanText, nextStep, receiptLines, recoveryRollbackLines, section } from "../ui/format.ts";
import { wrap } from "../ui/width.ts";
import { applyRollback, assertFresh, planChange, previewRollback, type Change } from "../wiring/apply.ts";
import { confirm } from "../ui/prompt.ts";
import { RegionError, find } from "../wiring/region.ts";
import { TARGETS, inspectContextConsumers, orderedFingerprint, orderedHook, recordedHook, regionContent, wiredAt, type WiredAt } from "../wiring/targets.ts";
import { hasHook, hookCommand, ownedHook } from "../wiring/hooks.ts";
import { codexHookTrust, type CodexTrust } from "../wiring/codex-trust.ts";
import { assertRecordedTextAccess, contentHash, registrationKey, resourceKey } from "../wiring/ownership.ts";

// `note` exists because true, disclosed, deliberate states were reporting as problems: a tool
// the user chose not to wire, an install that never ran `init`. A
// `doctor` that says unhealthy forever is a `doctor` nobody reads the day it means it.
type State = "ok" | "problem" | "note" | "absent";

type Check = {
  name: string;
  state: State;
  detail: string;
  /** Separate human facts while keeping the machine detail's existing prose. */
  humanDetail?: readonly string[];
  /** Actionable repair, when available. */
  repair?: string;
  /** PATH repair snapshot used to check recorded shell ownership. */
  change?: Change;
  files?: { path: string; reason: Exclude<SeedState, "current"> }[];
};

type BoundedChange =
  | { change: Change; error: null }
  | { change: null; error: string };

type ContextJson = Pick<ContextLayoutInspection, "kind" | "cause" | "legacyWitness" | "legacyConsumers" | "inspectionFailure" | "migration">;

type ContextPayload = {
  guideFormat: "supported" | "missing" | "unsupported" | "not-inspected";
  guideChars: number | null;
  artifactChars: number | null;
  totalChars: number | null;
};

type ReaderHealth = {
  state: "not-required" | "not-inspected" | "missing" | "unrunnable" | "runnable";
  reason: Exclude<SeedState, "current"> | "inspection" | "operation" | "changed" | "probe" | null;
  runtime: string | null;
  scope: "cli-runtime";
};

type NativeRuntimeHealth = {
  /** The configured absolute runtime is inspected, never launched. */
  path: string | null;
  state: "available" | "missing" | "unusable" | "not-inspected";
  scope: "configured-runtime";
  reason: "not-regular" | "not-executable" | "not-accessible" | "inspection" | null;
};

type NativeReaderHealth = {
  path: string;
  state: ReaderHealth["state"];
  reason: ReaderHealth["reason"];
  scope: ReaderHealth["scope"];
};

type NativeIntegration = {
  tool: AgentTool;
  /** The physical settings file, not merely the requested scope's default spelling. */
  path: string;
  inherited: boolean;
  /** `foreign` is its own answer: unreadable or no longer ours is not a stale copy of ours. */
  configuration: "configured" | "missing" | "stale" | "foreign";
  runtime: NativeRuntimeHealth;
  reader: NativeReaderHealth;
  /** Codex's separate trust record; an enabled setting does not prove trust or delivery. */
  trust: CodexTrust;
  activation: "unverified";
};

type HookSetting = {
  tool: AgentTool;
  state: "enabled" | "disabled" | "unknown";
  basis: "registered-file" | "codex-record" | "unverified";
  path: string | null;
};

type HookEvent = "SessionStart" | "PreInvocation";

function hookEvent(tool: AgentTool): HookEvent {
  return tool === "antigravity" ? "PreInvocation" : "SessionStart";
}

type NativeRoute = {
  tool: AgentTool;
  /** The registration whose managed handler is the source of truth for this inspection. */
  sourceId: string;
  resource: ManagedResource | undefined;
  path: string;
  inherited: boolean;
  repairAllowed: boolean;
};

type NativeDiagnosis = {
  integration: NativeIntegration;
  hookSetting: HookSetting;
  check: Check;
};

type ContextDiagnosis = {
  layout: ContextLayoutInspection;
  config: Config | null;
  configChange: Change | null;
};

/** Turn the shared planner's bounded-read refusal into a diagnostic finding. */
function boundedChange(
  ctx: Ctx,
  path: string,
  transform: (before: string | null) => string | null,
  mode?: number,
  within?: string,
): BoundedChange {
  try {
    return { change: planChange(path, transform, ctx.t, mode, within), error: null };
  } catch (cause) {
    return { change: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function contextJson(layout: ContextLayoutInspection): ContextJson {
  return {
    kind: layout.kind,
    cause: layout.cause,
    legacyWitness: layout.legacyWitness,
    legacyConsumers: [...layout.legacyConsumers],
    inspectionFailure: layout.inspectionFailure,
    migration: layout.migration,
  };
}

/** Snapshot measurements, not ownership, freshness, or evidence of host delivery. */
function contextPayload(ctx: Ctx, layout: ContextLayoutInspection): ContextPayload {
  const guide = layout.checks.find((change) => change.path === ctx.paths.agents);
  const artifact = layout.checks.find((change) => change.path === ctx.paths.tone);
  const guideText = guide && !guide.snapshot.symbolicLink ? guide.before : null;
  const artifactText = layout.kind === "current" && artifact && !artifact.snapshot.symbolicLink
    ? artifact.before : null;
  const guideFormat = !guide || guide.snapshot.symbolicLink ? "not-inspected"
    : guideText === null ? "missing"
      : guideText.split(/\r?\n/, 1)[0] === GUIDE_FORMAT_MARKER ? "supported" : "unsupported";
  const guideChars = guideText === null ? null : [...guideText].length;
  const artifactChars = artifactText === null ? null : [...artifactText].length;
  return {
    guideFormat,
    guideChars,
    artifactChars,
    totalChars: guideFormat === "supported" && guideChars !== null && artifactChars !== null
      ? guideChars + 2 + artifactChars : null,
  };
}

/** Probe verified snapshot bytes, never a mutable script path or the private context pair. */
function readerHealth(ctx: Ctx, config: Config, configRead: Change, seeds: readonly SeedInspection[], pairRequired: boolean): ReaderHealth {
  const result: ReaderHealth = { state: "not-required", reason: null, runtime: null, scope: "cli-runtime" };
  if (!pairRequired && config.managedSeeds.reader === undefined) return result;
  result.state = "unrunnable";
  const reader = seeds.find(({ seed }) => seed.id === "reader");
  if (!reader) return { ...result, reason: "inspection" };
  if (reader.state !== "current") {
    return { ...result, state: reader.state === "missing" ? "missing" : "unrunnable", reason: reader.state };
  }
  const captured = boundedChange(ctx, reader.seed.path, (before) => before, undefined, ctx.paths.root);
  if (!captured.change) return { ...result, reason: "unreadable" };
  const source = captured.change.snapshot.bytes;
  if (captured.change.snapshot.symbolicLink || source === null || !source.equals(Buffer.from(reader.seed.contents, "utf8"))) {
    return { ...result, reason: "changed" };
  }

  let temporary: string | undefined;
  result.reason = "changed";
  try {
    assertFresh(configRead, ctx.t);
    assertFresh(captured.change, ctx.t);
    result.reason = "probe";
    temporary = mkdtempSync(join(tmpdir(), "tonedial-reader-check-"));
    temporary = realpathSync(temporary);
    const guide = `${GUIDE_FORMAT_MARKER}\nToneDial diagnostic guide.\n`;
    const artifact = "ToneDial diagnostic tone — 한글 🌿.\n";
    writeFileSync(join(temporary, CONTEXT_GUIDE_FILENAME), guide, { flag: "wx", mode: 0o600 });
    writeFileSync(join(temporary, CONTEXT_ARTIFACT_FILENAME), artifact, { flag: "wx", mode: 0o600 });
    const body = guide + "\n\n" + artifact;
    result.runtime = process.execPath;
    for (const provider of AGENT_TOOLS) {
      const probe = spawnSync(process.execPath, ["--input-type=module", "-", "--provider", provider, "--state", temporary], {
        input: source,
        encoding: "utf8",
        cwd: temporary,
        env: { PATH: "", HOME: temporary, TMPDIR: temporary },
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 8192,
      });
      const expected = provider === "antigravity"
        ? JSON.stringify({ injectSteps: [{ ephemeralMessage: body }] }) + "\n" : body;
      if (probe.error || probe.status !== 0 || probe.stderr !== "" || probe.stdout !== expected) return result;
    }
    result.reason = "changed";
    assertFresh(configRead, ctx.t);
    assertFresh(captured.change, ctx.t);
    result.state = "runnable";
    result.reason = null;
  } catch {
    // Keep snapshot/probe failures structured; never echo captured subprocess output.
  } finally {
    if (temporary !== undefined) {
      try {
        rmSync(temporary, { recursive: true, force: true });
      } catch {
        result.state = "unrunnable";
        result.reason = "probe";
      }
    }
  }
  return result;
}

/** Inspect the configured native runtime without executing it or trusting its output. */
function nativeRuntimeHealth(path: string | undefined): NativeRuntimeHealth {
  const result: NativeRuntimeHealth = {
    path: path ?? null,
    state: "not-inspected",
    scope: "configured-runtime",
    reason: path === undefined ? "inspection" : null,
  };
  if (path === undefined) return result;
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return { ...result, state: "missing", reason: null };
    if (!stat.isFile()) return { ...result, state: "unusable", reason: "not-regular" };
    if ((stat.mode & 0o111) === 0) return { ...result, state: "unusable", reason: "not-executable" };
    accessSync(path, constants.R_OK | constants.X_OK);
    return { ...result, state: "available", reason: null };
  } catch {
    return { ...result, state: "unusable", reason: "not-accessible" };
  }
}

/** A native route is explicit when its registration carries the pair context. */
function nativeResource(config: Config, registrationId: string): ManagedResource | undefined {
  if (!isConfigV2(config)) return undefined;
  const registration = config.wiring.registrations[registrationId];
  return registration?.resourceIds
    .map((id) => config.wiring.resources[id])
    .find((resource): resource is ManagedResource => resource?.kind === "hook" && recordedHook(resource, registrationId) !== null);
}

/**
 * Resolve the route doctor should inspect without discovering or adopting an agent.
 *
 * A project may consume a fully managed global handler without having a project registration of
 * its own. That is evidence to report, but not permission for project `doctor --fix` to create a
 * new registration. An explicit project pair registration, on the other hand, may be repaired by
 * the normal planner even when its shared physical resource currently lives at global scope.
 */
function nativeRoute(ctx: Ctx, config: Config, tool: AgentTool): NativeRoute | null {
  if (!isConfigV2(config)) return null;
  const scope = ctx.agent.live ? "global" : "project";
  const destination = canonicalDestination(ctx.agent.root);
  const requestedId = registrationKey(tool, scope, destination);
  const requested = config.wiring.registrations[requestedId];
  const requestedPair = requested?.context === "pair";
  let sourceId = requestedId;
  let resource = requestedPair ? nativeResource(config, requestedId) : undefined;
  let inherited = false;
  let repairAllowed = requestedPair;
  let sourceAgent = ctx.agent;

  if (!ctx.agent.live) {
    const globalAgent = resolveAgentPaths(
      { global: true, project: null },
      { ...ctx.env, TONEDIAL_AGENT_HOME: undefined },
      ctx.agent.root,
    );
    const globalId = registrationKey(tool, "global", canonicalDestination(globalAgent.root));
    const global = config.wiring.registrations[globalId];
    const globalPair = global?.context === "pair";
    const globalResource = globalPair ? nativeResource(config, globalId) : undefined;

    if (requestedPair && resource === undefined && globalResource !== undefined) {
      // `planOrderedDelivery` can attach this explicit project registration to the matching
      // global resource. Inspect the actual physical source while retaining project repair scope.
      sourceId = globalId;
      resource = globalResource;
      inherited = true;
    } else if (!requestedPair && requested === undefined && globalPair) {
      // This is inherited configuration only. Even a missing global resource is a selected
      // global route, but a project doctor must not create a project registration as repair.
      sourceId = globalId;
      resource = globalResource;
      sourceAgent = globalAgent;
      inherited = true;
      repairAllowed = false;
    }
  }

  if (!requestedPair && !inherited) return null;
  const defaultPath = sourceAgent.hookFile(tool);
  const path = resource?.accessPaths?.[sourceId]?.path ?? resource?.path ?? defaultPath;
  if (!ctx.agent.live && path !== ctx.agent.hookFile(tool)) inherited = true;
  return {
    tool,
    sourceId,
    resource,
    path,
    inherited,
    repairAllowed,
  };
}

/** Diagnose one native route from a bounded settings snapshot. */
function diagnoseNative(
  ctx: Ctx,
  route: NativeRoute,
  reader: ReaderHealth,
): NativeDiagnosis {
  const event = hookEvent(route.tool);
  const nativeReader: NativeReaderHealth = {
    path: readerPath(ctx.paths.root),
    state: reader.state,
    reason: reader.reason,
    scope: reader.scope,
  };
  const resource = route.resource;
  const metadata = resource?.managedByRegistration?.[route.sourceId];
  const installed = resource ? recordedHook(resource, route.sourceId) : null;
  const runtime = nativeRuntimeHealth(metadata?.runtime);
  const inspected = boundedChange(ctx, route.path, (before) => before);
  // Foreign is the starting answer, not stale: until the file is read and the recorded handler is
  // found intact inside it, nothing here is a copy of ours that merely went out of date.
  let configuration: NativeIntegration["configuration"] = "foreign";
  let repairable = false;
  let detail = ctx.t.doctor.nativeForeign;
  const change = inspected.change;

  if (change === null) {
    // The target could not be read inside its bounds. Preserved and reported, never repaired.
  } else if (change.before === null || resource === undefined || metadata === undefined || installed === null) {
    // Our entry is absent — either the file is not there, or it is someone else's file and this
    // route has nothing recorded in it. Both are "missing", because the writer preserves sibling
    // handlers, so setup can still add ours without touching what is already there. Calling an
    // untouched foreign settings file a stale copy of ours is the misreport this branch fixes.
    configuration = "missing";
    detail = ctx.t.doctor.nativeMissing(route.path, event);
    repairable = route.repairAllowed;
    if (change.before === null && resource !== undefined) {
      try {
        assertRecordedTextAccess(change, resource, resource.accessPaths?.[route.sourceId], ctx.t);
      } catch {
        configuration = "foreign";
        detail = ctx.t.doctor.nativeForeign;
        repairable = false;
      }
    }
  } else {
    let owned: string | null = null;
    try {
      assertRecordedTextAccess(change, resource, resource.accessPaths?.[route.sourceId], ctx.t);
      owned = ownedHook(change.before, installed, route.path, ctx.t);
    } catch {
      owned = null;
    }
    const recordedHash = metadata.handlerSha256 ?? resource.managed.handlerSha256;
    if (owned !== null && recordedHash !== undefined && contentHash(owned) === recordedHash) {
      // Ownership is settled here: the file still carries byte for byte what this tool wrote.
      // Everything past this point is only whether it is current, and a difference is something
      // to refresh rather than evidence of an outside edit. Reading it the other way would turn
      // every installed hook foreign — and unrepairable — the first time the protocol moved.
      const desired = orderedHook(route.tool, ctx.paths.root, process.execPath);
      const current = contentHash(owned) === orderedFingerprint(desired, route.path, ctx.t);
      configuration = current ? "configured" : "stale";
      detail = current
        ? (route.inherited ? ctx.t.doctor.nativeInherited(route.path, event) : ctx.t.doctor.nativeConfigured(event))
        : ctx.t.doctor.nativeStale;
      repairable = current ? false : route.repairAllowed;
    }
  }

  const humanDetail = [configuration === "configured"
    ? route.inherited
      ? ctx.t.doctor.nativeInheritedCompact(route.path, event)
      : ctx.t.doctor.nativeConfiguredCompact(event)
    : detail];

  // Runtime availability is its own observation. It can make a configured entry unusable, and it
  // says so beside that reading rather than overwriting it — the configuration is what this tool
  // wrote, and the runtime is whether the machine can still run it.
  if (runtime.state !== "available" && runtime.state !== "not-inspected") {
    const runtimeDetail = ctx.t.doctor.nativeRuntimeUnusable(runtime.path ?? route.path);
    detail = `${detail} ${runtimeDetail}`;
    humanDetail.push(runtimeDetail);
  }

  // Host trust is its own observation too, and only Codex keeps one. Read from the user's Codex
  // home whatever scope this route belongs to, because that is where Codex records trust for
  // project hooks as well as home ones.
  const trust: CodexTrust = route.tool === "codex"
    ? codexHookTrust(
        join(resolveAgentPaths({ global: true, project: null }, ctx.env).home("codex"), "config.toml"),
        route.path,
        change?.before ?? null,
        installed,
        ctx.t,
      )
    : "unknown";
  if (trust === "disabled") {
    detail = `${detail} ${ctx.t.doctor.codexHookDisabled}`;
  }

  const hookSetting: HookSetting = { tool: route.tool, state: "unknown", basis: "unverified", path: route.path };
  if (trust === "disabled") {
    hookSetting.state = "disabled";
    hookSetting.basis = "codex-record";
  } else if (route.tool === "claude" && configuration === "configured" && change?.before) {
    const disabled: unknown = JSON.parse(change.before).disableAllHooks;
    // shortcut: this is only the registered file's switch; effective host state needs a host API.
    if (disabled === undefined || typeof disabled === "boolean") {
      hookSetting.state = disabled === true ? "disabled" : "enabled";
      hookSetting.basis = "registered-file";
      if (disabled === true) detail = `${detail} ${ctx.t.doctor.hookSettingState.disabled}`;
    }
  } else if (route.tool === "antigravity" && configuration === "configured" && change?.before) {
    try {
      const named = JSON.parse(change.before).tonedial;
      const enabled = named !== null && typeof named === "object" ? named.enabled : undefined;
      if (enabled === undefined || typeof enabled === "boolean") {
        hookSetting.state = enabled === false ? "disabled" : "enabled";
        hookSetting.basis = "registered-file";
        if (enabled === false) detail = `${detail} ${ctx.t.doctor.hookSettingState.disabled}`;
      }
    } catch {
      // Keep enablement unknown when the owned hook document cannot be read as JSON.
    }
  }

  const integration: NativeIntegration = {
    tool: route.tool,
    path: route.path,
    inherited: route.inherited,
    configuration,
    runtime,
    reader: nativeReader,
    trust,
    activation: "unverified",
  };
  // A recorded off switch is a configuration problem. Unknown trust remains a separate
  // host-review observation, never approval or activation evidence.
  const state: State =
    configuration === "configured" && runtime.state === "available" &&
    hookSetting.state !== "disabled" ? "ok" : "problem";
  const repair = repairable ? repairCommand(ctx, `init --tools ${route.tool}`) : undefined;
  return {
    integration,
    hookSetting,
    check: {
      name: TARGETS[route.tool].label,
      state,
      detail: `${detail} ${ctx.t.doctor.nativeActivationUnverified(trust !== "unknown")}`,
      humanDetail,
      ...(repair ? { repair } : {}),
    },
  };
}

function failedContext(cause: ContextLayoutInspection["cause"] = "inspection"): ContextLayoutInspection {
  return {
    kind: "conflict",
    cause,
    checks: [],
    legacyWitness: "unresolved",
    legacyConsumers: [],
    inspectionFailure: null,
    migration: { route: null, reason: cause },
  };
}

/**
 * Reuse the central layout classifier for doctor, but never turn an inspection into consent.
 * Config bytes are parsed from the bounded snapshot so an unsafe or replaced entry cannot be
 * reopened by `loadConfig` after it was inspected.
 */
function contextDiagnosis(ctx: Ctx, operations: ReturnType<typeof inspectOperations>): ContextDiagnosis {
  const planned = boundedChange(ctx, ctx.paths.config, (before) => before, undefined, ctx.paths.root);
  if (planned.change === null) {
    return { layout: failedContext(), config: null, configChange: null };
  }
  const configChange = planned.change;
  let config: Config;
  try {
    config = configChange.before === null ? defaultConfig() : parseConfig(configChange.before, ctx.t);
  } catch {
    return { layout: failedContext(), config: null, configChange };
  }

  let expectedArtifact: string;
  try {
    expectedArtifact = compile(toCompileInput(config));
  } catch {
    return { layout: failedContext(), config: null, configChange };
  }

  const known = inspectContextConsumers(ctx.paths, ctx.agent, config, ctx.env, ctx.t);
  const layout = inspectContextLayout(ctx.paths, configChange, ctx.t, {
    config: configChange.before === null ? null : config,
    expectedArtifact,
    ...known,
    consumerInspectionFailed: known.error !== null,
    operations,
  });
  return { layout, config, configChange };
}

function contextCheck(ctx: Ctx, diagnosis: ContextDiagnosis): Check {
  if (diagnosis.config === null) {
    return {
      name: "context",
      state: "problem",
      detail: ctx.t.errors.unreadableConfigFile(ctx.paths.config),
    };
  }
  const { kind, cause } = diagnosis.layout;
  if (diagnosis.layout.inspectionFailure !== null) {
    const { path, reason } = diagnosis.layout.inspectionFailure;
    return { name: "context", state: "problem", detail: ctx.t.errors.contextInspectionFailure(path, reason) };
  }
  if (kind === "current" && cause === "none") {
    return { name: "context", state: "ok", detail: ctx.t.doctor.contextCurrent };
  }
  if (kind === "current" && cause === "repair") {
    return { name: "context", state: "problem", detail: ctx.t.doctor.contextRepair };
  }
  if (kind === "legacy") {
    return {
      name: "context",
      state: "problem",
      detail: ctx.t.recovery.keptSettings,
      repair: repairCommand(ctx, "doctor --fix"),
    };
  }
  return {
    name: "context",
    state: "problem",
    detail: ctx.t.errors.contextLayout(kind === "current" ? "conflict" : kind, ctx.paths.root, repairCommand(ctx, "doctor --json")),
  };
}

/** A blocked layout must never advertise a repair command that the central gate would refuse. */
function suppressBlockedRepairs(checks: Check[], diagnosis: ContextDiagnosis): void {
  if (diagnosis.config === null || diagnosis.layout.kind === "current") return;
  for (const check of checks) {
    if (check.name === "context") continue;
    delete check.repair;
  }
}



export async function runDoctor(ctx: Ctx, _args: string[]): Promise<CommandResult> {
  if (ctx.flags.rollback !== null) {
    if (!ctx.flags.fix) throw new ConfigError(ctx.t.errors.rollbackNeedsFix);
    return runRollback(ctx, ctx.flags.rollback);
  }
  if (!ctx.flags.fix) return doctorReport(ctx);
  const app = await runAppRebuild(ctx);
  if (ctx.flags.dryRun) {
    const native = await runRebuildNative(ctx, app.legacy, app.proposedConfig);
    return {
      lines: [...app.lines, ...native.lines],
      json: { ...app.json, root: ctx.agent.root, stateRoot: ctx.paths.root, agentRoot: ctx.agent.root,
        live: ctx.agent.live, fixed: false, native: native.json,
        appHealthy: app.json.appRebuilt === true,
        nativeAttention: app.json.nativeAttention === true || native.json.attention === true },
      warnings: [...(app.warnings ?? []), ...(native.warnings ?? [])],
    };
  }
  if (app.rebuiltConfig === null) return {
    ...app,
    json: { ...app.json, root: ctx.agent.root, stateRoot: ctx.paths.root, agentRoot: ctx.agent.root,
      live: ctx.agent.live, fixed: false, appHealthy: false },
  };
  const native = await runRebuildNative(ctx, app.legacy);
  const rollbackLines = recoveryRollbackLines(ctx.t, app.json.operationId, native.json.operationId);
  const codexSetup = Array.isArray(native.json.tools) && native.json.tools.some(route =>
    typeof route === "object" && route !== null && route.tool === "codex" && route.configuration === "configured");
  const report = await doctorReport(ctx, rollbackLines.length === 0, !codexSetup);
  return {
    lines: [...app.lines, ...native.lines, ...report.lines,
      ...rollbackLines],
    json: {
      ...report.json, ...app.json,
      root: ctx.agent.root, stateRoot: ctx.paths.root, agentRoot: ctx.agent.root, live: ctx.agent.live,
      appHealthy: report.json.appHealthy === true,
      native: native.json,
      nativeAttention: app.json.nativeAttention === true || native.json.attention === true || report.json.nativeAttention === true,
      fixed: app.json.applied === true || native.json.applied === true,
    },
    warnings: [...(app.warnings ?? []), ...(native.warnings ?? []), ...(report.warnings ?? [])],
  };
}

async function doctorReport(ctx: Ctx, showRollbackCommands = true, showCodexAction = true): Promise<CommandResult> {
  // Recovery must remain available even if an interrupted operation left config unparseable.
  const inspected = inspectOperations(ctx.paths);
  const recovery = {
    lock: inspected.lock.state,
    operations: inspected.journals.map(({ operationId, state }) => ({ operationId, state })),
  };
  if (inspected.lock.state !== "none" || inspected.journals.some(({ state }) => state === "pending" || state === "invalid")) {
    const owner = inspected.lock.owner;
    const blocking = inspected.journals.filter(({ state }) => state === "pending" || state === "invalid");
    const shown = ctx.flags.verbose ? inspected.journals : inspected.journals.filter(({ operationId, state }) =>
      state === "pending" || state === "invalid" || operationId === owner?.operationId);
    const lines = [
      ...wrap(ctx.t.doctor.recoveryPending, ctx.ui.width - 2).map(line => `  ${ctx.ui.warn(line)}`),
      ...shown.map(({ operationId, state }) => `  ${operationId}  ${ctx.t.doctor.operationState[state]}`),
    ];
    if (owner !== null && !shown.some(({ operationId }) => operationId === owner.operationId)) lines.push(`  ${owner.operationId}`);
    if (inspected.lock.state === "live" || inspected.lock.state === "unknown" || inspected.lock.state === "invalid") {
      lines.push(...wrap(ctx.t.doctor.rollbackStatus[inspected.lock.state === "live" ? "busy" : "unresolved"], ctx.ui.width - 2)
        .map(line => `  ${line}`));
    } else if (inspected.lock.state === "dead" && owner?.kind === "mutation") {
      const entry = inspected.journals.find(({ operationId }) => operationId === owner.operationId);
      if (entry?.journal && entry.journal.owner.nonce === owner.nonce) {
        const selection = inspectRollback(ctx.paths, owner.operationId);
        if (entry.state === "pending" && !selection.synthetic && blocking.every(({ operationId, journal }) => operationId === owner.operationId && journal !== null)) {
          lines.push("", `  ${ctx.t.doctor.resumeOperation}`,
            ...nextStep(repairCommand(ctx, `doctor --fix --from-operation ${owner.operationId}`), ctx.ui).slice(1));
        }
        if (showRollbackCommands && previewRollback(ctx.paths, owner.operationId, ctx.t).status === "ready") {
          lines.push("", ...receiptLines(ctx.t.recovery.rollback(owner.operationId), ctx.ui.width - 2).map(line => `  ${line}`));
        }
      }
    }
    lines.push(...nextStep(`${repairCommand(ctx, "doctor")} --json`, ctx.ui));
    return {
      lines,
      // The damaged config is deliberately not parsed here. `operation` is the only safe context
      // fact to expose until the owner-selected rollback or recovery has completed.
      json: {
        root: ctx.agent.root,
        live: ctx.agent.live,
        healthy: false,
        appHealthy: false,
        fixed: false,
        diff: [],
        checks: [],
        context: contextJson(failedContext("operation")),
        contextPayload: contextPayload(ctx, failedContext("operation")),
        reader: { state: "not-inspected", reason: "operation", runtime: null, scope: "cli-runtime" },
        recovery,
      },
    };
  }
  const diagnosis = contextDiagnosis(ctx, inspected);
  if (diagnosis.config === null || diagnosis.configChange === null || diagnosis.layout.inspectionFailure !== null) {
    const checks = [contextCheck(ctx, diagnosis)];
    const lines = [
      ...section(ctx.t.doctor.checksHeading, ctx.ui).slice(1),
      ...renderCheckBlocks(checks, [], [], ctx),
      "",
      `  ${ctx.ui.warn(ctx.t.doctor.toLookAt(1))}`,
    ];
    return {
      lines,
      json: {
        root: ctx.agent.root,
        live: ctx.agent.live,
        healthy: false,
        appHealthy: false,
        fixed: false,
        recovery,
        context: contextJson(diagnosis.layout),
        contextPayload: contextPayload(ctx, diagnosis.layout),
        reader: { state: "not-inspected", reason: "inspection", runtime: null, scope: "cli-runtime" },
        diff: [],
        checks: checks.map(({ name, state, detail, repair, files }) => ({ name, state, detail, repair: repair ?? null, ...(files ? { files } : {}) })),
      },
    };
  }
  const configChange = diagnosis.configChange;
  const config = diagnosis.config;
  const checks: Check[] = [contextCheck(ctx, diagnosis)];
  const payload = contextPayload(ctx, diagnosis.layout);
  checks.push({
    name: "AGENTS.md",
    state: payload.guideFormat === "missing" || payload.guideFormat === "unsupported" ? "problem" : "note",
    detail: payload.guideFormat === "supported"
      ? ctx.t.doctor.contextSize(payload.guideChars!, payload.totalChars)
      : ctx.t.doctor.guideFormat[payload.guideFormat],
  });

  const expected = compile(toCompileInput(config));
  const plannedTone = boundedChange(ctx, ctx.paths.tone, () => expected, undefined, ctx.paths.root);
  if (plannedTone.change === null) {
    checks.push({ name: "TONE.md", state: "problem", detail: plannedTone.error });
  } else {
    const toneChange = plannedTone.change;
    const onDisk = toneChange.before;
    checks.push(
      onDisk === null
        ? { name: "TONE.md", state: "problem", detail: ctx.t.doctor.toneNotWritten, repair: "tonedial compile" }
        : onDisk === expected
          ? { name: "TONE.md", state: "ok", detail: artifactSize(measure(expected), ctx.t) }
          : {
              name: "TONE.md",
              state: "problem",
              detail: ctx.t.doctor.toneDisagrees,
              repair: "tonedial compile",
            },
    );
  }

  const shownPath = wiredAt(ctx.paths.tone, ctx.env);
  const destination = canonicalDestination(ctx.agent.root);
  const scope = ctx.agent.live ? "global" : "project";
  const selection = recordedSeedSelection(config, AGENT_TOOLS);
  const seeds = inspectSeeds(ctx.paths, config.managedSeeds, selection);
  const reader = readerHealth(ctx, config, configChange, seeds, selection.native);
  const readerReason = reader.reason === "changed" || reader.reason === "probe"
    ? ctx.t.doctor.readerFailure[reader.reason]
    : reader.reason !== null && reader.reason !== "inspection" && reader.reason !== "operation"
      ? ctx.t.doctor.seedReason[reader.reason] : "";
  const integrations: NativeIntegration[] = [];
  const hookSettings: HookSetting[] = [];
  for (const tool of AGENT_TOOLS) {
    const route = nativeRoute(ctx, config, tool);
    if (route !== null) {
      const diagnosed = diagnoseNative(ctx, route, reader);
      integrations.push(diagnosed.integration);
      hookSettings.push(diagnosed.hookSetting);
      checks.push(diagnosed.check);
      continue;
    }

    const check = wiringCheck(ctx, tool, shownPath);
    checks.push(check);
    hookSettings.push({ tool, state: "unknown", basis: "unverified", path: null });
  }
  for (const setting of hookSettings) {
    const check = checks.find(check => check.name === TARGETS[setting.tool].label)!;
    const integration = integrations.find(integration => integration.tool === setting.tool);
    const guidance = integration === undefined && TARGETS[setting.tool].delivery === null ? ""
      : integration === undefined ? ctx.t.doctor.hookNotConnected
      : integration.configuration !== "configured" || integration.runtime.state !== "available"
        ? ctx.t.doctor.hookNeedsInspection
      : setting.tool === "codex" && !showCodexAction ? ""
      : ctx.t.doctor.hookGuidance[setting.tool];
    check.humanDetail = [ctx.t.doctor.hookSettingState[setting.state],
      ...(check.humanDetail ?? [check.detail]),
      ...(guidance === "" ? [] : [guidance])];
  }

  checks.push(seedCheck(ctx, config, seeds));
  checks.push({
    name: "reader",
    state: reader.state === "missing" || reader.state === "unrunnable" ? "problem" : "note",
    detail: [ctx.t.doctor.readerState[reader.state], readerReason].filter(Boolean).join(" "),
  });
  for (const tool of AGENT_TOOLS) {
    if (!isConfigV2(config) || !config.wiring.registrations[registrationKey(tool, scope, destination)]) continue;
    checks.push(skillCheck(ctx, tool));
  }
  const shape = installShape(ctx.paths, undefined, ctx.env);
  const shellCheck = pathCheck(ctx, shape);
  if (shellCheck.change && (!isConfigV2(config)
    || !config.wiring.resources[resourceKey(shellCheck.change.realPath, "shell")])) {
    delete shellCheck.change;
    shellCheck.repair = repairCommand(ctx, "init");
  }
  checks.push(shellCheck);
  const command = commandCheck(ctx, shape);
  if (command) checks.push(command);

  // **Shape-independent, because the failure is.** The check above is about the file a curl
  // install writes; this one is about whether a shell would find *any* `tonedial`, which is the
  // question the skill, the `/tone` command, and `tone.md`'s fallback line all depend on and
  // which nothing asked under npm. The repair stays shape-specific: a missing npm shim is not
  // this tool's to write.
  const found = onPath("tonedial", ctx.env);
  checks.push(
    found !== null
      ? { name: "tonedial on PATH", state: "ok", detail: ctx.t.doctor.commandOnPath(found) }
      : {
          name: "tonedial on PATH",
          state: "problem",
          detail: shape === "curl" ? ctx.t.doctor.commandNotOnPath : ctx.t.doctor.commandNotOnPathNpm,
          ...(shape === "curl" ? { repair: repairCommand(ctx, "doctor --fix") } : {}),
        },
  );

  checks.push({ name: "install", state: "note", detail: ctx.t.doctor.installShape(shape, UPDATE_COMMAND[shape]) });

  suppressBlockedRepairs(checks, diagnosis);

  const problems = checks.filter((c) => c.state === "problem");
  const nativeAttention = (diagnosis.layout.nativeAttention?.legacyConsumers.length ?? 0) > 0 ||
    diagnosis.layout.nativeAttention?.inspectionFailure != null || integrations.some((integration) =>
      integration.configuration !== "configured" || integration.runtime.state !== "available" ||
      integration.trust === "disabled") || hookSettings.some(setting => setting.state === "disabled");
  const elsewhere = wiredElsewhere(config, { scope, destination });
  const nativeCheckNames = new Set(hookSettings.map(({ tool }) => TARGETS[tool].label));
  const shownChecks = ctx.flags.verbose
    ? checks
    : checks.filter((check) =>
        check.state === "problem" || check.repair !== undefined || nativeCheckNames.has(check.name));
  const appHealthy = diagnosis.layout.kind === "current" && diagnosis.layout.cause === "none" && seeds.every(({ state }) => state === "current");

  const lines: string[] = [
    `  ${ctx.ui.bold((appHealthy ? ctx.ui.success : ctx.ui.warn)(ctx.t.doctor.applicationHealth(appHealthy)))}`,
    ...(integrations.length || nativeAttention ? [
      ...section(ctx.t.doctor.connectionsHeading, ctx.ui),
      ...wrap(ctx.t.doctor.connectionHealth(nativeAttention), ctx.ui.width - 2).map((line) =>
        `  ${nativeAttention ? ctx.ui.warn(line) : line}`),
      ...wrap(ctx.t.doctor.hookSettingScope, ctx.ui.width - 2).map(line => `  ${line}`),
    ] : []),
    ...section(ctx.t.doctor.checksHeading, ctx.ui),
    ...renderCheckBlocks(shownChecks, ctx.flags.verbose ? [] : hookSettings, integrations, ctx),
    // A repair receipt presents its new IDs once in native→app order. Standalone diagnosis
    // still lists available historical rollback commands.
    ...(showRollbackCommands ? inspected.journals.flatMap(({ operationId, state, journal }) =>
      state === "complete" && journal?.retention && inspectRollback(ctx.paths, operationId).allowed
        ? ["", `  ${operationId}  ${ctx.t.doctor.operationState.complete}`, `  tonedial doctor --fix --rollback ${operationId}`]
        : []) : []),
    ...elsewhereReport(elsewhere, ctx),
  ];

  if (problems.length) {
    lines.push("", `  ${ctx.ui.warn(ctx.t.doctor.toLookAt(problems.length))}`);
  }

  return {
    lines,
    json: {
      root: ctx.agent.root,
      live: ctx.agent.live,
      healthy: problems.length === 0,
      appHealthy,
      nativeAttention,
      fixed: false,
      recovery,
      context: contextJson(diagnosis.layout),
      contextPayload: payload,
      reader,
      integrations,
      hookSettings,
      diff: [],
      checks: checks.map(({ name, state, detail, repair, files }) => ({ name, state, detail, repair: repair ?? null, ...(files ? { files } : {}) })),
      wiredElsewhere: elsewhere,
    },
  };
}

async function runRollback(ctx: Ctx, operationId: string): Promise<CommandResult> {
  const preview = previewRollback(ctx.paths, operationId, ctx.t);
  // A rollback receipt lists targets and outcomes, never the private journal's snapshot bodies.
  const actions = preview.actions.map(({ index, kind, path, realPath, status }) => ({ index, kind, path, realPath, status }));
  const lines = [
    `  ${operationId}`,
    ...wrap(ctx.t.doctor.rollbackStatus[preview.status], ctx.ui.width - 2).map((line) => `  ${ctx.ui.bold(line)}`),
    ...actions.flatMap((action) => [
      `  ${ctx.t.doctor.rollbackAction[action.status]}`,
      `  ${humanText(action.path)}`,
      ...(action.realPath === action.path ? [] : [`  → ${humanText(action.realPath)}`]),
    ]),
  ];
  const json = { operationId, status: preview.status, state: preview.state, actions, unresolved: preview.unresolved };
  if (ctx.flags.dryRun || preview.status !== "ready") {
    return { lines, json: { fixed: false, reason: ctx.flags.dryRun ? "dry-run" : preview.status, rollback: json } };
  }
  if (!ctx.flags.auto) {
    if (!ctx.canPrompt) throw new ConfigError(ctx.t.wiring.needsApproval);
    process.stdout.write(`${lines.join("\n")}\n`);
    lines.length = 0;
    if (await confirm(`  ${ctx.t.doctor.rollbackQuestion}`) !== "yes") {
      return { lines: [`  ${ctx.t.wiring.declined}`], json: { fixed: false, reason: "declined", rollback: json } };
    }
  }
  const result = applyRollback(ctx.paths, operationId, ctx.t);
  const fixed = result.state === "rolled-back";
  lines.push(...wrap(ctx.t.doctor.rollbackStatus[fixed ? "rolled-back" : "unresolved"], ctx.ui.width - 2)
    .map((line) => `  ${(fixed ? ctx.ui.success : ctx.ui.warn)(line)}`));
  return { lines, json: { fixed, rollback: { ...json, ...result, status: fixed ? "rolled-back" : "unresolved" } } };
}

/**
 * The seeds in home against the ones this package carries.
 *
 * An npm update replaces the code and never touches `~/.tonedial/`, so a corrected anchor would
 * otherwise never reach an existing user. `doctor --fix` refreshes generated application files.
 */
function seedCheck(ctx: Ctx, config: Config, seeds: readonly SeedInspection[]): Check {
  // Zero means `init` never ran, which `use` and `wire` reach on their own and which nothing is
  // wrong with. A version behind the package's is the real finding: it means this home holds
  // anchors an update has already corrected.
  if (config.seedVersion === 0) {
    return { name: "seeds", state: "note", detail: ctx.t.doctor.seedsNotRun, repair: repairCommand(ctx, "init") };
  }
  const stale = seeds.filter((entry) => entry.state !== "current");
  return stale.length === 0
    ? { name: "seeds", state: "ok", detail: ctx.t.doctor.seedsOk(SEED_VERSION) }
    : {
        name: "seeds",
        state: "problem",
        detail: ctx.t.doctor.seedsAttention,
        files: stale.map(({ seed, state }) => ({ path: seed.path, reason: state as Exclude<SeedState, "current"> })),
        ...(stale.every(({ state }) => state === "missing" || state === "stale") ? { repair: repairCommand(ctx, "doctor --fix") } : {}),
      };
}

/** Whether the skill is linked, copied, someone else's, or simply not installed. */
function skillCheck(ctx: Ctx, tool: AgentTool): Check {
  const path = skillPath(ctx.agent, tool);
  const name = `${TARGETS[tool].label} skill`;
  const source = join(ctx.paths.skill, SKILL_NAME);
  if (!existsSync(source)) {
    return { name, state: "note", detail: ctx.t.doctor.skillNotSeeded, repair: repairCommand(ctx, "init") };
  }
  switch (inspectSkill(ctx.agent, tool, source)) {
    case "linked":
      return { name, state: "ok", detail: ctx.t.doctor.skillLinked };
    case "copied":
      return { name, state: "ok", detail: ctx.t.doctor.skillCopied };
    case "foreign":
      return {
        name,
        state: "problem",
        detail: ctx.t.doctor.skillForeign(path),
      };
    default:
      return { name, state: "note", detail: ctx.t.doctor.skillNotLinked, repair: `tonedial wire ${tool}` };
  }
}

/**
 * The `tonedial` command itself. Only a curl install creates one — npm owns its own shim — and
 * without this check `doctor` reported a healthy install whose PATH line pointed at an empty
 * directory, which is the state the whole npm-less channel shipped in.
 */
function commandCheck(ctx: Ctx, shape: InstallShape): Check | null {
  if (shape !== "curl") return null;
  const path = ctx.paths.command;
  const repair = `curl -fsSL https://raw.githubusercontent.com/awesometic/tonedial/main/install.sh | TONEDIAL_HOME="${shellQuote(ctx.paths.root)}" sh -s -- --repair ${connectionScopeFlag(ctx.agent)}`;
  const expected = shimScript(ctx.paths.lib, ctx.paths.root);
  // Planning performs the lstat/open/fstat/read with O_NONBLOCK and rejects directories, devices,
  // FIFOs, and races before any bytes are consumed. The same planned change supplies the mode
  // snapshot, so this check does not reopen a target after it was inspected.
  const planned = boundedChange(ctx, path, () => expected, 0o755, ctx.paths.root);
  if (planned.change === null) {
    return { name: "tonedial", state: "problem", detail: planned.error };
  }
  const change = planned.change;
  if (change.before === null) {
    return {
      name: "tonedial",
      state: "problem",
      detail: ctx.t.doctor.commandMissing(path),
      repair,
    };
  }
  if (change.before !== expected) {
    return {
      name: "tonedial",
      state: "problem",
      detail: ctx.t.doctor.commandStale(path),
      repair,
    };
  }
  if (!((change.snapshot.mode ?? 0) & 0o111)) {
    return {
      name: "tonedial",
      state: "problem",
      detail: ctx.t.doctor.commandNotExecutable(path),
      repair,
    };
  }
  return { name: "tonedial", state: "ok", detail: ctx.t.doctor.commandAt(path) };
}

/** The PATH line, which is the only reason the command above is found by name. */
function pathCheck(ctx: Ctx, shape: InstallShape): Check {
  // Every rc file this tool could have written, not just the one `$SHELL` names today. Someone
  // who installed under bash and moved to zsh had the line looked for in `.zshrc`, found absent,
  // and reported clean — while it sat in `.bash_profile` doing nothing.
  let found: { path: string; state: "current" | "stale" } | undefined;
  for (const path of candidateRcPaths(ctx.agent, ctx.env)) {
    const inspected = boundedChange(ctx, path, (before) => before);
    if (inspected.change === null) {
      return { name: "PATH line", state: "problem", detail: inspected.error };
    }
    const state = pathLineState(inspected.change.before, ctx.paths.bin, ctx.env.SHELL);
    if (state !== "absent") {
      found = { path, state };
      break;
    }
  }

  if (found?.state === "current") return { name: "PATH line", state: "ok", detail: ctx.t.doctor.pathLineAt(found.path) };
  if (found?.state === "stale") {
    if (!ctx.agent.live || found.path !== rcPath(ctx.agent, ctx.env)) {
      return { name: "PATH line", state: "problem", detail: `${ctx.t.doctor.pathLineStale(found.path, ctx.paths.bin)} ${ctx.t.doctor.pathLineOutsideScope}` };
    }
    const repair = boundedChange(
      ctx,
      found.path,
      (before) => withPathLine(before, ctx.paths.bin, ctx.env.SHELL),
    );
    if (repair.change === null) return { name: "PATH line", state: "problem", detail: repair.error };
    return {
      name: "PATH line",
      state: "problem",
      detail: ctx.t.doctor.pathLineStale(found.path, ctx.paths.bin),
      repair: repairCommand(ctx, "doctor --fix"),
      change: repair.change,
    };
  }
  // Absent is normal for an npm install, where npm owns the entry — and a real problem for a
  // curl one, where this line is the only reason a bare `tonedial` resolves at all.
  const rc = rcPath(ctx.agent, ctx.env);
  if (shape !== "curl") return { name: "PATH line", state: "note", detail: ctx.t.doctor.pathLineNotNeeded(shape) };
  if (!ctx.agent.live) return { name: "PATH line", state: "problem", detail: `${ctx.t.doctor.pathLineMissingForCurl} ${ctx.t.doctor.pathLineOutsideScope}` };
  const repair = boundedChange(ctx, rc, (before) => withPathLine(before, ctx.paths.bin, ctx.env.SHELL));
  if (repair.change === null) return { name: "PATH line", state: "problem", detail: repair.error };
  return {
    name: "PATH line",
    state: "problem",
    detail: ctx.t.doctor.pathLineMissingForCurl,
    repair: repairCommand(ctx, "doctor --fix"),
    change: repair.change,
  };
}

/** One tool's region: absent, present and current, present and stale, present and damaged. */
function wiringCheck(ctx: Ctx, tool: AgentTool, shownPath: WiredAt): Check {
  const target = TARGETS[tool];
  const name = target.label;
  // A native target has no legacy region. An unregistered Antigravity hooks file is not evidence
  // of a ToneDial connection, so leave it to the common hook-setting guidance below.
  if (target.delivery === null) {
    return { name, state: "note", detail: ctx.t.doctor.hookNotConnected };
  }
  const path = ctx.agent.wiredFile(tool);
  // Legacy delivery is inspected only; new setup uses the native pair route.

  // Use the shared bounded planner even for inspection. It rejects a directory, FIFO, device,
  // dangling link, invalid text, or replacement race before a command-level read can hang or
  // throw past `doctor --json`.
  const inspected = boundedChange(ctx, path, (before) => before);
  if (inspected.change === null) {
    return { name, state: "problem", detail: inspected.error };
  }
  const text = inspected.change.before;

  if (text === null) {
    if (!existsSync(ctx.agent.home(tool))) return { name, state: "absent", detail: ctx.t.doctor.notInstalled };
    return { name, state: "note", detail: ctx.t.doctor.legacyRepairWithheld };
  }

  // **The hook is asked about as a hook.** Its file is JSON with no marker to find, and the
  // question a person needs answered is the same one a region answers: is this wiring here, and
  // does it point at an artifact that exists. Asked of `hooks.ts` directly rather than through a
  // helper over both deliveries: a boolean cannot carry the three answers the region branch needs
  // — absent, edited by hand, matching — so one would have had a caller and a dead half.
  if (target.delivery === "hook") {
    let present: boolean;
    try {
      present = hasHook(text, hookCommand(shownPath.toneAbsolute, shownPath.home), path, ctx.t);
    } catch {
      // The bounded planner proved the file is readable; its JSON/shape is still not ours to
      // replace. Do not surface parser details, which can include a snippet of user content.
      return {
        name,
        state: "problem",
        detail: ctx.t.errors.unreadableTarget(path, "invalid hook settings"),
      };
    }
    if (present) {
      return existsSync(ctx.paths.tone)
        ? { name, state: "ok", detail: ctx.t.doctor.hookPresent(hookEvent(tool)) }
        : {
            name,
            state: "problem",
            detail: ctx.t.doctor.hookDangling(ctx.paths.tone),
            repair: "tonedial compile",
          };
    }
    return { name, state: "note", detail: ctx.t.doctor.legacyRepairWithheld };
  }

  const content = regionContent(shownPath.tonePath);
  let found;
  try {
    found = find(text);
  } catch (cause) {
    // Damage, not drift. `--fix` deliberately cannot repair it: which bytes are ours is exactly
    // what a duplicated or unclosed marker makes unknowable, and guessing deletes someone's
    // configuration.
    return {
      name,
      state: "problem",
      detail: ctx.t.doctor.damagedRegion(path, (cause as RegionError).message),
    };
  }

  if (!found) {
    return { name, state: "note", detail: ctx.t.doctor.legacyRepairWithheld };
  }
  if (found.content === content) return { name, state: "ok", detail: ctx.t.doctor.imported };

  return { name, state: "problem", detail: ctx.t.doctor.editedByHand };
}

/** A repair a user can paste. Under `--global` it has to carry the flag, or running it
 *  repairs a destination it was not pointed at, and leaves the diagnosed one as it was. */
function repairCommand(ctx: Ctx, rest: string): string {
  return `tonedial ${rest} ${connectionScopeFlag(ctx.agent)}`;
}

const MARK: Record<State, string> = { ok: "ok", problem: "!", note: "·", absent: "·" };

/** A registration this run is not inspecting, and whether its destination is still there. */
type Elsewhere = { target: string; scope: WiringScope; destination: string; state: "ok" | "gone" | "unwired" };

/**
 * Wiring that lives outside the scope being inspected.
 *
 * Presence only, and report only. `existsSync` is false on `EACCES` and on an unmounted volume,
 * and a renamed project still carries a hook whose handler keeps delivering, so "gone" is a
 * guess about a directory rather than a fact about delivery. That is why nothing here acts on
 * it: `--fix` leaves every one of these records alone, and the row names the one explicit act
 * that removes it instead.
 *
 * Agent targets only. A curl install registers the directory of its rc file as a `shell`
 * target, and `eject --project ~` is not how a PATH line is removed.
 */
function wiredElsewhere(config: Config, here: { scope: WiringScope; destination: string }): Elsewhere[] {
  if (!isConfigV2(config)) return [];
  const rows: Elsewhere[] = [];
  for (const [id, registration] of Object.entries(config.wiring.registrations)) {
    if (!(AGENT_TOOLS as readonly string[]).includes(registration.target)) continue;
    if (registration.scope === here.scope && registration.destination === here.destination) continue;
    // Every resource, not the first: a codex registration carries a skill directory and a hook,
    // and the skill survives the hook's deletion, so reading one of them would call a
    // destination that stopped delivering healthy.
    const wired = registration.resourceIds.length > 0 && registration.resourceIds.every((resourceId) => {
      const resource = config.wiring.resources[resourceId];
      return resource !== undefined && existsSync(resource.accessPaths?.[id]?.path ?? resource.path);
    });
    rows.push({
      target: registration.target,
      scope: registration.scope,
      destination: registration.destination,
      state: !existsSync(registration.destination) ? "gone" : wired ? "ok" : "unwired",
    });
  }
  return rows.sort((a, b) => a.destination.localeCompare(b.destination));
}

/** Group presentation only; JSON retains each registration and its individual state. */
function elsewhereReport(rows: Elsewhere[], ctx: Ctx): string[] {
  if (rows.length === 0) return [];
  const groups = new Map<string, Elsewhere[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.scope, row.destination]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const lines = section(ctx.t.doctor.wiredElsewhere, ctx.ui);
  for (const group of groups.values()) {
    const { scope, destination } = group[0]!;
    lines.push(...wrap(scope === "global" ? ctx.t.wiring.scopeGlobal : ctx.t.wiring.scopeHere, ctx.ui.width - 2)
      .map(line => `  ${ctx.ui.dim(line)}`), `  ${humanText(destination)}`);
    for (const state of ["ok", "unwired", "gone"] as const) {
      const targets = group.filter(row => row.state === state).map(row => row.target);
      if (targets.length === 0) continue;
      const detail = state === "ok" ? ctx.t.doctor.destinationPresent
        : state === "gone" ? ctx.t.doctor.destinationGone : ctx.t.doctor.destinationUnwired;
      lines.push(...wrap(`${targets.join(", ")} — ${detail}`, ctx.ui.width - 4)
        .map(line => `    ${state === "ok" ? line : ctx.ui.warn(line)}`));
    }
    if (group.some(row => row.state !== "ok")) {
      const scopeFlag = scope === "global" ? "--global" : `--project "${shellQuote(destination)}"`;
      lines.push(...wrap(ctx.t.doctor.inspectScope, ctx.ui.width - 4).map(line => `    ${line}`),
        `    ${ctx.ui.accent(humanText(`tonedial doctor ${scopeFlag}`))}`,
        ...wrap(ctx.t.doctor.disconnectScope, ctx.ui.width - 4).map(line => `    ${line}`),
        `    ${ctx.ui.accent(humanText(`tonedial eject ${scopeFlag}`))}`);
    }
    lines.push("");
  }
  lines.pop();
  return lines;
}

function report(check: Check, ctx: Ctx): string[] {
  const paint =
    check.state === "problem" ? ctx.ui.error : check.state === "ok" ? ctx.ui.success : ctx.ui.dim;
  const head = `  ${paint(MARK[check.state])} ${ctx.ui.bold(humanText(check.name === "seeds" ? ctx.t.doctor.seedsHeading : check.name))}`;
  // Keep the marker and check name together, then give every detail a stable four-cell hanging
  // indent. A fixed name column made a narrow doctor report spend most of its width on padding.
  const body = (check.files?.length ? [] : check.humanDetail ?? [check.detail]).flatMap(detail => detail.split("\n"))
    .flatMap(line => receiptLines(humanText(line), ctx.ui.width - 6));
  const lines = [head, ...body.map((line) => `    ${check.state === "ok" ? ctx.ui.dim(line) : line}`)];
  if (check.files?.length) {
    lines.push(`    ${humanText(ctx.paths.root)}`);
    for (const reason of ["missing", "stale", "modified", "foreign", "unreadable"] as const) {
      const files = check.files.filter(file => file.reason === reason);
      if (!files.length) continue;
      lines.push(...wrap(ctx.t.doctor.seedReason[reason], ctx.ui.width - 6).map(line => `    ${line}`));
      for (const file of files) {
        lines.push(...wrap(humanText(relative(ctx.paths.root, file.path)), ctx.ui.width - 8).map(line => `      ${line}`));
      }
    }
  }
  if (check.repair) lines.push(...nextStep(check.repair, ctx.ui));
  return lines;
}

/** Render the human report without changing the individual machine checks. */
function renderCheckBlocks(
  checks: readonly Check[],
  settings: readonly HookSetting[],
  integrations: readonly NativeIntegration[],
  ctx: Ctx,
): string[] {
  const unconnected = settings.filter((setting) => {
    const check = checks.find(({ name }) => name === TARGETS[setting.tool].label);
    return check !== undefined &&
      !integrations.some(({ tool }) => tool === setting.tool) &&
      (check.state === "absent" || check.detail === ctx.t.doctor.hookNotConnected) && check.repair === undefined;
  });
  const unconnectedNames = new Set(unconnected.map(({ tool }) => TARGETS[tool].label));
  const blocks: string[][] = [];
  let grouped = false;
  for (const check of checks) {
    if (unconnectedNames.has(check.name)) {
      if (!grouped) {
        blocks.push(unconnectedReport(unconnected, ctx));
        grouped = true;
      }
      continue;
    }
    blocks.push(report(check, ctx));
  }
  return blocks.flatMap((block, index) => index === 0 ? block : ["", ...block]);
}

function unconnectedReport(settings: readonly HookSetting[], ctx: Ctx): string[] {
  const tools = settings.map(({ tool }) => TARGETS[tool].label);
  return [
    `  ${ctx.ui.dim(MARK.note)} ${ctx.ui.bold(ctx.t.doctor.hookGroupHeading)}`,
    ...wrap(ctx.t.doctor.hookGroupUnknown(tools), ctx.ui.width - 4).map(line => `    ${line}`),
  ];
}
