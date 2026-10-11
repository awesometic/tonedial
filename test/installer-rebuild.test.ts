// Real compiled candidates, temporary homes and a loopback registry exercise the fresh repair
// entry. Neither a broken installed program nor a malformed state file is used as the bootstrap.

import assert from "node:assert/strict";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

const execFile = promisify(execFileCallback);
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
let scratch: string;
let release: string;
let registry: string;
let registryVersion: string;
let server: Server;

function environment(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: [join(scratch, "bin"), "/usr/bin", "/bin"].join(":"),
    HOME: join(scratch, "home"), XDG_CONFIG_HOME: join(scratch, "xdg"), XDG_CACHE_HOME: join(scratch, "cache"),
    TMPDIR: join(scratch, "tmp"), TONEDIAL_HOME: root, TONEDIAL_AGENT_HOME: join(scratch, "agents"),
    TONEDIAL_REGISTRY: registry, npm_config_cache: join(scratch, "npm-cache"),
    npm_config_userconfig: join(scratch, "npmrc"), npm_config_globalconfig: join(scratch, "globalrc"),
    npm_config_update_notifier: "false", npm_config_offline: "true", SHELL: "/bin/bash", NO_COLOR: "1", LANG: "C", LC_ALL: "C",
    ...extra,
  };
}

function candidate(label: string, badVersion = false): string {
  const path = join(scratch, label, "package");
  mkdirSync(path, { recursive: true });
  cpSync(join(repo, "dist"), join(path, "dist"), { recursive: true });
  cpSync(join(repo, "package.json"), join(path, "package.json"));
  if (badVersion) writeFileSync(join(path, "dist", "bin.js"), "process.stdout.write(JSON.stringify({ok:true,version:'wrong'}) + '\\n');\n");
  return path;
}

function invoke(root: string, source = release, flags: string[] = [], extra: Record<string, string> = {}) {
  return execFile(process.execPath, [join(source, "dist", "install.js"), "--root", root, "--candidate", source, ...flags], {
    encoding: "utf8", env: environment(root, extra), timeout: 60_000,
  });
}

function installerFailure(pattern: RegExp): (cause: unknown) => boolean {
  return (cause: unknown) => {
    const result = JSON.parse((cause as { stdout: string }).stdout);
    assert.equal(result.ok, false);
    assert.equal(result.packageRepair.status, "failed");
    assert.equal(result.stateRepair.status, "not-started");
    assert.match(result.error, pattern);
    return true;
  };
}

const approvedRepair = ["--repair", "--global", "--tools", "none", "--auto", "--json"];

function cli(root: string, args: string[], source = release, extra: Record<string, string> = {}) {
  return execFile(process.execPath, [join(source, "dist", "bin.js"), ...args], {
    encoding: "utf8", env: environment(root, extra), timeout: 60_000,
  });
}

async function initialized(label: string): Promise<string> {
  const root = join(scratch, label, "state");
  await invoke(root);
  await cli(root, ["init", "--global", "--tools", "none", "--auto"]);
  await cli(root, ["set", "warmth=4"]);
  await cli(root, ["save", "keep-me"]);
  return root;
}

function histories(root: string): string[] {
  return readdirSync(join(root, "operations")).filter((name) => name.startsWith("completed-")).map((name) => join(root, "operations", name));
}

