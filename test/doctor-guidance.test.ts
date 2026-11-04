// Doctor's human guidance: every finding names its cause once and ends with the command that
// fixes it, in the scope the user is looking at.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.ts";

let scratch: string;
let home: string;
let project: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-doctor-guidance-"));
  home = join(scratch, "home");
  project = join(home, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, ".codex"));
  env = { HOME: home, PATH: "", LANG: "en_US.UTF-8", COLUMNS: "80" };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Human output without a terminal: what a pipe, CI log or agent shell sees. */
async function human(args: string[], cwd = home): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((text: string) => { out += text; return true; }) as typeof stdout;
  process.stderr.write = ((text: string) => { err += text; return true; }) as typeof stderr;
  try {
    const code = await run(args, env, cwd, false, false);
    return { code, out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

async function json(args: string[], cwd = home) {
  const result = await human([...args, "--json"], cwd);
  return { code: result.code, value: JSON.parse(result.out) };
}

test("doctor --fix without a terminal reports approval, not a protected file, with both rerun commands", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  rmSync(join(home, ".codex", "hooks.json"));

  const machine = await json(["doctor", "--fix", "--global"]);
  assert.equal(machine.code, 0);
  assert.equal(machine.value.native.reason, "approval-required");
  assert.deepEqual(machine.value.native.issues, [{ tool: null, reason: "approval-required" }]);

  const shown = await human(["doctor", "--fix", "--global"]);
  assert.equal(shown.code, 0);
  assert.doesNotMatch(shown.out, /need separate attention/);
  assert.match(shown.out, /approval required/);
  assert.match(shown.out, /^ {2,}tonedial doctor --fix --global$/m);
  assert.match(shown.out, /^ {2,}tonedial doctor --fix --global --auto$/m);
});

/** One finding's lines, from its marked heading to the blank line that ends it. */
function block(out: string, heading: string): string[] {
  const lines = out.split("\n");
  const start = lines.findIndex((line) => /^ {2}(ok|!|·) /.test(line) && line.endsWith(` ${heading}`));
  assert.ok(start >= 0, `no ${heading} finding in:\n${out}`);
  const end = lines.findIndex((line, index) => index > start && line.trim() === "");
  return lines.slice(start, end < 0 ? undefined : end).map((line) => line.trim());
}

test("each fixable finding ends with the scoped doctor --fix that fixes it, once per cause", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  const state = join(home, ".tonedial");
  rmSync(join(home, ".codex", "hooks.json"));
  rmSync(join(state, "TONE.md"));
  writeFileSync(join(state, "skill", "tonedial", "SKILL.md"), "locally edited\n");

  const machine = await json(["doctor", "--global"]);
  const repair = (name: string) => machine.value.checks.find((check: { name: string }) => check.name === name)?.repair;
  for (const name of ["Codex CLI", "TONE.md", "seeds"]) assert.equal(repair(name), "tonedial doctor --fix --global", name);

  const shown = await human(["doctor", "--global"]);
  for (const heading of ["Codex CLI", "TONE.md", "Bundled files"]) {
    assert.equal(block(shown.out, heading).at(-1), "tonedial doctor --fix --global", heading);
  }
  // The missing artifact is one cause: the context-layout summary does not repeat it.
  assert.doesNotMatch(shown.out, /Context files/);
  assert.doesNotMatch(shown.out, /tonedial (compile|init --tools)/);

  assert.equal((await human(["doctor", "--fix", "--global", "--auto"])).code, 0);
  const after = await json(["doctor", "--global"]);
  for (const name of ["Codex CLI", "TONE.md", "seeds"]) {
    assert.notEqual(after.value.checks.find((check: { name: string }) => check.name === name).state, "problem", name);
  }
});

test("an edited TONE.md is one finding with the doctor --fix command", async () => {
  assert.equal((await human(["init", "--tools", "none", "--global", "--auto"])).code, 0);
  writeFileSync(join(home, ".tonedial", "TONE.md"), "edited by hand\n");
  const shown = await human(["doctor", "--global"]);
  assert.doesNotMatch(shown.out, /Context files/);
  assert.equal(block(shown.out, "TONE.md").at(-1), "tonedial doctor --fix --global");
});

