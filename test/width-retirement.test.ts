import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../src/cli.ts";
import { loadConfig } from "../src/core/config.ts";
import { catalogue } from "../src/core/i18n.ts";
import { readJournal } from "../src/core/operations.ts";
import { resolvePaths } from "../src/core/paths.ts";
import { toCompileInput } from "../src/core/resolve.ts";
import { applyRollback, gate, planChange, previewRollback } from "../src/wiring/apply.ts";
import { palette } from "../src/ui/style.ts";

const EN = catalogue("en").cli;

function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "tonedial-width-retirement-")));
  const env = { HOME: home, TONEDIAL_HOME: join(home, "state"), TONEDIAL_AGENT_HOME: join(home, "agent"), PATH: "", LANG: "en_US.UTF-8" };
  const paths = resolvePaths(env);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env, paths };
}

async function invoke(f: ReturnType<typeof fixture>, args: string[], json = true) {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = ((text: string) => { stdout += text; return true; }) as typeof out;
  process.stderr.write = ((text: string) => { stderr += text; return true; }) as typeof err;
  try {
    const code = await run([...args, ...(json ? ["--json"] : ["--color", "never"])], f.env, f.home, false, false);
    return { code, stdout, stderr, value: json ? JSON.parse(stdout) : null };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

function snapshot(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map(entry => {
    const path = join(entry.parentPath, entry.name);
    const stat = statSync(path);
    return { path, mode: stat.mode, ino: stat.ino, mtime: stat.mtimeMs,
      bytes: entry.isFile() ? readFileSync(path) : null };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

test("reading old guard and width state leaves files untouched until an authorized canonical setting write", async t => {
  const f = fixture(t);
  const initialized = await invoke(f, ["init", "--global", "--tools", "none", "--auto"]);
  assert.equal(initialized.code, 0, initialized.stderr);
  const tuned = await invoke(f, ["set", "safeword=dummy plain answer", "speech_level=polite", "persona.note=dummy reviewer"]);
  assert.equal(tuned.code, 0, tuned.stderr);
  const raw = JSON.parse(readFileSync(f.paths.config, "utf8"));
  raw.fixed_width = true;
  raw.guards = false;
  const oldBytes = `${JSON.stringify(raw)}\n\n`;
  writeFileSync(f.paths.config, oldBytes);
  mkdirSync(join(f.paths.presets, "custom"), { recursive: true });
  const custom = join(f.paths.presets, "custom", "my-current-tone.json");
  const flat = join(f.paths.presets, "my-legacy-tone.json");
  writeFileSync(custom, '{"schema":1,"slug":"my-current-tone","displayName":"My tone","values":{"care":2}}\n');
  writeFileSync(flat, '{"displayName":"My older tone","values":{"warmth":4}}\n');
  const before = snapshot(f.paths.root);
  const loaded = loadConfig(f.paths.config, EN);
  assert.equal(Object.hasOwn(loaded, "fixed_width"), false);
  assert.equal(Object.hasOwn(loaded, "guards"), false);
  assert.equal(loaded.safeword, "dummy plain answer");
  for (const args of [["--help"], ["show"], ["doctor"], ["compile", "--check"]]) {
    const result = await invoke(f, args, args[0] !== "--help");
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\u001b/, args.join(" "));
    if (args[0] === "show") {
      assert.equal(Object.hasOwn(result.value, "fixed_width"), false);
      assert.equal(Object.hasOwn(result.value, "guards"), false);
    }
    assert.deepEqual(snapshot(f.paths.root), before, args.join(" "));
  }

  const changed = await invoke(f, ["set", "language=ko"]);
  assert.equal(changed.code, 0, changed.stderr);
  const persisted = JSON.parse(readFileSync(f.paths.config, "utf8"));
  const { fixed_width: _retiredWidth, guards: _retiredGuards, ...expected } = raw;
  assert.deepEqual(persisted, { ...expected, language: "ko" });
  assert.equal(persisted.schema, 2);
  assert.equal(loadConfig(f.paths.config, EN).language, "ko");
  for (const path of [custom, flat]) {
    assert.deepEqual(readFileSync(path), before.find(entry => entry.path === path)!.bytes, path);
  }
});

test("approved recovery discloses invalid obsolete guard and width values without a live source/default and retains raw rollback bytes", async t => {
  const f = fixture(t);
  const initialized = await invoke(f, ["init", "--global", "--tools", "none", "--auto"]);
  assert.equal(initialized.code, 0, initialized.stderr);
  const raw = JSON.parse(readFileSync(f.paths.config, "utf8"));
  raw.fixed_width = "DUMMY_PRIVATE_OBSOLETE_WIDTH";
  raw.guards = "DUMMY_PRIVATE_OBSOLETE_GUARDS";
  const bytes = Buffer.from(`${JSON.stringify(raw)}\n\n`);
  writeFileSync(f.paths.config, bytes, { mode: 0o640 });
  chmodSync(f.paths.config, 0o640);
  const before = snapshot(f.paths.root);
  const original = statSync(f.paths.config);
  assert.throws(() => loadConfig(f.paths.config, EN), /guards/);
  const preview = await invoke(f, ["doctor", "--fix", "--global", "--tools", "none", "--auto", "--dry-run"], false);
  assert.equal(preview.code, 0, preview.stderr);
  assert.ok(preview.stdout.replace(/\s+/g, " ").includes(EN.recovery.obsoleteWidthDiscarded));
  assert.ok(preview.stdout.replace(/\s+/g, " ").includes(EN.recovery.obsoleteGuardsDiscarded));
  assert.doesNotMatch(preview.stdout + preview.stderr, /DUMMY_PRIVATE_OBSOLETE_/);
  assert.deepEqual(snapshot(f.paths.root), before);
  const repaired = await invoke(f, ["doctor", "--fix", "--global", "--tools", "none", "--auto"]);
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.deepEqual(repaired.value.invalid, ["fixed_width", "guards"]);
  assert.ok(!repaired.value.defaulted.includes("fixed_width"));
  assert.ok(!repaired.value.recovered.includes("fixed_width"));
  assert.ok(!repaired.value.defaulted.includes("guards"));
  assert.ok(!repaired.value.recovered.includes("guards"));
  const persisted = JSON.parse(readFileSync(f.paths.config, "utf8"));
  const { fixed_width: _retiredWidth, guards: _retiredGuards, ...expected } = raw;
  assert.deepEqual(persisted, expected);
  assert.doesNotMatch(repaired.stdout + repaired.stderr, /DUMMY_PRIVATE_OBSOLETE_/);
  assert.equal(previewRollback(f.paths, repaired.value.operationId, EN).status, "ready");
  const restored = await invoke(f, ["doctor", "--fix", "--rollback", repaired.value.operationId, "--auto"]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.deepEqual(readFileSync(f.paths.config), bytes);
  assert.equal(statSync(f.paths.config).mode, original.mode);
  assert.equal(statSync(f.paths.config).ino, original.ino);
});

test("retained journals with obsolete guard and width values remain eligible and restore exact older config bytes", async t => {
  const f = fixture(t);
  const initialized = await invoke(f, ["init", "--global", "--tools", "none", "--auto"]);
  assert.equal(initialized.code, 0, initialized.stderr);
  const raw = JSON.parse(readFileSync(f.paths.config, "utf8"));
  const before = Buffer.from(`${JSON.stringify({ ...raw, fixed_width: false, guards: true })}\n\n`);
  const after = `${JSON.stringify({ ...raw, fixed_width: true, guards: false, safeword: "dummy old journal phrase" }, null, 4)}\n`;
  writeFileSync(f.paths.config, before);
  const applied = await gate([planChange(f.paths.config, () => after, EN, undefined, f.paths.root)], {
    paths: f.paths, t: EN, auto: true, dryRun: false, ui: palette("never", {}, false), out: () => {},
    retention: { kind: "migration", reason: "schema" },
  });
  assert.ok(applied.operationId);
  const journal = readJournal(f.paths, applied.operationId)!;
  assert.equal(journal.actions.length, 1);
  assert.deepEqual(Buffer.from((journal.actions[0]!.before as { bytes: string }).bytes, "base64"), before);
  assert.equal(Buffer.from((journal.actions[0]!.after as { bytes: string }).bytes, "base64").toString(), after);
  assert.equal(previewRollback(f.paths, applied.operationId, EN).status, "ready");
  assert.equal(applyRollback(f.paths, applied.operationId, EN).state, "rolled-back");
  assert.deepEqual(readFileSync(f.paths.config), before);
  assert.equal(Object.hasOwn(loadConfig(f.paths.config, EN), "fixed_width"), false);
  assert.equal(Object.hasOwn(loadConfig(f.paths.config, EN), "guards"), false);
});

test("existing init and doctor rebuild disclose selected risky tone without lowering it or mutating a preview", async t => {
  const f = fixture(t);
  const initialized = await invoke(f, ["init", "--global", "--tools", "none", "--auto"]);
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal((await invoke(f, ["set", "refusal=5", "compliance=5", "bravado=5"])).code, 0);
  const raw = JSON.parse(readFileSync(f.paths.config, "utf8"));
  raw.guards = true;
  writeFileSync(f.paths.config, `${JSON.stringify(raw)}\n\n`);
  const expectedSettings = toCompileInput(loadConfig(f.paths.config, EN));
  const before = snapshot(f.paths.root);
  const expectedRisk = ["compliance", "refusal", "bravado"];
  const preview = await invoke(f, ["init", "--global", "--tools", "none", "--auto", "--dry-run"]);
  assert.equal(preview.code, 0, preview.stderr);
  assert.deepEqual(preview.value.riskAxes, expectedRisk);
  assert.ok(preview.value.warnings.includes(EN.notice.riskAxes(expectedRisk)));
  assert.deepEqual(snapshot(f.paths.root), before);
  const humanPreview = await invoke(f, ["init", "--global", "--tools", "none", "--auto", "--dry-run"], false);
  assert.equal(humanPreview.code, 0, humanPreview.stderr);
  const humanOutput = (humanPreview.stdout + humanPreview.stderr).replace(/\s+/g, " ");
  assert.ok(humanOutput.includes(EN.notice.riskAxes(expectedRisk)), "the selected risks remain visible in the preview");
  assert.ok(!humanOutput.includes(EN.notice.riskIntro), "a preview must not repeat the generic product disclaimer");
  assert.deepEqual(snapshot(f.paths.root), before);
  for (const args of [["init", "--global", "--tools", "none", "--auto"], ["doctor", "--fix", "--global", "--tools", "none", "--auto"]]) {
    const result = await invoke(f, args);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.value.riskAxes, expectedRisk, args.join(" "));
    assert.ok(result.value.warnings.includes(EN.notice.riskAxes(expectedRisk)), args.join(" "));
    assert.deepEqual(toCompileInput(loadConfig(f.paths.config, EN)), expectedSettings,
      "rebuild preserves all selected tone settings, including conflicting levels");
  }
});
