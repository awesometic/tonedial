// Bounded release download and extraction; the candidate installer owns package replacement.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { ConfigError } from "./config.ts";
import type { Messages } from "./i18n.ts";
import { decodeUtf8, getBounded, urlIdentity } from "./net.ts";
import { fileIdentity, onPath, type Paths } from "./paths.ts";

/** Where releases come from. Overridable for tests, exactly as `install.sh` overrides it. */
export const REGISTRY = "https://registry.npmjs.org";

/**
 * The most a release may weigh. The small CLI package gets generous headroom while the read
 * stays bounded. Node's `fetch` decompresses transparently, so the check is on what arrives.
 */
export const RELEASE_MAX_BYTES = 16 * 1024 * 1024;

/** How long to wait on a registry that is not answering. */
export const RELEASE_TIMEOUT_MS = 30_000;

const TARBALL_BOUNDS = { maxBytes: RELEASE_MAX_BYTES, timeoutMs: RELEASE_TIMEOUT_MS };
/** Metadata is a small JSON document. The tarball's cap here would hand `JSON.parse` 16 MB. */
const METADATA_BOUNDS = { maxBytes: 1024 * 1024, timeoutMs: RELEASE_TIMEOUT_MS };

export type Release = { version: string; tarball: string; integrity: string };

/** The version the package on disk declares, or `null` where it cannot be read. */
export function installedVersion(paths: Pick<Paths, "lib">): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(paths.lib, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    return raw.name === "tonedial" && typeof raw.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(raw.version)
      ? raw.version : null;
  } catch {
    return null;
  }
}

export type NpmInstall = { entry: string; prefix: string; root: string; version: string };

