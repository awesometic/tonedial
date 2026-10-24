import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { Config } from "../src/core/compile.ts";
import { assertRecordedTone } from "./support/recorded-tone.ts";
import { AXIS_ORDER } from "../src/core/anchors.ts";
import { BUNDLED, localizedPreset } from "../src/core/presets.ts";
import { catalogue, LANGUAGES } from "../src/core/i18n.ts";
import { maxCells } from "../src/ui/width.ts";
import { captureCli, createGoldenWorkspace } from "./support/golden.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const quote = (text: string) => text.split("\n").map(line => line ? "> " + line : ">").join("\n");

type Reply = {
  preset: string;
  input: Config;
  tone: string;
  toneSha256: string;
  text: string;
  responseSha256: string;
  agentMessageSha256: string;
  samples: number;
  nativeExit: number;
  toolCallsObserved: number;
  stateAndTargetUnchanged: boolean;
  promptSha256?: string;
  openingResponseSha256?: string;
  openingResponseText: string;
  preQuestionResponses: string[];
  preQuestionResponseSha256: string[];
  intensityApprovalOrder: "not-required" | "named-before-approval" | "approval-before-naming";
  nativeModel?: string;
  nativeReasoningEffort?: string;
  nativeTurnCount?: number;
  intensityApproval: string | null;
  intensityApprovalSha256: string | null;
  capture?: {
    model: string; reasoningEffort: string; recordedOn: string;
    productRevision: string; delivery: string; clientVersion: string;
    questionSha256: string;
  };
};

function expectedNativeTurnCount(reply: Reply): number {
  const axisRequestsApproval = reply.input.axes.profanity >= 4 || reply.input.axes.critique === 5;
  assert.equal(reply.intensityApproval !== null, axisRequestsApproval,
    "public axis-selected intensity needs one recorded approval turn");
  if (reply.intensityApproval === null) {
    assert.equal(reply.intensityApprovalSha256, null);
    assert.equal(reply.intensityApprovalOrder, "not-required");
    return 2;
  }
  assert.equal(reply.intensityApprovalSha256, hash(reply.intensityApproval));
  assert.match(reply.intensityApprovalOrder, /^(?:named-before-approval|approval-before-naming)$/);
  return 3;
}

