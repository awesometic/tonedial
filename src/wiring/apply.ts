// File planning, preview/approval, journaled publication and explicit rollback.

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  linkSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ConfigError } from "../core/config.ts";
import { inside } from "../core/paths.ts";
import type { Messages } from "../core/i18n.ts";
import {
  acquireOperation,
  beginJournal,
  checkpointJournal,
  finishJournal,
  inspectOperations,
  inspectRollback,
  OperationError,
  rollbackOperation,
  releaseOperation,
  type JsonValue,
  type OperationAction,
  type OperationHandle,
  type OperationJournal,
  type OperationPaths,
  type OperationRetention,
  type OperationState,
} from "../core/operations.ts";
import { confirm, interactive } from "../ui/prompt.ts";
import { palette as paletteFor, type Palette } from "../ui/style.ts";
import { humanText } from "../ui/format.ts";
import { probeSkillAction, rollbackSkillAction, validateSkillAction } from "./skill.ts";

export type Change = {
  /** Raw read-set evidence cannot be repurposed into a text write. */
  readOnlySnapshot?: true;
  /** Where this tool was asked to write. */
  path: string;
  /** Where the bytes actually land. Different when the target is a symlink. */
  realPath: string;
  /** `null` when the file does not exist yet. */
  before: string | null;
  /** `null` when the file should not exist afterwards. */
  after: string | null;
  /** True when this tool is about to create the file. Only such a file may be deleted again. */
  created: boolean;
  /** True when its directory does not exist either, and this tool is about to create that too. */
  createdDir: boolean;
  /**
   * A mode to enforce, for a file whose executability is part of what it is.
   *
   * **Part of the change rather than a step beside it.** The `tonedial` command was chmodded at
   * two call sites after their writes, and they came apart exactly as two copies of one fact do:
   * a shim whose contents were right but whose exec bit was gone is a no-op by content, so the
   * gate dropped it and `doctor --fix` reported that a person was needed for a state one `chmod`
   * would have fixed — while `init`, whose `chmod` ran unconditionally, repaired it.
   */
  mode?: number | undefined;
  /** The target state observed while preparing the diff, used to reject stale writes. */
  snapshot: TargetSnapshot;
  /** Optional physical containment root for tool-owned files. */
  within: string | null;
  /** Identity of the containment root when it existed at planning time. */
  withinIdentity: string | null;
  /** Canonical spelling of the containment root at planning time. */
  withinCanonical: string | null;
};

type TargetSnapshot = {
  /** Whether the target path existed, including a symlink whose target is missing. */
  exists: boolean;
  /** The path the write would resolve to, including the nearest real parent for a new file. */
  resolvedPath: string;
  /** The resolved target for an existing path, or null when the path did not exist. */
  realPath: string | null;
  /** Whether the target path itself was a symlink. */
  symbolicLink: boolean;
  /** The symlink's stored target, preserving identity beyond its resolved path. */
  linkTarget: string | null;
  /** The exact bytes observed, or null when the target did not exist. */
  bytes: Buffer | null;
  /** The original target mode, independent of the mode this change requests. */
  mode: number | null;
  /** Exact identities of the lexical entry and resolved file, not just equal contents. */
  pathIdentity: string | null;
  targetIdentity: string | null;
  /** Identity of the nearest resolved existing parent, required to make a create fresh. */
  parentIdentity: string | null;
  /** Lexical path at which `parentIdentity` was observed. */
  parentPath: string | null;
};

export const isNoop = (change: Change) =>
  change.before === change.after &&
  (change.mode === undefined || (change.snapshot.mode !== null && (change.snapshot.mode & change.mode) === change.mode));

/**
 * Read as text, or refuse.
 *
 * `readFileSync(path, "utf8")` replaces every invalid sequence with U+FFFD, and the whole
 * decoded string is what gets written back — so a Latin-1 `é` became three different bytes and
 * `eject` could not restore it. Worse, it is **invisible in the diff**: both sides carry the
 * same replacement character, so the common-prefix trim drops those lines entirely and
 * approving the diff cannot protect against it.
 */
function decode(raw: Buffer, t: Messages): string {
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) throw new ConfigError(t.errors.notUtf8);
  return text;
}

/**
 * Read a target and pair it with what it should become.
 *
 * **A symlinked target is resolved and reported, never refused.** A global `CLAUDE.md` is
 * commonly a link into a dotfiles repository, so writing through it edits that repository — a
 * second file the user did not hand over, in a directory version control is watching. Refusing
 * would break exactly the users who care most about their configuration; naming the real path
 * in the diff makes it visible before approval instead of afterwards in `git status`.
 */
/**
 * The path a write to `path` would actually take, for a file that does not exist yet: its
 * nearest existing ancestor resolved, with the rest of the path put back on.
 */
function nearestParent(path: string): { path: string; resolvedPath: string; identity: string } {
  let here = dirname(path);
  const tail = [basename(path)];
  for (;;) {
    const stat = lstatSync(here, { bigint: true, throwIfNoEntry: false });
    if (stat !== undefined) {
      const resolved = realpathSync(here);
      const realStat = statSync(resolved, { bigint: true });
      if (!realStat.isDirectory()) throw new Error("nearest existing parent is not a directory");
      return { path: here, resolvedPath: join(resolved, ...tail), identity: `${realStat.dev}:${realStat.ino}` };
    }
    const up = dirname(here);
    if (up === here) throw new Error("no existing parent");
    tail.unshift(basename(here));
    here = up;
  }
}

/** Capture target identity and metadata without reading its contents. */
function targetSnapshot(path: string, t: Messages): TargetSnapshot {
  let pathStat: BigIntStats | undefined;
  try {
    pathStat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  } catch (cause) {
    throw new ConfigError(t.errors.unreadableTarget(path, (cause as Error).message));
  }

  if (pathStat === undefined) {
    let parent: { path: string; resolvedPath: string; identity: string };
    try {
      parent = nearestParent(path);
    } catch (cause) {
      throw new ConfigError(t.errors.unreadableTarget(path, (cause as Error).message));
    }
    return {
      exists: false,
      resolvedPath: parent.resolvedPath,
      realPath: null,
      symbolicLink: false,
      linkTarget: null,
      bytes: null,
      mode: null,
      pathIdentity: null,
      targetIdentity: null,
      parentIdentity: parent.identity,
      parentPath: parent.path,
    };
  }

  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch (cause) {
    throw new ConfigError(t.errors.unreadableTarget(path, (cause as Error).message));
  }

  let realStat: BigIntStats;
  try {
    realStat = statSync(realPath, { bigint: true });
  } catch (cause) {
    throw new ConfigError(t.errors.unreadableTarget(path, (cause as Error).message));
  }
  if (!realStat.isFile()) throw new ConfigError(t.errors.unreadableTarget(path, "not a regular file"));

  let linkTarget: string | null = null;
  if (pathStat.isSymbolicLink()) {
    try {
      linkTarget = readlinkSync(path);
    } catch (cause) {
      throw new ConfigError(t.errors.unreadableTarget(path, (cause as Error).message));
    }
  }

  return {
    exists: true,
    resolvedPath: realPath,
    realPath,
    symbolicLink: pathStat.isSymbolicLink(),
    linkTarget,
    bytes: null,
    mode: Number(realStat.mode & 0o7777n),
    pathIdentity: `${pathStat.dev}:${pathStat.ino}`,
    targetIdentity: `${realStat.dev}:${realStat.ino}`,
    parentIdentity: null,
    parentPath: null,
  };
}

