// Native recovery uses real provider containers in temporary destinations. Application state
// is already usable; a foreign container must remain native attention, never an app failure.

import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { run, type Ctx, type Flags } from "../src/cli.ts";
import { runRebuildNative } from "../src/commands/wire.ts";
import { runAppRebuild } from "../src/commands/rebuild.ts";
import { parseConfig, requireConfigV2, serializeConfig, type LegacyOwnershipEvidence } from "../src/core/config.ts";
import { catalogue } from "../src/core/i18n.ts";
import { canonicalDestination, resolveAgentPaths, resolvePaths } from "../src/core/paths.ts";
import { palette } from "../src/ui/style.ts";
import { cells } from "../src/ui/width.ts";
import { applyRollback, gate, planChange, previewRollback } from "../src/wiring/apply.ts";
import { recordFileChange } from "../src/wiring/ownership.ts";
import { rcPath, withPathLine } from "../src/wiring/shell.ts";

let scratch: string;
let project: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-rebuild-native-"));
  project = join(scratch, "project");
  for (const path of [project, join(scratch, "home")]) mkdirSync(path);
  env = { HOME: join(scratch, "home"), TONEDIAL_HOME: join(scratch, "state"), TONEDIAL_INSTALL_SHAPE: "npm", PATH: "", LANG: "en_US.UTF-8", NO_COLOR: "1" };
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function invoke(args: string[]) {
  let output = "";
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof write;
  try {
    const code = await run([...args, "--json"], env, project, false, false);
    return { code, value: JSON.parse(output) as Record<string, unknown> };
  } finally {
    process.stdout.write = write;
  }
}

function context(flags: Partial<Flags> = {}): Ctx {
  const selected: Flags = {
    global: true, here: false, project: null, tools: null, commands: false, auto: true, dryRun: false,
    verbose: true, check: false, explain: false, fix: true, rollback: null, lang: null, ...flags,
  };
  return {
    paths: resolvePaths(env), cwd: project, env, flags: selected,
    agent: resolveAgentPaths({ global: selected.global, project: selected.project }, env, project),
    t: catalogue("en").cli, ui: palette("never", env, false), asJson: true, canPrompt: false, scopeExplicit: true,
  };
}

async function stateOnly(): Promise<Ctx> {
  const result = await invoke(["init", "--global", "--tools", "none", "--auto"]);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  const ctx = context();
  writeFileSync(join(ctx.paths.root, "tone.md"), readFileSync(ctx.paths.tone));
  const rebuilt = await runAppRebuild(ctx);
  assert.equal(rebuilt.json.appRebuilt, true, JSON.stringify(rebuilt.json));
  return ctx;
}

function historical(tool: string): LegacyOwnershipEvidence {
  return { schema: 1, wiring: { [tool]: { created: true, createdDir: true } }, managedSeeds: {} };
}

test("native recovery attention prose respects the fixed terminal width in both languages", async () => {
  const base = await stateOnly();
  for (const language of ["en", "ko"] as const) {
    const ctx = { ...base, flags: { ...base.flags, tools: "none" }, t: catalogue(language).cli, ui: palette("never", env, false, 79) };
    const result = await runRebuildNative(ctx, historical("claude"));
    assert.equal(result.json.attention, true);
    assert.ok(result.lines.length > 0);
    for (const line of result.lines) assert.ok(cells(line) <= 79, `${language}: ${line}`);
    const failure = await runRebuildNative({ ...ctx, flags: { ...ctx.flags, dryRun: false } }, null, requireConfigV2(parseConfig(readFileSync(ctx.paths.config, "utf8")), ctx.t));
    assert.equal(failure.json.attention, true);
    assert.ok(failure.lines.length > 0);
    for (const line of failure.lines) assert.ok(cells(line) <= 79, `${language}: ${line}`);
  }
});

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

