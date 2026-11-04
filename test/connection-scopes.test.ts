import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { run } from "../src/cli.ts";
import { isConfigV2, parseConfig } from "../src/core/config.ts";
import { resolvePaths } from "../src/core/paths.ts";
import { addLegacyRider } from "./support/legacy-fixture.ts";

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

async function human(args: string[], extra: NodeJS.ProcessEnv = {}, cwd = project) {
  let output = "";
  let errors = "";
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((text: string) => { output += text; return true; }) as typeof stdout;
  process.stderr.write = ((text: string) => { errors += text; return true; }) as typeof stderr;
  try {
    const code = await run(args, { ...env, NO_COLOR: "1", COLUMNS: "200", ...extra }, cwd, false, false);
    return { code, output, errors };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test("show lists every connection with its scope and directory, keeping two projects apart", async () => {
  const other = join(scratch, "other");
  mkdirSync(other);
  // Projects first: a project beside the global connection would record nothing of its own.
  assert.equal((await invoke(["init", "--here", "--tools", "codex", "--auto"])).code, 0);
  assert.equal((await invoke(["wire", "codex", "--project", other, "--auto"])).code, 0);
  assert.equal((await invoke(["wire", "codex", "--global", "--auto"])).code, 0);
  const home = realpathSync(env.HOME!);
  const shown = await invoke(["show"]);
  assert.equal(shown.code, 0, JSON.stringify(shown.value));
  assert.deepEqual(shown.value.connections, [
    { target: "codex", scope: "global", destination: home },
    { target: "codex", scope: "project", destination: realpathSync(other) },
    { target: "codex", scope: "project", destination: realpathSync(project) },
  ]);
  const text = await human(["show"]);
  assert.equal(text.code, 0, text.errors);
  const rows = text.output.split("\n").map((line) => line.trim());
  const at = (row: string) => rows.indexOf(row);
  // One label per scope, each directory on its own copyable row, its agents beneath it.
  assert.equal(rows.filter((row) => row === "Project").length, 1);
  assert.ok(at("Global") < at(home) && at(home) < at("Project"), text.output);
  assert.ok(at("Project") < at(realpathSync(other)) && at(realpathSync(other)) < at(realpathSync(project)), text.output);
  assert.equal(rows[at(realpathSync(project)) + 1], "codex");
});

test("unwire without a scope refuses in a folder with its own connections and names both commands", async () => {
  const other = join(scratch, "other");
  mkdirSync(other);
  const paths = resolvePaths(env);
  assert.equal((await invoke(["init", "--here", "--tools", "codex", "--auto"])).code, 0);
  assert.equal((await invoke(["wire", "codex", "--global", "--auto"])).code, 0);
  const config = readFileSync(paths.config, "utf8");
  const refused = await invoke(["unwire", "codex", "--dry-run"]);
  assert.equal(refused.code, 1, JSON.stringify(refused.value));
  assert.match(refused.value.error, /^  tonedial unwire codex --here$/m);
  assert.match(refused.value.error, /^  tonedial unwire codex --global$/m);
  // The folder has no Claude connection of its own, so `--here` could not mean it.
  const claude = await invoke(["unwire", "claude", "--dry-run"]);
  assert.equal(claude.code, 0, JSON.stringify(claude.value));
  assert.equal(claude.value.live, true);
  const text = await human(["unwire", "codex"]);
  assert.equal(text.code, 1);
  assert.match(text.errors, /tonedial unwire codex --here/);
  assert.equal(readFileSync(paths.config, "utf8"), config);
  assert.equal(existsSync(join(project, ".codex", "hooks.json")), true);
  assert.equal(existsSync(join(env.HOME!, ".codex", "hooks.json")), true);

  // Elsewhere the default stays global, and an explicit scope is never refused.
  const elsewhere = await human(["unwire", "codex", "--dry-run"], {}, other);
  assert.equal(elsewhere.code, 0, elsewhere.errors);
  assert.match(elsewhere.output, /Connection scope: global/);
  const global = await invoke(["unwire", "codex", "--global", "--dry-run"]);
  assert.equal(global.code, 0, JSON.stringify(global.value));
  assert.deepEqual(global.value.diff.map((change: { path: string }) => change.path).filter((path: string) => path.endsWith("tonedial")),
    [join(env.HOME!, ".agents", "skills", "tonedial")]);
});

test("bare unwire outside a terminal refuses with an example and leaves eject as the disconnect-all route", async () => {
  const paths = resolvePaths(env);
  assert.equal((await invoke(["init", "--global", "--tools", "codex", "--auto"])).code, 0);
  const config = readFileSync(paths.config, "utf8");
  for (const args of [["unwire", "--global"], ["unwire", "--global", "--auto"], ["unwire", "--dry-run"]]) {
    const refused = await invoke(args);
    assert.equal(refused.code, 1, args.join(" "));
    assert.match(refused.value.error, /^  tonedial unwire codex --global$/m);
    assert.match(refused.value.error, /^  tonedial eject --global$/m);
  }
  assert.equal(readFileSync(paths.config, "utf8"), config);
  assert.equal(existsSync(join(env.HOME!, ".codex", "hooks.json")), true);
  const ejected = await invoke(["eject", "--global", "--auto"]);
  assert.equal(ejected.code, 0, JSON.stringify(ejected.value));
  assert.equal(existsSync(join(env.HOME!, ".codex", "hooks.json")), false);
});

test("bare unwire in a terminal asks with the wire picker and marks installed and connected agents", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "none", "--auto"])).code, 0);
  assert.equal((await invoke(["wire", "codex", "--here", "--auto"])).code, 0);
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
  chmodSync(join(bin, "claude"), 0o755);
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
  const source = `
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    const { run } = await import(${JSON.stringify(pathToFileURL(entry).href)});
    process.exitCode = await run(["unwire", "--here", "--dry-run"]);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: project, env: { ...env, PATH: bin, NO_COLOR: "1" }, input: "3\n", encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Agents to disconnect/);
  assert.match(result.stdout, /^ +1\. Claude Code \(claude\) · installed$/m);
  assert.match(result.stdout, /^ +2\. Antigravity IDE\/Desktop \(antigravity\)$/m);
  assert.match(result.stdout, /^ +3\. Codex CLI \(codex\) · connected$/m);
  assert.match(result.stdout, new RegExp(`${join(realpathSync(project), ".codex", "hooks.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n *\\(removed\\)`));
  assert.match(result.stdout, /--dry-run · nothing written/);
  assert.equal(existsSync(join(project, ".codex", "hooks.json")), true);
});

