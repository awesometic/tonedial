import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { compile, type Config } from "../src/core/compile.ts";
import { BUNDLED, localizedPreset } from "../src/core/presets.ts";
import { catalogue } from "../src/core/i18n.ts";

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

for (const language of ["en", "ko"] as const) {
  test("recorded " + language + " examples preserve seven native replies and feature only two roles", () => {
    const dir = join(root, "docs/media/readme", language);
    const data = JSON.parse(readFileSync(join(dir, "voice-examples.json"), "utf8")) as {
      kind: string; language: string; featured: string[]; replies: Reply[];
    };
    assert.equal(data.kind, "recorded-native-replies");
    assert.equal(data.language, language);
    assert.deepEqual(data.featured, ["royal-advisor", "ego-sword"]);
    assert.deepEqual(data.replies.map(reply => reply.preset), BUNDLED.map(preset => preset.slug));
    const page = readFileSync(join(root, language === "en" ? "docs/EXAMPLES.md" : "docs/EXAMPLES.ko.md"), "utf8");
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
    }
    const rendered = spawnSync(process.execPath, [join(root, "scripts/voice-svg.ts"), language], { cwd: root, encoding: "utf8" });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal(rendered.stdout, readFileSync(join(dir, "voice-examples.svg"), "utf8"));
    assert.doesNotMatch(rendered.stdout, /\b(?:textLength|lengthAdjust)=/);
    for (const reply of data.replies) {
      assert.equal(rendered.stdout.includes(escape(reply.text)), data.featured.includes(reply.preset), reply.preset + ": README featured selection");
    }
    const readme = readFileSync(join(root, language === "en" ? "README.md" : "README.ko.md"), "utf8");
    assert.ok(readme.includes("docs/media/readme/" + language + "/voice-examples.svg"));
    assert.ok(readme.includes(language === "en" ? "docs/EXAMPLES.md" : "docs/EXAMPLES.ko.md"));
  });
}
