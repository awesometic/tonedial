import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { run } from "../src/cli.ts";
import { inspectOperations } from "../src/core/operations.ts";
import { resolvePaths } from "../src/core/paths.ts";
import { parseConfig } from "../src/core/config.ts";
import { catalogue } from "../src/core/i18n.ts";
import { customPresetDir } from "../src/core/presets.ts";

let scratch = "";
let state = "";
let project = "";
let output = "";
let errors = "";
let restore: (() => void)[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-mutations-"));
  state = join(scratch, "state");
  project = join(scratch, "project");
  output = "";
  errors = "";
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((text: string) => (output += text, true)) as typeof stdout;
  process.stderr.write = ((text: string) => (errors += text, true)) as typeof stderr;
  restore = [
    () => { process.stdout.write = stdout; },
    () => { process.stderr.write = stderr; },
  ];
});

afterEach(() => {
  for (const restoreOne of restore) restoreOne();
  rmSync(scratch, { recursive: true, force: true });
});

const invoke = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
  run(args, { HOME: scratch, TONEDIAL_HOME: state, ...extra }, project, false, false);

const paths = () => resolvePaths({ HOME: scratch, TONEDIAL_HOME: state });

const journalWith = (pathsWanted: string[]) => {
  const journals = inspectOperations(paths()).journals;
  assert.ok(journals.length > 0, "mutation did not leave a journal record");
  const match = journals.find((entry) => {
    if (entry.state !== "complete" || entry.journal === null) return false;
    return JSON.stringify(entry.journal.actions.map((action) => action.path)) === JSON.stringify(pathsWanted);
  });
  assert.ok(match, `no journal for ${pathsWanted.join(", ")}`);
  const latest = match!;
  assert.equal(latest.state, "complete");
  assert.ok(latest.journal);
  return latest.journal!;
};

test("direct state mutations apply artifact before final config in one operation", async () => {
  assert.equal(await invoke(["init", "--here", "--tools", "none", "--auto"]), 0, errors);
  assert.equal(await invoke(["set", "verbosity=5"]), 0, errors);
  let journal = journalWith([paths().tone, paths().config]);
  assert.deepEqual(
    journal.actions.map((action) => action.path),
    [paths().tone, paths().config],
  );
  assert.equal(parseConfig(readFileSync(paths().config, "utf8")).axes.verbosity, 5);

  assert.equal(await invoke(["save", "My Tone"]), 0, errors);
  journal = journalWith([join(customPresetDir(paths().presets), "my-tone.json"), paths().tone, paths().config]);
  assert.deepEqual(
    journal.actions.map((action) => action.path),
    [join(customPresetDir(paths().presets), "my-tone.json"), paths().tone, paths().config],
  );
  assert.ok(existsSync(join(customPresetDir(paths().presets), "my-tone.json")));
});

