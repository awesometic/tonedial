import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../src/cli.ts";
import { defaultConfig, serializeConfig } from "../src/core/config.ts";
import { compile } from "../src/core/compile.ts";
import { toCompileInput } from "../src/core/resolve.ts";
import { resolvePaths } from "../src/core/paths.ts";
import { BUNDLED, serializePreset, customPresetDir } from "../src/core/presets.ts";
import { catalogue } from "../src/core/i18n.ts";

let scratch: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-context-gates-"));
  env = { HOME: scratch, TONEDIAL_HOME: join(scratch, "state"), PATH: "", LANG: "en_US.UTF-8" };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function invoke(args: string[]) {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = ((text: string) => { output += text; return true; }) as typeof original;
  try {
    const code = await run([...args, "--json"], env, join(scratch, "project"), false, false);
    return { code, value: JSON.parse(output) };
  } finally {
    process.stdout.write = original;
  }
}

const mutations = [
  ["set", "care=2"], ["reset"], ["use", "tough-love"], ["save", "Example"],
  ["edit"], ["import", "https://example.invalid/preset.json"], ["compile"],
  ["wire", "--here", "codex", "--auto"],
];

test("fresh mutations require approved init without creating state", async () => {
  for (const args of mutations) {
    const result = await invoke(args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.value.error, /has not been initialized/);
    assert.deepEqual(readdirSync(scratch), []);
  }
});

