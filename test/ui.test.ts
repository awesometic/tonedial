// Actual rendered cells, stream boundaries, help discovery and locale coverage.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMAND_NAMES, VERSION, run } from "../src/cli.ts";
import { AXIS_DEFAULT, AXIS_GROUP, AXIS_KIND, AXIS_ORDER } from "../src/core/anchors.ts";
import { LANGUAGES, catalogue } from "../src/core/i18n.ts";
import { parseConfig, SETTING_KEYS } from "../src/core/config.ts";

/** The catalogue for the unit-level render calls. Language coverage is asserted separately. */
const EN = catalogue("en").cli;
import { gaugeBlock, gaugeHeader } from "../src/ui/gauge.ts";
import { isCopyableLine, receiptLines } from "../src/ui/format.ts";
import { palette } from "../src/ui/style.ts";
import { UNKNOWN_WIDTH, cells, maxCells, padEnd, resolveBudget, truncate, wrap } from "../src/ui/width.ts";
import { isDiffBody, isUnbreakable } from "./support/width-contract.ts";

const PLAIN = palette("never", {}, false);

// ── width ────────────────────────────────────────────────────────────────────────────────

test("East Asian Width is read from the table, not guessed", async () => {
  // Each of these was measured against Unicode before the table was generated. They are here
  // because the gauge bug was invisible until someone looked one of them up.
  assert.equal(cells("█"), 1, "FULL BLOCK is Ambiguous — one cell in a Latin locale");
  assert.equal(maxCells("█"), 2, "and two in a CJK one");
  assert.equal(cells("░"), 1, "LIGHT SHADE is Neutral");
  assert.equal(maxCells("░"), 1, "in every locale, which is the mismatch");

  for (const glyph of ["▮", "▯"]) {
    assert.equal(cells(glyph), 1, glyph);
    assert.equal(maxCells(glyph), 1, `${glyph} is Neutral in every locale`);
  }

  assert.equal(cells("선생님"), 6, "Hangul syllables are Wide");
  assert.equal(cells("漢字"), 4, "so are Han ideographs");
  assert.equal(cells("あアん"), 6, "and both kana");
  assert.equal(cells("，。"), 4, "and full-width punctuation");
  assert.equal(cells("ｱﾝ"), 2, "half-width katakana is not");
  assert.equal(cells("abc"), 3);
});

test("the gauge is five cells at every level in every locale", async () => {
  // The defect this module exists for: `█░` measured 6 cells at level 1 and 10 at level 5
  // under a CJK locale, so the bar's width varied with its own value and every column to its
  // right moved with it.
  const axes = { ...AXIS_DEFAULT };
  for (let level = 1; level <= 5; level++) {
    for (const axis of AXIS_ORDER) axes[axis] = level as 1 | 2 | 3 | 4 | 5;
    for (const line of gaugeBlock(axes, PLAIN, EN)) {
      const gauge = /[▮▯]+/.exec(line)![0];
      assert.equal(cells(gauge), 5, `level ${level} narrow`);
      assert.equal(maxCells(gauge), 5, `level ${level} wide`);
    }
  }
});

test("gauge rows stay aligned whatever the levels are", async () => {
  const axes = { ...AXIS_DEFAULT, formality: 1, playfulness: 5, care: 1, refusal: 4 } as typeof AXIS_DEFAULT;
  const columns = gaugeBlock(axes, PLAIN, EN).map((l) => maxCells(l.slice(0, l.indexOf("▮") >= 0 ? l.indexOf("▮") : l.indexOf("▯"))));
  assert.equal(new Set(columns).size, 1, "the gauge starts in the same column on every row");
});

test("combining marks take no cell, and NFC composes what it can", async () => {
  assert.equal(cells("é"), 1, "a decomposed Spanish e-acute is one cell");
  assert.equal(cells("é"), 1, "so is the composed form");
  assert.equal(cells("́"), 0, "a lone combining mark occupies nothing");
});

test("emoji clusters stay aligned and whole when labels are padded, cut or folded", () => {
  for (const cluster of ["👩‍💻", "👍🏽", "🇰🇷", "1️⃣"]) {
    assert.equal(cells(cluster), 2, cluster);
    assert.equal(maxCells(cluster), 2, `${cluster} wide locale`);
    assert.equal(padEnd(cluster, 4), `${cluster}  `);
    assert.equal(truncate(`${cluster} Engineer`, 5), `${cluster} …`);
    assert.deepEqual(wrap(cluster.repeat(3), 4), [cluster.repeat(2), cluster]);
  }
});

test("truncate fits the budget and says something was cut", async () => {
  assert.equal(truncate("short", 40), "short", "what fits is untouched");
  for (const [s, budget] of [["선생님과 아주 긴 한국어 이름", 10], ["a very long latin display name", 12]] as const) {
    const cut = truncate(s, budget);
    assert.ok(maxCells(cut) <= budget, `${cut} is ${maxCells(cut)} cells`);
    assert.match(cut, /…$/, "and it is visibly a truncation");
  }
});

test("padEnd counts cells, which is what a column is made of", async () => {
  assert.equal(maxCells(padEnd("선생님", 10)), 10);
  assert.equal(maxCells(padEnd("abc", 10)), 10);
  assert.equal(padEnd("선생님", 2), "선생님", "never truncates to reach the target");
});

test("wrap folds to the budget, and breaks mid-token when a token cannot fit", async () => {
  for (const line of wrap("guards are off and this sentence is deliberately long enough to fold", 30)) {
    assert.ok(maxCells(line) <= 30, line);
  }
  // Japanese and Chinese put no spaces between words, so a whole sentence arrives as one
  // token. A space-only wrapper emits it as a single over-long line.
  const cjk = "これは日本語の文章で空白がまったく含まれていないため折り返しが必要になります";
  const folded = wrap(cjk, 20);
  assert.ok(folded.length > 1, "one token still folds");
  for (const line of folded) assert.ok(maxCells(line) <= 20, line);
  assert.equal(folded.join(""), cjk, "and nothing is lost");
});

// ── style ────────────────────────────────────────────────────────────────────────────────

test("colour follows explicit flags, environment precedence and the output stream", () => {
  for (const [mode, env, terminal, colored] of [
    ["auto", {}, false, false],
    ["auto", {}, true, true],
    ["auto", { NO_COLOR: "1", FORCE_COLOR: "1" }, true, false],
    ["auto", { TERM: "dumb" }, true, false],
    ["auto", { FORCE_COLOR: "1" }, false, true],
    ["auto", { FORCE_COLOR: "0" }, false, false],
    ["never", { FORCE_COLOR: "1" }, true, false],
    ["always", { NO_COLOR: "1" }, false, true],
  ] as const) {
    const output = palette(mode, env, terminal).accent("tone");
    assert.equal(output, colored ? "\x1b[36mtone\x1b[39m" : "tone", `${mode}: ${JSON.stringify(env)}, terminal=${terminal}`);
  }
});

test("every signal survives with colour stripped", async () => {
  const axes = { ...AXIS_DEFAULT, warmth: 5 } as typeof AXIS_DEFAULT;
  const plain = gaugeBlock(axes, PLAIN, EN).join("\n");
  assert.match(plain, /\*3/, "the moved-from-default marker survives without colour");
  assert.match(plain, /warmth\s+▮▮▮▮▮\s+5/, "and the level is a digit beside its bar");
});

