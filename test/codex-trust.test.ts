// Synthetic recorded switches are observations, not proof of current host approval.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexHookTrust as observeTrust } from "../src/wiring/codex-trust.ts";
import { catalogue } from "../src/core/i18n.ts";
import { withHook, type HookSpec } from "../src/wiring/hooks.ts";

let scratch = "";
const HOOKS = "/Users/someone/.codex/hooks.json";
const TABLE = `[hooks.state."${HOOKS}:session_start:0:0"]`;
const EN = catalogue("en").cli;
const SPEC: HookSpec = {
  matchers: ["startup|resume"],
  handler: { type: "command", command: "node synthetic-reader", statusMessage: "ToneDial: load saved response tone" },
  documentDescription: "ToneDial: load saved response tone",
};
const DOCUMENT = withHook(null, SPEC, HOOKS, EN);
const codexHookTrust = (path: string, hooks: string) => observeTrust(path, hooks, DOCUMENT, SPEC, EN);

beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "tonedial-trust-")); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const withConfig = (body: string): string => {
  const path = join(scratch, "config.toml");
  writeFileSync(path, body);
  return path;
};

test("a config that cannot be read says nothing rather than accusing anyone", () => {
  // A machine where Codex has never run has no config and no opinion about trust. Answering
  // `untrusted` here would tell someone to go and enable something in a program they do not have.
  assert.equal(codexHookTrust(join(scratch, "absent.toml"), HOOKS), "unknown");
});

test("a config with no matching record cannot establish current host trust", () => {
  const path = withConfig(`[hooks.state]\n\n[hooks.state."/other/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:aa"\n`);
  assert.equal(codexHookTrust(path, HOOKS), "unknown");
});

test("a recorded hash never substitutes for verification of the current definition", () => {
  assert.equal(codexHookTrust(withConfig(`${TABLE}\ntrusted_hash = "sha256:aa"\n`), HOOKS), "unknown");
  assert.equal(
    codexHookTrust(withConfig(`${TABLE}\ntrusted_hash = "sha256:aa"\nenabled = true\n`), HOOKS),
    "unknown",
  );
});

test("enabled = false is the one reading that means switched off", () => {
  assert.equal(
    codexHookTrust(withConfig(`${TABLE}\ntrusted_hash = "sha256:aa"\nenabled = false\n`), HOOKS),
    "disabled",
  );
});

test("the next table ends the block, so a neighbour's state is not read as this one's", () => {
  const path = withConfig(
    `${TABLE}\ntrusted_hash = "sha256:aa"\n\n[hooks.state."/other/.codex/hooks.json:stop:0:0"]\nenabled = false\n`,
  );
  assert.equal(codexHookTrust(path, HOOKS), "unknown");
});

test("a table with no hash is a shape this does not recognise, not an accusation", () => {
  assert.equal(codexHookTrust(withConfig(`${TABLE}\nsomething_else = 1\n`), HOOKS), "unknown");
});

test("a path TOML would have escaped is refused rather than guessed at", () => {
  // Guessing the escaping wrong reads as "no table", and "no table" is the answer that tells a
  // user they have not done something they may well have done.
  const odd = '/Users/some"one/.codex/hooks.json';
  assert.equal(codexHookTrust(withConfig(`[hooks.state]\n`), odd), "unknown");
});

test("managed hook location excludes a foreign first matcher and handler", () => {
  const foreign = JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "foreign" }] }] } });
  const merged = withHook(foreign, SPEC, HOOKS, EN);
  const own = `[hooks.state."${HOOKS}:session_start:1:0"]`;
  const config = withConfig(`${TABLE}\nenabled = false\n${own}\ntrusted_hash = "sha256:dummy"\n`);
  assert.equal(observeTrust(config, HOOKS, merged, SPEC, EN), "unknown");
  writeFileSync(config, `${TABLE}\ntrusted_hash = "sha256:dummy"\n${own}\nenabled = false\n`);
  assert.equal(observeTrust(config, HOOKS, merged, SPEC, EN), "disabled");
  const grouped = JSON.stringify({ hooks: { SessionStart: [{ matcher: SPEC.matchers[0], hooks: [
    { type: "command", command: "foreign" }, SPEC.handler,
  ] }] } });
  writeFileSync(config, `${TABLE}\nenabled = false\n[hooks.state."${HOOKS}:session_start:0:1"]\nenabled = true\n`);
  assert.equal(observeTrust(config, HOOKS, grouped, SPEC, EN), "unknown");
});

test("changed definitions and ambiguous records remain unknown", () => {
  const config = withConfig(`${TABLE}\nenabled = false\n`);
  const changed = withHook(null, { ...SPEC, handler: { ...SPEC.handler, command: "changed" } }, HOOKS, EN);
  const renamed = withHook(null, { ...SPEC, handler: { ...SPEC.handler, statusMessage: "Changed hook" } }, HOOKS, EN);
  const duplicate = JSON.stringify({ hooks: { SessionStart: [{ matcher: SPEC.matchers[0], hooks: [SPEC.handler, SPEC.handler] }] } });
  for (const document of [null, "invalid JSON", changed, renamed, duplicate]) {
    assert.equal(observeTrust(config, HOOKS, document, SPEC, EN), "unknown");
  }
  for (const body of [`${TABLE}\nenabled = false\n${TABLE}\nenabled = true\n`, `${TABLE}\nenabled = false\nenabled = true\n`]) {
    writeFileSync(config, body);
    assert.equal(observeTrust(config, HOOKS, DOCUMENT, SPEC, EN), "unknown");
  }
});

test("TOML multiline examples are not observed as actual hook switch tables", () => {
  for (const quotes of ['"""', "'''"]) {
    const path = withConfig(`developer_instructions = ${quotes}\n${TABLE}\nenabled = false\n${quotes}\n`);
    assert.equal(codexHookTrust(path, HOOKS), "unknown");
  }
});
