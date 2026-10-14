import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { run } from "../src/cli.ts";
import { catalogue } from "../src/core/i18n.ts";
import { isConfigV2, parseConfig, serializeConfig, type Config } from "../src/core/config.ts";
import { readerPath, resolveAgentPaths, resolvePaths } from "../src/core/paths.ts";
import { inspectSeeds, seedFiles, seedRecord } from "../src/core/seeds.ts";
import { gate, planChange } from "../src/wiring/apply.ts";
import { orderedFingerprint, planOrderedDelivery, recordedHook } from "../src/wiring/targets.ts";
import { palette } from "../src/ui/style.ts";

let scratch: string;
let env: NodeJS.ProcessEnv;
let project: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-native-"));
  project = join(scratch, "project");
  mkdirSync(project);
  env = { HOME: scratch, TONEDIAL_HOME: join(scratch, "state 한글 ' \" $d `literal`"), PATH: "", LANG: "en_US.UTF-8" };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function invoke(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = ((text: string) => { output += text; return true; }) as typeof original;
  try {
    const code = await run([...args, "--json"], { ...env, ...extraEnv }, project, false, false);
    return { code, value: JSON.parse(output) };
  } finally {
    process.stdout.write = original;
  }
}

for (const tool of ["codex", "claude", "antigravity"] as const) {
  test(`${tool} native setup delivers the pair and scoped removal preserves user settings`, async () => {
    const agent = resolveAgentPaths({ global: false, project: null }, env, project);
    const path = agent.hookFile(tool);
    const isAntigravity = tool === "antigravity";
    const sibling = { matcher: "startup", hooks: [{ type: "command", command: "user-owned-hook", description: "User hook" }] };
    const original = isAntigravity
      ? { custom: { keep: true }, foreign: { keep: "user hook" } }
      : { custom: { keep: true }, hooks: { SessionStart: [sibling] } };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(original));
    const instruction = isAntigravity ? null : join(project, tool === "claude" ? "CLAUDE.md" : "AGENTS.md");
    if (instruction) writeFileSync(instruction, "User project instructions stay unchanged.\n");

    const args = ["init", "--here", "--tools", tool, "--auto", ...(tool === "claude" ? ["--commands"] : [])];
    const preview = await invoke([...args, "--dry-run"]);
    assert.equal(preview.code, 0, JSON.stringify(preview.value));
    assert.equal(existsSync(resolvePaths(env).root), false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);

    const setup = await invoke(args);
    assert.equal(setup.code, 0, JSON.stringify(setup.value));
    const paths = resolvePaths(env);
    const installed = readFileSync(path, "utf8");
    const document = JSON.parse(installed);
    assert.deepEqual(document.custom, original.custom);
    if (isAntigravity) {
      assert.deepEqual(document.foreign, original.foreign);
      assert.equal(document.tonedial.enabled, true);
      assert.equal(document.tonedial.PreInvocation.length, 1);
      const hook = document.tonedial.PreInvocation[0];
      assert.deepEqual(Object.keys(hook).sort(), ["command", "type"]);
      assert.equal(hook.type, "command");
      assert.match(hook.command, /--provider[ ="]+antigravity(?:[ "']|$)/);
      const output = JSON.parse(execFileSync("/bin/sh", ["-c", hook.command], { env, encoding: "utf8" })) as {
        injectSteps: Array<{ ephemeralMessage: string }>;
      };
      assert.equal(output.injectSteps[0]?.ephemeralMessage, `${readFileSync(paths.agents, "utf8")}\n\n${readFileSync(paths.tone, "utf8")}`);
    } else {
      assert.deepEqual(document.hooks.SessionStart[0], sibling);
      // Codex and Claude document their session sources as matcher expressions; all of their
      // handlers run the same reader and preserve the user's existing block.
      const ourBlocks = document.hooks.SessionStart.slice(1);
      assert.deepEqual(ourBlocks.map((block: { matcher: string }) => block.matcher),
        tool === "claude" ? ["startup|resume|clear|compact|fork"] : ["startup|resume|clear|compact"]);
      for (const block of ourBlocks) assert.deepEqual(block.hooks, ourBlocks[0].hooks);
      const hook = ourBlocks[0].hooks[0];
      assert.equal(hook.statusMessage, "ToneDial: load saved response tone");
      assert.equal(hook.name, undefined, "Codex and Claude do not use a handler name");
      assert.equal(hook.description, undefined, "the purpose slot is not a Codex/Claude handler field");
      assert.equal(document.description, tool === "codex" ? "ToneDial: load saved response tone" : undefined);
      const run = () => tool === "claude"
        ? execFileSync(hook.command, hook.args, { env, encoding: "utf8", timeout: 5000 })
        : execFileSync("/bin/sh", ["-c", hook.command], { env, encoding: "utf8", timeout: 5000 });
      assert.equal(run(), `${readFileSync(paths.agents, "utf8")}\n\n${readFileSync(paths.tone, "utf8")}`);
      for (const event of ["UserPromptSubmit", "Stop"] as const) {
        const eventBlocks = document.hooks[event];
        assert.equal(eventBlocks.length, 1, `${event} has one managed entry`);
        assert.equal((eventBlocks[0] as { matcher?: string }).matcher, undefined, `${event} has no lifecycle matcher`);
        const eventHandler = (eventBlocks[0] as { hooks: Array<{ command: string; args?: string[] }> }).hooks[0]!;
        if (tool === "claude") {
          assert.deepEqual(eventHandler.args?.slice(-2), ["--event", event]);
        } else {
          assert.match(eventHandler.command, new RegExp(`--event[ \\\"']+${event}`));
        }
      }
    }

    if (!isAntigravity) {
      const damaged = JSON.parse(readFileSync(paths.config, "utf8"));
      const managed = Object.values(damaged.wiring.resources as Record<string, any>)
        .find((resource) => resource.kind === "hook").managedByRegistration;
      const event = Object.values(managed as Record<string, any>)[0].events[0];
      event.matchers = ["\0"];
      assert.throws(() => parseConfig(JSON.stringify(damaged)), /events\.0\.matchers/,
        "invalid event matchers reached native ownership");
    }

    const repeated = await invoke(args);
    assert.equal(repeated.code, 0, JSON.stringify(repeated.value));
    assert.equal(readFileSync(path, "utf8"), installed, "repeat setup must not duplicate the handler");
    assert.match(readFileSync(join(project, ".agents", "skills", "tonedial", "SKILL.md"), "utf8"), /agentsPath/);
    if (tool === "claude") {
      // A link, not a copy: two physical sources drift the moment one is refreshed, and equal
      // bytes today cannot tell the two apart.
      const alias = join(project, ".claude", "skills", "tonedial");
      assert.equal(lstatSync(alias).isSymbolicLink(), true, "the provider path is a second copy, not an alias");
      assert.equal(realpathSync(alias), realpathSync(join(project, ".agents", "skills", "tonedial")));
      assert.match(readFileSync(agent.command("tone"), "utf8"), /agentsPath/);
      assert.equal(existsSync(agent.wiredFile(tool)), false, "new setup must not create legacy imports");
    }

    const changed = await invoke(["set", "care=2"]);
    assert.equal(changed.code, 0, JSON.stringify(changed.value));
    const afterChange = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    if (isAntigravity) {
      const output = JSON.parse(execFileSync("/bin/sh", ["-c", afterChange.tonedial.PreInvocation[0].command], { env, encoding: "utf8" })) as {
        injectSteps: Array<{ ephemeralMessage: string }>;
      };
      assert.equal(output.injectSteps[0]?.ephemeralMessage, `${readFileSync(paths.agents, "utf8")}\n\n${readFileSync(paths.tone, "utf8")}`);
    } else {
      const afterHook = afterChange.hooks.SessionStart.slice(1)[0].hooks[0];
      const output = tool === "claude"
        ? execFileSync(afterHook.command, afterHook.args, { env, encoding: "utf8", timeout: 5000 })
        : execFileSync("/bin/sh", ["-c", afterHook.command], { env, encoding: "utf8", timeout: 5000 });
      assert.equal(output, `${readFileSync(paths.agents, "utf8")}\n\n${readFileSync(paths.tone, "utf8")}`);
    }
    const doctor = await invoke(["doctor", "--here"]);
    assert.equal(doctor.code, 0, JSON.stringify(doctor.value));
    assert.equal(doctor.value.reader.state, "runnable");

    const eject = await invoke(["eject", "--here", "--auto"]);
    assert.equal(eject.code, 0, JSON.stringify(eject.value));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);
    if (instruction) assert.equal(readFileSync(instruction, "utf8"), "User project instructions stay unchanged.\n");
    assert.equal(existsSync(join(project, ".agents", "skills", "tonedial")), false);
    if (tool === "claude") {
      assert.equal(existsSync(join(project, ".claude", "skills", "tonedial")), false, "the provider alias outlived its registration");
      assert.equal(existsSync(agent.command("tone")), false, "the optional command outlived its registration");
    }
    // Disconnecting removes the delivery, never the dial: the state root keeps the guide, the
    // artifact, and the skill source the next setup links to again.
    assert.equal(existsSync(paths.agents), true);
    assert.equal(existsSync(paths.tone), true);
    assert.equal(existsSync(join(paths.skill, "tonedial", "SKILL.md")), true, "the managed skill source was removed with its link");
    assert.equal(readdirSync(paths.root).includes("operations.lock"), false);
  });
}

