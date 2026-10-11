// Eject disconnects the selected scope. It does not uninstall the CLI, remove global shell
// setup, or guess ownership of a project export from its filename.

import type { CommandResult, Ctx } from "../cli.ts";
import { runUnwire } from "./wire.ts";
import { humanText, receiptLines } from "../ui/format.ts";

export async function runEject(ctx: Ctx, _args: string[]): Promise<CommandResult> {
  const result = await runUnwire(ctx, []);
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
