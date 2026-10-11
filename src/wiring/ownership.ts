// The persisted ownership graph for schema-2 wiring.
//
// A registration is a selected delivery at one destination. Resources are the physical files,
// links, or directories that delivery uses. The graph is deliberately small and concrete: the
// command layer can attach several registrations to one resource, and removal can drop one
// consumer without mistaking another destination's ownership for its own.

import type {
  ManagedResource,
  ResourceAccess,
  WiringRegistration,
  WiringResourceMap,
  WiringScope,
  WiringV2,
  ResourceKind,
} from "../core/config.ts";
import { createHash } from "node:crypto";
import type { Change } from "./apply.ts";
import { ConfigError } from "../core/config.ts";
import type { Messages } from "../core/i18n.ts";
import { canonicalResourcePath } from "../core/paths.ts";

export const contentHash = (contents: string): string => createHash("sha256").update(contents).digest("hex");

/** Record a planned text write; the caller journals this graph with that same write. */
export function recordFileChange(
  wiring: WiringV2,
  registration: Omit<WiringRegistration, "resourceIds">,
  change: Change,
  kind: ResourceKind,
  managed: ManagedResource["managed"],
  t: Messages,
): WiringV2 {
  if (change.after === null) throw new Error("cannot register a removed resource");
  const registrationId = registrationKey(registration.target, registration.scope, registration.destination);
  assertRegisteredFileChange(wiring, registrationId, change, kind, t);
  const selected = wiring.registrations[registrationId];
  const graph = putRegistration(wiring, { ...selected, ...registration, resourceIds: selected?.resourceIds ?? [] });
  const resourceId = resourceKey(change.realPath, kind);
  const access: ResourceAccess = change.snapshot.symbolicLink
    ? {
        path: change.path,
        type: "symlink",
        linkTarget: change.snapshot.linkTarget ?? "",
      }
    : { path: change.path, type: "file" };
  return recordResource(graph, registrationId, resourceId, {
    path: change.realPath,
    kind,
    created: change.created,
    createdDir: change.createdDir,
    consumers: [],
    accessPaths: { [registrationId]: access },
    expected: { type: "file", sha256: contentHash(change.after) },
    managed,
    ...(kind === "hook" && managed.version === 2 ? { managedByRegistration: { [registrationId]: managed } } : {}),
  });
}

/** Refresh the access that was approved, not a new referent reached through the same link. */
export function assertRegisteredFileChange(
  wiring: WiringV2,
  registrationId: string,
  change: Change,
  kind: ResourceKind,
  t: Messages,
): void {
  for (const id of wiring.registrations[registrationId]?.resourceIds ?? []) {
    const resource = wiring.resources[id]!;
    if (resource.kind !== kind) continue;
    const access = resource.accessPaths?.[registrationId];
    if (!access) throw new ConfigError(t.errors.ownershipConflict(change.path));
    // One shell registration may retain several rc files after a login-shell change.
    if (kind === "shell" && access.path !== change.path
      && canonicalResourcePath(access.path) !== canonicalResourcePath(change.path)) continue;
    assertRecordedTextAccess(change, resource, access, t);
  }
}

/** Missing resources may be detached, but missing evidence never authorizes a new write. */
export function assertRecordedTextAccess(
  change: Change,
  resource: ManagedResource,
  access: ResourceAccess | undefined,
  t: Messages,
  removing = false,
): void {
  if (removing && change.before === null) return;
  if (!access || change.realPath !== resource.path
    || change.snapshot.symbolicLink !== (access.type === "symlink")
    || (access.type === "symlink" && change.snapshot.linkTarget !== access.linkTarget)) {
    throw new ConfigError(t.errors.ownershipConflict(access?.path ?? resource.path));
  }
}

/** Encode tuple keys as JSON, so paths containing the chosen delimiter cannot collide. */
export function tupleKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