test("older recorded hooks inherit unchanged and refresh metadata only in the selected global scope", async () => {
  const setup = await invoke(["init", "--global", "--tools", "codex", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const paths = resolvePaths(env);
  const globalAgent = resolveAgentPaths({ global: true, project: null }, env, project);
  const projectAgent = resolveAgentPaths({ global: false, project: null }, env, project);
  const path = globalAgent.hookFile("codex");
  const config = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(config));
  const resource = Object.values(config.wiring.resources).find((entry) => entry.kind === "hook");
  assert.ok(resource);
  const globalId = resource.consumers[0]!;
  const old = recordedHook(resource, globalId)!;
  delete old.handler.statusMessage;
  delete old.documentDescription;
  const document = JSON.parse(readFileSync(path, "utf8"));
  delete document.description;
  delete document.hooks.SessionStart[0].hooks[0].statusMessage;
  const oldSettings = `${JSON.stringify(document, null, 2)}\n`;
  writeFileSync(path, oldSettings);
  const hash = orderedFingerprint(old, path, catalogue("en").cli);
  for (const metadata of [resource.managed, ...Object.values(resource.managedByRegistration!)]) {
    delete metadata.statusMessage;
    metadata.handlerSha256 = hash;
  }
  delete resource.documentDescription;
  resource.expected.sha256 = createHash("sha256").update(oldSettings).digest("hex");
  writeFileSync(paths.config, serializeConfig(config));

  const report = await invoke(["doctor", "--global"]);
  assert.equal(report.value.integrations.find((entry: { tool: string }) => entry.tool === "codex").configuration, "stale");
  const wired = await invoke(["wire", "--here", "codex", "--auto"]);
  assert.equal(wired.code, 0, JSON.stringify(wired.value));
  assert.equal(existsSync(projectAgent.hookFile("codex")), false, "inheritance keeps the existing global command");
  assert.equal(readFileSync(path, "utf8"), oldSettings, "project setup cannot rewrite global display metadata");
  const inherited = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(inherited));
  const inheritedHook = Object.values(inherited.wiring.resources).find((entry) => entry.kind === "hook")!;
  assert.equal(inheritedHook.consumers.length, 2);
  for (const entry of Object.values(inheritedHook.managedByRegistration!)) {
    assert.equal(entry.statusMessage, undefined, "the new consumer owns the exact old handler");
    assert.equal(entry.handlerSha256, hash);
  }
  for (const args of [["wire", "--here", "codex", "--auto"], ["init", "--here", "--tools", "codex", "--auto"]]) {
    const repeatedProject = await invoke(args);
    assert.equal(repeatedProject.code, 0, JSON.stringify(repeatedProject.value));
    assert.equal(readFileSync(path, "utf8"), oldSettings, "repeated project setup cannot relabel the global hook");
    assert.equal(existsSync(projectAgent.hookFile("codex")), false);
  }
  const globalRefresh = await invoke(["init", "--global", "--tools", "codex", "--auto"]);
  assert.equal(globalRefresh.code, 0, JSON.stringify(globalRefresh.value));
  const refreshed = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(refreshed.description, "ToneDial: load saved response tone");
  assert.equal(refreshed.hooks.SessionStart.length, 1);
  assert.equal(refreshed.hooks.SessionStart[0].hooks[0].statusMessage, "ToneDial: load saved response tone");
  const persisted = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(persisted));
  const shared = Object.values(persisted.wiring.resources).find((entry) => entry.kind === "hook")!;
  assert.equal(shared.consumers.length, 2);
  assert.equal(shared.documentDescription, refreshed.description);
  for (const metadata of Object.values(shared.managedByRegistration!)) {
    assert.equal(metadata.statusMessage, refreshed.hooks.SessionStart[0].hooks[0].statusMessage);
  }

  const disconnectedGlobal = await invoke(["unwire", "--global", "codex", "--auto"]);
  assert.equal(disconnectedGlobal.code, 0, JSON.stringify(disconnectedGlobal.value));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), refreshed, "the remaining project keeps the shared handler and description");
  const disconnectedProject = await invoke(["unwire", "--here", "codex", "--auto"]);
  assert.equal(disconnectedProject.code, 0, JSON.stringify(disconnectedProject.value));
  assert.equal(existsSync(path), false, "the final consumer removes the created hook document");
});