async function recordedShell(ctx: Ctx, bin: string): Promise<string> {
  const path = rcPath(ctx.agent, ctx.env);
  write(path, "export USER_PREF=PRIVATE_PROFILE_VALUE\n");
  const change = planChange(path, (before) => withPathLine(before, bin, ctx.env.SHELL), ctx.t);
  const config = requireConfigV2(parseConfig(readFileSync(ctx.paths.config, "utf8")), ctx.t);
  config.wiring = recordFileChange(config.wiring, { target: "shell", scope: "global", destination: canonicalDestination(dirname(path)) },
    change, "shell", { version: 1, regionId: "tonedial" }, ctx.t);
  await gate([change], { paths: ctx.paths, t: ctx.t, ui: ctx.ui, auto: true, dryRun: false, out: () => {},
    finalChanges: [planChange(ctx.paths.config, () => serializeConfig(config, ctx.t), ctx.t, undefined, ctx.paths.root)] });
  return path;
}

for (const source of ["legacy", "binary"] as const) {
  test(`${source} app-source preview plans missing native families and optional command without publishing or exposing values`, async () => {
    const ctx = context({ tools: "claude", commands: true, dryRun: true, fromPreset: "tough-love" });
    mkdirSync(ctx.paths.root);
    const bytes = source === "binary" ? Buffer.concat([Buffer.from("PRIVATE_PREVIEW_BINARY"), Buffer.from([0xff, 0x80])]) : Buffer.from(JSON.stringify({
      schema: 1, preset: null, unsaved: true,
      axes: { formality: 1, verbosity: 4, profanity: 2, playfulness: 3, critique: 5, flattery: 1,
        warmth: 5, conviction: 4, care: 5, compliance: 3, refusal: 1, bravado: 1 },
      persona: { age: "30s", gender: "neutral", address: { self_ref: null, user_ref: null }, note: "PRIVATE_APP_PREVIEW_NOTE" },
      safeword: "old safe phrase", guards: false, speech_level: "polite", fixed_width: false, language: "en",
      wiring: { claude: { created: true } }, seedVersion: 1,
    }));
    writeFileSync(ctx.paths.config, bytes);
    const provider = ctx.agent.hookFile("claude");
    write(provider, '{"privateExample":"PRIVATE_PREVIEW_PROVIDER"}\n');
    const before = readdirSync(scratch, { recursive: true }).sort();
    const app = await runAppRebuild(ctx);
    assert.ok(app.proposedConfig);
    const proposed = structuredClone(app.proposedConfig);
    const preview = await runRebuildNative(ctx, app.legacy, app.proposedConfig);
    assert.equal(preview.json.applied, false);
    assert.equal(preview.json.reason, "dry-run");
    const diff = preview.json.diff as { path: string; kind?: string }[];
    assert.ok(diff.some((entry) => entry.path === provider));
    assert.ok(diff.some((entry) => entry.path === ctx.agent.command("tone")));
    assert.ok(diff.some((entry) => entry.kind === "skill"));
    assert.deepEqual(app.proposedConfig, proposed);
    assert.deepEqual(readFileSync(ctx.paths.config), bytes);
    assert.equal(readFileSync(provider, "utf8"), '{"privateExample":"PRIVATE_PREVIEW_PROVIDER"}\n');
    assert.deepEqual(readdirSync(scratch, { recursive: true }).sort(), before);
    for (const path of [ctx.paths.agents, ctx.paths.tone, join(ctx.paths.root, "reader.mjs"), ctx.paths.skill]) assert.equal(existsSync(path), false);
    const visible = JSON.stringify(preview.json) + preview.lines.join("\n");
    assert.doesNotMatch(visible, /PRIVATE_APP_PREVIEW_NOTE|PRIVATE_PREVIEW_BINARY|PRIVATE_PREVIEW_PROVIDER/);
    assert.equal(visible.includes(bytes.toString("base64")), false);
    const invalidApply = await runRebuildNative({ ...ctx, flags: { ...ctx.flags, dryRun: false } }, app.legacy, app.proposedConfig);
    assert.equal(invalidApply.json.applied, false);
    assert.equal(invalidApply.json.attention, true);
    assert.deepEqual(readdirSync(scratch, { recursive: true }).sort(), before);
  });
}

