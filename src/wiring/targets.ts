// Native adapters deliver the shared AGENTS.md/TONE.md pair through the managed reader.
// Legacy targets remain separate for recognition and scoped cleanup; new setup never emits
// their imports or one-file commands.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { ConfigError, isConfigV2, type Config, type ManagedResource, type WiringV2 } from "../core/config.ts";
import { AGENT_TOOLS, LEGACY_CONTEXT_ARTIFACT_FILENAME, canonicalDestination, readerPath, resolveAgentPaths, shellQuote, type AgentPaths, type AgentTool, type Paths } from "../core/paths.ts";
import type { ContextConsumerCheck, ContextInspectionFailure } from "../core/seeds.ts";
import { planChange, type Change } from "./apply.ts";
import { MARKDOWN, RegionError, find, remove, upsert } from "./region.ts";
import { hasHook, hookCommand, hookDocumentDescription, ownedHook, withHook, withoutHook, type HookSpec } from "./hooks.ts";
import type { Messages } from "../core/i18n.ts";
import { assertRecordedTextAccess, normalizeWiring, contentHash, recordFileChange, registrationKey, resourceKey } from "./ownership.ts";

/** The two retained legacy delivery formats. */
export type Delivery = "import" | "hook";

export type Target = {
  /** What a person calls it. */
  label: string;
  delivery: Delivery;
};

export const TARGETS: Record<AgentTool, Target> = {
  claude: { label: "Claude Code", delivery: "import" },
  gemini: { label: "Gemini CLI", delivery: "import" },
  codex: { label: "Codex CLI", delivery: "hook" },
};

/**
 * The lifecycle sources each provider is asked to fire on, and how it wants them written.
 *
 * Codex and Claude document a matcher that accepts an alternation, so one entry covers the set.
 * Gemini's own reference is ambiguous: it calls the matcher "regex or exact match" and does not
 * say whether one entry may cover several sources, while the recorded investigation of it read
 * the sources as exact names. Under that reading an alternation matches none of them — a hook
 * that is written, looks right in the file, and never fires. One entry per source is correct
 * under either reading, which is why the ambiguity did not have to be resolved to proceed.
 */
const LIFECYCLE: Record<AgentTool, readonly string[]> = {
  codex: ["startup|resume|clear|compact"],
  claude: ["startup|resume|clear|compact|fork"],
  gemini: ["startup", "resume", "clear"],
};

const HOOK_DESCRIPTION = "ToneDial: load saved response tone";

/**
 * Target names that are claimed but not implemented, each with what blocks it.
 *
 * These are not adapters. They have no path, no delivery, and no entry in `TARGETS`, because an
 * adapter without a verified contract is a guess — and the guess available here is another
 * product's adapter, which a shared directory name makes look plausible and which would deliver
 * into a surface nobody has tested. Naming them keeps that guess from being made silently and
 * turns a selection into its actual blocker instead of a spelling complaint.
 *
 * A name leaves this list by gaining a verified contract and a real `TARGETS` entry, so the list
 * shrinks to nothing rather than becoming permanent furniture.
 */
export const RESERVED_TARGETS: Record<string, "project-path" | "protocol"> = {
  "antigravity-cli": "project-path",
  "antigravity-desktop": "protocol",
  "antigravity-ide": "protocol",
};

/** A scope that already delivers this tool's pair, reported rather than refused. */
export type DeliveryDuplicate = {
  scope: "project";
  destination: string;
  path: string;
  state: "duplicate" | "stale-duplicate";
};

