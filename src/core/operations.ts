// The one owner for mutations rooted at a tonedial state directory.
//
// The installer was the first operation to need an exclusive lock, so its lock directory and
// recovery lease predate this module.  Keep the on-disk names stable and put the ownership rules
// here instead of growing a second lock for wiring.  Domain code owns the actions; this module
// owns who may start, checkpoint, recover, and release an operation.

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const OPERATION_SCHEMA = 1 as const;
export const OPERATION_OWNER_FILE = "owner.json" as const;
export const OPERATION_RECOVERY_DIR = "recovery" as const;
export const OPERATION_LEASE_FILE = "lease.json" as const;

export type OperationPaths = {
  root: string;
  operations: string;
  operationsLock: string;
};

export type OperationKind = "install" | "mutation";
export type OperationState = "pending" | "complete" | "rolled-back" | "retired-for-app-rebuild";
export type RecoveryPhase = "prepare" | "write" | "verify" | "finalize";
export type MutationOwnerPhase = "preparing" | "journaled";

/** A completed journal is restorable only when the caller explicitly labels it as a migration. */
export type OperationRetention = {
  kind: "migration";
  reason: "delivery" | "schema" | "case" | "app-rebuild";
};

export type OperationOwner<K extends OperationKind = OperationKind> = {
  schema: typeof OPERATION_SCHEMA;
  kind: K;
  operationId: string;
  nonce: string;
  pid: number;
  startedAt: string;
  /** Only mutation owners carry this lifecycle marker; install owners keep their old shape. */
  phase?: MutationOwnerPhase;
};

export type OperationLease = {
  schema: typeof OPERATION_SCHEMA;
  operationId: string;
  nonce: string;
  pid: number;
  startedAt: string;
};

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A serializable action descriptor. The executor for each kind remains in its domain module. */
export type OperationAction = {
  id: string;
  kind: string;
  path: string;
  realPath: string;
  before: JsonValue;
  after: JsonValue;
  metadata?: JsonValue;
};

export type OperationJournal = {
  schema: typeof OPERATION_SCHEMA;
  kind: "mutation";
  operationId: string;
  root: string;
  owner: OperationOwner<"mutation">;
  state: OperationState;
  createdAt: string;
  updatedAt: string;
  actions: OperationAction[];
  completed: number[];
  /** Omitted for ordinary setup/repair journals, which must not become implicit backups. */
  retention?: OperationRetention;
  /** A retirement is terminal history, not successful application or rollback. */
  retirement?: RetirementSeal;
};

export type RetirementSeal = { receipt: string; identity: string; digest: string };

export type RetirementReceipt = {
  schema: 1;
  kind: "app-rebuild-retirement";
  operationId: string;
  root: string;
  owner: OperationOwner;
  ownerIdentity: string;
  lockIdentity: string;
  createdAt: string;
  /** Domain-validated historical evidence and data; never new rollback authority. */
  evidence: JsonValue;
};

export type OperationHandle<K extends OperationKind = OperationKind> = {
  paths: OperationPaths;
  lock: string;
  owner: OperationOwner<K>;
};

export type RecoveryHandle = {
  operation: OperationHandle<"mutation">;
  lease: OperationLease;
};

export type OperationErrorCode =
  | "busy"
  | "invalid"
  | "not-found"
  | "needs-recovery"
  | "ownership-changed"
  | "journal-conflict";

export class OperationError extends Error {
  readonly code: OperationErrorCode;

  constructor(code: OperationErrorCode, message: string) {
    super(message);
    this.name = "OperationError";
    this.code = code;
  }
}

export type ProcessState = "live" | "dead" | "unknown";

export type OperationLockInspection = {
  path: string;
  state: "none" | ProcessState | "invalid";
  owner: OperationOwner | null;
  message?: string;
};

export type OperationJournalInspection = {
  path: string;
  operationId: string;
  state: OperationState | "invalid";
  journal: OperationJournal | null;
  message?: string;
};

export type OperationsInspection = {
  lock: OperationLockInspection;
  journals: OperationJournalInspection[];
};

