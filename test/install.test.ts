// End-to-end coverage for the npm-less installer and its shared package transaction.
//
// Every network request here goes only to the loopback registry below. HOME, XDG, and npm's
// caches are redirected into this suite's temporary directory, so a failed assertion cannot
// discover or modify a real agent home.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCb);
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

let scratch: string;
let server: Server;
let registry: string;
let packedTarball: string;
let packedVersion: string;
let packedBytes: Uint8Array;

const served: {
  version: string;
  tarball: Uint8Array;
  integrity: string;
  raw?: string;
} = {
  version: "0.0.0",
  tarball: new Uint8Array(),
  integrity: "",
};

function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = join(scratch, "npm-home");
  const cache = join(scratch, "npm-cache");
  mkdirSync(home, { recursive: true });
  mkdirSync(cache, { recursive: true });
  return {
    ...process.env,
    // The tool's own variables never inherit. A developer with `TONEDIAL_HOME` exported in their
    // shell otherwise points every child process at their real state root, and the failure reads
    // as a defect in the installer rather than in this helper. `...extra` still wins, so a test
    // that sets one deliberately is unaffected.
    TONEDIAL_HOME: undefined,
    TONEDIAL_AGENT_HOME: undefined,
    TONEDIAL_INSTALL_SHAPE: undefined,
    TONEDIAL_REGISTRY: undefined,
    HOME: home,
    XDG_CONFIG_HOME: join(scratch, "xdg"),
    XDG_CACHE_HOME: join(scratch, "xdg-cache"),
    npm_config_cache: cache,
    npm_config_userconfig: join(scratch, "npmrc"),
    npm_config_globalconfig: join(scratch, "globalrc"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    ...extra,
  };
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-install-"));
  const packed = join(scratch, "pack");
  mkdirSync(packed);
  // Avoid rebuilding shared dist while parallel tests copy it; prepack is tested in a disposable tree.
  const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packed], {
    cwd: repo,
    env: isolatedEnv(),
    encoding: "utf8",
  });
  const name = (JSON.parse(output) as { filename: string }[])[0]!.filename;
  packedTarball = join(packed, name);
  packedBytes = readFileSync(packedTarball);
  packedVersion = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;
  served.version = packedVersion;
  served.tarball = packedBytes;
  served.integrity = integrityOf(packedBytes);

  server = createServer((request, response) => {
    if (request.url === "/tonedial/latest") {
      response.setHeader("content-type", "application/json");
      response.end(
        served.raw ??
          JSON.stringify({
            version: served.version,
            dist: { tarball: registry + "/tarball", integrity: served.integrity },
          }),
      );
      return;
    }
    if (request.url === "/tarball") {
      response.end(Buffer.from(served.tarball));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  registry = "http://127.0.0.1:" + (typeof address === "object" && address ? address.port : 0);
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});

function integrityOf(bytes: Uint8Array): string {
  return "sha512-" + createHash("sha512").update(bytes).digest("base64");
}

async function serving<T>(
  values: Partial<typeof served> & { raw?: string | undefined },
  run: () => Promise<T>,
): Promise<T> {
  const previous = { ...served };
  Object.assign(served, values);
  try {
    return await run();
  } finally {
    served.version = previous.version;
    served.tarball = previous.tarball;
    served.integrity = previous.integrity;
    if (previous.raw === undefined) delete served.raw;
    else served.raw = previous.raw;
  }
}

async function install(
  label: string,
  extra: Record<string, string> = {},
): Promise<{ home: string; agent: string; shellHome: string; stdout: string }> {
  const home = join(scratch, label, "tonedial");
  const agent = join(scratch, label, "agent");
  const shellHome = join(scratch, label, "home");
  mkdirSync(shellHome, { recursive: true });
  const result = await execFile("sh", [join(repo, "install.sh")], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: scratch,
      TONEDIAL_REGISTRY: registry,
      TONEDIAL_HOME: home,
      TONEDIAL_AGENT_HOME: agent,
      HOME: shellHome,
      ...extra,
    },
  });
  return { home, agent, shellHome, stdout: result.stdout };
}

async function byName(home: string, agent: string, ...args: string[]): Promise<string> {
  return (
    await execFile("tonedial", args, {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: join(home, "bin") + ":" + (process.env.PATH ?? ""),
        TONEDIAL_HOME: home,
        TONEDIAL_AGENT_HOME: agent,
        HOME: join(dirname(agent), "home"),
        TONEDIAL_REGISTRY: registry,
      },
    })
  ).stdout;
}

async function invokeInstaller(root: string, candidate: string, extra: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return execFile("node", [join(repo, "dist", "install.js"), "--root", root, "--candidate", candidate], {
    encoding: "utf8",
    timeout: 60_000,
    env: isolatedEnv({ TONEDIAL_HOME: root, ...extra }),
  });
}

function readdirSorted(path: string): string[] {
  return existsSync(path) ? readdirSync(path).sort() : [];
}

function makeCandidate(label: string, version: string, mutate?: (candidate: string) => void): string {
  const work = join(scratch, "candidates", label);
  mkdirSync(work, { recursive: true });
  execFileSync("tar", ["-xzf", packedTarball, "-C", work]);
  const candidate = join(work, "package");
  const packageJson = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as Record<string, unknown>;
  packageJson.version = version;
  writeFileSync(join(candidate, "package.json"), JSON.stringify(packageJson, null, 2) + "\n");
  const cli = join(candidate, "dist", "cli.js");
  const compiled = readFileSync(cli, "utf8");
  assert.match(compiled, /export const VERSION = "[^"]+";/);
  writeFileSync(cli, compiled.replace(/export const VERSION = "[^"]+";/, `export const VERSION = ${JSON.stringify(version)};`));
  mutate?.(candidate);
  return candidate;
}

function makeArchive(label: string, candidate: string): Uint8Array {
  const archive = join(scratch, "candidates", label + ".tgz");
  execFileSync("tar", ["-czf", archive, "-C", dirname(candidate), "package"]);
  return readFileSync(archive);
}

function makeTraversalArchive(label: string): Uint8Array {
  const work = join(scratch, "traversal", label);
  mkdirSync(join(work, "package"), { recursive: true });
  mkdirSync(join(work, "outside"), { recursive: true });
  writeFileSync(join(work, "outside", "sentinel"), "keep me");
  const archive = join(work, "unsafe.tgz");
  execFileSync("tar", ["-czf", archive, "-C", join(work, "package"), "../outside/sentinel"]);
  return readFileSync(archive);
}

function packageTreeDigest(path: string): string {
  const digest = createHash("sha256");
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
      const child = join(directory, name);
      const stat = lstatSync(child);
      const relative = prefix ? prefix + "/" + name : name;
      if (stat.isDirectory()) {
        digest.update("d\0" + relative + "\0" + (stat.mode & 0o7777) + "\n");
        walk(child, relative);
      } else {
        const bytes = readFileSync(child);
        digest.update("f\0" + relative + "\0" + (stat.mode & 0o7777) + "\0" + createHash("sha256").update(bytes).digest("hex") + "\n");
      }
    }
  };
  walk(path, "");
  return digest.digest("hex");
}

