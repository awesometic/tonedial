#!/usr/bin/env node
// A local public-release gate. `--tree` and `--history` can qualify a candidate
// before its public identity and npm version are finalized.
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = process.cwd();
const maxTextBytes = 4 * 1024 * 1024;
const forbiddenRoots = new Set([".agents", ".claude", ".codex", ".gemini"]);
const forbiddenFiles = new Set([
  "CLAUDE.md", "docs/RELEASING.local.md",
]);
const binaryExtensions = /\.(?:png|jpe?g|gif|webp|ico|pdf|woff2?|zip|gz|tgz)$/i;
const homePath = /\/(?:Users|home)\/(?!someone\/|you\/|u\/|user\/|example\/|test\/)([\w.-]+)\/(?:Developer|Documents|Desktop|\.tonedial|\.codex|\.claude|\.config)(?:\/|\b)/;
// Pin the full notice from https://www.unicode.org/license.txt (2026-10-11), excluding the fence's closing newline.
const unicodeLicenseBlockSha256 = "8fa201617d2c10c64205a88903dfac046417e6b95748e36b492026fbc38c5b94";
const gitEnv = { ...process.env };
for (const key of Object.keys(gitEnv)) {
  if (key.startsWith("GIT_CONFIG_") ||
      ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"].includes(key)) {
    delete gitEnv[key];
  }
}
gitEnv.GIT_CONFIG_NOSYSTEM = "1";
gitEnv.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
gitEnv.GIT_CONFIG_SYSTEM = gitEnv.GIT_CONFIG_GLOBAL;

function fail(message) {
  process.stderr.write(`Release check: ${message}\n`);
  process.exit(1);
}

