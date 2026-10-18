// The state layer and the commands that only touch home.
//
// Every test drives `run()` — the same path a user's shell does — against a temporary
// TONEDIAL_HOME and project directories under one temporary home. State mutations stay in
// their root; explicit project exports and wiring have separate destinations.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { run } from "../src/cli.ts";
import { compile } from "../src/core/compile.ts";
import { toCompileInput } from "../src/core/resolve.ts";
import { AXIS_DEFAULT, AXIS_ORDER, DELIVERY_OFF_MARKER } from "../src/core/anchors.ts";
import { parseConfig, serializeConfig, defaultConfig, nearestAxis } from "../src/core/config.ts";
import { resolvePaths } from "../src/core/paths.ts";
import { editorCommand } from "../src/commands/edit.ts";
import { LANGUAGES, catalogue } from "../src/core/i18n.ts";
import { BUNDLED, RETIRED_PRESETS, slugify, applyPreset, customPresetDir, builtinPresetDir } from "../src/core/presets.ts";
import { nonDefaultAxes } from "../src/core/combos.ts";
import { gate, planChange } from "../src/wiring/apply.ts";
import { contentHash, recordFileChange } from "../src/wiring/ownership.ts";
import { inspectOperations } from "../src/core/operations.ts";
import { canonicalDestination } from "../src/core/paths.ts";
import { palette } from "../src/ui/style.ts";
import { maxCells } from "../src/ui/width.ts";
import { createLegacyFixture } from "./support/legacy-fixture.ts";

/** The catalogue these unit-level calls read from. Message wording is asserted in ui.test.ts. */
const EN = catalogue("en").cli;

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let home = "";
let out: string[] = [];
let err: string[] = [];
let restore: (() => void)[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tonedial-"));
  mkdirSync(join(home, "project"));
  out = [];
  err = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => (out.push(s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => (err.push(s), true)) as typeof process.stderr.write;
  restore = [() => { process.stdout.write = o; }, () => { process.stderr.write = e; }];
});

afterEach(() => {
  for (const r of restore) r();
  const opened = join(home, "editor-path");
  if (existsSync(opened)) {
    const staging = dirname(readFileSync(opened, "utf8").trim());
    assert.ok(basename(staging).startsWith("tonedial-edit-"), "editor fixture recorded an unexpected staging directory");
    rmSync(staging, { recursive: true, force: true });
  }
  rmSync(home, { recursive: true, force: true });
});

// Pinned to a non-TTY colour profile. Left to the ambient `process.stdout.isTTY` these
// assertions pass under `node --test` and fail under any runner that hands the file a terminal,
// which is the documented top cause of snapshot tests that flap.
const commandEnv = () => ({ HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "" });
const cli = (...args: string[]) => run(args, commandEnv(), join(home, "project"), false, false);
const stdout = () => out.join("");
/** stdout with folds collapsed. Prose is wrapped to the line budget, so a sentence a test
 *  cares about may legitimately arrive across two lines. */
const flat = () => out.join("").replace(/\n\s*/g, " ");
const stderr = () => err.join("");
const collapsed = (text: string) => text.replace(/\s+/g, " ").trim();
const paths = () => resolvePaths(commandEnv());
const tone = () => readFileSync(paths().tone, "utf8");
const config = () => parseConfig(readFileSync(paths().config, "utf8"));

/** Real approved setup, then the neutral axes these command contracts start from. */
async function initializeState(): Promise<void> {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0, stderr());
  assert.equal(await cli("reset"), 0, stderr());
  assert.equal(await cli("set", "persona.self_ref=", "persona.user_ref=", "persona.user=", "persona.agent=", "speech_level=auto"), 0, stderr());
  out = [];
  err = [];
}

/** Every file under a directory, so a test can assert a tree was not touched. */
const snapshot = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => join(d.parentPath, d.name))
        .sort()
    : [];

test("paths follow TONEDIAL_HOME, then XDG_CONFIG_HOME, then the home directory", async () => {
  assert.equal(resolvePaths({ TONEDIAL_HOME: "/a" }).root, "/a");
  assert.equal(resolvePaths({ XDG_CONFIG_HOME: "/b" }).root, join("/b", "tonedial"));
  assert.match(resolvePaths({}).root, /\.tonedial$/);
});

test("compile check returns absolute paired-context destinations without creating state", async () => {
  assert.equal(await cli("compile", "--check", "--json"), 0);
  const result = JSON.parse(stdout());
  assert.equal(result.agentsPath, join(paths().root, "AGENTS.md"));
  assert.equal(result.path, join(paths().root, "TONE.md"));
  assert.equal(result.written, false);
  assert.equal(existsSync(paths().root), false);
});

test("human compile reports observed current, stale, missing and generated state without changing check JSON", async () => {
  await initializeState();
  const before = readFileSync(paths().config);
  const original = tone();
  assert.equal(await cli("compile"), 0, stderr());
  assert.match(stdout(), /TONE\.md current/);
  assert.doesNotMatch(stdout(), /TONE\.md generated/);
  out = [];
  writeFileSync(paths().tone, "Dummy stale artifact.\n");
  assert.equal(await cli("compile", "--check"), 0, stderr());
  assert.match(stdout(), /TONE\.md differs from saved settings/);
  assert.equal(tone(), "Dummy stale artifact.\n");
  assert.deepEqual(readFileSync(paths().config), before);
  out = [];
  assert.equal(await cli("compile", "--check", "--json"), 0, stderr());
  assert.equal(JSON.parse(stdout()).written, false);
  assert.equal(Object.hasOwn(JSON.parse(stdout()), "artifactState"), false);
  out = [];
  assert.equal(await cli("compile"), 0, stderr());
  assert.match(stdout(), /TONE\.md generated/);
  assert.equal(tone(), original);
  rmSync(paths().tone);
  out = [];
  assert.equal(await cli("compile", "--check"), 0, stderr());
  assert.match(stdout(), /TONE\.md has not been generated/);
  assert.equal(existsSync(paths().tone), false);
});

test("human compile comparison does not follow an artifact link or reveal its contents", async () => {
  await initializeState();
  const other = join(home, "dummy-other-artifact");
  writeFileSync(other, "DUMMY_OTHER_CONTENT_DO_NOT_ECHO\n");
  rmSync(paths().tone);
  symlinkSync(other, paths().tone);
  const before = readFileSync(paths().config);
  assert.equal(await cli("compile", "--check"), 0, stderr());
  assert.match(stdout(), /could not be safely compared/);
  assert.doesNotMatch(stdout() + stderr(), /DUMMY_OTHER_CONTENT_DO_NOT_ECHO/);
  assert.equal(lstatSync(paths().tone).isSymbolicLink(), true);
  assert.equal(readFileSync(other, "utf8"), "DUMMY_OTHER_CONTENT_DO_NOT_ECHO\n");
  assert.deepEqual(readFileSync(paths().config), before);
});

test("the bundled set contains the seven agreed character profiles", async () => {
  // Bundled starting points are settled; axis-space coverage belongs to measurements.
  // Nothing pinned it, so a preset lost in a refactor would empty the loops below in silence.
  assert.equal(BUNDLED.length, 7);
  assert.deepEqual(
    BUNDLED.map((p) => p.slug),
    ["caring-brother", "bratty-kid", "eager-sycophant", "royal-advisor", "ego-sword", "heavenly-demon", "right-hand"],
  );
});

test("every bundled profile compiles to its current pack artifact, byte for byte", async () => {
  await initializeState();
  // The end-to-end claim: state on disk, through resolve, through the compiler, equals the
  // current pack artifact, including its full profile settings. Without it the state layer could be quietly
  // wrong in a way the compiler's own golden test cannot see.
  assert.equal(await cli("set", "safeword=진심으로 부탁할게"), 0);
  for (const preset of BUNDLED) {
    assert.equal(await cli("use", preset.slug), 0, preset.slug);
    assert.equal(tone(), readFileSync(join(FIXTURES, `${preset.slug}.tone.md`), "utf8"), preset.slug);
  }
});

test("a full round trip produces the same bytes as compiling the values directly", async () => {
  await initializeState();
  assert.equal(await cli("set", "safeword=진심으로 부탁할게"), 0);
  assert.equal(await cli("set", "formality=2", "critique=5", "warmth=5", "conviction=4", "care=4"), 0);
  assert.equal(await cli("save", "Round Trip"), 0);
  assert.equal(await cli("use", "round-trip"), 0);
  const viaRoundTrip = tone();
  assert.equal(await cli("compile"), 0);
  assert.equal(tone(), viaRoundTrip, "compile after use changes nothing");

  // Same axis values as tough-love, so everything below the generation comment matches.
  const toughLove = readFileSync(join(FIXTURES, "tough-love.tone.md"), "utf8");
  assert.equal(viaRoundTrip.split("\n").slice(1).join("\n"), toughLove.split("\n").slice(1).join("\n"));
  assert.match(viaRoundTrip, /^<!-- generated by tonedial · preset: round-trip -->/);
});

test("running a state-changing command twice changes nothing the second time", async () => {
  await initializeState();
  for (const args of [
    ["use", "tough-love"], ["set", "critique=4"], ["save", "Twice"], ["compile"], ["reset", "care"],
  ]) {
    assert.equal(await cli(...args), 0, args.join(" "));
    const [c1, t1] = [readFileSync(paths().config, "utf8"), tone()];
    assert.equal(await cli(...args), 0);
    assert.equal(readFileSync(paths().config, "utf8"), c1, `${args.join(" ")} config`);
    assert.equal(tone(), t1, `${args.join(" ")} artifact`);
  }
});

test("off and on pause delivery without losing the saved tone", async () => {
  await initializeState();
  assert.equal(await cli("set", "warmth=4", "persona.user=Dummy saved context"), 0);
  const beforeConfig = config();
  const beforeTone = tone();

  out = [];
  assert.equal(await cli("off", "--json"), 0, stderr());
  const stopped = JSON.parse(stdout()) as { enabled: boolean; changed: boolean };
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.changed, true);
  const stoppedConfig = config();
  assert.equal(stoppedConfig.enabled, false);
  assert.deepEqual({ ...stoppedConfig, enabled: true }, beforeConfig);
  assert.equal(tone().replace(`${DELIVERY_OFF_MARKER}\n`, ""), beforeTone);
  assert.ok(tone().length > DELIVERY_OFF_MARKER.length, "off emptied TONE.md");

  const stoppedBytes = [readFileSync(paths().config), readFileSync(paths().tone)];
  out = [];
  assert.equal(await cli("off", "--json"), 0, stderr());
  assert.equal(JSON.parse(stdout()).changed, false);
  assert.deepEqual([readFileSync(paths().config), readFileSync(paths().tone)], stoppedBytes);

  out = [];
  assert.equal(await cli("show", "--json"), 0, stderr());
  assert.equal(JSON.parse(stdout()).enabled, false);
  out = [];
  assert.equal(await cli("get", "--json"), 0, stderr());
  assert.equal(JSON.parse(stdout()).enabled, false);
  out = [];
  assert.equal(await cli("compile", "--check", "--json"), 0, stderr());
  assert.equal(JSON.parse(stdout()).enabled, false);

  out = [];
  assert.equal(await cli("on", "--json"), 0, stderr());
  const resumed = JSON.parse(stdout()) as { enabled: boolean; changed: boolean };
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.changed, true);
  assert.deepEqual(config(), beforeConfig);
  assert.equal(tone(), beforeTone);

  const resumedBytes = [readFileSync(paths().config), readFileSync(paths().tone)];
  out = [];
  assert.equal(await cli("on", "--json"), 0, stderr());
  assert.equal(JSON.parse(stdout()).changed, false);
  assert.deepEqual([readFileSync(paths().config), readFileSync(paths().tone)], resumedBytes);
});

test("nothing is written outside the resolved root", async () => {
  await initializeState();
  // The first version listed three known paths and asserted they existed, which a write to
  // ~/.claude/CLAUDE.md would have passed unchanged. This snapshots a sibling directory
  // instead, so any escape shows up as a file that was not there before.
  const outside = mkdtempSync(join(tmpdir(), "tonedial-outside-"));
  const before = snapshot(outside);
  for (const args of [["use", "tough-love"], ["set", "critique=4"], ["save", "Local Only"], ["compile"], ["reset"]]) {
    assert.equal(await cli(...args), 0, args.join(" "));
  }
  assert.deepEqual(snapshot(outside), before, "a sibling directory was touched");
  for (const p of snapshot(home)) assert.ok(p.startsWith(home), `${p} escaped the root`);
  rmSync(outside, { recursive: true, force: true });
});

test("after every command the artifact on disk equals a compile of the state on disk", async () => {
  await initializeState();
  // The property, rather than the round trip's wording. `save` used to finish with tone.md
  // still saying `preset: unsaved` while config.json named the preset, and the old test
  // could not see it because a `use` ran in between and repaired it.
  const inSync = (label: string) => {
    const fromState = compile(toCompileInput(config()));
    assert.equal(tone(), fromState, `${label}: tone.md and config.json disagree`);
  };
  for (const args of [
    ["set", "critique=5"], ["save", "Mine"], ["use", "tough-love"],
    ["set", "warmth=1"], ["reset", "warmth"], ["reset"], ["compile"],
  ]) {
    assert.equal(await cli(...args), 0, args.join(" "));
    inSync(args.join(" "));
  }
});

