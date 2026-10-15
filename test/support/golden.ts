import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative as relativePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { run, VERSION } from "../../src/cli.ts";
import { AXIS_ORDER } from "../../src/core/anchors.ts";
import { catalogue, type Language } from "../../src/core/i18n.ts";
import { BUNDLED, applyPreset } from "../../src/core/presets.ts";
import { dial } from "../../src/ui/dial.ts";
import { palette } from "../../src/ui/style.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROJECT_ROOT = dirname(ROOT);
const GOLDEN_ROOT = join(ROOT, "golden");
const LANGUAGES = ["en", "ko"] as const satisfies readonly Language[];

export type GoldenLanguage = (typeof LANGUAGES)[number];

export type CliCapture = {
  status: number;
  stdout: string;
  stderr: string;
};

export type GoldenWorkspace = {
  root: string;
  project: string;
  state: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  dispose: () => void;
};

export type DialFrameScenario = "pending" | "help" | "too-small";

export type DialFrameCapture = {
  language: GoldenLanguage;
  scenario: DialFrameScenario;
  columns: number;
  rows: number;
  ansi: string;
  visible: string;
};

/** Select a locale strictly; a misspelled CI matrix value must fail the test process. */
export function selectedGoldenLanguages(env: NodeJS.ProcessEnv = process.env): GoldenLanguage[] {
  if (!Object.hasOwn(env, "TONEDIAL_TEST_LANG")) return [...LANGUAGES];
  const value = env.TONEDIAL_TEST_LANG;
  if (value === undefined || !LANGUAGES.includes(value as GoldenLanguage)) {
    throw new Error(`TONEDIAL_TEST_LANG must be one of ${LANGUAGES.join(" or ")}; received ${JSON.stringify(value)}`);
  }
  return [value as GoldenLanguage];
}

export function goldenUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.TONEDIAL_GOLDEN_UPDATE;
  if (value === undefined) return false;
  if (value !== "1") throw new Error("TONEDIAL_GOLDEN_UPDATE must be 1 when set");
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "false") {
    throw new Error("TONEDIAL_GOLDEN_UPDATE=1 is forbidden in CI");
  }
  return true;
}

