// Skill ownership tests use only temporary public paths. They exercise the action planner
// directly; command gates and the recovery dispatcher consume the same descriptors later.

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { catalogue } from "../src/core/i18n.ts";
import { entryIdentity, canonicalResourcePath, resolveAgentPaths } from "../src/core/paths.ts";
import { applyRollback, gate, type PlannedOperationAction } from "../src/wiring/apply.ts";
import { inspectOperations, type OperationAction, type OperationPaths } from "../src/core/operations.ts";
import {
  emptyWiring,
  putRegistration,
  recordResource,
  registrationKey,
  resourceKey,
} from "../src/wiring/ownership.ts";
import {
  planSelectedSkills,
  planSkillInstall,
  planSkillRemoval,
  rollbackSkillAction,
} from "../src/wiring/skill.ts";
import type { WiringRegistration } from "../src/core/config.ts";
import { palette } from "../src/ui/style.ts";

const EN = catalogue("en").cli;
let scratch = "";

function registration(target: "codex" | "claude" | "antigravity", root: string): Omit<WiringRegistration, "resourceIds"> {
  return { target, scope: "project", destination: root };
}

function linkedSkill(): { source: string; destination: string; removal: PlannedOperationAction } {
  const source = join(scratch, "state", "skill", "tonedial");
  const destination = join(scratch, ".agents", "skills", "tonedial");
  const route = registration("codex", scratch);
  const routeId = registrationKey(route.target, route.scope, route.destination);
  let wiring = putRegistration(emptyWiring(), { ...route, resourceIds: [] });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "skill\n");

  const install = planSkillInstall(destination, source, wiring, {
    mode: "link",
    files: {},
    boundary: scratch,
  }, EN);
  if (install.action === null) throw new Error("expected a skill install action");
  install.action.apply();
  wiring = recordResource(wiring, routeId, install.resourceId, install.resource);

  const removal = planSkillRemoval(destination, source, routeId, wiring, { boundary: scratch }, EN);
  if (removal.action === null) throw new Error("expected a skill removal action");
  return { source, destination, removal: removal.action };
}

function operationPaths(): OperationPaths {
  const root = join(scratch, "operation-state");
  return {
    root,
    operations: join(root, "operations"),
    operationsLock: join(root, "operations.lock"),
  };
}

function gateOptions(paths: OperationPaths) {
  return {
    paths,
    t: EN,
    dryRun: false,
    auto: true,
    ui: palette("never", {}, false),
    out: () => {},
  };
}

function laterFailure(path: string): PlannedOperationAction {
  const parent = dirname(path);
  const realPath = join(fs.realpathSync(parent), basename(path));
  const parentStat = fs.statSync(parent, { bigint: true });
  const action: OperationAction = {
    id: `file:${path}`,
    kind: "file",
    path,
    realPath,
    before: {
      exists: false,
      resolvedPath: realPath,
      realPath: null,
      symbolicLink: false,
      linkTarget: null,
      mode: null,
      pathIdentity: null,
      targetIdentity: null,
      parentIdentity: `${parentStat.dev}:${parentStat.ino}`,
      parentPath: parent,
    },
    after: {
      exists: true,
      resolvedPath: realPath,
      realPath,
      symbolicLink: false,
      linkTarget: null,
      mode: 0o600,
      pathIdentity: null,
      targetIdentity: null,
      parentIdentity: null,
      parentPath: null,
      bytes: "Y29udGVudA==",
    },
    metadata: { created: true, createdDir: false, requestedMode: null },
  };
  return {
    action,
    apply: () => { throw new Error("injected later skill failure"); },
  };
}

test.beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tonedial-skill-"));
});

