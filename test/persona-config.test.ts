import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultConfig,
  parseConfig,
  recoverSettings,
  serializeConfig,
} from "../src/core/config.ts";
import { PERSONA_DESCRIPTION_MAX } from "../src/core/combos.ts";
import { compile } from "../src/core/compile.ts";
import { catalogue } from "../src/core/i18n.ts";
import { recoverLegacyTone } from "../src/core/legacy-tone.ts";
import { toCompileInput } from "../src/core/resolve.ts";

const EN = catalogue("en").cli;

function rawConfig(): Record<string, any> {
  return JSON.parse(serializeConfig(defaultConfig())) as Record<string, any>;
}

test("role descriptions normalize whitespace, keep literal unspecified, and serialize as nullable fields", () => {
  const raw = rawConfig();
  raw.persona.user = "  Maintains a small studio  ";
  raw.persona.agent = "\nA specialist who likes careful fixes.\n";
  const parsed = parseConfig(JSON.stringify(raw), EN);
  assert.equal(parsed.persona.user, "Maintains a small studio");
  assert.equal(parsed.persona.agent, "A specialist who likes careful fixes.");

  raw.persona.user = "unspecified";
  raw.persona.agent = "   ";
  const cleared = parseConfig(JSON.stringify(raw), EN);
  assert.equal(cleared.persona.user, "unspecified");
  assert.equal(cleared.persona.agent, null);

  const saved = JSON.parse(serializeConfig(cleared));
  assert.equal(saved.persona.user, "unspecified");
  assert.equal(saved.persona.agent, null);
});

test("each role description has an independent 200-code-point hard limit", () => {
  const accepted = rawConfig();
  accepted.persona.user = "😀".repeat(PERSONA_DESCRIPTION_MAX);
  assert.equal(parseConfig(JSON.stringify(accepted), EN).persona.user, accepted.persona.user);

  for (const field of ["user", "agent"] as const) {
    const raw = rawConfig();
    const secret = `${field}-DO_NOT_ECHO`;
    raw.persona[field] = `${secret}${"x".repeat(PERSONA_DESCRIPTION_MAX)}`;
    assert.throws(
      () => parseConfig(JSON.stringify(raw), EN),
      (error: unknown) => {
        assert.match(String(error), new RegExp(`persona\\.${field}`));
        assert.doesNotMatch(String(error), new RegExp(secret));
        return true;
      },
    );
  }
});

test("missing role fields default to null and damaged fields recover independently", () => {
  const old = rawConfig();
  delete old.persona.user;
  delete old.persona.agent;
  const parsed = parseConfig(JSON.stringify(old), EN);
  assert.equal(parsed.persona.user, null);
  assert.equal(parsed.persona.agent, null);

  const damaged = rawConfig();
  damaged.persona.user = "A valid user context";
  const agentSecret = "persona-agent-SECRET";
  damaged.persona.agent = `${agentSecret}${"x".repeat(PERSONA_DESCRIPTION_MAX)}`;
  const result = recoverSettings(JSON.stringify(damaged), EN)!;
  assert.equal(result.config.persona.user, "A valid user context");
  assert.equal(result.config.persona.agent, null);
  assert.ok(result.recovered.includes("persona.user"));
  assert.ok(result.invalid.includes("persona.agent"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(agentSecret));
});

test("current persona descriptions recover from the compiled body without mixing their labels", () => {
  const config = defaultConfig();
  config.persona.user = "Maintains a small studio";
  config.persona.agent = "A fictional security specialist with twenty years of experience";
  const recovered = recoverLegacyTone(compile(toCompileInput(config)), EN)!;
  assert.equal(recovered.config.persona.user, config.persona.user);
  assert.equal(recovered.config.persona.agent, config.persona.agent);
  assert.equal(recovered.config.persona.note, null);
});

test("non-string role values are rejected privately and recover independently", () => {
  for (const field of ["user", "agent"] as const) {
    const other = field === "user" ? "agent" : "user";
    const raw = rawConfig();
    const secret = `DO_NOT_ECHO_${field}`;
    raw.persona[field] = { private: secret };
    raw.persona[other] = "Valid context";
    assert.throws(() => parseConfig(JSON.stringify(raw), EN), (error: unknown) => {
      assert.ok(String(error).includes(`persona.${field}`));
      assert.equal(String(error).includes(secret), false);
      return true;
    });
    const recovered = recoverSettings(JSON.stringify(raw), EN)!;
    assert.ok(recovered.invalid.includes(`persona.${field}`));
    assert.equal(recovered.config.persona[field], null);
    assert.equal(recovered.config.persona[other], "Valid context");
    assert.equal(JSON.stringify(recovered).includes(secret), false);
  }
});

test("a user-only or agent-only description can close the persona section", () => {
  for (const [user, agent] of [
    ["Maintains a small studio", null],
    [null, "A fictional security specialist"],
  ] as const) {
    const config = defaultConfig();
    config.persona.user = user;
    config.persona.agent = agent;
    const recovered = recoverLegacyTone(compile(toCompileInput(config)), EN)!;
    assert.equal(recovered.config.persona.user, user);
    assert.equal(recovered.config.persona.agent, agent);
  }
});
