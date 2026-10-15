import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(sourceRoot, "scripts", "check-release.mjs");
const repository = "https://github.com/awesometic/tonedial";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function command(root: string, program: string, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "", HOME: root, XDG_CONFIG_HOME: join(root, "xdg"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      ...extraEnv,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(root: string, ...args: string[]) {
  const result = command(root, "git", args);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

function commit(root: string, message: string) {
  git(root, "add", "-A");
  git(root, "-c", "user.name=ToneDial Test", "-c", "user.email=test@example.invalid", "commit", "-qm", message);
}

function fixture(publicIdentity = true) {
  const root = mkdtempSync(join(tmpdir(), "tonedial-release-check-"));
  roots.push(root);
  git(root, "init", "-q", "--initial-branch=main");
  mkdirSync(join(root, "scripts"));
  copyFileSync(script, join(root, "scripts", "check-release.mjs"));
  mkdirSync(join(root, "test"));
  copyFileSync(fileURLToPath(import.meta.url), join(root, "test", "release-check.test.ts"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "tonedial",
    version: "1.0.0",
    files: ["dist", "THIRD_PARTY_NOTICES.md"],
    repository: { type: "git", url: `git+${repository}.git` },
    scripts: { prepack: "npm run build" },
  }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    name: "tonedial",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "tonedial", version: "1.0.0" } },
  }));
  copyFileSync(join(sourceRoot, "LICENSE"), join(root, "LICENSE"));
  copyFileSync(join(sourceRoot, "THIRD_PARTY_NOTICES.md"), join(root, "THIRD_PARTY_NOTICES.md"));
  writeFileSync(join(root, "install.sh"), `# curl -fsSL https://raw.githubusercontent.com/awesometic/tonedial/main/install.sh | sh\n`);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "src", "bin.ts"), 'console.log("tonedial");\n');
  writeFileSync(join(root, "src", "cli.ts"), 'export const VERSION = "1.0.0";\n');
  writeFileSync(join(root, "dist", "bin.js"), 'console.log("tonedial");\n');
  writeFileSync(join(root, "dist", "cli.js"), 'export const VERSION = "1.0.0";\n');
  writeFileSync(join(root, ".gitignore"), 'dist/\n');
  if (publicIdentity) {
    writeFileSync(join(root, ".public-release.json"), JSON.stringify({ repository }));
    git(root, "remote", "add", "public", `${repository}.git`);
  }
  return root;
}

function check(root: string, ...args: string[]) {
  return command(root, process.execPath, [join(root, "scripts", "check-release.mjs"), ...args]);
}

function checkWithEnv(root: string, extraEnv: Record<string, string>, ...args: string[]) {
  return command(root, process.execPath, [join(root, "scripts", "check-release.mjs"), ...args], extraEnv);
}

test("an unmarked candidate can inspect its tree and history but cannot pass the publish gate", () => {
  const sourceManifest = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  assert.doesNotMatch(sourceManifest.scripts.prepack, /check-release/, "npm pack must remain available for candidate trials");
  const root = fixture(false);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "tonedial", version: "0.0.0", repository: { url: `git+${repository}.git` },
    scripts: { prepack: "npm run build" },
  }));
  commit(root, "unmarked candidate");
  assert.equal(check(root, "--tree").code, 0);
  assert.equal(check(root, "--history").code, 0);
  const release = check(root);
  assert.notEqual(release.code, 0);
  assert.match(release.stderr, /missing or invalid \.public-release\.json/);
});

test("a clean public checkout with localized READMEs and matching identity passes", () => {
  const root = fixture();
  writeFileSync(join(root, "README.md"), "# ToneDial\n");
  for (const language of ["ko", "ja", "zh", "es"]) writeFileSync(join(root, `README.${language}.md`), "# ToneDial\n");
  commit(root, "public candidate");
  const result = check(root);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Release check passed/);
});

test("ignored build output cannot introduce an extra npm package file", () => {
  const root = fixture();
  commit(root, "public candidate");
  writeFileSync(join(root, "dist", "private-note.js"), "export const privateNote = true;\n");
  assert.equal(check(root, "--tree").code, 0);
  const result = check(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unapproved packed file.*private-note/);
});

test("the release package must contain the third-party notices", () => {
  const root = fixture();
  commit(root, "public candidate");
  unlinkSync(join(root, "THIRD_PARTY_NOTICES.md"));
  commit(root, "remove third-party notices");
  const result = check(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /missing required package file: THIRD_PARTY_NOTICES\.md/);
});

