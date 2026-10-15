import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { compile, type Config } from "../src/core/compile.ts";
import { BUNDLED, localizedPreset } from "../src/core/presets.ts";
import { catalogue, LANGUAGES } from "../src/core/i18n.ts";

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

for (const language of LANGUAGES) {
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
