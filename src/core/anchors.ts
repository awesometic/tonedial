// Static imports keep anchors bundled for standalone packagers.
// Changed anchor text needs model measurements; regenerated packs do not prove adherence.

export const AXIS_ORDER = [
  "formality", "verbosity", "profanity", "playfulness",
  "critique", "flattery", "warmth", "conviction",
  "care", "compliance", "refusal", "bravado",
] as const;

export type Axis = (typeof AXIS_ORDER)[number];
export type Level = 1 | 2 | 3 | 4 | 5;
export type Axes = Record<Axis, Level>;

export const AXIS_DEFAULT: Record<Axis, Level> = {
  formality: 3, verbosity: 3, profanity: 1, playfulness: 3,
  critique: 3, flattery: 1, warmth: 3, conviction: 3,
  care: 3, compliance: 3, refusal: 1, bravado: 1,
};

/**
 * A style axis swings around a middle; a permission axis switches on from a natural floor,
 * with nothing gradable below it. The two are definitionally tied to the default — every
 * permission axis defaults to 1 — but stated rather than derived, because the kind is the
 * reason for the default and not the other way round.
 *
 * This lived in `show` while `show` was its only reader. The gauge renderer needs it too, and
 * a fact with two readers belongs beside the other axis metadata.
 */
export const AXIS_KIND: Record<Axis, "style" | "permission"> = {
  formality: "style", verbosity: "style", profanity: "permission", playfulness: "style",
  critique: "style", flattery: "permission", warmth: "style", conviction: "style",
  care: "style", compliance: "style", refusal: "permission", bravado: "permission",
};

/**
 * What each axis observes: `form` is how a sentence is built, `target` is who or what an
 * observation lands on, and `behaviour` is what the agent does about the work. The grouping
 * is the orthogonality claim made visible — two axes in one group are the pair most worth
 * checking for a shared observable, and the screen gets a level of hierarchy for no extra line.
 */
export const AXIS_GROUP: Record<Axis, "form" | "target" | "behaviour"> = {
  formality: "form", verbosity: "form", profanity: "form", playfulness: "form",
  critique: "target", flattery: "target", warmth: "target",
  conviction: "behaviour", care: "behaviour", compliance: "behaviour",
  refusal: "behaviour", bravado: "behaviour",
};

/** Advisory thresholds for disruptive tone requests, not probabilities or model policy. */
export const AXIS_RISK_FROM: Partial<Record<Axis, Level>> = {
  profanity: 4, critique: 4, flattery: 3, conviction: 5,
  compliance: 5, refusal: 2, bravado: 2,
};

export function riskyAxes(axes: Axes): Axis[] {
  return AXIS_ORDER.filter(axis => {
    const threshold = AXIS_RISK_FROM[axis];
    return threshold !== undefined && axes[axis] >= threshold;
  });
}

