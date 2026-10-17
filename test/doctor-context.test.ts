import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import childProcess from "node:child_process";
import fs from "node:fs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../src/cli.ts";
import { runDoctor } from "../src/commands/doctor.ts";
import { isConfigV2, parseConfig, serializeConfig } from "../src/core/config.ts";
import { canonicalDestination, readerPath, resolveAgentPaths, resolvePaths } from "../src/core/paths.ts";
import { catalogue } from "../src/core/i18n.ts";
import { planSeedChanges, seedFiles } from "../src/core/seeds.ts";
import { registrationKey } from "../src/wiring/ownership.ts";
import { gate, planChange } from "../src/wiring/apply.ts";
import { planOrderedDelivery } from "../src/wiring/targets.ts";
import { palette } from "../src/ui/style.ts";
import { UNKNOWN_WIDTH, maxCells } from "../src/ui/width.ts";
import { createLegacyFixture } from "./support/legacy-fixture.ts";
import { withPathLine } from "../src/wiring/shell.ts";
import { isUnbreakable } from "./support/width-contract.ts";
import { acquireOperation, beginJournal, inspectOperations } from "../src/core/operations.ts";

type Check = {
  name: string;
  state: string;
  detail: string;
  repair: string | null;
  files?: { path: string; reason: string }[];
};
type Report = {
  code: number;
  value: {
    context?: { kind: string; cause: string; legacyWitness: string; legacyConsumers: string[]; migration: { route: string | null; reason: string | null }; inspectionFailure: { path: string; reason: string } | null };
    contextPayload?: { guideFormat: string; guideChars: number | null; artifactChars: number | null; totalChars: number | null };
    reader?: { state: string; reason: string | null; runtime: string | null; scope: string };
    checks?: Check[];
    [key: string]: unknown;
  };
  output: string;
};

let scratch = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-doctor-context-"));
  env = {
    HOME: scratch,
    TONEDIAL_HOME: join(scratch, "state"),
    PATH: "",
    LANG: "en_US.UTF-8",
  };
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function invoke(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Report> {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = ((text: string) => {
    output += text;
    return true;
  }) as typeof original;
  try {
    const code = await run([...args, "--json"], { ...env, ...extra }, join(scratch, "project"), false, false);
    return { code, value: JSON.parse(output), output };
  } finally {
    process.stdout.write = original;
  }
}

test("a stale PATH profile outside the current global shell is diagnosed without an ineffective repair offer", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "none", "--auto"])).code, 0);
  const path = join(scratch, ".bash_profile");
  const contents = withPathLine("user profile\n", join(scratch, "previous-install", "bin"), "bash");
  writeFileSync(path, contents);
  for (const args of [["doctor", "--global"], ["doctor", "--here"]]) {
    const result = await invoke(args, { SHELL: "/bin/zsh", TONEDIAL_INSTALL_SHAPE: "curl" });
    const row = result.value.checks?.find(check => check.name === "PATH line");
    assert.equal(row?.state, "problem");
    assert.equal(row?.repair, null);
    assert.match(row?.detail ?? "", /current global shell profile/);
    assert.equal(readFileSync(path, "utf8"), contents);
  }
});

type HumanResult = { code: number; output: string; error: string };

async function invokeHuman(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<HumanResult> {
  let output = "";
  let error = "";
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((text: string) => {
    output += text;
    return true;
  }) as typeof originalOut;
  process.stderr.write = ((text: string) => {
    error += text;
    return true;
  }) as typeof originalErr;
  try {
    const code = await run(args, { ...env, ...extra }, join(scratch, "project"), false, false);
    return { code, output, error };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test("a repair receipt offers each rollback command once and standalone diagnosis retains it", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "none", "--auto"])).code, 0);
  writeFileSync(join(env.TONEDIAL_HOME!, "AGENTS.md"), "damaged generated guide\n");
  const result = await invokeHuman(["doctor", "--fix", "--global", "--tools", "none", "--auto"]);
  assert.equal(result.code, 0, result.error);
  const commands = result.output.match(/tonedial doctor --fix --rollback [0-9a-f]{32}/g) ?? [];
  assert.equal(commands.length, 1, result.output);
  const diagnosis = await invokeHuman(["doctor", "--global"]);
  assert.equal(diagnosis.code, 0, diagnosis.error);
  assert.ok(diagnosis.output.includes(commands[0]!), "standalone diagnosis must retain the restorable operation");
});

test("a repair receipt preserves ordered rollback instructions when another operation becomes pending", async t => {
  assert.equal((await invoke(["init", "--global", "--tools", "none", "--auto"])).code, 0);
  const paths = resolvePaths(env);
  writeFileSync(paths.agents, "damaged generated guide\n");
  const remove = fs.rmdirSync;
  let pendingId: string | null = null;
  const released = t.mock.method(fs, "rmdirSync", (...args: Parameters<typeof fs.rmdirSync>) => {
    remove(...args);
    if (String(args[0]) !== paths.operationsLock || pendingId !== null) return;
    const operation = acquireOperation(paths, "mutation");
    pendingId = operation.owner.operationId;
    beginJournal(operation, []);
    const ownerPath = join(paths.operationsLock, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    owner.pid = 2_147_483_000;
    writeFileSync(ownerPath, JSON.stringify(owner));
  });
  syncBuiltinESMExports();
  let result: HumanResult;
  try {
    result = await invokeHuman(["doctor", "--fix", "--global", "--tools", "none", "--auto"]);
  } finally { released.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(result.code, 0, result.error);
  assert.ok(pendingId, "the new operation must appear between app repair and final diagnosis");
  assert.ok(result.output.includes(pendingId));
  assert.ok(!result.output.includes(`tonedial doctor --fix --rollback ${pendingId}`), "the receipt owns its ordered rollback instructions");
  assert.equal((result.output.match(/tonedial doctor --fix --rollback [0-9a-f]{32}/g) ?? []).length, 1);
});

test("blocked doctor shows the stopped operation and scoped recovery actions while retaining JSON and verbose history", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "none", "--auto"])).code, 0);
  assert.equal((await invoke(["set", "care=4"])).code, 0);
  const paths = resolvePaths(env);
  const history = inspectOperations(paths).journals.map(({ operationId }) => operationId);
  assert.ok(history.length >= 2);
  const operation = acquireOperation(paths, "mutation");
  beginJournal(operation, []);
  const ownerPath = join(paths.operationsLock, "owner.json");
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  owner.pid = 2_147_483_000;
  writeFileSync(ownerPath, JSON.stringify(owner));
  const journalPath = join(paths.operations, `${owner.operationId}.json`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.owner.pid = owner.pid;
  writeFileSync(journalPath, JSON.stringify(journal));
  const directory = join(scratch, "project with spaces");
  mkdirSync(directory);
  const before = [paths.config, ownerPath, journalPath].map(path => ({ path, bytes: readFileSync(path) }));
  const report = await invokeHuman(["doctor", "--project", directory]);
  assert.equal(report.code, 0, report.error);
  assert.ok(report.output.includes(owner.operationId));
  for (const id of history) assert.ok(!report.output.includes(id), "completed journals are history, not current blockers");
  assert.ok(report.output.includes(`tonedial doctor --project "${directory}" --json`));
  assert.ok(report.output.includes(`tonedial doctor --fix --from-operation ${owner.operationId} --project "${directory}"`));
  assert.ok(report.output.includes(`tonedial doctor --fix --rollback ${owner.operationId}`));
  const json = await invoke(["doctor", "--project", directory]);
  assert.equal(json.code, 0, json.output);
  assert.deepEqual(json.value.recovery, {
    lock: "dead",
    operations: inspectOperations(paths).journals.map(({ operationId, state }) => ({ operationId, state })),
  });
  const verbose = await invokeHuman(["doctor", "--project", directory, "--verbose"]);
  assert.equal(verbose.code, 0, verbose.error);
  for (const id of history) assert.ok(verbose.output.includes(id), "verbose diagnosis retains completed history");
  for (const { path, bytes } of before) assert.deepEqual(readFileSync(path), bytes, "diagnosis changed recovery state");
});