/** Protocol definitions do not by themselves enable setup or certify host activation. */
export function orderedHook(tool: AgentTool, stateRoot: string, runtime: string): HookSpec {
  if (![stateRoot, runtime].every((path) => isAbsolute(path) && !path.includes("\0"))) {
    throw new ConfigError("Hook runtime and state paths must be absolute and contain no NUL.");
  }
  const args = [readerPath(stateRoot), "--provider", tool, "--state", stateRoot];
  const matchers = LIFECYCLE[tool];
  // Claude documents a command plus an argument vector; the other two document one shell string,
  // so their arguments are quoted into it rather than handed over separately.
  if (tool === "claude") return { matchers, handler: { type: "command", command: runtime, args, statusMessage: HOOK_DESCRIPTION } };
  const command = [runtime, ...args].map((part) => `"${shellQuote(part)}"`).join(" ");
  return tool === "codex"
    ? { matchers, handler: { type: "command", command, statusMessage: HOOK_DESCRIPTION }, documentDescription: HOOK_DESCRIPTION }
    : { matchers, handler: { type: "command", command, name: "ToneDial", description: "Load saved response tone" } };
}

/** Version 2 identifies an ordered-pair hook, not an arbitrary legacy provider registration. */
export function recordedHook(resource: ManagedResource, registrationId: string): HookSpec | null {
  const metadata = resource.managedByRegistration?.[registrationId];
  if (!metadata) return null;
  const { version, event, matchers, command, args, statusMessage, name, description } = metadata;
  if (resource.kind !== "hook" || version !== 2 || event !== "SessionStart" || !matchers?.length || !command) return null;
  return {
    matchers,
    handler: {
      type: "command", command,
      ...(args === undefined ? {} : { args }),
      ...(statusMessage === undefined ? {} : { statusMessage }),
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
    },
    ...(resource.documentDescription === undefined ? {} : { documentDescription: resource.documentDescription }),
  };
}

/**
 * Whether two deliveries are the same one.
 *
 * Canonical on both sides, for the same reason the fingerprint is: the matcher set is a set, and
 * comparing it as a sequence would make a record written under one ordering unrecognisable to a
 * later one. That is not hypothetical — the order comes from a table in this file, and a table
 * is something people reorder.
 */
export function sameDelivery(left: HookSpec | null, right: HookSpec | null): boolean {
  const canonical = (spec: HookSpec | null) =>
    spec === null ? null : JSON.stringify({ matchers: [...spec.matchers].sort(), handler: spec.handler });
  return canonical(left) === canonical(right);
}

/** Display differences may share a command; a changed runtime or payload may not. */
function sameDeliveryCommand(left: HookSpec | null, right: HookSpec | null): boolean {
  const commandOnly = (spec: HookSpec | null): HookSpec | null => {
    if (spec === null) return null;
    const { statusMessage: _status, name: _name, description: _description, ...handler } = spec.handler;
    return { matchers: spec.matchers, handler };
  };
  return sameDelivery(commandOnly(left), commandOnly(right));
}

/**
 * The hash a provider's delivery is recognised by, normalized the way ownership reads it back.
 *
 * Built by writing the entries and selecting them again rather than by hashing what was written,
 * so the stored value and every later comparison pass through one normalization. Two spellings
 * of "what we wrote" is how an ownership check starts disagreeing with itself.
 */
export function orderedFingerprint(spec: HookSpec, path: string, t: Messages): string {
  return contentHash(ownedHook(withHook(null, spec, path, t), spec, path, t) ?? "");
}

