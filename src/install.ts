// The private entry point used by the npm-less installer and self-update path.
//
// This file is deliberately narrower than `init`: it installs the package and the command that
// points at it. It does not create config, seeds, presets, skills, agent files, or shell rc
// entries. Those are user state and belong to the explicit commands that own them.

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INSTALL_MARKER,
  INSTALL_MARKER_TEXT,
  INSTALL_METADATA,
  AGENT_TOOLS,
  resolvePaths,
  shellQuote,
  shimScript,
  type Paths,
} from "./core/paths.ts";
import {
  acquireOperation,
  claimRecoveryLease,
  operationOwnerMatches,
  persistRetirementReceipt,
  readRetirementReceipt,
  processState,
  validOwner,
  validLease,
  OPERATION_LEASE_FILE,
  OPERATION_OWNER_FILE,
  OPERATION_RECOVERY_DIR,
  type OperationLease,
  type OperationOwner,
  type JsonValue,
  type RetirementSeal,
} from "./core/operations.ts";
import { confirm, interactive } from "./ui/prompt.ts";

const RECORD_SCHEMA = 1;
const OWNER_FILE = OPERATION_OWNER_FILE;
const RECORD_FILE = "record.json";
const RECOVERY_DIR = OPERATION_RECOVERY_DIR;
const LEASE_FILE = OPERATION_LEASE_FILE;
const CANDIDATE_DIR = "candidate";
const PREVIOUS_DIR = "previous";
const COMPLETED_PREFIX = "completed-";
const COMMAND_ARCHIVE = "previous-command";
const LEGACY_COMPONENTS = ["package.json", "src", "dist"] as const;
type LegacyComponent = (typeof LEGACY_COMPONENTS)[number];
export type ArchiveComponent = "lib" | "command" | "legacy-bin";
export type InstallRepairOptions = { archiveCurrent: readonly ArchiveComponent[] };
type RepairArchive = { legacy: Partial<Record<LegacyComponent, Snapshot>>; binAfterArchive: Snapshot | null };

type Identity = { dev: string; ino: string };

type Snapshot =
  | { exists: false }
  | {
      exists: true;
      type: "file" | "directory";
      identity: Identity;
      mode: number;
      tree: string;
      bytes?: string;
    }
  | { exists: true; type: "symlink" | "other"; identity: Identity; mode: number; target?: string };

type Candidate = { version: string; packageDigest: string };

type RecordState = "prepared" | "staged" | "previous-moved" | "lib-swapped" | "shim-prepared" | "shim-written" | "verified" | "complete" | "rolled-back" | "retired-for-app-rebuild";

type InstallRecord = {
  schema: typeof RECORD_SCHEMA;
  kind: "install";
  operationId: string;
  root: string;
  state: RecordState;
  candidate: Candidate;
  candidateSnapshot: Snapshot | null;
  before: { lib: Snapshot; bin: Snapshot; command: Snapshot };
  after: { lib: Snapshot | null; command: Snapshot | null };
  desiredCommand: { bytes: string; mode: number };
  /** The temp file identity recorded before its atomic rename into the command path. */
  preparedCommand?: Snapshot | null;
  preparedPath?: string | null;
  /** The bin directory created by this operation, when its identity was durably recorded. */
  createdBin?: Snapshot | null;
  cleanup: "pending" | "removed" | "preserved";
  /** Repair archives remain private even when the new package passes verification. */
  repair?: RepairArchive;
  retirement?: RetirementSeal;
};

type Owner = OperationOwner<"install">;
type Lease = OperationLease;

class InstallFailure extends Error {}