/** Read bytes only after the resolved destination has passed its containment check. */
function targetBytes(path: string, expected: TargetSnapshot, t: Messages): Buffer {
  let fd: number | undefined;
  try {
    // Open the already-checked physical file, then verify its identity before reading bytes.
    // Nonblocking open also lets a FIFO replacement be rejected instead of hanging setup.
    fd = openSync(expected.resolvedPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || `${before.dev}:${before.ino}` !== expected.targetIdentity ||
      Number(before.mode & 0o7777n) !== expected.mode) {
      throw new ConfigError(t.errors.staleTarget(path));
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const current = targetSnapshot(path, t);
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      current.pathIdentity !== expected.pathIdentity || current.targetIdentity !== expected.targetIdentity ||
      current.resolvedPath !== expected.resolvedPath || current.linkTarget !== expected.linkTarget) {
      throw new ConfigError(t.errors.staleTarget(path));
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(t.errors.unreadableTarget(path, (cause as Error).message));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Read one already-known ancestor without replacing it with today's nearest parent. */
function parentIdentityAt(path: string): string | null {
  try {
    const lexical = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (lexical === undefined) return null;
    const resolved = realpathSync(path);
    const stat = statSync(resolved, { bigint: true });
    if (!stat.isDirectory()) return null;
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function canonicalPath(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat !== undefined) return realpathSync(path);
  return nearestParent(path).resolvedPath;
}

function containmentBoundary(path: string): string {
  try {
    return canonicalPath(path);
  } catch {
    return path;
  }
}

function containmentError(path: string, target: string, within: string, t: Messages): ConfigError {
  return new ConfigError(t.errors.escapesRoot(path, target, containmentBoundary(within)));
}

function canonicalInside(target: string, within: string): boolean {
  const stat = lstatSync(within, { throwIfNoEntry: false });
  if (stat !== undefined) return inside(target, within);
  const root = canonicalPath(within);
  const remainder = relative(root, target);
  return remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}

function assertWithinFresh(change: Change, t: Messages): void {
  if (change.within === null || change.withinCanonical === null) return;
  try {
    if (change.withinIdentity !== null) {
      if (parentIdentityAt(change.within) !== change.withinIdentity) {
        throw new ConfigError(t.errors.staleTarget(change.path));
      }
    } else if (canonicalPath(change.within) !== change.withinCanonical) {
      throw new ConfigError(t.errors.staleTarget(change.path));
    }
    if (!canonicalInside(change.realPath, change.within)) {
      throw new ConfigError(t.errors.staleTarget(change.path));
    }
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(t.errors.staleTarget(change.path));
  }
}

/** Revalidate a captured read or approved diff without applying a change. */
export function assertFresh(change: Change, t: Messages, paths?: OperationPaths): void {
  let current: TargetSnapshot;
  try {
    current = targetSnapshot(change.path, t);
  } catch {
    throw new ConfigError(t.errors.staleTarget(change.path));
  }
  assertWithinFresh(change, t);
  const planned = change.snapshot;
  // Acquiring the operation owner may create `<state>/operations` (and, on a first run, the
  // state root itself) after a missing target was previewed. Compare the captured ancestor at its
  // original lexical path instead of treating that owner-created directory as a user change.
  // Any other nearer parent that appeared after preview remains stale: it was not created by the
  // operation and could redirect a write into a directory nobody approved.
  let parentFresh = true;
  if (!planned.exists && planned.parentPath !== null && planned.parentIdentity !== null) {
    parentFresh = parentIdentityAt(planned.parentPath) === planned.parentIdentity;
    if (parentFresh && current.parentPath !== planned.parentPath) {
      const ownerCreated = paths !== undefined &&
        (current.parentPath === paths.root || current.parentPath === paths.operations);
      parentFresh = ownerCreated;
    }
  }
  if (
    current.exists !== planned.exists ||
    current.resolvedPath !== planned.resolvedPath ||
    current.realPath !== planned.realPath ||
    current.symbolicLink !== planned.symbolicLink ||
    current.linkTarget !== planned.linkTarget ||
    current.mode !== planned.mode ||
    current.pathIdentity !== planned.pathIdentity ||
    current.targetIdentity !== planned.targetIdentity ||
    current.parentIdentity !== planned.parentIdentity && current.parentPath === planned.parentPath
  ) {
    throw new ConfigError(t.errors.staleTarget(change.path));
  }
  if (!parentFresh) {
    throw new ConfigError(t.errors.staleTarget(change.path));
  }
  if (planned.bytes === null) return;
  let bytes: Buffer;
  try {
    bytes = targetBytes(change.path, current, t);
  } catch {
    throw new ConfigError(t.errors.staleTarget(change.path));
  }
  if (!planned.bytes.equals(bytes)) throw new ConfigError(t.errors.staleTarget(change.path));
}

export function planChange(
  path: string,
  transform: (before: string | null) => string | null,
  t: Messages,
  mode?: number,
  /** Physical containment for state-owned files, checked before their contents are read. */
  within?: string,
): Change {
  const metadata = targetSnapshot(path, t);
  const exists = metadata.exists;
  const realPath = metadata.resolvedPath;
  // Check the resolved destination, including a missing file's real parent, before reading.
  let withinIdentity: string | null = null;
  let withinCanonical: string | null = null;
  if (within !== undefined) {
    try {
      withinIdentity = parentIdentityAt(within);
      withinCanonical = canonicalPath(within);
      if (!canonicalInside(metadata.resolvedPath, within)) {
        throw containmentError(path, metadata.resolvedPath, within, t);
      }
    } catch (cause) {
      if (cause instanceof ConfigError) throw cause;
      throw containmentError(path, metadata.resolvedPath, within, t);
    }
  }
  // A path that exists is not a path that can be read. A directory, a device, or a file with no
  // read permission all threw out of here as a raw stack trace — and the caller most likely to
  // hit one is `doctor`, planning the repair for exactly that state.
  const snapshot = metadata.exists ? { ...metadata, bytes: targetBytes(path, metadata, t) } : metadata;
  const before = snapshot.bytes === null ? null : decode(snapshot.bytes, t);
  return {
    path,
    realPath,
    before,
    after: transform(before),
    created: !exists,
    // Recorded rather than inferred, for the same reason as the file: an empty directory the
    // user made and one this tool made look identical afterwards, and removing theirs is how a
    // tool that promises tracelessness leaves a hole instead.
    createdDir: !existsSync(dirname(path)),
    mode,
    snapshot,
    within: within ?? null,
    withinIdentity,
    withinCanonical,
  };
}

/**
 * The changed lines, with a little of what surrounds them.
 *
 * A general diff algorithm would be the wrong tool: every change this module makes is one
 * contiguous region appearing, changing, or going away, so trimming the common prefix and
 * suffix describes it exactly and adds no dependency to a package that has none.
 */
function changedLines(change: Change): {
  before: string[];
  after: string[];
  head: number;
  tail: number;
  removed: string[];
  added: string[];
  finalNewline: "added" | "removed" | null;
} {
  const split = (text: string | null) => {
    if (text === null) return [];
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  };
  const before = split(change.before);
  const after = split(change.after);
  const finalNewline = change.before !== null && change.after !== null &&
    change.before.endsWith("\n") !== change.after.endsWith("\n")
    ? change.after.endsWith("\n") ? "added" : "removed"
    : null;
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    before,
    after,
    head,
    tail,
    removed: before.slice(head, before.length - tail),
    added: after.slice(head, after.length - tail),
    finalNewline,
  };
}

function renderDiff(change: Change, ui: Palette, t: Messages, context = 2, audience: "machine" | "human" = "machine"): string[] {
  // A trailing newline shows up as an empty final element in both arrays. Rendering it as a
  // changed line puts a bare `+` at the end of every diff, describing a line that is not there.
  const { before, after, head, tail } = changedLines(change);
  const display = audience === "human" ? humanText : (value: string) => value;

  const lines: string[] = [];
  lines.push(`  ${ui.bold(display(change.path))}`);
  // Keep both paths copyable without composing two long paths into one wide heading.
  if (change.realPath !== change.path) lines.push(`  ${ui.warn(`→ ${display(change.realPath)}`)}`);
  // Keep the structured new-file representation stable: path and size. Human previews select
  // representative additions or the complete body outside this function.
  if (change.before === null) {
    lines.push(`  ${t.wiring.newFile}  ${ui.dim(t.wiring.newFileLines(after.length))}`);
    return lines;
  }
  if (change.after === null) lines.push(`  ${ui.warn(t.wiring.removedFile)}`);

  const from = Math.max(0, head - context);
  for (let i = from; i < head; i++) lines.push(`  ${ui.dim(`  ${display(before[i]!)}`)}`);
  for (let i = head; i < before.length - tail; i++) lines.push(`  ${ui.error(`- ${display(before[i]!)}`)}`);
  for (let i = head; i < after.length - tail; i++) lines.push(`  ${ui.accent(`+ ${display(after[i]!)}`)}`);
  const context_end = Math.min(before.length, before.length - tail + context);
  for (let i = before.length - tail; i < context_end; i++) lines.push(`  ${ui.dim(`  ${display(before[i]!)}`)}`);

  return lines;
}

/** A bounded approval summary that still shows representative changed lines. */
function renderSummary(change: Change, ui: Palette, t: Messages): string[] {
  const { before, after, removed, added, finalNewline } = changedLines(change);
  const lines = [`  ${ui.bold(humanText(change.path))}`];
  if (change.realPath !== change.path) lines.push(`  ${ui.warn(`→ ${humanText(change.realPath)}`)}`);

  if (change.before === null) {
    lines.push(`  ${t.wiring.newFile}  ${ui.dim(t.wiring.newFileLines(after.length))}`);
  } else if (change.after === null) {
    lines.push(`  ${ui.warn(t.wiring.removedFile)}  ${ui.dim(t.wiring.newFileLines(before.length))}`);
  } else if (removed.length === 0 && added.length === 0) {
    const detail = finalNewline === "added"
      ? t.wiring.finalNewlineAdded
      : finalNewline === "removed" ? t.wiring.finalNewlineRemoved : t.wiring.modeChanged;
    lines.push(`  ${detail}`);
    return lines;
  } else {
    lines.push(`  ${t.wiring.modifiedFile}  ${ui.accent(`+${added.length}`)} ${ui.error(`-${removed.length}`)}`);
  }

  let representativeAdded = added;
  if (change.before === null) {
    const nonBlankAdded = added.filter((line) => line.trim() !== "");
    const substantiveAdded = nonBlankAdded.filter((line) => {
      const value = line.trim();
      return !/^[{}\[\],]+$/.test(value) &&
        !/^<!--.*-->$/.test(value) &&
        !/^#{1,6}\s/.test(value);
    });
    representativeAdded = substantiveAdded.length > 0 ? substantiveAdded : nonBlankAdded;
  }
  const limit = change.before === null ? 2 : 4;
  const removedCount = Math.min(removed.length, limit - Math.min(representativeAdded.length, 2));
  const addedCount = Math.min(representativeAdded.length, limit - removedCount);
  for (const line of removed.slice(0, removedCount)) lines.push(`  ${ui.error(`- ${humanText(line)}`)}`);
  for (const line of representativeAdded.slice(0, addedCount)) lines.push(`  ${ui.accent(`+ ${humanText(line)}`)}`);
  return lines;
}

/** Complete human diff, including created-file bodies and final-newline changes. */
function renderVerboseDiff(change: Change, ui: Palette, t: Messages): string[] {
  const lines = renderDiff(change, ui, t, 2, "human");
  if (change.before !== null && change.after !== null && change.before === change.after) {
    lines.push(`  ${ui.dim(t.wiring.modeChanged)}`);
    return lines;
  }
  if (change.before !== null && change.after !== null) {
    const { finalNewline } = changedLines(change);
    if (finalNewline !== null) {
      lines.push(`  ${ui.dim(finalNewline === "added" ? t.wiring.finalNewlineAdded : t.wiring.finalNewlineRemoved)}`);
    }
  }
  if (change.before !== null || change.after === null) return lines;
  const { after } = changedLines(change);
  lines.push(...after.map((line) => `  ${ui.accent(`+ ${humanText(line)}`)}`));
  return lines;
}

function removeFile(change: Change): void {
  // Remove the lexical symlink entry, preserving its user-owned referent.
  rmSync(change.snapshot.symbolicLink ? change.path : change.realPath, { force: true });
  if (change.createdDir) {
    try {
      const dir = dirname(change.path);
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // A directory that will not go is not a failed removal.
    }
  }
}

export type PlannedOperationAction = {
  /** The durable descriptor written before the first action is applied. */
  action: OperationAction;
  /** Apply the concrete side effect represented by `action`. */
  apply: () => void;
  /** Persist prepared entry identities before publishing anything at the approved target. */
  prepare?: (checkpoint: (action: OperationAction) => void, createdParents?: Map<string, string>) => void;
  /** Re-check an external resource under the operation lock before any action is applied. */
  assertFresh?: () => void;
  /** Return the descriptor with its actual after-state after `apply` succeeds. */
  after?: () => OperationAction;
};

export type RawEntryCapture = {
  path: string;
  type: "missing" | "regular" | "symlink" | "directory";
  bytes: Buffer | null;
  mode: number | null;
  identity: string | null;
  linkTarget: string | null;
  boundary: string;
  boundaryCanonical: string;
  boundaryIdentity: string;
  parents: { path: string; identity: string | null }[];
};

/** Capture a bounded lexical entry. A link's referent is never inspected. */
export function captureRawEntry(
  path: string,
  t: Messages,
  options: { within: string; maxBytes?: number; allowLink?: boolean; allowDirectory?: boolean },
): RawEntryCapture {
  const boundary = resolve(options.within);
  const target = resolve(path);
  if (target !== path || boundary !== options.within || !lexicallyInside(target, boundary)) {
    throw new ConfigError(t.errors.staleTarget(path));
  }
  const root = lstatSync(boundary, { bigint: true, throwIfNoEntry: false });
  if (!root?.isDirectory() || root.isSymbolicLink()) throw new ConfigError(t.errors.staleTarget(boundary));
  const boundaryIdentity = `${root.dev}:${root.ino}`;
  const boundaryCanonical = realpathSync(boundary);
  const rootAfter = lstatSync(boundary, { bigint: true, throwIfNoEntry: false });
  if (!rootAfter?.isDirectory() || rootAfter.isSymbolicLink() || `${rootAfter.dev}:${rootAfter.ino}` !== boundaryIdentity) {
    throw new ConfigError(t.errors.staleTarget(boundary));
  }
  const parents: RawEntryCapture["parents"] = [{ path: boundary, identity: boundaryIdentity }];
  const parts = relative(boundary, dirname(target)).split(sep).filter(Boolean);
  let parent = boundary;
  let absent = false;
  for (const part of parts) {
    parent = join(parent, part);
    const entry: BigIntStats | undefined = absent ? undefined : lstatSync(parent, { bigint: true, throwIfNoEntry: false });
    if (entry !== undefined && (!entry.isDirectory() || entry.isSymbolicLink())) {
      throw new ConfigError(t.errors.staleTarget(parent));
    }
    absent ||= entry === undefined;
    parents.push({ path: parent, identity: entry === undefined ? null : `${entry.dev}:${entry.ino}` });
  }
  const entry = absent ? undefined : lstatSync(target, { bigint: true, throwIfNoEntry: false });
  const base = { path: target, boundary, boundaryCanonical, boundaryIdentity, parents };
  if (entry === undefined) return { ...base, type: "missing", bytes: null, mode: null, identity: null, linkTarget: null };
  const identity = `${entry.dev}:${entry.ino}`;
  const mode = Number(entry.mode & 0o7777n);
  if (entry.isSymbolicLink()) {
    if (options.allowLink !== true) throw new ConfigError(t.errors.staleTarget(target));
    const linkTarget = readlinkSync(target);
    const after = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!after?.isSymbolicLink() || `${after.dev}:${after.ino}` !== identity || after.ctimeNs !== entry.ctimeNs) {
      throw new ConfigError(t.errors.staleTarget(target));
    }
    return { ...base, type: "symlink", bytes: null, mode, identity, linkTarget };
  }
  if (entry.isDirectory() && options.allowDirectory === true) {
    return { ...base, type: "directory", bytes: null, mode, identity, linkTarget: null };
  }
  if (!entry.isFile()) throw new ConfigError(t.errors.unreadableTarget(target, "not a regular file"));
  const limit = options.maxBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 0 || entry.size > BigInt(limit)) {
    throw new ConfigError(t.errors.unreadableTarget(target, "file exceeds the recovery size limit"));
  }
  let fd: number | undefined;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || `${opened.dev}:${opened.ino}` !== identity || opened.mode !== entry.mode ||
        opened.size !== entry.size || opened.mtimeNs !== entry.mtimeNs || opened.ctimeNs !== entry.ctimeNs) {
      throw new ConfigError(t.errors.staleTarget(target));
    }
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= limit) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - length));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      length += count;
    }
    const bytes = Buffer.concat(chunks, length);
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (bytes.length > limit || !named?.isFile() || `${named.dev}:${named.ino}` !== identity ||
        named.mode !== opened.mode || named.size !== opened.size || named.mtimeNs !== opened.mtimeNs || named.ctimeNs !== opened.ctimeNs ||
        after.mode !== opened.mode || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      throw new ConfigError(t.errors.staleTarget(target));
    }
    return { ...base, type: "regular", bytes, mode, identity, linkTarget: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A text read-set entry derived from the already captured raw source, without a second read. */
export function rawReadChange(capture: RawEntryCapture, t: Messages): Change {
  if (capture.type !== "regular" && capture.type !== "missing") throw new ConfigError(t.errors.staleTarget(capture.path));
  const before = capture.bytes === null ? null : decode(capture.bytes, t);
  return capturedReadChange(capture, before);
}

/** Bind raw source precedence without decoding or granting write authority. */
export function rawReadCheck(capture: RawEntryCapture, t: Messages): Change {
  if (capture.type !== "regular" && capture.type !== "missing") throw new ConfigError(t.errors.staleTarget(capture.path));
  return { ...capturedReadChange(capture, null), readOnlySnapshot: true };
}

function capturedReadChange(capture: RawEntryCapture, before: string | null): Change {
  const parent = [...capture.parents].reverse().find((entry) => entry.identity !== null)!;
  const physicalPath = join(capture.boundaryCanonical, relative(capture.boundary, capture.path));
  return {
    path: capture.path, realPath: physicalPath, before, after: before,
    created: capture.type === "missing", createdDir: capture.parents.at(-1)!.identity === null,
    snapshot: {
      exists: capture.type === "regular", resolvedPath: physicalPath,
      realPath: capture.type === "regular" ? physicalPath : null,
      symbolicLink: false, linkTarget: null, bytes: capture.bytes,
      mode: capture.mode, pathIdentity: capture.identity, targetIdentity: capture.identity,
      parentPath: capture.type === "missing" ? parent.path : null,
      parentIdentity: capture.type === "missing" ? parent.identity : null,
    },
    within: capture.boundary, withinIdentity: capture.boundaryIdentity,
    withinCanonical: capture.boundaryCanonical,
  };
}

function rawEntryJson(capture: RawEntryCapture): JsonValue {
  return { type: capture.type, identity: capture.identity, mode: capture.mode,
    bytes: capture.bytes?.toString("base64") ?? null, linkTarget: capture.linkTarget };
}

function regularEntryJson(snapshot: TargetSnapshot): JsonValue {
  return { type: "regular", identity: snapshot.pathIdentity, mode: snapshot.mode,
    bytes: snapshot.bytes!.toString("base64"), linkTarget: null };
}

function rawParentsFresh(capture: Pick<RawEntryCapture, "parents" | "path">): void {
  for (const expected of capture.parents) {
    const entry = lstatSync(expected.path, { bigint: true, throwIfNoEntry: false });
    if (expected.identity === null && entry === undefined) continue;
    if (!entry?.isDirectory() || entry.isSymbolicLink() ||
        (expected.identity === null || `${entry.dev}:${entry.ino}` !== expected.identity)) {
      throw invalidRecoveryAction(capture.path, "recovery parent changed");
    }
  }
}

function rawCapturedAt(path: string, capture: Pick<RawEntryCapture, "boundary">, t: Messages): JsonValue {
  return rawEntryJson(captureRawEntry(path, t, { within: capture.boundary, allowLink: true, allowDirectory: true }));
}

type EntryRecipe = { relativePath: string; contents: string; mode?: number };
type EntryRebuildMetadata = {
  schema: 1;
  reason: "generated" | "restore-config" | "restore-preset";
  boundary: string;
  boundaryIdentity: string;
  parents: RawEntryCapture["parents"];
  stash: string;
  stashIdentity: string | null;
  archive: string;
  prepared: string;
  preparedIdentity: string | null;
  createdParents: { path: string; identity: string }[];
  recipes?: EntryRecipe[];
};

function planRawRebuild(
  capture: RawEntryCapture,
  after: string | EntryRecipe[],
  t: Messages,
  options: { reason: EntryRebuildMetadata["reason"]; mode?: number },
): { action: PlannedOperationAction; changed: boolean } {
  if (capture.type === "directory" || (options.reason !== "generated" && capture.type === "symlink")) {
    throw new ConfigError(t.errors.staleTarget(capture.path));
  }
  const family = Array.isArray(after);
  const mode = options.mode ?? (capture.type === "regular" ? capture.mode! : 0o600);
  const nonce = randomBytes(16).toString("hex");
  const stash = join(dirname(capture.path), `.${basename(capture.path)}.tonedial-rebuild-${nonce}`);
  const metadata: EntryRebuildMetadata = {
    schema: 1, reason: options.reason, boundary: capture.boundary, boundaryIdentity: capture.boundaryIdentity,
    parents: capture.parents.map((entry) => ({ ...entry })), stash, stashIdentity: null,
    archive: join(stash, "archive"), prepared: join(stash, "prepared"), preparedIdentity: null, createdParents: [],
    ...(family ? { recipes: after } : {}),
  };
  let descriptor: OperationAction = {
    id: `entry-rebuild:${nonce}:${capture.path}`, kind: "entry-rebuild", path: capture.path, realPath: capture.path,
    before: rawEntryJson(capture),
    after: family ? { type: "directory", identity: null, mode: 0o700, entries: [] } :
      { type: "regular", identity: null, mode, bytes: Buffer.from(after).toString("base64"), linkTarget: null },
    metadata: metadata as unknown as JsonValue,
  };
  const changed = family || capture.type !== "regular" || !capture.bytes!.equals(Buffer.from(after)) ||
    (options.mode !== undefined && options.mode !== capture.mode);
  const assertCaptured = () => {
    rawParentsFresh(capture);
    if (JSON.stringify(rawCapturedAt(capture.path, capture, t)) !== JSON.stringify(descriptor.before)) {
      throw new ConfigError(t.errors.staleTarget(capture.path));
    }
  };
  const action: PlannedOperationAction = {
    action: descriptor,
    assertFresh: assertCaptured,
    prepare(checkpoint, createdParents = new Map()) {
      const assertCreatedParents = () => rawParentsFresh({ path: capture.path, parents: capture.parents.map((entry) => ({ ...entry,
        identity: entry.identity ?? createdParents.get(entry.path) ?? null })) });
      assertCreatedParents();
      if (JSON.stringify(rawCapturedAt(capture.path, capture, t)) !== JSON.stringify(descriptor.before)) {
        throw new ConfigError(t.errors.staleTarget(capture.path));
      }
      for (const parent of capture.parents) {
        if (parent.identity !== null) continue;
        assertCreatedParents();
        if (!createdParents.has(parent.path)) mkdirSync(parent.path, { mode: 0o700 });
        const observed = lstatSync(parent.path, { bigint: true });
        if (!observed.isDirectory() || observed.isSymbolicLink() ||
            (createdParents.has(parent.path) && `${observed.dev}:${observed.ino}` !== createdParents.get(parent.path))) {
          throw new ConfigError(t.errors.staleTarget(parent.path));
        }
        createdParents.set(parent.path, `${observed.dev}:${observed.ino}`);
        metadata.createdParents.push({ path: parent.path, identity: `${observed.dev}:${observed.ino}` });
      }
      assertCreatedParents();
      mkdirSync(stash, { mode: 0o700 });
      const stashStat = lstatSync(stash, { bigint: true });
      if (!stashStat.isDirectory() || stashStat.isSymbolicLink() || (stashStat.mode & 0o777n) !== 0o700n) {
        throw new ConfigError(t.errors.staleTarget(stash));
      }
      metadata.stashIdentity = `${stashStat.dev}:${stashStat.ino}`;
      descriptor = { ...descriptor, metadata: metadata as unknown as JsonValue };
      action.action = descriptor;
      checkpoint(descriptor);
      const directories = new Map<string, string>();
      const assertPreparation = () => {
        assertEntryParents({ action: descriptor, metadata });
        if (metadata.stashIdentity === null) throw new ConfigError(t.errors.staleTarget(stash));
        assertDirectoryIdentity(stash, metadata.stashIdentity, t);
        for (const [path, identity] of directories) assertDirectoryIdentity(path, identity, t);
      };
      assertPreparation();
      if (family) {
        assertPreparation();
        mkdirSync(metadata.prepared, { mode: 0o700 });
        const root = lstatSync(metadata.prepared, { bigint: true });
        if (!root.isDirectory() || root.isSymbolicLink()) throw new ConfigError(t.errors.staleTarget(metadata.prepared));
        directories.set(metadata.prepared, `${root.dev}:${root.ino}`);
        const entries = new Map<string, JsonValue>();
        for (const recipe of after) {
          const target = join(metadata.prepared, recipe.relativePath);
          let parent = metadata.prepared;
          for (const part of relative(metadata.prepared, dirname(target)).split(sep).filter(Boolean)) {
            parent = join(parent, part);
            if (directories.has(parent)) continue;
            assertPreparation();
            mkdirSync(parent, { mode: 0o700 });
            const observed = lstatSync(parent, { bigint: true });
            if (!observed.isDirectory() || observed.isSymbolicLink()) throw new ConfigError(t.errors.staleTarget(parent));
            const identity = `${observed.dev}:${observed.ino}`;
            directories.set(parent, identity);
            entries.set(relative(metadata.prepared, parent), { type: "directory", identity, mode: 0o700, bytes: null, linkTarget: null });
          }
          const snapshot = prepareRegularEntry(target, Buffer.from(recipe.contents), recipe.mode ?? 0o600, t, assertPreparation);
          entries.set(recipe.relativePath, regularEntryJson(snapshot));
          assertPreparation();
          syncEntryDirectory(target);
        }
        descriptor = { ...descriptor, after: { type: "directory", identity: directories.get(metadata.prepared)!, mode: 0o700,
          entries: [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([relativePath, entry]) => ({ relativePath, ...snapshotRecord(entry)! })) } };
        assertPreparation();
        if (!entrySnapshotMatches(metadata.prepared, descriptor.after, metadata, t)) throw new ConfigError(t.errors.staleTarget(metadata.prepared));
      } else {
        const snapshot = prepareRegularEntry(metadata.prepared, Buffer.from(after), mode, t, assertPreparation);
        assertPreparation();
        syncEntryDirectory(metadata.prepared);
        descriptor = { ...descriptor, after: regularEntryJson(snapshot) };
      }
      metadata.preparedIdentity = snapshotRecord(descriptor.after)!.identity as string;
      descriptor = { ...descriptor, metadata: metadata as unknown as JsonValue };
      action.action = descriptor;
      checkpoint(descriptor);
      assertPreparation();
    },
    apply() {
      const checked = validateEntryRebuildAction(descriptor, true);
      assertEntryParents(checked);
      if (!entrySnapshotMatches(metadata.prepared, descriptor.after, metadata, t) ||
          !entrySnapshotMatches(capture.path, descriptor.before, metadata, t) || lstatSync(metadata.archive, { throwIfNoEntry: false }) !== undefined) {
        throw new ConfigError(t.errors.staleTarget(capture.path));
      }
      if (capture.type !== "missing") {
        assertEntryParents(checked);
        moveEntry(capture.path, metadata.archive);
      }
      assertEntryParents(checked);
      moveEntry(metadata.prepared, capture.path);
      if (!entrySnapshotMatches(capture.path, descriptor.after, metadata, t)) throw new ConfigError(t.errors.staleTarget(capture.path));
    },
    after: () => descriptor,
  };
  return { action, changed };
}

/** Only explicit restoration reasons may replace damaged user-data bytes. */
export function planEntryRebuild(
  capture: RawEntryCapture, after: string, t: Messages,
  options: { reason: EntryRebuildMetadata["reason"]; mode?: number },
): { action: PlannedOperationAction; changed: boolean } {
  return planRawRebuild(capture, after, t, options);
}

function isGeneratedFamily(path: string, boundary: string): boolean {
  return path === join(boundary, "skill", "tonedial") || path === join(boundary, "presets", "builtin");
}

/** Replace one declared generated family entry and only its supplied closed recipes. */
export function planGeneratedFamilyRebuild(capture: RawEntryCapture, recipes: EntryRecipe[], t: Messages) {
  if (!isGeneratedFamily(capture.path, capture.boundary) || recipes.length === 0 || new Set(recipes.map((recipe) => recipe.relativePath)).size !== recipes.length || recipes.some((recipe) =>
    recipe.relativePath === "" || isAbsolute(recipe.relativePath) ||
    resolve(capture.path, recipe.relativePath) !== join(capture.path, recipe.relativePath) ||
    !lexicallyInside(resolve(capture.path, recipe.relativePath), capture.path) || recipe.relativePath.includes("\0"))) {
    throw new ConfigError(t.errors.staleTarget(capture.path));
  }
  return planRawRebuild(capture, recipes, t, { reason: "generated" });
}

function familyEntrySnapshot(path: string, t: Messages, boundary: string, recipes: EntryRecipe[]): JsonValue {
  const directories = new Set<string>([""]);
  for (const recipe of recipes) {
    let parent = dirname(recipe.relativePath);
    while (parent !== ".") { directories.add(parent); parent = dirname(parent); }
  }
  const names = [...directories, ...recipes.map((recipe) => recipe.relativePath)].sort();
  for (const directory of directories) {
    const target = join(path, directory);
    const stat = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw invalidRecoveryAction(path, "generated family directory changed");
    const expected = names.filter((name) => name !== "" && dirname(name) === (directory || ".")).map((name) => basename(name)).sort();
    if (JSON.stringify(readdirSync(target).sort()) !== JSON.stringify(expected)) {
      throw invalidRecoveryAction(path, "generated family has unrecognized entries");
    }
  }
  const root = lstatSync(path, { bigint: true });
  const entries: JsonValue[] = [];
  for (const name of names.filter(Boolean)) {
    const entry = captureRawEntry(join(path, name), t, { within: boundary, allowDirectory: true });
    entries.push({ relativePath: name, ...snapshotRecord(rawEntryJson(entry)) });
  }
  return { type: "directory", identity: `${root.dev}:${root.ino}`, mode: Number(root.mode & 0o7777n), entries };
}

function validateRawEntrySnapshot(value: JsonValue, path: string, requireIdentity: boolean, family = false): Record<string, JsonValue> {
  const entry = snapshotRecord(value);
  if (entry === null || !["missing", "regular", "symlink", ...(family ? ["directory"] : [])].includes(entry.type as string) ||
      (entry.identity !== null && !identityTextValue(entry.identity)) ||
      (requireIdentity && entry.type !== "missing" && !identityTextValue(entry.identity)) ||
      (entry.type === "missing" ? entry.mode !== null || entry.identity !== null :
        typeof entry.mode !== "number" || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777)) {
    throw invalidRecoveryAction(path, "lexical entry snapshot is invalid");
  }
  if (entry.type === "directory") {
    if (Object.keys(entry).sort().join(",") !== "entries,identity,mode,type" || !Array.isArray(entry.entries)) throw invalidRecoveryAction(path, "generated family snapshot is invalid");
    for (const item of entry.entries) {
      const child = snapshotRecord(item);
      if (child === null || typeof child.relativePath !== "string" || child.relativePath === "" ||
          isAbsolute(child.relativePath) || !lexicallyInside(resolve(path, child.relativePath), path)) {
        throw invalidRecoveryAction(path, "generated family child is invalid");
      }
      if (child.type === "directory") {
        if (Object.keys(child).sort().join(",") !== "bytes,identity,linkTarget,mode,relativePath,type" ||
            !identityTextValue(child.identity) || child.mode !== 0o700 || child.bytes !== null || child.linkTarget !== null) {
          throw invalidRecoveryAction(path, "generated family directory witness is invalid");
        }
      } else {
        const childEntry = { ...child };
        delete childEntry.relativePath;
        validateRawEntrySnapshot(childEntry, path, true);
      }
    }
  } else if (Object.keys(entry).sort().join(",") !== "bytes,identity,linkTarget,mode,type" ||
      (entry.type === "regular" ? !base64Value(entry.bytes) : entry.bytes !== null) ||
      (entry.type === "symlink" ? typeof entry.linkTarget !== "string" || entry.linkTarget.length === 0 : entry.linkTarget !== null)) {
    throw invalidRecoveryAction(path, "lexical entry data is invalid");
  }
  return entry;
}

function validateEntryRebuildAction(action: OperationAction, prepared = false): { action: OperationAction; metadata: EntryRebuildMetadata } {
  const value = snapshotRecord(action.metadata ?? null);
  if (action.kind !== "entry-rebuild" || !normalizedPath(action.path) || action.realPath !== action.path || value === null ||
      Object.keys(value).sort().join(",") !== ["schema", "reason", "boundary", "boundaryIdentity", "parents", "stash", "stashIdentity", "archive", "prepared", "preparedIdentity", "createdParents", ...(Object.hasOwn(value, "recipes") ? ["recipes"] : [])].sort().join(",") ||
      value.schema !== 1 || !["generated", "restore-config", "restore-preset"].includes(value.reason as string) ||
      !normalizedPath(value.boundary) || !lexicallyInside(action.path, value.boundary) || !identityTextValue(value.boundaryIdentity) ||
      !Array.isArray(value.parents) || value.parents.length === 0 || !normalizedPath(value.stash) ||
      dirname(value.stash) !== dirname(action.path) || !new RegExp(`^\\.${basename(action.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.tonedial-rebuild-[0-9a-f]{32}$`).test(basename(value.stash)) ||
      value.archive !== join(value.stash, "archive") || value.prepared !== join(value.stash, "prepared") ||
      (value.stashIdentity !== null && !identityTextValue(value.stashIdentity)) ||
      (value.preparedIdentity !== null && !identityTextValue(value.preparedIdentity)) || !Array.isArray(value.createdParents)) {
    throw invalidRecoveryAction(action.path, "lexical rebuild provenance is invalid");
  }
  const metadata = value as unknown as EntryRebuildMetadata;
  let parent = metadata.boundary;
  if (metadata.parents[0]?.path !== parent || metadata.parents[0]?.identity !== metadata.boundaryIdentity) {
    throw invalidRecoveryAction(action.path, "lexical rebuild root witness is invalid");
  }
  for (const [index, entry] of metadata.parents.entries()) {
    if (!entry || !normalizedPath(entry.path) || (entry.identity !== null && !identityTextValue(entry.identity)) ||
        (index > 0 && dirname(entry.path) !== parent)) throw invalidRecoveryAction(action.path, "lexical rebuild parent witness is invalid");
    parent = entry.path;
  }
  if (parent !== dirname(action.path) || metadata.createdParents.some((entry) => !entry || !identityTextValue(entry.identity) ||
      !metadata.parents.some((planned) => planned.path === entry.path && planned.identity === null))) {
    throw invalidRecoveryAction(action.path, "lexical rebuild parent set is inconsistent");
  }
  const before = validateRawEntrySnapshot(action.before, action.path, true);
  const after = validateRawEntrySnapshot(action.after, action.path, prepared, metadata.recipes !== undefined);
  if (after.type !== (metadata.recipes === undefined ? "regular" : "directory")) {
    throw invalidRecoveryAction(action.path, "lexical rebuild after-state is invalid");
  }
  if (metadata.reason !== "generated" && (before.type === "symlink" || after.type !== "regular")) {
    throw invalidRecoveryAction(action.path, "user-data restoration cannot replace a link");
  }
  if (metadata.recipes !== undefined && (!Array.isArray(metadata.recipes) || metadata.recipes.length === 0 ||
      new Set(metadata.recipes.map((recipe) => recipe.relativePath)).size !== metadata.recipes.length ||
      !isGeneratedFamily(action.path, metadata.boundary) ||
      metadata.recipes.some((recipe) => typeof recipe.contents !== "string" || !normalizedPath(resolve(action.path, recipe.relativePath)) ||
        !lexicallyInside(resolve(action.path, recipe.relativePath), action.path)))) {
    throw invalidRecoveryAction(action.path, "generated family recipes are invalid");
  }
  if (prepared && (!identityTextValue(metadata.stashIdentity) || metadata.preparedIdentity !== after.identity)) {
    throw invalidRecoveryAction(action.path, "lexical rebuild prepared witness is missing");
  }
  return { action, metadata };
}

function assertEntryParents({ action, metadata }: { action: OperationAction; metadata: EntryRebuildMetadata }): void {
  rawParentsFresh({ path: action.path, parents: metadata.parents.map((entry) => ({ ...entry,
    identity: entry.identity ?? metadata.createdParents.find((created) => created.path === entry.path)?.identity ?? null })) });
  const stash = lstatSync(metadata.stash, { bigint: true, throwIfNoEntry: false });
  if (metadata.stashIdentity !== null && stash !== undefined) {
    if (!stash.isDirectory() || stash.isSymbolicLink() || `${stash.dev}:${stash.ino}` !== metadata.stashIdentity ||
        (stash.mode & 0o777n) !== 0o700n) throw invalidRecoveryAction(action.path, "private entry archive changed");
  } else if (metadata.stashIdentity === null && stash !== undefined) {
    throw invalidRecoveryAction(action.path, "private archive identity was not recorded");
  }
}

function entrySnapshotMatches(path: string, expected: JsonValue, metadata: EntryRebuildMetadata, t: Messages): boolean {
  try {
    const type = snapshotRecord(expected)?.type;
    const actual = type === "directory" && metadata.recipes !== undefined
      ? familyEntrySnapshot(path, t, metadata.boundary, metadata.recipes)
      : rawCapturedAt(path, metadata, t);
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch { return false; }
}

function probeEntryRebuild(action: OperationAction, t: Messages): RollbackActionStatus {
  try {
    const validation = validateEntryRebuildAction(action, false);
    const { metadata } = validation;
    assertEntryParents(validation);
    if (entrySnapshotMatches(action.path, action.before, metadata, t) &&
        lstatSync(metadata.archive, { throwIfNoEntry: false }) === undefined) return "already-reverted";
    validateEntryRebuildAction(action, true);
    const before = snapshotRecord(action.before)!;
    const archiveOkay = before.type === "missing" ? lstatSync(metadata.archive, { throwIfNoEntry: false }) === undefined :
      entrySnapshotMatches(metadata.archive, action.before, metadata, t);
    if (!archiveOkay) return "changed";
    if (entrySnapshotMatches(action.path, action.after, metadata, t)) return "applied";
    if (lstatSync(action.path, { throwIfNoEntry: false }) === undefined && before.type !== "missing" &&
        entrySnapshotMatches(metadata.prepared, action.after, metadata, t)) return "applied";
    return "changed";
  } catch { return "changed"; }
}

function restoreEntryRebuild(action: OperationAction, t: Messages): RollbackActionOutcome {
  const status = probeEntryRebuild(action, t);
  if (status === "already-reverted") return status;
  if (status !== "applied") throw invalidRecoveryAction(action.path, "lexical entry changed after rebuilding");
  const validation = validateEntryRebuildAction(action, true);
  const { metadata } = validation;
  assertEntryParents(validation);
  if (lstatSync(action.path, { throwIfNoEntry: false }) !== undefined) {
    if (lstatSync(metadata.prepared, { throwIfNoEntry: false }) !== undefined) {
      throw invalidRecoveryAction(action.path, "prepared archive is occupied");
    }
    // Retain the witnessed new entry as well as the original; no recursive deletion is needed.
    assertEntryParents(validation);
    moveEntry(action.path, metadata.prepared);
  }
  if (snapshotRecord(action.before)!.type !== "missing") {
    assertEntryParents(validation);
    moveEntry(metadata.archive, action.path);
  }
  if (!entrySnapshotMatches(action.path, action.before, metadata, t)) {
    throw invalidRecoveryAction(action.path, "original lexical entry could not be restored");
  }
  return "restored";
}

function snapshotJson(snapshot: TargetSnapshot): JsonValue {
  const value: Record<string, JsonValue> = {
    exists: snapshot.exists,
    resolvedPath: snapshot.resolvedPath,
    realPath: snapshot.realPath,
    symbolicLink: snapshot.symbolicLink,
    linkTarget: snapshot.linkTarget,
    mode: snapshot.mode,
    pathIdentity: snapshot.pathIdentity,
    targetIdentity: snapshot.targetIdentity,
    parentIdentity: snapshot.parentIdentity,
    parentPath: snapshot.parentPath,
  };
  if (snapshot.bytes !== null) value.bytes = snapshot.bytes.toString("base64");
  return value;
}

function snapshotForJournal(path: string, t: Messages): JsonValue {
  const snapshot = targetSnapshot(path, t);
  if (snapshot.exists) snapshot.bytes = targetBytes(path, snapshot, t);
  return snapshotJson(snapshot);
}

function desiredAfter(change: Change): JsonValue {
  const removed = !writesRegular(change);
  if (removed) {
    let parent = nearestParent(change.path);
    if (change.createdDir) {
      const names = readdirSync(dirname(change.path));
      if (names.length === 1 && names[0]!.toLowerCase() === basename(change.path).toLowerCase()) {
        const surviving = nearestParent(dirname(change.path));
        parent = { ...surviving, resolvedPath: join(surviving.resolvedPath, basename(change.path)) };
      }
    }
    return {
      exists: false,
      resolvedPath: parent.resolvedPath,
      realPath: null,
      symbolicLink: false,
      linkTarget: null,
      mode: null,
      pathIdentity: null,
      targetIdentity: null,
      // A removed entry has no inode; its surviving parent identifies the planned absence.
      parentIdentity: parent.identity,
      parentPath: parent.path,
    };
  }
  const value: Record<string, JsonValue> = {
    exists: true,
    resolvedPath: change.realPath,
    realPath: change.realPath,
    symbolicLink: false,
    linkTarget: null,
    mode: change.mode ?? change.snapshot.mode ?? 0o600,
    pathIdentity: null,
    targetIdentity: null,
    parentIdentity: change.snapshot.parentIdentity,
    parentPath: change.snapshot.parentPath,
    bytes: Buffer.from(change.after ?? "", "utf8").toString("base64"),
  };
  return value;
}

function operationAction(change: Change, phase: string, index: number): OperationAction {
  const removed = !writesRegular(change);
  return {
    id: `file:${phase}:${index}:${change.path}`,
    kind: "file",
    path: change.path,
    realPath: change.realPath,
    before: snapshotJson(change.snapshot),
    after: desiredAfter(change),
    metadata: {
      created: change.created,
      createdDir: change.createdDir,
      requestedMode: change.mode ?? null,
      ...(removed && change.snapshot.symbolicLink ? { removedSymlink: true } : {}),
    },
  };
}

type FileEffect = { change: Change; aliases: Change[]; final: boolean };

function writesRegular(change: Change): change is Change & { after: string } {
  return change.after !== null && !(change.after === "" && change.created);
}

function samePhysicalPreimage(left: Change, right: Change): boolean {
  const a = left.snapshot;
  const b = right.snapshot;
  return left.realPath === right.realPath && a.exists === b.exists && a.resolvedPath === b.resolvedPath &&
    a.targetIdentity === b.targetIdentity && a.mode === b.mode &&
    (a.bytes === null ? b.bytes === null : b.bytes !== null && a.bytes.equals(b.bytes)) &&
    (a.exists || a.parentIdentity === b.parentIdentity);
}

/** Multiple access paths can request one physical write; removals still own lexical entries. */
function fileEffects(changes: Change[], finalChanges: Change[], t: Messages): { initial: FileEffect[]; final: FileEffect[] } {
  const effects: FileEffect[] = [];
  const writes = new Map<string, FileEffect>();
  for (const [list, final] of [[changes, false], [finalChanges, true]] as const) {
    for (const change of list) {
      if (isNoop(change)) continue;
      if (!writesRegular(change)) { effects.push({ change, aliases: [], final }); continue; }
      const previous = writes.get(change.realPath);
      if (previous === undefined) {
        const effect = { change, aliases: [], final };
        effects.push(effect);
        writes.set(change.realPath, effect);
      } else {
        if (!samePhysicalPreimage(previous.change, change) || previous.change.after !== change.after ||
            (previous.change.mode ?? previous.change.snapshot.mode ?? 0o600) !== (change.mode ?? change.snapshot.mode ?? 0o600)) {
          throw new ConfigError(t.errors.staleTarget(change.path));
        }
        previous.final ||= final;
      }
    }
  }
  for (const effect of writes.values()) {
    const byPath = new Map<string, Change>([[effect.change.path, effect.change]]);
    for (const change of [...changes, ...finalChanges]) {
      if (change.realPath !== effect.change.realPath || (!isNoop(change) && !writesRegular(change))) continue;
      if (!samePhysicalPreimage(effect.change, change)) throw new ConfigError(t.errors.staleTarget(change.path));
      const existing = byPath.get(change.path);
      if (existing !== undefined && (existing.snapshot.pathIdentity !== change.snapshot.pathIdentity ||
          existing.snapshot.symbolicLink !== change.snapshot.symbolicLink || existing.snapshot.linkTarget !== change.snapshot.linkTarget)) {
        throw new ConfigError(t.errors.staleTarget(change.path));
      }
      byPath.set(change.path, change);
    }
    effect.aliases = [...byPath.values()].filter((change) => change.path !== effect.change.path);
  }
  const removals = new Set<string>();
  for (const effect of effects) {
    if (writesRegular(effect.change) || effect.change.snapshot.symbolicLink) continue;
    if (writes.has(effect.change.realPath) || removals.has(effect.change.realPath)) throw new ConfigError(t.errors.staleTarget(effect.change.path));
    removals.add(effect.change.realPath);
  }
  return { initial: effects.filter((effect) => !effect.final), final: effects.filter((effect) => effect.final) };
}

function effectAction(effect: FileEffect, phase: string, index: number): OperationAction {
  const action = operationAction(effect.change, phase, index);
  if (effect.aliases.length === 0) return action;
  return { ...action, metadata: { ...snapshotRecord(action.metadata ?? null), aliases: effect.aliases.map((alias) =>
    ({ path: alias.path, before: snapshotJson(alias.snapshot), after: desiredAfter({ ...alias, after: effect.change.after, mode: effect.change.mode }) })) } };
}

function fileAliases(action: OperationAction): { path: string; before: JsonValue; after: JsonValue }[] {
  const aliases = snapshotRecord(action.metadata ?? null)?.aliases;
  if (aliases === undefined) return [];
  if (!Array.isArray(aliases)) throw invalidRecoveryAction(action.path, "physical write aliases are invalid");
  return aliases as { path: string; before: JsonValue; after: JsonValue }[];
}

function assertActionAliases(action: OperationAction, phase: "before" | "after" | "restored", t: Messages): void {
  for (const alias of fileAliases(action)) {
    const current = targetSnapshot(alias.path, t);
    const restored = snapshotRecord(snapshotRecord(action.metadata ?? null)?.restoreWitness ?? null);
    const expectedValue = phase === "restored" && restored !== null
      ? restored.exists === false ? { ...restored, parentPath: current.parentPath }
        : preparedLanding({ ...restored, symbolicLink: false, linkTarget: null, pathIdentity: restored.targetIdentity! }, action.realPath, snapshotRecord(alias.before)!)
      : alias[phase === "restored" ? "before" : phase];
    const expected = snapshotRecord(expectedValue)!;
    const captured = snapshotRecord(snapshotJson(current))!;
    if (snapshotFields.some((field) => (phase !== "before" || expected.exists !== false || !["parentPath", "parentIdentity"].includes(field)) &&
        JSON.stringify(captured[field]) !== JSON.stringify(expected[field])) ||
        (phase === "before" && expected.exists === false && parentIdentityAt(expected.parentPath as string) !== expected.parentIdentity)) {
      throw new ConfigError(t.errors.staleTarget(alias.path));
    }
    if (current.exists) captured.bytes = targetBytes(alias.path, current, t).toString("base64");
    if (expected.exists && !sameJournalSnapshot(captured, expectedValue)) throw new ConfigError(t.errors.staleTarget(alias.path));
  }
}

function aliasesMatchCurrent(action: OperationAction, phase: "before" | "after" | "restored", t: Messages): boolean {
  try { assertActionAliases(action, phase, t); return true; } catch { return false; }
}

function assertWrittenAliases(actions: OperationAction[], completed: readonly number[], t: Messages): void {
  for (const index of completed) {
    const action = actions[index]!;
    if (action.kind !== "file" || fileAliases(action).length === 0) continue;
    assertAppliedFileLocation(action, t);
  }
}

function updatedFileAction(change: Change, action: OperationAction, t: Messages): OperationAction {
  const metadata = targetSnapshot(change.path, t);
  const expected = snapshotRecord(action.after)!;
  const current = snapshotRecord(snapshotJson(metadata))!;
  if (snapshotFields.some((field) => JSON.stringify(current[field]) !== JSON.stringify(expected[field]))) {
    throw new ConfigError(t.errors.staleTarget(change.path));
  }
  if (metadata.exists) current.bytes = targetBytes(change.path, metadata, t).toString("base64");
  // The prepared inode is the witness. Never adopt a replacement merely because it landed
  // between publication and the completion checkpoint with the same contents.
  if (!sameJournalSnapshot(current, action.after)) throw new ConfigError(t.errors.staleTarget(change.path));
  assertActionAliases(action, "after", t);
  return action;
}

function assertDirectoryIdentity(path: string, identity: string, t: Messages): void {
  const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!entry?.isDirectory() || entry.isSymbolicLink() || `${entry.dev}:${entry.ino}` !== identity) {
    throw new ConfigError(t.errors.staleTarget(path));
  }
}

/** The opened inode, not a later pathname observation, owns the prepared write. */
function prepareRegularEntry(path: string, bytes: Buffer, mode: number, t: Messages, assertParents: () => void): TargetSnapshot {
  assertParents();
  let fd: number | undefined;
  let witness: BigIntStats;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), mode);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw new ConfigError(t.errors.staleTarget(path));
    assertParents();
    writeFileSync(fd, bytes);
    assertParents();
    fchmodSync(fd, mode);
    assertParents();
    fsyncSync(fd);
    witness = fstatSync(fd, { bigint: true });
    if (!witness.isFile() || witness.dev !== opened.dev || witness.ino !== opened.ino ||
        Number(witness.mode & 0o7777n) !== mode || witness.size !== BigInt(bytes.length)) {
      throw new ConfigError(t.errors.staleTarget(path));
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  assertParents();
  const named = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!named?.isFile() || named.isSymbolicLink() || named.dev !== witness.dev || named.ino !== witness.ino ||
      Number(named.mode & 0o7777n) !== mode || named.size !== witness.size ||
      named.mtimeNs !== witness.mtimeNs || named.ctimeNs !== witness.ctimeNs) {
    throw new ConfigError(t.errors.staleTarget(path));
  }
  const captured = captureRawEntry(path, t, { within: dirname(path), maxBytes: bytes.length });
  if (captured.type !== "regular" || captured.identity !== `${witness.dev}:${witness.ino}` || captured.mode !== mode ||
      captured.bytes === null || !captured.bytes.equals(bytes)) throw new ConfigError(t.errors.staleTarget(path));
  assertParents();
  const physical = join(captured.boundaryCanonical, basename(path));
  return { exists: true, resolvedPath: physical, realPath: physical, symbolicLink: false, linkTarget: null,
    bytes: Buffer.from(bytes), mode, pathIdentity: captured.identity, targetIdentity: captured.identity,
    parentIdentity: null, parentPath: null };
}