type TestSnapshot =
  | { exists: false }
  | {
      exists: true;
      type: "file" | "directory";
      identity: { dev: string; ino: string };
      mode: number;
      tree: string;
      bytes?: string;
    };

function testSnapshot(path: string, includeBytes = false): TestSnapshot {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return { exists: false };
  const base = {
    exists: true as const,
    identity: { dev: String(stat.dev), ino: String(stat.ino) },
    mode: stat.mode & 0o7777,
  };
  if (stat.isDirectory()) return { ...base, type: "directory", tree: packageTreeDigest(path) };
  assert.ok(stat.isFile(), "unexpected test snapshot type: " + path);
  const bytes = readFileSync(path);
  return {
    ...base,
    type: "file",
    tree: createHash("sha256").update(bytes).digest("hex"),
    ...(includeBytes ? { bytes: Buffer.from(bytes).toString("base64") } : {}),
  };
}

function noUserState(home: string, agent: string, shellHome: string): void {
  for (const path of ["config.json", "AGENTS.md", "TONE.md", "tone.md", "reader.mjs", "presets", "skill"]) {
    assert.equal(existsSync(join(home, path)), false, path + " was written during install");
  }
  assert.equal(existsSync(agent), false, "agent files were written during install");
  for (const file of [".zshrc", ".bash_profile", ".bashrc", ".profile"]) {
    assert.equal(existsSync(join(shellHome, file)), false, file + " was written during install");
  }
  assert.equal(existsSync(join(home, "operations.lock")), false, "the operation lock was left behind");
  assert.deepEqual(readdirSorted(join(home, "bin")), ["tonedial"]);
}

test("a curl install recognises itself as one, without being told", async () => {
  const { home, agent } = await install("shape");
  // No `TONEDIAL_INSTALL_SHAPE`. Detection is what decides whether a PATH line gets written at
  // all, so forcing it here would test nothing and hide the defect that shipped.
  const payload = JSON.parse(await byName(home, agent, "update", "--json")) as { shape: string };
  assert.equal(payload.shape, "curl");
});

test("a symlink above the install does not turn a curl install into an npm one", async () => {
  // `import.meta.url` comes back realpathed while the configured root does not, so comparing
  // them raw made these two spellings of one directory disagree — and the npm branch writes no
  // PATH line, leaving the command unreachable. macOS `/tmp -> private/tmp` is enough.
  const { home, agent } = await install("symlink");
  const linked = join(scratch, "symlink", "via-link");
  execFileSync("ln", ["-s", home, linked]);

  const payload = JSON.parse(
    (await execFile("tonedial", ["update", "--json"], {
      encoding: "utf8",
      env: {
        PATH: `${join(linked, "bin")}:${process.env.PATH!}`,
        TONEDIAL_HOME: linked,
        TONEDIAL_AGENT_HOME: agent,
        HOME: agent,
        TONEDIAL_REGISTRY: registry,
      },
    })).stdout,
  ) as { shape: string };
  assert.equal(payload.shape, "curl", "a symlinked root reported the wrong install shape");
});

test("the installer leaves no staging directory behind", async () => {
  const before = readdirSorted(scratch).filter((f) => f.startsWith("tonedial."));
  await install("staging");
  // Twice, because a re-install is the case that accumulates: `update` tells curl users to
  // re-run this script. A version that leaked only on the second run passed a one-run test.
  await install("staging");
  const after = readdirSorted(scratch).filter((f) => f.startsWith("tonedial."));
  // Asserts the outcome, not one line: the trap, the explicit removal, and not `exec`ing are
  // three mechanisms for one guarantee, and a leak is a leak whichever of them lapses. `update`
  // tells curl users to re-run the installer, so a leak accumulates rather than happening once.
  assert.deepEqual(after, before, "a staging directory was left in TMPDIR");
});


test("doctor diagnoses a missing command and app repair leaves executable replacement to the installer", async () => {
  const { home, agent } = await install("repair");
  await byName(home, agent, "init", "--project", agent, "--tools", "none", "--auto");
  const shim = join(home, "bin", "tonedial");
  const configBefore = readFileSync(join(home, "config.json"));
  rmSync(shim);

  // Initialized state permits local repair, but a missing command must still report unhealthy.
  const broken = JSON.parse(
    (await execFile("node", [join(home, "lib", "dist", "bin.js"), "doctor", "--json"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH!, TONEDIAL_HOME: home, TONEDIAL_AGENT_HOME: agent, HOME: agent },
    })).stdout,
  ) as { healthy: boolean; checks: { name: string; state: string }[] };
  assert.equal(broken.healthy, false, "doctor called an unreachable install healthy");
  assert.equal(broken.checks.find((c) => c.name === "tonedial")?.state, "problem");

  const repaired = await execFile("node", [join(home, "lib", "dist", "bin.js"), "doctor", "--project", agent, "--fix", "--auto", "--json"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH!, TONEDIAL_HOME: home, TONEDIAL_AGENT_HOME: agent, HOME: agent },
  });
  assert.equal(JSON.parse(repaired.stdout).appHealthy, true);
  assert.equal(existsSync(shim), false, "application repair recreated an installer-owned command");
  assert.deepEqual(readFileSync(join(home, "config.json")), configBefore);
  const commandCheck = JSON.parse(repaired.stdout).checks.find((check: { name: string }) => check.name === "tonedial");
  assert.match(commandCheck.detail, /install|command|missing/i);
  assert.match(commandCheck.repair, /--repair/);
  assert.ok(commandCheck.repair.includes(home), "reinstall guidance lost the installed state-root binding");
});

