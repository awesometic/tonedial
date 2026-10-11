// Narrow installer recovery coverage that does not need the loopback registry fixture.
// Every candidate, install root, runtime home, and injected fault module lives in one temporary
// directory; the test invokes the built installer entry exactly as the packaged entry does.

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

import { shimScript } from "../src/core/paths.ts";

const execFile = promisify(execFileCallback);
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

let scratch: string;

function isolatedEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    TMPDIR: join(scratch, "tmp"),
    LANG: "C",
    LC_ALL: "C",
    LC_CTYPE: "C",
    HOME: join(scratch, "home"),
    XDG_CONFIG_HOME: join(scratch, "xdg"),
    XDG_CACHE_HOME: join(scratch, "xdg-cache"),
    npm_config_cache: join(scratch, "npm-cache"),
    npm_config_userconfig: join(scratch, "npmrc"),
    npm_config_globalconfig: join(scratch, "globalrc"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    TONEDIAL_HOME: root,
    ...extra,
  };
}

function candidate(label: string, version: string): string {
  const path = join(scratch, "candidates", label);
  mkdirSync(path, { recursive: true });
  cpSync(join(repo, "dist"), join(path, "dist"), { recursive: true, force: false });
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as Record<string, unknown>;
  manifest.version = version;
  writeFileSync(join(path, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const cliPath = join(path, "dist", "cli.js");
  const cli = readFileSync(cliPath, "utf8");
  assert.match(cli, /export const VERSION = "[^"]+";/);
  writeFileSync(cliPath, cli.replace(/export const VERSION = "[^"]+";/, `export const VERSION = ${JSON.stringify(version)};`));
  return path;
}

function failingCandidate(label: string, version: string): string {
  const path = candidate(label, version);
  writeFileSync(join(path, "dist", "bin.js"), "process.stdout.write(JSON.stringify({ok:true,version:'wrong'}) + '\\n');\n");
  return path;
}

async function invokeInstaller(root: string, source: string, extra: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return execFile(process.execPath, [join(source, "dist", "install.js"), "--root", root, "--candidate", source], {
    encoding: "utf8",
    timeout: 60_000,
    env: isolatedEnv(root, extra),
  });
}

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-install-recovery-"));
  mkdirSync(join(scratch, "home"), { recursive: true });
  mkdirSync(join(scratch, "tmp"), { recursive: true });
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

for (const matching of [true, false]) {
  test(`replaces an unrecorded ${matching ? "identical" : "different"} regular executable`, async () => {
    const root = join(scratch, matching ? "identical-command" : "different-command");
    const command = join(root, "bin", "tonedial");
    mkdirSync(dirname(command), { recursive: true });
    writeFileSync(command, matching ? shimScript(join(root, "lib"), root) : Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0x80, 0x00]));
    chmodSync(command, 0o700);
    const before = lstatSync(command);
    assert.deepEqual(readdirSync(root), ["bin"], "no prior package or installation record");

    await invokeInstaller(root, candidate(matching ? "identical" : "different", "2.0.0"));

    const after = lstatSync(command);
    assert.notDeepEqual([after.dev, after.ino], [before.dev, before.ino], "replace even identical bytes");
    assert.equal(after.mode & 0o7777, 0o755);
    const result = await execFile(command, ["--version", "--json"], { env: isolatedEnv(root), timeout: 30_000 });
    assert.equal(JSON.parse(result.stdout).version, "2.0.0");
    assert.equal(existsSync(join(root, "operations.lock")), false);
    for (const name of ["config.json", "AGENTS.md", "TONE.md", "presets", "skill", "reader.mjs"]) {
      assert.equal(existsSync(join(root, name)), false, name);
    }
  });
}

test("failed first installation restores an unrecorded binary executable exactly", async () => {
  const root = join(scratch, "binary-command-rollback");
  const command = join(root, "bin", "tonedial");
  const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0x80, 0x00, 0xc0, 0xaf]);
  mkdirSync(dirname(command), { recursive: true });
  writeFileSync(command, bytes);
  chmodSync(command, 0o710);

  await assert.rejects(() => invokeInstaller(root, failingCandidate("binary-rollback", "2.0.0")), /verification|new tonedial command/);

  assert.deepEqual(readFileSync(command), bytes);
  assert.equal(lstatSync(command).mode & 0o7777, 0o710);
  assert.equal(existsSync(join(root, "lib")), false);
  assert.equal(existsSync(join(root, "operations.lock")), false);
  assert.deepEqual(readdirSync(dirname(command)), ["tonedial"]);
});

