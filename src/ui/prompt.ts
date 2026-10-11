// Restore raw input on handled exits. Never prompt without a terminal.

import { createInterface } from "node:readline/promises";

export type Answer = "yes" | "no";

/** Whether a question can be asked at all. */
export function interactive(stdin = process.stdin, stdout = process.stdout): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/**
 * Restore whatever the terminal had before, on every path out — including the ones nobody
 * plans for. Returns a function that undoes the registration, so a short-lived prompt does not
 * leave a listener behind on a long-lived process.
 *
 * The order matters on the crash path: the terminal is restored **before** the stack trace is
 * written, because a trace printed in raw mode is a trace nobody can read.
 */
export function guardTerminal(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
  options: {
    raw?: boolean;
    onRestore?: () => void;
    onResume?: () => void;
  } = {},
): (() => void) & { suspend: () => void } {
  const wasRaw = stdin.isRaw === true;
  let resumeRaw = wasRaw;
  let hiddenCursor = false;
  let suspended = false;
  let released = false;

  const enter = (raw: boolean) => {
    if (stdin.isTTY && stdin.isRaw !== raw) stdin.setRawMode(raw);
    if (!stdout.isTTY) return;
    if (options.raw) {
      hiddenCursor = true;
      stdout.write("\x1b[?25l");
    }
  };

  const restore = () => {
    try {
      if (stdin.isTTY && stdin.isRaw !== wasRaw) stdin.setRawMode(wasRaw);
    } finally {
      try {
        options.onRestore?.();
      } finally {
        const controls = hiddenCursor ? "\x1b[?25h" : "";
        hiddenCursor = false;
        if (controls && !stdout.destroyed && stdout.writable !== false) stdout.write(controls);
      }
    }
  };

  const onExit = () => {
    // A broken output stream must not replace the original exit or uncaught-error diagnostic.
    try { release(); } catch { /* raw-mode restoration was attempted before terminal output */ }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    // Re-raise with the default handler so the exit status is the one the shell expects —
    // 130 for an interrupt — rather than a plain zero from a handler that swallowed it.
    try { release(); } finally { process.kill(process.pid, signal); }
  };
  const onInterrupt = () => onSignal("SIGINT");
  const onTerminate = () => onSignal("SIGTERM");

  // Raw mode delivers Ctrl+Z as a key. The dial calls this same path as an external SIGTSTP.
  const onSuspend = () => {
    if (released || suspended || process.platform === "win32") return;
    resumeRaw = stdin.isRaw === true;
    restore();
    suspended = true;
    process.removeListener("SIGTSTP", onSuspend);
    process.kill(process.pid, "SIGTSTP");
  };
  const onResume = () => {
    if (released || !suspended) return;
    suspended = false;
    process.on("SIGTSTP", onSuspend);
    enter(resumeRaw);
    options.onResume?.();
  };

  process.on("exit", onExit);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  if (process.platform !== "win32") {
    process.on("SIGTSTP", onSuspend);
    process.on("SIGCONT", onResume);
  }
  process.on("uncaughtExceptionMonitor", onExit);

  function release() {
    if (released) return;
    released = true;
    try {
      restore();
    } finally {
      process.removeListener("exit", onExit);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      process.removeListener("SIGTSTP", onSuspend);
      process.removeListener("SIGCONT", onResume);
      process.removeListener("uncaughtExceptionMonitor", onExit);
    }
  }

  try {
    enter(options.raw === true || wasRaw);
  } catch (error) {
    onExit();
    throw error;
  }
  return Object.assign(release, { suspend: onSuspend });
}

/**
 * Ask once. Anything that is not an explicit yes is a no, because this gate stands in front of
 * writes to files the user did not hand over and a stray keystroke should cost nothing.
 */
export async function confirm(question: string): Promise<Answer> {
  const release = guardTerminal();
  let rl: ReturnType<typeof createInterface> | undefined;
  try {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    const reply = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return reply === "y" || reply === "yes" ? "yes" : "no";
  } finally {
    try { rl?.close(); } finally { release(); }
  }
}