test("live, unknown and invalid operation owners get diagnosis without resume or rollback offers", async t => {
  assert.equal((await invoke(["init", "--global", "--tools", "none", "--auto"])).code, 0);
  const paths = resolvePaths(env);
  const operation = acquireOperation(paths, "mutation");
  beginJournal(operation, []);
  const ownerPath = join(paths.operationsLock, "owner.json");
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  const originalKill = process.kill;
  t.mock.method(process, "kill", ((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid === 2_147_483_000 && signal === 0) throw Object.assign(new Error("fixture owner cannot be inspected"), { code: "EPERM" });
    return originalKill(pid, signal);
  }) as typeof process.kill);
  for (const state of ["live", "unknown", "invalid"] as const) {
    writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: state === "live" ? process.pid : 2_147_483_000,
      ...(state === "invalid" ? { nonce: "invalid" } : {}) }));
    const before = readFileSync(ownerPath);
    const human = await invokeHuman(["doctor", "--global"]);
    assert.equal(human.code, 0, human.error);
    assert.ok(human.output.includes(`tonedial doctor --global --json`));
    assert.doesNotMatch(human.output, /--from-operation|--rollback/, state);
    const json = await invoke(["doctor", "--global"]);
    assert.equal(json.code, 0, json.output);
    assert.equal((json.value.recovery as { lock: string }).lock, state);
    assert.deepEqual(readFileSync(ownerPath), before, "diagnosis must preserve the owner");
  }
});

test("a stopped preparation without a journal offers rollback without an unusable resume source", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "none", "--auto"])).code, 0);
  const paths = resolvePaths(env);
  const operation = acquireOperation(paths, "mutation");
  const ownerPath = join(paths.operationsLock, "owner.json");
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  owner.pid = 2_147_483_000;
  writeFileSync(ownerPath, JSON.stringify(owner));
  const human = await invokeHuman(["doctor", "--global"]);
  assert.equal(human.code, 0, human.error);
  assert.ok(human.output.includes(`tonedial doctor --fix --rollback ${operation.owner.operationId}`));
  assert.doesNotMatch(human.output, /--from-operation/);
  assert.equal(existsSync(join(paths.operations, `${operation.owner.operationId}.json`)), false,
    "read-only diagnosis must not create a synthetic journal on disk");
});

test("an orphan pending journal offers diagnosis without recovery authority the executor does not have", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "none", "--auto"])).code, 0);
  const paths = resolvePaths(env);
  const operation = acquireOperation(paths, "mutation");
  beginJournal(operation, []);
  rmSync(paths.operationsLock, { recursive: true });
  const journalPath = join(paths.operations, `${operation.owner.operationId}.json`);
  const before = readFileSync(journalPath);
  const human = await invokeHuman(["doctor", "--global"]);
  assert.equal(human.code, 0, human.error);
  assert.ok(human.output.includes(operation.owner.operationId));
  assert.ok(human.output.includes("tonedial doctor --global --json"));
  assert.doesNotMatch(human.output, /--from-operation|--rollback/);
  const rollback = await invoke(["doctor", "--fix", "--rollback", operation.owner.operationId, "--auto"]);
  assert.equal(rollback.code, 1);
  assert.match(rollback.value.error as string, /does not contain a recoverable owner/);
  assert.deepEqual(readFileSync(journalPath), before);
  assert.equal(existsSync(paths.operationsLock), false);
});

test("an unreadable operation record is quarantined through the repair gate and remains rollbackable", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "none", "--auto"])).code, 0);
  const paths = resolvePaths(env);
  const operationId = "8".repeat(32);
  const path = join(paths.operations, `${operationId}.json`);
  const original = Buffer.from([0xff, 0x00, 0x7b, 0x0a]);
  writeFileSync(path, original, { mode: 0o640 });

  const diagnosis = await invokeHuman(["doctor", "--global"]);
  assert.equal(diagnosis.code, 0, diagnosis.error);
  assert.ok(diagnosis.output.includes(`tonedial doctor --fix --quarantine-operation ${operationId} --global`));

  const preview = await invoke(["doctor", "--fix", "--quarantine-operation", operationId, "--global", "--tools", "none", "--dry-run"]);
  assert.equal(preview.code, 0, preview.output);
  assert.equal(preview.value.quarantinedOperation, operationId);
  assert.deepEqual(readFileSync(path), original, "dry-run changed the unreadable record");

  const repaired = await invoke(["doctor", "--fix", "--quarantine-operation", operationId, "--global", "--tools", "none", "--auto"]);
  assert.equal(repaired.code, 0, repaired.output);
  assert.equal(repaired.value.quarantinedOperation, operationId);
  assert.equal(inspectOperations(paths).journals.find(entry => entry.operationId === operationId)?.state, "quarantined");
  assert.notDeepEqual(readFileSync(path), original);

  const rollback = await invoke(["doctor", "--fix", "--rollback", String(repaired.value.operationId), "--auto"]);
  assert.equal(rollback.code, 0, rollback.output);
  assert.deepEqual(readFileSync(path), original, "rollback did not restore the unreadable record bytes");
  assert.equal(lstatSync(path).mode & 0o777, 0o640);
  assert.equal(inspectOperations(paths).journals.find(entry => entry.operationId === operationId)?.state, "invalid");
});

test("multiple unreadable operation records can be quarantined one at a time and rolled back independently", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "none", "--auto"])).code, 0);
  const paths = resolvePaths(env);
  const ids = ["6".repeat(32), "7".repeat(32)];
  const originals = ids.map((id, index) => {
    const path = join(paths.operations, `${id}.json`);
    const bytes = Buffer.from([0xff, index, 0x7b, 0x0a]);
    writeFileSync(path, bytes, { mode: 0o640 + index });
    return { id, path, bytes, mode: 0o640 + index };
  });

  const diagnosis = await invokeHuman(["doctor", "--global"]);
  assert.equal(diagnosis.code, 0, diagnosis.error);
  for (const { id } of originals) assert.ok(diagnosis.output.includes(id));
  assert.ok(diagnosis.output.includes(`tonedial doctor --fix --quarantine-operation ${ids[0]} --global`));

  const preview = await invoke(["doctor", "--fix", "--quarantine-operation", ids[0]!, "--global", "--tools", "none", "--dry-run"]);
  assert.equal(preview.code, 0, preview.output);
  assert.equal(preview.value.appRebuilt, false);
  assert.deepEqual(preview.value.remainingInvalidOperations, [ids[1]]);
  assert.equal(preview.value.next, null);
  for (const original of originals) assert.deepEqual(readFileSync(original.path), original.bytes);

  const first = await invokeHuman(["doctor", "--fix", "--quarantine-operation", ids[0]!, "--global", "--tools", "none", "--auto"]);
  assert.equal(first.code, 0, first.error);
  const firstRollback = /tonedial doctor --fix --rollback ([0-9a-f]{32})/.exec(first.output)?.[1];
  const nextCommand = `tonedial doctor --fix --quarantine-operation ${ids[1]} --global`;
  assert.ok(firstRollback, first.output);
  assert.ok(first.output.indexOf(`tonedial doctor --fix --rollback ${firstRollback}`) < first.output.indexOf(nextCommand),
    "the next repair command must remain the final action after the optional rollback");
  assert.equal(inspectOperations(paths).journals.find(entry => entry.operationId === ids[0])?.state, "quarantined");
  assert.equal(inspectOperations(paths).journals.find(entry => entry.operationId === ids[1])?.state, "invalid");

  const second = await invoke(["doctor", "--fix", "--quarantine-operation", ids[1]!, "--global", "--tools", "none", "--auto"]);
  assert.equal(second.code, 0, second.output);
  assert.equal(second.value.appRebuilt, true);
  assert.equal(second.value.quarantinedOperation, ids[1]);
  for (const id of ids) assert.equal(inspectOperations(paths).journals.find(entry => entry.operationId === id)?.state, "quarantined");

  for (const operationId of [String(second.value.operationId), firstRollback]) {
    const rollback = await invoke(["doctor", "--fix", "--rollback", operationId, "--auto"]);
    assert.equal(rollback.code, 0, rollback.output);
  }
  for (const original of originals) {
    assert.deepEqual(readFileSync(original.path), original.bytes);
    assert.equal(lstatSync(original.path).mode & 0o777, original.mode);
  }
});

function containsWrapped(text: string, expected: string): boolean {
  return text.replace(/\s+/g, " ").includes(expected.replace(/\s+/g, " "));
}

