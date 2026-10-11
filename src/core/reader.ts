// Hooks may run without PATH or after the package moves. The seeded reader is standalone.

import {
  CONTEXT_ARTIFACT_FILENAME,
  CONTEXT_GUIDE_FILENAME,
} from "./paths.ts";

export const READER_PROTOCOL_VERSION = 1 as const;
export const GUIDE_FORMAT_VERSION = 1 as const;
export const GUIDE_FORMAT_MARKER = `<!-- tonedial-guide:${GUIDE_FORMAT_VERSION} -->`;

/** Stable, short repair guidance shared by the emitted source and diagnostics. */
export const READER_REPAIR_HINTS = {
  arguments: "pass --provider and --state",
  provider: "choose codex, claude, or gemini",
  state: "use an absolute dedicated state root",
  "missing-state": "run tonedial init --tools none",
  "nonregular-state": "use a dedicated directory for TONEDIAL_HOME",
  "root-changed": "retry after the state root is stable",
  "outside-root": "use files contained by the dedicated state root",
  locked: "retry after the operation completes",
  "missing-guide": "run tonedial init --tools none",
  "missing-artifact": "run tonedial init --tools none",
  "unsupported-guide": "refresh the managed guide with tonedial init",
  symlink: "replace the context entry with a regular file through tonedial init",
  nonregular: "replace the context entry with a regular file through tonedial init",
  replaced: "retry after the context files are stable",
  changed: "retry after the context files are stable",
  "pair-changed": "retry after the context pair is stable",
  utf8: "rewrite the context file as UTF-8",
  unreadable: "run tonedial doctor and resolve the reported path",
} as const;

/**
 * A complete executable, intentionally independent of this package. It reads only the two
 * filenames derived from the explicit state root, never evaluates their text, and emits once all
 * bytes have been validated. Keep this as one concrete reader rather than a host/plugin registry.
 */