function prepareRegularWrite(path: string, bytes: Buffer, mode: number, t: Messages, assertDestination: () => void): { temporary: string; snapshot: JsonValue; parentIdentity: string } {
  const missing: string[] = [];
  let parent = dirname(path);
  while (lstatSync(parent, { throwIfNoEntry: false }) === undefined) {
    missing.unshift(parent);
    parent = dirname(parent);
  }
  const entry = lstatSync(parent, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ConfigError(t.errors.staleTarget(parent));
  const directories = [{ path: parent, identity: `${entry.dev}:${entry.ino}` }];
  const assertParents = () => {
    assertDestination();
    for (const directory of directories) assertDirectoryIdentity(directory.path, directory.identity, t);
  };
  assertParents();
  for (const directory of missing) {
    assertParents();
    mkdirSync(directory, { mode: 0o700 });
    const created = lstatSync(directory, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink()) throw new ConfigError(t.errors.staleTarget(directory));
    directories.push({ path: directory, identity: `${created.dev}:${created.ino}` });
  }
  const temporary = join(dirname(path), `.${basename(path)}.tonedial-write-${randomBytes(16).toString("hex")}`);
  const snapshot = prepareRegularEntry(temporary, bytes, mode, t, assertParents);
  return { temporary, snapshot: snapshotJson(snapshot), parentIdentity: directories.at(-1)!.identity };
}

function syncEntryDirectory(path: string): void {
  const fd = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function moveEntry(from: string, to: string): void {
  renameSync(from, to);
  syncEntryDirectory(from);
  if (dirname(from) !== dirname(to)) syncEntryDirectory(to);
}

function preparedLanding(snapshot: JsonValue, path: string, prior?: Record<string, JsonValue>): JsonValue {
  const prepared = snapshotRecord(snapshot)!;
  return {
    ...prepared,
    resolvedPath: path,
    realPath: path,
    symbolicLink: prior?.symbolicLink === true,
    linkTarget: prior?.symbolicLink === true ? prior.linkTarget! : null,
    pathIdentity: prior?.symbolicLink === true ? prior.pathIdentity! : prepared.pathIdentity!,
  };
}

function prepareFileWrite(change: Change, action: OperationAction, t: Messages): OperationAction {
  if (!writesRegular(change)) return action;
  const prepared = prepareRegularWrite(change.realPath, Buffer.from(change.after), change.mode ?? change.snapshot.mode ?? 0o600, t,
    () => { assertFileLocation(change, t); assertActionAliases(action, "before", t); });
  return {
    ...action,
    after: preparedLanding(prepared.snapshot, change.realPath, snapshotRecord(action.before) ?? undefined),
    metadata: { ...snapshotRecord(action.metadata ?? null), preparedWrite: prepared,
      ...(fileAliases(action).length === 0 ? {} : { aliases: fileAliases(action).map((alias) =>
        ({ ...alias, after: preparedLanding(prepared.snapshot, change.realPath, snapshotRecord(alias.before)!) })) }) },
  };
}

function assertFileLocation(change: Change, t: Messages): void {
  assertWithinFresh(change, t);
  if (change.within !== null) {
    const root = lstatSync(change.within, { throwIfNoEntry: false });
    if (!root?.isDirectory() || root.isSymbolicLink()) throw new ConfigError(t.errors.staleTarget(change.path));
  }
  const current = targetSnapshot(change.path, t);
  if (current.exists !== change.snapshot.exists || current.pathIdentity !== change.snapshot.pathIdentity ||
      current.targetIdentity !== change.snapshot.targetIdentity || current.resolvedPath !== change.realPath ||
      current.linkTarget !== change.snapshot.linkTarget || current.mode !== change.snapshot.mode) {
    throw new ConfigError(t.errors.staleTarget(change.path));
  }
}

function publishFileWrite(change: Change, action: OperationAction, t: Messages): void {
  const prepared = snapshotRecord(snapshotRecord(action.metadata ?? null)?.preparedWrite ?? null);
  if (prepared === null) {
    removeFile(change);
    return;
  }
  const temporary = prepared.temporary as string;
  assertActionAliases(action, "before", t);
  assertFileLocation(change, t);
  assertDirectoryIdentity(dirname(change.realPath), prepared.parentIdentity as string, t);
  if (!sameJournalSnapshot(snapshotForJournal(temporary, t), prepared.snapshot!)) throw new ConfigError(t.errors.staleTarget(change.path));
  assertFileLocation(change, t);
  assertDirectoryIdentity(dirname(change.realPath), prepared.parentIdentity as string, t);
  const current = targetSnapshot(change.path, t);
  if (current.exists !== change.snapshot.exists || current.pathIdentity !== change.snapshot.pathIdentity ||
      current.targetIdentity !== change.snapshot.targetIdentity || current.resolvedPath !== change.realPath ||
      current.linkTarget !== change.snapshot.linkTarget || current.mode !== change.snapshot.mode ||
      (current.exists && !targetBytes(change.path, current, t).equals(change.snapshot.bytes!))) {
    throw new ConfigError(t.errors.staleTarget(change.path));
  }
  moveEntry(temporary, change.realPath);
}

function snapshotRecord(value: JsonValue): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

const snapshotFields = [
  "exists", "resolvedPath", "realPath", "symbolicLink", "linkTarget", "mode",
  "pathIdentity", "targetIdentity", "parentIdentity", "parentPath",
] as const;

function sameJournalSnapshot(actual: JsonValue, expected: JsonValue): boolean {
  const current = snapshotRecord(actual);
  const planned = snapshotRecord(expected);
  if (current === null || planned === null) return false;
  for (const field of snapshotFields) {
    if (JSON.stringify(current[field]) !== JSON.stringify(planned[field])) return false;
  }
  if (JSON.stringify(current.bytes) !== JSON.stringify(planned.bytes)) return false;
  return true;
}

function snapshotHasIdentity(value: Record<string, JsonValue>): boolean {
  return value.exists === true && typeof value.pathIdentity === "string" && value.pathIdentity !== "" &&
    typeof value.targetIdentity === "string" && value.targetIdentity !== "";
}

function metadataBoolean(action: OperationAction, key: string): boolean {
  const metadata = action.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return false;
  return metadata[key] === true;
}

const fileSnapshotKeys = [...snapshotFields, "bytes"] as const;

function normalizedAbsolute(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value) && resolve(value) === value;
}

function identityTextValue(value: unknown): value is string {
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

function invalidRecoveryAction(path: string, reason: string): ConfigError {
  return new ConfigError(`cannot safely recover ${path}: ${reason}`);
}

function validFileSnapshot(
  value: JsonValue,
  actionPath: string,
  label: "before" | "after",
  requireIdentity: boolean,
  allowPlannedParent: boolean,
): Record<string, JsonValue> {
  const snapshot = snapshotRecord(value);
  if (snapshot === null || Object.keys(snapshot).some((key) => !fileSnapshotKeys.includes(key as (typeof fileSnapshotKeys)[number]))) {
    throw invalidRecoveryAction(actionPath, `${label} snapshot is invalid`);
  }
  const exists = snapshot.exists;
  if (typeof exists !== "boolean" || !normalizedAbsolute(snapshot.resolvedPath)) {
    throw invalidRecoveryAction(actionPath, `${label} snapshot is invalid`);
  }
  const realPath = snapshot.realPath;
  const symbolicLink = snapshot.symbolicLink;
  const linkTarget = snapshot.linkTarget;
  const mode = snapshot.mode;
  const pathIdentity = snapshot.pathIdentity;
  const targetIdentity = snapshot.targetIdentity;
  const parentIdentity = snapshot.parentIdentity;
  const parentPath = snapshot.parentPath;
  const hasParentEvidence = parentIdentity !== null || parentPath !== null;
  const hasPartialParentEvidence = (parentIdentity === null) !== (parentPath === null);
  if (typeof symbolicLink !== "boolean" ||
      (exists && (!normalizedAbsolute(realPath) || realPath !== snapshot.resolvedPath)) ||
      (!exists && realPath !== null) ||
      (exists && (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o7777)) ||
      (!exists && mode !== null) ||
      (exists && symbolicLink && (typeof linkTarget !== "string" || linkTarget.length === 0)) ||
      ((!exists || !symbolicLink) && linkTarget !== null) ||
      (exists && ((!allowPlannedParent && hasParentEvidence) || (allowPlannedParent && hasPartialParentEvidence))) ||
      (!exists && (!normalizedAbsolute(parentPath) || !identityTextValue(parentIdentity))) ||
      (parentIdentity !== null && !identityTextValue(parentIdentity)) ||
      (exists && !Object.hasOwn(snapshot, "bytes")) ||
      (exists && !base64Value(snapshot.bytes)) ||
      (!exists && Object.hasOwn(snapshot, "bytes") && snapshot.bytes !== null)) {
    throw invalidRecoveryAction(actionPath, `${label} snapshot is invalid`);
  }
  if (!exists) {
    if (symbolicLink !== false || pathIdentity !== null || targetIdentity !== null) {
      throw invalidRecoveryAction(actionPath, `${label} snapshot is invalid`);
    }
  } else {
    const identitiesMissing = pathIdentity === null && targetIdentity === null;
    if ((!identitiesMissing && (!identityTextValue(pathIdentity) || !identityTextValue(targetIdentity))) ||
        (requireIdentity && identitiesMissing)) {
      throw invalidRecoveryAction(actionPath, `${label} snapshot identity is invalid`);
    }
  }
  return snapshot;
}

/** Validate file recovery semantics without touching the target or its referent. */
/**
 * Whether a `created` flag agrees with what the action actually does to the file's existence.
 *
 * `created` records that this tool owns the file's existence, which is true in two shapes: the
 * action brings the file into being, or it removes a file this tool had brought into being
 * earlier and whose whole content was still ours — the case `unwire` and the legacy-delivery
 * removal both produce, where leaving an emptied file behind would be the wrong outcome.
 *
 * What it may never mean is the third shape: a file that exists before and after. Claiming
 * creation there describes an edit as a creation, and this validator refuses the descriptor
 * rather than let a journal carry that claim — which is the whole of its effect today, because
 * restoration reads the `before` snapshot and not this flag. Keep it that way: the flag is the
 * recorded intent, and a future branch that acts on it would need this invariant to be true.
 */
function ownsExistence(created: unknown, existedBefore: boolean, existsAfter: boolean): boolean {
  return created === true ? !existedBefore || !existsAfter : existedBefore;
}

export function validateFileAction(action: OperationAction, applied = false): void {
  if (action.kind !== "file" || !normalizedAbsolute(action.path) || !normalizedAbsolute(action.realPath)) {
    throw invalidRecoveryAction(action.path, "file action paths are invalid");
  }
  const before = validFileSnapshot(action.before, action.path, "before", true, false);
  const after = validFileSnapshot(action.after, action.path, "after", applied, !applied);
  if ((before.exists && before.realPath !== action.realPath) || (after.exists && after.realPath !== action.realPath)) {
    throw invalidRecoveryAction(action.path, "file action realPath does not match its snapshot");
  }
  // A missing snapshot records the physical path a future write/removal would take. Keep it
  // tied to the descriptor even before a target inode exists; the only exception is lexical
  // symlink removal, where the entry disappears while its referent remains at realPath.
  if (!before.exists && before.resolvedPath !== action.realPath) {
    throw invalidRecoveryAction(action.path, "file action missing before path does not match realPath");
  }
  if (!after.exists && !(before.exists && before.symbolicLink) && after.resolvedPath !== action.realPath) {
    throw invalidRecoveryAction(action.path, "file action missing after path does not match realPath");
  }
  const metadata = action.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata) ||
      !Object.hasOwn(metadata, "created") || !Object.hasOwn(metadata, "createdDir") ||
      !Object.hasOwn(metadata, "requestedMode") ||
      Object.keys(metadata).some((key) => !["created", "createdDir", "requestedMode", "removedSymlink", "preparedWrite", "restoreWitness", "restoreTemporary", "aliases"].includes(key))) {
    throw invalidRecoveryAction(action.path, "file provenance is invalid");
  }
  if (typeof metadata.created !== "boolean" || typeof metadata.createdDir !== "boolean" ||
      (metadata.requestedMode !== null &&
        (typeof metadata.requestedMode !== "number" || !Number.isInteger(metadata.requestedMode) || metadata.requestedMode < 0 || metadata.requestedMode > 0o7777)) ||
      (Object.hasOwn(metadata, "removedSymlink") && typeof metadata.removedSymlink !== "boolean") ||
      !ownsExistence(metadata.created, before.exists === true, after.exists === true)) {
    throw invalidRecoveryAction(action.path, "file provenance is invalid");
  }
  const removedSymlink = before.exists && before.symbolicLink && !after.exists;
  if (removedSymlink && metadata.removedSymlink !== true) {
    throw invalidRecoveryAction(action.path, "symlink removal provenance is missing");
  }
  if (!removedSymlink && metadata.removedSymlink === true) {
    throw invalidRecoveryAction(action.path, "symlink removal provenance is inconsistent");
  }
  if (Object.hasOwn(metadata, "preparedWrite")) {
    const prepared = snapshotRecord(metadata.preparedWrite!);
    if (prepared === null || Object.keys(prepared).sort().join(",") !== "parentIdentity,snapshot,temporary" || !identityTextValue(prepared.parentIdentity) ||
        !normalizedPath(prepared.temporary) || dirname(prepared.temporary) !== dirname(action.realPath) ||
        !basename(prepared.temporary).startsWith(`.${basename(action.realPath)}.tonedial-write-`)) {
      throw invalidRecoveryAction(action.path, "prepared file provenance is invalid");
    }
    const witness = validFileSnapshot(prepared.snapshot!, action.path, "after", true, false);
    if (witness.symbolicLink || witness.realPath !== prepared.temporary || after.exists !== true ||
        after.targetIdentity !== witness.targetIdentity || after.bytes !== witness.bytes || after.mode !== witness.mode) {
      throw invalidRecoveryAction(action.path, "prepared file witness is inconsistent");
    }
  }
  if (Object.hasOwn(metadata, "restoreWitness")) {
    const restored = validFileSnapshot(metadata.restoreWitness!, action.path, "before", true, false);
    const absentRestoration = before.exists === false && restored.exists === false;
    if (absentRestoration) {
      if (restored.resolvedPath !== action.realPath || metadata.restoreTemporary !== null) {
        throw invalidRecoveryAction(action.path, "restoration absence witness is inconsistent");
      }
    } else if (before.exists !== true || restored.realPath !== action.realPath || restored.bytes !== before.bytes ||
        restored.mode !== before.mode || restored.symbolicLink !== before.symbolicLink || restored.linkTarget !== before.linkTarget ||
        !normalizedPath(metadata.restoreTemporary) || dirname(metadata.restoreTemporary) !== dirname(removedSymlink ? action.path : action.realPath) ||
        !basename(metadata.restoreTemporary).startsWith(`.${basename(removedSymlink ? action.path : action.realPath)}.tonedial-write-`)) {
      throw invalidRecoveryAction(action.path, "restoration witness is inconsistent");
    }
  } else if (Object.hasOwn(metadata, "restoreTemporary")) {
    throw invalidRecoveryAction(action.path, "restoration temporary has no witness");
  }
  if (Object.hasOwn(metadata, "aliases")) {
    if (!Array.isArray(metadata.aliases) || metadata.aliases.length === 0 || after.exists !== true) {
      throw invalidRecoveryAction(action.path, "physical write aliases are invalid");
    }
    const paths = new Set([action.path]);
    for (const value of metadata.aliases) {
      const alias = snapshotRecord(value);
      if (alias === null || Object.keys(alias).sort().join(",") !== "after,before,path" || !normalizedPath(alias.path) || paths.has(alias.path)) {
        throw invalidRecoveryAction(action.path, "physical write alias path is invalid");
      }
      paths.add(alias.path);
      const original = validFileSnapshot(alias.before!, alias.path, "before", true, false);
      const landing = validFileSnapshot(alias.after!, alias.path, "after", applied, !applied);
      if (original.resolvedPath !== action.realPath || original.exists !== before.exists || original.bytes !== before.bytes ||
          original.mode !== before.mode || original.targetIdentity !== before.targetIdentity || landing.exists !== true ||
          landing.realPath !== action.realPath || landing.bytes !== after.bytes || landing.mode !== after.mode ||
          landing.targetIdentity !== after.targetIdentity ||
          (landing.targetIdentity !== null && (landing.symbolicLink !== original.symbolicLink || landing.linkTarget !== original.linkTarget ||
            landing.pathIdentity !== (original.symbolicLink ? original.pathIdentity : landing.targetIdentity)))) {
        throw invalidRecoveryAction(action.path, "physical write alias snapshots are inconsistent");
      }
    }
  }
}

