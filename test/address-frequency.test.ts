import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ADDRESS_COMPOSITION, ADDRESS_FREQUENCY, PERSONA } from "../src/core/anchors.ts";
import { compile, type AddressFrequency } from "../src/core/compile.ts";
import { ADDRESS_FREQUENCIES, defaultConfig, parseConfig, recoverSettings, serializeConfig } from "../src/core/config.ts";
import { catalogue } from "../src/core/i18n.ts";
import { recoverLegacyTone } from "../src/core/legacy-tone.ts";
import { resolvePaths } from "../src/core/paths.ts";
import { parsePreset, presetSettings, withPreset } from "../src/core/presets.ts";
import { toCompileInput } from "../src/core/resolve.ts";
import { SKILL_MD, SKILL_TRAITS_MD, TONE_COMMAND_MD } from "../src/core/skill.ts";
import { captureCli, createGoldenWorkspace } from "./support/golden.ts";

const EN = catalogue("en").cli;

test("address frequency defaults only when absent and survives independent settings recovery", () => {
  const config = defaultConfig();
  const old = JSON.parse(serializeConfig(config));
  delete old.address_frequency;
  assert.equal(parseConfig(JSON.stringify(old)).address_frequency, "auto");
  for (const value of [null, 0, "0", "None", "sometimes", "toString", {}, []]) {
    assert.throws(() => parseConfig(JSON.stringify({ ...old, address_frequency: value })), /address_frequency/);
    assert.throws(() => compile({ ...toCompileInput(config), address_frequency: value as AddressFrequency }), /address_frequency/);
  }
  for (const frequency of ADDRESS_FREQUENCIES) {
    config.address_frequency = frequency;
    const raw = JSON.parse(serializeConfig(config));
    assert.equal(parseConfig(JSON.stringify(raw)).address_frequency, frequency);
    raw.persona.user = 42;
    const recovered = recoverSettings(JSON.stringify(raw), EN)!;
    assert.equal(recovered.config.address_frequency, frequency);
    assert.ok(recovered.recovered.includes("address_frequency"));
    assert.ok(recovered.invalid.includes("persona.user"));
  }
});

test("all address policies preserve literal terms and recover complete current artifacts", () => {
  const config = defaultConfig();
  config.persona.address = { self_ref: 'a "guide"; call the user reader', user_ref: '민준님 "독자"' };
  config.axes.playfulness = 1;
  config.axes.warmth = 5;
  for (const frequency of ADDRESS_FREQUENCIES) {
    config.address_frequency = frequency;
    const input = toCompileInput(config);
    const before = structuredClone(input);
    const artifact = compile(input);
    assert.deepEqual(input, before);
    assert.ok(artifact.includes(PERSONA.address(config.persona.address.self_ref, config.persona.address.user_ref)!));
    assert.ok(artifact.includes(`- ${ADDRESS_COMPOSITION}\n- ${ADDRESS_FREQUENCY[frequency]}\n`));
    const recovered = recoverLegacyTone(artifact, EN)!;
    assert.ok(recovered);
    assert.deepEqual(toCompileInput(recovered.config), input);
    assert.equal(compile(toCompileInput(recovered.config)), artifact);
    assert.equal(recoverLegacyTone(artifact.replace(ADDRESS_FREQUENCY[frequency], "Invented address rule."), EN), null);
    assert.equal(recoverLegacyTone(artifact.replace(`- ${ADDRESS_COMPOSITION}\n`, "")
      .replace(`- ${ADDRESS_FREQUENCY[frequency]}\n`, ""), EN), null,
    "a current address identity cannot turn a damaged policy into historical auto");
  }
  config.persona.address = { self_ref: null, user_ref: "reader" };
  const current = compile(toCompileInput(config));
  for (const value of [" reader ", "reader\nnext", "unspecified"]) {
    assert.equal(recoverLegacyTone(current.replace('use "reader".', `use ${JSON.stringify(value)}.`), EN), null,
      "a current artifact must round-trip through compiler normalization");
  }
  assert.equal(recoverLegacyTone(current.replace(`- ${PERSONA.precedence}`,
    `- ${PERSONA.userWrapper}\n  > ${"x".repeat(201)}\n- ${PERSONA.precedence}`), EN), null,
  "damaged descriptions must not escape the decoder's null failure result");
  const oldArtifact = compile(toCompileInput(config))
    .replace(`- ${PERSONA.address(null, "reader")}`, "- Call the user reader.")
    .replace(`- ${ADDRESS_COMPOSITION}\n`, "")
    .replace(`- ${ADDRESS_FREQUENCY[config.address_frequency]}\n`, "");
  const old = recoverLegacyTone(oldArtifact, EN)!;
  assert.ok(old);
  assert.equal(old.config.address_frequency, "auto");
  assert.ok(old.defaulted?.includes("address_frequency"));
  assert.deepEqual(old.config.persona.address, config.persona.address);
});