test("every command emits --json carrying the schema version", async () => {
  await initializeState();
  for (const args of [
    ["show"], ["list"], ["use", "tough-love"], ["compile"], ["export", "tough-love"],
    ["set", "critique=4"], ["reset", "critique"], ["save", "Every Json"],
  ]) {
    out = [];
    assert.equal(await cli(...args, "--json"), 0, args.join(" "));
    const parsed = JSON.parse(stdout()) as { schema: number; ok: boolean; warnings: unknown };
    assert.equal(parsed.schema, 3, args.join(" "));
    assert.equal(parsed.ok, true);
    assert.ok(Array.isArray(parsed.warnings), "warnings are always an array");
  }
});

test("a failure reports through --json rather than only on stderr", async () => {
  await initializeState();
  // `show` threw a bare Error, which escaped the envelope entirely and printed a stack with
  // no JSON at all — on the path a skill hits most, a mistyped slug.
  for (const args of [["use", "no-such"], ["show", "no-such"], ["set", "nope=1"], ["import", "/nope.json"]]) {
    out = [];
    assert.ok(await cli(...args, "--json") > 0, args.join(" "));
    const parsed = JSON.parse(stdout()) as { schema: number; ok: boolean; error: string; warnings: unknown[] };
    assert.equal(parsed.schema, 3, args.join(" "));
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error.length > 0, args.join(" "));
    assert.deepEqual(parsed.warnings, [], "the shape does not change between success and failure");
  }
});

test("argument-parser failures honor JSON intent before command dispatch", async () => {
  for (const args of [["show", "--typo", "--json"], ["show", "--json", "--typo"]]) {
    out = [];
    err = [];
    assert.equal(await cli(...args), 2);
    assert.deepEqual(JSON.parse(stdout()), {
      schema: 3, ok: false, error: EN.errors.notAnOption("--typo"), warnings: [],
    });
    assert.equal(stderr(), "", "a machine refusal must not emit a second human diagnostic");
    assert.equal(existsSync(paths().root), false, "a parser refusal created state");
  }
});

test("JSON intent ignores literal arguments and string-option values", async () => {
  for (const args of [
    ["show", "--typo", "--", "--json"],
    ["show", "--typo", "--color=--json"],
    ["show", "--typo", "--project", "--json"],
  ]) {
    out = [];
    err = [];
    assert.equal(await cli(...args), 2, args.join(" "));
    assert.equal(stdout(), "", args.join(" "));
    assert.ok(collapsed(stderr()).includes(collapsed(EN.errors.notAnOption("--typo"))));
    assert.equal(existsSync(paths().root), false);
  }
});

test("a flag reaches only the commands that accept it", async () => {
  await initializeState();
  assert.equal(await cli("compile", "--project", "."), 2);
  assert.ok(stderr().includes(EN.errors.flagNotAccepted("compile", "project")));
  assert.equal(await cli("show", "--check"), 2);
  assert.equal(await cli("use", "tough-love", "--project", "."), 0, "use takes it");
  assert.equal(await cli("eject", "--project", ".", "--dry-run", "--auto"), 0, "and eject, which takes it back out");
});

test("an extra positional is refused rather than silently dropped", async () => {
  assert.equal(await cli("reset", "critique", "warmth"), 2);
  assert.ok(stderr().includes(EN.errors.tooManyArguments("reset", 1, 2)));
  assert.equal(await cli("list", "extra"), 2);
});

test("--help succeeds, because the artifact tells the agent to run it", async () => {
  assert.equal(await cli("--help"), 0);
  // Every command it dispatches is listed. A command reachable but undocumented is a command
  // only someone who has read the source can find.
  for (const name of ["set", "reset", "show", "save", "list", "use", "compile", "export", "import"]) {
    assert.match(stdout(), new RegExp(`\\b${name}\\b`), name);
  }
});

test("bare help stays compact, --help carries the reference, and verbose keeps JSON stable", async () => {
  assert.equal(await cli("show", "--help"), 0);
  assert.match(stdout(), /^tonedial show \[slug\]/);
  assert.match(stdout(), /--explain/);
  assert.match(stdout(), /-v, --verbose/);
  assert.doesNotMatch(stdout(), /--fix/, "command help lists only relevant flags");

  out = [];
  assert.equal(await cli(), 0);
  const compactHelp = stdout();
  assert.doesNotMatch(compactHelp, /set <key>=<value>/, "compact help is a command directory");

  out = [];
  assert.equal(await cli("--help"), 0);
  const fullHelp = stdout();
  assert.match(fullHelp, /set <key>=<value>/, "full help includes command syntax and descriptions");
  assert.ok(fullHelp.split("\n").length > compactHelp.split("\n").length, "full help carries the reference");
  out = [];
  assert.equal(await cli("--help", "--verbose"), 0);
  assert.equal(stdout(), fullHelp, "full help does not require a second discovery flag");

  await initializeState();
  assert.equal(await cli("show", "--json"), 0);
  const compactJson = stdout();
  out = [];
  assert.equal(await cli("show", "--json", "-v"), 0);
  assert.equal(stdout(), compactJson, "verbose never changes machine output");

  out = [];
  assert.equal(await cli("show", "-v"), 0);
  assert.match(stdout(), new RegExp(EN.artifact.whatEachAxisObserves));
});

test("an unknown axis suggests the nearest one instead of guessing", async () => {
  await initializeState();
  assert.equal(nearestAxis("critque"), "critique");
  assert.equal(nearestAxis("warmness"), "warmth");
  assert.equal(nearestAxis("zzzzzzzzzzzz"), null, "a name close to nothing gets no suggestion");
  assert.equal(await cli("set", "critque=5"), 1);
  assert.match(stderr(), /Did you mean critique\?/);
});

test("set rejects a level outside 1 to 5 and leaves the state untouched", async () => {
  await initializeState();
  assert.equal(await cli("use", "tough-love"), 0);
  const before = readFileSync(paths().config, "utf8");
  assert.equal(await cli("set", "critique=9"), 1);
  assert.equal(readFileSync(paths().config, "utf8"), before, "a rejected set writes nothing");
});

test("persona age takes a band, buckets a number, and rejects anything else", async () => {
  await initializeState();
  assert.equal(await cli("set", "persona.age=40s"), 0);
  assert.equal(config().persona.age, "40s");
  assert.equal(await cli("set", "persona.age=34"), 0);
  assert.equal(config().persona.age, "30s", "a raw number is bucketed on write");
  assert.equal(await cli("set", "persona.age=17"), 0);
  assert.equal(config().persona.age, "teens");
  assert.equal(await cli("set", "persona.age=61"), 0);
  assert.equal(config().persona.age, "50s+");
  assert.equal(await cli("set", "persona.age=ancient"), 1);
  assert.match(stderr(), /persona\.age/);
});

test("persona gender is a closed set", async () => {
  await initializeState();
  assert.equal(await cli("set", "persona.gender=feminine"), 0);
  assert.equal(config().persona.gender, "feminine");
  assert.equal(await cli("set", "persona.gender=nonbinary"), 1);
});

test("normal address changes do not report a problem", async () => {
  await initializeState();
  assert.equal(await cli("set", "persona.user_ref=선생님"), 0);
  assert.equal(stderr(), "");
});

test("valid persona settings do not repeat general product caveats", async () => {
  await initializeState();
  assert.equal(await cli("set", "persona.age=40s", "persona.gender=masculine", "persona.note=x"), 0);
  assert.equal(stderr(), "");
});

test("address sets both terms in one command, and is the same write as two sets", async () => {
  await initializeState();
  assert.equal(await cli("address", "소인", "왕"), 0, stderr());
  const viaAddress = config();
  assert.deepEqual(viaAddress.persona.address, { self_ref: "소인", user_ref: "왕" });
  // The receipt names the keys it moved, because the stored shape nests them and the movement
  // is the only place a user sees which of the two each word landed on.
  assert.match(stdout(), /persona\.self_ref/);
  assert.match(stdout(), /persona\.user_ref/);

  // The point of the command is discoverability, not a second write path. Reaching the same
  // state through the keys it wraps has to produce the same config, or one of them is lying.
  assert.equal(await cli("address", "", ""), 0, stderr());
  assert.equal(await cli("set", "persona.self_ref=소인", "persona.user_ref=왕"), 0, stderr());
  assert.deepEqual(config(), viaAddress);
});

test("address takes both terms or neither, because half an address reads as a mistake", async () => {
  await initializeState();
  assert.equal(await cli("address", "소인"), 1);
  assert.match(stderr(), /address/);
  assert.equal(config().persona.address, null, "a refused pair writes nothing");
});

test("address clears both terms when handed two empty strings", async () => {
  await initializeState();
  assert.equal(await cli("address", "소인", "왕"), 0, stderr());
  assert.equal(await cli("address", "", ""), 0, stderr());
  // Null rather than a pair of nulls: an address with nothing in it is no address, which is the
  // shape `set` already collapses to and what the compiler tests for.
  assert.equal(config().persona.address, null);
});

test("address refuses rather than blocking where no question can be asked", async () => {
  await initializeState();
  // `--json` is the deterministic form of "nobody is watching" — it pins `canPrompt` false
  // without depending on whether the test runner handed this file a terminal.
  assert.equal(await cli("address", "--json"), 1);
  assert.match(stdout(), /address/);
});

test("persona applies agent and user roles together, recompiles, and saves them with the profile", async () => {
  await initializeState();
  const axes = config().axes;
  const address = config().persona.address;
  assert.equal(await cli("persona", "  A fictional reviewer  ", "A developer", "--json"), 0, stderr());
  const result = JSON.parse(stdout());
  assert.equal(result.config.persona.agent, "A fictional reviewer");
  assert.equal(result.config.persona.user, "A developer");
  assert.deepEqual(config().axes, axes);
  assert.deepEqual(config().persona.address, address);
  assert.equal(config().unsaved, true);
  assert.ok(tone().includes("A fictional reviewer") && tone().includes("A developer"));
  assert.equal(await cli("save", "Persona Example"), 0, stderr());
  assert.equal(await cli("persona", "", ""), 0, stderr());
  assert.equal(config().persona.agent, null);
  assert.equal(config().persona.user, null);
  assert.equal(await cli("use", "persona-example"), 0, stderr());
  assert.equal(config().persona.agent, "A fictional reviewer");
  assert.equal(config().persona.user, "A developer");
  assert.equal(await cli("persona", "Another reviewer", "Another developer"), 0, stderr());
  out = [];
  assert.equal(await cli("show", "persona-example"), 0, stderr());
  assert.match(stdout().replace(/\s+/g, " "), /A fictional reviewer/);
  assert.doesNotMatch(stdout(), /Another reviewer/);
});

test("persona validates both 200-code-point descriptions before writing and never prompts in JSON", async () => {
  await initializeState();
  const boundary = "😀".repeat(200);
  assert.equal(await cli("persona", boundary, boundary), 0, stderr());
  const before = [readFileSync(paths().config, "utf8"), tone()];
  for (const args of [["persona"], ["persona", "One role"], ["persona", "Too", "Many", "Roles"],
    ["persona", boundary + "😀", "Changed user"], ["persona", "Changed agent", boundary + "😀"]]) {
    out = [];
    assert.notEqual(await cli(...args, "--json"), 0, args.join(" "));
    assert.equal(JSON.parse(stdout()).ok, false);
    assert.deepEqual([readFileSync(paths().config, "utf8"), tone()], before, "rejected roles changed files");
  }
});

test("bare set --json honors nonprompting context when streams report TTY", async () => {
  await initializeState();
  const beforeConfig = readFileSync(paths().config, "utf8");
  const beforeTone = tone();
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
  // The eligibility branch is controlled here; actual raw-mode/terminal behavior is a PTY
  // check. A delayed cancel lets the pre-fix dial exit so the regression never hangs.
  const source = `
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    process.stdin.setRawMode = () => process.stdin;
    const { run } = await import(${JSON.stringify(pathToFileURL(entry).href)});
    setTimeout(() => process.stdin.emit("keypress", "q", { name: "q" }), 10);
    process.exitCode = await run(["set", "--json"]);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: join(home, "project"),
    env: { ...commandEnv(), TERM: "xterm", XDG_CONFIG_HOME: join(home, "xdg"), XDG_CACHE_HOME: join(home, "cache") },
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.error, undefined, "JSON mode waited for dial input");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    schema: 3, ok: false, error: EN.axis.needsArgument, warnings: [],
  });
  assert.equal(readFileSync(paths().config, "utf8"), beforeConfig);
  assert.equal(tone(), beforeTone);
});

test("bare set commits an interactive dial change through the command path", async () => {
  await initializeState();
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
  // Drive the real CLI with a terminal-shaped stdin, then inspect the files it wrote. A dial
  // unit test proves the selected axes; this catches a run-level regression that could lose the
  // selection before the config/artifact transaction or print a receipt for a different state.
  const source = `
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    process.stdin.setRawMode = () => process.stdin;
    const { run } = await import(${JSON.stringify(pathToFileURL(entry).href)});
    process.exitCode = await run(["set"]);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: join(home, "project"),
    env: { ...commandEnv(), NO_COLOR: "1", TERM: "xterm" },
    input: "\u001b[C\r", encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.error, undefined, "interactive set did not finish");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ToneDial · set/);
  assert.match(result.stdout, /formality\s+3 → 4/);
  assert.match(result.stdout, /TONE\.md generated/);

  const saved = config();
  assert.equal(saved.axes.formality, 4, "the dial selection was not persisted");
  assert.equal(saved.unsaved, true, "the dial selection did not mark the artifact unsaved");
  assert.equal(tone(), compile(toCompileInput(saved)), "the generated artifact does not match saved settings");
});

