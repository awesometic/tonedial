// These tests check the current fixtures for completeness and internal consistency.
// Generated artifacts establish deterministic assembly, not renewed model adherence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test", "fixtures");

// Restated rather than imported from src/core/anchors.ts. These tests check the fixtures
// against the specs, not against the compiler, and sharing the compiler's constants would make
// them agree with it by construction.
const AXES = [
  "formality", "verbosity", "profanity", "playfulness",
  "critique", "flattery", "warmth", "conviction",
  "care", "compliance", "refusal", "bravado",
];

type Persona = {
  age: string | null;
  gender: string | null;
  address: { self_ref: string; user_ref: string };
  user: string | null;
  agent: string | null;
  note: string | null;
};

/** The fixture object passed to compile(), using the persisted field names. */
type Config = {
  preset: string | null;
  axes: Record<string, number>;
  speech_level: string;
  persona: Persona | null;
  safeword: string | null;
};

/** Fixture metadata sits outside `config`, so compile(fixture.config) is the whole call. */
type Fixture = { name: string; chars: number; config: Config };

const COMPOSITES = [
  {
    fires: (a: Record<string, number>) => a.warmth! >= 4 && a.profanity! >= 4,
    line: "- Character: use affectionate swearing.",
  },
  {
    fires: (a: Record<string, number>) => a.compliance! <= 2 && a.conviction! <= 2,
    line: "- Grumble without being passive; make the complaint itself clear.",
  },
  {
    fires: (a: Record<string, number>) => a.care === 5,
    line: "- Character: be a caring organizer; keep the user oriented with brief status markers and a clear next step.",
  },
  {
    fires: (a: Record<string, number>) => a.playfulness! >= 4 && a.bravado! >= 4,
    line: "- Character: be a playful, cocky expert; add confident wit while keeping the technical answer clear.",
  },
  {
    fires: (a: Record<string, number>) => a.verbosity! <= 2 && a.care! >= 4,
    line: "- When verbosity is low and care is high, keep organized items compact; use functional emoji or status markers when they fit.",
  },
  {
    fires: (a: Record<string, number>) => a.verbosity === 5 && a.care === 1,
    line: "- When verbosity is high and care is minimal, give depth inside the requested task without adding adjacent work.",
  },
];

const index = JSON.parse(readFileSync(join(FIXTURES, "index.json"), "utf8")) as {
  schema: number;
  fixtures: string[];
};

/**
 * The tests below iterate over `index.fixtures`, and an empty list would let every one of them
 * pass having asserted nothing. The guard is here rather than inside one of them because a
 * guard in a sibling test disarms all the tests when a fixture is deleted — and a move or a
 * rename is exactly what empties a discovery while changing no assertion.
 *
 * Counted against the packs rather than written out. One pack may yield more than one —
 * `persona-leak` carries two artifacts — so the floor is the pack count, not the exact figure.
 */
const packCount = readdirSync(join(ROOT, "docs", "test", "packs")).filter((f) => f.endsWith(".md")).length;
assert.ok(packCount > 0, "no packs found — the fixture set has nothing to come from");
assert.ok(
  index.fixtures.length >= packCount,
  `${index.fixtures.length} fixtures from ${packCount} packs — a pack produced none`,
);

const load = (name: string) => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURES, `${name}.config.json`), "utf8"),
  ) as Fixture;
  return {
    fixture,
    config: fixture.config,
    artifact: readFileSync(join(FIXTURES, `${name}.tone.md`), "utf8"),
  };
};

test("the index lists every fixture on disk, and nothing else", () => {
  const onDisk = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".tone.md"))
    .map((f) => f.replace(/\.tone\.md$/, ""))
    .sort();
  assert.deepEqual(index.fixtures, onDisk);
});

test("every fixture pairs an artifact with a config", () => {
  for (const name of index.fixtures) {
    const { fixture, artifact } = load(name);
    assert.equal(fixture.name, name, `${name}: config name does not match its filename`);
    assert.ok(artifact.length > 0, `${name}: artifact is empty`);
  }
});