test("app repair preserves the bytes and mode of an unexecutable installer-owned command", async () => {
  const { home, agent } = await install("mode");
  await byName(home, agent, "init", "--project", agent, "--tools", "none", "--auto");
  const shim = join(home, "bin", "tonedial");
  chmodSync(shim, 0o644);
  const before = readFileSync(shim);

  const result = await execFile("node", [join(home, "lib", "dist", "bin.js"), "doctor", "--project", agent, "--fix", "--auto", "--json"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH!, TONEDIAL_HOME: home, TONEDIAL_AGENT_HOME: agent, HOME: agent },
  });
  assert.equal(JSON.parse(result.stdout).appHealthy, true);
  assert.deepEqual(readFileSync(shim), before);
  assert.equal(statSync(shim).mode & 0o777, 0o644);
  const commandCheck = JSON.parse(result.stdout).checks.find((check: { name: string }) => check.name === "tonedial");
  assert.equal(commandCheck.state, "problem");
  assert.match(commandCheck.repair, /--repair/);
  assert.ok(commandCheck.repair.includes(home), "reinstall guidance lost the installed state-root binding");
});

test("an install under a custom root still knows what it is once the variable is gone", async () => {
  // A user's shell does not carry the `TONEDIAL_HOME` they installed with. Without the root
  // baked into the command, `resolvePaths` fell back to `~/.tonedial`, `installShape` found no
  // match and reported npm — which turns off the PATH-line check, the command check, and the
  // right update instruction, all silently.
  const { home, agent } = await install("customroot");
  const payload = JSON.parse(
    (await execFile("tonedial", ["update", "--json"], {
      encoding: "utf8",
      // Deliberately absent, which is the whole point.
      env: { PATH: `${join(home, "bin")}:${process.env.PATH!}`, HOME: agent, TONEDIAL_AGENT_HOME: agent, TONEDIAL_REGISTRY: registry },
    })).stdout,
  ) as { shape: string };
  assert.equal(payload.shape, "curl", "the install misread itself once TONEDIAL_HOME was unset");
});

test("the installer refuses a lib.previous it did not create, rather than deleting it", async () => {
  const home = join(scratch, "prev", "tonedial");
  const agent = join(scratch, "prev", "agent");
  mkdirSync(join(home, "lib.previous"), { recursive: true });
  mkdirSync(agent, { recursive: true });
  // The crash window of an earlier run creates this path, so a user can find their own directory
  // sitting at it. Nothing guarded it, and the installer removed it unconditionally.
  writeFileSync(join(home, "lib.previous", "thesis.txt"), "ten years of work");

  await assert.rejects(() => install("prev"), /did not put it there/);
  assert.ok(existsSync(join(home, "lib.previous", "thesis.txt")), "someone else's file was destroyed");
});

test("a command whose file cannot be read is a problem, not a crash", async () => {
  const { home, agent } = await install("unreadable");
  const shim = join(home, "bin", "tonedial");
  rmSync(shim);
  mkdirSync(shim);

  // `doctor` is the one command whose job is to survive a broken install. Reading this path
  // without a guard threw a raw Node stack trace out of it, taking `--json` — which the skill
  // parses — along with it.
  const payload = JSON.parse(
    (await execFile("node", [join(home, "lib", "dist", "bin.js"), "doctor", "--json"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH!, TONEDIAL_HOME: home, TONEDIAL_AGENT_HOME: agent, HOME: agent },
    })).stdout,
  ) as { checks: { name: string; state: string }[] };
  assert.equal(payload.checks.find((c) => c.name === "tonedial")?.state, "problem");
});

test("a relative TONEDIAL_HOME still installs something that resolves", async () => {
  // The installer exited 0 while producing a shim and a PATH line that were both relative, so
  // the command resolved against whatever directory happened to be current — and `installShape`
  // answered differently depending on where it was called from. The installer's own check passed
  // from its own cwd while the user's shell found nothing.
  const home = join(scratch, "relative");
  mkdirSync(join(home, "agent"), { recursive: true });
  await execFile("sh", [join(repo, "install.sh")], {
    encoding: "utf8",
    cwd: home,
    timeout: 60_000,
    env: {
      PATH: process.env.PATH!,
      TMPDIR: scratch,
      TONEDIAL_REGISTRY: registry,
      TONEDIAL_HOME: "tonedial",
      TONEDIAL_AGENT_HOME: join(home, "agent"),
      HOME: join(home, "agent"),
    },
  });
  const bin = join(home, "tonedial", "bin");
  const shim = readFileSync(join(bin, "tonedial"), "utf8");
  // Absolute, asked of the path rather than of a spelling it must not have. The old form
  // excluded one relative prefix, which stopped meaning anything the moment the entry moved.
  const target = /exec node "([^"]+)"/.exec(shim)![1]!;
  assert.ok(target.startsWith("/"), `the command carries a relative path: ${shim}`);
  assert.ok(existsSync(target), `the command points at nothing: ${target}`);

  // Run it from somewhere else entirely, which is what a shell does.
  const version = (await execFile("tonedial", ["--version"], {
    encoding: "utf8",
    cwd: scratch,
    env: { PATH: `${bin}:${process.env.PATH!}`, HOME: join(home, "agent"), TONEDIAL_AGENT_HOME: join(home, "agent") },
  })).stdout;
  assert.match(version, /tonedial \d/);
});

