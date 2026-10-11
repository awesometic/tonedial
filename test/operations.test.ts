import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { catalogue } from "../src/core/i18n.ts";
import type { WiringV2 } from "../src/core/config.ts";
import {
  acquireOperation,
  beginJournal,
  checkpointJournal,
  finishJournal,
  inspectOperations,
  readJournal,
  releaseOperation,
  rollbackOperation,
  type OperationAction,
  type OperationPaths,
} from "../src/core/operations.ts";
import { applyRollback, gate, planChange, previewRollback, type PlannedOperationAction } from "../src/wiring/apply.ts";
import { planSkillInstall } from "../src/wiring/skill.ts";
import { palette } from "../src/ui/style.ts";

const EN = catalogue("en").cli;

function temporaryPaths(): { root: string; paths: OperationPaths } {
  const root = mkdtempSync(join(tmpdir(), "tonedial-operations-"));
  return {
    root,
    paths: {
      root,
      operations: join(root, "operations"),
      operationsLock: join(root, "operations.lock"),
    },
  };
}

function action(path: string): OperationAction {
  const parent = dirname(path);
  const realPath = join(fs.realpathSync(parent), basename(path));
  const parentStat = fs.statSync(parent, { bigint: true });
  return {
    id: `file:${path}`,
    kind: "file",
    path,
    realPath,
    before: {
      exists: false,
      resolvedPath: realPath,
      realPath: null,
      symbolicLink: false,
      linkTarget: null,
      mode: null,
      pathIdentity: null,
      targetIdentity: null,
      parentIdentity: `${parentStat.dev}:${parentStat.ino}`,
      parentPath: parent,
    },
    after: {
      exists: true,
      resolvedPath: realPath,
      realPath,
      symbolicLink: false,
      linkTarget: null,
      mode: 0o600,
      pathIdentity: null,
      targetIdentity: null,
      parentIdentity: null,
      parentPath: null,
      bytes: "Y29udGVudA==",
    },
    metadata: { created: true, createdDir: false, requestedMode: null },
  };
}

function gateOptions(paths: OperationPaths) {
  return {
    paths,
    t: EN,
    dryRun: false,
    auto: true,
    ui: palette("never", {}, false),
    out: () => {},
  };
}