const CASE_RENAME_KIND = "case-rename" as const;
const CASE_RENAME_SCHEMA = 1 as const;

type CaseRenameMetadata = {
  schema: typeof CASE_RENAME_SCHEMA;
  source: string;
  destination: string;
  temporary: string;
  boundary: string;
  boundaryIdentity: string;
  parentPath: string;
  parentIdentity: string;
};

type CaseRenameActionValidation = {
  metadata: CaseRenameMetadata;
  before: Record<string, JsonValue>;
  after: Record<string, JsonValue>;
};

function normalizedPath(value: unknown): value is string {
  return normalizedAbsolute(value) && !value.includes("\0");
}

function lexicallyInside(target: string, boundary: string): boolean {
  const remainder = relative(resolve(boundary), resolve(target));
  return remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}

function sameCaseName(left: string, right: string): boolean {
  return left !== right && left.toLowerCase() === right.toLowerCase();
}

function caseDirectoryNames(parent: string, t: Messages): string[] {
  try {
    const entry = lstatSync(parent, { throwIfNoEntry: false });
    if (entry === undefined || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("parent is not a regular directory");
    }
    return readdirSync(parent);
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(t.errors.unreadableTarget(parent, (cause as Error).message));
  }
}

function caseDirectoryNamesOrNull(parent: string): string[] | null {
  try {
    const entry = lstatSync(parent, { throwIfNoEntry: false });
    if (entry === undefined || !entry.isDirectory() || entry.isSymbolicLink()) return null;
    return readdirSync(parent);
  } catch {
    return null;
  }
}

