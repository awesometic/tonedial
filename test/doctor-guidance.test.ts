// Doctor's human guidance: every finding names its cause once and ends with the command that
// fixes it, in the scope the user is looking at.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.ts";
import { HOST_COMPOSITION } from "../src/core/anchors.ts";
import { addLegacyRider } from "./support/legacy-fixture.ts";

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
  assert.match(shown.out, /^ {2,}tonedial doctor --fix --global --dry-run$/m);
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

test("a TONE.md an earlier version wrote from the same settings says so, not that it was edited", async () => {
  assert.equal((await human(["init", "--tools", "none", "--global", "--auto"])).code, 0);
  const tone = join(home, ".tonedial", "TONE.md");
  // 0.1.11 wrote the current artifact without the host reply-style rule (added in 0.1.13).
  const current = readFileSync(tone, "utf8");
  const earlier = current.replace(`- ${HOST_COMPOSITION}\n`, "");
  assert.notEqual(earlier, current);
  writeFileSync(tone, earlier);

  const lines = block((await human(["doctor", "--global"])).out, "TONE.md");
  assert.match(lines.join(" "), /generated by an earlier ToneDial version/);
  assert.doesNotMatch(lines.join(" "), /edited directly|write interrupted/);
  assert.equal(lines.at(-1), "tonedial doctor --fix --global");

  // A recognised artifact with other settings than config.json's is a write that did not finish.
  assert.equal((await human(["set", "warmth=1"])).code, 0);
  writeFileSync(tone, current);
  const interrupted = block((await human(["doctor", "--global"])).out, "TONE.md");
  assert.match(interrupted.join(" "), /edited directly or write interrupted/);
  assert.equal(interrupted.at(-1), "tonedial doctor --fix --global");
});

test("a reader an update left behind ends with the doctor --fix that refreshes it", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  // A bundled reader recorded at an earlier seed version, as an older package left it.
  const config = join(home, ".tonedial", "config.json");
  const saved = JSON.parse(readFileSync(config, "utf8"));
  saved.managedSeeds.reader.version -= 1;
  writeFileSync(config, JSON.stringify(saved));

  const reader = block((await human(["doctor", "--global"])).out, "Reader");
  assert.match(reader.join(" "), /Reader self-test failed\. Bundled file update available/);
  assert.equal(reader.at(-1), "tonedial doctor --fix --global");
  const check = (await json(["doctor", "--global"])).value.checks.find((row: { name: string }) => row.name === "reader");
  assert.equal(check.repair, "tonedial doctor --fix --global");

  assert.equal((await human(["doctor", "--fix", "--global", "--auto"])).code, 0);
  const after = (await json(["doctor", "--global"])).value.checks.find((row: { name: string }) => row.name === "reader");
  assert.deepEqual([after.state, after.repair], ["note", null]);
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

test("a project recorded on the global hook is not reported as a duplicate", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  await addLegacyRider(env, "codex", project);
  for (const [args, cwd] of [[["doctor", "--global"], home], [["doctor", "--here"], project]] as const) {
    const machine = await json([...args], cwd);
    assert.deepEqual(machine.value.integrations.find((row: { tool: string }) => row.tool === "codex").duplicates, []);
    assert.doesNotMatch((await human([...args], cwd)).out, /both hooks are present/);
  }
});

test("a hook file that no longer parses is reported as unreadable, not as edited entries", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  const hook = join(home, ".codex", "hooks.json");
  writeFileSync(hook, readFileSync(hook, "utf8").replace(/\}\s*$/, ""));

  const lines = block((await human(["doctor", "--global"])).out, "Codex CLI");
  const codex = lines.join(" ");
  assert.doesNotMatch(codex, /edited outside ToneDial/);
  assert.match(codex, /Cannot read this file as JSON/);
  assert.ok(lines.includes(hook), codex);
  assert.equal(lines.at(-1), "tonedial doctor --global");
  const machine = await json(["doctor", "--global"]);
  assert.equal(machine.value.integrations.find((row: { tool: string }) => row.tool === "codex").configuration, "foreign");
});

