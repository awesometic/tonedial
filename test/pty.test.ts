// Real PTY checks cover process lifecycle and terminal restoration beyond fake stream tests.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { selectedGoldenLanguages } from "./support/golden.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const driver = join(root, "test", "support", "pty.py");
const binary = join(root, "dist", "bin.js");
const ptySkipReason = process.platform === "linux" || process.platform === "darwin"
  ? false
  : `PTY checks require Linux or macOS (platform: ${process.platform})`;

function failureArtifact(language: string, stdout: string, stderr: string): void {
  const directory = join(root, "artifacts", "pty", language);
  mkdirSync(directory, { recursive: true });
  const redact = (value: string) => value.split(root).join("<repository>");
  writeFileSync(
    join(directory, "failure.json"),
    JSON.stringify({ language, stdout: redact(stdout), stderr: redact(stderr) }, null, 2) + "\n",
  );
}

for (const language of selectedGoldenLanguages()) {
  test(`compiled CLI core flows restore a real PTY (${language})`, { skip: ptySkipReason }, () => {
    const result = spawnSync("python3", [driver, "--root", root, "--language", language, "--node", process.execPath, "--binary", binary], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: language === "ko" ? "ko_KR.UTF-8" : "en_US.UTF-8",
        LC_CTYPE: "C.UTF-8",
        TMPDIR: "/tmp",
        PYTHONIOENCODING: "utf-8",
      },
    });
    if (result.error) {
      failureArtifact(language, result.stdout ?? "", `${result.stderr ?? ""}\n${result.error.message}`);
    }
    assert.equal(result.error, undefined, `python3 PTY driver could not start: ${result.error?.message ?? "unknown error"}`);
    if (result.status !== 0) {
      failureArtifact(language, result.stdout ?? "", result.stderr ?? "");
    }
    assert.equal(result.status, 0, `${language} PTY flow failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    let receipt: { ok: boolean; language: string };
    try {
      receipt = JSON.parse(result.stdout.trim()) as { ok: boolean; language: string };
    } catch (error) {
      failureArtifact(language, result.stdout ?? "", `${result.stderr ?? ""}\n${String(error)}`);
      throw error;
    }
    if (!receipt.ok || receipt.language !== language) {
      failureArtifact(language, result.stdout ?? "", result.stderr ?? "");
    }
    assert.equal(receipt.ok, true, `${language} PTY driver returned a failed receipt`);
    assert.equal(receipt.language, language);
  });
}