/** Stable identity for one selected target and destination. */
export function registrationKey(
  target: string,
  scope: WiringScope,
  destination: string,
): string {
  return tupleKey([target, scope, destination]);
}

/** Stable identity for one physical resource and its resource kind. */
export function resourceKey(path: string, kind: ResourceKind): string {
  return tupleKey([path, kind]);
}

/** Decode a persisted tuple key without accepting arbitrary JSON as an identity. */
export function decodeTupleKey(value: string, length: number): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== length || parsed.some((part) => typeof part !== "string")) {
    return null;
  }
  return parsed as string[];
}

/** A fresh graph for a state root with no selected delivery yet. */
export function emptyWiring(): WiringV2 {
  return { registrations: {}, resources: {} };
}

function cloneManaged(source: ManagedResource["managed"]): ManagedResource["managed"] {
  const managed: ManagedResource["managed"] = { version: source.version };
  for (const key of ["event", "matcher", "handlerSha256", "command", "runtime", "statusMessage", "name", "description", "regionId"] as const) {
    if (source[key] !== undefined) managed[key] = source[key];
  }
  if (source.args !== undefined) managed.args = [...source.args];
  // One spelling survives a rewrite. Keeping both would leave a stale singular beside the list
  // that supersedes it, with nothing checking they still agree.
  if (source.matchers !== undefined) {
    managed.matchers = [...source.matchers];
    delete managed.matcher;
  }
  return managed;
}

/**
 * Deterministic representation used before config serialization and after graph mutations.
 * Resource/registration values are copied so a caller cannot mutate the stored graph through a
 * returned nested object.
 */
export function normalizeWiring(wiring: WiringV2): WiringV2 {
  const registrations: WiringV2["registrations"] = {};
  for (const key of Object.keys(wiring.registrations).sort()) {
    const registration = wiring.registrations[key]!;
    registrations[key] = {
      target: registration.target,
      scope: registration.scope,
      destination: registration.destination,
      resourceIds: [...registration.resourceIds].sort(),
      ...(registration.context ? { context: registration.context } : {}),
    };
  }

  const resources: WiringResourceMap = {};
  for (const key of Object.keys(wiring.resources).sort()) {
    const resource = wiring.resources[key]!;
    const expected: ManagedResource["expected"] = { type: resource.expected.type };
    if (resource.expected.linkTarget !== undefined) expected.linkTarget = resource.expected.linkTarget;
    if (resource.expected.sha256 !== undefined) expected.sha256 = resource.expected.sha256;
    if (resource.expected.files !== undefined) {
      expected.files = {};
      for (const file of Object.keys(resource.expected.files).sort()) {
        expected.files[file] = resource.expected.files[file]!;
      }
    }
    const managed = cloneManaged(resource.managed);
    const managedByRegistration: NonNullable<ManagedResource["managedByRegistration"]> = {};
    for (const id of Object.keys(resource.managedByRegistration ?? {}).sort()) {
      managedByRegistration[id] = cloneManaged(resource.managedByRegistration![id]!);
    }
    const accessPaths: Record<string, ResourceAccess> = {};
    for (const accessKey of Object.keys(resource.accessPaths ?? {}).sort()) {
      const access = resource.accessPaths![accessKey]!;
      accessPaths[accessKey] = {
        path: access.path,
        type: access.type,
        ...(access.linkTarget !== undefined ? { linkTarget: access.linkTarget } : {}),
      };
    }
    resources[key] = {
      path: resource.path,
      kind: resource.kind,
      created: resource.created,
      createdDir: resource.createdDir,
      consumers: [...resource.consumers].sort(),
      ...(Object.keys(accessPaths).length > 0 ? { accessPaths } : {}),
      expected,
      managed,
      ...(Object.keys(managedByRegistration).length ? { managedByRegistration } : {}),
      ...(resource.documentDescription === undefined ? {} : { documentDescription: resource.documentDescription }),
    };
  }
  return { registrations, resources };
}

