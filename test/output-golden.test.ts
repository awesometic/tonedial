import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { COMMAND_NAMES } from "../src/cli.ts";
import { catalogue } from "../src/core/i18n.ts";
import {
  assertGolden,
  captureCli,
  createGoldenWorkspace,
  formatCapture,
  goldenArtifactDirectory,
  goldenPath,
  normalizeCapture,
  selectedGoldenLanguages,
  type GoldenLanguage,
  type GoldenWorkspace,
} from "./support/golden.ts";

type Scenario = {
  expected: number;
  setup?: (workspace: GoldenWorkspace, language: GoldenLanguage) => Promise<void>;
  args: (workspace: GoldenWorkspace, language: GoldenLanguage) => string[];
};

const init = async (workspace: GoldenWorkspace, language: GoldenLanguage, tools = "none"): Promise<void> => {
  const result = await captureCli(workspace, ["init", "--here", "--tools", tools, "--lang", language, "--auto"]);
  assert.equal(result.status, 0, `setup init failed: ${result.stderr}`);
  assert.ok(result.stdout.includes(catalogue(language).init.scopeHeading), `${language}: setup did not render its selected locale`);
};

const initialized = (args: (workspace: GoldenWorkspace, language: GoldenLanguage) => string[]): Scenario => ({
  expected: 0,
  setup: async (workspace, language) => init(workspace, language),
  args,
});

const scenarios: Record<string, Scenario> = {
  set: initialized(() => ["set", "warmth=5"]),
  test: initialized(() => ["test", "codex", "--dry-run"]),
  address: initialized(() => ["address", "self", "user"]),
  reset: {
    ...initialized(() => ["reset", "warmth"]),
    setup: async (workspace, language) => {
      await init(workspace, language);
      const result = await captureCli(workspace, ["set", "warmth=5"]);
      assert.equal(result.status, 0, `setup set failed: ${result.stderr}`);
    },
  },
  show: initialized(() => ["show"]),
  save: initialized(() => ["save", "Example"]),
  list: initialized(() => ["list"]),
  edit: initialized(() => ["edit", "--dry-run"]),
  update: initialized(() => ["update", "--dry-run"]),
  use: initialized(() => ["use", "tough-love"]),
  compile: {
    ...initialized(() => ["compile", "--check"]),
  },
  export: initialized(() => ["export", "tough-love"]),
  import: {
    expected: 0,
    setup: async (workspace, language) => {
      await init(workspace, language);
      writeFileSync(join(workspace.root, "incoming.json"), JSON.stringify({
        schema: 1,
        slug: "example-import",
        displayName: "Example Import",
        values: { warmth: 5, care: 4 },
      }, null, 2) + "\n");
    },
    args: (workspace) => ["import", join(workspace.root, "incoming.json")],
  },
  wire: {
    expected: 0,
    setup: async (workspace, language) => init(workspace, language),
    args: () => ["wire", "codex", "--here", "--auto"],
  },
  unwire: {
    expected: 0,
    setup: async (workspace, language) => {
      await init(workspace, language);
      const result = await captureCli(workspace, ["wire", "codex", "--here", "--auto"]);
      assert.equal(result.status, 0, `setup wire failed: ${result.stderr}`);
    },
    args: () => ["unwire", "codex", "--here", "--auto"],
  },
  init: {
    expected: 0,
    args: (_, language) => ["init", "--here", "--tools", "none", "--lang", language, "--auto"],
  },
  doctor: initialized(() => ["doctor", "--here"]),
  eject: {
    expected: 0,
    setup: async (workspace, language) => init(workspace, language, "codex"),
    args: () => ["eject", "--here", "--auto"],
  },
};

test("command goldens enumerate the live command registry", () => {
  assert.deepEqual(Object.keys(scenarios).sort(), [...COMMAND_NAMES].sort(), "a command has no golden scenario or an obsolete one remains");
});

test("formatted captures preserve empty, newline, and missing-trailing-newline streams", () => {
  const empty = formatCapture({ status: 0, stdout: "", stderr: "" });
  const newline = formatCapture({ status: 0, stdout: "\n", stderr: "" });
  const text = formatCapture({ status: 0, stdout: "text", stderr: "" });
  const textWithNewline = formatCapture({ status: 0, stdout: "text\n", stderr: "" });
  assert.notEqual(empty, newline);
  assert.notEqual(text, textWithNewline);
  assert.match(empty, /--- stdout --- \[bytes=0; endsWithNewline=false\]/);
  assert.match(newline, /--- stdout --- \[bytes=1; endsWithNewline=true\]/);
  assert.match(text, /--- stdout --- \[bytes=4; endsWithNewline=false\]/);
  assert.match(textWithNewline, /--- stdout --- \[bytes=5; endsWithNewline=true\]/);
});

