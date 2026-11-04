// Doctor's human guidance: every finding names its cause once and ends with the command that
// fixes it, in the scope the user is looking at.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.ts";

let scratch: string;
let home: string;
let project: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-doctor-guidance-"));
  home = join(scratch, "home");
  project = join(home, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, ".codex"));
  env = { HOME: home, PATH: "", LANG: "en_US.UTF-8", COLUMNS: "80" };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Human output without a terminal: what a pipe, CI log or agent shell sees. */
async function human(args: string[], cwd = home): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((text: string) => { out += text; return true; }) as typeof stdout;
  process.stderr.write = ((text: string) => { err += text; return true; }) as typeof stderr;
  try {
    const code = await run(args, env, cwd, false, false);
    return { code, out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

async function json(args: string[], cwd = home) {
  const result = await human([...args, "--json"], cwd);
  return { code: result.code, value: JSON.parse(result.out) };
}

test("doctor --fix without a terminal reports approval, not a protected file, with both rerun commands", async () => {
  assert.equal((await human(["init", "--tools", "codex", "--global", "--auto"])).code, 0);
  rmSync(join(home, ".codex", "hooks.json"));

  const machine = await json(["doctor", "--fix", "--global"]);
  assert.equal(machine.code, 0);
  assert.equal(machine.value.native.reason, "approval-required");
  assert.deepEqual(machine.value.native.issues, [{ tool: null, reason: "approval-required" }]);

  const shown = await human(["doctor", "--fix", "--global"]);
  assert.equal(shown.code, 0);
  assert.doesNotMatch(shown.out, /need separate attention/);
  assert.match(shown.out, /approval required/);
  assert.match(shown.out, /^ {2,}tonedial doctor --fix --global$/m);
  assert.match(shown.out, /^ {2,}tonedial doctor --fix --global --auto$/m);
});