test("only the bars that changed take the accent; the default marker beside them is plain", () => {
  const axes = { ...AXIS_DEFAULT, warmth: 5 } as typeof AXIS_DEFAULT;
  const rows = gaugeBlock(axes, palette("always", {}, true), EN);
  const moved = rows[AXIS_ORDER.indexOf("warmth")]!;
  assert.match(moved, /\x1b\[36m▮▮▮▮▮\x1b\[39m/, "the moved bar takes the accent");
  assert.match(moved, / {2}\*3$/, "and the default it moved from is plain text");
  assert.doesNotMatch(rows[AXIS_ORDER.indexOf("care")]!, /\x1b\[36m/, "a bar at its default is not accented");
});

test("risky levels use theme red while the selected axis remains cyan and monochrome keeps the marker", () => {
  const axes = { ...AXIS_DEFAULT, flattery: 3, critique: 4, refusal: 2, conviction: 5 } as typeof AXIS_DEFAULT;
  const cursor = AXIS_ORDER.indexOf("flattery");
  const color = gaugeBlock(axes, palette("always", {}, true), EN, cursor);
  const selected = color[cursor]!;
  assert.match(selected, /^\x1b\[36m> /, "selection caret retains the focus token");
  assert.match(selected, /\x1b\[36mflattery/, "selection label remains cyan");
  assert.match(selected, /\x1b\[31m▮▮▮▯▯/, "the risky bar uses the terminal's red");
  assert.match(selected, /\x1b\[31m3!/, "the risky current value pairs red with a marker");
  assert.doesNotMatch(color[AXIS_ORDER.indexOf("warmth")]!, /\x1b\[31m/, "ordinary levels are not risk-colored");
  for (const width of [2, 20, 33, 40, 59, 79]) {
    const rows = gaugeBlock(axes, palette("auto", { NO_COLOR: "1" }, true, width), EN, cursor);
    assert.doesNotMatch(rows.join("\n"), /\x1b/);
    for (const [index, axis] of AXIS_ORDER.entries()) {
      assert.ok(maxCells(rows[index]!) <= width, `${width}: ${rows[index]}`);
      assert.equal(rows[index]!.includes("!"), ["critique", "flattery", "conviction", "refusal"].includes(axis), `${width}: ${axis} risk marker`);
    }
  }
  for (const language of LANGUAGES) {
    const copy = catalogue(language).cli;
    const heading = gaugeHeader(palette("never", {}, true, 59), copy);
    assert.ok(heading.includes(copy.artifact.riskMarker), `${language}: minimum preview explains !`);
    assert.ok(heading.includes(copy.artifact.defaultLevelShort), `${language}: minimum preview retains initial values`);
  }
});

// ── axis metadata ────────────────────────────────────────────────────────────────────────

test("every axis has a kind and a group, and the groups are the three the product names", async () => {
  for (const axis of AXIS_ORDER) {
    assert.ok(AXIS_KIND[axis], axis);
    assert.ok(AXIS_GROUP[axis], axis);
  }
  // The effect, not the spelling. Restating the group sequence as a literal would agree with
  // `AXIS_GROUP` by construction and survive any rename; what the grouping is *for* is that the
  // gutter names each group once, in the interface language, which breaks the moment two groups
  // interleave or a locale shows another language's name.
  for (const language of LANGUAGES) {
    const copy = catalogue(language).cli;
    const gutters = gaugeBlock({ ...AXIS_DEFAULT }, PLAIN, copy).map((line) => {
      const [, gutter] = /^ {2}(\S*)/.exec(line) ?? [];
      return gutter ?? "";
    });
    const named = gutters.filter((g) => g !== "");
    assert.deepEqual(named, [...new Set(AXIS_ORDER.map((axis) => copy.artifact.axisGroups[AXIS_GROUP[axis]]))],
      `${language}: each group is labelled once, in its own language`);
  }
  const permission = AXIS_ORDER.filter((a) => AXIS_KIND[a] === "permission");
  assert.deepEqual(permission, ["profanity", "flattery", "refusal", "bravado"]);
  for (const axis of permission) assert.equal(AXIS_DEFAULT[axis], 1, `${axis} floors at 1`);
});

test("measured widths reserve one cursor column and unknown width uses the prose fallback", () => {
  assert.equal(resolveBudget(140), 139);
  assert.equal(resolveBudget(60), 59);
  assert.equal(resolveBudget(40), 39);
  assert.equal(resolveBudget(undefined), UNKNOWN_WIDTH);
});

// ── the gate ─────────────────────────────────────────────────────────────────────────────

let home = "";
let out: string[] = [];
let err: string[] = [];
let restore: (() => void)[] = [];

beforeEach(() => {
  // Keep lexical and physical temporary roots identical so diagnostics do not compose a long
  // two-token arrow line from a `/var` alias and a `/private/var` target.
  home = realpathSync(mkdtempSync(join(tmpdir(), "tonedial-ui-")));
  out = [];
  err = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  // Only CLI strings: Node 22's test child reports through this stream as binary chunks.
  process.stdout.write = ((s: string | Uint8Array) => typeof s === "string" ? (out.push(s), true) : o(s)) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => typeof s === "string" ? (err.push(s), true) : e(s)) as typeof process.stderr.write;
  restore = [() => { process.stdout.write = o; }, () => { process.stderr.write = e; }];
});

afterEach(() => {
  for (const r of restore) r();
  rmSync(home, { recursive: true, force: true });
});

const cli = (...args: string[]) => run(args, { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "" }, join(home, "project"), false);

const initializeState = async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0, err.join(""));
  out = [];
  err = [];
};

test("a fresh init composes every line in the language it was asked for", async () => {
  mkdirSync(join(home, "project"));
  // Fresh on purpose. With no config on disk there is nowhere for the language to come from but
  // the flag, and `ctx.t` — which is resolved from that config — falls back to English. The
  // receipt used to arrive in two languages a sentence apart, and no test after an init could
  // have caught it, because by then the config named the language.
  assert.equal(await cli("init", "--global", "--tools", "codex", "--lang", "ko", "--auto", "--verbose"), 0, err.join(""));
  const receipt = out.join("");
  const ko = catalogue("ko").cli;

  // Three lines the receipt composes rather than quotes, one from each of the places the bug
  // reached: the seed list, the skill state, and the scope footer.
  assert.ok(receipt.includes(ko.wiring.seeded(["__label__"]).replace("__label__", "")), "the seed list is Korean");
  assert.ok(receipt.includes(ko.wiring.skillState("__state__").replace("__state__", "")), "the skill line is Korean");
  assert.ok(receipt.includes(ko.wiring.scopeGlobal), "the scope line is Korean");
  for (const english of [/\bseeded\b/, /\bskill codex\b/, /Configuration scope/]) {
    assert.doesNotMatch(receipt, english, `English survived: ${String(english)}`);
  }
});

for (const language of LANGUAGES) {
  test(`native receipts show the global cover and the Codex action in ${language}`, async () => {
    mkdirSync(join(home, "project"));
    assert.equal(await cli("init", "--global", "--tools", "codex", "--lang", language, "--auto"), 0, err.join(""));
    const global = out.join("");
    assert.match(global, /\/hooks/);
    assert.doesNotMatch(global, /Trust this project|이 프로젝트를 신뢰/);
    assert.match(global, /TONE\.md/);
    out = [];
    assert.equal(await cli("wire", "--here", "codex", "--auto"), 0, err.join(""));
    const inherited = out.join("");
    const localized = catalogue(language).cli;
    const joined = inherited.replace(/\s+/g, "");
    assert.ok(joined.includes(localized.wiring.globalCovers("Codex CLI").replace(/\s+/g, "")), inherited);
    assert.ok(joined.includes(localized.wiring.keepProjectOnly(true).replace(/\s+/g, "")), inherited);
    assert.match(inherited, /^ {2}tonedial unwire codex --global\n {2}tonedial wire codex --here$/m);
    assert.doesNotMatch(inherited, /App activation is unverified|앱 활성화는 확인하지 않았습니다/);
    const receipt = inherited.slice(inherited.indexOf("  Codex CLI:"));
    for (const line of receipt.split("\n")) assert.ok(cells(line) <= UNKNOWN_WIDTH || isUnbreakable(line), line);
    out = [];
    assert.equal(await cli("wire", "--here", "codex", "--auto", "--json"), 0, err.join(""));
    const json = JSON.parse(out.join(""));
    assert.equal(json.root, join(home, "project"));
    assert.equal(json.tools[0].inherited, true);
    assert.equal(json.tools[0].covered, true);
    assert.equal(json.tools[0].path, join(home, ".codex", "hooks.json"));
    assert.equal(json.tools[0].activation, "unverified");
    assert.equal(json.tools[0].configuration, "configured");
    out = [];
    assert.equal(await cli("doctor", "--here"), 0, err.join(""));
    const doctorOut = out.join("");
    assert.match(doctorOut.replace(/\s+/g, " "), /\/hooks → SessionStart → ToneDial/);
    for (const line of doctorOut.split("\n")) {
      assert.ok(maxCells(line) <= UNKNOWN_WIDTH || isUnbreakable(line), `${language} doctor --here overflow: ${line}`);
    }
    const hookPath = join(home, ".codex", "hooks.json");
    const document = JSON.parse(readFileSync(hookPath, "utf8"));
    rmSync(hookPath);
    out = [];
    assert.equal(await cli("doctor", "--here"), 0, err.join(""));
    assert.ok(out.join("").includes(localized.doctor.nativeMissing("", "SessionStart").split("\n")[0]!));
    assert.doesNotMatch(out.join("").replace(/\s+/g, " "), /\/hooks → SessionStart → ToneDial/, "a missing hook must be repaired before enabling it");
    document.hooks.SessionStart[0].hooks[0].statusMessage = "User-edited hook";
    writeFileSync(hookPath, JSON.stringify(document));
    out = [];
    assert.equal(await cli("doctor", "--here"), 0, err.join(""));
    const foreign = out.join("").replace(/\s+/g, "");
    assert.ok(foreign.includes(localized.doctor.nativeEdited(hookPath).replace(/\s+/g, "")));
    assert.doesNotMatch(out.join("").replace(/\s+/g, " "), /\/hooks → SessionStart → ToneDial/, "do not advise enabling a foreign definition");
  });
}

for (const language of LANGUAGES) {
  test(`Claude receipts name workspace trust per scope in ${language}`, async () => {
    mkdirSync(join(home, "project"));
    const localized = catalogue(language).cli;
    const projectTrust = localized.wiring.claudeTrust(false);
    const sharedTrust = localized.wiring.claudeTrust(true);
    // Folding may break CJK prose without a space, so compare with whitespace removed.
    const flat = (text: string) => text.replace(/\s+/g, "");
    // Project first: a project beside an existing global connection gets nothing to trust.
    assert.equal(await cli("init", "--here", "--tools", "claude", "--lang", language, "--auto"), 0, err.join(""));
    assert.ok(flat(out.join("")).includes(flat(projectTrust!)), `${language}: project receipt lost its trust step`);
    out = [];
    assert.equal(await cli("wire", "--global", "claude", "--auto"), 0, err.join(""));
    assert.ok(flat(out.join("")).includes(flat(sharedTrust!)), `${language}: global receipt lost the trust rule`);
    assert.ok(!flat(out.join("")).includes(flat(projectTrust!)), `${language}: global receipt named one project`);
  });
}

test("the Claude context cap notice follows the delivered guide-and-tone size", async () => {
  mkdirSync(join(home, "project"));
  assert.equal(await cli("init", "--here", "--tools", "claude", "--lang", "en", "--auto"), 0, err.join(""));
  const setNote = async (note: string) => {
    out = [];
    assert.equal(await cli("set", `persona.note=${note}`, "--json"), 0, err.join(""));
    const warnings = JSON.parse(out.join("")).warnings as string[];
    // Measure what the installed reader actually hands Claude Code, not the CLI's own formula.
    const state = join(home, "state");
    const reader = spawnSync(process.execPath, [join(state, "reader.mjs"), "--provider", "claude", "--state", state],
      { input: "", encoding: "utf8" });
    assert.equal(reader.status, 0, reader.stderr);
    return { total: [...reader.stdout].length, warnings };
  };
  const notice = (total: number) => EN.artifact.contextCap("10,000", total.toLocaleString("en-US"));
  const base = await setNote("x");
  // Claude Code measures the output without its final newline, so 10,001 written characters fit.
  const atCap = await setNote("x".repeat(2 + 10_000 - base.total));
  assert.equal(atCap.total, 10_001, "the note no longer grows the payload one character at a time");
  assert.deepEqual(atCap.warnings, [], "a payload at the cap is delivered whole");
  const over = await setNote("x".repeat(3 + 10_000 - base.total));
  assert.deepEqual(over.warnings, [notice(10_001)]);
  out = [];
  assert.equal(await cli("doctor", "--here", "--json"), 0, err.join(""));
  const capCheck = JSON.parse(out.join("")).checks.find((check: { name: string }) => check.name === "Claude Code context");
  assert.equal(capCheck?.state, "problem", "doctor did not report the oversized Claude payload");
  assert.equal(capCheck.detail, notice(10_001));
  out = [];
  assert.equal(await cli("off", "--json"), 0, err.join(""));
  assert.deepEqual(JSON.parse(out.join("")).warnings, [], "paused delivery sends no hook context");
  out = [];
  assert.equal(await cli("doctor", "--here", "--json"), 0, err.join(""));
  assert.ok(!JSON.parse(out.join("")).checks.some((check: { name: string }) => check.name === "Claude Code context"));
  out = [];
  assert.equal(await cli("on", "--json"), 0, err.join(""));
  assert.deepEqual(JSON.parse(out.join("")).warnings, [notice(10_001)], "resumed delivery is oversized again");
  const settingsPath = join(home, "project", ".claude", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(settingsPath, "utf8")), disableAllHooks: true }));
  out = [];
  assert.equal(await cli("doctor", "--here", "--json"), 0, err.join(""));
  assert.ok(!JSON.parse(out.join("")).checks.some((check: { name: string }) => check.name === "Claude Code context"),
    "disabled hooks deliver nothing, which doctor already reports");
});

test("hosts without Claude Code get no Claude context cap notice", async () => {
  mkdirSync(join(home, "project"));
  assert.equal(await cli("init", "--here", "--tools", "codex", "--lang", "en", "--auto"), 0, err.join(""));
  out = [];
  assert.equal(await cli("set", `persona.note=${"x".repeat(12_000)}`, "--json"), 0, err.join(""));
  assert.deepEqual(JSON.parse(out.join("")).warnings, []);
  out = [];
  assert.equal(await cli("doctor", "--here", "--json"), 0, err.join(""));
  assert.ok(!JSON.parse(out.join("")).checks.some((check: { name: string }) => check.name === "Claude Code context"));
});

test("short receipts start with their result; plan commands and the full view keep a title", async () => {
  mkdirSync(join(home, "project"));
  await initializeState();
  for (const argv of [["set", "verbosity=2"], ["get"], ["get", "verbosity"], ["off"], ["on"], ["use", "bratty-kid"],
    ["reset"], ["list"], ["persona", "A patient mentor", "A new developer"], ["address", "your mentor", "friend"], ["compile"], ["export", "caring-brother"]]) {
    out = [];
    assert.equal(await cli(...argv), 0, `${argv.join(" ")}: ${err.join("")}`);
    const screen = out.join("");
    assert.ok(!screen.includes("ToneDial · "), `${argv.join(" ")} printed a title:\n${screen}`);
    assert.ok(!screen.startsWith("\n"), `${argv.join(" ")} starts with a blank line:\n${screen}`);
  }
  for (const argv of [["wire", "codex", "--here", "--dry-run"], ["doctor", "--here"], ["init", "--here", "--tools", "none", "--auto"]]) {
    out = [];
    assert.equal(await cli(...argv), 0, `${argv.join(" ")}: ${err.join("")}`);
    assert.ok(out.join("").startsWith(`ToneDial · ${argv[0]}\n\n`), `${argv.join(" ")} lost its title`);
  }
  out = [];
  assert.equal(await cli("show"), 0, err.join(""));
  assert.ok(out.join("").startsWith("ToneDial · show"), "show lost its title");
});

test("a dry run that would change files ends with the command that applies it", async () => {
  mkdirSync(join(home, "project"));
  const last = () => out.join("").trimEnd().split("\n").at(-1);
  for (const [argv, apply] of [
    [["init", "--here", "--tools", "codex", "--lang", "en", "--dry-run"], "tonedial init --lang en --tools codex --here"],
  ] as const) {
    out = [];
    assert.equal(await cli(...argv), 0, err.join(""));
    assert.equal(last(), `  ${apply}`, out.join(""));
  }
  await initializeState();
  for (const [argv, apply] of [
    [["wire", "codex", "--here", "--dry-run"], "tonedial wire codex --here"],
    [["create", "Example", "--slug", "example", "--dry-run"], "tonedial create Example --slug example"],
  ] as const) {
    out = [];
    assert.equal(await cli(...argv), 0, err.join(""));
    assert.equal(last(), `  ${apply}`, out.join(""));
  }
  assert.equal(await cli("wire", "codex", "--here", "--auto"), 0, err.join(""));
  for (const [argv, apply] of [
    [["unwire", "codex", "--here", "--dry-run"], "tonedial unwire codex --here"],
    [["eject", "--here", "--dry-run"], "tonedial eject --here"],
  ] as const) {
    out = [];
    assert.equal(await cli(...argv), 0, err.join(""));
    assert.equal(last(), `  ${apply}`, out.join(""));
  }
  rmSync(join(home, "project", ".codex"), { recursive: true });
  out = [];
  assert.equal(await cli("doctor", "--fix", "--here", "--dry-run"), 0, err.join(""));
  assert.equal(last(), "  tonedial doctor --fix --here", out.join(""));
  // Nothing to change, nothing to apply.
  assert.equal(await cli("doctor", "--fix", "--here", "--auto"), 0, err.join(""));
  out = [];
  assert.equal(await cli("wire", "codex", "--here", "--dry-run"), 0, err.join(""));
  assert.doesNotMatch(out.join(""), /^ {2}tonedial wire/m, out.join(""));
});

test("a refused connection command writes no title or scope to stdout", async () => {
  mkdirSync(join(home, "project"));
  await initializeState();
  const configPath = join(home, "state", "config.json");
  const before = readFileSync(configPath, "utf8");
  // Approval is needed and there is no terminal to give it in.
  assert.equal(await cli("wire", "codex", "--here"), 1);
  assert.equal(out.join(""), "", "the refusal printed a title or a resolved scope");
  assert.ok(err.join("").includes("tonedial wire codex --here --auto"), err.join(""));
  assert.equal(readFileSync(configPath, "utf8"), before, "an unapproved preview changed the settings");
  // Without a scope flag, a folder with its own connection is refused before any scope is assumed.
  assert.equal(await cli("wire", "codex", "--here", "--auto"), 0, err.join(""));
  out = [];
  err = [];
  assert.equal(await cli("unwire", "codex"), 1);
  assert.equal(out.join(""), "", "the refusal printed the global scope it did not use");
  assert.ok(err.join("").includes("tonedial unwire codex --global"), err.join(""));
});

test("an unreadable import keeps its path copyable and reflows the diagnostic", async () => {
  for (const language of LANGUAGES) {
    await cli("init", "--here", "--tools", "none", "--auto", "--lang", language);
    out = []; err = [];
    const path = join(home, "a missing preset with spaces.json");
    assert.equal(await run(["import", path], {
      HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: "40",
    }, join(home, "project"), false, false), 1);
    const [target, ...diagnostic] = err.join("").trimEnd().split("\n");
    assert.equal(err.join("").split(path).length - 1, 1, `${language}: the diagnostic repeated the target`);
    assert.equal(target, path, `${language}: the path was split or lost`);
    assert.ok(diagnostic.length > 1, `${language}: the diagnostic did not reflow`);
    for (const line of diagnostic) assert.ok(maxCells(line) <= resolveBudget(40), `${language}: ${line}`);
  }
});

test("slash-command prose wraps while arbitrary paths with spaces and indented commands stay whole", async () => {
  const hookGuidance = "/hooks → SessionStart: check the ToneDial command and settings source. If hooks are off, set disableAllHooks to false and check workspace trust.";
  const topLevelSpacePath = "/a valid top level file name.json";
  const colonSegmentPath = "/folder: name/file.json";
  const toneNamedPath = "/tone folder/file.json";
  const customRootPath = "/custom-mount/workspace with spaces/my preset file.json";
  const indentedNpmGlobal = "  npm install --global tonedial";
  const indentedInstall = "  curl -fsSL https://raw.githubusercontent.com/awesometic/tonedial/main/install.sh | sh";
  const indentedRollback = "  tonedial doctor --fix --rollback op_1234567890abcdef";
  const trailingDotCommand = "tonedial wire --project .";
  const dotSpaceArgCommand = 'tonedial set persona.note="Mr. Smith"';
  const copyable = [
    topLevelSpacePath,
    colonSegmentPath,
    toneNamedPath,
    customRootPath,
    indentedNpmGlobal,
    indentedInstall,
    indentedRollback,
    trailingDotCommand,
    dotSpaceArgCommand,
  ];
  assert.equal(isCopyableLine(hookGuidance), false);
  for (const line of copyable) {
    assert.equal(isCopyableLine(line), true, line);
    assert.deepEqual(receiptLines(line, 15), [line], line);
  }
  const folded = receiptLines([hookGuidance, ...copyable].join("\n"), 20);
  for (const line of copyable) {
    assert.ok(folded.includes(line), `copyable line must stay whole: ${line}`);
  }
  for (const line of folded) {
    if (copyable.includes(line)) continue;
    assert.ok(maxCells(line) <= 20, `prose line did not wrap at 20 cells: ${line}`);
  }
});

test("eject and unwire receipts name only the connected agents that were disconnected", async () => {
  mkdirSync(join(home, "project"));
  assert.equal(await cli("init", "--here", "--tools", "codex", "--auto"), 0, err.join(""));
  out = [];
  assert.equal(await cli("eject", "--here", "--auto"), 0, err.join(""));
  const receipt = out.join("");
  assert.match(receipt, /Codex CLI: disconnected/);
  assert.doesNotMatch(receipt, /Claude Code.*: disconnected/);
  assert.doesNotMatch(receipt, /Antigravity.*: disconnected/);
});

test("empty disconnect reports not connected when only config formatting changes", async () => {
  mkdirSync(join(home, "project"));
  await initializeState();
  const path = join(home, "state", "config.json");
  const original = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(original.wiring.registrations, {});
  for (const [command, empty] of [[["unwire", "codex"], /Codex CLI: not connected · nothing to change/], [["eject"], /nothing to disconnect/]] as const) {
    for (const json of [false, true]) {
      writeFileSync(path, JSON.stringify(original));
      out = [];
      assert.equal(await cli(...command, "--here", "--auto", ...(json ? ["--json"] : [])), 0, err.join(""));
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);
      assert.notEqual(readFileSync(path, "utf8"), JSON.stringify(original));
      if (json) {
        const result = JSON.parse(out.join(""));
        assert.equal(result.applied, true);
        assert.equal(result.reason, "written");
        assert.deepEqual(result.unlinked, []);
        assert.deepEqual(result.diff.map((change: { path: string }) => change.path), [path]);
      } else {
        const receipt = out.join("").replace(/\s+/g, " ");
        assert.match(receipt, empty);
        assert.doesNotMatch(receipt, /(?:Codex CLI|Claude Code|Antigravity IDE\/Desktop): disconnected/);
      }
    }
  }
});

test("default show keeps all axes before complete role settings within 80 columns", async () => {
  await initializeState();
  await cli("use", "bratty-kid");
  out = [];
  await run(["show"], { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: "80" }, join(home, "project"), false);
  const screen = out.join("");
  const lines = screen.trimEnd().split("\n");
  for (const line of lines) assert.ok(maxCells(line) <= 79 || isUnbreakable(line), line);
  const role = parseConfig(readFileSync(join(home, "state", "config.json"), "utf8")).persona;
  assert.ok(screen.replace(/\s+/g, " ").includes(role.agent!));
  assert.ok(screen.replace(/\s+/g, " ").includes(role.user!));
  assert.ok(screen.indexOf("bravado") < screen.indexOf(EN.artifact.settingsHeading), "settings buried the last axis");
  const header = lines.find((line) => line.includes(EN.artifact.currentLevel));
  assert.ok(header?.includes(EN.artifact.defaultLevelShort), "the header names the column of default levels");
  assert.ok(!header?.includes(EN.artifact.defaultLevel), "show titles it briefly; the dial keeps the long title");
  assert.ok(header?.includes(EN.artifact.riskMarker), "a risky level brings the legend for !");
  assert.match(screen, /verbosity\s+[▮▯]{5}\s+3\s+3/);
  assert.match(screen, /refusal\s+[▮▯]{5}\s+3!\s+\*1/);
  assert.ok(screen.includes(EN.artifact.displaySettings("en")));
  assert.ok(screen.includes(EN.artifact.connectionRecords([])));

  await cli("address", "guide", "friend");
  out = [];
  assert.equal(await run(["show"], { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: "80" }, join(home, "project"), false), 0);
  const withPersona = out.join("");
  for (const line of withPersona.trimEnd().split("\n")) assert.ok(maxCells(line) <= 79 || isUnbreakable(line), line);
  assert.ok(withPersona.includes("guide") && withPersona.includes("friend"), "the viewport hid the persona");
  assert.ok(withPersona.includes("bravado") && withPersona.includes('tonedial save "My Tone"'), "the viewport hid an axis or save action");
});

test("show prints a legend only while its marker is on the screen", async () => {
  const env = { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: "80" };
  const show = async () => {
    out = [];
    assert.equal(await run(["show"], env, join(home, "project"), false), 0);
    const text = out.join("");
    return { text, header: text.split("\n").find((line) => line.includes(EN.artifact.currentLevel))! };
  };
  // Not set up: every axis at its default, nothing risky and nothing to save, so no key is printed.
  let screen = await show();
  assert.ok(screen.header.includes(EN.artifact.defaultLevelShort));
  assert.ok(!screen.header.includes(EN.artifact.riskMarker), "no risky level, no legend for !");
  assert.ok(!screen.text.includes(EN.artifact.movedFromDefault), "no changed axis, no legend for *");
  assert.ok(!screen.text.includes(EN.preset.changesNotSaved));

  // A preset changes axes without any being risky, and its saved state still matches.
  await initializeState();
  assert.equal(await cli("use", "caring-brother"), 0);
  screen = await show();
  assert.ok(screen.text.includes(`* ${EN.artifact.movedFromDefault}`), "the changed axes bring the legend for *");
  assert.ok(!screen.header.includes(EN.artifact.riskMarker));

  // An edit that is risky and unsaved needs both keys and the save notice.
  assert.equal(await cli("set", "refusal=3"), 0);
  screen = await show();
  assert.ok(screen.header.includes(EN.artifact.riskMarker), "a risky level brings the legend for !");
  assert.ok(screen.text.includes(`* ${EN.artifact.movedFromDefault} · ${EN.preset.changesNotSaved}`));

  // With every axis back at its default only the save notice remains, with no * to explain.
  assert.equal(await cli("reset"), 0);
  screen = await show();
  assert.ok(!screen.text.includes(EN.artifact.movedFromDefault));
  assert.ok(screen.text.split("\n").includes(`  ${EN.preset.changesNotSaved}`), screen.text);
});

test("show leaves out the language of a root that is not set up and the install rows of a preview", async () => {
  const env = { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: "80" };
  const show = async (...args: string[]) => {
    out = [];
    assert.equal(await run(["show", ...args], env, join(home, "project"), false), 0);
    return out.join("");
  };
  // Before init the language is a default nobody chose, so the row is not printed in any language.
  for (const language of LANGUAGES) {
    const copy = catalogue(language).cli;
    out = [];
    assert.equal(await run(["show"], { ...env, LANG: { en: "en_US.UTF-8", ko: "ko_KR.UTF-8", ja: "ja_JP.UTF-8", zh: "zh_CN.UTF-8", es: "es_ES.UTF-8" }[language] }, join(home, "project"), false), 0);
    assert.ok(!out.join("").includes(copy.artifact.displaySettings("")), `${language}: a root that is not set up has no language row`);
  }
  await initializeState();
  assert.ok((await show()).includes(EN.artifact.displaySettings("en")), "a set-up root shows its language");

  // A preview shows what the preset stores. The language and the connections are the install's.
  await cli("set", "persona.note=Keep answers short.", "safeword=stop the act");
  const complete = await show("royal-advisor");
  assert.ok(complete.includes(EN.persona.callsYou("Your Majesty")), "a complete preset shows its own persona");
  assert.ok(!complete.includes("stop the act") && !complete.includes("Keep answers short."), "and not the current tone's");
  for (const row of [EN.artifact.displaySettings("en"), EN.artifact.connectionRecords([])]) assert.ok(!complete.includes(row), row);

  // A schema-1 preset stores axes only: its screen cannot show a persona, a safeword or a register
  // as the preset's, because they are the current tone's.
  const axesOnly = await show("tough-love");
  assert.ok(axesOnly.includes(EN.preset.axisOnlyPreview));
  for (const current of ["stop the act", "Keep answers short.", "note ", "register", EN.artifact.displaySettings("en"), EN.artifact.connectionRecords([])]) {
    assert.ok(!axesOnly.includes(current), `an axis-only preview does not show ${current}`);
  }
  // Machine output keeps reporting the current install beside the preview.
  out = [];
  assert.equal(await run(["show", "tough-love", "--json"], env, join(home, "project"), false), 0);
  const json = JSON.parse(out.join(""));
  assert.equal(json.preview, true);
  assert.equal(json.language, "en");
  assert.deepEqual(json.connections, []);
});

test("show and explain stack cleanly at 60 columns without changing saved state", async () => {
  await initializeState();
  await cli("set", "persona.user_ref=선생님👩‍💻", "safeword=진심으로 부탁할게");
  const configPath = join(home, "state", "config.json");
  const tonePath = join(home, "state", "TONE.md");
  const before = [readFileSync(configPath, "utf8"), readFileSync(tonePath, "utf8")];
  for (const args of [["show"], ["show", "--explain"]]) {
    out = [];
    err = [];
    assert.equal(await run(args, { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: "60" }, join(home, "project"), false), 0);
    const lines = out.join("").split("\n").filter(Boolean);
    assert.ok(lines.some((line) => line.includes("bravado")), "axis list disappeared");
    for (const line of lines) assert.ok(maxCells(line) <= 59 || isUnbreakable(line), `${maxCells(line)}: ${line}`);
  }
  assert.deepEqual([readFileSync(configPath, "utf8"), readFileSync(tonePath, "utf8")], before);
});

for (const language of LANGUAGES) {
  test(`show exposes role descriptions and counts within terminal width in ${language}`, async () => {
    await initializeState();
    assert.equal(await cli("set", `language=${language}`), 0, err.join(""));
    out = [];
    err = [];
    const user = "Builds small tools and likes careful reviews.";
    const agent = "A TypeScript specialist with ten years of experience who speaks plainly.";
    await cli("set", `persona.user=${user}`, `persona.agent=${agent}`);
    const env = { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: "60" };
    const visible = (text: string) => text.replace(/\s+/g, " ");

    out = [];
    assert.equal(await run(["show"], env, join(home, "project"), false), 0);
    const shown = out.join("");
    // Each count stays with the description it measures.
    assert.ok(visible(shown).includes(`${agent} (${[...agent].length}/200)`));
    assert.ok(visible(shown).includes(`${user} (${[...user].length}/200)`));
    assert.ok(visible(shown).includes(user));
    assert.ok(visible(shown).includes(agent));
    for (const line of shown.trimEnd().split("\n")) assert.ok(maxCells(line) <= 59 || isUnbreakable(line), line);

    out = [];
    assert.equal(await run(["show", "--verbose"], env, join(home, "project"), false), 0);
    const verbose = out.join("");
    const visibleVerbose = visible(verbose);
    assert.equal(visibleVerbose.includes(user), true);
    assert.equal(visibleVerbose.includes(agent), true);
    for (const line of verbose.trimEnd().split("\n")) assert.ok(maxCells(line) <= 59 || isUnbreakable(line), line);

    out = [];
    assert.equal(await run(["show", "--json"], env, join(home, "project"), false), 0);
    const json = JSON.parse(out.join("")) as { persona: { user: string; agent: string } };
    assert.equal(json.persona.user, user);
    assert.equal(json.persona.agent, agent);
  });
}

test("the retired fullscreen flag is absent from help and refuses without writes", async () => {
  await initializeState();
  out = [];
  assert.equal(await cli("set", "--help"), 0);
  assert.doesNotMatch(out.join(""), /--full-screen/);
  const configPath = join(home, "state", "config.json");
  const before = readFileSync(configPath, "utf8");
  for (const args of [["set", "--full-screen", "--json"], ["set", "warmth=4", "--full-screen", "--json"], ["show", "--full-screen", "--json"]]) {
    out = [];
    assert.notEqual(await cli(...args), 0);
    assert.equal(JSON.parse(out.join("")).ok, false);
    assert.doesNotMatch(out.join(""), /\x1b\[/);
    assert.equal(readFileSync(configPath, "utf8"), before);
  }
});

test("measured TTY widths beat stale COLUMNS independently for output and errors", async () => {
  await initializeState();
  const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const stderrColumns = Object.getOwnPropertyDescriptor(process.stderr, "columns");
  Object.defineProperty(process.stdout, "columns", { value: 60, configurable: true });
  Object.defineProperty(process.stderr, "columns", { value: 40, configurable: true });
  restore.push(() => {
    if (stdoutColumns) Object.defineProperty(process.stdout, "columns", stdoutColumns);
    else delete (process.stdout as Partial<NodeJS.WriteStream>).columns;
    if (stderrColumns) Object.defineProperty(process.stderr, "columns", stderrColumns);
    else delete (process.stderr as Partial<NodeJS.WriteStream>).columns;
  });
  const env = { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: "120", NO_COLOR: "1" };
  out = [];
  assert.equal(await run(["show", "--explain"], env, join(home, "project"), true, true), 0);
  for (const line of out.join("").split("\n")) assert.ok(maxCells(line) <= 59 || isUnbreakable(line), line);
  err = [];
  assert.equal(await run(["not-a-command"], env, join(home, "project"), true, true), 2);
  for (const line of err.join("").split("\n")) assert.ok(maxCells(line) <= 39, line);
  err = [];
  assert.equal(await run(["show", "--this-option-name-is-intentionally-long-to-trigger-a-parser-diagnostic"], env, join(home, "project"), true, true), 2);
  for (const line of err.join("").split("\n")) assert.ok(maxCells(line) <= 39, line);
});

test("wide show uses terminal presence independently of forced or disabled colour", async () => {
  await initializeState();
  const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value: 140, configurable: true });
  restore.push(() => {
    if (original) Object.defineProperty(process.stdout, "columns", original);
    else delete (process.stdout as Partial<NodeJS.WriteStream>).columns;
  });
  const before = readFileSync(join(home, "state", "config.json"), "utf8");
  const env = { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: "140" };
  out = [];
  assert.equal(await run(["show"], { ...env, FORCE_COLOR: "1" }, home, false, false), 0);
  const pipe = out.join("").replace(/\x1b\[(?:1|2|22|31|32|33|36|39)m/g, "");
  const pipeRows = pipe.split("\n");
  assert.ok(pipeRows.some(line => line.trim() === EN.artifact.settingsHeading), "a coloured pipe merged settings into the gauge pane");
  assert.ok(pipe.indexOf("bravado") < pipe.indexOf(EN.artifact.settingsHeading), "pipe settings precede the complete axis list");
  out = [];
  assert.equal(await run(["show"], { ...env, COLUMNS: "60", NO_COLOR: "1" }, home, true, false), 0);
  const terminal = out.join("");
  assert.doesNotMatch(terminal, /\x1b/, "NO_COLOR was ignored");
  assert.ok(terminal.split("\n").some(line => line.includes(EN.artifact.currentLevel) && line.includes(EN.artifact.settingsHeading)), "a monochrome wide terminal lost its settings pane");
  for (const line of [...pipeRows, ...terminal.split("\n")]) assert.ok(maxCells(line) <= 139 || isUnbreakable(line), line);
  assert.equal(readFileSync(join(home, "state", "config.json"), "utf8"), before);
});

test("compact gauges and init notices respect narrow physical budgets", async () => {
  await initializeState();
  for (const language of LANGUAGES) {
    await cli("set", `language=${language}`);
    for (const args of [["show"], ["show", "tough-love"], ["show", "--explain"], ["init", "--here", "--tools", "none", "--auto", "--dry-run"], ["init", "--here", "--tools", "none", "--auto", "--dry-run", "--verbose"]]) {
      out = [];
      err = [];
      const columns = args[0] === "init" ? 60 : 40;
      assert.equal(await run(args, { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: String(columns) }, join(home, "project"), false), 0, args.join(" "));
      for (const line of [...out, ...err].join("").split("\n")) {
        assert.ok(maxCells(line) <= columns - 1 || isUnbreakable(line) || isDiffBody(line), `${columns}: ${line}`);
      }
      if (args[0] === "show") assert.ok(out.join("").includes("bravado"));
    }
  }
});

test("show --json names each axis group by its English id in every interface language", async () => {
  await initializeState();
  for (const language of LANGUAGES) {
    assert.equal(await cli("set", `language=${language}`), 0, err.join(""));
    out = [];
    assert.equal(await cli("show", "--json"), 0);
    // The gauge shows the group's name in the interface language; machine output keeps the id.
    assert.deepEqual(JSON.parse(out.join("")).groups, AXIS_GROUP, language);
  }
});

test("every command's --json envelope keeps the keys a consumer reads", async () => {
  // The skill and the slash command are windows onto this output, and nothing pinned it — which
  // is how `use`'s notice array changed length between milestones without a test noticing.
  // The type is pinned, not only the key. `key in parsed` passes for a field that turned into
  // `undefined` or changed shape, which is the whole class of break a consumer would hit —
  // `use`'s notice went from an array to an object during this milestone and a presence check
  // would have called that unchanged.
  const shape = (v: unknown) =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const expected: Record<string, Record<string, string>> = {
    show: {
      preset: "string", preview: "boolean", combinations: "array", unsaved: "boolean", enabled: "boolean",
      axes: "object", defaults: "object", kinds: "object", groups: "object",
      riskAxes: "array", riskThresholds: "object", persona: "object", safeword: "null",
      speech_level: "string", address_frequency: "string", language: "string",
      chars: "number", artifact: "object",
    },
    list: { presets: "array", active: "string", skipped: "array" },
    use: {
      preset: "string", displayName: "string", axes: "object", chars: "number",
      riskAxes: "array", safeword: "null", notice: "object", project: "null",
    },
    compile: {
      path: "string", written: "boolean", chars: "number",
    },
  };
  await initializeState();
  for (const [command, fields] of Object.entries(expected)) {
    out = [];
    err = [];
    const args = command === "use" ? ["use", "tough-love"] : [command];
    assert.equal(await cli(...args, "--json", "--color=always"), 0, command);
    assert.doesNotMatch(out.join(""), /\x1b\[/, `${command}: styled machine stdout`);
    assert.equal(err.join(""), "", `${command}: machine mode wrote human stderr`);
    const parsed = JSON.parse(out.join("")) as Record<string, unknown>;
    for (const [key, type] of Object.entries(fields)) {
      assert.ok(key in parsed, `${command} --json lost ${key}`);
      assert.equal(shape(parsed[key]), type, `${command} --json changed the type of ${key}`);
    }
    assert.equal(parsed.schema, 3, command);
    assert.equal(Object.hasOwn(parsed, "guards"), false, `${command}: retired guard field returned`);
    assert.equal(Object.hasOwn(parsed, "ceilings"), false, `${command}: retired ceiling field returned`);
    assert.equal(Object.hasOwn(parsed, "fixed_width"), false, `${command}: retired field returned`);
    assert.equal(parsed.ok, true, command);
    assert.equal(shape(parsed.warnings), "array", command);
  }
});

test("list keeps original preset names in JSON while bounding human rows", async () => {
  await initializeState();
  const displayName = `Long ${"n".repeat(100)}`;

  assert.equal(await cli("save", displayName, "--json"), 0, err.join(""));
  const { slug } = JSON.parse(out.join("")) as { slug: string };

  out = [];
  assert.equal(await cli("list", "--json"), 0, err.join(""));
  const payload = JSON.parse(out.join("")) as {
    presets: { slug: string; displayName: string }[];
  };
  assert.equal(payload.presets.find((preset) => preset.slug === slug)?.displayName, displayName);

  out = [];
  assert.equal(await cli("list"), 0, err.join(""));
  const group = out.join("").split(/\n[ \t]*\n/).find((block) => block.includes(slug));
  assert.ok(group, `${slug} is missing from human output`);
  assert.match(group, /Long n+…/, "the slug's group must include its visibly truncated display name");
  for (const line of group.split("\n")) {
    assert.ok(maxCells(line) <= UNKNOWN_WIDTH, `${maxCells(line)} cells: ${line}`);
  }
});

test("the version is stated in the source and matches the manifest", async () => {
  const manifest = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as { version: string };
  assert.equal(
    VERSION,
    manifest.version,
    "reading package.json at run time is what breaks the binary packagers, so this is the gate instead",
  );
  out = [];
  assert.equal(await cli("--version"), 0);
  assert.equal(out.join(""), `tonedial ${VERSION}\n`);
  out = [];
  assert.equal(await cli("--version", "--verbose"), 0);
  assert.match(out.join(""), new RegExp(`tonedial ${VERSION} · node \\d+`));
  assert.match(out.join(""), /--json schema 3/);
});

test("no command emits an escape sequence when its output is not a terminal", async () => {
  // The whole `NO_COLOR` contract in one assertion: with colour off there is nothing to strip,
  // which is what makes a piped or redirected run byte-comparable.
  await initializeState();
  await cli("use", "bratty-kid");
  await cli("set", "persona.user_ref=선생님", "safeword=진심으로 부탁할게");
  await cli("show", "--explain");
  await cli("list");
  assert.doesNotMatch(out.join("") + err.join(""), /\x1b\[/);
});

test("no catalogue string shares a line between a command and a sentence, in any locale", () => {
  // A command stands alone or follows a bare label ("Options: tonedial x --help"). Beside prose it
  // wraps mid-command and cannot be copied as a line. Functions are called with sample arguments
  // that name real commands, so a command built from an argument is seen too.
  const COMMAND = /\b(?:tonedial (?:on|off|set|get|test|address|persona|reset|show|create|save|list|edit|update|use|compile|export|import|wire|unwire|init|doctor|eject|--)|npm (?:prefix|root|install|uninstall)\b|curl -)/;
  const samples: unknown[][] = [["show"], ["show", "show"], ["show", ["show"]], ["show", null], [["show"]], [2], [true],
    ["show", "show", "show"], ["show", "show", "show", "show"]];
  const offenders: string[] = [];
  let scanned = 0;
  const scan = (where: string, text: string) => {
    for (const line of text.split("\n")) {
      const at = line.search(COMMAND);
      if (at < 0) continue;
      scanned++;
      const before = line.slice(0, at).trim();
      if (before !== "" && !/^[^.!?。！？]*[:：]$/.test(before)) offenders.push(`${where}: ${line.trim()}`);
    }
  };
  const walk = (where: string, value: unknown): void => {
    if (typeof value === "string") scan(where, value);
    else if (typeof value === "function") {
      for (const args of samples) {
        try { const text = value(...args); if (typeof text === "string") scan(where, text); } catch { /* wrong arity for this sample */ }
      }
    } else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) walk(`${where}.${key}`, item);
  };
  for (const language of LANGUAGES) walk(language, catalogue(language));
  assert.deepEqual([...new Set(offenders)], []);
  assert.ok(scanned > 500, `only ${scanned} command lines were scanned, so the sweep is not reaching the catalogues`);
});

test("a refusal at 60 columns leaves each command whole on a line of its own, in both locales", async () => {
  await initializeState();
  const env = { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: "60" };
  for (const language of ["en", "ko"]) {
    assert.equal(await cli("set", `language=${language}`), 0, err.join(""));
    for (const argv of [["set", "verbosty=2"], ["get", "verbosty"], ["reset", "verbosty"], ["address", "one"], ["persona", "one"],
      ["use"], ["export"], ["create", "--auto"], ["edit", "preset"], ["edit"]]) {
      out = [];
      err = [];
      assert.equal(await run(argv, env, join(home, "project"), false, false), 1, `${language} ${argv.join(" ")}`);
      const lines = err.join("").split("\n");
      const commands = lines.filter((line) => line.includes("tonedial "));
      assert.ok(commands.length > 0 || argv[0] === "edit" && argv.length === 1, `${language} ${argv.join(" ")} offers a command`);
      for (const line of commands) assert.match(line, /^ *tonedial /, `${language} ${argv.join(" ")}: ${line}`);
    }
    // The file `edit` cannot open is a copy target, so it stands alone however long it is.
    err = [];
    await run(["edit"], env, join(home, "project"), false, false);
    assert.ok(err.join("").split("\n").includes(join(home, "state", "config.json")), `${language}: the config path is whole on its line`);
  }
});

test("list rides the risk mark beside the title, flush right only on a terminal, else under the description", async () => {
  await initializeState();
  assert.equal(await cli("set", "profanity=4", "critique=4", "flattery=3", "conviction=5", "compliance=5", "refusal=2", "bravado=2"), 0, err.join(""));
  assert.equal(await cli("save", "Every Risk At Once", "--slug", "every-risk"), 0, err.join(""));
  const rows = async (columns: number, terminal: boolean) => {
    out = [];
    const env = { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: String(columns), NO_COLOR: "1" };
    assert.equal(await run(["list"], env, join(home, "project"), terminal, false), 0, err.join(""));
    return out.join("").split("\n");
  };
  const piped = await rows(100, false);
  assert.ok(piped.includes("    bratty-kid       Bratty Kid  ! refusal, bravado"), "a pipe gets two spaces, not a column");
  assert.ok(piped.includes("    A cheeky kid who talks back and jokes with you."), "and the description is one line under it");
  assert.ok(piped.some((line) => /^ {2}\* every-risk +Every Risk At Once · active · user preset$/.test(line)), "the active row reads slug, name · states");
  const screen = await rows(80, true);
  const bratty = screen.find((line) => line.includes("bratty-kid"))!;
  assert.equal(maxCells(bratty), 79, "on a terminal the mark ends at the last column, with colour off as well");
  assert.match(bratty, /Bratty Kid {3,}! refusal, bravado$/);
  const narrow = await rows(60, true);
  const at = narrow.findIndex((line) => line.includes("every-risk"));
  assert.deepEqual(narrow.slice(at + 2, at + 4), ["    ! profanity, critique, flattery, conviction,", "      compliance, refusal, bravado"],
    "seven axes fold under the description with a hanging indent");
  assert.doesNotMatch([...piped, ...screen, ...narrow].join("\n"), /harsh language|biased judgments/, "the explanation belongs to show");
  // At 60 columns the name gives way before the words a person scans for, in the longer locales too.
  assert.equal(await cli("use", "caring-brother"), 0, err.join(""));
  assert.equal(await cli("set", "warmth=1"), 0, err.join(""));
  for (const language of ["ko", "es"] as const) {
    assert.equal(await cli("set", `language=${language}`), 0, err.join(""));
    const row = (await rows(60, true)).find((line) => line.includes("caring-brother"))!;
    assert.ok(row.endsWith(catalogue(language).cli.preset.unsaved), `${language}: ${row}`);
    assert.ok(maxCells(row) <= 59, `${language}: ${row}`);
  }
});

test("a risk notice is yellow on stdout and stderr and never the red of a failure", async () => {
  await initializeState();
  mkdirSync(join(home, "project"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  const env = { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: bin };
  // Each command shows the notice where it always has: three receipts on stdout, `set` on stderr.
  for (const [argv, stream] of [
    [["use", "ego-sword"], "out"], [["create", "Risky One", "critique=5", "--auto"], "out"],
    [["test", "codex", "--dry-run"], "out"], [["set", "critique=5"], "err"],
  ] as const) {
    out = [];
    err = [];
    assert.equal(await run([...argv, "--color=always"], env, join(home, "project"), false, false), 0, `${argv[0]}: ${err.join("")}`);
    const shown = (stream === "out" ? out : err).join("");
    assert.match(shown, /\x1b\[33m! critique/, `${argv[0]}: the notice is yellow and keeps its mark`);
    assert.doesNotMatch(shown, /\x1b\[31m! /, `${argv[0]}: and is not painted like a failure`);
  }
});

/**
 * Every human-facing line every command emits, under the worst case the state can reach:
 * a Korean safeword, a Korean address, a note at its cap, and axes at their extremes.
 */
async function everyLine(columns?: number, language = "en"): Promise<{ line: string; from: string }[]> {
  await initializeState();
  assert.equal(await cli("set", `language=${language}`), 0, err.join(""));
  const collected: { line: string; from: string }[] = [];
  const runs: string[][] = [
    ["--help"],
    ["--help", "--verbose"],
    ["--version"],
    ["list"],
    ["use", "bratty-kid"],
    ["set", "safeword=진심으로 부탁할게", "persona.user_ref=선생님", "persona.age=40s"],
    ["set", `persona.note=${"채".repeat(200)}`],
    ["set", ...AXIS_ORDER.map((a) => `${a}=5`)],
    ["save", "Every Risk At Once"],
    ["show"],
    ["show", "--explain"],
    ["show", "tough-love"],
    ["set", ...AXIS_ORDER.map((a) => `${a}=1`)],
    ["show"],
    ["set", "guards=false"],
    ["use", "tough-love"],
    ["reset", "warmth"],
    ["reset"],
    ["compile"],
    ["compile", "--check"],
    ["update"],
    ["update", "--dry-run"],
    // Exercise diagnostic rows without the separate project-path footer width issue.
    ["doctor", "--global"],
    ["doctor", "--global", "--verbose"],
    // A display name has no length cap anywhere in the tool, so this is the input most likely
    // to push a composed row past the budget — and the corpus missed it until a review said so.
    ["save", "A Preset Whose Display Name Nobody Thought To Limit At All"],
    ["save", "이름이 아주 긴 한국어 프리셋 이름을 붙여 보겠습니다"],
    ["export", "tough-love"],
    ["list"],
    ["show"],
    ["nosuchcommand"],
    ["set", "verbosity=9"],
    ["use", "nosuchpreset"],
    ["use", "bratty-kd"],
    ["set", "persona.address.user=x"],
    ["--color=maybe"],
    ["--badflag"],
    ["wire", "--here", "--dry-run"],
    ["wire", "--here", "nosuchtool"],
    ["unwire", "--here", "--dry-run"],
  ];

  for (const argv of runs) {
    out = [];
    err = [];
    await run(argv, {
      HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "",
      ...(columns === undefined ? {} : { COLUMNS: String(columns) }),
    }, join(home, "project"), false);
    const before = collected.length;
    for (const chunk of [...out, ...err]) {
      for (const line of chunk.split("\n")) {
        if (line !== "") collected.push({ line, from: `tonedial ${argv.join(" ")}` });
      }
    }
    // **Every run has to say something.** Without this, anything that made the invocations
    // produce nothing — a rename, a corpus edited down, a `cli` that stopped reaching the
    // capture — would leave the gates below filtering an empty list and reporting green. That
    // is the vacuous pass, and it is the failure mode a move survives precisely because it
    // changes no assertion.
    assert.ok(
      collected.length > before,
      `tonedial ${argv.join(" ")} emitted nothing — the corpus is not exercising the tool`,
    );
  }
  // A floor on the whole corpus, far below the real count. It is a liveness check, so that
  // shrinking the corpus is a failure rather than a quieter gate.
  assert.ok(collected.length > 150, `the corpus collected only ${collected.length} lines`);
  return collected;
}

test("command output reflows to actual cells in each locale and preserves copy targets", async () => {
  for (const language of LANGUAGES) {
    for (const columns of [60, 140, undefined]) {
      const budget = resolveBudget(columns);
      const lines = await everyLine(columns, language);
      const over = lines.filter(({ line }) => maxCells(line) > budget)
        .filter(({ line, from }) => !isUnbreakable(line) && !((from.startsWith("tonedial wire") || from.startsWith("tonedial unwire")) && isDiffBody(line)));
      assert.deepEqual(over.map(({ line, from }) => `${from}: ${maxCells(line)} cells — ${line}`), [], `${language} width ${columns ?? "unknown"}`);
      for (const { line, from } of lines) {
        if (maxCells(line) <= budget) continue;
        const wiring = from.startsWith("tonedial wire") || from.startsWith("tonedial unwire");
        assert.ok(/[/\\]/.test(line) || (wiring && isDiffBody(line)), `${from}: overflow is neither a copy target nor diff body: ${line}`);
      }
    }
  }
});

test("connection scope introduction cannot execute project controls and machine root stays exact", async () => {
  const controlled = join(home, "project\u001b[2J\nFORGED\u202e");
  const env = { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", LANG: "en_US.UTF-8" };
  const before = readdirSync(home);
  for (const color of ["never", "always"]) {
    out = []; err = [];
    assert.equal(await run(["doctor", "--project", controlled, `--color=${color}`], env, home, false, false), 0);
    const visible = out.join("").replace(/\x1b\[(?:1|2|22|31|32|33|36|39)m/g, "");
    assert.doesNotMatch(visible, /[\u001b\u202e]/);
    assert.ok(visible.includes("project\\u{1b}[2J\\u{a}FORGED\\u{202e}"));
    assert.ok(!visible.split("\n").some(line => line.startsWith("FORGED")));
    assert.deepEqual(readdirSync(home), before);
  }
  out = []; err = [];
  assert.equal(await run(["doctor", "--project", controlled, "--json"], env, home, false, false), 0);
  assert.equal(JSON.parse(out.join("")).root, controlled);
  assert.deepEqual(readdirSync(home), before);
});

test("the help screen lists every command the CLI dispatches", async () => {
  out = [];
  await cli("--help");
  const help = out.join("");
  // The list is grouped, and a group is somewhere a command can be left out of. Before the
  // grouping a missing command was impossible by construction; now it is only impossible here.
  for (const name of COMMAND_NAMES) {
    assert.match(help, new RegExp(`\\b${name}\\b`), `${name} is missing from --help`);
  }
});

test("full and command help remain readable at measured widths in both locales", async () => {
  await initializeState();
  for (const language of LANGUAGES) {
    assert.equal(await cli("set", `language=${language}`), 0);
    const copy = catalogue(language).cli;
    for (const columns of [60, 140]) {
      for (const name of [undefined, ...COMMAND_NAMES]) {
        out = [];
        const argv = name === undefined ? ["--help"] : [name, "--help"];
        assert.equal(await run(argv, { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: String(columns) }, home, false), 0);
        const text = out.join("");
        const lines = text.split("\n").filter(Boolean);
        for (const line of lines) assert.ok(maxCells(line) <= columns - 1 || isUnbreakable(line), `${language} ${argv.join(" ")} ${columns}: ${line}`);
        const flatten = (value: string) => value.replace(/\s+/g, " ");
        if (name !== undefined) {
          assert.ok(flatten(text).includes(flatten(copy.help.commands[name as keyof typeof copy.help.commands])), `${name}: purpose missing`);
          assert.ok(text.includes(copy.help.examples), `${name}: examples missing`);
          assert.match(text, new RegExp(`tonedial ${name}\\b`), `${name}: syntax missing`);
        } else {
          assert.ok(text.includes("https://github.com/awesometic/tonedial/issues/new/choose"), `${language}: issue-reporting URL is missing or split`);
          assert.ok(lines.some(line => maxCells(line) > 79) || columns === 60, "wide help still uses the retired cap");
        }
      }
    }
  }
});

test("the gauge block leaves room for a wider terminal to be unnecessary", async () => {
  // 46 cells is the measured worst case — every axis at 5, so every row carries both the
  // moved-from-default marker and a cap mark. It matters because the inline dial adds a cursor
  // column to these same rows, and 33 cells of slack is what pays for that.
  const axes = { ...AXIS_DEFAULT };
  for (let level = 1; level <= 5; level++) {
    for (const axis of AXIS_ORDER) axes[axis] = level as 1 | 2 | 3 | 4 | 5;
    for (const language of LANGUAGES) {
      for (const line of gaugeBlock(axes, PLAIN, catalogue(language).cli)) assert.ok(maxCells(line) <= 46, `${language} ${maxCells(line)}: ${line}`);
    }
  }
});

// ── the catalogue ────────────────────────────────────────────────────────────────────────

test("every catalogue is complete, and en is the fallback that must be", async () => {
  const reference = catalogue("en");
  for (const language of LANGUAGES) {
    const c = catalogue(language);
    assert.deepEqual(Object.keys(c.init).sort(), Object.keys(reference.init).sort(), language);
    assert.deepEqual(Object.keys(c.presets).sort(), Object.keys(reference.presets).sort(), language);
    assert.deepEqual(Object.keys(c.safewords).sort(), Object.keys(reference.safewords).sort(), language);
    for (const axis of AXIS_ORDER) {
      assert.ok(c.axisHints[axis], `${language} is missing a hint for ${axis}`);
    }
  }
});

test("--explain renders the hints in the configured language, and stays in budget", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--lang", "ko", "--auto"), 0);
  out = [];
  assert.equal(await cli("show", "--explain"), 0);
  const lines = out.join("").split("\n").filter((l) => l !== "");
  assert.match(out.join(""), new RegExp(catalogue("ko").axisHints.formality!.owns), "the Korean hint is what a Korean user reads");
  assert.doesNotMatch(out.join(""), /Use the most casual register/, "and never an anchor, which the agent reads");
  for (const line of lines) assert.ok(maxCells(line) <= UNKNOWN_WIDTH, `${maxCells(line)}: ${line}`);
});

test("normal setup stays quiet and --explain describes advisory risk in every language", async () => {
  // Assert the consumed catalogue and the concrete explanation at the CLI boundary.
  for (const language of LANGUAGES) {
    home = realpathSync(mkdtempSync(join(tmpdir(), "tonedial-ui-")));
    // `afterEach` only removes whatever `home` ends as, and this loop moves it once per language.
    const leaked = home;
    restore.push(() => { rmSync(leaked, { recursive: true, force: true }); });
    assert.equal(await cli("init", "--here", "--tools", "none", "--lang", language, "--auto"), 0);
    const copy = catalogue(language);
    const flatten = (text: string) => text.replace(/\s+/g, language === "ja" || language === "zh" ? "" : " ");
    assert.equal(err.join(""), "", `${language}: normal setup must not produce warnings`);
    out = [];
    assert.equal(await cli("show", "--explain"), 0);
    const section = out.join("").split(copy.cli.artifact.riskHeading)[1] ?? "";
    const screen = flatten(section);
    assert.ok(flatten(screen).includes(flatten(copy.cli.notice.riskIntro)), `${language}: advisory limits missing`);
    const concrete = {
      en: [/judgments and work reports/, /falsehood, omission or exaggeration/, /not measured probabilities/],
      ko: [/판단과 작업 보고/, /거짓·누락·과장/, /측정한 확률이 아닙니다/],
      ja: [/判断や作業報告/, /虚偽・省略・誇張/, /測定した確率ではありません/],
      zh: [/判断和工作报告/, /虚假、遗漏或夸张/, /不是测得的概率/],
      es: [/juicios e informes/, /falsedades, omisiones o exageraciones/, /no una probabilidad medida/],
    }[language];
    for (const expected of concrete) assert.match(screen, expected, language);
    assert.doesNotMatch(screen, /G[1-4]|guards|가드/);
    err = [];
    assert.equal(await cli("set", "refusal=2", "flattery=3"), 0);
    out = [];
    err = [];
    assert.equal(await cli("show"), 0);
    assert.ok(flatten(err.join("")).includes(flatten(copy.cli.notice.riskAxes(["flattery", "refusal"]))), `${language}: selected risky axes missing`);
    out = [];
    err = [];
    assert.equal(await cli("list"), 0);
    assert.doesNotMatch(out.join("") + err.join(""), /model response varies|모델 반응은 다릅니다/);
    assert.equal(err.join(""), "", `${language}: a valid library must not produce warnings`);
  }
});

test("--explain names every settable key, and every one of them is settable", async () => {
  // Two halves, and only the second can catch the list drifting from `assign`: a key with no
  // branch there falls through and exits 1. The first is a presence check on the renderer.
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  out = [];
  assert.equal(await cli("show", "--explain"), 0);
  // Scoped because `safeword` and `language` are on the state row too.
  const section = out.join("").split(catalogue("en").cli.artifact.whatElseIsSettable)[1] ?? "";
  for (const key of SETTING_KEYS) assert.ok(section.includes(key), `--explain never names ${key}`);

  // Exercise each declared key through the real assignment and persistence boundary.
  const values: Record<string, string> = {
    safeword: "just tell me", speech_level: "plain", address_frequency: "rarely",
    "persona.age": "30s", "persona.gender": "unspecified",
    "persona.self_ref": "I", "persona.user_ref": "boss", "persona.note": "a build engineer",
    "persona.user": "a careful builder", "persona.agent": "a plain-speaking reviewer",
    language: "en",
  };
  for (const key of SETTING_KEYS) {
    err = [];
    assert.equal(await cli("set", `${key}=${values[key]!}`), 0, `${key}: ${err.join("")}`);
  }
});

test("a mistyped key is answered with the nearest thing set actually takes", async () => {
  await initializeState();
  err = [];
  assert.equal(await cli("set", "safewrd=x"), 1);
  assert.match(err.join(""), /safeword/, "a near-miss on a setting suggests the setting");
  err = [];
  assert.equal(await cli("set", "persona=x"), 1);
  assert.doesNotMatch(err.join(""), /persona\./, "and a bare prefix names no single field");
  err = [];
  assert.equal(await cli("set", "warmthh=3"), 1);
  assert.match(err.join(""), /warmth/, "while an axis typo still reaches the axis");
});

test("the two catalogues carry the same message keys, and every one is reachable", async () => {
  // The `Messages` type makes a missing key a compile error, so what this adds is that neither
  // language has a key the other lacks at runtime — and that walking the whole tree produces a
  // string for every one, which catches a function that throws on its own arguments.
  const walk = (node: unknown, path: string): string[] =>
    typeof node === "function"
      ? [path]
      : typeof node === "object" && node !== null
        ? Object.entries(node).flatMap(([k, v]) => walk(v, `${path}.${k}`))
        : [path];
  const en = walk(catalogue("en").cli, "cli").sort();
  const ko = walk(catalogue("ko").cli, "cli").sort();
  assert.deepEqual(ko, en);
  assert.ok(en.length > 90, `only ${en.length} messages — the catalogue lost most of itself`);
});

/**
 * Ordinary English function words and verbs, none of which is a token this tool asks a user to
 * type — `preset`, `level`, `set`, `use`, `file` and the rest are deliberately absent, because a
 * Korean message that says `tonedial list` or `edit preset` is naming a command form and not
 * lapsing into English. Shared by every Korean scan, so one list is the contract.
 */
const ENGLISH =
  /\b(the|this|that|these|those|your|their|an|is|are|was|were|be|been|not|and|or|but|with|from|into|onto|for|its|you|will|would|can|cannot|could|should|has|have|had|does|there|here|what|when|which|while|who|whose|only|also|than|then|because|before|after|until|takes|needs|means|leaves|keeps|holds|carries|written|reads|nothing|none|something|anything|already|never|always|every|each|both|other|another|same|first|last|next)\b/i;

test("a Korean install speaks Korean where a user actually reads", async () => {
  // **Absence of English, not presence of Korean.** The first version of this test asserted
  // that one Hangul character appeared somewhere in the output, and it passed on screens that
  // were almost entirely English — `show --explain` cleared it on the axis hints alone while
  // every line of the legend around them stayed untranslated. One translated word next to ten
  // untranslated ones is the state this test exists to catch, and matching Korean cannot see it.
  //
  // So the gate is a word list: ordinary English prose that must not survive anywhere a Korean
  // user reads. Axis names, slugs, paths, command names, and `--json` are all deliberately
  // stable and none of them are on it.
  assert.equal(await cli("init", "--here", "--tools", "none", "--lang", "ko", "--auto"), 0);
  for (const argv of [
    ["set", "warmth=4"], ["set", "warmth=4"], ["reset"],
    ["use", "tough-love"], ["show"], ["show", "--explain"], ["list"], ["doctor", "--here"], ["doctor", "--global"],
    // The approval screen. `--dry-run --auto` renders every line the gate would print without
    // waiting on a person, which is the only way a non-interactive test reaches the highest
    // stakes copy in the product: a user is asked here to approve writes to their own files.
    ["init", "--here", "--tools", "none", "--dry-run", "--auto"], ["eject", "--here", "--dry-run", "--auto"],
    ["compile"], ["update"], ["export", "tough-love"],
    // A one-letter display name on purpose: a display name is the user's own text and slugs
    // are Latin-only by design, so anything longer would put English in the output that the
    // tool did not choose and that the gate cannot tell from English the tool did choose.
    ["save", "x"],
    ["save"],
    // `--help` is the largest block of copy in the tool. It is written straight to stdout
    // rather than returned as a CommandResult, which is how it stayed English through an
    // entire migration named after making the output speak the user's language.
    ["--help"], ["--help", "--verbose"], ["show", "--help"],
  ]) {
    out = [];
    assert.equal(await cli(...argv), 0, argv.join(" "));
    // Painted output carries no escape sequences here — `cli` pins a non-TTY profile — so what
    // is scanned is what a user sees. Slugs and axis names are stripped first: they are input
    // tokens and stay English by design, and leaving them in would make this unfixable.
    const prose = stripStable(out.join(""));
    if (argv[0] === "doctor" && argv.includes("--global")) {
      for (const line of out.join("").split("\n")) {
        assert.ok(maxCells(line) <= UNKNOWN_WIDTH || isUnbreakable(line), line);
      }
    }
    const hit = prose.match(ENGLISH);
    assert.equal(hit, null, `${argv.join(" ")} answered in English on "${hit?.[0]}": ...${context(prose, hit)}...`);
  }
  out = [];
  err = [];
  assert.equal(await cli("wire", "--here", "--tools", "other-agent", "--dry-run", "--auto"), 1, "wire --tools other-agent");
  assert.equal(out.join(""), "", "a native refusal writes nothing to stdout");
  const expectedRefusal = catalogue("ko").cli.wiring.unknownTool("other-agent", ["claude", "antigravity", "codex"]);
  assert.equal(
    err.join("").replace(/\s+/g, " ").trim(),
    expectedRefusal.replace(/\s+/g, " ").trim(),
    "native refusal matches the Korean catalogue apart from layout wrapping",
  );
  const refusal = stripStable(err.join(""));
  const refusalHit = refusal.match(ENGLISH);
  assert.equal(refusalHit, null, `wire --tools other-agent answered in English on "${refusalHit?.[0] ?? ""}"`);
  // Errors too — they are what a user hits when something has already gone wrong.
  for (const argv of [
    ["set", "warmth=9"], ["set", "warmthh=3"], ["use", "nosuch"], ["edit", "traits"],
    ["save", "--slug", "missing-preset"], ["import", "/nonexistent.json"], ["wire", "--here", "nosuchtool"], ["edit", "preset"],
  ]) {
    err = [];
    assert.equal(await cli(...argv), 1, argv.join(" "));
    const prose = stripStable(err.join(""));
    const hit = prose.match(ENGLISH);
    assert.equal(hit, null, `${argv.join(" ")} refused in English on "${hit?.[0]}": ...${context(prose, hit)}...`);
  }
});

test("a Korean install speaks Korean where a command does not exist", async () => {
  // The scan above ends on an error loop that asserts exit 1. A name that is not a command
  // exits 2, so neither the stopping answer nor the refusal around it is reachable from there.
  assert.equal(await cli("init", "--here", "--tools", "none", "--lang", "ko", "--auto"), 0);
  for (const argv of [["disable"], ["ejct"], ["toString"]]) {
    err = [];
    assert.equal(await cli(...argv), 2, argv.join(" "));
    const prose = stripStable(err.join(""));
    const hit = prose.match(ENGLISH);
    assert.equal(hit, null, `${argv.join(" ")} answered in English on "${hit?.[0] ?? ""}"`);
  }
});

test("a Korean install still speaks Korean once its config stops parsing", async () => {
  // The scan above drives a healthy root, so neither message a broken one reaches is inside it.
  // `doctor`'s was the English leak — a Korean frame around a hardcoded English reason — and is
  // what this catches today; `doctor --fix`'s was already Korean, so that arm is forward cover
  // for the new string rather than a reproduction. The break keeps the JSON valid so the
  // language is still readable out of the file; an unparseable one falls back to the machine
  // locale by design, which is a different contract.
  assert.equal(await cli("init", "--here", "--tools", "none", "--lang", "ko", "--auto"), 0);
  const configPath = join(home, "state", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.safeword = '그가 "그만"이라고';
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  out = [];
  assert.equal(await cli("doctor", "--here"), 0, err.join(""));
  err = [];
  assert.equal(await cli("doctor", "--here", "--fix", "--auto"), 1);

  for (const [surface, text] of [["doctor", out.join("")], ["doctor --fix", err.join("")]] as const) {
    const prose = stripStable(text);
    const hit = prose.match(ENGLISH);
    assert.equal(hit, null, `${surface} answered in English on "${hit?.[0] ?? ""}"`);
  }
});

/**
 * Everything that stays English by design, removed before the prose is scanned: axis names
 * (CLI input tokens), preset slugs and
 * display names, `tonedial` and its subcommands, flags, filesystem paths, and the artifact's
 * own filename. What is left is sentences, which is what the gate is about.
 */
function stripStable(text: string): string {
  return text
    // Diff body. What a wiring diff shows is `tone.md`, which is English **by design** — it is
    // an instruction the agent reads rather than text a person does, and one English anchor set
    // is what lets the tool work in every language. The gate is about the copy around the diff:
    // whose file this is, what would change, and the question being asked.
    .split("\n").filter((line) => !/^\s*[+-] /.test(line)).join("\n")
    .replace(/\/[^\s]+/g, " ")
    .replace(/(^|\s)--?[a-z][a-z-]*/g, " ")
    // Any slug: lowercase words joined by dashes. User presets carry names the tool never chose.
    .replace(/\b[a-z0-9]+(-[a-z0-9]+)+\b/g, " ")
    .replace(/\btonedial\b|\bToneDial\b/g, " ")
    .replace(new RegExp(`\\b(${AXIS_ORDER.join("|")})\\b`, "g"), " ")
    .replace(/\b(tone\.md|config\.json|SKILL\.md|npm|npx|curl|init|show|list|doctor|wire|unwire|eject|compile|export|import|save|reset|edit|update|use|set|none|G1|G2|G3|G4)\b/g, " ")
    // `doctor`'s check names. They are identifiers, not prose: the same strings are the `name`
    // field in `--json`, which the skill reads, and a screen that called a check something
    // other than what the payload calls it would make the two disagree about what was checked.
    .replace(/\b(PATH line|install|seeds|skill)\b/g, " ")
    // Node's errno strings. `ENOENT: no such file or directory` is the operating system
    // talking, not this tool, and no catalogue can reach it.
    .replace(/\b[A-Z]{4,}: [^,\n]+/g, " ")
    .replace(/\b(Caring Brother|Bratty Kid|Eager Sycophant|Tough Love|Terse Operator)\b/g, " ")
    .replace(/\b(caring-brother|bratty-kid|eager-sycophant|tough-love|terse-operator)\b/g, " ")
    .replace(/\b(Claude Code|Codex CLI|Antigravity IDE\/Desktop|EDITOR|VISUAL|PATH|JSON|auto|always|never)\b/g, " ");
}

/** The words either side of a hit, so a failure names the sentence rather than the word. */
function context(prose: string, hit: RegExpMatchArray | null): string {
  if (!hit) return "";
  return prose.slice(Math.max(0, hit.index! - 60), hit.index! + 60).replace(/\s+/g, " ");
}

test("the language falls back to the locale when the config cannot be read", async () => {
  // A config too broken to parse still has to produce a message, and that message should be in
  // the language the machine is set to — the file that names the language is the broken one.
  writeFileSync(join(home, "config.json"), "{ not json");
  err = [];
  assert.equal(await run(["show"], { TONEDIAL_HOME: home, LANG: "ko_KR.UTF-8" }, home, false, false), 1);
  assert.match(err.join(""), /[가-힣]/, "a broken config answered in English");
});

for (const language of LANGUAGES) {
  test(`native setup copy fits the width contract at a realistic destination in ${language}`, async () => {
    // The corpus test measures whatever destination the temporary root happens to produce, so a
    // short root lets every line carrying a path pass by construction. This one names the length
    // instead: a project path the size of one a person actually works in, held fixed, so the copy
    // this batch added is measured where it will really be read.
    const deep = join(home, "project", "Developer", "customer-platform-with-a-long-name", "services", "billing-api");
    mkdirSync(deep, { recursive: true });
    assert.ok(deep.length > 90, `the fixture destination is only ${deep.length} characters`);

    const emitted: string[] = [];
    const collect = async (...args: string[]) => {
      out = [];
      err = [];
      const code = await cli(...args, "--color", "never");
      emitted.push(...out.join("").split("\n"), ...err.join("").split("\n"));
      return code;
    };
    // Only init takes the language; every later command reads it back from the saved state.
    assert.equal(await collect("init", "--global", "--tools", "codex", "--lang", language, "--auto"), 0, err.join(""));
    // A project reached through a long path: the covered receipt and doctor's own rows name it.
    assert.equal(await collect("wire", "codex", "--project", deep, "--auto"), 0, err.join(""));
    assert.equal(await collect("doctor", "--project", deep), 0, err.join(""));
    assert.equal(await collect("unwire", "codex", "--project", deep, "--auto"), 0, err.join(""));

    // Liveness first: a filter that stopped matching would otherwise measure nothing and pass.
    assert.ok(emitted.some((line) => line.includes(deep)), "no emitted line named the long destination");
    const over = emitted
      .filter((line) => maxCells(line) > UNKNOWN_WIDTH)
      .filter((line) => !isUnbreakable(line) && !isDiffBody(line));
    assert.deepEqual(over.map((line) => `${maxCells(line)} cells — ${line}`), []);
  });
}

test("valid legacy width input cannot cap measured output or cause a read-only write", async () => {
  // The unit above proves the arithmetic. This proves the number reaches the renderers — which
  // is the part that broke when the budget was a module constant imported at thirty-four sites.
  const wide = (...args: string[]) =>
    run(args, { HOME: home, TONEDIAL_HOME: join(home, "state"), PATH: "", COLUMNS: "120" }, join(home, "project"), false);

  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0, err.join(""));

  out = [];
  assert.equal(await wide("show", "--explain"), 0, err.join(""));
  const widened = out.join("").split("\n");
  assert.ok(
    widened.some((line) => maxCells(line) > UNKNOWN_WIDTH),
    "a measured terminal should use space beyond the unknown-width fallback",
  );
  for (const line of widened) {
    assert.ok(maxCells(line) <= 119 || isUnbreakable(line) || isDiffBody(line), line);
  }

  const configPath = join(home, "state", "config.json");
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  raw.fixed_width = true;
  const legacyBytes = JSON.stringify(raw, null, 2) + "\n";
  writeFileSync(configPath, legacyBytes);
  out = [];
  assert.equal(await wide("show", "--explain"), 0, err.join(""));
  assert.deepEqual(out.join("").split("\n"), widened, "old input still caps the view");
  assert.equal(readFileSync(configPath, "utf8"), legacyBytes, "read-only output canonicalized stored input");
});