function archived(root: string, name: string): string {
  const found = histories(root).filter((path) => existsSync(join(path, name)));
  assert.equal(found.length, 1, `expected one retained ${name} archive`);
  return join(found[0]!, name);
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-installer-rebuild-"));
  for (const name of ["home", "xdg", "cache", "tmp", "agents", "bin"]) mkdirSync(join(scratch, name));
  symlinkSync(process.execPath, join(scratch, "bin", "node"));
  writeFileSync(join(scratch, "npmrc"), "");
  writeFileSync(join(scratch, "globalrc"), "");
  release = candidate("fresh");
  const archive = join(scratch, "release.tgz");
  execFileSync("tar", ["--format=ustar", "-czf", archive, "-C", dirname(release), "package"], { env: environment(join(scratch, "tar-state")) });
  const tarball = readFileSync(archive);
  const version = (JSON.parse(readFileSync(join(release, "package.json"), "utf8")) as { version: string }).version;
  registryVersion = version;
  server = createServer((request, response) => {
    if (request.url === "/tonedial/latest") response.end(JSON.stringify({ version: registryVersion, dist: { tarball: registry + "/package.tgz", integrity: "sha512-" + createHash("sha512").update(tarball).digest("base64") } }));
    else if (request.url === "/package.tgz") response.end(tarball);
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  registry = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("fresh bootstrap repairs a non-runnable modified modern package and retains usable custom data", async () => {
  const root = await initialized("modern");
  const custom = JSON.parse((await cli(root, ["export", "keep-me", "--json"])).stdout);
  const config = readFileSync(join(root, "config.json"));
  const badProgram = Buffer.from([0xff, 0x80, 0x00]);
  writeFileSync(join(root, "lib", "package.json"), badProgram);
  writeFileSync(join(root, "lib", "dist", "bin.js"), badProgram);
  writeFileSync(join(root, "bin", "tonedial"), badProgram);
  chmodSync(join(root, "bin", "tonedial"), 0o710);
  writeFileSync(join(root, "bin", "unrelated"), "unrelated command\n");

  const result = await execFile("/bin/sh", [join(repo, "install.sh"), ...approvedRepair], { env: environment(root), encoding: "utf8", timeout: 60_000 });
  const payload = JSON.parse(result.stdout) as { ok: boolean; packageRepair: { status: string }; stateRepair: { status: number } };
  assert.equal(payload.packageRepair.status, "complete");
  assert.equal(payload.stateRepair.status, 0);
  assert.equal(payload.ok, true);
  assert.deepEqual(readFileSync(join(archived(root, "previous"), "package.json")), badProgram);
  assert.deepEqual(readFileSync(archived(root, "previous-command")), badProgram);
  assert.equal(lstatSync(archived(root, "previous-command")).mode & 0o7777, 0o710);
  assert.equal(readFileSync(join(root, "bin", "unrelated"), "utf8"), "unrelated command\n");
  assert.deepEqual(JSON.parse((await cli(root, ["export", "keep-me", "--json"], join(root, "lib"))).stdout), custom);
  await cli(root, ["use", "keep-me"], join(root, "lib"));
  assert.equal(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).axes.warmth, 4);
  assert.ok(config.length > 0, "initialized state existed before corrupting the program");
  assert.deepEqual(readdirSync(join(scratch, "tmp")).filter((name) => name.startsWith("tonedial.")), []);
});

test("historical flat components are archived individually while unrelated bin siblings and state survive", async () => {
  const root = await initialized("flat");
  rmSync(join(root, "lib"), { recursive: true });
  const command = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff]);
  writeFileSync(join(root, "bin", "tonedial"), command);
  writeFileSync(join(root, "bin", "package.json"), '{"name":"tonedial","version":"0.0.1"}\n');
  for (const name of ["src", "dist"]) {
    mkdirSync(join(root, "bin", name));
    writeFileSync(join(root, "bin", name, "old"), `retained ${name}\n`);
  }
  writeFileSync(join(root, "bin", "helper"), "keep helper\n");
  const preset = JSON.parse((await cli(root, ["export", "keep-me", "--json"])).stdout);

  const result = JSON.parse((await invoke(root, release, approvedRepair)).stdout);
  assert.equal(result.packageRepair.status, "complete");
  assert.equal(result.stateRepair.status, 0);
  assert.deepEqual(readdirSync(join(root, "bin")).sort(), ["helper", "tonedial"]);
  for (const name of ["src", "dist"]) assert.equal(readFileSync(join(archived(root, `legacy-${name}`), "old"), "utf8"), `retained ${name}\n`);
  assert.match(readFileSync(archived(root, "legacy-package.json"), "utf8"), /"tonedial"/);
  assert.deepEqual(readFileSync(archived(root, "previous-command")), command);
  assert.deepEqual(JSON.parse((await cli(root, ["export", "keep-me", "--json"], join(root, "lib"))).stdout), preset);
});

