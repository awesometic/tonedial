// The wiring layer: where it is allowed to write, and whether it can put a file back the way
// it found it.
//
// **Nothing here writes to a real agent home, and that is a permanent property of this suite
// rather than a convenience.** Synthetic homes and explicit project scopes keep destinations
// temporary, and `TONEDIAL_AGENT_HOME` redirects the shared fixture's agent resources.
//
// The `--global` branch *is* executed, at the end of this file, against a `$HOME` made of a
// temporary directory. It was covered by a string comparison alone for four milestones, and a
// review found that the one path nothing could drive was the one that was broken — so the seam
// exists for that reason rather than for convenience.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { catalogue } from "../src/core/i18n.ts";

const EN = catalogue("en").cli;
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, symlinkSync, chmodSync, statSync, readdirSync, readlinkSync, realpathSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { run } from "../src/cli.ts";
import { parseConfig, serializeConfig } from "../src/core/config.ts";
import { seedFiles, seedRecord, SEED_VERSION } from "../src/core/seeds.ts";
import { TONE_COMMAND_MD } from "../src/core/skill.ts";
import { GUIDE_FORMAT_MARKER, READER_SOURCE } from "../src/core/reader.ts";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AGENT_TOOLS, canonicalDestination, installShape, LEGACY_CONTEXT_ARTIFACT_FILENAME, resolveAgentPaths, resolvePaths, type Paths } from "../src/core/paths.ts";
import { pathLine, pathLineState, rcPath, withPathLine } from "../src/wiring/shell.ts";
import { recordFileChange } from "../src/wiring/ownership.ts";
import { MARKDOWN, RegionError, find, remove, upsert } from "../src/wiring/region.ts";
import { gate, planChange } from "../src/wiring/apply.ts";
import { palette } from "../src/ui/style.ts";
import { hasHook, ownedHook, withoutHook, withHook, type HookEventSpec, type HookSpec } from "../src/wiring/hooks.ts";
import { createLegacyFixture, type LegacyRoute, type LegacySkillRoute } from "./support/legacy-fixture.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

let scratch = "";
let gatePaths: Paths;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-wiring-"));
  gatePaths = resolvePaths({ TONEDIAL_HOME: join(scratch, "gate-state") });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ── the roots ────────────────────────────────────────────────────────────────────────────

test("explicit project resolution targets cwd independently of the CLI's global default", () => {
  // It used to land in `output/` under the working directory, which protected nothing a user
  // would name: `~/.tonedial/` was created in the home anyway, so half the install went there
  // while the wiring went somewhere no agent reads.
  const paths = resolveAgentPaths({ global: false, project: null }, {}, "/work");
  assert.equal(paths.root, "/work");
  assert.equal(paths.live, false, "and it is not the global scope");
  assert.equal(paths.wiredFile("claude"), join("/work", ".claude", "CLAUDE.md"));
});

test("--global resolves to the real agent home", () => {
  // Compares strings and opens nothing: `homedir()` reads an environment variable, and a
  // resolved path is not an access. The branch's behaviour is exercised at the end of this file
  // against a temporary directory standing in for `$HOME`.
  const paths = resolveAgentPaths({ global: true, project: null }, {}, "/work");
  assert.equal(paths.root, homedir());
  assert.equal(paths.live, true);
  assert.equal(paths.wiredFile("claude"), join(homedir(), ".claude", "CLAUDE.md"));
  assert.equal(paths.hookFile("antigravity"), join(homedir(), ".gemini", "config", "hooks.json"));
  // Not an instruction file. `.codex/AGENTS.md` is read only in the home, so a project install
  // wrote a path Codex never looked at; the artifact arrives through a SessionStart hook now.
  assert.equal(paths.wiredFile("codex"), join(homedir(), ".codex", "hooks.json"));
});

test("TONEDIAL_AGENT_HOME wins over --global, not the other way round", () => {
  // The safe direction. One stray flag in a test must not reach the developer's own files,
  // whereas an override that loses to the flag would do exactly that.
  const paths = resolveAgentPaths({ global: true, project: null }, { TONEDIAL_AGENT_HOME: scratch }, "/work");
  assert.equal(paths.root, scratch);
  assert.equal(paths.live, false, "an overridden root is not a live home whatever the flag says");
  assert.notEqual(paths.root, homedir());
});

// ── the region ───────────────────────────────────────────────────────────────────────────

const SAMPLES = [
  "",
  "\n",
  "abc",
  "abc\n",
  "abc\n\n",
  "# Notes\n\nsome text\n",
  "no trailing newline and a # heading",
  "a file that mentions <!-- tonedial --> without the real markers\n",
  "line1\nline2\nline3",
  "  leading space\n\ttab\n",
  "한글이 들어간 파일\n",
];

test("inserting a region and removing it returns the original bytes", () => {
  // The property `eject` rests on. A promise about someone else's file is worth exactly what
  // can be demonstrated, so this runs over the shapes that broke earlier drafts: a file with no
  // trailing newline, an empty one, and one that merely looks like it holds a marker.
  for (const original of SAMPLES) {
    for (const content of ["@~/.tonedial/tone.md", "a\nmulti\nline\nblock", ""]) {
      const wired = upsert(original, content);
      assert.equal(remove(wired), original, `${JSON.stringify(original)} + ${JSON.stringify(content)}`);
    }
  }
});

test("wiring twice changes nothing the second time", () => {
  for (const original of SAMPLES) {
    const once = upsert(original, "@~/.tonedial/tone.md");
    assert.equal(upsert(once, "@~/.tonedial/tone.md"), once, JSON.stringify(original));
  }
});

test("updating the content leaves everything around the region untouched", () => {
  const original = "# My rules\n\nkeep this\n";
  const wired = upsert(original, "old");
  const updated = upsert(wired, "new");
  assert.match(updated, /keep this/);
  assert.equal(find(updated)!.content, "new");
  assert.equal(remove(updated), original, "and it is still reversible after an update");
});

test("removing from a file that was never wired is a no-op", () => {
  for (const original of SAMPLES) assert.equal(remove(original), original);
});

test("a damaged region is reported rather than guessed at", () => {
  // Guessing which bytes are ours is how a tool deletes a line of someone else's configuration.
  const cases: [string, string][] = [
    [`${MARKDOWN.begin}\nno end\n`, "unclosed"],
    [`nothing opened it\n${MARKDOWN.end}\n`, "unopened"],
    [`${MARKDOWN.begin}\na\n${MARKDOWN.end}\n${MARKDOWN.begin}\nb\n${MARKDOWN.end}\n`, "duplicated"],
  ];
  for (const [text, damage] of cases) {
    assert.throws(() => find(text), (e: unknown) => e instanceof RegionError && e.damage === damage, damage);
  }
});

test("a file carrying half a marker is refused, and that is a real limit", () => {
  // A global CLAUDE.md that documents this tool would hold the marker text without meaning it
  // as a marker, and nothing distinguishes the two. Refusing is the safe reading — `wire` would
  // otherwise append a second region and `eject` would have to guess which bytes are ours — but
  // it does mean such a file cannot be wired until the stray marker is removed. `doctor` names
  // it; it is not silently worked around.
  const documented = "See the docs:\n\n```\n" + MARKDOWN.begin + "\n```\n";
  assert.throws(() => upsert(documented, "x"), RegionError);
  assert.throws(() => remove(documented), RegionError);
});

test("the region round-trips its own content", () => {
  for (const content of ["one line", "two\nlines", "", "  indented  ", "한 줄"]) {
    assert.equal(find(upsert("host\n", content))!.content, content, JSON.stringify(content));
  }
});

test("the sandbox mirrors a real home exactly, so an agent can be pointed at it", () => {
  // A flatter, more browsable sandbox layout was the obvious first move and it is wrong: an
  // agent looks for `$HOME/.claude/CLAUDE.md`, so renaming the directory in the preview makes
  // the preview unusable for the one measurement this product has never run — its own route.
  const live = resolveAgentPaths({ global: true, project: null }, {}, "/work");
  const preview = resolveAgentPaths({ global: false, project: null }, {}, "/work");
  for (const tool of AGENT_TOOLS) {
    const previewRelative = relative(preview.root, preview.wiredFile(tool));
    const liveRelative = relative(live.root, live.wiredFile(tool));
    if (tool === "antigravity") {
      assert.equal(previewRelative, join(".agents", "hooks.json"));
      assert.equal(liveRelative, join(".gemini", "config", "hooks.json"));
    } else {
      assert.equal(previewRelative, liveRelative, `${tool} sits at the same place under either root`);
    }
  }
});

// ── the commands ─────────────────────────────────────────────────────────────────────────

let home = "";
let work = "";
let out: string[] = [];
let err: string[] = [];
let restore: (() => void)[] = [];

function captureStreams() {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => (out.push(s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => (err.push(s), true)) as typeof process.stderr.write;
  restore = [() => { process.stdout.write = o; }, () => { process.stderr.write = e; }];
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tonedial-home-"));
  work = mkdtempSync(join(tmpdir(), "tonedial-work-"));
  out = [];
  err = [];
  captureStreams();
});