test("implicit curl PATH repair uses its recorded global profile without creating native families", async () => {
  const ctx = await stateOnly();
  env.SHELL = "/bin/bash";
  env.TONEDIAL_INSTALL_SHAPE = "curl";
  const path = await recordedShell(ctx, join(scratch, "old-state", "bin"));
  const before = readFileSync(path, "utf8");
  const result = await runRebuildNative(ctx);
  assert.equal(result.json.applied, true);
  assert.deepEqual(result.json.tools, []);
  assert.equal(readFileSync(path, "utf8"), withPathLine(before, ctx.paths.bin, env.SHELL));
  assert.match(readFileSync(path, "utf8"), /export USER_PREF=PRIVATE_PROFILE_VALUE/);
  assert.equal(existsSync(join(ctx.paths.root, "reader.mjs")), false);
  assert.equal(existsSync(ctx.paths.skill), false);
  assert.doesNotMatch(JSON.stringify(result.json) + result.lines.join("\n"), /PRIVATE_PROFILE_VALUE/);

  const foreign = withPathLine("export USER_PREF=PRIVATE_CHANGED_PROFILE\n", join(scratch, "other-state", "bin"), env.SHELL);
  writeFileSync(path, foreign);
  const config = readFileSync(ctx.paths.config);
  const none = await runRebuildNative(context({ tools: "none" }));
  assert.equal(none.json.applied, false);
  const projectOnly = await runRebuildNative(context({ global: false, here: true }));
  assert.equal(projectOnly.json.applied, false);
  assert.equal(readFileSync(path, "utf8"), foreign);
  assert.deepEqual(readFileSync(ctx.paths.config), config);
  const protectedResult = await runRebuildNative(ctx);
  assert.equal(protectedResult.json.attention, true);
  assert.equal(protectedResult.json.applied, false);
  assert.equal(readFileSync(path, "utf8"), foreign);
  assert.deepEqual(readFileSync(ctx.paths.config), config);
});

test("explicit curl native setup adds only its approved PATH region and preserves foreign profile lines", async () => {
  await stateOnly();
  env.SHELL = "/bin/bash";
  env.TONEDIAL_INSTALL_SHAPE = "curl";
  const ctx = context({ tools: "claude" });
  const path = rcPath(ctx.agent, env);
  const foreign = "export USER_PREF=PRIVATE_FRESH_PROFILE\n";
  write(path, foreign);
  const result = await runRebuildNative(ctx);
  assert.equal(result.json.applied, true);
  assert.equal(readFileSync(path, "utf8"), withPathLine(foreign, ctx.paths.bin, env.SHELL));
  assert.equal((result.json.shell as { path: string }).path, path);
  assert.doesNotMatch(JSON.stringify(result.json) + result.lines.join("\n"), /PRIVATE_FRESH_PROFILE/);
});

test("explicit native recovery removes only the selected exact legacy import and conceals provider bodies", async () => {
  const ctx = await stateOnly();
  const legacy = ctx.agent.wiredFile("claude");
  write(legacy, `Team guidance stays.\n\n<!-- tonedial:begin -->\n@${join(ctx.paths.root, "tone.md")}\n<!-- tonedial:end -->\n`);
  const settings = ctx.agent.hookFile("claude");
  const sibling = { matcher: "startup", hooks: [{ type: "command", command: "user-owned-command" }] };
  write(settings, JSON.stringify({ privateExample: "PRIVATE_NATIVE_6618", hooks: { SessionStart: [sibling] } }));
  const unselected = join(project, ".claude", "CLAUDE.md");
  const unselectedBytes = `<!-- tonedial:begin -->\n@${join(ctx.paths.root, "tone.md")}\n<!-- tonedial:end -->\n`;
  write(unselected, unselectedBytes);
  const lower = readFileSync(join(ctx.paths.root, "tone.md"));

  const result = await runRebuildNative(context({ tools: "claude" }), historical("claude"));
  assert.equal(result.json.applied, true);
  assert.equal(readFileSync(legacy, "utf8"), "Team guidance stays.\n");
  assert.equal(readFileSync(unselected, "utf8"), unselectedBytes);
  assert.deepEqual(readFileSync(join(ctx.paths.root, "tone.md")), lower);
  const document = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(document.privateExample, "PRIVATE_NATIVE_6618");
  assert.deepEqual(document.hooks.SessionStart[0], sibling);
  assert.equal(document.hooks.SessionStart.length, 2);
  assert.equal(document.hooks.SessionStart[1].hooks[0].args[1], "--provider");
  assert.equal(document.hooks.SessionStart[1].hooks[0].args[2], "claude");
  assert.equal(result.json.activation, "unverified");
  assert.doesNotMatch(JSON.stringify(result.json) + result.lines.join("\n"), /PRIVATE_NATIVE_6618|user-owned-command|Team guidance stays/);
  const repeated = await runRebuildNative(context({ tools: "claude" }), historical("claude"));
  assert.equal(repeated.json.reason, "nothing");
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).hooks.SessionStart.length, 2);
  assert.equal((await invoke(["export", "tough-love"])).code, 0);
});

