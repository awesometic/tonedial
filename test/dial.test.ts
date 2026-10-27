// Fake keys cover interaction and rendered frames, not real-terminal usability after exit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";

import { AXIS_DEFAULT, AXIS_ORDER } from "../src/core/anchors.ts";
import { dial } from "../src/ui/dial.ts";
import { catalogue, LANGUAGES } from "../src/core/i18n.ts";
import { maxCells } from "../src/ui/width.ts";

const COPY = catalogue("en");
const EN = COPY.cli;
import { palette } from "../src/ui/style.ts";

const PLAIN = palette("never", {}, false);

/** Enough of a stdin for `emitKeypressEvents` to be a no-op and for us to emit our own. */
function fakeStdin() {
  const stream = new EventEmitter() as unknown as NodeJS.ReadStream & { press: (name: string, seq?: string) => void };
  Object.assign(stream, {
    isTTY: false,
    isRaw: false,
    setRawMode: () => stream,
    resume: () => stream,
    pause: () => stream,
    press: (name: string, sequence?: string) => stream.emit("keypress", sequence ?? "", { name, sequence }),
  });
  return stream;
}

function fakeStdout(columns?: number, rows?: number) {
  const written: string[] = [];
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream;
  Object.assign(stream, { columns, rows, isTTY: columns !== undefined, write: (s: string) => (written.push(s), true) });
  return { written, stream };
}

/** Run the dial, feed it keys once it is listening, and resolve with its result. */
async function drive(keys: [string, string?][], start = { ...AXIS_DEFAULT }) {
  const stdin = fakeStdin();
  const { stream: stdout, written } = fakeStdout();
  const result = dial(start, PLAIN, COPY, stdin, stdout);
  for (const [name, seq] of keys) stdin.press(name, seq);
  return { axes: await result, written };
}

test("the arrows move the cursor and change the level under it", async () => {
  const { axes } = await drive([["down"], ["down"], ["down"], ["right"], ["right"], ["return"]]);
  assert.equal(axes!.playfulness, 5, "3 + 2");
  assert.equal(axes!.formality, AXIS_DEFAULT.formality, "and nothing else moved");
});

test("vim motions do what the arrows do, because both are expected", async () => {
  const viaArrows = await drive([["down"], ["right"], ["return"]]);
  const viaVim = await drive([["j"], ["l"], ["return"]]);
  assert.deepEqual(viaVim.axes, viaArrows.axes);
});

test("a digit sets the level directly", async () => {
  const { axes } = await drive([["1", "1"], ["return"]]);
  assert.equal(axes!.formality, 1);
});

test("levels clamp at 1 and 5 rather than wrapping or overflowing", async () => {
  const low = await drive([["left"], ["left"], ["left"], ["left"], ["left"], ["return"]]);
  assert.equal(low.axes!.formality, 1);
  const high = await drive([["right"], ["right"], ["right"], ["right"], ["right"], ["return"]]);
  assert.equal(high.axes!.formality, 5);
});

test("the cursor wraps around the ends of the list", async () => {
  // Up from the first axis lands on the last one, which is what a twelve-row list should do.
  const { axes } = await drive([["up"], ["right"], ["return"]]);
  assert.equal(axes![AXIS_ORDER.at(-1)!], AXIS_DEFAULT.bravado + 1);
});

test("Esc, q, and Ctrl+C all leave the levels alone", async () => {
  for (const keys of [[["right"], ["escape"]], [["right"], ["q"]]] as [string, string?][][]) {
    const { axes } = await drive(keys);
    assert.equal(axes, null, "cancelling returns nothing rather than the edited values");
  }
  const stdin = fakeStdin();
  const { stream } = fakeStdout();
  const result = dial({ ...AXIS_DEFAULT }, PLAIN, COPY, stdin, stream);
  stdin.emit("keypress", "", { name: "c", ctrl: true });
  assert.equal(await result, null, "Ctrl+C belongs to the terminal and is not rebound");
});