test("the interface language is settable after init, not only during it", async () => {
  await initializeState();
  // It used to be reachable through `init --lang` alone, so changing your mind about it meant
  // re-running setup on a home that was already set up.
  assert.equal(config().language, "en");
  assert.equal(await cli("set", "language=ko"), 0, stderr());
  assert.equal(config().language, "ko");
  assert.match(stdout(), /language/);

  assert.equal(await cli("set", "language=xx"), 1, "an unsupported language is refused");
  assert.equal(config().language, "ko", "a refused value leaves the old one");
  // It reaches nothing the agent reads: the anchors are one English set whatever this says.
  assert.doesNotMatch(tone(), /ko/i);
});

test("the retired fixed_width setting refuses clearly without changing files", async () => {
  await initializeState();
  assert.equal(Object.hasOwn(config(), "fixed_width"), false);
  const beforeFiles = snapshot(paths().root);
  for (const args of [["fixed_width=true"], ["warmth=2", "fixed_width=false"], ["fixed_width=yes"]]) {
    out = [];
    err = [];
    assert.equal(await cli("set", ...args, "--json"), 1);
    assert.deepEqual(JSON.parse(stdout()), { schema: 3, ok: false, error: EN.settings.fixedWidthRetired, warnings: [] });
    assert.equal(stderr(), "");
    assert.deepEqual(snapshot(paths().root), beforeFiles, "retirement refusal changed saved files");
  }
});

test("valid legacy width input stays readable until an authorized canonical write", async () => {
  await initializeState();
  for (const legacy of [true, false, undefined]) {
    const raw = JSON.parse(readFileSync(paths().config, "utf8")) as Record<string, unknown>;
    if (legacy === undefined) delete raw.fixed_width;
    else raw.fixed_width = legacy;
    const bytes = JSON.stringify(raw, null, 2) + "\n";
    writeFileSync(paths().config, bytes);
    assert.equal(Object.hasOwn(config(), "fixed_width"), false, "obsolete field became active state");
    assert.equal(await cli("show"), 0, stderr());
    assert.equal(readFileSync(paths().config, "utf8"), bytes, "read-only show canonicalized legacy input");
    assert.equal(await cli("set", "warmth=4"), 0, stderr());
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(paths().config, "utf8")), "fixed_width"), false);
    assert.equal(config().axes.warmth, 4);
  }
});

test("a persona key that does not exist is refused by naming the ones that do", async () => {
  await initializeState();
  // The stored shape nests the address terms, so `persona.address.user` is the first thing
  // someone who has read config.json reaches for.
  assert.equal(await cli("set", "persona.address.user=선생님"), 1);
  for (const field of ["age", "gender", "self_ref", "user_ref", "note", "user", "agent"]) {
    assert.match(stderr(), new RegExp(field), field);
  }
});

test("set reports the movement, not only which keys were touched", async () => {
  await initializeState();
  assert.equal(await cli("set", "warmth=5"), 0);
  out = [];
  assert.equal(await cli("set", "warmth=2"), 0);
  assert.match(stdout(), /warmth\s+5 → 2/);
});