/**
 * The same width contract `ui.test.ts` applies, including its exemption.
 *
 * This helper was written stricter than the contract and only agreed with it while `doctor`
 * happened to compose every path into a sentence. It now prints the destination on its own line,
 * which is the shape the contract has always exempted, so the two owners share one predicate
 * rather than disagreeing the first time one of them is right.
 */
function assertHumanWidth(output: string, language: string, width = UNKNOWN_WIDTH): void {
  for (const line of output.split("\n")) {
    if (isUnbreakable(line)) continue;
    assert.ok(maxCells(line) <= width, `${language}: ${maxCells(line)} cells: ${line}`);
  }
}

function check(report: Report, name: string): Check {
  const found = report.value.checks?.find((candidate) => candidate.name === name);
  assert.ok(found, `missing check ${name}: ${report.output}`);
  return found;
}

async function retainReaderSeed(language: "en" | "ko" = "en"): Promise<string> {
  const setup = await invoke(["init", "--here", "--tools", "none", ...(language === "ko" ? ["--lang", "ko"] : []), "--auto"]);
  assert.equal(setup.code, 0, setup.output);
  const paths = resolvePaths(env);
  const config = parseConfig(readFileSync(paths.config, "utf8"));
  const selection = { native: false, recorded: ["reader"] } as const;
  const t = catalogue(language).cli;
  const plan = planSeedChanges(paths, config.managedSeeds, selection, t);
  const reader = seedFiles(paths, selection).find((seed) => seed.id === "reader");
  assert.ok(reader);
  assert.equal(reader.path, readerPath(paths.root));
  config.managedSeeds = plan.records;
  const configChange = planChange(paths.config, (before) => before, t, undefined, paths.root);
  const result = await gate(plan.changes, {
    paths,
    finalChanges: [{ ...configChange, after: serializeConfig(config) }],
    auto: true,
    dryRun: false,
    t,
    ui: palette("never", env, false),
    out: () => {},
  });
  assert.equal(result.applied, true);
  return reader.path;
}

test("fresh doctor reports a scalar context diagnosis without creating state", async () => {
  const report = await invoke(["doctor", "--here"]);
  assert.equal(report.code, 0, report.output);
  assert.deepEqual(report.value.context, {
    kind: "fresh",
    cause: "none",
    legacyWitness: "not-applicable",
    legacyConsumers: [],
    migration: { route: null, reason: "fresh" },
    inspectionFailure: null,
  });
  assert.deepEqual(report.value.reader, {
    state: "not-required",
    reason: null,
    runtime: null,
    scope: "cli-runtime",
  });
  assert.equal(check(report, "TONE.md").repair, null);
  assert.equal(existsSync(join(scratch, "state")), false);
});

test("doctor measures the complete ordered UTF-8 pair separately from the artifact budget", async () => {
  assert.equal((await invoke(["init", "--here", "--tools", "none", "--auto"])).code, 0);
  assert.equal((await invoke(["set", "persona.note=조용한 🌿 말투"])).code, 0);
  const compiled = await invoke(["compile", "--check"]);
  const guide = readFileSync(compiled.value.agentsPath as string, "utf8");
  const artifact = readFileSync(compiled.value.path as string, "utf8");
  const report = await invoke(["doctor", "--here"]);
  assert.deepEqual(report.value.contextPayload, {
    guideFormat: "supported",
    guideChars: [...guide].length,
    artifactChars: [...artifact].length,
    totalChars: [...`${guide}\n\n${artifact}`].length,
  });
  assert.equal(compiled.value.chars, report.value.contextPayload!.artifactChars);
  assert.doesNotMatch(report.output, /조용한 🌿 말투/);
  assert.equal(readFileSync(compiled.value.agentsPath as string, "utf8"), guide);
  assert.equal(readFileSync(compiled.value.path as string, "utf8"), artifact);
});

test("doctor and the reader accept a CRLF guide while preserving its bytes and ownership hash", async () => {
  const reader = await retainReaderSeed();
  const paths = resolvePaths(env);
  const guide = readFileSync(paths.agents, "utf8").replace(/\n/g, "\r\n");
  const artifact = readFileSync(paths.tone, "utf8");
  const config = readFileSync(paths.config, "utf8");
  writeFileSync(paths.agents, guide);
  const output = childProcess.execFileSync(process.execPath, [reader, "--provider", "codex", "--state", paths.root], {
    env, encoding: "utf8", timeout: 5000,
  });
  assert.equal(output, `${guide}\n\n${artifact}`);

  const report = await invoke(["doctor", "--here"]);
  assert.equal(report.code, 0, report.output);
  assert.deepEqual(report.value.contextPayload, {
    guideFormat: "supported",
    guideChars: [...guide].length,
    artifactChars: [...artifact].length,
    totalChars: [...`${guide}\n\n${artifact}`].length,
  });
  assert.equal(check(report, "AGENTS.md").state, "note");
  assert.deepEqual(check(report, "seeds").files?.find((file) => file.path === paths.agents), {
    path: paths.agents, reason: "modified",
  });
  assert.equal(readFileSync(paths.agents, "utf8"), guide);
  assert.equal(readFileSync(paths.tone, "utf8"), artifact);
  assert.equal(readFileSync(paths.config, "utf8"), config);
});

test("doctor distinguishes a missing guide from an unsupported guide without claiming a payload", async () => {
  assert.equal((await invoke(["init", "--here", "--tools", "none", "--auto"])).code, 0);
  const paths = resolvePaths(env);
  for (const body of [null, "<!-- tonedial-guide:99 -->\nprivate guide content\n"]) {
    if (body === null) rmSync(paths.agents);
    else writeFileSync(paths.agents, body);
    const report = await invoke(["doctor", "--here"]);
    assert.equal(report.value.contextPayload?.guideFormat, body === null ? "missing" : "unsupported");
    assert.equal(report.value.contextPayload?.guideChars, body === null ? null : [...body].length);
    assert.equal(report.value.contextPayload?.totalChars, null);
    assert.equal(check(report, "AGENTS.md").state, "problem");
    assert.doesNotMatch(report.output, /private guide content/);
    assert.equal(existsSync(paths.agents), body !== null);
  }
});

test("state-only doctor refuses an unavailable native wire repair, including a retained registration", async () => {
  const project = join(scratch, "project");
  const setup = await invoke(["init", "--here", "--tools", "none", "--auto"]);
  assert.equal(setup.code, 0, setup.output);
  mkdirSync(join(project, ".claude"), { recursive: true });

  for (const retained of [false, true]) {
    if (retained) {
      const paths = resolvePaths(env);
      const config = parseConfig(readFileSync(paths.config, "utf8"));
      const destination = canonicalDestination(project);
      config.wiring.registrations ??= {};
      config.wiring.registrations[registrationKey("claude", "project", destination)] = {
        target: "claude",
        scope: "project",
        destination,
        resourceIds: [],
      };
      writeFileSync(paths.config, serializeConfig(config));
    }

    const report = await invoke(["doctor", "--here", "--fix", "--auto"]);
    assert.equal(report.code, 0, report.output);
    assert.deepEqual(report.value.context, {
      kind: "current",
      cause: "none",
      legacyWitness: "not-applicable",
      legacyConsumers: [],
      migration: { route: null, reason: "not-needed" },
      inspectionFailure: null,
    });
    assert.deepEqual(report.value.reader, {
      state: "not-required",
      reason: null,
      runtime: null,
      scope: "cli-runtime",
    });
    const claude = check(report, "Claude Code");
    assert.equal(claude.state, "note");
    assert.equal(claude.repair, null);
    assert.equal(claude.detail, catalogue("en").cli.doctor.legacyRepairWithheld);
    for (const flags of [[], ["--verbose"]]) {
      const human = await invokeHuman(["doctor", "--here", ...flags]);
      assert.equal(human.code, 0, human.output + human.error);
      assert.ok(containsWrapped(human.output, catalogue("en").cli.doctor.legacyRepairWithheld), "grouping concealed the withheld legacy diagnosis");
    }
    assert.doesNotMatch(report.output, /tonedial wire claude/);
    assert.equal(existsSync(join(project, ".claude", "CLAUDE.md")), false);
  }
});