test("recovers a shim rename recorded at the prepared checkpoint without a registry", async () => {
  const root = join(scratch, "tonedial");
  const initial = candidate("initial", "1.0.0");
  await invokeInstaller(root, initial);

  const command = join(root, "bin", "tonedial");
  writeFileSync(command, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0x80, 0x00]));
  chmodSync(command, 0o710);
  const oldShim = readFileSync(command);
  const oldPackage = readFileSync(join(root, "lib", "package.json"));
  const fault = join(scratch, "kill-after-shim-rename.mjs");
  writeFileSync(fault, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const rename = fs.renameSync;
    const command = ${JSON.stringify(command)};
    let killed = false;
    fs.renameSync = (from, to) => {
      const result = rename(from, to);
      if (!killed && String(to) === command && String(from).startsWith(command + ".tmp-")) {
        killed = true;
        process.kill(process.pid, "SIGKILL");
      }
      return result;
    };
    syncBuiltinESMExports();
  `);

  const interrupted = candidate("interrupted", "2.0.0");
  await assert.rejects(
    () => invokeInstaller(root, interrupted, { NODE_OPTIONS: `--import=${fault}` }),
    (error: unknown) => {
      assert.equal((error as { signal?: string }).signal, "SIGKILL");
      return true;
    },
  );

  const lock = join(root, "operations.lock");
  const record = JSON.parse(readFileSync(join(lock, "record.json"), "utf8")) as {
    state: string;
    preparedPath?: string;
    preparedCommand?: { exists: boolean; type?: string; identity?: { dev: string; ino: string }; tree?: string; bytes?: string };
  };
  assert.equal(record.state, "shim-prepared");
  assert.equal(typeof record.preparedPath, "string");
  assert.ok(record.preparedCommand?.exists);
  assert.equal(record.preparedCommand?.type, "file");
  const current = lstatSync(command);
  assert.deepEqual(
    { dev: String(current.dev), ino: String(current.ino) },
    record.preparedCommand?.identity,
  );
  assert.deepEqual(readFileSync(join(lock, "previous", "package.json")), oldPackage);
  assert.deepEqual(readFileSync(command), Buffer.from(record.preparedCommand!.bytes!, "base64"));
  assert.notDeepEqual(readFileSync(command), oldShim);

  const restored = join(scratch, "restored-layout.json");
  const observer = join(scratch, "observe-restored-layout.mjs");
  writeFileSync(observer, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const lock = ${JSON.stringify(lock)};
    const completedPrefix = ${JSON.stringify(join(root, "operations", "completed-"))};
    const marker = ${JSON.stringify(restored)};
    const command = ${JSON.stringify(command)};
    let captured = false;
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      const result = rename(from, to);
      if (!captured && String(from) === lock && String(to).startsWith(completedPrefix)) {
        captured = true;
        fs.writeFileSync(marker, JSON.stringify({
          package: fs.readFileSync(${JSON.stringify(join(root, "lib", "package.json"))}).toString("base64"),
          shim: fs.readFileSync(command).toString("base64"),
          mode: fs.statSync(command).mode & 0o7777,
        }));
      }
      return result;
    };
    syncBuiltinESMExports();
  `);
  const replacement = candidate("replacement", "3.0.0");
  await invokeInstaller(root, replacement, { NODE_OPTIONS: `--import=${observer}` });
  const restoredLayout = JSON.parse(readFileSync(restored, "utf8")) as { package: string; shim: string; mode: number };
  assert.equal(restoredLayout.package, oldPackage.toString("base64"));
  assert.equal(restoredLayout.shim, oldShim.toString("base64"));
  assert.equal(restoredLayout.mode, 0o710);
  const version = JSON.parse(
    (await execFile(command, ["--version", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      env: isolatedEnv(root),
    })).stdout,
  ) as { version?: unknown };
  assert.equal(version.version, "3.0.0");
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(join(root, "bin")).sort(), ["tonedial"]);
  assert.equal(existsSync(record.preparedPath!), false);
  assert.equal(existsSync(join(root, "lib.previous")), false);
});