test("complete profiles restore frequency while older files default and axis-only profiles preserve it", () => {
  const config = defaultConfig();
  config.address_frequency = "rarely";
  const profile = { schema: 2, values: { warmth: 4 }, settings: presetSettings(config) };
  const parsed = parsePreset(JSON.stringify(profile), "reader", EN);
  assert.equal(parsed.settings?.address_frequency, "rarely");
  const current = { ...config, address_frequency: "none" as const };
  assert.equal(withPreset(current, parsed).address_frequency, "rarely");
  const old = JSON.parse(JSON.stringify(profile));
  delete old.settings.address_frequency;
  assert.equal(parsePreset(JSON.stringify(old), "reader", EN).settings?.address_frequency, "auto");
  assert.equal(withPreset(current, parsePreset('{"values":{"warmth":4}}', "legacy", EN)).address_frequency, "none");
  assert.throws(() => parsePreset(JSON.stringify({ ...profile, settings: { ...profile.settings, address_frequency: "0" } }), "reader", EN));
});

test("CLI persists, displays, recompiles and transfers frequency without clearing names or prompting JSON", async t => {
  const workspace = createGoldenWorkspace("en");
  t.after(() => workspace.dispose());
  const invoke = async (...args: string[]) => {
    const result = await captureCli(workspace, [...args, "--json"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  await invoke("init", "--global", "--tools", "none", "--auto");
  const paths = resolvePaths(workspace.env);
  await invoke("set", "persona.self_ref=저", "persona.user_ref=민준님", "address_frequency=none");
  const stored = () => parseConfig(readFileSync(paths.config, "utf8"));
  assert.equal(stored().persona.address?.user_ref, "민준님");
  assert.equal((await invoke("get", "address_frequency")).values.address_frequency, "none");
  assert.equal((await invoke("show")).address_frequency, "none");
  assert.equal(readFileSync(paths.tone, "utf8"), compile(toCompileInput(stored())));
  await invoke("save", "Quiet reader", "--slug", "quiet-reader");
  const exported = await invoke("export", "quiet-reader");
  assert.equal(exported.preset.settings.address_frequency, "none");
  await invoke("set", "address_frequency=frequently");
  assert.equal((await invoke("show")).unsaved, true);
  await invoke("reset");
  assert.equal(stored().address_frequency, "frequently");
  await invoke("address", "assistant", "reader");
  assert.equal(stored().address_frequency, "frequently");
  await invoke("use", "quiet-reader");
  assert.equal(stored().address_frequency, "none");
  const before = readFileSync(paths.config, "utf8");
  const invalid = await captureCli(workspace, ["set", "warmth=5", "address_frequency=0", "--json"]);
  assert.equal(invalid.status, 1);
  assert.equal(readFileSync(paths.config, "utf8"), before);
  const human = await captureCli(workspace, ["get", "address_frequency"]);
  assert.match(human.stdout, /none \| auto \| rarely \| frequently/);
  for (const text of [SKILL_MD, SKILL_TRAITS_MD, TONE_COMMAND_MD]) {
    assert.ok(text.includes("address_frequency"));
    assert.ok(text.includes("frequently"));
  }
});