/** Bind npm's global target to this running copy before allowing package-manager writes. */
export function inspectNpmInstall(env: NodeJS.ProcessEnv, t: Messages): NpmInstall {
  const executable = onPath("npm", env);
  if (executable === null) throw new ConfigError(t.update.npmMissing);
  const entry = resolve(executable);
  const query = (args: string[]): string => {
    const result = spawnSync(entry, args, { env, encoding: "utf8", timeout: RELEASE_TIMEOUT_MS, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const value = result.stdout?.trim();
    if (result.status !== 0 || !value || !isAbsolute(value) || /[\r\n\0]/.test(value)) throw new ConfigError(t.update.npmScopeUnknown);
    return resolve(value);
  };
  const prefix = query(["prefix", "-g"]);
  const root = join(query(["root", "-g", "--prefix", prefix]), "tonedial");
  try {
    const own = fileURLToPath(new URL("../../", import.meta.url));
    const current = fileIdentity(own);
    const target = fileIdentity(root);
    const version = installedVersion({ lib: root });
    if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink() || current === null || target === null || current.dev !== target.dev || current.ino !== target.ino || version === null) {
      throw new ConfigError(t.update.npmScopeMismatch);
    }
    return { entry, prefix, root, version };
  } catch {
    throw new ConfigError(t.update.npmScopeMismatch);
  }
}

/** npm owns replacement; captured output cannot corrupt JSON or disclose npm configuration. */
export function updateNpmInstall(install: NpmInstall, env: NodeJS.ProcessEnv, t: Messages): string {
  const current = inspectNpmInstall(env, t);
  if (current.entry !== install.entry || current.prefix !== install.prefix || current.root !== install.root || current.version !== install.version) throw new ConfigError(t.update.npmScopeMismatch);
  const result = spawnSync(install.entry, ["update", "-g", "tonedial", "--prefix", install.prefix, "--json"],
    { env, encoding: "utf8", timeout: 120_000, maxBuffer: RELEASE_MAX_BYTES, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new ConfigError(t.update.npmFailed);
  const version = installedVersion({ lib: install.root });
  if (version === null) throw new ConfigError(t.update.versionUnknown);
  return version;
}

/** Whether the one external tool this needs is here. Checked before anything is downloaded. */
export function haveTar(): boolean {
  return spawnSync("tar", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * Check the unpacked release without following links or opening special files. The child
 * installer repeats the check before copying, but this parent must reject a malicious `dist/`
 * parent (or a linked entry point) before it starts any code from the candidate.
 */
function validateUnpackedTree(root: string, t: Messages): void {
  const walk = (directory: string): void => {
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ConfigError(t.update.notAPackage);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      const childStat = lstatSync(child, { throwIfNoEntry: false });
      if (childStat === undefined || childStat.isSymbolicLink()) {
        throw new ConfigError(t.update.notAPackage);
      }
      if (childStat.isDirectory()) {
        walk(child);
      } else if (!childStat.isFile() || childStat.nlink !== 1) {
        throw new ConfigError(t.update.notAPackage);
      }
    }
  };

  walk(root);
}

function tarField(bytes: Buffer, start: number, length: number): string | null {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  const content = end === -1 ? field : field.subarray(0, end);
  const value = content.toString("utf8");
  return value.includes("\ufffd") ? null : value;
}

function tarSize(bytes: Buffer, start: number, length: number): number | null {
  const value = tarField(bytes, start, length);
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  if (!/^[0-7]+$/.test(trimmed)) return null;
  const size = Number.parseInt(trimmed, 8);
  return Number.isSafeInteger(size) ? size : null;
}

function safeArchivePath(path: string): boolean {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = normalized.split("/");
 return (normalized === "package" || normalized.startsWith("package/")) &&
    !/[\u0000-\u001f\u007f]/.test(normalized) &&
   parts.every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * The tar command's listing hides PAX and GNU extension records. Read raw headers first so the
 * narrow package format rejects those records before extraction. Only ordinary ustar
 * regular-file and directory flags are accepted.
 */
function validateRawArchive(archive: string, t: Messages): void {
  let bytes: Buffer;
  try {
    bytes = gunzipSync(readFileSync(archive), { maxOutputLength: RELEASE_MAX_BYTES });
  } catch {
    throw new ConfigError(t.update.notAPackage);
  }
  if (bytes.length === 0 || bytes.length % 512 !== 0) throw new ConfigError(t.update.notAPackage);
  let offset = 0;
  let entries = 0;
  let zeroBlocks = 0;
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.length !== 512) throw new ConfigError(t.update.notAPackage);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += 512;
      continue;
    }
    if (zeroBlocks >= 2) throw new ConfigError(t.update.notAPackage);
    zeroBlocks = 0;
    const type = header[156];
    if (type !== 0 && type !== 48 && type !== 53) throw new ConfigError(t.update.notAPackage);
    const size = tarSize(header, 124, 12);
    const name = tarField(header, 0, 100);
    const prefix = tarField(header, 345, 155);
    if (size === null || name === null || prefix === null) throw new ConfigError(t.update.notAPackage);
    const path = prefix === "" ? name : prefix + "/" + name;
    if (!safeArchivePath(path) || size > RELEASE_MAX_BYTES || offset + 512 + size > bytes.length) {
      throw new ConfigError(t.update.notAPackage);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
    entries += 1;
  }
  if (entries === 0 || zeroBlocks < 2) throw new ConfigError(t.update.notAPackage);
}

/**
 * Inspect archive headers before extraction. The package format is intentionally narrow: every
 * member must be a package-relative regular file or directory. This keeps an absolute/parent
 * path, symlink, hard link, special file, PAX header, or unknown entry from writing anywhere
 * before the unpacked tree validator gets a chance to see it.
 */
function validateArchive(archive: string, t: Messages): void {
  validateRawArchive(archive, t);
  const list = spawnSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: RELEASE_MAX_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const detail = spawnSync("tar", ["-tvzf", archive], {
    encoding: "utf8",
    maxBuffer: RELEASE_MAX_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (list.status !== 0 || detail.status !== 0 || typeof list.stdout !== "string" || typeof detail.stdout !== "string") {
    throw new ConfigError(t.update.notAPackage);
  }
  const names = list.stdout.endsWith("\n") ? list.stdout.slice(0, -1).split("\n") : list.stdout.split("\n");
  const headers = detail.stdout.endsWith("\n") ? detail.stdout.slice(0, -1).split("\n") : detail.stdout.split("\n");
  if (names.length === 0 || names.length !== headers.length) throw new ConfigError(t.update.notAPackage);
  for (const [index, name] of names.entries()) {
    const header = headers[index]!;
    const type = header[0];
    const path = name.endsWith("/") ? name.slice(0, -1) : name;
    if ((type !== "d" && type !== "-") || !safeArchivePath(path)) {
      throw new ConfigError(t.update.notAPackage);
    }
  }
}

/** What the registry says the current release is. */
export async function latestRelease(registry: string, t: Messages): Promise<Release> {
  const source = urlIdentity(registry, t);
  const body = await getBounded(`${registry}/tonedial/latest`, METADATA_BOUNDS, t);
  let raw: { version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } };
  try {
    raw = JSON.parse(decodeUtf8(body, t)) as typeof raw;
  } catch (cause) {
    throw new ConfigError(t.config.fetchFailed(source, t.update.notAPackage), { cause });
  }
  // `null` is valid JSON and destructuring it throws a `TypeError`, which is not a
  // `ConfigError` — so a registry serving `null` emptied `--json` and printed a stack trace.
  if (raw === null || typeof raw !== "object") {
    throw new ConfigError(t.config.fetchFailed(source, t.update.notAPackage));
  }
  const { version, dist } = raw;
  // This is a displayable release label, not arbitrary responder text or version ordering.
  const versionMatch = typeof version === "string" && version.length <= 256 && !/[\p{Cc}]/u.test(version)
    ? /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
    : null;
  if (typeof version !== "string" || versionMatch === null || versionMatch[1]?.split(".").some(identifier => /^0\d+$/.test(identifier)) ||
      typeof dist?.tarball !== "string" || typeof dist.integrity !== "string") {
    throw new ConfigError(t.config.fetchFailed(source, t.update.notAPackage));
  }
  return { version, tarball: dist.tarball, integrity: dist.integrity };
}

/**
 * The release tarball, checked against the hash the registry published with it.
 *
 * That check buys less than it looks like — the URL and the hash arrive in one response, so
 * whoever controls that response controls both. What it does buy is corruption in transit and a
 * tarball host that is not the metadata host, which is the same guarantee `npm install` makes.
 */
export async function downloadRelease(release: Release, t: Messages): Promise<Uint8Array> {
  const body = await getBounded(release.tarball, TARBALL_BOUNDS, t);
  // **The algorithm is pinned, not read.** Taking it from the response let that response name
  // `md5` and still "pass" — the party being checked would have chosen the check. npm publishes
  // `dist.integrity` as sha512, so anything else is not a hash this knows how to trust.
  const digest = release.integrity.startsWith("sha512-") ? release.integrity.slice("sha512-".length) : null;
  if (digest === null || digest === "") throw new ConfigError(t.update.integrityMismatch);
  if (createHash("sha512").update(body).digest("base64") !== digest) {
    throw new ConfigError(t.update.integrityMismatch);
  }
  return body;
}

/**
 * Unpack the release and hand the candidate to the new release's installer entry point.
 *
 * `--no-same-owner` and `--no-same-permissions` for the reason `install.sh` gives: a tarball
 * unpacked as root could otherwise carry setuid bits into a directory this then moves.
 */
export function installRelease(paths: Paths, tarball: Uint8Array, t: Messages): void {
  const staging = mkdtempSync(join(tmpdir(), "tonedial-update-"));
  try {
    const archive = join(staging, "package.tgz");
    writeFileSync(archive, tarball);
    validateArchive(archive, t);
    mkdirSync(join(staging, "unpacked"));
    const extracted = spawnSync(
      "tar",
      ["-xzf", archive, "-C", join(staging, "unpacked"), "--no-same-owner", "--no-same-permissions"],
      { stdio: "ignore" },
    );
    const unpacked = join(staging, "unpacked", "package");
    // **`lstat`, not `exists`.** A `package/` that is itself a symlink passed the existence
    // check, and `cpSync` copies links rather than following them — so `lib/` became a link into
    // the staging directory that the `finally` then deleted, after the old install was already
    // gone. The command exited 0 and left nothing `update`, `doctor --fix`, or `install.sh`
    // could recover from.
    if (extracted.status !== 0 || !lstatSync(unpacked, { throwIfNoEntry: false })?.isDirectory()) {
      throw new ConfigError(t.update.notAPackage);
    }
    validateUnpackedTree(unpacked, t);
    if (!lstatSync(join(unpacked, "dist", "bin.js"), { throwIfNoEntry: false })?.isFile() ||
        !lstatSync(join(unpacked, "dist", "install.js"), { throwIfNoEntry: false })?.isFile()) {
      throw new ConfigError(t.update.notAPackage);
    }
    // The candidate is the only process allowed to acquire operations.lock, move lib, write the
    // absolute shim, verify both entry points, and roll back. Keeping this launch here means a
    // curl update and a fresh curl install have one transaction owner; this parent only owns the
    // bounded download and unpack work.
    const result = spawnSync(
      process.execPath,
      [join(unpacked, "dist", "install.js"), "--root", paths.root, "--candidate", unpacked, "--replace-current"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TONEDIAL_HOME: paths.root } },
    );
    if (result.status !== 0) {
      const reason = (result.stderr || result.stdout || "installation failed").trim();
      throw new ConfigError(t.update.swapFailed(reason));
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