function fail(message: string): never {
  throw new InstallFailure(message);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function identity(stat: Stats): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function lstatOrNull(path: string): Stats | null {
  return lstatSync(path, { throwIfNoEntry: false }) ?? null;
}

function mode(stat: Stats): number {
  return stat.mode & 0o7777;
}

function sortedEntries(path: string): Dirent[] {
  return (readdirSync(path, { withFileTypes: true }) as Dirent[]).sort((a, b) => a.name.localeCompare(b.name));
}

/** A deterministic package/tree fingerprint. It never follows a link or reads a special file. */
function treeDigest(path: string, excluded = new Set<string>(), lexical = false): string {
  const digest = createHash("sha256");

  const walk = (directory: string, prefix: string): void => {
    for (const entry of sortedEntries(directory)) {
      if (prefix === "" && excluded.has(entry.name)) continue;
      const child = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = lstatOrNull(child);
      if (stat === null) fail(`install target disappeared while it was being inspected: ${child}`);
      if (stat.isSymbolicLink()) {
        if (!lexical) fail(`install target contains a symbolic link: ${child}`);
        digest.update(`l\0${relativePath}\0${mode(stat)}\0${readlinkSync(child)}\n`);
        continue;
      }
      if (stat.isDirectory()) {
        digest.update(`d\0${relativePath}\0${mode(stat)}\n`);
        walk(child, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        if (!lexical) fail(`install target contains a non-regular file: ${child}`);
        digest.update(`o\0${relativePath}\0${stat.dev}\0${stat.ino}\0${stat.mode}\n`);
        continue;
      }
      if (stat.nlink !== 1 && !lexical) fail("install target contains a hard-linked file: " + child);
      const bytes = readFileSync(child);
      digest.update(`f\0${relativePath}\0${mode(stat)}\0${hash(bytes)}\n`);
    }
  };

  walk(path, "");
  return digest.digest("hex");
}

function snapshot(path: string, includeBytes = false): Snapshot {
  const stat = lstatOrNull(path);
  if (stat === null) return { exists: false };
  const id = identity(stat);
  const fileMode = mode(stat);
  if (stat.isSymbolicLink()) return { exists: true, type: "symlink", identity: id, mode: fileMode, target: readlinkSync(path) };
  if (stat.isDirectory()) return { exists: true, type: "directory", identity: id, mode: fileMode, tree: treeDigest(path, new Set(), true) };
  if (stat.isFile()) {
    const bytes = readFileSync(path);
    return {
      exists: true,
      type: "file",
      identity: id,
      mode: fileMode,
      tree: hash(bytes),
      ...(includeBytes ? { bytes: Buffer.from(bytes).toString("base64") } : {}),
    };
  }
  return { exists: true, type: "other", identity: id, mode: fileMode };
}

function snapshotsEqual(actual: Snapshot, expected: Snapshot): boolean {
  if (actual.exists !== expected.exists) return false;
  if (!actual.exists || !expected.exists) return true;
  if (actual.type !== expected.type || !sameIdentity(actual.identity, expected.identity) || actual.mode !== expected.mode) return false;
  if (actual.type === "directory" && expected.type === "directory") return actual.tree === expected.tree;
  if (actual.type === "file" && expected.type === "file") return actual.tree === expected.tree && (expected.bytes === undefined || actual.bytes === expected.bytes);
  if (actual.type === "symlink" && expected.type === "symlink") return expected.target === undefined || actual.target === expected.target;
  return true;
}

/** Compare only the entry identity/type; directory contents are expected to change while running. */
function sameEntry(actual: Snapshot, expected: Snapshot): boolean {
  if (actual.exists !== expected.exists) return false;
  if (!actual.exists || !expected.exists) return true;
  return actual.type === expected.type && sameIdentity(actual.identity, expected.identity) && actual.mode === expected.mode;
}

function assertEntry(path: string, expected: Snapshot, label: string): void {
  if (!sameEntry(snapshot(path), expected)) fail(`${path} ${label}; preserving it for manual recovery`);
}

function readJson<T>(path: string): T | null {
  let descriptor: number | undefined;
  try {
    const named = lstatOrNull(path);
    if (named === null || !named.isFile() || named.isSymbolicLink() || named.size > 4 * 1024 * 1024) return null;
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(identity(opened), identity(named)) || mode(opened) !== mode(named) ||
        opened.size !== named.size || opened.mtimeMs !== named.mtimeMs || opened.ctimeMs !== named.ctimeMs) return null;
    const contents = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    const current = lstatOrNull(path);
    if (current === null || !current.isFile() || !sameIdentity(identity(after), identity(opened)) ||
        !sameIdentity(identity(current), identity(opened)) || mode(after) !== mode(opened) ||
        after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return null;
    return JSON.parse(contents) as T;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeAtomic(path: string, contents: string | Uint8Array, fileMode = 0o600): Snapshot {
  const temporary = `${path}.tmp-${randomBytes(16).toString("hex")}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, fileMode);
    writeFileSync(descriptor, contents);
    // The requested mode is part of the journal's contract; fchmod is not subject to umask and
    // operates on the inode we opened rather than a path that could have been substituted.
    fchmodSync(descriptor, fileMode);
    closeSync(descriptor);
    descriptor = undefined;
    const written = snapshot(temporary, true);
    renameSync(temporary, path);
    return written;
  } catch (cause) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw cause;
  }
}

type PreparedWrite = { path: string; snapshot: Snapshot };

/** Prepare a same-directory replacement and return its identity before the rename. */
function prepareAtomic(path: string, contents: string, fileMode: number, token: string, parent: Snapshot): PreparedWrite {
  const temporary = `${path}.tmp-${token}`;
  let descriptor: number | undefined;
  let openedIdentity: Identity | undefined;
  try {
    assertEntry(dirname(path), parent, "parent changed before shim preparation");
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, fileMode);
    writeFileSync(descriptor, contents);
    // Normalize via the opened inode so a restrictive umask cannot create a journal mode that
    // differs from the recovery contract, and do not chmod a pathname after a replacement.
    fchmodSync(descriptor, fileMode);
    const opened = fstatSync(descriptor);
    openedIdentity = identity(opened);
    closeSync(descriptor);
    descriptor = undefined;
    const prepared = snapshot(temporary, true);
    if (!prepared.exists || prepared.type !== "file" || !sameIdentity(prepared.identity, openedIdentity) ||
        prepared.mode !== fileMode || prepared.bytes !== Buffer.from(contents, "utf8").toString("base64")) {
      fail(`${temporary} changed while the shim was being prepared; preserving it for manual recovery`);
    }
    assertEntry(dirname(path), parent, "parent changed while shim was being prepared");
    return { path: temporary, snapshot: prepared };
  } catch (cause) {
    if (descriptor !== undefined) closeSync(descriptor);
    const current = lstatOrNull(temporary);
    if (openedIdentity !== undefined && current !== null && current.isFile() && sameIdentity(identity(current), openedIdentity)) {
      unlinkSync(temporary);
    }
    throw cause;
  }
}

function commitPrepared(prepared: PreparedWrite, destination: string, parent: Snapshot, before: Snapshot): Snapshot {
  assertEntry(dirname(destination), parent, "parent changed before shim replacement");
  if (!snapshotsEqual(snapshot(prepared.path, true), prepared.snapshot)) {
    fail(`${prepared.path} changed before shim replacement; preserving it for manual recovery`);
  }
  if (!snapshotsEqual(snapshot(destination, true), before)) {
    fail(`${destination} changed before shim replacement; preserving it for manual recovery`);
  }
  renameSync(prepared.path, destination);
  return prepared.snapshot;
}

function writeRecord(lock: string, record: InstallRecord): void {
  writeAtomic(join(lock, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function validBase64(value: unknown): value is string {
  return typeof value === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function validSnapshot(value: unknown, requireBytes = false): value is Snapshot {
  if (!isPlainObject(value) || typeof value.exists !== "boolean") return false;
  if (!value.exists) return hasExactKeys(value, ["exists"]);
  if (typeof value.type !== "string" || !["file", "directory", "symlink", "other"].includes(value.type)) return false;
  if (!isPlainObject(value.identity) || !hasExactKeys(value.identity, ["dev", "ino"]) ||
      typeof value.identity.dev !== "string" || value.identity.dev === "" ||
      typeof value.identity.ino !== "string" || value.identity.ino === "" ||
      typeof value.mode !== "number" || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o7777) return false;
  const allowed = value.type === "file"
    ? ["exists", "identity", "mode", "tree", "type", ...(Object.hasOwn(value, "bytes") ? ["bytes"] : [])]
    : ["exists", "identity", "mode", "type", ...(value.type === "directory" ? ["tree"] : []), ...(Object.hasOwn(value, "target") ? ["target"] : [])];
  if (!hasExactKeys(value, allowed)) return false;
  if (Object.hasOwn(value, "target") && (value.type !== "symlink" || typeof value.target !== "string" || value.target.includes("\0"))) return false;
  if (value.type === "file" || value.type === "directory") {
    if (typeof value.tree !== "string" || !/^[0-9a-f]{64}$/.test(value.tree)) return false;
  }
  if (value.type === "file") {
    if (requireBytes && typeof value.bytes !== "string") return false;
    if (value.bytes !== undefined && !validBase64(value.bytes)) return false;
    if (typeof value.bytes === "string" && hash(Buffer.from(value.bytes, "base64")) !== value.tree) return false;
  }
  return true;
}

function validRecord(value: unknown, root: string, operationId: string): value is InstallRecord {
  if (!isPlainObject(value)) return false;
  const expectedKeys = [
    "after", "before", "candidate", "candidateSnapshot", "cleanup", "desiredCommand", "kind", "operationId", "root", "schema", "state",
    ...(Object.hasOwn(value, "preparedCommand") ? ["preparedCommand"] : []),
    ...(Object.hasOwn(value, "preparedPath") ? ["preparedPath"] : []),
    ...(Object.hasOwn(value, "createdBin") ? ["createdBin"] : []),
    ...(Object.hasOwn(value, "repair") ? ["repair"] : []),
    ...(Object.hasOwn(value, "retirement") ? ["retirement"] : []),
  ];
  if (!hasExactKeys(value, expectedKeys)) return false;
  if (value.schema !== RECORD_SCHEMA || value.kind !== "install" || value.root !== root || value.operationId !== operationId ||
      typeof value.state !== "string" || !["prepared", "staged", "previous-moved", "lib-swapped", "shim-prepared", "shim-written", "verified", "complete", "rolled-back", "retired-for-app-rebuild"].includes(value.state) ||
      typeof value.operationId !== "string" || !/^[0-9a-f]{32}$/.test(value.operationId) ||
      !isPlainObject(value.candidate) || !hasExactKeys(value.candidate, ["packageDigest", "version"]) ||
      typeof value.candidate.version !== "string" || value.candidate.version === "" || typeof value.candidate.packageDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.candidate.packageDigest) ||
      (value.candidateSnapshot !== null && !validSnapshot(value.candidateSnapshot)) ||
      !isPlainObject(value.before) || !hasExactKeys(value.before, ["bin", "command", "lib"]) ||
      !validSnapshot(value.before.lib) || !validSnapshot(value.before.bin) || !validSnapshot(value.before.command, true) ||
      !isPlainObject(value.after) || !hasExactKeys(value.after, ["command", "lib"]) ||
      (value.after.lib !== null && !validSnapshot(value.after.lib)) ||
      (value.after.command !== null && !validSnapshot(value.after.command)) ||
      !isPlainObject(value.desiredCommand) || !hasExactKeys(value.desiredCommand, ["bytes", "mode"]) ||
      !validBase64(value.desiredCommand.bytes) || value.desiredCommand.bytes === "" ||
      typeof value.desiredCommand.mode !== "number" || !Number.isInteger(value.desiredCommand.mode) || value.desiredCommand.mode < 0 || value.desiredCommand.mode > 0o7777 ||
      typeof value.cleanup !== "string" || !["pending", "removed", "preserved"].includes(value.cleanup)) return false;
  const hasPrepared = value.preparedCommand !== undefined && value.preparedCommand !== null;
  const hasPreparedPath = value.preparedPath !== undefined && value.preparedPath !== null;
  if (hasPrepared !== hasPreparedPath || (value.state !== "retired-for-app-rebuild" && (value.state === "shim-prepared") !== hasPrepared)) return false;
  if (hasPrepared) {
    const prepared = value.preparedCommand;
    const command = resolvePaths({ TONEDIAL_HOME: root }).command;
    if (value.preparedPath !== `${command}.tmp-${operationId}` ||
        !validSnapshot(prepared, true) || !prepared.exists || prepared.type !== "file" ||
        prepared.bytes !== value.desiredCommand.bytes || prepared.mode !== value.desiredCommand.mode) return false;
  }
  if (Object.hasOwn(value, "createdBin") && value.createdBin !== null) {
    if (value.before.bin.exists || !validSnapshot(value.createdBin) || !value.createdBin.exists || value.createdBin.type !== "directory") return false;
  }
  if (Object.hasOwn(value, "repair")) {
    if (!isPlainObject(value.repair) || !hasExactKeys(value.repair, ["legacy", "binAfterArchive"]) ||
        !isPlainObject(value.repair.legacy) || Object.keys(value.repair.legacy).some((key) => !(LEGACY_COMPONENTS as readonly string[]).includes(key)) ||
        Object.values(value.repair.legacy).some((entry) => !validSnapshot(entry)) ||
        (value.repair.binAfterArchive !== null && !validSnapshot(value.repair.binAfterArchive))) return false;
  }
  if ((value.state === "retired-for-app-rebuild") !== Object.hasOwn(value, "retirement")) return false;
  if (Object.hasOwn(value, "retirement") && (!isPlainObject(value.retirement) || !hasExactKeys(value.retirement, ["receipt", "identity", "digest"]))) return false;
  return true;
}

function safeRoot(root: string, create = true): string {
  const absolute = resolve(root);
  if (absolute === "/" || absolute === "/.tonedial" || absolute === "") fail(`TONEDIAL_HOME resolves to ${absolute}, which is not a safe place to install.`);
  const stat = lstatOrNull(absolute);
  if (stat?.isSymbolicLink()) fail(`${absolute} is a symbolic link; choose its target as the install root.`);
  if (stat !== null && !stat.isDirectory()) fail(`${absolute} is not a directory.`);
  if (stat === null && create) mkdirSync(absolute, { recursive: true });
  return absolute;
}

function ensureDirectory(path: string, label: string): boolean {
  const stat = lstatOrNull(path);
  if (stat === null) {
    // `path` is a direct child of the already-safe install root. Keep creation exclusive so a
    // directory that appears between the lstat and mkdir cannot be mistaken for ours.
    try {
      mkdirSync(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        fail(`${path} appeared during installation; preserving it for manual recovery`);
      }
      throw cause;
    }
    const created = lstatOrNull(path);
    if (created === null || !created.isDirectory() || created.isSymbolicLink()) fail(`${path} is not a safe ${label}.`);
    return true;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${path} is not a safe ${label}.`);
  return false;
}

function validateCandidate(path: string): Candidate {
  const absolute = resolve(path);
  const stat = lstatOrNull(absolute);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) fail("what was downloaded does not look like tonedial");
  if (absolute === "/" || absolute === "") fail("what was downloaded does not look like tonedial");
  const packagePath = join(absolute, "package.json");
  const packageStat = lstatOrNull(packagePath);
  if (packageStat === null || !packageStat.isFile()) fail("what was downloaded does not look like tonedial");
  let packageJson: { name?: unknown; version?: unknown };
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown; version?: unknown };
  } catch {
    fail("what was downloaded does not look like tonedial");
  }
  if (packageJson.name !== "tonedial" || typeof packageJson.version !== "string" || packageJson.version === "") {
    fail("what was downloaded does not look like tonedial");
  }
  for (const required of [join(absolute, "dist", "bin.js"), join(absolute, "dist", "install.js")]) {
    const requiredStat = lstatOrNull(required);
    if (requiredStat === null || !requiredStat.isFile()) fail("what was downloaded does not look like tonedial");
  }
  if (lstatOrNull(join(absolute, INSTALL_MARKER)) !== null || lstatOrNull(join(absolute, INSTALL_METADATA)) !== null) {
    fail("the release already contains tonedial's install marker");
  }
  const packageDigest = treeDigest(absolute);
  return { version: packageJson.version, packageDigest };
}