test("an externally edited hook gets what ToneDial expected and two routes that work", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  const hook = join(home, ".codex", "hooks.json");
  const written = readFileSync(hook, "utf8");
  writeFileSync(hook, written.replace('"additionalContextLimit": 0', '"additionalContextLimit": 5'));

  const codex = block((await human(["doctor", "--global"])).out, "Codex CLI");
  assert.match(codex.join(" "), /edited outside ToneDial/);
  assert.ok(codex.includes(hook), codex.join("\n"));
  assert.ok(codex.includes("tonedial doctor --global --verbose"), codex.join("\n"));
  assert.equal(codex.at(-1), "tonedial doctor --fix --global");
  const verbose = block((await human(["doctor", "--global", "--verbose"])).out, "Codex CLI");
  assert.ok(verbose.includes('"statusMessage": "ToneDial: load saved response tone",'), verbose.join("\n"));
  assert.ok(verbose.includes('"additionalContextLimit": 0'), "the expected entries, not the edited ones");

  // Refresh does not dead-end either: it points to the diagnosis that carries these routes.
  assert.match((await human(["init", "--tools", "codex", "--global", "--auto"])).out, /^ {2}tonedial doctor --global$/m);

  // Route 1: restoring the entries as written makes the hook ToneDial's again.
  writeFileSync(hook, written);
  assert.equal((await json(["doctor", "--global"])).value.integrations[0].configuration, "configured");

  // Route 2: with the edited file moved aside, doctor --fix writes a new one.
  writeFileSync(hook, written.replace('"additionalContextLimit": 0', '"additionalContextLimit": 5'));
  renameSync(hook, `${hook}.mine`);
  assert.equal((await human(["doctor", "--fix", "--global", "--auto"])).code, 0);
  assert.equal((await json(["doctor", "--global"])).value.integrations[0].configuration, "configured");
});

test("doctor --fix --dry-run previews without a configured-hook receipt", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  writeFileSync(join(home, ".tonedial", "skill", "tonedial", "SKILL.md"), "locally edited\n");
  const preview = await human(["doctor", "--fix", "--global", "--dry-run"]);
  assert.equal(preview.code, 0, preview.err);
  assert.match(preview.out, /--dry-run · nothing written/);
  assert.doesNotMatch(preview.out, /hook configured|enable the hook/);
});

test("the doctor --fix receipt gives each agent one state", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  const hook = join(home, ".codex", "hooks.json");
  const receipt = (out: string) => out.slice(out.indexOf("Connect agents"), out.indexOf("\n  Checks\n"));

  // An application repair with the hook already in place: nothing to write for Codex.
  writeFileSync(join(home, ".tonedial", "TONE.md"), "edited by hand\n");
  const unchanged = receipt((await human(["doctor", "--fix", "--global", "--auto"])).out);
  assert.equal(unchanged.match(/Codex CLI:/g)?.length, 1, unchanged);
  assert.match(unchanged, /Codex CLI: already up to date · no changes/);

  // A hook the repair writes again is reported once, as configured, with its file.
  rmSync(hook);
  const written = receipt((await human(["doctor", "--fix", "--global", "--auto"])).out);
  assert.equal(written.match(/Codex CLI:/g)?.length, 1, written);
  assert.match(written, /Codex CLI: hook configured/);
  assert.ok(written.split("\n").some((line) => line.trim() === hook), written);
});

test("a missing hook's path sits on its own line", async () => {
  env.COLUMNS = "60";
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  const hook = join(home, ".codex", "hooks.json");
  rmSync(hook);
  const codex = block((await human(["doctor", "--global"])).out, "Codex CLI");
  assert.deepEqual(codex.slice(1, 3), ["No ToneDial SessionStart hook", hook]);
});

test("a duplicate hook stays visible and counted when that agent also has a problem", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--here", "--auto"], project)).code, 0);
  assert.equal((await human(["wire", "codex", "--global", "--auto"])).code, 0);
  const hooks = join(home, ".codex", "hooks.json");
  writeFileSync(hooks, readFileSync(hooks, "utf8").replace("tonedial", "tonedial-edited"));
  const shown = await human(["doctor", "--global"]);
  const codex = block(shown.out, "Codex CLI").join(" ");
  assert.match(codex, /both hooks are present/);
  const machine = await json(["doctor", "--global"]);
  assert.equal(machine.value.integrations.find((row: { tool: string }) => row.tool === "codex").duplicates.length, 1);
});

