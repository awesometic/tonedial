// Schema-2 ownership is observable config state, so these tests stay below the command layer.
// They exercise only temporary public paths and never load or modify a real agent home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CONFIG_SCHEMA,
  LEGACY_CONFIG_SCHEMA,
  defaultConfig,
  isConfigV2,
  parseConfig,
  prepareApprovedMigration,
  serializeConfig,
  type Config,
  type ManagedResource,
  type WiringV2,
} from "../src/core/config.ts";
import {
  canonicalDestination,
  canonicalResourcePath,
  entryIdentity,
  fileIdentity,
} from "../src/core/paths.ts";
import {
  detachRegistration,
  emptyWiring,
  normalizeWiring,
  putRegistration,
  putResource,
  recordResource,
  registrationKey,
  resourceKey,
} from "../src/wiring/ownership.ts";
import { recordedHook } from "../src/wiring/targets.ts";

const HASH = "a".repeat(64);
let scratch = "";

function baseConfig(wiring: WiringV2 = emptyWiring()): Config {
  const config = defaultConfig();
  config.wiring = wiring;
  return config;
}

function resource(path: string, consumers: string[] = []): ManagedResource {
  return {
    path,
    kind: "hook",
    created: true,
    createdDir: true,
    consumers,
    expected: { type: "file", sha256: HASH },
    managed: {
      version: 1,
      event: "SessionStart",
      matcher: "startup|resume",
      handlerSha256: HASH,
    },
  };
}

test.beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-ownership-"));
});

test.afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("schema 2 round-trips graph state and serializes tuple maps deterministically", () => {
  const destination = join(scratch, "project");
  mkdirSync(destination, { recursive: true });
  const hook = join(destination, ".codex", "hooks.json");
  const first = registrationKey("codex", "project", canonicalDestination(destination));
  const second = registrationKey("claude", "global", canonicalDestination(destination));
  const hookId = resourceKey(canonicalResourcePath(hook), "hook");
  const hookPath = canonicalResourcePath(hook);
  const config = baseConfig({
    registrations: {
      [second]: { target: "claude", scope: "global", destination: canonicalDestination(destination), resourceIds: [hookId] },
      [first]: { target: "codex", scope: "project", destination: canonicalDestination(destination), resourceIds: [hookId] },
    },
    resources: {
      [hookId]: resource(hookPath, [second, first]),
    },
  });
  config.managedSeeds = {
    "reader": { path: join(scratch, "reader"), type: "file", version: 2, sha256: HASH },
    "guide": { path: join(scratch, "AGENTS.md"), type: "file", version: 1, sha256: HASH },
  };

  const serialized = serializeConfig(config);
  const parsed = parseConfig(serialized);
  assert.equal(parsed.schema, CONFIG_SCHEMA);
  assert.equal(isConfigV2(parsed), true);
  assert.equal(serializeConfig(parsed), serialized);
  assert.deepEqual(JSON.parse(serialized).wiring.registrations[first].resourceIds, [hookId]);
  assert.deepEqual(Object.keys(JSON.parse(serialized).managedSeeds), ["guide", "reader"]);
});

test("schema 2 round-trips independent lexical access witnesses for one physical resource", () => {
  const destination = canonicalDestination(scratch);
  const first = registrationKey("claude", "project", destination);
  const second = registrationKey("antigravity", "project", destination);
  const physical = join(scratch, "shared.md");
  const id = resourceKey(physical, "hook");
  const firstPath = join(scratch, ".claude", "CLAUDE.md");
  const secondPath = join(scratch, ".agents", "hooks.json");
  const wiring: WiringV2 = {
    registrations: {
      [first]: { target: "claude", scope: "project", destination, resourceIds: [id] },
      [second]: { target: "antigravity", scope: "project", destination, resourceIds: [id] },
    },
    resources: {
      [id]: {
        ...resource(physical, [first, second]),
        accessPaths: {
          [first]: { path: firstPath, type: "symlink", linkTarget: physical },
          [second]: { path: secondPath, type: "symlink", linkTarget: physical },
        },
      },
    },
  };
  const serialized = serializeConfig(baseConfig(wiring));
  const parsed = parseConfig(serialized);
  if (!isConfigV2(parsed)) throw new Error("round-tripped config is not schema 2");
  assert.deepEqual(parsed.wiring.resources[id]!.accessPaths, {
    [first]: { path: firstPath, type: "symlink", linkTarget: physical },
    [second]: { path: secondPath, type: "symlink", linkTarget: physical },
  });
  assert.equal(serializeConfig(parsed), serialized);

  const detached = detachRegistration(parsed.wiring, first);
  assert.equal(detached.resources[id]!.accessPaths?.[first], undefined);
  assert.deepEqual(detached.resources[id]!.accessPaths?.[second], {
    path: secondPath,
    type: "symlink",
    linkTarget: physical,
  });
});