/** Init and wire share exact handler ownership and the same file planner. */
export function planOrderedDelivery(
  paths: Paths,
  agent: AgentPaths,
  tool: AgentTool,
  wiring: WiringV2,
  env: NodeJS.ProcessEnv,
  t: Messages,
  runtime = process.execPath,
  legacy?: Change,
) {
  const scope = agent.live ? "global" : "project";
  const destination = canonicalDestination(agent.root);
  const id = registrationKey(tool, scope, destination);
  const selected = wiring.registrations[id];
  const existing = selected?.resourceIds.map((key) => wiring.resources[key]!).find((resource) => resource.kind === "hook");
  let desired = orderedHook(tool, paths.root, runtime);
  let path = agent.hookFile(tool);
  let ownerId = id;
  let prior = existing;
  let reuseInherited = false;
  const checks: Change[] = [];
  // Hosts merge scopes. Reuse the exact recorded global command without changing its display fields.
  if (!agent.live && !existing) {
    const global = resolveAgentPaths({ global: true, project: null }, { ...env, TONEDIAL_AGENT_HOME: undefined }, agent.root);
    const globalId = registrationKey(tool, "global", canonicalDestination(global.root));
    const inherited = wiring.registrations[globalId]?.resourceIds.map((key) => wiring.resources[key]!)
      .find((resource) => resource.kind === "hook");
    if (inherited) {
      const installed = recordedHook(inherited, globalId);
      if (!sameDeliveryCommand(installed, desired)) {
        throw new ConfigError(t.errors.ownershipConflict(inherited.path));
      }
      const local = planChange(path, (before) => before, t);
      if (ownedHook(local.before, desired, path, t) !== null || ownedHook(local.before, installed!, path, t) !== null) {
        throw new ConfigError(t.errors.ownershipConflict(path));
      }
      checks.push(local);
      path = inherited.accessPaths?.[globalId]?.path ?? inherited.path;
      prior = inherited;
      ownerId = globalId;
      desired = installed!;
      reuseInherited = true;
    }
  }
  if (existing) path = existing.accessPaths?.[id]?.path ?? existing.path;
  const previous = prior ? recordedHook(prior, ownerId) : null;
  if (prior && previous === null) throw new ConfigError(t.errors.ownershipConflict(path));
  // Repeated project setup inherits display-only changes too; it must not relabel a global hook.
  if (!agent.live && path !== agent.hookFile(tool) && sameDeliveryCommand(previous, desired)) {
    desired = previous!;
    reuseInherited = true;
  }
  const planned = planChange(path, (before) => before, t);
  const replacesLegacy = legacy !== undefined && legacy.realPath === planned.realPath;
  if (replacesLegacy && (legacy.before !== planned.before ||
    legacy.snapshot.targetIdentity !== planned.snapshot.targetIdentity)) {
    throw new ConfigError(t.errors.ownershipConflict(path));
  }
  if (replacesLegacy) checks.push({ ...legacy, after: legacy.before });
  const before = planned.before;
  let remaining = replacesLegacy ? legacy.after : before;
  if (previous && prior) {
    const owned = ownedHook(before, previous, path, t);
    if (before !== null && (owned === null || contentHash(owned) !== (prior.managedByRegistration?.[ownerId] ?? prior.managed).handlerSha256)) {
      throw new ConfigError(t.errors.ownershipConflict(path));
    }
    if (before !== null) {
      const handlerOnly = { ...previous };
      delete handlerOnly.documentDescription;
      remaining = withoutHook(before, handlerOnly, path, t);
    }
  } else if (ownedHook(before, desired, path, t) !== null) {
    throw new ConfigError(t.errors.ownershipConflict(path));
  }
  const previousDescription = (prior ?? wiring.resources[resourceKey(planned.realPath, "hook")])?.documentDescription;
  const descriptionBefore = hookDocumentDescription(remaining, path, t);
  const ownsDescription = (desired.documentDescription !== undefined && descriptionBefore === undefined) ||
    (previousDescription !== undefined && descriptionBefore === previousDescription);
  if (reuseInherited && before === null) throw new ConfigError(t.errors.ownershipConflict(path));
  const change = { ...planned, after: reuseInherited ? before! : withHook(remaining, desired, path, t) };
  if (prior) assertRecordedTextAccess(change, prior, prior.accessPaths?.[ownerId], t);
  const managed: ManagedResource["managed"] = {
    version: 2,
    event: "SessionStart",
    matchers: [...desired.matchers],
    command: desired.handler.command,
    runtime,
    ...(desired.handler.args === undefined ? {} : { args: desired.handler.args }),
    ...(desired.handler.statusMessage === undefined ? {} : { statusMessage: desired.handler.statusMessage }),
    ...(desired.handler.name === undefined ? {} : { name: desired.handler.name }),
    ...(desired.handler.description === undefined ? {} : { description: desired.handler.description }),
    handlerSha256: orderedFingerprint(desired, path, t),
  };
  const next = recordFileChange(wiring, { target: tool, scope, destination, context: "pair" }, change, "hook", managed, t);
  const recorded = next.resources[resourceKey(change.realPath, "hook")]!;
  const descriptionAfter = hookDocumentDescription(change.after, path, t);
  if (ownsDescription && typeof descriptionAfter === "string") recorded.documentDescription = descriptionAfter;
  else delete recorded.documentDescription;
  // Carry the retired record's creation fact onto the resource, not onto the `Change`.
  //
  // The two answer different questions with the same word. Ownership asks whether this tool ever
  // created the file, because that is what lets `eject` delete it later; the journal asks whether
  // *this* action created it. Replacing a legacy handler edits a file that already exists, so
  // putting the historical answer on the change had the journal claim a creation that did not
  // happen — a descriptor the recovery validator refuses, which froze every interrupted migration
  // with no way out but deleting the journal by hand.
  if (replacesLegacy) {
    const carried = next.resources[resourceKey(change.realPath, "hook")]!;
    carried.created = legacy.created;
    carried.createdDir = legacy.createdDir;
  }
  // Inherited registrations share one physical handler. Refresh their identities together;
  // otherwise the next scoped disconnect would compare the new bytes with an old command.
  if (prior && previous) {
    const shared = next.resources[resourceKey(change.realPath, "hook")]!;
    for (const consumer of prior.consumers) {
      if (sameDelivery(recordedHook(prior, consumer), previous)) {
        shared.managedByRegistration![consumer] = { ...managed, ...(managed.args ? { args: [...managed.args] } : {}) };
      }
    }
  }
  return {
    change,
    checks,
    replacesLegacy,
    wiring: next,
    inherited: !agent.live && path !== agent.hookFile(tool),
    duplicates: projectDuplicates(next, tool, id, desired, paths.root, agent.live),
  };
}