function missingJournalSnapshot(path: string): JsonValue {
  const parent = nearestParent(path);
  return {
    exists: false,
    resolvedPath: parent.resolvedPath,
    realPath: null,
    symbolicLink: false,
    linkTarget: null,
    mode: null,
    pathIdentity: null,
    targetIdentity: null,
    parentIdentity: parent.identity,
    parentPath: parent.path,
  };
}

/**
 * Capture a lexical entry rather than letting a case-insensitive filesystem turn an absent
 * spelling into an alias of its sibling. Historical recovery must locate the recorded entry.
 */
function lexicalJournalSnapshot(path: string, t: Messages): { present: boolean; snapshot: JsonValue } {
  const present = caseDirectoryNames(dirname(path), t).includes(basename(path));
  return {
    present,
    snapshot: present ? snapshotForJournal(path, t) : missingJournalSnapshot(path),
  };
}

function caseMetadata(action: OperationAction): CaseRenameMetadata {
  if (action.kind !== CASE_RENAME_KIND || !normalizedPath(action.path) || !normalizedPath(action.realPath)) {
    throw invalidRecoveryAction(action.path, "case-rename action paths are invalid");
  }
  const value = snapshotRecord(action.metadata ?? null);
  const keys = [
    "boundary", "boundaryIdentity", "destination", "parentIdentity", "parentPath", "schema", "source", "temporary",
  ];
  if (value === null || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    throw invalidRecoveryAction(action.path, "case-rename provenance is invalid");
  }
  const source = value.source;
  const destination = value.destination;
  const temporary = value.temporary;
  const boundary = value.boundary;
  const boundaryIdentity = value.boundaryIdentity;
  const parentPath = value.parentPath;
  const parentIdentity = value.parentIdentity;
  if (value.schema !== CASE_RENAME_SCHEMA || !normalizedPath(source) || !normalizedPath(destination) ||
      !normalizedPath(temporary) || !normalizedPath(boundary) || !identityTextValue(boundaryIdentity) ||
      !normalizedPath(parentPath) || !identityTextValue(parentIdentity) ||
      source !== action.path || destination !== action.realPath || dirname(source) !== parentPath ||
      dirname(destination) !== parentPath || dirname(temporary) !== parentPath ||
      source === destination || source === temporary || destination === temporary ||
      !sameCaseName(basename(source), basename(destination)) ||
      !lexicallyInside(source, boundary) || !lexicallyInside(destination, boundary) ||
      !lexicallyInside(temporary, boundary) || action.id !== `case-rename:${source}:${destination}:${temporary}`) {
    throw invalidRecoveryAction(action.path, "case-rename provenance is inconsistent");
  }
  return {
    schema: CASE_RENAME_SCHEMA,
    source,
    destination,
    temporary,
    boundary,
    boundaryIdentity,
    parentPath,
    parentIdentity,
  };
}