test("native doctor reports independent runtime and reader health and repairs a missing hook", async () => {
  const setup = await invoke(["init", "--here", "--tools", "claude", "--auto"]);
  assert.equal(setup.code, 0, setup.output);
  const paths = resolvePaths(env);
  const agent = resolveAgentPaths({ global: false, project: null }, env, join(scratch, "project"));
  const hookPath = agent.hookFile("claude");

  const current = await invoke(["doctor", "--here"]);
  assert.equal(current.code, 0, current.output);
  const currentIntegration = (current.value.integrations as Array<Record<string, any>>)
    .find((entry) => entry.tool === "claude");
  assert.deepEqual(currentIntegration, {
    tool: "claude",
    path: hookPath,
    inherited: false,
    configuration: "configured",
    runtime: {
      path: process.execPath,
      state: "available",
      scope: "configured-runtime",
      reason: null,
    },
    reader: {
      path: readerPath(paths.root),
      state: "runnable",
      reason: null,
      scope: "cli-runtime",
    },
    // Claude keeps no trust record of its own, so there is nothing to read and nothing to say.
    // Only Codex answers anything else here.
    trust: "unknown",
    activation: "unverified",
  });
  assert.equal(check(current, "Claude Code").state, "ok", current.output);
  assert.match(check(current, "Claude Code").detail, /AGENTS\.md.*TONE\.md/i);
  assert.match(check(current, "Claude Code").detail, /activation.*unverified/i);

  rmSync(hookPath);
  const missing = await invoke(["doctor", "--here"]);
  const missingIntegration = (missing.value.integrations as Array<Record<string, any>>)
    .find((entry) => entry.tool === "claude");
  assert.equal(missingIntegration?.configuration, "missing");
  assert.equal(missingIntegration?.inherited, false);
  assert.equal((missingIntegration?.reader as Record<string, any>)?.state, "runnable");
  assert.equal(check(missing, "Claude Code").state, "problem");
  assert.match(check(missing, "Claude Code").detail, /No ToneDial SessionStart hook/i);
  assert.ok(check(missing, "Claude Code").repair);

  const fixed = await invoke(["doctor", "--here", "--fix", "--auto"]);
  assert.equal(fixed.code, 0, fixed.output);
  assert.equal(fixed.value.fixed, true, fixed.output);
  const repairedIntegration = (fixed.value.integrations as Array<Record<string, any>>)
    .find((entry) => entry.tool === "claude");
  assert.equal(repairedIntegration?.configuration, "configured");
  assert.equal(repairedIntegration?.inherited, false);
  assert.equal((repairedIntegration?.runtime as Record<string, any>)?.path, process.execPath);
  assert.equal((repairedIntegration?.reader as Record<string, any>)?.state, "runnable");
  assert.equal(JSON.parse(readFileSync(hookPath, "utf8")).hooks.SessionStart.length, 1);
});

test("doctor shares hook setting states and guidance across agents and locales", async () => {
  assert.equal((await invoke(["init", "--global", "--tools", "claude,codex,antigravity", "--auto"])).code, 0);
  const agent = resolveAgentPaths({ global: true, project: null }, env);
  const claudePath = agent.hookFile("claude");
  const antigravityPath = agent.hookFile("antigravity");
  const original = readFileSync(claudePath, "utf8");
  const hooks = (result: Report) => result.value.hookSettings as Array<{
    tool: string; state: string; basis: string; path: string | null;
  }>;
  const configured = await invoke(["doctor", "--global"]);
  assert.deepEqual(hooks(configured).find(row => row.tool === "claude"), {
    tool: "claude", state: "enabled", basis: "registered-file", path: claudePath,
  });
  assert.deepEqual(hooks(configured).find(row => row.tool === "antigravity"), {
    tool: "antigravity", state: "enabled", basis: "registered-file", path: antigravityPath,
  });
  assert.equal(hooks(configured).find(row => row.tool === "codex")?.state, "unknown");
  assert.deepEqual(hooks(configured).map(row => row.tool).sort(), ["antigravity", "claude", "codex"],
    "diagnose all supported targets through the same hook layer");
  // A project can inherit the same file; no project activation is inferred from that observation.
  const inherited = await invoke(["doctor", "--here"]);
  assert.deepEqual(hooks(inherited).find(row => row.tool === "claude"),
    hooks(configured).find(row => row.tool === "claude"));

  for (const language of ["en", "ko"] as const) {
    assert.equal((await invoke(["set", `language=${language}`])).code, 0);
    const human = await invokeHuman(["doctor", "--global"]);
    const t = catalogue(language).cli.doctor;
    assert.ok(containsWrapped(human.output, t.hookSettingState.enabled), human.output);
    assert.ok(containsWrapped(human.output, t.hookGuidance.codex), human.output);
    assert.ok(containsWrapped(human.output, t.hookGuidance.antigravity), human.output);
    assert.ok(containsWrapped(human.output, t.hookGuidance.claude), human.output);
    assert.equal(human.output.split("/hooks").length - 1, 2, human.output);
    assert.ok(containsWrapped(human.output, t.hookSettingScope), human.output);
  }
  assert.equal(readFileSync(claudePath, "utf8"), original, "diagnosis must not change host settings");

  for (const [disabled, expected] of [[true, "disabled"], [false, "enabled"], ["false", "unknown"]] as const) {
    const contents = JSON.stringify({ ...JSON.parse(original), disableAllHooks: disabled });
    writeFileSync(claudePath, contents);
    const result = await invoke(["doctor", "--global"]);
    assert.equal(hooks(result).find(row => row.tool === "claude")?.state, expected);
    for (const language of ["en", "ko"] as const) {
      assert.equal((await invoke(["set", `language=${language}`])).code, 0);
      const human = await invokeHuman(["doctor", "--global"]);
      const guide = catalogue(language).cli.doctor.hookGuidance.claude;
      assert.ok(containsWrapped(human.output, guide), human.output);
    }
    if (expected === "disabled") {
      assert.equal(check(result, "Claude Code").state, "problem");
      assert.equal(result.value.nativeAttention, true);
    }
    assert.equal(readFileSync(claudePath, "utf8"), contents);
  }

  // An intact handler is required; another file's default-on switch is not ours.
  writeFileSync(claudePath, '{"disableAllHooks":false}');
  assert.equal(hooks(await invoke(["doctor", "--global"])).find(row => row.tool === "claude")?.state, "unknown");
  writeFileSync(join(agent.home("codex"), "config.toml"),
    `[hooks.state.${JSON.stringify(agent.hookFile("codex") + ":session_start:0:0")}]\nenabled = false\n`);
  const off = hooks(await invoke(["doctor", "--global"])).find(row => row.tool === "codex");
  assert.equal(off?.state, "disabled");
  assert.equal(off?.basis, "codex-record");
});