test("approval reruns keep the agent selection and options the user asked for", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  mkdirSync(join(home, ".claude"));
  rmSync(join(home, ".codex", "hooks.json"));
  const fixed = await human(["doctor", "--fix", "--tools", "codex", "--global"]);
  assert.match(fixed.out, /^ {2,}tonedial doctor --fix --tools codex --global$/m, fixed.out);
  assert.match(fixed.out, /^ {2,}tonedial doctor --fix --tools codex --global --auto$/m);

  const setup = await human(["init", "--tools", "claude", "--commands", "--global"]);
  assert.match(setup.out, /^ {2,}tonedial init --commands --tools claude --global$/m, setup.out + setup.err);
  assert.match(setup.out, /^ {2,}tonedial init --commands --tools claude --global --auto$/m);
});

test("a hook left after a damaged config is restored is reported, then adopted exactly by doctor --fix --tools", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  const hook = join(home, ".codex", "hooks.json");
  const bytes = readFileSync(hook, "utf8");
  writeFileSync(join(home, ".tonedial", "config.json"), "{");
  assert.equal((await human(["doctor", "--fix", "--global", "--from-preset", "caring-brother", "--auto"])).code, 0);

  const codex = block((await human(["doctor", "--global"])).out, "Codex CLI");
  assert.match(codex.join(" "), /no connection records them/);
  assert.ok(codex.includes(hook), codex.join("\n"));
  assert.equal(codex.at(-1), "tonedial doctor --fix --tools codex --global");
  const machine = await json(["doctor", "--global"]);
  assert.equal(machine.value.healthy, false);
  assert.equal(machine.value.checks.find((row: { name: string }) => row.name === "Codex CLI").repair,
    "tonedial doctor --fix --tools codex --global");

  // Adoption goes through the usual preview: here it only records the connection.
  const preview = await json(["doctor", "--fix", "--tools", "codex", "--global", "--dry-run"]);
  assert.deepEqual(preview.value.native.diff.map((row: { path: string }) => row.path), [join(home, ".tonedial", "config.json")]);
  const adopted = await human(["doctor", "--fix", "--tools", "codex", "--global", "--auto"]);
  assert.equal(adopted.code, 0, adopted.err);
  assert.equal(readFileSync(hook, "utf8"), bytes, "adoption leaves the entries byte for byte");
  const after = await json(["doctor", "--global"]);
  assert.equal(after.value.integrations.find((row: { tool: string }) => row.tool === "codex").configuration, "configured");
  assert.equal(after.value.checks.find((row: { name: string }) => row.name === "Codex CLI").state, "ok");

  // Recorded again, the connection disconnects completely.
  assert.equal((await human(["unwire", "codex", "--global", "--auto"])).code, 0);
  assert.equal(existsSync(hook), false);
  assert.equal(existsSync(join(home, ".agents", "skills", "tonedial")), false);
});

test("an unrecorded ToneDial entry that was edited gets guidance and is never adopted", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  const hook = join(home, ".codex", "hooks.json");
  writeFileSync(hook, readFileSync(hook, "utf8").replace('"additionalContextLimit": 0', '"additionalContextLimit": 5'));
  const edited = readFileSync(hook, "utf8");
  writeFileSync(join(home, ".tonedial", "config.json"), "{");
  assert.equal((await human(["doctor", "--fix", "--global", "--from-preset", "caring-brother", "--auto"])).code, 0);

  const codex = block((await human(["doctor", "--global"])).out, "Codex CLI");
  assert.match(codex.join(" "), /differ from what ToneDial writes/);
  assert.ok(codex.includes(hook), codex.join("\n"));
  assert.equal(codex.at(-1), "tonedial wire codex --global");
  assert.equal((await json(["doctor", "--global"])).value.checks.find((row: { name: string }) => row.name === "Codex CLI").repair, null);

  assert.equal((await human(["doctor", "--fix", "--tools", "codex", "--global", "--auto"])).code, 0);
  assert.equal(readFileSync(hook, "utf8"), edited);
  assert.match(block((await human(["doctor", "--global"])).out, "Codex CLI").join(" "), /differ from what ToneDial writes/);
});

