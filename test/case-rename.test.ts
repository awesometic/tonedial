// Recovery of persisted case-only rename actions from versions that produced them.
// A child process records the historical journal and exits so its owner is provably dead.

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../src/cli.ts";
import { catalogue } from "../src/core/i18n.ts";
import { inspectOperations, readJournal, type OperationJournal } from "../src/core/operations.ts";
import { LEGACY_CONTEXT_ARTIFACT_FILENAME, resolveAgentPaths, type Paths } from "../src/core/paths.ts";
import { applyRollback, previewRollback } from "../src/wiring/apply.ts";
import { createLegacyFixture } from "./support/legacy-fixture.ts";

const EN = catalogue("en").cli;
const TEMPORARY_MARK = ".tonedial-case-";
const FOREIGN = "someone else got here first\n";

let scratch: string;
let project: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "tonedial-case-rename-")));
  project = join(scratch, "project");
  fs.mkdirSync(project);
  env = { HOME: scratch, TONEDIAL_HOME: join(scratch, "state"), PATH: "", LANG: "en_US.UTF-8" };
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

async function invoke(args: string[]) {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = ((text: string) => { stdout += text; return true; }) as typeof out;
  process.stderr.write = ((text: string) => { stderr += text; return true; }) as typeof err;
  try {
    const code = await run([...args, "--json"], env, project, false, false);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/** The old lowercase layout and delivery whose exact bytes recovery must preserve. */
async function witnessed(tool: "codex" | "claude" = "codex") {
  const { paths } = await createLegacyFixture({ env, cwd: project, routes: [{ tool, root: project }] });
  const lower = join(paths.root, LEGACY_CONTEXT_ARTIFACT_FILENAME);
  return {
    paths,
    lower,
    upper: join(paths.root, "TONE.md"),
    bytes: fs.readFileSync(lower, "utf8"),
    inode: fs.statSync(lower).ino,
    configBytes: fs.readFileSync(paths.config, "utf8"),
    legacyFile: resolveAgentPaths({ global: false, project: null }, env, project).wiredFile(tool),
    hook: () => fs.readFileSync(resolveAgentPaths({ global: false, project: null }, env, project).wiredFile(tool), "utf8"),
  };
}

type HistoricalPlacement = "before-second" | "after-second" | "inside-second" | "destination-appears";

/** Persist an old-format pending journal and its interrupted physical state in a dead process. */
function interrupted(at: HistoricalPlacement, state: { lower: string; upper: string; paths: Paths }) {
  const script = `
    import fs from "node:fs";
    import { join, dirname } from "node:path";
    import { acquireOperation, beginJournal } from ${JSON.stringify(new URL("../src/core/operations.ts", import.meta.url).href)};
    const SOURCE = ${JSON.stringify(state.lower)};
    const UPPER = ${JSON.stringify(state.upper)};
    const FOREIGN = ${JSON.stringify(FOREIGN)};
    const placement = ${JSON.stringify(at)};
    const paths = ${JSON.stringify(state.paths)};
    const temporary = join(paths.root, ".tone.md.tonedial-case-" + "a".repeat(32) + ".tmp");
    const source = fs.lstatSync(SOURCE, { bigint: true });
    const parent = fs.statSync(dirname(SOURCE), { bigint: true });
    const physical = fs.realpathSync(SOURCE);
    const parentIdentity = parent.dev + ":" + parent.ino;
    const action = {
      id: "case-rename:" + SOURCE + ":" + UPPER + ":" + temporary,
      kind: "case-rename", path: SOURCE, realPath: UPPER,
      before: {
        exists: true, resolvedPath: physical, realPath: physical, symbolicLink: false,
        linkTarget: null, mode: Number(source.mode & 0o7777n),
        pathIdentity: source.dev + ":" + source.ino, targetIdentity: source.dev + ":" + source.ino,
        parentIdentity: null, parentPath: null, bytes: fs.readFileSync(SOURCE).toString("base64"),
      },
      after: {
        exists: false, resolvedPath: UPPER, realPath: null, symbolicLink: false,
        linkTarget: null, mode: null, pathIdentity: null, targetIdentity: null,
        parentIdentity, parentPath: dirname(SOURCE),
      },
      metadata: {
        schema: 1, source: SOURCE, destination: UPPER, temporary, boundary: paths.root,
        boundaryIdentity: parentIdentity, parentPath: dirname(SOURCE), parentIdentity,
      },
    };
    const owner = acquireOperation(paths, "mutation");
    beginJournal(owner, [action], { kind: "migration", reason: "case" });
    fs.linkSync(SOURCE, temporary);
    fs.unlinkSync(SOURCE);
    if (placement === "destination-appears") fs.writeFileSync(UPPER, FOREIGN);
    else if (placement !== "before-second") {
      fs.linkSync(temporary, UPPER);
      if (placement === "after-second") fs.unlinkSync(temporary);
    }
    process.exitCode = 1;
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 20_000,
    env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: scratch, TMPDIR: scratch },
  });
  assert.equal(result.status, 1, `historical fixture did not finish: ${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, "", "historical fixture setup failed before its intended exit");
  return result;
}

/** Whether this filesystem folds case, probed once rather than assumed from the platform. */
function foldsCase(root: string): boolean {
  const probe = join(root, "tonedial-case-probe");
  fs.writeFileSync(probe, "");
  try {
    return fs.existsSync(join(root, "TONEDIAL-CASE-PROBE"));
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

/** Names in the state root, so a case-only spelling is compared as a directory entry. */
const entries = (paths: Paths) => fs.readdirSync(paths.root);
const temporaryOf = (paths: Paths) => entries(paths).find((name) => name.includes(TEMPORARY_MARK));

function pendingJournal(paths: Paths): OperationJournal {
  const inspected = inspectOperations(paths);
  assert.equal(inspected.lock.state, "dead", "the interrupted writer should no longer hold a live lock");
  const pending = inspected.journals.find((entry) => entry.state === "pending");
  assert.ok(pending?.journal, "the interrupted transition left no pending journal");
  return pending.journal;
}

test("an interruption between the two renames parks the artifact and rollback restores its identity", async () => {
  const state = await witnessed();
  const hookBefore = state.hook();
  interrupted("before-second", state);

  // The artifact is at neither spelling: it is parked at the temporary sibling.
  assert.ok(!entries(state.paths).includes(LEGACY_CONTEXT_ARTIFACT_FILENAME));
  assert.ok(!entries(state.paths).includes("TONE.md"));
  const parked = temporaryOf(state.paths);
  assert.ok(parked, `no temporary sibling remains: ${entries(state.paths).join(", ")}`);
  assert.equal(fs.readFileSync(join(state.paths.root, parked), "utf8"), state.bytes);

  const journal = pendingJournal(state.paths);
  const preview = previewRollback(state.paths, journal.operationId, EN);
  assert.equal(preview.status, "ready", JSON.stringify(preview.unresolved));

  const recovered = await invoke(["doctor", "--fix", "--rollback", journal.operationId, "--auto"]);
  assert.equal(recovered.code, 0, recovered.stdout || recovered.stderr);
  assert.ok(entries(state.paths).includes(LEGACY_CONTEXT_ARTIFACT_FILENAME));
  assert.equal(temporaryOf(state.paths), undefined, "the temporary sibling is not left behind");
  assert.equal(fs.readFileSync(state.lower, "utf8"), state.bytes);
  assert.equal(fs.statSync(state.lower).ino, state.inode, "the restored artifact is the same file, not a copy");
  assert.equal(fs.readFileSync(state.paths.config, "utf8"), state.configBytes);
  assert.equal(state.hook(), hookBefore);
});

test("an interruption after the rename lands but before its checkpoint is recoverable, not a dead end", async () => {
  const state = await witnessed();
  interrupted("after-second", state);

  // The rename landed; only the checkpoint did not. The upper-case entry holds the same file.
  assert.ok(entries(state.paths).includes("TONE.md"));
  assert.ok(!entries(state.paths).includes(LEGACY_CONTEXT_ARTIFACT_FILENAME));
  assert.equal(temporaryOf(state.paths), undefined);
  assert.equal(fs.statSync(state.upper).ino, state.inode);

  const journal = pendingJournal(state.paths);
  const preview = previewRollback(state.paths, journal.operationId, EN);
  assert.equal(preview.status, "ready",
    `an uncheckpointed rename whose destination still holds the recorded file is resolvable: ${JSON.stringify(preview.unresolved)}`);

  // Identity decides, not bytes: a move preserves the inode, so a replacement carrying the same
  // content is a different file and must not be adopted as the one this action moved. A second
  // link keeps the original inode alive while the replacement stands in its place.
  const keep = join(state.paths.root, "keep-inode");
  fs.linkSync(state.upper, keep);
  fs.rmSync(state.upper);
  fs.writeFileSync(state.upper, state.bytes);
  assert.notEqual(fs.statSync(state.upper).ino, state.inode, "the probe did not produce a new inode");
  assert.equal(previewRollback(state.paths, journal.operationId, EN).status, "unresolved",
    "a byte-identical replacement was adopted as the moved file");
  fs.rmSync(state.upper);
  fs.linkSync(keep, state.upper);
  fs.rmSync(keep);
  assert.equal(fs.statSync(state.upper).ino, state.inode);

  const recovered = await invoke(["doctor", "--fix", "--rollback", journal.operationId, "--auto"]);
  assert.equal(recovered.code, 0, recovered.stdout || recovered.stderr);
  assert.ok(entries(state.paths).includes(LEGACY_CONTEXT_ARTIFACT_FILENAME));
  assert.ok(!entries(state.paths).includes("TONE.md"));
  assert.equal(fs.readFileSync(state.lower, "utf8"), state.bytes);
  assert.equal(fs.statSync(state.lower).ino, state.inode);
  assert.equal(fs.readFileSync(state.paths.config, "utf8"), state.configBytes);
});

test("historical case recovery preserves an unrecorded destination beside the parked artifact", async () => {
  const state = await witnessed();
  interrupted("destination-appears", state);

  const parked = temporaryOf(state.paths);
  assert.ok(parked, `the artifact was lost rather than parked: ${entries(state.paths).join(", ")}`);
  assert.equal(fs.readFileSync(join(state.paths.root, parked), "utf8"), state.bytes);
  assert.equal(fs.statSync(join(state.paths.root, parked)).ino, state.inode);

  // Case-folding filesystems make the old spelling and the foreign destination one entry.
  const folds = foldsCase(state.paths.root);
  const journal = pendingJournal(state.paths);
  const recovered = applyRollback(state.paths, journal.operationId, EN);
  assert.equal(fs.readFileSync(state.upper, "utf8"), FOREIGN, "rollback does not reclaim a destination it never wrote");
  assert.equal(recovered.state, folds ? "pending" : "rolled-back", JSON.stringify(recovered.unresolved));
  const restoredTo = folds ? join(state.paths.root, parked) : state.lower;
  assert.equal(fs.readFileSync(restoredTo, "utf8"), state.bytes);
  assert.equal(fs.statSync(restoredTo).ino, state.inode);
});

test("a crash inside the second move leaves no second copy behind", async () => {
  const state = await witnessed();
  interrupted("inside-second", state);

  // A move is a link then an unlink. Dying between them leaves one file reachable under two
  // names, and recovery that restores from the temporary without noticing would report success
  // while the artifact stayed at the upper-case name for the next setup to trip over.
  const parked = temporaryOf(state.paths);
  assert.ok(parked, `the temporary link is gone: ${entries(state.paths).join(", ")}`);
  assert.ok(entries(state.paths).includes("TONE.md"));
  assert.equal(fs.statSync(state.upper).ino, fs.statSync(join(state.paths.root, parked)).ino, "not one inode under two names");

  const journal = pendingJournal(state.paths);
  const recovered = applyRollback(state.paths, journal.operationId, EN);
  assert.equal(recovered.state, "rolled-back", JSON.stringify(recovered.unresolved));
  assert.deepEqual(
    entries(state.paths).filter((name) => name.toLowerCase().includes("tone")).sort(),
    [LEGACY_CONTEXT_ARTIFACT_FILENAME],
    "recovery left a second name holding the artifact",
  );
  assert.equal(fs.statSync(state.lower).ino, state.inode);
});

test("a migration over a file this tool created and the user edited stays recoverable", async () => {
  // The legacy instruction file was created by an older install, so ownership records it as ours;
  // the user has since added their own lines. Removing our region leaves their file behind, and a
  // journal claiming this action created a file that survives is one recovery refuses to read.
  const state = await witnessed("claude");
  const instructions = state.legacyFile;
  fs.appendFileSync(instructions, "\nMy own notes.\n");
  const edited = fs.readFileSync(instructions, "utf8");

  const applied = await invoke(["init", "--here", "--tools", "claude", "--auto"]);
  assert.equal(applied.code, 0, applied.stderr || applied.stdout);
  const result = JSON.parse(applied.stdout);
  const operationId = result.native.operationId as string;
  assert.equal(typeof operationId, "string");
  assert.equal(previewRollback(state.paths, operationId, EN).status, "ready",
    JSON.stringify(previewRollback(state.paths, operationId, EN).unresolved));

  const recovered = await invoke(["doctor", "--fix", "--rollback", operationId, "--auto"]);
  assert.equal(recovered.code, 0, recovered.stdout || recovered.stderr);
  const app = await invoke(["doctor", "--fix", "--rollback", result.operationId, "--auto"]);
  assert.equal(app.code, 0, app.stdout || app.stderr);
  assert.equal(fs.readFileSync(instructions, "utf8"), edited, "the user's own lines were not restored");
  assert.ok(entries(state.paths).includes(LEGACY_CONTEXT_ARTIFACT_FILENAME));
});

test("a replacement at the parked artifact is preserved and reported unresolved instead of restored", async () => {
  const state = await witnessed();
  interrupted("before-second", state);
  const parked = temporaryOf(state.paths)!;

  // The user re-creates the old spelling by hand before asking for recovery. Restoring over it
  // would destroy their file, so recovery must stop rather than choose between the two.
  fs.writeFileSync(state.lower, "the user wrote this while recovering\n");

  const journal = pendingJournal(state.paths);
  const refused = applyRollback(state.paths, journal.operationId, EN);
  assert.equal(refused.state, "pending");
  assert.match(refused.unresolved.join(" "), new RegExp(`${LEGACY_CONTEXT_ARTIFACT_FILENAME}: changed`));
  assert.equal(fs.readFileSync(state.lower, "utf8"), "the user wrote this while recovering\n");
  assert.equal(fs.readFileSync(join(state.paths.root, parked), "utf8"), state.bytes);
  assert.equal(readJournal(state.paths, journal.operationId)?.state, "pending", "the journal is kept for manual recovery");
  assert.equal(fs.existsSync(state.paths.operationsLock), true, "the lock is kept so no other command overwrites it");
});

test("an invalid case-rename descriptor never crashes recovery and never writes", async () => {
  const state = await witnessed();
  interrupted("before-second", state);
  const journal = pendingJournal(state.paths);

  // Corrupt the recorded boundary so the descriptor no longer contains its own paths.
  //
  // What this pins is that a damaged journal is refused as data rather than acted on: recovery
  // reports it unresolved, writes nothing, and never lets an injected filesystem failure escape
  // as a raw error. What it cannot pin is the internal ordering — validation before the first
  // read — because the probe converts every failure into "changed", so a version that read first
  // would report the same thing. That ordering is held by the code and its comment alone; making
  // it observable would need the probe to distinguish its causes, which it deliberately does not.
  const journalPath = join(state.paths.operations, `${journal.operationId}.json`);
  const stored = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const action = stored.actions.find((entry: { kind: string }) => entry.kind === "case-rename");
  assert.ok(action, "the pending journal carries no case-rename action");
  action.metadata.boundary = join(scratch, "elsewhere");
  fs.writeFileSync(journalPath, JSON.stringify(stored));

  const originalRead = fs.readdirSync;
  const originalStat = fs.lstatSync;
  const guard = "the descriptor was used before it was validated";
  const readdir = mock.method(fs, "readdirSync", (path: fs.PathLike, options?: unknown) => {
    if (String(path) === state.paths.root) throw new Error(guard);
    return (originalRead as (p: fs.PathLike, o?: unknown) => unknown)(path, options);
  });
  const lstat = mock.method(fs, "lstatSync", (path: fs.PathLike, options?: unknown) => {
    const target = String(path);
    if (target === state.lower || target === state.upper || target.includes(TEMPORARY_MARK)) {
      throw new Error(guard);
    }
    return (originalStat as (p: fs.PathLike, o?: unknown) => unknown)(path, options);
  });
  syncBuiltinESMExports();
  try {
    const refused = applyRollback(state.paths, journal.operationId, EN);
    assert.equal(refused.state, "pending");
    assert.doesNotMatch(refused.unresolved.join(" "), new RegExp(guard), refused.unresolved.join(" "));
  } finally {
    readdir.mock.restore();
    lstat.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readJournal(state.paths, journal.operationId)?.state, "pending");
  assert.ok(temporaryOf(state.paths), "the parked artifact was moved by a refused recovery");
});

test("historical case recovery retains its journal when the filesystem cannot restore the file", async () => {
  const state = await witnessed();
  interrupted("before-second", state);
  const journal = pendingJournal(state.paths);
  const parked = temporaryOf(state.paths)!;
  const original = fs.linkSync;
  const link = mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === state.lower) {
      throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
    }
    return original(from, to);
  });
  syncBuiltinESMExports();
  try {
    const result = applyRollback(state.paths, journal.operationId, EN);
    assert.equal(result.state, "pending");
    assert.match(result.unresolved.join(" "), /operation not supported/);
  } finally {
    link.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(join(state.paths.root, parked), "utf8"), state.bytes);
  assert.equal(fs.statSync(join(state.paths.root, parked)).ino, state.inode);
  assert.equal(fs.existsSync(state.lower), false);
  assert.equal(readJournal(state.paths, journal.operationId)?.state, "pending");
  assert.equal(fs.existsSync(state.paths.operationsLock), true);
});