afterEach(() => {
  for (const r of restore) r();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

// Never `--global` without also overriding the root. The override wins, so even a mistake
// here lands in a temporary directory — which is the reason the precedence goes that way.
//
// **`--auto` by default, because the gate now stands in front of every destination.** Removing
// the `output/` sandbox removed its exemption, so a non-interactive run that does not answer the
// question is refused rather than written — which is the contract, not an obstacle. These tests
// are about what wiring writes; the gate's own obligations keep dedicated tests below (the
// no-terminal refusal, the diff-before-question ordering, `--dry-run`, and the `--json` diff),
// and each of those drives `gate` directly or asserts the refusal rather than passing this flag.
const GATED = new Set(["init", "wire", "unwire", "doctor", "eject"]);
const answering = (args: string[]) =>
  GATED.has(args[0] ?? "") && !args.includes("--auto") ? [...args, "--auto"] : args;
/**
 * The environment every run in this file gets, and the one place `HOME` is set.
 *
 * **`HOME` is not optional here, and leaving it out once wrote a PATH line into the developer's
 * real `~/.bash_profile`.** The shell rc is resolved from the user's home rather than from the
 * destination — it is the one file that is the *person's* and not the destination's — so an env
 * with no `HOME` falls back to `homedir()` and the rc write leaves this suite entirely. The
 * header above claims nothing here touches a real home; this function is what makes that true
 * for the rc, the way `TONEDIAL_AGENT_HOME` makes it true for everything else.
 */
const envFor = (extra: Record<string, string> = {}) => ({
  TONEDIAL_HOME: home,
  TONEDIAL_AGENT_HOME: join(work, "output"),
  HOME: join(work, "home"),
  ...extra,
});
const cli = (...args: string[]) => run(answering(args), envFor(), work, false, false);
const stdout = () => out.join("");
/** The same CLI, told it arrived through the curl channel — the branch the module path cannot
 *  reach from a checkout, and therefore the one nothing could drive until this existed. */
const curlEnv = () => envFor({ TONEDIAL_INSTALL_SHAPE: "curl", SHELL: "/bin/bash" });
const curlCli = (...args: string[]) => run(answering(args), curlEnv(), work, false, false);
const collapsed = (text: string) => text.replace(/\s+/g, " ").trim();

test("disconnect receipts report removal and no-op separately while retaining shared state", async () => {
  assert.equal(await cli("init", "--here", "--tools", "claude", "--auto", "--json"), 0, err.join(""));
  const configured = JSON.parse(stdout()) as { integrations: { tool: string; path: string }[] };
  const hook = configured.integrations.find(entry => entry.tool === "claude")!.path;
  assert.equal(existsSync(hook), true);
  out = [];
  assert.equal(await cli("unwire", "claude", "--here"), 0, err.join(""));
  assert.match(collapsed(stdout()), /Claude Code connections disconnected/);
  assert.equal(existsSync(hook), false);
  const retained = readFileSync(join(home, "config.json"));
  out = [];
  assert.equal(await cli("unwire", "claude", "--here"), 0, err.join(""));
  assert.match(collapsed(stdout()), /Claude Code: already disconnected/);
  assert.deepEqual(readFileSync(join(home, "config.json")), retained);
  assert.equal(existsSync(join(home, "TONE.md")), true);
  assert.equal(existsSync(join(home, "presets")), true);
});
const pathCheckOf = (payload: string) =>
  (JSON.parse(payload) as { checks: { name: string; state: string; repair: string | null }[] }).checks
    .find((c) => c.name === "PATH line")!;
const stderr = () => err.join("");
const agentFile = (tool: string) =>
  tool === "codex"
    ? join(work, "output", ".codex", "hooks.json")
    : tool === "claude"
      ? join(work, "output", ".claude", "CLAUDE.md")
      : join(work, "output", ".agents", "hooks.json");
const LEGACY_TOOLS = ["claude", "codex"] as const;
const legacyFixture = (routes: readonly LegacyRoute[] = [], skills: readonly LegacySkillRoute[] = []) =>
  createLegacyFixture({ env: envFor(), cwd: work, routes, skills });

/** A journaled historical shell resource, kept separate from B's unavailable native init. */
async function legacyShellFixture(shell = "/bin/bash") {
  const root = join(work, "output");
  const { paths, config } = await legacyFixture(
    LEGACY_TOOLS.map((tool) => ({ tool, root })), [{ tools: LEGACY_TOOLS, root }],
  );
  const env = { ...curlEnv(), SHELL: shell };
  const agent = resolveAgentPaths({ global: false, project: null }, env, work);
  const path = rcPath(agent, env);
  const change = planChange(path, (before) => withPathLine(before, paths.bin, shell), EN);
  config.wiring = recordFileChange(config.wiring, {
    target: "shell", scope: "global", destination: canonicalDestination(dirname(path)),
  }, change, "shell", { version: 1, regionId: "tonedial" }, EN);
  const result = await gate([change], {
    paths, finalChanges: [planChange(paths.config, () => serializeConfig(config), EN, undefined, paths.root)],
    auto: true, dryRun: false, t: EN, ui: palette("never", {}, false), out: () => {},
  });
  assert.equal(result.applied, true);
  return path;
}

test("native wire refuses an unknown target before claiming a destination or scope", async () => {
  // A refused selection stops after state-only setup and before any host path or scope is reported.
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  out = [];
  err = [];
  assert.equal(await cli("wire", "--here", "--tools", "other-agent"), 1);
  assert.match(stderr(), /unsupported tool/);
  for (const tool of AGENT_TOOLS) assert.equal(existsSync(agentFile(tool)), false, tool);
});

test("legacy wiring twice leaves every host file byte-identical", async () => {
  const routes = LEGACY_TOOLS.map((tool) => ({ tool, root: join(work, "output") }));
  await legacyFixture(routes);
  const first = LEGACY_TOOLS.map((t) => readFileSync(agentFile(t), "utf8"));
  out = [];
  await legacyFixture(routes);
  assert.deepEqual(LEGACY_TOOLS.map((t) => readFileSync(agentFile(t), "utf8")), first);
});

test("legacy unwire and eject leave a pre-existing file byte-identical", async () => {
  const original = "# my own rules\n\nkeep this line\n";
  mkdirSync(join(work, "output", ".claude"), { recursive: true });
  writeFileSync(agentFile("claude"), original);

  const routes = [{ tool: "claude" as const, root: join(work, "output") }];
  await legacyFixture(routes);
  assert.notEqual(readFileSync(agentFile("claude"), "utf8"), original, "it did something");
  assert.equal(await cli("unwire", "--here", "claude"), 0);
  assert.equal(readFileSync(agentFile("claude"), "utf8"), original, "and it put it back exactly");

  await legacyFixture(routes);
  assert.equal(await cli("eject", "--here"), 0);
  assert.equal(readFileSync(agentFile("claude"), "utf8"), original);
});

test("a legacy file this tool created is removed entirely, and one it did not is left empty", async () => {
  // Provenance is recorded at wire time, because afterwards it cannot be recovered: "we made
  // this" and "the user had an empty one" look identical on disk, and inferring ownership from
  // emptiness deleted a user's own file.
  mkdirSync(join(work, "output", ".claude"), { recursive: true });
  writeFileSync(agentFile("claude"), "");

  await legacyFixture(LEGACY_TOOLS.map((tool) => ({ tool, root: join(work, "output") })));
  assert.equal(await cli("eject", "--here"), 0);

  assert.equal(existsSync(agentFile("codex")), false, "codex was ours, so it is gone");
  assert.equal(existsSync(agentFile("claude")), true, "claude was the user's, so it stays");
  assert.equal(readFileSync(agentFile("claude"), "utf8"), "", "exactly as it was found");
});

test("legacy wiring writes through a symlink instead of replacing it", async () => {
  // A global CLAUDE.md is commonly a link into a dotfiles repository. `rename(2)` over a
  // symlink replaces the link, so an "atomic" write to the link path silently breaks it and
  // leaves the repository copy diverging — with nothing recorded to restore the link from.
  const real = join(work, "dotfiles", "CLAUDE.md");
  mkdirSync(join(work, "dotfiles"), { recursive: true });
  writeFileSync(real, "# from my dotfiles\n");
  mkdirSync(join(work, "output", ".claude"), { recursive: true });
  symlinkSync(real, agentFile("claude"));

  await legacyFixture([{ tool: "claude", root: join(work, "output") }]);

  assert.equal(lstatSync(agentFile("claude")).isSymbolicLink(), true, "the link survived");
  assert.match(readFileSync(real, "utf8"), /tonedial:begin/, "and the dotfiles copy is what changed");

  assert.equal(await cli("unwire", "--here", "claude"), 0);
  assert.equal(lstatSync(agentFile("claude")).isSymbolicLink(), true);
  assert.equal(readFileSync(real, "utf8"), "# from my dotfiles\n", "restored byte for byte");
});

test("--dry-run shows the diff and writes nothing", async () => {
  // Native setup no longer writes this delivery shape. Exercise the generic diff contract directly:
  // an existing host file shows its changed lines, while the gate still applies no bytes.
  const target = agentFile("claude");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "# mine\n");
  const change = planChange(
    target,
    () => "# mine\n\n<!-- tonedial:begin -->\n@/state/tone.md\n<!-- tonedial:end -->\n",
    EN,
  );
  const result = await gate([change], {
    paths: gatePaths,
    dryRun: true,
    auto: true,
    t: EN,
    ui: palette("never", {}, false),
  });
  const preview = result.lines.join("\n");
  assert.match(preview, /\+ <!-- tonedial:begin -->/, "a modification shows its added lines");
  assert.equal(result.reason, "dry-run");
  assert.equal(readFileSync(target, "utf8"), "# mine\n", "dry-run leaves the host untouched");
});

test("compact approval previews bound key lines while verbose shows the complete change", async () => {
  const target = join(scratch, "bounded-preview.txt");
  const before = "one\ntwo\nthree\nfour\nfive\nsix\n";
  const after = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n";
  writeFileSync(target, before);
  const change = planChange(target, () => after, EN);
  const second = join(scratch, "second-preview.txt");
  const changes = [change, planChange(second, () => "new content\n", EN)];
  const compact = await gate(changes, {
    paths: gatePaths,
    dryRun: true, auto: true, t: EN, ui: palette("never", {}, false),
  });
  const compactPreview = compact.lines.join("\n");
  assert.match(compactPreview, /\+6.*-6/);
  assert.match(compactPreview, /- one/, "compact output carries a representative removed line");
  assert.match(compactPreview, /\+ alpha/, "compact output carries a representative added line");
  assert.match(compactPreview, new RegExp(EN.wiring.previewMore));
  assert.doesNotMatch(compactPreview, /zeta/, "compact output is bounded");
  assert.ok(compactPreview.includes(EN.wiring.changeCount(2)), "the approval scope has no change count");
  assert.ok(compactPreview.includes(`\n\n  ${second}\n`), "separate files run together");

  const verbose = await gate(changes, {
    paths: gatePaths,
    dryRun: true, auto: true, verbose: true, t: EN, ui: palette("never", {}, false),
  });
  assert.match(verbose.lines.join("\n"), /\+ zeta/, "verbose output carries every changed line");
  assert.deepEqual(verbose.diff, compact.diff, "human verbosity does not alter the structured diff");
  assert.equal(readFileSync(target, "utf8"), before, "both dry runs leave the file unchanged");
});

test("approval previews identify final-newline-only changes without altering structured diffs", async () => {
  const cases = [
    { label: "addition", before: "sample", after: "sample\n", notice: EN.wiring.finalNewlineAdded },
    { label: "removal", before: "sample\n", after: "sample", notice: EN.wiring.finalNewlineRemoved },
  ];

  for (const { label, before, after, notice } of cases) {
    const target = join(scratch, `final-newline-${label}.txt`);
    const original = Buffer.from(before);
    writeFileSync(target, original);
    const change = planChange(target, () => after, EN);
    const compact = await gate([change], {
      paths: gatePaths,
      dryRun: true, auto: true, t: EN, ui: palette("never", {}, false),
    });
    const verbose = await gate([change], {
      paths: gatePaths,
      dryRun: true, auto: true, verbose: true, t: EN, ui: palette("never", {}, false),
    });

    assert.ok(compact.lines.some((line) => line.includes(notice)), `${label} is visible in compact output`);
    assert.ok(verbose.lines.some((line) => line.includes(notice)), `${label} is visible in verbose output`);
    assert.equal(compact.lines.some((line) => line.includes(EN.wiring.modeChanged)), false);
    assert.deepEqual(verbose.diff, compact.diff, "human verbosity does not alter the structured diff");
    assert.deepEqual(readFileSync(target), original, `${label} dry-runs preserve the original bytes`);
  }
});

test("legacy eject --dry-run removes nothing, including the skill it does not diff", async () => {
  await legacyFixture(
    LEGACY_TOOLS.map((tool) => ({ tool, root: join(work, "output") })),
    [{ tools: LEGACY_TOOLS, root: join(work, "output") }],
  );
  const link = join(work, "output", ".claude", "skills", "tonedial");
  assert.ok(existsSync(link));
  out = [];
  assert.equal(await cli("eject", "--here", "--dry-run"), 0);
  assert.ok(stdout().includes(EN.wiring.dryRun));
  assert.ok(existsSync(link), "the skill action stayed unapplied during dry-run");
  for (const tool of LEGACY_TOOLS) assert.ok(existsSync(agentFile(tool)), tool);
});

test("legacy eject keeps the state root, and says where it is", async () => {
  await legacyFixture(LEGACY_TOOLS.map((tool) => ({ tool, root: join(work, "output") })));
  out = [];
  assert.equal(await cli("eject", "--here"), 0);
  assert.ok(existsSync(join(home, "config.json")), "presets and settings survive");
  assert.ok(existsSync(join(home, "tone.md")));
  assert.match(stdout(), /Presets and settings kept\./);
  assert.ok(stdout().split("\n").includes(`  ${home}`), "the retained root stays complete and copyable");
});

test("doctor names what it checked, what it could not, and where it looked", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none"), 0);
  assert.equal(await cli("use", "tough-love"), 0);
  out = [];
  assert.equal(await cli("doctor", "--here", "--json"), 0);
  const parsed = JSON.parse(stdout()) as {
    healthy: boolean;
    root: string;
    checks: { name: string; state: string }[];
  };
  // **Not healthy, and that is the fix.** There is no `tonedial` on this run's PATH, and doctor
  // used to report healthy anyway because it only looked under a curl install — while the skill,
  // the `/tone` command, and tone.md's fallback line all call a bare `tonedial`.
  assert.equal(parsed.healthy, false);
  const onPathCheck = parsed.checks.find((c) => c.name === "tonedial on PATH")!;
  assert.equal(onPathCheck.state, "problem", "an unreachable command is a problem, not a note");
  assert.equal(parsed.root, join(work, "output"), "the root it inspected is in the report");
  // Diagnostics must execute their checks rather than report deferred placeholders.
  assert.deepEqual(parsed.checks.filter((c) => c.state === "deferred"), []);
  const names = parsed.checks.map((c) => c.name);
  for (const live of ["seeds", "PATH line", "install"]) {
    assert.ok(names.includes(live), `${live} is not reported at all: ${names.join(", ")}`);
  }
  assert.ok(names.length >= 9, `only ${names.length} checks ran`);

  // And healthy once a shell would find it. Written into a directory this test owns and put on
  // PATH, so what is asserted is the lookup rather than a branch on the install shape.
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tonedial"), "#!/bin/sh\n");
  chmodSync(join(bin, "tonedial"), 0o755);
  out = [];
  assert.equal(
    await run(
      ["doctor", "--here", "--json", "--auto"],
      { TONEDIAL_HOME: home, TONEDIAL_AGENT_HOME: join(work, "output"), PATH: bin },
      work,
      false,
      false,
    ),
    0,
  );
  const withCommand = JSON.parse(stdout()) as { healthy: boolean; checks: { name: string; state: string }[] };
  assert.equal(withCommand.checks.find((c) => c.name === "tonedial on PATH")!.state, "ok");
  assert.equal(withCommand.healthy, true, "and nothing else was wrong");

  out = [];
  assert.equal(await run(
    ["doctor", "--here"],
    { TONEDIAL_HOME: home, TONEDIAL_AGENT_HOME: join(work, "output"), PATH: bin },
    work, false, false,
  ), 0);
  assert.match(stdout(), /Application: healthy/);
  assert.match(stdout(), /Connection files: no issues in selected scope/);
  assert.doesNotMatch(stdout(), /App activation is unverified/);
  assert.doesNotMatch(stdout(), new RegExp(EN.doctor.contextCurrent), "healthy check detail is verbose");
  out = [];
  assert.equal(await run(
    ["doctor", "--here", "--verbose"],
    { TONEDIAL_HOME: home, TONEDIAL_AGENT_HOME: join(work, "output"), PATH: bin },
    work, false, false,
  ), 0);
  assert.match(stdout(), new RegExp(EN.doctor.contextCurrent));
});

test("init says the command is missing only when a shell would not find it", async () => {
  // Reported from the first real use as "the skill cannot find the CLI". init could see it and
  // said nothing -- it printed the global-install hint unconditionally instead, which recommended
  // a second copy to someone who already had one and stayed silent about the case it exists for.
  const at = (path: string) =>
    run(
      ["init", "--here", "--lang", "en", "--tools", "none", "--auto"],
      { TONEDIAL_HOME: home, TONEDIAL_AGENT_HOME: join(work, "output"), PATH: path },
      work,
      false,
      false,
    );
  out = [];
  assert.equal(await at(join(work, "empty")), 0);
  assert.ok(
    collapsed(stdout()).includes(collapsed(catalogue("en").init.installHint)),
    "it says how to make a bare tonedial resolve",
  );

  const bin = join(work, "bin2");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tonedial"), "#!/bin/sh\n");
  chmodSync(join(bin, "tonedial"), 0o755);
  out = [];
  assert.equal(await at(bin), 0);
  assert.doesNotMatch(stdout(), /npm i -g tonedial/, "and stays quiet when it already resolves");
});

test("doctor diagnoses legacy delivery without offering an unavailable native repair", async () => {
  await legacyFixture(LEGACY_TOOLS.map((tool) => ({ tool, root: join(work, "output") })));

  const claude = readFileSync(agentFile("claude"), "utf8");
  writeFileSync(agentFile("claude"), claude.replace("@", "@EDITED-"));
  rmSync(agentFile("codex"));
  const before = readFileSync(join(home, "tone.md"));
  const retained = [join(home, "config.json"), agentFile("claude")]
    .map((path) => ({ path, bytes: readFileSync(path) }));

  out = [];
  assert.equal(await cli("doctor", "--here", "--json"), 0);
  const byName = Object.fromEntries(
    (JSON.parse(stdout()) as { checks: { name: string; state: string; detail: string; repair: string | null }[] }).checks.map(
      (c) => [c.name, c],
    ),
  );
  assert.equal(byName.context!.state, "problem");
  assert.equal(byName.context!.detail, EN.recovery.keptSettings);
  assert.match(byName.context!.repair!, /tonedial doctor --fix/);
  for (const name of ["Claude Code", "Codex CLI"]) assert.equal(byName[name]!.repair, null);
  assert.deepEqual(readFileSync(join(home, "tone.md")), before);
  assert.equal(existsSync(agentFile("codex")), false);
  for (const { path, bytes } of retained) assert.deepEqual(readFileSync(path), bytes, path);
});

test("doctor --fix preserves damaged legacy delivery for explicit resolution", async () => {
  await legacyFixture(LEGACY_TOOLS.map((tool) => ({ tool, root: join(work, "output") })));
  writeFileSync(agentFile("claude"), readFileSync(agentFile("claude"), "utf8").replace("@", "@EDITED-"));
  // A marker without its partner: which bytes are ours becomes unknowable, and guessing wrong
  // deletes a line of someone else's configuration.
  writeFileSync(agentFile("claude"), readFileSync(agentFile("claude"), "utf8").replace(MARKDOWN.end, ""));

  const before = LEGACY_TOOLS.map((tool) => readFileSync(agentFile(tool)));
  const beforeConfig = readFileSync(join(home, "config.json"));
  const beforeTone = readFileSync(join(home, "tone.md"));
  out = [];
  assert.equal(await cli("doctor", "--here", "--fix", "--dry-run", "--json"), 0);
  assert.deepEqual(readFileSync(join(home, "config.json")), beforeConfig);
  assert.deepEqual(LEGACY_TOOLS.map((tool) => readFileSync(agentFile(tool))), before);
  err = [];
  out = [];
  assert.equal(await cli("doctor", "--here", "--fix", "--json"), 0);
  const repaired = JSON.parse(stdout());
  assert.equal(repaired.appHealthy, true);
  assert.equal(repaired.native.applied, false);
  assert.equal(repaired.nativeAttention, true);
  assert.deepEqual(LEGACY_TOOLS.map((tool) => readFileSync(agentFile(tool))), before);
  const saved = parseConfig(readFileSync(join(home, "config.json"), "utf8"));
  const prior = parseConfig(beforeConfig.toString("utf8"));
  for (const field of ["axes", "preset", "unsaved", "persona", "safeword", "speech_level", "language"] as const) {
    assert.deepEqual(saved[field], prior[field], field);
  }
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(home, "config.json"), "utf8")), "fixed_width"), false);
  assert.deepEqual(readFileSync(join(home, "tone.md")), beforeTone);
  out = [];
  assert.equal(await cli("doctor", "--here", "--json"), 0);
  const byName = Object.fromEntries(
    (JSON.parse(stdout()) as { checks: { name: string; state: string; detail: string }[] }).checks.map(
      (c) => [c.name, c],
    ),
  );
  assert.equal(byName.context!.state, "ok");
  assert.equal(byName["Claude Code"]!.state, "problem");
  const diagnosis = JSON.parse(stdout());
  assert.equal(diagnosis.context.inspectionFailure, null);
  assert.equal(diagnosis.nativeAttention, true);
  assert.equal(diagnosis.checks.find((check: { name: string }) => check.name === "Claude Code").repair, null);
  assert.deepEqual(LEGACY_TOOLS.map((tool) => readFileSync(agentFile(tool))), before);
  for (const field of ["axes", "preset", "unsaved", "persona", "safeword", "speech_level", "language"] as const) {
    assert.deepEqual(parseConfig(readFileSync(join(home, "config.json"), "utf8"))[field], prior[field], field);
  }
  assert.deepEqual(readFileSync(join(home, "tone.md")), beforeTone);
});

