import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolvePaths } from "../src/core/paths.ts";

for (const replacement of ["file", "symlink", "fifo"] as const) {
  test(`planning rejects a ${replacement} replacement before reading its bytes`, {
    skip: replacement === "fifo" && process.platform === "win32",
  }, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tonedial-inspection-")));
    try {
      const target = join(root, "target.md");
      const other = join(root, "unrelated.md");
      writeFileSync(target, "original document\n");
      writeFileSync(other, "unrelated document\n");
      const script = `
        import fs from "node:fs";
        import { execFileSync } from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        import { planChange } from ${JSON.stringify(new URL("../src/wiring/apply.ts", import.meta.url).href)};
        import { catalogue } from ${JSON.stringify(new URL("../src/core/i18n.ts", import.meta.url).href)};
        const target = ${JSON.stringify(target)};
        const other = ${JSON.stringify(other)};
        const replacement = ${JSON.stringify(replacement)};
        const open = fs.openSync;
        const read = fs.readFileSync;
        let replaced = false;
        let payloadReads = 0;
        function replace(path) {
          if (path !== target || replaced) return;
          replaced = true;
          fs.renameSync(target, target + ".saved");
          if (replacement === "fifo") execFileSync("mkfifo", [target]);
          else if (replacement === "symlink") fs.symlinkSync(other, target);
          else fs.writeFileSync(target, "original document\\n");
        }
        fs.openSync = (path, ...args) => { replace(path); return open(path, ...args); };
        fs.readFileSync = (path, ...args) => {
          replace(path);
          if (path === target || typeof path === "number") payloadReads++;
          return read(path, ...args);
        };
        syncBuiltinESMExports();
        let refused = false;
        try { planChange(target, () => "changed\\n", catalogue("en").cli, undefined, ${JSON.stringify(root)}); }
        catch { refused = true; }
        process.stdout.write(JSON.stringify({ replaced, refused, payloadReads }));
      `;
      // A real FIFO bounds the blocking regression; the other cases prove no foreign bytes
      // enter the planned diff, even when replacement bytes happen to equal the original.
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: root, TMPDIR: root },
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { replaced: true, refused: true, payloadReads: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const replacement of ["file", "symlink", "fifo", "in-place edit"] as const) {
  test(`journal inspection rejects ${replacement} races without accepting changed records`, {
    skip: replacement === "fifo" && process.platform === "win32",
  }, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tonedial-journal-read-")));
    try {
      const script = `
        import fs from "node:fs";
        import { execFileSync } from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        import { acquireOperation, beginJournal, readJournal } from ${JSON.stringify(new URL("../src/core/operations.ts", import.meta.url).href)};
        const root = ${JSON.stringify(root)};
        const paths = { root, operations: root + "/operations", operationsLock: root + "/operations.lock" };
        const handle = acquireOperation(paths, "mutation");
        const journal = beginJournal(handle, []);
        const target = paths.operations + "/" + journal.operationId + ".json";
        const other = root + "/foreign.json";
        const bytes = fs.readFileSync(target);
        fs.writeFileSync(other, bytes);
        const replacement = ${JSON.stringify(replacement)};
        const open = fs.openSync;
        const read = fs.readFileSync;
        let replaced = false;
        let payloadReads = 0;
        function replace(path) {
          if (path !== target || replaced || replacement === "in-place edit") return;
          replaced = true;
          fs.renameSync(target, target + ".saved");
          if (replacement === "fifo") execFileSync("mkfifo", [target]);
          else if (replacement === "symlink") fs.symlinkSync(other, target);
          else fs.writeFileSync(target, bytes);
        }
        fs.openSync = (path, ...args) => { replace(path); return open(path, ...args); };
        fs.readFileSync = (path, ...args) => {
          replace(path);
          if (path === target || typeof path === "number") payloadReads++;
          const result = read(path, ...args);
          if (replacement === "in-place edit" && typeof path === "number" && !replaced) {
            replaced = true;
            fs.writeFileSync(target, "changed after the read\\n");
          }
          return result;
        };
        syncBuiltinESMExports();
        const invalid = readJournal(paths, journal.operationId) === null;
        process.stdout.write(JSON.stringify({ replaced, invalid, payloadReads }));
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: root, TMPDIR: root },
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        replaced: true,
        invalid: true,
        payloadReads: replacement === "in-place edit" ? 1 : 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

type DiagnosticCase = "host" | "rc" | "command" | "artifact" | "doctor-artifact";

function diagnosticFixture(kind: DiagnosticCase) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tonedial-diagnostic-")));
  const state = join(root, "state");
  const agent = join(root, "agent");
  const home = join(root, "home");
  mkdirSync(state, { recursive: true });
  mkdirSync(agent, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    TONEDIAL_HOME: state,
    TONEDIAL_AGENT_HOME: agent,
    HOME: home,
    PATH: "",
    TONEDIAL_INSTALL_SHAPE: kind === "host" || kind === "artifact" || kind === "doctor-artifact" ? "npm" : "curl",
    ...(kind === "rc" || kind === "command" ? { SHELL: "/bin/bash" } : {}),
  };
  const paths = resolvePaths(env);
  let target: string;
  let args: string[];
  if (kind === "host") {
    mkdirSync(join(agent, ".claude"), { recursive: true });
    target = join(agent, ".claude", "CLAUDE.md");
    args = ["doctor", "--here", "--json"];
  } else if (kind === "rc") {
    target = join(home, ".bash_profile");
    args = ["doctor", "--here", "--json"];
  } else if (kind === "command") {
    mkdirSync(join(state, "bin"), { recursive: true });
    target = paths.command;
    args = ["doctor", "--here", "--json"];
  } else if (kind === "artifact") {
    target = paths.tone;
    args = ["wire", "--here", "codex", "--auto", "--json"];
  } else {
    target = paths.tone;
    args = ["doctor", "--here", "--json"];
  }
  return { root, env, args, target, kind };
}

function runDiagnostic(fixture: ReturnType<typeof diagnosticFixture>) {
  const script = `
    import { execFileSync } from "node:child_process";
    import { rmSync } from "node:fs";
    import { resolveAgentPaths, resolvePaths } from ${JSON.stringify(new URL("../src/core/paths.ts", import.meta.url).href)};
    import { messages } from ${JSON.stringify(new URL("../src/core/i18n.ts", import.meta.url).href)};
    import { palette } from ${JSON.stringify(new URL("../src/ui/style.ts", import.meta.url).href)};
    import { run } from ${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)};
    const output = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
    let code;
    try {
      // Establish a real state-only install before replacing the named destination. This keeps
      // context-layout classification out of the owner-specific read-boundary assertion.
      await run(["init", "--here", "--lang", "en", "--tools", "none", "--auto"], ${JSON.stringify(fixture.env)}, ${JSON.stringify(fixture.root)}, false, false);
      output.length = 0;
      if (${JSON.stringify(fixture.kind)} === "artifact" || ${JSON.stringify(fixture.kind)} === "doctor-artifact") rmSync(${JSON.stringify(fixture.target)});
      execFileSync("mkfifo", [${JSON.stringify(fixture.target)}]);
      if (${JSON.stringify(fixture.kind)} === "artifact") {
        const paths = resolvePaths(${JSON.stringify(fixture.env)});
        const agent = resolveAgentPaths({ global: false, project: null }, ${JSON.stringify(fixture.env)}, ${JSON.stringify(fixture.root)});
        const flags = { verbose: false, project: null, here: true, check: false, explain: false, global: false, auto: true, dryRun: false, fix: false, rollback: null, lang: null, commands: false, tools: null };
        const { runWire } = await import(${JSON.stringify(new URL("../src/commands/wire.ts", import.meta.url).href)});
        try {
          await runWire({ paths, cwd: ${JSON.stringify(fixture.root)}, flags, ui: palette("never", ${JSON.stringify(fixture.env)}, false), agent, env: ${JSON.stringify(fixture.env)}, t: messages(paths.config, ${JSON.stringify(fixture.env)}), asJson: false, canPrompt: false }, ["codex"]);
          code = 0;
        } catch (cause) {
          code = 1;
          output.push(JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }));
        }
      } else {
        code = await run(${JSON.stringify(fixture.args)}, ${JSON.stringify(fixture.env)}, ${JSON.stringify(fixture.root)}, false, false);
      }
    } finally {
      process.stdout.write = original;
    }
    original(JSON.stringify({ code, output: output.join("") }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 2000,
    env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: fixture.root, TMPDIR: fixture.root },
  });
}