test("Codex setup and removal preserve existing or edited file descriptions", async () => {
  const agent = resolveAgentPaths({ global: false, project: null }, env, project);
  const path = agent.hookFile("codex");
  const sibling = { matcher: "startup", hooks: [{ type: "command", command: "user-owned", description: "User handler" }] };
  const original = { description: "ToneDial: load saved response tone", hooks: { SessionStart: [sibling] } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(original));
  const setup = await invoke(["init", "--here", "--tools", "codex", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const paths = resolvePaths(env);
  let config = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(config));
  let resource = Object.values(config.wiring.resources).find((entry) => entry.kind === "hook")!;
  assert.equal(resource.documentDescription, undefined, "an identical existing description must not be adopted");
  const firstDisconnect = await invoke(["unwire", "--here", "codex", "--auto"]);
  assert.equal(firstDisconnect.code, 0, JSON.stringify(firstDisconnect.value));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);

  delete (original as { description?: string }).description;
  writeFileSync(path, JSON.stringify(original));
  const rewired = await invoke(["wire", "--here", "codex", "--auto"]);
  assert.equal(rewired.code, 0, JSON.stringify(rewired.value));
  const edited = JSON.parse(readFileSync(path, "utf8"));
  edited.description = "My session hooks";
  writeFileSync(path, JSON.stringify(edited));
  const refresh = await invoke(["wire", "--here", "codex", "--auto"]);
  assert.equal(refresh.code, 0, JSON.stringify(refresh.value));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).description, "My session hooks");
  config = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(config));
  resource = Object.values(config.wiring.resources).find((entry) => entry.kind === "hook")!;
  assert.equal(resource.documentDescription, undefined, "refresh releases ownership of edited document metadata");
  const secondDisconnect = await invoke(["unwire", "--here", "codex", "--auto"]);
  assert.equal(secondDisconnect.code, 0, JSON.stringify(secondDisconnect.value));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...original, description: "My session hooks" });
});

test("edited Antigravity commands are preserved and refuse refresh or removal", async () => {
  const setup = await invoke(["init", "--here", "--tools", "antigravity", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const path = resolveAgentPaths({ global: false, project: null }, env, project).hookFile("antigravity");
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.tonedial.PreInvocation[0].command += " --edited-by-user";
  writeFileSync(path, JSON.stringify(document));
  const paths = resolvePaths(env);
  const before = [path, paths.config].map((file) => ({ file, contents: readFileSync(file, "utf8") }));
  const doctor = await invoke(["doctor", "--here"]);
  assert.equal(doctor.value.integrations.find((entry: { tool: string }) => entry.tool === "antigravity").configuration, "foreign");
  const refresh = await invoke(["wire", "--here", "antigravity", "--auto"]);
  assert.notEqual(refresh.code, 0, JSON.stringify(refresh.value));
  const remove = await invoke(["unwire", "--here", "antigravity", "--auto"]);
  assert.notEqual(remove.code, 0, JSON.stringify(remove.value));
  for (const { file, contents } of before) assert.equal(readFileSync(file, "utf8"), contents);
});

test("a managed file description remains until the last distinct handler consumer disconnects", async () => {
  const agent = resolveAgentPaths({ global: false, project: null }, env, project);
  const path = agent.hookFile("codex");
  const alias = agent.hookFile("claude");
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(alias), { recursive: true });
  writeFileSync(path, '{"userSetting":true}\n');
  symlinkSync(path, alias);
  const setup = await invoke(["init", "--here", "--tools", "codex", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const added = await invoke(["wire", "--here", "claude", "--auto"]);
  assert.equal(added.code, 0, JSON.stringify(added.value));
  const paths = resolvePaths(env);
  let config = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(config));
  let resource = Object.values(config.wiring.resources).find((entry) => entry.kind === "hook")!;
  assert.equal(resource.consumers.length, 2);
  assert.equal(resource.documentDescription, "ToneDial: load saved response tone", "adding another provider retains the file's ownership fact");

  const first = await invoke(["unwire", "--here", "codex", "--auto"]);
  assert.equal(first.code, 0, JSON.stringify(first.value));
  const retained = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(retained.description, "ToneDial: load saved response tone");
  assert.equal(retained.hooks.SessionStart.length, 1);
  assert.deepEqual(retained.hooks.SessionStart[0].hooks[0].args,
    [readerPath(paths.root), "--provider", "claude", "--state", paths.root], "Claude's distinct exec handler stays installed");
  config = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(config));
  resource = Object.values(config.wiring.resources).find((entry) => entry.kind === "hook")!;
  assert.equal(resource.consumers.length, 1);
  assert.equal(resource.documentDescription, retained.description);

  const final = await invoke(["unwire", "--here", "claude", "--auto"]);
  assert.equal(final.code, 0, JSON.stringify(final.value));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { userSetting: true }, "last removal clears only the owned root description and handler");
  assert.equal(lstatSync(alias).isSymbolicLink(), true, "a user-created settings alias survives scoped removal");
});

test("Codex configuration and stored hashes do not certify current trust or activation", async () => {
  const globalAgent = resolveAgentPaths({ global: true, project: null }, env, project);
  const initialized = await invoke(["init", "--global", "--tools", "codex", "--auto"]);
  assert.equal(initialized.code, 0, JSON.stringify(initialized.value));
  const hooks = globalAgent.hookFile("codex");
  const codexConfig = join(globalAgent.home("codex"), "config.toml");
  const table = `[hooks.state."${hooks}:session_start:0:0"]`;

  // No Codex config at all. A machine where Codex has never run says nothing about trust, so the
  // reading is unchanged from before this check existed.
  const silent = await invoke(["doctor", "--global"]);
  const before = (silent.value as { integrations: { tool: string; trust: string }[] }).integrations
    .find((i) => i.tool === "codex");
  assert.equal(before?.trust, "unknown", JSON.stringify(silent.value));

  // No matching record is insufficient to infer the current host's approval state.
  writeFileSync(codexConfig, "[hooks.state]\n");
  const untrusted = await invoke(["doctor", "--global"]);
  const denied = (untrusted.value as { integrations: { tool: string; trust: string; configuration: string }[] })
    .integrations.find((i) => i.tool === "codex");
  assert.equal(denied?.trust, "unknown");
  assert.equal(denied?.configuration, "configured", "the configuration is right; the trust is not");

  // Mere hash presence does not verify trust for the current hook definition.
  writeFileSync(codexConfig, `[hooks.state]\n\n${table}\ntrusted_hash = "sha256:aa"\n`);
  const trusted = await invoke(["doctor", "--global"]);
  const allowed = (trusted.value as { integrations: { tool: string; trust: string }[] }).integrations
    .find((i) => i.tool === "codex");
  assert.equal(allowed?.trust, "unknown");
  // Still only `unverified`. An approval is not evidence that a session loaded the file.
  assert.equal(
    (trusted.value as { integrations: { tool: string; activation: string }[] }).integrations
      .find((i) => i.tool === "codex")?.activation,
    "unverified",
  );
});