/**
 * Projects that will keep delivering this tool's pair after a global setup.
 *
 * Hosts merge their scopes, so a project hook goes on firing once a global one exists. That is
 * worth telling someone about and is not worth refusing over: setting the dial once for every
 * project is what `init --global` is for, and blocking it because one project happened to be
 * wired first would refuse the route the quickstart leads with. Nor is it this command's place
 * to edit a project it was not pointed at — the receipt names the scope and the command that
 * clears it, and leaves the choice there.
 *
 * Only a handler this tool would itself generate counts. `stale-duplicate` is the same handler
 * recorded against an older runtime path; anything else is a different delivery, not a second
 * copy of this one.
 */
function projectDuplicates(
  wiring: WiringV2,
  tool: AgentTool,
  selfId: string,
  desired: HookSpec,
  stateRoot: string,
  live: boolean,
): DeliveryDuplicate[] {
  if (!live) return [];
  const found: DeliveryDuplicate[] = [];
  for (const [id, registration] of Object.entries(wiring.registrations)) {
    if (id === selfId || registration.target !== tool || registration.scope !== "project") continue;
    const hook = registration.resourceIds.map((key) => wiring.resources[key]).find((resource) => resource?.kind === "hook");
    const recorded = hook ? recordedHook(hook, id) : null;
    if (!hook || !recorded) continue;
    const runtime = hook.managedByRegistration?.[id]?.runtime;
    const current = sameDelivery(recorded, desired);
    const stale = !current && runtime !== undefined &&
      sameDeliveryCommand(recorded, orderedHook(tool, stateRoot, runtime));
    if (!current && !stale) continue;
    found.push({
      scope: "project",
      destination: registration.destination,
      path: hook.accessPaths?.[id]?.path ?? hook.path,
      state: current ? "duplicate" : "stale-duplicate",
    });
  }
  return found.sort((left, right) => left.destination.localeCompare(right.destination));
}