test("eject refuses all legacy targets before touching a damaged sibling, while selected unwire can proceed", async () => {
  await legacyFixture(LEGACY_TOOLS.map((tool) => ({ tool, root: join(work, "output") })));
  const before = {
    codex: readFileSync(agentFile("codex")),
    claude: readFileSync(agentFile("claude")),
    config: readFileSync(join(home, "config.json")),
  };
  writeFileSync(agentFile("claude"), before.claude.toString().replace(MARKDOWN.end, ""));

  err = [];
  assert.equal(await cli("eject", "--here"), 1, "all-target eject refuses before applying a partial plan");
  assert.deepEqual(readFileSync(agentFile("codex")), before.codex, "codex was not changed");
  assert.equal(
    readFileSync(agentFile("claude"), "utf8"),
    before.claude.toString().replace(MARKDOWN.end, ""),
    "the damaged file was not changed",
  );
  assert.deepEqual(readFileSync(join(home, "config.json")), before.config, "provenance was not changed");
  assert.match(stderr(), /tonedial:end/, "the missing closing marker is named");
  assert.match(stderr(), /CLAUDE\.md/, "and the file it is about");

  for (const lang of ["en", "ko"] as const) {
    const localizedConfig = JSON.stringify({ ...JSON.parse(before.config.toString()), language: lang });
    writeFileSync(join(home, "config.json"), localizedConfig);
    out = [];
    assert.equal(await cli("eject", "--here", "--json", "--color", "never"), 1);
    const failure = JSON.parse(stdout()) as { ok: boolean; error: string };
    assert.equal(failure.ok, false);
    assert.ok(failure.error.includes(agentFile("claude")), "the full repair path remains copyable");
    assert.doesNotMatch(failure.error, /\u001b\[/, "JSON diagnostics contain no terminal styling");
    assert.equal(
      failure.error,
      catalogue(lang).cli.doctor.damagedRegion(agentFile("claude"), `${MARKDOWN.begin} has no ${MARKDOWN.end}`),
    );
    assert.equal(readFileSync(join(home, "config.json"), "utf8"), localizedConfig);
  }
  writeFileSync(join(home, "config.json"), before.config);

  assert.equal(await cli("unwire", "--here", "codex"), 0);
  assert.equal(await cli("unwire", "--here", "claude"), 1, "a selected damaged file is still protected");
  assert.equal(existsSync(agentFile("codex")), false, "selected codex wiring came out");
  assert.ok(existsSync(agentFile("claude")), "the damaged Claude file remains");
  assert.equal(readFileSync(agentFile("claude"), "utf8"), before.claude.toString().replace(MARKDOWN.end, ""));
  const after = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    wiring: { registrations: Record<string, { target: string }>; };
  };
  const registrations = Object.values(after.wiring.registrations);
  assert.equal(registrations.some((registration) => registration.target === "codex"), false);
  assert.equal(registrations.some((registration) => registration.target === "claude"), true);
});

test("wire refuses a tool it does not have, by listing the ones it does", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  err = [];
  assert.equal(await cli("wire", "--here", "emacs"), 1);
  for (const tool of AGENT_TOOLS) assert.match(stderr(), new RegExp(tool), tool);
});

test("wire refuses before there is an artifact to wire", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  rmSync(resolvePaths(envFor()).tone);
  err = [];
  assert.equal(await cli("wire", "--here", "--tools", "codex"), 1);
  assert.match(stderr(), /tonedial compile/, "and says what to run first");
});

// ── init ─────────────────────────────────────────────────────────────────────────────────

test("native init refuses an unknown target before creating a wired state", async () => {
  err = [];
  assert.equal(await cli("init", "--here", "--lang", "en", "--tools", "other-agent", "--auto"), 1);
  assert.match(stderr(), /unsupported tool/);
  assert.equal(existsSync(join(home, "config.json")), false);
  assert.equal(existsSync(join(home, "AGENTS.md")), false);
  assert.equal(existsSync(join(home, "TONE.md")), false);
  assert.equal(existsSync(join(home, "skill")), false);
  for (const tool of AGENT_TOOLS) assert.equal(existsSync(agentFile(tool)), false, tool);
});

test("init with an unsupported --lang writes nothing at all", async () => {
  // A system locale is a guess and falls back quietly; `--lang` is a person stating an intent,
  // so an unsupported value stops before anything is created.
  err = [];
  assert.equal(await cli("init", "--here", "--lang", "xx", "--tools", "codex,claude,antigravity", "--auto"), 1);
  assert.match(stderr(), /en, ko/, "and it names the ones that work");
  assert.equal(existsSync(join(home, "config.json")), false);
  assert.equal(existsSync(join(home, "TONE.md")), false);
});

test("fresh init previews or refuses without creating state or agent roots", async () => {
  const state = join(home, "fresh");
  const env = envFor({ TONEDIAL_HOME: state, TONEDIAL_INSTALL_SHAPE: "curl", SHELL: "/bin/bash" });
  for (const args of [
    ["init", "--here", "--lang", "en", "--tools", "other-agent", "--auto", "--commands", "--dry-run", "--json"],
    ["init", "--here", "--lang", "en", "--tools", "other-agent", "--commands"],
  ]) {
    out = [];
    err = [];
    const code = await run(args, env, work, false, false);
    assert.equal(code, 1);
    assert.match(stdout() + stderr(), /unsupported tool/);
    assert.equal(existsSync(state), false, "an unapproved init created tone state");
    assert.equal(existsSync(join(work, "output")), false, "an unapproved init created agent resources");
    assert.equal(existsSync(join(work, "home")), false, "an unapproved init created shell configuration");
    assert.doesNotMatch(stdout(), /Set up/, "a preview or refusal is not completed setup");
  }
});

test("init keeps its default dry-run receipt compact and expands it with --verbose", async () => {
  const state = join(home, "concise-init");
  const env = envFor({ TONEDIAL_HOME: state });
  const args = ["init", "--here", "--lang", "en", "--tools", "none", "--auto", "--dry-run"];

  assert.equal(await run(args, env, work, false, false), 0);
  const compact = stdout();
  assert.match(compact, new RegExp(EN.wiring.dryRun));
  assert.equal(compact.split(EN.wiring.previewMore).length - 1, 1, "one full-diff hint covers the plan");
  assert.ok(compact.includes(catalogue("en").init.autoChose("caring-brother", null)), "the selected preset remains visible");
  assert.doesNotMatch(compact, new RegExp(catalogue("en").init.welcome));
  assert.equal(existsSync(state), false, "the compact dry-run wrote no state");

  out = [];
  assert.equal(await run([...args, "--verbose"], env, work, false, false), 0);
  assert.match(stdout(), new RegExp(catalogue("en").init.welcome));
  assert.equal(existsSync(state), false, "the verbose dry-run wrote no state");
});

test("native init refuses before inspecting host configuration or changing state", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  const paths = resolvePaths(envFor());
  const config = readFileSync(join(home, "config.json"));
  const tone = readFileSync(paths.tone);
  const skillPresent = existsSync(join(home, "skill"));
  const presetsPresent = existsSync(join(home, "presets"));
  err = [];
  // English despite `--lang ko`: the selection is parsed before the interface language is
  // chosen, so a refusal raised there speaks the saved or system language. Pre-existing, and
  // recorded rather than changed here.
  assert.equal(await cli("init", "--here", "--lang", "ko", "--tools", "other-agent", "--auto"), 1);
  assert.match(stderr(), /unsupported tool/);
  assert.deepEqual(readFileSync(join(home, "config.json")), config);
  assert.deepEqual(readFileSync(paths.tone), tone);
  assert.equal(existsSync(join(home, "skill")), skillPresent);
  assert.equal(existsSync(join(home, "presets")), presetsPresent);
});

test("state-only init is the update path, so running it twice is safe", async () => {
  assert.equal(await cli("init", "--here", "--lang", "en", "--tools", "none", "--auto"), 0);
  assert.equal(await cli("set", "warmth=5"), 0);
  const tuned = readFileSync(join(home, "config.json"), "utf8");
  out = [];
  assert.equal(await cli("init", "--here", "--lang", "en", "--tools", "none", "--auto"), 0);
  assert.ok(stdout().includes(EN.recovery.unchanged));
  assert.equal(
    JSON.parse(readFileSync(join(home, "config.json"), "utf8")).axes.warmth,
    JSON.parse(tuned).axes.warmth,
    "a re-run to refresh the seeds does not re-interrogate someone who already answered",
  );
});

test("state-only init records the seed version", async () => {
  assert.equal(await cli("init", "--here", "--lang", "en", "--tools", "none", "--auto"), 0);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    seedVersion: number;
    language: string;
  };
  assert.equal(config.seedVersion, SEED_VERSION);
  assert.equal(config.language, "en");
});

test("a config written before language and seedVersion existed still loads", async () => {
  // The shape a user's home is in after an upgrade. Absent is a normal thing to meet.
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
  config.schema = 1;
  delete config.language;
  delete config.seedVersion;
  delete config.wiring;
  writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2));
  assert.equal(await cli("show"), 0, "an older config is not a broken one");
});

// ── the approval gate ────────────────────────────────────────────────────────────────────

test("the diff is printed before the question, not after the write", async () => {
  // The gate stands in front of someone's real configuration, and it used to ask for consent
  // to something the user could not yet see: `gate` buffered its diff into the command's lines,
  // which reach stdout only after `run()` has already resolved.
  const order: string[] = [];
  // An existing target, so what the gate prints is a real diff. A creation shows its path and a
  // line count instead, which would make this assert on a body that is deliberately absent.
  writeFileSync(join(scratch, "TARGET.md"), "old content\n");
  const change = planChange(join(scratch, "TARGET.md"), () => "new content\n", EN);
  const result = await gate([change], {
    paths: gatePaths,
    t: EN,
    dryRun: false,
    auto: false,
    ui: palette("never", {}, false),
    out: (text) => order.push(`diff:${text.includes("new content")}`),
    ask: async () => (order.push("ask"), "no"),
    interactive: () => true,
  });
  assert.deepEqual(order, ["diff:true", "ask"], "the diff reaches the user, then the question");
  assert.equal(result.applied, false);
  assert.equal(readFileSync(join(scratch, "TARGET.md"), "utf8"), "old content\n", "declining writes nothing");
});

test("a new file under a symlinked parent previews its actual destination", async () => {
  const actualDir = join(scratch, "external-config");
  const linkedDir = join(scratch, "linked-config");
  mkdirSync(actualDir);
  symlinkSync(actualDir, linkedDir);
  const path = join(linkedDir, "hooks.json");
  const actual = join(realpathSync(actualDir), "hooks.json");
  const change = planChange(path, () => "{}\n", EN);
  assert.equal(change.realPath, actual);
  let preview = "";
  const result = await gate([change], {
    paths: gatePaths,
    t: EN, dryRun: false, auto: false, ui: palette("never", {}, false),
    out: (text) => { preview += text; },
    ask: async () => {
      assert.ok(preview.includes(`  ${path}\n  → ${actual}\n`));
      assert.equal(existsSync(actual), false, "approval must precede creation");
      return "yes";
    },
    interactive: () => true,
  });
  assert.equal(result.applied, true);
  assert.equal(result.diff[0]!.realPath, actual);
  assert.equal(readFileSync(actual, "utf8"), "{}\n");
});

test("gate revalidates every target before writing a stale diff", async () => {
  const first = join(scratch, "first.md");
  const second = join(scratch, "second.md");
  writeFileSync(first, "first before\n");
  writeFileSync(second, "second before\n");
  const changes = [
    planChange(first, () => "first after\n", EN),
    planChange(second, () => "second after\n", EN),
  ];
  await assert.rejects(
    () => gate(changes, {
      paths: gatePaths,
      t: EN,
      dryRun: false,
      auto: false,
      ui: palette("never", {}, false),
      out: () => {},
      ask: async () => {
        writeFileSync(second, "a user edit after the preview\n");
        return "yes";
      },
      interactive: () => true,
    }),
    /changed after the diff was prepared/,
  );
  assert.equal(readFileSync(first, "utf8"), "first before\n", "a later stale target blocks earlier writes");
  assert.equal(readFileSync(second, "utf8"), "a user edit after the preview\n", "the new bytes survive");
});

test("gate refuses a target that appears after a creation preview", async () => {
  const target = join(scratch, "appeared.md");
  const change = planChange(target, () => "tonedial\n", EN);
  await assert.rejects(
    () => gate([change], {
      paths: gatePaths,
      t: EN,
      dryRun: false,
      auto: false,
      ui: palette("never", {}, false),
      out: () => {},
      ask: async () => {
        writeFileSync(target, "a user's file\n");
        return "yes";
      },
      interactive: () => true,
    }),
    /changed after the diff was prepared/,
  );
  assert.equal(readFileSync(target, "utf8"), "a user's file\n");
});

test("gate refuses a symlink whose identity changes after preview", async () => {
  const first = join(scratch, "first-target.md");
  const second = join(scratch, "second-target.md");
  const link = join(scratch, "settings.md");
  writeFileSync(first, "original\n");
  writeFileSync(second, "other\n");
  symlinkSync(first, link);
  const change = planChange(link, () => "updated\n", EN);
  await assert.rejects(
    () => gate([change], {
      paths: gatePaths,
      t: EN,
      dryRun: false,
      auto: false,
      ui: palette("never", {}, false),
      out: () => {},
      ask: async () => {
        rmSync(link);
        symlinkSync(second, link);
        return "yes";
      },
      interactive: () => true,
    }),
    /changed after the diff was prepared/,
  );
  assert.equal(readFileSync(first, "utf8"), "original\n");
  assert.equal(readFileSync(second, "utf8"), "other\n");
});

test("gate preserves equal-content replacements after preview", async () => {
  for (const replacement of ["file", "symlink", "symlink target"] as const) {
    const directory = join(scratch, replacement);
    mkdirSync(directory);
    const target = join(directory, "target.md");
    const link = join(directory, "settings.md");
    writeFileSync(target, "original\n");
    if (replacement !== "file") symlinkSync(target, link);
    const path = replacement === "file" ? target : link;
    const first = join(directory, "first.md");
    writeFileSync(first, "first before\n");
    const changes = [planChange(first, () => "first after\n", EN), planChange(path, () => "updated\n", EN)];
    const replacedPath = replacement === "symlink" ? link : target;
    const originalIdentity = lstatSync(replacedPath, { bigint: true });
    await assert.rejects(() => gate(changes, {
      paths: gatePaths,
      t: EN, dryRun: false, auto: false, ui: palette("never", {}, false),
      out: () => {}, interactive: () => true,
      ask: async () => {
        // Keep the original inode alive so the replacement cannot reuse it.
        renameSync(replacedPath, join(directory, "retained-original"));
        if (replacement === "symlink") symlinkSync(target, link);
        else {
          writeFileSync(target, "original\n");
          chmodSync(target, Number(originalIdentity.mode & 0o7777n));
        }
        return "yes";
      },
    }), /changed after the diff was prepared/, replacement);
    assert.equal(readFileSync(first, "utf8"), "first before\n", replacement);
    assert.equal(readFileSync(path, "utf8"), "original\n", replacement);
    assert.notEqual(lstatSync(replacedPath, { bigint: true }).ino, originalIdentity.ino, replacement);
  }
});

