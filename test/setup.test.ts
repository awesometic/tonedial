import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../src/cli.ts";
import { runDoctor } from "../src/commands/doctor.ts";
import { isConfigV2, parseConfig, serializeConfig } from "../src/core/config.ts";
import { AGENT_TOOLS, LEGACY_CONTEXT_ARTIFACT_FILENAME, projectTonePath, readerPath, resolveAgentPaths, resolvePaths } from "../src/core/paths.ts";
import { seedFiles, seedRecord } from "../src/core/seeds.ts";
import { acquireOperation, beginJournal, readJournal } from "../src/core/operations.ts";
import { catalogue } from "../src/core/i18n.ts";
import { gate, planChange } from "../src/wiring/apply.ts";
import { palette } from "../src/ui/style.ts";
import { cells } from "../src/ui/width.ts";
import { createLegacyFixture } from "./support/legacy-fixture.ts";

let scratch: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-setup-"));
  env = { HOME: scratch, TONEDIAL_HOME: join(scratch, "state"), PATH: "", LANG: "en_US.UTF-8" };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function invoke(args: string[], extra: NodeJS.ProcessEnv = {}) {
  let out = "";
  let err = "";
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((text: string) => { out += text; return true; }) as typeof stdout;
  process.stderr.write = ((text: string) => { err += text; return true; }) as typeof stderr;
  try {
    const code = await run(args, { ...env, ...extra }, join(scratch, "project"), false, false);
    return { code, out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test("non-interactive setup rejects missing or invalid agent selection before writes", async () => {
  for (const args of [
    ["init", "--here", "--auto"], ["init", "--here"], ["wire", "--here", "--auto"], ["wire", "--here"],
    ["init", "--here", "--tools", ""], ["init", "--here", "--tools", "none,codex"],
    ["init", "--here", "--tools", "codex,"], ["init", "--here", "--tools", "unknown"],
    ["wire", "--here", "--tools", "none"], ["wire", "--here", "codex", "--tools", "claude"], ["wire", "--here", "codex,claude"],
    ["init", "--here", "--tools", "none", "--commands"],
  ]) {
    const result = await invoke([...args, "--json"]);
    assert.notEqual(result.code, 0, args.join(" "));
    assert.equal(JSON.parse(result.out).ok, false);
    assert.deepEqual(readdirSync(scratch), [], "invalid selection creates neither state nor host configuration");
  }
});

for (const shape of ["equal", "ancestor", "alias"] as const) {
  test(`global setup refuses ${shape} state/instruction roots without writes`, async () => {
    if (shape === "alias") symlinkSync(scratch, join(scratch, "alias"));
    const before = readdirSync(scratch);
    const result = await invoke(["init", "--global", "--tools", "none", "--auto", "--json"], {
      HOME: shape === "ancestor" ? join(scratch, "user") : scratch,
      TONEDIAL_HOME: shape === "alias" ? join(scratch, "alias") : scratch,
    });
    assert.notEqual(result.code, 0, result.out);
    assert.match(JSON.parse(result.out).error, /instruction root/);
    assert.deepEqual(readdirSync(scratch), before);
  });
}

test("unsupported tools are refused before creating files", async () => {
  for (const tool of ["other-agent", "unknown-agent"] as const) {
    const result = await invoke(["init", "--here", "--tools", tool, "--auto", "--json"]);
    assert.notEqual(result.code, 0, result.out);
    const error = JSON.parse(result.out).error as string;
    assert.equal(error, catalogue("en").cli.wiring.unknownTool(tool, AGENT_TOOLS), tool);
    assert.match(error, /Available:/);
    assert.deepEqual(readdirSync(scratch), [], tool);
  }
});

test("disconnect refuses a missing native handler identity without changing settings or registration", async () => {
  mkdirSync(join(scratch, "project"));
  const setup = await invoke(["init", "--here", "--tools", "claude", "--auto", "--json"]);
  assert.equal(setup.code, 0, setup.out + setup.err);
  const paths = resolvePaths(env);
  const settings = join(scratch, "project", ".claude", "settings.json");
  const beforeSettings = readFileSync(settings);
  const damaged = JSON.parse(readFileSync(paths.config, "utf8"));
  for (const resource of Object.values(damaged.wiring.resources) as Array<{ kind: string; managedByRegistration?: unknown }>) {
    if (resource.kind === "hook") delete resource.managedByRegistration;
  }
  writeFileSync(paths.config, JSON.stringify(damaged));
  const beforeConfig = readFileSync(paths.config);
  const disconnected = await invoke(["unwire", "--here", "claude", "--auto", "--json"]);
  assert.equal(disconnected.code, 1, disconnected.out + disconnected.err);
  assert.match(JSON.parse(disconnected.out).error, /managedByRegistration/);
  assert.deepEqual(readFileSync(paths.config), beforeConfig);
  assert.deepEqual(readFileSync(settings), beforeSettings);
  assert.equal(existsSync(join(scratch, "project", ".agents", "skills", "tonedial")), true);
});

for (const args of [["wire", "--here", "claude"], ["init", "--here", "--tools", "claude"], ["doctor", "--here", "--fix"]]) {
  test(`a retargeted host remains untouched while ${args.join(" ")} follows its current gate`, async () => {
    const entry = join(scratch, "project", ".claude", "settings.json");
    const original = join(scratch, "original.md");
    const foreign = join(scratch, "foreign.md");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(original, '{"custom":"original"}\n');
    symlinkSync(original, entry);
    const initial = await invoke(["init", "--here", "--tools", "claude", "--auto", "--json"]);
    assert.equal(initial.code, 0, initial.out + initial.err);
    const config = resolvePaths(env).config;
    const beforeConfig = readFileSync(config);
    const beforeOriginal = readFileSync(original);
    const foreignText = '{"custom":"foreign"}\n';
    writeFileSync(foreign, foreignText);
    rmSync(entry);
    symlinkSync(foreign, entry);
    const result = await invoke([...args, "--auto", "--json"]);
    if (args[0] === "doctor" || args[0] === "init") {
      assert.equal(result.code, 0, result.out + result.err);
      const report = JSON.parse(result.out);
      assert.equal(report.appHealthy, true);
      assert.equal(report.native.applied, false);
      assert.equal(report.native.nativeRepair, "attention");
    } else {
      assert.notEqual(result.code, 0, result.out);
      assert.match(JSON.parse(result.out).error, /unowned|changed/);
    }
    assert.deepEqual(readFileSync(original), beforeOriginal);
    assert.equal(readFileSync(foreign, "utf8"), foreignText);
    assert.equal(realpathSync(entry), realpathSync(foreign));
    assert.deepEqual(readFileSync(config), beforeConfig);
  });
}

for (const args of [["init", "--here", "--tools", "codex"], ["doctor", "--here", "--fix"]]) {
  test(`a retargeted shell remains untouched while ${args.join(" ")} follows its current gate`, async () => {
    const entry = join(scratch, ".bash_profile");
    const original = join(scratch, "original-shell");
    const foreign = join(scratch, "foreign-shell");
    writeFileSync(original, "# original shell\n");
    symlinkSync(original, entry);
    const extra = { SHELL: "/bin/bash", TONEDIAL_INSTALL_SHAPE: "curl" };
    const initial = await invoke(["init", "--here", "--tools", "codex", "--auto", "--json"], extra);
    assert.equal(initial.code, 0, initial.out + initial.err);
    const config = resolvePaths(env).config;
    const beforeConfig = readFileSync(config);
    const beforeOriginal = readFileSync(original);
    writeFileSync(foreign, "# foreign shell\n");
    rmSync(entry);
    symlinkSync(foreign, entry);
    const result = await invoke([...args, "--auto", "--json"], extra);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(JSON.parse(result.out).appHealthy, true);
    assert.deepEqual(readFileSync(original), beforeOriginal);
    assert.equal(readFileSync(foreign, "utf8"), "# foreign shell\n");
    assert.equal(realpathSync(entry), realpathSync(foreign));
    assert.deepEqual(readFileSync(config), beforeConfig);
  });
}

test("state-only init records only selected seeds and package update does not require native sources", async () => {
  const first = await invoke(["init", "--here", "--tools", "none", "--auto", "--json"]);
  assert.equal(first.code, 0, first.out + first.err);
  const paths = resolvePaths(env);
  const config = parseConfig(readFileSync(paths.config, "utf8"));
  assert.match(readFileSync(paths.agents, "utf8"), /^<!-- tonedial-guide:1 -->\n/);
  assert.equal(existsSync(paths.tone), true);
  assert.equal(existsSync(readerPath(paths.root)), false);
  assert.ok(Object.keys(config.managedSeeds).length > 0);
  assert.ok(Object.keys(config.managedSeeds).every((id) => !id.startsWith("skill/")));
  assert.equal(existsSync(paths.skill), false);
  assert.equal(existsSync(join(scratch, "project")), false);
  assert.equal(existsSync(join(scratch, ".zshrc")), false);
  assert.equal(existsSync(paths.operationsLock), false);
  const doctor = await invoke(["doctor", "--here", "--json"]);
  assert.equal(doctor.code, 0, doctor.out + doctor.err);
  assert.equal(JSON.parse(doctor.out).checks.some((check: { name: string }) => check.name.endsWith(" skill")), false);

  const second = await invoke(["init", "--here", "--tools", "none", "--auto", "--json"]);
  assert.equal(second.code, 0, second.out + second.err);
  assert.deepEqual(parseConfig(readFileSync(paths.config, "utf8")).managedSeeds, config.managedSeeds);
  const update = await invoke(["update", "--json"]);
  assert.equal(update.code, 0, update.out + update.err);
  assert.deepEqual(JSON.parse(update.out).staleSeeds, []);
  assert.equal(existsSync(paths.skill), false);
});

test("a generated cache without saved settings needs an explicit data source and previews without writes", async () => {
  const paths = resolvePaths(env);
  const seed = seedFiles(paths, { native: false }).find((candidate) => candidate.id.startsWith("preset/"))!;
  mkdirSync(dirname(seed.path), { recursive: true });
  writeFileSync(seed.path, seed.contents);
  for (const lang of ["en_US.UTF-8", "ko_KR.UTF-8"]) {
    const result = await invoke(["init", "--here", "--tools", "none", "--auto", "--json"], { LANG: lang });
    assert.notEqual(result.code, 0);
    const error = JSON.parse(result.out).error as string;
    assert.match(error, /--from-preset/);
    assert.equal(existsSync(paths.config), false);
    assert.equal(existsSync(paths.tone), false);
    assert.equal(readFileSync(seed.path, "utf8"), seed.contents);
    const preview = await invoke(["doctor", "--fix", "--here", "--tools", "none", "--from-preset", "tough-love", "--auto", "--dry-run", "--json"], { LANG: lang });
    assert.equal(preview.code, 0, preview.out + preview.err);
    assert.equal(JSON.parse(preview.out).appRebuilt, false);
    assert.equal(existsSync(paths.config), false);
    assert.equal(readFileSync(seed.path, "utf8"), seed.contents);
  }
  const approved = await invoke(["doctor", "--fix", "--here", "--tools", "none", "--from-preset", "tough-love", "--auto", "--json"]);
  assert.equal(approved.code, 0, approved.out + approved.err);
  assert.equal(JSON.parse(approved.out).appHealthy, true);
  assert.equal(parseConfig(readFileSync(paths.config, "utf8")).axes.warmth, 5);
});

test("native setup refuses before touching an existing unowned tone command", async () => {
  const command = join(scratch, "project", ".claude", "commands", "tone.md");
  mkdirSync(dirname(command), { recursive: true });
  const ownCommand = "# My tone command\nKeep my instructions.\n";
  writeFileSync(command, ownCommand);
  const result = await invoke(["init", "--here", "--tools", "claude", "--commands", "--auto", "--json"]);
  assert.notEqual(result.code, 0, result.out + result.err);
  assert.equal(JSON.parse(result.out).error, catalogue("en").cli.errors.ownershipConflict(command));
  assert.equal(readFileSync(command, "utf8"), ownCommand);
  assert.equal(existsSync(resolvePaths(env).config), false);
  assert.equal(existsSync(resolvePaths(env).tone), false);
  assert.deepEqual(readdirSync(join(scratch, "project", ".claude")), ["commands"]);
});

test("legacy selected agents share one approved skill and disconnect only their own consumers", async () => {
  const project = join(scratch, "project");
  const tools = ["codex", "claude"] as const;
  const fixture = await createLegacyFixture({
    env,
    cwd: project,
    routes: tools.map((tool) => ({ tool, root: project })),
    skills: [{ tools, root: project }],
  });
  const paths = fixture.paths;
  const source = join(paths.skill, "tonedial");
  const shared = join(project, ".agents", "skills", "tonedial");
  const claude = join(project, ".claude", "skills", "tonedial");
  assert.equal(realpathSync(shared), realpathSync(source));
  assert.equal(realpathSync(claude), realpathSync(source));
  assert.equal(readFileSync(join(claude, "SKILL.md"), "utf8"), readFileSync(join(source, "SKILL.md"), "utf8"));
  const config = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(config));
  const resources = Object.values(config.wiring.resources).filter((resource) => resource.kind === "skill");
  assert.equal(resources.length, 2);
  assert.equal(resources.find((resource) => resource.path === shared)!.consumers.length, 2);

  for (const tool of ["claude", "codex"] as const) {
    const removed = await invoke(["unwire", "--here", tool, "--auto", "--json"]);
    assert.equal(removed.code, 0, removed.out + removed.err);
    assert.equal(existsSync(shared), tool !== "codex", "shared delivery lasts through the final consumer");
  }
  assert.equal(existsSync(claude), false);
  assert.equal(existsSync(join(source, "SKILL.md")), true, "disconnect retains the managed source");
});

test("native wire preserves a foreign skill and succeeds after the collision is resolved", async () => {
  const setup = await invoke(["init", "--here", "--tools", "none", "--auto", "--json"]);
  assert.equal(setup.code, 0, setup.out + setup.err);
  const paths = resolvePaths(env);
  const before = readFileSync(paths.config, "utf8");
  const foreign = join(scratch, "project", ".agents", "skills", "tonedial");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "SKILL.md"), "# My skill\n");
  const refused = await invoke(["wire", "--here", "codex", "--auto", "--json"]);
  assert.notEqual(refused.code, 0);
  assert.equal(JSON.parse(refused.out).error, catalogue("en").cli.errors.ownershipConflict(foreign));
  assert.equal(readFileSync(paths.config, "utf8"), before);
  assert.equal(existsSync(paths.skill), false);
  assert.equal(existsSync(join(scratch, "project", ".codex")), false);
  rmSync(foreign, { recursive: true });
  const wired = await invoke(["wire", "--here", "codex", "--auto", "--json"]);
  assert.equal(wired.code, 0, wired.out + wired.err);
  assert.notEqual(readFileSync(paths.config, "utf8"), before);
  assert.equal(readFileSync(join(foreign, "SKILL.md"), "utf8"), readFileSync(join(paths.skill, "tonedial", "SKILL.md"), "utf8"));
  assert.equal(JSON.parse(readFileSync(join(scratch, "project", ".codex", "hooks.json"), "utf8")).hooks.SessionStart.length, 1);
});

