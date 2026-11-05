// Eject disconnects the selected scope. It does not uninstall the CLI, remove global shell
// setup, or guess ownership of a project export from its filename.

import type { CommandResult, Ctx } from "../cli.ts";
import { disconnect } from "./wire.ts";
import { planConfig } from "./compile.ts";
import { AGENT_TOOLS } from "../core/paths.ts";
import { humanText, receiptLines } from "../ui/format.ts";
import { refuseHomeProject, refuseUnscopedDisconnect } from "../wiring/scopes.ts";

export async function runEject(ctx: Ctx, _args: string[]): Promise<CommandResult> {
  refuseHomeProject(ctx.agent, ctx.env, "tonedial eject --global", ctx.t);
  if (!(ctx.scopeExplicit ?? (ctx.flags.global || ctx.flags.here === true || ctx.flags.project !== null))) {
    refuseUnscopedDisconnect(planConfig(ctx).config, ctx.cwd, "tonedial eject", ctx.t, undefined, true);
  }
  const result = await disconnect(ctx, [...AGENT_TOOLS], true);
  const diff = result.json.diff as { path: string }[];
  return {
    ...result,
    lines: [...result.lines, ...receiptLines(ctx.t.wiring.stateKept(humanText(ctx.paths.root)), ctx.ui.width - 2).map(line => `  ${line}`)],
    json: {
      ...result.json,
      removed: result.json.applied ? diff.filter((change) => change.path !== ctx.paths.config).map((change) => change.path) : [],
      stateRoot: ctx.paths.root,
      stateKept: true,
    },
  };
}
