import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { compile, type Config } from "../src/core/compile.ts";
import { AXIS_ORDER } from "../src/core/anchors.ts";
import { BUNDLED, localizedPreset } from "../src/core/presets.ts";
import { catalogue, LANGUAGES } from "../src/core/i18n.ts";
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
  samples: number;
  nativeExit: number;
  toolCallsObserved: number;
};

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
      hookActivationVerified: boolean; adherenceScored: boolean; recipes: Recipe[];
    };
    assert.equal(data.kind, "recorded-native-use-cases");
    assert.equal(data.language, language);
    assert.equal(data.delivery, "tonedial-test-native-interactive");
    assert.equal(data.model, "gpt-6.1-sol");
    assert.equal(data.reasoningEffort, "high");
    assert.equal(hash(data.question), data.questionSha256);
    for (const value of [data.client, data.clientVersion]) assert.ok(value.trim());
    assert.match(data.productRevision, /^[a-f0-9]{40}$/);
    assert.equal(data.hookActivationVerified, false);
    assert.equal(data.adherenceScored, false);
    assert.deepEqual(data.recipes.map(recipe => recipe.slug), ["vibe-coder", "steady-companion", "rough-but-reliable"]);

    const readme = readFileSync(join(root, language === "en" ? "README.md" : `README.${language}.md`), "utf8");
    assert.ok(readme.includes(`https://github.com/awesometic/tonedial/blob/main/docs/media/readme/${language}/use-cases.json`));
    assert.ok(readme.includes(data.question), "README must preserve the actual question");
    const workspace = createGoldenWorkspace("en");
    t.after(() => workspace.dispose());
    const initialized = await captureCli(workspace, ["init", "--global", "--tools", "none", "--lang", language, "--auto", "--json"]);
    assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
    for (const recipe of data.recipes) {
      assert.equal(recipe.samples, 1);
      assert.equal(recipe.nativeExit, 0);
      assert.equal(recipe.toolCallsObserved, 0);
      assert.equal(recipe.nativeModel, data.model);
      assert.equal(recipe.nativeReasoningEffort, data.reasoningEffort);
      assert.equal(recipe.nativeTurnCount, 2, "native session must contain the opening and separate question");
      if (language === "ko" && recipe.slug === "vibe-coder") assert.equal(recipe.input.persona?.address?.user_ref, "사장님");
      if (language === "ko" && recipe.slug === "rough-but-reliable") assert.equal(recipe.input.persona?.address?.user_ref, "야");
      assert.ok(recipe.text.trim());
      assert.equal(hash(recipe.text), recipe.responseSha256);
      assert.equal(recipe.agentMessageSha256, recipe.responseSha256);
      assert.match(recipe.promptSha256, /^[a-f0-9]{64}$/);
      assert.equal(hash(recipe.tone), recipe.toneSha256);
      assert.equal(compile(recipe.input), recipe.tone);
      assert.equal(recipe.input.preset, recipe.slug);
      assert.deepEqual(recipe.argv.slice(0, 5), ["create", recipe.title, "--slug", recipe.slug, "--auto"]);
      assert.deepEqual(recipe.argv.slice(5).map(arg => arg.slice(0, arg.indexOf("="))), [
        ...AXIS_ORDER, "speech_level", "persona.age", "persona.gender", "persona.note", "safeword",
        "persona.self_ref", "persona.user_ref", "persona.user", "persona.agent",
      ], "recipes must set every tone field rather than inherit the reader's current profile");
      assert.equal(recipe.command, recipeCommand(recipe.argv));
      assert.ok(readme.includes(recipe.title));
      assert.ok(readme.includes(recipe.description));
      assert.ok(readme.includes("```bash\n" + recipe.command + "\n```"), recipe.slug + ": README changed or omitted the command");
      assert.ok(readme.includes(quote(recipe.text)), recipe.slug + ": README changed or omitted the native response");
      const created = await captureCli(workspace, [...recipe.argv, "--json"]);
      assert.equal(created.status, 0, created.stdout + created.stderr);
      const payload = JSON.parse(created.stdout);
      assert.equal(payload.created, true);
      assert.deepEqual(payload.config, recipe.input, recipe.slug + ": copied command differs from the recorded tone");
    }
  });

  test("recorded " + language + " examples preserve seven native replies and feature only two roles", () => {
    const dir = join(root, "docs/media/readme", language);
    const data = JSON.parse(readFileSync(join(dir, "voice-examples.json"), "utf8")) as {
      kind: string; language: string; question: string; featured: string[]; replies: Reply[];
    };
    assert.equal(data.kind, "recorded-native-replies");
    assert.equal(data.language, language);
    assert.deepEqual(data.featured, ["royal-advisor", "ego-sword"]);
    assert.deepEqual(data.replies.map(reply => reply.preset), BUNDLED.map(preset => preset.slug));
    const pageName = language === "en" ? "EXAMPLES.md" : `EXAMPLES.${language}.md`;
    const page = readFileSync(join(root, "docs", pageName), "utf8");
    assert.equal((page.match(/<img src=/g) ?? []).length, data.replies.length, "each preset needs its own visible conversation image");
    for (const reply of data.replies) {
      assert.equal(reply.samples, 1);
      assert.equal(reply.nativeExit, 0);
      assert.equal(reply.toolCallsObserved, 0);
      assert.ok(reply.text.trim());
      assert.equal(hash(reply.text), reply.responseSha256);
      assert.equal(hash(reply.tone), reply.toneSha256);
      assert.equal(compile(reply.input), reply.tone);
      const preset = localizedPreset(BUNDLED.find(preset => preset.slug === reply.preset)!, catalogue(language).cli);
      assert.deepEqual(reply.input.persona, preset.settings!.persona);
      assert.ok(page.includes(quote(reply.text)), reply.preset + ": page changed or omitted the native response");
      const imageName = `voice-${reply.preset}.svg`;
      assert.ok(page.includes(`https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/${language}/${imageName}`), reply.preset + ": gallery image missing");
      const single = spawnSync(process.execPath, [join(root, "scripts/voice-svg.ts"), language, reply.preset], { cwd: root, encoding: "utf8" });
      assert.equal(single.status, 0, single.stderr);
      assert.equal(single.stdout, readFileSync(join(dir, imageName), "utf8"));
      assert.ok(single.stdout.includes(`$ tonedial test codex --preset ${reply.preset}`));
      assert.ok(single.stdout.includes(escape(data.question)));
      assert.ok(single.stdout.includes("&gt; "));
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

test("the transcript renderer refuses an unknown preset without emitting an image", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts/voice-svg.ts"), "en", "missing-preset"], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Select one recorded preset/);
});