test("gate refuses a target whose original mode changes after preview", async () => {
  const target = join(scratch, "mode.md");
  writeFileSync(target, "original\n");
  chmodSync(target, 0o644);
  const change = planChange(target, () => "updated\n", EN);
  await assert.rejects(
    () => gate([change], {
      paths: gatePaths,
      t: EN,
      dryRun: false,
      auto: false,
      ui: palette("never", {}, false),
      out: () => {},
      ask: async () => {
        chmodSync(target, 0o600);
        return "yes";
      },
      interactive: () => true,
    }),
    /changed after the diff was prepared/,
  );
  assert.equal(readFileSync(target, "utf8"), "original\n");
  assert.equal(statSync(target).mode & 0o7777, 0o600);
});

test("gate does not let a post-preview mode fix hide a planned change", async () => {
  const target = join(scratch, "mode-only.md");
  writeFileSync(target, "original\n");
  chmodSync(target, 0o644);
  const change = planChange(target, (before) => before, EN, 0o755);
  const preview = await gate([change], {
    paths: gatePaths,
    t: EN,
    dryRun: true,
    auto: true,
    ui: palette("never", {}, false),
  });
  const verbosePreview = await gate([change], {
    paths: gatePaths,
    t: EN,
    dryRun: true,
    auto: true,
    verbose: true,
    ui: palette("never", {}, false),
  });
  for (const rendered of [preview, verbosePreview]) {
    assert.ok(
      rendered.lines.some((line) => line.includes(EN.wiring.modeChanged)),
      "an actual mode-only edit keeps its label",
    );
  }
  // The live mode now satisfies the requested mode, but the mode observed in the preview does
  // not. Using the live filesystem for isNoop would skip the freshness check entirely.
  chmodSync(target, 0o755);
  await assert.rejects(
    () => gate([change], {
      paths: gatePaths,
      t: EN,
      dryRun: false,
      auto: true,
      ui: palette("never", {}, false),
      out: () => {},
    }),
    /changed after the diff was prepared/,
  );
  assert.equal(readFileSync(target, "utf8"), "original\n");
});

test("gate revalidates a planned no-op before applying another change", async () => {
  const noOpTarget = join(scratch, "no-op.md");
  const realTarget = join(scratch, "real.md");
  writeFileSync(noOpTarget, "original\n");
  chmodSync(noOpTarget, 0o600);
  writeFileSync(realTarget, "real before\n");
  const noOp = planChange(noOpTarget, (before) => before, EN, 0o600);
  const real = planChange(realTarget, () => "real after\n", EN);
  writeFileSync(noOpTarget, "a user edit after the preview\n");

  await assert.rejects(
    () => gate([noOp, real], {
      paths: gatePaths,
      t: EN,
      dryRun: false,
      auto: true,
      ui: palette("never", {}, false),
      out: () => {},
    }),
    /changed after the diff was prepared/,
  );
  assert.equal(readFileSync(noOpTarget, "utf8"), "a user edit after the preview\n");
  assert.equal(readFileSync(realTarget, "utf8"), "real before\n", "the later write did not partially apply");
});

test("the shell rc follows the person, never the destination", () => {
  // **This test exists because the suite wrote into the developer's real `~/.bash_profile`.**
  // `AgentPaths.rc` was resolved from the agent root, which was right while that root was the
  // sandbox or the home. With the destination axis it is any directory, so `init` in a project
  // dropped a `.zshrc` there — junk in someone's repository, close enough to a real rc to be
  // committed by accident, and a PATH line no shell would ever read. And because the rc left the
  // destination, `TONEDIAL_AGENT_HOME` stopped containing it: an env without `HOME` sent the
  // write to the real one.
  //
  // Asserted for all three destinations, because it is the *independence* that is the property.
  for (const where of [
    { global: false, project: null },
    { global: false, project: "sub" },
    { global: true, project: null },
  ]) {
    assert.equal(
      resolveAgentPaths(where, { HOME: "/user" }, "/work").rc("/bin/zsh"),
      join("/user", ".zshrc"),
      JSON.stringify(where),
    );
  }
});

test("the destination is one axis: here, a named project, or the home", () => {
  // This replaces a test about `needsApproval`, which no longer exists as a property. Its
  // exemption was for the `output/` sandbox, and removing the sandbox removed the exemption:
  // the current directory, a named project, and the home are all somebody's, so the gate now
  // stands in front of all three and there is nothing left to assert about which is exempt.
  const at = (where: { global: boolean; project: string | null }, env = {}) =>
    resolveAgentPaths(where, env, "/work").root;
  assert.equal(at({ global: false, project: null }), "/work", "the explicit project resolver can select cwd");
  assert.equal(at({ global: false, project: "sub" }), join("/work", "sub"), "--project is relative to it");
  assert.equal(at({ global: false, project: "/elsewhere" }), "/elsewhere", "and takes an absolute path");
  assert.equal(at({ global: true, project: null }, { HOME: "/user" }), "/user", "--global is the home");
  assert.equal(
    at({ global: true, project: "sub" }, { TONEDIAL_AGENT_HOME: "/named" }),
    "/named",
    "and the override wins over both, so a stray flag in a test cannot reach a real home",
  );
});

test("an empty TONEDIAL_AGENT_HOME is an error, not a silent fall-through", async () => {
  // A wrapper that exports the variable from an unset value used to lose to `--global`,
  // sending the write to the real home the caller believed was redirected.
  assert.throws(() => resolveAgentPaths({ global: true, project: null }, { TONEDIAL_AGENT_HOME: "" }, "/work"), /set but empty/);
});

test("legacy hook wiring merges into hooks.json rather than replacing it, and round-trips out", async () => {
  // JSON has no comment syntax, so the marker-wrapped region this tool uses everywhere else
  // cannot live in this file. The entry is identified by its command string instead, which makes
  // "leave everything the user put here" a property worth asserting rather than assuming.
  const path = agentFile("codex");
  mkdirSync(dirname(path), { recursive: true });
  const ownedCommand = `cat "${join(home, "tone.md")}"`;
  const theirs = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [
            { type: "command", command: "echo mine", label: "keep this" },
            { type: "prompt", command: ownedCommand, label: "keep non-command" },
          ],
        },
        { matcher: "resume", metadata: { kept: true }, hooks: [] },
      ],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo theirs" }] }],
    },
    somethingElse: { kept: true },
  };
  const before = {
    ...theirs,
    hooks: {
      ...theirs.hooks,
      SessionStart: [
        {
          matcher: "startup",
          hooks: [
            { type: "command", command: ownedCommand },
            ...theirs.hooks.SessionStart[0]!.hooks,
          ],
        },
        { matcher: "resume", metadata: { kept: true }, hooks: [{ type: "command", command: ownedCommand }] },
      ],
    },
  };
  writeFileSync(path, `${JSON.stringify(before, null, 2)}\n`);

  const route = [{ tool: "codex" as const, root: join(work, "output") }];
  await legacyFixture(route);
  const after = JSON.parse(readFileSync(path, "utf8")) as typeof theirs & {
    hooks: { SessionStart: { hooks: { command: string }[] }[] };
  };
  assert.equal(after.hooks.SessionStart.length, 3, "ours was added beside theirs");
  const siblingBlock = after.hooks.SessionStart.find((b) => b.hooks.some((h) => h.command === "echo mine"));
  assert.deepEqual(
    siblingBlock?.hooks,
    [
      { type: "command", command: "echo mine", label: "keep this" },
      { type: "prompt", command: ownedCommand, label: "keep non-command" },
    ],
    "the sibling handlers survived",
  );
  const unknownBlock = after.hooks.SessionStart.find((b) => (b as { matcher?: string }).matcher === "resume");
  assert.deepEqual(
    unknownBlock,
    { matcher: "resume", metadata: { kept: true }, hooks: [] },
    "a sole owned handler does not erase unknown matcher fields",
  );
  assert.ok(after.hooks.SessionStart.some((b) => b.hooks.some((h) => h.command.endsWith("tone.md\""))), "ours was refreshed");
  assert.deepEqual(after.hooks.PreToolUse, theirs.hooks.PreToolUse, "an unrelated event survived");
  assert.deepEqual(after.somethingElse, theirs.somethingElse, "and so did an unrelated key");

  // Twice changes nothing: the entry is replaced rather than appended, so a version that moved
  // `additionalContextLimit` updates in place instead of accumulating beside its older self.
  const once = readFileSync(path, "utf8");
  await legacyFixture(route);
  assert.equal(readFileSync(path, "utf8"), once, "wiring twice added a second entry");

  // Byte identity is not achievable through a JSON parse, so the round trip is on the value.
  assert.equal(await cli("eject", "--here"), 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), theirs, "eject left their document as it was");
});

test("native ordered hooks use an exact exec pair, preserve settings, and run the reader", () => {
  const stateRoot = join(scratch, "native state $with spaces");
  mkdirSync(stateRoot, { recursive: true });
  const guide = `${GUIDE_FORMAT_MARKER}\nNative guide.\n`;
  const artifact = "# Native tone\n";
  writeFileSync(join(stateRoot, "AGENTS.md"), guide);
  writeFileSync(join(stateRoot, "TONE.md"), artifact);
  const reader = join(stateRoot, "reader.mjs");
  writeFileSync(reader, READER_SOURCE, { mode: 0o600 });

  const spec: HookSpec = {
    matchers: ["startup|resume|clear|compact|fork"],
    handler: {
      type: "command",
      command: process.execPath,
      args: [reader, "--provider", "claude", "--state", stateRoot],
    },
  };
  const shellTwin: HookSpec = {
    matchers: spec.matchers,
    handler: { type: "command", command: process.execPath },
  };
  const emptyArgs: HookSpec = {
    matchers: spec.matchers,
    handler: { type: "command", command: process.execPath, args: [] },
  };
  const settingsPath = join(scratch, ".claude", "settings.json");
  const before = `${JSON.stringify({
    unrelated: { keep: true },
    hooks: {
      SessionStart: [
        {
          matcher: spec.matchers[0],
          metadata: { keep: true },
          hooks: [shellTwin.handler, { type: "prompt", prompt: "keep me" }],
        },
        { matcher: "resume", hooks: [{ type: "command", command: "echo sibling" }] },
      ],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo unrelated" }] }],
    },
  }, null, 2)}\n`;

  const once = withHook(before, spec, settingsPath, EN);
  const parsed = JSON.parse(once) as {
    unrelated: { keep: boolean };
    hooks: {
      SessionStart: Array<{ matcher?: string; metadata?: unknown; hooks: Array<Record<string, unknown>> }>;
      PreToolUse: unknown[];
    };
  };
  assert.deepEqual(parsed.unrelated, { keep: true });
  assert.deepEqual(parsed.hooks.PreToolUse, [{ matcher: "*", hooks: [{ type: "command", command: "echo unrelated" }] }]);
  const ours = parsed.hooks.SessionStart.find((block) =>
    block.matcher === spec.matchers[0] && block.hooks.some((handler) => handler.args !== undefined),
  );
  assert.deepEqual(ours, { matcher: spec.matchers[0], hooks: [spec.handler] });
  assert.equal(
    parsed.hooks.SessionStart[0]!.hooks.some((handler) => handler.command === process.execPath && handler.args === undefined),
    true,
    "a shell-shaped sibling with the same runtime is not adopted",
  );
  assert.equal(withHook(once, spec, settingsPath, EN), once, "native wiring is idempotent");
  assert.equal(hasHook(once, spec, settingsPath, EN), true);
  assert.equal(hasHook(once, shellTwin, settingsPath, EN), true, "the exact legacy-shaped sibling remains selectable by its own shape");
  const emptyArgsDocument = withHook(null, emptyArgs, settingsPath, EN);
  assert.equal(hasHook(emptyArgsDocument, shellTwin, settingsPath, EN), false, "absent args is not [] args");
  assert.equal(hasHook(emptyArgsDocument, emptyArgs, settingsPath, EN), true);
  assert.equal(hasHook(once, { ...spec, matchers: ["startup"] }, settingsPath, EN), false, "edited matcher is not adopted");

  const owned = ownedHook(once, spec, settingsPath, EN);
  assert.deepEqual(JSON.parse(owned ?? "null"), { hooks: { SessionStart: [{ matcher: spec.matchers[0], hooks: [spec.handler] }] } });
  assert.equal(withoutHook(emptyArgsDocument, shellTwin, settingsPath, EN), emptyArgsDocument, "a shell-shaped selector does not remove [] args");
  assert.equal(withoutHook(once, { ...spec, matchers: ["startup"] }, settingsPath, EN), once, "an edited matcher is not removed");

  const removed = JSON.parse(withoutHook(once, spec, settingsPath, EN)) as typeof parsed;
  assert.equal(
    removed.hooks.SessionStart.some((block) => block.hooks.some((handler) => handler.args !== undefined)),
    false,
    "only the exact native handler is removed",
  );
  assert.equal(
    removed.hooks.SessionStart.some((block) => block.hooks.some((handler) => handler.command === process.execPath && handler.args === undefined)),
    true,
    "the shell twin remains",
  );
  assert.deepEqual(removed.hooks.PreToolUse, parsed.hooks.PreToolUse);

  const output = execFileSync(spec.handler.command, spec.handler.args ?? [], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: scratch, TMPDIR: scratch },
  });
  assert.equal(output, guide + "\n\n" + artifact, "the exact command and args execute the prepared reader");
});

test("unwire preserves a sibling in an unnormalized shared hook block", async () => {
  // Wire normalizes our handler into its own block. Removing only after wire would never
  // catch withoutHook accidentally dropping a whole shared block from an older install.
  const path = agentFile("codex");
  mkdirSync(dirname(path), { recursive: true });
  const sibling = { type: "command", command: "echo keep-me" };
  const expected = {
    hooks: { SessionStart: [{ matcher: "startup", hooks: [sibling], label: "user metadata" }] },
  };
  const before = {
    hooks: { SessionStart: [{
      ...expected.hooks.SessionStart[0]!,
      hooks: [{ type: "command", command: `cat "${join(home, "tone.md")}"` }, sibling],
    }] },
  };
  writeFileSync(path, `${JSON.stringify(before)}\n`);

  assert.equal(await cli("unwire", "--here", "codex"), 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), expected);
});

test("unwire leaves a hook document without our handler byte-identical", async () => {
  const path = agentFile("codex");
  mkdirSync(dirname(path), { recursive: true });
  for (const before of ["", "{}\n", "{\"hooks\": {\"SessionStart\": []}}\n"]) {
    writeFileSync(path, before);
    assert.equal(await cli("unwire", "--here", "codex"), 0);
    assert.equal(existsSync(path), true, "an unrelated container was deleted");
    assert.equal(readFileSync(path, "utf8"), before);
  }
});

test("legacy unwire keeps a pre-existing empty hook file after removing our handler", async () => {
  const path = agentFile("codex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  await legacyFixture([{ tool: "codex", root: join(work, "output") }]);
  assert.match(readFileSync(path, "utf8"), /SessionStart/);
  assert.equal(await cli("unwire", "--here", "codex"), 0);
  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(path, "utf8"), "");
});