test("an altered prepared-shim path cannot remove a file outside the installation", async () => {
  const root = join(scratch, "altered-prepared-path");
  await invokeInstaller(root, candidate("path-initial", "1.0.0"));
  const recordPath = join(root, "operations.lock", "record.json");
  const fault = join(scratch, "kill-before-shim-rename.mjs");
  writeFileSync(fault, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      const result = rename(from, to);
      if (String(to) === ${JSON.stringify(recordPath)} &&
          JSON.parse(fs.readFileSync(to, "utf8")).state === "shim-prepared") {
        process.kill(process.pid, "SIGKILL");
      }
      return result;
    };
    syncBuiltinESMExports();
  `);
  await assert.rejects(
    () => invokeInstaller(root, candidate("path-interrupted", "2.0.0"), { NODE_OPTIONS: `--import=${fault}` }),
    (error: unknown) => (error as { signal?: string }).signal === "SIGKILL",
  );
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as { preparedPath: string; state: string };
  assert.equal(record.state, "shim-prepared");
  const preserved = join(scratch, "keep-this-command.sh");
  renameSync(record.preparedPath, preserved);
  const before = readFileSync(preserved);
  const identity = lstatSync(preserved, { bigint: true });
  record.preparedPath = preserved;
  writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
  const packageBefore = readFileSync(join(root, "lib", "package.json"));
  const commandBefore = readFileSync(join(root, "bin", "tonedial"));

  await assert.rejects(
    () => invokeInstaller(root, candidate("path-retry", "3.0.0")),
    /no valid install record; preserving it for manual recovery/,
  );
  assert.deepEqual(readFileSync(preserved), before);
  assert.equal(lstatSync(preserved, { bigint: true }).ino, identity.ino);
  assert.deepEqual(readFileSync(join(root, "lib", "package.json")), packageBefore);
  assert.deepEqual(readFileSync(join(root, "bin", "tonedial")), commandBefore);
  assert.equal(existsSync(join(root, "operations.lock")), true);
});

test("a restrictive umask leaves a recoverable normalized shim mode", async () => {
  const root = join(scratch, "restrictive-umask");
  const command = join(root, "bin", "tonedial");
  const recordPath = join(root, "operations.lock", "record.json");
  const fault = join(scratch, "restrictive-umask.mjs");
  writeFileSync(fault, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const rename = fs.renameSync;
    let restrictive = false;
    let killed = false;
    fs.renameSync = (from, to) => {
      const result = rename(from, to);
      if (String(to) !== ${JSON.stringify(recordPath)}) return result;
      const state = JSON.parse(fs.readFileSync(to, "utf8")).state;
      if (!restrictive && state === "lib-swapped") {
        restrictive = true;
        process.umask(0o077);
      } else if (!killed && state === "shim-prepared") {
        killed = true;
        process.kill(process.pid, "SIGKILL");
      }
      return result;
    };
    syncBuiltinESMExports();
  `);
  await assert.rejects(
    () => invokeInstaller(root, candidate("umask-interrupted", "1.0.0"), { NODE_OPTIONS: `--import=${fault}` }),
    (error: unknown) => (error as { signal?: string }).signal === "SIGKILL",
  );
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as { desiredCommand: { mode: number }; preparedCommand?: { mode?: number } };
  assert.equal(record.desiredCommand.mode, 0o755);
  assert.equal(record.preparedCommand?.mode, 0o755);

  await invokeInstaller(root, candidate("umask-retry", "2.0.0"));
  assert.equal(existsSync(join(root, "operations.lock")), false);
  assert.equal(lstatSync(command).mode & 0o7777, 0o755);
});