test("a connected agent shows one state: connected, with enablement that files cannot show", async () => {
  mkdirSync(join(home, ".claude"));
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  const global = await human(["doctor", "--global"]);
  const codex = block(global.out, "Codex CLI");
  assert.equal(codex[0], "ok Codex CLI");
  assert.match(codex[1]!, /^Connected · SessionStart/);
  assert.match(codex.join(" "), /can't be checked from files/);
  assert.doesNotMatch(codex.join(" "), /unknown|[Tt]rust/);
  // An installed agent that was never connected is simply not connected.
  assert.match(block(global.out, "Agent hooks").join(" "), /Not connected: Claude Code, Antigravity IDE\/Desktop\./);
  assert.doesNotMatch(global.out, /no longer set up/);

  rmSync(join(home, ".codex", "hooks.json"));
  const missing = block((await human(["doctor", "--global"])).out, "Codex CLI");
  assert.deepEqual(missing.slice(-1), ["tonedial doctor --fix --global"]);
  assert.doesNotMatch(missing.join(" "), /[Ee]nablement|Resolve the reported/);
});

test("the project trust step appears only for a project connection", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--here", "--auto"], project)).code, 0);
  const here = block((await human(["doctor", "--here"], project)).out, "Codex CLI");
  assert.match(here.join(" "), /Trust this project in Codex/);
});

test("the report opens with a count of problems and notices", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  const lead = (out: string) => out.split("\n").filter((line) => line.trim() !== "")[3]!.trim();
  const unhealthy = await human(["doctor", "--global"]);
  assert.equal(unhealthy.code, 0, "problems keep exit status 0");
  assert.equal(lead(unhealthy.out), "1 problem", unhealthy.out);
  assert.doesNotMatch(unhealthy.out, /need(s)? attention\n*$/);

  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tonedial"), "#!/bin/sh\n", { mode: 0o755 });
  env.PATH = bin;
  assert.equal(lead((await human(["doctor", "--global"])).out), "No problems found");
});

test("plain doctor in a folder with its own connections points to doctor --here", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--here", "--auto"], project)).code, 0);
  const shown = await human(["doctor"], project);
  assert.match(shown.out, /This folder has its own connections \(codex\)/);
  assert.match(shown.out, /^ {2}tonedial doctor --here$/m);
  assert.match(shown.out.split("\n").filter((line) => line.trim())[3]!, /1 notice/);
  const machine = await json(["doctor"], project);
  assert.equal(machine.value.wiredElsewhere.length, 1, "JSON keeps every registration outside the scope");
});

test("doctor reports a project hook that duplicates the global one, in both scopes", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--here", "--auto"], project)).code, 0);
  assert.equal((await human(["wire", "codex", "--global", "--auto"])).code, 0);
  for (const [args, cwd] of [[["doctor", "--global"], home], [["doctor", "--here"], project]] as const) {
    const codex = block((await human([...args], cwd)).out, "Codex CLI");
    assert.ok(codex.includes(project), codex.join("\n"));
    assert.match(codex.join(" "), /both hooks are present/);
    assert.equal(codex.at(-1), "tonedial unwire codex --here");
    const machine = await json([...args], cwd);
    const integration = machine.value.integrations.find((row: { tool: string }) => row.tool === "codex");
    assert.deepEqual(integration.duplicates.map((row: { destination: string }) => row.destination), [project]);
  }
});

test("a project that inherits the global hook is not reported as a duplicate", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  assert.equal((await human(["wire", "codex", "--here", "--auto"], project)).code, 0);
  for (const [args, cwd] of [[["doctor", "--global"], home], [["doctor", "--here"], project]] as const) {
    const machine = await json([...args], cwd);
    assert.deepEqual(machine.value.integrations.find((row: { tool: string }) => row.tool === "codex").duplicates, []);
    assert.doesNotMatch((await human([...args], cwd)).out, /both hooks are present/);
  }
});
