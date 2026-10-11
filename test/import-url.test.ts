// `import` over https, driven against a stub server.
//
// Preset import reaches the network because a user typed a URL, and it is bounded three
// ways — protocol, protocol again after redirects, and size — because what arrives becomes a
// file they keep. Everything after the read is the path a file import already took, so the
// strongest assertion here is that both routes produce identical bytes.
//
// The three bounds are driven against a stubbed `fetch` rather than a real server. Testing them
// over real https needs a self-signed certificate and a process-wide switch turning off the
// certificate verification this feature is partly about — so the stub states each answer
// exactly, and the shared path after the read is asserted by comparing against a file import.
// Nothing touches the real home.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.ts";
import { UNKNOWN_WIDTH, cells } from "../src/ui/width.ts";
import { resolvePaths } from "../src/core/paths.ts";
import { IMPORT_MAX_BYTES, asUrl, fetchPreset } from "../src/commands/transfer.ts";
import { catalogue } from "../src/core/i18n.ts";
import { latestRelease } from "../src/core/selfupdate.ts";

const EN = catalogue("en").cli;

/**
 * A stand-in for `fetch`, so the guards can be driven over https without a certificate.
 *
 * The three bounds read the protocol of the URL, the protocol of `response.url` after
 * redirects, and the length of the body — all of which a stub can state exactly. Driving them
 * through a real server would need a self-signed certificate and a process-wide switch turning
 * off the verification this feature is about.
 */
async function withFetch<T>(reply: { url?: string; status?: number; body?: string; error?: Error; asked?: string[] }, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const asked = input instanceof URL ? input.href : String(input);
    reply.asked?.push(asked);
    if (reply.error) throw reply.error;
    const bytes = new TextEncoder().encode(reply.body ?? "");
    return {
      url: reply.url ?? asked,
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      // A stream, because the code reads one — the cap has to refuse a body *while* it arrives,
      // and a stub offering only `arrayBuffer` would let a version that buffers everything pass.
      // Chunked, so a cap that only looked at the last chunk would not survive either.
      body: (async function* () {
        for (let at = 0; at < bytes.byteLength; at += 4096) yield bytes.subarray(at, at + 4096);
      })(),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}


let home = "";
let out: string[] = [];
let err: string[] = [];
let restore: (() => void)[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tonedial-url-"));
  out = [];
  err = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => (out.push(s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => (err.push(s), true)) as typeof process.stderr.write;
  restore = [() => { process.stdout.write = o; }, () => { process.stderr.write = e; }];
});

afterEach(() => {
  for (const r of restore) r();
  rmSync(home, { recursive: true, force: true });
});

const cli = (...args: string[]) => run(args, {
  HOME: home, TONEDIAL_HOME: join(home, "state"), TONEDIAL_AGENT_HOME: join(home, "agents"),
}, join(home, "project"), false, false);
const paths = () => resolvePaths({ TONEDIAL_HOME: join(home, "state") });
const PRESET = JSON.stringify({ schema: 1, slug: "from-web", displayName: "From Web", values: { warmth: 5 } });

test("a preset fetched over https lands byte-identical to one imported from disk", async () => {
  // The claim of the feature: the source changes and nothing else does.
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  const file = join(home, "p.json");
  writeFileSync(file, PRESET);
  assert.equal(await cli("import", file), 0);
  const fromDisk = readFileSync(join(paths().presets, "custom", "from-web.json"), "utf8");
  rmSync(join(paths().presets, "custom", "from-web.json"));

  await withFetch({ body: PRESET }, async () => {
    assert.equal(await cli("import", "https://example.invalid/p.json"), 0, err.join(""));
  });
  assert.equal(readFileSync(join(paths().presets, "custom", "from-web.json"), "utf8"), fromDisk);
});

test("http is refused before anything is fetched", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { called = true; throw new Error("should not run"); }) as typeof fetch;
  try {
    await assert.rejects(() => fetchPreset(new URL("http://example.invalid/p.json"), EN), /not https/);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(called, false, "the request went out before the protocol was checked");
});