test("saved names and settings cannot forge human notices while storage and JSON keep their text", async () => {
  await initializeState();
  const controlled = "Name\u001b[2J\nFORGED\u202e 👩‍💻";
  const render = (...args: string[]) => run(args, { ...commandEnv(), FORCE_COLOR: "1" }, join(home, "project"), false, false);
  const visible = (text: string) => text.replace(/\x1b\[(?:1|2|22|31|32|33|36|39)m/g, "");
  const assertSafe = (text: string) => {
    const printed = visible(text);
    const dangerous = [...printed].filter(character => /[\p{Cc}\p{Cf}]/u.test(character)
      && character !== "\n" && character !== "\u200c" && character !== "\u200d");
    assert.deepEqual(dangerous, [], printed);
    assert.doesNotMatch(printed, /^FORGED/m, "user text created a new receipt row");
    return printed;
  };
  out = [];
  err = [];
  assert.equal(await render("save", controlled), 0, stderr());
  const saveReceipt = assertSafe(stdout() + stderr());
  assert.match(saveReceipt, /Name\\u\{1b\}\[2J\\u\{a\}FORGED\\u\{202e\}/);
  assert.ok(saveReceipt.includes("👩‍💻"), "display sanitization broke a legitimate emoji joiner");
  const slug = config().preset!;
  assert.equal(JSON.parse(readFileSync(join(customPresetDir(paths().presets), `${slug}.json`), "utf8")).displayName, controlled);
  out = [];
  assert.equal(await render("save", controlled, "--json"), 0);
  assert.equal(JSON.parse(stdout()).displayName, controlled);

  const previous = `Old ${controlled}`;
  out = [];
  assert.equal(await cli("set", `persona.self_ref=${previous}`, `persona.user_ref=${previous}`, `safeword=${previous}`, `persona.note=${previous}`, "--json"), 0);
  const originalMoves = JSON.parse(stdout()).moves as { key: string; to: string }[];
  for (const key of ["persona.self_ref", "persona.user_ref", "safeword"]) assert.equal(originalMoves.find(move => move.key === key)?.to, previous);
  const current = `New ${controlled}`;
  out = [];
  err = [];
  assert.equal(await render("set", `persona.self_ref=${current}`, `persona.user_ref=${current}`, `safeword=${current}`, `persona.note=${current}`), 0, stderr());
  const setReceipt = assertSafe(stdout() + stderr());
  assert.match(setReceipt, /\\u\{1b\}\[2J\\u\{a\}/);
  assert.equal(config().persona.address?.self_ref, current);
  assert.equal(config().persona.address?.user_ref, current);
  assert.equal(config().persona.note, current);
  assert.equal(config().safeword, current);
  assert.equal(await cli("save"), 0);
  const artifact = tone();
  for (const args of [["show"], ["use", slug]]) {
    out = [];
    err = [];
    assert.equal(await render(...args), 0, stderr());
    assertSafe(stdout() + stderr());
  }
  assert.equal(tone(), artifact, "human display sanitization changed compiled bytes");
  out = [];
  assert.equal(await cli("show", "--json"), 0);
  const saved = JSON.parse(stdout());
  assert.equal(saved.persona.address.self_ref, current);
  assert.equal(saved.persona.address.user_ref, current);
  assert.equal(saved.persona.note, current);
  assert.equal(saved.safeword, current);
  out = [];
  err = [];
  assert.equal(await render("set", "safeword=x\ny"), 0);
  assertSafe(stdout() + stderr());
  assert.match(visible(stderr()), /safeword x\\u\{a\}y/, "the short-safeword warning echoed a value newline as layout");
  out = [];
  assert.equal(await cli("set", "safeword=x\ny", "--json"), 0);
  assert.equal(JSON.parse(stdout()).warnings[0], EN.settings.safewordShort("x\ny"), "display escaping altered the machine warning");
});

test("role notes are preserved without English substring guesses about tone", async () => {
  await initializeState();
  for (const note of ["Swarm engineer and shortbread baker", "Be harsh about the code and very brief.",
    "간결한 답변을 좋아하는 개발자", "簡潔な説明が好きな開発者", "喜欢简明说明的开发者", "Desarrolla herramientas pequeñas"]) {
    out = []; err = [];
    assert.equal(await cli("set", `persona.note=${note}`, "--json"), 0);
    assert.deepEqual(JSON.parse(stdout()).warnings, []);
    assert.equal(config().persona.note, note);
  }
});

test("setting warnings describe final values rather than superseded assignments", async () => {
  await initializeState();
  assert.equal(await cli("set", "safeword=x", "safeword=plain reply", `persona.note=${"x".repeat(201)}`,
    "persona.note=Final role note", "--json"), 0);
  assert.deepEqual(JSON.parse(stdout()).warnings, []);
  assert.equal(config().safeword, "plain reply");
  assert.equal(config().persona.note, "Final role note");
});

test("a long persona note is valid and preserves its full text without a made-up limit", async () => {
  await initializeState();
  assert.equal(await cli("set", `persona.note=${"x".repeat(201)}`, "playfulness=5", "--json"), 0);
  assert.deepEqual(JSON.parse(stdout()).warnings, []);
  assert.equal([...config().persona.note!].length, 201, "stored anyway");
});

test("user and agent role descriptions trim, clear, and reject overlong Unicode input atomically", async () => {
  await initializeState();
  const user = "Builds small tools and likes careful reviews.";
  const agent = "A TypeScript specialist with ten years of experience who speaks plainly.";
  assert.equal(await cli("set", `persona.user=  ${user}  `, `persona.agent=  ${agent}  `, "--json"), 0, stderr());
  const receipt = JSON.parse(stdout()) as { config: { persona: { user: string; agent: string } } };
  assert.deepEqual([receipt.config.persona.user, receipt.config.persona.agent], [user, agent],
    "explicit machine mutation results retain the chosen settings");
  assert.equal(config().persona.user, user);
  assert.equal(config().persona.agent, agent);

  assert.equal(await cli("set", "persona.user=   "), 0, stderr());
  assert.equal(config().persona.user, null, "whitespace clears a role description");
  assert.equal(await cli("set", "persona.agent=   "), 0, stderr());
  assert.equal(config().persona.agent, null, "whitespace clears the fictional role");

  const astral = "😀".repeat(200);
  assert.equal(await cli("set", `persona.user=${astral}`), 0, stderr());
  assert.equal([...config().persona.user!].length, 200, "the boundary counts Unicode code points");
  const beforeConfig = readFileSync(paths().config, "utf8");
  const beforeTone = tone();
  assert.equal(await cli("set", "persona.user=would-be-changed", `persona.agent=${"😀".repeat(201)}`), 1);
  assert.match(stderr(), /persona\.agent/);
  assert.doesNotMatch(stderr(), /😀{20}/u, "the rejected role value is not echoed");
  assert.equal(readFileSync(paths().config, "utf8"), beforeConfig, "a rejected role leaves config untouched");
  assert.equal(tone(), beforeTone, "a rejected role leaves the artifact untouched");
  assert.equal(config().persona.user, astral, "a rejected pair does not partially apply the other role");
});

test("retired guards assignments fail clearly without committing any changes", async () => {
  await initializeState();
  const beforeConfig = readFileSync(paths().config, "utf8");
  const beforeTone = tone();
  const operations = inspectOperations(paths()).journals.length;
  for (const value of ["true", "false", "invalid"]) {
    out = [];
    err = [];
    assert.equal(await cli("set", "warmth=5", `guards=${value}`, "--json"), 1);
    assert.deepEqual(JSON.parse(stdout()), { schema: 3, ok: false, error: EN.settings.guardsRetired, warnings: [] });
    assert.equal(readFileSync(paths().config, "utf8"), beforeConfig);
    assert.equal(tone(), beforeTone);
    assert.equal(inspectOperations(paths()).journals.length, operations);
  }
});

test("a forbidden combination warns and still applies", async () => {
  await initializeState();
  assert.equal(await cli("set", "refusal=5", "compliance=5"), 0);
  assert.match(stderr(), /refusal≥4 × compliance≥4/);
  assert.equal(config().axes.refusal, 5, "nothing is blocked");
  assert.equal(config().axes.compliance, 5, "the contradiction is not lowered");
  assert.equal(tone(), compile(toCompileInput(config())), "the artifact includes the unchanged choice");
});

test("use restores a bundled profile's complete settings, including clearing the previous safeword", async () => {
  await initializeState();
  assert.equal(await cli("set", "safeword=연기 그만", "persona.user_ref=선생님",
    "persona.user=likes small tools", "persona.agent=plain-speaking reviewer"), 0);
  assert.equal(await cli("use", "eager-sycophant"), 0);
  const profile = BUNDLED.find(p => p.slug === "eager-sycophant")!;
  assert.equal(config().safeword, profile.settings!.safeword);
  assert.deepEqual(config().persona, profile.settings!.persona);
  assert.equal(config().speech_level, profile.settings!.speech_level);
  assert.deepEqual(config().axes, applyPreset(BUNDLED.find((p) => p.slug === "eager-sycophant")!));
});

test("use reports the safeword and advisory risky axes without repeating help", async () => {
  await initializeState();
  assert.equal(await cli("set", "safeword=연기 그만"), 0);
  out = [];
  assert.equal(await cli("use", "tough-love"), 0);
  const receipt = flat();
  assert.match(receipt, /safeword 연기 그만/, "the current safeword remains visible");
  assert.doesNotMatch(receipt, /requests one plain answer|grants authority/, "ordinary receipts do not repeat setting help");
  assert.ok(!receipt.includes(EN.notice.risk), "a valid selection must not repeat the general product disclaimer");
  assert.match(receipt, /! critique · harsh language/);
  assert.doesNotMatch(stdout(), /guards|G[1-4]/i, "retired guard state is absent");
});

test("use --project writes the artifact into the project and nothing else", async () => {
  await initializeState();
  // The artifact has to work for someone without tonedial installed, so it is the compiled
  // file rather than a link into a home their collaborators do not have.
  assert.equal(await cli("use", "tough-love", "--project", "."), 0);
  const projectTone = join(home, "project", ".tonedial", "TONE.md");
  assert.equal(readFileSync(projectTone, "utf8"), tone(), "the same bytes as the home artifact");
  assert.deepEqual(
    readdirSync(join(home, "project", ".tonedial")),
    ["TONE.md"],
    "a project directory gains the artifact and nothing else",
  );
});

test("a command flag reaches the command instead of being swallowed by the parser", async () => {
  await initializeState();
  // A permissive parse put every unknown flag in `values` and handed commands only the
  // positionals, so `--project` and `--check` were accepted and then silently ignored.
  assert.equal(await cli("use", "tough-love"), 0);
  const before = tone();
  rmSync(paths().tone);
  assert.equal(await cli("compile", "--check"), 0);
  assert.ok(!existsSync(paths().tone), "--check reports without writing");
  assert.equal(await cli("compile"), 0);
  assert.equal(tone(), before, "and a plain compile still writes");
});

test("a misspelled flag fails rather than being ignored", async () => {
  assert.equal(await cli("show", "--jsonn"), 2);
  assert.match(stderr(), /jsonn/);
});

test("save captures axes and the complete profile settings, excluding interface and wiring", async () => {
  await initializeState();
  assert.equal(await cli("set", "safeword=연기 그만", "persona.age=40s",
    "persona.user=likes small tools", "persona.agent=plain-speaking reviewer"), 0);
  assert.equal(await cli("use", "terse-operator"), 0);
  assert.equal(await cli("save", "My Operator"), 0);
  const saved = JSON.parse(readFileSync(join(customPresetDir(paths().presets), "my-operator.json"), "utf8"));
  assert.deepEqual(Object.keys(saved.values).sort(), ["care", "conviction", "playfulness", "verbosity", "warmth"]);
  assert.equal(saved.schema, 2);
  assert.deepEqual(saved.settings, { persona: config().persona, safeword: "연기 그만", speech_level: "auto" });
  assert.equal(Object.hasOwn(saved, "language"), false);
  assert.equal(Object.hasOwn(saved, "wiring"), false);
});

test("save refuses to shadow a bundled slug", async () => {
  await initializeState();
  assert.equal(await cli("save", "Royal Advisor"), 1);
  assert.match(stderr(), /bundled preset/);
});

test("saving a valid custom preset does not warn about its number of changed axes", async () => {
  await initializeState();
  assert.equal(await cli("set", "critique=5"), 0);
  out = []; err = [];
  assert.equal(await cli("save", "Just One", "--json"), 0);
  const saved = JSON.parse(stdout());
  assert.equal(saved.nonDefaultAxes, 1);
  assert.deepEqual(saved.warnings, []);
});

test("slugs are lowercase Latin letters, digits, and dashes", async () => {
  assert.equal(slugify("Tough Love", EN), "tough-love");
  assert.equal(slugify("  My   Operator!  ", EN), "my-operator");
  assert.throws(() => slugify("한국어만", EN), /no Latin letters or digits/);
});

test("export and import round-trip full profiles without activating them", async () => {
  await initializeState();
  assert.equal(await cli("set", "safeword=연기 그만", "persona.note=A senior engineer.",
    "persona.user=likes small tools", "persona.agent=plain-speaking reviewer", "speech_level=rough"), 0);
  assert.equal(await cli("use", "terse-operator"), 0);
  assert.equal(await cli("save", "Portable"), 0);
  out = [];
  assert.equal(await cli("export", "portable"), 0);
  const exported = stdout();
  assert.equal(JSON.parse(exported).schema, 2);
  assert.deepEqual(JSON.parse(exported).settings, { persona: config().persona, safeword: "연기 그만", speech_level: "rough" });
  assert.equal(await cli("set", "speech_level=plain"), 0);
  const beforeImport = readFileSync(paths().config);
  const beforeArtifact = tone();

  const sourceDirectory = join(home, `input files with spaces${" source".repeat(15)}`);
  mkdirSync(sourceDirectory);
  const file = join(sourceDirectory, "portable.json");
  writeFileSync(file, exported);
  rmSync(join(customPresetDir(paths().presets), "portable.json"));
  out = [];
  assert.equal(await cli("import", file), 0);
  assert.ok(existsSync(join(customPresetDir(paths().presets), "portable.json")));
  const sourceRow = stdout().split("\n").find(line => line.trim().endsWith("portable.json"));
  assert.ok(sourceRow, "the import receipt lost its local source");
  assert.ok(maxCells(sourceRow) > 100, "the fixture did not exercise an intact long path");
  assert.equal(readFileSync(sourceRow.trim(), "utf8"), exported, "the displayed source no longer resolves to the imported bytes");
  out = []; err = [];
  assert.equal(await cli("import", file), 0);
  assert.ok(stdout().includes(EN.preset.imported("portable", true)));
  assert.equal(stderr(), "", "a successful replacement is a receipt, not a warning");
  assert.deepEqual(readFileSync(paths().config), beforeImport, "import must not activate the rough register");
  assert.equal(tone(), beforeArtifact);
  assert.equal(await cli("use", "portable"), 0);
  assert.equal(config().speech_level, "rough");
  assert.equal(tone(), compile(toCompileInput(config())));
});

test("import refuses to replace a bundled preset", async () => {
  await initializeState();
  const file = join(home, "evil.json");
  writeFileSync(file, JSON.stringify({ schema: 1, slug: "royal-advisor", displayName: "x", values: {} }));
  assert.equal(await cli("import", file), 1);
  // Against the catalogue rather than a literal: what matters is that *this* message is the one
  // emitted, which stays true when the wording changes and fails when the wrong one is picked.
  assert.match(stderr(), new RegExp(catalogue("en").cli.preset.bundledSlug("royal-advisor")));
});

test("importing JSON null is refused through the preset boundary without writing state", async () => {
  await initializeState();
  const file = join(home, "not-a-preset.json");
  writeFileSync(file, "null");
  const beforeConfig = readFileSync(paths().config, "utf8");
  const beforeTone = tone();
  const beforeFiles = snapshot(paths().root);
  assert.equal(await cli("import", file, "--json"), 1);
  assert.deepEqual(JSON.parse(stdout()), {
    schema: 3, ok: false, error: EN.preset.notAPreset(file), warnings: [],
  });
  assert.equal(stderr(), "");
  assert.deepEqual(snapshot(paths().root), beforeFiles);
  assert.equal(readFileSync(paths().config, "utf8"), beforeConfig);
  assert.equal(tone(), beforeTone);
});

test("show marks every axis that has moved off its default", async () => {
  await initializeState();
  assert.equal(await cli("use", "terse-operator"), 0);
  out = [];
  assert.equal(await cli("show"), 0);
  const text = stdout();
  for (const axis of AXIS_ORDER) {
    const moved = applyPreset(RETIRED_PRESETS.find((p) => p.slug === "terse-operator")!)[axis] !== AXIS_DEFAULT[axis];
    const line = text.split("\n").find((l) => new RegExp(`\\b${axis}\\b`).test(l))!;
    assert.equal(line.includes("*"), moved, `${axis} marker`);
  }
});

test("show --explain says in words why all-3 is not neutral", async () => {
  // The legend left the gauge screen because it never changes; it did not stop existing.
  assert.equal(await cli("show", "--explain"), 0);
  const permissionAxes = EN.artifact.permissionAxes(["profanity", "flattery", "refusal", "bravado"]);
  assert.ok(collapsed(stdout()).includes(collapsed(permissionAxes)));
  out = [];
  assert.equal(await cli("show"), 0);
  assert.equal(collapsed(stdout()).includes(collapsed(permissionAxes)), false, "and it is not on the everyday screen");
  assert.match(stdout(), /--explain/, "which says where it went");
});

test("show publishes advisory risk metadata without guard or ceiling fields", async () => {
  await initializeState();
  assert.equal(await cli("set", "profanity=4", "flattery=3", "refusal=2", "bravado=2", "critique=4", "conviction=5", "compliance=5"), 0);
  out = [];
  assert.equal(await cli("show", "--explain"), 0);
  assert.match(collapsed(stdout()), /not measured probabilities/);
  const json = JSON.parse((out = [], await cli("show", "--json"), stdout())) as {
    riskAxes: string[];
    riskThresholds: Record<string, number>;
    kinds: Record<string, string>;
  };
  assert.deepEqual(json.riskAxes, ["profanity", "critique", "flattery", "conviction", "compliance", "refusal", "bravado"]);
  assert.deepEqual(json.riskThresholds, { profanity: 4, critique: 4, flattery: 3, conviction: 5, compliance: 5, refusal: 2, bravado: 2 });
  assert.equal(Object.hasOwn(json, "guards"), false);
  assert.equal(Object.hasOwn(json, "ceilings"), false);
  assert.equal(json.kinds.flattery, "permission");
  assert.equal(json.kinds.warmth, "style");
});

test("show previews a preset without activating it", async () => {
  await initializeState();
  assert.equal(await cli("use", "tough-love"), 0);
  out = [];
  assert.equal(await cli("show", "terse-operator", "--json"), 0);
  const json = JSON.parse(stdout()) as { preset: string; preview: boolean; axes: Record<string, number> };
  assert.equal(json.preview, true);
  assert.equal(json.axes.verbosity, 1, "the previewed values are shown");
  assert.equal(config().preset, "tough-love", "the active preset is unchanged");
});

test("current show guides saving changed axes to the named preset, while slug previews stay unchanged", async () => {
  await initializeState();
  assert.equal(await cli("save", "Jarvis Helper", "--slug", "my-jarvis"), 0, stderr());
  assert.equal(await cli("set", "warmth=2"), 0);
  const before = readFileSync(paths().config);
  out = [];
  assert.equal(await cli("show"), 0);
  assert.ok(flat().includes(EN.preset.changesNotSaved));
  assert.ok(stdout().includes("tonedial save"));
  assert.deepEqual(readFileSync(paths().config), before);
  out = [];
  assert.equal(await cli("show", "my-jarvis"), 0);
  assert.ok(!flat().includes(EN.preset.changesNotSaved));
  assert.ok(stdout().includes("tonedial use my-jarvis"));
  assert.equal(await cli("save"), 0);
  out = [];
  assert.equal(await cli("show"), 0);
  assert.ok(!flat().includes(EN.preset.changesNotSaved));
  assert.equal(config().axes.warmth, 2);
  assert.equal(JSON.parse(readFileSync(join(customPresetDir(paths().presets), "my-jarvis.json"), "utf8")).displayName, "Jarvis Helper");
});

test("create saves and switches complete profiles while interface language stays global", async () => {
  await initializeState();
  out = [];
  assert.equal(await cli("create", "내 자비스", "--slug", "my-jarvis", "warmth=2",
    "persona.self_ref=저", "persona.user_ref=사용자님", "persona.user=Maintains services",
    "persona.agent=A fictional reviewer", "speech_level=rough", "--auto", "--json"), 0, stderr());
  const result = JSON.parse(stdout());
  assert.equal(result.created, true);
  assert.ok(result.diff.some((entry: { path: string }) => entry.path === paths().config));
  assert.ok(result.diff.some((entry: { path: string }) => entry.path === paths().tone));
  const preset = JSON.parse(readFileSync(join(customPresetDir(paths().presets), "my-jarvis.json"), "utf8"));
  const saved = config();
  assert.deepEqual(preset, { schema: 2, slug: "my-jarvis", displayName: "내 자비스", values: { warmth: 2 },
    settings: { persona: saved.persona, safeword: saved.safeword, speech_level: saved.speech_level } });
  assert.equal(saved.preset, "my-jarvis");
  assert.equal(saved.unsaved, false);
  assert.equal(saved.speech_level, "rough");
  assert.equal(saved.persona.agent, "A fictional reviewer");
  assert.equal(saved.persona.user, "Maintains services");
  assert.deepEqual(saved.persona.address, { self_ref: "저", user_ref: "사용자님" });
  assert.equal(tone(), compile(toCompileInput(saved)));
  assert.equal(await cli("use", "tough-love"), 0);
  assert.deepEqual(config().persona, saved.persona, "a legacy bundled preset must preserve settings");
  assert.equal(await cli("set", "language=ko"), 0);
  assert.equal(await cli("create", "Alternate", "--slug", "alternate", "persona.agent=Another reviewer",
    "persona.self_ref=", "persona.user_ref=", "safeword=alternate reply", "speech_level=plain", "--auto"), 0);
  assert.equal(await cli("use", "my-jarvis"), 0);
  assert.deepEqual(config().persona, saved.persona);
  assert.equal(config().safeword, saved.safeword);
  assert.equal(config().speech_level, "rough");
  assert.equal(config().language, "ko");
  assert.equal(await cli("use", "alternate"), 0);
  assert.equal(config().persona.agent, "Another reviewer");
  assert.equal(config().persona.address, null);
  assert.equal(config().safeword, "alternate reply");
  assert.equal(config().speech_level, "plain");
  assert.equal(await cli("set", "persona.agent=Edited reviewer"), 0);
  assert.equal(config().unsaved, true);
  out = [];
  assert.equal(await cli("show", "alternate", "--json"), 0);
  assert.equal(JSON.parse(stdout()).persona.agent, "Another reviewer", "preview must use the saved role");
  assert.equal(config().persona.agent, "Edited reviewer", "preview must not activate the profile");
  assert.equal(await cli("save"), 0);
  assert.equal(config().unsaved, false);
});

test("create previews without writes and refuses missing approval, unsafe input and existing slugs", async () => {
  await initializeState();
  const before = readFileSync(paths().config);
  const artifact = tone();
  out = [];
  assert.equal(await cli("create", "Preview", "warmth=2", "persona.agent=Draft role", "--dry-run", "--json"), 0);
  const preview = JSON.parse(stdout());
  assert.equal(preview.created, false);
  assert.equal(preview.reason, "dry-run");
  assert.deepEqual(preview.warnings, [], "an unapplied profile must not emit current-state warnings");
  assert.ok(preview.diff.length >= 3);
  for (const args of [
    ["create"],
    ["create", "Missing Approval"],
    ["create", "Invalid Role", "persona.agent=" + "x".repeat(201), "--auto"],
    ["create", "Unsafe Slug", "--slug", "../outside", "--auto"],
    ["create", "Oversized Profile", "persona.note=" + "x".repeat(64 * 1024), "--auto"],
  ]) {
    out = []; err = [];
    assert.equal(await cli(...args, "--json"), 1, args.join(" "));
    assert.equal(JSON.parse(stdout()).ok, false);
    assert.deepEqual(readFileSync(paths().config), before);
    assert.equal(tone(), artifact);
    assert.equal(existsSync(customPresetDir(paths().presets)), false, "failed creation left a preset directory");
  }
  assert.equal(await cli("save", "Existing"), 0);
  const preset = readFileSync(join(customPresetDir(paths().presets), "existing.json"));
  const existingConfig = readFileSync(paths().config);
  assert.equal(await cli("create", "Existing", "warmth=5", "--auto"), 1);
  assert.deepEqual(readFileSync(paths().config), existingConfig);
  assert.deepEqual(readFileSync(join(customPresetDir(paths().presets), "existing.json")), preset);
});

test("created profiles report only final applicable setting warnings", async () => {
  await initializeState();
  assert.equal(await cli("create", "Final Profile", "safeword=x", "safeword=plain reply",
    `persona.note=${"x".repeat(201)}`, "persona.note=Final note", "--auto", "--json"), 0, stderr());
  const created = JSON.parse(stdout());
  assert.equal(created.created, true);
  assert.deepEqual(created.warnings, []);
  out = []; err = [];
  assert.equal(await cli("create", "Short Safeword", "safeword=x", "--auto", "--json"), 0, stderr());
  assert.deepEqual(JSON.parse(stdout()).warnings, [EN.settings.safewordShort("x")]);
});

test("show refusing a preset name lists the ones it would have taken", async () => {
  // It passed an empty list where every other refusal passes the real one, so the message read
  // "Available:" and then stopped, on a root holding all seven bundled profiles.
  await initializeState();
  err = [];
  assert.equal(await cli("show", "nope"), 1);
  const said = stderr();
  for (const { slug } of BUNDLED) assert.match(said, new RegExp(slug), `${slug} is missing from the list`);
});

test("reset with no argument clears the axes and leaves persona and safeword alone", async () => {
  await initializeState();
  assert.equal(await cli("use", "eager-sycophant"), 0);
  assert.equal(await cli("set", "safeword=연기 그만", "persona.age=40s",
    "persona.user=likes small tools", "persona.agent=plain-speaking reviewer"), 0);
  assert.equal(await cli("reset"), 0);
  assert.deepEqual(config().axes, AXIS_DEFAULT);
  assert.equal(config().safeword, "연기 그만");
  assert.equal(config().persona.age, "40s");
  assert.equal(config().persona.user, "likes small tools");
  assert.equal(config().persona.agent, "plain-speaking reviewer");
});

test("a malformed config is refused by field rather than silently defaulted", async () => {
  mkdirSync(dirname(paths().config), { recursive: true });
  const cases: [unknown, string | RegExp][] = [
    [[1, 2, 3], EN.config.rootNotAnObject],
    [{ schema: 1, axes: 5 }, EN.config.notAnObject("axes")],
    [{ schema: 1, persona: "senior dev" }, EN.config.notAnObject("persona")],
    [{ schema: 1, persona: { address: "boss" } }, EN.config.notAnObject("persona.address")],
    [{ schema: 1, guards: "false" }, EN.config.notABoolean("guards")],
    [{ schema: 1, enabled: "false" }, EN.config.notABoolean("enabled")],
    [{ schema: 1, emoji: 3 }, /unknown key emoji/],
    [{ schema: 1, safeword: 'a" b' }, EN.config.safewordQuote],
  ];
  for (const [body, expected] of cases) {
    err = [];
    writeFileSync(paths().config, JSON.stringify(body));
    assert.equal(await cli("show"), 1, JSON.stringify(body));
    if (typeof expected === "string") {
      assert.ok(collapsed(stderr()).includes(collapsed(expected)), JSON.stringify(body));
    } else assert.match(stderr(), expected);
  }
});

test("a name that is not a command is refused, including one the prototype answers for", async () => {
  // `COMMANDS` is an object literal, so a truthiness check on `COMMANDS[name]` accepts every
  // `Object.prototype` member. `tonedial toString` got past that guard and died on
  // `command.flags` with a raw stack trace instead of the refusal every other name gets.
  for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf", "nosuchthing"]) {
    err = [];
    assert.equal(await cli(name), 2, name);
    assert.match(stderr(), /is not a command/, name);
  }
  // Against a far miss rather than against a spelling: every refusal lists every command, so
  // asserting that `eject` appears passes with the suggestion removed. What only a near miss
  // can produce is an answer that differs from the one a name nothing resembles gets.
  err = [];
  assert.equal(await cli("ejct"), 2);
  const nearMiss = stderr();
  err = [];
  assert.equal(await cli("zzzzzzzzzzzz"), 2);
  // Collapsed first: the two names are different lengths, so the same sentence folds at
  // different points and would compare unequal on the wrapping alone.
  const withoutName = (text: string, name: string) => text.replace(/\s+/g, " ").replace(name, "").trim();
  assert.notEqual(withoutName(nearMiss, "ejct"), withoutName(stderr(), "zzzzzzzzzzzz"),
    "a near miss is answered differently from a name nothing resembles");
});

test("a stopping synonym points to off instead of the nearest command", async () => {
  // None of these is a command, and three are inside the spelling match's reach — `stop` is two
  // edits from `show`, `delete` three from `reset`, `quit` two from `edit`. So the table has to
  // be consulted first, or the answer sends someone trying to leave back to what they are
  // leaving. The answer names the pause, reset, disconnect, and uninstall boundaries.
  for (const word of ["disable", "stop", "quit", "uninstall", "remove", "delete"]) {
    err = [];
    assert.equal(await cli(word), 2, word);
    const said = stderr();
    assert.match(said, /tonedial off/, `${word}: the delivery switch is named`);
    assert.match(said, /tonedial on/, `${word}: the reversible path is named`);
    assert.match(said, /reset/, `${word}: the dial reset remains distinct`);
    assert.match(said, /eject/, `${word}: disconnect remains distinct`);
    assert.doesNotMatch(said, /Did you mean/, `${word}: and the spelling match never ran`);
  }
});

test("show on a root with nothing in it names the command that works there", async () => {
  // `compile` is context-gated and the gate refuses a fresh root, so the line `show` printed
  // sent a new user to a command that cannot run. The last two assertions are what make this
  // more than a wording change: the advice it gives now is the one that works, and the advice
  // it gave before is the one that does not.
  assert.equal(await cli("show"), 0, stderr());
  assert.ok(stdout().includes(EN.artifact.notSetUp));
  assert.equal(stdout().includes(EN.artifact.notWritten), false);
  assert.deepEqual(snapshot(paths().root), [], "and reading the state created none of it");
  err = [];
  assert.equal(await cli("compile"), 1, "compile really is refused here");

  // And the other direction, which is the half a one-sided assertion leaves open: a root that
  // is set up but whose artifact is gone still says compile, because there the advice works.
  err = [];
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0, stderr());
  rmSync(paths().tone);
  out = [];
  assert.equal(await cli("show"), 0, stderr());
  assert.ok(stdout().includes(EN.artifact.notWritten));
  assert.equal(stdout().includes(EN.artifact.notSetUp), false);
});

test("show directs a config-only legacy root to read-only diagnosis without changing it", async () => {
  const env = {
    ...commandEnv(),
    TONEDIAL_HOME: join(home, `state-${"long-path-segment-".repeat(8)}`),
  };
  const fixture = await createLegacyFixture({
    env,
    cwd: join(home, "project"),
    includeArtifact: false,
  });
  const before = {
    entries: readdirSync(fixture.paths.root, { recursive: true }).sort(),
    config: readFileSync(fixture.paths.config, "utf8"),
  };

  const pathLine = `  ${fixture.paths.root}`;
  for (const columns of [80, 60]) {
    out = [];
    err = [];
    assert.equal(await run(["show"], { ...env, COLUMNS: String(columns) }, join(home, "project"), false, false), 0, stderr());
    assert.match(flat(), /tonedial doctor/);
    assert.doesNotMatch(flat(), /run compile/);
    const shownLines = stdout().trimEnd().split("\n");
    assert.ok(shownLines.includes(pathLine), "the absolute state root remains one copyable line");
    assert.ok(maxCells(pathLine) > columns, "the fixture exercises the absolute-path exception");
    for (const line of shownLines.filter((line) => line !== pathLine)) {
      assert.ok(maxCells(line) <= columns - 1, `${columns} columns: ${maxCells(line)} cells: ${line}`);
    }
  }
  assert.deepEqual(readdirSync(fixture.paths.root, { recursive: true }).sort(), before.entries);
  assert.equal(readFileSync(fixture.paths.config, "utf8"), before.config);

  out = [];
  err = [];
  assert.equal(await run(["doctor", "--here", "--json"], env, join(home, "project"), false, false), 0, stderr());
  const diagnosis = JSON.parse(stdout()) as { context: { kind: string }; ok: boolean };
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.context.kind, "legacy");
  assert.equal(stderr(), "", "the successful structured diagnosis emitted no raw stack trace");
  assert.deepEqual(readdirSync(fixture.paths.root, { recursive: true }).sort(), before.entries);
  assert.equal(readFileSync(fixture.paths.config, "utf8"), before.config);
});