test("global native inheritance keeps one hook and disconnects shared consumers by scope", async () => {
  const paths = resolvePaths(env);
  const globalAgent = resolveAgentPaths({ global: true, project: null }, env, project);
  const projectAgent = resolveAgentPaths({ global: false, project: null }, env, project);
  const globalSettings = globalAgent.hookFile("claude");
  const codexHooks = globalAgent.hookFile("codex");
  const sharedSkill = join(scratch, ".agents", "skills", "tonedial");
  const projectSharedSkill = join(project, ".agents", "skills", "tonedial");
  const projectClaudeSettings = projectAgent.hookFile("claude");
  const countCommands = (document: { hooks?: { SessionStart?: Array<{ hooks?: Array<{ type?: string }> }> } }): number =>
    document.hooks?.SessionStart?.flatMap((block) => block.hooks ?? []).filter((handler) => handler.type === "command").length ?? 0;

  const initialized = await invoke(["init", "--global", "--tools", "claude,codex", "--auto"]);
  assert.equal(initialized.code, 0, JSON.stringify(initialized.value));
  const globalSettingsReal = realpathSync(globalSettings);
  assert.equal(existsSync(globalSettings), true);
  assert.equal(existsSync(codexHooks), true);
  assert.equal(existsSync(sharedSkill), true);
  assert.equal(countCommands(JSON.parse(readFileSync(globalSettings, "utf8"))), 1);

  // A global handler with a different absolute runtime is not inherited and must not cause a
  // second project hook while the current WIP keeps mismatch handling conservative.
  const guide = catalogue("en").cli;
  const globalBeforeMismatch = readFileSync(globalSettings, "utf8");
  const configBeforeMismatchText = readFileSync(paths.config, "utf8");
  const configBeforeMismatch = parseConfig(configBeforeMismatchText, guide);
  if (!isConfigV2(configBeforeMismatch)) throw new Error("native setup did not record schema 2 wiring");
  assert.throws(
    () => planOrderedDelivery(paths, projectAgent, "claude", configBeforeMismatch.wiring, env, guide, join(scratch, "runtime-mismatch", "node")),
    /unowned|managed content|file type changed/,
  );
  assert.equal(readFileSync(globalSettings, "utf8"), globalBeforeMismatch);
  assert.equal(existsSync(projectClaudeSettings), false);
  assert.equal(readFileSync(paths.config, "utf8"), configBeforeMismatchText);

  const projectWired = await invoke(["wire", "--here", "claude", "--auto"]);
  assert.equal(projectWired.code, 0, JSON.stringify(projectWired.value));
  assert.equal(existsSync(projectClaudeSettings), false, "a matching global hook is inherited");
  assert.equal(countCommands(JSON.parse(readFileSync(globalSettings, "utf8"))), 1, "inheritance does not duplicate the hook");
  assert.equal(existsSync(projectSharedSkill), true, "project skill delivery remains scoped to the project");

  let config = parseConfig(readFileSync(paths.config, "utf8"), guide);
  if (!isConfigV2(config)) throw new Error("native setup did not record schema 2 wiring");
  const globalClaudeId = Object.entries(config.wiring.registrations).find(([, registration]) =>
    registration.target === "claude" && registration.scope === "global",
  )?.[0];
  const projectClaudeId = Object.entries(config.wiring.registrations).find(([, registration]) =>
    registration.target === "claude" && registration.scope === "project",
  )?.[0];
  const hookResource = Object.values(config.wiring.resources).find((resource) =>
    resource.kind === "hook" && resource.path === globalSettingsReal,
  );
  if (!globalClaudeId || !projectClaudeId || !hookResource) throw new Error("missing inherited Claude hook ownership");
  assert.deepEqual([...hookResource.consumers].sort(), [globalClaudeId, projectClaudeId].sort());

  const disconnectedGlobal = await invoke(["unwire", "claude", "--global", "--auto"]);
  assert.equal(disconnectedGlobal.code, 0, JSON.stringify(disconnectedGlobal.value));
  assert.equal(existsSync(globalSettings), true, "the project consumer keeps the inherited file");
  assert.equal(countCommands(JSON.parse(readFileSync(globalSettings, "utf8"))), 1);
  assert.equal(existsSync(sharedSkill), true, "Codex remains a shared-skill consumer");
  config = parseConfig(readFileSync(paths.config, "utf8"), guide);
  if (!isConfigV2(config)) throw new Error("global disconnect did not preserve schema 2 wiring");
  const retainedHook = Object.values(config.wiring.resources).find((resource) =>
    resource.kind === "hook" && resource.path === globalSettingsReal,
  );
  assert.deepEqual(retainedHook?.consumers, [projectClaudeId]);

  // The remaining project registration owns the retained global file and must reuse its exact
  // handler rather than appending a second one after the original global registration leaves.
  const rewiredProject = await invoke(["wire", "--here", "claude", "--auto"]);
  assert.equal(rewiredProject.code, 0, JSON.stringify(rewiredProject.value));
  assert.equal(existsSync(projectClaudeSettings), false);
  assert.equal(countCommands(JSON.parse(readFileSync(globalSettings, "utf8"))), 1);

  const disconnectedProject = await invoke(["unwire", "--here", "claude", "--auto"]);
  assert.equal(disconnectedProject.code, 0, JSON.stringify(disconnectedProject.value));
  assert.equal(existsSync(globalSettings), false, "the last Claude hook consumer removes the created file");
  assert.equal(existsSync(projectSharedSkill), false);
  assert.equal(existsSync(sharedSkill), true, "the Codex shared-skill consumer remains");
  assert.equal(existsSync(codexHooks), true);

  const disconnectedCodex = await invoke(["unwire", "codex", "--global", "--auto"]);
  assert.equal(disconnectedCodex.code, 0, JSON.stringify(disconnectedCodex.value));
  assert.equal(existsSync(codexHooks), false);
  assert.equal(existsSync(sharedSkill), false, "the last shared-skill consumer removes the source");
  assert.equal(existsSync(paths.agents), true, "disconnect keeps the ordered state pair");
  assert.equal(existsSync(paths.tone), true);
  assert.equal(existsSync(paths.config), true);
});