test("legacy unwire preserves a hook symlink and its pre-existing empty target", async () => {
  const path = agentFile("codex");
  const target = join(work, "personal-hooks.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(target, "");
  symlinkSync(target, path);
  await legacyFixture([{ tool: "codex", root: join(work, "output") }]);
  assert.match(readFileSync(target, "utf8"), /SessionStart/);
  assert.equal(await cli("unwire", "--here", "codex"), 0);
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  assert.equal(readlinkSync(path), target);
  assert.equal(readFileSync(target, "utf8"), "");
});

test("legacy schema-2 provenance spares a file it did not make", async () => {
  // The ownership graph records one registration per selected destination and one resource per
  // physical file. The user's empty CLAUDE.md must therefore keep its resource's first-creation
  // fact even though the init operation also seeds state and skill resources.
  mkdirSync(dirname(agentFile("claude")), { recursive: true });
  writeFileSync(agentFile("claude"), "");
  await legacyFixture(LEGACY_TOOLS.map((tool) => ({ tool, root: join(work, "output") })));
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    wiring: {
      registrations: Record<string, { target: string; resourceIds: string[] }>;
      resources: Record<string, { kind: string; created: boolean }>;
    };
  };
  const claude = Object.values(config.wiring.registrations).find((registration) => registration.target === "claude")!;
  const hookId = claude.resourceIds.find((id) => config.wiring.resources[id]!.kind === "hook")!;
  assert.equal(config.wiring.resources[hookId]!.created, false, "the user's file was recorded as pre-existing");
  assert.equal(await cli("eject", "--here"), 0);
  assert.equal(existsSync(agentFile("claude")), true, "and eject did not delete it");
  assert.equal(readFileSync(agentFile("claude"), "utf8"), "", "exactly as it was found");
});

test("legacy provenance follows the destination this run wrote, not the first one ever wired", async () => {
  // The record is one entry per tool in a single state root, and it was written with
  // `?? existing` — first value wins, forever. That was harmless while one of the two
  // destinations was a throwaway sandbox; with unbounded destinations, a `created: true` recorded
  // in a fresh project decided what `eject` deleted in a home the user had files in.
  const projA = join(work, "projA");
  const projB = join(work, "projB");
  mkdirSync(join(projB, ".claude"), { recursive: true });
  writeFileSync(join(projB, ".claude", "CLAUDE.md"), "");
  const legacyEnv = { TONEDIAL_HOME: home, HOME: join(work, "home") };
  await createLegacyFixture({
    env: legacyEnv,
    cwd: work,
    routes: [{ tool: "claude", root: projA }, { tool: "claude", root: projB }],
  });
  const atB = (...args: string[]) =>
    run(answering(args), { ...legacyEnv, TONEDIAL_AGENT_HOME: projB }, work, false, false);

  assert.equal(await atB("eject", "--project", projB), 0);
  assert.equal(existsSync(join(projB, ".claude", "CLAUDE.md")), true, "projB's file was deleted");
  assert.equal(readFileSync(join(projB, ".claude", "CLAUDE.md"), "utf8"), "");
});

test("legacy no-op provenance at a second destination does not inherit the first creation flag", async () => {
  const a = join(work, "init-a");
  const b = join(work, "init-b");
  const at = (dir: string, ...args: string[]) =>
    run(answering(args), envFor({ TONEDIAL_AGENT_HOME: dir }), work, false, false);
  const fixtureEnv = { TONEDIAL_HOME: home, HOME: join(work, "home") };
  const first = await createLegacyFixture({ env: fixtureEnv, cwd: work, routes: [{ tool: "claude", root: a }] });
  const aFile = join(a, ".claude", "CLAUDE.md");
  const bFile = join(b, ".claude", "CLAUDE.md");
  mkdirSync(dirname(bFile), { recursive: true });
  writeFileSync(bFile, readFileSync(aFile));

  await createLegacyFixture({ env: fixtureEnv, cwd: work, routes: [{ tool: "claude", root: b }], priorConfig: first.config });
  assert.equal(await at(b, "eject", "--project", b), 0);
  assert.equal(existsSync(bFile), true, "A's creation flag must not delete B's matching file");
  assert.equal(readFileSync(bFile, "utf8"), "");
});

test("blocked legacy init does not recreate a missing skill or change provenance", async () => {
  await legacyFixture([{ tool: "claude", root: join(work, "output") }], [{ tools: ["claude"], root: join(work, "output") }]);
  const skill = join(dirname(agentFile("claude")), "skills", "tonedial");
  assert.equal(lstatSync(skill).isSymbolicLink(), true);
  rmSync(skill);
  const before = readFileSync(join(home, "config.json"));
  assert.equal(await run(["init", "--here", "--lang", "en", "--tools", "claude"], envFor(), work, false, false), 1);
  assert.equal(existsSync(skill), false, "no-op text plan must not authorize a skill write");
  assert.deepEqual(readFileSync(join(home, "config.json")), before);
});

test("legacy eject removes a hooks.json that held nothing but our entry", async () => {
  // Proven creation permits removing the now-empty managed container.
  await legacyFixture([{ tool: "codex", root: join(work, "output") }]);
  assert.ok(existsSync(agentFile("codex")));
  assert.equal(await cli("eject", "--here"), 0);
  assert.equal(existsSync(agentFile("codex")), false, "the file went with the entry");
});

test("a legacy hooks.json this tool cannot make sense of is refused, never overwritten", async () => {
  // The user's other hooks are in there. Replacing the document to add one entry would delete
  // them, so a file this tool cannot read is a refusal rather than a fresh start.
  //
  // **Shape, not only syntax**, which the first version of this module got wrong: valid JSON in
  // an unexpected shape either destroyed a value or escaped as a raw stack trace out of the one
  // command whose job is to survive a broken install.
  const path = agentFile("codex");
  mkdirSync(dirname(path), { recursive: true });
  for (const body of [
    "{ this is not json\n",
    // Spreading this produced {"0":"n","1":"o",…} and wrote the user's value away as characters.
    '{"hooks":"nope"}\n',
    // This threw `entriesOf(...).filter is not a function` — a TypeError, not a message.
    '{"hooks":{"SessionStart":{"a":1}}}\n',
    '{"hooks":{"SessionStart":["not an object"]}}\n',
    '{"hooks":{"SessionStart":[{"hooks":{"a":1}}]}}\n',
    '{"hooks":{"SessionStart":[{"hooks":[null]}]}}\n',
    "[]\n",
  ]) {
    writeFileSync(path, body);
    assert.throws(() => hasHook(body, "synthetic legacy command", path, EN), /JSON/, body);
    assert.equal(readFileSync(path, "utf8"), body, `bytes changed for ${body}`);
  }
});

test("a legacy hook command survives a state root a shell would otherwise split", async () => {
  // The path comes from the state root, which `TONEDIAL_HOME` puts anywhere, and the string is
  // *executed* by Codex at session start. Unquoted, a space split it into two arguments and a `$`
  // expanded to something else — the same hazard the shell PATH line already carried a guard for.
  const awkward = join(work, "a root $with space");
  mkdirSync(awkward, { recursive: true });
  const fixture = await createLegacyFixture({
    env: { TONEDIAL_HOME: awkward, TONEDIAL_AGENT_HOME: join(work, "output"), HOME: join(work, "home") },
    cwd: work,
    routes: [{ tool: "codex", root: join(work, "output") }],
  });
  const hooks = JSON.parse(readFileSync(agentFile("codex"), "utf8")) as {
    hooks: { SessionStart: { hooks: { command: string }[] }[] };
  };
  const command = hooks.hooks.SessionStart[0]!.hooks[0]!.command;
  // Run it the way Codex would, and check it reads the artifact rather than failing or reading
  // something else. Asserting on the quoting instead would be asserting a spelling.
  const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  assert.equal(
    output,
    readFileSync(join(fixture.paths.root, LEGACY_CONTEXT_ARTIFACT_FILENAME), "utf8"),
    "the hook does not reach the artifact",
  );
});

test("a marker in the artifact no longer reaches any legacy wired file", async () => {
  // It used to be able to. A note reaches tone.md verbatim and Codex's region carried the whole
  // artifact, so a note holding a marker wrote a region this tool could never parse again --
  // `wire`, `unwire`, `eject`, and `doctor --fix` all refusing forever over damage tonedial
  // itself caused. Nothing inlines the artifact now, so the note cannot get into a region at all.
  const fixture = await legacyFixture(LEGACY_TOOLS.map((tool) => ({ tool, root: join(work, "output") })));
  const artifact = join(fixture.paths.root, LEGACY_CONTEXT_ARTIFACT_FILENAME);
  writeFileSync(artifact, `${readFileSync(artifact, "utf8")}\n${MARKDOWN.begin} sneaky\n`);
  assert.ok(readFileSync(artifact, "utf8").includes(MARKDOWN.begin), "the marker still reaches the artifact");

  for (const tool of LEGACY_TOOLS) {
    assert.equal(
      readFileSync(agentFile(tool), "utf8").includes(MARKDOWN.begin + " sneaky"),
      false,
      `${tool} carried the note through`,
    );
  }
  // Still parseable afterwards, which is the property the old refusal was protecting.
  assert.equal(await cli("eject", "--here"), 0);
});

test("a file being created is summarized by default and expanded only when verbose", async () => {
  // Every line in a created file is an addition. The default still needs representative evidence
  // before approval, while verbose owns the complete body and structural wrappers add no signal.
  const target = agentFile("claude");
  const change = planChange(
    target,
    () =>
      "# generated\n<!-- tonedial:begin -->\n@/state/tone.md\nTone changes style only.\n" +
      "later unique instruction\n<!-- tonedial:end -->\n",
    EN,
  );
  const result = await gate([change], {
    paths: gatePaths,
    dryRun: true,
    auto: true,
    t: EN,
    ui: palette("never", {}, false),
  });
  const preview = result.lines.join("\n");
  assert.match(preview, /\(new file\)/, "it says a file is being created");
  assert.ok(preview.includes(target), "and names where");
  assert.match(preview, /\d+ lines/, "and how big it is");
  assert.match(preview, /\+ @\/state\/tone\.md/, "a representative addition remains visible");
  assert.match(preview, /\+ Tone changes style only\./, "a second meaningful addition remains visible");
  assert.doesNotMatch(preview, /later unique instruction/, "the compact excerpt stays bounded");
  assert.doesNotMatch(preview, /tonedial:begin/, "structural wrappers add no approval evidence");
  assert.equal(existsSync(target), false, "the dry-run did not create the file");

  const verbose = await gate([change], {
    paths: gatePaths,
    dryRun: true,
    auto: true,
    verbose: true,
    t: EN,
    ui: palette("never", {}, false),
  });
  const verbosePreview = verbose.lines.join("\n");
  assert.match(verbosePreview, /\+ <!-- tonedial:begin -->/, "verbose includes structural wrappers");
  assert.match(verbosePreview, /\+ later unique instruction/, "verbose includes the complete created-file body");
  assert.deepEqual(verbose.diff, result.diff, "verbose leaves the machine diff unchanged");
  assert.equal(existsSync(target), false, "verbose dry-run still creates nothing");
});

// ── what the adversarial review found ────────────────────────────────────────────────────

test("native JSON wire reports the approved settings destination and unverified activation", async () => {
  assert.equal(await cli("init", "--here", "--lang", "en", "--tools", "none", "--auto"), 0);
  const before = readFileSync(join(home, "config.json"));
  out = [];
  err = [];
  assert.equal(await cli("wire", "--here", "claude", "--json"), 0);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tools[0].activation, "unverified");
  assert.equal(JSON.parse(readFileSync(parsed.tools[0].path, "utf8")).hooks.SessionStart.length, 1);
  assert.notDeepEqual(readFileSync(join(home, "config.json")), before);
  assert.equal(existsSync(agentFile("claude")), false);
});

test("a legacy restricted file keeps its mode across a write", async () => {
  // `writeFileSync` creates a fresh inode at the process umask and `rename` moves it into
  // place, so a file the user deliberately restricted used to come back world-readable.
  mkdirSync(join(work, "output", ".claude"), { recursive: true });
  writeFileSync(agentFile("claude"), "# mine\n");
  chmodSync(agentFile("claude"), 0o600);
  await legacyFixture([{ tool: "claude", root: join(work, "output") }]);
  assert.equal(statSync(agentFile("claude")).mode & 0o777, 0o600);
});

test("a legacy file that is not valid UTF-8 is refused rather than silently rewritten", async () => {
  // Decoding replaces the invalid byte with U+FFFD and writes the whole decoded string back —
  // and the substitution is invisible in the diff, because both sides carry the same
  // replacement character and the common-prefix trim drops those lines.
  mkdirSync(join(work, "output", ".claude"), { recursive: true });
  writeFileSync(agentFile("claude"), Buffer.from([0x23, 0x20, 0xe9, 0x0a]));
  await assert.rejects(
    () => createLegacyFixture({
      env: envFor(),
      cwd: work,
      routes: [{ tool: "claude", root: join(work, "output") }],
    }),
    (cause: unknown) => cause instanceof Error && cause.message === EN.errors.notUtf8,
  );
  assert.deepEqual(
    [...readFileSync(agentFile("claude"))],
    [0x23, 0x20, 0xe9, 0x0a],
    "and its bytes are exactly as they were",
  );
});

test("a marker quoted mid-line is not the region", async () => {
  // Matching anywhere let a marker inside a sentence become the live region, and `upsert` then
  // deleted the words between the pair. Requiring column 0 is what makes prose *about* this
  // tool safe to keep in a file this tool edits.
  const prose = `keep this ${MARKDOWN.begin} and this ${MARKDOWN.end} too\n`;
  assert.equal(find(prose), null, "there is no region here");
  assert.equal(remove(upsert(prose, "x")), prose, "and the sentence survives a round trip");
});

test("legacy eject removes a directory this tool created, and leaves one it did not", async () => {
  // `writeAtomic` creates `.codex/` on the way in. Leaving it behind made `doctor` report a
  // tool the user never installed, forever, because "installed" is read from the directory.
  mkdirSync(join(work, "output", ".foreign-agent"), { recursive: true });
  await legacyFixture(LEGACY_TOOLS.map((tool) => ({ tool, root: join(work, "output") })));
  assert.equal(await cli("eject", "--here"), 0);
  assert.equal(existsSync(join(work, "output", ".codex")), false, "ours went with the file");
  assert.equal(existsSync(join(work, "output", ".foreign-agent")), true, "theirs stayed");
});

test("doctor --fix leaves an installed-but-unselected tool unwired", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none"), 0);
  mkdirSync(dirname(agentFile("claude")), { recursive: true });
  const config = readFileSync(join(home, "config.json"));
  out = [];
  assert.equal(await cli("doctor", "--here", "--fix"), 0);
  assert.equal(existsSync(agentFile("claude")), false, "directory detection is not wiring approval");
  assert.deepEqual(readFileSync(join(home, "config.json")), config);
});