function packageMetadata(path: string): { version: string; packageDigest: string } | null {
  const markerStat = lstatOrNull(join(path, INSTALL_MARKER));
  const metadataPath = join(path, INSTALL_METADATA);
  const metadataStat = lstatOrNull(metadataPath);
  if (markerStat === null || !markerStat.isFile() || metadataStat === null || !metadataStat.isFile()) return null;
  try {
    if (readFileSync(join(path, INSTALL_MARKER), "utf8") !== INSTALL_MARKER_TEXT) return null;
    const raw = JSON.parse(readFileSync(metadataPath, "utf8")) as { schema?: unknown; version?: unknown; packageDigest?: unknown };
    if (raw.schema !== 1 || typeof raw.version !== "string" || typeof raw.packageDigest !== "string") return null;
    if (treeDigest(path, new Set([INSTALL_MARKER, INSTALL_METADATA])) !== raw.packageDigest) return null;
    return { version: raw.version, packageDigest: raw.packageDigest };
  } catch {
    return null;
  }
}

function ownedPackage(path: string): boolean {
  const stat = lstatOrNull(path);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return false;
  return packageMetadata(path) !== null;
}

function rejectForeignSibling(path: string): void {
  if (lstatOrNull(path) !== null) fail(`${path} is in the way and this tool did not put it there; remove it yourself`);
}

function unchangedCommandSnapshot(paths: Paths, before: Snapshot): Snapshot {
  const current = snapshot(paths.command, true);
  if (snapshotsEqual(current, before)) return current;
  // Without a recorded write identity, identical bytes do not prove that we created this file.
  fail(`${paths.command} has no matching recorded write; preserving it for manual recovery`);
}

function preparedCommandSnapshot(paths: Paths, record: InstallRecord): Snapshot {
  const before = record.before.command;
  const current = snapshot(paths.command, true);
  if (snapshotsEqual(current, before)) return before;
  const prepared = record.preparedCommand;
  if (prepared !== null && prepared !== undefined && snapshotsEqual(current, prepared)) return current;
  fail(`${paths.command} changed before its prepared shim could be checkpointed; preserving it for manual recovery`);
}

function removePreparedShim(record: InstallRecord): void {
  const path = record.preparedPath;
  const expected = record.preparedCommand;
  if (path === null || path === undefined) return;
  const current = snapshot(path, true);
  if (!current.exists) return;
  if (expected === null || expected === undefined || !snapshotsEqual(current, expected)) {
    fail(`${path} changed during installation; preserving it for manual recovery`);
  }
  rmSync(path, { force: false });
}

function expectedShim(paths: Paths): Buffer {
  return Buffer.from(shimScript(paths.lib, paths.root), "utf8");
}

function recognizedPackage(path: string): boolean {
  const raw = readJson<{ name?: unknown }>(join(path, "package.json"));
  if (raw?.name === "tonedial") return true;
  const marker = lstatOrNull(join(path, INSTALL_MARKER));
  return marker !== null && marker.isFile() && !marker.isSymbolicLink() && marker.size === Buffer.byteLength(INSTALL_MARKER_TEXT) &&
    readFileSync(join(path, INSTALL_MARKER)).equals(Buffer.from(INSTALL_MARKER_TEXT));
}

