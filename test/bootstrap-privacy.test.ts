// Observe the bootstrap subprocess boundary without contacting a registry or installing code.
// Fake curl records its private transport separately from user-visible diagnostics.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = 'https://PRIVATE_URL:PRIVATE_URL@registry.invalid/PRIVATE_URL/quoted"back\\slash?token=PRIVATE_URL#PRIVATE_URL';
const tarball = 'https://PRIVATE_URL:PRIVATE_URL@packages.invalid/PRIVATE_URL/quoted"back\\slash?token=PRIVATE_URL#PRIVATE_URL';
type Download = { args: string[]; config: string; registryOverride: string | null };

function bootstrap(metadata: string, options: { registry?: string; firstFailure?: number; directoryMetadata?: boolean; packageSuccess?: boolean } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "tonedial-bootstrap-privacy-"));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  const log = join(scratch, "curl-calls.jsonl");
  const nodeArgs = join(scratch, "node-argv");
  const metadataPath = join(scratch, "metadata.json");
  writeFileSync(metadataPath, metadata);
  writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "$PRIVACY_NODE_ARGV"\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(bin, "node"), 0o755);
  writeFileSync(join(bin, "curl"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const config = configIndex !== -1 && args[configIndex + 1] === "-" ? fs.readFileSync(0, "utf8") : "";
const prior = fs.existsSync(process.env.PRIVACY_CURL_LOG) ? fs.readFileSync(process.env.PRIVACY_CURL_LOG, "utf8").trim().split("\\n").length : 0;
fs.appendFileSync(process.env.PRIVACY_CURL_LOG, JSON.stringify({ args, config, registryOverride: process.env.TONEDIAL_REGISTRY ?? null }) + "\\n");
const target = args[args.indexOf("-o") + 1];
if (prior === 0 && process.env.PRIVACY_FIRST_FAILURE === "0") {
  if (process.env.PRIVACY_DIRECTORY_METADATA === "1") fs.mkdirSync(target);
  else fs.copyFileSync(process.env.PRIVACY_METADATA, target);
  process.exit(0);
}
if (prior === 1 && process.env.PRIVACY_PACKAGE_SUCCESS === "1") {
  fs.writeFileSync(target, "synthetic package bytes");
  process.exit(0);
}
process.stdout.write("PRIVATE_ERROR reflected download output\\n");
process.stderr.write("PRIVATE_ERROR reflected request details\\n");
process.exit(prior === 0 ? Number(process.env.PRIVACY_FIRST_FAILURE) : 22);
`);
  chmodSync(join(bin, "curl"), 0o755);
  const root = join(scratch, "state");
  const result = spawnSync("/bin/sh", ["-s", "--", "--repair", "--global", "--tools", "none", "--auto", "--json"], {
    // The installer is streamed: downloader stdin must be a separate pipe, not this script.
    input: readFileSync(join(repo, "install.sh")), encoding: "utf8", timeout: 10_000,
    env: {
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: join(scratch, "home"), TONEDIAL_HOME: root, TMPDIR: scratch,
      TONEDIAL_REGISTRY: options.registry ?? registry,
      PRIVACY_NODE_ARGV: nodeArgs, PRIVACY_CURL_LOG: log, PRIVACY_METADATA: metadataPath,
      PRIVACY_FIRST_FAILURE: String(options.firstFailure ?? 0), PRIVACY_DIRECTORY_METADATA: options.directoryMetadata ? "1" : "0",
      PRIVACY_PACKAGE_SUCCESS: options.packageSuccess ? "1" : "0",
    },
  });
  const calls: Download[] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as Download) : [];
  const intermediateArgs = existsSync(nodeArgs) ? readFileSync(nodeArgs, "utf8") : "";
  const retained = readdirSync(scratch).filter(name => name.startsWith("tonedial."));
  const wroteState = existsSync(root);
  rmSync(scratch, { recursive: true, force: true });
  return { result, calls, intermediateArgs, retained, wroteState };
}

function configuredUrl(config: string): string {
  const line = /^url = "((?:[^"\\]|\\.)*)"\n$/.exec(config);
  assert.ok(line, "one quoted URL with no injected curl directives");
  return line[1]!.replace(/\\([\\"])/g, "$1");
}

test("bootstrap keeps complete escaped URLs in private curl config and suppresses downloader diagnostics", () => {
  const { result, calls, intermediateArgs, retained, wroteState } = bootstrap(JSON.stringify({ version: "9.9.9", dist: { tarball, integrity: "sha512-dummy" } }));
  assert.equal(result.status, 1, result.stderr);
  assert.equal(calls.length, 2, "metadata and tarball downloader boundaries were reached");
  for (const [index, call] of calls.entries()) {
    assert.equal(call.args[0], "-q", "disable inherited curlrc before other options");
    assert.equal(call.registryOverride, null, "the configured URL reached curl through its environment");
    assert.doesNotMatch(JSON.stringify(call.args), /PRIVATE_URL/);
    assert.equal(configuredUrl(call.config), index === 0 ? registry + "/tonedial/latest" : tarball);
  }
  assert.doesNotMatch(intermediateArgs, /PRIVATE_URL/, "a formatter or metadata child received the URL in argv");
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_URL|PRIVATE_ERROR/);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.deepEqual(retained, []);
  assert.equal(wroteState, false);
});

test("bootstrap classifies metadata download failures without echoing curl output or the registry URL", () => {
  for (const [failure, reason] of [[7, "transport failure"], [22, "HTTP failure"], [28, "timeout"], [60, "secure connection could not be verified"]] as const) {
    const { result, calls, intermediateArgs, retained, wroteState } = bootstrap("{}", { firstFailure: failure });
    assert.equal(result.status, 1);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(result.stdout + result.stderr + intermediateArgs, /PRIVATE_URL|PRIVATE_ERROR/);
    assert.match(result.stderr, /registry\.invalid/);
    assert.ok(result.stderr.includes(reason), `curl ${failure} must keep its safe failure class`);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.deepEqual(retained, []);
    assert.equal(wroteState, false);
  }
});

test("bootstrap metadata parser and type failures stay bounded and never launch a tarball download", () => {
  for (const metadata of [
    "PRIVATE_BODY invalid JSON", "null", "[]",
    JSON.stringify({ dist: { tarball: { PRIVATE_BODY: "PRIVATE_BODY" }, integrity: "sha512-dummy" } }),
    JSON.stringify({ dist: { tarball, integrity: { PRIVATE_BODY: "PRIVATE_BODY" } } }),
  ]) {
    const { result, calls, intermediateArgs, retained, wroteState } = bootstrap(metadata);
    assert.equal(result.status, 1);
    assert.equal(calls.length, 1, "invalid metadata reached the tarball downloader");
    assert.doesNotMatch(result.stdout + result.stderr + intermediateArgs, /PRIVATE_URL|PRIVATE_BODY|SyntaxError|TypeError|\n\s+at /);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.deepEqual(retained, []);
    assert.equal(wroteState, false);
  }
  const unreadable = bootstrap("{}", { directoryMetadata: true });
  assert.equal(unreadable.result.status, 1);
  assert.equal(unreadable.calls.length, 1);
  assert.doesNotMatch(unreadable.result.stdout + unreadable.result.stderr, /Error:|\n\s+at /);
});

test("bootstrap refuses malformed URLs and curl config controls before their downloader boundary", () => {
  for (const invalid of ["https://[PRIVATE_URL", registry + '\noutput = "PRIVATE_URL"', registry + "\rPRIVATE_URL", registry + "\n", registry + "\u0085"]) {
    const registryFailure = bootstrap("{}", { registry: invalid });
    assert.equal(registryFailure.result.status, 1);
    assert.equal(registryFailure.calls.length, 0);
    assert.doesNotMatch(registryFailure.result.stdout + registryFailure.result.stderr + registryFailure.intermediateArgs, /PRIVATE_URL/);
    const tarballFailure = bootstrap(JSON.stringify({ dist: { tarball: invalid, integrity: "sha512-dummy" } }));
    assert.equal(tarballFailure.result.status, 1);
    assert.equal(tarballFailure.calls.length, 1);
    assert.doesNotMatch(tarballFailure.result.stdout + tarballFailure.result.stderr + tarballFailure.intermediateArgs, /PRIVATE_URL|Error:|\n\s+at /);
  }
});

test("bootstrap never forwards reflected integrity metadata through a verifier child argument", () => {
  const { result, calls, intermediateArgs, wroteState, retained } = bootstrap(JSON.stringify({ dist: {
    tarball, integrity: "sha512-https://registry.invalid/PRIVATE_BODY?token=PRIVATE_URL",
  } }), { packageSuccess: true });
  assert.equal(result.status, 1);
  assert.equal(calls.length, 2, "the fixture must reach integrity verification after download");
  assert.doesNotMatch(intermediateArgs + result.stdout + result.stderr, /PRIVATE_URL|PRIVATE_BODY/);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(wroteState, false);
  assert.deepEqual(retained, []);
});
