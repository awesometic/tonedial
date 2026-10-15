// Package-manager updates run only through disposable npm wrappers and package copies.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { renderDialSvg } from "../scripts/dial-svg.ts";
import { assertGolden, formatCapture, goldenPath } from "./support/golden.ts";
import { cells } from "../src/ui/width.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function fixture(t: TestContext) {
  const scratch = mkdtempSync(join(tmpdir(), "tonedial-npm-update-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const prefix = join(scratch, "npm prefix");
  const installed = join(prefix, "lib", "node_modules", "tonedial");
  const state = join(scratch, "state");
  const bin = join(scratch, "bin");
  const log = join(scratch, "npm-calls.jsonl");
  for (const directory of [installed, state, bin, join(scratch, "home"), join(scratch, "project")]) mkdirSync(directory, { recursive: true });
  cpSync(join(REPO, "dist"), join(installed, "dist"), { recursive: true });
  const manifest = join(installed, "package.json");
  writeFileSync(manifest, JSON.stringify({ name: "tonedial", version: "0.1.0", type: "module" }));
  const runner = join(scratch, "fake-npm.cjs");
  writeFileSync(runner, `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_NPM_LOG, JSON.stringify(args) + "\\n");
const prefix = process.env.TEST_NPM_PREFIX;
if (args[0] === "prefix") process.stdout.write(prefix + "\\n");
else if (args[0] === "root") process.stdout.write(path.join(prefix, "lib", "node_modules") + "\\n");
else if (args[0] === "update") {
  if (args[args.indexOf("--prefix") + 1] !== prefix) process.exit(99);
  if (process.env.TEST_NPM_PERMISSION) {
    if (process.env.TEST_NPM_LEGACY) process.stderr.write("npm ERR! code " + process.env.TEST_NPM_PERMISSION + "\\nPRIVATE_NPM_ERROR_2947");
    else process.stdout.write(JSON.stringify({error: {code: process.env.TEST_NPM_PERMISSION, detail: "PRIVATE_NPM_ERROR_2947"}}));
    process.exit(7);
  }
  process.stdout.write("PRIVATE_NPM_OUTPUT_2947");
  process.stderr.write("PRIVATE_NPM_ERROR_2947");
  if (process.env.TEST_NPM_FAILURE) process.exit(7);
  const manifest = path.join(prefix, "lib", "node_modules", "tonedial", "package.json");
  const data = JSON.parse(fs.readFileSync(manifest, "utf8"));
  data.version = process.env.TEST_NPM_VERSION || "9.8.7";
  fs.writeFileSync(manifest, JSON.stringify(data));
} else process.exit(98);
`);
  // Multiplexing managers dispatch from the lexical npm name, even through a symlink.
  writeFileSync(join(bin, "tool-manager"), `#!/bin/sh\ncase "$0" in */npm) ;; *) exit 97 ;; esac\nexec "${process.execPath.replaceAll('"', '\\"')}" "${runner.replaceAll('"', '\\"')}" "$@"\n`, { mode: 0o755 });
  symlinkSync("tool-manager", join(bin, "npm"));
  const env: NodeJS.ProcessEnv = {
    HOME: join(scratch, "home"), TONEDIAL_HOME: state,
    PATH: bin, LANG: "en_US.UTF-8", NO_COLOR: "1",
    TEST_NPM_PREFIX: prefix, TEST_NPM_LOG: log,
  };
  const invoke = (args: string[], extra: NodeJS.ProcessEnv = {}, entry = join(installed, "dist", "bin.js")) => {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: join(scratch, "project"), env: { ...env, ...extra }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    return { code: result.status, out: result.stdout, err: result.stderr, value: result.stdout.startsWith("{") ? JSON.parse(result.stdout) : null };
  };
  const calls = (): string[][] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const snapshot = () => readdirSync(state, { recursive: true, withFileTypes: true })
    .map(entry => [relative(state, join(entry.parentPath, entry.name)), entry.isFile() ? readFileSync(join(entry.parentPath, entry.name)).toString("hex") : "directory"])
    .sort(([left], [right]) => left!.localeCompare(right!));
  const setup = invoke(["init", "--global", "--tools", "none", "--auto", "--json"]);
  assert.equal(setup.code, 0, setup.out + setup.err);
  mkdirSync(join(state, "presets", "custom"), { recursive: true });
  writeFileSync(join(state, "presets", "custom", "private-profile.json"), '{"personal":"PRIVATE_SETTINGS_2947"}\n');
  return { scratch, prefix, installed, state, manifest, env, invoke, calls, snapshot };
}

test("approved npm update uses its exact global prefix, accepts wrappers and reports the observed version", (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  const result = f.invoke(["update", "--auto", "--json"]);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(result.value.outcome, "updated");
  assert.equal(result.value.installedVersion, "9.8.7");
  assert.equal(result.value.replaced, "9.8.7");
  assert.equal(result.value.checkedRemote, false, "npm owns its cache/registry resolution");
  assert.deepEqual(f.calls().filter(args => args[0] === "update"), [["update", "-g", "tonedial", "--prefix", f.prefix, "--json"]]);
  assert.deepEqual(f.snapshot(), before, "package updates changed saved application state");
  assert.doesNotMatch(result.out + result.err, /PRIVATE_/);
  assert.equal(result.err, "");
  const unchanged = f.invoke(["update", "--auto", "--json"]);
  assert.equal(unchanged.code, 0, unchanged.out + unchanged.err);
  assert.equal(unchanged.value.outcome, "unchanged");
  assert.equal(unchanged.value.installedVersion, "9.8.7");
  assert.equal(unchanged.value.replaced, null);
});

test("npm JSON without approval and dry-run with approval never launch npm or change bytes", (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  const packageBefore = readFileSync(f.manifest, "utf8");
  for (const args of [["--json"], ["--auto", "--dry-run", "--json"]]) {
    const result = f.invoke(["update", ...args]);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(result.value.outcome, args.includes("--dry-run") ? "dry-run" : "approval-required");
    assert.equal(result.value.replaced, null);
    assert.equal(result.value.installedVersion, null);
    assert.equal(result.err, "");
  }
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(readFileSync(f.manifest, "utf8"), packageBefore);
});

test("npm update refuses a global prefix that owns a different ToneDial copy", (t) => {
  const f = fixture(t);
  const other = join(f.scratch, "other-prefix");
  const otherPackage = join(other, "lib", "node_modules", "tonedial");
  mkdirSync(otherPackage, { recursive: true });
  writeFileSync(join(otherPackage, "package.json"), '{"name":"tonedial","version":"0.1.0"}');
  const result = f.invoke(["update", "--auto", "--json"], { TEST_NPM_PREFIX: other });
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(result.value.ok, false);
  assert.match(result.value.error, /not the global package/);
  assert.equal(f.calls().some(args => args[0] === "update"), false);
  assert.equal(JSON.parse(readFileSync(f.manifest, "utf8")).version, "0.1.0");
});

test("npm package update proceeds with invalid settings and preserves private bytes", (t) => {
  const f = fixture(t);
  const broken = Buffer.from('{"private":"PRIVATE_SETTINGS_2947"');
  writeFileSync(join(f.state, "config.json"), broken);
  const before = f.snapshot();
  const result = f.invoke(["update", "--auto", "--json"]);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(result.value.outcome, "updated");
  assert.equal(result.value.stateIssue, "invalid");
  assert.equal(result.value.stateRecoveryRequired, true);
  assert.ok(result.value.warnings.some((warning: string) => warning.includes("settings are invalid")));
  assert.deepEqual(f.snapshot(), before);
  assert.doesNotMatch(result.out + result.err, /PRIVATE_/);
});

test("npm failure stays a failure and does not expose npm output or claim installation success", (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  const result = f.invoke(["update", "--auto", "--json"], { TEST_NPM_FAILURE: "1" });
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(result.value.ok, false);
  assert.match(result.value.error, /npm update failed/);
  assert.doesNotMatch(result.out + result.err, /PRIVATE_|updated|update complete/);
  assert.equal(JSON.parse(readFileSync(f.manifest, "utf8")).version, "0.1.0");
  assert.deepEqual(f.snapshot(), before);
});

test("npm update checks rename permission on the package parent before launching an update", { skip: process.platform === "win32" || process.getuid?.() === 0 }, (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  const parent = dirname(f.installed);
  chmodSync(parent, 0o555);
  try {
    const result = f.invoke(["update", "--auto", "--json"]);
    assert.equal(result.code, 1, result.out + result.err);
    assert.equal(result.value.ok, false);
    assert.match(result.value.error, /write permission \(EACCES\)/);
    assert.ok(result.value.error.includes(f.prefix));
    assert.match(result.value.error, /Back up.*reinstall/s);
    assert.equal(f.calls().some(args => args[0] === "update"), false);
    assert.deepEqual(f.snapshot(), before);
  } finally { chmodSync(parent, 0o755); }
});

test("npm permission failures report recovery without exposing npm details or changing settings", (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  for (const [code, legacy] of [["EACCES", ""], ["EPERM", "1"]]) {
    const result = f.invoke(["update", "--auto", "--json"], { TEST_NPM_PERMISSION: code, TEST_NPM_LEGACY: legacy });
    assert.equal(result.code, 1, result.out + result.err);
    assert.equal(result.value.ok, false);
    assert.ok(result.value.error.includes(`(${code})`));
    assert.match(result.value.error, /docs\/USAGE.md#npm-permissions/);
    assert.doesNotMatch(result.out + result.err, /PRIVATE_|sudo|update complete/);
    assert.equal(JSON.parse(readFileSync(f.manifest, "utf8")).version, "0.1.0");
    assert.deepEqual(f.snapshot(), before);
  }
});

test("localized npm permission recovery preserves streams, copyable targets and narrow prose", (t) => {
  const f = fixture(t);
  for (const language of ["en", "ko", "ja", "zh", "es"] as const) {
    assert.equal(f.invoke(["set", `language=${language}`, "--json"]).code, 0);
    for (const columns of [40, 80]) {
      const result = f.invoke(["update", "--auto"], { TEST_NPM_PERMISSION: "EACCES", COLUMNS: String(columns) });
      assert.equal(result.code, 1, result.out + result.err);
      assert.match(result.err, /EACCES/);
      assert.ok(result.err.includes(f.prefix));
      assert.ok(result.err.includes("https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#npm-permissions\n"));
      assert.doesNotMatch(result.out + result.err, /PRIVATE_/);
      for (const line of result.err.split("\n")) {
        if (line === f.prefix || line.startsWith("https://")) continue;
        assert.ok(cells(line) <= columns, `${language}/${columns}: ${line}`);
      }
      if ((language === "en" || language === "ko") && columns === 80) {
        const normalize = (value: string) => value.replaceAll(f.scratch, "<ROOT>");
        const capture = { status: result.code!, stdout: normalize(result.out), stderr: normalize(result.err) };
        assertGolden(goldenPath(language, "errors", "npm-permission"), formatCapture(capture));
        assertGolden(join(REPO, "test/golden/images", language, "npm-permission.svg"), renderDialSvg(capture.stdout + capture.stderr, language, "npm-permission"));
      }
    }
  }
});

test("npm success without a verifiable installed version is not reported as an update", (t) => {
  const f = fixture(t);
  const result = f.invoke(["update", "--auto", "--json"], { TEST_NPM_VERSION: "unverified" });
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(result.value.ok, false);
  assert.match(result.value.error, /version could not be verified/);
  assert.doesNotMatch(result.out + result.err, /PRIVATE_|update complete/);
});