test("an exact old Codex handler is replaced once while foreign handlers and matcher fields survive", async () => {
  const ctx = await stateOnly();
  const path = ctx.agent.hookFile("codex");
  const oldCommand = `cat "${join(ctx.paths.root, "tone.md")}"`;
  const foreign = { type: "command", command: "unrelated-native-handler", extra: "keep" };
  write(path, JSON.stringify({ privateExample: "PRIVATE_NATIVE_9702", hooks: { SessionStart: [{
    matcher: "startup|resume", customBlock: "keep block", hooks: [
      { type: "command", command: oldCommand, additionalContextLimit: 5000 }, foreign,
    ],
  }] } }));

  const result = await runRebuildNative(context({ tools: "codex" }), historical("codex"));
  assert.equal(result.json.applied, true);
  const document = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(document.privateExample, "PRIVATE_NATIVE_9702");
  assert.equal(document.hooks.SessionStart[0].customBlock, "keep block");
  assert.deepEqual(document.hooks.SessionStart[0].hooks, [foreign]);
  const handlers = document.hooks.SessionStart.flatMap((block: { hooks: { command: string }[] }) => block.hooks);
  assert.equal(handlers.filter((handler: { command: string }) => handler.command === oldCommand).length, 0);
  assert.equal(handlers.filter((handler: { command: string }) => handler.command.includes("reader.mjs")).length, 1);
  assert.doesNotMatch(JSON.stringify(result.json) + result.lines.join("\n"), /PRIVATE_NATIVE_9702|unrelated-native-handler|keep block/);
  const repeated = await runRebuildNative(context({ tools: "codex" }), historical("codex"));
  assert.equal(repeated.json.reason, "nothing");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).hooks.SessionStart.length, 2);
});

test("an altered old handler or malformed selected container remains native attention with app data usable", async () => {
  const ctx = await stateOnly();
  const path = ctx.agent.hookFile("codex");
  for (const text of [
    JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: `cat "${join(ctx.paths.root, "tone.md")}"`, additionalContextLimit: 5000, args: ["PRIVATE_NATIVE_MODIFIED"] }] }] } }),
    '{"privateExample":"PRIVATE_NATIVE_PARSE"',
  ]) {
    write(path, text);
    const config = readFileSync(ctx.paths.config);
    const result = await runRebuildNative(context({ tools: "codex" }), historical("codex"));
    assert.equal(result.json.nativeRepair, "attention");
    assert.equal(result.json.applied, false);
    assert.equal(result.json.attention, true);
    assert.ok((result.json.issues as unknown[]).length > 0);
    assert.equal(readFileSync(path, "utf8"), text);
    assert.deepEqual(readFileSync(ctx.paths.config), config);
    assert.equal(existsSync(ctx.paths.operationsLock), false);
    assert.equal(existsSync(join(ctx.paths.root, "reader.mjs")), false);
    assert.doesNotMatch(JSON.stringify(result.json) + result.lines.join("\n"), /PRIVATE_NATIVE_MODIFIED|PRIVATE_NATIVE_PARSE|additionalContextLimit/);
    assert.equal((await invoke(["use", "tough-love"])).code, 0);
  }
});

