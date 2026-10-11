import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { join } from "node:path";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { defaultConfig, serializeConfig } from "../src/core/config.ts";
import { catalogue } from "../src/core/i18n.ts";
import { resolvePaths, type Paths } from "../src/core/paths.ts";
import {
  GUIDE_MD,
  inspectContextLayout,
  seedFiles,
  seedRecord,
  type ContextConsumerCheck,
  type ContextLayoutInspection,
} from "../src/core/seeds.ts";
import { gate, isNoop, planChange } from "../src/wiring/apply.ts";
import { palette } from "../src/ui/style.ts";

const EN = catalogue("en").cli;
let scratch = "";
let paths: Paths;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-context-layout-"));
  paths = resolvePaths({ HOME: scratch, TONEDIAL_HOME: join(scratch, "state") });
  mkdirSync(paths.root, { recursive: true });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function inspect(
  config: ReturnType<typeof defaultConfig> | null = null,
  options: Partial<Parameters<typeof inspectContextLayout>[3]> = {},
): ContextLayoutInspection {
  const configRead = planChange(paths.config, (before) => before, EN, undefined, paths.root);
  return inspectContextLayout(paths, configRead, EN, {
    config,
    ...options,
  });
}

async function writeCurrentPair(): Promise<{ config: ReturnType<typeof defaultConfig>; artifact: string }> {
  const guide = seedFiles(paths, { native: false }).find((seed) => seed.id === "guide")!;
  const artifact = "# generated tone\n";
  const config = defaultConfig();
  config.managedSeeds.guide = seedRecord(guide);
  const configChange = planChange(paths.config, () => serializeConfig(config), EN, undefined, paths.root);
  const guideChange = planChange(paths.agents, () => GUIDE_MD, EN, undefined, paths.root);
  const artifactChange = planChange(paths.tone, () => artifact, EN, undefined, paths.root);
  await gate([guideChange, artifactChange], {
    paths,
    finalChanges: [configChange],
    t: EN,
    auto: true,
    dryRun: false,
    out: () => {},
    ui: palette("never", {}, false),
  });
  return { config, artifact };
}

test("an empty dedicated root is fresh and returns only identity checks", () => {
  const result = inspect();
  assert.deepEqual({ kind: result.kind, cause: result.cause }, { kind: "fresh", cause: "none" });
  assert.deepEqual(result.checks.map((change) => change.path), [
    paths.config,
    paths.agents,
    paths.tone,
    join(paths.root, "tone.md"),
  ]);
  assert.ok(result.checks.every((change) => isNoop(change)));
});

test("a stable state-root alias stays read-only inspectable without changing its entry or referent", () => {
  const alias = join(scratch, "state-alias");
  symlinkSync(paths.root, alias, "dir");
  const aliasPaths = resolvePaths({ HOME: scratch, TONEDIAL_HOME: alias });
  const configRead = planChange(aliasPaths.config, (before) => before, EN, undefined, aliasPaths.root);
  const result = inspectContextLayout(aliasPaths, configRead, EN, { config: null });
  assert.deepEqual({ kind: result.kind, cause: result.cause }, { kind: "fresh", cause: "none" });
  assert.ok(result.checks.every((change) => isNoop(change)));
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(paths.root), []);
});

test("a journaled managed pair is current", async () => {
  const { config, artifact } = await writeCurrentPair();
  const result = inspect(config, { expectedArtifact: artifact });
  assert.deepEqual({ kind: result.kind, cause: result.cause }, { kind: "current", cause: "none" });
  assert.equal(result.legacyWitness, "not-applicable");
  assert.ok(result.checks.every((change) => isNoop(change)));
});

test("application integrity remains inspectable without relying on a completed journal's ownership labels", async () => {
  const { config, artifact } = await writeCurrentPair();
  const journals = readdirSync(paths.operations).filter((name) => name.endsWith(".json"));
  assert.equal(journals.length, 1);
  const journalPath = join(paths.operations, journals[0]!);
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const toneIndex = journal.actions.findIndex((action: { path: string }) => action.path === paths.tone);
  assert.ok(toneIndex >= 0);
  assert.ok(journal.actions.length > 1);
  journal.completed = [toneIndex];
  writeFileSync(journalPath, JSON.stringify(journal));
  const result = inspect(config, { expectedArtifact: artifact });
  assert.deepEqual({ kind: result.kind, cause: result.cause }, { kind: "current", cause: "none" });
  assert.equal(readFileSync(paths.tone, "utf8"), artifact);
});