test("native doctor refreshes an owned runtime but preserves an edited handler", async () => {
  const setup = await invoke(["init", "--here", "--tools", "claude", "--auto"]);
  assert.equal(setup.code, 0, setup.output);
  const paths = resolvePaths(env);
  const agent = resolveAgentPaths({ global: false, project: null }, env, join(scratch, "project"));
  const t = catalogue("en").cli;
  const oldRuntime = join(scratch, "old runtime", "node");
  let config = parseConfig(readFileSync(paths.config, "utf8"), t);
  assert.ok(isConfigV2(config));
  const planned = planOrderedDelivery(paths, agent, "claude", config.wiring, env, t, oldRuntime);
  config.wiring = planned.wiring;
  const configChange = planChange(paths.config, (before) => before, t);
  const applied = await gate([...planned.checks, planned.change], {
    paths,
    finalChanges: [{ ...configChange, after: serializeConfig(config) }],
    auto: true,
    dryRun: false,
    ui: palette("never", env, false),
    t,
  });
  assert.equal(applied.applied, true);

  const stale = await invoke(["doctor", "--here"]);
  const staleIntegration = (stale.value.integrations as Array<Record<string, any>>)
    .find((entry) => entry.tool === "claude");
  assert.equal(staleIntegration?.configuration, "stale");
  assert.deepEqual(staleIntegration?.runtime, {
    path: oldRuntime,
    state: "missing",
    scope: "configured-runtime",
    reason: null,
  });
  assert.equal(check(stale, "Claude Code").state, "problem");
  assert.match(check(stale, "Claude Code").detail, /older reader or runtime/i);
  assert.ok(check(stale, "Claude Code").repair);

  const fixed = await invoke(["doctor", "--here", "--fix", "--auto"]);
  assert.equal(fixed.code, 0, fixed.output);
  assert.equal(fixed.value.fixed, true, fixed.output);
  const refreshed = (fixed.value.integrations as Array<Record<string, any>>)
    .find((entry) => entry.tool === "claude");
  assert.equal(refreshed?.configuration, "configured");
  assert.equal((refreshed?.runtime as Record<string, any>)?.path, process.execPath);
  assert.equal(JSON.parse(readFileSync(agent.hookFile("claude"), "utf8"))
    .hooks.SessionStart[0].hooks[0].command, process.execPath);

  const edited = JSON.parse(readFileSync(agent.hookFile("claude"), "utf8")) as {
    hooks: { SessionStart: Array<{ hooks: Array<Record<string, unknown>> }> };
  };
  edited.hooks.SessionStart[0]!.hooks[0]!.args = [readerPath(paths.root), "--edited-by-user"];
  writeFileSync(agent.hookFile("claude"), `${JSON.stringify(edited, null, 2)}\n`);
  const before = readFileSync(agent.hookFile("claude"), "utf8");
  const foreign = await invoke(["doctor", "--here"]);
  const foreignIntegration = (foreign.value.integrations as Array<Record<string, any>>)
    .find((entry) => entry.tool === "claude");
  // `foreign`, not `stale`: a handler someone edited is not an old copy of ours to refresh, and
  // the two need different answers because only one of them may be overwritten.
  assert.equal(foreignIntegration?.configuration, "foreign");
  assert.equal(check(foreign, "Claude Code").repair, null);
  assert.match(check(foreign, "Claude Code").detail, /changed outside ToneDial/i);

  const refused = await invoke(["doctor", "--here", "--fix", "--auto"]);
  assert.equal(refused.code, 0, refused.output);
  assert.equal(refused.value.fixed, false, refused.output);
  assert.equal(readFileSync(agent.hookFile("claude"), "utf8"), before);
});

test("project doctor reports a managed global native hook without creating a project registration", async () => {
  const setup = await invoke(["init", "--global", "--tools", "claude", "--auto"]);
  assert.equal(setup.code, 0, setup.output);
  const paths = resolvePaths(env);
  const globalAgent = resolveAgentPaths({ global: true, project: null }, env, join(scratch, "project"));
  const projectAgent = resolveAgentPaths({ global: false, project: null }, env, join(scratch, "project"));
  const report = await invoke(["doctor", "--here"]);
  const integration = (report.value.integrations as Array<Record<string, any>>)
    .find((entry) => entry.tool === "claude");
  assert.deepEqual(integration, {
    tool: "claude",
    path: globalAgent.hookFile("claude"),
    inherited: true,
    configuration: "configured",
    runtime: {
      path: process.execPath,
      state: "available",
      scope: "configured-runtime",
      reason: null,
    },
    reader: {
      path: readerPath(paths.root),
      state: "runnable",
      reason: null,
      scope: "cli-runtime",
    },
    // Claude keeps no trust record of its own, so there is nothing to read and nothing to say.
    // Only Codex answers anything else here.
    trust: "unknown",
    activation: "unverified",
  });
  assert.equal(check(report, "Claude Code").state, "ok", report.output);
  assert.match(check(report, "Claude Code").detail, /global SessionStart hook/i);
  assert.equal(existsSync(projectAgent.hookFile("claude")), false);
  const config = parseConfig(readFileSync(paths.config, "utf8"), catalogue("en").cli);
  assert.ok(isConfigV2(config));
  assert.equal(Object.values(config.wiring.registrations).some((registration) =>
    registration.target === "claude" && registration.scope === "project"), false);

  const fixed = await invoke(["doctor", "--here", "--fix", "--auto"]);
  assert.equal(fixed.code, 0, fixed.output);
  assert.equal(fixed.value.fixed, false, fixed.output);
  assert.equal(existsSync(projectAgent.hookFile("claude")), false);
});

test("pair registration without a hook resource stays native and does not fall back to legacy repair", async () => {
  const setup = await invoke(["init", "--here", "--tools", "none", "--auto"]);
  assert.equal(setup.code, 0, setup.output);
  const paths = resolvePaths(env);
  const project = join(scratch, "project");
  const destination = canonicalDestination(project);
  const config = parseConfig(readFileSync(paths.config, "utf8"), catalogue("en").cli);
  assert.ok(isConfigV2(config));
  const id = registrationKey("claude", "project", destination);
  config.wiring.registrations[id] = {
    target: "claude",
    scope: "project",
    destination,
    resourceIds: [],
    context: "pair",
  };
  writeFileSync(paths.config, serializeConfig(config));

  const report = await invoke(["doctor", "--here"]);
  const claude = check(report, "Claude Code");
  assert.equal(claude.state, "problem");
  assert.match(claude.detail, /No ToneDial SessionStart hook/i);
  assert.match(claude.repair ?? "", /tonedial init --tools claude/i,
    "missing reader/skill seeds point back to the seed owner");
  assert.equal((report.value.integrations as Array<Record<string, any>>)
    .some((entry) => entry.tool === "claude" && entry.configuration === "missing"), true);
  // Check the diagnosed status, not serialized paths that may legitimately contain "imported".
  assert.doesNotMatch(claude.detail, /^\s*(?:imported|no tonedial block)(?:\s|$)/i);
});

test("approved repair rebuilds the recorded reader before restoring its scoped native hook", async () => {
  const setup = await invoke(["init", "--here", "--tools", "claude", "--auto"]);
  assert.equal(setup.code, 0, setup.output);
  const paths = resolvePaths(env);
  const agent = resolveAgentPaths({ global: false, project: null }, env, join(scratch, "project"));
  rmSync(readerPath(paths.root));
  rmSync(agent.hookFile("claude"));

  const report = await invoke(["doctor", "--here", "--fix", "--auto"]);
  assert.equal(report.code, 0, report.output);
  assert.equal(report.value.fixed, true, report.output);
  assert.equal((report.value.reader as Record<string, any>)?.state, "runnable");
  const integration = (report.value.integrations as Array<Record<string, any>>)
    .find((entry) => entry.tool === "claude");
  assert.equal(integration?.configuration, "configured");
  assert.equal(existsSync(readerPath(paths.root)), true);
  assert.equal(existsSync(agent.hookFile("claude")), true);
});