test("update replaces lib and leaves the command working", async () => {
  const { home, agent } = await install("selfupdate");
  const before = readFileSync(join(home, "lib", "package.json"), "utf8");
  const oldIdentity = lstatSync(join(home, "lib"), { bigint: true }).ino;
  await byName(home, agent, "init", "--global", "--lang", "en", "--auto", "--tools", "none");
  await serving({ version: "9.9.9" }, async () => {
    const payload = JSON.parse(await byName(home, agent, "update", "--json", "--auto")) as {
      replaced: string | null;
      checkedRemote: boolean;
    };
    // The version the tarball declares, not the one the metadata claimed. The stub serves the
    // packed artifact under a made-up number, and reporting that number was a lie `update` told
    // about itself — and it made the no-op check compare metadata against this process's own
    // constant, so it swapped again on every run forever.
    assert.equal(payload.replaced, packedVersion);
    assert.equal(payload.checkedRemote, true);
  });
  // The old copy is gone and the new one is whole.
  assert.notEqual(lstatSync(join(home, "lib"), { bigint: true }).ino, oldIdentity, "update did not replace the package");
  assert.equal(readFileSync(join(home, "lib", "package.json"), "utf8"), before);
  assert.ok(!existsSync(join(home, "lib.previous")), "the previous copy was left behind");
  // The command points at `lib/`, and the swap is what could have moved it.
  assert.match(await byName(home, agent, "--version"), /tonedial \d/);
  // The user's own state is not the package.
  assert.ok(existsSync(join(home, "config.json")));
  assert.ok(existsSync(join(home, "presets", "builtin", "tough-love.json")));
});

test("a tarball that fails its hash leaves the install untouched", async () => {
  const { home, agent } = await install("corrupt");
  const before = readFileSync(join(home, "lib", "package.json"), "utf8");
  await serving({ version: "9.9.9", tarball: Buffer.concat([packedBytes, Buffer.from("corruption")]) }, () =>
    // Matched, not merely rejected. A renamed flag or a stub timeout would satisfy a bare
    // `rejects` and prove nothing about the hash.
    assert.rejects(() => byName(home, agent, "update", "--auto"), /download hash differs from the registry/));
  // The check that matters: a failed update is not a broken install.
  assert.equal(readFileSync(join(home, "lib", "package.json"), "utf8"), before);
  assert.ok(!existsSync(join(home, "lib.previous")), "a half-swapped state was left behind");
  assert.match(await byName(home, agent, "--version"), /tonedial \d/);
});

test("update --dry-run says what it would do and writes nothing", async () => {
  const { home, agent } = await install("dryrun");
  writeFileSync(join(home, "lib", "MARKER"), "old");
  await serving({ version: "9.9.9" }, async () => {
    const out = await byName(home, agent, "update", "--dry-run");
    // The dry-run line specifically. Matching the version alone could not tell it from the
    // line that prints the same version on every branch.
    assert.match(out, /would replace/);
  });
  assert.ok(existsSync(join(home, "lib", "MARKER")), "--dry-run replaced lib");
});

test("update on the version already installed replaces nothing", async () => {
  const { home, agent } = await install("current");
  writeFileSync(join(home, "lib", "MARKER"), "old");
  // Stated rather than inherited: the stub serves the packed version, which is what is
  // installed, so this is the same-version branch by construction rather than by coincidence.
  const payload = JSON.parse(await byName(home, agent, "update", "--json", "--auto")) as { replaced: string | null };
  assert.equal(payload.replaced, null);
  assert.ok(existsSync(join(home, "lib", "MARKER")), "an unchanged version was swapped anyway");
});

test("an update that cannot write leaves the install exactly as it was", async () => {
  // This remains a pre-swap permissions regression; post-swap rollback has a separate test above.
  const { home, agent } = await install("preflight-write-failure");
  const beforePackage = readFileSync(join(home, "lib", "package.json"));
  const before = readdirSorted(join(home, "lib"));

  chmodSync(home, 0o500);
  try {
    await serving({ version: "9.9.9" }, () => assert.rejects(() => byName(home, agent, "update", "--auto")));
  } finally {
    chmodSync(home, 0o755);
  }

  assert.deepEqual(readFileSync(join(home, "lib", "package.json")), beforePackage);
  assert.deepEqual(readdirSorted(join(home, "lib")), before);
  assert.ok(!existsSync(join(home, "lib.previous")), "the previous copy was left behind");
  assert.match(await byName(home, agent, "--version"), /tonedial \d/);
});

test("a sibling directory this installer did not create is refused, not removed", async () => {
  // `install.sh` refuses both siblings without the marker, and it refuses them because the
  // first version of that guard read a `package.json` and destroyed someone's own tree. The
  // native swap implemented the same steps and skipped the check.
  const { home, agent } = await install("sibling");
  mkdirSync(join(home, "lib.previous"), { recursive: true });
  writeFileSync(join(home, "lib.previous", "thesis.txt"), "ten years of work");

  await serving({ version: "9.9.9" }, () =>
    assert.rejects(() => byName(home, agent, "update", "--auto"), /did\s+not\s+put\s+it\s+there/));
  assert.ok(existsSync(join(home, "lib.previous", "thesis.txt")), "someone else's file was removed");
  assert.equal(readFileSync(join(home, "lib.previous", "thesis.txt"), "utf8"), "ten years of work");
});

test("an integrity string that is not sha512 is refused, whatever it names", async () => {
  // The algorithm used to come from the response being checked, so a registry naming `md5`
  // would have had its own answer accepted — the party under check choosing the check.
  const { home, agent } = await install("algorithm");
  const weak = `md5-${createHash("md5").update(readFileSync(join(scratch, "pack", readdirSorted(join(scratch, "pack"))[0]!))).digest("base64")}`;
  await serving({ version: "9.9.9", integrity: weak }, () =>
    assert.rejects(() => byName(home, agent, "update", "--auto"), /download hash differs from the registry/));
  // And a correct sha512 still passes, so this is a pin rather than a wall.
  await serving({ version: "9.9.9" }, async () => {
    const payload = JSON.parse(await byName(home, agent, "update", "--json", "--auto")) as { replaced: string | null };
    assert.equal(payload.replaced, packedVersion);
  });
});

test("update refuses rather than asks when there is no terminal, and says what to run", async () => {
  // The only `confirm()` in the tool that was not guarded. With stdin a pipe it waited forever
  // and with stdin closed it exited 13 — either way `--json` never parsed, and `--json` is what
  // the skill drives.
  const { home, agent } = await install("noterminal");
  await serving({ version: "9.9.9" }, async () => {
    const payload = JSON.parse(await byName(home, agent, "update", "--json")) as {
      ok: boolean;
      replaced: string | null;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.replaced, null, "it replaced without being asked");
  });
  assert.ok(existsSync(join(home, "lib", "package.json")));
});