test("current artifact ownership survives an unrelated completed journal", async () => {
  const { config, artifact } = await writeCurrentPair();
  const unrelated = planChange(join(paths.root, "unrelated.txt"), () => "unrelated\n", EN, undefined, paths.root);
  await gate([unrelated], {
    paths,
    auto: true,
    dryRun: false,
    out: () => {},
    ui: palette("never", {}, false),
    t: EN,
  });
  const result = inspect(config, { expectedArtifact: artifact });
  assert.deepEqual({ kind: result.kind, cause: result.cause }, { kind: "current", cause: "none" });
});

test("a recorded uppercase layout with a missing artifact is current repair", async () => {
  const { config, artifact } = await writeCurrentPair();
  rmSync(paths.tone);
  const result = inspect(config, { expectedArtifact: artifact });
  assert.deepEqual({ kind: result.kind, cause: result.cause }, { kind: "current", cause: "repair" });
  assert.ok(result.checks.every((change) => isNoop(change)));
});

test("lowercase-only state is legacy and equal bytes without a journal are not a witness", () => {
  const legacy = join(paths.root, "tone.md");
  writeFileSync(legacy, "# generated tone\n");
  const result = inspect(null, { expectedArtifact: "# generated tone\n" });
  assert.deepEqual({ kind: result.kind, cause: result.cause }, { kind: "legacy", cause: "legacy" });
  assert.equal(result.legacyWitness, "absent");
});

test("known lower delivery keeps the layout legacy without scanning arbitrary projects", () => {
  const consumerPath = join(scratch, "known-consumer.md");
  writeFileSync(consumerPath, "legacy delivery\n");
  const change = planChange(consumerPath, (before) => before, EN);
  const consumer: ContextConsumerCheck = { id: "registration:claude", legacy: true, change };
  const result = inspect(null, { consumers: [consumer] });
  assert.deepEqual({ kind: result.kind, cause: result.cause }, { kind: "legacy", cause: "legacy" });
  assert.deepEqual(result.legacyConsumers, ["registration:claude"]);
  assert.ok(!result.checks.includes(change), "an external consumer read is not an application mutation witness");
  assert.equal(readFileSync(consumerPath, "utf8"), "legacy delivery\n");
});

test("an uppercase file without guide/journal provenance is a foreign conflict", () => {
  writeFileSync(paths.tone, "# generated tone\n");
  const result = inspect(null, { expectedArtifact: "# generated tone\n" });
  assert.deepEqual({ kind: result.kind, cause: result.cause }, { kind: "conflict", cause: "foreign" });
});

test("distinct uppercase and lowercase entries are a case collision", (t) => {
  writeFileSync(paths.tone, "uppercase\n");
  writeFileSync(join(paths.root, "tone.md"), "lowercase\n");
  // macOS's default volume preserves one directory entry for these spellings, so there is no
  // distinct collision to inspect in this fixture. Linux CI exercises the actual two-entry case.
  const names = readdirSync(paths.root);
  if (!names.includes("TONE.md") || !names.includes("tone.md")) {
    t.skip("filesystem aliases the two case spellings");
    return;
  }
  const result = inspect(null, { expectedArtifact: "uppercase\n" });
  assert.deepEqual({ kind: result.kind, cause: result.cause }, { kind: "conflict", cause: "case-collision" });
});

test("instruction-root overlap is a structured conflict before layout writes", () => {
  const result = inspect(null, { instructionRoots: [paths.root] });
  assert.deepEqual({ kind: result.kind, cause: result.cause }, { kind: "conflict", cause: "overlap" });
  assert.ok(result.checks.every((change) => isNoop(change)));
});

test("any operation-lock entry blocks the otherwise fresh classification", () => {
  mkdirSync(paths.operationsLock);
  const result = inspect();
  assert.deepEqual({ kind: result.kind, cause: result.cause }, { kind: "fresh", cause: "operation" });
});
