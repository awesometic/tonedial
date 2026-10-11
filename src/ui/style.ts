// Semantic paint for the user's terminal theme. Text carries every status without colour.

import { UNKNOWN_WIDTH } from "./width.ts";

/** Wraps a string in one token's escapes, or returns it untouched when colour is off. */
export type Paint = (s: string) => string;

export type Palette = {
  /** Titles, observed outcomes and principal targets. */
  bold: Paint;
  /** Legend, footers, axes sitting at their default — present but not competing. */
  dim: Paint;
  /** The one thing on the screen the eye should land on first. */
  accent: Paint;
  /** A completed outcome, accompanied by its textual status. */
  success: Paint;
  /** A warning that does not stop the command. */
  warn: Paint;
  /** Advisory tone risk; selected levels remain available. */
  risk: Paint;
  /** A cap overrun or a failed check. */
  error: Paint;
  /** Whether this output stream is a terminal, independent of forced or disabled colour. */
  terminal: boolean;
  /** The widest line this invocation may write, in cells. */
  width: number;
};

const wrap = (on: string, off: string): Paint => (s) => `${on}${s}${off}`;
const identity: Paint = (s) => s;

const PLAIN: Palette = { bold: identity, dim: identity, accent: identity, success: identity, warn: identity, risk: identity, error: identity, terminal: false, width: UNKNOWN_WIDTH };

const COLOUR: Palette = {
  bold: wrap("\x1b[1m", "\x1b[22m"),
  dim: wrap("\x1b[2m", "\x1b[22m"),
  accent: wrap("\x1b[36m", "\x1b[39m"),
  success: wrap("\x1b[32m", "\x1b[39m"),
  warn: wrap("\x1b[33m", "\x1b[39m"),
  risk: wrap("\x1b[31m", "\x1b[39m"),
  error: wrap("\x1b[31m", "\x1b[39m"),
  terminal: false,
  width: UNKNOWN_WIDTH,
};

export type ColourMode = "auto" | "always" | "never";

export function isColourMode(value: string): value is ColourMode {
  return value === "auto" || value === "always" || value === "never";
}

// Explicit flags outrank the environment; NO_COLOR outranks FORCE_COLOR in auto mode.
export function palette(
  mode: ColourMode,
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
  width: number = UNKNOWN_WIDTH,
): Palette {
  const colour = (): Palette => {
    if (mode === "never") return PLAIN;
    if (mode === "always") return COLOUR;
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return PLAIN;
    if (env.TERM === "dumb") return PLAIN;
    if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") return COLOUR;
    return isTTY ? COLOUR : PLAIN;
  };
  const base = colour();
  return width === base.width && isTTY === base.terminal ? base : { ...base, width, terminal: isTTY };
}
