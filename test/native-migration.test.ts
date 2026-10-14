import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { run } from "../src/cli.ts";
import { compile } from "../src/core/compile.ts";
import { defaultConfig, isConfigV2, parseConfig, requireConfigV2, serializeConfig } from "../src/core/config.ts";
import { catalogue } from "../src/core/i18n.ts";
import { canonicalDestination, resolveAgentPaths, resolvePaths, type AgentTool } from "../src/core/paths.ts";
import { toCompileInput } from "../src/core/resolve.ts";
import { BUNDLED, serializePreset } from "../src/core/presets.ts";
import { acquireOperation, beginJournal, inspectOperations } from "../src/core/operations.ts";
import { seedFiles, seedRecord } from "../src/core/seeds.ts";
import { gate, planChange } from "../src/wiring/apply.ts";
import { contentHash, recordFileChange } from "../src/wiring/ownership.ts";
import { wiredAt } from "../src/wiring/targets.ts";
import { legacyDelivery } from "./support/legacy-fixture.ts";
import { palette } from "../src/ui/style.ts";

const t = catalogue("en").cli;
let scratch: string;
let project: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-native-migration-"));
  project = join(scratch, "project");
  mkdirSync(project);
  env = { HOME: scratch, TONEDIAL_HOME: join(scratch, "state"), PATH: "", LANG: "en_US.UTF-8" };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function invoke(args: string[], json = true) {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = ((text: string) => { stdout += text; return true; }) as typeof out;
  process.stderr.write = ((text: string) => { stderr += text; return true; }) as typeof err;
  try {
    const code = await run([...args, ...(json ? ["--json"] : ["--color", "never"])], env, project, false, false);
    return { code, stdout, stderr, value: json ? JSON.parse(stdout) : null };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

function assertCompatibleArtifact(paths: ReturnType<typeof resolvePaths>, artifact: string): void {
  const lower = join(paths.root, "tone.md");
  assert.equal(readFileSync(paths.tone, "utf8"), artifact);
  assert.equal(readFileSync(lower, "utf8"), artifact);
  const upperEntry = lstatSync(paths.tone);
  const lowerEntry = lstatSync(lower);
  const names = readdirSync(paths.root).filter(name => name.toLowerCase() === "tone.md");
  if (upperEntry.dev === lowerEntry.dev && upperEntry.ino === lowerEntry.ino) {
    assert.deepEqual(names, ["tone.md"], "case-folding rebuild preserves the actual old spelling");
  } else {
    assert.deepEqual(names.sort(), ["TONE.md", "tone.md"], "case-sensitive delivery keeps both managed entries");
  }
}

/** Separate approvals produce separate rollback records; restore the native phase first. */
async function rollbackRebuild(value: Record<string, any>, scope: string[] = []) {
  if (value.native?.operationId) {
    assert.notEqual(value.native.operationId, value.operationId);
    const native = await invoke(["doctor", "--fix", "--rollback", value.native.operationId, "--auto", ...scope]);
    assert.equal(native.code, 0, native.stdout);
  }
  assert.equal(typeof value.operationId, "string");
  return invoke(["doctor", "--fix", "--rollback", value.operationId, "--auto", ...scope]);
}

/** Establish ownership through the existing mutation writer, not a fabricated journal. */
async function legacyState(tools: Exclude<AgentTool, "antigravity">[] = ["codex", "claude"], elsewhere?: string, destination = project) {
  const paths = resolvePaths(env);
  mkdirSync(paths.root);
  const agent = resolveAgentPaths({ global: false, project: destination }, env, project);
  const config = requireConfigV2(defaultConfig(), t);
  const artifact = compile(toCompileInput(config));
  const lower = join(paths.root, "tone.md");
  const where = wiredAt(lower, env);
  const changes = [planChange(lower, () => artifact, t, undefined, paths.root)];
  const originals = new Map<string, string>();
  for (const tool of tools) {
    const path = agent.wiredFile(tool);
    mkdirSync(dirname(path), { recursive: true });
    const original = tool === "codex" ? '{"custom":true}\n' : "User instructions.\n";
    writeFileSync(path, original);
    const change = planChange(path, (before) => legacyDelivery(tool, before, where, path, t), t);
    config.wiring = recordFileChange(config.wiring, { target: tool, scope: "project", destination: canonicalDestination(destination) },
      change, "hook", { version: 1, handlerSha256: contentHash(legacyDelivery(tool, null, where, path, t)) }, t);
    changes.push(change);
    originals.set(path, change.after!);
  }
  // A second project wired by the same old install. Its registration reads the same lower-case
  // artifact, so a transition here would change a file it still consumes.
  if (elsewhere !== undefined) {
    mkdirSync(elsewhere, { recursive: true });
    const other = resolveAgentPaths({ global: false, project: elsewhere }, env, project);
    const path = other.wiredFile("codex");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"other":true}\n');
    const change = planChange(path, (before) => legacyDelivery("codex", before, where, path, t), t);
    config.wiring = recordFileChange(config.wiring, { target: "codex", scope: "project", destination: canonicalDestination(elsewhere) },
      change, "hook", { version: 1, handlerSha256: contentHash(legacyDelivery("codex", null, where, path, t)) }, t);
    changes.push(change);
    originals.set(path, change.after!);
  }
  await gate(changes, {
    paths, t, auto: true, dryRun: false, out: () => {}, ui: palette("never", {}, false),
    finalChanges: [planChange(paths.config, () => serializeConfig(config), t, undefined, paths.root)],
  });
  return { paths, agent, lower, artifact, originals, configBytes: readFileSync(paths.config, "utf8") };
}

test("explicit native rebuild keeps compatibility delivery and separately rolls back native and application changes", async () => {
  const { paths, agent, lower, artifact, originals, configBytes } = await legacyState();
  const args = ["init", "--here", "--tools", "codex,claude", "--commands", "--auto"];
  const preview = await invoke([...args, "--dry-run"]);
  assert.equal(preview.code, 0, preview.stdout);
  assert.ok(readdirSync(paths.root).includes("tone.md"));
  assert.equal(readFileSync(paths.config, "utf8"), configBytes);
  for (const [path, before] of originals) assert.equal(readFileSync(path, "utf8"), before);

  const applied = await invoke(args);
  assert.equal(applied.code, 0, applied.stdout);
  assert.equal(typeof applied.value.operationId, "string");
  assertCompatibleArtifact(paths, artifact);
  assert.equal(applied.value.appHealthy, true);
  assert.equal(applied.value.native.applied, true);
  assert.equal(typeof applied.value.native.operationId, "string");
  // Every provider's import is removed by the transition that replaces it, and nothing the user
  // wrote in those files goes with it.
  for (const tool of ["claude"] as const) {
    assert.equal(readFileSync(agent.wiredFile(tool), "utf8"), "User instructions.\n", tool);
  }
  const codex = JSON.parse(readFileSync(agent.hookFile("codex"), "utf8"));
  assert.equal(codex.custom, true);
  assert.equal(codex.hooks.SessionStart.length, 1, "the legacy handler is replaced, not retained beside the new one");
  const command = codex.hooks.SessionStart[0].hooks[0].command;
  const output = execFileSync("/bin/sh", ["-c", command], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(output, `${readFileSync(paths.agents, "utf8")}\n\n${artifact}`);
  const repeated = await invoke(args);
  assert.equal(repeated.code, 0, repeated.stdout);

  const rollback = await rollbackRebuild(applied.value);
  assert.equal(rollback.code, 0, rollback.stdout);
  assert.ok(readdirSync(paths.root).includes("tone.md"));
  assert.ok(!readdirSync(paths.root).includes("TONE.md"));
  assert.equal(readFileSync(lower, "utf8"), artifact);
  assert.equal(readFileSync(paths.config, "utf8"), configBytes);
  for (const [path, before] of originals) assert.equal(readFileSync(path, "utf8"), before);
});

test("migration through a project alias retains the native hook, foreign handlers, and exact rollback", async () => {
  const alias = join(scratch, "project-alias");
  project = realpathSync(project);
  symlinkSync(project, alias, "dir");
  const { paths, agent, lower, artifact, configBytes } = await legacyState(["codex"], undefined, alias);
  const oldPath = agent.hookFile("codex");
  const hookPath = resolveAgentPaths({ global: false, project: null }, env, project).hookFile("codex");
  assert.notEqual(oldPath, hookPath);
  assert.equal(realpathSync(oldPath), realpathSync(hookPath));

  const foreign = { type: "command", command: "user-owned-handler" };
  const document = JSON.parse(readFileSync(oldPath, "utf8"));
  document.hooks.SessionStart[0].hooks.push(foreign);
  const foreignBlock = { ...document.hooks.SessionStart[0], hooks: [foreign] };
  document.hooks.PreToolUse = [{ matcher: "*", hooks: [foreign] }];
  const hookBytes = `${JSON.stringify(document, null, 2)}\n`;
  writeFileSync(oldPath, hookBytes);

  const applied = await invoke(["init", "--here", "--tools", "codex", "--auto"]);
  assert.equal(applied.code, 0, applied.stdout);
  const after = JSON.parse(readFileSync(hookPath, "utf8"));
  assert.equal(after.custom, true);
  assert.deepEqual(after.hooks.PreToolUse, document.hooks.PreToolUse);
  assert.deepEqual(after.hooks.SessionStart[0], foreignBlock);
  const native = after.hooks.SessionStart.flatMap((block: { hooks: Array<{ command: string }> }) => block.hooks)
    .filter((handler: { command: string }) => handler.command !== foreign.command);
  assert.equal(native.length, 1, "one replacement delivery survives on the physical hook target");
  const output = execFileSync("/bin/sh", ["-c", native[0].command], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(output, `${readFileSync(paths.agents, "utf8")}\n\n${artifact}`);
  const journal = JSON.parse(readFileSync(join(paths.operations, `${applied.value.native.operationId}.json`), "utf8"));
  assert.equal(journal.actions.filter((action: { kind: string; realPath: string }) =>
    action.kind === "file" && action.realPath === realpathSync(hookPath)).length, 1);
  const report = await invoke(["doctor", "--here"]);
  assert.equal(report.value.integrations.find((entry: { tool: string }) => entry.tool === "codex").configuration, "configured");

  const rollback = await rollbackRebuild(applied.value);
  assert.equal(rollback.code, 0, rollback.stdout);
  assert.equal(readFileSync(oldPath, "utf8"), hookBytes);
  assert.equal(readFileSync(paths.config, "utf8"), configBytes);
  assert.equal(readFileSync(lower, "utf8"), artifact);
  assert.ok(readdirSync(paths.root).includes("tone.md"));
  assert.ok(!readdirSync(paths.root).includes("TONE.md"));
});

test("selected native rebuild preserves unselected legacy delivery and keeps its lowercase artifact current", async () => {
  const { paths, originals, configBytes } = await legacyState();
  const result = await invoke(["init", "--here", "--tools", "claude", "--auto"]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.value.appHealthy, true);
  for (const [path, before] of originals) {
    if (!path.includes(".claude")) assert.equal(readFileSync(path, "utf8"), before);
  }
  const set = await invoke(["set", "care=2"]);
  assert.equal(set.code, 0, set.stdout);
  assertCompatibleArtifact(paths, readFileSync(paths.tone, "utf8"));
  assert.notEqual(readFileSync(paths.config, "utf8"), configBytes);
});

test("the rebuild receipt names its rollback while an unchanged repeat creates no recovery record", async () => {
  env.COLUMNS = "60";
  await legacyState(["codex"]);
  const applied = await invoke(["init", "--here", "--tools", "codex", "--auto"], false);
  assert.equal(applied.code, 0, applied.stderr);

  // Replacing generated entries retains originals. The copyable rollback belongs in the receipt.
  const receipt = applied.stdout;
  const json = await invoke(["compile", "--check"]);
  assert.equal(json.code, 0);
  const recorded = readdirSync(join(resolvePaths(env).root, "operations"))
    .filter((name) => name.endsWith(".json")).map((name) => name.replace(".json", ""));
  const quoted = recorded.find((id) => receipt.includes(id));
  assert.ok(quoted, `no operation id in the receipt: ${receipt}`);
  assert.ok(receipt.includes(`tonedial doctor --fix --rollback ${quoted}`), receipt);

  // An unchanged repeat has no new transaction to restore.
  const again = await invoke(["init", "--here", "--tools", "codex", "--auto"], false);
  assert.equal(again.code, 0, again.stderr);
  assert.ok(!again.stdout.includes("--rollback"), again.stdout);
});

test("a scoped rebuild keeps another project's legacy hook and synchronized compatibility output", async () => {
  const elsewhere = join(scratch, "other-project");
  const { paths, originals, artifact } = await legacyState(["codex"], elsewhere);
  const result = await invoke(["init", "--here", "--tools", "codex", "--auto"]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.value.nativeAttention, true);
  for (const [path, before] of originals) if (path.startsWith(elsewhere)) assert.equal(readFileSync(path, "utf8"), before);
  assertCompatibleArtifact(paths, artifact);
  assert.equal((await invoke(["set", "care=2"])).code, 0);
  assertCompatibleArtifact(paths, readFileSync(paths.tone, "utf8"));
});

for (const damage of ["no-witness", "edited", "unsupported-historical-action"] as const) {
  test(`${damage} generated state rebuilds after approval and retains original bytes for rollback`, async () => {
    const { paths, lower, originals, configBytes, artifact } = await legacyState(["claude"]);
    if (damage === "no-witness") {
      for (const file of readdirSync(paths.operations)) rmSync(join(paths.operations, file));
    } else if (damage === "edited") {
      writeFileSync(lower, "User edited this generated file.\n");
    } else {
      const file = join(paths.operations, readdirSync(paths.operations).find((name) => name.endsWith(".json"))!);
      const journal = JSON.parse(readFileSync(file, "utf8"));
      journal.actions.find((action: { path: string }) => action.path === lower).metadata.requestedMode = "invalid";
      writeFileSync(file, JSON.stringify(journal));
    }
    const bytes = readFileSync(lower);
    const args = ["init", "--here", "--tools", "claude", "--auto"];
    const preview = await invoke([...args, "--dry-run"]);
    assert.equal(preview.code, 0, preview.stdout);
    assert.deepEqual(readFileSync(lower), bytes);
    assert.equal(readFileSync(paths.config, "utf8"), configBytes);
    for (const [path, before] of originals) assert.equal(readFileSync(path, "utf8"), before);
    const approved = await invoke(args);
    assert.equal(approved.code, 0, approved.stdout);
    assert.equal(approved.value.appHealthy, true);
    assertCompatibleArtifact(paths, artifact);
    const restored = await rollbackRebuild(approved.value);
    assert.equal(restored.code, 0, restored.stdout);
    assert.equal(readFileSync(paths.config, "utf8"), configBytes);
    assert.deepEqual(readFileSync(lower), bytes);
    for (const [path, before] of originals) assert.equal(readFileSync(path, "utf8"), before);
  });
}

function unrecordedState(includeArtifact: boolean, schema = 1) {
  const paths = resolvePaths(env);
  mkdirSync(paths.presets, { recursive: true });
  const raw = JSON.parse(serializeConfig(defaultConfig()));
  raw.schema = schema;
  if (schema === 1) raw.wiring = { claude: { created: true, createdDir: false }, codex: { created: false } };
  raw.axes.critique = 5;
  raw.axes.care = 1;
  raw.preset = "my-own-tone";
  raw.unsaved = true;
  raw.persona = { age: "30s", gender: "neutral", address: { self_ref: "reviewer", user_ref: "colleague" }, note: "a patient reviewer" };
  raw.safeword = "straight please";
  raw.guards = false;
  raw.fixed_width = true;
  raw.speech_level = "plain";
  const configBytes = `${JSON.stringify(raw)}\n\n`;
  // The original formatting and modes belong to the retained migration, not its serializer.
  writeFileSync(paths.config, configBytes, { mode: 0o640 });
  const artifact = compile(toCompileInput(parseConfig(configBytes)));
  const lower = join(paths.root, "tone.md");
  if (includeArtifact) writeFileSync(lower, artifact, { mode: 0o600 });
  const presetPath = join(paths.presets, "my-own-tone.json");
  const presetBytes = serializePreset({ ...BUNDLED[0]!, slug: "my-own-tone", displayName: "My own tone" });
  writeFileSync(presetPath, presetBytes, { mode: 0o600 });
  return { paths, raw, configBytes, lower, artifact, presetPath, presetBytes };
}

test("approved journal-free rebuilding retains settings and raw modes across separate global app and native operations", async () => {
  const fixture = unrecordedState(true);
  const { paths, raw, configBytes, lower, artifact, presetPath, presetBytes } = fixture;
  const provider = join(scratch, ".codex");
  mkdirSync(provider, { mode: 0o750 });
  const hookPath = join(provider, "hooks.json");
  const originalHook = '{"custom":{"keep":true},"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"user-owned"}]}]}}\n';
  writeFileSync(hookPath, originalHook, { mode: 0o640 });
  const sibling = join(provider, "user-notes.md");
  writeFileSync(sibling, "user notes\n");
  const args = ["init", "--global", "--tools", "codex", "--auto"];

  const withoutApproval = await invoke(["init", "--global", "--tools", "codex"]);
  assert.equal(withoutApproval.code, 1, withoutApproval.stdout);
  assert.equal(readFileSync(paths.config, "utf8"), configBytes);
  assert.equal(readFileSync(hookPath, "utf8"), originalHook);
  const preview = await invoke(args.filter((arg) => arg !== "--auto").concat("--dry-run"));
  assert.equal(preview.code, 0, preview.stdout);
  assert.equal(readFileSync(paths.config, "utf8"), configBytes);
  assert.equal(readFileSync(lower, "utf8"), artifact);
  assert.equal(readFileSync(hookPath, "utf8"), originalHook);
  assert.equal(existsSync(paths.agents), false);
  assert.equal(existsSync(paths.operations), false);

  const applied = await invoke(args);
  assert.equal(applied.code, 0, applied.stdout);
  assert.equal(typeof applied.value.operationId, "string");
  assertCompatibleArtifact(paths, artifact);
  assert.equal(statSync(paths.tone).mode & 0o777, 0o600);
  assert.equal(statSync(paths.config).mode & 0o777, 0o640);
  assert.equal(readFileSync(presetPath, "utf8"), presetBytes);
  const current = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(current));
  for (const key of ["axes", "preset", "unsaved", "persona", "safeword", "speech_level", "language"] as const) {
    // Absent role descriptions normalize to null without changing older saved values.
    const expected = key === "persona" ? { ...raw.persona, user: null, agent: null } : raw[key];
    assert.deepEqual(current[key], expected, key);
  }
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(paths.config, "utf8")), "fixed_width"), false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(paths.config, "utf8")), "guards"), false);
  const hookResource = Object.values(current.wiring.resources).find((resource) => resource.kind === "hook")!;
  assert.equal(hookResource.created, false, "new migration approval does not own an existing provider file");
  assert.equal(hookResource.createdDir, false, "new migration approval does not own an existing provider directory");
  const document = JSON.parse(readFileSync(hookPath, "utf8"));
  assert.deepEqual(document.custom, { keep: true });
  assert.deepEqual(document.hooks.PreToolUse, JSON.parse(originalHook).hooks.PreToolUse);
  const retained = inspectOperations(paths).journals.filter((entry) => entry.journal?.retention !== undefined);
  assert.equal(typeof applied.value.native.operationId, "string");
  assert.deepEqual(retained.map((entry) => entry.operationId).sort(), [applied.value.operationId, applied.value.native.operationId].sort());
  const repeated = await invoke(args);
  assert.equal(repeated.code, 0, repeated.stdout);
  assert.deepEqual(inspectOperations(paths).journals.filter((entry) => entry.journal?.retention !== undefined)
    .map((entry) => entry.operationId).sort(), [applied.value.operationId, applied.value.native.operationId].sort());

  // A recovery ID selects its recorded global paths even when a project scope is supplied.
  const rollback = await rollbackRebuild(applied.value, ["--here"]);
  assert.equal(rollback.code, 0, rollback.stdout);
  assert.equal(readFileSync(paths.config, "utf8"), configBytes);
  assert.equal(readFileSync(lower, "utf8"), artifact);
  assert.equal(statSync(lower).mode & 0o777, 0o600);
  assert.equal(statSync(paths.config).mode & 0o777, 0o640);
  assert.equal(readFileSync(hookPath, "utf8"), originalHook);
  assert.equal(statSync(hookPath).mode & 0o777, 0o640);
  assert.equal(statSync(provider).mode & 0o777, 0o750);
  assert.equal(readFileSync(sibling, "utf8"), "user notes\n");
  assert.equal(readFileSync(presetPath, "utf8"), presetBytes);
  assert.equal(existsSync(paths.agents), false);
  assert.equal(readdirSync(paths.root).includes("TONE.md"), false);
  const restoredDiagnosis = await invoke(["doctor", "--global"]);
  assert.equal(restoredDiagnosis.code, 0, restoredDiagnosis.stdout);
  assert.equal(restoredDiagnosis.value.context.kind, "legacy");
  assert.match(restoredDiagnosis.value.checks.find((check: { name: string }) => check.name === "context").repair, /doctor --fix/);
  const retried = await invoke(args);
  assert.equal(retried.code, 0, retried.stdout);
  assert.equal(readFileSync(paths.tone, "utf8"), artifact);
  assert.equal(statSync(paths.tone).mode & 0o777, 0o600);
  assert.equal(readFileSync(presetPath, "utf8"), presetBytes);
  assert.notEqual(retried.value.operationId, applied.value.operationId);
});