test("state-only setup refuses a redirected preset directory without writing through it", async () => {
  const paths = resolvePaths(env);
  const outside = join(scratch, "outside");
  mkdirSync(paths.root);
  mkdirSync(outside);
  symlinkSync(outside, paths.presets);
  for (const existing of [false, true]) {
    const seed = seedFiles(paths, { native: false }).find(candidate => candidate.id.startsWith("preset/"))!;
    const outsideFile = join(outside, seed.path.slice(paths.presets.length + 1));
    if (existing) { mkdirSync(dirname(outsideFile), { recursive: true }); writeFileSync(outsideFile, "user preset\n"); }
    const before = readdirSync(outside, { recursive: true }).sort();
    const result = await invoke(["init", "--here", "--tools", "none", "--from-preset", "tough-love", "--auto", "--json"]);
    assert.notEqual(result.code, 0, result.out + result.err);
    assert.equal(existsSync(paths.config), false);
    assert.equal(existsSync(paths.operationsLock), false);
    assert.deepEqual(readdirSync(outside, { recursive: true }).sort(), before);
    if (existing) assert.equal(readFileSync(outsideFile, "utf8"), "user preset\n");
  }
});

test("init rejects a project export overlapping shared state before creating state files", async () => {
  const project = join(scratch, "project");
  const state = join(project, ".tonedial");
  const result = await invoke(["init", "--here", "--tools", "none", "--auto", "--json"], { TONEDIAL_HOME: state });
  assert.notEqual(result.code, 0, result.out + result.err);
  assert.ok(JSON.parse(result.out).error.includes(projectTonePath(project)));
  assert.deepEqual(readdirSync(scratch), []);

  const dedicated = join(scratch, "dedicated");
  mkdirSync(dedicated);
  mkdirSync(project);
  symlinkSync(dedicated, state);
  const alias = await invoke(["init", "--here", "--tools", "none", "--auto", "--json"], { TONEDIAL_HOME: dedicated });
  assert.notEqual(alias.code, 0, alias.out + alias.err);
  assert.ok(JSON.parse(alias.out).error.includes(projectTonePath(project)));
  assert.deepEqual(readdirSync(dedicated), []);
});