function validateCaseRenameAction(action: OperationAction, applied = false): CaseRenameActionValidation {
  const metadata = caseMetadata(action);
  const before = validFileSnapshot(action.before, action.path, "before", true, false);
  const after = validFileSnapshot(action.after, action.path, "after", applied, !applied);
  if (before.exists !== true || before.symbolicLink !== false || before.realPath === null ||
      typeof before.bytes !== "string" || !base64Value(before.bytes) ||
      (after.exists && (after.symbolicLink !== false || typeof after.bytes !== "string" || !base64Value(after.bytes))) ||
      (after.exists && (after.pathIdentity !== before.pathIdentity || after.targetIdentity !== before.targetIdentity ||
        after.mode !== before.mode || after.bytes !== before.bytes))) {
    throw invalidRecoveryAction(action.path, "case-rename snapshots do not preserve the source file");
  }
  if (applied && after.exists !== true) {
    throw invalidRecoveryAction(action.path, "case-rename after snapshot is incomplete");
  }
  return { metadata, before, after };
}

/**
 * Whether the recorded paths still sit under the boundary the action was planned against.
 *
 * One predicate rather than two copies: detection returns it and recovery throws on it, and a
 * rule about what is in bounds that is written down twice is a rule that will be tightened once.
 */
function caseRenameBoundaryHolds(metadata: CaseRenameMetadata): boolean {
  try {
    return parentIdentityAt(metadata.boundary) === metadata.boundaryIdentity &&
      parentIdentityAt(metadata.parentPath) === metadata.parentIdentity &&
      canonicalInside(metadata.source, metadata.boundary) &&
      canonicalInside(metadata.destination, metadata.boundary) &&
      canonicalInside(metadata.temporary, metadata.boundary);
  } catch {
    return false;
  }
}

function assertCaseRenameBoundary(metadata: CaseRenameMetadata, t: Messages): void {
  if (!caseRenameBoundaryHolds(metadata)) throw new ConfigError(t.errors.staleTarget(metadata.source));
}

/**
 * Move a regular file to a name that must not already exist yet.
 *
 * `renameSync` replaces whatever sits at its destination, so a directory listing taken
 * beforehand only narrows the window in which someone else's file is destroyed without trace —
 * this action records no bytes for a destination it never expected to find. `link` lets the
 * kernel make that decision instead: it fails with `EEXIST` and touches nothing. The pair is one
 * move because `caseMetadata` forces all three paths to share a parent, so they share a device.
 *
 * On a case-insensitive filesystem `link(tone.md, TONE.md)` resolves to the source itself and
 * reports `EEXIST`, which is the same reason the rename goes through a distinctly named
 * temporary sibling rather than straight to its final spelling.
 */
function moveWithoutReplacing(from: string, to: string, t: Messages): void {
  try {
    linkSync(from, to);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConfigError(t.errors.ownershipConflict(to));
    }
    throw new ConfigError(t.errors.couldNotWrite(to, (cause as Error).message, []));
  }
  try {
    unlinkSync(from);
  } catch (cause) {
    // The new name already holds the file, so report the stranded old one rather than removing
    // the link that just succeeded: a caller can see both names and neither has lost content.
    throw new ConfigError(t.errors.couldNotWrite(from, (cause as Error).message, [to]));
  }
}

function sameRenamedFileSnapshot(actual: JsonValue, expected: JsonValue): boolean {
  const current = snapshotRecord(actual);
  const planned = snapshotRecord(expected);
  if (current === null || planned === null || current.exists !== true || planned.exists !== true ||
      current.symbolicLink !== false || planned.symbolicLink !== false) return false;
  for (const field of ["mode", "pathIdentity", "targetIdentity", "bytes"] as const) {
    if (JSON.stringify(current[field]) !== JSON.stringify(planned[field])) return false;
  }
  return normalizedPath(current.resolvedPath) && normalizedPath(current.realPath) &&
    normalizedPath(planned.resolvedPath) && normalizedPath(planned.realPath);
}


/** Match a completed case-rename receipt to a freshly planned uppercase artifact read. */
export function caseRenameMatchesCurrent(action: OperationAction, change: Change): boolean {
  let validation: CaseRenameActionValidation;
  try {
    // Keep this first: an invalid journal descriptor must not trigger any filesystem reads.
    validation = validateCaseRenameAction(action, true);
  } catch {
    return false;
  }
  const { metadata, after } = validation;
  if (change.path !== metadata.destination || change.snapshot.bytes === null || change.snapshot.symbolicLink) return false;
  if (!caseRenameBoundaryHolds(metadata)) return false;
  try {
    const names = caseDirectoryNamesOrNull(metadata.parentPath);
    if (names === null) return false;
    if (!names.includes(basename(metadata.destination)) || names.includes(basename(metadata.source))) return false;
  } catch {
    return false;
  }
  return sameJournalSnapshot(snapshotJson(change.snapshot), after);
}

/**
 * Which of the action's three names currently holds the file it recorded, if any.
 *
 * Identity and bytes decide this, never the spelling alone. A rename preserves the inode, so the
 * recorded `before` snapshot identifies the same file under whichever name it now sits — which
 * is what lets recovery act on the window between the second move and its journal checkpoint.
 * In that window the destination is correct on disk while the journal's `after` still records
 * the absence observed at plan time; reading only `after` would report the success state as
 * unrecoverable and leave the user with a pending journal no command can clear.
 *
 * `source` additionally requires the other two names to be free, so a stranded temporary is
 * reported rather than quietly accepted as a completed revert.
 */
function caseRenamePlacement(
  validation: CaseRenameActionValidation,
  t: Messages,
): { position: "source" | "temporary" | "destination" | "unknown"; leftover: string | null } {
  const { metadata, before, after } = validation;
  const source = lexicalJournalSnapshot(metadata.source, t);
  const temporary = lexicalJournalSnapshot(metadata.temporary, t);
  const destination = lexicalJournalSnapshot(metadata.destination, t);
  if (source.present) {
    const reverted = !temporary.present && !destination.present && sameJournalSnapshot(source.snapshot, before);
    return { position: reverted ? "source" : "unknown", leftover: null };
  }
  const atTemporary = temporary.present && sameRenamedFileSnapshot(temporary.snapshot, before);
  const atDestination = destination.present &&
    ((after.exists === true && sameJournalSnapshot(destination.snapshot, after)) ||
      sameRenamedFileSnapshot(destination.snapshot, before));
  // Both names holding one inode is this action's own doing: a move is a link followed by an
  // unlink, and a death in between leaves the file reachable under each. The destination is
  // where the move was going, so recover from there and drop the leftover link — which is safe
  // to remove precisely because it is provably the same inode, not a second file.
  if (atTemporary && atDestination) return { position: "destination", leftover: metadata.temporary };
  if (atTemporary) return { position: "temporary", leftover: null };
  // The mirror state — source and temporary both holding one inode, from a death inside the
  // *first* move — is deliberately left to the source branch above, which refuses while a
  // temporary is present. The same inode proof would justify cleaning it automatically; the
  // difference is that there the file is still at the name the user knows, so reporting it and
  // stopping costs them nothing, while here the artifact is only at the new name.
  if (atDestination && !temporary.present) return { position: "destination", leftover: null };
  return { position: "unknown", leftover: null };
}

function probeCaseRenameAction(action: OperationAction, t: Messages): RollbackActionStatus {
  try {
    const validation = validateCaseRenameAction(action, false);
    assertCaseRenameBoundary(validation.metadata, t);
    const { position } = caseRenamePlacement(validation, t);
    if (position === "source") return "already-reverted";
    return position === "unknown" ? "changed" : "applied";
  } catch {
    return "changed";
  }
}

function restoreCaseRenameAction(action: OperationAction, t: Messages): RollbackActionOutcome {
  const validation = validateCaseRenameAction(action, false);
  assertCaseRenameBoundary(validation.metadata, t);
  const { metadata } = validation;
  const { position, leftover } = caseRenamePlacement(validation, t);
  if (position === "source") return "already-reverted";
  if (position === "unknown") {
    throw new ConfigError(`${metadata.source} changed after the operation; preserving it for manual recovery`);
  }
  if (leftover !== null) {
    try {
      unlinkSync(leftover);
    } catch (cause) {
      throw new ConfigError(t.errors.couldNotWrite(leftover, (cause as Error).message, []));
    }
  }
  // Coming back from the destination is the same case-only move the forward path refuses to make
  // in one step: where the filesystem folds case, the old spelling resolves to the file already
  // sitting at the new one, so the move is declined. Go back through the recorded temporary
  // sibling, which this position has already proved to be free.
  const steps: readonly (readonly [string, string])[] = position === "temporary"
    ? [[metadata.temporary, metadata.source]]
    : [[metadata.destination, metadata.temporary], [metadata.temporary, metadata.source]];
  for (const [from, to] of steps) moveWithoutReplacing(from, to, t);
  // The forward path proves its own post-condition before reporting success, and restoring is
  // where a false success costs most: the journal would be marked rolled back over a state that
  // never came back. Confirm the old spelling is present and every name moved through is free.
  const names = caseDirectoryNames(metadata.parentPath, t);
  const cleared = [...steps.map(([from]) => from), ...(leftover === null ? [] : [leftover])];
  if (!names.includes(basename(metadata.source)) || cleared.some((path) => names.includes(basename(path)))) {
    throw new ConfigError(`${metadata.source} could not be restored to its original spelling; preserving it for manual recovery`);
  }
  return "restored";
}

/** Confirm that a symlink referent was preserved, not replaced while the link was absent. */
function referentMatchesBefore(action: OperationAction, before: Record<string, JsonValue>, t: Messages): boolean {
  const expectedIdentity = before.targetIdentity;
  const expectedMode = before.mode;
  const expectedBytes = before.bytes;
  if (typeof expectedIdentity !== "string" || typeof expectedMode !== "number" ||
      typeof expectedBytes !== "string" || before.realPath !== action.realPath) return false;

  let current: TargetSnapshot;
  try {
    current = targetSnapshot(action.realPath, t);
  } catch {
    return false;
  }
  if (!current.exists || current.symbolicLink || current.realPath !== action.realPath ||
      current.targetIdentity !== expectedIdentity || current.mode !== expectedMode) return false;

  try {
    return Buffer.from(expectedBytes, "base64").equals(targetBytes(action.realPath, current, t));
  } catch {
    return false;
  }
}