test("legacy owned wiring ejects while retaining empty host containers", async () => {
  // `init` wires through the same gate but was not recording what it created, so its wiring
  // survived an eject that promises tracelessness. Provenance has to be written by whoever
  // writes the file, at the only moment it is knowable.
  await legacyFixture(
    LEGACY_TOOLS.map((tool) => ({ tool, root: join(work, "output") })),
    [{ tools: LEGACY_TOOLS, root: join(work, "output") }],
  );
  for (const tool of LEGACY_TOOLS) assert.ok(existsSync(agentFile(tool)), tool);
  assert.equal(await cli("eject", "--here"), 0);
  assert.equal(existsSync(agentFile("claude")), false);
  assert.equal(existsSync(agentFile("codex")), false);
  assert.deepEqual(readdirSync(join(work, "output", ".agents", "skills")), [], "the shared skill entry is gone");
  assert.deepEqual(readdirSync(join(work, "output", ".claude", "skills")), [], "the Claude alias is gone");
});

// ── the skill, the command, and the PATH line ────────────────────────────────────────────

test("the packaged skill seed is a valid Agent Skill, and carries no tool-specific field", () => {
  // Asserted through what a loader reads rather than by matching the string the module states.
  // Portability is the reason there is one SKILL.md instead of one per tool, and a single
  // tool-specific key is how that stops being true.
  const seed = seedFiles(resolvePaths(envFor()), { native: true }).find((candidate) => candidate.id === "skill/body")!;
  const text = seed.contents;
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  assert.ok(frontmatter, "SKILL.md opens with frontmatter");
  const keys = frontmatter.split("\n").map((l) => l.split(":")[0]);
  assert.deepEqual(keys.sort(), ["description", "name"], "the plain specification and nothing else");
  assert.match(frontmatter, /^name: tonedial$/m);
  // The description is an activation trigger, so it has to say *when*, not what.
  assert.match(frontmatter, /description: Use when/);
  assert.ok(seedFiles(resolvePaths(envFor()), { native: true }).some((candidate) => candidate.id === "skill/traits"));
});

test("legacy skill wiring uses one shared native root, with a Claude provider alias", async () => {
  const fixture = await legacyFixture([], [{ tools: LEGACY_TOOLS, root: join(work, "output") }]);
  const source = join(fixture.paths.skill, "tonedial");
  const shared = join(work, "output", ".agents", "skills", "tonedial");
  const claude = join(work, "output", ".claude", "skills", "tonedial");
  for (const [tool, link] of [["codex", shared], ["claude", claude]] as const) {
    assert.equal(lstatSync(link).isSymbolicLink(), true, `${tool} is linked, not copied`);
    assert.equal(realpathSync(link), realpathSync(source), `${tool} reaches the one seeded copy`);
    // Opened, not just resolved: a link is only wiring if something is at the other end.
    assert.match(readFileSync(join(link, "SKILL.md"), "utf8"), /^---\nname: tonedial$/m);
  }
  assert.equal(existsSync(join(work, "output", ".codex", "skills")), false);
  assert.match(readFileSync(join(fixture.paths.root, LEGACY_CONTEXT_ARTIFACT_FILENAME), "utf8"), /use the `tonedial` CLI/);
});

test("native wire preserves a foreign Claude skill without partial setup", async () => {
  const theirs = join(work, "output", ".claude", "skills", "tonedial");
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(theirs, "SKILL.md"), "# mine\n");
  assert.equal(await cli("init", "--here", "--lang", "en", "--tools", "none", "--auto"), 0);
  const before = readFileSync(join(home, "config.json"));
  err = [];
  assert.equal(await cli("wire", "--here", "claude"), 1);
  assert.ok(stderr().includes(EN.errors.ownershipConflict(theirs)));
  assert.equal(readFileSync(join(theirs, "SKILL.md"), "utf8"), "# mine\n", "left exactly as found");
  assert.deepEqual(readFileSync(join(home, "config.json")), before, "foreign discovery caused no state commit");
  assert.equal(existsSync(agentFile("claude")), false, "the host file was not partially wired");

  assert.equal(await cli("eject", "--here"), 0);
  assert.ok(existsSync(join(theirs, "SKILL.md")), "eject does not delete what it did not create");
});

test("native wire refuses before adopting a marketplace Claude copy", async () => {
  // The names match by construction — it is the same skill — so classifying by content would
  // wipe a hand-installed copy the moment anyone ran eject.
  const theirs = join(work, "output", ".claude", "skills", "tonedial");
  mkdirSync(join(theirs, "references"), { recursive: true });
  writeFileSync(join(theirs, "SKILL.md"), "---\nname: tonedial\n---\n");
  writeFileSync(join(theirs, "references", "traits.md"), "# theirs\n");
  writeFileSync(join(theirs, "my-notes.md"), "mine\n");

  assert.equal(await cli("init", "--here", "--lang", "en", "--tools", "none", "--auto"), 0);
  err = [];
  assert.equal(await cli("wire", "--here", "claude"), 1);
  assert.ok(stderr().includes(EN.errors.ownershipConflict(theirs)));
  assert.equal(await cli("eject", "--here"), 0);
  assert.ok(existsSync(join(theirs, "my-notes.md")), "their own file survived");
  assert.ok(existsSync(join(theirs, "SKILL.md")), "and so did the copy they installed");
});

test("a legacy skill link whose target is gone is replaced, not reported absent and left", async () => {
  // `existsSync` follows a symlink, so a dangling one read as "absent": `uninstall` left it
  // forever and `install` threw EEXIST creating a link over it, mid-way through an `init` that
  // had already written everything else.
  const options = [{ tools: LEGACY_TOOLS, root: join(work, "output") }];
  const first = await legacyFixture([], options);
  const link = join(work, "output", ".claude", "skills", "tonedial");
  rmSync(first.paths.skill, { recursive: true, force: true });
  assert.equal(lstatSync(link).isSymbolicLink(), true, "the link is still there, pointing nowhere");

  await createLegacyFixture({
    env: envFor(),
    cwd: work,
    priorConfig: first.config,
    skills: options,
  });
  assert.equal(existsSync(link), true, "and the link resolves again");
});

test("a recorded legacy tone command is removed with its selected wiring", async () => {
  const root = join(work, "output");
  const { paths, config } = await legacyFixture([{ tool: "claude", root }]);
  const command = join(work, "output", ".claude", "commands", "tone.md");
  assert.equal(existsSync(command), false, "a fourth window onto the CLI is not installed by default");

  const change = planChange(command, () => TONE_COMMAND_MD, EN);
  config.wiring = recordFileChange(config.wiring, {
    target: "claude", scope: "project", destination: canonicalDestination(root),
  }, change, "command", { version: 1 }, EN);
  const installed = await gate([change], {
    paths, finalChanges: [planChange(paths.config, () => serializeConfig(config), EN, undefined, paths.root)],
    auto: true, dryRun: false, t: EN, ui: palette("never", {}, false), out: () => {},
  });
  assert.equal(installed.applied, true);
  assert.match(readFileSync(command, "utf8"), /^---\ndescription: /, "it is a command file");
  assert.equal(await cli("eject", "--here"), 0);
  assert.equal(existsSync(command), false);
});

