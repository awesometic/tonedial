import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_TOOLS, resolveAgentPaths } from "../src/core/paths.ts";
import { RESERVED_TARGETS, TARGETS, orderedHook, parseToolSelection } from "../src/wiring/targets.ts";
import { BUNDLED, SLUG_PATTERN } from "../src/core/presets.ts";
import { LANGUAGES, catalogue } from "../src/core/i18n.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EN = catalogue("en").cli;

// ── adding an agent ──────────────────────────────────────────────────────────────────────

test("every supported agent carries a complete route, named where it does not", () => {
  const env = { HOME: "/tmp/does-not-matter", PATH: "" };
  const agent = resolveAgentPaths({ global: true, project: null }, env, "/tmp");

  for (const tool of AGENT_TOOLS) {
    const target = TARGETS[tool];
    assert.ok(target, `${tool} is in AGENT_TOOLS with no TARGETS entry`);
    assert.ok(target.label.trim().length > 0, `${tool} has no label for a person to read`);

    // Where the host reads from. A tool with no AGENT_LAYOUT entry throws here rather than
    // silently resolving to the agent root itself and writing into the wrong place.
    for (const [what, path] of [["home", agent.home(tool)], ["hook file", agent.hookFile(tool)]] as const) {
      assert.ok(isAbsolute(path), `${tool}'s ${what} is not absolute: ${path}`);
      assert.ok(path.startsWith("/tmp/does-not-matter"), `${tool}'s ${what} escapes the agent root: ${path}`);
    }

    // The lifecycle it fires on. One entry may carry an alternation where the host documents
    // one, and needs one entry per source where it does not — either way the set is not empty,
    // because a hook with no matcher is written, looks right, and never runs.
    const spec = orderedHook(tool, "/tmp/state", "/usr/bin/node");
    assert.ok(spec.matchers.length > 0, `${tool} installs a SessionStart hook with no matcher`);
    for (const matcher of spec.matchers) {
      assert.ok(matcher.trim().length > 0, `${tool} has an empty matcher`);
    }
    assert.ok(spec.handler.command, `${tool}'s hook has no command to run`);

    // A name cannot be both supported and reserved: `parseToolSelection` checks reserved first,
    // so leaving it in the reserved table makes the finished route unselectable.
    assert.equal(RESERVED_TARGETS[tool], undefined, `${tool} is supported and still reserved`);
    assert.deepEqual(parseToolSelection(tool, false, EN), [tool], `${tool} is not selectable`);
  }
});

test("no two agents claim the same label or the same settings file", () => {
  const env = { HOME: "/tmp/does-not-matter", PATH: "" };
  const agent = resolveAgentPaths({ global: true, project: null }, env, "/tmp");
  const labels = AGENT_TOOLS.map((tool) => TARGETS[tool].label);
  assert.equal(new Set(labels).size, labels.length, `two agents share a label: ${labels.join(", ")}`);
  // Sharing one file is a real case the writer supports, but it has to be deliberate: an
  // accidental collision means one tool's setup silently reads as the other's.
  const files = AGENT_TOOLS.map((tool) => agent.hookFile(tool));
  assert.equal(new Set(files).size, files.length, `two agents share a settings file: ${files.join(", ")}`);
});

// ── adding a preset ──────────────────────────────────────────────────────────────────────

test("every bundled preset carries its copy in every language the interface ships", () => {
  // The catalogue maps are `Record<string, string>` rather than a slug union, so the compiler
  // catches nothing here, and the consumers fall back quietly: `init` renders `?? ""` for a
  // missing summary and simply prints no safeword suggestion. This is what notices instead.
  for (const language of LANGUAGES) {
    const copy = catalogue(language);
    for (const preset of BUNDLED) {
      const summary = copy.presets[preset.slug];
      assert.ok(
        summary !== undefined && summary.trim().length > 0,
        `${preset.slug} has no ${language} one-line summary — init would list it blank`,
      );
      const safeword = copy.safewords[preset.slug];
      assert.ok(
        safeword !== undefined && safeword.trim().length > 0,
        `${preset.slug} has no ${language} safeword suggestion — init would offer none`,
      );
    }
  }
});

test("every bundled preset has a pack and a pinned artifact", () => {
  for (const preset of BUNDLED) {
    assert.match(preset.slug, SLUG_PATTERN, `${preset.slug} is not a valid slug`);
    const pack = join(ROOT, "docs", "test", "packs", `${preset.slug}.md`);
    assert.ok(existsSync(pack), `${preset.slug} has no prompt pack at docs/test/packs/${preset.slug}.md`);
    const fixture = join(ROOT, "test", "fixtures", `${preset.slug}.tone.md`);
    assert.ok(existsSync(fixture), `${preset.slug} has no fixture — run npm run fixtures`);
  }
});

test("a preset's display name is distinct, because it is what a person picks by", () => {
  const names = BUNDLED.map((p) => p.displayName);
  assert.equal(new Set(names).size, names.length, `two presets share a display name: ${names.join(", ")}`);
  const slugs = BUNDLED.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length, `two presets share a slug: ${slugs.join(", ")}`);
});