test("the block is erased on the way out, so the receipt lands where it was", async () => {
  const { written } = await drive([["down"], ["return"]]);
  const all = written.join("");
  // `clearScreenDown` writes the erase sequence; the last thing the dial does is one of those
  // with nothing printed after it.
  assert.match(all, /\x1b\[0J/, "it clears what it drew");
  assert.equal(all.endsWith("\x1b[0J"), true, "and nothing is drawn afterwards");
});

test("what it returns is a new object, so a cancelled dial cannot have edited the caller's", async () => {
  const start = { ...AXIS_DEFAULT };
  const { axes } = await drive([["right"], ["return"]], start);
  assert.equal(start.formality, AXIS_DEFAULT.formality, "the caller's copy is untouched");
  assert.equal(axes!.formality, AXIS_DEFAULT.formality + 1);
});

function inlineFrame(written: string[]): string[] {
  const frames = written.filter((part) => part.endsWith("\n"));
  assert.ok(frames.length > 0, "the inline dial rendered a frame");
  return stripVTControlCharacters(frames.at(-1)!).slice(0, -1).split("\n");
}

test("new language copy keeps every axis editable at the 60 by 24 floor", async () => {
  for (const language of ["ja", "zh", "es"] as const) {
    const stdin = fakeStdin();
    const { stream, written } = fakeStdout(60, 24);
    const result = dial({ ...AXIS_DEFAULT }, PLAIN, catalogue(language), stdin, stream);
    try {
      for (const axis of AXIS_ORDER) {
        const lines = inlineFrame(written);
        assert.ok(lines.find(line => line.startsWith("> "))?.includes(axis), `${language}/${axis}: navigation stopped`);
        assert.ok(lines.length < 24);
        for (const line of lines) assert.ok(maxCells(line) < 60, `${language}: ${line}`);
        stdin.press("5", "5");
        stdin.press("down");
      }
      stdin.press("return");
      const applied = await result;
      assert.ok(applied, `${language}: apply must remain available`);
      assert.deepEqual(Object.values(applied), AXIS_ORDER.map(() => 5));
    } finally {
      stdin.press("escape");
      await result;
    }
  }
});

test("inline keeps one ordered gauge list, selected semantics and actions within each viewport", async () => {
  for (const { language, columns, color } of [
    { language: "ko", columns: 60, color: "never" },
    { language: "en", columns: 80, color: "never" },
    { language: "en", columns: 120, color: "never" },
    { language: "ko", columns: 60, color: "always" },
    { language: "en", columns: 80, color: "always" },
    { language: "ko", columns: 120, color: "always" },
  ] as const) {
    const rows = 24;
    const copy = catalogue(language);
    const stdin = fakeStdin();
    const { stream, written } = fakeStdout(columns, rows);
    const paint = palette(color, {}, true);
    const presetName = columns === 60 ? "선생님👩‍💻".repeat(12) : "Tough Love";
    const result = dial({ ...AXIS_DEFAULT, critique: 4, flattery: 3, refusal: 2 }, paint, copy, stdin, stream, { presetName });
    try {
      const statusBefore = inlineFrame(written)[1];
      stdin.press("down");
      stdin.press("5", "5");
      const lines = inlineFrame(written);
      assert.ok(lines.length < rows, "the inline block leaves one row for its cursor");
      for (const line of lines) assert.ok(maxCells(line) <= columns - 1, `${columns} columns: ${line}`);
      const gauges = lines.filter((line) => /[▮▯]/u.test(line));
      assert.deepEqual(gauges.map((line) => AXIS_ORDER.find((axis) => line.includes(axis))), AXIS_ORDER);
      assert.ok(gauges.find((line) => line.startsWith("> "))?.includes("verbosity"), "selection follows the cursor");
      const visible = lines.join("\n");
      assert.notEqual(lines[1], statusBefore, "editing changes the visible status, not just its color");
      if (language === "en") assert.match(lines[1]!, /changes pending/, "the rendered status names uncommitted changes");
      assert.ok(visible.includes(copy.cli.artifact.currentLevel));
      assert.ok(visible.includes(columns === 60 ? copy.cli.artifact.defaultLevelShort : copy.cli.artifact.defaultLevel));
      for (const axis of ["critique", "flattery", "refusal"]) {
        assert.ok(gauges.find((line) => line.includes(axis))!.includes("!"), `${columns}: ${axis} advisory marker survives`);
      }
      assert.ok(visible.includes(copy.cli.artifact.riskMarker), "the full preview explains the risk marker");
      assert.ok(visible.includes(copy.axisHints.verbosity!.owns), "selected detail comes from the interface catalogue");
      assert.ok(visible.includes(copy.axisHints.verbosity!.high), "the endpoint is visible before commit");
      assert.ok(visible.includes(copy.cli.artifact.dialPreview("", true).trim()), "pending status survives a long preset name");
      if (columns === 60) assert.ok(visible.includes("…"), "the oversized CJK/emoji preset name is visibly shortened");
      else assert.ok(visible.includes(presetName), "a short preset name is kept");
      assert.ok(visible.includes(copy.cli.artifact.dialActions), "apply, discard and help stay visible");
      assert.doesNotMatch(written.join(""), /\x1b\[\?1049[hl]/, "the summon-and-adjust dial stays inline");
      stdin.press("return");
      assert.equal((await result)!.verbosity, 5, "the dial commits the same ordinal values");
    } finally {
      stdin.press("q");
    }
  }
});

test("every localized axis hint keeps the pending dial editable at 60 × 24 and 80 × 24", async () => {
  for (const language of LANGUAGES) {
    const copy = catalogue(language);
    for (const columns of [60, 80] as const) {
      const stdin = fakeStdin();
      const { stream, written } = fakeStdout(columns, 24);
      const result = dial({ ...AXIS_DEFAULT }, PLAIN, copy, stdin, stream, {
        presetName: "A deliberately long profile name that must not steal rows from the dial",
      });
      try {
        stdin.press("right");
        for (const axis of AXIS_ORDER) {
          const lines = inlineFrame(written);
          const visible = lines.join("\n");
          assert.ok(lines.length < 24, `${language}/${columns}/${axis}: the dial needs a cursor row`);
          assert.equal(lines.filter((line) => /[▮▯]/u.test(line)).length, AXIS_ORDER.length,
            `${language}/${columns}/${axis}: normal size fell back to the small-terminal notice`);
          assert.ok(lines.some((line) => line.startsWith("> ") && line.includes(axis)), `${language}/${columns}/${axis}: selection disappeared`);
          assert.ok(visible.includes(copy.axisHints[axis]!.owns), `${language}/${columns}/${axis}: ownership hint is hidden`);
          assert.ok(visible.includes(copy.axisHints[axis]!.low), `${language}/${columns}/${axis}: low endpoint is hidden`);
          assert.ok(visible.includes(copy.axisHints[axis]!.high), `${language}/${columns}/${axis}: high endpoint is hidden`);
          assert.ok(visible.includes(copy.cli.artifact.dialActions), `${language}/${columns}/${axis}: actions are hidden`);
          stdin.press("down");
        }
      } finally {
        stdin.press("q");
        await result;
      }
    }
  }
});

test("preset headers normalize newlines and terminal controls before viewport accounting", async () => {
  const stdin = fakeStdin();
  const { stream, written } = fakeStdout(80, 24);
  const result = dial({ ...AXIS_DEFAULT }, PLAIN, COPY, stdin, stream, {
    presetName: "Tough\nLove\r\u001b[2J\u001b[8B\t\u0007",
  });
  try {
    const frame = written.find(part => part.endsWith("\n"))!;
    assert.equal(frame.includes("\u001b[2J"), false, "the user label cannot clear the screen");
    assert.equal(frame.includes("\u001b[8B"), false, "the user label cannot move the cursor");
    assert.equal(/[\r\t\u0007]/u.test(frame), false);
    const lines = inlineFrame(written);
    assert.ok(lines.length < 24);
    assert.ok(lines[1]!.includes("Tough Love"));
    assert.equal(lines.filter(line => /[▮▯]/u.test(line)).length, AXIS_ORDER.length);
    assert.ok(lines.at(-1)!.includes("Enter apply"));
    stdin.press("right");
    stdin.press("return");
    assert.equal((await result)!.formality, AXIS_DEFAULT.formality + 1);
  } finally { stdin.press("q"); }
});

test("a resize below the minimum blocks edits and commit, then restores the preview at actual stream size", async () => {
  const copy = catalogue("en");
  const stdin = fakeStdin();
  const { stream, written } = fakeStdout(80, 24);
  const result = dial({ ...AXIS_DEFAULT }, { ...PLAIN, width: 200 }, copy, stdin, stream);
  let settled = false;
  void result.then(() => { settled = true; });
  try {
    stdin.press("right");
    Object.assign(stream, { columns: 45, rows: 10 });
    stream.emit("resize");
    const small = inlineFrame(written);
    assert.ok(small.join(" ").includes("Terminal too small."));
    assert.ok(small.length < 10);
    for (const line of small) assert.ok(maxCells(line) <= 44, line);
    stdin.press("1", "1");
    stdin.press("return");
    await Promise.resolve();
    assert.equal(settled, false, "Enter cannot commit while the preview is hidden");
    Object.assign(stream, { columns: 60, rows: 24 });
    stream.emit("resize");
    const restored = inlineFrame(written);
    assert.ok(restored.length < 24);
    for (const line of restored) assert.ok(maxCells(line) <= 59, line);
    assert.ok(restored.some((line) => line.startsWith("> ") && line.includes("formality")));
    stdin.press("return");
    assert.equal((await result)!.formality, AXIS_DEFAULT.formality + 1, "small-window input left the preview untouched");
  } finally {
    stdin.press("q");
  }
});

test("inline help shows every binding and cannot edit or apply its hidden preview", async () => {
  const copy = catalogue("en");
  const stdin = fakeStdin();
  const { stream, written } = fakeStdout(60, 24);
  const result = dial({ ...AXIS_DEFAULT }, PLAIN, copy, stdin, stream);
  let settled = false;
  void result.then(() => { settled = true; });
  try {
    stdin.press("right");
    stdin.press("?", "?");
    const shown = inlineFrame(written).join("\n");
    assert.ok(shown.includes(EN.artifact.dialHelpTitle));
    for (const binding of EN.artifact.dialHelp) assert.ok(shown.includes(binding), binding);
    stdin.press("1", "1");
    stdin.press("return");
    await Promise.resolve();
    assert.equal(settled, false, "help cannot apply an unseen preview");
    stdin.press("?", "?");
    assert.ok(inlineFrame(written).join("\n").includes(EN.artifact.dialTitle));
    stdin.press("return");
    assert.equal((await result)!.formality, AXIS_DEFAULT.formality + 1);
  } finally {
    stdin.press("q");
  }
});

test("a rendering or stream error rejects the dial and removes its live input/resize/signal listeners", async () => {
  for (const failure of ["write", "event"] as const) {
    const signals = ["exit", "SIGINT", "SIGTERM", "SIGTSTP", "SIGCONT", "uncaughtExceptionMonitor"] as const;
    const before = signals.map((signal) => process.listenerCount(signal));
    const stdin = fakeStdin();
    const { stream } = fakeStdout();
    const error = new Error("screen failed");
    if (failure === "write") stream.write = () => { throw error; };
    const result = dial({ ...AXIS_DEFAULT }, PLAIN, COPY, stdin, stream);
    if (failure === "event") stream.emit("error", error);
    await assert.rejects(result, (caught) => caught === error, "the original failure reaches the caller");
    assert.equal(stdin.listenerCount("keypress"), 0, "failed input cannot mutate a dial that is over");
    assert.equal(stream.listenerCount("resize"), 0, "failed output cannot restart painting");
    assert.deepEqual(signals.map((signal) => process.listenerCount(signal)), before, "short-lived terminal guards do not accumulate");
  }
});