test("a sibling the guard refuses is still there afterwards", async () => {
  // The cleanup ran on the throw path too, so `update` said "this tool did not put it there"
  // and then removed it — undoing the refusal it had just made.
  const { home, agent } = await install("cleanup");
  mkdirSync(join(home, "lib.incoming"), { recursive: true });
  writeFileSync(join(home, "lib.incoming", "theirs.txt"), "not ours");

  await serving({ version: "9.9.9" }, () =>
    assert.rejects(() => byName(home, agent, "update", "--auto"), /did\s+not\s+put\s+it\s+there/));
  assert.ok(existsSync(join(home, "lib.incoming", "theirs.txt")), "the refused directory was deleted anyway");
  assert.equal(readFileSync(join(home, "lib.incoming", "theirs.txt"), "utf8"), "not ours");
});

test("a registry answering null is refused inside the json envelope", async () => {
  const { home, agent } = await install("nullbody");
  await serving({ version: "9.9.9", raw: "null" }, async () => {
    await assert.rejects(() => byName(home, agent, "update", "--json"));
  });
  assert.ok(existsSync(join(home, "lib", "package.json")));
});

test("fresh install writes only the package and absolute command shim", async () => {
  const result = await install("fresh");
  assert.match(result.stdout, /Installed tonedial into/);
  assert.match(result.stdout, /Run ["'][^"']+\/bin\/tonedial["'] init/);
  assert.ok(existsSync(join(result.home, "lib", "package.json")));
  assert.ok(statSync(join(result.home, "bin", "tonedial")).mode & 0o111);
  assert.match(await byName(result.home, result.agent, "--version"), /tonedial \d/);
  noUserState(result.home, result.agent, result.shellHome);
});