function isSymlinkRemoval(before: Record<string, JsonValue> | null, after: Record<string, JsonValue> | null): boolean {
  return before?.exists === true && before.symbolicLink === true && after?.exists === false;
}

export function validateRollbackJournal(journal: OperationJournal): void {
  const completed = new Set(journal.completed);
  for (const [index, action] of journal.actions.entries()) {
    try {
      if (action.kind === "file") {
        validateFileAction(action, completed.has(index));
      } else if (action.kind === CASE_RENAME_KIND) {
        validateCaseRenameAction(action, completed.has(index));
      } else if (action.kind === "skill") {
        validateSkillAction(action, completed.has(index));
      } else if (action.kind === "entry-rebuild") {
        const { metadata } = validateEntryRebuildAction(action, completed.has(index));
        if (metadata.boundary !== journal.root) throw invalidRecoveryAction(action.path, "lexical rebuild root does not match its operation");
      } else {
        throw invalidRecoveryAction(action.path, `unsupported action kind ${action.kind}`);
      }
    } catch (cause) {
      if (cause instanceof ConfigError) throw cause;
      throw invalidRecoveryAction(action.path, "action semantics are invalid");
    }
  }
}

function probeAction(action: OperationAction, t: Messages): RollbackActionStatus {
  if (action.kind === "entry-rebuild") return probeEntryRebuild(action, t);
  if (action.kind === "file") {
    const before = snapshotRecord(action.before);
    const after = snapshotRecord(action.after);
    if (before !== null && isSymlinkRemoval(before, after)) {
      // Journals written before lexical-only deletion could have removed the referent. They are
      // intentionally not guessed at: restoring bytes to an ambiguous physical path can destroy
      // a replacement made after the interruption.
      if (!metadataBoolean(action, "removedSymlink")) return "unsupported";
      let current: JsonValue;
      try {
        current = snapshotForJournal(action.path, t);
      } catch {
        return "changed";
      }
      if (fileRestoreMatches(current, action)) {
        return "already-reverted";
      }
      if (after !== null && sameJournalSnapshot(current, action.after)) {
        return referentMatchesBefore(action, before, t) ? "applied" : "changed";
      }
      return "changed";
    }
    const current = snapshotForJournal(action.path, t);
    if (fileRestoreMatches(current, action)) {
      return aliasesMatchCurrent(action, snapshotRecord(action.metadata ?? null)?.restoreWitness !== undefined ? "restored" : "before", t)
        ? "already-reverted" : "changed";
    }
    if (after !== null && snapshotHasIdentity(after) && sameJournalSnapshot(current, action.after)) {
      return aliasesMatchCurrent(action, "after", t) ? "applied" : "changed";
    }
    if (after?.exists === false && sameJournalSnapshot(current, action.after)) return "applied";
    return "changed";
  }
  if (action.kind === "skill") {
    return probeSkillAction(action);
  }
  if (action.kind === CASE_RENAME_KIND) {
    return probeCaseRenameAction(action, t);
  }
  return "unsupported";
}

/** A completed rollback restores prior evidence; it does not establish forward ownership. */
export function restoredArtifactMatchesCurrent(action: OperationAction, change: Change, t: Messages): boolean {
  if (action.path !== change.path || change.snapshot.bytes === null || change.snapshot.symbolicLink) return false;
  try {
    // Validate before probing any journal path, including the case action's temporary name.
    if (action.kind === "file") validateFileAction(action, false);
    else if (action.kind === CASE_RENAME_KIND) validateCaseRenameAction(action, false);
    else return false;
    const captured = snapshotJson(change.snapshot);
    const matches = action.kind === CASE_RENAME_KIND
      ? sameJournalSnapshot(captured, action.before)
      : fileRestoreMatches(captured, action);
    return matches && probeAction(action, t) === "already-reverted";
  } catch {
    return false;
  }
}

type RollbackActionOutcome = "restored" | "already-reverted";

function assertAppliedFileLocation(action: OperationAction, t: Messages): void {
  assertActionAliases(action, "after", t);
  const after = snapshotRecord(action.after)!;
  const current = targetSnapshot(action.path, t);
  if (after.exists === false) {
    if (current.exists || current.resolvedPath !== after.resolvedPath ||
        parentIdentityAt(after.parentPath as string) !== after.parentIdentity) throw invalidRecoveryAction(action.path, "entry changed before restoration");
    return;
  }
  const actual = snapshotRecord(snapshotJson(current))!;
  if (snapshotFields.some((field) => JSON.stringify(actual[field]) !== JSON.stringify(after[field]))) {
    throw invalidRecoveryAction(action.path, "entry changed before restoration");
  }
}

function fileRestoreMatches(current: JsonValue, action: OperationAction): boolean {
  const restored = snapshotRecord(action.metadata ?? null)?.restoreWitness;
  return sameJournalSnapshot(current, action.before) || (restored !== undefined && sameJournalSnapshot(current, restored));
}

function restoreFileAction(action: OperationAction, t: Messages, checkpoint: (updated: OperationAction) => void): RollbackActionOutcome {
  // Keep the direct executor safe as well as the journal dispatcher: all descriptor semantics are
  // checked before the first snapshot probe or restoration side effect.
  validateFileAction(action, true);
  const before = snapshotRecord(action.before);
  const after = snapshotRecord(action.after);
  if (before === null || after === null) throw new ConfigError(`cannot safely recover ${action.path}: its snapshots are invalid`);
  if (isSymlinkRemoval(before, after)) {
    if (!metadataBoolean(action, "removedSymlink")) {
      throw new ConfigError(`${action.path} uses an older journal that may have deleted its symlink referent; manual recovery is required`);
    }
    let current: JsonValue;
    try {
      current = snapshotForJournal(action.path, t);
    } catch {
      throw new ConfigError(`${action.path} changed after the operation; preserving it for manual recovery`);
    }
    // An uncheckpointed recreated link cannot be distinguished from a user's replacement.
    // Keep its identity in the comparison and leave ambiguous interrupted recovery unresolved.
    if (fileRestoreMatches(current, action)) return "already-reverted";
    if (!sameJournalSnapshot(current, action.after) || !referentMatchesBefore(action, before, t)) {
      throw new ConfigError(`${action.path} changed after the operation; preserving it for manual recovery`);
    }
    const linkTarget = before.linkTarget;
    if (typeof linkTarget !== "string") {
      throw new ConfigError(`cannot safely recover ${action.path}: its original symlink target is unavailable`);
    }
    try {
      const temporary = join(dirname(action.path), `.${basename(action.path)}.tonedial-write-${randomBytes(16).toString("hex")}`);
      const parent = lstatSync(dirname(action.path), { bigint: true });
      const identity = `${parent.dev}:${parent.ino}`;
      assertAppliedFileLocation(action, t);
      assertDirectoryIdentity(dirname(action.path), identity, t);
      symlinkSync(linkTarget, temporary);
      const witness = snapshotRecord(snapshotForJournal(temporary, t))!;
      const restored: JsonValue = { ...witness, resolvedPath: action.realPath, realPath: action.realPath };
      checkpoint({ ...action, metadata: { ...snapshotRecord(action.metadata ?? null), restoreTemporary: temporary, restoreWitness: restored } });
      assertAppliedFileLocation(action, t);
      assertDirectoryIdentity(dirname(action.path), identity, t);
      if (!sameJournalSnapshot(snapshotForJournal(action.path, t), action.after) || !referentMatchesBefore(action, before, t)) {
        throw invalidRecoveryAction(action.path, "entry changed before link restoration");
      }
      const named = lstatSync(temporary, { bigint: true, throwIfNoEntry: false });
      if (!named?.isSymbolicLink() || `${named.dev}:${named.ino}` !== witness.pathIdentity || readlinkSync(temporary) !== witness.linkTarget) {
        throw invalidRecoveryAction(action.path, "prepared link changed before restoration");
      }
      assertDirectoryIdentity(dirname(action.path), identity, t);
      moveEntry(temporary, action.path);
      if (!sameJournalSnapshot(snapshotForJournal(action.path, t), restored)) throw invalidRecoveryAction(action.path, "restored link was replaced");
    } catch (cause) {
      throw new ConfigError(t.errors.couldNotWrite(action.path, (cause as Error).message, []));
    }
    return "restored";
  }
  if (after.exists === true && !snapshotHasIdentity(after)) {
    // A process can die between its final write and its checkpoint. Bytes alone would let a
    // foreign equal-content replacement be adopted, so leave that action unresolved.
    throw new ConfigError(`cannot safely recover ${action.path}: its applied identity was not checkpointed`);
  }
  const current = snapshotForJournal(action.path, t);
  if (fileRestoreMatches(current, action)) {
    assertActionAliases(action, snapshotRecord(action.metadata ?? null)?.restoreWitness !== undefined ? "restored" : "before", t);
    return "already-reverted";
  }
  if (!sameJournalSnapshot(current, action.after)) {
    throw new ConfigError(`${action.path} changed after the operation; preserving it for manual recovery`);
  }
  assertActionAliases(action, "after", t);
  if (before.exists !== true) {
    if (current !== null && after.exists === true) {
      try {
        const restored = missingJournalSnapshot(action.path);
        checkpoint({ ...action, metadata: { ...snapshotRecord(action.metadata ?? null), restoreTemporary: null, restoreWitness: restored } });
        assertAppliedFileLocation(action, t);
        if (!sameJournalSnapshot(snapshotForJournal(action.path, t), action.after)) {
          throw invalidRecoveryAction(action.path, "entry changed before deletion");
        }
        // This action created a regular file, never a directory tree. A directory swapped in
        // after the snapshot must survive; lexical parent aliases name this same file entry.
        rmSync(action.realPath, { force: false });
        const observed = snapshotForJournal(action.path, t);
        const absent = snapshotRecord(observed)!;
        if (absent.exists !== false || absent.resolvedPath !== action.realPath) throw invalidRecoveryAction(action.path, "restored absence changed");
        // No parent is removed by rollback. A real replacement parent may remain after the
        // witnessed file deletion; bind its observed absence without claiming that directory.
        if (!sameJournalSnapshot(observed, restored)) {
          checkpoint({ ...action, metadata: { ...snapshotRecord(action.metadata ?? null), restoreTemporary: null, restoreWitness: observed } });
        }
      } catch (cause) {
        throw new ConfigError(t.errors.couldNotWrite(action.path, (cause as Error).message, []));
      }
    }
    // `createdDir` records that a parent was absent, but the journal has no identity for the
    // newly-created directory itself. A same-path replacement can therefore look empty while
    // belonging to someone else; retain that ambiguous parent rather than removing it during
    // recovery. The normal forward commit still uses its reviewed `Change` ownership proof.
    return "restored";
  }
  const bytes = before.bytes;
  const mode = before.mode;
  if (typeof bytes !== "string" || typeof mode !== "number" || !Number.isInteger(mode)) {
    throw new ConfigError(`cannot safely recover ${action.path}: its original bytes are unavailable`);
  }
  try {
    const prepared = prepareRegularWrite(action.realPath, Buffer.from(bytes, "base64"), mode, t,
      () => assertAppliedFileLocation(action, t));
    const restored = preparedLanding(prepared.snapshot, action.realPath, before);
    const updated = { ...action, metadata: { ...snapshotRecord(action.metadata ?? null), restoreTemporary: prepared.temporary, restoreWitness: restored } };
    checkpoint(updated);
    assertAppliedFileLocation(action, t);
    assertDirectoryIdentity(dirname(action.realPath), prepared.parentIdentity, t);
    if (!sameJournalSnapshot(snapshotForJournal(prepared.temporary, t), prepared.snapshot) ||
        (after.exists === true && !sameJournalSnapshot(snapshotForJournal(action.path, t), action.after))) {
      throw invalidRecoveryAction(action.path, "entry changed before restoration");
    }
    assertAppliedFileLocation(action, t);
    assertDirectoryIdentity(dirname(action.realPath), prepared.parentIdentity, t);
    moveEntry(prepared.temporary, action.realPath);
    if (!sameJournalSnapshot(snapshotForJournal(action.path, t), restored)) throw invalidRecoveryAction(action.path, "restored file was replaced");
    assertActionAliases(updated, "restored", t);
  } catch (cause) {
    throw new ConfigError(t.errors.couldNotWrite(action.path, (cause as Error).message, []));
  }
  return "restored";
}

export type RollbackActionStatus = "applied" | "already-reverted" | "changed" | "unsupported";

export type RollbackPreviewAction = {
  index: number;
  kind: string;
  path: string;
  realPath: string;
  status: RollbackActionStatus;
  lines: string[];
};

export type RollbackPreview = {
  operationId: string;
  state: OperationState;
  status: "ready" | "busy" | "unresolved" | "superseded" | "not-found";
  actions: RollbackPreviewAction[];
  unresolved: string[];
};

export type RollbackResult = {
  operationId: string;
  state: "rolled-back" | "pending";
  restored: number;
  alreadyReverted: number;
  unresolved: string[];
};

/** Read-only recovery preview. It never claims the owner, creates a lock, or writes a target. */
export function previewRollback(paths: OperationPaths, operationId: string, t: Messages): RollbackPreview {
  let selection;
  try {
    selection = inspectRollback(paths, operationId);
  } catch (cause) {
    if (cause instanceof OperationError && cause.code === "not-found") {
      return { operationId, state: "pending", status: "not-found", actions: [], unresolved: [cause.message] };
    }
    throw cause;
  }
  const unresolved = selection.reason === undefined ? [] : [selection.reason];
  if (selection.status === "retired-for-app-rebuild") {
    return { operationId, state: selection.journal.state, status: "unresolved", actions: [], unresolved };
  }
  let semanticError: ConfigError | null = null;
  try {
    validateRollbackJournal(selection.journal);
  } catch (cause) {
    semanticError = cause instanceof ConfigError
      ? cause
      : new ConfigError("mutation journal action semantics are invalid");
    unresolved.push(semanticError.message);
  }
  const lock = inspectOperations(paths).lock;
  const busy = lock.state === "live" || lock.state === "unknown";
  const invalidLock = lock.state === "invalid";
  if (invalidLock) unresolved.push(lock.message ?? "operation lock is invalid");
  const actions = selection.journal.actions.map((action, index) => {
    // Invalid journal semantics or lock contents must not cause resource reads. The preview has
    // no "not probed" status, so retain the cause and mark those actions unsupported.
    const status = semanticError === null && !invalidLock ? probeAction(action, t) : "unsupported" as const;
    if (status === "changed" || status === "unsupported") unresolved.push(`${action.path}: ${status}`);
    return {
      index,
      kind: action.kind,
      path: action.path,
      realPath: action.realPath,
      status,
      lines: renderAction(action, palettePlain()),
    };
  });
  const hasUnresolvedAction = actions.some((action) => action.status === "changed" || action.status === "unsupported");
  const status = busy
    ? "busy"
    : selection.status === "superseded"
      ? "superseded"
      : !selection.allowed || invalidLock || hasUnresolvedAction
        ? "unresolved"
        : "ready";
  return {
    operationId: selection.journal.operationId,
    state: selection.journal.state,
    status,
    actions,
    unresolved,
  };
}

