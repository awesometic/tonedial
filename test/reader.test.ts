import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, test } from "node:test";

import {
  CONTEXT_ARTIFACT_FILENAME,
  CONTEXT_GUIDE_FILENAME,
} from "../src/core/paths.ts";
import { GUIDE_FORMAT_MARKER, READER_PROTOCOL_VERSION, READER_SOURCE } from "../src/core/reader.ts";

let scratch = "";
let script = "";
let state = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-reader-"));
  state = join(scratch, "state \"quoted\" 한글");
  mkdirSync(state, { recursive: true });
  script = join(scratch, "outside-package", "reader.mjs");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, READER_SOURCE, { mode: 0o600 });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const guidePath = () => join(state, CONTEXT_GUIDE_FILENAME);
const artifactPath = () => join(state, CONTEXT_ARTIFACT_FILENAME);
const lockPath = () => join(state, "operations.lock");
const guide = `${GUIDE_FORMAT_MARKER}\nShort operating boundaries.\n`;
const artifact = "# Tone\nThe current compiled tone.\n";

function writePair(): void {
  writeFileSync(guidePath(), guide);
  writeFileSync(artifactPath(), artifact);
}

function writePreload(name: string, source: string): string {
  const preload = join(scratch, name);
  writeFileSync(preload, source, { mode: 0o600 });
  return preload;
}

function invoke(
  provider: string,
  extra: string[] = [],
  timeout = 5000,
  stateRoot = state,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [script, "--provider", provider, "--state", stateRoot, ...extra], {
    encoding: "utf8",
    timeout,
    env: {
      PATH: process.env.PATH,
      HOME: scratch,
      TMPDIR: scratch,
      ...extraEnv,
    },
  });
}

test("emitted reader runs outside the package and preserves the ordered plain payload", () => {
  writePair();
  const before = readdirSync(state).sort();
  const result = invoke("codex");
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, guide + "\n\n" + artifact);
  assert.equal(result.stderr, "");
  assert.deepEqual(readdirSync(state).sort(), before);
  assert.equal(existsSync(join(scratch, "node_modules")), false);
});

test("Gemini receives exactly its JSON envelope with the same ordered body", () => {
  writePair();
  const result = invoke("gemini");
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(
    result.stdout,
    JSON.stringify({ hookSpecificOutput: { additionalContext: guide + "\n\n" + artifact } }) + "\n",
  );
  assert.equal(result.stderr, "");
});

test("a stable configured symlink root alias remains readable", () => {
  writePair();
  const alias = join(scratch, "configured-state-alias");
  symlinkSync(state, alias, "dir");
  const result = invoke("codex", [], 5000, alias);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, guide + "\n\n" + artifact);
  assert.equal(result.stderr, "");
});

test("a root redirected during validation emits no payload and never opens the outside guide", () => {
  writePair();
  const alias = join(scratch, "race-state-alias");
  const outside = join(scratch, "outside-state");
  const outsideGuide = join(outside, CONTEXT_GUIDE_FILENAME);
  const outsideArtifact = join(outside, CONTEXT_ARTIFACT_FILENAME);
  const marker = join(scratch, "outside-guide-opened");
  mkdirSync(outside, { recursive: true });
  writeFileSync(outsideGuide, `${GUIDE_FORMAT_MARKER}\noutside\n`);
  writeFileSync(outsideArtifact, "outside artifact\n");
  symlinkSync(state, alias, "dir");

  const preload = writePreload(
    "root-race.cjs",
    `const fs = require("node:fs");
const moduleApi = require("node:module");
const root = ${JSON.stringify(alias)};
const outside = ${JSON.stringify(outside)};
const outsideGuide = ${JSON.stringify(outsideGuide)};
const marker = ${JSON.stringify(marker)};
let rootLstatCount = 0;
const originalLstatSync = fs.lstatSync;
fs.lstatSync = function patchedLstatSync(target, ...args) {
  if (target === root && ++rootLstatCount === 2) {
    fs.unlinkSync(root);
    fs.symlinkSync(outside, root, "dir");
  }
  return originalLstatSync.call(fs, target, ...args);
};
const originalOpenSync = fs.openSync;
fs.openSync = function patchedOpenSync(target, ...args) {
  if (target === outsideGuide) fs.writeFileSync(marker, "opened");
  return originalOpenSync.call(fs, target, ...args);
};
moduleApi.syncBuiltinESMExports();
`,
  );
  const result = invoke("codex", [], 5000, alias, { NODE_OPTIONS: `--require=${preload}` });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /root-changed/);
  assert.equal(existsSync(marker), false);
});