test("state-only rebuild refreshes a recorded generated family and leaves native destinations unselected", async () => {
  const setup = await invoke(["init", "--here", "--tools", "none", "--auto", "--json"]);
  assert.equal(setup.code, 0, setup.out + setup.err);
  const paths = resolvePaths(env);
  const native = seedFiles(paths, { native: true }).filter((seed) => seed.id.startsWith("skill/"));
  const missing = native[0]!;
  const modified = native[1]!;
  const config = parseConfig(readFileSync(paths.config, "utf8"));
  for (const seed of native) {
    mkdirSync(dirname(seed.path), { recursive: true });
    writeFileSync(seed.path, seed.contents);
    config.managedSeeds[seed.id] = seedRecord(seed);
  }
  writeFileSync(paths.config, serializeConfig(config));
  rmSync(missing.path);
  writeFileSync(modified.path, "user changes\n");
  const refreshed = await invoke(["init", "--here", "--tools", "none", "--auto", "--json"]);
  assert.equal(refreshed.code, 0, refreshed.out + refreshed.err);
  assert.equal(readFileSync(missing.path, "utf8"), missing.contents);
  assert.equal(readFileSync(modified.path, "utf8"), modified.contents);
  const updated = parseConfig(readFileSync(paths.config, "utf8"));
  for (const seed of native) assert.deepEqual(updated.managedSeeds[seed.id], seedRecord(seed));
  assert.equal(existsSync(join(scratch, "project", ".agents")), false);
  assert.equal(existsSync(join(scratch, "project", ".claude")), false);
});