test("scoped legacy eject preserves a journaled curl PATH line byte for byte", async () => {
  // Native init is unavailable in B; install the historical resource through its real owners.
  // This protects scoped removal, not activation of the future native setup route.
  const rc = join(work, "home", ".bash_profile");
  mkdirSync(join(work, "output"), { recursive: true });
  mkdirSync(join(work, "home"), { recursive: true });
  writeFileSync(rc, "# my shell\nexport EDITOR=vim\n");

  assert.equal(await legacyShellFixture(), rc);
  const after = readFileSync(rc, "utf8");
  assert.ok(
    after.split("\n").some((l) => l.includes(join(home, "bin")) && l.startsWith("export PATH=")),
    `the rc file never got a PATH line:\n${after}`,
  );
  assert.match(after, /^# tonedial:begin$/m, "a shell comment, not an HTML one");
  assert.match(after, /^export EDITOR=vim$/m, "and what was already there survived");

  assert.equal(await curlCli("eject", "--here"), 0);
  assert.equal(readFileSync(rc, "utf8"), after, "scoped eject preserves the installed shell setup byte for byte");
});

test("an npm install leaves the shell rc alone", async () => {
  const rc = join(work, "home", ".bash_profile");
  mkdirSync(join(work, "output"), { recursive: true });
  mkdirSync(join(work, "home"), { recursive: true });
  writeFileSync(rc, "# my shell\n");
  assert.equal(await cli("init", "--here", "--lang", "en", "--tools", "none", "--auto"), 0);
  assert.equal(readFileSync(rc, "utf8"), "# my shell\n", "npm owns the PATH entry, so nothing is written");
});

test("doctor calls an absent PATH line a problem for curl and a note for npm", async () => {
  assert.equal(await cli("init", "--here", "--lang", "en", "--tools", "none", "--auto"), 0);
  out = [];
  assert.equal(await cli("doctor", "--here", "--json"), 0);
  assert.equal(pathCheckOf(stdout()).state, "note", "npm owns it, so absent is normal");

  out = [];
  assert.equal(await curlCli("doctor", "--here", "--json"), 0);
  const curl = pathCheckOf(stdout());
  assert.equal(curl.state, "problem", "for curl it is the only reason a bare tonedial resolves");
  assert.equal(curl.repair, null, "a project repair cannot change the global profile");
  out = [];
  assert.equal(await run(["doctor", "--global", "--json"], { ...curlEnv(), TONEDIAL_AGENT_HOME: undefined }, work, false, false), 0);
  assert.ok(pathCheckOf(stdout()).repair, "the current global profile carries an actionable repair");
});

test("fish gets fish syntax, because export PATH is a syntax error there", async () => {
  // The region mechanism hid this perfectly: `# tonedial:begin` is a valid fish comment, so a
  // POSIX payload round-tripped and updated idempotently while erroring on every new shell.
  assert.match(pathLine("/opt/tonedial/bin", "/bin/sh"), /^export PATH="/);
  assert.match(pathLine("/opt/tonedial/bin", "/usr/local/bin/fish"), /^set -gx PATH /);
  assert.doesNotMatch(pathLine("/opt/tonedial/bin", "/usr/local/bin/fish"), /export/);
  // A path is executed on every shell start, so it is quoted rather than interpolated.
  assert.match(pathLine('/tmp/a"b$c/bin', "/bin/zsh"), /a\\"b\\\$c/);
});

test("scoped eject preserves the PATH line even after the login shell changed", async () => {
  // The shell setup belongs to the curl installation, not to this project scope. Changing the
  // current shell must not make a scoped disconnect rewrite or remove the installed rc file.
  await legacyShellFixture();
  const bashRc = join(work, "home", ".bash_profile");
  assert.ok(existsSync(bashRc), "installed under bash");
  const installed = readFileSync(bashRc);

  // Now they use zsh. Same home, same bin, different rc.
  const zsh = (...args: string[]) =>
    run(answering(args), { ...curlEnv(), SHELL: "/bin/zsh" }, work, false, false);
  assert.equal(await zsh("eject", "--here"), 0);
  assert.equal(existsSync(bashRc), true, "the installation rc remains owned by the install scope");
  assert.deepEqual(readFileSync(bashRc), installed, "the installed rc remains byte-identical");
});

test("packing builds first, so a stale dist cannot be published", async () => {
  // **`files: ["dist"]` ships whatever is on disk**, and `prepublishOnly` covers `npm publish`
  // alone. `npm pack` on a tree with no `dist/` shipped three files and no bin target — a
  // package whose command does not exist, produced without a single error. `prepack` is the hook
  // that runs before both, so the artifact cannot be older than the source that made it.
  //
  // Start with no dist in a disposable source tree. Deleting the repository's dist races with
  // parallel installer tests that consume it, so the build-under-test needs its own output.
  const unbuilt = join(scratch, "unbuilt");
  mkdirSync(unbuilt);
  for (const file of ["src", "package.json", "tsconfig.json", "tsconfig.build.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    cpSync(join(repoRoot, file), join(unbuilt, file), { recursive: true });
  }
  symlinkSync(join(repoRoot, "node_modules"), join(unbuilt, "node_modules"), "junction");
  assert.equal(existsSync(join(unbuilt, "dist")), false);
  const listed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: unbuilt, encoding: "utf8" }),
  ) as [{ files: { path: string }[] }];
  const manifest = JSON.parse(readFileSync(join(unbuilt, "package.json"), "utf8")) as {
    bin: Record<string, string>;
  };
  for (const target of Object.values(manifest.bin)) {
    assert.ok(
      listed[0]!.files.some((f) => f.path === target.replace(/^\.\//, "")),
      `packing an unbuilt tree shipped no ${target}`,
    );
  }
});

test("the published package carries what the CLI needs, and none of the harness", async () => {
  // Asked of the packer rather than of `package.json`, because `files` is the spelling and what
  // npm actually puts in the tarball is the obligation. A `files` entry that stopped matching —
  // a renamed directory, a stray `.npmignore` — reads identically and ships a broken package.
  // Avoid rebuilding shared dist while parallel tests copy it; prepack is tested in a disposable tree.
  const listed = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], { cwd: repoRoot, encoding: "utf8" }),
  ) as [{ files: { path: string }[] }];
  const shipped = listed[0]!.files.map((f) => f.path);
  assert.ok(shipped.length > 20, `only ${shipped.length} files would ship`);

  // The bin target is read from the manifest rather than restated. Repointing `bin` at a file
  // the tarball does not carry is precisely the change a hardcoded list survives green.
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    bin: Record<string, string>;
  };
  for (const target of Object.values(manifest.bin)) {
    assert.ok(shipped.includes(target.replace(/^\.\//, "")), `bin points at ${target}, which would not ship`);
  }
  // The compiled equivalents. `src/` is not published any more — Node refuses type stripping
  // under `node_modules`, so what ships has to be JavaScript — and these three are the ones the
  // CLI cannot start without. The private install entry must ship for curl and self-update too.
  for (const needed of ["dist/cli.js", "dist/install.js", "dist/core/skill.js", "dist/core/seeds.js", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert.ok(shipped.includes(needed), `${needed} would not ship`);
  }
  // And no TypeScript at all. A stray `files` entry or a `.npmignore` that let `src/` back in
  // would ship a package whose primary channel cannot run it, which is the whole defect.
  assert.deepEqual(shipped.filter((f) => f.endsWith(".ts")), [], "TypeScript would ship");
  // The verification harness is for contributors and stays out. `docs/` is where a widened
  // boundary would pull it in without anyone noticing.
  for (const prefix of ["docs/", "test/", "scripts/", "output/"]) {
    const leaked = shipped.filter((f) => f.startsWith(prefix));
    assert.deepEqual(leaked, [], `${prefix} must not ship`);
  }
});

test("the installer has valid POSIX shell syntax", async () => {
  // Runtime install/update tests use a local registry and inspect actual package, shim, state,
  // and host bytes. A source-text redirection scanner cannot establish that write boundary.
  const script = join(repoRoot, "install.sh");
  execFileSync("sh", ["-n", script]);
});

const seedCheckOf = (payload: string) =>
  (
    JSON.parse(payload) as {
      checks: { name: string; state: string; detail: string; files?: { path: string; reason: string }[] }[];
    }
  ).checks
    .find((c) => c.name === "seeds")!;

test("the seed check compares content, so a stale seed cannot report ok", async () => {
  // Checking only that a file existed let `init` stamp a new version over the old anchors and
  // then report `ok` — the update path certifying exactly what it exists to replace.
  assert.equal(await cli("init", "--here", "--lang", "ko", "--tools", "none", "--auto"), 0);
  // Optional native seeds are not written by a state-only setup. Construct their recorded
  // evidence explicitly through the packaged seed definitions so this test exercises the
  // refresh contract without pretending B owns native delivery.
  const paths = resolvePaths(envFor());
  const optional = seedFiles(paths, { native: true }).filter((seed) => seed.id.startsWith("skill/"));
  for (const seed of optional) {
    mkdirSync(dirname(seed.path), { recursive: true });
    writeFileSync(seed.path, seed.contents);
  }
  const config = parseConfig(readFileSync(paths.config, "utf8"));
  for (const seed of optional) config.managedSeeds[seed.id] = seedRecord(seed);
  writeFileSync(paths.config, serializeConfig(config));

  out = [];
  assert.equal(await cli("doctor", "--here", "--json"), 0);
  assert.equal(seedCheckOf(stdout()).state, "ok");

  const skill = optional.find((seed) => seed.id === "skill/body")!.path;
  writeFileSync(skill, `${readFileSync(skill, "utf8")}\nan edit an update would have to reach\n`);
  out = [];
  assert.equal(await cli("doctor", "--here", "--json"), 0);
  const stale = seedCheckOf(stdout());
  assert.equal(stale.state, "problem", "a seed whose content moved is stale, not merely present");
  assert.deepEqual(stale.files, [{ path: skill, reason: "modified" }]);

  // The recorded generated family can be rebuilt without selecting external consumers.
  const expected = optional.find((seed) => seed.id === "skill/body")!.contents;
  assert.equal(await cli("init", "--here", "--lang", "ko", "--tools", "none", "--auto"), 0);
  out = [];
  assert.equal(await cli("doctor", "--here", "--json"), 0);
  assert.equal(seedCheckOf(stdout()).state, "ok");
  assert.equal(readFileSync(skill, "utf8"), expected);
  assert.equal(existsSync(join(work, "output", ".agents")), false);
});

test("a seed that is simply gone is refreshed too", async () => {
  assert.equal(await cli("init", "--here", "--lang", "en", "--tools", "none", "--auto"), 0);
  rmSync(join(home, "presets", "builtin", "heavenly-demon.json"));
  out = [];
  assert.equal(await cli("doctor", "--here", "--json"), 0);
  assert.ok(seedCheckOf(stdout()).files?.some((file) => file.path.endsWith("heavenly-demon.json")));
  assert.equal(await cli("init", "--here", "--lang", "en", "--tools", "none", "--auto"), 0);
  assert.ok(existsSync(join(home, "presets", "builtin", "heavenly-demon.json")));
});

test("the approval gate stands in front of the skill and the command too", async () => {
  // Inject the approval prompt because redirected test roots otherwise need no approval.
  const target = join(scratch, "home", ".claude", "CLAUDE.md");
  const asked: string[] = [];
  const result = await gate([planChange(target, () => "wired\n", EN)], {
    paths: gatePaths,
    t: EN,
    dryRun: false,
    auto: false,
    ui: palette("never", {}, false),
    out: () => asked.push("diff"),
    ask: async () => (asked.push("ask"), "no"),
    interactive: () => true,
  });
  assert.deepEqual(asked, ["diff", "ask"]);
  assert.equal(result.applied, false);
  assert.equal(existsSync(target), false);
});

test("an unavailable native selection refuses before linking anything or claiming success", async () => {
  assert.equal(await cli("init", "--here", "--lang", "en", "--tools", "none", "--auto"), 0);
  err = [];
  out = [];
  const configBefore = readFileSync(join(home, "config.json"));
  const toneBefore = readFileSync(join(home, "TONE.md"));
  assert.equal(
    await cli("init", "--here", "--lang", "en", "--tools", "other-agent"),
    1,
  );
  for (const tool of ["claude", "codex"] as const) {
    assert.equal(
      existsSync(tool === "claude"
        ? join(work, "output", ".claude", "skills", "tonedial")
        : join(work, "output", ".agents", "skills", "tonedial")),
      false,
      `${tool} was linked after the write was refused`,
    );
  }
  assert.doesNotMatch(stdout(), /Set up/, "a refused init reported itself finished");
  assert.match(stderr(), /unsupported tool/);
  assert.deepEqual(readFileSync(join(home, "config.json")), configBefore);
  assert.deepEqual(readFileSync(join(home, "TONE.md")), toneBefore);
});

test("declining the diff leaves no skill link and no claim of success", async () => {
  // The seam the gate already exposes, driven directly, because the CLI cannot say no to itself.
  const target = join(work, "output", ".claude", "CLAUDE.md");
  const change = planChange(target, () => "wired\n", EN);
  const result = await gate([change], {
    paths: gatePaths,
    dryRun: false,
    auto: false,
    t: EN,
    ui: palette("never", {}, false),
    out: () => {},
    ask: async () => "no",
    interactive: () => true,
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "declined");
  assert.equal(existsSync(target), false, "declining wrote the file anyway");
});

test("a fish install disconnects host wiring while preserving its shell config", async () => {
  const fish = (...args: string[]) =>
    run(answering(args), { ...curlEnv(), SHELL: "/usr/local/bin/fish" }, work, false, false);
  await legacyShellFixture("/usr/local/bin/fish");
  const config = join(work, "home", ".config", "fish", "config.fish");
  assert.match(readFileSync(config, "utf8"), /^set -gx PATH /m, "fish syntax, not export");
  const installed = readFileSync(config);

  assert.equal(await fish("eject", "--here"), 0);
  assert.equal(existsSync(agentFile("codex")), false, "the Codex hook was disconnected");
  assert.equal(existsSync(agentFile("claude")), false, "the Claude import was disconnected");
  assert.equal(existsSync(join(work, "output", ".agents", "skills", "tonedial")), false, "the shared skill was disconnected");
  assert.equal(existsSync(join(work, "output", ".claude", "skills", "tonedial")), false, "the Claude skill alias was disconnected");
  assert.deepEqual(readFileSync(config), installed, "the fish rc remains byte-identical");
});

test("global and project destinations share one artifact without moving the state", async () => {
  // **The coupling this record exists to prevent.** The wiring moves and the state root does
  // not: tone is a user attribute, so N projects must not mean N configs, preset libraries, and
  // safewords. A destination that carried its own `tone.md` would be that, and the way it would
  // show is the import line pointing somewhere other than the one artifact.
  //
  // `TONEDIAL_AGENT_HOME` is deliberately *not* set here — this drives the flags a user types.
  const fakeHome = join(work, "home");
  // The agent directory exists in the fake home, because at `--global` absence means the user does
  // not have that agent rather than "nothing here yet" — the subject here is the import line, not
  // detection.
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  // Native init no longer produces lower-case legacy registrations. Build the same ones through the
  // real ownership planner so this multi-destination invariant remains executable in B.
  const legacyEnv = { TONEDIAL_HOME: home, HOME: fakeHome };
  await createLegacyFixture({
    env: legacyEnv,
    cwd: work,
    routes: [
      { tool: "claude", root: work },
      { tool: "claude", root: join(work, "sub") },
      { tool: "claude", root: fakeHome, scope: "global" },
    ],
  });

  const roots = [work, join(work, "sub"), fakeHome];
  for (const root of roots) {
    const claude = join(root, ".claude", "CLAUDE.md");
    assert.ok(existsSync(claude), `no CLAUDE.md at ${root}`);
    // Read out of the file as it stands rather than compared against a spelling typed here, and
    // resolved, so a line that points at a path nothing is at fails instead of matching.
    const line = find(readFileSync(claude, "utf8"))!.content.split("\n").find((l) => l.startsWith("@"))!;
    const target = line.slice(1).replace(/^~/, fakeHome);
    assert.equal(realpathSync(target), realpathSync(join(home, LEGACY_CONTEXT_ARTIFACT_FILENAME)), `${root} imports its own copy`);
  }
  // The state root did not multiply with the destinations.
  for (const root of roots) {
    assert.equal(existsSync(join(root, "config.json")), false, `${root} grew a config`);
    assert.equal(existsSync(join(root, "presets")), false, `${root} grew a preset library`);
  }
});

// ── the live branch ──────────────────────────────────────────────────────────────────────

/**
 * `--global` against a home made of a temporary directory.
 *
 * Until this existed the live branch was covered by a string comparison and never executed —
 * and the milestone review found the one thing nothing could drive was the one thing that was
 * broken. A tmp directory standing in for `$HOME` runs the real path with no real home in reach.
 */
const liveHome = (...parts: string[]) => join(work, "home", ...parts);
// The state root sits *inside* the fake home, as it does in a real install — which is what lets
// the import line abbreviate to `~/.tonedial/tone.md` instead of an absolute path.
const liveCli = (...args: string[]) =>
  run(args, { TONEDIAL_HOME: liveHome(".tonedial"), HOME: liveHome() }, work, false, false);

test("legacy global wiring writes the real agent files, and no preview at all", async () => {
  mkdirSync(liveHome(".claude"), { recursive: true });
  writeFileSync(liveHome(".claude", "CLAUDE.md"), "# My own rules\n\nAlways run tests.\n");

  // The subject here is what a real home gets written into it, not which agents a home happens
  // to hold.
  mkdirSync(liveHome(".codex"), { recursive: true });
  await createLegacyFixture({
    env: { TONEDIAL_HOME: liveHome(".tonedial"), HOME: liveHome() },
    cwd: work,
    routes: LEGACY_TOOLS.map((tool) => ({ tool, root: liveHome(), scope: "global" })),
    skills: [{ tools: LEGACY_TOOLS, root: liveHome(), scope: "global" }],
  });

  const claude = readFileSync(liveHome(".claude", "CLAUDE.md"), "utf8");
  assert.match(claude, /^# My own rules$/m, "what the user wrote is still there");
  assert.match(claude, /^@~\/\.tonedial\/tone\.md$/m, "and the reference is written with ~");
  assert.ok(claude.indexOf("Always run tests") < claude.indexOf("tonedial:begin"), "at the end, after theirs");
  assert.equal(claude.split("\n").filter((l) => l.startsWith("@")).length, 1, "one line, not the artifact");

  assert.ok(existsSync(liveHome(".claude", "skills", "tonedial")));
  assert.equal(existsSync(join(work, "output")), false, "the preview is not written when the real thing is");
});

test("legacy global eject restores the user's file byte for byte", async () => {
  const original = "# My own rules\n\nAlways run tests.\n";
  mkdirSync(liveHome(".claude"), { recursive: true });
  writeFileSync(liveHome(".claude", "CLAUDE.md"), original);

  await createLegacyFixture({
    env: { TONEDIAL_HOME: liveHome(".tonedial"), HOME: liveHome() },
    cwd: work,
    routes: LEGACY_TOOLS.map((tool) => ({ tool, root: liveHome(), scope: "global" })),
  });
  assert.equal(await liveCli("eject", "--global", "--auto"), 0);

  assert.equal(readFileSync(liveHome(".claude", "CLAUDE.md"), "utf8"), original);
  // `.codex` was this tool's; `.claude` was the user's and stays with their file.
  assert.equal(existsSync(liveHome(".codex")), false);
  assert.ok(existsSync(liveHome(".claude", "CLAUDE.md")), "and theirs did not");
  assert.ok(existsSync(liveHome(".tonedial", "config.json")), "the state root is kept, as eject says it is");
});

test("legacy global Codex gets a hook and the others get a link too", async () => {
  // Both present, so detection checks both and the contrast between the two deliveries is what
  // this test is about rather than which agents a home happens to hold.
  mkdirSync(liveHome(".codex"), { recursive: true });
  mkdirSync(liveHome(".claude"), { recursive: true });
  const liveEnv = { TONEDIAL_HOME: liveHome(".tonedial"), HOME: liveHome() };
  await createLegacyFixture({
    env: liveEnv,
    cwd: work,
    routes: [
      { tool: "codex", root: liveHome(), scope: "global" },
      { tool: "claude", root: liveHome(), scope: "global" },
    ],
  });
  const hooks = JSON.parse(readFileSync(liveHome(".codex", "hooks.json"), "utf8")) as {
    hooks: { SessionStart: { hooks: { command: string }[] }[] };
  };
  // **Executed, not spelled.** The first version of this asserted `/^cat "~\//` with a comment
  // claiming a shell expands it. It does not — POSIX tilde expansion happens only on an
  // *unquoted* leading tilde — so the hook read a directory named `~` on every default install
  // while this test stayed green and `doctor` reported healthy. Run it the way Codex would.
  const command = hooks.hooks.SessionStart[0]!.hooks[0]!.command;
  const read = execFileSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    env: { HOME: liveHome(), PATH: process.env.PATH ?? "" },
    cwd: "/",
  });
  assert.equal(read, readFileSync(liveHome(".tonedial", "tone.md"), "utf8"), "the hook does not reach the artifact");
  assert.doesNotMatch(command, /"~/, "and it does not carry a tilde a shell will not expand");
  assert.match(find(readFileSync(liveHome(".claude", "CLAUDE.md"), "utf8"))!.content, /^@/);
  assert.equal(existsSync(liveHome(".codex", "AGENTS.md")), false, "and no instruction file was written");
});

test("a live destination needs approval, and refuses when there is no terminal to ask on", async () => {
  // A run with no terminal cannot be assumed to consent — silence is the one answer this gate
  // will not take. It holds at every destination now; the home is the one with the most at stake.
  err = [];
  assert.equal(await liveCli("init", "--lang", "en", "--tools", "none", "--global"), 1);
  assert.ok(collapsed(stderr()).includes(collapsed(EN.wiring.needsApproval)));
  assert.equal(existsSync(liveHome(".claude")), false, "and it wrote nothing on the way to refusing");
});

// The three ways one directory can be written down, and the shape check that has to see through
// all of them. Each of these was a real defect: a symlink above the install, a relative
// `TONEDIAL_HOME`, and a case difference on a filesystem that ignores case. A misread shape
// writes no PATH line, so the channel reports success and leaves `tonedial` unreachable.

/** Whether this filesystem treats two spellings of one name as the same directory. */
function caseInsensitiveHere(dir: string): boolean {
  mkdirSync(join(dir, "Probe"), { recursive: true });
  return existsSync(join(dir, "probe"));
}

test("one directory spelled three ways is one install", (t) => {
  const lib = join(scratch, "Root", "lib", "src", "core");
  mkdirSync(lib, { recursive: true });
  const self = join(lib, "paths.ts");

  // The spelling as given always works; it is the two variants that used to fail.
  assert.equal(installShape(resolvePaths({ TONEDIAL_HOME: join(scratch, "Root") }), self, {}), "curl");

  if (!caseInsensitiveHere(scratch)) {
    // Reported rather than silently returned. On a case-sensitive filesystem `root` and `Root`
    // are two directories and telling them apart is correct — but this is the only test that
    // exercises the defect the change was written for, and a bare `return` let a whole platform
    // report green having asserted one line.
    t.skip("this filesystem is case-sensitive, where telling the spellings apart is correct");
    return;
  }
  for (const spelling of ["root", "rOoT"]) {
    const paths = resolvePaths({ TONEDIAL_HOME: join(scratch, spelling) });
    assert.equal(installShape(paths, self, {}), "curl", spelling);
  }
});

test("a symlinked root is the same install, and an unrelated path is not", () => {
  const root = join(scratch, "physical");
  mkdirSync(join(root, "lib", "src", "core"), { recursive: true });
  const self = join(root, "lib", "src", "core", "paths.ts");
  symlinkSync(root, join(scratch, "link"));

  assert.equal(installShape(resolvePaths({ TONEDIAL_HOME: join(scratch, "link") }), self, {}), "curl");
  // The other direction matters as much: a global npm install must not be read as a curl one,
  // or `init` writes a PATH line npm already owns.
  const elsewhere = join(scratch, "elsewhere", "node_modules", "tonedial", "src", "core", "paths.ts");
  assert.equal(installShape(resolvePaths({ TONEDIAL_HOME: root }), elsewhere, {}), "npm");
});

test("a lib directory that does not exist is not an install to be inside of", () => {
  // An npm install has no `lib/` under the state root at all. Asking the filesystem about a
  // path that is not there must answer no rather than throw.
  const paths = resolvePaths({ TONEDIAL_HOME: join(scratch, "never-installed") });
  assert.equal(installShape(paths, join(scratch, "somewhere", "paths.ts"), {}), "npm");
});

// The three mutations that survived the whole suite before these existed. Each names a half of
// the identity check that nothing was holding down, and a green suite over a missing half is
// how a mutant of this function reached a commit.

/**
 * Two directories on different volumes that share an inode number, where neither contains the
 * other — `/` is excluded for that reason, since everything really is inside it.
 */
function sameInodeDifferentVolume(): [string, string] | null {
  const seen = new Map<string, string>();
  for (const path of ["/System/Volumes/VM", "/System/Volumes/Preboot", "/System/Volumes/Data", "/private", "/home"]) {
    let id;
    try {
      id = statSync(path, { bigint: true });
    } catch {
      continue;
    }
    const key = String(id.ino);
    const prior = seen.get(key);
    if (prior !== undefined && !path.startsWith(prior + sep) && !prior.startsWith(path + sep)) {
      return [prior, path];
    }
    seen.set(key, path);
  }
  return null;
}

test("two volumes sharing an inode number are two directories", (t) => {
  // Inode numbers are unique per filesystem, not per machine: on this laptop `/` and two system
  // volumes all have inode 2. Comparing inode alone reads a global npm install as a curl one and
  // writes a PATH line into a shell rc on a wrong answer.
  const pair = sameInodeDifferentVolume();
  if (pair === null) {
    t.skip("no two mounted volumes here share an inode number");
    return;
  }
  const [lib, elsewhere] = pair;
  assert.equal(
    installShape({ ...resolvePaths({ TONEDIAL_HOME: scratch }), lib }, join(elsewhere, "src", "core", "paths.ts"), {}),
    "npm",
    `${elsewhere} was read as being inside ${lib}`,
  );
});

test("the module's own directory is where the walk starts, and the filesystem root is where it stops", () => {
  const lib = join(scratch, "root", "lib");
  mkdirSync(join(lib, "src", "core"), { recursive: true });
  const paths = { ...resolvePaths({ TONEDIAL_HOME: join(scratch, "root") }), lib };

  // Starting at `self` rather than its directory would make a *file* named like the lib match
  // itself, and would answer curl for `self === lib`.
  assert.equal(installShape(paths, lib, {}), "npm", "lib itself is not inside lib");

  // Stopping one level early would miss a module sitting deep under lib. Four levels down is
  // past anything the real layout uses, so only a walk that runs to the root finds it.
  const deep = join(lib, "src", "core", "a", "b", "c", "paths.ts");
  mkdirSync(dirname(deep), { recursive: true });
  assert.equal(installShape(paths, deep, {}), "curl", "the walk gave up before reaching lib");
});

test("a module outside the install is not inside it, however deep the walk goes", () => {
  // The negative half of the headline case, which lives here because that test asserts `curl`
  // four times and so passes under an `inside()` that always says yes.
  const lib = join(scratch, "root", "lib");
  mkdirSync(join(lib, "src"), { recursive: true });
  const sibling = join(scratch, "root", "elsewhere", "src", "core", "paths.ts");
  mkdirSync(dirname(sibling), { recursive: true });

  const paths = { ...resolvePaths({ TONEDIAL_HOME: join(scratch, "root") }), lib };
  assert.equal(installShape(paths, sibling, {}), "npm", "a sibling of lib was read as inside it");
});

// The write boundary. `init` writes the `tonedial` command outside the approval gate on the
// grounds that it lands under our own root — so this is what makes that grounds true. It had no
// test at all, which is how folding it onto the shared helper broke it while the suite stayed
// green: asking about the path as written follows lexical parents, and a symlink whose parents
// are inside the root is exactly the case the guard exists for.

test("a symlink out of the root is refused, however its own parents read", () => {
  const root = join(scratch, "state");
  mkdirSync(join(root, "bin"), { recursive: true });
  const outside = join(scratch, "theirs.txt");
  writeFileSync(outside, "precious");
  // Parents inside the root, target outside it.
  symlinkSync(outside, join(root, "bin", "tonedial"));

  assert.throws(
    () => planChange(join(root, "bin", "tonedial"), () => "ours\n", EN, 0o755, root),
    /outside/,
  );
});

test("a symlink that stays inside the root is allowed", () => {
  const root = join(scratch, "state");
  mkdirSync(join(root, "bin"), { recursive: true });
  const real = join(root, "real.txt");
  writeFileSync(real, "ours");
  symlinkSync(real, join(root, "bin", "tonedial"));

  // The guard is about leaving the root, not about symlinks. Refusing this one would break
  // every user whose state root is itself reached through a link.
  const change = planChange(join(root, "bin", "tonedial"), () => "new\n", EN, 0o755, root);
  assert.equal(change.realPath, realpathSync(real));
});

test("a plain file inside the root is allowed, and one outside is not", () => {
  const root = join(scratch, "state");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "inside.txt"), "a");
  writeFileSync(join(scratch, "outside.txt"), "b");

  assert.doesNotThrow(() => planChange(join(root, "inside.txt"), () => "c", EN, undefined, root));
  assert.throws(() => planChange(join(scratch, "outside.txt"), () => "c", EN, undefined, root), /outside/);
});

test("a non-regular target is refused before its contents are read", () => {
  const target = join(scratch, "not-a-file");
  mkdirSync(target);
  assert.throws(() => planChange(target, () => "c", EN), /not a regular file/);
});

test("a directory symlinked out of the root refuses a file that does not exist yet", () => {
  // The branch both callers take on a fresh install: `init` writes the command where nothing is,
  // and `doctor --fix` repairs a missing one. Skipping containment there left a symlinked `bin/`
  // carrying the write out of the root with no diff and no approval — and asking `inside()`
  // about the path as written does not close it either, because that walk steps over the link
  // lexically and reaches the root through a path the write never takes.
  const root = join(scratch, "state");
  const outside = join(scratch, "elsewhere");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(root, "bin"));

  assert.throws(() => planChange(join(root, "bin", "tonedial"), () => "ours\n", EN, 0o755, root), /outside/);
  assert.deepEqual(readdirSync(outside), [], "the write was planned into someone else's directory");
});

test("a file that does not exist yet inside the root is allowed", () => {
  // The same branch, taken correctly. Refusing this would mean no install could ever write its
  // own command.
  const root = join(scratch, "state");
  mkdirSync(join(root, "bin"), { recursive: true });
  const change = planChange(join(root, "bin", "tonedial"), () => "ours\n", EN, 0o755, root);
  assert.equal(change.before, null);
  assert.equal(change.after, "ours\n");
});


test("the PATH line's state is absent, current, or stale, and doctor acts on the difference", () => {
  const bin = "/home/u/.tonedial/bin";
  assert.equal(pathLineState(null, bin, "/bin/zsh"), "absent");
  assert.equal(pathLineState("# nothing of ours\n", bin, "/bin/zsh"), "absent");

  const written = withPathLine("", bin, "/bin/zsh");
  assert.equal(pathLineState(written, bin, "/bin/zsh"), "current");
  // Pointing somewhere else is what `doctor --fix` repairs, and it has to be told apart from
  // absent: one appends a line and the other rewrites the block.
  assert.equal(pathLineState(written, "/home/u/elsewhere/bin", "/bin/zsh"), "stale");
  // A shell whose spelling differs makes the same line stale, which is why fish is not a
  // cosmetic difference — `export PATH=` is a syntax error there.
  assert.equal(pathLineState(written, bin, "/usr/local/bin/fish"), "stale");
});


test("a delivery of several entries is identified by its set, not by the order they sit in", () => {
  // A provider whose session sources are exact names gets one entry each. Those entries are one
  // delivery: they share a handler, they are written together, and they are removed together.
  const spec: HookSpec = {
    matchers: ["startup", "resume", "clear"],
    handler: { type: "command", command: "/usr/bin/node", args: ["/state/reader.mjs", "--provider", "codex"] },
  };
  const path = "/project/.codex/hooks.json";
  const written = withHook(null, spec, path, EN);
  assert.equal(JSON.parse(written).hooks.SessionStart.length, 3);
  assert.equal(withHook(written, spec, path, EN), written, "a repeat run duplicated an entry");
  assert.equal(hasHook(written, spec, path, EN), true);

  // The order of the entries belongs to whoever last edited the file. Someone adding an
  // unrelated hook, or an editor tidying the array, changes nothing of ours — so it must not
  // change what ours hashes to, or every command would stop recognising an untouched delivery.
  const shuffled = JSON.parse(written) as { hooks: { SessionStart: unknown[] } };
  shuffled.hooks.SessionStart.reverse();
  const reordered = `${JSON.stringify(shuffled, null, 2)}\n`;
  assert.notEqual(reordered, written, "the fixture did not actually reorder the entries");
  assert.equal(ownedHook(reordered, spec, path, EN), ownedHook(written, spec, path, EN));

  // A file missing one of the three is not this delivery: it is neither present nor ours.
  const partial = JSON.parse(written) as { hooks: { SessionStart: unknown[] } };
  partial.hooks.SessionStart.splice(1, 1);
  const missing = `${JSON.stringify(partial, null, 2)}\n`;
  assert.equal(hasHook(missing, spec, path, EN), false, "two of three entries reported as present");
  assert.notEqual(ownedHook(missing, spec, path, EN), ownedHook(written, spec, path, EN));

  // Removal takes all of them and leaves a sibling alone.
  const withSibling = withHook(`${JSON.stringify({
    hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "theirs" }] }] },
  }, null, 2)}\n`, spec, path, EN);
  const removed = JSON.parse(withoutHook(withSibling, spec, path, EN)) as {
    hooks: { SessionStart: Array<{ hooks: Array<{ command?: string }> }> };
  };
  assert.deepEqual(removed.hooks.SessionStart, [{ matcher: "startup", hooks: [{ type: "command", command: "theirs" }] }]);
});

test("a native registration owns every managed event as one complete delivery", () => {
  const events: HookEventSpec[] = [
    { event: "UserPromptSubmit", matchers: [], handler: { type: "command", command: "/reader --event UserPromptSubmit" } },
    { event: "Stop", matchers: [], handler: { type: "command", command: "/reader --event Stop" } },
  ];
  const spec: HookSpec = {
    matchers: ["startup", "resume"],
    handler: { type: "command", command: "/reader" },
    events,
  };
  const path = "/project/.codex/hooks.json";
  const written = withHook(null, spec, path, EN);
  const document = JSON.parse(written) as { hooks: Record<string, unknown[]> };
  assert.deepEqual(Object.keys(document.hooks).sort(), ["SessionStart", "Stop", "UserPromptSubmit"]);
  assert.equal(hasHook(written, spec, path, EN), true);
  assert.equal(withHook(written, spec, path, EN), written, "a repeat run duplicated one event");

  const partial = JSON.parse(written) as { hooks: Record<string, unknown[]> };
  delete partial.hooks.Stop;
  const missing = `${JSON.stringify(partial, null, 2)}\n`;
  assert.equal(hasHook(missing, spec, path, EN), false, "a main hook without Stop was treated as complete");
  assert.notEqual(ownedHook(missing, spec, path, EN), ownedHook(written, spec, path, EN));

  const withForeign = withHook(JSON.stringify({ hooks: {
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "foreign-start" }] }],
    Stop: [{ hooks: [{ type: "command", command: "foreign-stop" }] }],
  } }, null, 2) + "\n", spec, path, EN);
  const removed = JSON.parse(withoutHook(withForeign, spec, path, EN)) as { hooks: Record<string, unknown[]> };
  assert.deepEqual(removed.hooks.SessionStart, [{ matcher: "startup", hooks: [{ type: "command", command: "foreign-start" }] }]);
  assert.deepEqual(removed.hooks.Stop, [{ hooks: [{ type: "command", command: "foreign-stop" }] }]);
  assert.equal(removed.hooks.UserPromptSubmit, undefined);
});