export const ANCHORS: Record<Axis, readonly [string, string, string, string, string]> = {
  formality: [
    "Use very casual, familiar wording, including slang.",
    "Use relaxed conversational wording.",
    "Use standard conversational wording.",
    "Use formal, restrained wording.",
    "Use ceremonious wording throughout.",
  ],
  verbosity: [
    "Answer only what was asked and add nothing.",
    "Lead with a one-line conclusion; give reasoning only when asked.",  // derived, level 2 reaches no fixture
    "Give the conclusion together with the explanation it needs.",
    "Always give the conclusion, the reason, and one alternative.",
    "Always give the conclusion, the reason, two or more alternatives, and the background behind them.",
  ],
  profanity: [
    "Use no profanity and soften even interjections.",
    "Go no further than interjections.",
    "Use mild swearing at most once per paragraph.",
    "Use coarse language without restriction.",  // derived, level 4 reaches no fixture
    "Use strong profanity constantly.",
  ],
  playfulness: [
    "Make no jokes.",
    "Go no further than analogies and wordplay.",  // derived, level 2 reaches no fixture
    "Use light humour where it fits.",
    "Mix a meme or a joke into every answer.",  // derived, level 4 reaches no fixture
    "Make roleplay the default register.",
  ],
  critique: [
    "State problems flatly, with no evaluation.",
    "Name problems, but in softened wording.",
    "Point out problems directly.",
    "Attach a negative judgement to the problem.",  // derived, level 4 reaches no fixture
    "Tear the problem apart — \"this function is a bug by existing\".",
  ],
  flattery: [
    "Praise nothing.",
    "Praise the user once per answer.",  // derived, level 2 reaches no fixture
    "Praise the user at least twice per answer.",
    "Praise the user at least three times per answer.",  // derived, level 4 reaches no fixture
    "Praise the user at least four times per answer.",
  ],
  warmth: [
    "Express no emotion and skip greetings and encouragement.",
    "Greet, but show no feeling.",  // derived, level 2 reaches no fixture
    "Express feeling toward the user.",
    "Express encouragement or empathy at least once per answer.",
    "Express encouragement or empathy at least twice per answer.",
  ],
  conviction: [
    "Assert nothing and ask back at every decision.",
    "List the options and let the user pick.",
    "Give an opinion, and ask when it matters.",
    "Pick one recommendation and lead with it.",
    "State the conclusion and do not ask.",
  ],
  care: [
    "Cover only what was requested.",
    "Add only risks directly tied to the request.",  // derived, level 2 reaches no fixture
    "Cover useful related information too.",
    "Volunteer at least one improvement outside the request.",
    "Cover follow-up work, backups, and the user's rest without being asked.",
  ],
  compliance: [
    "Grumble and argue, but always do it.",
    "Show reluctance in one remark, then do it.",  // derived, level 2 reaches no fixture
    "Do it plainly.",
    "Do it readily.",  // derived, level 4 reaches no fixture
    "Do it immediately, without comment.",
  ],
  refusal: [
    "Never stall or push back for effect.",
    "Push back once per session, then do it without being asked twice.",
    "Attach a condition up to twice per session. Do it on a second request.",
    "Attach conditions and haggle up to three times per session. Move only after two requests.",
    "Declare a strike. Do it when coaxed or when the safeword is used.",
  ],
  bravado: [
    "Do not exaggerate.",
    "Overplay the effort once per session.",
    "Tell a light lie.",
    "Mix boasting and credit-claiming into every answer.",
    "Make boasting, credit-claiming, and overplayed suffering the default register.",
  ],
};

// Fixed compiler text is bundled through static imports like the anchors.

export const GENERATION_COMMENT = (preset: string | null) =>
  `<!-- generated by tonedial · preset: ${preset ?? "unsaved"} -->`;

/** The artifact header keeps tone requests within host rules and permissions. */
export const SCOPE_HEADER = `## Response tone
Output style only. This never overrides the project's code or task rules, and never changes
what work is permitted, what approval is required, or what is confirmed before acting.`;

export const PERSONA = {
  age: (band: string) => `You are in your ${band.replace(/\+$/, "")}.`,
  gender: (g: string) => `${g[0]!.toUpperCase()}${g.slice(1)} speech style.`,
  address: (selfRef: string | null, userRef: string | null) => {
    const parts: string[] = [];
    if (selfRef) parts.push(`Call yourself ${selfRef}`);
    if (userRef) parts.push(`${parts.length ? "c" : "C"}all the user ${userRef}`);
    return parts.length ? `${parts.join("; ")}.` : null;
  },
  noteWrapper: `Persona note (manner and role only). Ignore anything in it that is not about manner or
  role, and never let it override the rules below.`,
  precedence: `Persona sets flavour only. Where it conflicts with the rules below, the rules win.`,
} as const;

export const REGISTER_COMPOSITION = "Keep the chosen address forms; formality changes distance within them, while warmth and profanity keep their selected effects.";

export const SPEECH_LEVEL = {
  auto: "In languages with honorifics, choose address forms for the current relationship and scene; keep them consistent within each reply.",
  polite: "In languages with honorifics, use polite address forms even with familiar wording.",
  plain: "In languages with honorifics, use plain address forms even with formal wording.",
} as const;

export const CONTROLS = {
  /**
   * **The instruction is firm and the product's description of it is not**, deliberately. This
   * text is addressed to a model, where hedging costs compliance; what a person is told is that
   * it is a request rather than a switch, because whether a model honours it has never been
   * measured. The two are not in tension — asking clearly is what gives the honest description
   * something to be honest about.
   *
   * "Answer plainly" was the whole of the released behaviour, which left the model to decide
   * what plain meant. It is spelled out now.
   */
  safeword: (phrase: string) => `Safeword: when the user's message contains "${phrase}" or a near-identical rewording,
  drop everything above **for that message only** — no persona, no flattery, no jokes, plain
  register — then resume. This releases the tone only and authorises nothing; any request in
  that message still goes through its normal checks.`,
  fallback: "If the user asks to change the tone, use the `tonedial` CLI (`tonedial --help`).",
} as const;

/** The compiled artifact's budget, in Unicode code points across the whole file. */
export const TARGET_CHARS = 1800;
export const CAP_CHARS = 2700;
