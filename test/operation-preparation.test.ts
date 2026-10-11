import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mock, test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { catalogue } from "../src/core/i18n.ts";
import {
  acquireOperation,
  beginJournal,
  inspectOperations,
  inspectRollback,
  readJournal,
  releaseOperation,
  rollbackOperation,
  type OperationAction,
  type OperationPaths,
} from "../src/core/operations.ts";
import { gate, planChange } from "../src/wiring/apply.ts";
import { palette } from "../src/ui/style.ts";

const EN = catalogue("en").cli;

function temporaryPaths(): { root: string; paths: OperationPaths } {
  const root = mkdtempSync(join(tmpdir(), "tonedial-operation-preparation-"));
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
  return {
    id: `file:${path}`,
    kind: "file",
    path,
    realPath: path,
    before: { exists: false },
    after: { exists: true },
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

test("a killed process leaves a preparing owner that explicit rollback can safely release", () => {
  const { root, paths } = temporaryPaths();
  try {
    const script = `
      import { acquireOperation } from ${JSON.stringify(new URL("../src/core/operations.ts", import.meta.url).href)};
      acquireOperation(${JSON.stringify(paths)}, "mutation");
      process.kill(process.pid, "SIGKILL");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
        HOME: root,
        TMPDIR: root,
      },
    });
    assert.equal(result.signal, "SIGKILL", result.error?.message ?? result.stderr);

    const inspected = inspectOperations(paths);
    assert.equal(inspected.lock.state, "dead");
    assert.equal(inspected.journals.length, 1);
    const pending = inspected.journals[0]!;
    assert.equal(pending.state, "pending");
    assert.equal(pending.journal?.actions.length, 0);
    assert.equal(inspectRollback(paths, pending.operationId).synthetic, true);

    let callbackJournal: OperationAction[] | undefined;
    rollbackOperation(paths, pending.operationId, (journal) => {
      callbackJournal = journal.actions;
    });
    assert.deepEqual(callbackJournal, []);
    assert.equal(existsSync(paths.operationsLock), false);
    assert.equal(readJournal(paths, pending.operationId)?.state, "rolled-back");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live and ambiguous preparing owners remain locked", () => {
  const { root, paths } = temporaryPaths();
  try {
    const handle = acquireOperation(paths, "mutation");
    assert.throws(
      () => rollbackOperation(paths, handle.owner.operationId, () => {}),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "busy",
    );

    const fault = mock.method(process, "kill", () => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    try {
      assert.throws(
        () => rollbackOperation(paths, handle.owner.operationId, () => {}),
        (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "busy",
      );
    } finally {
      fault.mock.restore();
    }

    assert.equal(existsSync(paths.operationsLock), true);
    releaseOperation(handle);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pending journal survives beginJournal seal failure and gate cleanup", async () => {
  const { root, paths } = temporaryPaths();
  const target = join(root, "target.md");
  writeFileSync(target, "before\n");
  const ownerPath = join(paths.operationsLock, "owner.json");
  const originalRename = fs.renameSync;
  let failed = false;
  let ownerRenames = 0;
  const fault = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === ownerPath && String(from).startsWith(`${ownerPath}.tmp-`)) ownerRenames += 1;
    if (!failed && ownerRenames === 2) {
      failed = true;
      const error = new Error("injected owner seal failure") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => gate([planChange(target, () => "after\n", EN)], gateOptions(paths)),
      /could not seal its journal owner/,
    );
    assert.equal(failed, true);
    assert.equal(readFileSync(target, "utf8"), "before\n");
    assert.equal(existsSync(paths.operationsLock), true);
    assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).phase, "preparing");
    const inspected = inspectOperations(paths);
    assert.equal(inspected.journals.length, 1);
    assert.equal(inspected.journals[0]!.state, "pending");
    assert.equal(inspected.journals[0]!.journal?.actions.length, 1);
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a journal removed after target writes is not treated as owner-only preparation", () => {
  const { root, paths } = temporaryPaths();
  try {
    const target = join(root, "target.md");
    const handle = acquireOperation(paths, "mutation");
    const journal = beginJournal(handle, [action(target)]);
    writeFileSync(target, "landed\n");
    unlinkSync(join(paths.operations, `${journal.operationId}.json`));

    const ownerPath = join(paths.operationsLock, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
    owner.pid = 2_147_483_000;
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);

    const inspected = inspectOperations(paths);
    assert.equal(inspected.lock.state, "dead");
    assert.deepEqual(inspected.journals.map(({ operationId, state }) => ({ operationId, state })), [
      { operationId: journal.operationId, state: "invalid" },
    ]);
    assert.throws(() => inspectRollback(paths, journal.operationId), /not found or is invalid/);
    assert.throws(() => rollbackOperation(paths, journal.operationId, () => {}), /not found or is invalid/);
    assert.equal(readFileSync(target, "utf8"), "landed\n");
    assert.equal(lstatSync(paths.operationsLock).isDirectory(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a journaled owner with a missing journal remains locked", () => {
  const { root, paths } = temporaryPaths();
  try {
    const handle = acquireOperation(paths, "mutation");
    const journal = beginJournal(handle, [action(join(root, "target.md"))]);
    unlinkSync(join(paths.operations, `${journal.operationId}.json`));

    assert.equal(handle.owner.phase, "journaled");
    assert.throws(
      () => releaseOperation(handle),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "needs-recovery",
    );
    assert.equal(existsSync(paths.operationsLock), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery rejects a journal replaced at lease claim before touching targets", () => {
  const { root, paths } = temporaryPaths();
  const target = join(root, "target.md");
  writeFileSync(target, "before\n");
  let fault: ReturnType<typeof mock.method<typeof fs, "renameSync">> | undefined;
  try {
    const handle = acquireOperation(paths, "mutation");
    const journal = beginJournal(handle, [action(target)]);
    const ownerPath = join(paths.operationsLock, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
    owner.pid = 2_147_483_000;
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);

    const journalPath = join(paths.operations, `${journal.operationId}.json`);
    const leasePath = join(paths.operationsLock, "recovery", "lease.json");
    const originalRename = fs.renameSync;
    let replaced = false;
    fault = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      const result = originalRename(from, to);
      if (!replaced && String(to) === leasePath) {
        replaced = true;
        const current = JSON.parse(readFileSync(journalPath, "utf8")) as { actions: OperationAction[] };
        current.actions = [...current.actions, action(join(root, "replacement.md"))];
        writeFileSync(journalPath, `${JSON.stringify(current)}\n`);
      }
      return result;
    });
    syncBuiltinESMExports();

    let callbackCalled = false;
    assert.throws(
      () => rollbackOperation(paths, journal.operationId, () => {
        callbackCalled = true;
      }),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ownership-changed",
    );
    assert.equal(replaced, true);
    assert.equal(callbackCalled, false);
    assert.equal(readFileSync(target, "utf8"), "before\n");
    assert.equal(existsSync(paths.operationsLock), true);
    assert.equal(existsSync(leasePath), true);
  } finally {
    fault?.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
