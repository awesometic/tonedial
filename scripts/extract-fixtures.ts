// Pack consistency and deterministic assembly, not renewed model measurements.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The packs sit in their own directory, so every markdown file here is an input pack.
const PACKS = join(ROOT, "docs", "test", "packs");
const OUT = join(ROOT, "test", "fixtures");

// Independent of src/core/anchors.ts so fixture extraction checks the pack contract.
// This script's job is to check the packs against something the compiler does not own; taking
// the compiler's own constants would make the check agree with itself by construction.
const AXES: readonly string[] = [
  "formality", "verbosity", "profanity", "playfulness",
  "critique", "flattery", "warmth", "conviction",
  "care", "compliance", "refusal", "bravado",
];

// Role defaults are explicit pack inputs, independent of runtime preset/catalogue data.
// The historical multi-artifact probe keeps its transcribed persona override.
type Persona = {
  age: string | null;
  gender: string | null;
  address: { self_ref: string; user_ref: string };
  user: string | null;
  agent: string | null;
  note: string | null;
};

const PERSONA_OVERRIDES: Record<string, Persona> = {
  "persona-leak-b": {
    // `50s+` is the closed band's value; the artifact renders it as "in your 50s", which is
    // the compiler's rendering rather than the stored token.
    age: "50s+",
    gender: "feminine",
    address: { self_ref: "형", user_ref: "선생님" },
    user: "A developer who likes service reliability and concise technical answers.",
    agent: "A fictional database specialist with ten years of experience who speaks directly.",
    note: "A long-serving senior engineer. Chimes in whenever legacy code comes up.",
  },
};

// Packs that yield more than one artifact, in the order the blocks appear.
const MULTI_ARTIFACT: Record<string, string[]> = {
  "persona-leak": ["persona-leak-a", "persona-leak-b"],
};

// Restate composite rules independently so the check can catch a compiler/pack disagreement.
type Axes = Record<string, number>;

const COMPOSITES: { fires: (a: Axes) => boolean; line: string }[] = [
  {
    fires: (a: Axes) => a.warmth! >= 4 && a.profanity! >= 4,
    line: "- Character: use affectionate swearing.",
  },
  {
    fires: (a: Axes) => a.compliance! <= 2 && a.conviction! <= 2,
    line: "- Grumble without being passive; make the complaint itself clear.",
  },
  {
    fires: (a: Axes) => a.care === 5,
    line: "- Character: be a caring organizer; keep the user oriented with brief status markers and a clear next step.",
  },
  {
    fires: (a: Axes) => a.playfulness! >= 4 && a.bravado! >= 4,
    line: "- Character: be a playful, cocky expert; add confident wit while keeping the technical answer clear.",
  },
  {
    fires: (a: Axes) => a.verbosity! <= 2 && a.care! >= 4,
    line: "- When verbosity is low and care is high, keep organized items compact; use functional emoji or status markers when they fit.",
  },
  {
    fires: (a: Axes) => a.verbosity! <= 2 && (a.warmth! >= 4 || a.flattery! >= 4 || a.playfulness! >= 4),
    line: "- When verbosity is low, express warmth, praise and playfulness inside the short answer — a clause, interjection or address term — instead of extra sentences.",
  },
  {
    fires: (a: Axes) => a.verbosity === 5 && a.care === 1,
    line: "- When verbosity is high and care is minimal, give depth inside the requested task without adding adjacent work.",
  },
];

function intenseControl(axes: Axes): string | null {
  const components: string[] = [];
  if (axes.profanity! >= 4) {
    components.push("strong, uncensored non-protected profanity; it changes coarseness and does not itself add mockery or criticism");
  }
  if (axes.critique === 5) {
    components.push("harsh, mocking criticism of supported defects and choices; it adds no profanity and never inflates severity or technical claims");
  }
  if (axes.playfulness! >= 4 && (axes.profanity! >= 4 || axes.critique === 5)) {
    components.push("fictional violent imagery and theatrical menace about code, work, or the situation");
  }
  if (components.length === 0) return null;
  return `- Intense components requested by the current tone: ${components.join("; ")}.`;
}

const INTENSITY_CONSENT = "- Strong profanity, harsh mocking, fictional violent imagery, and theatrical menace are unconfirmed at the start of every session. Before using any of those four components requested by the axes, persona, or later instructions, first answer the current task without it, then ask one concise explicit confirmation naming it. Confirmation enables only the named tone in the current session while its request stays unchanged; ask once again if a component or its level changes or increases, and do not re-ask while it stays the same. Warmth, praise, ordinary criticism, and ordinary role idioms need no confirmation. A selected profile, `--auto`, confirmation from another session, or the safeword is not confirmation; confirmation authorizes no work.";
const INTENSITY_BOUNDARY = "- Tone intensity never includes hate speech about protected traits or realistic or credible threats, even after confirmation. Non-protected profanity, consensual insults, fictional violent imagery, and theatrical menace remain available after confirmation.";

