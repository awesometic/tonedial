import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { defaultConfig, type Config } from "../src/core/config.ts";
import { readerPath, resolvePaths, type Paths } from "../src/core/paths.ts";
import { inspectSeeds, recordedSeedSelection, seedFiles, seedRecord, type Seed } from "../src/core/seeds.ts";
import { registrationKey } from "../src/wiring/ownership.ts";

let scratch: string;
let paths: Paths;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-seeds-"));
  paths = resolvePaths({ HOME: scratch, TONEDIAL_HOME: join(scratch, "state") });
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function writeSeed(seed: Seed, contents = seed.contents): void {
  mkdirSync(dirname(seed.path), { recursive: true });
  writeFileSync(seed.path, contents);
}

test("state-only selection excludes native seeds, while inspection can retain recorded sources", () => {
  const state = seedFiles(paths, { native: false });
  const all = seedFiles(paths, { native: true });
  const body = all.find((seed) => seed.id === "skill/body")!;
  assert.ok(state.length > 0);
  assert.equal(state.find((seed) => seed.id === "guide")?.path, paths.agents);
  assert.equal(state.some((seed) => seed.id === "reader"), false);
  assert.ok(state.every((seed) => !seed.id.startsWith("skill/")));
  assert.equal(all.length, state.length + 3);
  assert.equal(new Set(all.map((seed) => seed.id)).size, all.length);

  const records = { [body.id]: seedRecord(body) };
  assert.equal(inspectSeeds(paths, records, { native: false }).length, state.length);
  const retained = inspectSeeds(paths, records, { native: false, recorded: Object.keys(records) });
  assert.equal(retained.length, state.length + 1);
  assert.equal(retained.find(({ seed }) => seed.id === body.id)?.state, "missing");
  assert.equal(retained.some(({ seed }) => seed.id === "skill/traits"), false);
});