test("opaque legacy flags and explicit none cause no native inspection or writes", async () => {
  const ctx = await stateOnly();
  const path = ctx.agent.hookFile("codex");
  const bytes = '{"privateExample":"PRIVATE_NATIVE_UNSELECTED"';
  write(path, bytes);
  const files = readdirSync(ctx.paths.root).sort();
  for (const tools of [null, "none"]) {
    const result = await runRebuildNative(context({ tools }), historical("codex"));
    assert.equal(result.json.applied, false);
    assert.deepEqual(result.json.tools, []);
    assert.equal(result.json.reason, "not-selected");
    assert.equal(readFileSync(path, "utf8"), bytes);
    assert.deepEqual(readdirSync(ctx.paths.root).sort(), files);
    assert.equal(existsSync(join(ctx.agent.root, ".agents")), false);
    assert.doesNotMatch(JSON.stringify(result.json) + result.lines.join("\n"), /PRIVATE_NATIVE_UNSELECTED/);
  }
});

test("native recovery never invents settings when config disappears after application repair", async () => {
  const ctx = await stateOnly();
  rmSync(ctx.paths.config);
  const result = await runRebuildNative(context({ tools: "claude" }));
  assert.equal(result.json.applied, false);
  assert.equal(result.json.attention, true);
  assert.equal(existsSync(ctx.paths.config), false);
  assert.equal(existsSync(ctx.agent.hookFile("claude")), false);
  assert.equal(existsSync(join(ctx.paths.root, "reader.mjs")), false);
  assert.equal((await invoke(["export", "tough-love"])).code, 0);
});

test("implicit native repair follows current-scope registrations and leaves recorded foreign project content alone", async () => {
  const projectSetup = await invoke(["init", "--here", "--tools", "codex", "--auto"]);
  assert.equal(projectSetup.code, 0, JSON.stringify(projectSetup.value));
  const globalSetup = await invoke(["wire", "--global", "codex", "--auto"]);
  assert.equal(globalSetup.code, 0, JSON.stringify(globalSetup.value));
  const ctx = context();
  const globalPath = ctx.agent.hookFile("codex");
  rmSync(globalPath);
  const projectPath = resolveAgentPaths({ global: false, project: null }, env, project).hookFile("codex");
  const foreign = '{"privateExample":"PRIVATE_RECORDED_PROJECT"';
  write(projectPath, foreign);

  const result = await runRebuildNative(ctx);
  assert.equal(result.json.applied, true);
  assert.equal(readFileSync(projectPath, "utf8"), foreign);
  assert.equal(JSON.parse(readFileSync(globalPath, "utf8")).hooks.SessionStart.length, 1);
  assert.ok((result.json.issues as { reason: string }[]).some((item) => item.reason === "unselected-scopes"));
  assert.doesNotMatch(JSON.stringify(result.json) + result.lines.join("\n"), /PRIVATE_RECORDED_PROJECT/);
  const journal = JSON.parse(readFileSync(join(ctx.paths.operations, `${result.json.operationId}.json`), "utf8"));
  assert.equal(journal.actions.some((action: { path: string }) => action.path === projectPath), false);
});

