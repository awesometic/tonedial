import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { defaultConfig, serializeConfig } from "../src/core/config.ts";
import { catalogue } from "../src/core/i18n.ts";
import { maxCells } from "../src/ui/width.ts";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bin.ts");
const PRIVATE_NOTE = "Dummy private tone note with ' quotes, $dollar, `literal`, and 한글.";
const PRIVATE_USER = "Dummy developer background with ' quotes, $dollar, and 한글.";
const PRIVATE_AGENT = "Dummy fictional database specialist with ten years of experience.";
const EN = catalogue("en").cli.test;
let scratch: string;
let target: string;
let state: string;
let bin: string;
let calls: string;
let preload: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "tonedial-chat-preview-")));
  target = join(scratch, "project's \" space $dollar `literal` 한글");
  state = join(scratch, "state");
  bin = join(scratch, "bin");
  calls = join(scratch, "native-calls.jsonl");
  preload = join(scratch, "terminal-fixture.mjs");
  for (const directory of [target, state, bin, join(scratch, "home")]) mkdirSync(directory);
  writeFileSync(join(target, "keep.txt"), "Existing target content.\n");
  const config = defaultConfig();
  config.persona.note = PRIVATE_NOTE;
  config.persona.user = PRIVATE_USER;
  config.persona.agent = PRIVATE_AGENT;
  config.axes.warmth = 5;
  writeFileSync(join(state, "config.json"), serializeConfig(config));
  writeFileSync(join(state, "TONE.md"), "Dummy stale artifact: never rewrite or deliver this.\n");
  writeFileSync(join(state, "AGENTS.md"), "Dummy state guide: never rewrite this.\n");
  writeFileSync(join(state, "reader.mjs"), 'throw new Error("A test conversation must not execute the installed reader.");\n');
  // A real CLI process exercises the handoff; this fixture supplies terminal availability only.
  // It does not claim to exercise a provider TUI or actual terminal lifecycle behavior.
  writeFileSync(preload, 'Object.defineProperty(process.stdin, "isTTY", { value: true });\nObject.defineProperty(process.stdout, "isTTY", { value: true });\nprocess.stdin.isRaw = false;\nprocess.stdin.setRawMode = value => { process.stdin.isRaw = value; return process.stdin; };\n');
  env = {
    HOME: join(scratch, "home"), TONEDIAL_HOME: state, PATH: bin, LANG: "en_US.UTF-8",
    TONEDIAL_INSTALL_SHAPE: "npm", TONEDIAL_TEST_CALLS: calls, TONEDIAL_TEST_MARKER: "inherited dummy marker",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function install(provider: "claude" | "codex") {
  writeFileSync(join(bin, provider), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
const argv = process.argv.slice(2);
const safeMode = argv.includes("--safe-mode");
const settingsIndex = argv.indexOf("--settings");
const settings = settingsIndex < 0 ? {} : JSON.parse(argv[settingsIndex + 1]);
const overrides = Object.fromEntries(argv.flatMap((arg, index) =>
  arg === "--config" || arg === "-c" ? [argv[index + 1].split("=")] : []));
const claude = ${JSON.stringify(provider)} === "claude";
const hooksDisabled = claude ? safeMode || settings.disableAllHooks === true : overrides["features.hooks"] === "false";
const instructionsDisabled = claude ? safeMode : overrides["project_doc_max_bytes"] === "0";
const nativeDirectory = claude ? ".claude" : ".codex";
// This local startup loader exercises ToneDial's boundary, not vendor flag enforcement.
if (!hooksDisabled) {
  for (const root of [process.env.HOME, process.cwd()]) {
    const hookFile = join(root, nativeDirectory, claude ? "settings.json" : "hooks.json");
    if (!existsSync(hookFile)) continue;
    for (const group of JSON.parse(readFileSync(hookFile, "utf8")).hooks.SessionStart) {
      for (const hook of group.hooks) {
        const result = spawnSync(hook.command, [], { env: process.env, encoding: "utf8" });
        if (result.error) throw result.error;
        process.stdout.write(result.stdout);
      }
    }
  }
}
const context = [];
if (!instructionsDisabled) {
  const instructionFiles = [
    join(process.env.HOME, nativeDirectory, claude ? "CLAUDE.md" : "AGENTS.md"),
    join(process.cwd(), claude ? "CLAUDE.md" : "AGENTS.md"),
  ];
  for (const path of instructionFiles) {
    if (!existsSync(path)) continue;
    const instruction = readFileSync(path, "utf8");
    context.push(instruction);
    for (const [, imported] of instruction.matchAll(/^@(.+)$/gm)) {
      context.push(readFileSync(resolve(dirname(path), imported), "utf8"));
    }
  }
}
context.push(argv.at(-1));
appendFileSync(process.env.TONEDIAL_TEST_CALLS, JSON.stringify({
  argv, cwd: process.cwd(), marker: process.env.TONEDIAL_TEST_MARKER,
  home: process.env.HOME, context: context.join("\\n")
}) + "\\n");
if (process.env.TONEDIAL_TEST_REJECT_ISOLATION) {
  process.stderr.write("Native client rejected preview isolation controls\\n");
  process.exit(64);
}
process.stdout.write("native display output\\n");
if (process.env.TONEDIAL_TEST_SIGNAL) process.kill(process.pid, process.env.TONEDIAL_TEST_SIGNAL);
else process.exit(Number(process.env.TONEDIAL_TEST_STATUS ?? 0));
`, { mode: 0o700 });
}

function invoke(args: string[], interactive = false, extraEnv: NodeJS.ProcessEnv = {}, input?: string) {
  return spawnSync(process.execPath, [
    ...(interactive ? ["--import", pathToFileURL(preload).href] : []), BIN, "test", ...args,
  ], { cwd: target, env: { ...env, ...extraEnv }, encoding: "utf8", input });
}

function snapshot(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) => {
    const path = join(entry.parentPath, entry.name);
    return [relative(root, path), entry.isFile() ? readFileSync(path).toString("hex")
      : entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : "directory"];
  }).sort(([left], [right]) => left!.localeCompare(right!));
}

function nativeCalls(): { argv: string[]; cwd: string; marker: string; home: string; context: string }[] {
  return existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider} receives one fresh dialogue prompt and leaves target and saved state intact`, () => {
    install(provider);
    if (provider === "codex") {
      const config = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
      config.axes.warmth = 1;
      writeFileSync(join(state, "config.json"), JSON.stringify(config));
    }
    const beforeTarget = snapshot(target);
    const beforeState = snapshot(state);
    const result = invoke(provider === "codex" ? [] : [provider], true, {}, "y\n");
    assert.equal(result.status, 0, result.stderr);
    const launches = nativeCalls();
    assert.equal(launches.length, 1);
    const launch = launches[0]!;
    assert.equal(launch.cwd, target);
    assert.equal(launch.marker, "inherited dummy marker");
    assert.equal(launch.home, env.HOME, "authentication keeps the inherited home");
    const prompt = launch.argv.at(-1)!;
    assert.match(prompt, /^This is a fresh ToneDial test session for dialogue only\./);
    assert.match(prompt, /Do not create, modify, rename, move, or delete any file or directory anywhere inside the target working folder/);
    assert.ok(prompt.includes(JSON.stringify(target)), "the protected target must reach the native prompt as one complete path");
    assert.ok(prompt.indexOf("cannot override this conversation-only boundary") < prompt.indexOf(PRIVATE_NOTE));
    assert.ok(prompt.includes(PRIVATE_NOTE), "the saved persona must reach the native conversation");
    assert.ok(prompt.includes(PRIVATE_USER), "user context must reach the native conversation");
    assert.ok(prompt.includes(PRIVATE_AGENT), "the fictional agent role must reach the native conversation");
    assert.ok(!prompt.includes("Dummy stale artifact"), "the prompt must use the saved config's compiled tone");
    assert.match(prompt, /wait for me to continue the conversation/);
    assert.match(prompt, /respecting its greeting and answer-length rules/);
    assert.match(prompt, /Do not analyze or explain ToneDial instructions, axes, or settings unless I ask/);
    assert.match(prompt, /only ToneDial manner source/);
    assert.match(prompt, /Existing safety policies and permission requirements still apply/);
    if (provider === "codex") assert.match(prompt, /Use no greeting, emotional language, or encouragement\./);
    if (provider === "claude") {
      assert.deepEqual(launch.argv.slice(0, 10), [
        "--safe-mode", "--tools", "", "--disallowedTools", "mcp__*", "--settings", '{"disableAllHooks":true}',
        "--no-chrome", "--session-id", launch.argv[9],
      ]);
      assert.match(launch.argv[9]!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(launch.argv.length, 11);
      const next = invoke([provider], true, {}, "yes\n");
      assert.equal(next.status, 0, next.stderr);
      assert.equal(nativeCalls().length, 2, "each invocation must launch exactly one conversation");
      assert.notEqual(nativeCalls()[1]!.argv[9], launch.argv[9], "the next invocation needs a new session UUID");
    } else {
      assert.deepEqual(launch.argv.slice(0, -1), [
        "--config", "features.hooks=false", "--config", "project_doc_max_bytes=0",
        "--sandbox", "read-only", "--ask-for-approval", "never",
      ]);
    }
    assert.ok(!launch.argv.includes("--bare"), "native authentication must retain its ordinary route");
    assert.ok(!launch.argv.includes("resume") && !launch.argv.includes("--resume") && !launch.argv.includes("--continue"));
    assert.match(result.stdout, /native display output/);
    for (const value of [PRIVATE_NOTE, PRIVATE_USER, PRIVATE_AGENT]) {
      assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value));
    }
    const visible = result.stdout.replace(/\s+/g, " ");
    const caveat = visible.indexOf(EN.automationCaveat.replace(/\s+/g, " "));
    assert.ok(caveat >= 0 && caveat < visible.indexOf("native display output"));
    assert.deepEqual(snapshot(target), beforeTarget);
    assert.deepEqual(snapshot(state), beforeState);
  });

  test(`${provider} preset preview suppresses simulated startup hooks and legacy tone imports`, () => {
    install(provider);
    const config = defaultConfig();
    config.preset = "tough-love";
    config.axes.warmth = 5;
    writeFileSync(join(state, "config.json"), serializeConfig(config));
    const home = env.HOME!;
    const nativeDirectory = provider === "claude" ? ".claude" : ".codex";
    const startupMarker = join(scratch, "old-startup-ran.txt");
    const startup = join(scratch, "old-startup.mjs");
    writeFileSync(startup, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(startupMarker)}, "OLD_STARTUP_HOOK_SENTINEL\\n");
process.stdout.write("OLD_STARTUP_HOOK_SENTINEL\\n");
`, { mode: 0o700 });
    const hookSettings = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: startup }] }] } });
    for (const [root, artifact] of [[home, "tone.md"], [target, "TONE.md"]] as const) {
      mkdirSync(join(root, nativeDirectory));
      writeFileSync(join(root, nativeDirectory, provider === "claude" ? "settings.json" : "hooks.json"), hookSettings);
      const toneDirectory = join(root, ".tonedial");
      mkdirSync(toneDirectory);
      writeFileSync(join(toneDirectory, artifact), artifact === "tone.md"
        ? "OLD_LOWERCASE_TONE_SENTINEL\n" : "OLD_UPPERCASE_TONE_SENTINEL\n");
      const instruction = root === home
        ? join(root, nativeDirectory, provider === "claude" ? "CLAUDE.md" : "AGENTS.md")
        : join(root, provider === "claude" ? "CLAUDE.md" : "AGENTS.md");
      writeFileSync(instruction, `OLD_STYLE_INSTRUCTION_SENTINEL\n@${join(toneDirectory, artifact)}\n`);
    }

    // Establish that the fixture really runs startup delivery when suppression is absent.
    const baseline = spawnSync(join(bin, provider), ["baseline conversation"], {
      cwd: target, env, encoding: "utf8",
    });
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(readFileSync(startupMarker, "utf8"), "OLD_STARTUP_HOOK_SENTINEL\n".repeat(2));
    assert.match(baseline.stdout, /OLD_STARTUP_HOOK_SENTINEL/);
    for (const sentinel of ["OLD_STYLE_INSTRUCTION_SENTINEL", "OLD_LOWERCASE_TONE_SENTINEL", "OLD_UPPERCASE_TONE_SENTINEL"]) {
      assert.ok(nativeCalls()[0]!.context.includes(sentinel), "the legacy import fixture must deliver its old tone");
    }
    rmSync(startupMarker);
    const beforeTarget = snapshot(target), beforeState = snapshot(state), beforeHome = snapshot(home);
    const plan = invoke([provider, "--preset", "terse-operator", "--json", "--accept-usage"]);
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).customizationIsolation, "requested");
    assert.equal(nativeCalls().length, 1, "a metadata plan cannot launch or probe the installed client");
    const result = invoke([provider, "--preset", "terse-operator", "--accept-usage"], true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(nativeCalls().length, 2, "the preview launches once after the fixture baseline");
    assert.equal(existsSync(startupMarker), false, "ordinary startup hooks must be suppressed at the client boundary");
    const launch = nativeCalls()[1]!;
    assert.equal(launch.context, launch.argv.at(-1), "automatic legacy instructions must not join the initial prompt");
    assert.match(launch.context, /preset: terse-operator/);
    assert.match(launch.context, /Use no greeting, emotional language, or encouragement\./);
    assert.ok(!launch.context.includes("preset: tough-love"));
    assert.ok(!launch.context.includes("OLD_"));
    assert.ok(!result.stdout.includes("OLD_") && !result.stderr.includes("OLD_"));
    assert.deepEqual(snapshot(target), beforeTarget);
    assert.deepEqual(snapshot(state), beforeState);
    assert.deepEqual(snapshot(home), beforeHome);
  });
}

test("project scope changes only the child cwd and ignores the wiring destination override", () => {
  install("codex");
  const project = join(scratch, "selected project");
  const wiring = join(scratch, "wiring destination");
  mkdirSync(project);
  mkdirSync(wiring);
  writeFileSync(join(project, "keep.txt"), "Selected project content.\n");
  const before = snapshot(scratch);
  const result = invoke(["codex", "--project", "../selected project"], true, { TONEDIAL_AGENT_HOME: wiring }, "y\n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(nativeCalls()[0]!.cwd, project);
  assert.ok(nativeCalls()[0]!.argv.at(-1)!.includes(JSON.stringify(project)));
  assert.deepEqual(snapshot(scratch).filter(([path]) => path !== "native-calls.jsonl"), before);
});

test("target path controls stay exact for the child but cannot conceal human notices", () => {
  install("codex");
  const controlled = join(scratch, "project\u001b[2J\n\u202econtrol");
  mkdirSync(controlled);
  const result = invoke(["codex", "--project", controlled, "--accept-usage"], true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(nativeCalls()[0]!.cwd, controlled);
  assert.ok(nativeCalls()[0]!.argv.at(-1)!.includes(JSON.stringify(controlled)));
  // Remove only ToneDial's permitted paint. A conceal/erase sequence must remain a failure.
  const visible = result.stdout.replace(/\x1b\[(?:1|2|22|31|32|33|36|39)m/g, "");
  assert.ok(!visible.includes("\u001b") && !visible.includes("\u202e"));
  assert.match(visible, /project\\u\{1b\}\[2J\\u\{a\}\\u\{202e\}control/);
  assert.ok(visible.replace(/\s+/g, " ").includes(EN.automationCaveat.replace(/\s+/g, " ")));
  const unavailable = invoke(["codex", "--project", `${controlled}-missing`]);
  assert.equal(unavailable.status, 1);
  assert.ok(!unavailable.stderr.includes("\u001b") && !unavailable.stderr.includes("\u202e"));
});

test("JSON and dry-run return metadata without any native launch, probe, or private prompt", () => {
  install("claude");
  const before = snapshot(scratch);
  for (const args of [["claude", "--json"], ["claude", "--dry-run"], ["--json"], ["claude", "--dry-run", "--verbose"],
    ["claude", "--json", "--preset", "terse-operator", "--accept-usage"],
    ["claude", "--dry-run", "--preset", "terse-operator", "--accept-usage"]]) {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr);
    for (const value of [PRIVATE_NOTE, PRIVATE_USER, PRIVATE_AGENT]) {
      assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value));
    }
    if (args.includes("--json")) {
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.provider, "claude");
      assert.equal(plan.target, target);
      assert.equal(plan.launched, false);
      assert.equal(plan.freshSession, true);
      assert.equal(plan.delivery, "initial-prompt");
      assert.equal(plan.customizationIsolation, "requested");
      assert.equal(plan.nativeAutomation, "unverified");
      assert.equal(plan.osImmutable, false);
      assert.equal(typeof plan.toneChars, "number");
      assert.equal("prompt" in plan || "argv" in plan, false);
      assert.equal(plan.preview, args.includes("--preset"));
      if (args.includes("--preset")) {
        assert.equal(plan.preset, "terse-operator");
        assert.deepEqual(plan.riskAxes, ["conviction"]);
      }
    }
    assert.ok(!result.stdout.includes("[y/N]") && !result.stdout.includes(EN.chooseProvider));
  }
  assert.deepEqual(nativeCalls(), []);
  assert.deepEqual(snapshot(scratch), before);
});

test("non-terminal conversations and ambiguous automatic selection do not launch", () => {
  install("claude");
  install("codex");
  const before = snapshot(scratch);
  for (const args of [["claude"], ["claude", "--accept-usage"]]) {
    const nonTerminal = invoke(args);
    assert.equal(nonTerminal.status, 1);
    assert.match(nonTerminal.stderr, /interactive terminal/);
  }
  for (const args of [["--json"], ["--json", "--preset", "terse-operator", "--accept-usage"], ["--dry-run", "--accept-usage"]]) {
    const ambiguous = invoke(args);
    assert.equal(ambiguous.status, 1);
    assert.match(args.includes("--json") ? JSON.parse(ambiguous.stdout).error : ambiguous.stderr, /Choose a provider explicitly/);
    assert.ok(!ambiguous.stdout.includes("[y/N]"));
  }
  assert.deepEqual(nativeCalls(), []);
  assert.deepEqual(snapshot(scratch), before);
});

test("usage notices remain before provider choice when one invocation skips consent", () => {
  install("claude");
  install("codex");
  const beforeState = snapshot(state);
  const beforeTarget = snapshot(target);
  const result = invoke(["--accept-usage", "--color=never"], true, {}, "2\n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(nativeCalls().length, 1);
  assert.deepEqual(nativeCalls()[0]!.argv.slice(0, -1), [
    "--config", "features.hooks=false", "--config", "project_doc_max_bytes=0",
    "--sandbox", "read-only", "--ask-for-approval", "never",
  ]);
  const visible = result.stdout.replace(/\s+/g, " ");
  const choice = visible.indexOf(EN.chooseProvider.trim().replace(/\s+/g, " "));
  assert.ok(choice >= 0, "provider choice is missing");
  for (const notice of [EN.cost, EN.interpretationCaveat, EN.history, EN.protection, EN.automationCaveat]) {
    const content = notice.replace(/\s+/g, " ");
    const index = visible.indexOf(content);
    assert.ok(index >= 0 && index < choice, "usage notice must be visible before provider choice");
    assert.equal(visible.indexOf(content, index + content.length), -1, "usage notice must appear once");
  }
  assert.ok(!result.stdout.includes("[y/N]"), "the explicit flag must skip only consent");
  assert.deepEqual(snapshot(state), beforeState);
  assert.deepEqual(snapshot(target), beforeTarget);
});

test("accepted usage hands input to the two-provider chooser before one launch", { timeout: 10_000 }, async t => {
  install("claude");
  install("codex");
  const beforeState = snapshot(state), beforeTarget = snapshot(target);
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, BIN, "test", "--color=never"], {
    cwd: target, env, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { child.kill(); });
  let output = "", errors = "", accepted = false, chosen = false;
  child.stdout.on("data", chunk => {
    output += chunk;
    if (!accepted && output.includes(EN.usageConsent)) { accepted = true; child.stdin.write("y\n"); }
    if (!chosen && output.includes(EN.chooseProvider)) { chosen = true; child.stdin.end("2\n"); }
  });
  child.stderr.on("data", chunk => { errors += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, errors);
  assert.equal(output.indexOf(EN.usageConsent) < output.indexOf(EN.chooseProvider), true);
  assert.equal(nativeCalls().length, 1);
  assert.deepEqual(nativeCalls()[0]!.argv.slice(0, -1), [
    "--config", "features.hooks=false", "--config", "project_doc_max_bytes=0",
    "--sandbox", "read-only", "--ask-for-approval", "never",
  ]);
  assert.deepEqual(snapshot(state), beforeState);
  assert.deepEqual(snapshot(target), beforeTarget);
});

test("blank, rejected, or invalid usage consent cancels before provider choice and every native execution", () => {
  install("claude");
  install("codex");
  const before = snapshot(scratch);
  for (const reply of ["\n", "n\n", "maybe\n"]) {
    const result = invoke(["--color=never"], true, {}, reply);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[y\/N\]/);
    assert.ok(result.stdout.includes(EN.usageDeclined));
    assert.ok(!result.stdout.includes(EN.chooseProvider));
    assert.deepEqual(nativeCalls(), []);
    assert.deepEqual(snapshot(scratch), before);
  }
});

test("required usage notices and default-no consent fit a narrow terminal in both locales", () => {
  install("codex");
  for (const language of ["en", "ko"] as const) {
    const config = defaultConfig();
    config.language = language;
    writeFileSync(join(state, "config.json"), serializeConfig(config));
    const before = snapshot(scratch);
    const result = invoke(["codex", "--color=never"], true, { COLUMNS: "60" }, "\n");
    assert.equal(result.status, 0, result.stderr);
    const visible = stripVTControlCharacters(result.stdout);
    for (const line of visible.split("\n")) {
      assert.ok(maxCells(line) <= 59, `${language}: notice exceeds the terminal width: ${line}`);
    }
    const flattened = visible.replace(/\s+/g, " ");
    const copy = catalogue(language).cli.test;
    for (const notice of [copy.cost, copy.interpretationCaveat, copy.history, copy.protection, copy.automationCaveat]) {
      assert.ok(flattened.includes(notice.replace(/\s+/g, " ")), `${language}: required notice was lost`);
    }
    assert.match(visible, /\[y\/N\]/);
    assert.deepEqual(nativeCalls(), []);
    assert.deepEqual(snapshot(scratch), before);
  }
});

test("accepting usage once does not persist consent or replace provider-choice cancellation", () => {
  install("codex");
  const beforeState = snapshot(state);
  const beforeTarget = snapshot(target);
  const accepted = invoke(["codex", "--accept-usage"], true);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.ok(!accepted.stdout.includes("[y/N]"));
  assert.equal(nativeCalls().length, 1);
  const next = invoke(["codex"], true, {}, "\n");
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /\[y\/N\]/);
  assert.equal(nativeCalls().length, 1, "a previous invocation cannot authorize this launch");

  install("claude");
  const cancelled = invoke(["--accept-usage"], true, {}, "cancel\n");
  assert.equal(cancelled.status, 1);
  assert.ok(cancelled.stderr.includes(EN.selectionCancelled));
  assert.equal(nativeCalls().length, 1, "skipping consent cannot select a provider");
  assert.deepEqual(snapshot(state), beforeState);
  assert.deepEqual(snapshot(target), beforeTarget);
});

test("bundled, custom, and readonly legacy preset previews preserve saved personal settings and all disk state", () => {
  install("codex");
  const config = defaultConfig();
  config.preset = "tough-love";
  config.unsaved = true;
  config.axes.warmth = 5;
  config.persona = {
    age: "30s", gender: "neutral", note: PRIVATE_NOTE,
    user: PRIVATE_USER, agent: PRIVATE_AGENT,
    address: { self_ref: "dummy assistant", user_ref: "dummy reader" },
  };
  config.safeword = "dummy release phrase";
  config.speech_level = "plain";
  writeFileSync(join(state, "config.json"), serializeConfig(config));
  const presets = join(state, "presets");
  const custom = join(presets, "custom");
  mkdirSync(custom, { recursive: true });
  const values = { warmth: 1, verbosity: 1, conviction: 5 };
  writeFileSync(join(custom, "custom-preview.json"), JSON.stringify({ displayName: "Custom Preview", values }));
  writeFileSync(join(presets, "custom-preview.json"), JSON.stringify({ values: { warmth: 5 } }));
  writeFileSync(join(presets, "terse-operator.json"), JSON.stringify({ values: { warmth: 5 } }));
  writeFileSync(join(presets, "legacy-preview.json"), JSON.stringify({ displayName: "Legacy Preview", values }));
  const outside = join(scratch, "foreign-preset.json");
  const outsideContents = JSON.stringify({ values: { warmth: 5 }, dummy: "NEVER_PRINT_FOREIGN_PRESET" });
  writeFileSync(outside, outsideContents);
  symlinkSync(outside, join(custom, "legacy-preview.json"));
  const beforeState = snapshot(state);
  const beforeTarget = snapshot(target);
  for (const [slug, name] of [["terse-operator", "Terse Operator"], ["custom-preview", "Custom Preview"], ["legacy-preview", "Legacy Preview"]] as const) {
    const callsBefore = nativeCalls().length;
    const planResult = invoke(["codex", "--preset", slug, "--json"]);
    assert.equal(planResult.status, 0, planResult.stderr);
    const plan = JSON.parse(planResult.stdout);
    assert.equal(plan.preset, slug);
    assert.equal(plan.preview, true);
    assert.deepEqual(plan.riskAxes, ["conviction"]);
    assert.equal(nativeCalls().length, callsBefore, "a preset metadata plan cannot execute the provider");

    const result = invoke(["codex", "--preset", slug, "--accept-usage", "--color=never"], true);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(EN.previewTone(name)));
    assert.equal(nativeCalls().length, callsBefore + 1, "each explicit preset preview starts one conversation");
    const prompt = nativeCalls().at(-1)!.argv.at(-1)!;
    assert.ok(prompt.includes(`preset: ${slug}`));
    assert.match(prompt, /Use no greeting, emotional language, or encouragement\./);
    assert.match(prompt, /Use one or two short sentences for a simple result, or terse fragments for items; omit rationale, process, and background\./);
    for (const savedValue of [PRIVATE_NOTE, PRIVATE_USER, PRIVATE_AGENT, "dummy assistant", "dummy reader", "dummy release phrase"]) {
      assert.ok(prompt.includes(savedValue), "preset axes cannot replace saved personal settings");
      assert.ok(!result.stdout.includes(savedValue) && !result.stderr.includes(savedValue));
    }
    assert.match(prompt, /In languages with honorifics, use plain address forms even with formal wording\./);
    assert.ok(!prompt.includes("NEVER_PRINT_FOREIGN_PRESET"));
    assert.deepEqual(snapshot(state), beforeState);
    assert.deepEqual(snapshot(target), beforeTarget);
    assert.equal(readFileSync(outside, "utf8"), outsideContents);
  }
  assert.equal(nativeCalls().length, 3);
});

test("unknown or damaged preview presets and test-only flag misuse execute nothing", () => {
  install("codex");
  const custom = join(state, "presets", "custom");
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(custom, "damaged.json"), `${PRIVATE_NOTE} invalid dummy preset`);
  const before = snapshot(scratch);
  for (const slug of ["unknown-preset", "damaged", "../escape", ""]) {
    const result = invoke(["codex", "--preset", slug, "--json", "--accept-usage"]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.ok(!result.stdout.includes(PRIVATE_NOTE) && !result.stderr.includes(PRIVATE_NOTE));
  }
  const auto = invoke(["codex", "--auto", "--json"]);
  assert.equal(auto.status, 2, "file-mutation approval cannot authorize account usage");
  for (const option of [["--accept-usage"], ["--preset", "terse-operator"]]) {
    const result = spawnSync(process.execPath, [BIN, "show", ...option, "--json"], {
      cwd: target, env, encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
  assert.deepEqual(nativeCalls(), []);
  assert.deepEqual(snapshot(scratch), before);
});

test("unsupported providers, unavailable executables, and unavailable targets never launch", () => {
  install("codex");
  const before = snapshot(scratch);
  for (const provider of ["antigravity", "claude"]) {
    const result = invoke([provider, "--json"]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
  const missingTarget = invoke(["codex", "--project", "../missing project", "--json"]);
  assert.equal(missingTarget.status, 1);
  assert.equal(JSON.parse(missingTarget.stdout).ok, false);
  assert.deepEqual(nativeCalls(), []);
  assert.deepEqual(snapshot(scratch), before);
});

test("missing or invalid saved configuration never creates default state or starts a provider", () => {
  install("codex");
  const missingState = join(scratch, "missing state");
  for (const preset of [[], ["--preset", "terse-operator"]]) {
    const missing = invoke(["codex", ...preset, "--json"], false, { TONEDIAL_HOME: missingState });
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stdout).error, /tonedial init --tools none/);
    assert.equal(existsSync(missingState), false);
  }
  writeFileSync(join(state, "config.json"), `${PRIVATE_NOTE} invalid dummy config`);
  const before = snapshot(scratch);
  for (const preset of [[], ["--preset", "terse-operator"]]) {
    const invalid = invoke(["codex", ...preset, "--json"]);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).ok, false);
    assert.equal(invalid.stdout.includes(PRIVATE_NOTE) || invalid.stderr.includes(PRIVATE_NOTE), false);
  }
  assert.deepEqual(nativeCalls(), []);
  assert.deepEqual(snapshot(scratch), before);
});

test("legacy saved configuration is data for the prompt without migration", () => {
  install("codex");
  const config = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
  config.schema = 1;
  config.wiring = {};
  writeFileSync(join(state, "config.json"), JSON.stringify(config));
  const before = snapshot(state);
  const result = invoke(["codex", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(state), before);
  assert.deepEqual(nativeCalls(), []);
});

test("native exit status and signal are the test command's exit status", () => {
  install("codex");
  const beforeState = snapshot(state);
  const beforeTarget = snapshot(target);
  assert.equal(invoke(["codex"], true, { TONEDIAL_TEST_STATUS: "23" }, "y\n").status, 23);
  assert.equal(invoke(["codex"], true, { TONEDIAL_TEST_SIGNAL: "SIGTERM" }, "y\n").status, 143);
  assert.equal(nativeCalls().length, 2);
  assert.deepEqual(snapshot(state), beforeState);
  assert.deepEqual(snapshot(target), beforeTarget);
});

test("a native isolation rejection is returned without probing or retrying with weaker controls", () => {
  install("claude");
  install("codex");
  const beforeState = snapshot(state), beforeTarget = snapshot(target), beforeHome = snapshot(env.HOME!);
  for (const provider of ["claude", "codex"] as const) {
    const callsBefore = nativeCalls().length;
    const result = invoke([provider, "--preset", "terse-operator", "--accept-usage"], true, {
      TONEDIAL_TEST_REJECT_ISOLATION: "1",
    });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /Native client rejected preview isolation controls/);
    assert.equal(nativeCalls().length, callsBefore + 1, "the native rejection cannot trigger a probe or another launch");
    assert.ok(!result.stdout.includes(PRIVATE_NOTE) && !result.stderr.includes(PRIVATE_NOTE));
  }
  assert.deepEqual(snapshot(state), beforeState);
  assert.deepEqual(snapshot(target), beforeTarget);
  assert.deepEqual(snapshot(env.HOME!), beforeHome);
});

test("spawn failure reports a safe installation error without exposing the injected tone", () => {
  writeFileSync(join(bin, "codex"), `#!${join(scratch, "missing runtime")}\n`, { mode: 0o700 });
  const before = snapshot(scratch);
  const result = invoke(["codex"], true, {}, "y\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not start codex/);
  assert.ok(!result.stdout.includes(PRIVATE_NOTE) && !result.stderr.includes(PRIVATE_NOTE));
  assert.deepEqual(nativeCalls(), []);
  assert.deepEqual(snapshot(scratch), before);
});

test("schema-2 preview uses the selected profile's role without exposing it in JSON or changing state", () => {
  install("codex");
  const config = defaultConfig();
  config.persona.agent = "ROLE_FROM_SELECTED_PROFILE";
  config.persona.address = { self_ref: "profile guide", user_ref: "profile reader" };
  config.safeword = "profile plain reply";
  const custom = join(state, "presets", "custom");
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(custom, "whole-profile.json"), JSON.stringify({ schema: 2, slug: "whole-profile", displayName: "Whole Profile",
    values: { warmth: 1 }, settings: { persona: config.persona, safeword: config.safeword, speech_level: "polite" } }));
  const before = snapshot(state);
  const plan = invoke(["codex", "--preset", "whole-profile", "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(!plan.stdout.includes("ROLE_FROM_SELECTED_PROFILE"));
  assert.equal(nativeCalls().length, 0);
  const preview = invoke(["codex", "--preset", "whole-profile", "--accept-usage"], true);
  assert.equal(preview.status, 0, preview.stderr);
  const prompt = nativeCalls()[0]!.argv.at(-1)!;
  assert.ok(prompt.includes("ROLE_FROM_SELECTED_PROFILE"));
  assert.ok(prompt.includes("profile guide") && prompt.includes("profile plain reply"));
  assert.ok(!prompt.includes(PRIVATE_AGENT));
  assert.deepEqual(snapshot(state), before);
});
