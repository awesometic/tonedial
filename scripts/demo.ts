// Isolated CLI scenes; no native client starts and all state roots are temporary.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LANGUAGES, type Language } from "../src/core/i18n.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Media geometry belongs to this recipe, never to a saved ToneDial setting. */
export const DEMO_COLUMNS = 80;

export type Scene = {
  id: string;
  title: string;
  preset: string;
  settings: readonly string[];
  /** Free-form example inputs per locale, not translated agent instructions. */
  address: Record<Language, { self: string; user: string }> | null;
};

export const SCENES: readonly Scene[] = [
  {
    id: "sycophant",
    title: "a preset that praises everything, addressing you as royalty",
    preset: "eager-sycophant",
    settings: [],
    address: {
      en: { self: "your humble servant", user: "Your Majesty" },
      ko: { self: "소인", user: "전하" },
      ja: { self: "臣", user: "陛下" },
      zh: { self: "臣", user: "陛下" },
      es: { self: "su humilde servidor", user: "Su Majestad" },
    },
  },
  {
    id: "risky-tone",
    title: "tough love with risky levels marked, and what the tool says about them",
    preset: "tough-love",
    settings: ["profanity=4", "bravado=3"],
    address: null,
  },
  {
    id: "terse",
    title: "the everyday case: brief, unemotional, nothing switched off",
    preset: "terse-operator",
    settings: [],
    address: null,
  },
  {
    id: "jester",
    title: "a preset that grumbles before complying",
    preset: "bratty-kid",
    settings: [],
    address: null,
  },
];

/** One CLI invocation against the throwaway home, returning what a terminal would have shown. */
function cli(home: string, args: readonly string[]): { out: string; err: string } {
  const result = spawnSync(process.execPath, [join(ROOT, "src", "bin.ts"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    // Scrubbed rather than inherited: the developer's own TONEDIAL_HOME, NO_COLOR or COLUMNS
    // would each change the screen, and a screenshot that depends on who took it is not a
    // screenshot of the product. FORCE_COLOR requests color in the pipe; COLUMNS pins this
    // recipe's synthetic geometry without changing saved state or measured real terminals.
    // All three roots, not just HOME: without the agent root the project scope resolves to the
    // working directory, which is this repository, and setup starts inspecting the checkout's
    // own agent files.
    env: {
      PATH: process.env.PATH ?? "",
      FORCE_COLOR: "1",
      COLUMNS: String(DEMO_COLUMNS),
      HOME: join(home, "home"),
      TONEDIAL_HOME: join(home, "state"),
      TONEDIAL_AGENT_HOME: join(home, "agents"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`tonedial ${args.join(" ")} exited ${String(result.status)}\n${result.stderr}`);
  }
  return { out: result.stdout, err: result.stderr };
}

/** The screen, as text. Exported so the test can assert its shape without capturing an image. */
export function render(scene: Scene, language: Language): string {
  const home = mkdtempSync(join(tmpdir(), "tonedial-demo-"));
  try {
    cli(home, ["init", "--here", "--lang", language, "--tools", "none", "--auto"]);
    cli(home, ["use", scene.preset]);
    if (scene.settings.length) cli(home, ["set", ...scene.settings]);
    const address = scene.address?.[language];
    if (address) cli(home, ["address", address.self, address.user]);

    // Both streams, in the order a terminal shows them. `show` writes its notices — the
    // risky-axis notice, the unanchored-persona warning — to stderr, and a screenshot that
    // dropped them would be a picture of a tool that warns about less than it does.
    const shown = cli(home, ["show"]);
    return shown.out + shown.err;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function usage(): string {
  const scenes = SCENES.map((s) => `  ${s.id.padEnd(12)} ${s.title}`).join("\n");
  return [
    "node scripts/demo.ts <scene> [language]",
    "",
    "Scenes:",
    scenes,
    "",
    `Languages: ${LANGUAGES.join(", ")}`,
    "",
    "Run it in a terminal and capture the screen. Save each as",
    "docs/media/<scene>-<language>.png.",
    "",
    "Renders isolated CLI output only; no native client is started.",
  ].join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const unsupported = args.find((arg) => arg.startsWith("-") && arg !== "--list" && arg !== "--help");
  if (unsupported !== undefined) {
    process.stderr.write(`unsupported option ${unsupported}\n\n${usage()}\n`);
    process.exit(2);
  }
  const [id, language = "en"] = args;
  if (args.length > 2 || ((id === "--list" || id === "--help") && args.length > 1)) {
    process.stderr.write(`unexpected arguments\n\n${usage()}\n`);
    process.exit(2);
  }
  if (id === undefined || id === "--list" || id === "--help") {
    process.stdout.write(usage() + "\n");
    return;
  }
  const scene = SCENES.find((s) => s.id === id);
  if (!scene) {
    process.stderr.write(`no scene named ${id}\n\n${usage()}\n`);
    process.exit(2);
  }
  if (!(LANGUAGES as readonly string[]).includes(language)) {
    process.stderr.write(`no interface language ${language}\n\n${usage()}\n`);
    process.exit(2);
  }
  // Cleared with an escape sequence rather than `clear`, which needs TERM set and dies without
  // it. Only on a terminal: piping this is how the test reads it.
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(render(scene, language as Language));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