function preflight(paths: Paths, repair?: InstallRepairOptions): { lib: Snapshot; bin: Snapshot; command: Snapshot; legacy: Partial<Record<LegacyComponent, Snapshot>> } {
  rejectForeignSibling(paths.libPrevious);
  rejectForeignSibling(paths.libIncoming);

  const oldLayoutPackage = lstatOrNull(join(paths.bin, "package.json"));
  const oldLayoutSource = lstatOrNull(join(paths.bin, "src"));
  if (repair === undefined && oldLayoutPackage !== null && oldLayoutSource !== null) {
    fail("bin/package.json and bin/src belong to an install from before this installer split bin/ and lib; remove it yourself and run this again");
  }

  const lib = snapshot(paths.lib);
  if (lib.exists && !ownedPackage(paths.lib) &&
      !(repair && ((lib.type === "directory" && recognizedPackage(paths.lib)) || repair.archiveCurrent.includes("lib")))) {
    if (!repair) fail(`${paths.lib} is in the way and this tool did not put it there; remove it yourself`);
    fail(`${paths.lib} is not an identifiable installed package; preserve it or use --repair --archive-current lib after reviewing this component`);
  }

  const binStat = lstatOrNull(paths.bin);
  if (binStat !== null && (!binStat.isDirectory() || binStat.isSymbolicLink())) fail(`${paths.bin} is not a safe command directory.`);
  const bin = snapshot(paths.bin);
  const command = snapshot(paths.command, true);
  // Explicit installation replaces this exact regular command, regardless of prior ownership.
  if (command.exists && command.type !== "file" && !repair?.archiveCurrent.includes("command")) {
    if (command.type === "symlink" && !repair) fail(`install target contains a symbolic link: ${paths.command}`);
    fail(`${paths.command} is in the way and this tool did not put it there; remove it yourself`);
  }
  const legacy: Partial<Record<LegacyComponent, Snapshot>> = {};
  if (repair) {
    const present = LEGACY_COMPONENTS.filter((name) => lstatOrNull(join(paths.bin, name)) !== null);
    if (present.length && !recognizedPackage(paths.bin) && !repair.archiveCurrent.includes("legacy-bin")) {
      fail("bin/package.json, bin/src or bin/dist are not an identifiable historical package; use --archive-current legacy-bin only after reviewing those components");
    }
    for (const name of present) legacy[name] = snapshot(join(paths.bin, name));
  }
  return { lib, bin, command, legacy };
}

function lockEntriesAreKnown(lock: string): boolean {
  const allowed = new Set([OWNER_FILE, RECORD_FILE, CANDIDATE_DIR, PREVIOUS_DIR, RECOVERY_DIR, COMMAND_ARCHIVE, ...LEGACY_COMPONENTS.map((name) => `legacy-${name}`)]);
  return sortedEntries(lock).every((entry) => allowed.has(entry.name));
}

function leaseEntriesAreKnown(lock: string): boolean {
  const recovery = join(lock, RECOVERY_DIR);
  const stat = lstatOrNull(recovery);
  if (stat === null) return true;
  return stat.isDirectory() && sortedEntries(recovery).every((entry) => entry.name === LEASE_FILE);
}

function acquireLock(paths: Paths): { lock: string; owner: Owner } {
  try {
    const handle = acquireOperation(paths, "install");
    return { lock: handle.lock, owner: handle.owner };
  } catch (cause) {
    if (cause instanceof Error) fail(cause.message);
    throw cause;
  }
}

function removeExact(path: string, expected: Snapshot): void {
  const current = snapshot(path, expected.exists && expected.type === "file" && expected.bytes !== undefined);
  if (!snapshotsEqual(current, expected)) fail(`${path} changed during installation; preserving it for manual recovery`);
  if (!expected.exists) return;
  if (expected.type === "file") {
    unlinkSync(path);
    return;
  }
  if (expected.type === "directory") {
    rmSync(path, { recursive: true, force: false });
    return;
  }
  rmSync(path, { force: false });
}

function restoreFile(path: string, before: Snapshot, after: Snapshot): void {
  const current = snapshot(path, true);
  if (snapshotsEqual(current, before)) return;
  if (!snapshotsEqual(current, after)) fail(`${path} changed during installation; preserving it for manual recovery`);
  if (!before.exists) {
    if (!after.exists) fail(`${path} has no recorded replacement; preserving it for manual recovery`);
    if (after.type === "file") unlinkSync(path);
    else if (after.type === "directory") rmSync(path, { recursive: true, force: false });
    else rmSync(path, { force: false });
    return;
  }
  if (before.type !== "file" || before.bytes === undefined) fail(`${path} cannot be restored safely; preserving it for manual recovery`);
  writeAtomic(path, Buffer.from(before.bytes, "base64"), before.mode);
}

function rollback(paths: Paths, lock: string, record: InstallRecord): void {
  const previous = join(lock, PREVIOUS_DIR);
  const candidate = join(lock, CANDIDATE_DIR);
  const rootBoundary = snapshot(paths.root);
  const previousSnapshot = snapshot(previous);
  const currentLib = snapshot(paths.lib);
  const beforeLib = record.before.lib;
  // A crash between the candidate rename and the record update leaves `after.lib` null, but the
  // candidate snapshot has the same identity and complete tree hash after that rename. Treat it
  // as the owned after-state; anything else remains a manual conflict.
  const afterLib = record.after.lib ?? record.candidateSnapshot;

  // The only package trees this function may remove are the exact tree it staged and the exact
  // tree it put in place. A marker alone never licenses a recursive deletion.
  if (record.candidateSnapshot !== null && snapshot(candidate).exists) removeExact(candidate, record.candidateSnapshot);
  if (afterLib !== null && snapshotsEqual(currentLib, afterLib)) {
    if (beforeLib.exists && !snapshotsEqual(previousSnapshot, beforeLib)) fail("the previous package backup changed during installation; preserving it for manual recovery");
    if (!beforeLib.exists && previousSnapshot.exists) fail("an unexpected package backup exists; preserving it for manual recovery");
    removeExact(paths.lib, afterLib);
    if (beforeLib.exists) {
      if (!snapshotsEqual(previousSnapshot, beforeLib)) fail(`${previous} changed during installation; preserving it for manual recovery`);
      assertEntry(paths.root, rootBoundary, "root changed before package rollback");
      if (snapshot(paths.lib).exists || !snapshotsEqual(snapshot(previous), beforeLib)) fail(`${paths.lib} changed before package rollback; preserving it for manual recovery`);
      renameSync(previous, paths.lib);
    }
  } else if (!snapshotsEqual(currentLib, beforeLib)) {
    // A swap can have stopped after moving the old lib and before moving the candidate.
    if (!currentLib.exists && beforeLib.exists && snapshotsEqual(previousSnapshot, beforeLib)) {
      assertEntry(paths.root, rootBoundary, "root changed before package rollback");
      if (snapshot(paths.lib).exists || !snapshotsEqual(snapshot(previous), beforeLib)) fail(`${paths.lib} changed before package rollback; preserving it for manual recovery`);
      renameSync(previous, paths.lib);
    } else {
      fail(`${paths.lib} changed during installation; preserving it for manual recovery`);
    }
  }

  if (record.repair) {
    const binBoundary = record.before.bin.exists ? record.before.bin : record.createdBin;
    if (binBoundary) assertEntry(paths.bin, binBoundary, "command directory changed before archive rollback");
    restoreArchive(paths.command, join(lock, COMMAND_ARCHIVE), record.before.command,
      record.after.command ?? record.preparedCommand ?? { exists: false });
    for (const name of LEGACY_COMPONENTS) {
      const before = record.repair.legacy[name];
      if (before) restoreArchive(join(paths.bin, name), join(lock, `legacy-${name}`), before, { exists: false });
    }
  } else {
    const afterCommand = record.state === "shim-prepared"
      ? preparedCommandSnapshot(paths, record)
      : record.after.command ?? unchangedCommandSnapshot(paths, record.before.command);
    restoreFile(paths.command, record.before.command, afterCommand);
  }
  removePreparedShim(record);
  if (!record.before.bin.exists && record.createdBin?.exists && record.createdBin.type === "directory") {
    const bin = snapshot(paths.bin);
    if (snapshotsEqual(bin, record.createdBin) && readdirSync(paths.bin).length === 0) rmdirSync(paths.bin);
  }
  if (lstatOrNull(previous) !== null) {
    // A prior tree must never be recursively removed unless its complete identity and content
    // still match the snapshot. Rollback should leave no backup behind when it is safe to do so.
    if (record.before.lib.exists) removeExact(previous, record.before.lib);
    else fail(`${previous} exists unexpectedly; preserving it for manual recovery`);
  }
  record.state = "rolled-back";
  record.preparedCommand = null;
  record.preparedPath = null;
  record.createdBin = null;
  record.cleanup = "removed";
  writeRecord(lock, record);
}