test("use rejects a user preset replaced after selection instead of compiling stale bytes", async (t) => {
  assert.equal(await invoke(["init", "--here", "--tools", "none", "--auto"]), 0, errors);
  const presetPath = join(paths().presets, "mine.json");
  const selected = JSON.stringify({
    schema: 1,
    slug: "mine",
    displayName: "Mine",
    values: { warmth: 5 },
  });
  const replacement = JSON.stringify({
    schema: 1,
    slug: "mine",
    displayName: "Replaced",
    values: { warmth: 1 },
  });
  writeFileSync(presetPath, selected);
  const beforeConfig = readFileSync(paths().config, "utf8");
  const beforeTone = readFileSync(paths().tone, "utf8");
  const actualReadFileSync = readFileSync;
  const presetIdentity = fs.statSync(presetPath);
  let replaced = false;
  t.mock.method(fs, "readFileSync", (path: Parameters<typeof readFileSync>[0], options?: Parameters<typeof readFileSync>[1]) => {
    const value = actualReadFileSync(path, options as never);
    const opened = typeof path === "number" ? fs.fstatSync(path) : null;
    const selectedFile = path === presetPath || opened?.dev === presetIdentity.dev && opened?.ino === presetIdentity.ino;
    if (!replaced && selectedFile) {
      replaced = true;
      writeFileSync(presetPath, replacement);
    }
    return value;
  });
  syncBuiltinESMExports();
  try {
    output = "";
    errors = "";
    assert.equal(await invoke(["use", "mine", "--json"]), 1);
    assert.equal(replaced, true, "the replacement race did not run");
    const payload = JSON.parse(output) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.match(payload.error, /changed after the diff was prepared/);
    assert.equal(actualReadFileSync(paths().config, "utf8"), beforeConfig);
    assert.equal(actualReadFileSync(paths().tone, "utf8"), beforeTone);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("import is gated and does not rewrite config or the compiled artifact", async () => {
  assert.equal(await invoke(["init", "--here", "--tools", "none", "--auto"]), 0, errors);
  const beforeConfig = readFileSync(paths().config, "utf8");
  const beforeTone = readFileSync(paths().tone, "utf8");
  const source = join(scratch, "import.json");
  writeFileSync(source, JSON.stringify({ schema: 1, slug: "mine", displayName: "Mine", values: { warmth: 5 } }));

  assert.equal(await invoke(["import", source]), 0, errors);
  const journal = journalWith([join(customPresetDir(paths().presets), "mine.json")]);
  assert.deepEqual(journal.actions.map((action) => action.path), [join(customPresetDir(paths().presets), "mine.json")]);
  assert.equal(readFileSync(paths().config, "utf8"), beforeConfig);
  assert.equal(readFileSync(paths().tone, "utf8"), beforeTone);
});

test("project export rejects a state alias before creating or changing any output", async () => {
  assert.equal(await invoke(["init", "--here", "--tools", "none", "--auto"]), 0, errors);
  const beforeConfig = readFileSync(paths().config, "utf8");
  const beforeTone = readFileSync(paths().tone, "utf8");
  // The project root is deliberately inside the state root. The explicit export destination is
  // therefore a second route into shared state, even though no project files exist yet.
  project = join(state, "project");
  assert.equal(await invoke(["use", "tough-love", "--project", "."]), 1);
  assert.equal(errors, `${catalogue("en").cli.errors.stateInstructionOverlap(paths().root)}\n`);
  assert.equal(readFileSync(paths().config, "utf8"), beforeConfig);
  assert.equal(readFileSync(paths().tone, "utf8"), beforeTone);
  assert.equal(existsSync(join(project, ".tonedial")), false);
});

test("compile --check remains read-only", async () => {
  assert.equal(await invoke(["init", "--here", "--tools", "none", "--auto"]), 0, errors);
  const before = inspectOperations(paths()).journals.length;
  const config = readFileSync(paths().config, "utf8");
  const tone = readFileSync(paths().tone, "utf8");
  assert.equal(await invoke(["compile", "--check"]), 0, errors);
  assert.equal(inspectOperations(paths()).journals.length, before);
  assert.equal(readFileSync(paths().config, "utf8"), config);
  assert.equal(readFileSync(paths().tone, "utf8"), tone);
});

test("edit preserves the staged copy when the original changes while the editor is open", async () => {
  assert.equal(await invoke(["init", "--here", "--tools", "none", "--auto"]), 0, errors);
  const original = readFileSync(paths().config, "utf8");
  const edited = JSON.parse(original) as Record<string, unknown>;
  edited.axes = { ...(edited.axes as Record<string, unknown>), verbosity: 5 };
  const replacement = join(scratch, "replacement.json");
  writeFileSync(replacement, JSON.stringify(edited, null, 2));
  const editor = join(scratch, "editor.sh");
  writeFileSync(editor, `#!/bin/sh\nprintf '%s\\n' 'external change' > ${JSON.stringify(paths().config)}\ncat ${JSON.stringify(replacement)} > "$1"\n`);

  output = "";
  assert.equal(await invoke(["edit", "--json"], { EDITOR: `sh ${editor}` }), 1);
  const payload = JSON.parse(output) as { ok: boolean; error: string };
  assert.equal(payload.ok, false);
  assert.match(payload.error, /edited copy is preserved here/);
  assert.equal(readFileSync(paths().config, "utf8"), "external change\n");
  const preserved = payload.error.match(/preserved here:\n([^\n]+)/)?.[1];
  assert.ok(preserved && existsSync(preserved), "the stale edited copy was not preserved");
  rmSync(dirname(preserved), { recursive: true, force: true });
});

test("edit preserves the staged copy when the apply owner is busy", async () => {
  assert.equal(await invoke(["init", "--here", "--tools", "none", "--auto"]), 0, errors);
  const original = readFileSync(paths().config, "utf8");
  const edited = JSON.stringify({
    ...(JSON.parse(original) as Record<string, unknown>),
    axes: { ...(JSON.parse(original) as { axes: Record<string, unknown> }).axes, verbosity: 5 },
  }, null, 2);
  const replacement = join(scratch, "busy-replacement.json");
  writeFileSync(replacement, edited);
  const editor = join(scratch, "busy-editor.sh");
  writeFileSync(
    editor,
    `#!/bin/sh\nmkdir -p ${JSON.stringify(paths().operationsLock)}\ncat ${JSON.stringify(replacement)} > "$1"\n`,
  );

  output = "";
  errors = "";
  assert.equal(await invoke(["edit", "--json"], { EDITOR: `sh ${editor}` }), 1);
  assert.equal(readFileSync(paths().config, "utf8"), original, "a busy apply changed the original");
  const payload = JSON.parse(output) as { ok: boolean; error: string };
  assert.equal(payload.ok, false);
  assert.match(payload.error, /Edited copy preserved at:/);
  const preserved = payload.error.match(/preserved at:\n([^\n]+)/)?.[1];
  assert.ok(preserved && existsSync(preserved), "the busy apply discarded the staged copy");
  assert.equal(readFileSync(preserved, "utf8"), edited);
  rmSync(dirname(preserved), { recursive: true, force: true });
});

test("edit preserves the staged copy when artifact planning fails before apply", async () => {
  assert.equal(await invoke(["init", "--here", "--tools", "none", "--auto"]), 0, errors);
  const original = readFileSync(paths().config, "utf8");
  const edited = JSON.stringify({
    ...JSON.parse(original),
    axes: { ...JSON.parse(original).axes, verbosity: 5 },
  }, null, 2);
  const replacement = join(scratch, "planning-replacement.json");
  writeFileSync(replacement, edited);
  const editor = join(scratch, "planning-editor.sh");
  writeFileSync(editor, `#!/bin/sh\nmv ${JSON.stringify(paths().tone)} ${JSON.stringify(join(scratch, "old-tone.md"))}\nmkdir ${JSON.stringify(paths().tone)}\ncat ${JSON.stringify(replacement)} > "$1"\n`);

  output = "";
  assert.equal(await invoke(["edit", "--json"], { EDITOR: `sh ${editor}` }), 1);
  assert.equal(readFileSync(paths().config, "utf8"), original);
  assert.equal(fs.lstatSync(paths().tone).isDirectory(), true);
  const payload = JSON.parse(output) as { ok: boolean; error: string };
  assert.equal(payload.ok, false);
  const preserved = payload.error.match(/preserved at:\n([^\n]+)/)?.[1];
  assert.ok(preserved && existsSync(preserved), "planning failure discarded the user's edit");
  assert.equal(readFileSync(preserved, "utf8"), edited);
  rmSync(dirname(preserved), { recursive: true, force: true });
});