test("doctor and update report an unowned seed replacement without suggesting routine refresh", async () => {
  const setup = await invoke(["init", "--here", "--tools", "none", "--auto", "--json"]);
  assert.equal(setup.code, 0, setup.out + setup.err);
  const paths = resolvePaths(env);
  const seed = seedFiles(paths, { native: false })[0]!;
  const replacement = join(scratch, "replacement");
  writeFileSync(replacement, seed.contents);
  rmSync(seed.path);
  symlinkSync(replacement, seed.path);
  const beforeConfig = readFileSync(paths.config, "utf8");
  const doctor = await invoke(["doctor", "--here", "--json"]);
  assert.equal(doctor.code, 0, doctor.out + doctor.err);
  const check = JSON.parse(doctor.out).checks.find((check: { name: string }) => check.name === "seeds");
  assert.deepEqual(check.files, [{ path: seed.path, reason: "foreign" }]);
  assert.equal(check.repair, null);
  const update = await invoke(["update", "--json"]);
  assert.equal(update.code, 0, update.out + update.err);
  assert.deepEqual(JSON.parse(update.out).seedIssues, [{ path: seed.path, reason: "foreign" }]);
  assert.equal(readFileSync(paths.config, "utf8"), beforeConfig);
  assert.equal(readFileSync(replacement, "utf8"), seed.contents);
});