test("doctor reports a retained reader as runnable under the CLI runtime without probing the private pair", async (t) => {
  const retainedPath = await retainReaderSeed();
  const paths = resolvePaths(env);
  const privatePair = "doctor-private-reader-pair-sentinel";
  writeFileSync(paths.agents, `${readFileSync(paths.agents, "utf8")}${privatePair}\n`);
  writeFileSync(paths.tone, `${readFileSync(paths.tone, "utf8")}${privatePair}\n`);

  const inputs: (string | Buffer)[] = [];
  const originalSpawn = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", ((...args: Parameters<typeof childProcess.spawnSync>) => {
    const options = args[2] as { input?: string | Buffer } | undefined;
    if (options?.input !== undefined) inputs.push(options.input);
    return originalSpawn(...args);
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  let report: Report;
  try {
    report = await invoke(["doctor", "--here"]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(report.code, 0, report.output);
  assert.deepEqual(report.value.reader, {
    state: "runnable",
    reason: null,
    runtime: process.execPath,
    scope: "cli-runtime",
  });
  assert.equal(check(report, "reader").state, "note");
  assert.equal(check(report, "reader").detail, catalogue("en").cli.doctor.readerState.runnable);
  assert.doesNotMatch(report.output, new RegExp(privatePair));
  assert.equal(inputs.length, 3);
  assert.ok(inputs.every((input) => !Buffer.from(input).toString("utf8").includes(privatePair)));
  assert.equal(readFileSync(retainedPath, "utf8").startsWith("#!"), true);
});

test("doctor does not probe a missing retained reader", async () => {
  const retainedPath = await retainReaderSeed();
  rmSync(retainedPath);

  const report = await invoke(["doctor", "--here"]);
  assert.deepEqual(report.value.reader, {
    state: "missing",
    reason: "missing",
    runtime: null,
    scope: "cli-runtime",
  });
  assert.equal(check(report, "reader").state, "problem");
  assert.equal(check(report, "seeds").repair, `tonedial doctor --fix --project "${join(scratch, "project")}"`);
});

test("doctor does not probe a stale retained reader", async () => {
  await retainReaderSeed();
  const paths = resolvePaths(env);
  const config = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(config.managedSeeds.reader);
  config.managedSeeds.reader.version += 1;
  writeFileSync(paths.config, serializeConfig(config));

  const report = await invoke(["doctor", "--here"]);
  assert.deepEqual(report.value.reader, {
    state: "unrunnable",
    reason: "stale",
    runtime: null,
    scope: "cli-runtime",
  });
  assert.equal(check(report, "reader").state, "problem");
});

test("doctor does not probe an unsafe retained reader path", async () => {
  const retainedPath = await retainReaderSeed();
  const attacker = join(scratch, "reader-attacker.mjs");
  const marker = join(scratch, "reader-attacker-ran");
  writeFileSync(attacker, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  rmSync(retainedPath);
  symlinkSync(attacker, retainedPath);

  const report = await invoke(["doctor", "--here"]);
  assert.deepEqual(report.value.reader, {
    state: "unrunnable",
    reason: "foreign",
    runtime: null,
    scope: "cli-runtime",
  });
  assert.equal(check(report, "reader").state, "problem");
  assert.equal(existsSync(marker), false);
});

test("doctor reports a reader changed at child launch without executing replacement bytes", async (t) => {
  const retainedPath = await retainReaderSeed();
  const marker = join(scratch, "reader-attacker-ran");
  const attacker = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`;
  const originalSpawn = childProcess.spawnSync;
  let replaced = false;
  t.mock.method(childProcess, "spawnSync", ((...args: Parameters<typeof childProcess.spawnSync>) => {
    const [file] = args;
    if (!replaced && file === process.execPath) {
      replaced = true;
      writeFileSync(retainedPath, attacker);
    }
    return originalSpawn(...args);
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    const report = await invoke(["doctor", "--here"]);
    assert.equal(replaced, true);
    assert.deepEqual(report.value.reader, {
      state: "unrunnable",
      reason: "changed",
      runtime: process.execPath,
      scope: "cli-runtime",
    });
    assert.equal(existsSync(marker), false);
    assert.doesNotMatch(report.output, /reader-attacker-ran/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("doctor turns a reader subprocess failure into a bounded diagnostic", async (t) => {
  await retainReaderSeed();
  const privateStdout = "private reader probe stdout";
  const privateStderr = "private reader probe stderr";
  t.mock.method(childProcess, "spawnSync", ((..._args: Parameters<typeof childProcess.spawnSync>) => ({
    pid: 0,
    output: [],
    stdout: privateStdout,
    stderr: privateStderr,
    status: 1,
    signal: null,
    error: undefined,
  }) as unknown as ReturnType<typeof childProcess.spawnSync>) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    const report = await invoke(["doctor", "--here"]);
    assert.deepEqual(report.value.reader, {
      state: "unrunnable",
      reason: "probe",
      runtime: process.execPath,
      scope: "cli-runtime",
    });
    assert.equal(check(report, "reader").state, "problem");
    assert.doesNotMatch(report.output, new RegExp(`${privateStdout}|${privateStderr}`));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("doctor reader probes do not inherit NODE_OPTIONS", async () => {
  await retainReaderSeed();
  const marker = join(scratch, "reader-node-options-inherited");
  const preload = join(scratch, "reader-node-options.cjs");
  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "inherited");\n`);

  const previous = process.env.NODE_OPTIONS;
  try {
    const nodeOptions = `--require=${preload}`;
    // Cover both leak routes: the CLI environment and the parent process environment. The latter
    // is what a child inherits when the implementation forgets to construct an isolated env.
    process.env.NODE_OPTIONS = nodeOptions;
    const report = await invoke(["doctor", "--here"], { NODE_OPTIONS: nodeOptions });
    assert.equal(report.value.reader?.state, "runnable");
    assert.equal(report.value.reader?.runtime, process.execPath);
    assert.equal(existsSync(marker), false);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});

test("legacy diagnosis stays read-only and approved app repair preserves unselected native imports", async () => {
  const project = join(scratch, "project");
  const fixture = await createLegacyFixture({
    env,
    cwd: project,
    routes: [{ tool: "claude", root: project }],
  });
  const legacy = join(fixture.paths.root, "tone.md");
  const before = readFileSync(legacy, "utf8");

  const report = await invoke(["doctor", "--here"]);
  assert.equal(report.code, 0, report.output);
  assert.equal(report.value.context?.kind, "legacy");
  assert.equal(report.value.context?.cause, "legacy");
  assert.equal(report.value.context?.legacyWitness, "present");
  assert.equal(report.value.contextPayload?.totalChars, null);
  assert.deepEqual(report.value.reader, {
    state: "not-required",
    reason: null,
    runtime: null,
    scope: "cli-runtime",
  });
  assert.ok(report.value.context?.legacyConsumers.some((id) => id.startsWith("claude:")));
  assert.equal(check(report, "Claude Code").repair, null);
  assert.equal(check(report, "TONE.md").repair, null);
  assert.doesNotMatch(report.output, /tonedial (compile|wire)/);
  assert.equal(readFileSync(legacy, "utf8"), before);

  // The row stays, because an old connection is still worth naming and still has to be findable
  // for cleanup. What it must never do is write more of the delivery shape this release stopped
  // producing. This goes red if the guard is dropped, or if a target is marked as delivering the
  // pair while its row still writes the import route.
  const instruction = join(project, ".claude", "CLAUDE.md");
  const instructionBefore = readFileSync(instruction, "utf8");
  const repaired = await invoke(["doctor", "--here", "--fix", "--auto"]);
  assert.equal(repaired.value.fixed, true, repaired.output);
  assert.equal(repaired.value.appHealthy, true, repaired.output);
  assert.equal((repaired.value.native as Record<string, unknown>).applied, false);
  assert.equal(repaired.value.nativeAttention, true);
  assert.equal(readFileSync(instruction, "utf8"), instructionBefore, "--fix wrote an import block");
  assert.equal(readFileSync(legacy, "utf8"), before);
});

test("legacy hook and skill resources do not require a reader seed in doctor or update", async () => {
  const project = join(scratch, "project");
  const setup = await invoke(["init", "--here", "--tools", "none", "--auto"]);
  assert.equal(setup.code, 0, setup.output);
  const paths = resolvePaths(env);
  const prior = parseConfig(readFileSync(paths.config, "utf8"));
  assert.ok(isConfigV2(prior));
  // Preserve the current guide/preset records so the only optional source under test is the
  // legacy delivery. Its lowercase artifact does not change which optional readers are selected.
  rmSync(paths.tone);
  const fixture = await createLegacyFixture({
    env,
    cwd: project,
    priorConfig: prior,
    routes: [{ tool: "claude", root: project }],
    skills: [{ tools: ["claude"], root: project }],
  });
  const kinds = Object.values(fixture.config.wiring.resources).map(({ kind }) => kind);
  assert.ok(kinds.includes("hook"), "fixture must contain a retained hook resource");
  assert.ok(kinds.includes("skill"), "fixture must contain a retained skill resource");

  const report = await invoke(["doctor", "--here"]);
  assert.equal(report.code, 0, report.output);
  assert.equal(report.value.context?.kind, "current");
  assert.deepEqual(report.value.reader, {
    state: "not-required",
    reason: null,
    runtime: null,
    scope: "cli-runtime",
  });
  const seeds = check(report, "seeds");
  assert.equal(seeds.state, "ok", report.output);
  assert.equal(seeds.repair, null);
  assert.equal(seeds.files?.some(({ path }) => path === readerPath(paths.root)) ?? false, false, report.output);

  // The update path consumes the same selector. Force the local npm branch so this regression
  // never performs a registry request while still observing its seed-issue receipt.
  const update = await invoke(["update"], { TONEDIAL_INSTALL_SHAPE: "npm" });
  assert.equal(update.code, 0, update.output);
  assert.deepEqual(update.value.seedIssues, []);
  assert.deepEqual(update.value.staleSeeds, []);
});

for (const language of ["en", "ko"] as const) {
  test(`human doctor identifies its scope and groups other registrations in ${language}`, async () => {
    env.LANG = language === "ko" ? "ko_KR.UTF-8" : "en_US.UTF-8";
    env.COLUMNS = "60";
    const copy = catalogue(language).cli.doctor;
    const project = join(scratch, "project");
    const other = join(scratch, "other");
    mkdirSync(project);
    mkdirSync(other);
    const assertScope = (output: string, label: string, root: string) => {
      assert.ok(output.includes(`  ${label}\n  ${root}\n`), output);
      assert.equal(output.split(label).length - 1, 1, output);
    };
    const fresh = await invokeHuman(["doctor", "--here"]);
    assertScope(fresh.output, copy.scope, project);
    assert.equal((await invoke(["init", "--project", project, "--tools", "claude,codex,antigravity", "--lang", language, "--auto"])).code, 0);
    assert.equal((await invoke(["wire", "codex", "--project", other, "--auto"])).code, 0);
    const intact = await invokeHuman(["doctor", "--global"]);
    assert.ok(!containsWrapped(intact.output, copy.inspectScope), intact.output);
    assert.ok(!containsWrapped(intact.output, copy.disconnectScope), intact.output);
    rmSync(join(project, ".claude", "settings.json"));
    rmSync(join(project, ".agents", "hooks.json"));
    rmSync(other, { recursive: true });

    const mixed = await invokeHuman(["doctor"]);
    assertScope(mixed.output, copy.scopeGlobal, scratch);
    const section = mixed.output.slice(mixed.output.indexOf(copy.wiredElsewhere));
    assert.ok(containsWrapped(section, `antigravity, claude — ${copy.destinationUnwired}`), section);
    assert.ok(containsWrapped(section, `codex — ${copy.destinationPresent}`), section);
    assert.ok(containsWrapped(section, `codex — ${copy.destinationGone}`), section);
    assert.ok(containsWrapped(section, copy.inspectScope), section);
    assert.ok(containsWrapped(section, copy.disconnectScope), section);
    const unfolded = section.replace(/\s+/g, " ");
    for (const advice of [copy.inspectScope, copy.disconnectScope]) {
      assert.equal(unfolded.split(advice).length - 1, 2, section);
    }
    for (const destination of [project, other].map(canonicalDestination)) {
      assert.equal(section.split("\n").filter(line => line.trim() === destination).length, 1, section);
      for (const command of ["doctor", "eject"]) {
        assert.equal(section.split(`tonedial ${command} --project "${destination}"`).length - 1, 1, section);
      }
    }
    // The full scoped commands above stay copyable; their long paths use terminal soft wrapping.
    const prose = (output: string) => output.split("\n").filter(line => !/^tonedial (doctor|eject) /.test(line.trim())).join("\n");
    assertHumanWidth(prose(mixed.output), language, 60);

    rmSync(join(project, ".codex", "hooks.json"));
    const missing = await invokeHuman(["doctor", "--global", "--verbose"]);
    assertScope(missing.output, copy.scopeGlobal, scratch);
    assert.ok(containsWrapped(missing.output, `antigravity, claude, codex — ${copy.destinationUnwired}`), missing.output);
    assertHumanWidth(prose(missing.output), language, 60);
    for (const args of [["--here"], ["--project", project, "--verbose"]]) {
      const selected = await invokeHuman(["doctor", ...args]);
      assertScope(selected.output, copy.scope, project);
      const elsewhere = selected.output.slice(selected.output.indexOf(copy.wiredElsewhere));
      assert.ok(!elsewhere.includes(project), elsewhere);
    }
    assert.equal((await invoke(["wire", "codex", "--global", "--auto"])).code, 0);
    rmSync(join(scratch, ".codex", "hooks.json"));
    const global = await invokeHuman(["doctor", "--here"]);
    const globalSection = global.output.slice(global.output.indexOf(copy.wiredElsewhere));
    for (const command of ["doctor", "eject"]) {
      assert.equal(globalSection.split(`tonedial ${command} --global`).length - 1, 1, globalSection);
    }
  });

  // Match the existing UI suite's global width scenario; long project repair paths are a
  // separately recorded soft-wrap limitation, not a reader-copy guarantee.
  test(`human global doctor keeps current reader detail behind verbose in ${language}`, async () => {
    await retainReaderSeed(language);
    const expected = catalogue(language).cli.doctor.readerState.runnable;
    const concise = await invokeHuman(["doctor", "--global"]);
    assert.equal(concise.code, 0, concise.output + concise.error);
    assert.equal(containsWrapped(concise.output, expected), false, concise.output);
    const verbose = await invokeHuman(["doctor", "--global", "--verbose"]);
    assert.equal(verbose.code, 0, verbose.output + verbose.error);
    assert.equal(containsWrapped(verbose.output, expected), true, verbose.output);
    assertHumanWidth(verbose.output, language);
  });

  test(`human global doctor renders a missing reader result in ${language}`, async () => {
    const retainedPath = await retainReaderSeed(language);
    rmSync(retainedPath);
    const result = await invokeHuman(["doctor", "--global"]);
    assert.equal(result.code, 0, result.output + result.error);
    const expected = catalogue(language).cli.doctor.readerState.missing;
    assert.equal(containsWrapped(result.output, expected), true, result.output);
    assertHumanWidth(result.output, language);
  });
}

test("invalid config is a structured inspection failure without echoing its bytes", async () => {
  const paths = resolvePaths(env);
  mkdirSync(paths.root, { recursive: true });
  const secret = "private damaged config payload";
  writeFileSync(paths.config, secret);

  const report = await invoke(["doctor", "--here"]);
  assert.equal(report.code, 0, report.output);
  assert.deepEqual(report.value.context, {
    kind: "conflict",
    cause: "inspection",
    legacyWitness: "unresolved",
    legacyConsumers: [],
    migration: { route: null, reason: "inspection" },
    inspectionFailure: null,
  });
  assert.equal(report.value.contextPayload?.guideFormat, "not-inspected");
  assert.equal(report.value.contextPayload?.totalChars, null);
  assert.deepEqual(report.value.reader, {
    state: "not-inspected",
    reason: "inspection",
    runtime: null,
    scope: "cli-runtime",
  });
  const context = check(report, "context");
  assert.equal(context.state, "problem");
  assert.ok(containsWrapped(context.detail, paths.config), "the failure names the file it could not read");
  assert.doesNotMatch(report.output, new RegExp(secret));
  assert.deepEqual(report.value.checks?.map(({ name }) => name), ["context"]);
});

test("wiring in another scope is reported, never repaired, and only for agent targets", async () => {
  // `doctor` inspects one scope. Until now it said nothing at all about the others, so a
  // project wired months ago and since deleted left a registration no command mentioned and
  // no report could lead anyone to.
  const p1 = join(scratch, "p1");
  const p2 = join(scratch, "p2");
  mkdirSync(p1, { recursive: true });
  mkdirSync(p2, { recursive: true });
  assert.equal((await invoke(["init", "--here", "--tools", "none", "--auto"])).code, 0);
  assert.equal((await invoke(["wire", "codex", "--project", p1, "--auto"])).code, 0);
  assert.equal((await invoke(["wire", "codex", "--project", p2, "--auto"])).code, 0);

  type Row = { target: string; scope: string; destination: string; state: string };
  const rows = (report: Report) => report.value.wiredElsewhere as Row[];

  const healthy = await invoke(["doctor", "--project", p1]);
  assert.equal(rows(healthy).length, 1, "the scope being inspected is not elsewhere");
  assert.equal(rows(healthy)[0]!.state, "ok");
  assert.match(rows(healthy)[0]!.destination, /p2$/);

  // A hook removed by hand, with the skill directory left alone. Reading one resource would
  // call this healthy; a codex registration carries two.
  const hook = join(p2, ".codex", "hooks.json");
  assert.ok(existsSync(hook), hook);
  rmSync(hook);
  assert.equal(rows(await invoke(["doctor", "--project", p1]))[0]!.state, "unwired");

  rmSync(p2, { recursive: true, force: true });
  const gone = await invoke(["doctor", "--project", p1]);
  assert.equal(rows(gone)[0]!.state, "gone");
  const human = await invokeHuman(["doctor", "--project", p1]);
  assert.ok(containsWrapped(human.output, "tonedial eject --project"), human.output);

  // Reported, never repaired: `existsSync` is false on a permission error and on an unmounted
  // volume, and a renamed project still carries a hook that keeps delivering, so dropping the
  // record on a guess destroys the only provenance there is.
  //
  // `--fix` writes the config only when it has something local to repair, so p1's own hook is
  // damaged first. Without that, `repairable` is empty, `serializeConfig` is never called, and
  // the assertion below passes against any implementation at all.
  rmSync(join(p1, ".codex", "hooks.json"));
  const before = readFileSync(resolvePaths(env).config, "utf8");
  const repaired = await invoke(["doctor", "--project", p1, "--fix", "--auto"]);
  assert.equal(repaired.code, 0, repaired.output);
  assert.equal(repaired.value.fixed, true, "the fixture has to give --fix a reason to write");
  const after = parseConfig(readFileSync(resolvePaths(env).config, "utf8"));
  assert.ok(isConfigV2(after));
  assert.equal(
    Object.values(after.wiring.registrations).filter((r) => r.destination.endsWith("p2")).length, 1,
    `--fix dropped the record for a directory it cannot see:\n${before}`,
  );

  // A curl install registers the directory of its rc file as a `shell` target, and
  // `eject --project ~` is not how a PATH line is removed.
  const planted = parseConfig(readFileSync(resolvePaths(env).config, "utf8"));
  assert.ok(isConfigV2(planted));
  const shellHome = canonicalDestination(scratch);
  planted.wiring.registrations[registrationKey("shell", "global", shellHome)] =
    { target: "shell", scope: "global", destination: shellHome, resourceIds: [] };
  writeFileSync(resolvePaths(env).config, serializeConfig(planted));
  assert.deepEqual(
    rows(await invoke(["doctor", "--project", p1])).map(({ target }) => target), ["codex"],
    "a shell registration is not an agent to eject",
  );
});

test("damaged-config recovery requires an explicit source without exposing or changing unknown input", async () => {
  const paths = resolvePaths(env);
  mkdirSync(paths.root, { recursive: true });
  const secret = "private damaged config payload";
  writeFileSync(paths.config, secret);
  const before = readFileSync(paths.config, "utf8");

  const result = await invokeHuman(["doctor", "--here", "--fix", "--auto"]);
  assert.equal(result.code, 1, result.output);
  assert.ok(containsWrapped(result.error, catalogue("en").cli.recovery.sourceRequired));
  const layoutRefusal = catalogue("en").cli.errors.contextLayout("conflict", paths.root);
  assert.ok(!result.error.includes(layoutRefusal), "and does not diagnose a layout it never read");
  assert.doesNotMatch(result.error + result.output, new RegExp(secret), "and never echoes its bytes");
  assert.equal(readFileSync(paths.config, "utf8"), before, "a refusal that says nothing was written wrote nothing");
});

test("malformed hook JSON remains a bounded structured diagnostic", async () => {
  const setup = await invoke(["init", "--here", "--tools", "none", "--auto"]);
  assert.equal(setup.code, 0, setup.output);
  const hookPath = join(scratch, "project", ".codex", "hooks.json");
  mkdirSync(join(scratch, "project", ".codex"), { recursive: true });
  writeFileSync(hookPath, JSON.stringify({ hooks: { SessionStart: { private: "hook payload" } } }));
  const beforeHook = readFileSync(hookPath);
  const paths = resolvePaths(env);
  const beforeState = [paths.config, paths.agents, paths.tone].map((path) => ({ path, bytes: readFileSync(path) }));

  const report = await invoke(["doctor", "--here"]);
  assert.equal(report.code, 0, report.output);
  assert.equal(report.value.context?.kind, "current");
  assert.equal(report.value.context?.cause, "none");
  assert.equal(report.value.context?.inspectionFailure, null);
  assert.equal(report.value.nativeAttention, true);
  const provider = check(report, "Codex CLI");
  assert.equal(provider.state, "problem");
  assert.equal(provider.repair, null);
  assert.ok(containsWrapped(provider.detail, hookPath));
  assert.doesNotMatch(report.output, /hook payload/);
  assert.deepEqual(readFileSync(hookPath), beforeHook);
  for (const { path, bytes } of beforeState) assert.deepEqual(readFileSync(path), bytes, path);
});

test("doctor revalidates its classifier read-set before an interactive repair", async () => {
  const project = join(scratch, "project");
  const setup = await invoke(["init", "--here", "--tools", "none", "--auto"]);
  assert.equal(setup.code, 0, setup.output);
  const paths = resolvePaths(env);
  const guideBefore = readFileSync(paths.agents, "utf8");
  rmSync(paths.tone);

  const input = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: true, writable: true });
  Object.defineProperty(input, "isRaw", { value: false, writable: true });
  Object.defineProperty(input, "setRawMode", {
    value: (raw: boolean) => {
      Object.defineProperty(input, "isRaw", { value: raw, writable: true });
      return input;
    },
  });
  const originalStdin = process.stdin;
  const originalWrite = process.stdout.write;
  let output = "";
  let changed = false;
  process.stdout.write = ((chunk: string) => {
    output += chunk;
    if (!changed && chunk.includes(paths.tone)) {
      changed = true;
      writeFileSync(paths.agents, "guide changed after approval preview\n");
    }
    return true;
  }) as typeof originalWrite;
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  input.end("yes\n");

  const context = {
    paths,
    cwd: project,
    flags: {
      verbose: false,
      project: null,
      check: false,
      explain: false,
      global: false,
      auto: false,
      dryRun: false,
      fix: true,
      rollback: null,
      lang: null,
      commands: false,
      tools: null,
    },
    ui: palette("never", env, false),
    agent: resolveAgentPaths({ global: false, project: null }, env, project),
    env,
    t: catalogue("en").cli,
    asJson: false,
    canPrompt: true,
  };
  try {
    await assert.rejects(
      () => runDoctor(context, []),
      /changed after the diff was prepared/,
    );
  } finally {
    process.stdout.write = originalWrite;
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
  }
  assert.equal(changed, true, output);
  assert.equal(existsSync(paths.tone), false, "the stale repair was not applied");
  assert.equal(readFileSync(paths.agents, "utf8"), "guide changed after approval preview\n");
  assert.notEqual(readFileSync(paths.agents, "utf8"), guideBefore);
});

for (const language of ["en", "ko"] as const) {
  test(`human doctor groups unconnected agents into one readable check in ${language}`, async () => {
    env.LANG = language === "ko" ? "ko_KR.UTF-8" : "en_US.UTF-8";
    env.COLUMNS = "60";
    assert.equal((await invoke(["init", "--global", "--tools", "none", "--lang", language, "--auto"])).code, 0);

    const result = await invokeHuman(["doctor", "--global"]);
    const copy = catalogue(language).cli.doctor;
    const tools = ["Claude Code", "Antigravity IDE/Desktop", "Codex CLI"];
    const unfolded = result.output.replace(/\s+/g, " ");
    const count = (value: string) => unfolded.split(value.replace(/\s+/g, " ")).length - 1;
    assert.equal(result.code, 0, result.output + result.error);
    assert.equal(count(copy.hookGroupHeading), 1, result.output);
    assert.ok(containsWrapped(result.output, copy.hookGroupUnknown(tools)), result.output);
    assert.ok(!containsWrapped(result.output, copy.hookSettingScope), "unused integrations need no enablement disclaimer");
    assert.ok(result.output.includes(copy.scopeGlobal), result.output);
    assert.doesNotMatch(result.output, /Hook enabled|훅이 켜져/);
    assertHumanWidth(result.output, language, 60);

    const verbose = await invokeHuman(["doctor", "--global", "--verbose"]);
    assert.equal(verbose.code, 0, verbose.output + verbose.error);
    assert.ok(containsWrapped(verbose.output, copy.notInstalled), "verbose concealed a missing agent home");
    assert.ok(tools.every(tool => verbose.output.includes(tool)), "verbose lost an individual agent check");
    assert.ok(!verbose.output.includes(copy.hookGroupHeading), "verbose still collapsed diagnostic evidence");
  });
}