test("every config carries all twelve axes at a level of 1 to 5", () => {
  for (const name of index.fixtures) {
    const { config } = load(name);
    assert.deepEqual(Object.keys(config.axes).sort(), [...AXES].sort(), `${name}: axis set`);
    for (const axis of AXES) {
      const level = config.axes[axis];
      assert.ok(
        Number.isInteger(level) && level! >= 1 && level! <= 5,
        `${name}: ${axis} is ${level}`,
      );
    }
  }
});

test("the recorded character count is the artifact's own length in code points", () => {
  for (const name of index.fixtures) {
    const { fixture, artifact } = load(name);
    assert.equal([...artifact].length, fixture.chars, `${name}: chars`);
  }
});

test("every artifact opens with the generation comment its config records", () => {
  for (const name of index.fixtures) {
    const { config, artifact } = load(name);
    const expected = `<!-- generated by tonedial · preset: ${config.preset ?? "unsaved"} -->`;
    assert.ok(artifact.startsWith(expected + "\n"), `${name}: generation comment`);
    const style = /^<!-- tonedial-style:1 verbosity=([1-5]) care=([1-5]) -->$/.exec(artifact.split("\n")[1] ?? "");
    assert.ok(style, `${name}: style marker`);
    assert.equal(Number(style![1]), config.axes.verbosity, `${name}: marker verbosity`);
    assert.equal(Number(style![2]), config.axes.care, `${name}: marker care`);
  }
});

test("every artifact states the scope-limiting header on its first line of prose", () => {
  for (const name of index.fixtures) {
    const { artifact } = load(name);
    const lines = artifact.split("\n");
    assert.match(lines[1] ?? "", /^<!-- tonedial-style:1 verbosity=[1-5] care=[1-5] -->$/, `${name}: style marker position`);
    assert.equal(lines[2], "## Response tone", `${name}: response-tone heading`);
    assert.match(lines[3] ?? "", /^Output style only\./, `${name}: response-tone prose`);
    assert.match(artifact, /never changes\nwhat work is permitted/, `${name}: permission clause`);
  }
});

test("the rules section has twelve axis lines, selected composites, and shared composition lines", () => {
  // Counting exactly against the predicates turns the axis values into a claim the artifact
  // answers.
  for (const name of index.fixtures) {
    const { config, artifact } = load(name);
    const rules = artifact.split("### Rules\n")[1]?.split("### Controls")[0];
    assert.ok(rules, `${name}: no rules section`);
    const lines = rules!.trimEnd().split("\n").filter((l) => l.startsWith("- "));

    let expected = 15; // Twelve axes, formatting, register composition, and speech level.
    assert.match(lines.at(-3)!, /Choose format from the whole selection/, name);
    assert.match(lines.at(-2)!, /formality changes distance within them/, name);
    assert.match(lines.at(-2)!, /allow role variants/, name);
    const register: Record<string, string> = {
      auto: "choose address forms for the current relationship and scene",
      polite: "use polite address forms even with familiar wording",
      plain: "use plain address forms even with formal wording",
    };
    assert.ok(lines.at(-1)!.includes(register[config.speech_level]!), `${name}: selected register`);
    for (const { fires, line } of COMPOSITES) {
      const should = fires(config.axes);
      assert.equal(lines.includes(line), should, `${name}: composite "${line.slice(2)}"`);
      if (should) expected += 1;
    }
    assert.equal(lines.length, expected, `${name}: rule line count`);
  }
});