/** The golden suite owns only its disposable root; it never observes the maintainer's home. */
export function createGoldenWorkspace(language: GoldenLanguage): GoldenWorkspace {
  // Host tmpdir aliases must not add real-path receipt lines to otherwise identical fixtures.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tonedial-golden-")));
  const project = join(root, "project");
  const state = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(project);
  mkdirSync(bin);

  // `test codex --dry-run` still checks PATH. The executable is never launched: the command's
  // dry-run path stops after composing its protected invocation preview.
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, "#!/bin/sh\nprintf 'unexpected fake codex launch\\n' >&2\nexit 97\n", { mode: 0o700 });
  chmodSync(fakeCodex, 0o700);

  const env: NodeJS.ProcessEnv = {
    HOME: root,
    TONEDIAL_HOME: state,
    PATH: bin,
    LANG: language === "ko" ? "ko_KR.UTF-8" : "en_US.UTF-8",
    TERM: "dumb",
    COLUMNS: "80",
    NO_COLOR: "1",
    TONEDIAL_INSTALL_SHAPE: "npm",
    EDITOR: "/bin/true",
  };
  return {
    root,
    project,
    state,
    bin,
    env,
    cwd: project,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function textChunk(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

/** Capture the public CLI entry point, keeping streams and status as separate obligations. */
export async function captureCli(workspace: GoldenWorkspace, args: string[]): Promise<CliCapture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(textChunk(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(textChunk(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const status = await run(args, workspace.env, workspace.cwd, false, false);
    return { status, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

/** Replace only values proven to vary between source/public checkouts or disposable runs. */
export function normalizeCapture(
  capture: CliCapture,
  workspace: GoldenWorkspace,
): CliCapture {
  const roots = [realpathSync(workspace.root), workspace.root];
  const normalize = (text: string): string => text
      .replaceAll(roots[0]!, "<ROOT>")
      .replaceAll(roots[1]!, "<ROOT>")
      .replaceAll(process.versions.node, "<NODE_VERSION>")
      .replaceAll(VERSION, "<VERSION>");
  return { status: capture.status, stdout: normalize(capture.stdout), stderr: normalize(capture.stderr) };
}

/** Keep stream boundaries visible in a human-readable fixture without changing their bytes. */
export function formatCapture(capture: CliCapture): string {
  const section = (label: string, text: string): string =>
    `${label} [bytes=${Buffer.byteLength(text, "utf8")}; endsWithNewline=${text.endsWith("\n")}]\n` +
    `${text}${text.endsWith("\n") ? "" : "\n"}`;
  return `status: ${capture.status}\n${section("--- stdout ---", capture.stdout)}${section("--- stderr ---", capture.stderr)}`;
}

export function goldenPath(language: GoldenLanguage, area: "commands" | "errors" | "frames", name: string): string {
  return join(ROOT, "golden", language, area, `${name}.txt`);
}

/** Directory containing raw expected/actual files for one failed golden. */
export function goldenArtifactDirectory(path: string): string {
  const relative = relativePath(GOLDEN_ROOT, path);
  if (relative === ".." || relative.startsWith(`..${sep}`)) {
    return join(PROJECT_ROOT, "artifacts", "golden", "external", basename(path, extname(path)));
  }
  const parts = relative.split(sep);
  const file = parts.pop() ?? "capture.txt";
  parts.push(file.endsWith(".txt") ? file.slice(0, -4) : file);
  return join(PROJECT_ROOT, "artifacts", "golden", ...parts);
}

function writeGoldenFailure(path: string, actual: string): string {
  const directory = goldenArtifactDirectory(path);
  const expected = existsSync(path) ? readFileSync(path, "utf8") : "";
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "actual.txt"), actual);
  writeFileSync(join(directory, "expected.txt"), expected);
  writeFileSync(join(directory, "diff.txt"), goldenDiff(expected, actual));
  return directory;
}

export function goldenDiff(expected: string, actual: string): string {
  const before = expected.split("\n");
  const after = actual.split("\n");
  const lines = ["--- expected", "+++ actual"];
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    if (before[index] === after[index]) continue;
    lines.push(`@@ line ${index + 1} @@`);
    if (before[index] !== undefined) lines.push(`-${before[index]}`);
    if (after[index] !== undefined) lines.push(`+${after[index]}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Assert or explicitly record a golden. CI can never rewrite the checked-in contract. */
export function assertGolden(path: string, actual: string, env: NodeJS.ProcessEnv = process.env): void {
  if (goldenUpdateEnabled(env)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  if (!existsSync(path)) {
    const artifacts = writeGoldenFailure(path, actual);
    throw new Error(`missing golden ${path}; raw capture written to ${artifacts}; run with TONEDIAL_GOLDEN_UPDATE=1 outside CI`);
  }
  const expected = readFileSync(path, "utf8");
  if (actual !== expected) {
    const artifacts = writeGoldenFailure(path, actual);
    assert.fail(`golden mismatch: ${path}; raw expected/actual captures written to ${artifacts}`);
  }
}

function fakeInput(): EventEmitter & NodeJS.ReadStream {
  const input = new EventEmitter() as EventEmitter & NodeJS.ReadStream;
  Object.assign(input, {
    isTTY: false,
    isRaw: false,
    resume: () => input,
    pause: () => input,
    press: (name: string, sequence = "") => input.emit("keypress", sequence, { name, sequence }),
  });
  return input;
}

function fakeOutput(columns: number, rows: number): { output: EventEmitter & NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const output = new EventEmitter() as EventEmitter & NodeJS.WriteStream;
  Object.assign(output, {
    columns,
    rows,
    isTTY: false,
    write: (text: string) => (writes.push(text), true),
  });
  return { output, writes };
}

function lastFrame(writes: string[]): string {
  const frame = writes.filter((text) => text.endsWith("\n")).at(-1);
  assert.ok(frame !== undefined, "the dial did not render a complete frame");
  return frame;
}

/** Capture the existing inline dial renderer for both golden text and the SVG image owner. */
export async function captureDialFrame(
  language: GoldenLanguage,
  scenario: DialFrameScenario,
  columns = language === "ko" ? 60 : 80,
): Promise<DialFrameCapture> {
  const rows = 24;
  const preset = BUNDLED.find((entry) => entry.slug === "caring-brother")!;
  const input = fakeInput();
  const { output, writes } = fakeOutput(columns, rows);
  const pending = dial(
    applyPreset(preset),
    palette("always", {}, false, columns - 1),
    catalogue(language),
    input,
    output,
    { presetName: preset.displayName },
  );
  if (scenario === "pending") {
    for (let index = 0; index < AXIS_ORDER.indexOf("warmth"); index++) input.emit("keypress", "", { name: "down" });
    input.emit("keypress", "", { name: "left" });
  } else if (scenario === "help") {
    input.emit("keypress", "?", { name: "?", sequence: "?" });
  } else {
    Object.assign(output, { columns: 45, rows: 10 });
    output.emit("resize");
  }
  const ansi = lastFrame(writes);
  input.emit("keypress", "", { name: "escape" });
  await pending;
  return {
    language,
    scenario,
    columns,
    rows,
    ansi,
    visible: stripVTControlCharacters(ansi).slice(0, -1),
  };
}