test("config-only rebuilding creates the missing pair from nonempty legacy user data and retains a rollback", async () => {
  const { paths, configBytes, raw, artifact, presetPath, presetBytes } = unrecordedState(false);
  const diagnosed = await invoke(["doctor"]);
  assert.equal(diagnosed.code, 0, diagnosed.stdout);
  assert.equal(diagnosed.value.context.legacyWitness, "not-applicable");
  assert.equal(diagnosed.value.context.kind, "legacy");
  const args = ["init", "--here", "--tools", "none", "--auto"];
  const preview = await invoke([...args, "--dry-run"]);
  assert.equal(preview.code, 0, preview.stdout);
  assert.equal(readFileSync(paths.config, "utf8"), configBytes);
  assert.equal(existsSync(paths.tone), false);
  assert.equal(existsSync(paths.agents), false);
  const applied = await invoke(args);
  assert.equal(applied.code, 0, applied.stdout);
  assert.equal(readFileSync(paths.tone, "utf8"), artifact);
  assert.equal(existsSync(paths.agents), true);
  assert.equal(existsSync(paths.skill), false);
  assert.deepEqual(readdirSync(project), []);
  const current = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(current));
  assert.deepEqual(current.wiring, { registrations: {}, resources: {} });
  assert.deepEqual(current.axes, raw.axes);
  assert.equal(readFileSync(presetPath, "utf8"), presetBytes);
  const rollback = await rollbackRebuild(applied.value);
  assert.equal(rollback.code, 0, rollback.stdout);
  assert.equal(readFileSync(paths.config, "utf8"), configBytes);
  assert.equal(existsSync(paths.tone), false);
  assert.equal(existsSync(paths.agents), false);
  assert.equal(readFileSync(presetPath, "utf8"), presetBytes);
  const restoredDiagnosis = await invoke(["doctor", "--here"]);
  assert.equal(restoredDiagnosis.code, 0, restoredDiagnosis.stdout);
  assert.equal(restoredDiagnosis.value.context.kind, "legacy");
  const retried = await invoke(args);
  assert.equal(retried.code, 0, retried.stdout);
  assert.equal(readFileSync(paths.tone, "utf8"), artifact);
  assert.equal(readFileSync(presetPath, "utf8"), presetBytes);
  assert.equal(existsSync(paths.skill), false);
  assert.notEqual(retried.value.operationId, applied.value.operationId);
});