test("a journal changed after the recovery lease is claimed is preserved", async () => {
  const root = join(scratch, "record-after-lease");
  await invokeInstaller(root, candidate("lease-initial", "1.0.0"));
  const command = join(root, "bin", "tonedial");
  const commandBefore = readFileSync(command);
  const recordPath = join(root, "operations.lock", "record.json");
  const killFault = join(scratch, "record-after-lease-kill.mjs");
  writeFileSync(killFault, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const recordPath = ${JSON.stringify(recordPath)};
    const rename = fs.renameSync;
    let killed = false;
    fs.renameSync = (from, to) => {
      const result = rename(from, to);
      if (!killed && String(to) === recordPath &&
          JSON.parse(fs.readFileSync(to, "utf8")).state === "shim-prepared") {
        killed = true;
        process.kill(process.pid, "SIGKILL");
      }
      return result;
    };
    syncBuiltinESMExports();
  `);
  const leaseFault = join(scratch, "record-after-lease-mutate.mjs");
  const leasePath = join(root, "operations.lock", "recovery", "lease.json");
  writeFileSync(leaseFault, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const recordPath = ${JSON.stringify(recordPath)};
    const leasePath = ${JSON.stringify(leasePath)};
    const rename = fs.renameSync;
    let changed = false;
    fs.renameSync = (from, to) => {
      const result = rename(from, to);
      if (!changed && String(to) === leasePath) {
        changed = true;
        const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        record.cleanup = "preserved";
        fs.writeFileSync(recordPath, JSON.stringify(record) + "\\n");
      }
      return result;
    };
    syncBuiltinESMExports();
  `);
  await assert.rejects(
    () => invokeInstaller(root, candidate("lease-interrupted", "2.0.0"), { NODE_OPTIONS: `--import=${killFault}` }),
    (error: unknown) => (error as { signal?: string }).signal === "SIGKILL",
  );
  await assert.rejects(
    () => invokeInstaller(root, candidate("lease-retry", "3.0.0"), { NODE_OPTIONS: `--import=${leaseFault}` }),
    /install record changed during recovery/,
  );
  assert.equal(JSON.parse(readFileSync(join(root, "lib", "package.json"), "utf8")).version, "2.0.0");
  assert.deepEqual(readFileSync(command), commandBefore);
  assert.equal(existsSync(join(root, "operations.lock")), true);
});

test("a foreign empty bin appearing at creation is preserved", async () => {
  const root = join(scratch, "foreign-empty-bin");
  const bin = join(root, "bin");
  const marker = join(scratch, "foreign-empty-bin-identity.json");
  const fault = join(scratch, "foreign-empty-bin.mjs");
  writeFileSync(fault, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const target = ${JSON.stringify(bin)};
    const marker = ${JSON.stringify(marker)};
    const mkdir = fs.mkdirSync;
    let injected = false;
    fs.mkdirSync = (path, options) => {
      if (!injected && String(path) === target) {
        injected = true;
        mkdir(path);
        const stat = fs.lstatSync(path);
        fs.writeFileSync(marker, JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino) }));
      }
      return mkdir(path, options);
    };
    syncBuiltinESMExports();
  `);

  await assert.rejects(
    () => invokeInstaller(root, failingCandidate("foreign-empty-bin-candidate", "1.0.0"), { NODE_OPTIONS: `--import=${fault}` }),
  );

  const identity = JSON.parse(readFileSync(marker, "utf8")) as { dev: string; ino: string };
  const current = lstatSync(bin);
  assert.deepEqual({ dev: String(current.dev), ino: String(current.ino) }, identity);
  assert.deepEqual(readdirSync(bin), []);
  assert.equal(existsSync(join(root, "lib")), false);
  assert.equal(existsSync(join(root, "operations.lock")), false);
});

test("a fresh operation-created bin is removed after verification failure", async () => {
  const root = join(scratch, "fresh-bin-rollback");

  await assert.rejects(
    () => invokeInstaller(root, failingCandidate("fresh-bin-rollback-candidate", "1.0.0")),
    /verification|new tonedial command/,
  );

  assert.equal(existsSync(join(root, "bin")), false);
  assert.equal(existsSync(join(root, "lib")), false);
  assert.equal(existsSync(join(root, "operations.lock")), false);
});