test("doctor repair previews artifact changes and never connects an unselected detected agent", async () => {
  const setup = await invoke(["init", "--here", "--tools", "none", "--auto", "--json"]);
  assert.equal(setup.code, 0, setup.out + setup.err);
  const paths = resolvePaths(env);
  const original = readFileSync(paths.tone, "utf8");
  const config = readFileSync(paths.config, "utf8");
  rmSync(paths.tone);
  const claude = join(scratch, "project", ".claude");
  mkdirSync(claude, { recursive: true });
  const preview = await invoke(["doctor", "--here", "--fix", "--dry-run", "--auto", "--json"]);
  assert.equal(preview.code, 0, preview.out + preview.err);
  assert.equal(JSON.parse(preview.out).fixed, false);
  assert.equal(existsSync(paths.tone), false);
  assert.equal(readFileSync(paths.config, "utf8"), config);
  assert.equal(existsSync(paths.operationsLock), false);
  const repaired = await invoke(["doctor", "--here", "--fix", "--auto", "--json"]);
  assert.equal(repaired.code, 0, repaired.out + repaired.err);
  const result = JSON.parse(repaired.out);
  assert.equal(result.fixed, true);
  assert.equal(result.checks.find((check: { name: string }) => check.name === "TONE.md").state, "ok");
  assert.equal(readFileSync(paths.tone, "utf8"), original);
  assert.deepEqual(readdirSync(claude), []);
});