test("schema-2 journal-free lowercase state can become state-only without a historical witness", async () => {
  const { paths, configBytes, lower, artifact } = unrecordedState(true, 2);
  const diagnosed = await invoke(["doctor"]);
  assert.equal(diagnosed.code, 0, diagnosed.stdout);
  assert.equal(diagnosed.value.context.legacyWitness, "absent");
  assert.equal(diagnosed.value.context.kind, "legacy");
  const applied = await invoke(["init", "--here", "--tools", "none", "--auto"]);
  assert.equal(applied.code, 0, applied.stdout);
  assert.equal(readFileSync(paths.tone, "utf8"), artifact);
  assert.deepEqual(readdirSync(project), []);
  const rollback = await rollbackRebuild(applied.value);
  assert.equal(rollback.code, 0, rollback.stdout);
  assert.equal(readFileSync(paths.config, "utf8"), configBytes);
  assert.equal(readFileSync(lower, "utf8"), artifact);
});

for (const layout of ["lowercase", "config-only"] as const) {
  test(`state-only ${layout} rebuilding repairs retained optional sources without selecting external connections`, async () => {
    const { paths, raw, artifact } = unrecordedState(layout === "lowercase");
    const optional = seedFiles(paths, { native: true }).filter((seed) => seed.id === "reader" || seed.id.startsWith("skill/"));
    assert.deepEqual(optional.map((seed) => seed.id), ["reader", "skill/body", "skill/traits"]);
    const retained = Object.fromEntries(optional.map((seed) => [seed.id, seedRecord({
      ...seed, version: seed.version - 1, contents: `Older unselected ${seed.id}\n`,
    })]));
    raw.managedSeeds = retained;
    const configBytes = `${JSON.stringify(raw)}\n\n`;
    writeFileSync(paths.config, configBytes);
    const existing = layout === "lowercase" ? optional.find((seed) => seed.id === "skill/traits")! : null;
    if (existing) {
      mkdirSync(dirname(existing.path), { recursive: true });
      writeFileSync(existing.path, `Older unselected ${existing.id}\n`, { mode: 0o640 });
    }
    const args = ["init", "--here", "--tools", "none", "--auto"];
    const preview = await invoke([...args, "--dry-run"]);
    assert.equal(preview.code, 0, preview.stdout);
    assert.equal(readFileSync(paths.config, "utf8"), configBytes);
    const applied = await invoke(args);
    assert.equal(applied.code, 0, applied.stdout);
    assert.equal(readFileSync(paths.tone, "utf8"), artifact);
    assert.deepEqual(readdirSync(project), []);
    const current = parseConfig(readFileSync(paths.config, "utf8"));
    for (const seed of optional) {
      assert.deepEqual(current.managedSeeds[seed.id], seedRecord(seed), seed.id);
      assert.equal(readFileSync(seed.path, "utf8"), seed.contents, seed.id);
      if (seed.id === existing?.id) {
        assert.equal(statSync(seed.path).mode & 0o777, 0o640);
      }
    }
    const rollback = await rollbackRebuild(applied.value);
    assert.equal(rollback.code, 0, rollback.stdout);
    assert.equal(readFileSync(paths.config, "utf8"), configBytes);
    for (const seed of optional) assert.equal(existsSync(seed.path), seed.id === existing?.id, seed.id);
    if (existing) assert.equal(readFileSync(existing.path, "utf8"), `Older unselected ${existing.id}\n`);
  });
}