test("an https URL that redirects to http is refused", async () => {
  // `fetch` follows redirects, so the protocol of what was asked for says nothing about the
  // protocol of what answered. This is the check the first one cannot make.
  await withFetch({ url: "http://elsewhere.invalid/p.json", body: PRESET }, () =>
    assert.rejects(() => fetchPreset(new URL("https://example.invalid/p.json"), EN), /not https/));
});

test("a body past the cap is refused, and it is the size that refuses it", async () => {
  // Valid JSON and a valid preset, so nothing downstream can be what rejects it.
  const big = JSON.stringify({ schema: 1, slug: "big", displayName: "B", values: {}, pad: "x".repeat(IMPORT_MAX_BYTES) });
  assert.ok(Buffer.byteLength(big) > IMPORT_MAX_BYTES);
  await withFetch({ body: big }, () =>
    assert.rejects(() => fetchPreset(new URL("https://example.invalid/p.json"), EN), /preset exceeds 65536 bytes/));
  // And one just under it is not refused, so the cap is a boundary rather than a wall.
  await withFetch({ body: PRESET }, async () =>
    assert.equal(await fetchPreset(new URL("https://example.invalid/p.json"), EN), PRESET));
});

test("a non-2xx answer is refused rather than parsed", async () => {
  await withFetch({ status: 404, body: "<html>not found</html>" }, () =>
    assert.rejects(() => fetchPreset(new URL("https://example.invalid/p.json"), EN), /404/));
});

test("a bare path is still a path, not a URL", async () => {
  // `./p.json` and `p.json` have to keep working, and a Windows drive letter is one character
  // so the scheme pattern cannot match it.
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  const file = join(home, "p.json");
  writeFileSync(file, PRESET);
  assert.equal(await cli("import", file), 0);
  assert.ok(existsSync(join(paths().presets, "custom", "from-web.json")));
});

test("a preset already on disk with a long name stays usable", async () => {
  // The cap is input validation. Putting it on the read path made `parsePreset` refuse a file it
  // had itself written before the cap existed — `listPresets` catches that into `skipped`, so
  // the preset vanished from `list`, `use`, `show`, and `export` while `doctor` said healthy.
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  writeFileSync(
    join(paths().presets, "legacy.json"),
    JSON.stringify({ schema: 1, slug: "legacy", displayName: "x".repeat(200), values: { warmth: 5 } }),
  );
  out = [];
  assert.equal(await cli("list"), 0);
  assert.match(out.join(""), /legacy/, "a preset the tool wrote is no longer listed");
  out = [];
  assert.equal(await cli("use", "legacy"), 0, err.join(""));
  // And the line it prints stays inside the budget, which is what `use` was missing while
  // `list` and `show` already truncated.
  for (const line of out.join("").split("\n")) assert.ok(cells(line) <= UNKNOWN_WIDTH, line.slice(0, 60));
});

test("a display name past the cap is refused however it arrives", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  const file = join(home, "p.json");
  writeFileSync(file, JSON.stringify({ schema: 1, slug: "long", displayName: "x".repeat(121), values: {} }));
  err = [];
  assert.equal(await cli("import", file), 1);
  assert.match(err.join(""), /121 characters/);
  // `save` was refused past this cap and `import` was not, so a file could carry a name no
  // command would accept — and `import` is the route remote text takes.
  assert.ok(!existsSync(join(paths().presets, "custom", "long.json")));
});

const ESC = String.fromCharCode(27);

test("a display name cannot carry control characters into the terminal", async () => {
  // `use` prints this name unwrapped, on the same screen as the safeword announcement and
  // the risk notice. A conceal sequence hides every line after it and a
  // newline forges one in the tool's own voice — and `import` now carries this from the network.
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  const hostile = `Nice${ESC}[8m${String.fromCharCode(10)}  guards are on`;
  await withFetch({ body: JSON.stringify({ schema: 1, slug: "sneaky", displayName: hostile, values: {} }) }, async () => {
    assert.equal(await cli("import", "https://example.invalid/p.json"), 0, err.join(""));
  });
  const saved = JSON.parse(readFileSync(join(paths().presets, "custom", "sneaky.json"), "utf8")) as { displayName: string };
  assert.doesNotMatch(saved.displayName, /[\p{Cc}\p{Cf}]/u, `control characters survived: ${JSON.stringify(saved.displayName)}`);

  out = [];
  assert.equal(await cli("use", "sneaky"), 0);
  assert.doesNotMatch(out.join(""), new RegExp(ESC + "\\["), "use emitted an escape sequence from a preset name");
});