test("a value the reader refuses is refused at the write, leaving nothing behind", async () => {
  // The table above plants a bad config by hand and checks the *read* side. This is the write
  // side, and the pair of them is the contract: what `serializeConfig` emits, `parseConfig`
  // takes back. A quoted safeword was the value that fell between them — accepted by `set`,
  // refused by every command after it, with no way back through the CLI.
  await initializeState();
  const configBefore = readFileSync(paths().config, "utf8");
  const toneBefore = tone();

  assert.equal(await cli("set", 'safeword=he said "stop"'), 1);
  assert.match(stderr(), /cannot contain a double quote/);
  assert.equal(readFileSync(paths().config, "utf8"), configBefore, "the refused config was not written");
  assert.equal(tone(), toneBefore, "and neither was the artifact it would have compiled to");

  // The point of refusing at the write: the next command still runs.
  out = [];
  err = [];
  assert.equal(await cli("show"), 0, stderr());
});

test("an unspecified persona field means the same thing as an unset one", async () => {
  await initializeState();
  assert.equal(await cli("set", "persona.age=unspecified", "persona.gender=unspecified"), 0);
  assert.equal(config().persona.age, null, "the closed set's word for not-set normalises to null");
  out = [];
  assert.equal(await cli("show"), 0);
  assert.ok(!stdout().includes("Persona:"), "show does not report a persona the artifact omits");
  assert.ok(!tone().includes("### Persona"));
});

test("one unreadable preset file costs one row, not every command", async () => {
  await initializeState();
  assert.equal(await cli("save", "Good One"), 0);
  writeFileSync(join(paths().presets, "broken.json"), "{ not json");
  writeFileSync(join(paths().presets, "Not A Slug.json"), "{}");
  out = [];
  assert.equal(await cli("list", "--json"), 0, "list still answers");
  const parsed = JSON.parse(stdout()) as { presets: { slug: string }[]; skipped: string[] };
  assert.ok(parsed.presets.some((p) => p.slug === "good-one"));
  assert.equal(parsed.skipped.length, 2);
  assert.equal(await cli("use", "tough-love"), 0, "a bundled preset still resolves");
});