for (const variant of ["uppercase", "guide", "seed", "edited", "link", "unrecorded-provider", "partial-consumer-scan"] as const) {
  test(`approved app rebuild replaces ${variant} generated evidence and preserves unselected external files`, async () => {
    const { paths, lower, artifact, raw, presetPath, presetBytes } = unrecordedState(true);
    let external: string | null = null;
    let externalBytes: string | null = null;
    if (variant === "uppercase") renameSync(lower, paths.tone);
    if (variant === "guide") writeFileSync(paths.agents, "Unrecorded generated guide.\n");
    if (variant === "seed") {
      const seed = seedFiles(paths, { native: false }).find(candidate => candidate.id.startsWith("preset/"))!;
      mkdirSync(dirname(seed.path), { recursive: true });
      writeFileSync(seed.path, "Old modified generated cache.\n");
    }
    if (variant === "edited") writeFileSync(lower, "An edited generated artifact.\n");
    if (variant === "link") {
      external = join(scratch, "foreign-tone.md");
      externalBytes = artifact;
      writeFileSync(external, externalBytes);
      rmSync(lower);
      symlinkSync(external, lower);
    }
    if (variant === "unrecorded-provider") {
      external = join(project, ".claude", "CLAUDE.md");
      externalBytes = `<!-- tonedial:begin -->\n@${lower}\n<!-- tonedial:end -->\n`;
    }
    if (variant === "partial-consumer-scan") {
      external = join(project, ".claude", "settings.json");
      externalBytes = "PRIVATE_INVALID_PROVIDER_PAYLOAD\n";
    }
    if (external !== null && externalBytes !== null) {
      mkdirSync(dirname(external), { recursive: true });
      writeFileSync(external, externalBytes);
    }
    const beforeConfig = readFileSync(paths.config);
    const preview = await invoke(["init", "--here", "--tools", "none", "--auto", "--dry-run"]);
    assert.equal(preview.code, 0, preview.stdout);
    assert.deepEqual(readFileSync(paths.config), beforeConfig);
    assert.equal(readFileSync(presetPath, "utf8"), presetBytes);
    const result = await invoke(["init", "--here", "--tools", "none", "--auto"]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.value.appHealthy, true);
    assert.equal(result.value.nativeAttention, true);
    assert.equal(readFileSync(paths.tone, "utf8"), artifact);
    if (variant !== "uppercase") assertCompatibleArtifact(paths, artifact);
    for (const key of ["axes", "preset", "unsaved", "persona", "safeword", "speech_level", "language"] as const) {
      const expected = key === "persona" ? { ...raw.persona, user: null, agent: null } : raw[key];
      assert.deepEqual(parseConfig(readFileSync(paths.config, "utf8"))[key], expected, key);
    }
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(paths.config, "utf8")), "fixed_width"), false);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(paths.config, "utf8")), "guards"), false);
    assert.equal(readFileSync(presetPath, "utf8"), presetBytes);
    assert.equal(statSync(presetPath).mode & 0o777, 0o600);
    assert.doesNotMatch(result.stdout, /PRIVATE_IN/);
    if (external !== null) assert.equal(readFileSync(external, "utf8"), externalBytes);
    if (variant === "link") assert.equal(lstatSync(lower).isSymbolicLink(), false);
  });
}