test("a slug too long to be a filename is refused inside the json envelope", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  // Matches SLUG_PATTERN, so nothing before the filesystem refuses it. It used to reach
  // `writeFileSync` as an ENAMETOOLONG, which is not a ConfigError and escapes `--json`.
  const long = "a".repeat(300);
  out = [];
  await withFetch({ body: JSON.stringify({ schema: 1, slug: long, displayName: "X", values: {} }) }, async () => {
    assert.equal(await cli("import", "https://example.invalid/p.json", "--json"), 1);
  });
  const payload = JSON.parse(out.join("")) as { ok: boolean; error: string };
  assert.equal(payload.ok, false);
  assert.match(payload.error, /300 characters/);
});

test("a body that is not UTF-8 is refused inside the json envelope", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  out = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    url: "https://example.invalid/p.json",
    ok: true,
    status: 200,
    body: (async function* () { yield new Uint8Array([0xff, 0xfe, 0x00]); })(),
  }) as unknown as Response) as typeof fetch;
  try {
    assert.equal(await cli("import", "https://example.invalid/p.json", "--json"), 1);
  } finally {
    globalThis.fetch = original;
  }
  const payload = JSON.parse(out.join("")) as { ok: boolean; error: string };
  assert.equal(payload.ok, false, "a TypeError escaped the envelope");
  assert.match(payload.error, /not UTF-8/);
});

test("what a URL returned is not quoted back when it fails to parse", async () => {
  // The parser's message embeds a prefix of its input, which for a URL is a readback of whatever
  // that host served — an oracle for anyone who gets this command pointed at an internal one.
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  err = [];
  // V8 quotes about the first ten characters of what it failed to parse, so the marker has to
  // sit inside that window — a longer one passes on a version that echoes everything.
  await withFetch({ body: "SECRETVAL internal-token-9f2a" }, async () => {
    assert.equal(await cli("import", "https://example.invalid/p.json"), 1);
  });
  assert.doesNotMatch(err.join(""), /SECRETVAL/, "the body was echoed back");
  assert.match(err.join(""), /not valid JSON/);
});

test("remote success receipts identify only the origin while requesting the complete URL", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  const source = "https://PRIVATE_URL:PRIVATE_URL@example.invalid:8443/PRIVATE_URL?token=PRIVATE_URL#PRIVATE_URL";
  for (const json of [false, true]) {
    out = [];
    err = [];
    const asked: string[] = [];
    await withFetch({ body: PRESET, asked }, async () => {
      assert.equal(await cli("import", source, ...(json ? ["--json"] : [])), 0, err.join(""));
    });
    assert.deepEqual(asked, [source], "privacy changed the request rather than its display");
    assert.doesNotMatch(out.join("") + err.join(""), /PRIVATE_URL/);
    if (json) assert.equal(JSON.parse(out.join("")).source, "https://example.invalid:8443");
    else assert.match(out.join(""), /https:\/\/example\.invalid:8443/);
  }
});