test("doctor reports pending recovery before parsing damaged config and never chooses a rollback", async () => {
  const paths = resolvePaths(env);
  const owner = acquireOperation(paths, "mutation");
  beginJournal(owner, []);
  writeFileSync(paths.config, "damaged config for recovery test\n");
  const before = readFileSync(paths.config, "utf8");
  const cwd = join(scratch, "project");
  const context = {
    paths,
    cwd,
    scopeExplicit: true,
    flags: {
      verbose: false,
      project: null,
      check: false,
      explain: false,
      global: false,
      auto: true,
      dryRun: false,
      fix: false,
      rollback: null,
      lang: null,
      commands: false,
      tools: null,
    },
    ui: palette("never", {}, false),
    agent: resolveAgentPaths({ global: false, project: null }, env, cwd),
    env,
    t: catalogue("en").cli,
    asJson: false,
    canPrompt: false,
  };
  for (const args of [["doctor", "--here"], ["doctor", "--here", "--fix", "--auto"]]) {
    context.flags.fix = args.includes("--fix");
    if (context.flags.fix) {
      await assert.rejects(() => runDoctor(context, []), /recover|rollback|doctor/i);
      assert.equal(readFileSync(paths.config, "utf8"), before);
      assert.equal(existsSync(paths.operationsLock), true);
      continue;
    }
    const result = await runDoctor(context, []);
    const report = result.json as {
      healthy: boolean;
      fixed: boolean;
      recovery: { operations: { operationId: string; state: string }[] };
    };
    assert.equal(report.healthy, false);
    assert.equal(report.fixed, false);
    assert.deepEqual(report.recovery.operations, [{ operationId: owner.owner.operationId, state: "pending" }]);
    assert.equal(readFileSync(paths.config, "utf8"), before);
    assert.equal(existsSync(paths.operationsLock), true);
    assert.doesNotMatch(JSON.stringify(result.json), /damaged config/);
  }
});

