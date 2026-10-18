// Hooks may run without PATH or after the package moves. The seeded reader is standalone.

import {
  CONTEXT_ARTIFACT_FILENAME,
  CONTEXT_GUIDE_FILENAME,
} from "./paths.ts";
import { DELIVERY_OFF_MARKER } from "./anchors.ts";

export const READER_PROTOCOL_VERSION = 3 as const;
export const GUIDE_FORMAT_VERSION = 1 as const;
export const GUIDE_FORMAT_MARKER = `<!-- tonedial-guide:${GUIDE_FORMAT_VERSION} -->`;

/** Stable, short repair guidance shared by the emitted source and diagnostics. */
export const READER_REPAIR_HINTS = {
  arguments: "pass --provider and --state",
  provider: "choose codex, claude, or antigravity",
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
  event: "use a supported hook event",
  input: "retry the hook with a valid event payload",
  response: "retry the hook when the response is available",
  "delivery-marker": "regenerate the tone artifact",
  "style-marker": "regenerate the tone artifact",
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
const DELIVERY_OFF_MARKER = ${JSON.stringify(DELIVERY_OFF_MARKER)};
const REPAIR_HINTS = ${JSON.stringify(READER_REPAIR_HINTS)};
const PROVIDERS = new Set(["codex", "claude", "antigravity"]);
const EVENTS = new Set(["SessionStart", "UserPromptSubmit", "Stop", "PreInvocation"]);
const MAX_HOOK_INPUT = 128 * 1024;
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
  let event = null;
  let eventProvided = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let name = argument;
    let value = null;
    if (argument === "--provider" || argument === "--state" || argument === "--event") {
      value = args[index + 1] ?? null;
      index += 1;
    } else if (argument?.startsWith("--provider=")) {
      name = "--provider";
      value = argument.slice("--provider=".length);
    } else if (argument?.startsWith("--state=")) {
      name = "--state";
      value = argument.slice("--state=".length);
    } else if (argument?.startsWith("--event=")) {
      name = "--event";
      value = argument.slice("--event=".length);
    }
    if (name === "--provider") {
      if (provider !== null || value === null || value === "") throw new ReaderFailure("arguments");
      provider = value;
    } else if (name === "--state") {
      if (state !== null || value === null || value === "") throw new ReaderFailure("arguments");
      state = value;
    } else if (name === "--event") {
      if (eventProvided || value === null || value === "") throw new ReaderFailure("arguments");
      eventProvided = true;
      event = value;
    } else {
      throw new ReaderFailure("arguments");
    }
  }
  if (provider === null || state === null || !PROVIDERS.has(provider)) {
    throw new ReaderFailure(provider !== null && !PROVIDERS.has(provider) ? "provider" : "arguments");
  }
  if (!isAbsolute(state) || state.includes("\0")) throw new ReaderFailure("state");
  event ??= provider === "antigravity" ? "PreInvocation" : "SessionStart";
  if (!EVENTS.has(event) || (provider === "antigravity" && event !== "PreInvocation") ||
      (provider !== "antigravity" && event === "PreInvocation")) throw new ReaderFailure("event");
  return { provider, state: resolve(state), event };
}

function eventHint(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--event") return args[index + 1] ?? null;
    if (args[index]?.startsWith("--event=")) return args[index].slice("--event=".length);
  }
  return null;
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
  return { body: guideRead.text + "\n\n" + artifactRead.text, artifact: artifactRead.text };
}

function empty(provider, event) {
  if (provider === "antigravity") {
    process.stdout.write(JSON.stringify({ injectSteps: [] }) + "\n");
  } else if (event === "Stop") {
    // Stop has a JSON-only stdout contract. An empty object is an explicit no-op and never
    // asks the host to continue a task when the response or marker cannot be trusted.
    process.stdout.write("{}\n");
  }
}

function fail(provider, event, code) {
  empty(provider, event);
  process.stderr.write("tonedial-reader:" + code + " " + (REPAIR_HINTS[code] ?? "run tonedial doctor") + "\n");
}

function hookInput() {
  if (process.stdin.isTTY) return Promise.resolve({ value: null, diagnostic: "input" });
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
      process.stdin.destroy();
      resolve(result);
    };
    // shortcut: slow native input fails open after 250ms; widen only for measured host latency.
    const timer = setTimeout(() => finish({ value: null, diagnostic: "input" }), 250);
    process.stdin.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_HOOK_INPUT) return finish({ value: null, diagnostic: "input" });
      chunks.push(chunk);
    });
    process.stdin.once("error", () => finish({ value: null, diagnostic: "input" }));
    process.stdin.once("end", () => finish(parseHookInput(chunks, total)));
  });
}