test("the release package must contain its license", () => {
  const root = fixture();
  commit(root, "public candidate");
  unlinkSync(join(root, "LICENSE"));
  commit(root, "remove license");
  const result = check(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /missing required package file: LICENSE/);
});

test("the release package rejects an altered Unicode license notice", () => {
  const root = fixture();
  commit(root, "public candidate");
  const notices = join(root, "THIRD_PARTY_NOTICES.md");
  writeFileSync(notices, readFileSync(notices, "utf8").replace("Copyright © 1991-2026 Unicode, Inc.", "Copyright © 1991-2026 Unicode, Inc. altered"));
  commit(root, "alter third-party notice");
  const result = check(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /does not contain the current Unicode License v3 notice/);
});

test("the release package rejects missing or truncated Unicode license text", () => {
  const cases = [
    {
      name: "missing permission text",
      mutate: (notices: string) => notices.replace(/Permission is hereby granted[\s\S]*?associated Documentation\.\n/, ""),
    },
    {
      name: "truncated final paragraph",
      mutate: (notices: string) => notices.replace(/\nExcept as contained in this notice[\s\S]*?authorization of the copyright holder\.\n```/, "\n```"),
    },
  ];
  for (const scenario of cases) {
    const root = fixture();
    commit(root, "public candidate");
    const notices = join(root, "THIRD_PARTY_NOTICES.md");
    writeFileSync(notices, scenario.mutate(readFileSync(notices, "utf8")));
    commit(root, scenario.name);
    const result = check(root);
    assert.notEqual(result.code, 0, scenario.name);
    assert.match(result.stderr, /does not contain the current Unicode License v3 notice/, scenario.name);
  }
});

test("changing every identity field together still cannot redirect publication", () => {
  const root = fixture();
  const other = "https://github.com/elsewhere/tonedial";
  writeFileSync(join(root, ".public-release.json"), JSON.stringify({ repository: other }));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  pkg.repository.url = `git+${other}.git`;
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(root, "install.sh"), "# https://raw.githubusercontent.com/elsewhere/tonedial/main/install.sh\n");
  git(root, "remote", "set-url", "public", `${other}.git`);
  commit(root, "redirect identity");
  const result = check(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /public release identity must be/);
});

test("Git environment overrides cannot redirect inspection away from the selected checkout", () => {
  const root = fixture();
  commit(root, "public candidate");
  const result = checkWithEnv(root, {
    GIT_DIR: join(root, "wrong-git-dir"),
    GIT_WORK_TREE: join(root, "wrong-worktree"),
    GIT_INDEX_FILE: join(root, "wrong-index"),
    GIT_CONFIG_GLOBAL: join(root, "wrong-global-config"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
  }, "--tree");
  assert.equal(result.code, 0, result.stderr);
});

test("tree inspection rejects nonignored private entries and symlinks without opening their targets", () => {
  const root = fixture();
  commit(root, "public candidate");
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "private.md"), "private\n");
  assert.match(check(root, "--tree").stderr, /private path \.codex\/private\.md/);
  rmSync(join(root, ".codex"), { recursive: true });

  symlinkSync(join(root, "missing-outside-target"), join(root, "docs-link"));
  const result = check(root, "--tree");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /symlink docs-link/);
});

test("local release instructions stay ignored and cannot enter the public tree or history", () => {
  const root = fixture();
  const path = "docs/RELEASING.local.md";
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, path), "Local operator instructions\n");
  writeFileSync(join(root, ".gitignore"), `dist/\n/${path}\n`);
  commit(root, "public candidate");
  assert.equal(check(root, "--tree").code, 0);

  git(root, "add", "--force", "--", path);
  const tree = check(root, "--tree");
  assert.notEqual(tree.code, 0);
  assert.match(tree.stderr, /private path docs\/RELEASING\.local\.md/);
  commit(root, "accidentally track local instructions");
  unlinkSync(join(root, path));
  commit(root, "remove local instructions");

  assert.equal(check(root, "--tree").code, 0);
  const history = check(root, "--history");
  assert.notEqual(history.code, 0);
  assert.match(history.stderr, /history [0-9a-f]+: private path docs\/RELEASING\.local\.md/);
});