test("shared native settings retain each registration's handler identity through serialization and detach", () => {
  const destination = canonicalDestination(scratch);
  const first = registrationKey("claude", "project", destination);
  const second = registrationKey("antigravity", "project", destination);
  const path = join(scratch, "hooks.json");
  const id = resourceKey(path, "hook");
  const firstMetadata = { version: 2, event: "SessionStart", matcher: "startup", command: "/old/node", runtime: "/old/node", args: ["reader.mjs", "claude"], handlerSha256: HASH, statusMessage: "ToneDial: load saved response tone" };
  const secondMetadata: ManagedResource["managed"] = {
    ...firstMetadata,
    event: "PreInvocation",
    matchers: [],
    command: '"/other/node" "reader.mjs" --provider antigravity',
  };
  delete secondMetadata.args;
  delete secondMetadata.statusMessage;
  const wiring: WiringV2 = {
    registrations: {
      [first]: { target: "claude", scope: "project", destination, resourceIds: [id], context: "pair" },
      [second]: { target: "antigravity", scope: "project", destination, resourceIds: [id], context: "pair" },
    },
    resources: { [id]: {
      ...resource(path, [first, second]),
      documentDescription: "ToneDial session hooks",
      managedByRegistration: { [second]: secondMetadata, [first]: firstMetadata },
    } },
  };
  const serialized = serializeConfig(baseConfig(wiring));
  const parsed = parseConfig(serialized);
  assert.ok(isConfigV2(parsed));
  const shared = parsed.wiring.resources[id]!;
  assert.deepEqual(Object.keys(shared.managedByRegistration!), [first, second].sort());
  assert.equal(recordedHook(shared, first)!.handler.command, "/old/node");
  assert.deepEqual(recordedHook(shared, first)!.handler.args, ["reader.mjs", "claude"]);
  assert.equal(recordedHook(shared, first)!.handler.statusMessage, "ToneDial: load saved response tone");
  assert.equal(recordedHook(shared, first)!.documentDescription, "ToneDial session hooks");
  assert.equal(recordedHook(shared, second)!.handler.args, undefined);
  assert.equal(recordedHook(shared, second)!.event, "PreInvocation");
  assert.deepEqual(recordedHook(shared, second)!.matchers, []);
  const missingMap = { ...shared };
  delete missingMap.managedByRegistration;
  assert.equal(recordedHook(missingMap, first), null);
  assert.equal(serializeConfig(parsed), serialized);
  const detached = detachRegistration(parsed.wiring, first);
  assert.equal(recordedHook(detached.resources[id]!, first), null);
  assert.equal(recordedHook(detached.resources[id]!, second)!.handler.command, secondMetadata.command);
  assert.equal(detached.resources[id]!.documentDescription, "ToneDial session hooks", "file metadata outlives an individual handler consumer");
  assert.equal(detachRegistration(detached, second).resources[id]!.managedByRegistration, undefined);
  assert.equal(recordedHook(shared, first)!.handler.command, "/old/node", "detachment must not mutate its input");

  for (const mutate of [
    (value: any) => { value.wiring.resources[id].managedByRegistration.bad = firstMetadata; },
    (value: any) => { value.wiring.resources[id].managedByRegistration[first].version = 1; },
    (value: any) => { value.wiring.resources[id].managedByRegistration[first].args = "not argv"; },
    (value: any) => { value.wiring.resources[id].managedByRegistration[first].statusMessage = []; },
    (value: any) => { value.wiring.resources[id].managedByRegistration[second].command = "bad\0value"; },
    (value: any) => { value.wiring.resources[id].documentDescription = false; },
    (value: any) => { value.wiring.resources[id].consumers = [second]; },
    (value: any) => { delete value.wiring.registrations[first].context; },
    (value: any) => { delete value.wiring.resources[id].managedByRegistration[first]; },
    (value: any) => { delete value.wiring.resources[id].managedByRegistration; },
  ]) {
    const malformed = JSON.parse(serialized);
    mutate(malformed);
    assert.throws(() => parseConfig(JSON.stringify(malformed)));
  }
});