function parseHookInput(chunks, total) {
  if (total === 0) return { value: null, diagnostic: "response" };
  let parsed;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    parsed = JSON.parse(text);
  } catch {
    return { value: null, diagnostic: "input" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { value: null, diagnostic: "input" };
  if (Object.hasOwn(parsed, "stop_hook_active") && typeof parsed.stop_hook_active !== "boolean") {
    return { value: null, diagnostic: "input" };
  }
  if (Object.hasOwn(parsed, "last_assistant_message") && parsed.last_assistant_message !== null &&
      typeof parsed.last_assistant_message !== "string") return { value: null, diagnostic: "input" };
  return { value: parsed, diagnostic: null };
}

function styleMarker(artifact) {
  const lines = artifact.split(/\r?\n/);
  const generation = lines[0] ?? "";
  if (!generation.startsWith("<!-- generated by tonedial · preset: ") || !generation.endsWith(" -->")) return null;
  const line = lines[1];
  const match = /^<!-- tonedial-style:1 verbosity=([1-5]) care=([1-5]) -->$/.exec(line ?? "");
  return match === null ? null : { verbosity: Number(match[1]), care: Number(match[2]) };
}

function deliveryEnabled(artifact) {
  const line = artifact.split(/\r?\n/, 3)[2] ?? "";
  if (line === DELIVERY_OFF_MARKER) return false;
  if (line.startsWith("<!-- tonedial-delivery:")) throw new ReaderFailure("delivery-marker");
  return true;
}

// shortcut: ambiguous data-like prose skips feedback; refine only with verified host format metadata.
function literalPayload(text) {
  const value = text.trim();
  if (value === "") return true;
  const fence = String.fromCharCode(96).repeat(3);
  if (value.startsWith(fence) && value.endsWith(fence)) return true;
  try {
    JSON.parse(value);
    return true;
  } catch {}
  if (value.startsWith("<") || /^(?:---\s*$|[\p{L}\p{N}_-]+\s*:)/um.test(value)) return true;
  const lines = value.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.some((line) => /[;{}]\s*$/.test(line))) return true;
  if (lines.length >= 2 && [",", ";", "\t"].some((separator) =>
      lines.every((line) => line.split(separator).length >= 2))) return true;
  if (lines.length >= 2 && lines.every((line) => /^\s*\|/.test(line) || /^\s*[-+|:]+\s*$/.test(line))) return true;
  const fenced = value.includes(fence);
  const outside = value.split(fence).filter((_part, index) => index % 2 === 0).join("").trim();
  return fenced && outside.length < 240;
}

function organized(text) {
  const lines = text.split(/\r?\n/);
  const labeled = lines.filter((line) => /^\s*(?:[-*•]|\d+[.)]|#{1,6}\s)/.test(line));
  return labeled.length >= 2;
}

function functionalEmoji(text) {
  return /(?:✅|❌|⚠️?|ℹ️?|✔️?|☑️?|⚙️?|🔹|🔸|📌|📝|🔧|🧪|📊|🟢|🟡|🔴)/u.test(text);
}

function styleFeedback(pair, input) {
  const marker = styleMarker(pair.artifact);
  if (marker === null) return { feedback: null, diagnostic: "style-marker" };
  if (input.diagnostic !== null) return { feedback: null, diagnostic: input.diagnostic };
  const response = input.value?.last_assistant_message;
  if (typeof response !== "string" || response.trim() === "") {
    return { feedback: null, diagnostic: "response" };
  }
  // Only an explicit false authorizes one bounded continuation. An omitted flag is a
  // provider-version or payload-shape gap; treating it as active avoids a feedback loop.
  if (input.value.stop_hook_active !== false || literalPayload(response)) return { feedback: null, diagnostic: null };
  const substantial = [...response].length >= 160;
  const overlong = marker.verbosity === 1 && [...response].length > 600;
  const careCheck = marker.care === 5 && substantial;
  const missingOrganization = careCheck && !organized(response);
  const missingEmoji = careCheck && !functionalEmoji(response);
  const missingCareShape = missingOrganization || missingEmoji;
  if (!overlong && !missingCareShape) return { feedback: null, diagnostic: null };
  const adjustment = [
    overlong ? "Compress unnecessary prose while preserving the requested detail." : null,
    missingOrganization ? "Use concise organized items." : null,
    missingEmoji ? "Add a functional emoji where useful." : null,
  ].filter(Boolean).join(" ");
  return { feedback: "Review and rewrite the response for the saved tone. If this turn uses the safeword or a task-required output format, preserve that request; revise only where the saved tone still applies. Preserve every task-required detail and requested format. " + adjustment + " Do not rerun tools or change permissions.", diagnostic: null };
}

async function main() {
  const args = process.argv.slice(2);
  const hint = providerHint(args);
  try {
    const { provider, state, event } = parseArgs(args);
    const pair = readPair(state);
    if (!deliveryEnabled(pair.artifact)) {
      empty(provider, event);
      return;
    }
    const input = event === "Stop" ? await hookInput() : null;
    if (event === "Stop") {
      const result = styleFeedback(pair, input);
      if (result.diagnostic !== null) {
        fail(provider, event, result.diagnostic);
        return;
      }
      const feedback = result.feedback;
      if (feedback === null) {
        empty(provider, event);
      } else if (provider === "claude") {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: feedback } }) + "\n");
      } else {
        process.stdout.write(JSON.stringify({ decision: "block", reason: feedback }) + "\n");
      }
    } else if (provider === "antigravity") {
      process.stdout.write(JSON.stringify({ injectSteps: [{ ephemeralMessage: pair.body }] }) + "\n");
    } else {
      process.stdout.write(pair.body);
    }
  } catch (cause) {
    const event = eventHint(args) === "Stop" ? "Stop" : "SessionStart";
    fail(hint, event, cause instanceof ReaderFailure ? cause.code : "unreadable");
  }
}

main();
`;