test("approval previews escape path and content controls before asking while structured diffs keep raw text", async () => {
  const physical = join(scratch, "actual\u001b[2J\n\u202e.md");
  const alias = join(scratch, "alias\u001b[2J\n\u202e.md");
  const created = join(scratch, "new\u001b[2J\n\u202e.md");
  const context = "context\u001b[2J\u202e 👩‍💻";
  const removed = "old\u001b[2J\u202e 👩‍💻";
  const added = "new\u001b[2J\u202e 👩‍💻";
  const before = `${context}\n${removed}\n`;
  writeFileSync(physical, before);
  symlinkSync(physical, alias);
  const changes = [
    planChange(alias, () => `${context}\n${added}\n`, EN),
    planChange(created, () => `${added}\n`, EN),
  ];
  for (const change of changes) {
    for (const presentation of ["compact", "verbose", "recovery"] as const) {
      let preview = "";
      const order: string[] = [];
      const result = await gate([change], {
        paths: gatePaths,
        dryRun: false, auto: false, verbose: presentation === "verbose",
        recoveryPresentation: presentation === "recovery",
        t: EN, ui: palette("always", {}, false), interactive: () => true,
        out: text => { preview += text; order.push("preview"); },
        ask: async () => {
          order.push("ask");
          // Only permitted paint is removed. An erase/conceal command cannot disappear here.
          const visible = preview.replace(/\x1b\[(?:1|2|22|31|32|33|36|39)m/g, "");
          const controls = [...visible].filter(character => /[\p{Cc}\p{Cf}]/u.test(character)
            && character !== "\n" && character !== "\u200c" && character !== "\u200d");
          assert.deepEqual(controls, [], `${presentation}: ${visible}`);
          assert.match(visible, /\\u\{1b\}\[2J\\u\{a\}\\u\{202e\}\.md/, "the target's controls were not visibly escaped");
          if (presentation !== "recovery") {
            assert.match(visible, /new\\u\{1b\}\[2J\\u\{202e\}/, "added content was not visibly escaped");
            assert.ok(visible.includes("👩‍💻"), "preview sanitization broke an emoji joiner");
          }
          assert.equal(readFileSync(physical, "utf8"), before, "the gate wrote before approval");
          assert.equal(existsSync(created), false, "the gate created a file before approval");
          return "no";
        },
      });
      assert.deepEqual(order, ["preview", "ask"]);
      assert.equal(result.reason, "declined");
      assert.equal(result.applied, false);
      assert.equal(result.diff[0]!.path, change.path);
      assert.equal(result.diff[0]!.realPath, change.realPath);
      assert.ok(result.diff[0]!.lines.some(line => line.includes(change.path)), "machine path text was sanitized");
      if (presentation !== "recovery" && change.before !== null) {
        assert.ok(result.diff[0]!.lines.includes(`  - ${removed}`), "machine removed-line bytes were sanitized");
        assert.ok(result.diff[0]!.lines.includes(`  + ${added}`), "machine added-line bytes were sanitized");
      }
      assert.equal(readFileSync(physical, "utf8"), before, "cancelling changed saved bytes");
      assert.equal(readlinkSync(alias), physical, "cancelling changed the target alias");
      assert.equal(existsSync(created), false, "cancelling created a file");
    }
  }
});