test("owned missing optional commands are restored and a changed command remains protected", async () => {
  const setup = await invoke(["init", "--global", "--tools", "claude", "--commands", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const ctx = context();
  const path = ctx.agent.command("tone");
  const original = readFileSync(path);
  rmSync(path);
  const repaired = await runRebuildNative(ctx);
  assert.equal(repaired.json.applied, true);
  assert.deepEqual(readFileSync(path), original);
  const before = readFileSync(ctx.paths.config);
  writeFileSync(path, "PRIVATE_OPTIONAL_COMMAND must remain untouched\n");
  const protectedResult = await runRebuildNative(ctx);
  assert.equal(protectedResult.json.nativeRepair, "attention");
  assert.equal(protectedResult.json.applied, false);
  assert.equal(readFileSync(path, "utf8"), "PRIVATE_OPTIONAL_COMMAND must remain untouched\n");
  assert.deepEqual(readFileSync(ctx.paths.config), before);
  assert.equal(parseConfig(before.toString("utf8")).schema, 2);
  assert.doesNotMatch(JSON.stringify(protectedResult.json) + protectedResult.lines.join("\n"), /PRIVATE_OPTIONAL_COMMAND/);
});

test("native rollback restores the app-after inode so application rollback returns exact schema-1 bytes and mode", async () => {
  const ctx = context({ tools: "codex" });
  mkdirSync(ctx.paths.root);
  const original = Buffer.from(JSON.stringify({
    schema: 1, preset: null, unsaved: true,
    axes: { formality: 1, verbosity: 4, profanity: 2, playfulness: 3, critique: 5, flattery: 1,
      warmth: 5, conviction: 4, care: 5, compliance: 3, refusal: 1, bravado: 1 },
    persona: { age: "30s", gender: "neutral", address: { self_ref: null, user_ref: null }, note: "Historical user setting" },
    safeword: "old safe phrase", guards: false, speech_level: "polite", fixed_width: false, language: "en",
    wiring: { codex: { created: true, createdDir: false } }, seedVersion: 1,
  }) + "\n");
  writeFileSync(ctx.paths.config, original);
  chmodSync(ctx.paths.config, 0o640);
  const identity = (path: string) => { const stat = lstatSync(path); return `${stat.dev}:${stat.ino}`; };
  const originalIdentity = identity(ctx.paths.config);
  writeFileSync(ctx.paths.agents, "old generated operating guide\n");
  writeFileSync(join(ctx.paths.root, "tone.md"), "old generated tone\n");
  const hookPath = ctx.agent.hookFile("codex");
  const oldHook = JSON.stringify({ keep: "foreign provider setting", hooks: { SessionStart: [{
    matcher: "startup|resume", hooks: [
      { type: "command", command: `cat "${join(ctx.paths.root, "tone.md")}"`, additionalContextLimit: 5000 },
      { type: "command", command: "foreign-command" },
    ],
  }] } });
  write(hookPath, oldHook);

  const app = await runAppRebuild(ctx);
  assert.equal(app.json.appRebuilt, true);
  const appIdentity = identity(ctx.paths.config);
  const appBytes = readFileSync(ctx.paths.config);
  const native = await runRebuildNative(ctx, app.legacy);
  assert.equal(native.json.applied, true);
  const nativeId = native.json.operationId as string;
  assert.notEqual(nativeId, app.json.operationId);
  const journal = JSON.parse(readFileSync(join(ctx.paths.operations, `${nativeId}.json`), "utf8"));
  assert.equal(journal.actions.at(-1).kind, "entry-rebuild");
  assert.equal(journal.actions.at(-1).path, ctx.paths.config);
  assert.equal(journal.actions.at(-1).metadata.reason, "restore-config");

  // Equal bytes from a foreign replacement still cannot supply the retained write witness.
  const nativeBytes = readFileSync(ctx.paths.config);
  const nativeEntry = join(scratch, "native-config-entry");
  renameSync(ctx.paths.config, nativeEntry);
  writeFileSync(ctx.paths.config, nativeBytes, { mode: 0o640 });
  chmodSync(ctx.paths.config, 0o640);
  assert.notEqual(identity(ctx.paths.config), identity(nativeEntry));
  assert.equal(previewRollback(ctx.paths, nativeId, ctx.t).status, "unresolved");
  renameSync(ctx.paths.config, join(scratch, "foreign-equal-config"));
  renameSync(nativeEntry, ctx.paths.config);

  assert.equal(applyRollback(ctx.paths, nativeId, ctx.t).state, "rolled-back");
  assert.equal(identity(ctx.paths.config), appIdentity);
  assert.deepEqual(readFileSync(ctx.paths.config), appBytes);
  assert.equal(readFileSync(hookPath, "utf8"), oldHook);
  assert.equal(applyRollback(ctx.paths, app.json.operationId as string, ctx.t).state, "rolled-back");
  assert.equal(identity(ctx.paths.config), originalIdentity);
  assert.deepEqual(readFileSync(ctx.paths.config), original);
  assert.equal(lstatSync(ctx.paths.config).mode & 0o7777, 0o640);
  assert.equal(readFileSync(hookPath, "utf8"), oldHook);
});
