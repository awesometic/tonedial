import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { catalogue } from "../src/core/i18n.ts";
import {
  acquireOperation, beginJournal, inspectOperations, inspectRollback, readJournal,
  retireOperationForAppRebuild, type OperationPaths,
} from "../src/core/operations.ts";
import {
  applyRollback, captureRawEntry, gate, planChange, planEntryRebuild,
  planGeneratedFamilyRebuild, previewRollback, rawReadChange,
} from "../src/wiring/apply.ts";
import { palette } from "../src/ui/style.ts";

const EN = catalogue("en").cli;

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "tonedial-rebuild-files-")));
  const paths: OperationPaths = { root, operations: join(root, "operations"), operationsLock: join(root, "operations.lock") };
  const options = { paths, t: EN, auto: true, dryRun: false, ui: palette("never", {}, false), out: () => {} };
  return { root, paths, options };
}

function deadOwner(paths: OperationPaths) {
  for (const path of [join(paths.operationsLock, "owner.json"), join(paths.operationsLock, "recovery", "lease.json")]) {
    if (!fs.existsSync(path)) continue;
    const value = JSON.parse(fs.readFileSync(path, "utf8"));
    value.pid = 2_147_483_000;
    fs.writeFileSync(path, JSON.stringify(value));
  }
}