/** Only init's witnessed transition may retire a registered lowercase delivery. */
export function planLegacyDeliveryRemoval(
  paths: Paths,
  agent: AgentPaths,
  tool: AgentTool,
  wiring: WiringV2,
  env: NodeJS.ProcessEnv,
  t: Messages,
): { change: Change; wiring: WiringV2 } | null {
  const id = registrationKey(tool, agent.live ? "global" : "project", canonicalDestination(agent.root));
  const registration = wiring.registrations[id];
  const resourceId = registration?.resourceIds.find((key) => wiring.resources[key]?.kind === "hook");
  if (!resourceId) return null;
  const resource = wiring.resources[resourceId]!;
  if (recordedHook(resource, id)) return null;
  const path = resource.accessPaths?.[id]?.path ?? resource.path;
  if (resource.managed.version !== 1 || resource.consumers.some((consumer) => consumer !== id)) {
    throw new ConfigError(t.errors.ownershipConflict(path));
  }
  const where = wiredAt(join(paths.root, LEGACY_CONTEXT_ARTIFACT_FILENAME), env);
  const planned = planChange(path, (before) => {
    if (before === null) return null;
    const owned = ownedDelivery(TARGETS[tool], before, where, path, t);
    const remaining = wiringRemoved(TARGETS[tool], before, where, path, t);
    if (owned === null || contentHash(owned) !== resource.managed.handlerSha256 || remaining === before) {
      throw new ConfigError(t.errors.ownershipConflict(path));
    }
    return remaining;
  }, t);
  assertRecordedTextAccess(planned, resource, resource.accessPaths?.[id], t, true);
  const next = normalizeWiring(wiring);
  next.registrations[id]!.resourceIds = registration!.resourceIds.filter((key) => key !== resourceId);
  delete next.resources[resourceId];
  return {
    // `created` decides whether emptying this file deletes it, so the historical fact belongs
    // here — but only while the file is still nothing but what this tool wrote. Once the user
    // has added lines of their own the removal leaves a file behind, and claiming creation for a
    // file that survives is the shape the journal validator refuses, which would freeze the very
    // migration this removal is part of. Same predicate `unwire` already uses.
    change: {
      ...planned,
      created: resource.created && planned.before !== null && contentHash(planned.before) === resource.expected.sha256,
      createdDir: resource.createdDir,
    },
    wiring: next,
  };
}

/**
 * Refuse a selection whose tools turn out to share one physical settings file.
 *
 * Nothing stops `.claude/settings.json` from being a link to `.codex/hooks.json`. Each adapter
 * plans its write against the bytes it read, and both read before either writes — so applied in
 * sequence the second silently drops the first's handler, and the ownership graph is left
 * recording two fingerprints that cannot both describe the file. The shared gate is the wrong
 * place to catch this: one physical resource with several consumers is the normal shape for the
 * skill source, so only the planner knows that these two are hooks competing for one file.
 */
export function assertDistinctHookTargets(
  planned: readonly { tool: AgentTool; change: Change }[],
  t: Messages,
): void {
  const owners = new Map<string, AgentTool>();
  for (const { tool, change } of planned) {
    const owner = owners.get(change.realPath);
    if (owner !== undefined && owner !== tool) throw new ConfigError(t.errors.ownershipConflict(change.path));
    owners.set(change.realPath, tool);
  }
}

