import { test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { run } from "../src/cli.ts";
import { AXIS_DEFAULT } from "../src/core/anchors.ts";
import { parseConfig } from "../src/core/config.ts";
import { catalogue } from "../src/core/i18n.ts";
import {
  applyPreset, customPresetDir, inspectPresetLibrary, PRESET_MAX_BYTES, resolvePreset,
  serializePreset,
} from "../src/core/presets.ts";
import { assertFresh, gate, rawReadChange, rawReadCheck } from "../src/wiring/apply.ts";
import { palette } from "../src/ui/style.ts";

const EN = catalogue("en").cli;

function fixture() {
  const home = fs.realpathSync(mkdtempSync(join(tmpdir(), "tonedial-library-")));
  const root = join(home, "state");
  const presets = join(root, "presets");
  const custom = customPresetDir(presets);
  mkdirSync(custom, { recursive: true });
  return {
    home, root, presets, custom,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), TONEDIAL_HOME: root, TONEDIAL_AGENT_HOME: join(home, "agent"), PATH: "" },
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}

async function invoke(f: ReturnType<typeof fixture>, ...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = ((text: string) => (stdout.push(text), true)) as typeof process.stdout.write;
  process.stderr.write = ((text: string) => (stderr.push(text), true)) as typeof process.stderr.write;
  try {
    const status = await run([...args, "--json"], f.env, f.home, false, false);
    return { status, payload: JSON.parse(stdout.join("")), stderr: stderr.join("") };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

test("missing or damaged config leaves old and new custom presets listable and exportable without writes", async () => {
  const f = fixture();
  try {
    const legacy = join(f.presets, "old-profile.json");
    const modern = join(f.custom, "new-profile.json");
    const oldBytes = JSON.stringify({ displayName: "Old ".repeat(40), values: { warmth: 5 } });
    writeFileSync(legacy, oldBytes, { mode: 0o640 });
    writeFileSync(modern, JSON.stringify({ schema: 1, values: { critique: 4 } }));
    writeFileSync(join(f.custom, "damaged.json"), '{ "dummy-private": "NEVER_PRINT_LIBRARY_PRIVATE"');
    const beforeFiles = readdirSync(f.root, { recursive: true }).sort();
    for (const configBody of [null, '{ "dummy-private": "NEVER_PRINT_CONFIG_PRIVATE"']) {
      if (configBody !== null) writeFileSync(join(f.root, "config.json"), configBody);
      const listed = await invoke(f, "list");
      assert.equal(listed.status, 0, listed.stderr);
      assert.equal(listed.payload.activeKnown, false);
      assert.equal(listed.payload.active, null);
      assert.equal(listed.payload.presets.find((p: { slug: string }) => p.slug === "damaged").available, false);
      assert.ok(listed.payload.presets.some((p: { slug: string; available: boolean }) => p.slug === "old-profile" && p.available));
      assert.ok(listed.payload.presets.some((p: { slug: string; available: boolean }) => p.slug === "new-profile" && p.available));
      assert.doesNotMatch(JSON.stringify(listed), /NEVER_PRINT_/);
      const exported = await invoke(f, "export", "old-profile");
      assert.equal(exported.status, 0, exported.stderr);
      assert.deepEqual(exported.payload.preset.values, { warmth: 5 });
      assert.equal(exported.payload.preset.displayName, "Old ".repeat(40).trim());
      assert.equal(readFileSync(legacy, "utf8"), oldBytes);
      assert.equal(statSync(legacy).mode & 0o777, 0o640);
      assert.deepEqual(readdirSync(f.root, { recursive: true }).filter((p) => p !== "config.json").sort(), beforeFiles);
    }
  } finally { f.dispose(); }
});

test("bundled presets export by their listed slug and unknown names are refused", async () => {
  const f = fixture();
  try {
    const listed = await invoke(f, "list");
    assert.equal(listed.status, 0);
    assert.equal(listed.payload.presets.find((preset: { displayName: string }) => preset.displayName === "Bratty Kid").slug, "bratty-kid");
    const unknown = await invoke(f, "export", "missing-preset");
    assert.equal(unknown.status, 1);
    assert.equal(unknown.payload.ok, false);
    const exported = await invoke(f, "export", "bratty-kid");
    assert.equal(exported.status, 0);
    assert.equal(exported.payload.preset.slug, "bratty-kid");
    assert.deepEqual(readdirSync(f.root), ["presets"]);
  } finally { f.dispose(); }
});

test("collision recovery gives both definitions stable selectors, reuses equivalent copies and preserves changed originals", async () => {
  const f = fixture();
  try {
    const oldPath = join(f.presets, "same-name.json");
    const newPath = join(f.custom, "same-name.json");
    const oldBytes = JSON.stringify({ schema: 1, slug: "same-name", displayName: "Legacy ".repeat(30), values: { warmth: 1 } });
    const newBytes = JSON.stringify({ schema: 1, slug: "same-name", displayName: "Current", values: { warmth: 4 } });
    writeFileSync(oldPath, oldBytes, { mode: 0o640 });
    writeFileSync(newPath, newBytes);
    const initial = inspectPresetLibrary(f.presets, EN);
    assert.equal(initial.conflicts.length, 1);
    assert.equal(initial.conflicts[0]!.resolved, false);
    assert.equal(initial.recoveryCopies.length, 1);
    const proposal = initial.recoveryCopies[0]!;
    assert.ok(proposal.preset.slug.length <= 32);
    assert.equal(resolvePreset(f.presets, "same-name", EN, initial)!.preset.values.warmth, 4);
    const listed = await invoke(f, "list");
    assert.equal(listed.status, 0);
    assert.equal(listed.payload.conflicts[0].recoveredSlug, proposal.preset.slug);
    assert.ok(!listed.payload.presets.some((p: { slug: string }) => p.slug === proposal.preset.slug));
    const ordinary = await invoke(f, "export", "same-name");
    assert.equal(ordinary.payload.preset.values.warmth, 4);

    // The approved copy lands at the planner's actual path. Readers then consume it normally.
    writeFileSync(proposal.path, proposal.contents);
    const complete = inspectPresetLibrary(f.presets, EN);
    assert.equal(complete.conflicts[0]!.resolved, true);
    assert.equal(complete.recoveryCopies.length, 0);
    const recovered = await invoke(f, "export", proposal.preset.slug);
    assert.equal(recovered.status, 0);
    assert.deepEqual(recovered.payload.preset.values, { warmth: 1 });
    assert.equal(recovered.payload.preset.displayName, "Legacy ".repeat(30).trim());
    const snapshot = readFileSync(proposal.path);
    // Default spelling and a different label do not manufacture another selectable copy.
    const sparse = JSON.parse(proposal.contents);
    sparse.displayName = "Recovered label";
    sparse.values.critique = AXIS_DEFAULT.critique;
    writeFileSync(proposal.path, JSON.stringify(sparse));
    assert.equal(inspectPresetLibrary(f.presets, EN).recoveryCopies.length, 0);

    writeFileSync(oldPath, JSON.stringify({ schema: 1, values: { warmth: 2 } }));
    const changed = inspectPresetLibrary(f.presets, EN).recoveryCopies[0]!;
    assert.notEqual(changed.preset.slug, proposal.preset.slug);
    assert.equal(changed.preset.values.warmth, 2);
    assert.equal(JSON.parse(readFileSync(proposal.path, "utf8")).values.warmth, 1);
    assert.notDeepEqual(readFileSync(proposal.path), snapshot, "the fixture did not change the copy's label/default spelling");
    assert.equal(readFileSync(newPath, "utf8"), newBytes);
    assert.equal(statSync(oldPath).mode & 0o777, 0o640);
  } finally { f.dispose(); }
});

test("reserved cache edits are extractable without replacing package definitions and occupied recovery names stay intact", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.presets, "tough-love.json"), JSON.stringify({ values: { warmth: 1 } }));
    const first = inspectPresetLibrary(f.presets, EN).recoveryCopies[0]!;
    assert.equal(resolvePreset(f.presets, "tough-love", EN)!.source, "bundled");
    assert.equal(applyPreset(resolvePreset(f.presets, "tough-love", EN)!.preset).warmth, 5);
    const foreign = JSON.stringify({ values: { warmth: 2 } });
    writeFileSync(first.path, foreign);
    const second = inspectPresetLibrary(f.presets, EN).recoveryCopies[0]!;
    assert.notEqual(second.path, first.path);
    assert.equal(readFileSync(first.path, "utf8"), foreign);
    writeFileSync(second.path, second.contents);
    const retryLibrary = inspectPresetLibrary(f.presets, EN);
    assert.equal(retryLibrary.recoveryCopies.length, 0);
    const retry = retryLibrary.cacheRecoveries[0]!;
    assert.equal(retry.existing!.path, second.path);
    assert.equal(retry.path, second.path);
    assert.equal(readFileSync(first.path, "utf8"), foreign);
  } finally { f.dispose(); }
});