function git(args, options = {}) {
  try {
    return execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "buffer", maxBuffer: 32 * 1024 * 1024, ...options });
  } catch (cause) {
    fail(`git ${args[0]} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function entries(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function forbidden(path) {
  const first = path.split("/", 1)[0];
  return forbiddenRoots.has(first) || forbiddenFiles.has(path);
}

function checkPath(path, context) {
  if (forbidden(path)) fail(`${context}: private path ${path}`);
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example") ||
      /\.(?:pem|key)$/.test(name) || name.includes("id_rsa") ||
      /secret|token|password|vault/.test(name)) {
    fail(`${context}: credential-like path ${path}`);
  }
}

function checkText(bytes, path, context) {
  if (binaryExtensions.test(path) || bytes.includes(0)) return;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return; // Binary data with a text-like filename is not prose to inspect.
  }
  if (homePath.test(text)) fail(`${context}: personal home path in ${path}`);
}

function safeStat(path) {
  let current = root;
  let stat;
  for (const part of path.split("/")) {
    current = join(current, part);
    stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) fail(`tree: missing entry ${path}`);
    if (stat.isSymbolicLink()) fail(`tree: symlink ${path}`);
  }
  if (!stat?.isFile()) fail(`tree: non-regular entry ${path}`);
  return stat;
}

function readTreeFile(path, stat) {
  if (binaryExtensions.test(path)) return;
  if (stat.size > maxTextBytes) fail(`tree: file too large to inspect ${path}`);
  const fd = openSync(join(root, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) fail(`tree: non-regular entry ${path}`);
    if (opened.size > maxTextBytes) fail(`tree: file too large to inspect ${path}`);
    const chunks = [];
    let bytes = 0;
    while (bytes <= maxTextBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxTextBytes + 1 - bytes));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      bytes += count;
    }
    if (bytes > maxTextBytes) fail(`tree: file too large to inspect ${path}`);
    checkText(Buffer.concat(chunks), path, "tree");
  } finally {
    closeSync(fd);
  }
}

function checkTree() {
  const seen = new Set();
  for (const row of entries(git(["ls-files", "--stage", "--cached", "-z"]))) {
    const tab = row.indexOf("\t");
    if (tab < 0) fail("git index has an unreadable entry");
    const path = row.slice(tab + 1);
    const [mode, , stage] = row.slice(0, tab).split(" ");
    checkPath(path, "tree");
    if (stage !== "0") fail(`tree: unresolved index entry ${path}`);
    if (mode !== "100644" && mode !== "100755") fail(`tree: symlink or non-file ${path}`);
    if (seen.has(path)) continue;
    seen.add(path);
    readTreeFile(path, safeStat(path));
  }
  for (const path of entries(git(["ls-files", "--others", "--exclude-standard", "-z"]))) {
    checkPath(path, "tree");
    if (seen.has(path)) continue;
    readTreeFile(path, safeStat(path));
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(join(root, path), "utf8"));
  } catch {
    fail(`missing or invalid ${path}`);
  }
}

function checkVersionConsistency(manifest) {
  const lock = readJson("package-lock.json");
  if (lock.version !== manifest.version) {
    fail("package-lock.json version does not match package.json");
  }
  if (lock.packages?.[""]?.version !== manifest.version) {
    fail('package-lock.json packages[""] version does not match package.json');
  }
  const cli = readFileSync(join(root, "src", "cli.ts"), "utf8");
  const match = cli.match(/export\s+const\s+VERSION\s*=\s*"([^"]+)";/);
  if (!match) fail("src/cli.ts VERSION literal is missing");
  if (match[1] !== manifest.version) {
    fail("src/cli.ts VERSION does not match package.json");
  }
}

function releaseRepository() {
  const marker = readJson(".public-release.json");
  const repository = marker?.repository;
  if (typeof repository !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
    fail(".public-release.json must name an exact https://github.com/OWNER/REPO repository");
  }
  if (repository !== "https://github.com/awesometic/tonedial") {
    fail("public release identity must be https://github.com/awesometic/tonedial");
  }
  if (!git(["ls-files", "--cached", "--", ".public-release.json"]).toString("utf8").trim()) {
    fail(".public-release.json must be committed in the public repository");
  }
  return repository;
}

function checkIdentity(repository) {
  const manifest = readJson("package.json");
  if (manifest?.name !== "tonedial" || typeof manifest.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version) || manifest.version === "0.0.0") {
    fail("package.json needs a release version other than 0.0.0");
  }
  checkVersionConsistency(manifest);
  if (manifest.repository?.url !== `git+${repository}.git`) {
    fail("package.json repository does not match .public-release.json");
  }
  const installer = readFileSync(join(root, "install.sh"), "utf8");
  const [owner, name] = repository.slice("https://github.com/".length).split("/");
  const expectedInstallUrl = `https://raw.githubusercontent.com/${owner}/${name}/main/install.sh`;
  const urls = [...installer.matchAll(/https:\/\/raw\.githubusercontent\.com\/[^\s"']+\/install\.sh/g)].map((match) => match[0]);
  if (urls.length === 0 || urls.some((url) => url !== expectedInstallUrl)) {
    fail("install.sh self-install URL does not match .public-release.json");
  }
  const remotes = git(["remote", "-v"]).toString("utf8");
  const remoteUrls = remotes.split("\n").map((line) => line.split(/\s+/)[1]).filter(Boolean);
  const https = `${repository}.git`;
  const ssh = `git@github.com:${owner}/${name}.git`;
  const sshUrl = `ssh://git@github.com/${owner}/${name}.git`;
  if (!remoteUrls.some((url) => [repository, https, ssh.slice(0, -4), ssh, sshUrl.slice(0, -4), sshUrl].includes(url))) {
    fail("no configured GitHub remote matches .public-release.json");
  }
}

function checkHistory() {
  const inspectedBlobs = new Set();
  for (const commit of git(["rev-list", "HEAD"]).toString("utf8").trim().split("\n")) {
    if (!commit) continue;
    checkText(git(["show", "-s", "--format=%B", commit]), "commit message", `history ${commit.slice(0, 12)}`);
    for (const row of entries(git(["ls-tree", "-r", "-z", "--full-tree", commit]))) {
      const tab = row.indexOf("\t");
      if (tab < 0) fail(`history ${commit.slice(0, 12)}: unreadable tree entry`);
      const [mode, type, object] = row.slice(0, tab).split(" ");
      const path = row.slice(tab + 1);
      checkPath(path, `history ${commit.slice(0, 12)}`);
      if (mode !== "100644" && mode !== "100755") fail(`history ${commit.slice(0, 12)}: symlink or non-file ${path}`);
      if (type !== "blob" || inspectedBlobs.has(object) || binaryExtensions.test(path)) continue;
      inspectedBlobs.add(object);
      const size = Number(git(["cat-file", "-s", object]).toString("utf8").trim());
      if (!Number.isSafeInteger(size) || size > maxTextBytes) fail(`history ${commit.slice(0, 12)}: file too large to inspect ${path}`);
      checkText(git(["cat-file", "blob", object]), path, `history ${commit.slice(0, 12)}`);
    }
  }
}

function checkPackage() {
  const expected = new Set(entries(git(["ls-files", "-z", "--", "src/"]))
    .filter(path => path.endsWith(".ts"))
    .map(path => path.replace(/^src\//, "dist/").replace(/\.ts$/, ".js")));
  if (!expected.size) fail("no tracked runtime source to verify the package against");
  const scratch = mkdtempSync(join(tmpdir(), "tonedial-pack-check-"));
  let packed;
  try {
    packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--offline", "--json"], {
      cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch,
        npm_config_userconfig: join(scratch, "npmrc"), npm_config_globalconfig: join(scratch, "globalrc"),
        npm_config_cache: join(scratch, "cache"), npm_config_update_notifier: "false",
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (packed.error || packed.status !== 0) fail("cannot inspect npm package contents");
  let files;
  try { files = JSON.parse(packed.stdout)[0].files; }
  catch { fail("npm did not return a package file list"); }
  if (!Array.isArray(files) || !files.length) fail("npm package has no files");
  const allowed = new Set(["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "README.ko.md", "README.ja.md", "README.zh.md", "README.es.md", "package.json"]);
  const found = new Set();
  for (const entry of files) {
    const path = entry.path;
    if (typeof path !== "string" || (!expected.has(path) && !allowed.has(path))) {
      fail(`unapproved packed file: ${JSON.stringify(path)}`);
    }
    found.add(path);
    readTreeFile(path, safeStat(path));
  }
  for (const path of expected) if (!found.has(path)) fail(`missing compiled runtime file: ${path}`);
  for (const path of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    if (!found.has(path)) fail(`missing required package file: ${path}`);
  }
  const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const unicodeNoticeMatch = notices.match(/## Unicode Character Database[\s\S]*?```text\n(UNICODE LICENSE V3\n[\s\S]*?)\n```/);
  const unicodeNoticeHash = unicodeNoticeMatch
    ? createHash("sha256").update(unicodeNoticeMatch[1], "utf8").digest("hex")
    : "";
  if (unicodeNoticeHash !== unicodeLicenseBlockSha256) {
    fail("THIRD_PARTY_NOTICES.md does not contain the current Unicode License v3 notice");
  }
}

const mode = process.argv[2];
if (process.argv.length > 3 || (mode !== undefined && mode !== "--tree" && mode !== "--history")) {
  fail("usage: node scripts/check-release.mjs [--tree | --history]");
}
const gitRoot = git(["rev-parse", "--show-toplevel"]).toString("utf8").trim();
if (realpathSync(gitRoot) !== realpathSync(root)) fail("run this check from the repository root");
checkTree();
if (mode === "--tree") {
  process.stdout.write("Release tree check passed.\n");
} else if (mode === "--history") {
  checkHistory();
  process.stdout.write("Release tree and history check passed.\n");
} else {
  const repository = releaseRepository();
  if (git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length) fail("Git working tree is not clean");
  checkIdentity(repository);
  checkHistory();
  checkPackage();
  process.stdout.write(`Release check passed for ${repository}.\n`);
}