/** Inspect only selected/global destinations and recorded consumers, never discover projects. */
export function inspectContextConsumers(
  paths: Paths,
  agent: AgentPaths,
  config: Config,
  env: NodeJS.ProcessEnv,
  t: Messages,
): { consumers: ContextConsumerCheck[]; instructionRoots: string[]; error: string | null; inspectionFailure: ContextInspectionFailure | null } {
  const global = resolveAgentPaths({ global: true, project: null }, env, agent.root);
  const instructionRoots = new Set([agent.root, global.root]);
  const destinations = new Map<string, { tool: AgentTool | null; path: string; json: boolean }>();
  const add = (tool: AgentTool | null, path: string, json = false) => {
    const id = `${tool ?? "unknown"}:${path}`;
    destinations.set(id, { tool, path, json: json || destinations.get(id)?.json === true });
  };
  for (const tool of AGENT_TOOLS) {
    add(tool, agent.wiredFile(tool), tool === "codex");
    add(tool, global.wiredFile(tool), tool === "codex");
    add(tool, agent.hookFile(tool), true);
    add(tool, global.hookFile(tool), true);
  }
  if (isConfigV2(config)) {
    for (const [id, registration] of Object.entries(config.wiring.registrations)) {
      if (registration.target === "shell") continue;
      instructionRoots.add(registration.destination);
      const tool = AGENT_TOOLS.find((name) => name === registration.target) ?? null;
      const registered = resolveAgentPaths({ global: false, project: registration.destination },
        { ...env, TONEDIAL_AGENT_HOME: undefined }, agent.root);
      if (tool !== null) {
        add(tool, registered.wiredFile(tool), tool === "codex");
        add(tool, registered.hookFile(tool), true);
      }
      for (const resourceId of registration.resourceIds) {
        const resource = config.wiring.resources[resourceId]!;
        if (resource.kind === "hook") add(tool, resource.accessPaths?.[id]?.path ?? resource.path,
          resource.managed.version === 2 || tool === "codex");
      }
    }
  }
  const roots = new Set([paths.root, canonicalDestination(paths.root)]);
  const locations = [...roots].map((root) => wiredAt(join(root, LEGACY_CONTEXT_ARTIFACT_FILENAME), env));
  const spellings = locations.flatMap((where) => [where.toneAbsolute, where.tonePath, hookCommand(where.toneAbsolute, where.home)]);
  const consumers: ContextConsumerCheck[] = [];
  for (const [id, { tool, path, json }] of destinations) {
    let reason: ContextInspectionFailure["reason"] = "unreadable";
    try {
      const change = planChange(path, (before) => before, t);
      const before = change.before;
      // Absence of a path spelling proves nothing when the provider document cannot parse.
      // Reuse the hook owner's syntax and shape checks for every known native destination.
      if (json) {
        reason = "invalid-provider-json";
        hasHook(before, hookCommand(locations[0]!.toneAbsolute, locations[0]!.home), path, t);
      }
      reason = "invalid-legacy-region";
      // Exact managed delivery is recognized by its existing transform. Ambiguous references
      // to this root also block transition, but never grant cleanup or adoption permission.
      const legacy = before !== null && (
        (tool !== null && locations.some((where) => wiringRemoved(TARGETS[tool], before, where, path, t) !== before)) ||
        spellings.some((text) => before.includes(text) || before.includes(JSON.stringify(text).slice(1, -1)))
      );
      let removalVerified = false;
      if (legacy && tool !== null && isConfigV2(config)) {
        for (const registration of Object.values(config.wiring.registrations)) {
          if (registration.target !== tool) continue;
          const recorded = resolveAgentPaths({ global: false, project: registration.destination },
            { ...env, TONEDIAL_AGENT_HOME: undefined }, agent.root);
          try {
            const removal = planLegacyDeliveryRemoval(paths, { ...recorded, live: registration.scope === "global" },
              tool, config.wiring, env, t);
            if (removal?.change.realPath === change.realPath && removal.change.before === before &&
                removal.change.snapshot.targetIdentity === change.snapshot.targetIdentity) {
              removalVerified = true;
              break;
            }
          } catch {
            // A failed ownership/removal check is a blocker, never fresh adoption authority.
          }
        }
      }
      consumers.push({ id, legacy, removalVerified, change });
    } catch {
      return { consumers, instructionRoots: [...instructionRoots], error: reason, inspectionFailure: { path, reason } };
    }
  }
  return { consumers, instructionRoots: [...instructionRoots], error: null, inspectionFailure: null };
}