export const READER_SOURCE = String.raw`#!/usr/bin/env node
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const GUIDE_FILENAME = ${JSON.stringify(CONTEXT_GUIDE_FILENAME)};
const ARTIFACT_FILENAME = ${JSON.stringify(CONTEXT_ARTIFACT_FILENAME)};
const LOCK_FILENAME = "operations.lock";
const GUIDE_MARKER = ${JSON.stringify(GUIDE_FORMAT_MARKER)};
const REPAIR_HINTS = ${JSON.stringify(READER_REPAIR_HINTS)};
const PROVIDERS = new Set(["codex", "claude", "gemini"]);
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = constants.O_NONBLOCK ?? 0;

class ReaderFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function providerHint(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--provider") return args[index + 1] ?? null;
    if (args[index]?.startsWith("--provider=")) return args[index].slice("--provider=".length);
  }
  return null;
}

function parseArgs(args) {
  let provider = null;
  let state = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let name = argument;
    let value = null;
    if (argument === "--provider" || argument === "--state") {
      value = args[index + 1] ?? null;
      index += 1;
    } else if (argument?.startsWith("--provider=")) {
      name = "--provider";
      value = argument.slice("--provider=".length);
    } else if (argument?.startsWith("--state=")) {
      name = "--state";
      value = argument.slice("--state=".length);
    }
    if (name === "--provider") {
      if (provider !== null || value === null || value === "") throw new ReaderFailure("arguments");
      provider = value;
    } else if (name === "--state") {
      if (state !== null || value === null || value === "") throw new ReaderFailure("arguments");
      state = value;
    } else {
      throw new ReaderFailure("arguments");
    }
  }
  if (provider === null || state === null || !PROVIDERS.has(provider)) {
    throw new ReaderFailure(provider !== null && !PROVIDERS.has(provider) ? "provider" : "arguments");
  }
  if (!isAbsolute(state) || state.includes("\0")) throw new ReaderFailure("state");
  return { provider, state: resolve(state) };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameMetadata(left, right) {
  return left.mode === right.mode && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function rootSnapshot(state) {
  let lexical;
  let resolved;
  let real;
  try {
    lexical = lstatSync(state, { bigint: true, throwIfNoEntry: false });
    if (lexical === undefined) throw new ReaderFailure("missing-state");
    resolved = statSync(state, { bigint: true });
    if (!resolved.isDirectory()) throw new ReaderFailure("nonregular-state");
    real = realpathSync(state);
    const realStat = statSync(real, { bigint: true });
    if (!realStat.isDirectory() || !sameIdentity(realStat, resolved)) {
      throw new ReaderFailure("root-changed");
    }
  } catch (cause) {
    if (cause instanceof ReaderFailure) throw cause;
    throw new ReaderFailure("state");
  }
  return { lexical, resolved, real };
}

function sameRoot(left, right) {
  return left.real === right.real && sameIdentity(left.lexical, right.lexical) &&
    sameMetadata(left.lexical, right.lexical) && sameIdentity(left.resolved, right.resolved) &&
    sameMetadata(left.resolved, right.resolved);
}

function assertRoot(root, state) {
  const current = rootSnapshot(state);
  if (!sameRoot(root, current)) throw new ReaderFailure("root-changed");
}

function assertContained(root, state, path) {
  assertRoot(root, state);
  let parent;
  try {
    parent = realpathSync(dirname(path));
  } catch {
    throw new ReaderFailure("state");
  }
  const distance = relative(root.real, parent);
  if (distance === ".." || distance.startsWith(".." + sep) || isAbsolute(distance)) {
    throw new ReaderFailure("outside-root");
  }
}

function safeText(root, state, path, missingCode) {
  assertContained(root, state, path);
  let entry;
  try {
    entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  } catch {
    throw new ReaderFailure("unreadable");
  }
  if (entry === undefined) throw new ReaderFailure(missingCode);
  if (entry.isSymbolicLink()) throw new ReaderFailure("symlink");
  if (!entry.isFile()) throw new ReaderFailure("nonregular");

  let descriptor;
  try {
    assertContained(root, state, path);
    descriptor = openSync(path, constants.O_RDONLY | NON_BLOCKING | NO_FOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(entry, opened)) throw new ReaderFailure("replaced");
    if (lockPresent(state)) throw new ReaderFailure("locked");
    assertContained(root, state, path);
    const beforeBytes = fstatSync(descriptor, { bigint: true });
    if (!beforeBytes.isFile() || !sameIdentity(opened, beforeBytes) || !sameMetadata(opened, beforeBytes)) {
      throw new ReaderFailure("changed");
    }
    assertContained(root, state, path);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (named === undefined || !named.isFile() || !sameIdentity(named, opened) || !sameMetadata(after, opened)) {
      throw new ReaderFailure("changed");
    }
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        snapshot: after,
      };
    } catch {
      throw new ReaderFailure("utf8");
    }
  } catch (cause) {
    if (cause instanceof ReaderFailure) throw cause;
    throw new ReaderFailure("unreadable");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The payload is already suppressed if the descriptor could not be read; closing cannot
        // make a partial payload safe to emit.
      }
    }
  }
}

function lockPresent(state) {
  try {
    return lstatSync(join(state, LOCK_FILENAME), { throwIfNoEntry: false }) !== undefined;
  } catch {
    throw new ReaderFailure("state");
  }
}

function readPair(state) {
  const root = rootSnapshot(state);
  if (lockPresent(state)) throw new ReaderFailure("locked");
  const guidePath = join(state, GUIDE_FILENAME);
  const artifactPath = join(state, ARTIFACT_FILENAME);
  const guideRead = safeText(root, state, guidePath, "missing-guide");
  const firstLine = guideRead.text.split(/\r?\n/, 1)[0];
  if (firstLine !== GUIDE_MARKER) throw new ReaderFailure("unsupported-guide");
  if (lockPresent(state)) throw new ReaderFailure("locked");
  const artifactRead = safeText(root, state, artifactPath, "missing-artifact");
  if (lockPresent(state)) throw new ReaderFailure("locked");
  let guideNow;
  try {
    guideNow = lstatSync(guidePath, { bigint: true, throwIfNoEntry: false });
  } catch {
    throw new ReaderFailure("pair-changed");
  }
  if (guideNow === undefined || !guideNow.isFile() || !sameIdentity(guideNow, guideRead.snapshot) ||
      !sameMetadata(guideNow, guideRead.snapshot)) {
    throw new ReaderFailure("pair-changed");
  }
  assertRoot(root, state);
  return guideRead.text + "\n\n" + artifactRead.text;
}

function empty(provider) {
  if (provider === "gemini") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "" } }) + "\n");
  }
}

function fail(provider, code) {
  empty(provider);
  process.stderr.write("tonedial-reader:" + code + " " + (REPAIR_HINTS[code] ?? "run tonedial doctor") + "\n");
}

function main() {
  const args = process.argv.slice(2);
  const hint = providerHint(args);
  try {
    const { provider, state } = parseArgs(args);
    const body = readPair(state);
    if (provider === "gemini") {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: body } }) + "\n");
    } else {
      process.stdout.write(body);
    }
  } catch (cause) {
    fail(hint, cause instanceof ReaderFailure ? cause.code : "unreadable");
  }
}

main();
`;