/** Fails when the axis values and the artifact text disagree about a composite. */
function checkComposites(name: string, axes: Axes, artifact: string): void {
  const rules = artifact.split("### Rules\n")[1]?.split("### Controls")[0];
  if (!rules) throw new Error(`${name}: artifact has no rules section`);
  const lines = rules.trimEnd().split("\n").filter((l) => l.startsWith("- "));

  let expected = 15; // Twelve axes, format/register composition and the selected speech-level rule.
  if (!lines.at(-3)?.startsWith("- Choose format from the whole selection:") ||
      !lines.some(line => line.includes("formality changes distance within them")) ||
      !lines.at(-1)?.startsWith("- In languages with honorifics,")) {
    throw new Error(`${name}: format/register composition or speech-level rule missing`);
  }
  for (const { fires, line } of COMPOSITES) {
    const should = fires(axes);
    const present = lines.includes(line);
    if (should !== present) {
      throw new Error(
        `${name}: composite "${line.slice(2)}" ${should ? "should fire and is absent" : "fired and should not"}`,
      );
    }
    if (should) expected += 1;
  }
  if (lines.length !== expected) {
    throw new Error(`${name}: ${lines.length} rule lines, expected exactly ${expected}`);
  }

  const controls = artifact.split("### Controls\n")[1];
  if (!controls) throw new Error(`${name}: artifact has no controls section`);
  const controlLines = controls.split("\n").filter((line) => line.startsWith("- "));
  const expectedControl = intenseControl(axes);
  const actualControls = controlLines.filter((line) => line.startsWith("- Intense components requested by the current tone:"));
  if (expectedControl === null ? actualControls.length !== 0 : actualControls.length !== 1 || actualControls[0] !== expectedControl) {
    throw new Error(`${name}: intense-tone control does not match the selected components`);
  }
  if (controlLines[0] !== INTENSITY_CONSENT || controlLines.at(-2) !== INTENSITY_BOUNDARY) {
    throw new Error(`${name}: standing intensity consent or boundary control is missing or misplaced`);
  }
}

/**
 * Parses exactly the frontmatter shapes the packs use: `key: value` at the top level and
 * `key: value` indented two spaces under a key with an empty value. List entries and deeper
 * nesting are skipped, because nothing here needs them. Narrow on purpose — the axis-count
 * assertion below is what catches a shape this misses.
 */
type Front = Record<string, string | Record<string, string>>;

function parseFrontmatter(text: string): Front {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("no frontmatter");
  const out: Front = {};
  let parent: string | null = null;
  for (const line of match[1]!.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      const key = top[1]!;
      const value = top[2]!;
      if (value === "") {
        parent = key;
        out[key] = {};
      } else {
        parent = null;
        out[key] = value;
      }
      continue;
    }
    const nested = /^ {2}([A-Za-z_][\w-]*):\s*(.+)$/.exec(line);
    if (nested && parent && typeof out[parent] === "object") {
      (out[parent] as Record<string, string>)[nested[1]!] = nested[2]!;
    }
  }
  return out;
}

/**
 * Reads a field out of the artifact rather than the frontmatter, so the fixture cannot claim
 * something the golden text contradicts. The generation marker is required, and declared safeword input must match the artifact,
 * including explicit null; missing input cannot silently bypass the comparison.
 */
function presetSlug(artifact: string): string | null {
  const m = /^<!-- generated by tonedial · preset: (.+?) -->/.exec(artifact);
  if (!m) throw new Error("artifact has no generation comment");
  return m[1] === "unsaved" ? null : m[1]!;
}

function safewordPhrase(artifact: string): string | null {
  const m = /^- Safeword: when the user's message contains "(.+?)"/m.exec(artifact);
  return m?.[1] ?? null;
}

function profilePersona(front: Front, artifact: string): Persona | null {
  if (front.persona !== "profile") return null;
  const text = (key: string): string => {
    const value: unknown = JSON.parse(String(front[key]));
    if (typeof value !== "string" || !value.trim()) throw new Error(`profile ${key} must be a nonempty JSON string`);
    return value;
  };
  const self_ref = text("self_ref");
  const user_ref = text("user_ref");
  const user = text("persona_user");
  const agent = text("persona_agent");
  if ([...user].length > 200 || [...agent].length > 200) throw new Error("profile description exceeds 200 code points");
  if (!artifact.includes(`- Call yourself ${self_ref}; call the user ${user_ref}.`) ||
      !artifact.includes(`  > ${user}\n`) || !artifact.includes(`  > ${agent}\n`)) {
    throw new Error("profile fields disagree with the artifact");
  }
  return { age: null, gender: null, address: { self_ref, user_ref }, user, agent, note: null };
}