test("a future config schema stays untouched until an explicit supported recovery source is selected", async () => {
  const { paths, raw, lower, presetPath, presetBytes } = unrecordedState(true);
  raw.schema = 99;
  writeFileSync(paths.config, JSON.stringify(raw));
  const before = readFileSync(paths.config);
  const artifact = readFileSync(lower);
  const entries = readdirSync(paths.root, { recursive: true }).sort();
  const result = await invoke(["init", "--here", "--tools", "none", "--auto"]);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.value.ok, false);
  assert.deepEqual(readFileSync(paths.config), before);
  assert.deepEqual(readFileSync(lower), artifact);
  assert.equal(readFileSync(presetPath, "utf8"), presetBytes);
  assert.deepEqual(readdirSync(paths.root, { recursive: true }).sort(), entries);
});

test("nonempty opaque legacy wiring stays historical while rebuilding without reading its stored destination", async () => {
  const { paths, lower, artifact, raw } = unrecordedState(true);
  const opaqueDestination = join(scratch, "opaque-destination.json");
  writeFileSync(opaqueDestination, "foreign opaque destination\n");
  raw.wiring = { unknown: { destination: opaqueDestination, created: true, createdDir: true } };
  const config = `${JSON.stringify(raw)}\n`;
  writeFileSync(paths.config, config);
  const open = fs.openSync;
  const read = fs.readFileSync;
  let destinationReads = 0;
  fs.openSync = ((path: fs.PathLike, ...args: unknown[]) => {
    if (path === opaqueDestination) destinationReads++;
    return Reflect.apply(open, fs, [path, ...args]);
  }) as typeof fs.openSync;
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (path === opaqueDestination) destinationReads++;
    return Reflect.apply(read, fs, [path, ...args]);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    const result = await invoke(["init", "--here", "--tools", "none", "--migrate-legacy", "--auto"]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.value.appHealthy, true);
    assert.equal(result.value.nativeAttention, true);
    assert.equal(destinationReads, 0, "opaque paths are evidence, never authority to inspect a destination");
  } finally {
    fs.openSync = open;
    fs.readFileSync = read;
    syncBuiltinESMExports();
  }
  const saved = parseConfig(readFileSync(paths.config, "utf8"));
  assert.deepEqual(saved.axes, raw.axes);
  assert.deepEqual(saved.wiring, { registrations: {}, resources: {} });
  assert.equal(readFileSync(lower, "utf8"), artifact);
  assert.equal(readFileSync(opaqueDestination, "utf8"), "foreign opaque destination\n");
  assert.equal(existsSync(paths.operations), true);
});