test("current fixtures carry controls without guard-only instructions", () => {
  for (const name of index.fixtures) {
    const { config, artifact } = load(name);
    assert.equal(Object.hasOwn(config, "guards"), false, name);
    assert.match(artifact, /### Controls\n/, name);
    assert.doesNotMatch(artifact, /### Guards|Statements about work state|Flattery never distorts|On destructive-work warnings/, name);
  }
});

test("the optional safeword has its scope controls and every fixture has the CLI fallback", () => {
  for (const name of index.fixtures) {
    const { config, artifact } = load(name);
    assert.equal(artifact.includes("- Safeword: when the user's message contains"), config.safeword !== null, `${name}: safeword presence`);
    if (config.safeword !== null) {
      assert.ok(artifact.includes("for that message only"), `${name}: safeword scope`);
      assert.ok(artifact.includes("authorises nothing"), `${name}: safeword changes no permissions`);
    }
    assert.ok(
      artifact.includes("If the user asks to change the tone, use the `tonedial` CLI"),
      `${name}: CLI fallback`,
    );
  }
});

test("every config explicitly declares its safeword, including null, and the artifact matches", () => {
  // Require both values so a missing config safeword cannot bypass the artifact comparison.
  for (const name of index.fixtures) {
    const { config, artifact } = load(name);
    assert.ok(Object.hasOwn(config, "safeword"), `${name}: config has no safeword field`);
    const inArtifact = /^- Safeword: when the user's message contains "(.+?)"/m.exec(artifact);
    assert.equal(inArtifact?.[1] ?? null, config.safeword, `${name}: safeword phrase`);
  }
});

test("a persona section appears when and only when a persona is configured", () => {
  for (const name of index.fixtures) {
    const { config, artifact } = load(name);
    assert.equal(artifact.includes("### Persona"), config.persona !== null, `${name}`);
    if (!config.persona) continue;

    // A persona field is a closed-set token and the compiled line renders it into prose, so
    // this checks the rendering rather than a substitution: `gender: "feminine"` appears as
    // "Feminine speech style.", and `age: "50s+"` as "in your 50s." The compiler owns those templates,
    // and asserting each field's own rendering is what keeps a swapped self_ref and user_ref
    // from passing — both strings appear in the artifact, so a bare substring check cannot
    // tell them apart.
    const p = config.persona;
    if (p.age) assert.match(artifact, new RegExp(`in your ${p.age.replace("+", "")}\\.`), `${name}: age`);
    else assert.ok(!artifact.includes("You are in your"), `${name}: no inferred age`);
    if (p.gender) assert.ok(artifact.includes(`${p.gender[0]!.toUpperCase()}${p.gender.slice(1)} speech style.`), `${name}: gender`);
    else assert.ok(!artifact.includes("speech style."), `${name}: no inferred gender`);
    assert.ok(artifact.includes(`Call yourself ${p.address.self_ref};`), `${name}: self_ref`);
    assert.ok(artifact.includes(`call the user ${p.address.user_ref}.`), `${name}: user_ref`);
    if (p.user !== null) assert.ok(artifact.includes(p.user), `${name}: user context`);
    if (p.agent !== null) assert.ok(artifact.includes(p.agent), `${name}: agent role`);
    if (p.note) assert.ok(artifact.includes(p.note), `${name}: note`);
    else assert.ok(!artifact.includes("Persona note ("), `${name}: no inferred note`);
    assert.ok(
      artifact.includes("Persona sets flavour only."),
      `${name}: the precedence sentence closes the persona section`,
    );
  }
});

test("the fixture set covers the branches the compiler has to get right", () => {
  const configs = index.fixtures.map((n) => load(n).config);
  assert.deepEqual([...new Set(configs.map(c => c.speech_level))].sort(), ["auto", "plain", "polite"], "all register forms are represented");
  assert.ok(configs.some(c => c.safeword === null) && configs.some(c => c.safeword !== null), "both safeword states are represented");
  assert.ok(configs.some((c) => c.persona !== null), "an artifact with a persona");
  assert.ok(configs.some((c) => Boolean(c.persona?.user)), "an artifact with user context");
  assert.ok(configs.some((c) => Boolean(c.persona?.agent)), "an artifact with a fictional agent role");
  assert.ok(configs.some((c) => c.preset === null), "an unsaved artifact");
  assert.ok(configs.some((c) => c.preset !== null), "a preset artifact");
  for (const level of [1, 3, 5]) {
    assert.ok(
      configs.some((c) => AXES.every((a) => c.axes[a] === level)),
      `a degenerate all-${level} artifact`,
    );
  }
  // Keep the unreached anchors explicit so changes to the fixture set are reviewed rather than
  // silently changing the compiler coverage it can verify.
  const unreached: string[] = [];
  for (const axis of AXES) {
    for (const level of [1, 2, 3, 4, 5]) {
      if (!configs.some((c) => c.axes[axis] === level)) unreached.push(`${axis} ${level}`);
    }
  }
  assert.deepEqual(
    unreached,
    [
      "profanity 4", "playfulness 2", "playfulness 4", "flattery 4", "care 2",
      "refusal 2", "refusal 4", "bravado 2", "bravado 4",
    ],
    "the set of anchors no fixture reaches changed; update this list deliberately",
  );
});