test("library links and oversized siblings are unavailable and selection keeps original identity and precedence witnesses", () => {
  const f = fixture();
  try {
    const outside = join(f.home, "outside.json");
    writeFileSync(outside, '{"dummy-private":"NEVER_PRINT_OUTSIDE"}');
    symlinkSync(outside, join(f.custom, "linked.json"));
    writeFileSync(join(f.custom, "oversized.json"), " ".repeat(PRESET_MAX_BYTES + 1));
    const legacy = join(f.presets, "kept.json");
    writeFileSync(legacy, JSON.stringify({ values: { warmth: 5 } }));
    const library = inspectPresetLibrary(f.presets, EN);
    assert.deepEqual(library.unavailable.map((p) => p.slug).sort(), ["linked", "oversized"]);
    assert.equal(resolvePreset(f.presets, "linked", EN, library), null);
    const selected = resolvePreset(f.presets, "kept", EN, library)!;
    const reads = selected.selectionReads.map((capture) => rawReadChange(capture, EN));
    for (const read of reads) assert.doesNotThrow(() => assertFresh(read, EN));
    const replacement = join(f.custom, "kept.json");
    writeFileSync(replacement, JSON.stringify({ values: { warmth: 2 } }));
    assert.throws(() => assertFresh(reads.find((read) => read.path === replacement)!, EN), /changed/);
    rmSync(replacement);
    const sameBytes = readFileSync(legacy);
    const foreignReplacement = join(f.presets, "same-bytes.json");
    writeFileSync(foreignReplacement, sameBytes);
    renameSync(foreignReplacement, legacy);
    assert.throws(() => assertFresh(reads.find((read) => read.path === legacy)!, EN), /changed/);
    assert.equal(readFileSync(outside, "utf8"), '{"dummy-private":"NEVER_PRINT_OUTSIDE"}');

    rmSync(f.custom, { recursive: true });
    symlinkSync(f.home, f.custom);
    const linkedParent = inspectPresetLibrary(f.presets, EN);
    assert.equal(linkedParent.unavailable.find((p) => p.path === f.custom)!.reason, "unreadable");
    assert.ok(!linkedParent.entries.some((entry) => entry.preset.slug === "outside"));
  } finally { f.dispose(); }
});