for (const language of selectedGoldenLanguages()) {
  test(`global help and version goldens · ${language}`, async () => {
    for (const [name, args] of [["global-help", ["--help"]], ["global-version", ["--version"]]] as const) {
      const workspace = createGoldenWorkspace(language);
      try {
        await init(workspace, language);
        const capture = await captureCli(workspace, [...args]);
        assert.equal(capture.status, 0, `${language} ${name}: unexpected exit status`);
        assert.ok(capture.stdout.length > 0 || capture.stderr.length > 0, `${language} ${name}: empty capture cannot be a golden`);
        if (name === "global-help") {
          assert.ok(capture.stdout.includes(catalogue(language).cli.help.tagline), `${language}: help ignored the configured locale`);
        }
        assertGolden(
          goldenPath(language, "commands", name),
          formatCapture(normalizeCapture(capture, workspace)),
        );
      } finally {
        workspace.dispose();
      }
    }
  });

  test(`command output goldens · ${language}`, async () => {
    for (const command of COMMAND_NAMES) {
      const workspace = createGoldenWorkspace(language);
      try {
        const scenario = scenarios[command]!;
        await scenario.setup?.(workspace, language);
        const capture = await captureCli(workspace, scenario.args(workspace, language));
        assert.equal(capture.status, scenario.expected, `${language} ${command}: unexpected exit status`);
        assert.ok(capture.stdout.length > 0 || capture.stderr.length > 0, `${language} ${command}: empty capture cannot be a golden`);
        assertGolden(
          goldenPath(language, "commands", command),
          formatCapture(normalizeCapture(capture, workspace)),
        );
      } finally {
        workspace.dispose();
      }
    }
  });
}

type ErrorScenario = {
  name: string;
  expected: number;
  setup?: (workspace: GoldenWorkspace, language: GoldenLanguage) => Promise<void>;
  args: (workspace: GoldenWorkspace, language: GoldenLanguage) => string[];
};

const errorScenarios: ErrorScenario[] = [
  {
    name: "unknown-command",
    expected: 2,
    setup: async (workspace, language) => init(workspace, language),
    args: () => ["not-a-command"],
  },
  {
    name: "invalid-set",
    expected: 1,
    setup: async (workspace, language) => init(workspace, language),
    args: () => ["set", "warmth=9"],
  },
  {
    name: "missing-import",
    expected: 1,
    setup: async (workspace, language) => init(workspace, language),
    args: (workspace) => ["import", join(workspace.root, "missing.json")],
  },
  {
    name: "rejected-context-flag",
    expected: 2,
    setup: async (workspace, language) => init(workspace, language),
    args: () => ["compile", "--project", "."],
  },
];

for (const language of selectedGoldenLanguages()) {
  test(`representative error and context goldens · ${language}`, async () => {
    for (const scenario of errorScenarios) {
      const workspace = createGoldenWorkspace(language);
      try {
        await scenario.setup?.(workspace, language);
        const capture = await captureCli(workspace, scenario.args(workspace, language));
        assert.equal(capture.status, scenario.expected, `${language} ${scenario.name}: unexpected exit status`);
        assert.ok(capture.stdout.length > 0 || capture.stderr.length > 0, `${language} ${scenario.name}: empty capture cannot be a golden`);
        if (scenario.name === "unknown-command") {
          const sentinel = catalogue(language).cli.errors.notACommand("not-a-command", ["__available__"], null)
            .split("__available__")[0]!;
          assert.ok(`${capture.stdout}${capture.stderr}`.includes(sentinel), `${language}: unknown-command ignored the configured locale`);
        }
        assertGolden(
          goldenPath(language, "errors", scenario.name),
          formatCapture(normalizeCapture(capture, workspace)),
        );
      } finally {
        workspace.dispose();
      }
    }
  });
}

test("golden policy rejects invalid locale, CI updates, and missing or changed baselines", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tonedial-golden-policy-"));
  const path = join(fixtureRoot, "baseline.txt");
  const artifacts = goldenArtifactDirectory(path);
  rmSync(artifacts, { recursive: true, force: true });
  try {
    assert.throws(() => assertGolden(path, "actual\n", {}), /missing golden/);
    assert.ok(existsSync(join(artifacts, "actual.txt")));
    assert.ok(existsSync(join(artifacts, "expected.txt")));
    assert.equal(readFileSync(join(artifacts, "actual.txt"), "utf8"), "actual\n");
    assert.equal(readFileSync(join(artifacts, "expected.txt"), "utf8"), "");

    writeFileSync(path, "expected\n");
    assert.throws(() => assertGolden(path, "changed\n", {}), /golden mismatch/);
    assert.equal(readFileSync(join(artifacts, "expected.txt"), "utf8"), "expected\n");
    assert.equal(readFileSync(join(artifacts, "actual.txt"), "utf8"), "changed\n");
    assert.throws(
      () => assertGolden(path, "changed\n", { TONEDIAL_GOLDEN_UPDATE: "1", CI: "true" }),
      /forbidden in CI/,
    );
    assert.throws(
      () => selectedGoldenLanguages({ TONEDIAL_TEST_LANG: "ja" }),
      /TONEDIAL_TEST_LANG must be one of/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});