test("schema 2 rejects malformed tuple keys, ownership references, and seed records", () => {
  const config = baseConfig();
  const valid = JSON.parse(serializeConfig(config)) as Record<string, unknown>;
  const malformed = [
    {
      ...valid,
      wiring: { registrations: { "not-a-tuple": {} }, resources: {} },
    },
    {
      ...valid,
      wiring: {
        registrations: {
          [registrationKey("codex", "project", scratch)]: {
            target: "codex", scope: "project", destination: scratch, resourceIds: ["[\"missing\",\"hook\"]"],
          },
        },
        resources: {},
      },
    },
    {
      ...valid,
      managedSeeds: { guide: { path: "relative/AGENTS.md", type: "file", version: 1, sha256: HASH } },
    },
    {
      ...valid,
      managedSeeds: { guide: { path: join(scratch, "AGENTS.md"), type: "file", version: 1, sha256: "bad" } },
    },
  ];
  for (const candidate of malformed) {
    assert.throws(() => parseConfig(JSON.stringify(candidate)), /config\.json/);
  }
});

test("schema 2 rejects an access witness that is not a resource consumer", () => {
  const destination = canonicalDestination(scratch);
  const first = registrationKey("claude", "project", destination);
  const second = registrationKey("antigravity", "project", destination);
  const path = join(scratch, "shared.md");
  const id = resourceKey(path, "hook");
  const config = baseConfig({
    registrations: {
      [first]: { target: "claude", scope: "project", destination, resourceIds: [id] },
    },
    resources: {
      [id]: resource(path, [first]),
    },
  });
  const raw = JSON.parse(serializeConfig(config)) as { wiring: { resources: Record<string, Record<string, unknown>> } };
  raw.wiring.resources[id]!.accessPaths = { [second]: { path: join(scratch, "link.md"), type: "file" } };
  assert.throws(() => parseConfig(JSON.stringify(raw)), /config\.json/);
});

test("shared consumers detach independently and retain the first creation fact", () => {
  const destination = canonicalDestination(scratch);
  const first = registrationKey("codex", "project", destination);
  const second = registrationKey("claude", "global", destination);
  const path = join(scratch, "shared.json");
  const id = resourceKey(canonicalResourcePath(path), "hook");
  let wiring = emptyWiring();
  wiring = putRegistration(wiring, { target: "codex", scope: "project", destination, resourceIds: [] });
  wiring = putRegistration(wiring, { target: "claude", scope: "global", destination, resourceIds: [] });
  wiring = recordResource(wiring, first, id, resource(path));
  wiring = recordResource(wiring, second, id, resource(path));
  assert.deepEqual(wiring.resources[id]!.consumers, [first, second].sort());

  wiring = putResource(wiring, id, { ...resource(path, []), created: false, createdDir: false });
  assert.equal(wiring.resources[id]!.created, true);
  assert.equal(wiring.resources[id]!.createdDir, true);
  assert.deepEqual(wiring.resources[id]!.consumers, [first, second].sort());

  wiring = detachRegistration(wiring, first);
  assert.deepEqual(wiring.resources[id]!.consumers, [second]);
  wiring = detachRegistration(wiring, second);
  assert.deepEqual(wiring.resources[id]!.consumers, []);
  assert.ok(wiring.resources[id], "an orphaned state resource remains available for repair");
});

