import assert from "node:assert/strict";
import { ADDRESS_COMPOSITION, ADDRESS_FREQUENCY, PERSONA } from "../../src/core/anchors.ts";
import { compile, type Config } from "../../src/core/compile.ts";

/** Preserve captured bytes while checking all compiler text outside the new address policy. */
export function assertRecordedTone(input: Config, recorded: string): void {
  assert.equal(input.address_frequency, undefined, "this capture predates address frequency");
  let current = compile(input).replace(`- ${ADDRESS_COMPOSITION}\n`, "")
    .replace(`- ${ADDRESS_FREQUENCY.auto}\n`, "");
  const refs = input.persona?.address;
  const modern = PERSONA.address(refs?.self_ref ?? null, refs?.user_ref ?? null);
  if (modern !== null) {
    const parts: string[] = [];
    if (refs?.self_ref) parts.push(`Call yourself ${refs.self_ref}`);
    if (refs?.user_ref) parts.push(`${parts.length ? "c" : "C"}all the user ${refs.user_ref}`);
    current = current.replace(modern, `${parts.join("; ")}.`);
  }
  assert.equal(current, recorded);
}