test("doctor does not adopt an unrecorded shell region as repair authority", async () => {
  const setup = await invoke(["init", "--here", "--tools", "none", "--auto", "--json"]);
  assert.equal(setup.code, 0, setup.out + setup.err);
  const shell = join(scratch, ".zshrc");
  const text = "# tonedial:begin\nexport PATH=/user-choice:$PATH\n# tonedial:end\n";
  writeFileSync(shell, text);
  const result = await invoke(["doctor", "--here", "--fix", "--auto", "--json"], { SHELL: "/bin/zsh" });
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(JSON.parse(result.out).fixed, false);
  assert.equal(readFileSync(shell, "utf8"), text);
});

test("doctor previews and restores an explicitly selected retained migration without exposing snapshots", async () => {
  assert.equal((await invoke(["init", "--here", "--tools", "none", "--auto"])).code, 0);
  const paths = resolvePaths(env);
  const target = join(paths.root, "migration.txt");
  const before = "before-context-payload\n";
  const after = "after-context-payload\n";
  writeFileSync(target, before);
  const t = catalogue("en").cli;
  const applied = await gate([planChange(target, () => after, t, undefined, paths.root)], {
    paths, t, auto: true, dryRun: false, out: () => {}, ui: palette("never", {}, false),
    retention: { kind: "migration", reason: "case" },
  });
  assert.ok(applied.operationId);
  const id = applied.operationId;
  const journalBefore = readFileSync(join(paths.operations, `${id}.json`), "utf8");
  const args = ["doctor", "--fix", "--rollback", id];

  const listing = await invoke(["doctor", "--here"]);
  assert.ok(listing.out.includes(id), "the retained backup must be discoverable without JSON");
  for (const lang of ["en_US.UTF-8", "ko_KR.UTF-8"]) {
    const preview = await invoke([...args, "--dry-run", "--json"], { LANG: lang });
    assert.equal(preview.code, 0, preview.out + preview.err);
    const report = JSON.parse(preview.out);
    assert.equal(report.fixed, false);
    assert.equal(report.reason, "dry-run");
    assert.equal(report.rollback.status, "ready");
    assert.deepEqual(report.rollback.actions.map((action: { status: string }) => action.status), ["applied"]);
    assert.doesNotMatch(preview.out, /before-context-payload|after-context-payload/);
    const human = await invoke([...args, "--dry-run"], { LANG: lang, NO_COLOR: "1", COLUMNS: "60", LINES: "24" });
    assert.equal(human.code, 0, human.out + human.err);
    assert.ok(human.out.includes(target));
    assert.doesNotMatch(human.out, /\u001b\[|before-context-payload|after-context-payload/);
    for (const line of human.out.trimEnd().split("\n")) {
      if (!line.includes(target) && !line.includes(realpathSync(target))) assert.ok(cells(line) <= 60, line);
    }
  }
  const unapproved = await invoke([...args, "--json"]);
  assert.notEqual(unapproved.code, 0, "noninteractive rollback requires approval");
  assert.equal(readFileSync(target, "utf8"), after);
  assert.equal(readFileSync(join(paths.operations, `${id}.json`), "utf8"), journalBefore);
  assert.equal(existsSync(paths.operationsLock), false);

  const restored = await invoke([...args, "--auto", "--json"]);
  assert.equal(restored.code, 0, restored.out + restored.err);
  assert.equal(JSON.parse(restored.out).fixed, true);
  assert.equal(JSON.parse(restored.out).rollback.state, "rolled-back");
  assert.equal(readFileSync(target, "utf8"), before);
  assert.equal(readJournal(paths, id)?.state, "rolled-back");
  assert.equal(existsSync(paths.operationsLock), false);
});

test("explicit selection guidance is readable in monochrome English and Korean narrow terminals", async () => {
  for (const lang of ["en_US.UTF-8", "ko_KR.UTF-8"]) {
    for (const columns of [80, 60]) {
      const result = await invoke(["init", "--here", "--auto"], { LANG: lang, NO_COLOR: "1", COLUMNS: String(columns), LINES: "24" });
      assert.notEqual(result.code, 0);
      assert.match(result.err, /--tools/);
      assert.match(result.err, /--auto/);
      assert.doesNotMatch(result.err, /\u001b\[/);
      for (const line of result.err.trimEnd().split("\n")) {
        assert.ok(cells(line) <= columns - 1, line);
      }
    }
  }
});

test("legacy A/B/global registrations survive scoped disconnection", async () => {
  const a = join(scratch, "a");
  const b = join(scratch, "b");
  const fixture = await createLegacyFixture({
    env,
    cwd: join(scratch, "project"),
    routes: [
      { tool: "codex", root: a },
      { tool: "codex", root: b },
      { tool: "codex", root: scratch, scope: "global" },
    ],
  });
  const paths = fixture.paths;
  const before = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(before));
  assert.equal(Object.keys(before.wiring.registrations).length, 3);
  assert.ok(Object.values(before.wiring.resources).every((resource) => resource.created));
  const bHook = join(b, ".codex", "hooks.json");
  const globalHook = join(scratch, ".codex", "hooks.json");
  const bBefore = readFileSync(bHook, "utf8");
  const globalBefore = readFileSync(globalHook, "utf8");
  const removed = await invoke(["unwire", "codex", "--project", a, "--auto", "--json"]);
  assert.equal(removed.code, 0, removed.out + removed.err);
  assert.equal(existsSync(join(a, ".codex", "hooks.json")), false);
  assert.equal(readFileSync(bHook, "utf8"), bBefore);
  assert.equal(readFileSync(globalHook, "utf8"), globalBefore);
  const after = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(after));
  assert.equal(Object.keys(after.wiring.registrations).length, 2);
  assert.deepEqual(after.managedSeeds, before.managedSeeds);
});