/** Repair preserves original entries by rename; it never follows an archived link. */
function restoreArchive(destination: string, archive: string, before: Snapshot, after: Snapshot): void {
  const current = snapshot(destination, true);
  const saved = snapshot(archive, true);
  if (snapshotsEqual(current, before) && !saved.exists) return;
  if (!snapshotsEqual(saved, before) || (current.exists && !snapshotsEqual(current, after))) fail(`${destination} or its archive changed; preserving them for manual recovery`);
  if (current.exists) removeExact(destination, after);
  if (before.exists) renameSync(archive, destination);
}

function verify(paths: Paths, expectedVersion: string): void {
  const env = { ...process.env, TONEDIAL_HOME: paths.root };
  const direct = execFileSync(process.execPath, [join(paths.lib, "dist", "bin.js"), "--version", "--json"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    killSignal: "SIGTERM",
  });
  const directJson = JSON.parse(direct) as { ok?: unknown; version?: unknown };
  if (directJson.ok !== true || directJson.version !== expectedVersion) fail("the new tonedial command did not pass verification");
  const shim = execFileSync(paths.command, ["--version", "--json"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    killSignal: "SIGTERM",
  });
  const shimJson = JSON.parse(shim) as { ok?: unknown; version?: unknown };
  if (shimJson.ok !== true || shimJson.version !== expectedVersion) fail("the tonedial command shim did not pass verification");
}

function completedPath(paths: Paths, operationId: string): string {
  return join(paths.operations, `${COMPLETED_PREFIX}${operationId}`);
}

function cleanupCompleted(path: string, owner: Owner, record: InstallRecord): void {
  // Only remove the exact operation files we wrote. Unknown files, or a user-edited backup,
  // leave the completed record behind for inspection rather than inviting a recursive delete.
  if (!leaseEntriesAreKnown(path)) return;
  const previous = join(path, PREVIOUS_DIR);
  if (record.repair || record.state === "retired-for-app-rebuild") return;
  if (lstatOrNull(previous) !== null) return;
  const candidate = join(path, CANDIDATE_DIR);
  if (lstatOrNull(candidate) !== null || !lockEntriesAreKnown(path)) return;
  const recovery = join(path, RECOVERY_DIR);
  const lease = readJson<Lease>(join(recovery, LEASE_FILE));
  if (lstatOrNull(recovery) !== null && (!validLease(lease) || lease.operationId !== owner.operationId)) return;
  for (const file of [OWNER_FILE, RECORD_FILE]) {
    const target = join(path, file);
    if (lstatOrNull(target)?.isFile()) unlinkSync(target);
  }
  if (lstatOrNull(join(recovery, LEASE_FILE))?.isFile()) unlinkSync(join(recovery, LEASE_FILE));
  if (lstatOrNull(recovery)?.isDirectory() && readdirSync(recovery).length === 0) rmdirSync(recovery);
  if (readdirSync(path).length === 0) rmdirSync(path);
}

function finish(paths: Paths, lock: string, owner: Owner, record: InstallRecord): void {
  if (!operationOwnerMatches(lock, owner)) fail(`${lock} ownership changed during installation; preserving it for manual recovery`);
  const target = completedPath(paths, owner.operationId);
  if (lstatOrNull(target) !== null) fail(`${target} already exists; preserving the install record`);
  renameSync(lock, target);
  cleanupCompleted(target, owner, record);
}

function writeCandidate(lock: string, source: string, candidate: Candidate, lockBoundary: Snapshot): Snapshot {
  const destination = join(lock, CANDIDATE_DIR);
  assertEntry(lock, lockBoundary, "lock parent changed before staging");
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
  const staged = snapshot(destination);
  if (!staged.exists || staged.type !== "directory") fail(`${destination} is not a safe staged package; preserving it for manual recovery`);
  const actualDigest = treeDigest(destination);
  if (actualDigest !== candidate.packageDigest) fail("the staged release changed while it was being copied");
  assertEntry(lock, lockBoundary, "lock parent changed while staging");
  assertEntry(destination, staged, "staged package changed before its marker was written");
  writeFileSync(join(destination, INSTALL_MARKER), INSTALL_MARKER_TEXT);
  assertEntry(lock, lockBoundary, "lock parent changed while staging");
  assertEntry(destination, staged, "staged package changed before its metadata was written");
  writeFileSync(
    join(destination, INSTALL_METADATA),
    `${JSON.stringify({ schema: 1, version: candidate.version, packageDigest: candidate.packageDigest }, null, 2)}\n`,
    { mode: 0o644 },
  );
  assertEntry(lock, lockBoundary, "lock parent changed after staging");
  const complete = snapshot(destination);
  if (!complete.exists || complete.type !== "directory" || !sameIdentity(complete.identity, staged.identity) ||
      treeDigest(destination, new Set([INSTALL_MARKER, INSTALL_METADATA])) !== candidate.packageDigest) {
    fail(`${destination} changed after staging; preserving it for manual recovery`);
  }
  return complete;
}