test.afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("link planning preserves the lexical entry and rolls back only the owned link", () => {
  const source = join(scratch, "state", "skill", "tonedial");
  const destination = join(scratch, ".agents", "skills", "tonedial");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "skill\n");

  const plan = planSkillInstall(destination, source, emptyWiring(), {
    mode: "link",
    files: {},
    boundary: scratch,
  }, EN);
  assert.equal(plan.state, "absent");
  assert.equal(plan.resource.path, destination);
  assert.equal(plan.resource.expected.type, "symlink");
  assert.equal(plan.resource.expected.linkTarget, source);
  assert.equal(plan.resourceId, resourceKey(canonicalResourcePath(destination), "skill"));
  assert.ok(plan.action);
  plan.action.assertFresh?.();
  plan.action.apply();
  const applied = plan.action.after?.();
  assert.ok(applied);
  assert.equal(lstatSync(destination).isSymbolicLink(), true);
  assert.equal(readFileSync(destination + "/SKILL.md", "utf8"), "skill\n");

  rollbackSkillAction(applied, EN);
  assert.equal(existsSync(destination), false);
  assert.equal(existsSync(source), true);
});

test("last-consumer link removal executes and explicit rollback restores the same link", () => {
  const { source, destination, removal } = linkedSkill();
  const sourceFile = join(source, "SKILL.md");
  const sourceIdentity = entryIdentity(source);
  const sourceBytes = readFileSync(sourceFile);

  removal.assertFresh?.();
  removal.apply();
  assert.equal(lstatSync(destination, { throwIfNoEntry: false }), undefined);
  const applied = removal.after?.();
  assert.ok(applied);

  rollbackSkillAction(applied, EN);
  const restored = lstatSync(destination, { throwIfNoEntry: false });
  assert.ok(restored?.isSymbolicLink());
  assert.equal(readlinkSync(destination), source);
  assert.deepEqual(entryIdentity(source), sourceIdentity);
  assert.deepEqual(readFileSync(sourceFile), sourceBytes);
});

test("link removal rollback preserves a foreign replacement and its referent", () => {
  const { source, destination, removal } = linkedSkill();
  const sourceFile = join(source, "SKILL.md");
  const sourceIdentity = entryIdentity(source);
  const sourceBytes = readFileSync(sourceFile);

  removal.apply();
  const applied = removal.after?.();
  assert.ok(applied);

  const foreignSource = join(scratch, "foreign", "skill");
  mkdirSync(foreignSource, { recursive: true });
  writeFileSync(join(foreignSource, "SKILL.md"), "foreign\n");
  symlinkSync(foreignSource, destination, "dir");
  const replacementIdentity = entryIdentity(destination);

  assert.throws(
    () => rollbackSkillAction(applied, EN),
    /changed after the operation; preserving it/,
  );
  assert.equal(readlinkSync(destination), foreignSource);
  assert.deepEqual(entryIdentity(destination), replacementIdentity);
  assert.deepEqual(entryIdentity(source), sourceIdentity);
  assert.deepEqual(readFileSync(sourceFile), sourceBytes);
});

test("gated link removal leaves a pending journal and explicit rollback restores it", async () => {
  const { source, destination, removal } = linkedSkill();
  const sourceFile = join(source, "SKILL.md");
  const sourceIdentity = entryIdentity(source);
  const sourceBytes = readFileSync(sourceFile);
  const paths = operationPaths();

  await assert.rejects(
    () => gate([], {
      ...gateOptions(paths),
      operationActions: [removal, laterFailure(join(scratch, "later-action"))],
    }),
    /injected later skill failure/,
  );
  assert.equal(lstatSync(destination, { throwIfNoEntry: false }), undefined);

  const pending = inspectOperations(paths).journals.find((entry) => entry.state === "pending")?.journal;
  assert.ok(pending);
  assert.deepEqual(pending.completed, [0]);
  assert.equal((pending.actions[0]!.after as { kind?: unknown }).kind, "missing");

  const ownerPath = join(paths.operationsLock, "owner.json");
  const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
  owner.pid = 2_147_483_000;
  writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);

  const restored = applyRollback(paths, pending.operationId, EN);
  assert.deepEqual(restored, {
    operationId: pending.operationId,
    state: "rolled-back",
    restored: 1,
    alreadyReverted: 1,
    unresolved: [],
  });
  const link = lstatSync(destination, { throwIfNoEntry: false });
  assert.ok(link?.isSymbolicLink());
  assert.equal(readlinkSync(destination), source);
  assert.deepEqual(entryIdentity(source), sourceIdentity);
  assert.deepEqual(readFileSync(sourceFile), sourceBytes);
  assert.equal(inspectOperations(paths).lock.state, "none");
});