test("native planner replaces an old runtime exactly and refuses edited ownership", async () => {
  const initialized = await invoke(["init", "--here", "--tools", "claude", "--auto"]);
  assert.equal(initialized.code, 0, JSON.stringify(initialized.value));
  const paths = resolvePaths(env);
  const agent = resolveAgentPaths({ global: false, project: null }, env, project);
  const t = catalogue("en").cli;
  const oldRuntime = join(scratch, "runtime old", "node");
  const newRuntime = join(scratch, "runtime new", "node");

  let config = parseConfig(readFileSync(paths.config, "utf8"), t);
  if (!isConfigV2(config)) throw new Error("native setup did not record schema 2 wiring");
  const oldPlan = planOrderedDelivery(paths, agent, "claude", config.wiring, env, t, oldRuntime);
  config.wiring = oldPlan.wiring;
  const oldConfigChange = planChange(paths.config, (before) => before, t);
  const oldApplied = await gate([oldPlan.change], {
    paths,
    finalChanges: [{ ...oldConfigChange, after: serializeConfig(config) }],
    auto: true,
    dryRun: false,
    ui: palette("never", env, false),
    t,
  });
  assert.equal(oldApplied.applied, true);

  const settingsPath = agent.hookFile("claude");
  const settingsRealPath = realpathSync(settingsPath);
  const readSettings = () => JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks: { SessionStart: Array<{ hooks: Array<{ type: string; command: string; args?: string[] }> }> };
  };
  const oldSettings = readSettings();
  const oldHandlers = oldSettings.hooks.SessionStart.flatMap((block) => block.hooks).filter((handler) => handler.type === "command");
  assert.equal(oldHandlers.length, 1);
  assert.equal(oldHandlers[0]!.command, oldRuntime);
  assert.deepEqual(oldHandlers[0]!.args, [readerPath(paths.root), "--provider", "claude", "--state", paths.root]);

  config = parseConfig(readFileSync(paths.config, "utf8"), t);
  if (!isConfigV2(config)) throw new Error("runtime replacement lost schema 2 wiring");
  const newPlan = planOrderedDelivery(paths, agent, "claude", config.wiring, env, t, newRuntime);
  config.wiring = newPlan.wiring;
  const newConfigChange = planChange(paths.config, (before) => before, t);
  const newApplied = await gate([newPlan.change], {
    paths,
    finalChanges: [{ ...newConfigChange, after: serializeConfig(config) }],
    auto: true,
    dryRun: false,
    ui: palette("never", env, false),
    t,
  });
  assert.equal(newApplied.applied, true);

  const newHandlers = readSettings().hooks.SessionStart.flatMap((block) => block.hooks).filter((handler) => handler.type === "command");
  assert.equal(newHandlers.length, 1);
  assert.equal(newHandlers[0]!.command, newRuntime);
  assert.deepEqual(newHandlers[0]!.args, [readerPath(paths.root), "--provider", "claude", "--state", paths.root]);
  config = parseConfig(readFileSync(paths.config, "utf8"), t);
  if (!isConfigV2(config)) throw new Error("runtime replacement did not persist schema 2 wiring");
  const resource = Object.values(config.wiring.resources).find((candidate) => candidate.kind === "hook" && candidate.path === settingsRealPath);
  assert.equal(resource?.managed.command, newRuntime);
  assert.deepEqual(resource?.managed.args, [readerPath(paths.root), "--provider", "claude", "--state", paths.root]);

  const editedDocument = readSettings();
  const editedHandler = editedDocument.hooks.SessionStart.flatMap((block) => block.hooks).find((handler) => handler.type === "command");
  if (!editedHandler) throw new Error("native handler disappeared before ownership test");
  editedHandler.args = [...(editedHandler.args ?? []), "--edited-by-user"];
  writeFileSync(settingsPath, `${JSON.stringify(editedDocument, null, 2)}\n`);
  const editedSettings = readFileSync(settingsPath, "utf8");
  const editedConfig = readFileSync(paths.config, "utf8");
  config = parseConfig(editedConfig, t);
  if (!isConfigV2(config)) throw new Error("edited ownership test lost schema 2 wiring");
  assert.throws(() => planOrderedDelivery(paths, agent, "claude", config.wiring, env, t, join(scratch, "runtime next", "node")), /unowned|managed content|file type changed/);
  assert.equal(readFileSync(settingsPath, "utf8"), editedSettings);
  assert.equal(readFileSync(paths.config, "utf8"), editedConfig);
});

test("global runtime refresh updates shared global/project ownership before either disconnects", async () => {
  const initialized = await invoke(["init", "--global", "--tools", "claude", "--auto"]);
  assert.equal(initialized.code, 0, JSON.stringify(initialized.value));
  const wired = await invoke(["wire", "--here", "claude", "--auto"]);
  assert.equal(wired.code, 0, JSON.stringify(wired.value));

  const paths = resolvePaths(env);
  const globalAgent = resolveAgentPaths({ global: true, project: null }, env, project);
  const settingsPath = globalAgent.hookFile("claude");
  const settingsRealPath = realpathSync(settingsPath);
  const t = catalogue("en").cli;
  const runtime = join(scratch, "runtime global refresh", "node");
  let config = parseConfig(readFileSync(paths.config, "utf8"), t);
  if (!isConfigV2(config)) throw new Error("global refresh setup did not record schema 2 wiring");

  const plan = planOrderedDelivery(paths, globalAgent, "claude", config.wiring, env, t, runtime);
  assert.equal(plan.checks.length, 0);
  config.wiring = plan.wiring;
  const configChange = planChange(paths.config, (before) => before, t);
  const applied = await gate([...plan.checks, plan.change], {
    paths,
    finalChanges: [{ ...configChange, after: serializeConfig(config) }],
    auto: true,
    dryRun: false,
    ui: palette("never", env, false),
    t,
  });
  assert.equal(applied.applied, true);

  const readHandlers = () => (JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks: { SessionStart: Array<{ hooks: Array<{ type: string; command: string; args?: string[] }> }> };
  }).hooks.SessionStart.flatMap((block) => block.hooks).filter((handler) => handler.type === "command");
  const handlers = readHandlers();
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0]!.command, runtime);
  assert.deepEqual(handlers[0]!.args, [readerPath(paths.root), "--provider", "claude", "--state", paths.root]);

  config = parseConfig(readFileSync(paths.config, "utf8"), t);
  if (!isConfigV2(config)) throw new Error("global refresh did not persist schema 2 wiring");
  const globalId = Object.entries(config.wiring.registrations).find(([, registration]) =>
    registration.target === "claude" && registration.scope === "global",
  )?.[0];
  const projectId = Object.entries(config.wiring.registrations).find(([, registration]) =>
    registration.target === "claude" && registration.scope === "project",
  )?.[0];
  const resource = Object.values(config.wiring.resources).find((candidate) =>
    candidate.kind === "hook" && candidate.path === settingsRealPath,
  );
  if (!globalId || !projectId || !resource) throw new Error("global refresh lost shared hook ownership");
  assert.deepEqual([...resource.consumers].sort(), [globalId, projectId].sort());
  assert.equal(resource.managedByRegistration?.[globalId]?.command, runtime);
  assert.equal(resource.managedByRegistration?.[projectId]?.command, runtime);

  const projectDisconnect = await invoke(["unwire", "--here", "claude", "--auto"]);
  assert.equal(projectDisconnect.code, 0, JSON.stringify(projectDisconnect.value));
  assert.equal(existsSync(settingsPath), true);
  config = parseConfig(readFileSync(paths.config, "utf8"), t);
  if (!isConfigV2(config)) throw new Error("project disconnect lost schema 2 wiring");
  const retained = Object.values(config.wiring.resources).find((candidate) =>
    candidate.kind === "hook" && candidate.path === settingsRealPath,
  );
  assert.deepEqual(retained?.consumers, [globalId]);
  assert.equal(retained?.managedByRegistration?.[globalId]?.command, runtime);

  const globalDisconnect = await invoke(["unwire", "claude", "--global", "--auto"]);
  assert.equal(globalDisconnect.code, 0, JSON.stringify(globalDisconnect.value));
  assert.equal(existsSync(settingsPath), false);
  assert.equal(existsSync(paths.agents), true);
  assert.equal(existsSync(paths.tone), true);
});

