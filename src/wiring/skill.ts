// Provider discovery entries point at one shared skill source.
// Windows copies only managed files; removal preserves foreign directory content.

import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ConfigError, writeAtomic } from "../core/config.ts";
import { SKILL_NAME } from "../core/skill.ts";
import { canonicalDestination, canonicalResourcePath, entryIdentity, nearestRealPath, skillDestinations, type SkillDestination } from "../core/paths.ts";
import type { ManagedResource, WiringV2 } from "../core/config.ts";
import type { Messages } from "../core/i18n.ts";
import type { JsonValue, OperationAction } from "../core/operations.ts";
import type { AgentPaths, AgentTool } from "../core/paths.ts";
import type { PlannedOperationAction } from "./apply.ts";
import { decodeTupleKey, putRegistration, recordResource, registrationKey, resourceKey } from "./ownership.ts";

export type SkillState = "linked" | "copied" | "foreign" | "dangling" | "absent";

/** Two paths that resolve to the same directory, whatever spelling each one used. */
function same(link: string, source: string): boolean {
  try {
    return realpathSync(link) === realpathSync(source);
  } catch {
    return readlinkSync(link) === source;
  }
}

/** The selected provider's skill discovery entry. */
export function skillPath(agent: AgentPaths, tool: AgentTool): string {
  return join(agent.skills(tool), SKILL_NAME);
}

/**
 * What is at that path now.
 *
 * `foreign` is the case worth naming: something is there and this tool did not put it. That is
 * a hand-installed skill of the same name, and overwriting it silently would be the one thing
 * a tool editing someone else's directory must not do.
 */
export function inspect(
  agent: AgentPaths,
  tool: AgentTool,
  source: string,
  platform: NodeJS.Platform = process.platform,
): SkillState {
  const path = skillPath(agent, tool);
  // `lstat`, not `exists`: `existsSync` follows the link, so one whose target is gone reported
  // "absent", hiding a stale delivery from inspection.
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "absent";
  }
  if (stat.isSymbolicLink()) {
    if (!existsSync(path)) return "dangling";
    // Resolved on both sides. A raw string comparison called our own link foreign the moment
    // the state root moved — `XDG_CONFIG_HOME` set after a first install, or a dotfiles manager
    // rewriting it as relative — and `doctor` then reported it unrepairable forever.
    return same(path, source) ? "linked" : "foreign";
  }
  // **A real directory is ours only where this tool copies rather than links.** Reading its
  // contents to decide would delete a skill installed from the marketplace by hand — the file
  // names match by construction, since it is the same skill — and guessing provenance from
  // content is the move the file path refuses everywhere else.
  if (platform !== "win32") return "foreign";
  return existsSync(join(path, "SKILL.md")) && existsSync(join(path, "references", "traits.md"))
    ? "copied"
    : "foreign";
}

/**
 * A skill delivery is a filesystem operation, not a text change.  These plans are deliberately
 * independent of the command layer: callers choose the destination route, put the returned
 * action in the shared operation gate, and record the returned resource in the schema-2 graph
 * in the same journal.
 */
export type SkillDelivery = "link" | "copy";

export type SkillPlanOptions = {
  mode: SkillDelivery;
  /** Bytes to put in a copied skill. Relative names are the managed subset of the directory. */
  files: Readonly<Record<string, string>>;
  /** Canonical or lexical boundary supplied by the selected agent route. */
  boundary?: string;
};

export type SkillPlan = {
  /** The state observed before the planned action, or the current state for a no-op. */
  state: SkillState;
  /** Canonical link-entry/directory tuple key used by schema-2 wiring. */
  resourceId: string;
  /** Resource record to pass to `recordResource` after the gate applies. */
  resource: ManagedResource;
  /** Null when the graph and filesystem are already at the requested state. */
  action: PlannedOperationAction | null;
};

type SnapshotKind = "missing" | "symlink" | "directory" | "file" | "other";

type FileSnapshot = {
  kind: SnapshotKind;
  identity: string | null;
  mode: number | null;
  sha256: string | null;
  bytes: string | null;
};

type SkillSnapshot = {
  kind: SnapshotKind;
  canonicalPath: string;
  identity: string | null;
  linkTarget: string | null;
  parentIdentity: string | null;
  parentPath: string;
  files: Record<string, FileSnapshot>;
};

type SkillActionMetadata = {
  schema: 1;
  operation: "install" | "remove";
  mode: SkillDelivery;
  destination: string;
  source: string;
  resourceId: string;
  boundary: string | null;
  trackedFiles: string[];
  created: boolean;
  createdDir: boolean;
};

const SKILL_ACTION_SCHEMA = 1 as const;

function digest(bytes: Buffer): string {
  // Keep this local to the delivery planner. `ownership.contentHash` is intentionally text-only,
  // while a copied skill must preserve the exact bytes it is given.
  return createHash("sha256").update(bytes).digest("hex");
}

function identityText(path: string): string | null {
  try {
    const identity = entryIdentity(path);
    return identity === null ? null : `${identity.dev.toString()}:${identity.ino.toString()}`;
  } catch {
    return null;
  }
}

function safeCanonical(path: string): string {
  try {
    return canonicalResourcePath(path);
  } catch {
    return nearestRealPath(path);
  }
}