test("project wiring names the files it wrote and the version-control choice; global wiring does not", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "none", "--auto"])).code, 0);
  const wired = await human(["wire", "codex", "--here", "--auto"]);
  assert.equal(wired.code, 0, wired.errors);
  // Shared state files are in the preview but are not project files.
  assert.match(wired.output, /^  Project files written: \.codex\/hooks\.json, \.agents\/skills\/tonedial$/m);
  const flat = wired.output.replace(/\s+/g, " ");
  assert.match(flat, /paths from this machine/);
  assert.match(flat, /\.git\/info\/exclude/);
  const global = await human(["wire", "claude", "--global", "--auto"]);
  assert.equal(global.code, 0, global.errors);
  assert.doesNotMatch(global.output, /Project files written|paths from this machine/);
});

test("project wiring in the home directory explains that it is the global destination", async () => {
  const home = env.HOME!;
  assert.equal((await invoke(["init", "--global", "--tools", "codex", "--auto"])).code, 0);
  const paths = resolvePaths(env);
  const config = readFileSync(paths.config, "utf8");
  for (const [args, cwd] of [[["wire", "codex", "--here", "--auto"], home], [["wire", "claude", "--here", "--dry-run"], home],
    [["wire", "claude", "--project", home, "--auto"], project]] as const) {
    const refused = await human([...args], {}, cwd);
    assert.equal(refused.code, 1, args.join(" "));
    assert.doesNotMatch(refused.errors, /Ownership is unknown/);
    assert.match(refused.errors, /home directory/);
    assert.match(refused.errors, new RegExp(`^  tonedial wire ${args[1]} --global$`, "m"));
  }
  assert.equal(readFileSync(paths.config, "utf8"), config);
  assert.equal(existsSync(join(home, ".claude")), false);
});