test("save and import replace the resolved legacy file, create new names under custom and use their actual definition", async () => {
  const f = fixture();
  try {
    assert.equal((await invoke(f, "init", "--global", "--tools", "none", "--auto")).status, 0);
    const legacy = join(f.presets, "old-profile.json");
    writeFileSync(legacy, JSON.stringify({ values: { warmth: 5 } }), { mode: 0o640 });
    assert.equal((await invoke(f, "use", "old-profile")).status, 0);
    assert.equal(parseConfig(readFileSync(join(f.root, "config.json"), "utf8"), EN).axes.warmth, 5);
    assert.equal((await invoke(f, "set", "warmth=2")).status, 0);
    assert.equal((await invoke(f, "save", "Old Profile")).status, 0);
    assert.equal(JSON.parse(readFileSync(legacy, "utf8")).values.warmth, 2);
    assert.equal(statSync(legacy).mode & 0o777, 0o640);
    assert.equal(existsSync(join(f.custom, "old-profile.json")), false);
    const incoming = join(f.home, "incoming.json");
    writeFileSync(incoming, JSON.stringify({ schema: 1, slug: "old-profile", values: { warmth: 4 } }));
    assert.equal((await invoke(f, "import", incoming)).status, 0);
    assert.equal(JSON.parse(readFileSync(legacy, "utf8")).values.warmth, 4);
    assert.equal((await invoke(f, "use", "old-profile")).status, 0);
    assert.equal(parseConfig(readFileSync(join(f.root, "config.json"), "utf8"), EN).axes.warmth, 4);
    assert.equal((await invoke(f, "save", "New Profile")).status, 0);
    const newPath = join(f.custom, "new-profile.json");
    assert.deepEqual(JSON.parse(readFileSync(newPath, "utf8")).values, { warmth: 4 });
    assert.equal(existsSync(join(f.presets, "new-profile.json")), false);
    assert.equal((await invoke(f, "use", "new-profile")).status, 0);
    const exported = await invoke(f, "export", "new-profile");
    assert.equal(exported.payload.preset.values.warmth, 4);
    assert.equal(serializePreset(resolvePreset(f.presets, "new-profile", EN)!.preset), readFileSync(newPath, "utf8"));
  } finally { f.dispose(); }
});