test("setting an axis to the value it already holds does not mark the state unsaved", async () => {
  await initializeState();
  assert.equal(await cli("use", "tough-love"), 0);
  out = [];
  assert.equal(await cli("set", "critique=5"), 0, "tough-love already sets critique to 5");
  assert.equal(config().unsaved, false);
  assert.match(tone(), /preset: tough-love -->/, "the generation comment does not flip to unsaved");
  assert.ok(stdout().includes(EN.axis.settingsUnchanged));
  assert.ok(stdout().includes(EN.artifact.current));
  assert.doesNotMatch(stdout(), /5 → 5/, "an unchanged axis is not reported as movement");
});

test("a note change of the same length is still reported as saved", async () => {
  await initializeState();
  assert.equal(await cli("set", "persona.note=alpha"), 0);
  out = [];
  assert.equal(await cli("set", "persona.note=omega"), 0);
  assert.equal(config().persona.note, "omega");
  assert.ok(stdout().includes(EN.axis.settingsSaved));
  assert.ok(stdout().includes(EN.artifact.generated));
  assert.doesNotMatch(stdout(), new RegExp(EN.axis.settingsUnchanged));
});

test("save reports a replacement instead of overwriting in silence", async () => {
  await initializeState();
  assert.equal(await cli("set", "critique=5"), 0);
  assert.equal(await cli("save", "Same Name"), 0);
  out = []; err = [];
  assert.equal(await cli("save", "Same  Name!"), 0, "both slugify to same-name");
  assert.ok(stdout().includes(EN.preset.replaced("same-name")));
  assert.equal(stderr(), "");
});

test("use --json carries the disclosure the human lines make", async () => {
  await initializeState();
  assert.equal(await cli("set", "safeword=연기 그만"), 0);
  out = [];
  assert.equal(await cli("use", "tough-love", "--json"), 0);
  const parsed = JSON.parse(stdout()) as {
    riskAxes: string[];
    safeword: string;
    notice: { safeword: string; riskAxes: string | null; risk: string };
  };
  assert.deepEqual(parsed.riskAxes, ["critique"]);
  assert.equal(parsed.safeword, "연기 그만");
  assert.match(parsed.notice.risk, /not recommended for production/);
  assert.match(parsed.notice.riskAxes!, /critique.*harsh language/);
  assert.match(parsed.notice.safeword, /연기 그만/);
});

test("the keyed use notice preserves its shape with and without risky axes", async () => {
  await initializeState();
  assert.equal(await cli("use", "caring-brother", "--json"), 0);
  const on = JSON.parse(stdout()) as { notice: Record<string, unknown> };
  assert.deepEqual(Object.keys(on.notice), ["safeword", "riskAxes", "risk", "roleplay"]);
  assert.equal(on.notice.riskAxes, null, "absent as a null, not as a missing position");

  out = [];
  assert.equal(await cli("use", "tough-love", "--json"), 0);
  const off = JSON.parse(stdout()) as { notice: Record<string, unknown> };
  assert.equal(typeof off.notice.riskAxes, "string");
  assert.deepEqual(Object.keys(off.notice), Object.keys(on.notice), "the same keys either way");
});

test("independent persona, address and register choices stay quiet in every interface language", async () => {
  await initializeState();
  for (const language of LANGUAGES) {
    for (const [formality, age] of [[5, "teens"], [1, "50s+"]] as const) {
      out = []; err = [];
      assert.equal(await cli("set", `language=${language}`, `formality=${formality}`, "warmth=1", "verbosity=1",
        "speech_level=plain", `persona.age=${age}`, "persona.self_ref=형", "persona.user_ref=선생님", "--json"), 0);
      assert.deepEqual(JSON.parse(stdout()).warnings, [], `${language}: valid settings were marked as a problem`);
      out = []; err = [];
      assert.equal(await cli("show", "--json"), 0);
      const shown = JSON.parse(stdout());
      assert.deepEqual(shown.combinations, []);
      assert.deepEqual(shown.warnings, []);
      assert.equal(shown.axes.formality, formality);
      assert.equal(shown.persona.age, age);
      assert.deepEqual(shown.persona.address, { self_ref: "형", user_ref: "선생님" });
      assert.equal(shown.speech_level, "plain");
    }
  }
});

test("show previewing a preset reports that preset's own size", async () => {
  await initializeState();
  assert.equal(await cli("use", "caring-brother"), 0);
  out = [];
  assert.equal(await cli("show", "terse-operator", "--json"), 0);
  const preview = JSON.parse(stdout()) as { chars: number };
  assert.equal(await cli("use", "terse-operator"), 0);
  out = [];
  assert.equal(await cli("show", "--json"), 0);
  const real = JSON.parse(stdout()) as { chars: number };
  assert.equal(preview.chars, real.chars, "the preview used the active preset's slug");
});

test("large tone artifacts report only their current character count without size warnings", async () => {
  await initializeState();
  const config = parseConfig(readFileSync(paths().config, "utf8"));
  config.persona.note = "😀".repeat(4000);
  writeFileSync(paths().config, serializeConfig(config));
  out = [];
  assert.equal(await cli("compile", "--json"), 0);
  const compiled = JSON.parse(stdout());
  const artifact = readFileSync(paths().tone, "utf8");
  assert.ok(artifact.includes(config.persona.note), "compilation truncated the persona note");
  assert.equal(compiled.chars, [...artifact].length);
  assert.ok(compiled.chars > 4000);
  for (const args of [["compile", "--check"], ["show"]]) {
    out = [];
    assert.equal(await cli(...args, "--json"), 0);
    const result = JSON.parse(stdout());
    assert.equal(result.chars, compiled.chars);
    for (const field of ["target", "cap", "overTarget", "overCap"]) {
      assert.equal(Object.hasOwn(result, field), false, `${args[0]}: retired ${field} field`);
    }
    assert.ok(!result.warnings.some((warning: string) => warning.includes("TONE.md")), "size emitted an artifact warning");
  }
  out = [];
  err = [];
  assert.equal(await cli("show"), 0);
  assert.match(stdout(), /TONE\.md [\d,]+ characters/);
  assert.doesNotMatch(stderr(), /TONE\.md/);
});

test("a config carrying an impossible value is refused with the field named", async () => {
  mkdirSync(dirname(paths().config), { recursive: true });
  const broken = { ...defaultConfig(), axes: { ...AXIS_DEFAULT, critique: 9 } };
  writeFileSync(paths().config, JSON.stringify(broken));
  assert.equal(await cli("show"), 1);
  assert.ok(stderr().includes(EN.axis.range("axes.critique", "9")));
});

test("a config from a future schema says so rather than guessing", async () => {
  mkdirSync(dirname(paths().config), { recursive: true });
  writeFileSync(paths().config, JSON.stringify({ schema: 99 }));
  assert.equal(await cli("show"), 1);
  assert.ok(collapsed(stderr()).includes(collapsed(EN.config.futureSchema(99, 2))));
});

test("a missing axis in a stored config takes its default rather than failing", async () => {
  mkdirSync(dirname(paths().config), { recursive: true });
  const partial = { schema: 1, axes: { critique: 5 } };
  writeFileSync(paths().config, JSON.stringify(partial));
  assert.equal(await cli("show"), 0);
  assert.equal(config().axes.warmth, AXIS_DEFAULT.warmth);
});

test("serializing a config is stable, so a diff shows a real change", async () => {
  const a = serializeConfig(defaultConfig());
  assert.equal(a, serializeConfig(parseConfig(a)));
  assert.equal(Object.keys(JSON.parse(a).axes).join(","), AXIS_ORDER.join(","));
  assert.ok(a.endsWith("\n"));
});

test("every bundled preset is sparse, which is the rule rather than one snapshot of it", async () => {
  // 5±2 is 3 to 7, and the reason is compliance rather than taste: fewer extremes mean fewer
  // internal collisions. The exact tuple used to be written out here, which made a preset change
  // fail with a number and not a name — and said nothing a reader could check against the rule.
  // Nothing is lost by dropping it: every artifact is pinned byte for byte by the fixtures.
  for (const preset of BUNDLED) {
    const count = nonDefaultAxes(applyPreset(preset), AXIS_DEFAULT).length;
    assert.ok(count >= 3 && count <= 7, `${preset.slug} sets ${count} non-default axes; 5±2 is 3 to 7`);
  }
});

test("subagent axes are refused rather than silently ignored", async () => {
  await initializeState();
  assert.equal(await cli("set", "subagent.critique=4"), 1);
  assert.ok(stderr().includes(EN.axis.subagentUnsupported));
});

// --- edit and update -------------------------------------------------------------------
//
// `edit` hands a file to a real subprocess, so these drive a real one: a shell script standing
// in for the editor. It touches a marker before writing, which is what lets a test prove the
// editor was *not* run — an assertion no amount of checking the file's contents can make.

/** `cli` with extra environment. `edit` reads `$EDITOR`, and the fixed env cannot carry it. */
const cliWith = (env: Record<string, string>, ...args: string[]) =>
  run(args, { ...commandEnv(), ...env }, join(home, "project"), false, false);

/** A stand-in editor: marks that it ran, then writes `replacement` over the file it was given. */
function fakeEditor(replacement: string | null): Record<string, string> {
  const script = join(home, "editor.sh");
  const marker = join(home, "editor-ran");
  const openedPath = join(home, "editor-path");
  writeFileSync(
    script,
    replacement === null
      ? `#!/bin/sh\ntouch "${marker}"\nprintf '%s\\n' "$1" > "${openedPath}"\nrm -f "$1"\n`
      : `#!/bin/sh\ntouch "${marker}"\nprintf '%s\\n' "$1" > "${openedPath}"\ncat "${join(home, "replacement")}" > "$1"\n`,
  );
  if (replacement !== null) writeFileSync(join(home, "replacement"), replacement);
  return { EDITOR: `sh ${script}` };
}
const editorRan = () => existsSync(join(home, "editor-ran"));

test("edit reserves JSON stdout without changing the human editor handoff", async () => {
  await initializeState();
  const beforeConfig = readFileSync(paths().config, "utf8");
  const beforeTone = tone();
  const script = join(home, "noisy-editor.sh");
  writeFileSync(script, "#!/bin/sh\nprintf 'editor display output\\n'\n", { mode: 0o700 });
  // Child stdio bypasses run()'s in-process capture, so exercise the CLI boundary itself.
  const result = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bin.ts"), "edit", "--json"], {
    cwd: join(home, "project"),
    env: { ...commandEnv(), EDITOR: script },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.opened, true);
  assert.equal(payload.changed, false);
  assert.match(result.stderr, /editor display output/);
  const human = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bin.ts"), "edit"], {
    cwd: join(home, "project"),
    env: { ...commandEnv(), EDITOR: script },
    encoding: "utf8",
  });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /editor display output/);
  assert.doesNotMatch(human.stderr, /editor display output/);
  assert.equal(readFileSync(paths().config, "utf8"), beforeConfig);
  assert.equal(tone(), beforeTone);
});

test("an edit to the settings reaches tone.md without a second command", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  const config = JSON.parse(readFileSync(paths().config, "utf8")) as Record<string, unknown>;
  // A value no bundled preset holds, so finding it in the artifact cannot come from anywhere else.
  config.axes = { ...(config.axes as object), verbosity: 5 };
  out = [];
  assert.equal(await cliWith(fakeEditor(JSON.stringify(config, null, 2)), "edit"), 0);
  assert.ok(editorRan(), "the editor never ran");

  const tone = readFileSync(paths().tone, "utf8");
  const expected = compile(toCompileInput(parseConfig(readFileSync(paths().config, "utf8"), EN)));
  assert.equal(tone, expected, "tone.md was not recompiled from what the editor saved");
  // Falsifiability: prove the artifact actually moved, or the equality above would hold on a
  // command that did nothing at all.
  assert.notEqual(tone, compile(toCompileInput(defaultConfig())), "tone.md is still the default");
});

test("editing a clean active profile synchronizes axes, role and artifact in one operation", async () => {
  await initializeState();
  assert.equal(await cli("set", "warmth=4", "persona.age=40s", "safeword=plain reply", "speech_level=polite"), 0);
  assert.equal(await cli("save", "Mine"), 0);
  const presetPath = join(customPresetDir(paths().presets), "mine.json");
  const edited = JSON.parse(readFileSync(presetPath, "utf8"));
  edited.values = { warmth: 5 };
  edited.settings.persona.agent = "Edited profile role";
  const beforeConfig = config();
  const beforeTone = tone();
  const beforeOperations = new Set(inspectOperations(paths()).journals.map((entry) => entry.operationId));
  out = [];
  err = [];
  assert.equal(await cliWith(fakeEditor(JSON.stringify(edited)), "edit", "preset", "mine", "--json"), 0, stderr());
  const payload = JSON.parse(stdout());
  const saved = config();
  assert.deepEqual(saved.axes, { ...AXIS_DEFAULT, warmth: 5 });
  assert.equal(saved.preset, "mine");
  assert.equal(saved.unsaved, false);
  assert.deepEqual(saved.persona, { ...beforeConfig.persona, agent: "Edited profile role" });
  assert.equal(saved.safeword, beforeConfig.safeword);
  assert.equal(saved.speech_level, beforeConfig.speech_level);
  assert.equal(Object.hasOwn(saved, "guards"), false);
  assert.deepEqual(JSON.parse(readFileSync(presetPath, "utf8")).values, { warmth: 5 });
  assert.notEqual(tone(), beforeTone);
  assert.equal(tone(), compile(toCompileInput(saved)));
  assert.equal(payload.applied, true);
  assert.equal(payload.unsaved, false);
  const operations = inspectOperations(paths()).journals.filter((entry) => !beforeOperations.has(entry.operationId));
  assert.equal(operations.length, 1, "preset, config and artifact split across operations");
  assert.equal(operations[0]!.state, "complete");
  assert.deepEqual(operations[0]!.journal!.actions.map((action) => action.path), [presetPath, paths().tone, paths().config]);
});

