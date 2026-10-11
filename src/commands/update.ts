// Update curl installations, guide npm updates, and report generated-state freshness.

import type { CommandResult, Ctx } from "../cli.ts";
import { VERSION } from "../cli.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";

import { ConfigError, parseConfig, type Config } from "../core/config.ts";
import { AGENT_TOOLS, UPDATE_COMMAND, installShape } from "../core/paths.ts";
import { REGISTRY, downloadRelease, haveTar, installRelease, installedVersion, latestRelease } from "../core/selfupdate.ts";
import { confirm } from "../ui/prompt.ts";
import { SEED_VERSION, inspectSeeds, recordedSeedSelection } from "../core/seeds.ts";
import { humanText } from "../ui/format.ts";
import { urlIdentity } from "../core/net.ts";

/** A damaged state file must not disable package guidance or reveal its parser excerpt. */
function updateConfig(ctx: Ctx): { config: Config | null; issue: string | null } {
  let descriptor: number | undefined;
  try {
    const root = lstatSync(ctx.paths.root, { throwIfNoEntry: false });
    if (!root) return { config: null, issue: "missing" };
    if (!root.isDirectory() || root.isSymbolicLink()) return { config: null, issue: "unsafe" };
    const named = lstatSync(ctx.paths.config, { throwIfNoEntry: false });
    if (!named) return { config: null, issue: "missing" };
    if (!named.isFile() || named.isSymbolicLink() || named.size > 1024 * 1024) {
      return { config: null, issue: "unsafe" };
    }
    descriptor = openSync(ctx.paths.config, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.mode !== named.mode || opened.size !== named.size ||
        opened.mtimeMs !== named.mtimeMs || opened.ctimeMs !== named.ctimeMs) return { config: null, issue: "changed" };
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(descriptor, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const bytes = buffer.subarray(0, count);
    const after = fstatSync(descriptor);
    const current = lstatSync(ctx.paths.config, { throwIfNoEntry: false });
    const currentRoot = lstatSync(ctx.paths.root, { throwIfNoEntry: false });
    if (bytes.length > 1024 * 1024 || !current?.isFile() || current.dev !== opened.dev || current.ino !== opened.ino || current.mode !== opened.mode ||
        current.size !== opened.size || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs ||
        !currentRoot?.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== root.dev || currentRoot.ino !== root.ino ||
        after.mode !== opened.mode || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return { config: null, issue: "changed" };
    return { config: parseConfig(new TextDecoder("utf-8", { fatal: true }).decode(bytes), ctx.t), issue: null };
  } catch (cause) {
    if (cause instanceof ConfigError || (cause instanceof TypeError && (cause as NodeJS.ErrnoException).code === "ERR_ENCODING_INVALID_ENCODED_DATA")) {
      return { config: null, issue: "invalid" };
    }
    if ((cause as NodeJS.ErrnoException).code) return { config: null, issue: "unreadable" };
    throw cause;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function runUpdate(ctx: Ctx): Promise<CommandResult> {
  const shape = installShape(ctx.paths, undefined, ctx.env);
  // `UPDATE_COMMAND` for every shape now, including curl — that is `tonedial update`, the
  // command being run. Handing back a `curl … | sh` line pointed a user at a second route to
  // the same release, which is the "two channels serving one version" this deliberately avoids.
  const command = UPDATE_COMMAND[shape];
  const registry = ctx.env.TONEDIAL_REGISTRY?.trim() || REGISTRY;

  const { config, issue } = updateConfig(ctx);
  // Content, not version. A `seedVersion` that matches proves only that some `init` stamped it;
  // comparing the files is what tells a user whether their home holds this package's anchors.
  let stale: ReturnType<typeof inspectSeeds> | null = null;
  let stateIssue = issue;
  if (config && config.seedVersion !== 0) {
    try {
      const selection = recordedSeedSelection(config, AGENT_TOOLS);
      stale = inspectSeeds(ctx.paths, config.managedSeeds, selection).filter((entry) => entry.state !== "current");
    } catch (cause) {
      if (!(cause instanceof ConfigError) && !(cause as NodeJS.ErrnoException).code) throw cause;
      stateIssue = "unreadable";
    }
  }

  const lines = [
    `  ${ctx.ui.bold(ctx.t.update.running(VERSION))}`,
    `  ${ctx.ui.dim(ctx.t.update.installedBy(shape))}`,
    "",
  ];

  // npm is told, not driven. Spawning a package manager to update a package it owns is a
  // different act from replacing a directory this tool put there itself.
  let replaced: string | null = null;
  if (shape !== "curl") {
    lines.push(`  ${ctx.t.update.onlyCurl(shape)}`, `  ${ctx.t.update.toUpdate}`, `    ${ctx.ui.accent(command)}`);
  } else {
    // Before the network, like `install.sh` checks its tools before it fetches anything.
    if (!haveTar()) throw new ConfigError(ctx.t.update.noTar);
    lines.push(`  ${ctx.ui.dim(ctx.t.update.fetching(humanText(urlIdentity(registry, ctx.t))))}`);
    const release = await latestRelease(registry, ctx.t);

    if (release.version === VERSION) {
      // Nothing downloaded. The common case is an install that is already current, and paying
      // for the whole package to be told so is a cost with nothing on the other side of it.
      lines.push(`  ${ctx.ui.success(ctx.t.update.already(release.version))}`);
    } else if (ctx.flags.dryRun) {
      lines.push(`  ${ctx.ui.warn(ctx.t.update.wouldReplace(humanText(ctx.paths.lib), humanText(release.version)))}`);
    } else if (!ctx.flags.auto && !ctx.canPrompt) {
      // JSON never asks, including on a terminal. Explicit --auto supplies approval through
      // the same branch as human output; absent approval, report the existing no-install result.
      lines.push(`  ${ctx.ui.warn(ctx.t.update.needsApproval)}`);
    } else if (ctx.flags.auto || (await confirm(ctx.t.update.question(release.version))) === "yes") {
      const tarball = await downloadRelease(release, ctx.t);
      lines.push(`  ${ctx.ui.accent(ctx.t.update.found(release.version, tarball.byteLength))}`);
      installRelease(ctx.paths, tarball, ctx.t);
      // **What landed, not what was claimed.** The registry's `version` is metadata; a stub or
      // a mistake serving one number and a different tarball made `update` report a version it
      // had not installed — and, because the no-op check compares that metadata against this
      // process's own constant, swap again on every run forever.
      replaced = installedVersion(ctx.paths) ?? release.version;
      lines.push(`  ${ctx.ui.success(ctx.ui.bold(ctx.t.update.replaced(replaced)))}`);
    } else {
      lines.push(`  ${ctx.t.update.declined}`);
    }
  }

  const warnings: string[] = [];
  // **After a swap, this process can no longer speak for what is installed.** `SEED_VERSION` and
  // `seedFiles` are constants in the copy that has just been replaced, so a release that moved
  // the anchors would be reported against the old ones — which is the exact gap this command
  // exists to close. Say the one thing that is still true and stop measuring.
  if (replaced !== null || config === null || config.seedVersion === 0 || stateIssue !== null || (stale && stale.length > 0)) {
    lines.push("", `  ${ctx.t.update.thenRefresh}`, `    ${ctx.ui.accent("tonedial doctor --fix")}`);
  }
  if (replaced === null && config?.seedVersion === 0) {
    warnings.push(ctx.t.update.neverInitialised);
  } else if (replaced === null && stale && stale.length > 0) {
    // Second, and phrased as a second step: replacing the package is not the whole update, and
    // a user who stops at the first line is the one who ends up running new code on old anchors.
    for (const { seed, state } of stale) {
      if (state !== "current") warnings.push(`${ctx.t.doctor.seedReason[state]}\n${seed.path}`);
    }
  }

  return {
    lines,
    json: {
      version: VERSION,
      shape,
      command,
      replaced,
      seedVersion: config?.seedVersion ?? null,
      stateIssue,
      stateRecoveryRequired: stateIssue !== null || config?.seedVersion === 0 || (stale?.length ?? 0) > 0 || replaced !== null,
      recoveryCommand: "tonedial doctor --fix",
      // Null after a swap: this process is the old package, and reporting its constants as the
      // installed ones would be a claim it cannot make.
      packageSeedVersion: replaced === null ? SEED_VERSION : null,
      staleSeeds: replaced === null ? (stale?.map(({ seed }) => seed.label) ?? null) : null,
      seedIssues: replaced === null ? (stale?.map(({ seed, state }) => ({ path: seed.path, reason: state })) ?? null) : null,
      // Named for what it is. On npm this command asks nothing of the network, so a consumer
      // must not read silence here as "you are up to date".
      checkedRemote: shape === "curl",
    },
    warnings,
  };
}