/** Replace one registration without mutating the input graph. */
export function putRegistration(
  wiring: WiringV2,
  registration: WiringRegistration,
): WiringV2 {
  const key = registrationKey(registration.target, registration.scope, registration.destination);
  const next = normalizeWiring(wiring);
  next.registrations[key] = {
    target: registration.target,
    scope: registration.scope,
    destination: registration.destination,
    resourceIds: [...registration.resourceIds],
    ...(registration.context ? { context: registration.context } : {}),
  };
  return normalizeWiring(next);
}

/** Replace one resource without mutating the input graph. */
export function putResource(
  wiring: WiringV2,
  key: string,
  resource: ManagedResource,
): WiringV2 {
  // Historical reader records still parse and round-trip, but only managedSeeds may own a new reader.
  if (resource.kind === "reader") throw new Error("Reader wiring records are read-only; use managed seed ownership");
  const next = normalizeWiring(wiring);
  const previous = next.resources[key];
  if (previous) {
    const accessPaths = { ...(previous.accessPaths ?? {}), ...(resource.accessPaths ?? {}) };
    const managedByRegistration = { ...previous.managedByRegistration, ...resource.managedByRegistration };
    next.resources[key] = {
      ...resource,
      // Hook identities have their own per-registration map; retain a legacy handler's witness.
      managed: resource.kind === "hook" && previous.managed.version === 1 && resource.managed.version === 2
        ? previous.managed : resource.managed,
      // Creation is a historical fact. A later observation that the resource exists must not
      // turn an originally existing file into something eject may delete.
      created: previous.created,
      createdDir: previous.createdDir,
      consumers: [...new Set([...previous.consumers, ...resource.consumers])],
      ...(Object.keys(accessPaths).length > 0 ? { accessPaths } : {}),
      ...(Object.keys(managedByRegistration).length > 0 ? { managedByRegistration } : {}),
    };
  } else {
    next.resources[key] = resource;
  }
  return normalizeWiring(next);
}

/** Record one observed resource and attach it to a selected registration. */
export function recordResource(
  wiring: WiringV2,
  registrationId: string,
  resourceId: string,
  resource: ManagedResource,
): WiringV2 {
  return attachResource(putResource(wiring, resourceId, resource), registrationId, resourceId);
}

/** Attach a resource to a registration and add the reverse consumer reference. */
export function attachResource(
  wiring: WiringV2,
  registrationId: string,
  resourceId: string,
): WiringV2 {
  const registration = wiring.registrations[registrationId];
  const resource = wiring.resources[resourceId];
  if (!registration || !resource) throw new Error("cannot attach an unknown wiring reference");
  const next = normalizeWiring(wiring);
  const selected = next.registrations[registrationId]!;
  if (!selected.resourceIds.includes(resourceId)) selected.resourceIds.push(resourceId);
  const consumers = next.resources[resourceId]!.consumers;
  if (!consumers.includes(registrationId)) consumers.push(registrationId);
  return normalizeWiring(next);
}

/**
 * Remove one registration and its reverse consumer references. Orphaned resources stay in the
 * graph so a state-root source or a completed migration can remain recorded for later repair.
 */
export function detachRegistration(wiring: WiringV2, registrationId: string): WiringV2 {
  const registration = wiring.registrations[registrationId];
  if (!registration) return normalizeWiring(wiring);
  const next = normalizeWiring(wiring);
  delete next.registrations[registrationId];
  for (const resourceId of registration.resourceIds) {
    const resource = next.resources[resourceId];
    if (resource) {
      resource.consumers = resource.consumers.filter((id) => id !== registrationId);
      if (resource.accessPaths !== undefined) {
        delete resource.accessPaths[registrationId];
      }
      if (resource.managedByRegistration !== undefined) delete resource.managedByRegistration[registrationId];
    }
  }
  return normalizeWiring(next);
}