export type RollbackOperation = (
  journal: OperationJournal,
  recovery: RecoveryHandle,
) => void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function validNonce(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function lstatOrNull(path: string): Stats | null {
  return lstatSync(path, { throwIfNoEntry: false }) ?? null;
}

function readJson<T>(path: string): T | null {
  let fd: number | undefined;
  try {
    const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!entry?.isFile()) return null;
    // Open the observed entry without following a substituted link or waiting on a FIFO.
    // The record is evidence for recovery, so equal bytes in a replacement are not enough.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino ||
        opened.mode !== entry.mode || opened.size !== entry.size ||
        opened.mtimeNs !== entry.mtimeNs || opened.ctimeNs !== entry.ctimeNs) return null;
    const contents = readFileSync(fd, "utf8");
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!named?.isFile() || named.dev !== opened.dev || named.ino !== opened.ino ||
        named.mode !== opened.mode || named.size !== opened.size ||
        named.mtimeNs !== opened.mtimeNs || named.ctimeNs !== opened.ctimeNs ||
        after.mode !== opened.mode || after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) return null;
    return JSON.parse(contents) as T;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${randomBytes(16).toString("hex")}`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    const parent = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch (cause) {
    try {
      unlinkSync(temporary);
    } catch {
      // Keep the original error. A leftover uniquely named temporary file is not an operation
      // target and cannot be followed by recovery.
    }
    throw cause;
  }
}

function ensureDirectory(path: string, label: string): void {
  const missing: string[] = [];
  let here = path;
  for (;;) {
    const stat = lstatOrNull(here);
    if (stat !== null) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new OperationError("invalid", `${path} is not a safe ${label} directory`);
      }
      break;
    }
    missing.unshift(here);
    const parent = dirname(here);
    if (parent === here) throw new OperationError("invalid", `${path} has no safe existing parent`);
    here = parent;
  }
  for (const entry of missing) {
    try {
      mkdirSync(entry, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    const stat = lstatOrNull(entry);
    if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new OperationError("invalid", `${entry} is not a safe ${label} directory`);
    }
  }
}

function ensureOperationsDirectory(paths: OperationPaths): void {
  if (!isAbsolute(paths.root) || !isAbsolute(paths.operations) || !isAbsolute(paths.operationsLock)) {
    throw new OperationError("invalid", "operation paths must be absolute");
  }
  // Create missing roots one component at a time so a pre-existing symlink cannot redirect the
  // owner, its journal, or the lock into a different physical state directory.
  ensureDirectory(paths.root, "state root");
  ensureDirectory(paths.operations, "operations");
}

export function validOwner(value: unknown, expectedKind?: OperationKind): value is OperationOwner {
  if (!isPlainObject(value)) return false;
  const hasPhase = Object.hasOwn(value, "phase");
  const keys = hasPhase
    ? ["kind", "nonce", "operationId", "phase", "pid", "schema", "startedAt"]
    : ["kind", "nonce", "operationId", "pid", "schema", "startedAt"];
  if (!hasExactKeys(value, keys)) {
    return false;
  }
  if (hasPhase && (value.kind !== "mutation" || (value.phase !== "preparing" && value.phase !== "journaled"))) {
    return false;
  }
  return value.schema === OPERATION_SCHEMA &&
    (value.kind === "install" || value.kind === "mutation") &&
    (expectedKind === undefined || value.kind === expectedKind) &&
    validOperationId(value.operationId) &&
    validNonce(value.nonce) &&
    typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 &&
    typeof value.startedAt === "string";
}

export function validLease(value: unknown): value is OperationLease {
  return isPlainObject(value) &&
    hasExactKeys(value, ["nonce", "operationId", "pid", "schema", "startedAt"]) &&
    value.schema === OPERATION_SCHEMA &&
    validOperationId(value.operationId) &&
    validNonce(value.nonce) &&
    typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 &&
    typeof value.startedAt === "string";
}

function validRetention(value: unknown): value is OperationRetention {
  return isPlainObject(value) &&
    hasExactKeys(value, ["kind", "reason"]) &&
    value.kind === "migration" &&
    (value.reason === "delivery" || value.reason === "schema" || value.reason === "case" || value.reason === "app-rebuild");
}

function validJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return true;
  }
  if (Array.isArray(value)) return value.every((entry) => validJsonValue(entry));
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((entry) => validJsonValue(entry));
}

function validAction(value: unknown): value is OperationAction {
  if (!isPlainObject(value)) return false;
  const keys = Object.hasOwn(value, "metadata")
    ? ["after", "before", "id", "kind", "metadata", "path", "realPath"]
    : ["after", "before", "id", "kind", "path", "realPath"];
  return hasExactKeys(value, keys) &&
    typeof value.id === "string" && value.id !== "" &&
    typeof value.kind === "string" && value.kind !== "" &&
    typeof value.path === "string" && isAbsolute(value.path) &&
    typeof value.realPath === "string" && isAbsolute(value.realPath) &&
    validJsonValue(value.before) && validJsonValue(value.after) &&
    (!Object.hasOwn(value, "metadata") || validJsonValue(value.metadata));
}

function validJournal(value: unknown, paths: OperationPaths, operationId: string): value is OperationJournal {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "actions", "completed", "createdAt", "kind", "operationId", "owner", "root", "schema", "state", "updatedAt",
    ...(Object.hasOwn(value, "retention") ? ["retention"] : []),
    ...(Object.hasOwn(value, "retirement") ? ["retirement"] : []),
  ])) return false;
  if (value.schema !== OPERATION_SCHEMA || value.kind !== "mutation" || value.root !== paths.root ||
      value.operationId !== operationId || !validOperationId(value.operationId) ||
      (value.state !== "pending" && value.state !== "complete" && value.state !== "rolled-back" && value.state !== "retired-for-app-rebuild") ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" ||
      !validOwner(value.owner, "mutation") || value.owner.operationId !== operationId ||
      !Array.isArray(value.actions) || !value.actions.every((action) => validAction(action)) ||
      !Array.isArray(value.completed) || !value.completed.every((index) => Number.isInteger(index) && index >= 0 && index < (value.actions as unknown[]).length)) {
    return false;
  }
  if (Object.hasOwn(value, "retention") && !validRetention(value.retention)) return false;
  if (value.state === "retired-for-app-rebuild") {
    const receipt = readRetirementReceipt(paths, value.retirement as RetirementSeal);
    if (receipt === null) return false;
    const evidence = isPlainObject(receipt.evidence) ? receipt.evidence : null;
    const original = evidence?.journal;
    if (receipt.operationId !== operationId || receipt.owner.kind !== "mutation" ||
        !isPlainObject(original) || original.state !== "pending" || original.operationId !== operationId ||
        !validJournal(original, paths, operationId) ||
        JSON.stringify(original.actions) !== JSON.stringify(value.actions) ||
        JSON.stringify(original.completed) !== JSON.stringify(value.completed) ||
        JSON.stringify(original.owner) !== JSON.stringify(value.owner)) return false;
  } else if (Object.hasOwn(value, "retirement")) return false;
  const actions = value.actions as OperationAction[];
  if (new Set(actions.map((action) => action.id)).size !== actions.length) return false;
  const completed = value.completed as number[];
  return new Set(completed).size === completed.length && completed.every((index, position) => position === 0 || completed[position - 1]! < index);
}

function lockEntries(lock: string): Dirent[] | null {
  const stat = lstatOrNull(lock);
  if (stat === null) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new OperationError("invalid", `${lock} is not a safe operation lock`);
  }
  return (readdirSync(lock, { withFileTypes: true }) as Dirent[]).sort((a, b) => a.name.localeCompare(b.name));
}

function lockIsKnown(lock: string): boolean {
  const entries = lockEntries(lock);
  if (entries === null) return false;
  const allowed = new Set<string>([OPERATION_OWNER_FILE, OPERATION_RECOVERY_DIR]);
  return entries.every((entry) => allowed.has(entry.name));
}

function ownerFromLock<K extends OperationKind>(lock: string, expectedKind: K): OperationOwner<K> | null;
function ownerFromLock(lock: string): OperationOwner | null;
function ownerFromLock(lock: string, expectedKind?: OperationKind): OperationOwner | null {
  const stat = lstatOrNull(lock);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return null;
  const owner = readJson<OperationOwner>(join(lock, OPERATION_OWNER_FILE));
  return validOwner(owner, expectedKind) ? owner : null;
}

function operationJournalPath(paths: OperationPaths, operationId: string): string {
  if (!validOperationId(operationId)) throw new OperationError("invalid", "operation id is not valid");
  if (!isAbsolute(paths.operations)) throw new OperationError("invalid", "operation paths must be absolute");
  return join(paths.operations, `${operationId}.json`);
}

function existingOperationsDirectory(paths: OperationPaths): boolean {
  const stat = lstatOrNull(paths.operations);
  if (stat === null) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new OperationError("invalid", `${paths.operations} is not a safe operations directory`);
  }
  return true;
}

export function operationId(): string {
  return randomBytes(16).toString("hex");
}

export function processState(pid: number): ProcessState {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

export function operationOwnerMatches(lock: string, owner: OperationOwner): boolean {
  const current = ownerFromLock(lock);
  return current !== null && current.operationId === owner.operationId && current.nonce === owner.nonce && current.pid === owner.pid && current.kind === owner.kind && current.phase === owner.phase;
}

export function acquireOperation<K extends OperationKind>(
  paths: OperationPaths,
  kind: K,
  requestedOperationId?: string,
): OperationHandle<K> {
  ensureOperationsDirectory(paths);
  if (requestedOperationId !== undefined && !validOperationId(requestedOperationId)) {
    throw new OperationError("invalid", "operation id is not valid");
  }
  const owner: OperationOwner<K> = {
    schema: OPERATION_SCHEMA,
    kind,
    operationId: requestedOperationId ?? operationId(),
    nonce: operationId(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...(kind === "mutation" ? { phase: "preparing" as const } : {}),
  };
  try {
    mkdirSync(paths.operationsLock, { mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new OperationError("busy", `${paths.operationsLock} is busy or needs manual recovery`);
    }
    throw cause;
  }
  try {
    writeJson(join(paths.operationsLock, OPERATION_OWNER_FILE), owner);
  } catch (cause) {
    throw new OperationError("needs-recovery", `${paths.operationsLock} could not record its owner; leave it in place for manual recovery: ${(cause as Error).message}`);
  }
  return { paths, lock: paths.operationsLock, owner };
}

function sealMutationOwner(handle: OperationHandle<"mutation">): void {
  assertOperationOwner(handle);
  if (handle.owner.phase === "journaled") return;
  const owner: OperationOwner<"mutation"> = { ...handle.owner, phase: "journaled" };
  try {
    writeJson(join(handle.lock, OPERATION_OWNER_FILE), owner);
  } catch (cause) {
    throw new OperationError(
      "needs-recovery",
      `${handle.lock} could not seal its journal owner; preserve the pending journal for explicit recovery: ${(cause as Error).message}`,
    );
  }
  handle.owner = owner;
}

export function assertOperationOwner(handle: OperationHandle): void {
  if (!operationOwnerMatches(handle.lock, handle.owner)) {
    throw new OperationError("ownership-changed", `${handle.lock} ownership changed during the operation`);
  }
}

export function beginJournal(
  handle: OperationHandle<"mutation">,
  actions: readonly OperationAction[],
  retention?: OperationRetention,
): OperationJournal {
  assertOperationOwner(handle);
  ensureOperationsDirectory(handle.paths);
  if (retention !== undefined && !validRetention(retention)) {
    throw new OperationError("invalid", "the mutation journal has an invalid retention marker");
  }
  const now = new Date().toISOString();
  const journal: OperationJournal = {
    schema: OPERATION_SCHEMA,
    kind: "mutation",
    operationId: handle.owner.operationId,
    root: handle.paths.root,
    owner: handle.owner,
    state: "pending",
    createdAt: now,
    updatedAt: now,
    actions: actions.map((action) => ({ ...action })),
    completed: [],
    ...(retention === undefined ? {} : { retention }),
  };
  if (!journal.actions.every((action) => validAction(action))) {
    throw new OperationError("invalid", "the mutation journal contains an invalid action");
  }
  const path = operationJournalPath(handle.paths, handle.owner.operationId);
  if (lstatOrNull(path) !== null) throw new OperationError("journal-conflict", `${path} already exists`);
  writeJson(path, journal);
  // The journal is the first durable proof that recovery has a target set. Only after it exists
  // may the owner leave `preparing`; the caller cannot start a target action until this function
  // returns. If sealing fails, releaseOperation preserves the pending journal below.
  sealMutationOwner(handle);
  return journal;
}

export function readJournal(paths: OperationPaths, operationIdValue: string): OperationJournal | null {
  if (!existingOperationsDirectory(paths)) return null;
  const path = operationJournalPath(paths, operationIdValue);
  const journal = readJson<OperationJournal>(path);
  return validJournal(journal, paths, operationIdValue) ? journal : null;
}

export type RollbackSelectionStatus = "pending" | "retained" | "superseded" | "unretained" | "rolled-back" | "retired-for-app-rebuild";

export type RollbackSelection = {
  journal: OperationJournal;
  status: RollbackSelectionStatus;
  allowed: boolean;
  /** True when the selected journal is an in-memory, empty owner-only recovery record. */
  synthetic?: boolean;
  reason?: string;
};

function journalTime(journal: OperationJournal): number {
  const updated = Date.parse(journal.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(journal.createdAt);
  return Number.isFinite(created) ? created : 0;
}

function actionDestinations(journal: OperationJournal): Set<string> {
  const result = new Set<string>();
  for (const action of journal.actions) {
    result.add(resolve(action.path));
    result.add(resolve(action.realPath));
  }
  return result;
}

function isLaterJournal(candidate: OperationJournal, selected: OperationJournal): boolean {
  const candidateTime = journalTime(candidate);
  const selectedTime = journalTime(selected);
  return candidateTime > selectedTime || (candidateTime === selectedTime && candidate.operationId > selected.operationId);
}

function hasNewerRetainedDestination(paths: OperationPaths, selected: OperationJournal): boolean {
  if (!existingOperationsDirectory(paths)) return false;
  const selectedDestinations = actionDestinations(selected);
  for (const entry of (readdirSync(paths.operations, { withFileTypes: true }) as Dirent[]).sort((a, b) => a.name.localeCompare(b.name))) {
    const match = /^(?<id>[0-9a-f]{32})\.json$/.exec(entry.name);
    if (!match?.groups?.id || !entry.isFile() || entry.isSymbolicLink() || match.groups.id === selected.operationId) continue;
    const candidate = readJournal(paths, match.groups.id);
    if (candidate === null || candidate.state !== "complete" || candidate.retention === undefined) continue;
    if (!isLaterJournal(candidate, selected)) continue;
    const overlap = [...actionDestinations(candidate)].some((path) => selectedDestinations.has(path));
    if (overlap) return true;
  }
  return false;
}

function syntheticOwnerJournal(paths: OperationPaths, owner: OperationOwner<"mutation">): OperationJournal {
  const now = new Date().toISOString();
  return {
    schema: OPERATION_SCHEMA,
    kind: "mutation",
    operationId: owner.operationId,
    root: paths.root,
    owner: { ...owner },
    state: "pending",
    createdAt: now,
    updatedAt: now,
    actions: [],
    completed: [],
  };
}

/** Read-only selector used by doctor and the apply layer before any recovery lock is claimed. */
export function inspectRollback(paths: OperationPaths, operationIdValue: string): RollbackSelection {
  const journal = readJournal(paths, operationIdValue);
  if (journal === null) {
    const owner = ownerFromLock(paths.operationsLock, "mutation");
    const journalPath = operationJournalPath(paths, operationIdValue);
    if (owner?.operationId === operationIdValue && owner.phase === "preparing" && lstatOrNull(journalPath) === null) {
      return { journal: syntheticOwnerJournal(paths, owner), status: "pending", allowed: true, synthetic: true };
    }
    throw new OperationError("not-found", `mutation journal ${operationIdValue} was not found or is invalid`);
  }
  if (journal.state === "pending") {
    return { journal, status: "pending", allowed: true };
  }
  if (journal.state === "rolled-back") {
    return { journal, status: "rolled-back", allowed: false, reason: "operation is already rolled back" };
  }
  if (journal.state === "retired-for-app-rebuild") {
    return { journal, status: "retired-for-app-rebuild", allowed: false, reason: "operation was retired for app rebuild; its historical actions are not rollback authority" };
  }
  if (journal.retention === undefined) {
    return { journal, status: "unretained", allowed: false, reason: "completed operation is not a retained migration" };
  }
  if (hasNewerRetainedDestination(paths, journal)) {
    return { journal, status: "superseded", allowed: false, reason: "a newer retained migration covers one of its destinations" };
  }
  return { journal, status: "retained", allowed: true };
}

export function checkpointJournal(
  handle: OperationHandle<"mutation">,
  completed: readonly number[],
  actions?: readonly OperationAction[],
): OperationJournal {
  assertOperationOwner(handle);
  const path = operationJournalPath(handle.paths, handle.owner.operationId);
  const journal = readJournal(handle.paths, handle.owner.operationId);
  if (journal === null) throw new OperationError("invalid", `${path} is not a valid mutation journal`);
  if (journal.state === "retired-for-app-rebuild") throw new OperationError("invalid", "retired history cannot be checkpointed");
  if (!completed.every((index) => Number.isInteger(index) && index >= 0 && index < journal.actions.length)) {
    throw new OperationError("invalid", `${path} contains an invalid checkpoint`);
  }
  if (actions !== undefined &&
      (actions.length !== journal.actions.length || actions.some((action, index) => action.id !== journal.actions[index]!.id))) {
    throw new OperationError("invalid", `${path} changed its action set during the operation`);
  }
  const next: OperationJournal = {
    ...journal,
    actions: (actions ?? journal.actions).map((action) => ({ ...action })),
    completed: [...completed].sort((a, b) => a - b),
    updatedAt: new Date().toISOString(),
  };
  if (!next.actions.every((action) => validAction(action))) throw new OperationError("invalid", `${path} contains an invalid action`);
  writeJson(path, next);
  return next;
}

export function finishJournal(handle: OperationHandle<"mutation">, state: "complete" | "rolled-back"): OperationJournal {
  assertOperationOwner(handle);
  const path = operationJournalPath(handle.paths, handle.owner.operationId);
  const journal = readJournal(handle.paths, handle.owner.operationId);
  if (journal === null) throw new OperationError("invalid", `${path} is not a valid mutation journal`);
  if (journal.state === "retired-for-app-rebuild") throw new OperationError("invalid", "retired history cannot be completed or rolled back");
  if (state === "complete" && journal.completed.length !== journal.actions.length) {
    throw new OperationError("invalid", `${path} is incomplete and cannot be marked complete`);
  }
  const next: OperationJournal = { ...journal, state, updatedAt: new Date().toISOString() };
  writeJson(path, next);
  return next;
}

export function releaseOperation(handle: OperationHandle): void {
  assertOperationOwner(handle);
  if (handle.owner.kind === "mutation") {
    const journalPath = operationJournalPath(handle.paths, handle.owner.operationId);
    if (lstatOrNull(journalPath) !== null) {
      const journal = readJournal(handle.paths, handle.owner.operationId);
      if (journal === null || journal.state === "pending") {
        throw new OperationError("needs-recovery", `${journalPath} is incomplete; preserving the operation lock`);
      }
    } else if (handle.owner.phase !== "preparing") {
      // Only an owner that has never sealed a journal can be released without one. Once the
      // durable lifecycle reaches journaled, a missing journal is ambiguous and the lock must
      // survive for explicit recovery rather than being silently discarded.
      throw new OperationError("needs-recovery", `${journalPath} is missing; preserving the operation lock`);
    }
  }
  if (!lockIsKnown(handle.lock)) throw new OperationError("needs-recovery", `${handle.lock} contains unknown recovery files; preserving it`);
  const recovery = join(handle.lock, OPERATION_RECOVERY_DIR);
  const recoveryStat = lstatOrNull(recovery);
  if (recoveryStat !== null) {
    if (!recoveryStat.isDirectory() || recoveryStat.isSymbolicLink()) throw new OperationError("needs-recovery", `${recovery} is not safe; preserving it`);
    const lease = readJson<OperationLease>(join(recovery, OPERATION_LEASE_FILE));
    if (!validLease(lease) || lease.operationId !== handle.owner.operationId) {
      throw new OperationError("needs-recovery", `${recovery} has an invalid lease; preserving it`);
    }
    unlinkSync(join(recovery, OPERATION_LEASE_FILE));
    rmdirSync(recovery);
  }
  unlinkSync(join(handle.lock, OPERATION_OWNER_FILE));
  rmdirSync(handle.lock);
}

export function claimRecoveryLease(lock: string, owner: OperationOwner): OperationLease {
  // Install recovery keeps candidate/previous/record beside the owner, while mutation recovery
  // keeps only the owner. The caller validates its domain-specific entries before claiming; this
  // shared primitive only needs to prove the contested lock itself is a directory and that the
  // recovery name is not a symlink.
  if (lockEntries(lock) === null) throw new OperationError("not-found", `${lock} does not exist`);
  const recovery = join(lock, OPERATION_RECOVERY_DIR);
  const existing = lstatOrNull(recovery);
  if (existing !== null) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new OperationError("needs-recovery", `${recovery} is not safe; preserving it`);
    }
    const entries = readdirSync(recovery, { withFileTypes: true }) as Dirent[];
    if (entries.some((entry) => entry.name !== OPERATION_LEASE_FILE || entry.isSymbolicLink() || !entry.isFile())) {
      throw new OperationError("needs-recovery", `${recovery} contains unknown recovery files; preserving it`);
    }
    const oldLease = readJson<OperationLease>(join(recovery, OPERATION_LEASE_FILE));
    if (!validLease(oldLease) || oldLease.operationId !== owner.operationId) {
      throw new OperationError("needs-recovery", `${recovery} has an invalid lease; preserving it`);
    }
    const state = processState(oldLease.pid);
    if (state !== "dead") {
      throw new OperationError("needs-recovery", `${lock} recovery is already claimed; preserving it`);
    }
    // A dead reclaimer cannot release its lease. Remove only the validated lease and directory so
    // the next explicit recovery attempt can claim the same operation; live/ambiguous owners stay
    // untouched above.
    unlinkSync(join(recovery, OPERATION_LEASE_FILE));
    rmdirSync(recovery);
  }
  try {
    mkdirSync(recovery, { mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new OperationError("needs-recovery", `${lock} recovery is already claimed; preserving it`);
    throw cause;
  }
  const lease: OperationLease = {
    schema: OPERATION_SCHEMA,
    operationId: owner.operationId,
    nonce: operationId(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  try {
    writeJson(join(recovery, OPERATION_LEASE_FILE), lease);
  } catch (cause) {
    throw new OperationError("needs-recovery", `${lock} recovery lease could not be recorded; preserving it for manual recovery: ${(cause as Error).message}`);
  }
  return lease;
}

export function claimRecovery(paths: OperationPaths, operationIdValue: string): RecoveryHandle {
  if (!validOperationId(operationIdValue)) throw new OperationError("invalid", "operation id is not valid");
  const entries = lockEntries(paths.operationsLock);
  if (entries === null) throw new OperationError("not-found", `${paths.operationsLock} does not exist`);
  if (!lockIsKnown(paths.operationsLock)) {
    throw new OperationError("needs-recovery", `${paths.operationsLock} contains unknown recovery files; preserving it`);
  }
  const owner = ownerFromLock(paths.operationsLock, "mutation");
  if (owner === null || owner.operationId !== operationIdValue) {
    throw new OperationError("invalid", `${paths.operationsLock} has no matching mutation owner`);
  }
  if (processState(owner.pid) !== "dead") throw new OperationError("busy", `${paths.operationsLock} owner is live or ambiguous`);
  const lease = claimRecoveryLease(paths.operationsLock, owner);
  const operation: OperationHandle<"mutation"> = { paths, lock: paths.operationsLock, owner };
  const reread = ownerFromLock(paths.operationsLock, "mutation");
  if (reread === null || !operationOwnerMatches(paths.operationsLock, owner)) {
    throw new OperationError("ownership-changed", `${paths.operationsLock} ownership changed during recovery`);
  }
  if (processState(owner.pid) !== "dead") throw new OperationError("busy", `${paths.operationsLock} owner is live or ambiguous`);
  return { operation, lease };
}

function receiptIdentity(path: string): string | null {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return stat?.isFile() && !stat.isSymbolicLink() ? `${stat.dev}:${stat.ino}` : null;
}

/** Validate a private retirement seal without granting authority over any historical target. */
export function readRetirementReceipt(paths: OperationPaths, seal: RetirementSeal): RetirementReceipt | null {
  if (!isPlainObject(seal) || !hasExactKeys(seal, ["receipt", "identity", "digest"]) ||
      typeof seal.receipt !== "string" || typeof seal.identity !== "string" || !/^\d+:\d+$/.test(seal.identity) ||
      typeof seal.digest !== "string" || !/^[0-9a-f]{64}$/.test(seal.digest)) return null;
  if (!existingOperationsDirectory(paths) || dirname(seal.receipt) !== paths.operations ||
      !/^[0-9a-f]{32}\.retirement\.json$/.test(seal.receipt.slice(paths.operations.length + 1)) ||
      receiptIdentity(seal.receipt) !== seal.identity) return null;
  const receipt = readJson<RetirementReceipt>(seal.receipt);
  if (!isPlainObject(receipt) || !hasExactKeys(receipt, ["schema", "kind", "operationId", "root", "owner", "ownerIdentity", "lockIdentity", "createdAt", "evidence"]) ||
      receipt.schema !== 1 || receipt.kind !== "app-rebuild-retirement" || !validOperationId(receipt.operationId) ||
      seal.receipt !== join(paths.operations, `${receipt.operationId}.retirement.json`) || receipt.root !== paths.root ||
      !validOwner(receipt.owner) || receipt.owner.operationId !== receipt.operationId ||
      typeof receipt.ownerIdentity !== "string" || !/^\d+:\d+$/.test(receipt.ownerIdentity) ||
      typeof receipt.lockIdentity !== "string" || !/^\d+:\d+$/.test(receipt.lockIdentity) ||
      typeof receipt.createdAt !== "string" || !validJsonValue(receipt.evidence) ||
      createHash("sha256").update(JSON.stringify(receipt)).digest("hex") !== seal.digest ||
      receiptIdentity(seal.receipt) !== seal.identity) return null;
  const stat = lstatSync(seal.receipt, { bigint: true });
  return (stat.mode & 0o777n) === 0o600n ? receipt : null;
}

/** Domain owners supply validated evidence; this shared seam binds and preserves it privately. */
export function persistRetirementReceipt(paths: OperationPaths, owner: OperationOwner, evidence: JsonValue): RetirementSeal {
  if (!operationOwnerMatches(paths.operationsLock, owner) || processState(owner.pid) !== "dead") {
    throw new OperationError("busy", "retirement requires the exact proven-dead owner");
  }
  const lease = readJson<OperationLease>(join(paths.operationsLock, OPERATION_RECOVERY_DIR, OPERATION_LEASE_FILE));
  if (!validLease(lease) || lease.operationId !== owner.operationId || lease.pid !== process.pid) {
    throw new OperationError("ownership-changed", "retirement requires this process's recovery lease");
  }
  ensureOperationsDirectory(paths);
  const ownerIdentity = receiptIdentity(join(paths.operationsLock, OPERATION_OWNER_FILE));
  const lock = lstatSync(paths.operationsLock, { bigint: true });
  if (ownerIdentity === null || !lock.isDirectory() || lock.isSymbolicLink() || !validJsonValue(evidence)) {
    throw new OperationError("invalid", "retirement evidence is invalid");
  }
  const lockIdentity = `${lock.dev}:${lock.ino}`;
  const receiptPath = join(paths.operations, `${owner.operationId}.retirement.json`);
  let receipt: RetirementReceipt;
  if (lstatOrNull(receiptPath) === null) {
    receipt = { schema: 1, kind: "app-rebuild-retirement", operationId: owner.operationId, root: paths.root,
      owner: { ...owner }, ownerIdentity, lockIdentity, createdAt: new Date().toISOString(), evidence };
    writeJson(receiptPath, receipt);
  } else {
    const original = readJson<RetirementReceipt>(receiptPath);
    if (original === null || original.root !== paths.root || original.operationId !== owner.operationId ||
        JSON.stringify(original.owner) !== JSON.stringify(owner) || original.ownerIdentity !== ownerIdentity ||
        original.lockIdentity !== lockIdentity || JSON.stringify(original.evidence) !== JSON.stringify(evidence)) {
      throw new OperationError("ownership-changed", "the preparing retirement receipt does not match the selected evidence");
    }
    receipt = original;
  }
  const identity = receiptIdentity(receiptPath);
  const seal = { receipt: receiptPath, identity: identity ?? "", digest: createHash("sha256").update(JSON.stringify(receipt)).digest("hex") };
  if (readRetirementReceipt(paths, seal) === null || !operationOwnerMatches(paths.operationsLock, owner) ||
      receiptIdentity(join(paths.operationsLock, OPERATION_OWNER_FILE)) !== ownerIdentity ||
      `${lstatSync(paths.operationsLock, { bigint: true }).dev}:${lstatSync(paths.operationsLock, { bigint: true }).ino}` !== lockIdentity) {
    throw new OperationError("ownership-changed", "retirement evidence changed while preparing its receipt");
  }
  return seal;
}

/** Retire a dead pending mutation, retaining its actions as history rather than rollback proof. */
export function retireOperationForAppRebuild(
  paths: OperationPaths,
  operationIdValue: string,
  options: { snapshots?: JsonValue; assertFresh?: () => void } = {},
): { operationId: string; state: "retired-for-app-rebuild"; retirement: RetirementSeal } {
  const root = lstatSync(paths.root, { bigint: true, throwIfNoEntry: false });
  if (!root?.isDirectory() || root.isSymbolicLink()) throw new OperationError("invalid", "app retirement requires a real state root");
  const rootIdentity = `${root.dev}:${root.ino}`;
  const journalPath = operationJournalPath(paths, operationIdValue);
  const selectedIdentity = receiptIdentity(journalPath);
  const selectedOwnerIdentity = receiptIdentity(join(paths.operationsLock, OPERATION_OWNER_FILE));
  const selected = readJournal(paths, operationIdValue);
  if (selected === null || (selected.state !== "pending" && selected.state !== "retired-for-app-rebuild")) {
    throw new OperationError("invalid", "app rebuild retirement requires a valid pending operation or its valid terminal seal");
  }
  if (receiptIdentity(journalPath) !== selectedIdentity) throw new OperationError("ownership-changed", "selected journal changed during retirement selection");
  if (selected.state === "retired-for-app-rebuild" && lstatOrNull(paths.operationsLock) === null) {
    return { operationId: operationIdValue, state: selected.state, retirement: selected.retirement! };
  }
  if (selected.state === "retired-for-app-rebuild") {
    const receipt = readRetirementReceipt(paths, selected.retirement!);
    const lock = lstatSync(paths.operationsLock, { bigint: true, throwIfNoEntry: false });
    if (receipt === null || !lock?.isDirectory() || lock.isSymbolicLink() || `${lock.dev}:${lock.ino}` !== receipt.lockIdentity) {
      throw new OperationError("ownership-changed", "retired lock no longer matches its receipt");
    }
    const ownerPath = join(paths.operationsLock, OPERATION_OWNER_FILE);
    const names = readdirSync(paths.operationsLock).sort();
    // Release can stop after removing the owner. Only this receipt's exact empty directory
    // may finish that release; an ownerless foreign directory is never adopted.
    if (lstatOrNull(ownerPath) === null && names.length === 0) {
      rmdirSync(paths.operationsLock);
      return { operationId: operationIdValue, state: selected.state, retirement: selected.retirement! };
    }
    if (receiptIdentity(ownerPath) !== receipt.ownerIdentity || !operationOwnerMatches(paths.operationsLock, receipt.owner)) {
      throw new OperationError("ownership-changed", "retired owner no longer matches its receipt");
    }
    const recoveryDirectory = join(paths.operationsLock, OPERATION_RECOVERY_DIR);
    const recoveryEntry = lstatOrNull(recoveryDirectory);
    if (recoveryEntry?.isDirectory() && !recoveryEntry.isSymbolicLink() && readdirSync(recoveryDirectory).length === 0) {
      // A sealed terminal operation has no remaining target writes. This exact empty lease
      // directory can be cleared after interrupted release before claiming a fresh lease.
      rmdirSync(recoveryDirectory);
    }
  }
  const recovery = claimRecovery(paths, operationIdValue);
  const refreshed = readJournal(paths, operationIdValue);
  if (refreshed === null || JSON.stringify(refreshed) !== JSON.stringify(selected) ||
      receiptIdentity(journalPath) !== selectedIdentity ||
      receiptIdentity(join(paths.operationsLock, OPERATION_OWNER_FILE)) !== selectedOwnerIdentity ||
      refreshed.owner.operationId !== recovery.operation.owner.operationId || refreshed.owner.nonce !== recovery.operation.owner.nonce) {
    throw new OperationError("ownership-changed", "selected operation changed before retirement");
  }
  options.assertFresh?.();
  const currentRoot = lstatSync(paths.root, { bigint: true });
  if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || `${currentRoot.dev}:${currentRoot.ino}` !== rootIdentity) {
    throw new OperationError("ownership-changed", "state root changed during retirement");
  }
  let seal = refreshed.retirement;
  if (refreshed.state === "pending") {
    seal = persistRetirementReceipt(paths, recovery.operation.owner, { journal: refreshed as unknown as JsonValue, snapshots: options.snapshots ?? null });
    // Recheck the original action/completion history and owner after receipt publication.
    if (JSON.stringify(readJournal(paths, operationIdValue)) !== JSON.stringify(refreshed) || receiptIdentity(journalPath) !== selectedIdentity) {
      throw new OperationError("ownership-changed", "selected operation changed while recording its retirement receipt");
    }
    assertOperationOwner(recovery.operation);
    const next: OperationJournal = { ...refreshed, state: "retired-for-app-rebuild", retirement: seal, updatedAt: new Date().toISOString() };
    writeJson(operationJournalPath(paths, operationIdValue), next);
    if (readJournal(paths, operationIdValue)?.state !== "retired-for-app-rebuild") {
      throw new OperationError("invalid", "retirement seal could not be validated; preserve the operation lock");
    }
  } else {
    const receipt = readRetirementReceipt(paths, seal!);
    const lock = lstatSync(paths.operationsLock, { bigint: true });
    if (receipt === null || JSON.stringify(receipt.owner) !== JSON.stringify(recovery.operation.owner) ||
        receipt.ownerIdentity !== receiptIdentity(join(paths.operationsLock, OPERATION_OWNER_FILE)) ||
        receipt.lockIdentity !== `${lock.dev}:${lock.ino}`) {
      throw new OperationError("ownership-changed", "retired owner no longer matches its receipt");
    }
  }
  releaseOperation(recovery.operation);
  return { operationId: operationIdValue, state: "retired-for-app-rebuild", retirement: seal! };
}

export function rollbackOperation(paths: OperationPaths, operationIdValue: string, rollback: RollbackOperation): void {
  const selection = inspectRollback(paths, operationIdValue);
  if (!selection.allowed) throw new OperationError("invalid", selection.reason ?? `mutation journal ${operationIdValue} cannot be rolled back`);
  let journal = selection.journal;
  let recovery: RecoveryHandle;
  if (lstatOrNull(paths.operationsLock) !== null) {
    recovery = claimRecovery(paths, operationIdValue);
  } else if (journal.state === "complete") {
    // A retained migration has no active lock after its original commit. Reuse its journal id for
    // the fresh owner so an interruption leaves a recognizable lock that the same selector can
    // retry; the new nonce/pid still make owner-only release and stale-owner checks meaningful.
    const operation = acquireOperation(paths, "mutation", operationIdValue);
    const lease = claimRecoveryLease(operation.lock, operation.owner);
    recovery = { operation, lease };
  } else {
    throw new OperationError("not-found", `${paths.operationsLock} does not contain a recoverable owner for ${operationIdValue}`);
  }
  // Claiming recovery can race with an external writer, including for a retained migration's
  // newly acquired owner. Recheck before changing the journal or invoking resource rollback.
  if (!lockIsKnown(paths.operationsLock)) {
    throw new OperationError("needs-recovery", `${paths.operationsLock} contains unknown recovery files; preserving it`);
  }
  if (selection.synthetic) {
    // Re-check the exact owner and absence of the journal after claiming the lease. A journal
    // appearing in this window means the preparation proof no longer holds, so preserve it.
    assertOperationOwner(recovery.operation);
    if (recovery.operation.owner.phase !== "preparing" || lstatOrNull(operationJournalPath(paths, operationIdValue)) !== null) {
      throw new OperationError("ownership-changed", `${paths.operationsLock} owner-only recovery changed during selection`);
    }
    journal = beginJournal(recovery.operation, []);
  } else {
    // A pending journal can be observed while its original owner was between journal creation
    // and the lifecycle seal. Seal before the rollback callback can write any target.
    sealMutationOwner(recovery.operation);
    // The journal selected before claiming the recovery lease may have been replaced in the
    // claim window. Re-read it under the claimed owner and refuse to adopt a changed action set,
    // invalid journal, or superseded retained operation before invoking the target-writing
    // callback. The lease intentionally remains held on every rejection.
    assertOperationOwner(recovery.operation);
    const refreshed = inspectRollback(paths, operationIdValue);
    if (!refreshed.allowed) {
      throw new OperationError("invalid", refreshed.reason ?? `mutation journal ${operationIdValue} cannot be rolled back`);
    }
    if (
      refreshed.synthetic ||
      refreshed.status !== selection.status ||
      JSON.stringify(refreshed.journal) !== JSON.stringify(selection.journal)
    ) {
      throw new OperationError("ownership-changed", `${operationJournalPath(paths, operationIdValue)} changed during recovery`);
    }
    journal = refreshed.journal;
  }
  // Failure leaves the recovery lease held for explicit retry.
  rollback(journal, recovery);
  finishJournal(recovery.operation, "rolled-back");
  releaseOperation(recovery.operation);
}

function inspectLock(paths: OperationPaths): OperationLockInspection {
  const stat = lstatOrNull(paths.operationsLock);
  if (stat === null) return { path: paths.operationsLock, state: "none", owner: null };
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { path: paths.operationsLock, state: "invalid", owner: null, message: "operation lock is not a safe directory" };
  if (!lockIsKnown(paths.operationsLock)) return { path: paths.operationsLock, state: "invalid", owner: null, message: "operation lock contains unknown files" };
  const owner = ownerFromLock(paths.operationsLock);
  if (owner === null) return { path: paths.operationsLock, state: "invalid", owner: null, message: "operation lock has no valid owner" };
  return { path: paths.operationsLock, state: processState(owner.pid), owner };
}

function ownerOnlyInspection(paths: OperationPaths, lock: OperationLockInspection): OperationJournalInspection | null {
  if (lock.owner === null || lock.owner.kind !== "mutation") return null;
  const owner = ownerFromLock(paths.operationsLock, "mutation");
  if (owner === null) return null;
  const path = operationJournalPath(paths, owner.operationId);
  if (lstatOrNull(path) !== null) return null;
  if (owner.phase === "preparing") {
    return {
      path,
      operationId: owner.operationId,
      state: "pending",
      journal: syntheticOwnerJournal(paths, owner),
      message: "mutation owner was recorded before its journal; no target action could have started",
    };
  }
  return {
    path,
    operationId: owner.operationId,
    state: "invalid",
    journal: null,
    message: "mutation owner has no journal or preparation proof",
  };
}

export function inspectOperations(paths: OperationPaths): OperationsInspection {
  const lock = inspectLock(paths);
  const journals: OperationJournalInspection[] = [];
  const operations = lstatOrNull(paths.operations);
  if (operations === null) {
    const ownerOnly = ownerOnlyInspection(paths, lock);
    return ownerOnly === null ? { lock, journals } : { lock, journals: [ownerOnly] };
  }
  if (!operations.isDirectory() || operations.isSymbolicLink()) {
    return { lock: { path: paths.operationsLock, state: "invalid", owner: null, message: "operations directory is not safe" }, journals };
  }
  for (const entry of (readdirSync(paths.operations, { withFileTypes: true }) as Dirent[]).sort((a, b) => a.name.localeCompare(b.name))) {
    const match = /^(?<id>[0-9a-f]{32})\.json$/.exec(entry.name);
    if (!match?.groups?.id || !entry.isFile() || entry.isSymbolicLink()) continue;
    const id = match.groups.id;
    const journal = readJournal(paths, id);
    journals.push({
      path: join(paths.operations, entry.name),
      operationId: id,
      state: journal?.state ?? "invalid",
      journal,
      ...(journal === null ? { message: "mutation journal is invalid" } : {}),
    });
  }
  const ownerOnly = ownerOnlyInspection(paths, lock);
  if (ownerOnly !== null && !journals.some((entry) => entry.operationId === ownerOnly.operationId)) {
    journals.push(ownerOnly);
  }
  return { lock, journals };
}