test("rewiring global does not report a project recorded on the global hook as a duplicate", async () => {
  assert.equal((await invoke(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  await addLegacyRider(env, "codex", project);
  const rewired = await invoke(["wire", "codex", "--global", "--auto"]);
  assert.equal(rewired.code, 0, JSON.stringify(rewired.value));
  assert.deepEqual(rewired.value.tools[0].duplicates, []);
});

test("eject without a scope refuses in a folder with its own connections and names both commands", async () => {
  const paths = resolvePaths(env);
  assert.equal((await invoke(["init", "--here", "--tools", "codex", "--auto"])).code, 0);
  assert.equal((await invoke(["wire", "codex", "--global", "--auto"])).code, 0);
  const config = readFileSync(paths.config, "utf8");
  const refused = await invoke(["eject", "--dry-run"]);
  assert.equal(refused.code, 1, JSON.stringify(refused.value));
  assert.match(refused.value.error, /^ {2}tonedial eject --here$/m);
  assert.match(refused.value.error, /^ {2}tonedial eject --global$/m);
  assert.equal(readFileSync(paths.config, "utf8"), config);
  assert.equal((await invoke(["eject", "--here", "--dry-run"])).code, 0);
});

test("init --here in the home directory refuses like wire --here and names the global command", async () => {
  const home = env.HOME!;
  for (const args of [["init", "--here", "--tools", "codex", "--auto"], ["init", "--here", "--tools", "codex", "--dry-run"]]) {
    const refused = await human(args, {}, home);
    assert.equal(refused.code, 1, args.join(" "));
    assert.match(refused.errors, /home directory/);
    assert.match(refused.errors, /^ {2}tonedial init --tools codex --global$/m);
  }
  assert.equal(existsSync(join(home, ".codex")), false);
  assert.equal(existsSync(resolvePaths(env).config), false);
});

test("unwire --here removes the skill directories it created once they are empty, and keeps a folder's own", async () => {
  assert.equal((await invoke(["init", "--here", "--tools", "codex,claude", "--auto"])).code, 0);
  assert.equal(existsSync(join(project, ".agents", "skills", "tonedial")), true);
  for (const tool of ["codex", "claude"]) assert.equal((await invoke(["unwire", tool, "--here", "--auto"])).code, 0, tool);
  assert.deepEqual(readdirSync(project), []);

  // A directory that was there before ToneDial stays, even when it ends up empty.
  mkdirSync(join(project, ".agents"));
  assert.equal((await invoke(["wire", "codex", "--here", "--auto"])).code, 0);
  assert.equal((await invoke(["unwire", "codex", "--here", "--auto"])).code, 0);
  assert.equal(existsSync(join(project, ".agents")), true);
  assert.deepEqual(readdirSync(join(project, ".agents")), [], "the skills folder it created is gone");
  assert.equal(existsSync(join(project, ".codex")), false);
});

test("a skill record from before 0.1.14 prunes only the folder it recorded creating", async () => {
  // Older records carry only `createdDir`: the link's own parent was missing. A user's empty
  // `.agents` above it was not ToneDial's, so it stays.
  mkdirSync(join(project, ".agents"));
  assert.equal((await invoke(["init", "--here", "--tools", "codex", "--auto"])).code, 0);
  const paths = resolvePaths(env);
  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  const skills = Object.values(config.wiring.resources as Record<string, { kind: string; createdDir: boolean; createdParents?: number }>)
    .filter(({ kind }) => kind === "skill");
  assert.equal(skills.length, 1);
  skills[0]!.createdDir = true;
  delete skills[0]!.createdParents;
  writeFileSync(paths.config, JSON.stringify(config, null, 2) + "\n");

  assert.equal((await invoke(["unwire", "codex", "--here", "--auto"])).code, 0);
  assert.equal(existsSync(join(project, ".agents")), true);
  assert.deepEqual(readdirSync(join(project, ".agents")), []);
});

test("a project wire beside the global connection writes and records nothing and names the two commands", async () => {
  const paths = resolvePaths(env);
  assert.equal((await invoke(["init", "--global", "--tools", "codex", "--auto"])).code, 0);
  const config = readFileSync(paths.config, "utf8");
  const hook = join(env.HOME!, ".codex", "hooks.json");
  const hookBytes = readFileSync(hook, "utf8");

  const shown = await human(["wire", "codex", "--here", "--auto"]);
  assert.equal(shown.code, 0, shown.errors);
  assert.match(shown.output.replace(/\s+/g, " "), /already gets the tone through the global connection/);
  const keepOnly = shown.output.split("\n").map((line) => line.trim());
  assert.ok(keepOnly.indexOf("tonedial unwire codex --global") >= 0, shown.output);
  assert.equal(keepOnly[keepOnly.indexOf("tonedial unwire codex --global") + 1], "tonedial wire codex --here");
  assert.doesNotMatch(shown.output, /Project files written|Changes:/);

  for (const args of [["wire", "codex", "--here", "--auto"], ["init", "--here", "--tools", "codex", "--auto"]]) {
    const machine = await invoke(args);
    assert.equal(machine.code, 0, JSON.stringify(machine.value));
    const route = (args[0] === "wire" ? machine.value.tools : machine.value.integrations)[0];
    assert.deepEqual([route.tool, route.covered, route.inherited, route.path], ["codex", true, true, hook]);
  }
  assert.deepEqual(readdirSync(project), []);
  assert.equal(readFileSync(paths.config, "utf8"), config, "no project connection is recorded");
  assert.equal(readFileSync(hook, "utf8"), hookBytes);

  // The global connection was the only one, so disconnecting it leaves nothing ToneDial wrote.
  assert.equal((await invoke(["unwire", "codex", "--global", "--auto"])).code, 0);
  assert.equal(existsSync(hook), false);
  assert.deepEqual((await invoke(["show"])).value.connections, []);
});

test("a project connected before the global one keeps its own hook until it is disconnected", async () => {
  const globalHook = join(env.HOME!, ".codex", "hooks.json");
  const projectHook = join(project, ".codex", "hooks.json");
  assert.equal((await invoke(["wire", "codex", "--here", "--auto"])).code, 1, "wire needs init first");
  assert.equal((await invoke(["init", "--here", "--tools", "codex", "--auto"])).code, 0);
  assert.equal((await invoke(["wire", "codex", "--global", "--auto"])).code, 0);
  const projectBytes = readFileSync(projectHook, "utf8");

  assert.equal((await invoke(["unwire", "codex", "--global", "--auto"])).code, 0);
  assert.equal(existsSync(globalHook), false);
  assert.equal(readFileSync(projectHook, "utf8"), projectBytes);

  // Reconnected globally and disconnected here, the folder is covered and gets nothing new.
  assert.equal((await invoke(["wire", "codex", "--global", "--auto"])).code, 0);
  assert.equal((await invoke(["unwire", "codex", "--here", "--auto"])).code, 0);
  const covered = await invoke(["wire", "codex", "--here", "--auto"]);
  assert.equal(covered.code, 0, JSON.stringify(covered.value));
  assert.equal(covered.value.tools[0].covered, true);
  assert.deepEqual(readdirSync(project), []);
});

test("a folder recorded on the global hook by an earlier version is covered and keeps its records", async () => {
  const paths = resolvePaths(env);
  assert.equal((await invoke(["init", "--global", "--tools", "codex", "--auto"])).code, 0);
  await addLegacyRider(env, "codex", project);
  const config = readFileSync(paths.config, "utf8");
  for (const args of [["wire", "codex", "--here", "--auto"], ["doctor", "--fix", "--here", "--auto"]]) {
    const machine = await invoke(args);
    assert.equal(machine.code, 0, JSON.stringify(machine.value));
    const tools = args[0] === "wire" ? machine.value.tools : machine.value.native.tools;
    assert.deepEqual(tools.map((route: { covered?: boolean }) => route.covered), [true], args.join(" "));
  }
  assert.equal(readFileSync(paths.config, "utf8"), config);
  assert.equal(existsSync(join(project, ".codex")), false);
});

test("unwire --global names and removes the project connections an earlier version recorded on its hook", async () => {
  const other = join(scratch, "other");
  mkdirSync(other);
  const hook = join(env.HOME!, ".codex", "hooks.json");
  assert.equal((await invoke(["init", "--global", "--tools", "codex", "--auto"])).code, 0);
  await addLegacyRider(env, "codex", project);
  await addLegacyRider(env, "codex", other);
  assert.equal(existsSync(join(project, ".agents", "skills", "tonedial")), true);

  const preview = await human(["unwire", "codex", "--global", "--dry-run"]);
  assert.equal(preview.code, 0, preview.errors);
  assert.match(preview.output.replace(/\s+/g, " "), /Also disconnects Codex CLI in these projects/);
  const rows = preview.output.split("\n").map((line) => line.trim());
  assert.ok(rows.includes(realpathSync(project)) && rows.includes(realpathSync(other)), preview.output);
  assert.ok(rows.indexOf(realpathSync(project)) < rows.findIndex((row) => row.startsWith("--dry-run")), "named before the result");

  const removed = await invoke(["unwire", "codex", "--global", "--auto"]);
  assert.equal(removed.code, 0, JSON.stringify(removed.value));
  assert.deepEqual(removed.value.alsoDisconnected, [
    { target: "codex", scope: "project", destination: realpathSync(other) },
    { target: "codex", scope: "project", destination: realpathSync(project) },
  ]);
  assert.equal(existsSync(hook), false, "nothing ToneDial wrote stays in the global hook file");
  assert.deepEqual(readdirSync(project), [], "each project's skill link goes as a project unwire removes it");
  assert.deepEqual(readdirSync(other), []);
  assert.deepEqual((await invoke(["show"])).value.connections, []);
});

test("unwire --global clears a global hook that only an earlier version's project record kept", async () => {
  const hook = join(env.HOME!, ".codex", "hooks.json");
  assert.equal((await invoke(["init", "--global", "--tools", "codex", "--auto"])).code, 0);
  await addLegacyRider(env, "codex", project, true);
  assert.equal(existsSync(hook), true);
  // The folder rides that hook, so it is covered too and gets nothing new.
  assert.equal((await invoke(["wire", "codex", "--here", "--auto"])).value.tools[0].covered, true);

  const removed = await invoke(["unwire", "codex", "--global", "--auto"]);
  assert.equal(removed.code, 0, JSON.stringify(removed.value));
  assert.deepEqual(removed.value.alsoDisconnected.map((row: { destination: string }) => row.destination), [realpathSync(project)]);
  assert.equal(existsSync(hook), false);
  assert.deepEqual(readdirSync(project), []);
  assert.deepEqual((await invoke(["show"])).value.connections, []);
});

test("eject --global removes earlier-version project records with the global hooks", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "codex,claude", "--auto"])).code, 0);
  await addLegacyRider(env, "claude", project);
  const ejected = await invoke(["eject", "--global", "--auto"]);
  assert.equal(ejected.code, 0, JSON.stringify(ejected.value));
  assert.deepEqual(ejected.value.alsoDisconnected.map((row: { target: string }) => row.target), ["claude"]);
  assert.equal(existsSync(join(env.HOME!, ".claude", "settings.json")), false);
  assert.deepEqual(readdirSync(project), []);
  assert.deepEqual((await invoke(["show"])).value.connections, []);
});

test("show labels a project connection an earlier version recorded on the global hook", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "codex", "--auto"])).code, 0);
  await addLegacyRider(env, "codex", project);
  const shown = await invoke(["show"]);
  assert.deepEqual(shown.value.connections, [
    { target: "codex", scope: "global", destination: realpathSync(env.HOME!) },
    { target: "codex", scope: "project", destination: realpathSync(project), sharesGlobalHook: true },
  ]);
  const rows = (await human(["show"])).output.split("\n").map((line) => line.trim());
  assert.equal(rows[rows.indexOf(realpathSync(project)) + 1], "codex · uses the global hook (earlier version)");
});