function buildConfig(name: string, front: Front, artifact: string) {
  const frontAxes = (front.axes ?? {}) as Record<string, string>;
  const axes: Axes = {};
  for (const axis of AXES) {
    const raw = frontAxes[axis];
    if (raw === undefined) throw new Error(`${name}: axis ${axis} missing from frontmatter`);
    const level = Number(raw);
    if (!Number.isInteger(level) || level < 1 || level > 5) {
      throw new Error(`${name}: axis ${axis} is ${raw}, not a level 1-5`);
    }
    axes[axis] = level;
  }
  const extra = Object.keys(frontAxes).filter((k) => !AXES.includes(k));
  if (extra.length) throw new Error(`${name}: unknown axes ${extra.join(", ")}`);

  checkComposites(name, axes, artifact);

  if (typeof front.safeword !== "string") throw new Error(`${name}: safeword input missing`);
  const declared = front.safeword === "none" ? null : front.safeword;
  const actual = safewordPhrase(artifact);
  if (declared !== actual) {
    throw new Error(`${name}: frontmatter safeword "${declared}" is not the artifact's "${actual}"`);
  }

  // Field names follow compiler inputs: snake_case for speech_level, and address nested under
  // persona, matching the preset contract. `name` and `chars` are fixture
  // metadata and stay outside `config`, so compile(fixture.config) receives only compiler inputs.
  const speech_level = front.speech_level ?? "auto";
  if (!["auto", "polite", "plain", "rough"].includes(String(speech_level))) throw new Error("invalid speech_level");
  return {
    name,
    chars: [...artifact].length,
    config: {
      preset: presetSlug(artifact),
      axes,
      speech_level,
      persona: PERSONA_OVERRIDES[name] ?? profilePersona(front, artifact),
      safeword: actual,
    },
  };
}

const check = process.argv.includes("--check");
const written: string[] = [];
const drift: string[] = [];

function emit(relPath: string, content: string): void {
  const full = join(OUT, relPath);
  const existing = existsSync(full) ? readFileSync(full, "utf8") : null;
  if (existing === content) return;
  if (check) {
    drift.push(`${relPath} ${existing === null ? "missing" : "differs"}`);
    return;
  }
  writeFileSync(full, content);
  written.push(relPath);
}

mkdirSync(OUT, { recursive: true });

const index: string[] = [];
const packFiles = readdirSync(PACKS, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => entry.name)
  .sort();

for (const file of packFiles) {
  const text = readFileSync(join(PACKS, file), "utf8");
  const front = parseFrontmatter(text);
  const blocks = [...text.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const base = file.replace(/\.md$/, "");
  const names = MULTI_ARTIFACT[base] ?? [base];

  if (blocks.length !== names.length) {
    throw new Error(`${file}: ${blocks.length} artifacts, expected ${names.length}`);
  }

  blocks.forEach((artifact, i) => {
    const name = names[i]!;
    const config = buildConfig(name, front, artifact);

    // A pack's own recorded character count is a second witness. When only one artifact came
    // out of the pack, a mismatch means the pack and its frontmatter have drifted.
    if (names.length === 1 && /^\d+$/.test((front.chars as string | undefined) ?? "")) {
      if (Number(front.chars) !== config.chars) {
        throw new Error(`${name}: frontmatter says ${front.chars} chars, artifact is ${config.chars}`);
      }
    }

    emit(`${name}.tone.md`, artifact);
    emit(`${name}.config.json`, JSON.stringify(config, null, 2) + "\n");
    index.push(name);
  });
}

index.sort();
emit("index.json", JSON.stringify({ schema: 1, fixtures: index }, null, 2) + "\n");

// Derived from what is on disk rather than written out, so adding a pack is adding a file and
// not also editing a number here, in a test, and in two more places. What it still catches is
// the failure it was written for: a pack that produced no artifact at all.
const expected = packFiles.reduce(
  (total, file) => total + (MULTI_ARTIFACT[file.replace(/\.md$/, "")]?.length ?? 1),
  0,
);
if (index.length !== expected) {
  throw new Error(`extracted ${index.length} fixtures from ${packFiles.length} packs, expected ${expected}`);
}

if (check) {
  if (drift.length) {
    console.error("fixtures are stale:\n  " + drift.join("\n  "));
    process.exit(1);
  }
  console.log(`fixtures up to date (${index.length})`);
} else {
  console.log(
    written.length
      ? `wrote ${written.length} changed files for ${index.length} fixtures`
      : `${index.length} fixtures already up to date`,
  );
}