for (const kind of ["host", "rc", "command", "artifact", "doctor-artifact"] as const) {
  test(`command-level ${kind} FIFO read is bounded and structured`, {
    skip: process.platform === "win32",
  }, () => {
    const fixture = diagnosticFixture(kind);
    try {
      const result = runDiagnostic(fixture);
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.equal(lstatSync(fixture.target).isFIFO(), true);
      const envelope = JSON.parse(result.stdout) as { code: number; output: string };
      if (kind === "artifact") {
        assert.equal(envelope.code, 1);
        const payload = JSON.parse(envelope.output) as { ok: boolean; error: string };
        assert.equal(payload.ok, false);
        assert.match(payload.error, /not a regular file|unreadable|cannot read/i);
      } else {
        assert.equal(envelope.code, 0);
        const payload = JSON.parse(envelope.output) as {
          ok: boolean;
          healthy: boolean;
          checks: { name: string; state: string; repair: string | null; detail: string }[];
          context: { kind: string; inspectionFailure: { path: string; reason: string } | null };
          contextPayload: { guideFormat: string; guideChars: number | null; artifactChars: number | null; totalChars: number | null };
          reader: { state: string; reason: string | null };
        };
        assert.equal(payload.ok, true);
        assert.equal(payload.healthy, false);
        const names = { host: "Claude Code", rc: "PATH line", command: "tonedial", "doctor-artifact": "TONE.md" } as const;
        const check = payload.checks.find(({ name }) => name === names[kind]);
        assert.ok(check);
        assert.equal(check.state, "problem");
        assert.equal(check.repair, null);
        if (kind === "host") {
          assert.equal(payload.context.kind, "current", "an external FIFO does not change application integrity");
          assert.equal(payload.context.inspectionFailure, null);
          assert.match(check.detail, /not a regular file|unreadable|cannot read/i);
          assert.equal(payload.contextPayload.guideFormat, "supported");
          assert.equal(typeof payload.contextPayload.artifactChars, "number");
          assert.equal(payload.reader.state, "not-required");
          assert.equal(payload.reader.reason, null);
          assert.equal(lstatSync(fixture.target).isFIFO(), true, "diagnosis did not replace the blocking entry");
        } else assert.match(check.detail, /not a regular file|unreadable|cannot read/i);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("init and unwire use the bounded config snapshot instead of reopening its path", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tonedial-config-boundary-")));
  try {
    const state = join(root, "state");
    const home = join(root, "home");
    const project = join(root, "project");
    const env = {
      HOME: home,
      TONEDIAL_HOME: state,
      LANG: "en_US.UTF-8",
      PATH: "",
    };
    const script = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { resolvePaths } from ${JSON.stringify(new URL("../src/core/paths.ts", import.meta.url).href)};
      import { run } from ${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)};
      const env = ${JSON.stringify(env)};
      const cwd = ${JSON.stringify(project)};
      const output = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
      const invoke = async (args) => {
        output.length = 0;
        try {
          const code = await run([...args, "--json"], env, cwd, false, false);
          return { code, output: output.join("") };
        } catch (cause) {
          return { code: null, output: output.join(""), thrown: cause instanceof Error ? cause.message : String(cause) };
        }
      };
      try {
        const setupCode = await run(["init", "--here", "--lang", "en", "--tools", "none", "--auto"], env, cwd, false, false);
        if (setupCode !== 0) throw new Error("state-only fixture initialization failed");
        const configPath = resolvePaths(env).config;
        const originalRead = fs.readFileSync;
        let configPathReads = 0;
        fs.readFileSync = (path, ...args) => {
          if (typeof path === "string" && path === configPath) {
            configPathReads += 1;
            throw new Error("config path reopened");
          }
          return originalRead(path, ...args);
        };
        syncBuiltinESMExports();
        const init = await invoke(["init", "--here", "--lang", "en", "--tools", "none", "--auto"]);
        const unwire = await invoke(["unwire", "--here", "--auto"]);
        originalWrite(JSON.stringify({ init, unwire, configPathReads }));
      } finally {
        process.stdout.write = originalWrite;
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: root, TMPDIR: root },
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    const envelope = JSON.parse(result.stdout) as {
      init: { code: number | null; output: string; thrown?: string };
      unwire: { code: number | null; output: string; thrown?: string };
      configPathReads: number;
    };
    assert.deepEqual(
      { initCode: envelope.init.code, unwireCode: envelope.unwire.code, configPathReads: envelope.configPathReads },
      { initCode: 0, unwireCode: 0, configPathReads: 0 },
    );
    assert.equal(JSON.parse(envelope.init.output).ok, true);
    assert.equal(JSON.parse(envelope.unwire.output).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