test("the reader is a managed optional seed and not a wiring resource", () => {
  const reader = seedFiles(paths, { native: true }).find((seed) => seed.id === "reader")!;
  assert.equal(reader.path, readerPath(paths.root));
  assert.match(reader.contents, /^#!\/usr\/bin\/env node\n/);
  const retained = seedFiles(paths, { native: false, recorded: ["reader"] });
  assert.equal(retained.find((seed) => seed.id === "reader")?.path, reader.path);
  assert.equal(retained.some((seed) => seed.id.startsWith("skill/")), false);
});

test("a retained reader resource record does not infer native seed selection", () => {
  const reader = seedFiles(paths, { native: true }).find((seed) => seed.id === "reader")!;
  const config = defaultConfig();
  config.managedSeeds.reader = {
    path: readerPath(paths.root), type: "file", version: reader.version, sha256: seedRecord(reader).sha256,
  };
  config.wiring = {
    registrations: {},
    resources: {
      oldReader: {
        path: reader.path,
        kind: "reader",
        created: true,
        createdDir: true,
        consumers: ["old-registration"],
        expected: { type: "file" },
        managed: { version: 1 },
      },
    },
  };
  const selection = recordedSeedSelection(config, []);
  assert.equal(selection.native, false);
  assert.deepEqual(selection.recorded, ["reader"]);
});

test("only explicitly selected paired registrations require native seeds", () => {
  const destination = join(scratch, "project");
  for (const target of ["codex", "claude"] as const) {
    const config = defaultConfig();
    const id = registrationKey(target, "project", destination);
    config.wiring = {
      registrations: {
        [id]: { target, scope: "project", destination, context: "pair", resourceIds: [] },
      },
      resources: {},
    };
    const selection = recordedSeedSelection(config, ["codex"]);
    assert.equal(selection.native, target === "codex", target);
    assert.deepEqual(selection.recorded, []);
  }
});

test("read-only seed inspection distinguishes matching unrecorded bytes before an approved rebuild", () => {
  const seed = seedFiles(paths, { native: false })[0]!;
  assert.equal(inspectSeeds(paths, {}, { native: false })[0]?.state, "missing");
  writeSeed(seed);
  assert.equal(inspectSeeds(paths, {}, { native: false })[0]?.state, "foreign");
  assert.equal(readFileSync(seed.path, "utf8"), seed.contents);
});

test("the applied seed hash distinguishes a package refresh from a user edit", () => {
  const seed = seedFiles(paths, { native: false })[0]!;
  const records: Config["managedSeeds"] = { [seed.id]: seedRecord(seed) };
  const state = () => inspectSeeds(paths, records, { native: false })[0]?.state;
  writeSeed(seed);
  assert.equal(state(), "current");

  records[seed.id] = seedRecord({ ...seed, version: 0 });
  assert.equal(state(), "stale", "per-seed version matters even when the bytes match");
  const old = { ...seed, contents: "previous bundled bytes\n", version: 0 };
  writeSeed(seed, old.contents);
  records[seed.id] = seedRecord(old);
  assert.equal(state(), "stale");

  writeSeed(seed, "user changes\n");
  assert.equal(state(), "modified");
  assert.equal(readFileSync(seed.path, "utf8"), "user changes\n");
});

test("a recorded seed never follows a replacement symlink or adopts a directory", () => {
  const seed = seedFiles(paths, { native: false })[0]!;
  const records = { [seed.id]: seedRecord(seed) };
  const target = join(scratch, "same-bytes");
  writeFileSync(target, seed.contents);
  mkdirSync(dirname(seed.path), { recursive: true });
  symlinkSync(target, seed.path);
  assert.equal(inspectSeeds(paths, records, { native: false })[0]?.state, "foreign");
  assert.equal(readFileSync(target, "utf8"), seed.contents);
  rmSync(seed.path);
  mkdirSync(seed.path);
  assert.equal(inspectSeeds(paths, records, { native: false })[0]?.state, "foreign");
});

test("stored paths do not redirect seed inspection or add arbitrary files to the catalogue", () => {
  const seed = seedFiles(paths, { native: false })[0]!;
  const other = join(scratch, "other");
  writeFileSync(other, seed.contents);
  const records = {
    [seed.id]: { ...seedRecord(seed), path: other },
    unknown: { ...seedRecord(seed), path: other },
  };
  const results = inspectSeeds(paths, records, { native: false, recorded: Object.keys(records) });
  assert.equal(results[0]?.state, "foreign");
  assert.equal(results.some(({ seed: found }) => found.path === other), false);
  assert.equal(readFileSync(other, "utf8"), seed.contents);
});

test("a linked seed directory cannot redirect setup outside the state root", () => {
  const other = join(scratch, "other-presets");
  mkdirSync(other);
  mkdirSync(paths.root);
  symlinkSync(other, paths.presets, "dir");
  const results = inspectSeeds(paths, {}, { native: false });
  const presets = results.filter(({ seed }) => seed.id.startsWith("preset/"));
  assert.ok(presets.length > 0, "the redirected library had no generated preset targets to inspect");
  assert.ok(presets.every(({ state }) => state === "foreign"));
  assert.equal(presets.some(({ state }) => state === "missing"), false, "outside targets are not offered for creation");
});

test("seed inspection does not hang when a regular file becomes a FIFO before open", { skip: process.platform === "win32" }, () => {
  const seed = seedFiles(paths, { native: false })[0]!;
  writeSeed(seed);
  const script = `
    import fs from "node:fs";
    import { execFileSync } from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { inspectSeeds } from ${JSON.stringify(new URL("../src/core/seeds.ts", import.meta.url).href)};
    const target = ${JSON.stringify(seed.path)};
    const originalOpen = fs.openSync;
    let replaced = false;
    fs.openSync = (path, ...args) => {
      if (path === target && !replaced) {
        replaced = true;
        fs.unlinkSync(target);
        execFileSync("mkfifo", [target]);
      }
      return originalOpen(path, ...args);
    };
    syncBuiltinESMExports();
    const result = inspectSeeds(${JSON.stringify(paths)}, ${JSON.stringify({ [seed.id]: seedRecord(seed) })}, { native: false });
    process.stdout.write(JSON.stringify({ replaced, state: result[0].state }));
  `;
  // Bound the child so a blocking open produces a failure instead of hanging the test runner.
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { replaced: true, state: "foreign" });
});