test("remote failures omit URL private components and reflected remote data in both output modes", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  const source = "https://PRIVATE_URL:PRIVATE_URL@example.invalid/PRIVATE_URL?token=PRIVATE_URL#PRIVATE_URL";
  const cases = [
    { label: "protocol", source: source.replace("https:", "http:"), reply: { body: PRESET } },
    { label: "malformed URL", source: "https://[PRIVATE_URL/?token=PRIVATE_URL", reply: { body: PRESET } },
    { label: "redirect", source, reply: { url: "http://elsewhere.invalid/PRIVATE_URL?token=PRIVATE_URL", body: PRESET } },
    { label: "HTTP", source, reply: { status: 403, body: "PRIVATE_BODY" } },
    { label: "transport", source, reply: { error: Object.assign(new Error("PRIVATE_BODY CERT_HAS_EXPIRED request " + source), { code: "UNKNOWN_CERTIFICATE_ERROR" }) } },
    { label: "TLS certificate", source, reply: { error: Object.assign(new Error("PRIVATE_BODY certificate details " + source), { code: "CERT_HAS_EXPIRED" }) } },
    { label: "TLS cause", source, reply: { error: new TypeError("PRIVATE_BODY fetch failure", { cause: Object.assign(new Error("PRIVATE_BODY certificate names " + source), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }) }) } },
    { label: "JSON", source, reply: { body: "PRIVATE_BODY invalid JSON" } },
    { label: "object", source, reply: { body: "null" } },
    { label: "slug", source, reply: { body: JSON.stringify({ slug: "PRIVATE_BODY", values: {} }) } },
    { label: "schema", source, reply: { body: JSON.stringify({ schema: "PRIVATE_BODY", slug: "remote", values: {} }) } },
    { label: "schema coercion", source, reply: { body: JSON.stringify({ schema: { toString: null }, slug: "remote", values: {} }) } },
    { label: "axis", source, reply: { body: JSON.stringify({ schema: 1, slug: "remote", values: { PRIVATE_BODY: 3 } }) } },
    { label: "level", source, reply: { body: JSON.stringify({ schema: 1, slug: "remote", values: { warmth: "PRIVATE_BODY" } }) } },
    { label: "level coercion", source, reply: { body: JSON.stringify({ schema: 1, slug: "remote", values: { warmth: { toString: null } } }) } },
  ];
  for (const item of cases) {
    for (const json of [false, true]) {
      out = [];
      err = [];
      const asked: string[] = [];
      await withFetch({ ...item.reply, asked }, async () => {
        assert.equal(await cli("import", item.source, ...(json ? ["--json"] : [])), 1, item.label);
      });
      assert.doesNotMatch(out.join("") + err.join(""), /PRIVATE_URL|PRIVATE_BODY/, item.label);
      if (item.label.startsWith("TLS")) assert.match(out.join("") + err.join(""), /secure connection could not be verified/i, item.label);
      if (item.label === "transport") assert.match(out.join("") + err.join(""), /network or timeout failure/i, "unknown codes and reflected TLS words stay generic");
      if (json) {
        const payload = JSON.parse(out.join(""));
        assert.equal(payload.schema, 3, item.label);
        assert.equal(payload.ok, false, item.label);
      }
      if (item.label === "protocol" || item.label === "malformed URL") assert.deepEqual(asked, [], item.label);
      else assert.deepEqual(asked, [source], item.label);
    }
  }
  assert.equal(existsSync(join(paths().presets, "custom", "remote.json")), false);
});

test("registry diagnostics use the origin without reflecting metadata or transport errors", async () => {
  const registry = "https://PRIVATE_URL:PRIVATE_URL@registry.invalid/PRIVATE_URL?token=PRIVATE_URL#PRIVATE_URL";
  for (const reply of [{ body: "PRIVATE_BODY invalid JSON" }, { body: "null" }, { body: JSON.stringify({ dist: "PRIVATE_BODY" }) }, { error: new Error("PRIVATE_BODY " + registry) }]) {
    const asked: string[] = [];
    await withFetch({ ...reply, asked }, () => assert.rejects(() => latestRelease(registry, EN), (cause: unknown) => {
      assert.ok(cause instanceof Error);
      assert.match(cause.message, /https:\/\/registry\.invalid/);
      assert.doesNotMatch(cause.message, /PRIVATE_URL|PRIVATE_BODY/);
      if ("error" in reply) assert.equal(cause.cause, reply.error, "retain the original failure internally");
      return true;
    }));
    assert.deepEqual(asked, [registry + "/tonedial/latest"]);
  }
  out = [];
  err = [];
  await withFetch({ body: JSON.stringify({ version: "9.9.9", dist: { tarball: "https://packages.invalid/PRIVATE_URL", integrity: "sha512-dummy" } }) }, async () => {
    assert.equal(await run(["update", "--dry-run"], {
      HOME: home, TONEDIAL_HOME: join(home, "state"), TONEDIAL_AGENT_HOME: join(home, "agents"), TONEDIAL_REGISTRY: registry, TONEDIAL_INSTALL_SHAPE: "curl",
    }, join(home, "project"), false, false), 0);
  });
  assert.match(out.join(""), /https:\/\/registry\.invalid/);
  assert.doesNotMatch(out.join("") + err.join(""), /PRIVATE_URL|PRIVATE_BODY/);
});

