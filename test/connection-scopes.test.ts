import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.ts";
import { isConfigV2, parseConfig } from "../src/core/config.ts";
import { resolvePaths } from "../src/core/paths.ts";

let scratch: string;
let project: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-connection-scopes-"));
  project = join(scratch, "project");
  mkdirSync(project);
  mkdirSync(join(scratch, "home"));
  env = { HOME: join(scratch, "home"), TONEDIAL_HOME: join(scratch, "state"), PATH: "", LANG: "en_US.UTF-8" };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function invoke(args: string[], extra: NodeJS.ProcessEnv = {}) {
  let output = "";
  const stdout = process.stdout.write;
  process.stdout.write = ((text: string) => { output += text; return true; }) as typeof stdout;
  try {
    const code = await run(["--json", ...args], { ...env, ...extra }, project, false, false);
    return { code, value: JSON.parse(output) };
  } finally {
    process.stdout.write = stdout;
  }
}

test("connection defaults preview the global destination and explicit scopes mutate only their own providers", async () => {
  const home = env.HOME!;
  const paths = resolvePaths(env);
  const preview = await invoke(["init", "--tools", "claude", "--dry-run", "--auto"]);
  assert.equal(preview.code, 0, JSON.stringify(preview.value));
  assert.equal(preview.value.agentRoot, home);
  assert.equal(preview.value.live, true);
  assert.equal(preview.value.integrations[0].path, join(home, ".claude", "settings.json"));
  assert.equal(existsSync(paths.root), false);
  assert.deepEqual(readdirSync(home), []);
  assert.deepEqual(readdirSync(project), []);

  const global = await invoke(["init", "--global", "--tools", "claude", "--auto"]);
  assert.equal(global.code, 0, JSON.stringify(global.value));
  const globalHook = join(home, ".claude", "settings.json");
  const globalBytes = readFileSync(globalHook, "utf8");
  const report = await invoke(["doctor", "--auto"]);
  assert.equal(report.code, 0, JSON.stringify(report.value));
  assert.equal(report.value.integrations.find((row: { tool: string }) => row.tool === "claude").path, globalHook);

  assert.equal((await invoke(["wire", "codex", "--here", "--auto"])).code, 0);
  const hereHook = join(project, ".codex", "hooks.json");
  const hereBytes = readFileSync(hereHook, "utf8");
  const named = join(project, "named");
  const setupNamed = await invoke(["init", "--project", "named", "--tools", "antigravity", "--auto"]);
  assert.equal(setupNamed.code, 0, JSON.stringify(setupNamed.value));
  const namedHook = join(named, ".agents", "hooks.json");
  const namedBytes = readFileSync(namedHook, "utf8");
  assert.equal(setupNamed.value.agentRoot, named);
  assert.equal(readFileSync(globalHook, "utf8"), globalBytes);
  assert.equal(readFileSync(hereHook, "utf8"), hereBytes);
  assert.equal(existsSync(join(project, ".claude")), false);
  assert.equal(existsSync(join(home, ".codex")), false);
  assert.equal(existsSync(join(named, "config.json")), false);
  assert.equal(existsSync(join(named, "presets")), false);
  const config = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(config));
  assert.deepEqual(Object.values(config.wiring.registrations).map(({ target, scope, destination }) =>
    ({ target, scope, destination })).sort((a, b) => a.target.localeCompare(b.target)), [
    { target: "antigravity", scope: "project", destination: realpathSync(named) },
    { target: "claude", scope: "global", destination: realpathSync(home) },
    { target: "codex", scope: "project", destination: realpathSync(project) },
  ]);

  assert.equal((await invoke(["unwire", "claude", "--global", "--auto"])).code, 0);
  assert.equal(readFileSync(hereHook, "utf8"), hereBytes);
  assert.equal(readFileSync(namedHook, "utf8"), namedBytes);
  assert.equal((await invoke(["eject", "--here", "--auto"])).code, 0);
  assert.equal(existsSync(hereHook), false);
  assert.equal(readFileSync(namedHook, "utf8"), namedBytes);
  assert.equal((await invoke(["eject", "--project", "named", "--auto"])).code, 0);
  assert.equal(existsSync(namedHook), false);
  assert.equal(existsSync(paths.agents), true);
  assert.equal(existsSync(paths.tone), true);
});

test("unattended connection writes require scope even for no-ops while read-only and dry-run calls stay nonmutating", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "none", "--auto"])).code, 0);
  const paths = resolvePaths(env);
  const config = readFileSync(paths.config, "utf8");
  const artifact = readFileSync(paths.tone, "utf8");
  const entries = readdirSync(paths.root, { recursive: true }).sort();
  for (const args of [
    ["init", "--tools", "none"], ["wire", "codex"], ["unwire", "codex"], ["eject"], ["doctor", "--fix"],
  ]) {
    const refused = await invoke([...args, "--auto"]);
    assert.equal(refused.code, 1, args.join(" "));
    assert.match(refused.value.error, /--global/);
    assert.match(refused.value.error, /--here/);
    assert.match(refused.value.error, /--project/);
    const preview = await invoke([...args, "--auto", "--dry-run"]);
    assert.equal(preview.code, 0, JSON.stringify(preview.value));
    assert.equal(readFileSync(paths.config, "utf8"), config);
    assert.equal(readFileSync(paths.tone, "utf8"), artifact);
    assert.deepEqual(readdirSync(paths.root, { recursive: true }).sort(), entries);
    assert.deepEqual(readdirSync(env.HOME!), []);
    assert.deepEqual(readdirSync(project), []);
  }
  const report = await invoke(["doctor", "--auto"]);
  assert.equal(report.code, 0, JSON.stringify(report.value));
  assert.equal(readFileSync(paths.config, "utf8"), config);
});

test("invalid scope and migration options fail before creating any state or provider files", async () => {
  for (const args of [
    ["init", "--tools", "none", "--global", "--here"],
    ["eject", "--global", "--project", "."],
    ["wire", "codex", "--here", "--project", "."],
    ["init", "--tools", "none", "--project", ""],
    ["init", "--tools", "none", "--project"],
    ["use", "tough-love", "--here"], ["compile", "--global"], ["update", "--here"],
    ["doctor", "--migrate-legacy"], ["init", "--here", "--tools", "none", "--migrate-legacy", "--auto"],
  ]) {
    const result = await invoke(args);
    assert.notEqual(result.code, 0, args.join(" "));
    assert.equal(result.value.ok, false);
    assert.equal(result.value.schema, 3);
    assert.deepEqual(readdirSync(scratch).sort(), ["home", "project"]);
    assert.deepEqual(readdirSync(env.HOME!), []);
    assert.deepEqual(readdirSync(project), []);
  }
});

test("the agent-home override isolates both default previews and explicit global writes", async () => {
  const isolated = join(scratch, "agent-override");
  const extra = { TONEDIAL_AGENT_HOME: isolated };
  const preview = await invoke(["init", "--tools", "codex", "--dry-run"], extra);
  assert.equal(preview.code, 0, JSON.stringify(preview.value));
  assert.equal(preview.value.agentRoot, isolated);
  assert.equal(preview.value.live, false);
  const result = await invoke(["init", "--global", "--tools", "codex", "--auto"], extra);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal(existsSync(join(isolated, ".codex", "hooks.json")), true);
  assert.deepEqual(readdirSync(env.HOME!), []);
  assert.deepEqual(readdirSync(project), []);
});