function runTransaction(paths: Paths, source: string, candidate: Candidate, lock: string, owner: Owner, before: { lib: Snapshot; bin: Snapshot; command: Snapshot }, repair?: RepairArchive): void {
  const record: InstallRecord = {
    schema: RECORD_SCHEMA,
    kind: "install",
    operationId: owner.operationId,
    root: paths.root,
    state: "prepared",
    candidate,
    candidateSnapshot: null,
    before,
    after: { lib: null, command: null },
    desiredCommand: { bytes: expectedShim(paths).toString("base64"), mode: 0o755 },
    preparedCommand: null,
    preparedPath: null,
    createdBin: null,
    cleanup: "pending",
    ...(repair ? { repair } : {}),
  };
  const rootBoundary = snapshot(paths.root);
  const lockBoundary = snapshot(lock);
  // This is the durable intent and all before-snapshots. It is written before any final target.
  writeRecord(lock, record);
  try {
    record.candidateSnapshot = writeCandidate(lock, source, candidate, lockBoundary);
    record.state = "staged";
    writeRecord(lock, record);

    const previous = join(lock, PREVIOUS_DIR);
    if (before.lib.exists) {
      assertEntry(paths.root, rootBoundary, "root changed before package backup");
      const currentLib = snapshot(paths.lib);
      if (!snapshotsEqual(currentLib, before.lib)) fail("the installed package changed during installation; preserving it for manual recovery");
      if (!repair && !ownedPackage(paths.lib)) fail(`${paths.lib} changed during installation; preserving it for manual recovery`);
      if (lstatOrNull(previous) !== null) fail(`${previous} appeared during installation; preserving it for manual recovery`);
      assertEntry(paths.lib, before.lib, "installed package changed before package backup");
      assertEntry(paths.root, rootBoundary, "root changed before package backup");
      renameSync(paths.lib, previous);
      if (!snapshotsEqual(snapshot(previous), before.lib)) fail(`${previous} changed during installation; preserving it for manual recovery`);
      record.state = "previous-moved";
      writeRecord(lock, record);
    }
    if (repair) {
      if (!snapshotsEqual(snapshot(paths.bin), before.bin)) fail(`${paths.bin} changed before component archival; preserving it for manual recovery`);
      for (const [destination, archiveName, expected] of [
        [paths.command, COMMAND_ARCHIVE, before.command],
        ...LEGACY_COMPONENTS.filter((name) => repair.legacy[name]).map((name) => [join(paths.bin, name), `legacy-${name}`, repair.legacy[name]!]),
      ] as [string, string, Snapshot][]) {
        if (!expected.exists) continue;
        assertEntry(paths.bin, before.bin, "command directory changed before archival");
        if (!snapshotsEqual(snapshot(destination, true), expected) || lstatOrNull(join(lock, archiveName)) !== null) fail(`${destination} changed before archival; preserving it for manual recovery`);
        renameSync(destination, join(lock, archiveName));
        if (!snapshotsEqual(snapshot(join(lock, archiveName), true), expected)) fail(`${destination} archive changed; preserving it for manual recovery`);
      }
      repair.binAfterArchive = snapshot(paths.bin);
      writeRecord(lock, record);
    }
    // Re-check an originally absent target immediately before the candidate rename. A directory
    // that appeared after preflight is not ours merely because it is empty or package-shaped.
    assertEntry(paths.root, rootBoundary, "root changed before package replacement");
    assertEntry(lock, lockBoundary, "lock parent changed before package replacement");
    if (snapshot(paths.lib).exists) fail(`${paths.lib} appeared during installation; preserving it for manual recovery`);
    if (record.candidateSnapshot === null || !snapshotsEqual(snapshot(join(lock, CANDIDATE_DIR)), record.candidateSnapshot)) {
      fail(`${join(lock, CANDIDATE_DIR)} changed before package replacement; preserving it for manual recovery`);
    }
    renameSync(join(lock, CANDIDATE_DIR), paths.lib);
    const installed = snapshot(paths.lib);
    if (!snapshotsEqual(installed, record.candidateSnapshot)) fail(`${paths.lib} changed after replacement; preserving it for manual recovery`);
    record.after.lib = installed;
    record.state = "lib-swapped";
    writeRecord(lock, record);

    // `bin/` is also a final target boundary: if it appeared or changed after preflight, do not
    // create a command inside a directory this operation did not observe and cannot own.
    assertEntry(paths.root, rootBoundary, "root changed before command preparation");
    const expectedBin = repair?.binAfterArchive ?? before.bin;
    if (!snapshotsEqual(snapshot(paths.bin), expectedBin)) {
      fail(`${paths.bin} changed during installation; preserving it for manual recovery`);
    }
    const binCreated = ensureDirectory(paths.bin, "command directory");
    const currentBin = snapshot(paths.bin);
    if (!currentBin.exists || currentBin.type !== "directory") fail(`${paths.bin} is not a safe command directory.`);
    if (before.bin.exists) {
      if (binCreated || !snapshotsEqual(currentBin, expectedBin)) fail(`${paths.bin} changed during installation; preserving it for manual recovery`);
    } else {
      if (!binCreated) fail(`${paths.bin} appeared during installation; preserving it for manual recovery`);
      record.createdBin = currentBin;
      writeRecord(lock, record);
    }
    const binBoundary = currentBin;
    const shim = expectedShim(paths);
    // Compare identity, mode, and bytes to the snapshot taken before this operation. Bytes alone
    // are insufficient: a foreign replacement can copy our shim and would otherwise be replaced.
    // The initial regular command is approved for replacement; normalize its mode below.
    const currentCommand = snapshot(paths.command, true);
    const commandBeforePublication: Snapshot = repair ? { exists: false } : before.command;
    if (!snapshotsEqual(currentCommand, commandBeforePublication)) {
      fail(`${paths.command} changed during installation; preserving it for manual recovery`);
    }
    const preparedCommand = prepareAtomic(paths.command, shim.toString("utf8"), 0o755, owner.operationId, binBoundary);
    record.preparedCommand = preparedCommand.snapshot;
    record.preparedPath = preparedCommand.path;
    record.state = "shim-prepared";
    writeRecord(lock, record);
    const writtenCommand = commitPrepared(preparedCommand, paths.command, binBoundary, commandBeforePublication);
    record.after.command = writtenCommand;
    record.preparedCommand = null;
    record.preparedPath = null;
    const installedCommand = snapshot(paths.command, true);
    if (!snapshotsEqual(installedCommand, writtenCommand)) fail(`${paths.command} changed after replacement; preserving it for manual recovery`);
    record.state = "shim-written";
    writeRecord(lock, record);

    verify(paths, candidate.version);
    if (!snapshotsEqual(snapshot(paths.lib), record.after.lib) ||
        !snapshotsEqual(snapshot(paths.command, true), record.after.command)) {
      fail("the installed package or command changed during verification; preserving it for manual recovery");
    }
    record.state = "verified";
    writeRecord(lock, record);

    const previousPath = join(lock, PREVIOUS_DIR);
    if (repair) {
      record.cleanup = "preserved";
    } else if (lstatOrNull(previousPath) !== null) {
      if (snapshotsEqual(snapshot(previousPath), before.lib)) {
        removeExact(previousPath, before.lib);
        record.cleanup = "removed";
      } else {
        // The install itself is verified; a user edit in the backup must survive. The completed
        // operation record is retained instead of recursively deleting that tree.
        record.cleanup = "preserved";
      }
    } else {
      record.cleanup = "removed";
    }
    record.state = "complete";
    writeRecord(lock, record);
    finish(paths, lock, owner, record);
  } catch (cause) {
    if (record.state === "verified") {
      // Verification commits the new runnable package. Cleanup is best effort: if deleting the
      // backup fails, rolling back would risk deleting the verified lib after the backup has been
      // partially removed. Leave the lock and its record for a later safe cleanup/recovery.
      record.cleanup = "pending";
      try {
        writeRecord(lock, record);
      } catch {
        // The previous durable record remains the safest recovery point when this write fails.
      }
      throw new InstallFailure(String((cause as Error).message) + "; the new install passed verification but cleanup needs manual recovery");
    }
    try {
      if (record.state !== "complete" && record.state !== "rolled-back") rollback(paths, lock, record);
      if (record.state === "rolled-back") finish(paths, lock, owner, record);
    } catch (rollbackCause) {
      throw new InstallFailure(`${(cause as Error).message}; rollback was not safe: ${(rollbackCause as Error).message}`);
    }
    if (cause instanceof InstallFailure) throw cause;
    throw new InstallFailure((cause as Error).message);
  }
}

function recoverRecord(paths: Paths, lock: string, owner: Owner, record: InstallRecord): void {
  if (!lockEntriesAreKnown(lock) || !leaseEntriesAreKnown(lock)) fail(`${lock} contains unknown recovery files; preserving it for manual recovery`);
  try {
    claimRecoveryLease(lock, owner);
  } catch (cause) {
    if (cause instanceof Error) fail(cause.message);
    throw cause;
  }
  const reread = readJson<Owner>(join(lock, OWNER_FILE));
  if (!validOwner(reread, "install") || reread.operationId !== owner.operationId || reread.nonce !== owner.nonce) fail(`${lock} ownership changed during recovery; preserving it for manual recovery`);
  if (processState(owner.pid) !== "dead") fail(`${lock} owner is live or ambiguous; preserving it for manual recovery`);
  const selectedRecord = readJson<InstallRecord>(join(lock, RECORD_FILE));
  if (!validRecord(selectedRecord, paths.root, owner.operationId) || JSON.stringify(selectedRecord) !== JSON.stringify(record)) {
    fail(`${lock} install record changed during recovery; preserving it for manual recovery`);
  }
  record = selectedRecord;
  if (record.state === "verified" || record.state === "complete") {
    if (record.after.lib === null || !snapshotsEqual(snapshot(paths.lib), record.after.lib) || record.after.command === null || !snapshotsEqual(snapshot(paths.command, true), record.after.command)) {
      fail(`${lock} no longer matches its verified install snapshot; preserving it for manual recovery`);
    }
    const previous = join(lock, PREVIOUS_DIR);
    if (record.repair) {
      record.cleanup = "preserved";
    } else if (lstatOrNull(previous) !== null) {
      if (snapshotsEqual(snapshot(previous), record.before.lib)) {
        removeExact(previous, record.before.lib);
        record.cleanup = "removed";
      } else {
        record.cleanup = "preserved";
      }
    }
    record.state = "complete";
    writeRecord(lock, record);
    // Keep the lease until the whole lock directory is atomically moved out of the contested
    // name. Another stale reclaimer can therefore never race a read-token-then-delete release.
    const target = completedPath(paths, owner.operationId);
    if (lstatOrNull(target) !== null) fail(`${target} already exists; preserving the install record`);
    renameSync(lock, target);
    cleanupCompleted(target, owner, record);
    return;
  }

  rollback(paths, lock, record);
  const target = completedPath(paths, owner.operationId);
  if (lstatOrNull(target) !== null) fail(`${target} already exists; preserving the install record`);
  renameSync(lock, target);
  cleanupCompleted(target, owner, record);
}