test("unknown components need a closed archive selection and linked commands never read their referent", async () => {
  const root = await initialized("unknown");
  rmSync(join(root, "lib"), { recursive: true });
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "lib", "unknown"), "unknown program\n");
  const referent = join(scratch, "external-command");
  writeFileSync(referent, "external dummy data\n");
  rmSync(join(root, "bin", "tonedial"));
  symlinkSync(referent, join(root, "bin", "tonedial"));
  const before = readFileSync(join(root, "config.json"));

  await assert.rejects(() => invoke(root, release, approvedRepair), installerFailure(/identifiable installed package/));
  assert.equal(readFileSync(join(root, "lib", "unknown"), "utf8"), "unknown program\n");
  assert.deepEqual(readFileSync(join(root, "config.json")), before);
  await assert.rejects(() => invoke(root, release, [...approvedRepair, "--archive-current", "../../outside"]), installerFailure(/component names/));
  const result = JSON.parse((await invoke(root, release, [...approvedRepair, "--archive-current", "lib,command"])).stdout);
  assert.equal(result.packageRepair.status, "complete");
  assert.equal(readFileSync(join(archived(root, "previous"), "unknown"), "utf8"), "unknown program\n");
  assert.equal(lstatSync(archived(root, "previous-command")).isSymbolicLink(), true);
  assert.equal(readFileSync(referent, "utf8"), "external dummy data\n");
});

test("verification failure restores archived flat components and binary command bytes and modes", async () => {
  const root = await initialized("rollback");
  const oldPackage = readFileSync(join(root, "lib", "package.json"));
  const command = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0x80]);
  writeFileSync(join(root, "bin", "tonedial"), command);
  chmodSync(join(root, "bin", "tonedial"), 0o710);
  mkdirSync(join(root, "bin", "src"));
  writeFileSync(join(root, "bin", "src", "old"), "old source\n");
  writeFileSync(join(root, "bin", "package.json"), '{"name":"tonedial"}\n');

  await assert.rejects(() => invoke(root, candidate("fails-verification", true), approvedRepair), installerFailure(/verification/));
  assert.deepEqual(readFileSync(join(root, "lib", "package.json")), oldPackage);
  assert.deepEqual(readFileSync(join(root, "bin", "tonedial")), command);
  assert.equal(lstatSync(join(root, "bin", "tonedial")).mode & 0o7777, 0o710);
  assert.equal(readFileSync(join(root, "bin", "src", "old"), "utf8"), "old source\n");
  assert.equal(existsSync(join(root, "operations.lock")), false);
});

