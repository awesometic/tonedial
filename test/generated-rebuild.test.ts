import assert from "node:assert/strict";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import { defaultConfig, serializeConfig } from "../src/core/config.ts";
import { compile } from "../src/core/compile.ts";
import { toCompileInput } from "../src/core/resolve.ts";
import { catalogue } from "../src/core/i18n.ts";
import { resolvePaths, readerPath } from "../src/core/paths.ts";
import {
  contextArtifactTargets, generatedSeedSelection, GUIDE_MD, inspectContextLayout,
  planGeneratedSeedRebuild, SEED_VERSION, seedFiles, seedRecord,
} from "../src/core/seeds.ts";
import { applyPlanned, planArtifact } from "../src/commands/compile.ts";
import { gate, planChange } from "../src/wiring/apply.ts";
import { palette } from "../src/ui/style.ts";
import type { Ctx } from "../src/cli.ts";

const EN = catalogue("en").cli;

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "tonedial-generated-rebuild-")));
  const env = { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", LANG: "en_US.UTF-8" };
  const paths = resolvePaths(env);
  fs.mkdirSync(paths.root);
  return { home, paths, env };
}

async function invoke(env: NodeJS.ProcessEnv, args: string[]) {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = ((text: string) => { output += text; return true; }) as typeof original;
  try {
    const code = await run([...args, "--json"], env, env.HOME!, false, false);
    return { code, value: JSON.parse(output) };
  } finally { process.stdout.write = original; }
}