/** Parse only named choices. Detection is never consent to configure a provider. */
export function parseToolSelection(value: string, allowNone: boolean, t: Messages): AgentTool[] {
  const names = [...new Set(value.split(",").map((name) => name.trim()))];
  if (names.some((name) => name === "") || (names.includes("none") && (!allowNone || names.length !== 1))) {
    throw new ConfigError(t.errors.toolsSelection);
  }
  if (names[0] === "none") return [];
  const known = Object.keys(TARGETS) as AgentTool[];
  for (const name of names) {
    // Reserved before unknown: a name this project has claimed is not a typo, and saying so
    // costs nothing while telling the user what would have to be true for it to work.
    const reserved = RESERVED_TARGETS[name];
    if (reserved !== undefined) throw new ConfigError(t.errors.reservedTarget(name, reserved));
    if (!known.includes(name as AgentTool)) throw new ConfigError(t.wiring.unknownTool(name, known));
  }
  return names as AgentTool[];
}

/**
 * The region body for a tool.
 *
 * The import path is written with `~` rather than expanded, because these files are shared
 * across machines through dotfile repositories and an absolute path from one home does not
 * resolve in another.
 */
export function regionContent(tonePath: string): string {
  const content = `@${tonePath}`;
  // A path containing a marker cannot be represented as an unambiguous legacy region.
  for (const marker of [MARKDOWN.begin, MARKDOWN.end]) {
    if (content.includes(marker)) {
      throw new ConfigError(
        `the compiled artifact contains ${marker}, which is this tool's own marker. ` +
          `Remove it from your persona note or safeword — wiring it would corrupt the file.`,
      );
    }
  }
  return content;
}

/**
 * How the artifact's path is written into an import line.
 *
 * `~` is resolved against the user's actual home directory, not against the state root — these
 * files travel between machines through dotfile repositories, and an absolute path from one
 * home does not resolve in another. A state root outside home keeps its absolute path, because
 * abbreviating it would produce a `~` the agent cannot expand back.
 */
export function importPath(toneAbsolute: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || homedir();
  return toneAbsolute.startsWith(home + "/") ? `~${toneAbsolute.slice(home.length)}` : toneAbsolute;
}

/** Remove owned content; only a missing input is an unconditional absent-file result. */
export function wiringRemoved(
  target: Target,
  before: string | null,
  where: WiredAt,
  path: string,
  t: Messages,
): string | null {
  if (before === null) return null;
  if (target.delivery === "hook") return withoutHook(before, hookCommand(where.toneAbsolute, where.home), path, t);
  const region = legacyRegion(before, path, t);
  // Markers alone are not permission to delete an import for a different state root.
  return region?.content === regionContent(where.tonePath) ? remove(before) : before;
}

export function ownedDelivery(target: Target, before: string | null, where: WiredAt, path: string, t: Messages): string | null {
  if (target.delivery === "hook") return ownedHook(before, hookCommand(where.toneAbsolute, where.home), path, t);
  const region = before === null ? null : legacyRegion(before, path, t);
  return region ? upsert("", region.content) : null;
}

/** Legacy inspection errors need the destination, before a multi-target plan can be approved. */
function legacyRegion(before: string, path: string, t: Messages): ReturnType<typeof find> {
  try {
    return find(before);
  } catch (cause) {
    if (cause instanceof RegionError) throw new ConfigError(t.doctor.damagedRegion(path, cause.message), { cause });
    throw cause;
  }
}

/**
 * The artifact, in the two spellings the two deliveries need.
 *
 * **One resolution, passed together, because splitting them is what broke the hook.** An import
 * line is read by the agent and takes the `~` form; a hook command is read by a shell and cannot.
 * Handing callers a single `tonePath` let the wrong one reach the wrong consumer, silently.
 */
export type WiredAt = { tonePath: string; toneAbsolute: string; home: string };

export function wiredAt(toneAbsolute: string, env: NodeJS.ProcessEnv = process.env): WiredAt {
  return { tonePath: importPath(toneAbsolute, env), toneAbsolute, home: env.HOME?.trim() || homedir() };
}
