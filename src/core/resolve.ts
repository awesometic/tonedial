import type { Config as StoredConfig } from "./config.ts";
import type { Config as CompileInput } from "./compile.ts";

export function toCompileInput(stored: StoredConfig): CompileInput {
  const p = stored.persona;
  const hasPersona =
    p.age !== null || p.gender !== null || p.note !== null || p.user !== null || p.agent !== null || p.address !== null;

  return {
    // The slug rides in the generation comment, so the model reads it. `unsaved` is what the
    // artifact says once the axes have moved away from the preset that named them.
    preset: stored.unsaved ? null : stored.preset,
    axes: stored.axes,
    speech_level: stored.speech_level,
    persona: hasPersona ? p : null,
    safeword: stored.safeword,
  };
}
