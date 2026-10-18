import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_TOOLS, resolveAgentPaths } from "../src/core/paths.ts";
import { TARGETS, orderedHook, parseToolSelection } from "../src/wiring/targets.ts";
import { BUNDLED, SLUG_PATTERN } from "../src/core/presets.ts";
import { LANGUAGES, catalogue } from "../src/core/i18n.ts";
import { SKILL_MD, SKILL_TRAITS_MD, TONE_COMMAND_MD } from "../src/core/skill.ts";

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

    // Session hooks carry matchers. Antigravity's invocation hook is a direct event list and
    // intentionally has no matcher.
    const spec = orderedHook(tool, "/tmp/state", "/usr/bin/node");
    if (tool === "antigravity") {
      assert.equal(spec.event, "PreInvocation");
      assert.deepEqual(spec.matchers, []);
    } else {
      assert.ok(spec.matchers.length > 0, `${tool} installs a SessionStart hook with no matcher`);
      for (const matcher of spec.matchers) {
        assert.ok(matcher.trim().length > 0, `${tool} has an empty matcher`);
      }
    }
    assert.ok(spec.handler.command, `${tool}'s hook has no command to run`);

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

test("the shipped controls keep intense-tone confirmation session-local and permission-neutral", () => {
  for (const [surface, contents] of [["skill", SKILL_MD], ["optional /tone command", TONE_COMMAND_MD]] as const) {
    assert.match(contents, /The four components that require confirmation are strong\s+profanity, harsh mocking, fictional violent imagery and theatrical menace/, `${surface} leaves confirmation scope ambiguous`);
    assert.match(contents, /Before using one\s+requested by axes, persona or later instructions/, `${surface} lets persona intensity bypass confirmation`);
    assert.match(contents, /first answer the current request without it/, `${surface} can withhold the task while asking`);
    assert.match(contents, /Warmth, praise,\s+ordinary criticism and ordinary role idioms need no confirmation/, `${surface} over-gates ordinary character language`);
    assert.match(contents, /Profiles store requested settings, never\s+session confirmation/, `${surface} persists confirmation`);
    assert.match(contents, /`--auto`.*safeword.*another session do not count/s, `${surface} treats another consent as tone confirmation`);
    assert.match(contents, /authorizes no work/, `${surface} lets tone confirmation expand the task`);
    assert.match(contents, /hate speech aimed at\s+protected traits or realistic or credible threats/, `${surface} omits the hard exclusions`);
    assert.match(contents, /Non-protected profanity,\s+consensual insults, fictional violent imagery and theatrical menace remain available/, `${surface} silently narrows approved intensity`);
  }

  assert.match(SKILL_TRAITS_MD, /Risk display and intense-tone confirmation are separate/);
  assert.match(SKILL_TRAITS_MD, /increase or change requires it\s+again/);
  assert.match(SKILL_TRAITS_MD, /rough uses curt, blunt non-honorific endings/);
});

test("the shipped controls use the CLI delivery switch without erasing the saved tone", () => {
  for (const [surface, contents] of [["skill", SKILL_MD], ["optional /tone command", TONE_COMMAND_MD]] as const) {
    assert.match(contents, /tonedial off --json/, `${surface} cannot pause delivery`);
    assert.match(contents, /tonedial on --json/, `${surface} cannot resume delivery`);
    assert.match(contents, /saved settings, profiles and the full\s+`TONE\.md` remain/, `${surface} can imply destructive disablement`);
    assert.match(contents, /Already delivered context\s+cannot be removed from an open conversation/, `${surface} promises to unload existing context`);
  }
  assert.doesNotMatch(SKILL_TRAITS_MD, /tonedial off|delivery switch/,
    "delivery state is not an axis trait or another tone anchor");
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
      const role = copy.cli.persona.bundled[preset.slug]!;
      assert.ok(role?.address?.self_ref && role.address.user_ref, `${preset.slug}: missing ${language} address defaults`);
      for (const field of ["user", "agent"] as const) {
        assert.ok(role[field] && [...role[field]].length <= 200, `${preset.slug}: invalid ${language} ${field} default`);
      }
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