test("registry metadata cannot turn an invalid release version into displayed private body text", async () => {
  for (const json of [false, true]) {
    out = [];
    err = [];
    await withFetch({ body: JSON.stringify({ version: "https://example.invalid/PRIVATE_BODY\nPRIVATE_URL", dist: { tarball: "https://packages.invalid/package.tgz", integrity: "sha512-dummy" } }) }, async () => {
      assert.equal(await run(["update", "--dry-run", ...(json ? ["--json"] : [])], {
        HOME: home, TONEDIAL_HOME: join(home, "state"), TONEDIAL_AGENT_HOME: join(home, "agents"), TONEDIAL_REGISTRY: "https://registry.invalid", TONEDIAL_INSTALL_SHAPE: "curl",
      }, join(home, "project"), false, false), 1);
    });
    if (json) {
      const payload = JSON.parse(out.join(""));
      assert.equal(payload.schema, 3);
      assert.equal(payload.ok, false);
    }
    assert.doesNotMatch(out.join("") + err.join(""), /PRIVATE_URL|PRIVATE_BODY/);
  }
  const version = "1.2.3-alpha.1+build.01";
  await withFetch({ body: JSON.stringify({ version, dist: { tarball: "https://packages.invalid/package.tgz", integrity: "sha512-dummy" } }) }, async () => {
    assert.equal((await latestRelease("https://registry.invalid", EN)).version, version, "valid prerelease/build labels remain accepted");
  });
});

test("leading whitespace cannot route a malformed URL into an error that echoes a local filename", async () => {
  assert.equal(await cli("init", "--here", "--tools", "none", "--auto"), 0);
  for (const json of [false, true]) {
    out = [];
    err = [];
    const asked: string[] = [];
    await withFetch({ body: PRESET, asked }, async () => {
      assert.equal(await cli("import", " \thttps://[PRIVATE_URL/?token=PRIVATE_BODY", ...(json ? ["--json"] : [])), 1);
    });
    assert.deepEqual(asked, []);
    assert.doesNotMatch(out.join("") + err.join(""), /PRIVATE_URL|PRIVATE_BODY/);
    if (json) assert.equal(JSON.parse(out.join("")).ok, false);
  }
});

test("only something with :// is a URL", () => {
  // `C:\\presets\\p.json` matched the scheme pattern and parsed as a URL, so an absolute
  // Windows path was refused for not being https rather than read as the file it is.
  // Colons are legal in POSIX filenames, and a file called `https:x.json` used to go out as a
  // real request to a host named `x.json`.
  for (const path of [
    "C:" + String.fromCharCode(92) + "presets" + String.fromCharCode(92) + "p.json",
    "./p.json",
    "p.json",
    "dir:name/p.json",
    "https:x.json",
  ]) {
    assert.equal(asUrl(path), null, path);
  }
  assert.notEqual(asUrl("https://example.invalid/p.json"), null);
});

test("the fetch carries an abort signal, which is all that bounds a server that never answers", async () => {
  // Waiting out the real ten seconds made the runner report one test for the whole file, so
  // this asserts the thing that is actually load-bearing: the signal reaching `fetch`. Removing
  // `AbortSignal.timeout` was a mutation the suite could not see.
  let signal: AbortSignal | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) => {
    signal = init?.signal;
    return Promise.resolve({
      url: "https://example.invalid/p.json",
      ok: true,
      status: 200,
      body: (async function* () { yield new TextEncoder().encode(PRESET); })(),
    } as unknown as Response);
  }) as typeof fetch;
  try {
    await fetchPreset(new URL("https://example.invalid/p.json"), EN);
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(signal instanceof AbortSignal, "no abort signal was passed to fetch");
  assert.equal(signal.aborted, false);
});
