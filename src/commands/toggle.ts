// Pause or resume native tone delivery while preserving the saved settings and full artifact.

import type { CommandResult, Ctx } from "../cli.ts";
import { serializeConfig } from "../core/config.ts";
import { wrap } from "../ui/width.ts";
import { applyPlanned, planArtifact, planConfig } from "./compile.ts";

async function setDelivery(ctx: Ctx, enabled: boolean): Promise<CommandResult> {
  const { change: configChange, config } = planConfig(ctx);
  const changed = config.enabled !== enabled;
  config.enabled = enabled;
  const { change: toneChange, size } = planArtifact(ctx, config);
  const finalConfig = { ...configChange, after: serializeConfig(config, ctx.t) };
  await applyPlanned(ctx, [configChange, toneChange], [finalConfig]);

  const message = enabled
    ? changed ? ctx.t.delivery.on : ctx.t.delivery.alreadyOn
    : changed ? ctx.t.delivery.off : ctx.t.delivery.alreadyOff;
  return {
    lines: [message, ...(enabled ? [] : [ctx.t.delivery.openConversation])]
      .flatMap((line) => wrap(line, ctx.ui.width - 2))
      .map((line) => `  ${ctx.ui.bold(changed ? ctx.ui.success(line) : line)}`),
    json: { enabled, changed, path: ctx.paths.tone, chars: size.chars },
  };
}

export const runOn = (ctx: Ctx): Promise<CommandResult> => setDelivery(ctx, true);
export const runOff = (ctx: Ctx): Promise<CommandResult> => setDelivery(ctx, false);