test("closed generated rebuild repairs linked builtin caches while preserving the custom library and outside contents", async () => {
  const { home, paths } = fixture();
  const outside = join(home, "outside-cache");
  const custom = join(paths.presets, "custom", "my-tone.json");
  const original = '{"schema":1,"slug":"my-tone","displayName":"My Tone","values":{"care":2}}\n';
  try {
    fs.mkdirSync(dirname(custom), { recursive: true });
    fs.writeFileSync(custom, original, { mode: 0o640 });
    const before = fs.lstatSync(custom, { bigint: true });
    fs.mkdirSync(outside);
    const sentinel = join(outside, "sentinel.json");
    fs.writeFileSync(sentinel, "outside-dummy-private-value\n");
    fs.symlinkSync(outside, join(paths.presets, "builtin"));
    fs.writeFileSync(paths.agents, Buffer.from([0xff, 0x80]));
    const selection = generatedSeedSelection(paths, defaultConfig(), false, EN);
    const plan = planGeneratedSeedRebuild(paths, {}, selection, EN);
    await gate(plan.checks, { paths, t: EN, auto: true, dryRun: false,
      operationActions: plan.operationActions, ui: palette("never", {}, false), out: () => {},
      retention: { kind: "migration", reason: "app-rebuild" } });
    assert.equal(fs.readFileSync(paths.agents, "utf8"), GUIDE_MD);
    assert.equal(fs.readFileSync(custom, "utf8"), original);
    const after = fs.lstatSync(custom, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    assert.equal(after.mtimeNs, before.mtimeNs);
    for (const seed of seedFiles(paths, selection)) assert.equal(fs.readFileSync(seed.path, "utf8"), seed.contents);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "outside-dummy-private-value\n");
    assert.equal(fs.existsSync(readerPath(paths.root)), false);
    assert.equal(fs.existsSync(paths.skill), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("an installed skill family repairs missing companions without selecting a reader or removing extra files", async () => {
  const { home, paths } = fixture();
  const body = join(paths.skill, "tonedial", "SKILL.md");
  const extra = join(dirname(body), "user-note.txt");
  try {
    fs.mkdirSync(dirname(body), { recursive: true });
    fs.writeFileSync(body, "old generated body\n");
    fs.writeFileSync(extra, "keep this extra\n");
    const selection = generatedSeedSelection(paths, defaultConfig(), false, EN);
    const plan = planGeneratedSeedRebuild(paths, {}, selection, EN);
    const skill = seedFiles(paths, selection).filter((seed) => seed.id.startsWith("skill/"));
    assert.equal(skill.length, 2);
    await gate(plan.checks, { paths, t: EN, auto: true, dryRun: false,
      operationActions: plan.operationActions, ui: palette("never", {}, false), out: () => {} });
    for (const seed of skill) assert.equal(fs.readFileSync(seed.path, "utf8"), seed.contents);
    assert.equal(fs.readFileSync(extra, "utf8"), "keep this extra\n");
    assert.equal(fs.existsSync(readerPath(paths.root)), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("ordinary set, use and compile keep existing lowercase delivery synchronized in either filesystem case model", async () => {
  const { home, paths, env } = fixture();
  const lower = join(paths.root, "tone.md");
  try {
    const config = defaultConfig();
    config.seedVersion = SEED_VERSION;
    for (const seed of seedFiles(paths, { native: false })) {
      fs.mkdirSync(dirname(seed.path), { recursive: true });
      fs.writeFileSync(seed.path, seed.contents);
      config.managedSeeds[seed.id] = seedRecord(seed);
    }
    fs.writeFileSync(paths.config, serializeConfig(config, EN));
    fs.writeFileSync(lower, compile(toCompileInput(config)));
    const names = fs.readdirSync(paths.root);
    const folding = fs.lstatSync(paths.tone, { throwIfNoEntry: false }) !== undefined && !names.includes("TONE.md");
    if (!folding) fs.writeFileSync(paths.tone, compile(toCompileInput(config)));
    const targets = contextArtifactTargets(paths, EN);
    assert.equal(targets.length, folding ? 1 : 2);
    if (folding) assert.equal(targets[0]!.path, lower);
    for (const args of [["set", "care=2"], ["use", "tough-love"], ["compile"]]) {
      const result = await invoke(env, args);
      assert.equal(result.code, 0, JSON.stringify(result.value));
      assert.equal(fs.readFileSync(lower, "utf8"), fs.readFileSync(paths.tone, "utf8"));
      assert.equal(fs.readdirSync(paths.root).includes("tone.md"), true);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("artifact compatibility uses the companion captured during planning and refuses later drift", async (t) => {
  const { home, paths } = fixture();
  const lower = join(paths.root, "tone.md");
  try {
    fs.writeFileSync(paths.tone, "old\n");
    fs.writeFileSync(lower, "old\n");
    if (!fs.readdirSync(paths.root).includes("TONE.md") || !fs.readdirSync(paths.root).includes("tone.md")) {
      t.skip("filesystem exposes one case-folded entry");
      return;
    }
    const ctx = { paths, t: EN, flags: { dryRun: false }, canPrompt: false, ui: palette("never", {}, false) } as Ctx;
    const planned = planArtifact(ctx, defaultConfig());
    fs.writeFileSync(lower, "external edit\n");
    await assert.rejects(() => applyPlanned(ctx, [planned.change]), /changed|stale/i);
    assert.equal(fs.readFileSync(paths.tone, "utf8"), "old\n");
    assert.equal(fs.readFileSync(lower, "utf8"), "external edit\n");
    assert.equal(fs.existsSync(paths.operationsLock), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("app context health does not turn an external inspection failure into app ownership", () => {
  const { home, paths } = fixture();
  try {
    const config = defaultConfig();
    const artifact = compile(toCompileInput(config));
    fs.writeFileSync(paths.config, serializeConfig(config, EN));
    fs.writeFileSync(paths.agents, GUIDE_MD);
    fs.writeFileSync(paths.tone, artifact);
    const external = join(home, "provider-settings.json");
    fs.writeFileSync(external, "not valid JSON: dummy-private-value\n");
    const layout = inspectContextLayout(paths, planChange(paths.config, (before) => before, EN, undefined, paths.root), EN,
      { config, expectedArtifact: artifact, consumerInspectionFailed: true,
        inspectionFailure: { path: external, reason: "invalid-provider-json" } });
    assert.equal(layout.kind, "current");
    assert.equal(layout.cause, "none");
    assert.equal(layout.inspectionFailure, null);
    assert.equal(layout.nativeAttention?.inspectionFailure?.reason, "invalid-provider-json");
    assert.equal(layout.checks.some((change) => change.path === external), false);
    assert.equal(fs.readFileSync(external, "utf8"), "not valid JSON: dummy-private-value\n");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("compile check reports paths and size without reading damaged generated entries", async () => {
  const { home, paths, env } = fixture();
  try {
    fs.writeFileSync(paths.config, serializeConfig(defaultConfig(), EN));
    fs.mkdirSync(paths.tone);
    const sentinel = join(paths.tone, "unknown.txt");
    fs.writeFileSync(sentinel, "preserve this directory\n");
    const before = fs.readdirSync(paths.root).sort();
    const result = await invoke(env, ["compile", "--check"]);
    assert.equal(result.code, 0, JSON.stringify(result.value));
    assert.equal(result.value.path, paths.tone);
    assert.equal(result.value.written, false);
    assert.equal(result.value.chars, [...compile(toCompileInput(defaultConfig()))].length);
    assert.deepEqual(fs.readdirSync(paths.root).sort(), before);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve this directory\n");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