test("rollback preserves a recreated link when restoration was interrupted before checkpoint", async () => {
  const { source, destination, removal } = linkedSkill();
  const sourceFile = join(source, "SKILL.md");
  const sourceIdentity = entryIdentity(source);
  const sourceBytes = readFileSync(sourceFile);
  const paths = operationPaths();

  await assert.rejects(
    () => gate([], {
      ...gateOptions(paths),
      operationActions: [removal, laterFailure(join(scratch, "later-action"))],
    }),
    /injected later skill failure/,
  );
  const pending = inspectOperations(paths).journals.find((entry) => entry.state === "pending")?.journal;
  assert.ok(pending);

  const ownerPath = join(paths.operationsLock, "owner.json");
  const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
  owner.pid = 2_147_483_000;
  writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);

  // Simulate recovery landing the new lexical link before its journal checkpoint is durable.
  rollbackSkillAction(pending.actions[0]!, EN);
  const recreatedIdentity = entryIdentity(destination);
  assert.ok(recreatedIdentity);

  const retried = applyRollback(paths, pending.operationId, EN);
  assert.equal(retried.state, "pending");
  assert.equal(retried.restored, 0);
  assert.equal(retried.alreadyReverted, 0);
  assert.match(retried.unresolved[0] ?? "", /changed/);
  assert.deepEqual(entryIdentity(destination), recreatedIdentity);
  assert.equal(readlinkSync(destination), source);
  assert.deepEqual(entryIdentity(source), sourceIdentity);
  assert.deepEqual(readFileSync(sourceFile), sourceBytes);
});

test("link planning permits a seed action to create the source before its gated action", () => {
  const source = join(scratch, "state", "skill", "tonedial");
  const destination = join(scratch, ".agents", "skills", "tonedial");
  const plan = planSkillInstall(destination, source, emptyWiring(), {
    mode: "link",
    files: {},
    boundary: scratch,
  }, EN);
  assert.ok(plan.action);
  mkdirSync(source, { recursive: true });
  plan.action.apply();
  assert.equal(lstatSync(destination).isSymbolicLink(), true);
});

test("skill actions refuse a destination parent replaced after preview", () => {
  const source = join(scratch, "state", "skill", "tonedial");
  const parent = join(scratch, ".agents", "skills");
  const destination = join(parent, "tonedial");
  mkdirSync(source, { recursive: true });
  mkdirSync(parent, { recursive: true });
  const plan = planSkillInstall(destination, source, emptyWiring(), {
    mode: "link",
    files: {},
    boundary: scratch,
  }, EN);
  assert.ok(plan.action);
  renameSync(parent, join(scratch, ".agents", "skills-old"));
  mkdirSync(parent, { recursive: true });
  assert.throws(() => plan.action!.assertFresh?.(), /The file was preserved/);
});

test("selected tools share one physical action and retain separate consumers", () => {
  const agent = resolveAgentPaths({ global: false, project: null }, { HOME: scratch }, scratch);
  const source = join(scratch, "state", "skill", "tonedial");
  const selected = planSelectedSkills(agent, ["codex", "antigravity"], source, emptyWiring(), {
    "SKILL.md": "skill\n",
  }, EN);

  assert.equal(selected.actions.length, 1, "shared .agents entry is one physical action");
  assert.equal(selected.skills.length, 2);
  assert.equal(Object.keys(selected.wiring.resources).length, 1);
  const resource = Object.values(selected.wiring.resources)[0]!;
  assert.equal(resource.consumers.length, 2);
  assert.deepEqual(selected.skills.map((skill) => skill.tool), ["codex", "antigravity"]);

  mkdirSync(source, { recursive: true });
  selected.actions[0]!.apply();
  const shared = join(scratch, ".agents", "skills", "tonedial");
  assert.equal(lstatSync(shared).isSymbolicLink(), true);

  const repeat = planSelectedSkills(agent, ["codex"], source, selected.wiring, {
    "SKILL.md": "skill\n",
  }, EN);
  assert.equal(repeat.actions.length, 0);
});