test("legacy mutation gates run before editor launch or import network access", async () => {
  const paths = resolvePaths(env);
  mkdirSync(paths.root);
  const config = serializeConfig(defaultConfig());
  const artifact = compile(toCompileInput(defaultConfig()));
  writeFileSync(paths.config, config);
  writeFileSync(join(paths.root, "tone.md"), artifact);
  env.EDITOR = "must-not-launch-this-editor";
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("network must not be reached"); };
  try {
    for (const args of mutations) {
      const result = await invoke(args);
      assert.equal(result.code, 1, args.join(" "));
      assert.match(result.value.error, /application recovery.*legacy layout/);
      assert.match(result.value.error, /tonedial doctor --fix/);
      assert.equal(readFileSync(paths.config, "utf8"), config);
      assert.equal(readFileSync(join(paths.root, "tone.md"), "utf8"), artifact);
      assert.deepEqual(readdirSync(paths.root).sort(), ["config.json", "tone.md"]);
    }
    assert.equal(fetches, 0);
    const approved = await invoke(["init", "--here", "--tools", "none", "--auto"]);
    assert.equal(approved.code, 0, JSON.stringify(approved.value));
    assert.equal(approved.value.appHealthy, true);
    assert.equal(readFileSync(join(paths.root, "tone.md"), "utf8"), artifact);
    assert.equal((await invoke(["set", "care=2"])).code, 0);
    assert.equal(readFileSync(join(paths.root, "tone.md"), "utf8"), readFileSync(paths.tone, "utf8"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("state-only init enables ordinary changes without rewriting the guide", async () => {
  const setup = await invoke(["init", "--here", "--tools", "none", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const paths = resolvePaths(env);
  const guide = readFileSync(paths.agents, "utf8");
  for (const args of [["set", "care=2"], ["save", "Example"], ["use", "example"], ["reset"], ["compile"]]) {
    const result = await invoke(args);
    assert.equal(result.code, 0, JSON.stringify(result.value));
    assert.equal(readFileSync(paths.agents, "utf8"), guide);
  }
  assert.equal(readdirSync(paths.root).includes("tone.md"), false);
  assert.equal(readdirSync(paths.root).includes("TONE.md"), true);
});

test("read-only and package-only commands do not initialize fresh state", async () => {
  for (const args of [["show"], ["list"], ["export", "tough-love"], ["compile", "--check"], ["doctor", "--here"], ["update"]]) {
    const result = await invoke(args);
    assert.equal(result.code, 0, JSON.stringify(result.value));
    assert.deepEqual(readdirSync(scratch), [], args.join(" "));
  }
});

test("disconnecting an uninitialized scope does not create config or context", async () => {
  for (const command of ["unwire", "eject"]) {
    const result = await invoke([command, "--here", "--auto"]);
    assert.equal(result.code, 0, JSON.stringify(result.value));
    assert.equal(result.value.applied, false);
    assert.deepEqual(readdirSync(scratch), [], command);
  }
});

test("a legacy consumer of the physical state root is detected through a configured alias", async () => {
  const root = resolvePaths(env).root;
  mkdirSync(root);
  const alias = join(scratch, "state-alias");
  symlinkSync(root, alias, "dir");
  env.TONEDIAL_HOME = alias;
  const host = join(scratch, "project", ".claude");
  mkdirSync(host, { recursive: true });
  const file = join(host, "CLAUDE.md");
  const original = `<!-- tonedial:begin -->\n@${join(realpathSync(root), "tone.md")}\n<!-- tonedial:end -->\n`;
  writeFileSync(file, original);
  const result = await invoke(["init", "--here", "--tools", "none", "--auto"]);
  assert.equal(result.code, 1);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.deepEqual(readdirSync(root), []);
});

test("state-only setup preserves unselected legacy imports without treating them as application authority", async () => {
  for (const scope of ["project", "global"]) {
    const root = scope === "project" ? join(scratch, "project") : scratch;
    const provider = join(root, ".claude");
    mkdirSync(provider, { recursive: true });
    const path = join(provider, "CLAUDE.md");
    const text = `<!-- tonedial:begin -->\n@${join(resolvePaths(env).root, "tone.md")}\n<!-- tonedial:end -->\n`;
    writeFileSync(path, text);
    const result = await invoke(["init", "--here", "--tools", "none", "--auto"]);
    assert.equal(result.code, 0, JSON.stringify(result.value));
    assert.equal(readFileSync(path, "utf8"), text);
    assert.equal(existsSync(resolvePaths(env).tone), true);
    assert.equal(existsSync(join(root, ".claude", "settings.json")), false);
    rmSync(provider, { recursive: true });
  }
});

test("a generated guide without any recoverable settings requires a source choice before replacement", async () => {
  const paths = resolvePaths(env);
  mkdirSync(paths.root);
  writeFileSync(paths.agents, "foreign guide\n");
  const result = await invoke(["init", "--here", "--tools", "none", "--auto"]);
  assert.equal(result.code, 1);
  assert.equal(result.value.error, catalogue("en").cli.recovery.sourceRequired);
  assert.deepEqual(readdirSync(paths.root), ["AGENTS.md"]);
  assert.equal(readFileSync(paths.agents, "utf8"), "foreign guide\n");
});

test("scoped legacy disconnect removes only the exact import and keeps shared state", async () => {
  const paths = resolvePaths(env);
  mkdirSync(paths.root);
  const config = serializeConfig(defaultConfig());
  const artifact = compile(toCompileInput(defaultConfig()));
  writeFileSync(paths.config, config);
  writeFileSync(join(paths.root, "tone.md"), artifact);
  const provider = join(scratch, "project", ".claude");
  mkdirSync(provider, { recursive: true });
  const path = join(provider, "CLAUDE.md");
  writeFileSync(path, `team guidance\n\n<!-- tonedial:begin -->\n@~/state/tone.md\n<!-- tonedial:end -->\n`);
  const result = await invoke(["unwire", "--here", "claude", "--auto"]);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal(readFileSync(path, "utf8"), "team guidance\n");
  assert.equal(readFileSync(join(paths.root, "tone.md"), "utf8"), artifact);
  assert.equal(readFileSync(paths.config, "utf8"), config);
  assert.equal(existsSync(paths.agents), false);
});

test("eject refuses a host instruction path redirected into the state guide", async () => {
  const paths = resolvePaths(env);
  mkdirSync(paths.root);
  writeFileSync(paths.config, serializeConfig(defaultConfig()));
  const contents = "<!-- tonedial:begin -->\n@~/state/tone.md\n<!-- tonedial:end -->\n";
  writeFileSync(paths.agents, contents);
  const provider = join(scratch, "project", ".claude");
  mkdirSync(provider, { recursive: true });
  symlinkSync(paths.agents, join(provider, "CLAUDE.md"));
  const result = await invoke(["eject", "--here", "--auto"]);
  assert.equal(result.code, 1, JSON.stringify(result.value));
  assert.equal(readFileSync(paths.agents, "utf8"), contents);
  assert.deepEqual(readdirSync(paths.root).sort(), ["AGENTS.md", "config.json"]);
});

test("an import revalidates the guide inspected before its asynchronous input", async () => {
  const setup = await invoke(["init", "--here", "--tools", "none", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const paths = resolvePaths(env);
  const config = readFileSync(paths.config, "utf8");
  const artifact = readFileSync(paths.tone, "utf8");
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    writeFileSync(paths.agents, "concurrent guide edit\n");
    const response = new Response(serializePreset({ ...BUNDLED[0]!, slug: "race-preset", displayName: "Race preset" }));
    Object.defineProperty(response, "url", { value: "https://example.invalid/preset.json" });
    return response;
  };
  try {
    const result = await invoke(["import", "https://example.invalid/preset.json"]);
    assert.equal(fetches, 1);
    assert.equal(result.code, 1, JSON.stringify(result.value));
    assert.equal(result.value.error, catalogue("en").cli.errors.staleTarget(paths.agents));
    assert.equal(existsSync(join(customPresetDir(paths.presets), "race-preset.json")), false);
    assert.equal(readFileSync(paths.config, "utf8"), config);
    assert.equal(readFileSync(paths.tone, "utf8"), artifact);
    assert.equal(readFileSync(paths.agents, "utf8"), "concurrent guide edit\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