test("project eject preserves exported files and global shell setup", async () => {
  const project = join(scratch, "a");
  const fixture = await createLegacyFixture({
    env,
    cwd: join(scratch, "project"),
    routes: [{ tool: "codex", root: project }],
  });
  const exported = join(project, ".tonedial", "TONE.md");
  mkdirSync(dirname(exported), { recursive: true });
  writeFileSync(exported, "shared project artifact\n");
  const shell = join(scratch, ".zshrc");
  writeFileSync(shell, "# tonedial:begin\nexport PATH=/keep:$PATH\n# tonedial:end\n");
  const result = await invoke(["eject", "--project", project, "--auto", "--json"]);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(readFileSync(exported, "utf8"), "shared project artifact\n");
  assert.equal(readFileSync(shell, "utf8"), "# tonedial:begin\nexport PATH=/keep:$PATH\n# tonedial:end\n");
  assert.equal(existsSync(join(fixture.paths.root, LEGACY_CONTEXT_ARTIFACT_FILENAME)), true);
});

test("scoped removal preserves unrelated hook handlers and refuses changed owned handlers", async () => {
  const project = join(scratch, "a");
  await createLegacyFixture({
    env,
    cwd: join(scratch, "project"),
    routes: [{ tool: "codex", root: project }],
  });
  const hook = join(project, ".codex", "hooks.json");
  const original = readFileSync(hook, "utf8");
  const doc = JSON.parse(original);
  const ours = doc.hooks.SessionStart[0].hooks[0];
  ours.additionalContextLimit = 1;
  const edited = JSON.stringify(doc);
  writeFileSync(hook, edited);
  const refused = await invoke(["unwire", "codex", "--project", project, "--auto", "--json"]);
  assert.notEqual(refused.code, 0);
  assert.equal(readFileSync(hook, "utf8"), edited);

  const sibling = { type: "command", command: "echo leave-me" };
  const restored = JSON.parse(original);
  restored.hooks.SessionStart[0].hooks.push(sibling);
  restored.theme = "keep";
  writeFileSync(hook, JSON.stringify(restored));
  const removed = await invoke(["unwire", "codex", "--project", project, "--auto", "--json"]);
  assert.equal(removed.code, 0, removed.out + removed.err);
  const kept = JSON.parse(readFileSync(hook, "utf8"));
  assert.equal(kept.theme, "keep");
  assert.deepEqual(kept.hooks.SessionStart[0].hooks, [sibling]);
});