test("unrecorded files and directories are foreign even when their names match", () => {
  const source = join(scratch, "state", "skill", "tonedial");
  const destination = join(scratch, ".agents", "skills", "tonedial");
  mkdirSync(source, { recursive: true });
  mkdirSync(destination, { recursive: true });
  const extra = join(destination, "notes.txt");
  writeFileSync(extra, "keep me\n");

  assert.throws(() => planSkillInstall(destination, source, emptyWiring(), {
    mode: "link",
    files: {},
    boundary: scratch,
  }, EN), /The file was preserved/);
  assert.equal(readFileSync(extra, "utf8"), "keep me\n");
});

test("managed copies refresh generated files and preserve extras", () => {
  const source = join(scratch, "state", "skill", "tonedial");
  const destination = join(scratch, ".agents", "skills", "tonedial");
  const files = { "SKILL.md": "one\n", "references/traits.md": "traits\n" };
  const route = registration("codex", scratch);
  let wiring = emptyWiring();
  const first = planSkillInstall(destination, source, wiring, { mode: "copy", files, boundary: scratch }, EN);
  assert.ok(first.action);
  first.action.apply();
  const id = first.resourceId;
  const routeId = registrationKey(route.target, route.scope, route.destination);
  wiring = putRegistration(wiring, { ...route, resourceIds: [] });
  wiring = recordResource(wiring, routeId, id, first.resource);
  const extra = join(destination, "marketplace.md");
  writeFileSync(extra, "foreign\n");

  const refreshedFiles = { ...files, "SKILL.md": "two\n" };
  const refresh = planSkillInstall(destination, source, wiring, {
    mode: "copy",
    files: refreshedFiles,
    boundary: scratch,
  }, EN);
  assert.ok(refresh.action);
  refresh.action.apply();
  assert.equal(readFileSync(join(destination, "SKILL.md"), "utf8"), "two\n");
  assert.equal(readFileSync(extra, "utf8"), "foreign\n");

  writeFileSync(join(destination, "SKILL.md"), "user edit\n");
  assert.throws(() => planSkillInstall(destination, source, wiring, {
    mode: "copy",
    files: refreshedFiles,
    boundary: scratch,
  }, EN), /The file was preserved/);
});

test("last-consumer removal deletes only managed copy files and keeps extras", () => {
  const source = join(scratch, "state", "skill", "tonedial");
  const destination = join(scratch, ".agents", "skills", "tonedial");
  const files = { "SKILL.md": "one\n", "references/traits.md": "traits\n" };
  const route = registration("codex", scratch);
  const routeId = registrationKey(route.target, route.scope, route.destination);
  let wiring = putRegistration(emptyWiring(), { ...route, resourceIds: [] });
  const first = planSkillInstall(destination, source, wiring, { mode: "copy", files, boundary: scratch }, EN);
  assert.ok(first.action);
  first.action.apply();
  wiring = recordResource(wiring, routeId, first.resourceId, first.resource);
  const extra = join(destination, "keep.txt");
  writeFileSync(extra, "keep\n");

  const removal = planSkillRemoval(destination, source, routeId, wiring, { boundary: scratch }, EN);
  assert.ok(removal.action);
  removal.action.assertFresh?.();
  removal.action.apply();
  assert.equal(existsSync(join(destination, "SKILL.md")), false);
  assert.equal(existsSync(join(destination, "references", "traits.md")), false);
  assert.equal(readFileSync(extra, "utf8"), "keep\n");
  // The planner does not infer provenance for an intermediate `references/` container; keeping
  // an empty pre-existing container is safer than removing a user's directory by emptiness.
  assert.deepEqual(readdirSync(destination).sort(), ["keep.txt", "references"]);
});
