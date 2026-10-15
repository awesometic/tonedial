import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";

import { AXIS_ORDER } from "../src/core/anchors.ts";
import { AGE_BANDS, GENDERS, SETTING_KEYS } from "../src/core/config.ts";
import { LANGUAGES, catalogue, type Language } from "../src/core/i18n.ts";
import { humanText } from "../src/ui/format.ts";
import { maxCells } from "../src/ui/width.ts";
import { captureCli, createGoldenWorkspace, type GoldenWorkspace } from "./support/golden.ts";

function workspace(t: TestContext): GoldenWorkspace {
  const value = createGoldenWorkspace("en");
  t.after(() => value.dispose());
  return value;
}

async function init(value: GoldenWorkspace, language: Language = "en"): Promise<void> {
  const result = await captureCli(value, ["init", "--global", "--tools", "none", "--lang", language, "--auto", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function snapshot(root: string) {
  return [root, ...readdirSync(root, { recursive: true, withFileTypes: true }).map(entry => join(entry.parentPath, entry.name))]
    .sort().map(path => {
      const stat = lstatSync(path, { bigint: true });
      return { path: relative(root, path), mode: stat.mode, ino: stat.ino, mtime: stat.mtimeNs, ctime: stat.ctimeNs,
        contents: stat.isFile() ? readFileSync(path) : stat.isSymbolicLink() ? readlinkSync(path) : null };
    });
}

test("get reads the actual set values and agrees with show without changing files", async t => {
  const value = workspace(t);
  await init(value);
  const note = "현재 역할의 전체 설명 — Unicode 👩‍💻";
  const set = await captureCli(value, ["set", "warmth=2", "language=ko", "speech_level=rough", "safeword=plain answer please",
    "persona.age=31", "persona.gender=neutral", "persona.self_ref=", "persona.user_ref=사용자님",
    `persona.note=${note}`, "persona.user=개발자", "persona.agent=Fictional reviewer", "--json"]);
  assert.equal(set.status, 0, set.stdout + set.stderr);
  const before = snapshot(value.root);
  const get = await captureCli(value, ["get", "--json", "--color=always"]);
  const payload = JSON.parse(get.stdout);
  assert.equal(get.status, 0);
  assert.equal(get.stderr, "");
  assert.equal(payload.schema, 3);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.warnings, []);
  assert.deepEqual(Object.keys(payload.values), [...AXIS_ORDER, ...SETTING_KEYS]);
  assert.equal(payload.values.warmth, 2);
  const expected = { safeword: "plain answer please", speech_level: "rough", language: "ko",
    "persona.age": "30s", "persona.gender": "neutral", "persona.self_ref": null, "persona.user_ref": "사용자님",
    "persona.note": note, "persona.user": "개발자", "persona.agent": "Fictional reviewer" };
  for (const [key, current] of Object.entries(expected)) assert.equal(payload.values[key], current, key);
  for (const key of ["warmth", "persona.self_ref", "persona.note"]) {
    const selected = await captureCli(value, ["get", key, "--json"]);
    assert.deepEqual(JSON.parse(selected.stdout).values, { [key]: payload.values[key] });
  }
  const show = JSON.parse((await captureCli(value, ["show", "--json"])).stdout);
  for (const axis of AXIS_ORDER) assert.equal(show.axes[axis], payload.values[axis], axis);
  assert.equal(show.persona.note, note);
  assert.equal(show.persona.address.self_ref, null);
  assert.equal(show.persona.user, payload.values["persona.user"]);
  assert.equal(show.persona.agent, payload.values["persona.agent"]);
  assert.equal(show.language, payload.values.language);
  assert.equal(show.speech_level, payload.values.speech_level);
  assert.equal(show.safeword, payload.values.safeword);
  assert.deepEqual(snapshot(value.root), before);
});

test("get requires saved configuration and never creates state from defaults", async t => {
  const value = workspace(t);
  const before = snapshot(value.root);
  for (const args of [["get"], ["get", "language"]]) {
    const result = await captureCli(value, [...args, "--json"]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error, catalogue("en").cli.test.missingConfig);
  }
  assert.deepEqual(snapshot(value.root), before);
});

test("get rejects unsupported keys, traversal and extra arguments without writes", async t => {
  const value = workspace(t);
  await init(value);
  const before = snapshot(value.root);
  for (const key of ["__proto__", "constructor", "toString", "wiring", "preset", "persona.address.user_ref", "language=ko"]) {
    const result = await captureCli(value, ["get", key, "--json"]);
    assert.equal(result.status, 1, key);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(Object.hasOwn(JSON.parse(result.stdout), "values"), false);
  }
  const extra = await captureCli(value, ["get", "language", "speech_level", "--json"]);
  assert.equal(extra.status, 2);
  assert.deepEqual(snapshot(value.root), before);
});

test("get reads saved settings even when generated tone is missing", async t => {
  const value = workspace(t);
  await init(value);
  rmSync(join(value.state, "TONE.md"));
  const before = snapshot(value.root);
  const result = await captureCli(value, ["get", "language", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).values, { language: "en" });
  assert.deepEqual(snapshot(value.root), before);
});

test("get refuses an untrusted config link without exposing its target", async t => {
  const value = workspace(t);
  await init(value);
  const foreign = join(value.root, "foreign-config.json");
  writeFileSync(foreign, "PRIVATE_CONFIG_TARGET_4763");
  rmSync(join(value.state, "config.json"));
  symlinkSync(foreign, join(value.state, "config.json"));
  const before = snapshot(value.root);
  const result = await captureCli(value, ["get", "--json"]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_CONFIG_TARGET_4763/);
  assert.deepEqual(snapshot(value.root), before);
});

test("get and show retain complete long note text while escaping terminal controls", async t => {
  const value = workspace(t);
  value.env.COLUMNS = "60";
  await init(value);
  const note = "전체 역할 메모 👩‍💻 ".repeat(30) + "\u001b[2J\nDO_NOT_FAKE_A_ROW";
  const set = await captureCli(value, ["set", `persona.note=${note}`, "--json"]);
  assert.equal(set.status, 0, set.stdout + set.stderr);
  for (const args of [["get"], ["get", "persona.note"], ["show"]]) {
    const result = await captureCli(value, args);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /\u001b/);
    assert.ok(result.stdout.replace(/\s+/g, "").includes(humanText(note).replace(/\s+/g, "")), args.join(" "));
    for (const line of result.stdout.split("\n")) assert.ok(maxCells(line) <= 59, `${args.join(" ")}: ${line}`);
  }
  const raw = await captureCli(value, ["get", "persona.note", "--json"]);
  assert.deepEqual(JSON.parse(raw.stdout).values, { "persona.note": note });
});

test("get key explanations and get/set help reuse localized setting meanings and choices", async t => {
  for (const language of LANGUAGES) {
    const value = workspace(t);
    await init(value, language);
    const copy = catalogue(language);
    const flat = (text: string) => text.replace(/\s+/g, "");
    for (const key of ["language", "speech_level"] as const) {
      const result = await captureCli(value, ["get", key]);
      assert.equal(result.status, 0);
      assert.ok(flat(result.stdout).includes(flat(copy.settingHints[key])), `${language}: ${key}`);
    }
    for (const command of ["get", "set"]) {
      const help = await captureCli(value, [command, "--help"]);
      assert.equal(help.status, 0);
      for (const key of [...AXIS_ORDER, ...SETTING_KEYS]) assert.ok(help.stdout.includes(key), `${language}: ${command} help lost ${key}`);
      for (const token of [...AGE_BANDS, ...GENDERS, ...LANGUAGES]) assert.ok(help.stdout.includes(token), `${language}: ${command} help lost ${token}`);
      assert.ok(flat(help.stdout).includes(flat(copy.axisHints.warmth!.low)));
      assert.ok(flat(help.stdout).includes(flat(copy.axisHints.warmth!.high)));
    }
  }
});
