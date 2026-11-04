// Package-manager updates run only through disposable npm wrappers and package copies.

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { renderDialSvg } from "../scripts/dial-svg.ts";
import { assertGolden, formatCapture, goldenPath } from "./support/golden.ts";
import { cells } from "../src/ui/width.ts";
import { VERSION } from "../src/cli.ts";
import { compareVersions } from "../src/core/selfupdate.ts";

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
else if (args[0] === "view") {
  if (!process.env.TEST_NPM_VIEW) process.exit(1);
  process.stdout.write(process.env.TEST_NPM_VIEW);
} else if (args[0] === "update") {
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

test("approved npm update receipts tell an update from an install that was already current", (t) => {
  const f = fixture(t);
  const updated = f.invoke(["update", "--auto"]);
  assert.equal(updated.code, 0, updated.out + updated.err);
  assert.match(updated.out, /npm update complete · updated to 9\.8\.7/);
  const unchanged = f.invoke(["update", "--auto"]);
  assert.equal(unchanged.code, 0, unchanged.out + unchanged.err);
  assert.match(unchanged.out, /npm update complete · already up to date \(9\.8\.7\)/);
  assert.doesNotMatch(unchanged.out, /updated to/);
});

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const npmView = (latest: string, time: Record<string, string> = {}) => JSON.stringify({
  version: latest,
  time: { created: "2025-01-01T00:00:00.000Z", [VERSION]: "2026-11-01T09:30:00.000Z", [latest]: "2026-11-03T18:00:00.000Z", ...time },
});

test("npm update asks npm for the latest release and shows both versions with their dates", (t) => {
  const f = fixture(t);
  const dry = f.invoke(["update", "--dry-run", "--json"], { TEST_NPM_VIEW: npmView("9.8.7") });
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.equal(dry.value.outcome, "dry-run");
  assert.equal(dry.value.latestVersion, "9.8.7");
  assert.equal(dry.value.installedPublishedAt, "2026-11-01T09:30:00.000Z");
  assert.equal(dry.value.latestPublishedAt, "2026-11-03T18:00:00.000Z");
  assert.equal(dry.value.checkedRemote, true);
  assert.deepEqual(f.calls(), [["view", "tonedial", "version", "time", "--json"]], "the check must use npm's own registry settings and run no update");

  const human = f.invoke(["update"], { TEST_NPM_VIEW: npmView("9.8.7") });
  assert.equal(human.code, 0, human.out + human.err);
  assert.match(human.out, new RegExp(`installed +${escaped(VERSION)} · released 2026-11-01\n`));
  assert.match(human.out, /latest +9\.8\.7 · released 2026-11-03\n/);
  assert.match(human.out, new RegExp(`update available · ${escaped(VERSION)} → 9\\.8\\.7`));
  assert.match(human.out, /approval required/);
  assert.equal(f.calls().some(([command]) => command === "update"), false);

  // A release date npm cannot vouch for is unknown, not displayed responder text.
  const undated = f.invoke(["update", "--dry-run", "--json"], { TEST_NPM_VIEW: npmView("9.8.7", { [VERSION]: "PRIVATE_DATE_2947", "9.8.7": "" }) });
  assert.equal(undated.value.latestVersion, "9.8.7");
  assert.equal(undated.value.installedPublishedAt, null);
  assert.equal(undated.value.latestPublishedAt, null);
  assert.doesNotMatch(undated.out, /PRIVATE_/);
});

test("npm update skips an install that is current or newer than the registry and never offers a downgrade", (t) => {
  const f = fixture(t);
  for (const [latest, pattern] of [[VERSION, /up to date/], ["0.0.1", /newer than the latest release/]] as const) {
    const json = f.invoke(["update", "--auto", "--json"], { TEST_NPM_VIEW: npmView(latest) });
    assert.equal(json.code, 0, json.out + json.err);
    assert.equal(json.value.outcome, "unchanged", latest);
    assert.equal(json.value.replaced, null);
    assert.equal(json.value.installedVersion, VERSION);
    assert.equal(json.value.latestVersion, latest);
    const human = f.invoke(["update"], { TEST_NPM_VIEW: npmView(latest) });
    assert.equal(human.code, 0, human.out + human.err);
    assert.match(human.out, pattern);
    assert.doesNotMatch(human.out, /approval required|Package update|update available/, latest);
    const dry = f.invoke(["update", "--dry-run"], { TEST_NPM_VIEW: npmView(latest) });
    assert.match(dry.out, /--dry-run · nothing written/);
  }
  assert.equal(f.calls().some(([command]) => command === "update"), false, "a current or newer install launched npm update");
  assert.equal(JSON.parse(readFileSync(f.manifest, "utf8")).version, "0.1.0");
});

test("an unavailable npm version check is reported and the package update still runs", (t) => {
  const f = fixture(t);
  for (const reply of [undefined, "PRIVATE_NPM_OUTPUT_2947", "null", JSON.stringify({ version: "PRIVATE_NPM_OUTPUT_2947\n1.0.0", time: {} })]) {
    const result = f.invoke(["update", "--json"], reply === undefined ? {} : { TEST_NPM_VIEW: reply });
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(result.value.outcome, "approval-required");
    assert.equal(result.value.latestVersion, null);
    assert.equal(result.value.installedPublishedAt, null);
    assert.equal(result.value.latestPublishedAt, null);
    assert.equal(result.value.checkedRemote, false);
    assert.doesNotMatch(result.out + result.err, /PRIVATE_/);
  }
  const human = f.invoke(["update"]);
  assert.match(human.out, /latest version could not be checked/);
  assert.match(human.out, /npm update -g tonedial/);
  const approved = f.invoke(["update", "--auto", "--json"]);
  assert.equal(approved.value.outcome, "updated");
  assert.equal(approved.value.installedVersion, "9.8.7");
});

test("update help omits the scope flag it still accepts from earlier releases", (t) => {
  const f = fixture(t);
  const help = f.invoke(["update", "--help"]);
  assert.equal(help.code, 0, help.out + help.err);
  assert.doesNotMatch(help.out, /--global/);
  assert.match(help.out, /--dry-run/);
  assert.equal(f.invoke(["update", "--global", "--dry-run", "--json"]).code, 0);
});

test("versions compare numerically with semver prerelease precedence", () => {
  const ordered = ["0.1.2", "0.1.9", "0.1.13", "0.2.0-alpha", "0.2.0-alpha.1", "0.2.0-alpha.beta", "0.2.0-beta.2", "0.2.0-beta.11",
    "0.2.0-rc.1", "0.2.0", "1.0.0", "10.0.0"];
  for (const [index, left] of ordered.entries()) {
    assert.equal(compareVersions(left, left), 0, left);
    for (const right of ordered.slice(index + 1)) {
      assert.ok(compareVersions(left, right) < 0, `${left} < ${right}`);
      assert.ok(compareVersions(right, left) > 0, `${right} > ${left}`);
    }
  }
  assert.equal(compareVersions("1.0.0+build.2", "1.0.0+build.1"), 0, "build metadata has no precedence");
});

test("npm JSON without approval and dry-run with approval never run npm update or change bytes", (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  const packageBefore = readFileSync(f.manifest, "utf8");
  for (const args of [["--json"], ["--auto", "--dry-run", "--json"]]) {
    const result = f.invoke(["update", ...args]);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(result.value.outcome, args.includes("--dry-run") ? "dry-run" : "approval-required");
    assert.equal(result.value.replaced, null);
    // Nothing was replaced, so the running version is still the installed one.
    assert.equal(result.value.installedVersion, VERSION);
    assert.equal(result.err, "");
  }
  assert.deepEqual(f.calls().filter(([command]) => command !== "view"), []);
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
      const result = f.invoke(["update", "--auto"], { TEST_NPM_PERMISSION: "EACCES", TEST_NPM_VIEW: npmView("9.8.7"), COLUMNS: String(columns) });
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

test("curl update reads the registry packument and reports versions, dates and dry runs without downloading", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "tonedial-curl-update-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const requests: string[] = [];
  let latest = "9.9.9";
  let registry = "";
  const server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url !== "/tonedial") return void response.writeHead(500).end("only the packument may be read");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      "dist-tags": { latest },
      versions: { [latest]: { version: latest, dist: { tarball: `${registry}/package.tgz`, integrity: "sha512-dummy" } } },
      time: { created: "2025-01-01T00:00:00.000Z", [VERSION]: "2026-11-01T09:30:00.000Z", [latest]: "2026-11-03T18:00:00.000Z" },
    }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  registry = `http://127.0.0.1:${address.port}`;
  const invoke = async (...args: string[]) => (await promisify(execFile)(process.execPath, [join(REPO, "dist", "bin.js"), "update", ...args], {
    cwd: scratch, encoding: "utf8", timeout: 10_000,
    env: { HOME: scratch, TONEDIAL_HOME: join(scratch, "state"), TONEDIAL_INSTALL_SHAPE: "curl", TONEDIAL_REGISTRY: registry, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", NO_COLOR: "1", COLUMNS: "80" },
  })).stdout;

  const dry = await invoke("--dry-run");
  assert.match(dry, new RegExp(`installed +${escaped(VERSION)} · released 2026-11-01\n`));
  assert.match(dry, /latest +9\.9\.9 · released 2026-11-03\n/);
  assert.match(dry, new RegExp(`update available · ${escaped(VERSION)} → 9\\.9\\.9`));
  assert.match(dry, /would replace/);
  assert.match(dry, /--dry-run · nothing written/);
  const json = JSON.parse(await invoke("--json"));
  assert.equal(json.outcome, "approval-required");
  assert.equal(json.latestVersion, "9.9.9");
  assert.equal(json.installedPublishedAt, "2026-11-01T09:30:00.000Z");
  assert.equal(json.latestPublishedAt, "2026-11-03T18:00:00.000Z");
  assert.equal(json.checkedRemote, true);

  // 0.0.1 sorts after 0.0.10 as text; neither a current nor an older registry release is installed.
  for (const [release, pattern] of [[VERSION, /up to date/], ["0.0.1", /newer than the latest release/]] as const) {
    latest = release;
    const payload = JSON.parse(await invoke("--auto", "--json"));
    assert.equal(payload.outcome, "unchanged", release);
    assert.equal(payload.replaced, null);
    assert.equal(payload.latestVersion, release);
    const human = await invoke("--dry-run");
    assert.match(human, pattern);
    assert.match(human, /--dry-run · nothing written/);
    assert.doesNotMatch(human, /would replace|update available/);
  }
  assert.deepEqual([...new Set(requests)], ["/tonedial"], "a check downloaded a package or used the abbreviated endpoint");
});