test("approved migration preserves opaque schema-1 ownership evidence without writing", () => {
  const legacyText = JSON.stringify({
    schema: LEGACY_CONFIG_SCHEMA,
    axes: { critique: 5 },
    wiring: {
      claude: { created: true, createdDir: true },
      unknown: { maybeOwned: true, destination: "/not-safe-to-infer" },
    },
  });
  const legacy = parseConfig(legacyText);
  const prepared = prepareApprovedMigration(legacy);
  assert.equal(legacy.schema, LEGACY_CONFIG_SCHEMA);
  assert.equal(prepared.config.schema, CONFIG_SCHEMA);
  assert.deepEqual(prepared.config.wiring, emptyWiring());
  assert.deepEqual(prepared.legacy.wiring, legacy.wiring);
  assert.equal(prepared.config.axes.critique, 5);
  prepared.config.managedSeeds.reader = {
    path: join(scratch, "reader"), type: "file", version: 2, sha256: HASH,
  };
  assert.equal(prepared.legacy.managedSeeds.reader, undefined);
  assert.throws(() => serializeConfig(legacy), /schema 1/);
  assert.equal(serializeConfig(prepared.config).includes("unknown"), false);
});

test("canonical resource identity keeps symlink entries distinct from their referents", () => {
  const target = join(scratch, "target.json");
  const link = join(scratch, "linked.json");
  const other = join(scratch, "other.json");
  const directory = join(scratch, "directory");
  mkdirSync(directory);
  // The target contents are irrelevant; the identity contract is about path entries and aliases.
  writeFileSync(target, "target\n");
  writeFileSync(other, "other\n");
  symlinkSync(target, link);
  const targetPath = canonicalResourcePath(target);
  const linkPath = canonicalResourcePath(link);
  assert.notEqual(resourceKey(targetPath, "hook"), resourceKey(linkPath, "hook"));
  assert.deepEqual(fileIdentity(target), entryIdentity(target));
  assert.notDeepEqual(fileIdentity(target), entryIdentity(link));
  assert.equal(canonicalDestination(directory), canonicalResourcePath(directory));
  assert.equal(existsSync(link), true);
  // Keep the no-write assertion explicit for this test's filesystem probes.
  assert.equal(existsSync(other), true);
});

test("normalization is a copy and does not mutate the ownership graph", () => {
  const destination = canonicalDestination(scratch);
  const registration = registrationKey("codex", "project", destination);
  const id = resourceKey(join(scratch, "resource"), "reader");
  const input: WiringV2 = {
    registrations: {
      [registration]: { target: "codex", scope: "project", destination, resourceIds: [id] },
    },
    resources: {
      [id]: {
        path: join(scratch, "resource"),
        kind: "reader",
        created: true,
        createdDir: false,
        consumers: [registration],
        expected: { type: "file" },
        managed: { version: 1 },
      },
    },
  };
  const normalized = normalizeWiring(input);
  assert.equal("files" in normalized.resources[id]!.expected, false);
  normalized.registrations[registration]!.resourceIds.push("later");
  assert.deepEqual(input.registrations[registration]!.resourceIds, [id]);
});

test("retired reader records survive config changes and disconnect without new ownership", () => {
  const destination = canonicalDestination(scratch);
  const route = registrationKey("codex", "project", destination);
  const path = join(destination, "reader.mjs");
  const id = resourceKey(path, "reader");
  const legacyReader: ManagedResource = { ...resource(path, [route]), kind: "reader" };
  const config = parseConfig(serializeConfig(baseConfig({
    registrations: { [route]: { target: "codex", scope: "project", destination, resourceIds: [id] } },
    resources: { [id]: legacyReader },
  })));
  if (!isConfigV2(config)) throw new Error("expected schema 2");
  config.axes.warmth = 5;
  const changed = parseConfig(serializeConfig(config));
  assert.deepEqual(changed.wiring.resources?.[id], legacyReader);
  config.wiring = detachRegistration(config.wiring, route);
  const disconnected = parseConfig(serializeConfig(config));
  assert.deepEqual(disconnected.wiring.resources?.[id], { ...legacyReader, consumers: [] });
  assert.deepEqual(disconnected.managedSeeds, {}, "retired evidence is not seed ownership");

  const empty = putRegistration(emptyWiring(), {
    target: "codex", scope: "project", destination, resourceIds: [],
  });
  assert.throws(() => recordResource(empty, route, id, legacyReader), /reader.*read-only/i);
  assert.deepEqual(empty.resources, {});
});