test("a damaged higher-priority user file remains raw read evidence and cannot become an unnoticed selector change", async (t) => {
  const f = fixture();
  try {
    assert.equal((await invoke(f, "init", "--global", "--tools", "none", "--auto")).status, 0);
    const legacy = join(f.presets, "race.json");
    const higher = join(f.custom, "race.json");
    writeFileSync(legacy, JSON.stringify({ values: { warmth: 5 } }));
    writeFileSync(higher, Buffer.from([0xff, 0x80]));
    const selected = resolvePreset(f.presets, "race", EN)!;
    const capture = selected.selectionReads.find(entry => entry.path === higher)!;
    assert.ok(capture, "the invalid preferred file must still bind source precedence");
    const raw = rawReadCheck(capture, EN);
    assert.doesNotThrow(() => assertFresh(raw, EN));
    await assert.rejects(() => gate([{ ...raw, after: "not a read" }], {
      paths: { root: f.root, operations: join(f.root, "operations"), operationsLock: join(f.root, "operations.lock") },
      t: EN, ui: palette("never", {}, false), auto: true, dryRun: false, out: () => {},
    }), /changed/);
    assert.deepEqual(readFileSync(higher), Buffer.from([0xff, 0x80]));
    const config = readFileSync(join(f.root, "config.json"));
    const tone = readFileSync(join(f.root, "TONE.md"));
    const mkdir = fs.mkdirSync;
    let replaced = false;
    t.mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
      if (!replaced && String(args[0]) === join(f.root, "operations.lock")) {
        replaced = true;
        writeFileSync(higher, JSON.stringify({ values: { warmth: 1 } }));
      }
      return mkdir(...args);
    });
    syncBuiltinESMExports();
    try {
      const result = await invoke(f, "use", "race");
      assert.equal(replaced, true);
      assert.equal(result.status, 1);
      assert.match(result.payload.error, /changed/);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.deepEqual(readFileSync(join(f.root, "config.json")), config);
    assert.deepEqual(readFileSync(join(f.root, "TONE.md")), tone);
    assert.equal(JSON.parse(readFileSync(legacy, "utf8")).values.warmth, 5);
  } finally { f.dispose(); }
});

