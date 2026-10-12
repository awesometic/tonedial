import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { run } from "../src/cli.ts";
import { catalogue } from "../src/core/i18n.ts";
import { resolvePaths } from "../src/core/paths.ts";

let scratch = "";
let project = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-antigravity-"));
  project = join(scratch, "project");
  mkdirSync(project);
  env = {
    HOME: scratch,
    TONEDIAL_HOME: join(scratch, "state"),
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
  };
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function invoke(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = ((text: string) => {
    output += text;
    return true;
  }) as typeof original;
  try {
    const code = await run([...args, "--json"], { ...env, ...extraEnv }, project, false, false);
    return { code, value: JSON.parse(output) as Record<string, any> };
  } finally {
    process.stdout.write = original;
  }
}

async function invokeHuman(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  let output = "";
  let error = "";
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((text: string) => {
    output += text;
    return true;
  }) as typeof originalOut;
  process.stderr.write = ((text: string) => {
    error += text;
    return true;
  }) as typeof originalErr;
  try {
    const code = await run(args, { ...env, ...extraEnv }, project, false, false);
    return { code, output, error };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function containsWrapped(text: string, expected: string): boolean {
  return text.replace(/\s+/g, " ").includes(expected.replace(/\s+/g, " "));
}

function runHook(command: string): Record<string, any> {
  return JSON.parse(execFileSync("/bin/sh", ["-c", command], {
    env,
    encoding: "utf8",
    timeout: 5000,
  })) as Record<string, any>;
}

test("project Antigravity setup uses the shared .agents hook and skill paths", async () => {
  const hookPath = join(project, ".agents", "hooks.json");
  const skillPath = join(project, ".agents", "skills", "tonedial");
  const foreign = { keep: { userSetting: true } };
  mkdirSync(join(project, ".agents"), { recursive: true });
  writeFileSync(hookPath, `${JSON.stringify(foreign)}\n`);

  const setup = await invoke(["init", "--here", "--tools", "antigravity", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const paths = resolvePaths(env);
  assert.equal(existsSync(hookPath), true);
  assert.equal(existsSync(skillPath), true);
  assert.equal(existsSync(join(project, ".gemini", "settings.json")), false);
  assert.equal(existsSync(join(project, ".gemini", "hooks.json")), false);

  const document = readJson(hookPath);
  assert.deepEqual(document.keep, foreign.keep);
  assert.equal(document.tonedial.enabled, true);
  assert.equal(document.tonedial.PreInvocation.length, 1);
  const handler = document.tonedial.PreInvocation[0];
  assert.deepEqual(Object.keys(handler).sort(), ["command", "type"]);
  assert.equal(handler.type, "command");
  assert.match(handler.command, /--provider[ ="]+antigravity(?:[ "']|$)/);
  assert.ok(handler.command.includes(paths.root), "the hook names the configured state root");
  assert.deepEqual(runHook(handler.command), {
    injectSteps: [{ ephemeralMessage: `${readFileSync(paths.agents, "utf8")}\n\n${readFileSync(paths.tone, "utf8")}` }],
  });

  const repeated = await invoke(["wire", "--here", "antigravity", "--auto"]);
  assert.equal(repeated.code, 0, JSON.stringify(repeated.value));
  const repeatedDocument = readJson(hookPath);
  assert.equal(repeatedDocument.tonedial.PreInvocation.length, 1);
  assert.deepEqual(repeatedDocument.keep, foreign.keep);
});

test("global Antigravity setup uses the official config path without a settings file", async () => {
  const hookPath = join(scratch, ".gemini", "config", "hooks.json");
  const skillPath = join(scratch, ".gemini", "config", "skills", "tonedial");
  const setup = await invoke(["init", "--global", "--tools", "antigravity", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  assert.equal(existsSync(hookPath), true);
  assert.equal(existsSync(skillPath), true);
  assert.equal(existsSync(join(scratch, ".gemini", "settings.json")), false);
  assert.equal(existsSync(join(scratch, ".gemini", "skills", "tonedial")), false);
  assert.equal(existsSync(join(project, ".agents", "hooks.json")), false);
});

test("the Antigravity enabled switch remains owned and can be disconnected", async () => {
  const hookPath = join(project, ".agents", "hooks.json");
  const setup = await invoke(["init", "--here", "--tools", "antigravity", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const document = readJson(hookPath);
  document.tonedial.enabled = false;
  writeFileSync(hookPath, `${JSON.stringify(document, null, 2)}\n`);

  const diagnosis = await invoke(["doctor", "--here"]);
  const setting = (diagnosis.value.hookSettings as Array<{ tool: string; state: string }>).find(
    row => row.tool === "antigravity",
  );
  assert.equal(setting?.state, "disabled");
  assert.equal((diagnosis.value.checks as Array<{ name: string; state: string }>).find(
    row => row.name === "Antigravity IDE/Desktop",
  )?.state, "problem");

  const refreshed = await invoke(["wire", "--here", "antigravity", "--auto"]);
  assert.equal(refreshed.code, 0, JSON.stringify(refreshed.value));
  assert.equal(readJson(hookPath).tonedial.enabled, false, "refresh preserves the user's disabled switch");
  assert.equal(readJson(hookPath).tonedial.PreInvocation.length, 1);

  const removed = await invoke(["unwire", "--here", "antigravity", "--auto"]);
  assert.equal(removed.code, 0, JSON.stringify(removed.value));
  assert.equal(existsSync(hookPath), false, "an entirely ToneDial-created hooks file is removed");
});

test("a project Antigravity setup reuses the recorded global hook", async () => {
  const globalHook = join(scratch, ".gemini", "config", "hooks.json");
  const localHook = join(project, ".agents", "hooks.json");
  const globalSetup = await invoke(["init", "--global", "--tools", "antigravity", "--auto"]);
  assert.equal(globalSetup.code, 0, JSON.stringify(globalSetup.value));
  const globalDocument = readJson(globalHook);
  globalDocument.tonedial.enabled = false;
  writeFileSync(globalHook, `${JSON.stringify(globalDocument)}\n`);
  const before = readFileSync(globalHook);

  const projectSetup = await invoke(["init", "--here", "--tools", "antigravity", "--auto"]);
  assert.equal(projectSetup.code, 0, JSON.stringify(projectSetup.value));
  assert.equal(projectSetup.value.integrations?.[0]?.inherited, true);
  assert.equal(existsSync(localHook), false, "an inherited project route does not create a second hook");
  assert.deepEqual(readFileSync(globalHook), before, "project setup leaves the global hook byte-identical");
});

test("a local Antigravity namespace collision blocks inherited setup without writes", async () => {
  const globalHook = join(scratch, ".gemini", "config", "hooks.json");
  const localHook = join(project, ".agents", "hooks.json");
  const globalSetup = await invoke(["init", "--global", "--tools", "antigravity", "--auto"]);
  assert.equal(globalSetup.code, 0, JSON.stringify(globalSetup.value));
  const globalBefore = readFileSync(globalHook);
  const localBytes = `${JSON.stringify({ tonedial: { owner: "someone-else" }, keep: true }, null, 2)}\n`;
  mkdirSync(join(project, ".agents"), { recursive: true });
  writeFileSync(localHook, localBytes);

  const projectSetup = await invoke(["init", "--here", "--tools", "antigravity", "--auto"]);
  assert.equal(projectSetup.code, 0, JSON.stringify(projectSetup.value));
  assert.equal(projectSetup.value.nativeAttention, true, "the inherited setup reports the protected namespace");
  assert.equal(projectSetup.value.native?.reason, "protected-native-resource");
  assert.equal(readFileSync(localHook, "utf8"), localBytes);
  assert.deepEqual(readFileSync(globalHook), globalBefore);
});

test("malformed Antigravity hooks files stay untouched with a localized refusal", async () => {
  const hookPath = join(project, ".agents", "hooks.json");
  const language = "ko" as const;
  for (const [label, value] of [["null", null], ["array", []], ["scalar", 1]] as const) {
    rmSync(join(project, ".agents"), { recursive: true, force: true });
    mkdirSync(join(project, ".agents"), { recursive: true });
    const bytes = `${JSON.stringify(value)}\n`;
    writeFileSync(hookPath, bytes);

    const result = await invoke(["init", "--here", "--lang", language, "--tools", "antigravity", "--auto"]);
    assert.notEqual(result.code, 0, `${label}/${language}: ${JSON.stringify(result.value)}`);
    assert.equal(result.value.error, catalogue(language).cli.errors.hooksNotJson(hookPath, ""));
    assert.equal(readFileSync(hookPath, "utf8"), bytes, `${label}/${language} keeps the original bytes`);
  }
});

test("Antigravity doctor reports enabled, disabled, and unknown hook settings in both languages", async () => {
  const hookPath = join(project, ".agents", "hooks.json");
  const setup = await invoke(["init", "--here", "--tools", "antigravity", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));

  const document = readJson(hookPath);
  for (const state of ["disabled", "enabled", "unknown"] as const) {
    if (state === "disabled") document.tonedial.enabled = false;
    else if (state === "enabled") delete document.tonedial.enabled;
    else document.tonedial.enabled = "sometimes";
    writeFileSync(hookPath, `${JSON.stringify(document, null, 2)}\n`);

    const diagnosis = await invoke(["doctor", "--here"]);
    const setting = (diagnosis.value.hookSettings as Array<{ tool: string; state: string }>).find(
      row => row.tool === "antigravity",
    );
    assert.equal(setting?.state, state, state);

    for (const language of ["en", "ko"] as const) {
      const selected = await invoke(["set", `language=${language}`]);
      assert.equal(selected.code, 0, JSON.stringify(selected.value));
      const human = await invokeHuman(["doctor", "--here"]);
      assert.equal(human.code, 0, human.error);
      const copy = catalogue(language).cli.doctor;
      assert.ok(containsWrapped(human.output, copy.hookSettingState[state]), `${state}/${language}: ${human.output}`);
      assert.ok(containsWrapped(human.output, copy.hookGuidance.antigravity), `${state}/${language}: ${human.output}`);
    }
  }
});

test("a pre-existing Antigravity named root is treated as foreign and left byte-identical", async () => {
  const hookPath = join(project, ".agents", "hooks.json");
  mkdirSync(join(project, ".agents"), { recursive: true });
  const original = {
    tonedial: { enabled: true, customSetting: "keep", PreInvocation: [{ type: "command", command: "user-owned" }] },
    other: { keep: true },
  };
  const bytes = `${JSON.stringify(original, null, 2)}\n`;
  writeFileSync(hookPath, bytes);

  const setup = await invoke(["init", "--here", "--tools", "antigravity", "--auto"]);
  assert.notEqual(setup.code, 0, JSON.stringify(setup.value));
  assert.equal(readFileSync(hookPath, "utf8"), bytes);
});

test("unsupported tools are refused instead of treated as aliases", async () => {
  for (const tool of ["other-agent", "unknown-agent"]) {
    const result = await invoke(["init", "--here", "--tools", tool, "--auto"]);
    assert.notEqual(result.code, 0, `${tool}: ${JSON.stringify(result.value)}`);
    assert.equal(existsSync(join(project, ".agents", "hooks.json")), false, tool);
  }
});