function recoverInterrupted(paths: Paths): void {
  const stat = lstatOrNull(paths.operationsLock);
  if (stat === null) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${paths.operationsLock} is not a safe operation lock; preserving it`);
  if (!lockEntriesAreKnown(paths.operationsLock)) fail(`${paths.operationsLock} contains unknown recovery files; preserving it for manual recovery`);
  const owner = readJson<Owner>(join(paths.operationsLock, OWNER_FILE));
  if (!validOwner(owner, "install")) fail(`${paths.operationsLock} has no valid owner record; preserving it for manual recovery`);
  const state = processState(owner.pid);
  if (state !== "dead") fail(`${paths.operationsLock} is busy or ambiguous; no install files were changed`);
  const record = readJson<InstallRecord>(join(paths.operationsLock, RECORD_FILE));
  if (!validRecord(record, paths.root, owner.operationId)) fail(`${paths.operationsLock} has no valid install record; preserving it for manual recovery`);
  if (record.state === "retired-for-app-rebuild") {
    retireInterruptedInstall(paths, owner, record);
    return;
  }
  recoverRecord(paths, paths.operationsLock, owner, record);
}

/** Approval to rebuild is a terminal retirement, never invented rollback authority. */
function retireInterruptedInstall(paths: Paths, owner: Owner, selected: InstallRecord): void {
  if (!lockEntriesAreKnown(paths.operationsLock) || !leaseEntriesAreKnown(paths.operationsLock) || processState(owner.pid) !== "dead") {
    fail("the interrupted installer is live, ambiguous or contains unknown evidence; preserve it for inspection");
  }
  claimRecoveryLease(paths.operationsLock, owner);
  if (!operationOwnerMatches(paths.operationsLock, owner) || JSON.stringify(readJson<InstallRecord>(join(paths.operationsLock, RECORD_FILE))) !== JSON.stringify(selected)) {
    fail("the interrupted installation changed while recovery was claimed; preserve it for inspection");
  }
  let record = selected;
  if (record.state !== "retired-for-app-rebuild") {
    const observed = {
      lib: snapshot(paths.lib), command: snapshot(paths.command, true),
      previous: snapshot(join(paths.operationsLock, PREVIOUS_DIR)), candidate: snapshot(join(paths.operationsLock, CANDIDATE_DIR)),
    };
    const retirement = persistRetirementReceipt(paths, owner, { record: record as unknown as JsonValue, observed: observed as unknown as JsonValue });
    if (!operationOwnerMatches(paths.operationsLock, owner) || JSON.stringify(readJson<InstallRecord>(join(paths.operationsLock, RECORD_FILE))) !== JSON.stringify(record) ||
        !snapshotsEqual(snapshot(paths.lib), observed.lib) || !snapshotsEqual(snapshot(paths.command, true), observed.command) ||
        !snapshotsEqual(snapshot(join(paths.operationsLock, PREVIOUS_DIR)), observed.previous) || !snapshotsEqual(snapshot(join(paths.operationsLock, CANDIDATE_DIR)), observed.candidate)) {
      fail("installation evidence changed before retirement sealing; preserve the pending owner");
    }
    record = { ...record, state: "retired-for-app-rebuild", retirement };
    writeRecord(paths.operationsLock, record);
  }
  const receipt = readRetirementReceipt(paths, record.retirement!);
  const lockIdentity = lstatSync(paths.operationsLock);
  const ownerIdentity = lstatSync(join(paths.operationsLock, OWNER_FILE));
  const historical = receipt && isPlainObject(receipt.evidence) ? receipt.evidence.record : null;
  if (receipt === null || receipt.operationId !== owner.operationId || JSON.stringify(receipt.owner) !== JSON.stringify(owner) ||
      receipt.ownerIdentity !== `${ownerIdentity.dev}:${ownerIdentity.ino}` || receipt.lockIdentity !== `${lockIdentity.dev}:${lockIdentity.ino}` ||
      !validRecord(historical, paths.root, owner.operationId) || historical.state === "retired-for-app-rebuild" ||
      JSON.stringify({ ...historical, state: record.state, retirement: record.retirement }) !== JSON.stringify(record) ||
      JSON.stringify(readJson<InstallRecord>(join(paths.operationsLock, RECORD_FILE))) !== JSON.stringify(record)) {
    fail("the installation retirement seal does not match its private receipt; preserve the owner");
  }
  const destination = completedPath(paths, owner.operationId);
  if (lstatOrNull(destination) !== null) fail("the retained installation history already exists; preserve both entries");
  // Moving the whole validated lock retains every archive and atomically releases its name.
  renameSync(paths.operationsLock, destination);
}

export function installCandidate(root: string, candidatePath: string, repair?: InstallRepairOptions, approvedBefore?: ReturnType<typeof preflight>): void {
  const absoluteRoot = safeRoot(root);
  const paths = resolvePaths({ TONEDIAL_HOME: absoluteRoot });
  const candidate = validateCandidate(candidatePath);
  // Recovery is selected from the durable lock, not from the caller's new candidate digest. A
  // safe rollback can finish before installing a different, freshly validated release.
  recoverInterrupted(paths);
  const { lock, owner } = acquireLock(paths);
  try {
    const observed = preflight(paths, repair);
    if (approvedBefore && (!snapshotsEqual(observed.lib, approvedBefore.lib) || !snapshotsEqual(observed.bin, approvedBefore.bin) ||
        !snapshotsEqual(observed.command, approvedBefore.command) || JSON.stringify(observed.legacy) !== JSON.stringify(approvedBefore.legacy))) {
      fail("the package components changed after the repair preview; preserve them and inspect a fresh preview");
    }
    const { legacy, ...before } = observed;
    runTransaction(paths, candidatePath, candidate, lock, owner, before, repair ? { legacy, binAfterArchive: null } : undefined);
  } catch (cause) {
    // A preflight failure happened before the record/target writes. Remove only this lock's
    // known owner file, then the empty directory; a partially recorded operation stays for
    // recovery instead.
    const record = readJson<InstallRecord>(join(lock, RECORD_FILE));
    if (record === null && operationOwnerMatches(lock, owner)) {
      unlinkSync(join(lock, OWNER_FILE));
      rmdirSync(lock);
    }
    throw cause;
  }
}

type InstallArguments = {
  root: string;
  candidate: string;
  repair: boolean;
  replaceCurrent: boolean;
  recovery: string[];
  archiveCurrent: ArchiveComponent[];
  auto: boolean;
  dryRun: boolean;
  json: boolean;
};

/** No user-supplied command, path selector or arbitrary argument reaches the fresh CLI. */
function parseInternalArgs(argv: string[]): InstallArguments {
  if (argv.length < 4 || argv[0] !== "--root" || argv[2] !== "--candidate" || !argv[1] || !argv[3]) {
    fail("install entry requires --root ROOT --candidate DIRECTORY and optional --repair recovery flags");
  }
  const result: InstallArguments = { root: argv[1]!, candidate: argv[3]!, repair: false, replaceCurrent: false, recovery: [], archiveCurrent: [], auto: false, dryRun: false, json: false };
  const seen = new Set<string>();
  const booleanFlags = new Set(["--repair", "--replace-current", "--global", "--here", "--auto", "--dry-run", "--json"]);
  const valueFlags = new Set(["--project", "--tools", "--from-operation", "--from-preset", "--restore-preset", "--rollback", "--archive-current"]);
  for (let index = 4; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (seen.has(flag) || (!booleanFlags.has(flag) && !valueFlags.has(flag))) fail("invalid or repeated installer recovery flag");
    seen.add(flag);
    if (flag === "--repair") { result.repair = true; continue; }
    if (flag === "--replace-current") { result.replaceCurrent = true; continue; }
    if (flag === "--auto") result.auto = true;
    if (flag === "--dry-run") result.dryRun = true;
    if (flag === "--json") result.json = true;
    if (booleanFlags.has(flag)) { result.recovery.push(flag); continue; }
    const value = argv[++index];
    if (!value || value.startsWith("-") || /[\u0000-\u001f\u007f]/.test(value)) fail(`${flag} requires one valid value`);
    if (flag === "--archive-current") {
      const components = value.split(",");
      if (new Set(components).size !== components.length || components.some((component) => !["lib", "command", "legacy-bin"].includes(component))) {
        fail("--archive-current accepts only lib,command,legacy-bin component names");
      }
      result.archiveCurrent = components as ArchiveComponent[];
      continue;
    }
    if ((flag === "--from-operation" || flag === "--rollback") && !/^[0-9a-f]{32}$/.test(value)) fail(`${flag} requires an operation ID`);
    if ((flag === "--from-preset" || flag === "--restore-preset") && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail(`${flag} requires a preset slug`);
    if (flag === "--tools" && value !== "none") {
      const tools = value.split(",");
      if (new Set(tools).size !== tools.length || tools.some((tool) => !(AGENT_TOOLS as readonly string[]).includes(tool))) fail("--tools requires none or a comma-separated list of supported tools");
    }
    result.recovery.push(flag, value);
  }
  if (!result.repair && seen.size && !(result.replaceCurrent && seen.size === 1)) fail("recovery flags require --repair");
  if (result.repair && result.replaceCurrent) fail("conflicting installer modes");
  const scopeCount = ["--global", "--here", "--project"].filter((flag) => seen.has(flag)).length;
  if (scopeCount > 1 ||
      (seen.has("--rollback") && ["--from-operation", "--from-preset", "--restore-preset", "--tools"].some((flag) => seen.has(flag)))) fail("conflicting installer recovery flags");
  if (seen.has("--restore-preset") && !seen.has("--from-operation")) fail("--restore-preset requires --from-operation ID");
  if (result.auto && !result.dryRun && !seen.has("--rollback") && (scopeCount !== 1 || !seen.has("--tools"))) {
    fail("unattended repair requires an explicit scope and --tools LIST or --tools none");
  }
  return result;
}

async function dispatchDoctor(entry: string, args: InstallArguments): Promise<{ status: number; result: unknown }> {
  const child = spawn(process.execPath, [entry, "doctor", "--fix", ...args.recovery], {
    env: { ...process.env, TONEDIAL_HOME: resolve(args.root) },
    stdio: args.json ? ["ignore", "pipe", "pipe"] : "inherit",
    // A person reading the preview is not subject to the download's I/O timeout.
  });
  let output = "";
  let failed = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(output) + chunk.length > 4 * 1024 * 1024) { failed = true; child.kill("SIGTERM"); }
    else output += chunk.toString("utf8");
  });
  child.stderr?.resume();
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const status = await new Promise<number>((done) => {
      child.once("error", () => { failed = true; });
      child.once("close", (code, signal) => done(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
    });
    let result: unknown = null;
    if (args.json && output) {
      try { result = JSON.parse(output); } catch { result = { ok: false, error: "fresh recovery returned an invalid response" }; }
    }
    if (failed) result = { ok: false, error: "fresh recovery could not complete" };
    return { status: failed ? 1 : status, result };
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

async function runInstaller(args: InstallArguments): Promise<void> {
  if (!args.repair) {
    installCandidate(args.root, args.candidate, args.replaceCurrent ? { archiveCurrent: [] } : undefined);
    const paths = resolvePaths({ TONEDIAL_HOME: resolve(args.root) });
    process.stdout.write(`Installed tonedial into ${paths.root}\nRun "${shellQuote(paths.command)}" init to create project or agent wiring.\n`);
    return;
  }
  const root = safeRoot(args.root, false);
  const paths = resolvePaths({ TONEDIAL_HOME: root });
  const candidate = validateCandidate(args.candidate);
  const repair = { archiveCurrent: args.archiveCurrent };
  const planned = preflight(paths, repair);
  const packagePlan = {
    version: candidate.version,
    components: ["lib", "command", ...Object.keys(planned.legacy).map((name) => `legacy-bin/${name}`)],
    archivesRetained: true,
  };
  if (!args.json) process.stdout.write(`Package repair: ${packagePlan.components.join(", ")}\nExisting components will be archived privately; saved state and other bin entries stay in place.\n`);
  if (!args.dryRun && !args.auto && (!interactive() || args.json)) {
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, packageRepair: { status: "approval-required", ...packagePlan }, stateRepair: { status: "not-started" } })}\n`);
    else process.stdout.write("Package repair requires a terminal for approval or --auto with explicit scope and tools. No files were changed.\n");
    process.exitCode = 1;
    return;
  }
  if (!args.dryRun && !args.auto && await confirm("Archive these components and install the verified release?") !== "yes") {
    process.stdout.write("Package repair declined. No files were changed.\n");
    return;
  }
  const freshEntry = join(args.candidate, "dist", "bin.js");
  let beforeRecovery: Awaited<ReturnType<typeof dispatchDoctor>> | null = null;
  if (args.dryRun || args.recovery.includes("--rollback") || lstatOrNull(paths.operationsLock) !== null) {
    // A pending app operation must be resolved by the working fresh release before installation
    // contends for that same lock. Staging stays alive throughout this dispatch.
    if (!args.dryRun && lstatOrNull(paths.operationsLock) !== null) {
      const owner = readJson<Owner>(join(paths.operationsLock, OWNER_FILE));
      if (owner?.kind === "install") {
        if (!validOwner(owner, "install")) fail("the interrupted installation has no valid owner; preserve it for inspection");
        const record = readJson<InstallRecord>(join(paths.operationsLock, RECORD_FILE));
        if (!validRecord(record, root, owner.operationId)) fail("the interrupted installation has no valid record; preserve it for inspection");
        retireInterruptedInstall(paths, owner, record);
      }
    }
    beforeRecovery = await dispatchDoctor(freshEntry, args);
    if (args.dryRun || beforeRecovery.status !== 0) {
      if (args.json) process.stdout.write(`${JSON.stringify({ ok: beforeRecovery.status === 0, packageRepair: { status: args.dryRun ? "dry-run" : "not-started", ...packagePlan }, stateRepair: beforeRecovery })}\n`);
      process.exitCode = beforeRecovery.status;
      return;
    }
  }
  installCandidate(root, args.candidate, repair, planned);
  if (!args.json) process.stdout.write(`Package repaired: tonedial ${candidate.version}. Application recovery follows.\n`);
  // After resolving a pending operation, inspect the now-installed release with current data.
  // Replaying the historical source or rollback selector would request another restoration.
  const afterArgs = beforeRecovery ? { ...args, recovery: args.recovery.filter((flag, index, flags) =>
    !["--from-operation", "--from-preset", "--restore-preset", "--rollback"].includes(flag) &&
    !(index > 0 && ["--from-operation", "--from-preset", "--restore-preset", "--rollback"].includes(flags[index - 1]!))) } : args;
  const stateRepair = args.recovery.includes("--rollback") && beforeRecovery
    ? beforeRecovery
    : await dispatchDoctor(join(paths.lib, "dist", "bin.js"), afterArgs);
  if (args.json) process.stdout.write(`${JSON.stringify({ ok: stateRepair.status === 0, packageRepair: { status: "complete", ...packagePlan }, priorRecovery: beforeRecovery, stateRepair })}\n`);
  process.exitCode = stateRepair.status;
}

function isMainEntry(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    // A temporary-directory alias can be a symlink on macOS. Compare canonical files so the
    // packed installer still runs when invoked through that alias (or another linked ancestor).
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  let parsed: InstallArguments | null = null;
  Promise.resolve().then(() => {
    parsed = parseInternalArgs(process.argv.slice(2));
    return runInstaller(parsed);
  }).catch((cause: unknown) => {
    if (parsed?.json || (parsed === null && process.argv.includes("--json"))) process.stdout.write(`${JSON.stringify({ ok: false, packageRepair: { status: "failed" }, stateRepair: { status: "not-started" }, error: cause instanceof InstallFailure ? cause.message : "installation failed; preserved evidence requires inspection" })}\n`);
    else process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
