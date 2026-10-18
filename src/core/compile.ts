import {
  ANCHORS, AXIS_ORDER, CONTROLS, DELIVERY_OFF_MARKER, FORMAT_COMPOSITION, GENERATION_COMMENT, PERSONA,
  REGISTER_COMPOSITION, SCOPE_HEADER, SPEECH_LEVEL, STYLE_MARKER,
  type Axes,
} from "./anchors.ts";
import { composites, intensityConfirmation, PERSONA_DESCRIPTION_MAX, type Persona } from "./combos.ts";

export type SpeechLevel = keyof typeof SPEECH_LEVEL;

export type Config = {
  preset: string | null;
  /** Missing means on for direct callers and artifacts produced before the switch existed. */
  enabled?: boolean;
  axes: Axes;
  speech_level: SpeechLevel;
  persona: Persona | null;
  /** null when the user has not set one, which is the documented default. */
  safeword: string | null;
};

const UNSPECIFIED = "unspecified";

const isSet = (v: string | null | undefined): v is string =>
  typeof v === "string" && v.trim() !== "" && v !== UNSPECIFIED;

const hasDescription = (v: string | null | undefined): v is string =>
  typeof v === "string" && v.trim() !== "";

// Keep free-form persona values inside their prose/block-quote wrapper.
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").trim();

function personaLines(p: Persona): string[] {
  const self = isSet(p.address?.self_ref) ? oneLine(p.address!.self_ref!) : null;
  const user = isSet(p.address?.user_ref) ? oneLine(p.address!.user_ref!) : null;

  const identity = [
    isSet(p.age) ? PERSONA.age(p.age) : null,
    isSet(p.gender) ? PERSONA.gender(p.gender) : null,
    PERSONA.address(self, user),
  ].filter((s): s is string => s !== null);

  const lines: string[] = [];
  if (identity.length) lines.push(`- ${identity.join(" ")}`);
  if (hasDescription(p.user)) {
    lines.push(`- ${PERSONA.userWrapper}\n  > ${oneLine(p.user)}`);
  }
  if (hasDescription(p.agent)) {
    lines.push(`- ${PERSONA.agentWrapper}\n  > ${oneLine(p.agent)}`);
  }
  if (isSet(p.note)) lines.push(`- ${PERSONA.noteWrapper}\n  > ${oneLine(p.note)}`);
  if (lines.length) lines.push(`- ${PERSONA.precedence}`);
  return lines;
}

function validate(config: Config): void {
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new RangeError("enabled must be true or false");
  }
  for (const axis of AXIS_ORDER) {
    const level = config.axes[axis];
    if (!Number.isInteger(level) || level < 1 || level > 5) {
      throw new RangeError(`axis ${axis} is ${level}, not a level 1 to 5`);
    }
  }
  if (!Object.hasOwn(SPEECH_LEVEL, config.speech_level)) {
    throw new RangeError(`speech_level is ${config.speech_level}, not auto, polite, plain, or rough`);
  }
  if (config.persona !== null) {
    for (const field of ["user", "agent"] as const) {
      const value = config.persona[field];
      if (value !== null && typeof value !== "string") {
        throw new RangeError(`persona.${field} must be a string or null`);
      }
      if (typeof value === "string" && [...value.trim()].length > PERSONA_DESCRIPTION_MAX) {
        throw new RangeError(`persona.${field} exceeds ${PERSONA_DESCRIPTION_MAX} Unicode code points`);
      }
    }
  }
  // An empty safeword would match every message and release the tone permanently.
  if (config.safeword !== null && config.safeword.trim() === "") {
    throw new RangeError("safeword is empty; use null when the user has not set one");
  }
}

export function compile(config: Config): string {
  validate(config);
  const out: string[] = [
    GENERATION_COMMENT(config.preset),
    STYLE_MARKER(config.axes.verbosity, config.axes.care),
  ];
  if (config.enabled === false) out.push(DELIVERY_OFF_MARKER);
  out.push(SCOPE_HEADER);

  if (config.persona) {
    const lines = personaLines(config.persona);
    if (lines.length) out.push("### Persona", ...lines);
  }

  const rules = AXIS_ORDER.map((axis) => `- ${ANCHORS[axis][config.axes[axis] - 1]}`);
  rules.push(...composites(config.axes).map((line) => `- ${line}`));

  rules.push(`- ${FORMAT_COMPOSITION}`, `- ${REGISTER_COMPOSITION}`, `- ${SPEECH_LEVEL[config.speech_level]}`);

  out.push("### Rules", ...rules);

  const controls: string[] = [`- ${CONTROLS.intensityConsent}`];
  const confirmation = intensityConfirmation(config.axes);
  if (confirmation !== null) controls.push(`- ${confirmation}`);
  if (config.safeword !== null) controls.push(`- ${CONTROLS.safeword(oneLine(config.safeword))}`);
  controls.push(`- ${CONTROLS.intensityBoundary}`);
  controls.push(`- ${CONTROLS.fallback}`);
  out.push("### Controls", ...controls);

  return out.join("\n") + "\n";
}

export type SizeReport = {
  chars: number;
};

export function measure(artifact: string): SizeReport {
  const chars = [...artifact].length;
  return {
    chars,
  };
}