test("deleted Antigravity wiring in the initial commit still blocks release", () => {
  const root = fixture();
  mkdirSync(join(root, ".gemini", "config"), { recursive: true });
  writeFileSync(join(root, ".gemini", "config", "hooks.json"), "{}\n");
  commit(root, "initial public draft with local wiring");
  rmSync(join(root, ".gemini"), { recursive: true });
  commit(root, "remove local wiring");

  assert.equal(check(root, "--tree").code, 0);
  const result = check(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /history [0-9a-f]+: private path \.gemini\/config\/hooks\.json/);
});

test("a deleted symlink remains a release blocker", () => {
  const root = fixture();
  symlinkSync(join(root, "missing-outside-target"), join(root, "old-link"));
  commit(root, "draft with machine link");
  unlinkSync(join(root, "old-link"));
  commit(root, "remove machine link");
  assert.equal(check(root, "--tree").code, 0);
  const result = check(root, "--history");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /history [0-9a-f]+: symlink or non-file old-link/);
});

test("a personal home path is checked even after its file is removed", () => {
  const root = fixture();
  const personalPath = ["", "Users", "fictional-maintainer", "Developer", "tonedial"].join("/");
  writeFileSync(join(root, "draft.md"), `Local path: ${personalPath}\n`);
  commit(root, "draft");
  unlinkSync(join(root, "draft.md"));
  commit(root, "remove draft");
  const result = check(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /history [0-9a-f]+: personal home path in draft\.md/);
});

test("a personal home path is refused while documented placeholder paths remain usable", () => {
  const root = fixture();
  writeFileSync(join(root, "notes.md"), "Example: /Users/you/.tonedial/bin\n");
  assert.equal(check(root, "--tree").code, 0);
  const personalPath = ["", "Users", "fictional-maintainer", "Developer", "tonedial"].join("/");
  writeFileSync(join(root, "notes.md"), `Local path: ${personalPath}\n`);
  const result = check(root, "--tree");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /personal home path in notes\.md/);
});

test("credential-like paths are refused before their contents are inspected", () => {
  const root = fixture();
  writeFileSync(join(root, ".env"), "dummy=not-a-credential\n");
  const result = check(root, "--tree");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /credential-like path \.env/);
});

test("release identity refuses an unreleased version, mismatched URLs, or no GitHub remote", () => {
  const cases: Array<{ name: string; change: (root: string) => void; error: RegExp }> = [
    {
      name: "unreleased version",
      change: (root) => writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "tonedial", version: "0.0.0", repository: { url: `git+${repository}.git` },
      })),
      error: /release version other than 0\.0\.0/,
    },
    {
      name: "wrong package repository",
      change: (root) => writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "tonedial", version: "1.0.0", repository: { url: "git+https://github.com/elsewhere/tonedial.git" },
      })),
      error: /package\.json repository does not match/,
    },
    {
      name: "wrong installer URL",
      change: (root) => writeFileSync(join(root, "install.sh"),
        "# curl -fsSL https://raw.githubusercontent.com/elsewhere/tonedial/main/install.sh | sh\n"),
      error: /install\.sh self-install URL does not match/,
    },
    {
      name: "missing GitHub remote",
      change: (root) => git(root, "remote", "remove", "public"),
      error: /no configured GitHub remote matches/,
    },
  ];
  for (const scenario of cases) {
    const root = fixture();
    scenario.change(root);
    commit(root, scenario.name);
    const result = check(root);
    assert.notEqual(result.code, 0, scenario.name);
    assert.match(result.stderr, scenario.error, scenario.name);
  }
});

test("release identity requires manifest, lockfile, and CLI versions to match", () => {
  const cases: Array<{ name: string; change: (root: string) => void; error: RegExp }> = [
    {
      name: "lockfile root version mismatch",
      change: (root) => {
        const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
        lock.version = "1.0.1";
        writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
      },
      error: /package-lock\.json version does not match package\.json/,
    },
    {
      name: "lockfile package version mismatch",
      change: (root) => {
        const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
        lock.packages[""].version = "1.0.1";
        writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
      },
      error: /package-lock\.json packages\[""\] version does not match package\.json/,
    },
    {
      name: "CLI version mismatch",
      change: (root) => writeFileSync(join(root, "src", "cli.ts"), 'export const VERSION = "1.0.1";\n'),
      error: /src\/cli\.ts VERSION does not match package\.json/,
    },
  ];
  for (const scenario of cases) {
    const root = fixture();
    scenario.change(root);
    commit(root, scenario.name);
    const result = check(root);
    assert.notEqual(result.code, 0, scenario.name);
    assert.match(result.stderr, scenario.error, scenario.name);
  }
});