test("explicit damaged user-file rebuild retains raw bytes and mode and binds the captured source", async () => {
  const { root, paths, options } = fixture();
  const path = join(root, "config.json");
  const original = Buffer.from([0xff, 0x00, 0xc3, 0x28]);
  try {
    fs.writeFileSync(path, original, { mode: 0o640 });
    const capture = captureRawEntry(path, EN, { within: root });
    assert.throws(() => rawReadChange(capture, EN), /UTF-8/);
    const plan = planEntryRebuild(capture, '{"schema":2}\n', EN, { reason: "restore-config" });
    fs.writeFileSync(path, Buffer.from([0xfe, 0x00]));
    await assert.rejects(() => gate([], { ...options, operationActions: [plan.action] }), /changed|stale/i);
    assert.deepEqual(fs.readFileSync(path), Buffer.from([0xfe, 0x00]));
    assert.equal(fs.existsSync(paths.operationsLock), false);

    fs.writeFileSync(path, original);
    const restored = planEntryRebuild(captureRawEntry(path, EN, { within: root }), '{"schema":2}\n', EN, { reason: "restore-config" });
    const result = await gate([], { ...options, operationActions: [restored.action], retention: { kind: "migration", reason: "app-rebuild" } });
    assert.equal(fs.readFileSync(path, "utf8"), '{"schema":2}\n');
    assert.equal(applyRollback(paths, result.operationId!, EN).state, "rolled-back");
    assert.deepEqual(fs.readFileSync(path), original);
    assert.equal(fs.lstatSync(path).mode & 0o777, 0o640);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("generated lexical links rebuild and roll back without observing their outside referents", async () => {
  const { root, paths, options } = fixture();
  const outside = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "tonedial-rebuild-outside-")));
  const target = join(root, "TONE.md");
  const referent = join(outside, "private.md");
  const originalRead = fs.readFileSync;
  const originalReal = fs.realpathSync;
  const originalStat = fs.statSync;
  const originalOpen = fs.openSync;
  try {
    fs.writeFileSync(referent, "outside-private-value\n");
    const before = fs.lstatSync(referent, { bigint: true });
    fs.symlinkSync(referent, target);
    const faults = [
      mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        assert.notEqual(String(args[0]), referent, "outside referent must never be read");
        return originalRead(...args);
      }),
      mock.method(fs, "realpathSync", (...args: Parameters<typeof fs.realpathSync>) => {
        assert.notEqual(String(args[0]), target, "link must never be resolved");
        return originalReal(...args);
      }),
      mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
        assert.notEqual(String(args[0]), referent, "outside referent must never be statted");
        if (String(args[0]) === target) assert.equal(fs.lstatSync(target).isSymbolicLink(), false, "link must never be statted");
        return originalStat(...args);
      }),
      mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        assert.notEqual(String(args[0]), referent, "outside referent must never be opened");
        if (String(args[0]) === target) assert.equal(fs.lstatSync(target).isSymbolicLink(), false, "link must never be opened");
        return originalOpen(...args);
      }),
    ];
    syncBuiltinESMExports();
    try {
      assert.throws(() => captureRawEntry(target, EN, { within: root }), /changed|stale/i);
      const capture = captureRawEntry(target, EN, { within: root, allowLink: true });
      assert.equal(capture.bytes, null);
      assert.throws(() => planEntryRebuild(capture, "new", EN, { reason: "restore-preset" }), /changed|stale/i);
      const plan = planEntryRebuild(capture, "generated\n", EN, { reason: "generated" });
      const result = await gate([], { ...options, operationActions: [plan.action], retention: { kind: "migration", reason: "app-rebuild" } });
      assert.equal(fs.lstatSync(target).isFile(), true);
      assert.equal(fs.readFileSync(target, "utf8"), "generated\n");
      assert.equal(applyRollback(paths, result.operationId!, EN).state, "rolled-back");
      assert.equal(fs.readlinkSync(target), referent);
    } finally {
      for (const fault of faults) fault.mock.restore();
      syncBuiltinESMExports();
    }
    const after = fs.lstatSync(referent, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(fs.readFileSync(referent, "utf8"), "outside-private-value\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a linked generated family installs only its recipes and restores the original dangling link", async () => {
  const { root, paths, options } = fixture();
  const family = join(root, "skill", "tonedial");
  try {
    fs.mkdirSync(join(root, "skill"));
    fs.symlinkSync("missing-source", family);
    assert.throws(() => captureRawEntry(join(family, "SKILL.md"), EN, { within: root }), /changed|stale/i);
    const plan = planGeneratedFamilyRebuild(captureRawEntry(family, EN, { within: root, allowLink: true }), [
      { relativePath: "SKILL.md", contents: "skill\n" },
      { relativePath: "references/traits.md", contents: "traits\n" },
    ], EN);
    const result = await gate([], { ...options, operationActions: [plan.action], retention: { kind: "migration", reason: "app-rebuild" } });
    assert.equal(fs.readFileSync(join(family, "references", "traits.md"), "utf8"), "traits\n");
    assert.equal(applyRollback(paths, result.operationId!, EN).state, "rolled-back");
    assert.equal(fs.readlinkSync(family), "missing-source");
    assert.equal(fs.existsSync(join(root, "skill", "missing-source")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const interruption of ["archive", "publish"] as const) {
  test(`raw generated rebuild rolls back an interruption after ${interruption}`, async () => {
    const { root, paths, options } = fixture();
    const target = join(root, "TONE.md");
    const bytes = Buffer.from([0xff, 0x00, 0x80]);
    const originalRename = fs.renameSync;
    try {
      fs.writeFileSync(target, bytes, { mode: 0o640 });
      const before = fs.lstatSync(target, { bigint: true });
      const plan = planEntryRebuild(captureRawEntry(target, EN, { within: root }), "generated\n", EN, { reason: "generated" });
      const fault = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        originalRename(from, to);
        if ((interruption === "archive" && String(from) === target) || (interruption === "publish" && String(to) === target)) {
          throw new Error("interrupted generated rebuild");
        }
      });
      syncBuiltinESMExports();
      try { await assert.rejects(() => gate([], { ...options, operationActions: [plan.action] }), /interrupted/); }
      finally { fault.mock.restore(); syncBuiltinESMExports(); }
      const pending = inspectOperations(paths).journals[0]!.journal!;
      deadOwner(paths);
      assert.equal(previewRollback(paths, pending.operationId, EN).status, "ready");
      assert.equal(applyRollback(paths, pending.operationId, EN).state, "rolled-back");
      assert.deepEqual(fs.readFileSync(target), bytes);
      assert.equal(fs.lstatSync(target, { bigint: true }).ino, before.ino);
      assert.equal(fs.lstatSync(target).mode & 0o777, 0o640);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

for (const foreign of [false, true]) {
  test(`regular publication records its witness before a lost completion checkpoint: foreign=${foreign}`, async () => {
    const { root, paths, options } = fixture();
    const target = join(root, "regular.md");
    const originalRename = fs.renameSync;
    try {
      fs.writeFileSync(target, "before\n", { mode: 0o640 });
      const fault = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        originalRename(from, to);
        if (String(to) === target) {
          if (foreign) {
            fs.writeFileSync(join(root, "foreign.md"), "after\n", { mode: 0o640 });
            originalRename(join(root, "foreign.md"), target);
          }
          throw new Error("interrupted after publication");
        }
      });
      syncBuiltinESMExports();
      try { await assert.rejects(() => gate([planChange(target, () => "after\n", EN)], options), /interrupted/); }
      finally { fault.mock.restore(); syncBuiltinESMExports(); }
      const pending = inspectOperations(paths).journals[0]!.journal!;
      assert.deepEqual(pending.completed, []);
      deadOwner(paths);
      if (foreign) {
        const inode = fs.lstatSync(target, { bigint: true }).ino;
        assert.equal(previewRollback(paths, pending.operationId, EN).status, "unresolved");
        assert.equal(applyRollback(paths, pending.operationId, EN).state, "pending");
        assert.equal(fs.lstatSync(target, { bigint: true }).ino, inode);
        assert.equal(fs.readFileSync(target, "utf8"), "after\n");
      } else {
        assert.equal(previewRollback(paths, pending.operationId, EN).status, "ready");
        const restoreFault = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
          originalRename(from, to);
          if (String(to) === target) throw new Error("interrupted after restoration");
        });
        syncBuiltinESMExports();
        try { assert.equal(applyRollback(paths, pending.operationId, EN).state, "pending"); }
        finally { restoreFault.mock.restore(); syncBuiltinESMExports(); }
        assert.equal(fs.readFileSync(target, "utf8"), "before\n");
        deadOwner(paths);
        assert.equal(previewRollback(paths, pending.operationId, EN).status, "ready");
        assert.equal(applyRollback(paths, pending.operationId, EN).state, "rolled-back");
        assert.equal(fs.lstatSync(target).mode & 0o777, 0o640);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("recovery-safe gate presentation excludes private bodies and verifies before completion", async () => {
  const { root, paths, options } = fixture();
  const target = join(root, "config.json");
  const privateValue = "dummy-private-address-and-note";
  try {
    fs.writeFileSync(target, `${privateValue}\n`);
    const change = planChange(target, () => `new-${privateValue}\n`, EN);
    for (const verbose of [false, true]) {
      const dry = await gate([change], { ...options, dryRun: true, verbose, recoveryPresentation: { lines: ["Affected fields: address, note"] } });
      assert.equal(JSON.stringify(dry).includes(privateValue), false);
    }
    let output = "";
    const declined = await gate([change], { ...options, auto: false, verbose: true, recoveryPresentation: true,
      out: (value) => { output += value; }, interactive: () => true, ask: async () => "no" });
    assert.equal((output + JSON.stringify(declined)).includes(privateValue), false);
    assert.equal(fs.readFileSync(target, "utf8"), `${privateValue}\n`);
    await assert.rejects(() => gate([change], { ...options, recoveryPresentation: true, verify() {
      assert.equal(readJournal(paths, JSON.parse(fs.readFileSync(join(paths.operationsLock, "owner.json"), "utf8")).operationId)?.state, "pending");
      throw Object.assign(new Error(privateValue), { code: privateValue, path: `/${privateValue}/config.json` });
    } }), (error: unknown) => error instanceof Error && !error.message.includes(privateValue) &&
      /verification \(UNKNOWN\)/.test(error.message));
    assert.equal(inspectOperations(paths).journals[0]!.state, "pending");
    assert.equal(fs.existsSync(paths.operationsLock), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rollback preserves a created file edited in place during its deletion checkpoint", async () => {
  const { root, paths, options } = fixture();
  const target = join(root, "created.md");
  const originalRename = fs.renameSync;
  try {
    const result = await gate([planChange(target, () => "generated\n", EN)], {
      ...options, retention: { kind: "migration", reason: "app-rebuild" },
    });
    const identity = fs.lstatSync(target, { bigint: true }).ino;
    let edited = false;
    const fault = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      originalRename(from, to);
      if (String(to) !== join(paths.operations, `${result.operationId}.json`)) return;
      const journal = readJournal(paths, result.operationId!);
      if (!edited && journal?.actions.some(action => action.metadata &&
          typeof action.metadata === "object" && !Array.isArray(action.metadata) &&
          action.metadata.restoreWitness !== undefined)) {
        edited = true;
        fs.writeFileSync(target, "user-edited\n");
        assert.equal(fs.lstatSync(target, { bigint: true }).ino, identity);
      }
    });
    syncBuiltinESMExports();
    try { assert.equal(applyRollback(paths, result.operationId!, EN).state, "pending"); }
    finally { fault.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(edited, true, "the edit occurs after the retained deletion witness");
    assert.equal(fs.readFileSync(target, "utf8"), "user-edited\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("interrupted rollback of a created file records its surviving parent before deletion", async () => {
  const { root, paths, options } = fixture();
  const target = join(root, "new-parent", "created.md");
  const originalRemove = fs.rmSync;
  try {
    const created = await gate([planChange(target, () => "generated\n", EN)], { ...options, retention: { kind: "migration", reason: "app-rebuild" } });
    const parentInode = fs.lstatSync(join(root, "new-parent"), { bigint: true }).ino;
    const fault = mock.method(fs, "rmSync", (path: fs.PathLike, flags?: fs.RmOptions) => {
      originalRemove(path, flags);
      if (String(path) === target) throw new Error("interrupted after restoring absence");
    });
    syncBuiltinESMExports();
    try { assert.equal(applyRollback(paths, created.operationId!, EN).state, "pending"); }
    finally { fault.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(fs.existsSync(target), false);
    deadOwner(paths);
    assert.equal(previewRollback(paths, created.operationId!, EN).status, "ready");
    assert.equal(applyRollback(paths, created.operationId!, EN).state, "rolled-back");
    assert.equal(fs.lstatSync(join(root, "new-parent"), { bigint: true }).ino, parentInode);
  } finally { originalRemove(root, { recursive: true, force: true }); }
});

for (const interruption of ["receipt", "seal", "release"] as const) {
  test(`dead operation retirement retries ${interruption} without resurrecting its lock or rollback authority`, async () => {
    const { root, paths, options } = fixture();
    const target = join(root, "config.json");
    const originalRename = fs.renameSync;
    const originalRmdir = fs.rmdirSync;
    try {
      fs.writeFileSync(target, "current-data\n");
      const handle = acquireOperation(paths, "mutation");
      const original = beginJournal(handle, [{ id: "old-unwitnessed", kind: "file", path: target, realPath: target,
        before: { bytes: "b2xkLWRhdGEK" }, after: { bytes: "Y3VycmVudC1kYXRhCg==" } }]);
      deadOwner(paths);
      const journalPath = join(paths.operations, `${original.operationId}.json`);
      const receiptPath = join(paths.operations, `${original.operationId}.retirement.json`);
      const fault = interruption === "release"
        ? mock.method(fs, "rmdirSync", (path: fs.PathLike) => {
          if (String(path) === paths.operationsLock) throw new Error("interrupted release");
          originalRmdir(path);
        })
        : mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
          originalRename(from, to);
          if (String(to) === (interruption === "receipt" ? receiptPath : journalPath)) throw new Error("interrupted seal");
        });
      syncBuiltinESMExports();
      try { assert.throws(() => retireOperationForAppRebuild(paths, original.operationId), /interrupted/); }
      finally { fault.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(fs.readFileSync(target, "utf8"), "current-data\n", "retirement does not mutate application data");
      deadOwner(paths);
      const result = retireOperationForAppRebuild(paths, original.operationId);
      assert.equal(result.state, "retired-for-app-rebuild");
      assert.equal(fs.existsSync(paths.operationsLock), false);
      const retired = readJournal(paths, original.operationId)!;
      assert.deepEqual(retired.actions, original.actions);
      assert.deepEqual(retired.completed, original.completed);
      assert.equal(inspectRollback(paths, original.operationId).allowed, false);
      assert.equal(previewRollback(paths, original.operationId, EN).actions.length, 0);

      const fresh = await gate([planChange(target, () => "rebuilt-data\n", EN)], { ...options, retention: { kind: "migration", reason: "app-rebuild" } });
      assert.notEqual(fresh.operationId, original.operationId);
      assert.equal(applyRollback(paths, fresh.operationId!, EN).state, "rolled-back");
      assert.equal(fs.readFileSync(target, "utf8"), "current-data\n");
      assert.equal(fs.existsSync(paths.operationsLock), false);
      assert.equal(readJournal(paths, original.operationId)?.state, "retired-for-app-rebuild");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

for (const kind of ["ordinary", "raw", "family", "rollback"] as const) {
  for (const equalBytes of [true, false]) {
    test(`prepared ${kind} refuses a foreign temporary inode without changing its mode: equalBytes=${equalBytes}`, async () => {
      const { root, paths, options } = fixture();
      const target = kind === "family" ? join(root, "skill", "tonedial") : join(root, "config.json");
      const planned = kind === "rollback" ? "before\n" : "after-dummy-private-value\n";
      const foreignBytes = equalBytes ? planned : "foreign contents\n";
      const originalOpen = fs.openSync;
      const originalClose = fs.closeSync;
      const originalRename = fs.renameSync;
      let operationId: string | undefined;
      let prepared: string | undefined;
      let descriptor: number | undefined;
      let replaced = false;
      try {
        if (kind === "family") {
          fs.mkdirSync(dirname(target), { recursive: true });
          fs.symlinkSync("missing-source", target);
        } else fs.writeFileSync(target, "before\n", { mode: 0o640 });
        if (kind === "rollback") {
          const result = await gate([planChange(target, () => "after\n", EN)], { ...options,
            retention: { kind: "migration", reason: "app-rebuild" } });
          operationId = result.operationId;
        }
        const open = mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
          const fd = originalOpen(...args);
          const name = String(args[0]);
          if (typeof args[1] === "number" && (args[1] & fs.constants.O_CREAT) !== 0 &&
              (name.includes(".tonedial-write-") || name.endsWith("/prepared") || name.endsWith("/prepared/SKILL.md"))) {
            prepared = name;
            descriptor = fd;
          }
          return fd;
        });
        const close = mock.method(fs, "closeSync", (fd: number) => {
          originalClose(fd);
          if (fd !== descriptor || prepared === undefined || replaced) return;
          replaced = true;
          originalRename(prepared, join(root, "retained-own-prepared"));
          const foreign = join(root, "foreign-prepared");
          fs.writeFileSync(foreign, foreignBytes, { mode: 0o444 });
          fs.chmodSync(foreign, 0o444);
          originalRename(foreign, prepared);
        });
        syncBuiltinESMExports();
        try {
          if (kind === "rollback") {
            assert.equal(applyRollback(paths, operationId!, EN).state, "pending");
          } else if (kind === "ordinary") {
            await assert.rejects(() => gate([planChange(target, () => planned, EN)], options), /changed|stale/i);
          } else {
            const capture = captureRawEntry(target, EN, { within: root, allowLink: kind === "family" });
            const plan = kind === "family"
              ? planGeneratedFamilyRebuild(capture, [{ relativePath: "SKILL.md", contents: planned }], EN)
              : planEntryRebuild(capture, planned, EN, { reason: "restore-config" });
            await assert.rejects(() => gate([], { ...options, operationActions: [plan.action] }), /changed|stale/i);
          }
        } finally { open.mock.restore(); close.mock.restore(); syncBuiltinESMExports(); }
        assert.equal(replaced, true);
        assert.ok(prepared);
        const foreign = fs.lstatSync(prepared, { bigint: true });
        assert.equal(fs.readFileSync(prepared, "utf8"), foreignBytes);
        assert.equal(foreign.mode & 0o777n, 0o444n);
        if (kind === "family") assert.equal(fs.readlinkSync(target), "missing-source");
        else assert.equal(fs.readFileSync(target, "utf8"), kind === "rollback" ? "after\n" : "before\n");
        assert.equal(fs.existsSync(paths.operationsLock), true);
        if (kind !== "rollback") {
          const pending = inspectOperations(paths).journals[0]!.journal!;
          assert.equal(pending.state, "pending");
          assert.deepEqual(pending.completed, []);
          deadOwner(paths);
          assert.equal(applyRollback(paths, pending.operationId, EN).state, "rolled-back");
        }
        assert.equal(fs.lstatSync(prepared, { bigint: true }).ino, foreign.ino);
        assert.equal(fs.lstatSync(prepared).mode & 0o777, 0o444);
        assert.equal(fs.readFileSync(prepared, "utf8"), foreignBytes);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
}

for (const family of [false, true]) {
  test(`private staging parent replaced at its checkpoint never receives recovery bytes: family=${family}`, async () => {
    const { root, paths, options } = fixture();
    const outside = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "tonedial-private-stage-outside-")));
    const target = family ? join(root, "skill", "tonedial") : join(root, "config.json");
    const originalRename = fs.renameSync;
    let stash: string | undefined;
    let retained: string | undefined;
    try {
      if (family) {
        fs.mkdirSync(dirname(target), { recursive: true });
        fs.symlinkSync("missing-source", target);
      } else fs.writeFileSync(target, "before\n", { mode: 0o640 });
      const capture = captureRawEntry(target, EN, { within: root, allowLink: family });
      const plan = family
        ? planGeneratedFamilyRebuild(capture, [{ relativePath: "SKILL.md", contents: "dummy-private-recovery-value\n" }], EN)
        : planEntryRebuild(capture, "dummy-private-recovery-value\n", EN, { reason: "restore-config" });
      const fault = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        originalRename(from, to);
        if (stash !== undefined || !String(to).startsWith(paths.operations) || !String(to).endsWith(".json")) return;
        const journal = JSON.parse(fs.readFileSync(to, "utf8"));
        const metadata = journal.actions?.[0]?.metadata;
        if (typeof metadata?.stashIdentity !== "string" || metadata.preparedIdentity !== null) return;
        stash = metadata.stash;
        retained = `${stash}.retained`;
        originalRename(stash!, retained);
        fs.symlinkSync(outside, stash!);
      });
      syncBuiltinESMExports();
      try { await assert.rejects(() => gate([], { ...options, operationActions: [plan.action] }), /changed|stale|archive/i); }
      finally { fault.mock.restore(); syncBuiltinESMExports(); }
      assert.ok(stash);
      assert.ok(retained);
      assert.deepEqual(fs.readdirSync(outside), [], "no private prepared file or family appears outside the state root");
      if (family) assert.equal(fs.readlinkSync(target), "missing-source");
      else assert.equal(fs.readFileSync(target, "utf8"), "before\n");
      const pending = inspectOperations(paths).journals[0]!.journal!;
      assert.deepEqual(pending.completed, []);
      deadOwner(paths);
      assert.equal(applyRollback(paths, pending.operationId, EN).state, "pending");
      assert.equal(fs.readlinkSync(stash), outside);
      assert.deepEqual(fs.readdirSync(outside), []);
      fs.unlinkSync(stash);
      originalRename(retained, stash);
      deadOwner(paths);
      assert.equal(applyRollback(paths, pending.operationId, EN).state, "rolled-back");
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
}

test("forward deletion records the surviving parent when an owned empty directory is removed", async () => {
  const { root, paths, options } = fixture();
  const target = join(root, "owned-parent", "owned.md");
  try {
    fs.mkdirSync(dirname(target));
    fs.writeFileSync(target, "original\n", { mode: 0o640 });
    const removal = { ...planChange(target, () => null, EN), created: true, createdDir: true };
    const result = await gate([removal], { ...options, retention: { kind: "migration", reason: "delivery" } });
    assert.equal(fs.existsSync(dirname(target)), false);
    assert.equal(readJournal(paths, result.operationId!)?.state, "complete");
    assert.equal(applyRollback(paths, result.operationId!, EN).state, "rolled-back");
    assert.equal(fs.readFileSync(target, "utf8"), "original\n");
    assert.equal(fs.lstatSync(target).mode & 0o777, 0o640);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("shared lexical aliases publish and roll back one physical write with every link witness retained", async () => {
  const { root, paths, options } = fixture();
  const shared = join(root, "shared.md");
  const first = join(root, "first.md");
  const second = join(root, "second.md");
  try {
    fs.writeFileSync(shared, "original\n", { mode: 0o640 });
    fs.symlinkSync(shared, first);
    fs.symlinkSync(shared, second);
    const firstInode = fs.lstatSync(first, { bigint: true }).ino;
    const secondInode = fs.lstatSync(second, { bigint: true }).ino;
    const result = await gate([planChange(first, () => "shared new value\n", EN), planChange(second, () => "shared new value\n", EN)], {
      ...options, retention: { kind: "migration", reason: "delivery" },
    });
    assert.equal(fs.readFileSync(shared, "utf8"), "shared new value\n");
    assert.deepEqual(result.diff.map((entry) => entry.path), [first, second]);
    const journal = readJournal(paths, result.operationId!)!;
    assert.equal(journal.actions.length, 1, "one physical effect owns one prepared write and rollback action");
    assert.deepEqual(journal.completed, [0]);
    assert.equal(fs.lstatSync(first, { bigint: true }).ino, firstInode);
    assert.equal(fs.lstatSync(second, { bigint: true }).ino, secondInode);
    assert.equal(applyRollback(paths, result.operationId!, EN).state, "rolled-back");
    assert.equal(fs.readFileSync(shared, "utf8"), "original\n");
    assert.equal(fs.readlinkSync(first), shared);
    assert.equal(fs.readlinkSync(second), shared);
    assert.equal(fs.lstatSync(first, { bigint: true }).ino, firstInode);
    assert.equal(fs.lstatSync(second, { bigint: true }).ino, secondInode);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a shared alias retargeted after publication stops final config and remains protected from rollback", async () => {
  const { root, paths, options } = fixture();
  const shared = join(root, "shared.md");
  const first = join(root, "first.md");
  const second = join(root, "second.md");
  const foreign = join(root, "foreign.md");
  const config = join(root, "config.json");
  const originalRename = fs.renameSync;
  let replaced = false;
  try {
    fs.writeFileSync(shared, "original\n");
    fs.writeFileSync(foreign, "foreign\n");
    fs.writeFileSync(config, "old config\n");
    fs.symlinkSync(shared, first);
    fs.symlinkSync(shared, second);
    const fault = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      originalRename(from, to);
      if (replaced || !String(to).startsWith(paths.operations) || !String(to).endsWith(".json")) return;
      const journal = JSON.parse(fs.readFileSync(to, "utf8"));
      if (!journal.completed?.includes(0) || !journal.actions?.[0]?.metadata?.aliases) return;
      replaced = true;
      fs.unlinkSync(second);
      fs.symlinkSync(foreign, second);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => gate([planChange(first, () => "new\n", EN), planChange(second, () => "new\n", EN)], {
        ...options, finalChanges: [planChange(config, () => "new config\n", EN)],
      }), /changed|stale/i);
    } finally { fault.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(config, "utf8"), "old config\n");
    assert.equal(fs.readlinkSync(second), foreign);
    assert.equal(fs.readFileSync(foreign, "utf8"), "foreign\n");
    const journal = inspectOperations(paths).journals[0]!.journal!;
    deadOwner(paths);
    assert.equal(previewRollback(paths, journal.operationId, EN).status, "unresolved");
    assert.equal(applyRollback(paths, journal.operationId, EN).state, "pending");
    assert.equal(fs.readlinkSync(second), foreign);
    assert.equal(fs.readFileSync(shared, "utf8"), "new\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const conflict of ["after", "source"] as const) {
  test(`conflicting shared physical ${conflict} refuses before any write`, async () => {
    const { root, paths, options } = fixture();
    const shared = join(root, "shared.md");
    const first = join(root, "first.md");
    const second = join(root, "second.md");
    const untouched = join(root, "unrelated.md");
    try {
      fs.writeFileSync(shared, "original\n");
      fs.writeFileSync(untouched, "unchanged\n");
      fs.symlinkSync(shared, first);
      fs.symlinkSync(shared, second);
      const a = planChange(first, () => "new\n", EN);
      if (conflict === "source") fs.writeFileSync(shared, "changed source\n");
      const b = planChange(second, () => conflict === "after" ? "different\n" : "new\n", EN);
      await assert.rejects(() => gate([planChange(untouched, () => "must not write\n", EN), a, b], options), /changed|stale/i);
      assert.equal(fs.readFileSync(untouched, "utf8"), "unchanged\n");
      assert.equal(fs.readFileSync(shared, "utf8"), conflict === "source" ? "changed source\n" : "original\n");
      assert.equal(fs.existsSync(paths.operationsLock), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("distinct lexical symlink removals keep separate entry actions without deleting their shared referent", async () => {
  const { root, paths, options } = fixture();
  const shared = join(root, "shared.md");
  const first = join(root, "first.md");
  const second = join(root, "second.md");
  try {
    fs.writeFileSync(shared, "retained referent\n");
    fs.symlinkSync(shared, first);
    fs.symlinkSync(shared, second);
    const result = await gate([planChange(first, () => null, EN), planChange(second, () => null, EN)], {
      ...options, retention: { kind: "migration", reason: "delivery" },
    });
    assert.equal(readJournal(paths, result.operationId!)?.actions.length, 2);
    assert.equal(fs.lstatSync(first, { throwIfNoEntry: false }), undefined);
    assert.equal(fs.lstatSync(second, { throwIfNoEntry: false }), undefined);
    assert.equal(fs.readFileSync(shared, "utf8"), "retained referent\n");
    assert.equal(applyRollback(paths, result.operationId!, EN).state, "rolled-back");
    assert.equal(fs.readlinkSync(first), shared);
    assert.equal(fs.readlinkSync(second), shared);
    assert.equal(fs.readFileSync(shared, "utf8"), "retained referent\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("shared creation aliases retry witnessed rollback absence after an interrupted deletion", async () => {
  const { root, paths, options } = fixture();
  const directory = join(root, "shared-parent");
  const first = join(root, "first-parent", "created.md");
  const second = join(root, "second-parent", "created.md");
  const physical = join(directory, "created.md");
  const originalRemove = fs.rmSync;
  try {
    fs.mkdirSync(directory);
    fs.symlinkSync(directory, dirname(first));
    fs.symlinkSync(directory, dirname(second));
    const result = await gate([planChange(first, () => "new\n", EN), planChange(second, () => "new\n", EN)], {
      ...options, retention: { kind: "migration", reason: "delivery" },
    });
    assert.equal(readJournal(paths, result.operationId!)?.actions.length, 1);
    const fault = mock.method(fs, "rmSync", (path: fs.PathLike, flags?: fs.RmOptions) => {
      originalRemove(path, flags);
      if (String(path) === physical) throw new Error("interrupted shared absence restoration");
    });
    syncBuiltinESMExports();
    try { assert.equal(applyRollback(paths, result.operationId!, EN).state, "pending"); }
    finally { fault.mock.restore(); syncBuiltinESMExports(); }
    deadOwner(paths);
    assert.equal(previewRollback(paths, result.operationId!, EN).status, "ready");
    assert.equal(applyRollback(paths, result.operationId!, EN).state, "rolled-back");
    assert.equal(fs.existsSync(physical), false);
    assert.equal(fs.readlinkSync(dirname(first)), directory);
    assert.equal(fs.readlinkSync(dirname(second)), directory);
  } finally { originalRemove(root, { recursive: true, force: true }); }
});