test("project runtime refresh updates inherited global ownership before global disconnects", async () => {
  const initialized = await invoke(["init", "--global", "--tools", "claude", "--auto"]);
  assert.equal(initialized.code, 0, JSON.stringify(initialized.value));
  const wired = await invoke(["wire", "--here", "claude", "--auto"]);
  assert.equal(wired.code, 0, JSON.stringify(wired.value));

  const paths = resolvePaths(env);
  const globalAgent = resolveAgentPaths({ global: true, project: null }, env, project);
  const projectAgent = resolveAgentPaths({ global: false, project: null }, env, project);
  const settingsPath = globalAgent.hookFile("claude");
  const settingsRealPath = realpathSync(settingsPath);
  const t = catalogue("en").cli;
  const runtime = join(scratch, "runtime project refresh", "node");
  let config = parseConfig(readFileSync(paths.config, "utf8"), t);
  if (!isConfigV2(config)) throw new Error("project refresh setup did not record schema 2 wiring");

  const plan = planOrderedDelivery(paths, projectAgent, "claude", config.wiring, env, t, runtime);
  assert.equal(plan.checks.length, 0);
  config.wiring = plan.wiring;
  const configChange = planChange(paths.config, (before) => before, t);
  const applied = await gate([...plan.checks, plan.change], {
    paths,
    finalChanges: [{ ...configChange, after: serializeConfig(config) }],
    auto: true,
    dryRun: false,
    ui: palette("never", env, false),
    t,
  });
  assert.equal(applied.applied, true);

  const readHandlers = () => (JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks: { SessionStart: Array<{ hooks: Array<{ type: string; command: string; args?: string[] }> }> };
  }).hooks.SessionStart.flatMap((block) => block.hooks).filter((handler) => handler.type === "command");
  const handlers = readHandlers();
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0]!.command, runtime);
  assert.deepEqual(handlers[0]!.args, [readerPath(paths.root), "--provider", "claude", "--state", paths.root]);

  config = parseConfig(readFileSync(paths.config, "utf8"), t);
  if (!isConfigV2(config)) throw new Error("project refresh did not persist schema 2 wiring");
  const globalId = Object.entries(config.wiring.registrations).find(([, registration]) =>
    registration.target === "claude" && registration.scope === "global",
  )?.[0];
  const projectId = Object.entries(config.wiring.registrations).find(([, registration]) =>
    registration.target === "claude" && registration.scope === "project",
  )?.[0];
  const resource = Object.values(config.wiring.resources).find((candidate) =>
    candidate.kind === "hook" && candidate.path === settingsRealPath,
  );
  if (!globalId || !projectId || !resource) throw new Error("project refresh lost shared hook ownership");
  assert.deepEqual([...resource.consumers].sort(), [globalId, projectId].sort());
  assert.equal(resource.managedByRegistration?.[globalId]?.command, runtime);
  assert.equal(resource.managedByRegistration?.[projectId]?.command, runtime);

  const globalDisconnect = await invoke(["unwire", "claude", "--global", "--auto"]);
  assert.equal(globalDisconnect.code, 0, JSON.stringify(globalDisconnect.value));
  assert.equal(existsSync(settingsPath), true);
  config = parseConfig(readFileSync(paths.config, "utf8"), t);
  if (!isConfigV2(config)) throw new Error("global disconnect lost schema 2 wiring");
  const retained = Object.values(config.wiring.resources).find((candidate) =>
    candidate.kind === "hook" && candidate.path === settingsRealPath,
  );
  assert.deepEqual(retained?.consumers, [projectId]);
  assert.equal(retained?.managedByRegistration?.[projectId]?.command, runtime);

  const projectDisconnect = await invoke(["unwire", "--here", "claude", "--auto"]);
  assert.equal(projectDisconnect.code, 0, JSON.stringify(projectDisconnect.value));
  assert.equal(existsSync(settingsPath), false);
  assert.equal(existsSync(paths.agents), true);
  assert.equal(existsSync(paths.tone), true);
});

test("inherited native route refuses a stale local hook probe before applying shared changes", async () => {
  const initialized = await invoke(["init", "--global", "--tools", "claude", "--auto"]);
  assert.equal(initialized.code, 0, JSON.stringify(initialized.value));

  const paths = resolvePaths(env);
  const projectAgent = resolveAgentPaths({ global: false, project: null }, env, project);
  const localSettings = projectAgent.hookFile("claude");
  const t = catalogue("en").cli;
  let config = parseConfig(readFileSync(paths.config, "utf8"), t);
  if (!isConfigV2(config)) throw new Error("stale-local setup did not record schema 2 wiring");
  const plan = planOrderedDelivery(paths, projectAgent, "claude", config.wiring, env, t);
  assert.equal(plan.checks.length, 1, "inheritance must probe the local destination");
  assert.equal(plan.checks[0]!.path, localSettings);
  assert.equal(plan.checks[0]!.before, null);
  assert.equal(plan.checks[0]!.after, null);

  config.wiring = plan.wiring;
  const configChange = planChange(paths.config, (before) => before, t);
  const finalConfig = serializeConfig(config);
  const beforeGlobalSettings = readFileSync(resolveAgentPaths({ global: true, project: null }, env, project).hookFile("claude"), "utf8");
  const beforeConfig = readFileSync(paths.config, "utf8");

  mkdirSync(dirname(localSettings), { recursive: true });
  writeFileSync(localSettings, '{"userOwned":true}\n');
  await assert.rejects(
    () => gate([...plan.checks, plan.change], {
      paths,
      finalChanges: [{ ...configChange, after: finalConfig }],
      auto: true,
      dryRun: false,
      ui: palette("never", env, false),
      t,
    }),
    /changed after the diff was prepared/,
  );
  assert.equal(readFileSync(localSettings, "utf8"), '{"userOwned":true}\n');
  assert.equal(readFileSync(paths.config, "utf8"), beforeConfig);
  assert.equal(
    readFileSync(resolveAgentPaths({ global: true, project: null }, env, project).hookFile("claude"), "utf8"),
    beforeGlobalSettings,
  );
});

test("two selected tools whose settings are one file are refused before either is written", async () => {
  const projectAgent = resolveAgentPaths({ global: false, project: null }, env, project);
  const codexHooks = projectAgent.hookFile("codex");
  const claudeSettings = projectAgent.hookFile("claude");
  mkdirSync(dirname(codexHooks), { recursive: true });
  mkdirSync(dirname(claudeSettings), { recursive: true });
  writeFileSync(codexHooks, '{"custom":true}\n');
  // Nothing stops one provider's settings from being a link to another's. Each adapter plans its
  // write from the bytes it read, so applied in sequence the second would drop the first's
  // handler and the ownership graph would record two fingerprints for one file.
  symlinkSync(codexHooks, claudeSettings);
  const before = readFileSync(codexHooks, "utf8");

  const refused = await invoke(["init", "--here", "--tools", "codex,claude", "--auto"]);
  assert.notEqual(refused.code, 0, JSON.stringify(refused.value));
  assert.equal(readFileSync(codexHooks, "utf8"), before, "the shared file was edited by the refused plan");
  assert.equal(existsSync(resolvePaths(env).config), false, "state was created for a plan that cannot apply");

  // Each tool on its own is unaffected: the refusal is about two of them meeting in one file.
  const alone = await invoke(["init", "--here", "--tools", "codex", "--auto"]);
  assert.equal(alone.code, 0, JSON.stringify(alone.value));
});

test("a global setup reports the projects that will keep delivering beside it", async () => {
  const wired = await invoke(["init", "--here", "--tools", "codex", "--auto"]);
  assert.equal(wired.code, 0, JSON.stringify(wired.value));

  // Hosts merge scopes, so this project's hook keeps firing after a global one is added. Saying
  // so is the job; refusing would block the route the quickstart leads with.
  const globally = await invoke(["init", "--global", "--tools", "codex", "--auto"]);
  assert.equal(globally.code, 0, JSON.stringify(globally.value));
  const codex = globally.value.integrations.find((entry: { tool: string }) => entry.tool === "codex");
  assert.deepEqual(codex.duplicates, [{
    scope: "project",
    destination: realpathSync(project),
    path: resolveAgentPaths({ global: false, project: null }, env, project).hookFile("codex"),
    state: "duplicate",
  }]);
  assert.equal(codex.inherited, false, "a global setup does not inherit from a project");

  // The project keeps its own hook: reporting is not removal, and this command was not pointed
  // at that project.
  const projectHooks = JSON.parse(readFileSync(resolveAgentPaths({ global: false, project: null }, env, project).hookFile("codex"), "utf8"));
  assert.equal(projectHooks.hooks.SessionStart.length, 1);
});

