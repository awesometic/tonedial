import { AXIS_ORDER, type Axes, type Axis } from "./anchors.ts";

export type Persona = {
  age: string | null;
  gender: string | null;
  address: { self_ref: string | null; user_ref: string | null } | null;
  note: string | null;
};

export type ComboId =
  | "refusalCompliance"
  | "formalSelfRef"
  | "casualUserRef"
  | "teensFormal"
  | "seniorJuniorSelfRef"
  | "addressUnlikely";

export type Warning = {
  layer: "forbidden" | "awkward" | "ineffective";
  rule: string;
  /** Key into `t.combos`. The sentence lives in the catalogue; this file stays pure. */
  id: ComboId;
};

// Composites are emitted instructions; combination layers below only warn.
const COMPOSITES: readonly { fires: (a: Axes) => boolean; line: string }[] = [
  {
    fires: (a) => a.warmth >= 4 && a.profanity >= 4,
    line: "Keep the swearing affectionate.",
  },
  {
    fires: (a) => a.compliance <= 2 && a.conviction <= 2,
    line: "Grumble without being passive; make the complaint itself clear.",
  },
];

export function composites(axes: Axes): string[] {
  return COMPOSITES.filter((c) => c.fires(axes)).map((c) => c.line);
}

// Address heuristics intentionally cover Korean only; other free-form terms stay unclassified.
// Widen only with a per-language address lexicon.
const INFORMAL_SELF = /^(나|내|형|누나|오빠|언니)$/;
const DEFERENTIAL_USER = /(님)$/;

export function check(
  axes: Axes,
  persona: Persona | null,
  speechLevel: "auto" | "polite" | "plain",
): Warning[] {
  const w: Warning[] = [];
  const add = (layer: Warning["layer"], rule: string, id: ComboId) => w.push({ layer, rule, id });

  if (axes.refusal >= 4 && axes.compliance >= 4) {
    add("forbidden", "refusal≥4 × compliance≥4", "refusalCompliance");
  }


  if (persona) {
    const selfRef = persona.address?.self_ref ?? null;
    const userRef = persona.address?.user_ref ?? null;

    if (axes.formality === 5 && selfRef && INFORMAL_SELF.test(selfRef)) {
      add("awkward", "formality 5 × informal self_ref", "formalSelfRef");
    }
    if (axes.formality <= 2 && speechLevel === "plain" && userRef && DEFERENTIAL_USER.test(userRef)) {
      add("awkward", "formality≤2 × deferential user_ref", "casualUserRef");
    }
    if (persona.age === "teens" && axes.formality === 5) {
      add("awkward", "age: teens × formality 5", "teensFormal");
    }
    if (persona.age === "50s+" && selfRef && INFORMAL_SELF.test(selfRef)) {
      add("awkward", "age: 50s+ with a junior self_ref", "seniorJuniorSelfRef");
    }

    // The spec's eighth awkward rule — `age` contradicting the relative age implied by
    // `address` — is **not implemented**. It needs a kinship lexicon that maps 형 or 누나 to a
    // relative age, in a design that takes address terms as free-form text in any language.
    // Recorded rather than dropped: the rule is right and the input it needs does not exist.

    // Measured, not predicted: across five `terse-operator` runs the configured address never
    // surfaced once, because a maximally terse reply has no natural slot for a vocative.
    // The user is told rather than obeyed, since the alternative is forcing unnatural output.
    if ((selfRef || userRef) && (axes.warmth <= 2 || axes.verbosity <= 2)) {
      add("ineffective", "address set while warmth≤2 or verbosity≤2", "addressUnlikely");
    }
  }

  return w;
}

/** The axes a preset moves off their default. Sparsity is 5±2 of these. */
export function nonDefaultAxes(axes: Axes, defaults: Record<Axis, number>): Axis[] {
  // Walks AXIS_ORDER rather than Object.keys: map iteration order follows the JSON file, and a
  // hand-edited config carrying a stray key would otherwise be reported as a non-default axis.
  return AXIS_ORDER.filter((a) => axes[a] !== defaults[a]);
}