test("a root redirected after descriptor validation is rejected before bytes are read", () => {
  writePair();
  const alias = join(scratch, "descriptor-race-state-alias");
  const outside = join(scratch, "descriptor-race-outside-state");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, CONTEXT_GUIDE_FILENAME), `${GUIDE_FORMAT_MARKER}\noutside\n`);
  writeFileSync(join(outside, CONTEXT_ARTIFACT_FILENAME), "outside artifact\n");
  symlinkSync(state, alias, "dir");

  const preload = writePreload(
    "descriptor-race.cjs",
    `const fs = require("node:fs");
const moduleApi = require("node:module");
const root = ${JSON.stringify(alias)};
const outside = ${JSON.stringify(outside)};
let replaced = false;
const originalFstatSync = fs.fstatSync;
fs.fstatSync = function patchedFstatSync(...args) {
  const result = originalFstatSync.apply(fs, args);
  if (!replaced) {
    replaced = true;
    fs.unlinkSync(root);
    fs.symlinkSync(outside, root, "dir");
  }
  return result;
};
moduleApi.syncBuiltinESMExports();
`,
  );
  const result = invoke("codex", [], 5000, alias, { NODE_OPTIONS: `--require=${preload}` });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /root-changed/);
});

test("a guide changed while the artifact opens suppresses the whole pair", () => {
  writePair();
  const changedGuide = `${GUIDE_FORMAT_MARKER}\nchanged after the guide read\n`;
  const preload = writePreload(
    "pair-race.cjs",
    `const fs = require("node:fs");
const moduleApi = require("node:module");
const artifact = ${JSON.stringify(artifactPath())};
const guide = ${JSON.stringify(guidePath())};
const changedGuide = ${JSON.stringify(changedGuide)};
const originalOpenSync = fs.openSync;
fs.openSync = function patchedOpenSync(target, ...args) {
  if (target === artifact) fs.writeFileSync(guide, changedGuide);
  return originalOpenSync.call(fs, target, ...args);
};
moduleApi.syncBuiltinESMExports();
`,
  );
  const result = invoke("codex", [], 5000, state, { NODE_OPTIONS: `--require=${preload}` });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /pair-changed/);
});

test("reader source is versioned, closed to providers, and has no package imports", () => {
  assert.equal(READER_PROTOCOL_VERSION, 1);
  assert.match(READER_SOURCE, /^#!\/usr\/bin\/env node\n/);
  assert.deepEqual(
    [...READER_SOURCE.matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]),
    ["node:fs", "node:path"],
  );

  writePair();
  const result = invoke("other");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /tonedial-reader:provider/);
});

test("missing, unsupported, symlinked, and nonregular context files emit no plain partial payload", () => {
  writeFileSync(artifactPath(), artifact);
  let result = invoke("claude");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /missing-guide/);

  writeFileSync(guidePath(), "<!-- tonedial-guide:99 -->\nwrong\n");
  result = invoke("claude");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unsupported-guide/);

  rmSync(guidePath());
  const foreign = join(scratch, "foreign-guide.md");
  writeFileSync(foreign, guide);
  symlinkSync(foreign, guidePath());
  result = invoke("claude");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /symlink/);
  assert.equal(readFileSync(foreign, "utf8"), guide);

  rmSync(guidePath());
  mkdirSync(guidePath());
  result = invoke("claude");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /nonregular/);
  assert.equal(lstatSync(guidePath()).isDirectory(), true);
});

test("missing artifact never emits the guide before reporting the failure", () => {
  writeFileSync(guidePath(), guide);
  const result = invoke("codex");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /missing-artifact/);
});

test("a mutation lock suppresses delivery immediately without reading or waiting", () => {
  writePair();
  mkdirSync(lockPath());
  const result = invoke("codex", [], 1000);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /locked/);
  assert.equal(readdirSync(state).sort().includes("operations.lock"), true);
});

test("a locked Gemini delivery remains protocol-valid and empty", () => {
  writePair();
  mkdirSync(lockPath());
  const result = invoke("gemini");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, JSON.stringify({ hookSpecificOutput: { additionalContext: "" } }) + "\n");
  assert.match(result.stderr, /locked/);
});

test("an unknown or replaced lock owner still suppresses delivery", () => {
  writePair();
  writeFileSync(lockPath(), JSON.stringify({ owner: "replaced", state: "unknown" }));
  const result = invoke("codex");
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /locked/);
});

test("a non-directory lock entry keeps Gemini's protocol envelope empty", () => {
  writePair();
  writeFileSync(lockPath(), "not an owner record\n");
  const result = invoke("gemini");
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, JSON.stringify({ hookSpecificOutput: { additionalContext: "" } }) + "\n");
  assert.match(result.stderr, /locked/);
});

test("a lock appearing during the artifact read suppresses the complete pair", () => {
  writePair();
  const preload = writePreload(
    "lock-race.cjs",
    `const fs = require("node:fs");
const moduleApi = require("node:module");
const artifact = ${JSON.stringify(artifactPath())};
const lock = ${JSON.stringify(lockPath())};
const originalOpenSync = fs.openSync;
fs.openSync = function patchedOpenSync(target, ...args) {
  if (target === artifact) fs.writeFileSync(lock, "appeared during read");
  return originalOpenSync.call(fs, target, ...args);
};
moduleApi.syncBuiltinESMExports();
`,
  );
  const result = invoke("codex", [], 1000, state, { NODE_OPTIONS: `--require=${preload}` });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /locked/);
  assert.equal(existsSync(lockPath()), true);
});

test("an existing FIFO is rejected without blocking", { skip: process.platform === "win32" }, () => {
  writeFileSync(guidePath(), guide);
  execFileSync("mkfifo", [artifactPath()]);
  const result = invoke("claude", [], 1000);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /nonregular/);
});
