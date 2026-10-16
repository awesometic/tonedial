import { AXIS_ORDER, type Axes, type Axis } from "./anchors.ts";

export const PERSONA_DESCRIPTION_MAX = 200;

export type Persona = {
  age: string | null;
  gender: string | null;
  address: { self_ref: string | null; user_ref: string | null } | null;
  note: string | null;
  /** Free-form user context, kept separate from the address and closed-set fields. */
  user: string | null;
  /** A fictional agent role; any credentials in it are unverified. */
  agent: string | null;
};

export type ComboId = "refusalCompliance";

export type Warning = {
  layer: "forbidden";
  rule: string;
  /** Key into `t.combos`. The sentence lives in the catalogue; this file stays pure. */
  id: ComboId;
};

// Composites are emitted style instructions; confirmation remains a control below.
const COMPOSITES: readonly { fires: (a: Axes) => boolean; line: string }[] = [
  {
    fires: (a) => a.warmth >= 4 && a.profanity >= 4,
    line: "Character: use affectionate swearing.",
  },
  {
    fires: (a) => a.compliance <= 2 && a.conviction <= 2,
    line: "Grumble without being passive; make the complaint itself clear.",
  },
  {
    fires: (a) => a.care === 5,
    line: "Character: be a caring organizer; keep the user oriented with brief status markers and a clear next step.",
  },
  {
    fires: (a) => a.playfulness >= 4 && a.bravado >= 4,
    line: "Character: be a playful, cocky expert; add confident wit while keeping the technical answer clear.",
  },
  {
    fires: (a) => a.verbosity <= 2 && a.care >= 4,
    line: "When verbosity is low and care is high, keep organized items compact; use functional emoji or status markers when they fit.",
  },
  {
    fires: (a) => a.verbosity <= 2 && (a.warmth >= 4 || a.flattery >= 4 || a.playfulness >= 4),
    line: "When verbosity is low, express warmth, praise and playfulness inside the short answer — a clause, interjection or address term — instead of extra sentences.",
  },
  {
    fires: (a) => a.verbosity === 5 && a.care === 1,
    line: "When verbosity is high and care is minimal, give depth inside the requested task without adding adjacent work.",
  },
];

export function composites(axes: Axes): string[] {
  return COMPOSITES.filter((c) => c.fires(axes)).map((c) => c.line);
}

/** Names only the intense components statically selected by known axes. */
export function intensityConfirmation(axes: Axes): string | null {
  const components: string[] = [];
  if (axes.profanity >= 4) {
    components.push("strong, uncensored non-protected profanity; it changes coarseness and does not itself add mockery or criticism");
  }
  if (axes.critique === 5) {
    components.push("harsh, mocking criticism of supported defects and choices; it adds no profanity and never inflates severity or technical claims");
  }
  if (axes.playfulness >= 4 && (axes.profanity >= 4 || axes.critique === 5)) {
    components.push("fictional violent imagery and theatrical menace about code, work, or the situation");
  }
  if (components.length === 0) return null;

  return `Intense components requested by the current tone: ${components.join("; ")}.`;
}

/** Independent persona choices are valid; warn only when axis instructions conflict. */
export function check(axes: Axes): Warning[] {
  return axes.refusal >= 4 && axes.compliance >= 4
    ? [{ layer: "forbidden", rule: "refusal≥4 × compliance≥4", id: "refusalCompliance" }]
    : [];
}

/** The axes a preset moves off their default; custom profiles have no count restriction. */
export function nonDefaultAxes(axes: Axes, defaults: Record<Axis, number>): Axis[] {
  // Walks AXIS_ORDER rather than Object.keys: map iteration order follows the JSON file, and a
  // hand-edited config carrying a stray key would otherwise be reported as a non-default axis.
  return AXIS_ORDER.filter((a) => axes[a] !== defaults[a]);
}