test("the optional command is installed only when it is asked for", async () => {
  const agent = resolveAgentPaths({ global: false, project: null }, env, project);
  const plain = await invoke(["init", "--here", "--tools", "claude", "--auto"]);
  assert.equal(plain.code, 0, JSON.stringify(plain.value));
  assert.equal(plain.value.commands, null);
  // A fourth window onto the same CLI is a convenience, not part of connecting a tool.
  assert.equal(existsSync(agent.command("tone")), false);
  assert.equal(existsSync(join(project, ".agents", "skills", "tonedial")), true, "the skill is not optional");

  const asked = await invoke(["init", "--here", "--tools", "claude", "--commands", "--auto"]);
  assert.equal(asked.code, 0, JSON.stringify(asked.value));
  assert.equal(existsSync(agent.command("tone")), true);
});

test("both windows onto the CLI carry one reload procedure, and it reads the guide first", async () => {
  const setup = await invoke(["init", "--here", "--tools", "claude", "--commands", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const agent = resolveAgentPaths({ global: false, project: null }, env, project);
  const skill = readFileSync(join(project, ".agents", "skills", "tonedial", "SKILL.md"), "utf8").split("\n");
  const command = readFileSync(agent.command("tone"), "utf8").split("\n");

  // The skill and the slash command are two windows onto one CLI, so the procedure they hand the
  // model has to be one text. Forking it is the failure this looks for: the shared run collapses.
  const anchor = skill.findIndex((line) => line.includes("compile --check --json"));
  assert.ok(anchor >= 0, "the skill no longer names the command that returns the paths");
  const start = command.findIndex((line) => line === skill[anchor]);
  assert.ok(start >= 0, "the command no longer shares the skill's reload procedure");
  const shared: string[] = [];
  for (let step = 0; skill[anchor + step] !== undefined && skill[anchor + step] === command[start + step]; step++) {
    shared.push(skill[anchor + step]!);
  }
  const procedure = shared.join("\n");
  assert.ok(procedure.length > 200, `the two windows share only ${procedure.length} characters of procedure`);

  // Order is the contract the hook and the skill agree on: operating guide, then current tone.
  const guide = procedure.indexOf("agentsPath");
  const artifact = procedure.indexOf("`path`");
  assert.ok(guide >= 0 && artifact > guide, `the artifact is read before the guide:\n${procedure}`);
  const presetSection = (lines: string[]) => /^## Current settings and saved presets\n([\s\S]*?)(?=\n## |\nFirst distinguish)/m.exec(lines.join("\n"))?.[1];
  const presets = presetSection(skill);
  assert.ok(presets);
  assert.equal(presetSection(command), presets, "the two control entry points disagree about preset creation");
  assert.match(presets, /created: true/);
  const created = await invoke(["create", "Skill Example", "--slug", "skill-example", "warmth=2", "--auto"]);
  assert.equal(created.code, 0, JSON.stringify(created.value));
  assert.equal(created.value.created, true);
});

test("installed explicit-setting examples use the CLI without changing neighbouring settings", async () => {
  const setup = await invoke(["init", "--here", "--tools", "claude", "--commands", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const paths = resolvePaths(env);
  const agent = resolveAgentPaths({ global: false, project: null }, env, project);
  const skill = readFileSync(join(project, ".agents", "skills", "tonedial", "SKILL.md"), "utf8");
  const command = readFileSync(agent.command("tone"), "utf8");
  const section = (text: string) => /^## Explicit settings\n([\s\S]*?)(?=\n## |\nFirst distinguish)/m.exec(text)?.[1];
  const settings = section(skill);
  assert.ok(settings, "the installed skill has no explicit-setting procedure");
  assert.equal(section(command), settings, "the optional command gives different setting instructions");
  const examples = [...settings.matchAll(/\|[^|\n]*\|\s*`tonedial (.+?)`\s*\|/g)].map((match) => match[1]!);
  const expected = parseConfig(readFileSync(paths.config, "utf8"));
  const changes: ((config: Config) => void)[] = [
    (config) => { config.persona.address = { self_ref: null, user_ref: "friend" }; },
    (config) => { config.persona.address!.self_ref = "guide"; },
    (config) => { config.persona.address = { self_ref: "assistant", user_ref: "reader" }; },
    (config) => { config.persona.age = "30s"; },
    (config) => { config.persona.gender = "neutral"; },
    (config) => { config.persona.user = "Developer who likes concise technical answers"; },
    (config) => { config.persona.agent = "Database specialist with ten years of experience; speaks directly"; },
    (config) => { config.persona.note = "Patient guide"; },
    (config) => { config.safeword = "plain answer please"; },
    (config) => { config.speech_level = "polite"; },
  ];
  assert.equal(examples.length, changes.length, "each documented example needs its independent state expectation");
  for (const [index, example] of examples.entries()) {
    // These generated examples use only unquoted tokens and double-quoted literal values.
    // Pass argv to the real CLI rather than executing Markdown as shell code.
    const args = [...example.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!);
    const changed = await invoke(args);
    assert.equal(changed.code, 0, JSON.stringify(changed.value));
    assert.equal(changed.value.ok, true);
    changes[index]!(expected);
    expected.unsaved = true;
    assert.deepEqual(parseConfig(readFileSync(paths.config, "utf8")), expected, example);
  }
});

test("approved native refresh updates stale skill seeds and the selected optional command only", async () => {
  const setup = await invoke(["init", "--here", "--tools", "claude", "--commands", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const paths = resolvePaths(env);
  const agent = resolveAgentPaths({ global: false, project: null }, env, project);
  const config = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(config));
  const seeds = seedFiles(paths, { native: true });
  const skills = seeds.filter((seed) => seed.id.startsWith("skill/"));
  assert.ok(skills.length > 0);
  const retainedRecords = Object.fromEntries(Object.entries(config.managedSeeds).filter(([id]) => !id.startsWith("skill/")));
  const currentCommand = readFileSync(agent.command("tone"), "utf8");
  const oldCommand = "# Previous generated command\n";
  const commandResource = Object.values(config.wiring.resources).find((resource) => resource.kind === "command");
  assert.ok(commandResource);
  for (const seed of skills) {
    const old = { ...seed, version: 1, contents: `Previous generated ${seed.id}\n` };
    writeFileSync(seed.path, old.contents);
    config.managedSeeds[seed.id] = seedRecord(old);
  }
  writeFileSync(agent.command("tone"), oldCommand);
  commandResource.expected.sha256 = createHash("sha256").update(oldCommand).digest("hex");
  commandResource.managed.version = 1;
  config.seedVersion = 1;
  writeFileSync(paths.config, serializeConfig(config));
  const before = [paths.config, agent.command("tone"), ...skills.map((seed) => seed.path)]
    .map((path) => ({ path, bytes: readFileSync(path) }));

  const doctor = await invoke(["doctor", "--here"]);
  assert.equal(doctor.code, 0, JSON.stringify(doctor.value));
  const check = doctor.value.checks.find((entry: { name: string }) => entry.name === "seeds");
  assert.deepEqual(check.files, skills.map((seed) => ({ path: seed.path, reason: "stale" })));
  const update = await invoke(["update"], { TONEDIAL_INSTALL_SHAPE: "npm" });
  assert.equal(update.code, 0, JSON.stringify(update.value));
  assert.equal(update.value.checkedRemote, false);
  assert.deepEqual(update.value.seedIssues, check.files);
  const preview = await invoke(["init", "--here", "--tools", "claude", "--commands", "--auto", "--dry-run"]);
  assert.equal(preview.code, 0, JSON.stringify(preview.value));
  for (const { path, bytes } of before) assert.deepEqual(readFileSync(path), bytes, path);

  const refreshed = await invoke(["init", "--here", "--tools", "claude", "--commands", "--auto"]);
  assert.equal(refreshed.code, 0, JSON.stringify(refreshed.value));
  const after = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(after));
  assert.equal(after.seedVersion, 13);
  assert.deepEqual(Object.fromEntries(Object.entries(after.managedSeeds).filter(([id]) => !id.startsWith("skill/"))), retainedRecords);
  for (const seed of skills) {
    assert.equal(after.managedSeeds[seed.id]?.version, seed.id === "skill/body" ? 13 : 7, seed.id);
    assert.equal(readFileSync(seed.path, "utf8"), seed.contents, seed.id);
    assert.equal(after.managedSeeds[seed.id]?.sha256, createHash("sha256").update(seed.contents).digest("hex"), seed.id);
  }
  assert.deepEqual(inspectSeeds(paths, after.managedSeeds, { native: true })
    .filter(({ seed }) => seed.id.startsWith("skill/"))
    .map(({ seed, state }) => ({ id: seed.id, state })), [
    { id: "skill/body", state: "current" },
    { id: "skill/traits", state: "current" },
  ]);
  assert.equal(readFileSync(agent.command("tone"), "utf8"), currentCommand);
  const refreshedCommand = Object.values(after.wiring.resources).find((resource) => resource.kind === "command");
  assert.equal(refreshedCommand?.managed.version, 6);
  assert.equal(refreshedCommand?.expected.sha256, createHash("sha256").update(currentCommand).digest("hex"));
  assert.equal(Object.values(after.managedSeeds).some((seed) => seed.path === agent.command("tone")), false,
    "the optional command is a wiring resource, not a seed");
});

test("an edited optional command blocks native refresh and scoped removal without partial writes", async () => {
  const setup = await invoke(["init", "--here", "--tools", "claude", "--commands", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const paths = resolvePaths(env);
  const agent = resolveAgentPaths({ global: false, project: null }, env, project);
  writeFileSync(agent.command("tone"), "# My customized tone command\n");
  const before = [paths.config, paths.agents, paths.tone, agent.command("tone"), agent.hookFile("claude"),
    ...seedFiles(paths, { native: true }).filter((seed) => seed.id.startsWith("skill/")).map((seed) => seed.path)]
    .map((path) => ({ path, bytes: readFileSync(path) }));
  for (const args of [["init", "--here", "--tools", "claude", "--commands", "--auto"], ["unwire", "--here", "claude", "--auto"]]) {
    const refused = await invoke(args);
    if (args[0] === "init") {
      assert.equal(refused.code, 0, JSON.stringify(refused.value));
      assert.equal(refused.value.appHealthy, true);
      assert.equal(refused.value.native.applied, false);
      assert.equal(refused.value.native.nativeRepair, "attention");
      assert.equal(refused.value.nativeAttention, true);
    } else {
      assert.notEqual(refused.code, 0, JSON.stringify(refused.value));
      assert.equal(refused.value.error, catalogue("en").cli.errors.ownershipConflict(agent.command("tone")));
    }
    for (const { path, bytes } of before) assert.deepEqual(readFileSync(path), bytes, path);
    assert.equal(existsSync(join(project, ".agents", "skills", "tonedial")), true);
  }
});

test("a record written before delivery needed several entries keeps its ownership", async () => {
  const setup = await invoke(["init", "--here", "--tools", "codex", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const paths = resolvePaths(env);

  // Rewrite the stored identity in the shape an earlier install wrote: one `matcher` string where
  // there is now a list. Reading it as the one-element list it always was is what keeps an
  // existing installation owned rather than turning it foreign on upgrade.
  const stored = readFileSync(paths.config, "utf8");
  const downgraded = stored.replace(/"matchers": \[\s*("[^"]+")\s*\]/g, '"matcher": $1');
  assert.notEqual(downgraded, stored, "the config carried no matcher list to downgrade");
  writeFileSync(paths.config, downgraded);

  const report = await invoke(["doctor", "--here"]);
  assert.equal(report.code, 0, JSON.stringify(report.value));
  const codex = report.value.integrations.find((entry: { tool: string }) => entry.tool === "codex");
  assert.equal(codex.configuration, "configured");

  // Writing it again restores the current spelling without disturbing the settings file.
  const before = readFileSync(resolveAgentPaths({ global: false, project: null }, env, project).hookFile("codex"), "utf8");
  const again = await invoke(["init", "--here", "--tools", "codex", "--auto"]);
  assert.equal(again.code, 0, JSON.stringify(again.value));
  assert.match(readFileSync(paths.config, "utf8"), /"matchers"/);
  assert.equal(readFileSync(resolveAgentPaths({ global: false, project: null }, env, project).hookFile("codex"), "utf8"), before);
});

test("an Antigravity hook removed by hand is preserved, not silently rewritten", async () => {
  const setup = await invoke(["init", "--here", "--tools", "antigravity", "--auto"]);
  assert.equal(setup.code, 0, JSON.stringify(setup.value));
  const settings = resolveAgentPaths({ global: false, project: null }, env, project).hookFile("antigravity");

  // The fingerprint covers the whole named hook, so a missing handler is no longer what this tool
  // wrote. It cannot be told apart from a deliberate removal, so it is left alone.
  const document = JSON.parse(readFileSync(settings, "utf8")) as { tonedial: { PreInvocation: unknown[] } };
  assert.equal(document.tonedial.PreInvocation.length, 1);
  document.tonedial.PreInvocation.splice(0, 1);
  writeFileSync(settings, `${JSON.stringify(document, null, 2)}\n`);
  const edited = readFileSync(settings, "utf8");

  const report = await invoke(["doctor", "--here"]);
  const antigravity = report.value.integrations.find((entry: { tool: string }) => entry.tool === "antigravity");
  assert.equal(antigravity.configuration, "foreign");
  const repaired = await invoke(["doctor", "--here", "--fix", "--auto"]);
  assert.equal(readFileSync(settings, "utf8"), edited, "--fix rewrote a hand-edited settings file");
  assert.equal(repaired.value.fixed ?? false, false);

  const disconnect = await invoke(["unwire", "--here", "antigravity", "--auto"]);
  assert.notEqual(disconnect.code, 0, "disconnect removed entries it could no longer identify");
  assert.equal(readFileSync(settings, "utf8"), edited);
});
