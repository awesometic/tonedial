import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bin.ts");

test("update JSON on actual process TTY flags returns without approval input or package changes", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "tonedial-update-json-tty-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const state = join(scratch, "state");
  const project = join(scratch, "project");
  const userHome = join(scratch, "home");
  const preload = join(scratch, "terminal-fixture.mjs");
  for (const directory of [state, project, userHome, join(state, "lib")]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(state, "lib", "package.json"), '{"name":"tonedial","version":"0.0.0"}\n');
  writeFileSync(join(state, "lib", "keep.txt"), "Dummy installed package bytes.\n");
  // The real entry point reads the actual process flags. No approval input is supplied.
  // This fixture proves JSON routing, not a provider TUI or terminal lifecycle.
  writeFileSync(preload, 'Object.defineProperty(process.stdin, "isTTY", { value: true });\nObject.defineProperty(process.stdout, "isTTY", { value: true });\nprocess.stdin.isRaw = false;\nprocess.stdin.setRawMode = value => { process.stdin.isRaw = value; return process.stdin; };\n');
  const requests: string[] = [];
  let registry = "";
  const server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url !== "/tonedial/latest") {
      response.writeHead(500).end("An unapproved update must not download a tarball.");
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ version: "9.9.9", dist: { tarball: `${registry}/package.tgz`, integrity: "sha512-dummy" } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  registry = `http://127.0.0.1:${address.port}`;
  const snapshot = () => readdirSync(state, { recursive: true, withFileTypes: true })
    .map(entry => [relative(state, join(entry.parentPath, entry.name)), entry.isFile() ? readFileSync(join(entry.parentPath, entry.name)).toString("hex") : "directory"])
    .sort(([left], [right]) => left!.localeCompare(right!));
  const before = snapshot();
  for (const flags of [["--json"], ["--json", "--dry-run", "--auto"]]) {
    const result = await execute(process.execPath, ["--import", pathToFileURL(preload).href, BIN, "update", ...flags], {
      cwd: project,
      env: { HOME: userHome, TONEDIAL_HOME: state, TONEDIAL_INSTALL_SHAPE: "curl", TONEDIAL_REGISTRY: registry, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 5000,
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema, 3);
    assert.equal(payload.ok, true);
    assert.equal(payload.checkedRemote, true);
    assert.equal(payload.replaced, null, "JSON updated without approval or during dry-run");
    assert.equal(result.stderr, "");
    assert.deepEqual(snapshot(), before, "the package or state changed");
  }
  assert.deepEqual(requests, ["/tonedial/latest", "/tonedial/latest"], "the no-install result fetched an update archive");
});