test("editing an inactive user preset preserves live config and artifact bytes", async () => {
  await initializeState();
  assert.equal(await cli("save", "Mine"), 0);
  assert.equal(await cli("use", "tough-love"), 0);
  const presetPath = join(customPresetDir(paths().presets), "mine.json");
  const edited = { ...JSON.parse(readFileSync(presetPath, "utf8")), values: { warmth: 2 } };
  const beforeConfig = readFileSync(paths().config, "utf8");
  const beforeTone = tone();
  out = [];
  assert.equal(await cliWith(fakeEditor(JSON.stringify(edited)), "edit", "preset", "mine", "--json"), 0);
  assert.equal(JSON.parse(stdout()).applied, false);
  assert.deepEqual(JSON.parse(readFileSync(presetPath, "utf8")).values, { warmth: 2 });
  assert.equal(readFileSync(paths().config, "utf8"), beforeConfig);
  assert.equal(tone(), beforeTone);
});

test("editing an active preset preserves custom axes and recomputes divergence", async () => {
  await initializeState();
  assert.equal(await cli("set", "warmth=4"), 0);
  assert.equal(await cli("save", "Mine"), 0);
  assert.equal(await cli("set", "warmth=2"), 0);
  const presetPath = join(customPresetDir(paths().presets), "mine.json");
  const edited = { ...JSON.parse(readFileSync(presetPath, "utf8")), values: { warmth: 5 } };
  const liveAxes = config().axes;
  const beforeTone = tone();
  out = [];
  assert.equal(await cliWith(fakeEditor(JSON.stringify(edited)), "edit", "preset", "mine"), 0);
  assert.deepEqual(config().axes, liveAxes);
  assert.equal(config().unsaved, true);
  assert.equal(tone(), beforeTone);
  const receipt = stdout();

  edited.values = { warmth: 2 };
  out = [];
  assert.equal(await cliWith(fakeEditor(JSON.stringify(edited)), "edit", "preset", "mine", "--json"), 0);
  const payload = JSON.parse(stdout());
  assert.deepEqual(config().axes, liveAxes);
  assert.equal(config().unsaved, false, "the matching saved preset still appears divergent");
  assert.equal(payload.applied, false, "preserved live axes were reported as newly applied");
  assert.equal(payload.unsaved, false);
  assert.ok(collapsed(receipt).includes(collapsed(EN.preset.editAxesKept(true))));
  assert.match(tone(), /^<!-- generated by tonedial · preset: mine -->/);
  assert.equal(tone(), compile(toCompileInput(config())));
});

test("an active preset edit checks baseline axes rather than trusting a stale clean flag", async () => {
  await initializeState();
  assert.equal(await cli("set", "warmth=4"), 0);
  assert.equal(await cli("save", "Mine"), 0);
  const replacement = { schema: 1, slug: "mine", displayName: "Mine", values: { warmth: 1 } };
  const file = join(home, "replacement.json");
  writeFileSync(file, JSON.stringify(replacement));
  assert.equal(await cli("import", file), 0);
  assert.equal(config().unsaved, false, "the import scenario did not leave stale preset metadata");
  const liveAxes = config().axes;
  replacement.values = { warmth: 5 };
  out = [];
  assert.equal(await cliWith(fakeEditor(JSON.stringify(replacement)), "edit", "preset", "mine", "--json"), 0);
  assert.deepEqual(config().axes, liveAxes);
  assert.equal(config().unsaved, true);
  assert.equal(JSON.parse(stdout()).applied, false);
  assert.match(tone(), /^<!-- generated by tonedial · preset: unsaved -->/);
  assert.equal(tone(), compile(toCompileInput(config())));
});

test("an ordinary invalid setting is left in live config only with unchanged proven ownership", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  const broken = '{ "schema": 1, "axes": { "warmth": 9 } }';
  out = [];
  err = [];
  assert.equal(await cliWith(fakeEditor(broken), "edit"), 1);
  assert.ok(stderr().includes(EN.axis.range("axes.warmth", "9")));
  // Valid JSON independently proves both ownership graphs empty despite the invalid axis.
  assert.equal(readFileSync(paths().config, "utf8"), broken, "the broken edit was reverted");
});

test("a bundled preset is refused before the editor is given the file", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  err = [];
  assert.equal(await cliWith(fakeEditor("{}"), "edit", "preset", "heavenly-demon"), 1);
  // The point of the refusal: an edit here is written back over by the next init, so the file
  // must never have been opened. Contents alone cannot show that; the marker can.
  assert.ok(!editorRan(), "the editor was run on a bundled preset");
  assert.match(err.join("").replace(/\n\s*/g, " "), /bundled/);
});

test("edit --dry-run opens nothing", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  out = [];
  assert.equal(await cliWith(fakeEditor("{}"), "edit", "--dry-run"), 0);
  assert.ok(!editorRan(), "--dry-run ran the editor");
  assert.match(stdout(), /would open/);
});

test("an edit that deletes the file says so rather than writing a default back", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  err = [];
  assert.equal(await cliWith(fakeEditor(null), "edit"), 1);
  assert.ok(stderr().includes(EN.errors.editDeleted(paths().config)));
  // A tool that silently re-created it would hide that the user's settings were lost.
  assert.ok(!existsSync(paths().config), "config.json was re-created behind the user");
});

test("edit names the file when there is no editor to hand it to", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  err = [];
  assert.equal(await cli("edit"), 1);
  assert.match(stderr().replace(/\n\s*/g, " "), /\$EDITOR/);
  // Naming the path is the whole value of the message — it is what a user does instead.
  assert.match(stderr().replace(/\n\s*/g, ""), new RegExp(paths().config.replace(/[/\\]/g, "[/\\\\]")));
});

test("update prints a command that can actually be run, for every install shape", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  // npm only. A curl install no longer prints a line to paste — it does the update, and that
  // path is driven against a stub registry in `install.test.ts` because it needs one. npx does
  // not reach a command at all: the entry point refuses it, which the gate test below covers.
  for (const [shape, pattern] of [["npm", /npm update -g tonedial/]] as const) {
    out = [];
    assert.equal(await cliWith({ TONEDIAL_INSTALL_SHAPE: shape }, "update"), 0, shape);
    assert.match(stdout(), pattern, shape);
    assert.match(stdout(), new RegExp(shape), `${shape} was not named`);
  }
});

test("npx refuses every command, and answers --help and --version anyway", async () => {
  // npx leaves no lasting copy for a bare `tonedial` to point at, so the skill, the `/tone`
  // command, and `tone.md`'s fallback line are all wired and dead under it. One gate before
  // dispatch rather than a branch per command: a half-working npx is the state the decision
  // removes, and it would need a fresh answer every time a command is added.
  const npx = { TONEDIAL_INSTALL_SHAPE: "npx" };
  const before = readdirSync(home).sort();
  // `doctor` is in this list on purpose. Someone with a real curl install who types
  // `npx tonedial doctor` gets the refusal rather than a diagnosis, because the shape they are
  // running under is not the shape of their install.
  for (const command of ["init", "set", "show", "list", "use", "doctor", "wire", "eject", "update", "compile"]) {
    err = [];
    assert.equal(await cliWith(npx, command), 2, command);
    assert.match(stderr(), /npx/, command);
    // Both channels, so the refusal is actionable rather than only a refusal.
    assert.match(stderr(), /npm i -g tonedial/, command);
    assert.match(stderr(), /install\.sh/, command);
  }
  assert.deepEqual(readdirSync(home).sort(), before, "and nothing was written on the way out");

  // `--json` still parses. The skill drives this tool through `--json`, so a refusal it cannot
  // read is a refusal it cannot act on.
  out = [];
  assert.equal(await cliWith(npx, "show", "--json"), 2);
  const parsed = JSON.parse(stdout()) as { ok: boolean; error: string };
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /npx/);

  // Neither of these makes a claim about an install, so neither is refused.
  for (const flag of ["--help", "--version"]) {
    out = [];
    assert.equal(await cliWith(npx, flag), 0, flag);
    assert.ok(stdout().length > 0, flag);
  }
});

test("update distinguishes locally modified seeds from a routine package refresh", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  out = [];
  assert.equal(await cli("update"), 0);
  assert.doesNotMatch(stdout(), /tonedial init/, "a fresh home was told to re-init");

  // An npm update replaces the package and never touches ~/.tonedial/, so the anchors on disk
  // can be a version behind with nothing saying so. This is the case that gap produces.
  writeFileSync(join(builtinPresetDir(paths().presets), "heavenly-demon.json"), '{"schema":1,"slug":"tough-love","displayName":"x","values":{}}\n');
  out = [];
  assert.equal(await cli("update"), 0);
  assert.doesNotMatch(stdout(), /tonedial init/, "a local edit must not be presented as a routine refresh");
  const payload = JSON.parse(
    (out = [], await cli("update", "--json"), stdout()),
  ) as { staleSeeds: string[] | null; seedIssues: { reason: string }[]; checkedRemote: boolean };
  assert.deepEqual(payload.staleSeeds, ["presets/builtin/heavenly-demon.json"]);
  assert.deepEqual(payload.seedIssues.map((issue) => issue.reason), ["modified"]);
  // Named for what it is. This command has no network and must not read as "you are current".
  assert.equal(payload.checkedRemote, false);
});

// Five defects a skeptical review found in `edit`. Each is here because it shipped once.

test("a slug that escapes the presets directory never reaches the editor", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  // Placed where the escape actually lands. Pointed anywhere the file does not exist, the
  // "unknown preset" check refuses first and the test passes without the guard it is for.
  const escape = "../outside-preset";
  const outside = join(paths().presets, `${escape}.json`);
  writeFileSync(outside, '{"unrelated":true}');
  assert.ok(!outside.startsWith(paths().presets + "/"), "the escape did not leave the presets directory");
  err = [];
  // The slug check used to run on the way *back* — by which point the editor had already saved
  // over whatever was there.
  assert.equal(await cliWith(fakeEditor("{}"), "edit", "preset", escape), 1);
  assert.ok(!editorRan(), "the editor was handed a path outside the presets directory");
  assert.equal(readFileSync(outside, "utf8"), '{"unrelated":true}', "the file outside was written");
});

test("an edit that drops the wiring record preserves live bytes and the edited copy", async () => {
  await initializeState();
  // This edit guard needs a real ownership record, not an enabled native provider. Establish
  // one shell resource through the same journaled gate instead of bypassing native setup.
  const before = config();
  const rc = join(home, ".bashrc");
  const shell = planChange(rc, () => "# ToneDial shell fixture\n", EN);
  const wiring = recordFileChange({ registrations: {}, resources: {} }, {
    target: "shell", scope: "global", destination: canonicalDestination(home),
  }, shell, "shell", { version: 1, regionId: "tonedial", handlerSha256: contentHash(shell.after!) }, EN);
  before.wiring = wiring;
  await gate([shell], {
    paths: paths(), finalChanges: [planChange(paths().config, () => serializeConfig(before), EN)],
    t: EN, auto: true, dryRun: false, out: () => {}, ui: palette("never", {}, false),
  });
  assert.equal(Object.keys(wiring.registrations).length, 1);
  assert.equal(Object.keys(wiring.resources).length, 1);

  const original = readFileSync(paths().config, "utf8");
  const originalTone = tone();
  const replacement = '{"schema":1}';
  err = [];
  // `parseConfig` defaults every field, so `{"schema":1}` parses clean and takes `wiring` with
  // it. `eject` then deletes nothing and leaves the user's agent files behind.
  assert.equal(await cliWith(fakeEditor(replacement), "edit"), 1);
  assert.match(err.join("").replace(/\n\s*/g, " "), /eject/);
  assert.equal(readFileSync(rc, "utf8"), shell.after);
  assert.equal(readFileSync(paths().config, "utf8"), original);
  assert.equal(tone(), originalTone);
  const retained = readFileSync(join(home, "editor-path"), "utf8").trim();
  assert.equal(readFileSync(retained, "utf8"), replacement);
  assert.equal(lstatSync(retained).mode & 0o777, 0o600);
  assert.ok(stderr().includes(retained), "the refusal did not identify the recoverable edited copy");
});

