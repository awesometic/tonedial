// One inline preview shares the printed gauge renderer and restores the terminal on exit.

import { emitKeypressEvents, clearScreenDown, moveCursor } from "node:readline";
import { stripVTControlCharacters } from "node:util";

import { AXIS_ORDER, type Axes, type Axis, type Level } from "../core/anchors.ts";
import { readDisplayName } from "../core/presets.ts";
import { gaugeBlock, gaugeHeader } from "./gauge.ts";
import { guardTerminal } from "./prompt.ts";
import type { Catalogue } from "../core/i18n.ts";
import type { Palette } from "./style.ts";
import { UNKNOWN_WIDTH, maxCells, resolveBudget, truncate, wrap } from "./width.ts";

type Key = { name?: string; sequence?: string; ctrl?: boolean };

export type DialOptions = { presetName?: string };

/**
 * Turn the dial. Resolves to the new axis values, or `null` when the user backed out.
 *
 * The caller owns everything else: this reads no config, writes no file, and recompiles
 * nothing. It is a function from one set of levels to another that happens to ask a person.
 */
export function dial(
  start: Axes,
  ui: Palette,
  copy: Catalogue,
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
  options: DialOptions = {},
): Promise<Axes | null> {
  const t = copy.cli;
  const axes: Axes = { ...start };
  let cursor = 0;
  let painted = 0;
  let help = false;
  let finished = false;

  const size = () => ({
    columns: Number.isFinite(stdout.columns) ? Math.max(0, Math.floor(stdout.columns)) : UNKNOWN_WIDTH + 1,
    rows: Number.isFinite(stdout.rows) ? Math.max(0, Math.floor(stdout.rows)) : 24,
  });

  const frame = (): { lines: string[]; editable: boolean } => {
    const { columns, rows } = size();
    const width = columns < 2 ? 0 : resolveBudget(columns);
    const paint = { ...ui, width };
    const indented = (text: string) => wrap(text, Math.max(1, width - 2)).map((line) => `  ${ui.dim(line)}`);
    // The trailing newline needs a cursor row. Never crop a preview and still offer Apply.
    const availableRows = Math.max(0, rows - 1);
    const tooSmall = () => {
      if (width < 2 || availableRows === 0) return { lines: [], editable: false };
      const cancel = wrap(t.artifact.dialCancelKeys, width).slice(0, availableRows);
      const notice = wrap(t.artifact.dialTooSmall, width).slice(0, Math.max(0, availableRows - cancel.length - 1));
      return { lines: [...notice, ...(notice.length ? [""] : []), ...cancel], editable: false };
    };
    if (columns < 60 || rows < 24) return tooSmall();

    const changed = AXIS_ORDER.some((axis) => axes[axis] !== start[axis]);
    const nameBudget = width - 2 - maxCells(t.artifact.dialPreview("", changed));
    const name = truncate(readDisplayName(options.presetName, t.preset.unsaved), Math.max(2, nameBudget));
    const body = [
      `  ${ui.bold(truncate(help ? t.artifact.dialHelpTitle : t.artifact.dialTitle, width - 2))}`,
      `  ${(changed ? ui.warn : ui.accent)(t.artifact.dialPreview(name, changed))}`,
      "",
    ];
    let footer: string[];
    if (help) {
      body.push(...t.artifact.dialHelp.flatMap(indented));
      footer = indented(t.artifact.dialHelpKeys);
    } else {
      const axis = AXIS_ORDER[cursor]!;
      const hint = copy.axisHints[axis]!;
      const detail = (budget: number) => [
        ...wrap(`${axis}  ${hint.owns}`, budget).map((line) => ui.bold(line)),
        ...wrap(`1  ${hint.low}`, budget),
        ...wrap(`5  ${hint.high}`, budget),
      ];
      const gauges = [gaugeHeader(paint, t), ...gaugeBlock(axes, paint, cursor)];
      if (width >= 119) {
        const column = Math.max(...gauges.map((line) => maxCells(stripVTControlCharacters(line))));
        const beside = detail(width - column - 4);
        for (let index = 0; index < Math.max(gauges.length, beside.length); index++) {
          const line = gauges[index] ?? "";
          body.push(beside[index] === undefined ? line
            : `${line}${" ".repeat(column - maxCells(stripVTControlCharacters(line)) + 4)}${beside[index]}`);
        }
      } else {
        body.push(...gauges, "", ...detail(width - 2).map((line) => `  ${line}`));
      }
      footer = [...indented(t.artifact.dialKeys), ...indented(t.artifact.dialActions)];
    }

    const lines = [...body, "", ...footer];
    return lines.length > availableRows ? tooSmall() : { lines, editable: !help };
  };

  // Clear the owned visible block. Resize reflow can strand older rows in normal-buffer
  // history; never guess extra cursor movement or clear scrollback at the user's expense.
  // Complete resize-history removal would need an explicit terminal-buffer ownership contract.
  const erase = () => {
    if (painted > 0) {
      moveCursor(stdout, 0, -painted);
      clearScreenDown(stdout);
      painted = 0;
    }
  };

  const draw = () => {
    if (finished) return;
    const { lines } = frame();
    erase();
    if (!lines.length) return;
    stdout.write(`${lines.join("\n")}\n`);
    painted = lines.length;
  };

  return new Promise((resolve, reject) => {
    let release: ReturnType<typeof guardTerminal> | undefined;

    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      stdin.removeListener("error", fail);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      stdout.removeListener("error", fail);
      stdout.removeListener("resize", redraw);
      try { release?.(); } finally { stdin.pause(); }
    };
    const finish = (result: Axes | null) => {
      if (finished) return;
      finished = true;
      try {
        cleanup();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };
    function fail(error: unknown) {
      if (finished) return;
      finished = true;
      // Preserve the original stream/render failure if restoring that same stream also fails.
      try { cleanup(); } catch { /* the original failure remains the rejection */ }
      reject(error);
    }
    function onEnd() { finish(null); }
    function redraw() {
      try { draw(); } catch (error) { fail(error); }
    }

    const move = (axis: Axis, by: number) => {
      const next = Math.min(5, Math.max(1, axes[axis] + by));
      axes[axis] = next as Level;
    };

    function onKey(_: string, key: Key) {
      if (finished) return;
      try { handleKey(key); } catch (error) { fail(error); }
    }

    function handleKey(key: Key) {
      if (!key) return;
      if (key.ctrl && key.name === "c") return finish(null);
      if (key.ctrl && key.name === "z") return release?.suspend();
      if (key.ctrl) return;
      if (key.name === "escape" || key.name === "q") return finish(null);
      if (key.sequence === "?" || key.name === "?") {
        help = !help;
        return draw();
      }
      // Help and small windows hide the preview. Neither accepts edits or Apply.
      if (!frame().editable) return;

      const axis = AXIS_ORDER[cursor]!;
      switch (key.name) {
        case "up":
        case "k":
          cursor = (cursor - 1 + AXIS_ORDER.length) % AXIS_ORDER.length;
          break;
        case "down":
        case "j":
        case "tab":
          cursor = (cursor + 1) % AXIS_ORDER.length;
          break;
        case "left":
        case "h":
          move(axis, -1);
          break;
        case "right":
        case "l":
          move(axis, +1);
          break;
        case "return":
        case "enter":
          return finish(axes);
        default: {
          // Both arrows and vim motions above, and a digit here: a level is a number one to
          // five, so typing it is the shortest path to a value you already know you want.
          const digit = Number(key.sequence);
          if (!Number.isInteger(digit) || digit < 1 || digit > 5) return;
          axes[axis] = digit as Level;
        }
      }
      draw();
    }

    try {
      release = guardTerminal(stdin, stdout, {
        raw: true,
        onRestore: erase,
        onResume: redraw,
      });
      emitKeypressEvents(stdin);
      stdin.on("keypress", onKey);
      stdin.on("error", fail);
      stdin.on("end", onEnd);
      stdin.on("close", onEnd);
      stdout.on("error", fail);
      stdout.on("resize", redraw);
      stdin.resume();
      draw();
    } catch (error) {
      fail(error);
    }
  });
}
