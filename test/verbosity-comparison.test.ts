import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { compile, type Config } from "../src/core/compile.ts";
import { LANGUAGES } from "../src/core/i18n.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const wordCount = (text: string) => text.match(/[\p{L}\p{N}’'-]+/gu)?.length ?? 0;

type Condition = {
  id: string;
  delivery: string;
  tone: string;
  openingResponseText: string;
  openingResponseSha256: string;
  responseText: string;
  responseSha256: string;
  responseWords: number;
  nativeTurnCount: number;
  nativeExit: number;
  toolCallsObserved: number;
  targetUnchanged: boolean;
};

test("the README default-vs-vibe-coder comparison preserves its recorded native replies", () => {
  const path = join(root, "docs/media/readme/verbosity-comparison.json");
  const serialized = readFileSync(path, "utf8");
  const data = JSON.parse(serialized) as {
    kind: string;
    recordedOn: string;
    samplesPerCondition: number;
    instruction: string;
    instructionSha256: string;
    client: string;
    clientVersion: string;
    model: string;
    reasoningEffort: string;
    productRevision: string;
    tonedialVersion: string;
    profileSource: string;
    profile: { slug: string; verbosity: number; toneChars: number; toneSha256: string; testCommand: string };
    comparisonScope: string;
    preRegisteredPrediction: string;
    capturePlanSha256: string;
    customizationIsolation: string;
    nativeSandbox: string;
    osFilesystemIsolationProven: boolean;
    hookActivationVerified: boolean;
    adherenceScored: boolean;
    excludedPreflight: {
      condition: string;
      profileArmRun: boolean;
      instruction: string;
      instructionSha256: string;
      responseText: string;
      responseSha256: string;
      excludedReason: string;
    };
    conditions: Condition[];
  };

  assert.doesNotMatch(serialized, /\/Users\/|\/private\/|codex resume|01a[0-9a-f-]{20,}/u);
  assert.equal(data.kind, "recorded-native-default-vs-profile");
  assert.equal(data.recordedOn, "2026-10-18");
  assert.equal(data.samplesPerCondition, 1);
  assert.equal(hash(data.instruction), data.instructionSha256);
  assert.equal(data.client, "Codex CLI");
  assert.equal(data.clientVersion, "0.160.0");
  assert.equal(data.model, "gpt-5.6-sol");
  assert.equal(data.reasoningEffort, "high");
  assert.match(data.productRevision, /^[a-f0-9]{40}$/u);
  assert.equal(data.tonedialVersion, "0.1.6");
  assert.equal(data.comparisonScope, "complete-profile-not-isolated-verbosity-axis");
  assert.ok(data.preRegisteredPrediction.trim());
  assert.match(data.capturePlanSha256, /^[a-f0-9]{64}$/u);
  assert.equal(data.customizationIsolation, "requested");
  assert.equal(data.nativeSandbox, "read-only");
  assert.equal(data.osFilesystemIsolationProven, false);
  assert.equal(data.hookActivationVerified, false);
  assert.equal(data.adherenceScored, false);
  assert.equal(data.excludedPreflight.condition, "codex-default");
  assert.equal(data.excludedPreflight.profileArmRun, false);
  assert.equal(hash(data.excludedPreflight.instruction), data.excludedPreflight.instructionSha256);
  assert.equal(hash(data.excludedPreflight.responseText), data.excludedPreflight.responseSha256);
  assert.match(data.excludedPreflight.responseText, /`tonedial preview`/u);
  assert.match(data.excludedPreflight.excludedReason, /nonexistent `tonedial preview`/u);

  const recipes = JSON.parse(readFileSync(join(root, data.profileSource), "utf8")) as {
    recipes: { slug: string; tone: string; toneSha256: string; input: Config }[];
  };
  const recipe = recipes.recipes.find(item => item.slug === data.profile.slug);
  assert.ok(recipe);
  assert.equal(data.profile.verbosity, 1);
  assert.equal(recipe.input.axes.verbosity, data.profile.verbosity);
  assert.equal(recipe.tone.length, data.profile.toneChars);
  assert.equal(hash(recipe.tone), data.profile.toneSha256);
  assert.equal(recipe.toneSha256, data.profile.toneSha256);
  assert.equal(compile(recipe.input), recipe.tone);
  assert.equal(data.profile.testCommand, "tonedial test codex --preset vibe-coder");

  assert.deepEqual(data.conditions.map(item => item.id), ["codex-default", "vibe-coder"]);
  for (const item of data.conditions) {
    assert.equal(hash(item.openingResponseText), item.openingResponseSha256);
    assert.equal(hash(item.responseText), item.responseSha256);
    assert.equal(wordCount(item.responseText), item.responseWords);
    assert.deepEqual([...item.responseText.matchAll(/^\d+\. /gmu)].map(match => match[0]), ["1. ", "2. ", "3. "]);
    assert.match(item.responseText, /tonedial test codex --preset/u);
    assert.doesNotMatch(item.responseText, /`tonedial preview`/u);
    assert.equal(item.nativeTurnCount, 2);
    assert.equal(item.nativeExit, 0);
    assert.equal(item.toolCallsObserved, 0);
    assert.equal(item.targetUnchanged, true);
  }
  assert.equal(data.conditions[0]!.delivery, "native-interactive-no-tonedial-control");
  assert.equal(data.conditions[0]!.tone, "none-supplied");
  assert.equal(data.conditions[1]!.delivery, "tonedial-test-native-interactive");
  assert.equal(data.conditions[1]!.tone, "vibe-coder");
  assert.equal(data.conditions[0]!.responseWords, 148);
  assert.equal(data.conditions[1]!.responseWords, 82);
  assert.ok(data.conditions[1]!.responseWords < data.conditions[0]!.responseWords);
});

test("every README locale renders and links the same comparison evidence", () => {
  const { instruction } = JSON.parse(readFileSync(join(root, "docs/media/readme/verbosity-comparison.json"), "utf8")) as {
    instruction: string;
  };
  for (const language of LANGUAGES) {
    const readmePath = join(root, language === "en" ? "README.md" : `README.${language}.md`);
    const readme = readFileSync(readmePath, "utf8");
    assert.ok(readme.includes(`docs/media/readme/${language}/verbosity-comparison.svg`));
    assert.ok(readme.includes("docs/media/readme/verbosity-comparison.json"));
    assert.ok(readme.includes("gpt-5.6-sol"));
    assert.ok(readme.includes(instruction));
    assert.ok(readme.includes("148"));
    assert.ok(readme.includes("82"));

    const rendered = spawnSync(process.execPath, [join(root, "scripts/verbosity-svg.ts"), language], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal(rendered.stdout, readFileSync(join(root, `docs/media/readme/${language}/verbosity-comparison.svg`), "utf8"));
    assert.ok(rendered.stdout.includes("gpt-5.6-sol"));
    assert.ok(rendered.stdout.includes("first-time users"));
    assert.ok(rendered.stdout.includes("README Quickstart"));
    assert.ok(rendered.stdout.includes("tonedial test codex --preset vibe-coder"));
    assert.ok(rendered.stdout.includes("2026-10-18"));

    const examples = readFileSync(join(root, "docs", language === "en" ? "EXAMPLES.md" : `EXAMPLES.${language}.md`), "utf8");
    assert.ok(examples.includes(language === "en" ? "../README.md#same-model-a-tighter-plan" : `../README.${language}.md`));
  }
});