const ownershipEdits = [
  ["emptied graph", (edited: ReturnType<typeof defaultConfig>) => { edited.wiring = { registrations: {}, resources: {} }; }],
  ["partial resource removal", (edited: ReturnType<typeof defaultConfig>) => {
    const id = Object.keys(edited.wiring.resources!)[0]!;
    delete edited.wiring.resources![id];
    for (const registration of Object.values(edited.wiring.registrations!)) registration.resourceIds = registration.resourceIds.filter((resource) => resource !== id);
  }],
  ["changed ownership metadata", (edited: ReturnType<typeof defaultConfig>) => {
    const resource = Object.values(edited.wiring.resources!)[0]!;
    resource.created = !resource.created;
  }],
  ["forged resource", (edited: ReturnType<typeof defaultConfig>) => {
    edited.wiring = recordFileChange({ registrations: edited.wiring.registrations!, resources: edited.wiring.resources! }, {
      target: "shell", scope: "global", destination: canonicalDestination(home),
    }, planChange(join(home, "forged-shell"), () => "Dummy forged ownership.\n", EN), "shell", { version: 1, regionId: "tonedial" }, EN);
  }],
  ["invalid setting plus ownership loss", (edited: ReturnType<typeof defaultConfig>) => {
    edited.wiring = { registrations: {}, resources: {} };
    Object.assign(edited.axes, { warmth: 9 });
  }],
  ["malformed graph", (edited: ReturnType<typeof defaultConfig>) => { Object.assign(edited.wiring, { resources: [] }); }],
] as const;

for (const [label, modify] of ownershipEdits) {
  test(`config edit refuses ${label} while preserving native cleanup ownership`, async () => {
    await initializeState();
    const hook = join(home, "project", ".claude", "settings.json");
    const foreign = { matcher: "startup", hooks: [{ type: "command", command: "dummy-user-handler" }] };
    const nativeOriginal = { custom: { keep: true }, hooks: { SessionStart: [foreign] } };
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, JSON.stringify(nativeOriginal));
    assert.equal(await cli("init", "--here", "--tools", "claude", "--auto"), 0, stderr());
    const original = readFileSync(paths().config, "utf8");
    const originalTone = tone();
    const nativeBefore = readFileSync(hook, "utf8");
    const edited = config();
    assert.ok(Object.keys(edited.wiring.resources!).length > 1, "fixture needs several managed resources");
    modify(edited);
    const replacement = JSON.stringify(edited);
    out = [];
    err = [];
    assert.equal(await cliWith(fakeEditor(replacement), "edit", "--json"), 1, label);
    const payload = JSON.parse(stdout());
    assert.equal(payload.schema, 3);
    assert.equal(payload.ok, false);
    assert.equal(readFileSync(paths().config, "utf8"), original, label);
    assert.equal(tone(), originalTone, label);
    assert.equal(readFileSync(hook, "utf8"), nativeBefore, label);
    const retained = readFileSync(join(home, "editor-path"), "utf8").trim();
    assert.equal(readFileSync(retained, "utf8"), replacement);
    assert.equal(lstatSync(retained).mode & 0o777, 0o600);
    assert.ok(payload.error.includes(retained), "the refusal omitted the retained edited copy");
    out = [];
    err = [];
    assert.equal(await cli("eject", "--here", "--auto"), 0, stderr());
    assert.deepEqual(JSON.parse(readFileSync(hook, "utf8")), nativeOriginal, "later scoped eject lost a foreign native handler");
  });
}

test("syntactically invalid config edits stay private even with an empty ownership baseline", async () => {
  await initializeState();
  const original = readFileSync(paths().config, "utf8");
  const originalTone = tone();
  const replacement = '{"schema":2,"wiring":{"registrations":{},"resources":{}},';
  out = [];
  assert.equal(await cliWith(fakeEditor(replacement), "edit", "--json"), 1);
  assert.equal(readFileSync(paths().config, "utf8"), original);
  assert.equal(tone(), originalTone);
  const retained = readFileSync(join(home, "editor-path"), "utf8").trim();
  assert.equal(readFileSync(retained, "utf8"), replacement);
  assert.ok(JSON.parse(stdout()).error.includes(retained));
});

test("forged ownership cannot enter unwired config through invalid ordinary settings", async () => {
  await initializeState();
  const original = readFileSync(paths().config, "utf8");
  const originalTone = tone();
  const edited = config();
  ownershipEdits.find(([label]) => label === "forged resource")![1](edited);
  Object.assign(edited.axes, { warmth: 9 });
  const replacement = JSON.stringify(edited);
  out = [];
  assert.equal(await cliWith(fakeEditor(replacement), "edit", "--json"), 1);
  assert.equal(readFileSync(paths().config, "utf8"), original);
  assert.equal(tone(), originalTone);
  assert.equal(readFileSync(readFileSync(join(home, "editor-path"), "utf8").trim(), "utf8"), replacement);
});

test("deleting the editor copy cannot delete managed config or claim a retained copy", async () => {
  await initializeState();
  assert.equal(await cli("init", "--here", "--tools", "claude", "--auto"), 0, stderr());
  const original = readFileSync(paths().config, "utf8");
  const originalTone = tone();
  const hook = join(home, "project", ".claude", "settings.json");
  const nativeBefore = readFileSync(hook, "utf8");
  out = [];
  assert.equal(await cliWith(fakeEditor(null), "edit", "--json"), 1);
  const payload = JSON.parse(stdout());
  assert.equal(payload.ok, false);
  assert.equal(readFileSync(paths().config, "utf8"), original);
  assert.equal(tone(), originalTone);
  assert.equal(readFileSync(hook, "utf8"), nativeBefore);
  const removed = readFileSync(join(home, "editor-path"), "utf8").trim();
  assert.equal(existsSync(dirname(removed)), false, "deleted editor copy left an empty staging directory");
  assert.ok(!payload.error.includes(removed), "the refusal claimed the deleted edited copy was recoverable");
  assert.doesNotMatch(payload.error, /Edited copy preserved/);
});

test("config edit compares normalized ownership while ordinary settings still recompile", async () => {
  await initializeState();
  assert.equal(await cli("init", "--here", "--tools", "claude", "--auto"), 0, stderr());
  const edited = config();
  const originalWiring = edited.wiring;
  edited.wiring = {
    resources: Object.fromEntries(Object.entries(edited.wiring.resources!).reverse()),
    registrations: Object.fromEntries(Object.entries(edited.wiring.registrations!).reverse().map(([id, registration]) => [id, {
      ...registration, resourceIds: [...registration.resourceIds].reverse(),
    }])),
  };
  edited.axes.warmth = 1;
  out = [];
  assert.equal(await cliWith(fakeEditor(JSON.stringify(edited)), "edit", "--json"), 0, stderr());
  assert.deepEqual(config().wiring, originalWiring);
  assert.equal(config().axes.warmth, 1);
  assert.equal(tone(), compile(toCompileInput(config())));
});

test("ordinary invalid settings keep raw edit behavior with unchanged managed ownership", async () => {
  await initializeState();
  assert.equal(await cli("init", "--here", "--tools", "claude", "--auto"), 0, stderr());
  const originalTone = tone();
  const hook = join(home, "project", ".claude", "settings.json");
  const nativeBefore = readFileSync(hook, "utf8");
  const edited = config();
  Object.assign(edited.axes, { warmth: 9 });
  const replacement = JSON.stringify(edited);
  out = [];
  assert.equal(await cliWith(fakeEditor(replacement), "edit", "--json"), 1);
  const payload = JSON.parse(stdout());
  assert.equal(payload.ok, false);
  assert.equal(payload.error, EN.axis.range("axes.warmth", "9"));
  assert.equal(readFileSync(paths().config, "utf8"), replacement);
  assert.equal(tone(), originalTone);
  assert.equal(readFileSync(hook, "utf8"), nativeBefore);
  assert.equal(existsSync(dirname(readFileSync(join(home, "editor-path"), "utf8").trim())), false);
});

test("an empty agent-home override is an actionable CLI failure without state or native writes", async () => {
  const before = readdirSync(home, { recursive: true }).sort();
  out = [];
  err = [];
  assert.equal(await cliWith({ TONEDIAL_AGENT_HOME: " \t " }, "init", "--global", "--tools", "claude", "--auto", "--json"), 1);
  const payload = JSON.parse(stdout());
  assert.equal(payload.schema, 3);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /TONEDIAL_AGENT_HOME is set but empty/);
  assert.match(payload.error, /Name a directory or unset it/);
  assert.equal(stderr(), "");
  assert.deepEqual(readdirSync(home, { recursive: true }).sort(), before);
  out = [];
  assert.equal(await cliWith({ TONEDIAL_AGENT_HOME: "" }, "init", "--global", "--tools", "claude", "--auto"), 1);
  assert.match(stderr().replace(/\s+/g, " "), /Name a directory or unset it/);
  assert.deepEqual(readdirSync(home, { recursive: true }).sort(), before);
});

test("a preset file that is valid JSON but not an object is refused inside the json envelope", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  assert.equal(await cli("save", "Mine"), 0);
  const beforeConfig = readFileSync(paths().config, "utf8");
  const beforeTone = tone();
  for (const body of ["null", "123", "[]", "true"]) {
    out = [];
    err = [];
    assert.equal(await cliWith(fakeEditor(body), "edit", "preset", "mine", "--json"), 1, body);
    // A TypeError is not a ConfigError, so this used to leave stdout empty and print a stack
    // trace — the one failure mode `--json` exists to prevent.
    const payload = JSON.parse(stdout()) as { ok: boolean; error: string };
    assert.equal(payload.ok, false, body);
    assert.match(payload.error, /not a preset object/, body);
    assert.equal(readFileSync(join(customPresetDir(paths().presets), "mine.json"), "utf8"), body);
    assert.equal(readFileSync(paths().config, "utf8"), beforeConfig);
    assert.equal(tone(), beforeTone);
  }
  const repaired = { schema: 1, slug: "mine", displayName: "Mine", values: { warmth: 2 } };
  out = [];
  assert.equal(await cliWith(fakeEditor(JSON.stringify(repaired)), "edit", "preset", "mine", "--json"), 0);
  assert.deepEqual(config().axes, parseConfig(beforeConfig).axes, "repair of an invalid baseline replaced live axes");
  assert.equal(config().unsaved, true);
  assert.equal(JSON.parse(stdout()).applied, false);
  assert.equal(tone(), compile(toCompileInput(config())));
});

test("an edit that lands the state a warning covers still raises the warning", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  const config = JSON.parse(readFileSync(paths().config, "utf8")) as Record<string, unknown>;
  config.axes = { ...(config.axes as object), refusal: 5, compliance: 5 };
  out = [];
  err = [];
  assert.equal(await cliWith(fakeEditor(JSON.stringify(config, null, 2)), "edit", "--json"), 0);
  const payload = JSON.parse(stdout()) as { warnings: string[] };
  // `set` and `use` both emit this for the same values. `edit` is the route with no validation
  // on the way in, so staying silent made it the quietest way into a forbidden combination.
  assert.ok(
    payload.warnings.some((w) => /refusal/.test(w)),
    `no combination warning: ${JSON.stringify(payload.warnings)}`,
  );
});

for (const field of ["user", "agent"] as const) {
  test(`editing valid persona.${field} preserves private text without a generic warning`, async () => {
    await initializeState();
    const edited = config();
    const value = `Dummy private ${field} description`;
    edited.persona[field] = value;
    out = [];
    err = [];
    assert.equal(await cliWith(fakeEditor(JSON.stringify(edited)), "edit", "--json"), 0, stderr());
    const receipt = stdout();
    const payload = JSON.parse(receipt) as { warnings: string[] };
    assert.deepEqual(payload.warnings, []);
    assert.equal(receipt.includes(value), false);
    assert.equal(config().persona[field], value);
    assert.ok(tone().includes(value));
  });
}

test("a whitespace-only VISUAL does not mask a usable EDITOR", () => {
  // `(VISUAL || EDITOR || "").trim()` — the trim ran after the fallback, so "  " won the `||`
  // and then collapsed to nothing, reporting no editor while one was set.
  assert.deepEqual(editorCommand({ VISUAL: "   ", EDITOR: "nano" }), ["nano"]);
  assert.deepEqual(editorCommand({ VISUAL: "vim -f", EDITOR: "nano" }), ["vim", "-f"]);
  assert.equal(editorCommand({ VISUAL: "  ", EDITOR: "  " }), null);
});

test("editing a preset's slug is refused rather than silently dropped", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  assert.equal(await cli("save", "Mine"), 0);
  const original = readFileSync(join(customPresetDir(paths().presets), "mine.json"), "utf8");
  const renamed = { ...(JSON.parse(original) as object), slug: "renamed", displayName: "Renamed" };

  err = [];
  // `parsePreset` returns the slug it was handed and ignores the file's own, so this used to
  // come back as a save where `displayName` took and `slug` did not — a partial write reported
  // as a success.
  assert.equal(await cliWith(fakeEditor(JSON.stringify(renamed, null, 2)), "edit", "preset", "mine"), 1);
  assert.ok(collapsed(stderr()).includes(collapsed(EN.preset.slugNotEditable("mine", "renamed"))));
  assert.ok(!existsSync(join(customPresetDir(paths().presets), "renamed.json")), "a second preset appeared");
  // The file keeps what the editor saved — this command's standing contract, and what makes the
  // fix one more edit rather than lost work. What must not happen is the *write back*, which is
  // where `displayName` would have taken while `slug` was dropped.
  assert.match(readFileSync(join(customPresetDir(paths().presets), "mine.json"), "utf8"), /"slug": "renamed"/);
  assert.notEqual(readFileSync(join(customPresetDir(paths().presets), "mine.json"), "utf8"), original);
});