function safeBoundary(path: string): string {
  try {
    // A boundary is a directory containment root, not a resource entry. Unlike a skill symlink,
    // its identity must follow an existing directory alias so a symlinked project root remains a
    // valid selected destination while writes still stay inside its physical tree.
    return realpathSync(path);
  } catch {
    return nearestRealPath(path);
  }
}

function relativeNames(files: Readonly<Record<string, string>>): string[] {
  const names = Object.keys(files).sort();
  for (const name of names) {
    if (
      name.length === 0 ||
      isAbsolute(name) ||
      name.split(/[\\/]/u).some((part) => part === ".." || part === "") ||
      name === "." ||
      name.includes("\\")
    ) {
      throw new ConfigError(`invalid managed skill file path: ${name}`);
    }
  }
  return names;
}

function fileSnapshot(path: string): FileSnapshot {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return { kind: "missing", identity: null, mode: null, sha256: null, bytes: null };
  const identity = identityText(path);
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) return { kind: "symlink", identity, mode, sha256: null, bytes: null };
  if (stat.isDirectory()) return { kind: "directory", identity, mode, sha256: null, bytes: null };
  if (!stat.isFile()) return { kind: "other", identity, mode, sha256: null, bytes: null };
  let fd: number | undefined;
  try {
    // The lstat above is only a descriptor. Open the same regular entry without following a
    // replacement at its final component, then verify its identity and timestamps around the
    // read. A FIFO, directory, or swapped-in symlink therefore becomes an "other" snapshot
    // instead of being read or blocking recovery.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || `${before.dev}:${before.ino}` !== identity || Number(before.mode & 0o7777n) !== mode) {
      return { kind: "other", identity: identityText(path), mode: Number(before.mode & 0o7777n), sha256: null, bytes: null };
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      return { kind: "other", identity: `${after.dev}:${after.ino}`, mode: Number(after.mode & 0o7777n), sha256: null, bytes: null };
    }
    return { kind: "file", identity, mode, sha256: digest(bytes), bytes: bytes.toString("base64") };
  } catch {
    return { kind: "other", identity: identityText(path), mode, sha256: null, bytes: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function captureSnapshot(destination: string, trackedFiles: readonly string[]): SkillSnapshot {
  const entry = lstatSync(destination, { throwIfNoEntry: false });
  let kind: SnapshotKind = "missing";
  let linkTarget: string | null = null;
  if (entry !== undefined) {
    if (entry.isSymbolicLink()) {
      kind = "symlink";
      linkTarget = readlinkSync(destination);
    } else if (entry.isDirectory()) kind = "directory";
    else if (entry.isFile()) kind = "file";
    else kind = "other";
  }
  const files: Record<string, FileSnapshot> = {};
  if (kind === "directory") {
    for (const relativePath of [...trackedFiles].sort()) {
      files[relativePath] = fileSnapshot(join(destination, relativePath));
    }
  }
  let parentPath: string;
  try {
    parentPath = realpathSync(dirname(destination));
  } catch {
    parentPath = nearestRealPath(dirname(destination));
  }
  return {
    kind,
    canonicalPath: safeCanonical(destination),
    identity: entry === undefined ? null : identityText(destination),
    linkTarget,
    parentIdentity: identityText(dirname(destination)),
    parentPath,
    files,
  };
}

function jsonSnapshot(snapshot: SkillSnapshot): JsonValue {
  const files: Record<string, JsonValue> = {};
  for (const name of Object.keys(snapshot.files).sort()) {
    const file = snapshot.files[name]!;
    files[name] = {
      kind: file.kind,
      identity: file.identity,
      mode: file.mode,
      sha256: file.sha256,
      bytes: file.bytes,
    };
  }
  return {
    kind: snapshot.kind,
    canonicalPath: snapshot.canonicalPath,
    identity: snapshot.identity,
    linkTarget: snapshot.linkTarget,
    parentIdentity: snapshot.parentIdentity,
    parentPath: snapshot.parentPath,
    files,
  };
}

function objectJson(value: JsonValue): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function stringJson(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

const fileSnapshotKeys = ["kind", "identity", "mode", "sha256", "bytes"] as const;
const skillSnapshotKeys = ["kind", "canonicalPath", "identity", "linkTarget", "parentIdentity", "parentPath", "files"] as const;

function normalizedAbsolute(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value) && resolve(value) === value;
}

function identityValue(value: unknown): value is string {
  return typeof value === "string" && /^\d+:\d+$/.test(value);
}

function base64Value(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function safeTrackedName(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !value.includes("\\") && value !== "." &&
    !value.split("/").some((part) => part === "" || part === "..");
}

function parseFileSnapshot(value: JsonValue | undefined, requireIdentity = false): FileSnapshot | null {
  const object = objectJson(value ?? null);
  if (object === null) return null;
  if (Object.keys(object).length !== fileSnapshotKeys.length ||
      fileSnapshotKeys.some((key) => !Object.hasOwn(object, key))) return null;
  const kind = stringJson(object.kind);
  if (kind !== "missing" && kind !== "symlink" && kind !== "directory" && kind !== "file" && kind !== "other") return null;
  const identity = object.identity;
  const mode = object.mode;
  const sha256 = object.sha256;
  const bytes = object.bytes;
  if ((identity !== null && !identityValue(identity)) ||
      (mode !== null && (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o7777)) ||
      (sha256 !== null && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(sha256))) ||
      (bytes !== null && !base64Value(bytes))) return null;
  if (kind === "missing" && (identity !== null || mode !== null || sha256 !== null || bytes !== null)) return null;
  if (kind === "file" && (typeof sha256 !== "string" || typeof bytes !== "string")) return null;
  if (kind !== "file" && (sha256 !== null || bytes !== null)) return null;
  if (requireIdentity && kind !== "missing" && (identity === null || (kind === "file" && mode === null))) return null;
  return {
    kind,
    identity: identity as string | null,
    mode: mode as number | null,
    sha256: sha256 as string | null,
    bytes: bytes as string | null,
  };
}

function parseSnapshot(value: JsonValue, requireIdentity = false): SkillSnapshot | null {
  const object = objectJson(value);
  if (object === null) return null;
  if (Object.keys(object).length !== skillSnapshotKeys.length ||
      skillSnapshotKeys.some((key) => !Object.hasOwn(object, key))) return null;
  const kind = stringJson(object.kind);
  if (kind !== "missing" && kind !== "symlink" && kind !== "directory" && kind !== "file" && kind !== "other") {
    return null;
  }
  const canonicalPath = object.canonicalPath;
  const identity = object.identity;
  const linkTarget = object.linkTarget;
  const parentIdentity = object.parentIdentity;
  const parentPath = object.parentPath;
  if (!normalizedAbsolute(canonicalPath) ||
      (identity !== null && !identityValue(identity)) ||
      (linkTarget !== null && typeof linkTarget !== "string") ||
      (parentIdentity !== null && !identityValue(parentIdentity)) ||
      !normalizedAbsolute(parentPath)) return null;
  const filesValue = objectJson(object.files ?? null);
  if (filesValue === null) return null;
  const files: Record<string, FileSnapshot> = {};
  for (const name of Object.keys(filesValue).sort()) {
    if (!safeTrackedName(name)) return null;
    const file = parseFileSnapshot(filesValue[name], requireIdentity);
    if (file === null) return null;
    files[name] = file;
  }
  if (kind === "missing" && (identity !== null || linkTarget !== null || Object.keys(files).length > 0)) return null;
  if (kind === "symlink" && (typeof linkTarget !== "string" || linkTarget.length === 0 || Object.keys(files).length > 0)) return null;
  if (kind === "directory" && linkTarget !== null) return null;
  if ((kind === "file" || kind === "other") && (linkTarget !== null || Object.keys(files).length > 0)) return null;
  if (requireIdentity && kind !== "missing" && identity === null) return null;
  return {
    kind,
    canonicalPath,
    identity: identity as string | null,
    linkTarget: linkTarget as string | null,
    parentIdentity: parentIdentity as string | null,
    parentPath,
    files,
  };
}

function snapshotsEqual(left: SkillSnapshot, right: SkillSnapshot): boolean {
  if (left.kind !== right.kind || left.identity !== right.identity || left.linkTarget !== right.linkTarget) return false;
  // A replacement parent can preserve bytes while redirecting the destination elsewhere. Keep
  // the observed parent identity even when it was missing: the current gate revalidates all
  // actions before applying any of them, so a newly appeared parent is an external race, not a
  // directory this action has already created. The action itself may create it after this check.
  if (left.parentIdentity !== right.parentIdentity || left.parentPath !== right.parentPath) return false;
  if (left.parentIdentity !== null && left.canonicalPath !== right.canonicalPath) return false;
  const names = new Set([...Object.keys(left.files), ...Object.keys(right.files)]);
  for (const name of names) {
    const a = left.files[name] ?? { kind: "missing", identity: null, mode: null, sha256: null, bytes: null };
    const b = right.files[name] ?? { kind: "missing", identity: null, mode: null, sha256: null, bytes: null };
    if (
      a.kind !== b.kind ||
      a.identity !== b.identity ||
      a.mode !== b.mode ||
      a.sha256 !== b.sha256 ||
      a.bytes !== b.bytes
    ) return false;
  }
  return true;
}

export type SkillRecoveryProbeStatus = "applied" | "already-reverted" | "changed";

/**
 * Classify a journaled skill using the skill domain's descriptor-safe snapshot owner.
 *
 * Recovery validates the complete action set before calling this function. Keep the final
 * metadata/snapshot shape check here as a guard for direct callers, but do not duplicate the
 * filesystem reader in the generic operation layer: `captureSnapshot` is the owner that handles
 * canonical/parent identity and no-follow tracked-file reads.
 */
export function probeSkillAction(action: OperationAction): SkillRecoveryProbeStatus {
  const metadata = metadataObject(action);
  const before = parseSnapshot(action.before, true);
  const after = parseSnapshot(action.after);
  if (metadata === null || before === null || after === null) {
    throw invalidSkillAction(action.path, "skill snapshots are invalid");
  }
  const current = captureSnapshot(metadata.destination, metadata.trackedFiles);
  if (snapshotsEqual(current, before)) return "already-reverted";
  // A planned create may intentionally omit the post-state identity until its write checkpoints.
  // snapshotsEqual still refuses a non-missing current entry with that null identity, so a
  // foreign file that landed after the journal was written is never adopted as ours.
  if (snapshotsEqual(current, after)) return "applied";
  return "changed";
}

function throwConflict(path: string, t: Messages): never {
  throw new ConfigError(t.errors.ownershipConflict(path));
}

function withinBoundary(destination: string, boundary: string | undefined, t: Messages): void {
  if (!boundary) return;
  const lexical = relative(resolve(boundary), resolve(destination));
  // Compare like with like. `/tmp` is commonly a symlink to `/private/tmp` on macOS, so using a
  // lexical boundary against a canonical destination rejects every fresh temporary project.
  const canonical = relative(safeBoundary(boundary), safeCanonical(destination));
  const outside = (value: string): boolean => isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`);
  if (outside(lexical) || outside(canonical)) throwConflict(destination, t);
}

function fileHashes(files: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of relativeNames(files)) result[name] = digest(Buffer.from(files[name]!, "utf8"));
  return result;
}

function previousResource(
  wiring: WiringV2,
  resourceId: string,
  destination: string,
): ManagedResource | undefined {
  const direct = wiring.resources[resourceId];
  if (direct) return direct;
  const lexical = resolve(destination);
  return Object.values(wiring.resources).find((resource) => resolve(resource.path) === lexical);
}

function resourceFor(
  destination: string,
  source: string,
  mode: SkillDelivery,
  expectedFiles: Record<string, string> | undefined,
  previous: ManagedResource | undefined,
  before: SkillSnapshot,
): ManagedResource {
  const expected: ManagedResource["expected"] = mode === "link"
    ? { type: "symlink", linkTarget: source }
    : { type: "directory", files: expectedFiles ?? {} };
  const storedPath = mode === "link"
    ? resolve(destination)
    : (before.kind === "directory" ? before.canonicalPath : safeCanonical(destination));
  return {
    path: storedPath,
    kind: "skill",
    created: previous?.created ?? before.kind === "missing",
    // For a copied delivery this is the destination directory itself; for a link it is the
    // parent chain that the link action may have created and later prune.  These are different
    // facts even though both travel in the one ownership record.
    createdDir: previous?.createdDir ?? (mode === "copy" ? before.kind === "missing" : before.parentIdentity === null),
    consumers: previous?.consumers ?? [],
    expected,
    managed: { version: previous?.managed.version ?? 1 },
  };
}

function trackedFilesFor(
  previous: ManagedResource | undefined,
  expectedFiles: Record<string, string> | undefined,
): string[] {
  return [...new Set([
    ...Object.keys(previous?.expected.files ?? {}),
    ...Object.keys(expectedFiles ?? {}),
  ])].sort();
}

function ensureSafeDirectory(path: string, boundary: string | undefined, t: Messages): void {
  withinBoundary(path, boundary, t);
  const missing: string[] = [];
  let here = resolve(path);
  for (;;) {
    const stat = lstatSync(here, { throwIfNoEntry: false });
    if (stat !== undefined) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throwConflict(here, t);
      break;
    }
    missing.unshift(here);
    const up = dirname(here);
    if (up === here) throwConflict(path, t);
    here = up;
  }
  for (const directory of missing) mkdirSync(directory);
}

function ensureSkillParent(destination: string, boundary: string | undefined, t: Messages): void {
  ensureSafeDirectory(dirname(destination), boundary, t);
}

function ensureTrackedParent(path: string, destination: string, boundary: string | undefined, t: Messages): void {
  const root = resolve(destination);
  const parent = resolve(dirname(path));
  const rel = relative(root, parent);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throwConflict(path, t);
  ensureSafeDirectory(parent, boundary, t);
}

function applyCopy(
  destination: string,
  desiredFiles: Readonly<Record<string, string>>,
  oldFiles: Readonly<Record<string, string>>,
  boundary: string | undefined,
  t: Messages,
): void {
  const entry = lstatSync(destination, { throwIfNoEntry: false });
  if (entry !== undefined && (!entry.isDirectory() || entry.isSymbolicLink())) throwConflict(destination, t);
  if (entry === undefined) ensureSafeDirectory(destination, boundary, t);
  for (const name of relativeNames(desiredFiles)) {
    const path = join(destination, name);
    ensureTrackedParent(path, destination, boundary, t);
    writeAtomic(path, desiredFiles[name]!);
  }
  for (const name of Object.keys(oldFiles).sort()) {
    if (desiredFiles[name] !== undefined) continue;
    const path = join(destination, name);
    const current = fileSnapshot(path);
    if (current.kind === "missing") continue;
    if (current.kind !== "file" || current.sha256 !== oldFiles[name]) throwConflict(path, t);
    unlinkSync(path);
  }
}

function removeCopy(
  destination: string,
  files: Readonly<Record<string, string>>,
  createdDir: boolean,
  t: Messages,
): void {
  const entry = lstatSync(destination, { throwIfNoEntry: false });
  if (entry === undefined) return;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throwConflict(destination, t);
  for (const name of Object.keys(files).sort()) {
    const path = join(destination, name);
    const current = fileSnapshot(path);
    if (current.kind === "missing") continue;
    if (current.kind !== "file" || current.sha256 !== files[name]) throwConflict(path, t);
    unlinkSync(path);
  }
  if (createdDir && readdirSync(destination).length === 0) {
    rmdirSync(destination);
  }
}

function applyLink(destination: string, source: string, boundary: string | undefined, t: Messages): void {
  const sourceEntry = lstatSync(source, { throwIfNoEntry: false });
  let resolvedSource = source;
  if (sourceEntry?.isSymbolicLink()) {
    try {
      resolvedSource = realpathSync(source);
    } catch {
      throwConflict(source, t);
    }
  }
  const sourceStat = lstatSync(resolvedSource, { throwIfNoEntry: false });
  if (sourceStat === undefined || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throwConflict(source, t);
  ensureSkillParent(destination, boundary, t);
  const current = lstatSync(destination, { throwIfNoEntry: false });
  if (current !== undefined) {
    if (!current.isSymbolicLink()) throwConflict(destination, t);
    rmSync(destination, { force: false });
  }
  symlinkSync(source, destination, "dir");
}

function desiredSnapshot(
  destination: string,
  mode: SkillDelivery,
  source: string,
  files: Readonly<Record<string, string>> | undefined,
  trackedFiles: readonly string[],
): SkillSnapshot {
  const snapshot = captureSnapshot(destination, trackedFiles);
  if (mode === "link") {
    return {
      ...snapshot,
      kind: "symlink",
      canonicalPath: safeCanonical(destination),
      identity: null,
      linkTarget: source,
      files: {},
    };
  }
  const plannedFiles: Record<string, FileSnapshot> = {};
  for (const name of Object.keys(files ?? {}).sort()) {
    const bytes = Buffer.from(files![name]!, "utf8");
    plannedFiles[name] = {
      kind: "file",
      identity: null,
      mode: null,
      sha256: digest(bytes),
      bytes: bytes.toString("base64"),
    };
  }
  return { ...snapshot, kind: "directory", identity: null, linkTarget: null, files: plannedFiles };
}

function actionMetadata(value: SkillActionMetadata): JsonValue {
  return {
    schema: value.schema,
    operation: value.operation,
    mode: value.mode,
    destination: value.destination,
    source: value.source,
    resourceId: value.resourceId,
    boundary: value.boundary,
    trackedFiles: [...value.trackedFiles],
    created: value.created,
    createdDir: value.createdDir,
  };
}

function metadataObject(action: OperationAction): SkillActionMetadata | null {
  const object = objectJson(action.metadata ?? null);
  if (object === null) return null;
  const keys = ["boundary", "created", "createdDir", "destination", "mode", "operation", "resourceId", "schema", "source", "trackedFiles"];
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) return null;
  // `trackedFiles` is an array in the journal, so decode it explicitly rather than trusting
  // arbitrary JSON as a path list.
  if (!Array.isArray(object.trackedFiles) || object.trackedFiles.some((value) => typeof value !== "string")) return null;
  const tracked = object.trackedFiles as string[];
  if (tracked.some((value) => !safeTrackedName(value)) ||
      tracked.some((value, index) => index > 0 && tracked[index - 1]! >= value)) return null;
  const mode = object.mode === "link" || object.mode === "copy" ? object.mode : null;
  const operation = object.operation === "install" || object.operation === "remove" ? object.operation : null;
  const boundary = object.boundary;
  if (object.schema !== 1 || mode === null || operation === null ||
      !normalizedAbsolute(object.destination) || !normalizedAbsolute(object.source) || typeof object.resourceId !== "string" ||
      (boundary !== null && !normalizedAbsolute(boundary)) ||
      typeof object.created !== "boolean" || typeof object.createdDir !== "boolean") {
    return null;
  }
  return {
    schema: SKILL_ACTION_SCHEMA,
    operation,
    mode,
    destination: object.destination,
    source: object.source,
    resourceId: object.resourceId,
    boundary: boundary as string | null,
    trackedFiles: tracked,
    created: object.created,
    createdDir: object.createdDir,
  };
}

function invalidSkillAction(path: string, reason: string): ConfigError {
  return new ConfigError(`cannot safely recover ${path}: ${reason}`);
}

/** Validate skill recovery semantics without inspecting the destination or source. */
export function validateSkillAction(action: OperationAction, applied = false): void {
  if (action.kind !== "skill" || !normalizedAbsolute(action.path) || !normalizedAbsolute(action.realPath) || action.path !== action.realPath) {
    throw invalidSkillAction(action.path, "skill action paths are invalid");
  }
  const metadata = metadataObject(action);
  if (metadata === null || metadata.destination !== action.path || metadata.destination !== action.realPath ||
      action.id !== `skill:${metadata.operation}:${metadata.resourceId}`) {
    throw invalidSkillAction(action.path, "skill provenance is invalid");
  }
  const before = parseSnapshot(action.before, true);
  const after = parseSnapshot(action.after, applied);
  if (before === null || after === null || before.canonicalPath !== after.canonicalPath) {
    throw invalidSkillAction(action.path, "skill snapshots are invalid");
  }
  const resourceTuple = decodeTupleKey(metadata.resourceId, 2);
  if (resourceTuple === null || resourceTuple[1] !== "skill" || !normalizedAbsolute(resourceTuple[0]) ||
      metadata.resourceId !== resourceKey(resourceTuple[0], "skill") ||
      resourceTuple[0] !== before.canonicalPath || resourceTuple[0] !== after.canonicalPath) {
    throw invalidSkillAction(action.path, "skill resource provenance is invalid");
  }
  if (metadata.boundary !== null) {
    const remainder = relative(resolve(metadata.boundary), resolve(metadata.destination));
    if (isAbsolute(remainder) || remainder === ".." || remainder.startsWith(`..${sep}`)) {
      throw invalidSkillAction(action.path, "skill destination escapes its boundary");
    }
  }
  if (metadata.mode === "link") {
    if (before.kind !== "missing" && before.kind !== "symlink") throw invalidSkillAction(action.path, "link snapshot kind is invalid");
    if (before.kind === "symlink" && before.linkTarget !== metadata.source) {
      throw invalidSkillAction(action.path, "link source provenance is inconsistent");
    }
    if (metadata.operation === "install") {
      if (after.kind !== "symlink" || after.linkTarget !== metadata.source) {
        throw invalidSkillAction(action.path, "link post-state is invalid");
      }
    } else if (after.kind !== "missing") {
      throw invalidSkillAction(action.path, "link removal post-state is invalid");
    }
  } else {
    if (before.kind !== "missing" && before.kind !== "directory") throw invalidSkillAction(action.path, "copy snapshot kind is invalid");
    if (after.kind !== "directory" && !(metadata.operation === "remove" && after.kind === "missing")) {
      throw invalidSkillAction(action.path, "copy post-state is invalid");
    }
  }
}

function actionFor(
  operation: "install" | "remove",
  destination: string,
  source: string,
  resourceId: string,
  mode: SkillDelivery,
  before: SkillSnapshot,
  after: SkillSnapshot,
  trackedFiles: string[],
  resource: ManagedResource,
  boundary: string | undefined,
  desiredFiles: Readonly<Record<string, string>>,
  oldFiles: Readonly<Record<string, string>>,
  t: Messages,
): PlannedOperationAction {
  const metadata: SkillActionMetadata = {
    schema: SKILL_ACTION_SCHEMA,
    operation,
    mode,
    destination: resolve(destination),
    source: resolve(source),
    resourceId,
    boundary: boundary === undefined ? null : resolve(boundary),
    trackedFiles,
    created: resource.created,
    createdDir: resource.createdDir,
  };
  const action: OperationAction = {
    id: `skill:${operation}:${resourceId}`,
    kind: "skill",
    path: resolve(destination),
    realPath: resolve(destination),
    before: jsonSnapshot(before),
    after: jsonSnapshot(after),
    metadata: actionMetadata(metadata),
  };
  const apply = (): void => {
    if (mode === "link") {
      if (operation === "install") applyLink(destination, source, boundary, t);
      else {
        const current = lstatSync(destination, { throwIfNoEntry: false });
        if (current !== undefined) {
          if (!current.isSymbolicLink()) throwConflict(destination, t);
          rmSync(destination, { force: false });
        }
        // Keep parent containers. A single `createdDir` bit cannot prove which intermediate
        // directory this action created, so pruning them could delete a pre-existing empty
        // `.agents` or `.claude` container.
      }
    } else if (operation === "install") {
      applyCopy(destination, desiredFiles, oldFiles, boundary, t);
    } else {
      removeCopy(destination, oldFiles, resource.createdDir, t);
    }
  };
  return {
    action,
    apply,
    assertFresh: () => {
      const current = captureSnapshot(destination, trackedFiles);
      if (!snapshotsEqual(current, before)) throwConflict(destination, t);
    },
    after: () => ({ ...action, after: jsonSnapshot(captureSnapshot(destination, trackedFiles)) }),
  };
}

/** Plan one link or managed copy without touching the filesystem. */
export function planSkillInstall(
  destination: string,
  source: string,
  wiring: WiringV2,
  options: SkillPlanOptions,
  t: Messages,
): SkillPlan {
  const lexicalDestination = resolve(destination);
  const lexicalSource = resolve(source);
  withinBoundary(lexicalDestination, options.boundary, t);
  const desiredFiles = options.mode === "copy" ? options.files : {};
  const hashes = options.mode === "copy" ? fileHashes(desiredFiles) : undefined;
  const resourceId = resourceKey(safeCanonical(lexicalDestination), "skill");
  const previous = previousResource(wiring, resourceId, lexicalDestination);
  const oldFiles = previous?.expected.files ?? {};
  const trackedFiles = trackedFilesFor(previous, hashes);
  const before = captureSnapshot(lexicalDestination, trackedFiles);
  if (previous === undefined && before.kind !== "missing") throwConflict(lexicalDestination, t);
  if (previous !== undefined) {
    const expectedType = previous.expected.type;
    if (options.mode === "link") {
      if (before.kind !== "missing" && before.kind !== "symlink") throwConflict(lexicalDestination, t);
      if (before.kind === "symlink" && previous.expected.linkTarget !== before.linkTarget) throwConflict(lexicalDestination, t);
    } else {
      if (before.kind !== "missing" && before.kind !== "directory") throwConflict(lexicalDestination, t);
      for (const [name, hash] of Object.entries(oldFiles)) {
        const current = before.files[name];
        if (current?.kind !== "missing" && (current?.kind !== "file" || current.sha256 !== hash)) throwConflict(join(lexicalDestination, name), t);
      }
      if (expectedType !== "directory" && before.kind !== "missing") throwConflict(lexicalDestination, t);
    }
  }
  const resource = resourceFor(lexicalDestination, lexicalSource, options.mode, hashes, previous, before);
  const desired = desiredSnapshot(lexicalDestination, options.mode, lexicalSource, desiredFiles, trackedFiles);
  const obsoleteClean = Object.entries(oldFiles).every(([name]) =>
    desiredFiles[name] !== undefined || before.files[name]?.kind === "missing");
  const already = options.mode === "link"
    ? before.kind === "symlink" && before.linkTarget === lexicalSource
    : before.kind === "directory" && obsoleteClean && Object.entries(hashes ?? {}).every(([name, hash]) => before.files[name]?.kind === "file" && before.files[name]?.sha256 === hash);
  const action = already
    ? null
    : actionFor("install", lexicalDestination, lexicalSource, resourceId, options.mode, before, desired, trackedFiles, resource, options.boundary, desiredFiles, oldFiles, t);
  return { state: before.kind === "symlink" ? "linked" : before.kind === "directory" ? "copied" : "absent", resourceId, resource, action };
}

/** Plan removal of one registration's delivery; callers detach the graph in the same gate. */
export function planSkillRemoval(
  destination: string,
  source: string,
  registrationId: string,
  wiring: WiringV2,
  options: Omit<SkillPlanOptions, "files" | "mode">,
  t: Messages,
): SkillPlan {
  const lexicalDestination = resolve(destination);
  const lexicalSource = resolve(source);
  withinBoundary(lexicalDestination, options.boundary, t);
  const resourceId = resourceKey(safeCanonical(lexicalDestination), "skill");
  const previous = previousResource(wiring, resourceId, lexicalDestination);
  const before = captureSnapshot(lexicalDestination, Object.keys(previous?.expected.files ?? {}).sort());
  if (previous === undefined) {
    if (before.kind !== "missing") throwConflict(lexicalDestination, t);
    const resource = resourceFor(lexicalDestination, lexicalSource, "link", undefined, undefined, before);
    return { state: "absent", resourceId, resource, action: null };
  }
  const remaining = previous.consumers.filter((consumer) => consumer !== registrationId);
  const mode: SkillDelivery = previous.expected.type === "symlink" ? "link" : "copy";
  if (remaining.length > 0) {
    return { state: before.kind === "symlink" ? "linked" : before.kind === "directory" ? "copied" : "absent", resourceId, resource: previous, action: null };
  }
  if (mode === "link") {
    if (before.kind === "missing") return { state: "absent", resourceId, resource: previous, action: null };
    if (before.kind !== "symlink" || before.linkTarget !== previous.expected.linkTarget) throwConflict(lexicalDestination, t);
  } else {
    if (before.kind === "missing") return { state: "absent", resourceId, resource: previous, action: null };
    if (before.kind !== "directory") throwConflict(lexicalDestination, t);
    for (const [name, hash] of Object.entries(previous.expected.files ?? {})) {
      const current = before.files[name];
      if (current?.kind !== "missing" && (current?.kind !== "file" || current.sha256 !== hash)) throwConflict(join(lexicalDestination, name), t);
    }
  }
  // The initial descriptor deliberately has no post-action identity.  If the process dies
  // before the first checkpoint, recovery must refuse to infer ownership from bytes alone; the
  // completed checkpoint replaces this with the actual post-removal snapshot.
  const desired = mode === "link"
    ? { ...before, kind: "missing" as const, identity: null, linkTarget: null, files: {} }
    : {
        ...before,
        kind: "directory" as const,
        identity: null,
        linkTarget: null,
        files: Object.fromEntries(Object.keys(previous.expected.files ?? {}).sort().map((name) => [name, {
          kind: "missing" as const,
          identity: null,
          mode: null,
          sha256: null,
          bytes: null,
        }])),
      };
  const emptyDesired: Readonly<Record<string, string>> = {};
  const action = actionFor("remove", lexicalDestination, lexicalSource, resourceId, mode, before, desired, Object.keys(previous.expected.files ?? {}).sort(), previous, options.boundary, emptyDesired, previous.expected.files ?? {}, t);
  return { state: mode === "link" ? "linked" : "copied", resourceId, resource: previous, action };
}

export type SelectedSkillReceipt = {
  tool: AgentTool;
  /** Desired post-apply delivery mode; route entries retain their observed pre-action states. */
  state: SkillState;
  routes: Array<{ path: string; state: SkillState; resourceId: string }>;
};

export type SelectedSkillPlan = {
  /** Graph after all selected registrations/resources have been attached. */
  wiring: WiringV2;
  /** Unique physical actions; shared `.agents` delivery is emitted once for many tools. */
  actions: PlannedOperationAction[];
  /** Per-tool route states for the command receipt. */
  skills: SelectedSkillReceipt[];
};

/**
 * Plan the concrete shared-skill routes for a selected set of tools.
 *
 * `files` is the selected seed's already-known content.  Passing it lets a copy route be planned
 * in the same batch that creates the state-root source; the source need not exist until the text
 * seed action runs.  The returned graph is pure data and must be committed only after the action
 * gate succeeds.
 */
export function planSelectedSkills(
  agent: AgentPaths,
  tools: readonly AgentTool[],
  source: string,
  wiring: WiringV2,
  files: Readonly<Record<string, string>>,
  t: Messages,
): SelectedSkillPlan {
  let next = wiring;
  const actions: PlannedOperationAction[] = [];
  const actionResources = new Set<string>();
  const skills: SelectedSkillReceipt[] = [];
  const mode: SkillDelivery = process.platform === "win32" ? "copy" : "link";
  const destination = canonicalDestination(agent.root);

  for (const tool of tools) {
    const routes: SkillDestination[] = skillDestinations(agent, tool, SKILL_NAME, source);
    const receipt: SelectedSkillReceipt = {
      tool,
      state: mode === "link" ? "linked" : "copied",
      routes: [],
    };
    const registration = {
      target: tool,
      scope: agent.live ? "global" as const : "project" as const,
      destination,
    };
    const registrationId = registrationKey(registration.target, registration.scope, registration.destination);
    if (!next.registrations[registrationId]) {
      next = putRegistration(next, { ...registration, resourceIds: [] });
    }
    for (const route of routes) {
      const plan = planSkillInstall(route.path, route.source, next, {
        mode,
        files,
        boundary: agent.root,
      }, t);
      if (!actionResources.has(plan.resourceId) && plan.action !== null) {
        actions.push(plan.action);
        actionResources.add(plan.resourceId);
      }
      next = recordResource(next, registrationId, plan.resourceId, plan.resource);
      receipt.routes.push({ path: route.path, state: plan.state, resourceId: plan.resourceId });
    }
    skills.push(receipt);
  }
  return { wiring: next, actions, skills };
}

/** Recover a completed skill action from a pending journal. The dispatcher owns kind routing. */
export function rollbackSkillAction(action: OperationAction, t: Messages): void {
  if (action.kind !== "skill") throw new ConfigError(`cannot safely recover ${action.path}: action kind ${action.kind} is not a skill`);
  // The direct domain entry point may be called without the shared journal dispatcher. Keep its
  // pure semantic gate ahead of the first destination snapshot in that path too.
  validateSkillAction(action, true);
  const metadata = metadataObject(action);
  const before = parseSnapshot(action.before);
  const after = parseSnapshot(action.after);
  if (metadata === null || before === null || after === null) throw new ConfigError(`cannot safely recover ${action.path}: skill snapshots are invalid`);
  if (after.kind !== "missing" && after.identity === null) {
    throw new ConfigError(`cannot safely recover ${action.path}: its applied identity was not checkpointed`);
  }
  const current = captureSnapshot(metadata.destination, metadata.trackedFiles);
  if (!snapshotsEqual(current, after)) throw new ConfigError(`${action.path} changed after the operation; preserving it for manual recovery`);
  const destination = metadata.destination;
  if (before.kind === "missing") {
    if (current.kind === "symlink") rmSync(destination, { force: false });
    else if (current.kind === "directory") {
      for (const name of metadata.trackedFiles) {
        const file = fileSnapshot(join(destination, name));
        const applied = after.files[name];
        if (applied?.kind === "file" && file.kind === "file" && file.sha256 === applied.sha256) unlinkSync(join(destination, name));
      }
      if (metadata.createdDir && readdirSync(destination).length === 0) rmdirSync(destination);
    }
    return;
  }
  if (before.kind === "symlink") {
    if ((current.kind !== "symlink" && current.kind !== "missing") || before.linkTarget === null) {
      throw new ConfigError(`cannot safely recover ${action.path}: original link is unavailable`);
    }
    if (current.kind === "symlink") rmSync(destination, { force: false });
    ensureSkillParent(destination, metadata.boundary ?? undefined, t);
    symlinkSync(before.linkTarget, destination, "dir");
    return;
  }
  if (before.kind !== "directory") throw new ConfigError(`cannot safely recover ${action.path}: original skill type is unsupported`);
  ensureSafeDirectory(destination, metadata.boundary ?? undefined, t);
  for (const name of metadata.trackedFiles) {
    const original = before.files[name];
    const path = join(destination, name);
    if (!original || original.kind === "missing") {
      const applied = after.files[name];
      const currentFile = fileSnapshot(path);
      if (applied?.kind === "file" && currentFile.kind === "file" && currentFile.sha256 === applied.sha256) {
        unlinkSync(path);
      }
      continue;
    }
    if (original.kind !== "file" || original.bytes === null) throw new ConfigError(`cannot safely recover ${action.path}: original skill bytes are unavailable`);
    ensureTrackedParent(path, destination, metadata.boundary ?? undefined, t);
    writeAtomic(path, Buffer.from(original.bytes, "base64").toString("utf8"));
    if (original.mode !== null) chmodSync(path, original.mode);
  }
}