test("interrupted component archival retires the dead installer with a bound receipt and preserves historical evidence", async () => {
  const root = await initialized("interrupted");
  const command = readFileSync(join(root, "bin", "tonedial"));
  const fault = join(scratch, "interrupt-archive.mjs");
  writeFileSync(fault, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const rename = fs.renameSync; fs.renameSync = (from,to) => { const result=rename(from,to);
    if (String(to)===${JSON.stringify(join(root, "operations.lock", "previous-command"))}) process.kill(process.pid,'SIGKILL'); return result; }; syncBuiltinESMExports();\n`);
  await assert.rejects(() => invoke(root, release, approvedRepair, { NODE_OPTIONS: `--import=${fault}` }), (cause: unknown) => (cause as { signal?: string }).signal === "SIGKILL");
  const id = JSON.parse(readFileSync(join(root, "operations.lock", "owner.json"), "utf8")).operationId as string;
  const saved = join(root, "operations", `completed-${id}`);

  const result = JSON.parse((await invoke(root, release, approvedRepair)).stdout);
  assert.equal(result.packageRepair.status, "complete");
  assert.equal(result.stateRepair.status, 0);
  assert.equal(existsSync(join(root, "operations.lock")), false);
  assert.deepEqual(readFileSync(join(saved, "previous-command")), command);
  const record = JSON.parse(readFileSync(join(saved, "record.json"), "utf8"));
  assert.equal(record.state, "retired-for-app-rebuild");
  assert.equal(lstatSync(record.retirement.receipt).mode & 0o777, 0o600);
  const receipt = JSON.parse(readFileSync(record.retirement.receipt, "utf8"));
  assert.equal(receipt.evidence.record.state, "previous-moved");
  await cli(root, ["use", "keep-me"], join(root, "lib"));
});

for (const phase of ["receipt", "seal", "release"] as const) {
  test(`installer retirement interrupted after ${phase} resumes without losing its retained archive`, async () => {
    const root = await initialized(`retirement-${phase}`);
    const command = readFileSync(join(root, "bin", "tonedial"));
    const lock = join(root, "operations.lock");
    const firstFault = join(scratch, `archive-before-${phase}.mjs`);
    writeFileSync(firstFault, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const rename=fs.renameSync; fs.renameSync=(from,to)=>{ const value=rename(from,to);
      if(String(to)===${JSON.stringify(join(lock, "previous-command"))}) process.kill(process.pid,'SIGKILL'); return value; }; syncBuiltinESMExports();\n`);
    await assert.rejects(() => invoke(root, release, approvedRepair, { NODE_OPTIONS: `--import=${firstFault}` }), (cause: unknown) => (cause as { signal?: string }).signal === "SIGKILL");
    const id = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).operationId as string;
    const receipt = join(root, "operations", `${id}.retirement.json`);
    const saved = join(root, "operations", `completed-${id}`);
    const retirementFault = join(scratch, `interrupt-retirement-${phase}.mjs`);
    writeFileSync(retirementFault, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const rename=fs.renameSync; fs.renameSync=(from,to)=>{ const value=rename(from,to);
      const stop=${JSON.stringify(phase)}==='receipt' ? String(to)===${JSON.stringify(receipt)} :
        ${JSON.stringify(phase)}==='seal' ? String(to)===${JSON.stringify(join(lock, "record.json"))} && JSON.parse(fs.readFileSync(to,'utf8')).state==='retired-for-app-rebuild' :
        String(from)===${JSON.stringify(lock)} && String(to)===${JSON.stringify(saved)};
      if(stop) process.kill(process.pid,'SIGKILL'); return value; }; syncBuiltinESMExports();\n`);
    await assert.rejects(() => invoke(root, release, approvedRepair, { NODE_OPTIONS: `--import=${retirementFault}` }), (cause: unknown) => (cause as { signal?: string }).signal === "SIGKILL");
    assert.equal(existsSync(receipt), true);
    assert.equal(existsSync(lock), phase !== "release");
    if (phase === "seal") {
      const original = readFileSync(receipt);
      writeFileSync(receipt, '{"changed":true}\n');
      await assert.rejects(() => invoke(root, release, approvedRepair), installerFailure(/retirement seal/));
      assert.equal(existsSync(lock), true);
      assert.equal(existsSync(join(root, "lib")), false);
      writeFileSync(receipt, original);
    }
    const result = JSON.parse((await invoke(root, release, approvedRepair)).stdout);
    assert.equal(result.packageRepair.status, "complete");
    assert.equal(result.stateRepair.status, 0);
    assert.equal(existsSync(lock), false);
    assert.deepEqual(readFileSync(join(saved, "previous-command")), command);
    assert.equal(JSON.parse(readFileSync(join(saved, "record.json"), "utf8")).state, "retired-for-app-rebuild");
    await cli(root, ["use", "keep-me"], join(root, "lib"));
  });
}

test("noninteractive bootstrap diagnosis and dry run leave a damaged installation untouched", async () => {
  const root = await initialized("preview");
  const bytes = Buffer.from([0xff, 0x80]);
  writeFileSync(join(root, "bin", "tonedial"), bytes);
  const before = readFileSync(join(root, "config.json"));
  await assert.rejects(() => execFile("/bin/sh", [join(repo, "install.sh"), "--repair", "--json"], { env: environment(root), encoding: "utf8", timeout: 60_000 }), (cause: unknown) => {
    assert.equal(JSON.parse((cause as { stdout: string }).stdout).packageRepair.status, "approval-required");
    return true;
  });
  const dry = JSON.parse((await execFile("/bin/sh", [join(repo, "install.sh"), "--repair", "--global", "--tools", "none", "--dry-run", "--json"], { env: environment(root), encoding: "utf8", timeout: 60_000 })).stdout);
  assert.equal(dry.packageRepair.status, "dry-run");
  assert.deepEqual(readFileSync(join(root, "bin", "tonedial")), bytes);
  assert.deepEqual(readFileSync(join(root, "config.json")), before);
  assert.equal(existsSync(join(root, "operations.lock")), false);
  assert.deepEqual(readdirSync(join(scratch, "tmp")).filter((name) => name.startsWith("tonedial.")), []);
});

test("incomplete preset restoration is rejected before bootstrap changes package, command, state or operations", async () => {
  const root = await initialized("incomplete-restoration");
  const snapshot = () => ["", ...readdirSync(root, { recursive: true }) as string[]].sort().map((name) => {
    const path = join(root, name);
    const stat = lstatSync(path);
    return { name, identity: `${stat.dev}:${stat.ino}`, mode: stat.mode & 0o7777,
      digest: stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : null };
  });
  const before = snapshot();
  await assert.rejects(() => execFile("/bin/sh", [join(repo, "install.sh"), ...approvedRepair, "--restore-preset", "keep-me"], {
    env: environment(root), encoding: "utf8", timeout: 60_000,
  }), (cause: unknown) => {
    const result = JSON.parse((cause as { stdout: string }).stdout);
    assert.equal(result.packageRepair.status, "failed");
    assert.equal(result.stateRepair.status, "not-started");
    assert.match(result.error, /--restore-preset requires --from-operation/);
    return true;
  });
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(readdirSync(join(scratch, "tmp")).filter((name) => name.startsWith("tonedial.")), []);
});

test("fresh bootstrap carries an explicit preset source into raw damaged-state recovery", async () => {
  const root = await initialized("selected-source");
  const preset = JSON.parse((await cli(root, ["export", "keep-me", "--json"])).stdout);
  writeFileSync(join(root, "config.json"), Buffer.from([0xff, 0x80, 0x00]));
  writeFileSync(join(root, "bin", "tonedial"), "this old executable cannot run\n");
  const result = await execFile("/bin/sh", [join(repo, "install.sh"), ...approvedRepair, "--from-preset", "keep-me"], { env: environment(root), encoding: "utf8", timeout: 60_000 });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.packageRepair.status, "complete");
  assert.equal(payload.stateRepair.status, 0);
  assert.equal(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).axes.warmth, 4);
  assert.deepEqual(JSON.parse((await cli(root, ["export", "keep-me", "--json"], join(root, "lib"))).stdout), preset);
});

test("fresh bootstrap combines a dead operation selector with preset fallback when no config snapshot survives", async () => {
  const root = await initialized("operation-and-preset");
  const names = (readdirSync(join(root, "presets"), { recursive: true }) as string[]).filter((name) => name.endsWith("keep-me.json"));
  assert.equal(names.length, 1, "the saved custom preset must exist before creating the interruption");
  const customPath = join(root, "presets", names[0]!);
  const customBytes = readFileSync(customPath);
  chmodSync(customPath, 0o640);

  // A real writer dies after recording a nonempty generated-entry operation. Its journal has
  // no config action, so the operation ID can retire this owner but cannot invent saved data.
  const actor = `
    import { acquireOperation, beginJournal } from ${JSON.stringify(join(release, "dist", "core", "operations.js"))};
    import { resolvePaths } from ${JSON.stringify(join(release, "dist", "core", "paths.js"))};
    import { catalogue } from ${JSON.stringify(join(release, "dist", "core", "i18n.js"))};
    import { captureRawEntry, planEntryRebuild } from ${JSON.stringify(join(release, "dist", "wiring", "apply.js"))};
    const paths = resolvePaths(process.env);
    const t = catalogue("en").cli;
    const captured = captureRawEntry(paths.agents, t, { within: paths.root });
    const planned = planEntryRebuild(captured, "An interrupted generated guide upgrade.\\n", t, { reason: "generated" });
    const handle = acquireOperation(paths, "mutation");
    beginJournal(handle, [planned.action.action]);
    process.kill(process.pid, "SIGKILL");
  `;
  await assert.rejects(() => execFile(process.execPath, ["--input-type=module", "-e", actor], {
    env: environment(root), encoding: "utf8", timeout: 30_000,
  }), (cause: unknown) => (cause as { signal?: string }).signal === "SIGKILL");
  const owner = JSON.parse(readFileSync(join(root, "operations.lock", "owner.json"), "utf8"));
  const journalPath = join(root, "operations", `${owner.operationId}.json`);
  const pending = JSON.parse(readFileSync(journalPath, "utf8"));
  assert.equal(pending.state, "pending");
  assert.equal(pending.actions.length, 1);
  assert.equal(pending.actions.some((action: { path: string }) => action.path === join(root, "config.json")), false);

  const damagedConfig = Buffer.from('{"privateExample":"PRIVATE_PENDING_FALLBACK_8137"');
  writeFileSync(join(root, "config.json"), damagedConfig);
  chmodSync(join(root, "config.json"), 0o640);
  writeFileSync(join(root, "TONE.md"), "unrecognized damaged generated output\n");
  writeFileSync(join(root, "lib", "dist", "bin.js"), Buffer.from([0xff, 0x80, 0x00]));
  writeFileSync(join(root, "bin", "tonedial"), Buffer.from([0xff, 0x80, 0x00]));

  const result = await execFile("/bin/sh", [join(repo, "install.sh"), ...approvedRepair,
    "--from-operation", owner.operationId, "--from-preset", "keep-me"], {
    env: environment(root), encoding: "utf8", timeout: 60_000,
  });
  const repaired = JSON.parse(result.stdout);
  assert.equal(repaired.packageRepair.status, "complete");
  assert.equal(repaired.priorRecovery.status, 0);
  assert.equal(repaired.priorRecovery.result.source, "preset");
  assert.equal(repaired.stateRepair.status, 0);
  assert.equal(existsSync(join(root, "operations.lock")), false);
  const retired = JSON.parse(readFileSync(journalPath, "utf8"));
  assert.equal(retired.state, "retired-for-app-rebuild");
  assert.deepEqual(retired.actions, pending.actions);
  const receipt = JSON.parse(readFileSync(retired.retirement.receipt, "utf8"));
  const savedConfig = receipt.evidence.snapshots.find((entry: { path: string }) => entry.path === join(root, "config.json"));
  assert.equal(savedConfig.bytes, damagedConfig.toString("base64"));
  assert.equal(savedConfig.mode, 0o640);
  assert.deepEqual(readFileSync(customPath), customBytes);
  assert.equal(lstatSync(customPath).mode & 0o7777, 0o640);
  assert.equal(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).axes.warmth, 4);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_PENDING_FALLBACK_8137/);
  const version = await execFile(join(root, "bin", "tonedial"), ["--version", "--json"], { env: environment(root), encoding: "utf8", timeout: 30_000 });
  assert.equal(JSON.parse(version.stdout).version, registryVersion);
  await cli(root, ["use", "keep-me"], join(root, "lib"));
});

test("curl package update replaces its program despite damaged config and leaves user data byte-identical", async () => {
  const root = await initialized("curl-update");
  const bytes = Buffer.from('{"dummy-private-note":"DO_NOT_PRINT_UPDATE_6392"');
  writeFileSync(join(root, "config.json"), bytes);
  const preset = JSON.parse((await cli(root, ["export", "keep-me", "--json"])).stdout);
  const previousVersion = registryVersion;
  registryVersion = "9.9.9";
  try {
    const result = await cli(root, ["update", "--auto", "--json"], join(root, "lib"));
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.shape, "curl");
    assert.equal(payload.checkedRemote, true);
    assert.equal(payload.replaced, previousVersion);
    assert.equal(payload.seedVersion, null);
    assert.equal(payload.packageSeedVersion, null);
    assert.equal(payload.recoveryCommand, "tonedial doctor --fix");
    assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_PRINT_UPDATE_6392/);
    assert.deepEqual(readFileSync(join(root, "config.json")), bytes);
    assert.deepEqual(JSON.parse((await cli(root, ["export", "keep-me", "--json"], join(root, "lib"))).stdout), preset);
    assert.equal(existsSync(join(root, "operations.lock")), false);
    assert.equal(existsSync(archived(root, "previous")), true);
  } finally {
    registryVersion = previousVersion;
  }
});

test("npm update guidance survives malformed and non-UTF-8 config without replacing state or exposing content", async () => {
  const root = await initialized("npm-guidance");
  for (const bytes of [Buffer.from('{"dummy-private-note":"DO_NOT_PRINT_2841"'), Buffer.from([0xff, 0x80, 0x00])]) {
    writeFileSync(join(root, "config.json"), bytes);
    const preset = JSON.parse((await cli(root, ["export", "keep-me", "--json"])).stdout);
    const result = await cli(root, ["update", "--json"], release, { TONEDIAL_INSTALL_SHAPE: "npm" });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "npm update -g tonedial");
    assert.equal(payload.recoveryCommand, "tonedial doctor --fix");
    assert.equal(payload.checkedRemote, false);
    assert.equal(payload.stateRecoveryRequired, true);
    assert.equal(payload.seedVersion, null);
    assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_PRINT_2841/);
    assert.deepEqual(readFileSync(join(root, "config.json")), bytes);
    assert.deepEqual(JSON.parse((await cli(root, ["export", "keep-me", "--json"])).stdout), preset);
  }
});