function assertRecapture(reply: Reply, question: string): void {
  assert.ok(reply.capture, "changed recordings need their own capture metadata");
  assert.equal(reply.capture.delivery, "tonedial-test-native-interactive");
  assert.equal(reply.capture.model, "gpt-6.1-sol");
  assert.equal(reply.capture.reasoningEffort, "high");
  assert.equal(reply.capture.questionSha256, hash(question));
  assert.match(reply.capture.productRevision, /^[a-f0-9]{40}$/);
  assert.match(reply.capture.recordedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(reply.capture.clientVersion.trim());
  assert.equal(reply.nativeModel, reply.capture.model);
  assert.equal(reply.nativeReasoningEffort, reply.capture.reasoningEffort);
  assert.equal(reply.nativeTurnCount, expectedNativeTurnCount(reply));
  assert.match(reply.promptSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(reply.openingResponseSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(hash(reply.openingResponseText), reply.openingResponseSha256);
}

type Recipe = Omit<Reply, "preset"> & {
  slug: string;
  title: string;
  description: string;
  argv: string[];
  command: string;
  promptSha256: string;
  agentMessageSha256: string;
  nativeModel: string;
  nativeReasoningEffort: string;
  nativeTurnCount: number;
};

const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
function recipeCommand(argv: string[]): string {
  return [
    `tonedial create ${shellQuote(argv[1]!)} --slug ${argv[3]} --auto`,
    ...[5, 9, 13].map(start => argv.slice(start, start + 4).join(" ")),
    argv.slice(17, 22).map(shellQuote).join(" "),
    ...argv.slice(22).map(shellQuote),
  ].join(" \\\n  ");
}

for (const language of LANGUAGES) {
  test("recorded " + language + " use cases preserve native replies and reproducible complete profiles", async t => {
    const data = JSON.parse(readFileSync(join(root, "docs/media/readme", language, "use-cases.json"), "utf8")) as {
      kind: string; language: string; delivery: string; question: string; questionSha256: string;
      model: string; reasoningEffort: string; client: string; clientVersion: string; productRevision: string;
      candidateSourceSha256: string; candidateRuntimeSha256: string; recordedOn: string;
      hookActivationVerified: boolean; adherenceScored: boolean; recipes: Recipe[];
    };
    assert.equal(data.kind, "recorded-native-use-cases");
    assert.equal(data.language, language);
    assert.equal(data.delivery, "tonedial-test-native-interactive");
    assert.equal(data.model, "gpt-6.1-sol");
    assert.equal(data.reasoningEffort, "high");
    assert.equal(hash(data.question), data.questionSha256);
    for (const value of [data.client, data.clientVersion]) assert.ok(value.trim());
    for (const value of [data.candidateSourceSha256, data.candidateRuntimeSha256]) assert.match(value, /^[a-f0-9]{64}$/);
    assert.match(data.productRevision, /^[a-f0-9]{40}$/);
    assert.match(data.recordedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(data.hookActivationVerified, false);
    assert.equal(data.adherenceScored, false);
    assert.deepEqual(data.recipes.map(recipe => recipe.slug), ["vibe-coder", "steady-companion", "rough-but-reliable"]);

    const readme = readFileSync(join(root, language === "en" ? "README.md" : `README.${language}.md`), "utf8");
    assert.ok(readme.includes(`https://github.com/awesometic/tonedial/blob/main/docs/media/readme/${language}/use-cases.json`));
    assert.ok(readme.includes(data.question), "README must preserve the actual question");
    const recipeDetails = [...readme.matchAll(/<details>\s*<summary>[^<]+<\/summary>([\s\S]*?)<\/details>/gu)]
      .map(match => match[1]!);
    assert.equal(recipeDetails.length, data.recipes.length, "each recipe needs one collapsed command-and-reply block");
    const workspace = createGoldenWorkspace("en");
    t.after(() => workspace.dispose());
    const initialized = await captureCli(workspace, ["init", "--global", "--tools", "none", "--lang", language, "--auto", "--json"]);
    assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
    for (const recipe of data.recipes) {
      if (recipe.capture) {
        assertRecapture({ ...recipe, preset: recipe.slug }, data.question);
      }
      assert.equal(recipe.samples, 1);
      assert.equal(Object.hasOwn(recipe, "failedBeforeCompletion"), false, "current batch must not retain stale attempt counters");
      assert.equal(recipe.nativeExit, 0);
      assert.equal(recipe.toolCallsObserved, 0);
      assert.equal(recipe.stateAndTargetUnchanged, true);
      assert.equal(recipe.nativeModel, data.model);
      assert.equal(recipe.nativeReasoningEffort, data.reasoningEffort);
      assert.equal(recipe.nativeTurnCount, expectedNativeTurnCount({ ...recipe, preset: recipe.slug }),
        "native session must contain the opening, optional intensity approval and separate question");
      if (language === "ko" && recipe.slug === "vibe-coder") assert.equal(recipe.input.persona?.address?.user_ref, "사장님");
      if (language === "ko" && recipe.slug === "rough-but-reliable") assert.equal(recipe.input.persona?.address?.user_ref, "야");
      assert.ok(recipe.text.trim());
      assert.equal(hash(recipe.text), recipe.responseSha256);
      assert.equal(recipe.agentMessageSha256, recipe.responseSha256);
      assert.match(recipe.promptSha256, /^[a-f0-9]{64}$/);
      assert.equal(hash(recipe.openingResponseText), recipe.openingResponseSha256);
      assert.deepEqual(recipe.preQuestionResponseSha256, recipe.preQuestionResponses.map(hash));
      assert.equal(recipe.preQuestionResponses.length, recipe.nativeTurnCount - 1);
      assert.equal(recipe.preQuestionResponses[0], recipe.openingResponseText);
      assert.equal(hash(recipe.tone), recipe.toneSha256);
      assertRecordedTone(recipe.input, recipe.tone);
      assert.equal(recipe.input.preset, recipe.slug);
      assert.deepEqual(recipe.argv.slice(0, 5), ["create", recipe.title, "--slug", recipe.slug, "--auto"]);
      assert.deepEqual(recipe.argv.slice(5).map(arg => arg.slice(0, arg.indexOf("="))), [
        ...AXIS_ORDER, "speech_level", "persona.age", "persona.gender", "persona.note", "safeword",
        "persona.self_ref", "persona.user_ref", "persona.user", "persona.agent",
      ], "captured recipes must retain their complete historical assignments");
      assert.equal(recipe.command, recipeCommand(recipe.argv));
      assert.ok(readme.includes(recipe.title));
      assert.ok(readme.includes(recipe.description));
      assert.ok(readme.includes("```bash\n" + recipe.command + "\n```"), recipe.slug + ": README changed or omitted the command");
      assert.ok(readme.includes(quote(recipe.text)), recipe.slug + ": README changed or omitted the native response");
      assert.ok(recipeDetails.some(block => block.includes(recipe.command) && block.includes(quote(recipe.text))),
        recipe.slug + ": command and reply must stay in the same collapsed block");
      const created = await captureCli(workspace, [...recipe.argv, "--json"]);
      assert.equal(created.status, 0, created.stdout + created.stderr);
      const payload = JSON.parse(created.stdout);
      assert.equal(payload.created, true);
      assert.deepEqual(payload.config, { ...recipe.input, address_frequency: "auto" }, recipe.slug + ": captured fields changed; new frequency defaults to auto");
    }
  });

  test("recorded " + language + " examples preserve seven native replies and feature only two roles", () => {
    const dir = join(root, "docs/media/readme", language);
    const data = JSON.parse(readFileSync(join(dir, "voice-examples.json"), "utf8")) as {
      kind: string; language: string; question: string; questionSha256: string; recordedOn: string;
      model: string; reasoningEffort: string; client: string; clientVersion: string; productRevision: string;
      candidateSourceSha256: string; candidateRuntimeSha256: string; delivery: string;
      hookActivationVerified: boolean; adherenceScored: boolean; featured: string[]; replies: Reply[];
    };
    assert.equal(data.kind, "recorded-native-replies");
    assert.equal(data.language, language);
    assert.equal(data.delivery, "tonedial-test-native-interactive");
    assert.equal(data.model, "gpt-6.1-sol");
    assert.equal(data.reasoningEffort, "high");
    assert.equal(hash(data.question), data.questionSha256);
    for (const value of [data.client, data.clientVersion]) assert.ok(value.trim());
    for (const value of [data.candidateSourceSha256, data.candidateRuntimeSha256]) assert.match(value, /^[a-f0-9]{64}$/);
    assert.match(data.productRevision, /^[a-f0-9]{40}$/);
    assert.match(data.recordedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(data.hookActivationVerified, false);
    assert.equal(data.adherenceScored, false);
    assert.deepEqual(data.featured, ["royal-advisor", "ego-sword"]);
    assert.deepEqual(data.replies.map(reply => reply.preset), BUNDLED.map(preset => preset.slug));
    const pageName = language === "en" ? "EXAMPLES.md" : `EXAMPLES.${language}.md`;
    const page = readFileSync(join(root, "docs", pageName), "utf8");
    assert.equal((page.match(/<img src=/g) ?? []).length, data.replies.length, "each preset needs its own visible conversation image");
    for (const reply of data.replies) {
      if (reply.capture) assertRecapture(reply, data.question);
      assert.equal(reply.samples, 1);
      assert.equal(Object.hasOwn(reply, "failedBeforeCompletion"), false, "current batch must not retain stale attempt counters");
      assert.equal(reply.nativeExit, 0);
      assert.equal(reply.toolCallsObserved, 0);
      assert.equal(reply.stateAndTargetUnchanged, true);
      assert.equal(reply.nativeTurnCount, expectedNativeTurnCount(reply));
      assert.ok(reply.text.trim());
      assert.equal(hash(reply.text), reply.responseSha256);
      assert.equal(reply.agentMessageSha256, reply.responseSha256);
      assert.equal(hash(reply.openingResponseText), reply.openingResponseSha256);
      assert.deepEqual(reply.preQuestionResponseSha256, reply.preQuestionResponses.map(hash));
      assert.equal(reply.preQuestionResponses.length, reply.nativeTurnCount! - 1);
      assert.equal(reply.preQuestionResponses[0], reply.openingResponseText);
      assert.equal(hash(reply.tone), reply.toneSha256);
      assertRecordedTone(reply.input, reply.tone);
      const preset = localizedPreset(BUNDLED.find(preset => preset.slug === reply.preset)!, catalogue(language).cli);
      assert.deepEqual(reply.input.persona, preset.settings!.persona);
      assert.ok(page.includes(quote(reply.text)), reply.preset + ": page changed or omitted the native response");
      const imageName = `voice-${reply.preset}.svg`;
      assert.ok(page.includes(`https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/${language}/${imageName}`), reply.preset + ": gallery image missing");
      const single = spawnSync(process.execPath, [join(root, "scripts/voice-svg.ts"), language, reply.preset], { cwd: root, encoding: "utf8" });
      assert.equal(single.status, 0, single.stderr);
      assert.equal(single.stdout, readFileSync(join(dir, imageName), "utf8"));
      const renderedOn = reply.capture?.recordedOn ?? data.recordedOn;
      assert.ok(single.stdout.includes(renderedOn), "use each reply's actual recording date");
      assert.ok(single.stdout.includes(`$ tonedial test codex --preset ${reply.preset}`));
      assert.ok(single.stdout.includes(escape(data.question)));
      assert.ok(single.stdout.includes("&gt; "));
      const svgLines = single.stdout.split("\n");
      const visibleResponse = svgLines.slice(
        svgLines.findIndex(line => line.includes(">codex</text>")) + 1,
        svgLines.findLastIndex(line => line.startsWith("<text") && line.includes(renderedOn)),
      );
      for (const match of reply.text.matchAll(/`([^`\n]+)`/gu)) {
        assert.ok(visibleResponse.some(line => line.includes(escape(match[1]!))),
          `${language}/${reply.preset}: inline code split across visible rows: ${match[1]}`);
      }
      for (const row of visibleResponse) {
        const plain = row.replace(/<[^>]+>/g, "").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&").trim();
        assert.ok(maxCells(plain) <= 68, `${language}/${reply.preset}: visible response row exceeds 68 cells`);
        assert.doesNotMatch(plain, /^[。，、！？；：）》」』】〕〉》…]+$/u,
          `${language}/${reply.preset}: closing punctuation is orphaned`);
      }
      for (const other of data.replies) {
        assert.equal(single.stdout.includes(escape(other.text)), other.preset === reply.preset, reply.preset + ": wrong transcript in image");
      }
    }
    const rendered = spawnSync(process.execPath, [join(root, "scripts/voice-svg.ts"), language], { cwd: root, encoding: "utf8" });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal(rendered.stdout, readFileSync(join(dir, "voice-examples.svg"), "utf8"));
    assert.doesNotMatch(rendered.stdout, /\b(?:textLength|lengthAdjust)=/);
    for (const reply of data.replies) {
      assert.equal(rendered.stdout.includes(escape(reply.text)), data.featured.includes(reply.preset), reply.preset + ": README featured selection");
    }
    const readme = readFileSync(join(root, language === "en" ? "README.md" : `README.${language}.md`), "utf8");
    assert.ok(readme.includes("docs/media/readme/" + language + "/voice-examples.svg"));
    assert.ok(readme.includes("docs/" + pageName));
    for (const other of LANGUAGES.filter(other => other !== language)) {
      assert.ok(page.includes(other === "en" ? "./EXAMPLES.md" : `./EXAMPLES.${other}.md`), `${language}: missing ${other} gallery link`);
      assert.ok(readme.includes(other === "en" ? "/README.md" : `/README.${other}.md`), `${language}: missing ${other} README link`);
    }
  });
}

test("the public batch preserves the invalid approval order instead of treating it as consent", () => {
  const invalid: { language: string; preset: string; order: Reply["intensityApprovalOrder"] }[] = [];
  let named = 0;
  let ordinary = 0;
  for (const language of LANGUAGES) {
    for (const file of ["voice-examples.json", "use-cases.json"] as const) {
      const data = JSON.parse(readFileSync(join(root, "docs/media/readme", language, file), "utf8"));
      for (const record of data.replies ?? data.recipes) {
        if (record.intensityApprovalOrder === "approval-before-naming") {
          invalid.push({ language, preset: record.preset ?? record.slug, order: record.intensityApprovalOrder });
        } else if (record.intensityApprovalOrder === "named-before-approval") named += 1;
        else if (record.intensityApprovalOrder === "not-required") ordinary += 1;
      }
    }
  }
  assert.deepEqual(invalid, [
    { language: "zh", preset: "heavenly-demon", order: "approval-before-naming" },
  ]);
  assert.equal(named, 9);
  assert.equal(ordinary, 40);
});

test("the public batch exposes candidate and before/after manifests for its provenance claims", () => {
  const manifestPath = join(root, "docs/media/readme/capture-v7-manifest.json");
  const serialized = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(serialized) as {
    productRevision: string;
    candidateSource: { sha256: string; files: Record<string, string> };
    candidateRuntime: { sha256: string; files: Record<string, string> };
    cases: { id: string; stateBefore: unknown[]; stateAfter: unknown[]; projectBefore: unknown[]; projectAfter: unknown[] }[];
  };
  assert.doesNotMatch(serialized, /\/Users\/|\/private\/|rollout-/);
  assert.equal(hash(JSON.stringify(manifest.candidateSource.files)), manifest.candidateSource.sha256);
  assert.equal(hash(JSON.stringify(manifest.candidateRuntime.files)), manifest.candidateRuntime.sha256);
  assert.equal(manifest.cases.length, 50);
  for (const item of manifest.cases) {
    assert.deepEqual(item.stateAfter, item.stateBefore, `${item.id}: recorded state changed`);
    assert.deepEqual(item.projectAfter, item.projectBefore, `${item.id}: recorded project changed`);
  }
  for (const [path, expected] of Object.entries(manifest.candidateSource.files)) {
    const shown = spawnSync("git", ["show", `${manifest.productRevision}:${path}`], { cwd: root });
    assert.equal(shown.status, 0, `${path}: missing from product revision`);
    assert.equal(createHash("sha256").update(shown.stdout).digest("hex"), expected, `${path}: product revision bytes differ`);
  }
  for (const language of LANGUAGES) {
    for (const file of ["voice-examples.json", "use-cases.json"]) {
      const data = JSON.parse(readFileSync(join(root, "docs/media/readme", language, file), "utf8"));
      assert.equal(data.captureManifest, "docs/media/readme/capture-v7-manifest.json");
      for (const record of data.replies ?? data.recipes) assert.equal(record.stateAndTargetUnchanged, true);
    }
  }
});

test("the transcript renderer refuses an unknown preset without emitting an image", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts/voice-svg.ts"), "en", "missing-preset"], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Select one recorded preset/);
});