test("doctor names a global hook only an earlier version's project record keeps, with unwire --global", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  await addLegacyRider(env, "codex", project, true);
  const hook = join(home, ".codex", "hooks.json");

  const codex = block((await human(["doctor", "--global"])).out, "Codex CLI");
  assert.match(codex.join(" "), /still sends the tone in every folder/);
  assert.ok(codex.includes(hook) && codex.includes(project), codex.join("\n"));
  assert.equal(codex.at(-1), "tonedial unwire codex --global");
  const machine = await json(["doctor", "--global"]);
  assert.equal(machine.value.checks.find((row: { name: string }) => row.name === "Codex CLI").state, "problem");
  assert.equal(machine.value.nativeAttention, true);

  assert.equal((await human(["unwire", "codex", "--global", "--auto"])).code, 0);
  assert.equal(existsSync(hook), false);
  assert.equal((await json(["doctor", "--global"])).value.checks.find((row: { name: string }) => row.name === "Codex CLI").state, "note");
});

test("a repair here leaves healthy connections elsewhere alone and names each scope that needs its own", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  assert.equal((await human(["wire", "claude", "--here", "--auto"], project)).code, 0);
  const other = join(scratch, "other");
  mkdirSync(other);
  assert.equal((await human(["wire", "claude", "--project", other, "--auto"])).code, 0);

  const healthy = await human(["doctor", "--fix", "--global", "--auto"], project);
  assert.equal(healthy.code, 0, healthy.err);
  assert.doesNotMatch(healthy.out, /need separate attention|need their own repair/);
  const machine = await json(["doctor", "--fix", "--global", "--auto"], project);
  assert.deepEqual([machine.value.native.nativeRepair, machine.value.native.issues], ["complete", []]);

  rmSync(join(project, ".claude", "settings.json"));
  rmSync(join(other, ".claude", "settings.json"));
  const broken = await human(["doctor", "--fix", "--global", "--auto"], project);
  assert.equal(broken.code, 0, broken.err);
  assert.doesNotMatch(broken.out, /need separate attention/);
  assert.match(broken.out.replace(/\s+/g, " "), /Connections in other scopes need their own repair/);
  // The current folder is `--here`; another folder keeps its path.
  assert.match(broken.out, /^ {2}tonedial doctor --fix --here$/m);
  assert.match(broken.out, new RegExp(`^ {2}tonedial doctor --fix --project "${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"$`, "m"));
  const issues = (await json(["doctor", "--fix", "--global", "--auto"], project)).value.native.issues;
  assert.deepEqual(issues, [{ tool: null, reason: "unselected-scopes" }]);
});

test("a repair blocked by an edited hook says which file and why, not only that connections need attention", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  const hook = join(home, ".codex", "hooks.json");
  writeFileSync(hook, readFileSync(hook, "utf8").replace(/"command": "/, '"command": "edited '));
  for (const args of [["doctor", "--fix", "--global", "--auto"], ["init", "--tools", "codex", "--global", "--auto"]]) {
    const shown = await human(args);
    assert.equal(shown.code, 0, shown.err);
    assert.doesNotMatch(shown.out, /need separate attention/, args.join(" "));
    assert.match(shown.out, /Ownership is unknown, or managed content or file type changed/, args.join(" "));
    assert.ok(shown.out.split("\n").some((line) => line.trim() === hook), shown.out);
    // doctor's own report follows its repair; init names the diagnosis that shows the guidance.
    if (args[0] === "init") assert.match(shown.out, /^ {2}tonedial doctor --global$/m);
  }
});

test("an agent with no hook to inspect is connected with wire, the command that adds one", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  const report = await json(["doctor", "--global"]);
  const antigravity = report.value.checks.find((check: { name: string }) => check.name === "Antigravity IDE/Desktop");
  assert.match(antigravity.detail, /run wire with this agent/);
  assert.doesNotMatch(antigravity.detail, /\binit\b/);
});
