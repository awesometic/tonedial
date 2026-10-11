import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { catalogue } from "../src/core/i18n.ts";
import { inspectOperations, type OperationPaths } from "../src/core/operations.ts";
import { applyRollback, gate, planChange, previewRollback } from "../src/wiring/apply.ts";
import { palette } from "../src/ui/style.ts";

const EN = catalogue("en").cli;

test("rollback preserves a foreign directory swapped in at the file deletion boundary", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "tonedial-file-swap-")));
  const paths: OperationPaths = { root, operations: join(root, "operations"), operationsLock: join(root, "operations.lock") };
  const target = join(root, "created.md");
  const sentinel = join(target, "user-file.txt");
  const originalRemove = fs.rmSync;
  try {
    const result = await gate([planChange(target, () => "generated\n", EN)], {
      paths, t: EN, auto: true, dryRun: false, ui: palette("never", {}, false), out: () => {},
      retention: { kind: "migration", reason: "delivery" },
    });
    assert.equal(previewRollback(paths, result.operationId!, EN).status, "ready");
    const removal = mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmOptions) => {
      if (path === target) {
        fs.unlinkSync(target);
        fs.mkdirSync(target);
        fs.writeFileSync(sentinel, "foreign contents\n");
      }
      originalRemove(path, options);
    });
    syncBuiltinESMExports();
    let recovered;
    try {
      recovered = applyRollback(paths, result.operationId!, EN);
    } finally {
      removal.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(fs.readFileSync(sentinel, "utf8"), "foreign contents\n");
    assert.equal(recovered.state, "pending");
    assert.equal(inspectOperations(paths).journals[0]!.state, "complete", "the retained migration is not marked rolled back");
    assert.equal(fs.existsSync(paths.operationsLock), true);
  } finally {
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
    originalRemove(root, { recursive: true, force: true });
  }
});

for (const scenario of ["restore", "foreign-link", "interrupted-restore"] as const) {
  test(`deleted file symlink recovery preserves its referent: ${scenario}`, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "tonedial-file-recovery-")));
    const paths: OperationPaths = { root, operations: join(root, "operations"), operationsLock: join(root, "operations.lock") };
    const referent = join(root, "user-document.md");
    const link = join(root, "entry.md");
    const originalRemove = fs.rmSync;
    const originalSymlink = fs.symlinkSync;
    const originalRename = fs.renameSync;
    try {
      fs.writeFileSync(referent, "user-owned document\n", { mode: 0o640 });
      fs.symlinkSync("user-document.md", link);
      const referentBefore = fs.statSync(referent, { bigint: true });
      const foreign = join(root, "foreign-entry.md");
      if (scenario === "foreign-link") {
        fs.symlinkSync("user-document.md", foreign);
        assert.notEqual(fs.lstatSync(foreign, { bigint: true }).ino, fs.lstatSync(link, { bigint: true }).ino);
      }
      const change = planChange(link, () => null, EN);
      const removal = mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmOptions) => {
        originalRemove(path, options);
        if (path === link) throw new Error("interrupted after unlink");
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(() => gate([change], {
          paths, t: EN, auto: true, dryRun: false, ui: palette("never", {}, false), out: () => {},
        }), /interrupted after unlink/);
      } finally {
        removal.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(fs.existsSync(link), false);
      assert.equal(fs.readFileSync(referent, "utf8"), "user-owned document\n");
      assert.equal(fs.statSync(referent, { bigint: true }).ino, referentBefore.ino);
      const pending = inspectOperations(paths).journals[0]!.journal!;
      assert.deepEqual(pending.completed, [], "unlink preceded its checkpoint");
      const ownerPath = join(paths.operationsLock, "owner.json");
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      owner.pid = 2_147_483_000;
      fs.writeFileSync(ownerPath, JSON.stringify(owner));

      if (scenario === "foreign-link") originalRename(foreign, link);
      if (scenario === "interrupted-restore") {
        const restoration = mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
          originalRename(...args);
          if (args[1] === link) throw new Error("interrupted after recreating link");
        });
        syncBuiltinESMExports();
        try {
          assert.equal(applyRollback(paths, pending.operationId, EN).state, "pending");
        } finally {
          restoration.mock.restore();
          syncBuiltinESMExports();
        }
        const leasePath = join(paths.operationsLock, "recovery", "lease.json");
        const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
        lease.pid = 2_147_483_000;
        fs.writeFileSync(leasePath, JSON.stringify(lease));
      }

      const replacement = fs.lstatSync(link, { bigint: true, throwIfNoEntry: false });
      const preview = previewRollback(paths, pending.operationId, EN);
      const result = applyRollback(paths, pending.operationId, EN);
      if (scenario !== "foreign-link") {
        assert.equal(preview.status, "ready");
        assert.equal(result.state, "rolled-back");
        assert.equal(result.restored + result.alreadyReverted, 1);
        assert.equal(fs.existsSync(paths.operationsLock), false);
      } else {
        assert.equal(preview.status, "unresolved");
        assert.equal(result.state, "pending");
        assert.equal(fs.lstatSync(link, { bigint: true }).ino, replacement!.ino);
        assert.equal(inspectOperations(paths).journals[0]!.state, "pending");
      }
      assert.equal(fs.readlinkSync(link), "user-document.md");
      assert.equal(fs.readFileSync(referent, "utf8"), "user-owned document\n");
      const referentAfter = fs.statSync(referent, { bigint: true });
      assert.equal(referentAfter.ino, referentBefore.ino);
      assert.equal(referentAfter.mode, referentBefore.mode);
      assert.equal(referentAfter.mtimeNs, referentBefore.mtimeNs);
    } finally {
      fs.rmSync = originalRemove;
      fs.symlinkSync = originalSymlink;
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
      originalRemove(root, { recursive: true, force: true });
    }
  });
}