/** Apply a selected pending or retained migration journal through the shared operation owner. */
export function applyRollback(paths: OperationPaths, operationId: string, t: Messages): RollbackResult {
  const selection = inspectRollback(paths, operationId);
  if (!selection.allowed) {
    throw new OperationError("invalid", selection.reason ?? `mutation journal ${operationId} cannot be rolled back`);
  }
  let restored = 0;
  let alreadyReverted = 0;
  try {
    // Validate the whole descriptor set before claiming a recovery lease. This is pure journal
    // work; no target or skill resource may be probed until every action has passed its owner.
    validateRollbackJournal(selection.journal);
    rollbackOperation(paths, operationId, (journal, recovery) => {
      // Re-read and validate again under the recovery owner. The journal is user-visible JSON and
      // may have changed after the read-only selection, so the callback cannot rely on the first
      // validation as its proof for subsequent resource reads or writes.
      validateRollbackJournal(journal);
      const probes = journal.actions.map((action, index) => ({
        action,
        index,
        status: probeAction(action, t),
      }));
      const blocked = probes.filter(({ status }) => status === "changed" || status === "unsupported");
      if (blocked.length > 0) {
        throw new ConfigError(blocked.map(({ action, status }) => `${action.path}: ${status}`).join("; "));
      }
      // Resource actions are restored before the final ownership/config actions. If an external
      // edit is found, the final commit remains applied rather than being rolled back into a
      // false ownership state; the journal stays pending for a later explicit retry.
      const order = probes.sort((left, right) => {
        const leftFinal = left.action.id.includes(":final:") ||
          left.action.kind === "entry-rebuild" && snapshotRecord(left.action.metadata ?? null)?.reason === "restore-config" ? 1 : 0;
        const rightFinal = right.action.id.includes(":final:") ||
          right.action.kind === "entry-rebuild" && snapshotRecord(right.action.metadata ?? null)?.reason === "restore-config" ? 1 : 0;
        return leftFinal - rightFinal || right.index - left.index;
      });
      const remaining = [...journal.completed];
      const actions = [...journal.actions];
      for (const { action, index, status } of order) {
        let outcome: RollbackActionOutcome = "restored";
        if (status === "already-reverted") {
          outcome = "already-reverted";
        } else if (action.kind === "file") {
          outcome = restoreFileAction(action, t, (updated) => {
            actions[index] = updated;
            checkpointJournal(recovery.operation, remaining, actions);
          });
        } else if (action.kind === "entry-rebuild") {
          outcome = restoreEntryRebuild(action, t);
        } else if (action.kind === CASE_RENAME_KIND) {
          outcome = restoreCaseRenameAction(action, t);
        } else if (action.kind === "skill") {
          rollbackSkillAction(action, t);
        }
        const position = remaining.indexOf(index);
        if (position >= 0) remaining.splice(position, 1);
        checkpointJournal(recovery.operation, remaining, actions);
        if (outcome === "already-reverted") alreadyReverted++;
        else restored++;
      }
    });
    return { operationId, state: "rolled-back", restored, alreadyReverted, unresolved: [] };
  } catch (cause) {
    if (cause instanceof ConfigError) {
      return {
        operationId,
        state: "pending",
        restored,
        alreadyReverted,
        unresolved: [cause.message],
      };
    }
    throw cause;
  }
}

function renderAction(action: Pick<OperationAction, "kind" | "path" | "realPath">, ui: Palette, t?: Messages): string[] {
  // The kind leads and the path follows on its own line: a path folded to fit stops being
  // something a reader can copy, and a preview exists to be acted on.
  const display = t === undefined ? (value: string) => value : humanText;
  const label = t === undefined ? `[${action.kind}]` : Object.hasOwn(t.wiring.actionLabel, action.kind)
    ? t.wiring.actionLabel[action.kind as keyof typeof t.wiring.actionLabel] : humanText(action.kind);
  const lines = t === undefined
    ? [`  ${ui.bold(label)}`, `  ${display(action.path)}`]
    : [`  - ${ui.bold(label)}`, `    ${display(action.path)}`];
  if (action.realPath !== action.path) lines.push(`  ${ui.warn(`→ ${display(action.realPath)}`)}`);
  return lines;
}

export type GateOptions = {
  dryRun: boolean;
  auto: boolean;
  /** Expand only the human preview. The structured diff remains byte-for-byte compatible. */
  verbose?: boolean;
  ui: Palette;
  t: Messages;
  /** Human phase title, shown with the same preview before its approval. */
  heading?: string;
  /** Where the diff goes. It is written before the question, never returned to be printed after. */
  out?: ((text: string) => void) | undefined;
  /** Injected so tests can drive the gate without a terminal. */
  ask?: (question: string) => Promise<"yes" | "no">;
  interactive?: () => boolean;
  /** The state-root paths used by the shared mutation owner. */
  paths: OperationPaths;
  /** Non-text resources (for example a skill link) that share this gate's journal and lock. */
  operationActions?: PlannedOperationAction[];
  /** Final ownership/config changes, applied after `operationActions` in the same journal. */
  finalChanges?: Change[];
  /** Mark this journal as an explicitly approved delivery/schema/case migration backup. */
  retention?: OperationRetention;
  /** Recovery previews expose paths and caller-supplied field summaries, never file bodies. */
  recoveryPresentation?: boolean | { lines?: string[]; failureMessage?: (operationId: string) => string };
  /** Read back repaired state under the owner before its journal can become complete. */
  verify?: () => void | Promise<void>;
};

export type GateResult = {
  applied: boolean;
  lines: string[];
  reason: "written" | "dry-run" | "declined" | "nothing";
  /** The same diff, structured. `--json` used to carry none at all, which made "`--auto` skips
   *  the question, never the diff" false in exactly the mode the skill drives. */
  diff: { path: string; realPath: string; created: boolean; removed: boolean; lines: string[]; kind?: string }[];
  /** Present when this gate owned a shared operation. */
  operationId?: string;
};

/** Preview and approval precede one shared mutation journal; auto still retains the preview. */
export async function gate(changes: Change[], opts: GateOptions): Promise<GateResult> {
  const finalChanges = opts.finalChanges ?? [];
  for (const change of [...changes, ...finalChanges]) {
    if (change.readOnlySnapshot && !isNoop(change)) throw new ConfigError(opts.t.errors.staleTarget(change.path));
  }
  const effects = fileEffects(changes, finalChanges, opts.t);
  const real = changes.filter((c) => !isNoop(c));
  const finalReal = finalChanges.filter((c) => !isNoop(c));
  const operationActions = opts.operationActions ?? [];
  const lines: string[] = opts.heading === undefined ? [] : ["", `  ${opts.ui.bold(opts.ui.accent(`# ${opts.heading}`))}`];
  if (real.length === 0 && finalReal.length === 0 && operationActions.length === 0) {
    for (const change of [...changes, ...finalChanges]) assertFresh(change, opts.t);
    try { await opts.verify?.(); }
    catch (cause) {
      if (opts.recoveryPresentation) throw new ConfigError(opts.t.recovery.sourceInvalid);
      throw cause;
    }
    if (opts.heading !== undefined && !opts.auto && !opts.dryRun && (opts.interactive ?? interactive)()) {
      (opts.out ?? defaultOut)(`${lines.join("\n")}\n`);
      lines.length = 0;
    }
    return { applied: false, lines, reason: "nothing", diff: [] };
  }

  const plain = palettePlain();
  const fileDiff = (changes: Change[]) => changes.map((change) => ({
    path: change.path,
    realPath: change.realPath,
    created: change.created,
    removed: !writesRegular(change),
    lines: opts.recoveryPresentation ? renderAction({ kind: "file", path: change.path, realPath: change.realPath }, plain) : renderDiff(change, plain, opts.t),
  }));
  const actionDiff = operationActions.map((planned) => ({
    path: planned.action.path,
    realPath: planned.action.realPath,
    created: false,
    removed: false,
    kind: planned.action.kind,
    lines: renderAction(planned.action, plain),
  }));
  const diff = [...fileDiff(real), ...actionDiff, ...fileDiff(finalReal)];
  const renderHuman = opts.verbose === true ? renderVerboseDiff : renderSummary;
  if (typeof opts.recoveryPresentation === "object") lines.push(...(opts.recoveryPresentation.lines ?? []));
  for (const change of real) {
    lines.push(...(opts.recoveryPresentation ? renderAction({ kind: "file", path: change.path, realPath: change.realPath }, opts.ui, opts.t) : renderHuman(change, opts.ui, opts.t)));
    if (opts.verbose) lines.push("");
  }
  for (const action of operationActions) {
    lines.push(...renderAction(action.action, opts.ui, opts.t));
    if (opts.verbose) lines.push("");
  }
  for (const change of finalReal) {
    lines.push(...(opts.recoveryPresentation ? renderAction({ kind: "file", path: change.path, realPath: change.realPath }, opts.ui, opts.t) : renderHuman(change, opts.ui, opts.t)));
    if (opts.verbose) lines.push("");
  }

  if (!opts.recoveryPresentation && !opts.verbose && real.length + finalReal.length > 0) {
    lines.push(`  ${opts.ui.dim(opts.t.wiring.previewMore)}`);
  }

  if (opts.dryRun) return { applied: false, lines, reason: "dry-run", diff };

  if (!opts.auto) {
    // **Printed here, not returned.** The command's lines reach stdout only after `run()`
    // resolves, so a gate that buffered its diff asked for consent to something the user could
    // not see — and then printed it after the write, or after they declined.
    (opts.out ?? defaultOut)(`${lines.join("\n")}\n`);
    lines.length = 0;
    const canAsk = (opts.interactive ?? interactive)();
    if (!canAsk) {
      // Silence is not consent. A pipe cannot see the diff above, so assuming approval here
      // would make the unattended case the one with the least oversight.
      throw new ConfigError(opts.t.wiring.needsApproval);
    }
    const answer = await (opts.ask ?? confirm)(`  ${opts.t.wiring.applyQuestion(real.length + operationActions.length + finalReal.length)}`);
    if (answer === "no") return { applied: false, lines, reason: "declined", diff };
  }

  // Approval precedes acquisition so an interview never holds the mutation lock.
  let handle: OperationHandle<"mutation"> | undefined;
  const actions: OperationAction[] = effects.initial.map((effect, index) => effectAction(effect, "initial", index));
  actions.push(...operationActions.map((planned) => ({ ...planned.action })));
  actions.push(...effects.final.map((effect, index) => effectAction(effect, "final", index)));
  const done: string[] = [];
  let journalStarted = false;
  try {
    handle = acquireOperation(opts.paths, "mutation");
    // Revalidate every target, including content-equal/no-op changes, while this owner is held.
    // A managed seed can be unchanged in bytes yet have been replaced by another inode.
    for (const change of [...changes, ...finalChanges]) assertFresh(change, opts.t, opts.paths);
    for (const action of operationActions) action.assertFresh?.();

    beginJournal(handle, actions, opts.retention);
    journalStarted = true;
    const completed: number[] = [];
    const createdParents = new Map<string, string>();
    for (let index = 0; index < effects.initial.length; index++) {
      const change = effects.initial[index]!.change;
      try {
        actions[index] = prepareFileWrite(change, actions[index]!, opts.t);
        checkpointJournal(handle, completed, actions);
        publishFileWrite(change, actions[index]!, opts.t);
        done.push(change.path);
        actions[index] = updatedFileAction(change, actions[index]!, opts.t);
        completed.push(index);
        checkpointJournal(handle, completed, actions);
      } catch (cause) {
        throw new ConfigError(opts.t.errors.couldNotWrite(change.path, (cause as Error).message, done));
      }
    }
    for (let index = 0; index < operationActions.length; index++) {
      const planned = operationActions[index]!;
      const actionIndex = effects.initial.length + index;
      try {
        assertWrittenAliases(actions, completed, opts.t);
        planned.prepare?.((action) => {
          actions[actionIndex] = action;
          checkpointJournal(handle!, completed, actions);
        }, createdParents);
        planned.apply();
        done.push(planned.action.path);
        actions[actionIndex] = planned.after?.() ?? actions[actionIndex]!;
        completed.push(actionIndex);
        checkpointJournal(handle, completed, actions);
      } catch (cause) {
        throw new ConfigError(opts.t.errors.couldNotWrite(planned.action.path, (cause as Error).message, done));
      }
    }
    for (let index = 0; index < effects.final.length; index++) {
      const change = effects.final[index]!.change;
      const actionIndex = effects.initial.length + operationActions.length + index;
      try {
        assertWrittenAliases(actions, completed, opts.t);
        actions[actionIndex] = prepareFileWrite(change, actions[actionIndex]!, opts.t);
        checkpointJournal(handle, completed, actions);
        publishFileWrite(change, actions[actionIndex]!, opts.t);
        done.push(change.path);
        actions[actionIndex] = updatedFileAction(change, actions[actionIndex]!, opts.t);
        completed.push(actionIndex);
        checkpointJournal(handle, completed, actions);
      } catch (cause) {
        throw new ConfigError(opts.t.errors.couldNotWrite(change.path, (cause as Error).message, done));
      }
    }
    await opts.verify?.();
    assertWrittenAliases(actions, completed, opts.t);
    finishJournal(handle, "complete");
    releaseOperation(handle);
    return { applied: true, lines, reason: "written", diff, operationId: handle.owner.operationId };
  } catch (cause) {
    // A pending journal and its owner remain on disk deliberately. Releasing here would let a
    // second command overwrite resources whose first action may already have landed. Doctor can
    // later claim the explicit operation id and invoke the domain rollback executor.
    if (handle !== undefined && !journalStarted) {
      // Preview freshness or journal setup failed before any target write. This lock has no
      // recovery state to protect, so release only our own empty owner rather than blocking the
      // next command forever.
      try {
        releaseOperation(handle);
      } catch {
        // If ownership or lock contents changed, preserve them for explicit recovery.
      }
    }
    if (opts.recoveryPresentation && journalStarted) {
      const operationId = handle!.owner.operationId;
      throw new ConfigError(typeof opts.recoveryPresentation === "object" && opts.recoveryPresentation.failureMessage !== undefined
        ? opts.recoveryPresentation.failureMessage(operationId)
        : `app rebuild did not complete; preserve operation ${operationId} for recovery`);
    }
    if (cause instanceof ConfigError) throw cause;
    if (cause instanceof OperationError) throw new ConfigError(cause.message);
    const path = done.at(-1) ?? real[0]?.path ?? operationActions[0]?.action.path ?? opts.paths.root;
    throw new ConfigError(opts.t.errors.couldNotWrite(path, (cause as Error).message, done));
  }
}

const defaultOut = (text: string) => process.stdout.write(text);
// The structured diff is unpainted: escape sequences are for a terminal, and a consumer reading
// `--json` is not one.
const palettePlain = () => paletteFor("never", {}, false);