test("approved app rebuilding restores modified recorded generated seeds and retains their exact preimages", async () => {
  const { paths, raw, lower, artifact, presetPath, presetBytes } = unrecordedState(true);
  const seeds = seedFiles(paths, { native: false });
  const guide = seeds.find(seed => seed.id === "guide")!;
  const preset = seeds.find(seed => seed.id.startsWith("preset/"))!;
  for (const seed of [guide, preset]) {
    mkdirSync(dirname(seed.path), { recursive: true });
    writeFileSync(seed.path, seed.contents);
    raw.managedSeeds[seed.id] = seedRecord(seed);
  }
  const config = `${JSON.stringify(raw)}\n`;
  writeFileSync(paths.config, config);
  for (const edited of [guide, preset]) {
    const original = "User changed this generated seed.\n";
    writeFileSync(edited.path, original);
    const result = await invoke(["init", "--here", "--tools", "none", "--auto"]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(readFileSync(edited.path, "utf8"), edited.contents);
    assert.equal(readFileSync(presetPath, "utf8"), presetBytes);
    assertCompatibleArtifact(paths, artifact);
    const restored = await rollbackRebuild(result.value);
    assert.equal(restored.code, 0, restored.stdout);
    assert.equal(readFileSync(edited.path, "utf8"), original);
    assert.equal(readFileSync(paths.config, "utf8"), config);
    assert.equal(readFileSync(lower, "utf8"), artifact);
    assert.equal(readFileSync(presetPath, "utf8"), presetBytes);
    writeFileSync(edited.path, edited.contents);
  }
});

test("state-only rebuilding leaves legacy consumers untouched and keeps their compatibility artifact synchronized", async () => {
  const { paths, lower, artifact, originals } = await legacyState(["claude"]);
  const result = await invoke(["init", "--here", "--tools", "none", "--auto"]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.value.appHealthy, true);
  assert.equal(result.value.nativeAttention, true);
  assertCompatibleArtifact(paths, artifact);
  for (const [path, bytes] of originals) assert.equal(readFileSync(path, "utf8"), bytes);
  const changed = await invoke(["set", "care=2"]);
  assert.equal(changed.code, 0, changed.stdout);
  assert.equal(readFileSync(lower, "utf8"), readFileSync(paths.tone, "utf8"));
  for (const [path, bytes] of originals) assert.equal(readFileSync(path, "utf8"), bytes);
});

test("later scoped disconnect preserves provider containers that migration approval did not create", async () => {
  const { paths } = unrecordedState(false);
  const provider = join(project, ".claude");
  const hook = join(provider, "settings.json");
  mkdirSync(provider, { mode: 0o750 });
  writeFileSync(hook, "{}\n", { mode: 0o600 });
  const applied = await invoke(["init", "--here", "--tools", "claude", "--migrate-legacy", "--auto"]);
  assert.equal(applied.code, 0, applied.stdout);
  const disconnected = await invoke(["unwire", "claude", "--here", "--auto"]);
  assert.equal(disconnected.code, 0, disconnected.stdout);
  assert.equal(existsSync(hook), true, "an emptied pre-existing settings file remains the user's file");
  assert.deepEqual(JSON.parse(readFileSync(hook, "utf8")), {});
  assert.equal(statSync(hook).mode & 0o777, 0o600);
  assert.equal(statSync(provider).mode & 0o777, 0o750);
  const ejected = await invoke(["eject", "--here", "--auto"]);
  assert.equal(ejected.code, 0, ejected.stdout);
  assert.equal(existsSync(provider), true);
  assert.equal(existsSync(hook), true);
  assert.equal(statSync(hook).mode & 0o777, 0o600);
  assert.equal(existsSync(paths.agents), true);
  assert.equal(existsSync(paths.tone), true);
});

for (const state of ["pending", "invalid"] as const) {
  test(`${state} recovery precedes init's damaged config, provider inspection, and missing scope`, async () => {
    const paths = resolvePaths(env);
    const owner = acquireOperation(paths, "mutation");
    const journal = beginJournal(owner, []);
    if (state === "invalid") writeFileSync(join(paths.operations, `${journal.operationId}.json`), "invalid journal\n");
    writeFileSync(paths.config, "damaged config\n");
    const provider = join(scratch, ".claude", "settings.json");
    mkdirSync(dirname(provider), { recursive: true });
    writeFileSync(provider, "damaged provider settings\n");
    const before = readdirSync(paths.root, { recursive: true }).sort();
    const result = await invoke(["init", "--tools", "none", "--auto"]);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.value.error, /recover|rollback|doctor/i);
    assert.doesNotMatch(result.value.error, /JSON|--global|--here|--project/);
    assert.equal(readFileSync(paths.config, "utf8"), "damaged config\n");
    assert.equal(readFileSync(provider, "utf8"), "damaged provider settings\n");
    assert.deepEqual(readdirSync(paths.root, { recursive: true }).sort(), before);
    assert.equal(existsSync(paths.operationsLock), true);
  });
}