test("one shared operation owner is exclusive and releases only its lock", () => {
  const { root, paths } = temporaryPaths();
  try {
    const first = acquireOperation(paths, "mutation");
    assert.equal(JSON.parse(readFileSync(join(paths.operationsLock, "owner.json"), "utf8")).kind, "mutation");
    assert.throws(() => acquireOperation(paths, "install"), (error: unknown) => {
      return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "busy";
    });
    releaseOperation(first);
    assert.equal(existsSync(paths.operationsLock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operation setup refuses symlinked state and operations directories", () => {
  const { root, paths } = temporaryPaths();
  const outside = mkdtempSync(join(tmpdir(), "tonedial-operations-outside-"));
  try {
    const linkedRoot = join(root, "state");
    symlinkSync(outside, linkedRoot);
    assert.throws(
      () => acquireOperation({ root: linkedRoot, operations: join(linkedRoot, "operations"), operationsLock: join(linkedRoot, "operations.lock") }, "mutation"),
      /safe state root/,
    );

    const linkedOperations = join(root, "linked-operations");
    symlinkSync(outside, linkedOperations);
    assert.throws(
      () => acquireOperation({ ...paths, operations: linkedOperations, operationsLock: join(linkedOperations, "operations.lock") }, "mutation"),
      /safe operations/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("mutation journals checkpoint actions and remain inspectable after completion", () => {
  const { root, paths } = temporaryPaths();
  try {
    const handle = acquireOperation(paths, "mutation");
    const record = beginJournal(handle, [action(join(root, "target"))]);
    assert.equal(record.state, "pending");
    const checkpoint = checkpointJournal(handle, [0]);
    assert.deepEqual(checkpoint.completed, [0]);
    finishJournal(handle, "complete");
    releaseOperation(handle);

    const inspected = inspectOperations(paths);
    assert.equal(inspected.lock.state, "none");
    assert.equal(inspected.journals.length, 1);
    assert.equal(inspected.journals[0]!.state, "complete");
    assert.deepEqual(readJournal(paths, handle.owner.operationId)?.completed, [0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit rollback claims a dead mutation owner and leaves a rolled-back journal", () => {
  const { root, paths } = temporaryPaths();
  try {
    const handle = acquireOperation(paths, "mutation");
    beginJournal(handle, [action(join(root, "target"))]);
    const owner = JSON.parse(readFileSync(join(paths.operationsLock, "owner.json"), "utf8")) as Record<string, unknown>;
    owner.pid = 2_147_483_000;
    writeFileSync(join(paths.operationsLock, "owner.json"), `${JSON.stringify(owner)}\n`);

    let called = false;
    rollbackOperation(paths, handle.owner.operationId, (journal, recovery) => {
      called = true;
      assert.equal(journal.state, "pending");
      assert.equal(recovery.operation.owner.operationId, handle.owner.operationId);
      assert.equal(lstatSync(join(paths.operationsLock, "recovery")).isDirectory(), true);
    });
    assert.equal(called, true);
    assert.equal(existsSync(paths.operationsLock), false);
    assert.equal(readJournal(paths, handle.owner.operationId)?.state, "rolled-back");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gated file mutation journals the completed after-state and keeps the lock-free success path", async () => {
  const { root, paths } = temporaryPaths();
  try {
    const target = join(root, "target.md");
    writeFileSync(target, "before\n");
    const result = await gate([planChange(target, () => "after\n", EN)], gateOptions(paths));
    assert.equal(result.applied, true);
    assert.equal(result.operationId?.length, 32);
    assert.equal(readFileSync(target, "utf8"), "after\n");
    assert.equal(existsSync(paths.operationsLock), false);
    const journals = inspectOperations(paths).journals;
    assert.equal(journals.length, 1);
    assert.equal(journals[0]!.state, "complete");
    assert.deepEqual(journals[0]!.journal?.completed, [0]);
    assert.equal((journals[0]!.journal?.actions[0]!.after as { bytes?: string }).bytes !== undefined, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retained migration previews without writes and rolls back only by explicit selection", async () => {
  const { root, paths } = temporaryPaths();
  try {
    const target = join(root, "migration.md");
    writeFileSync(target, "before\n");
    const result = await gate([planChange(target, () => "after\n", EN)], {
      ...gateOptions(paths),
      retention: { kind: "migration", reason: "case" },
    });
    const operationId = result.operationId!;
    const preview = previewRollback(paths, operationId, EN);
    assert.equal(preview.status, "ready");
    assert.equal(preview.actions[0]!.status, "applied");
    assert.equal(readFileSync(target, "utf8"), "after\n");
    assert.equal(existsSync(paths.operationsLock), false);

    const applied = applyRollback(paths, operationId, EN);
    assert.deepEqual(applied, { operationId, state: "rolled-back", restored: 1, alreadyReverted: 0, unresolved: [] });
    assert.equal(readFileSync(target, "utf8"), "before\n");
    assert.equal(inspectOperations(paths).journals[0]!.state, "rolled-back");
    assert.equal(existsSync(paths.operationsLock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback refuses unknown lock entries before restoring any target", async () => {
  const { root, paths } = temporaryPaths();
  try {
    const target = join(root, "migration.md");
    writeFileSync(target, "before\n");
    const applied = await gate([planChange(target, () => "after\n", EN)], {
      ...gateOptions(paths), retention: { kind: "migration", reason: "delivery" },
    });
    assert.ok(applied.operationId);
    const handle = acquireOperation(paths, "mutation", applied.operationId);
    writeFileSync(join(handle.lock, "owner.json"), JSON.stringify({ ...handle.owner, pid: 2_147_483_000 }));
    const foreign = join(handle.lock, "foreign.txt");
    writeFileSync(foreign, "keep this\n");
    const journalBefore = readJournal(paths, applied.operationId);
    assert.throws(() => applyRollback(paths, applied.operationId!, EN), /unknown recovery files/);
    assert.equal(readFileSync(target, "utf8"), "after\n", "rollback wrote before refusing the foreign lock entry");
    assert.equal(readFileSync(foreign, "utf8"), "keep this\n");
    assert.deepEqual(readJournal(paths, applied.operationId), journalBefore);
    assert.equal(existsSync(join(handle.lock, "recovery")), false);
    assert.equal(previewRollback(paths, applied.operationId, EN).status, "unresolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback rechecks foreign lock entries introduced while claiming recovery", async () => {
  const { root, paths } = temporaryPaths();
  let fault: ReturnType<typeof mock.method<typeof fs, "renameSync">> | undefined;
  try {
    const target = join(root, "migration.md");
    writeFileSync(target, "before\n");
    const applied = await gate([planChange(target, () => "after\n", EN)], {
      ...gateOptions(paths), retention: { kind: "migration", reason: "delivery" },
    });
    const journalBefore = readJournal(paths, applied.operationId!);
    const lease = join(paths.operationsLock, "recovery", "lease.json");
    const foreign = join(paths.operationsLock, "foreign.txt");
    const rename = fs.renameSync;
    fault = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      const result = rename(from, to);
      if (String(to) === lease) writeFileSync(foreign, "keep this\n");
      return result;
    });
    syncBuiltinESMExports();

    assert.throws(() => applyRollback(paths, applied.operationId!, EN), /unknown recovery files/);
    assert.equal(readFileSync(target, "utf8"), "after\n");
    assert.deepEqual(readJournal(paths, applied.operationId!), journalBefore);
    assert.equal(readFileSync(foreign, "utf8"), "keep this\n");
    assert.equal(existsSync(lease), true, "the claimed recovery remains visible for manual resolution");
    assert.equal(previewRollback(paths, applied.operationId!, EN).status, "unresolved");
  } finally {
    fault?.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary completed setup is not an implicit rollback backup and newer migrations supersede older ones", async () => {
  const { root, paths } = temporaryPaths();
  try {
    const ordinary = join(root, "ordinary.md");
    writeFileSync(ordinary, "before\n");
    const ordinaryResult = await gate([planChange(ordinary, () => "after\n", EN)], gateOptions(paths));
    const ordinaryPreview = previewRollback(paths, ordinaryResult.operationId!, EN);
    assert.equal(ordinaryPreview.status, "unresolved");
    assert.throws(() => applyRollback(paths, ordinaryResult.operationId!, EN), /not a retained migration/);

    const first = join(root, "migration.md");
    writeFileSync(first, "one\n");
    const firstResult = await gate([planChange(first, () => "two\n", EN)], {
      ...gateOptions(paths),
      retention: { kind: "migration", reason: "delivery" },
    });
    const secondResult = await gate([planChange(first, () => "three\n", EN)], {
      ...gateOptions(paths),
      retention: { kind: "migration", reason: "schema" },
    });
    assert.equal(previewRollback(paths, firstResult.operationId!, EN).status, "superseded");
    assert.equal(previewRollback(paths, secondResult.operationId!, EN).status, "ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gate journals actions before final ownership changes and exposes their receipt", async () => {
  const { root, paths } = temporaryPaths();
  try {
    const tone = join(root, "tone.md");
    const skill = join(root, "skill-link");
    const config = join(root, "config.json");
    const skillAction: PlannedOperationAction = {
      action: {
        id: "skill-link",
        kind: "skill-link",
        path: skill,
        realPath: skill,
        before: { linked: false },
        after: { linked: true },
      },
      apply: () => writeFileSync(skill, "linked\n"),
    };
    const result = await gate(
      [planChange(tone, () => "tone\n", EN, undefined, root)],
      {
        ...gateOptions(paths),
        operationActions: [skillAction],
        finalChanges: [planChange(config, () => "{}\n", EN, undefined, root)],
      },
    );
    assert.deepEqual(result.diff.map((entry) => [entry.path, entry.kind ?? "file"]), [
      [tone, "file"],
      [skill, "skill-link"],
      [config, "file"],
    ]);
    assert.equal(readFileSync(skill, "utf8"), "linked\n");
    assert.equal(readFileSync(config, "utf8"), "{}\n");
    const journal = inspectOperations(paths).journals[0]!.journal;
    assert.deepEqual(journal?.completed, [0, 1, 2]);
    assert.equal(journal?.state, "complete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed gated action retains the owner and precise pending checkpoint", async () => {
  const { root, paths } = temporaryPaths();
  try {
    const target = join(root, "target.md");
    writeFileSync(target, "before\n");
    const failed: PlannedOperationAction = {
      action: action(join(root, "skill-link")),
      apply: () => { throw new Error("injected action failure"); },
    };
    await assert.rejects(
      () => gate([planChange(target, () => "after\n", EN)], { ...gateOptions(paths), operationActions: [failed] }),
      /injected action failure/,
    );
    assert.equal(readFileSync(target, "utf8"), "after\n");
    const inspected = inspectOperations(paths);
    assert.notEqual(inspected.lock.state, "none");
    assert.equal(inspected.journals.length, 1);
    assert.equal(inspected.journals[0]!.state, "pending");
    assert.deepEqual(inspected.journals[0]!.journal?.completed, [0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback retries a dead recovery lease without breaking owner-only release", async () => {
  const { root, paths } = temporaryPaths();
  try {
    const target = join(root, "target.md");
    writeFileSync(target, "before\n");
    const failed: PlannedOperationAction = {
      action: action(join(root, "later.md")),
      apply: () => { throw new Error("injected action failure"); },
    };
    await assert.rejects(
      () => gate([planChange(target, () => "after\n", EN)], { ...gateOptions(paths), operationActions: [failed] }),
      /injected action failure/,
    );
    const pending = inspectOperations(paths).journals[0]!.journal!;
    const ownerPath = join(paths.operationsLock, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
    owner.pid = 2_147_483_000;
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
    const recovery = join(paths.operationsLock, "recovery");
    mkdirSync(recovery);
    writeFileSync(join(recovery, "lease.json"), JSON.stringify({
      schema: 1,
      operationId: pending.operationId,
      nonce: "c".repeat(32),
      pid: 2_147_483_000,
      startedAt: new Date(0).toISOString(),
    }));

    const preview = previewRollback(paths, pending.operationId, EN);
    assert.equal(preview.status, "ready");
    const applied = applyRollback(paths, pending.operationId, EN);
    assert.equal(applied.state, "rolled-back");
    assert.equal(readFileSync(target, "utf8"), "before\n");
    assert.equal(existsSync(paths.operationsLock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback dispatches a linked skill action and a file action through one journal", async () => {
  const { root, paths } = temporaryPaths();
  try {
    const source = join(root, "skill-source");
    mkdirSync(source);
    writeFileSync(join(source, "SKILL.md"), "skill\n");
    const destination = join(root, "skills", "tonedial");
    const wiring: WiringV2 = { registrations: {}, resources: {} };
    const plan = planSkillInstall(
      destination,
      source,
      wiring,
      { mode: "link", files: {}, boundary: root },
      EN,
    );
    assert.ok(plan.action);
    const target = join(root, "target.md");
    writeFileSync(target, "before\n");
    const failed: PlannedOperationAction = {
      action: action(join(root, "later.md")),
      apply: () => { throw new Error("stop after skill"); },
    };
    await assert.rejects(
      () => gate([planChange(target, () => "after\n", EN)], { ...gateOptions(paths), operationActions: [plan.action!, failed] }),
      /stop after skill/,
    );
    assert.equal(lstatSync(destination).isSymbolicLink(), true);
    const pending = inspectOperations(paths).journals[0]!.journal!;
    const ownerPath = join(paths.operationsLock, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
    owner.pid = 2_147_483_000;
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);

    const preview = previewRollback(paths, pending.operationId, EN);
    assert.equal(preview.status, "ready");
    assert.deepEqual(preview.actions.filter((entry) => entry.status === "applied").map((entry) => entry.kind), ["file", "skill"]);
    const applied = applyRollback(paths, pending.operationId, EN);
    assert.equal(applied.state, "rolled-back");
    assert.equal(existsSync(destination), false);
    assert.equal(readFileSync(target, "utf8"), "before\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed rollback targets remain unresolved and untouched", async () => {
  const { root, paths } = temporaryPaths();
  try {
    const target = join(root, "target.md");
    writeFileSync(target, "before\n");
    const failed: PlannedOperationAction = {
      action: action(join(root, "later.md")),
      apply: () => { throw new Error("stop"); },
    };
    await assert.rejects(
      () => gate([planChange(target, () => "after\n", EN)], { ...gateOptions(paths), operationActions: [failed] }),
      /stop/,
    );
    writeFileSync(target, "foreign\n");
    const pending = inspectOperations(paths).journals[0]!.journal!;
    const ownerPath = join(paths.operationsLock, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
    owner.pid = 2_147_483_000;
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
    const preview = previewRollback(paths, pending.operationId, EN);
    assert.equal(preview.status, "unresolved");
    assert.equal(preview.actions[0]!.status, "changed");
    const result = applyRollback(paths, pending.operationId, EN);
    assert.equal(result.state, "pending");
    assert.equal(readFileSync(target, "utf8"), "foreign\n");
    assert.ok(result.unresolved.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback restores a deletion that landed before its completion checkpoint", async () => {
  const { root, paths } = temporaryPaths();
  const target = join(root, "removed.md");
  const originalRemove = fs.rmSync;
  try {
    writeFileSync(target, "original document\n");
    const change = planChange(target, () => null, EN);
    const fault = mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmOptions) => {
      originalRemove(path, options);
      if (path === change.realPath) throw new Error("injected interruption after deletion");
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => gate([change], gateOptions(paths)), /injected interruption after deletion/);
    } finally {
      fault.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(existsSync(target), false, "the deletion actually landed");
    const pending = inspectOperations(paths).journals[0]!.journal!;
    assert.deepEqual(pending.completed, [], "no completion checkpoint landed");
    const ownerPath = join(paths.operationsLock, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    owner.pid = 2_147_483_000;
    writeFileSync(ownerPath, JSON.stringify(owner));
    const preview = previewRollback(paths, pending.operationId, EN);
    assert.equal(preview.status, "ready");
    assert.equal(preview.actions[0]!.status, "applied");
    const restored = applyRollback(paths, pending.operationId, EN);
    assert.equal(restored.state, "rolled-back");
    assert.equal(readFileSync(target, "utf8"), "original document\n");
    assert.equal(restored.restored, 1);
    assert.equal(existsSync(paths.operationsLock), false);
  } finally {
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("file recovery restores checkpointed writes only after claiming the dead owner", async () => {
  const { root, paths } = temporaryPaths();
  try {
    const target = join(root, "target.md");
    writeFileSync(target, "before\n");
    const failed: PlannedOperationAction = {
      action: action(join(root, "skill-link")),
      apply: () => { throw new Error("injected action failure"); },
    };
    await assert.rejects(
      () => gate([planChange(target, () => "after\n", EN)], { ...gateOptions(paths), operationActions: [failed] }),
      /injected action failure/,
    );
    const pending = inspectOperations(paths).journals[0]!.journal!;
    const ownerPath = join(paths.operationsLock, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
    owner.pid = 2_147_483_000;
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);

    applyRollback(paths, pending.operationId, EN);
    assert.equal(readFileSync(target, "utf8"), "before\n");
    assert.equal(existsSync(paths.operationsLock), false);
    assert.equal(inspectOperations(paths).journals[0]!.state, "rolled-back");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a first-run create is not stale merely because lock setup created the state root", async () => {
  const { root } = temporaryPaths();
  const state = join(root, "state");
  const statePaths: OperationPaths = {
    root: state,
    operations: join(state, "operations"),
    operationsLock: join(state, "operations.lock"),
  };
  try {
    const target = join(state, "tone.md");
    const result = await gate([planChange(target, () => "tone\n", EN, undefined, state)], gateOptions(statePaths));
    assert.equal(result.applied, true);
    assert.equal(readFileSync(target, "utf8"), "tone\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replaced nearest parent is stale even when the new parent has the same path", async () => {
  const { root, paths } = temporaryPaths();
  try {
    const parent = join(root, "nested");
    mkdirSync(parent);
    const target = join(parent, "created.md");
    const change = planChange(target, () => "new\n", EN);
    await assert.rejects(
      () => gate([change], {
        ...gateOptions(paths),
        auto: false,
        interactive: () => true,
        ask: async () => {
          renameSync(parent, join(root, "retained-parent"));
          mkdirSync(parent);
          return "yes";
        },
      }),
      /changed after the diff was prepared/,
    );
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(paths.operationsLock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
