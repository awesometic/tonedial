import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { catalogue } from "../src/core/i18n.ts";
import type { OperationAction, OperationPaths, JsonValue } from "../src/core/operations.ts";
import { applyRollback, gate, planChange, previewRollback, type PlannedOperationAction } from "../src/wiring/apply.ts";
import { emptyWiring } from "../src/wiring/ownership.ts";
import { planSkillInstall } from "../src/wiring/skill.ts";
import { palette } from "../src/ui/style.ts";

const EN = catalogue("en").cli;

function operationPaths(root: string): OperationPaths {
  return { root, operations: join(root, "operations"), operationsLock: join(root, "operations.lock") };
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

function invalidFileAction(path: string, realPath: string): PlannedOperationAction {
  const parent = dirname(path);
  const action: OperationAction = {
    id: `file:${path}`,
    kind: "file",
    path,
    realPath,
    before: {
      exists: false,
      resolvedPath: path,
      realPath: null,
      symbolicLink: false,
      linkTarget: null,
      mode: null,
      pathIdentity: null,
      targetIdentity: null,
      parentIdentity: "1:1",
      parentPath: parent,
    },
    after: {
      exists: true,
      resolvedPath: path,
      realPath: path,
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
  return {
    action,
    apply: () => { throw new Error("injected malformed later action"); },
  };
}

function retireOwner(paths: OperationPaths): void {
  const ownerPath = join(paths.operationsLock, "owner.json");
  const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, JsonValue>;
  owner.pid = 2_147_483_000;
  writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
}

function countLstatFor(path: string): { count: () => number; restore: () => void } {
  let reads = 0;
  const original = fs.lstatSync;
  const replacement = mock.method(fs, "lstatSync", (candidate: fs.PathLike, options?: fs.StatSyncOptions) => {
    if (String(candidate) === path) reads++;
    return original(candidate, options);
  });
  syncBuiltinESMExports();
  return {
    count: () => reads,
    restore: () => {
      replacement.mock.restore();
      syncBuiltinESMExports();
    },
  };
}

function plannedCreateAction(path: string): PlannedOperationAction {
  const parent = dirname(path);
  const realPath = join(fs.realpathSync(parent), basename(path));
  const parentStat = fs.statSync(parent, { bigint: true });
  const parentIdentity = String(parentStat.dev) + ":" + String(parentStat.ino);
  const action: OperationAction = {
    id: "file:planned-create:" + path,
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
      parentIdentity,
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
      parentIdentity,
      parentPath: parent,
      bytes: "Y3JlYXRlZAo=",
    },
    metadata: { created: true, createdDir: false, requestedMode: null },
  };
  return {
    action,
    apply: () => { throw new Error("injected before create"); },
  };
}

test("a malformed later file action is rejected before earlier resource probes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tonedial-journal-file-semantics-"));
  const paths = operationPaths(root);
  const target = join(root, "first.md");
  const later = join(root, "later.md");
  try {
    await assert.rejects(
      () => gate([planChange(target, () => "applied\n", EN)], {
        ...gateOptions(paths),
        operationActions: [invalidFileAction(later, join(root, "foreign", "later.md"))],
      }),
      /malformed later action/,
    );
    assert.equal(readFileSync(target, "utf8"), "applied\n");
    const pending = JSON.parse(readFileSync(join(paths.operations, `${JSON.parse(readFileSync(join(paths.operationsLock, "owner.json"), "utf8")).operationId}.json`), "utf8"));
    assert.equal(pending.completed.length, 1);
    retireOwner(paths);

    const observed = countLstatFor(target);
    try {
      const preview = previewRollback(paths, pending.operationId, EN);
      assert.equal(preview.status, "unresolved");
      assert.ok(preview.actions.every((action) => action.status === "unsupported"));
      const result = applyRollback(paths, pending.operationId, EN);
      assert.equal(result.state, "pending");
      assert.equal(result.restored, 0);
      assert.equal(existsSync(paths.operationsLock), true);
      assert.equal(observed.count(), 0);
    } finally {
      observed.restore();
    }
    assert.equal(readFileSync(target, "utf8"), "applied\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed later skill action is rejected before the linked resource is probed", async () => {
  const root = mkdtempSync(join(tmpdir(), "tonedial-journal-skill-semantics-"));
  const paths = operationPaths(root);
  const source = join(root, "source", "tonedial");
  const destination = join(root, ".agents", "skills", "tonedial");
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "skill\n");
    const plan = planSkillInstall(destination, source, emptyWiring(), {
      mode: "link",
      files: {},
      boundary: root,
    }, EN);
    assert.ok(plan.action);
    const metadata = { ...(plan.action.action.metadata as Record<string, JsonValue>), destination: join(root, "foreign", "tonedial") };
    const malformed: PlannedOperationAction = {
      action: { ...plan.action.action, id: `${plan.action.action.id}:malformed`, metadata },
      apply: () => { throw new Error("injected malformed later skill action"); },
    };

    await assert.rejects(
      () => gate([], { ...gateOptions(paths), operationActions: [plan.action!, malformed] }),
      /malformed later skill action/,
    );
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
    const owner = JSON.parse(readFileSync(join(paths.operationsLock, "owner.json"), "utf8")) as { operationId: string };
    const pending = JSON.parse(readFileSync(join(paths.operations, `${owner.operationId}.json`), "utf8"));
    assert.deepEqual(pending.completed, [0]);
    retireOwner(paths);

    const observed = countLstatFor(destination);
    try {
      const preview = previewRollback(paths, pending.operationId, EN);
      assert.equal(preview.status, "unresolved");
      assert.ok(preview.actions.every((action) => action.status === "unsupported"));
      const result = applyRollback(paths, pending.operationId, EN);
      assert.equal(result.state, "pending");
      assert.equal(result.restored, 0);
      assert.equal(existsSync(paths.operationsLock), true);
      assert.equal(observed.count(), 0);
    } finally {
      observed.restore();
    }
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an uncheckpointed planned create is already reverted only while its parent is unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "tonedial-journal-parent-semantics-"));
  const paths = operationPaths(root);
  const parent = join(root, "planned");
  const target = join(parent, "created.md");
  mkdirSync(parent);
  try {
    await assert.rejects(
      () => gate([], { ...gateOptions(paths), operationActions: [plannedCreateAction(target)] }),
      /injected before create/,
    );
    const owner = JSON.parse(readFileSync(join(paths.operationsLock, "owner.json"), "utf8")) as { operationId: string };
    const pending = JSON.parse(readFileSync(join(paths.operations, owner.operationId + ".json"), "utf8"));
    retireOwner(paths);

    const preview = previewRollback(paths, pending.operationId, EN);
    assert.equal(preview.status, "ready");
    assert.equal(preview.actions[0]!.status, "already-reverted");
    const result = applyRollback(paths, pending.operationId, EN);
    assert.deepEqual(result, {
      operationId: pending.operationId,
      state: "rolled-back",
      restored: 0,
      alreadyReverted: 1,
      unresolved: [],
    });
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an uncheckpointed create does not adopt a same-content foreign landing", async () => {
  const root = mkdtempSync(join(tmpdir(), "tonedial-journal-foreign-create-"));
  const paths = operationPaths(root);
  const target = join(root, "created.md");
  try {
    await assert.rejects(
      () => gate([], { ...gateOptions(paths), operationActions: [plannedCreateAction(target)] }),
      /injected before create/,
    );
    const owner = JSON.parse(readFileSync(join(paths.operationsLock, "owner.json"), "utf8")) as { operationId: string };
    const pending = JSON.parse(readFileSync(join(paths.operations, owner.operationId + ".json"), "utf8"));
    writeFileSync(target, "created\n");
    retireOwner(paths);

    const preview = previewRollback(paths, pending.operationId, EN);
    assert.equal(preview.status, "unresolved");
    assert.equal(preview.actions[0]!.status, "changed");
    const result = applyRollback(paths, pending.operationId, EN);
    assert.equal(result.state, "pending");
    assert.equal(result.restored, 0);
    assert.equal(readFileSync(target, "utf8"), "created\n");
    assert.equal(existsSync(paths.operationsLock), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed parent keeps an absent file action unresolved", async () => {
  const root = mkdtempSync(join(tmpdir(), "tonedial-journal-parent-swap-"));
  const paths = operationPaths(root);
  const parent = join(root, "planned");
  const target = join(parent, "created.md");
  try {
    mkdirSync(parent);
    await assert.rejects(
      () => gate([], { ...gateOptions(paths), operationActions: [plannedCreateAction(target)] }),
      /injected before create/,
    );
    const owner = JSON.parse(readFileSync(join(paths.operationsLock, "owner.json"), "utf8")) as { operationId: string };
    const pending = JSON.parse(readFileSync(join(paths.operations, owner.operationId + ".json"), "utf8"));
    renameSync(parent, join(root, "planned-old"));
    mkdirSync(parent);
    retireOwner(paths);

    const preview = previewRollback(paths, pending.operationId, EN);
    assert.equal(preview.status, "unresolved");
    assert.equal(preview.actions[0]!.status, "changed");
    const result = applyRollback(paths, pending.operationId, EN);
    assert.equal(result.state, "pending");
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(paths.operationsLock), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill recovery refuses a tracked file swapped to a foreign symlink during probing", async () => {
  const root = mkdtempSync(join(tmpdir(), "tonedial-journal-skill-swap-"));
  const paths = operationPaths(root);
  const source = join(root, "source", "tonedial");
  const destination = join(root, ".agents", "skills", "tonedial");
  const tracked = join(destination, "SKILL.md");
  const foreign = join(root, "foreign.md");
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "skill\n");
    writeFileSync(foreign, "skill\n");
    const plan = planSkillInstall(destination, source, emptyWiring(), {
      mode: "copy",
      files: { "SKILL.md": "skill\n" },
      boundary: root,
    }, EN);
    assert.ok(plan.action);
    const result = await gate([], {
      ...gateOptions(paths),
      operationActions: [plan.action],
      retention: { kind: "migration", reason: "delivery" },
    });
    assert.ok(result.operationId);
    rmSync(tracked);
    fs.symlinkSync(foreign, tracked);

    const originalLstat = fs.lstatSync;
    let armed = true;
    const replacement = mock.method(fs, "lstatSync", (candidate: fs.PathLike, options?: fs.StatSyncOptions) => {
      const stat = originalLstat(candidate, options);
      if (armed && String(candidate) === tracked) {
        armed = false;
        fs.unlinkSync(tracked);
        fs.symlinkSync(foreign, tracked);
      }
      return stat;
    });
    syncBuiltinESMExports();
    let preview;
    try {
      preview = previewRollback(paths, result.operationId, EN);
    } finally {
      replacement.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(preview.status, "unresolved");
    assert.equal(preview.actions[0]!.status, "changed");
    const recovered = applyRollback(paths, result.operationId, EN);
    assert.equal(recovered.state, "pending");
    assert.equal(fs.readlinkSync(tracked), foreign);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file recovery retains a same-path parent whose identity was never checkpointed", async () => {
  const root = fs.realpathSync(mkdtempSync(join(tmpdir(), "tonedial-journal-parent-retain-")));
  const paths = operationPaths(root);
  const target = join(root, "created-dir", "created.md");
  const parent = dirname(target);
  const originalRemove = fs.rmSync;
  try {
    const change = planChange(target, () => "created\n", EN);
    const applied = await gate([change], {
      ...gateOptions(paths),
      retention: { kind: "migration", reason: "delivery" },
    });
    assert.ok(applied.operationId);
    const replacement = mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmOptions) => {
      originalRemove(path, options);
      if (String(path) === change.realPath) {
        renameSync(parent, join(root, "created-dir-old"));
        mkdirSync(parent);
      }
    });
    syncBuiltinESMExports();
    try {
      const recovered = applyRollback(paths, applied.operationId, EN);
      assert.equal(recovered.state, "rolled-back");
    } finally {
      replacement.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(existsSync(parent), true);
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally {
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
    originalRemove(root, { recursive: true, force: true });
  }
});