test("same-format reinstall preserves state, agent files, rc files, and command reachability", async () => {
  const first = await install("reinstall");
  const userFiles: Record<string, string> = {
    [join(first.home, "config.json")]: "user config\n",
    [join(first.home, "AGENTS.md")]: "user guide\n",
    [join(first.home, "TONE.md")]: "user tone\n",
    [join(first.home, "reader.mjs")]: "user reader\n",
    [join(first.home, "presets", "mine.json")]: "user preset\n",
    [join(first.agent, ".claude", "CLAUDE.md")]: "user instructions\n",
    [join(first.shellHome, ".zshrc")]: "user shell\n",
  };
  for (const [path, contents] of Object.entries(userFiles)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  const before = new Map(Object.keys(userFiles).map((path) => [path, readFileSync(path, "utf8")]));
  await install("reinstall");
  for (const [path, contents] of before) assert.equal(readFileSync(path, "utf8"), contents);
  assert.equal(existsSync(join(first.home, "lib.previous")), false);
  assert.equal(existsSync(join(first.home, "lib.incoming")), false);
  assert.match(await byName(first.home, first.agent, "--version"), /tonedial \d/);
  assert.deepEqual(readdirSorted(join(first.home, "bin")), ["tonedial"]);
});

test("the install receipt remains runnable with quoted Unicode and shell metacharacters", async () => {
  const first = await install("quote 한글 '$HOME `uname` \" ");
  const line = first.stdout.split("\n").find((line) => line.startsWith("Run "));
  assert.ok(line);
  const command = line.slice(4, line.indexOf(" init to create"));
  const result = await execFile("sh", ["-c", `${command} --version --json`], {
    cwd: scratch,
    timeout: 10_000,
    encoding: "utf8",
    env: isolatedEnv(),
  });
  assert.equal(JSON.parse(result.stdout).version, packedVersion);
  noUserState(first.home, first.agent, first.shellHome);
});

test("a packed setup refusal for an unknown target leaves shell and user state untouched", async () => {
  const first = await install("explicit-path");
  noUserState(first.home, first.agent, first.shellHome);
  await assert.rejects(() => execFile(join(first.home, "bin", "tonedial"), ["init", "--global", "--lang", "en", "--auto", "--tools", "other-agent"], {
    timeout: 10_000,
    encoding: "utf8",
    env: isolatedEnv({ HOME: first.shellHome, TONEDIAL_AGENT_HOME: first.agent, SHELL: "/bin/bash" }),
  }), /unsupported tool/);
  noUserState(first.home, first.agent, first.shellHome);
  assert.match(await byName(first.home, first.agent, "--version"), /tonedial \d/);
});

test("the packed build writes native setup into the selected roots and nowhere else", async () => {
  const first = await install("packed-native");
  noUserState(first.home, first.agent, first.shellHome);
  await execFile(join(first.home, "bin", "tonedial"), ["init", "--global", "--lang", "en", "--auto", "--tools", "codex"], {
    timeout: 20_000,
    encoding: "utf8",
    env: isolatedEnv({ HOME: first.shellHome, TONEDIAL_AGENT_HOME: first.agent, SHELL: "/bin/bash" }),
  });

  // What ships is compiled JavaScript under `dist/`, and this is the only check that the route
  // works from there rather than from the checkout the rest of the suite runs against.
  for (const path of ["config.json", "AGENTS.md", "TONE.md", "reader.mjs"]) {
    assert.equal(existsSync(join(first.home, path)), true, `${path} was not created by the packed build`);
  }
  assert.equal(existsSync(join(first.agent, ".codex", "hooks.json")), true, "the selected host was not configured");
  // A curl install has no npm entry to put the command on PATH, so explicit setup adds one — in
  // a marked region, inside this trial's own shell home, and nowhere else.
  const rc = [".zshrc", ".bash_profile", ".bashrc", ".profile"]
    .map((file) => join(first.shellHome, file))
    .filter((path) => existsSync(path));
  assert.equal(rc.length, 1, `explicit setup edited ${rc.length} shell files`);
  assert.match(readFileSync(rc[0]!, "utf8"), /# tonedial:begin/);
  assert.equal(existsSync(join(first.home, "operations.lock")), false, "the operation lock was left behind");
});

test("a real post-swap verification failure restores the old package and shim", async () => {
  const first = await install("rollback");
  const oldPackage = readFileSync(join(first.home, "lib", "package.json"), "utf8");
  const oldShim = readFileSync(join(first.home, "bin", "tonedial"), "utf8");
  const candidate = makeCandidate("bad-bin", "9.9.9", (path) => {
    writeFileSync(join(path, "dist", "bin.js"), "process.stdout.write(JSON.stringify({ok:true,version:'wrong'}) + '\\n');\n");
  });
  await assert.rejects(() => invokeInstaller(first.home, candidate), /verification|new tonedial command/);
  assert.equal(readFileSync(join(first.home, "lib", "package.json"), "utf8"), oldPackage);
  assert.equal(readFileSync(join(first.home, "bin", "tonedial"), "utf8"), oldShim);
  assert.equal(existsSync(join(first.home, "lib.previous")), false);
  assert.equal(existsSync(join(first.home, "operations.lock")), false);
  assert.match(await byName(first.home, first.agent, "--version"), /tonedial \d/);
});

test("cleanup failure after verification retains the runnable new package and recovery record", async () => {
  const first = await install("cleanup-failure");
  // Inject one filesystem failure after verification, including a partial backup deletion.
  // Changing package permissions beforehand would instead fail its ownership fingerprint.
  const fault = join(scratch, "cleanup-fault.mjs");
  writeFileSync(fault, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const remove = fs.rmSync;
    fs.rmSync = (path, options) => {
      if (String(path).endsWith("/operations.lock/previous")) {
        remove(String(path) + "/dist/bin.js");
        throw new Error("injected partial backup cleanup failure");
      }
      return remove(path, options);
    };
    syncBuiltinESMExports();
  `);
  const candidate = makeCandidate("cleanup-failure", "9.9.9");
  await assert.rejects(() => invokeInstaller(first.home, candidate, { NODE_OPTIONS: `--import=${fault}` }), /cleanup needs manual recovery/);
  assert.equal(JSON.parse(readFileSync(join(first.home, "lib", "package.json"), "utf8")).version, "9.9.9");
  assert.match(await byName(first.home, first.agent, "--version"), /tonedial \d/);
  const lock = join(first.home, "operations.lock");
  assert.ok(existsSync(join(lock, "previous")), "the backup disappeared after cleanup failure");
  assert.equal(existsSync(join(lock, "previous", "dist", "bin.js")), false, "fault did not reach partial cleanup");
});

test("foreign packages, package links, and non-file commands are preserved", async () => {
  const foreign = join(scratch, "foreign", "tonedial");
  mkdirSync(join(foreign, "lib", "dist"), { recursive: true });
  writeFileSync(join(foreign, "lib", "package.json"), '{"name":"tonedial"}');
  writeFileSync(join(foreign, "lib", "dist", "mine.js"), "mine\n");
  await assert.rejects(() => install("foreign"), /did not put it there|did not create it/);
  assert.equal(readFileSync(join(foreign, "lib", "dist", "mine.js"), "utf8"), "mine\n");

  const edited = await install("edited");
  const editedPackage = join(edited.home, "lib", "package.json");
  writeFileSync(editedPackage, readFileSync(editedPackage, "utf8") + "\nuser edit\n");
  await assert.rejects(() => install("edited"), /did not put it there/);
  assert.match(readFileSync(editedPackage, "utf8"), /user edit/);

  const linked = join(scratch, "linked", "tonedial");
  const outside = join(scratch, "linked", "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "sentinel"), "keep\n");
  mkdirSync(linked, { recursive: true });
  symlinkSync(outside, join(linked, "lib"));
  await assert.rejects(() => install("linked"), /did not put it there/);
  assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep\n");

  const command = join(scratch, "linked-command", "tonedial", "bin", "tonedial");
  mkdirSync(dirname(command), { recursive: true });
  const referent = join(scratch, "linked-command", "outside-command");
  writeFileSync(referent, "someone else's command\n");
  symlinkSync(referent, command);
  await assert.rejects(() => install("linked-command"), /install target contains a symbolic link/);
  assert.ok(lstatSync(command).isSymbolicLink());
  assert.equal(readFileSync(referent, "utf8"), "someone else's command\n");

  const directoryCommand = join(scratch, "directory-command", "tonedial", "bin", "tonedial");
  mkdirSync(directoryCommand, { recursive: true });
  writeFileSync(join(directoryCommand, "sentinel"), "keep\n");
  await assert.rejects(() => install("directory-command"), /did not put it there/);
  assert.equal(readFileSync(join(directoryCommand, "sentinel"), "utf8"), "keep\n");
});

test("a dead recorded prepared state is recovered before the next install", async () => {
  const first = await install("interrupted");
  const root = first.home;
  const operationId = "a".repeat(32);
  const lock = join(root, "operations.lock");
  mkdirSync(lock, { recursive: true });
  const deadPid = 2_147_483_000;
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ schema: 1, kind: "install", operationId, nonce: "b".repeat(32), pid: deadPid, startedAt: new Date(0).toISOString() }),
  );
  const command = join(root, "bin", "tonedial");
  writeFileSync(
    join(lock, "record.json"),
    JSON.stringify({
      schema: 1,
      kind: "install",
      operationId,
      root,
      state: "prepared",
      candidate: { version: packedVersion, packageDigest: "c".repeat(64) },
      candidateSnapshot: null,
      before: {
        lib: testSnapshot(join(root, "lib")),
        bin: testSnapshot(join(root, "bin")),
        command: testSnapshot(command, true),
      },
      after: { lib: null, command: null },
      desiredCommand: { bytes: readFileSync(command).toString("base64"), mode: statSync(command).mode & 0o7777 },
      cleanup: "pending",
    }),
  );
  const candidate = makeCandidate("interrupted", "9.9.9");
  await invokeInstaller(root, candidate);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(join(root, "lib.previous")), false);
  assert.match(await byName(root, first.agent, "--version"), /tonedial \d/);
});

test("live and malformed locks fail closed and remain untouched", async () => {
  const live = join(scratch, "live-lock", "tonedial");
  mkdirSync(join(live, "operations.lock"), { recursive: true });
  writeFileSync(
    join(live, "operations.lock", "owner.json"),
    JSON.stringify({ schema: 1, kind: "install", operationId: "d".repeat(32), nonce: "e".repeat(32), pid: process.pid, startedAt: new Date().toISOString() }),
  );
  const liveCandidate = makeCandidate("live-lock", "9.9.9");
  await assert.rejects(() => invokeInstaller(live, liveCandidate), /busy or ambiguous/);
  assert.ok(existsSync(join(live, "operations.lock", "owner.json")));
  assert.equal(existsSync(join(live, "lib")), false);

  const malformed = join(scratch, "malformed-lock", "tonedial");
  mkdirSync(join(malformed, "operations.lock"), { recursive: true });
  writeFileSync(join(malformed, "operations.lock", "owner.json"), JSON.stringify({
    schema: 1,
    kind: "install",
    operationId: "../escape",
    nonce: "f".repeat(32),
    pid: 2_147_483_000,
    startedAt: new Date(0).toISOString(),
  }));
  const malformedCandidate = makeCandidate("malformed-lock", "9.9.9");
  await assert.rejects(() => invokeInstaller(malformed, malformedCandidate), /valid owner/);
  assert.ok(existsSync(join(malformed, "operations.lock", "owner.json")));
  assert.equal(existsSync(join(malformed, "lib")), false);
});

test("a killed post-swap installer recovers without its original staging package", async () => {
  const first = await install("killed-owner");
  const candidate = makeCandidate("killed-owner", "9.9.9", (path) => {
    writeFileSync(join(path, "dist", "bin.js"), "process.kill(process.ppid, 'SIGKILL');\n");
  });
  await assert.rejects(() => invokeInstaller(first.home, candidate), (error: unknown) => {
    assert.equal((error as { signal: string }).signal, "SIGKILL");
    return true;
  });
  const lock = join(first.home, "operations.lock");
  const interrupted = JSON.parse(readFileSync(join(lock, "record.json"), "utf8"));
  assert.equal(interrupted.state, "shim-written", "the kill must happen after both final writes");
  assert.ok(existsSync(join(lock, "previous", "dist", "bin.js")));
  rmSync(candidate, { recursive: true });
  const next = makeCandidate("after-killed-owner", "10.0.0");
  await invokeInstaller(first.home, next);
  const version = JSON.parse(await byName(first.home, first.agent, "--version", "--json"));
  assert.equal(version.version, "10.0.0");
  assert.equal(existsSync(lock), false);
  noUserState(first.home, first.agent, first.shellHome);
});

test("a second installer cannot replace a package while its owner verifies it", async () => {
  const first = await install("concurrent-owner");
  const ready = join(scratch, "verification-ready");
  const release = join(scratch, "verification-release");
  const candidate = makeCandidate("concurrent-owner", "9.9.9", (path) => {
    writeFileSync(join(path, "dist", "bin.js"), `
      import { existsSync, writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(ready)}, "ready");
      const timer = setInterval(() => {
        if (!existsSync(${JSON.stringify(release)})) return;
        clearInterval(timer);
        console.log(JSON.stringify({ ok: true, version: "9.9.9" }));
      }, 20);
    `);
  });
  const owner = invokeInstaller(first.home, candidate);
  // Observe the owner's outcome immediately so a setup failure cannot become an unhandled rejection.
  const settled = owner.then(() => null, (error: unknown) => error);
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(ready), "owner did not reach post-swap verification");
    const before = readFileSync(join(first.home, "operations.lock", "owner.json"));
    const next = makeCandidate("concurrent-contender", "10.0.0");
    await assert.rejects(() => invokeInstaller(first.home, next), /busy or ambiguous/);
    assert.deepEqual(readFileSync(join(first.home, "operations.lock", "owner.json")), before);
    assert.equal(JSON.parse(readFileSync(join(first.home, "lib", "package.json"), "utf8")).version, "9.9.9");
  } finally {
    writeFileSync(release, "continue");
    const failure = await settled;
    if (failure !== null) throw failure;
  }
  assert.equal(existsSync(join(first.home, "operations.lock")), false);
});

test("recovery preserves linked owner and journal files instead of following them", async () => {
  for (const file of ["owner.json", "record.json"]) {
    const first = await install("linked-record-" + file);
    const candidate = makeCandidate("linked-record-" + file, "9.9.9", (path) => {
      writeFileSync(join(path, "dist", "bin.js"), "process.kill(process.ppid, 'SIGKILL');\n");
    });
    await assert.rejects(() => invokeInstaller(first.home, candidate), (error: unknown) => {
      assert.equal((error as { signal: string }).signal, "SIGKILL");
      return true;
    });
    const path = join(first.home, "operations.lock", file);
    const external = join(scratch, "preserved-" + file);
    renameSync(path, external);
    const bytes = readFileSync(external);
    symlinkSync(external, path);
    const next = makeCandidate("linked-next-" + file, "10.0.0");
    await assert.rejects(() => invokeInstaller(first.home, next), /no valid (owner|install) record/);
    assert.ok(lstatSync(path).isSymbolicLink());
    assert.deepEqual(readFileSync(external), bytes);
    assert.equal(JSON.parse(readFileSync(join(first.home, "lib", "package.json"), "utf8")).version, "9.9.9");
  }
});

test("foreign replacements between install writes are preserved, not adopted for rollback", async () => {
  for (const phase of ["previous", "lib", "command", "same-command"]) {
    const first = await install("replacement-" + phase);
    const fault = join(scratch, "replace-" + phase + ".mjs");
    writeFileSync(fault, `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const root = ${JSON.stringify(first.home)};
      const phase = ${JSON.stringify(phase)};
      const rename = fs.renameSync;
      let changed = false;
      fs.renameSync = (from, to) => {
        let foreign;
        if (!changed && (phase === "command" || phase === "same-command") && to === root + "/bin/tonedial") {
          foreign = to + ".foreign";
          const bytes = phase === "same-command" ? fs.readFileSync(from) : "#!/bin/sh\\nexit 73\\n";
          fs.writeFileSync(foreign, bytes, { mode: 0o755, flag: "wx" });
        }
        rename(from, to);
        if (changed) return;
        if (phase === "previous" && to === root + "/operations.lock/previous") {
          changed = true;
          fs.mkdirSync(root + "/lib");
        } else if (phase === "lib" && from === root + "/operations.lock/candidate") {
          changed = true;
          fs.writeFileSync(root + "/lib/user-note", "external package edit");
        } else if (foreign) {
          changed = true;
          rename(foreign, to);
          fs.writeFileSync(root + "/foreign-command-identity", String(fs.lstatSync(to, { bigint: true }).ino));
        }
      };
      syncBuiltinESMExports();
    `);
    const candidate = makeCandidate("replacement-" + phase, "9.9.9", (path) => {
      if (phase === "lib") writeFileSync(join(path, "dist", "bin.js"), "process.exit(73);\n");
    });
    await assert.rejects(() => invokeInstaller(first.home, candidate, { NODE_OPTIONS: `--import=${fault}` }), /preserving it for manual recovery/, phase);
    if (phase === "previous") assert.deepEqual(readdirSync(join(first.home, "lib")), []);
    if (phase === "lib") assert.equal(readFileSync(join(first.home, "lib", "user-note"), "utf8"), "external package edit");
    if (phase === "command") assert.equal(readFileSync(join(first.home, "bin", "tonedial"), "utf8"), "#!/bin/sh\nexit 73\n");
    if (phase === "same-command") assert.equal(String(lstatSync(join(first.home, "bin", "tonedial"), { bigint: true }).ino), readFileSync(join(first.home, "foreign-command-identity"), "utf8"));
    assert.ok(existsSync(join(first.home, "operations.lock", "record.json")));
  }
});

test("completed cleanup does not follow an externally linked recovery directory", async () => {
  const first = await install("cleanup-link");
  const external = join(scratch, "external-recovery");
  mkdirSync(external);
  const fault = join(scratch, "cleanup-link.mjs");
  writeFileSync(fault, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const root = ${JSON.stringify(first.home)};
    const external = ${JSON.stringify(external)};
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (from !== root + "/operations.lock") return;
      const owner = JSON.parse(fs.readFileSync(to + "/owner.json", "utf8"));
      const { kind, ...lease } = owner;
      fs.writeFileSync(external + "/lease.json", JSON.stringify(lease));
      fs.symlinkSync(external, to + "/recovery");
    };
    syncBuiltinESMExports();
  `);
  const candidate = makeCandidate("cleanup-link", "9.9.9");
  await invokeInstaller(first.home, candidate, { NODE_OPTIONS: `--import=${fault}` });
  assert.ok(existsSync(join(external, "lease.json")), "cleanup deleted an external lease");
  const completed = readdirSync(join(first.home, "operations"));
  assert.equal(completed.length, 1);
  assert.ok(existsSync(join(first.home, "operations", completed[0]!, "record.json")));
  assert.equal(JSON.parse(await byName(first.home, first.agent, "--version", "--json")).version, "9.9.9");
});

test("archive links and parent paths are refused before the child installer can write", async () => {
  const first = await install("archive-links");
  const linkedArchive = makeArchive(
    "linked-dist",
    makeCandidate("linked-dist", "9.9.9", (path) => {
      const dist = join(path, "dist");
      renameSync(dist, join(path, "dist-real"));
      symlinkSync("dist-real", dist);
    }),
  );
  await serving({ version: "9.9.9", tarball: linkedArchive, integrity: integrityOf(linkedArchive) }, async () => {
    await assert.rejects(() => byName(first.home, first.agent, "update", "--auto"), /download is not a ToneDial package/);
  });
  assert.equal(JSON.parse(readFileSync(join(first.home, "lib", "package.json"), "utf8")).version, packedVersion);

  const linkedEntryArchive = makeArchive(
    "linked-entry",
    makeCandidate("linked-entry", "9.9.9", (path) => {
      const entry = join(path, "dist", "install.js");
      renameSync(entry, join(path, "dist", "install-real.js"));
      symlinkSync("install-real.js", entry);
    }),
  );
  await serving({ version: "9.9.9", tarball: linkedEntryArchive, integrity: integrityOf(linkedEntryArchive) }, async () => {
    await assert.rejects(() => byName(first.home, first.agent, "update", "--auto"), /download is not a ToneDial package/);
  });
  assert.match(await byName(first.home, first.agent, "--version"), /tonedial \d/);

  const traversal = makeTraversalArchive("traversal");
  const traversalRoot = join(scratch, "traversal-install", "tonedial");
  await serving({ version: "9.9.9", tarball: traversal, integrity: integrityOf(traversal) }, async () => {
    await assert.rejects(() => install("traversal-install"), /unsafe member|package/);
  });
  assert.equal(readFileSync(join(scratch, "traversal", "traversal", "outside", "sentinel"), "utf8"), "keep me");
  assert.equal(existsSync(traversalRoot), false);
});

test("the packed installer entry runs through the /tmp alias", async () => {
  const real = join(process.platform === "darwin" ? "/private/tmp" : scratch, "tonedial-alias-" + process.pid + "-" + Date.now());
  const candidate = join(real, "candidate");
  mkdirSync(candidate, { recursive: true });
  cpSync(join(repo, "dist"), join(candidate, "dist"), { recursive: true });
  cpSync(join(repo, "package.json"), join(candidate, "package.json"));
  const alias = process.platform === "darwin" && real.startsWith("/private") ? real.slice("/private".length) : real;
  const root = join(alias, "root");
  try {
    await execFile("node", [join(alias, "candidate", "dist", "install.js"), "--root", root, "--candidate", join(alias, "candidate")], {
      encoding: "utf8",
      timeout: 60_000,
      env: isolatedEnv({ TONEDIAL_HOME: root }),
    });
    assert.ok(existsSync(join(real, "root", "bin", "tonedial")));
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});

test("the old bin/src layout is named and preserved", async () => {
  const home = join(scratch, "old-layout", "tonedial");
  mkdirSync(join(home, "bin", "src"), { recursive: true });
  writeFileSync(join(home, "bin", "package.json"), '{"name":"tonedial"}');
  writeFileSync(join(home, "bin", "src", "old.ts"), "old\n");
  await assert.rejects(() => install("old-layout"), /before this installer split/);
  assert.equal(readFileSync(join(home, "bin", "src", "old.ts"), "utf8"), "old\n");
});

test("the npm channel remains runnable and is unaffected by curl installation", async () => {
  const prefix = join(scratch, "npm-channel");
  mkdirSync(prefix, { recursive: true });
  execFileSync("npm", ["install", "-g", "--prefix", prefix, packedTarball], {
    encoding: "utf8",
    env: isolatedEnv({ HOME: join(scratch, "npm-channel-home") }),
  });
  const result = await execFile(join(prefix, "bin", "tonedial"), ["--version"], {
    encoding: "utf8",
    cwd: scratch,
    env: isolatedEnv({ HOME: join(scratch, "npm-channel-home") }),
  });
  assert.match(result.stdout, /tonedial \d/);
  assert.ok(realpathSync(join(prefix, "bin", "tonedial")).includes(sep + "node_modules" + sep));
});