for (const preferred of ["parent-link", "file-link", "oversized"] as const) {
  test(`an unwitnessable ${preferred} keeps readonly fallback available and blocks preset mutation before writes or editor launch`, async () => {
    const f = fixture();
    try {
      assert.equal((await invoke(f, "init", "--global", "--tools", "none", "--auto")).status, 0);
      const legacy = join(f.presets, "old-profile.json");
      const higher = join(f.custom, "old-profile.json");
      const legacyBytes = JSON.stringify({ displayName: "Legacy Profile", values: { warmth: 5 } });
      writeFileSync(legacy, legacyBytes, { mode: 0o640 });
      const outside = join(f.home, "outside");
      mkdirSync(outside);
      const external = join(outside, "old-profile.json");
      const externalBytes = JSON.stringify({ values: { warmth: 1 }, dummy: "NEVER_PRINT_UNCAPTURED_VALUE" });
      writeFileSync(external, externalBytes);
      if (preferred === "parent-link") {
        rmSync(f.custom, { recursive: true });
        symlinkSync(outside, f.custom);
      } else if (preferred === "file-link") {
        symlinkSync(external, higher);
      } else {
        writeFileSync(higher, JSON.stringify({ values: { warmth: 1 }, padding: "x".repeat(PRESET_MAX_BYTES) }));
      }
      const marker = join(f.home, "editor-started");
      const editor = join(f.home, "editor.sh");
      writeFileSync(editor, `#!/bin/sh\nprintf opened > '${marker.replace(/'/g, "'\\''")}'\n`);
      Object.assign(f.env, { EDITOR: `/bin/sh ${editor}` });
      const beforeFiles = readdirSync(f.root, { recursive: true }).sort();
      const before = [join(f.root, "config.json"), join(f.root, "TONE.md"), legacy]
        .map(path => ({ path, bytes: readFileSync(path), mode: statSync(path).mode }));
      const protectedPath = preferred === "parent-link" ? f.custom : higher;
      const protectedEntry = lstatSync(protectedPath);
      const protectedLink = protectedEntry.isSymbolicLink() ? readlinkSync(protectedPath) : null;
      const protectedBytes = protectedEntry.isFile() ? readFileSync(protectedPath) : null;
      const assertPreferredKept = () => {
        const current = lstatSync(protectedPath);
        assert.equal(current.dev, protectedEntry.dev);
        assert.equal(current.ino, protectedEntry.ino);
        assert.equal(current.mode, protectedEntry.mode);
        if (protectedLink !== null) assert.equal(readlinkSync(protectedPath), protectedLink);
        if (protectedBytes !== null) assert.deepEqual(readFileSync(protectedPath), protectedBytes);
      };

      const listed = await invoke(f, "list");
      assert.equal(listed.status, 0, listed.stderr);
      assert.ok(listed.payload.presets.some((row: { slug: string; available: boolean }) => row.slug === "old-profile" && row.available));
      const shown = await invoke(f, "show", "old-profile");
      assert.equal(shown.status, 0, shown.stderr);
      assert.equal(shown.payload.axes.warmth, 5);
      const exported = await invoke(f, "export", "old-profile");
      assert.equal(exported.status, 0, exported.stderr);
      assert.deepEqual(exported.payload.preset.values, { warmth: 5 });
      assert.doesNotMatch(JSON.stringify([listed.payload, shown.payload, exported.payload]), /NEVER_PRINT_UNCAPTURED_VALUE/);

      for (const args of [["use", "old-profile"], ["save", "Old Profile"], ["edit", "preset", "old-profile"],
        ["doctor", "--fix", "--global", "--tools", "none", "--auto", "--from-preset", "old-profile"]]) {
        const blocked = await invoke(f, ...args);
        assert.equal(blocked.status, 1, JSON.stringify(blocked.payload));
        assert.equal(blocked.payload.ok, false);
        assert.ok(blocked.payload.error.includes(higher), "the refusal must identify the unbound preferred path");
        assert.equal(existsSync(marker), false, "the unsafe selection reached the editor");
        for (const entry of before) {
          assert.deepEqual(readFileSync(entry.path), entry.bytes, entry.path);
          assert.equal(statSync(entry.path).mode, entry.mode, entry.path);
        }
        assert.deepEqual(readdirSync(f.root, { recursive: true }).sort(), beforeFiles);
        assert.equal(readFileSync(external, "utf8"), externalBytes);
        assertPreferredKept();
      }
      // Valid saved config can rebuild app outputs without selecting this unbound fallback.
      const repaired = await invoke(f, "doctor", "--fix", "--global", "--tools", "none", "--auto");
      assert.equal(repaired.status, 0, JSON.stringify(repaired.payload));
      assert.equal(repaired.payload.appHealthy, true);
      assert.equal(readFileSync(legacy, "utf8"), legacyBytes);
      assert.equal(readFileSync(external, "utf8"), externalBytes);
      assertPreferredKept();
    } finally { f.dispose(); }
  });
}
