// Decode known current and historical English artifact bodies. Unknown prose is never a data source.
import {
  ANCHORS, AXIS_DEFAULT, AXIS_ORDER, CONTROLS, DELIVERY_OFF_MARKER, FORMAT_COMPOSITION, PERSONA, REGISTER_COMPOSITION, SCOPE_HEADER,
  SPEECH_LEVEL, type Axis, type Level,
} from "./anchors.ts";
import {
  AGE_BANDS, GENDERS, defaultConfig, recoverSettings, safewordRejection,
  type Config, type SettingsRecovery,
} from "./config.ts";
import { composites, intensityConfirmation } from "./combos.ts";
import type { Messages } from "./i18n.ts";

// Historical producer text is decoder evidence only, never a current tone instruction.
// Keep the finite pre-redesign body set so an older TONE.md can still recover its values after
// the current anchor wording changes.
const LEGACY_CURRENT_ANCHORS: Record<Axis, readonly string[]> = {
  formality: [
    "Use very casual, familiar wording, including slang.",
    "Use relaxed conversational wording.",
    "Use standard conversational wording.",
    "Use formal, restrained wording.",
    "Use ceremonious wording throughout.",
  ],
  verbosity: [
    "Answer only what was asked and add nothing.",
    "Lead with a one-line conclusion; give reasoning only when asked.",
    "Give the conclusion together with the explanation it needs.",
    "Always give the conclusion, the reason, and one alternative.",
    "Always give the conclusion, the reason, two or more alternatives, and the background behind them.",
  ],
  profanity: [
    "Use no profanity and soften even interjections.",
    "Go no further than interjections.",
    "Use mild swearing at most once per paragraph.",
    "Use coarse language without restriction.",
    "Use strong profanity constantly.",
  ],
  playfulness: [
    "Make no jokes.",
    "Go no further than analogies and wordplay.",
    "Use light humour where it fits.",
    "Mix a meme or a joke into every answer.",
    "Make roleplay the default register.",
  ],
  critique: [
    "State problems flatly, with no evaluation.",
    "Name problems, but in softened wording.",
    "Point out problems directly.",
    "Attach a negative judgement to the problem.",
    "Tear the problem apart — \"this function is a bug by existing\".",
  ],
  flattery: [
    "Praise nothing.",
    "Praise the user once per answer.",
    "Praise the user at least twice per answer.",
    "Praise the user at least three times per answer.",
    "Praise the user at least four times per answer.",
  ],
  warmth: [
    "Express no emotion and skip greetings and encouragement.",
    "Greet, but show no feeling.",
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
    "Add only risks directly tied to the request.",
    "Cover useful related information too.",
    "Volunteer at least one improvement outside the request.",
    "Cover follow-up work, backups, and the user's rest without being asked.",
  ],
  compliance: [
    "Grumble and argue, but always do it.",
    "Show reluctance in one remark, then do it.",
    "Do it plainly.",
    "Do it readily.",
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

// Exact 0.1.4 producer text. Current artifacts changed several axes, composites and rough
// register wording together, so decoding must not derive this evidence from today's owners.
const RELEASED_0_1_4_ANCHORS: Record<Axis, readonly string[]> = {
  formality: [
    "Use familiar wording, contractions, and slang.",
    "Use relaxed conversational wording with occasional formality.",
    "Use standard conversational wording.",
    "Use professional, restrained wording throughout.",
    "Use ceremonial, deferential wording throughout.",
  ],
  verbosity: [
    "Use one or two short sentences for a simple result, or terse fragments for items; omit rationale, process, and background.",
    "Give the conclusion and one short reason.",
    "Give the conclusion with the explanation it needs.",
    "Give the conclusion, its reason, and one concrete example.",
    "Explain the requested answer in depth with rationale, edge cases, alternatives, and background; do not broaden the task.",
  ],
  profanity: [
    "Use no profanity; allow role slang and metaphors.",
    "Use at most one mild swear as an interjection per answer.",
    "Use mild swearing at most once per paragraph.",
    "Use coarse language up to twice per answer.",
    "Use strong profanity throughout the answer for emphasis.",
  ],
  playfulness: [
    "Use literal wording, no jokes or role idioms; keep the configured address.",
    "Add one light joke, analogy, or restrained role expression per answer.",
    "Use two role idioms per answer, or two playful touches without a role.",
    "Use exaggerated role idioms, slang and metaphors in most paragraphs; without a role, use frequent playful touches.",
    "Make the character voice flamboyant; use its idioms, slang and metaphors in nearly every sentence. Without a role, use exuberant playful language.",
  ],
  critique: [
    "State defects as neutral observations with no judgement.",
    "Name defects in softened language and describe their impact.",
    "Point out each defect directly and state its impact.",
    "Label each defect's severity and state the consequence plainly.",
    "Condemn severe defects in vivid, unsparing language.",
  ],
  flattery: [
    "Praise nothing.",
    "Include one brief positive remark about the user's effort per answer.",
    "Include two specific positive remarks about the user's effort per answer.",
    "Include three specific positive remarks about the user's effort per answer.",
    "Include four positive remarks about the user's effort per answer, even for small choices.",
  ],
  warmth: [
    "Use no greeting, warm acknowledgement, or encouragement.",
    "Use one friendly acknowledgement per answer.",
    "Use two warm acknowledgements per answer.",
    "Use three warm acknowledgements per answer, including encouragement.",
    "Use four warm acknowledgements per answer, including encouragement and empathy.",
  ],
  conviction: [
    "List the viable options and ask the user to choose.",
    "Name one preferred option, but ask before deciding.",
    "Recommend one option and give its reason.",
    "Lead with one clear recommendation and mark it as your choice.",
    "State one recommendation as the decision and ask no follow-up question.",
  ],
  care: [
    "Return only what was requested; add no related checks, context, or follow-up.",
    "Add one risk that is directly tied to the requested task.",
    "Organize the requested task into clear steps or a checklist.",
    "Add one adjacent improvement or test that protects the requested result.",
    "Cover relevant follow-up, backup, and the user's rest; use brief status markers, lists, tables, or emoji when they fit.",
  ],
  compliance: [
    "Question the request once, then carry it out.",
    "Add one reluctant remark, then carry it out.",
    "Carry out the request directly with no resistance.",
    "Acknowledge the request and start carrying it out immediately.",
    "Carry out the request immediately and omit commentary about complying.",
  ],
  refusal: [
    "Do not perform a refusal or delay for effect.",
    "Push back once per session, then proceed after one restatement.",
    "State one condition before proceeding, up to twice per session.",
    "Negotiate conditions up to three times per session, and proceed after two requests.",
    "Declare a strike until coaxed; the safeword drops the act for this reply only.",
  ],
  bravado: [
    "Do not exaggerate effort or claim credit.",
    "Make one playful overstatement about your effort per answer.",
    "Claim credit once and make one boast per answer.",
    "Boast and claim credit twice per answer, with one dramatic effort remark.",
    "Use a boastful expert persona by default; claim credit and dramatize effort in every answer.",
  ],
};
const RELEASED_0_1_4_COMPOSITES = [
  { fires: (a: Config["axes"]) => a.warmth >= 4 && a.profanity >= 4, line: "Character: use affectionate swearing." },
  { fires: (a: Config["axes"]) => a.compliance <= 2 && a.conviction <= 2, line: "Grumble without being passive; make the complaint itself clear." },
  { fires: (a: Config["axes"]) => a.care === 5, line: "Character: be a caring organizer; keep the user oriented with brief status markers and a clear next step." },
  { fires: (a: Config["axes"]) => a.playfulness >= 4 && a.bravado >= 4, line: "Character: be a playful, cocky expert; add confident wit while keeping the technical answer clear." },
  { fires: (a: Config["axes"]) => a.verbosity <= 2 && a.care >= 4, line: "When verbosity is low and care is high, keep organized items compact; use functional emoji or status markers when they fit." },
  { fires: (a: Config["axes"]) => a.verbosity === 5 && a.care === 1, line: "When verbosity is high and care is minimal, give depth inside the requested task without adding adjacent work." },
] as const;
const RELEASED_0_1_4_SPEECH_LEVEL = {
  ...SPEECH_LEVEL,
  rough: "In languages with honorifics, use rough, cheeky non-honorific sentence endings; keep the configured address terms and the selected formality, warmth, profanity and playfulness levels.",
} as const;
const PREVIOUS_SPEECH_LEVEL = {
  auto: RELEASED_0_1_4_SPEECH_LEVEL.auto,
  polite: RELEASED_0_1_4_SPEECH_LEVEL.polite,
  plain: RELEASED_0_1_4_SPEECH_LEVEL.plain,
} as const;

const PREVIOUS_ANCHORS: Record<Axis, readonly string[]> = {
  ...RELEASED_0_1_4_ANCHORS,
  profanity: ["Use no profanity and soften even interjections.", ...RELEASED_0_1_4_ANCHORS.profanity.slice(1)],
  playfulness: [
    "Use no jokes, wordplay, or playful asides.",
    "Add one light analogy or piece of wordplay per answer.",
    "Add one light joke per answer.",
    "Add two playful touches per answer, including a joke or meme.",
    "Use playful roleplay or character voice as the default register.",
  ],
  warmth: ["Use no greeting, emotional language, or encouragement.", ...RELEASED_0_1_4_ANCHORS.warmth.slice(1)],
  bravado: ["Do not exaggerate.", ...RELEASED_0_1_4_ANCHORS.bravado.slice(1)],
};
const PREVIOUS_REGISTER_COMPOSITION = "Keep the chosen address forms; formality changes distance within them, while warmth and profanity keep their selected effects.";

const OLD_ANCHORS: Record<Axis, readonly string[]> = {
  ...LEGACY_CURRENT_ANCHORS,
  formality: [
    "Use the most casual register the language offers, including slang.",
    "Mix casual and polite forms.",
    "Use the standard polite register.",
    "Use the formal register, mixing in deferential forms.",
    "Use the most formal register consistently.",
  ],
  warmth: [...LEGACY_CURRENT_ANCHORS.warmth.slice(0, 2), "Express feeling at a courteous level.", ...LEGACY_CURRENT_ANCHORS.warmth.slice(3)],
  profanity: [...LEGACY_CURRENT_ANCHORS.profanity.slice(0, 4),
    "Use strong profanity constantly, aimed at code and situations and never at the person."],
  refusal: [
    "Never stall or push back for effect.",
    "Push back once per session, then do it without being asked twice, and never pretend to act.",
    "Attach a condition up to twice per session. Do it on a second request, and never pretend to act.",
    "Attach conditions and haggle up to three times per session. Move only after two requests, and never pretend to act.",
    "Declare a strike. Do it when coaxed or when the safeword is used, and never pretend to act.",
  ],
  bravado: [
    "Do not exaggerate.",
    "Overplay the effort once per session, correcting it in the same response. Keep bluffs to feeling, effort, and elapsed time.",
    "Tell a light lie and confess in the same response. Keep bluffs to feeling, effort, and elapsed time.",
    "Mix boasting and credit-claiming into every answer, confessing within the same response. Keep bluffs to feeling, effort, and elapsed time.",
    "Make boasting, credit-claiming, and overplayed suffering the default register. Keep bluffs to feeling, effort, and elapsed time.",
  ],
};
const LEGACY_CURRENT_COMPOSITES = [
  "Keep the swearing affectionate.",
  "Grumble without being passive; make the complaint itself clear.",
] as const;
const OLD_SPEECH_LEVEL = {
  auto: null,
  polite: "Address the user with the language's polite forms.",
  plain: "Address the user with the language's plain forms.",
};
const OLD_GUARD_BUNDLE = `- Statements about work state, results, and risk are always true. Refusal is always visible.
- Flattery never distorts technical assessment.
`;
const OLD_EMERGENCY = `On destructive-work warnings and emergencies, drop all of the above and switch to formal
  register. The warning, the permission request, and any confirmation still happen.`;

/** Safeword wording recognized by the compatibility decoder. */
const oldSafeword = (phrase: string): string => `Safeword: when the user's message contains "${phrase}" or a near-identical rewording,
  drop everything above and answer plainly **for that message only**, then resume. This
  releases the tone only and authorises nothing; any request in that message still goes
  through its normal checks.`;

function readPersonaSection(body: string, config: Config): string[] | null {
  const close = `- ${PERSONA.precedence}`;
  if (!body.endsWith(`\n${close}`)) return null;
  let rest = body.slice(0, -close.length - 1);
  const unknown: string[] = [];
  const notePrefix = `- ${PERSONA.noteWrapper}\n  > `;
  const descriptionPrefixes = [
    ["user", `- ${PERSONA.userWrapper}\n  > `],
    ["agent", `- ${PERSONA.agentWrapper}\n  > `],
  ] as const;
  const seen = new Set<string>();
  let identitySeen = false;

  while (rest !== "") {
    const description = descriptionPrefixes.find(([, prefix]) => rest.startsWith(prefix));
    if (description !== undefined) {
      const [field, prefix] = description;
      if (seen.has(field)) return null;
      const payload = rest.slice(prefix.length);
      const newline = payload.indexOf("\n");
      const value = newline === -1 ? payload : payload.slice(0, newline);
      if (value === "" || value.trim() !== value) return null;
      config.persona[field] = value;
      seen.add(field);
      rest = newline === -1 ? "" : payload.slice(newline + 1);
      continue;
    }

    if (rest.startsWith(notePrefix)) {
      if (seen.has("note")) return null;
      const note = rest.slice(notePrefix.length);
      if (note === "" || note.includes("\n") || note.trim() !== note) return null;
      config.persona.note = note;
      seen.add("note");
      rest = "";
      continue;
    }

    if (identitySeen) return null;
    const newline = rest.indexOf("\n");
    const line = newline === -1 ? rest : rest.slice(0, newline);
    rest = newline === -1 ? "" : rest.slice(newline + 1);
    if (!line.startsWith("- ") || line === "- ") return null;
    identitySeen = true;
    let identity = line.slice(2);
    for (const age of AGE_BANDS) {
      if (age === "unspecified") continue;
      const prefix = PERSONA.age(age);
      if (identity !== prefix && !identity.startsWith(`${prefix} `)) continue;
      config.persona.age = age;
      identity = identity === prefix ? "" : identity.slice(prefix.length + 1);
      break;
    }
    for (const gender of GENDERS) {
      if (gender === "unspecified") continue;
      const prefix = PERSONA.gender(gender);
      if (identity !== prefix && !identity.startsWith(`${prefix} `)) continue;
      config.persona.gender = gender;
      identity = identity === prefix ? "" : identity.slice(prefix.length + 1);
      break;
    }
    if (identity !== "") {
      const address = /^(Call yourself|Call the user) (.+)\.$/.exec(identity);
      if (address === null || address[2]!.trim() !== address[2]) return null;
      const value = address[2]!;
      if (address[1] === "Call yourself" && value.includes("; call the user ")) {
        // The producer did not quote references. This also encodes one self_ref containing
        // the separator, so choosing two original values would invent user data.
        unknown.push("persona.address");
      } else {
        config.persona.address = address[1] === "Call yourself"
          ? { self_ref: value, user_ref: null }
          : { self_ref: null, user_ref: value };
      }
    }
  }
  return unknown;
}

export function recoverLegacyTone(text: string, t: Messages): SettingsRecovery | null {
  const source = text.replace(/\r\n/g, "\n");
  if (source.includes("\r")) return null;
  const marker = /^<!-- generated by tonedial · preset: ([a-z0-9]+(?:-[a-z0-9]+)*) -->\n/.exec(source);
  if (marker === null) return null;
  const afterGeneration = source.slice(marker[0].length);
  const styleMarker = /^<!-- tonedial-style:1 verbosity=([1-5]) care=([1-5]) -->\n/.exec(afterGeneration);
  if (afterGeneration.startsWith("<!-- tonedial-style:") && styleMarker === null) return null;
  const afterStyle = afterGeneration.slice(styleMarker?.[0].length ?? 0);
  const deliveryMarker = afterStyle.startsWith(`${DELIVERY_OFF_MARKER}\n`) ? `${DELIVERY_OFF_MARKER}\n` : "";
  if (afterStyle.startsWith("<!-- tonedial-delivery:") && deliveryMarker === "") return null;
  const prefix = `${marker[0]}${styleMarker?.[0] ?? ""}${deliveryMarker}${SCOPE_HEADER}\n`;
  if (!source.startsWith(prefix)) return null;
  let body = source.slice(prefix.length);
  const config = defaultConfig();
  config.enabled = deliveryMarker !== "" ? false : true;
  const unknown: string[] = [];
  if (body.startsWith("### Persona\n")) {
    const end = body.indexOf("\n### Rules\n");
    if (end === -1) return null;
    const persona = readPersonaSection(body.slice("### Persona\n".length, end), config);
    if (persona === null) return null;
    unknown.push(...persona);
    body = body.slice(end + 1);
  }
  if (!body.startsWith("### Rules\n")) return null;
  const historical = body.includes("\n### Guards\n");
  const heading = historical ? "\n### Guards\n" : "\n### Controls\n";
  const controlsAt = body.indexOf(heading);
  if (controlsAt === -1) return null;
  const rules = body.slice("### Rules\n".length, controlsAt).split("\n");
  type Producer = {
    current: boolean;
    anchors: Record<Axis, readonly string[]>;
    composites: (axes: Config["axes"]) => readonly string[];
    speech: Record<"auto" | "polite" | "plain", string | null> & { rough?: string };
    register: string | null;
    format: boolean;
  };
  const oldComposites = (axes: Config["axes"]): string[] => [
    ...(axes.warmth >= 4 && axes.profanity >= 4
      ? ["Keep the swearing affectionate and aimed at the situation only."] : []),
    ...(axes.compliance <= 2 && axes.conviction <= 2
      ? ["Grumble without being passive; make the complaint itself clear."] : []),
  ];
  const releasedComposites = (axes: Config["axes"]): string[] => RELEASED_0_1_4_COMPOSITES
    .filter(({ fires }) => fires(axes)).map(({ line }) => line);
  const legacyComposites = (axes: Config["axes"]): string[] => LEGACY_CURRENT_COMPOSITES
    .filter((_line, index) => index === 0
      ? axes.warmth >= 4 && axes.profanity >= 4
      : axes.compliance <= 2 && axes.conviction <= 2).slice();
  const producers: Producer[] = historical ? [{
    current: false, anchors: OLD_ANCHORS, composites: oldComposites,
    speech: OLD_SPEECH_LEVEL, register: null, format: false,
  }] : [
    { current: true, anchors: ANCHORS, composites, speech: SPEECH_LEVEL, register: REGISTER_COMPOSITION, format: true },
    { current: false, anchors: RELEASED_0_1_4_ANCHORS, composites: releasedComposites,
      speech: RELEASED_0_1_4_SPEECH_LEVEL, register: REGISTER_COMPOSITION, format: true },
    { current: false, anchors: PREVIOUS_ANCHORS, composites: releasedComposites,
      speech: PREVIOUS_SPEECH_LEVEL, register: PREVIOUS_REGISTER_COMPOSITION, format: true },
    ...(!styleMarker ? [{ current: false, anchors: LEGACY_CURRENT_ANCHORS, composites: legacyComposites,
      speech: PREVIOUS_SPEECH_LEVEL, register: PREVIOUS_REGISTER_COMPOSITION, format: false }] : []),
  ];
  const controls = body.slice(controlsAt + heading.length).replace(/\n$/, "");
  let selected: { axes: Config["axes"]; speech: Config["speech_level"]; safeword: string | null } | null = null;

  for (const producer of producers) {
    const axes = { ...AXIS_DEFAULT };
    let recognized = true;
    for (const [position, axis] of AXIS_ORDER.entries()) {
      const matches = producer.anchors[axis].map((anchor, index) => ({ anchor, level: index + 1 }))
        .filter(({ anchor }) => rules[position] === `- ${anchor}`);
      if (matches.length !== 1) {
        recognized = false;
        break;
      }
      axes[axis] = matches[0]!.level as Level;
    }
    if (!recognized || styleMarker && (
      Number(styleMarker[1]) !== axes.verbosity || Number(styleMarker[2]) !== axes.care
    )) continue;

    const speechLine = rules.at(-1);
    const speech = styleMarker && producer.speech.rough !== undefined && speechLine === `- ${producer.speech.rough}` ? "rough"
      : speechLine === `- ${producer.speech.polite}` ? "polite"
      : speechLine === `- ${producer.speech.plain}` ? "plain" : "auto";
    const speechRule = speech === "rough" ? producer.speech.rough : producer.speech[speech];
    const expectedRules = [
      ...AXIS_ORDER.map((axis) => `- ${producer.anchors[axis][axes[axis] - 1]}`),
      ...producer.composites(axes).map((line) => `- ${line}`),
      ...(producer.format ? [`- ${FORMAT_COMPOSITION}`] : []),
      ...(producer.register === null ? [] : [`- ${producer.register}`]),
      ...(speechRule == null ? [] : [`- ${speechRule}`]),
    ];
    if (rules.length !== expectedRules.length || !rules.every((line, index) => line === expectedRules[index])) continue;

    let remaining = historical && controls.startsWith(OLD_GUARD_BUNDLE)
      ? controls.slice(OLD_GUARD_BUNDLE.length) : controls;
    if (producer.current) {
      const prefix = `- ${CONTROLS.intensityConsent}\n`;
      if (!remaining.startsWith(prefix)) continue;
      remaining = remaining.slice(prefix.length);
      const confirmation = intensityConfirmation(axes);
      if (confirmation !== null) {
        const confirmationLine = `- ${confirmation}\n`;
        if (!remaining.startsWith(confirmationLine)) continue;
        remaining = remaining.slice(confirmationLine.length);
      }
    }
    const safeword = /^- Safeword: when the user's message contains "([^"\n]+)" or a near-identical rewording,\n/.exec(remaining)?.[1] ?? null;
    if (safeword !== null && safewordRejection(safeword, t) !== null) continue;
    const boundary = producer.current ? `- ${CONTROLS.intensityBoundary}\n` : "";
    const tail = `${historical ? `- ${OLD_EMERGENCY}\n` : ""}${boundary}- ${CONTROLS.fallback}`;
    const known = safeword === null ? [tail] : [
      `- ${CONTROLS.safeword(safeword)}\n${tail}`,
      ...(historical ? [`- ${oldSafeword(safeword)}\n${tail}`] : []),
    ];
    if (!known.includes(remaining)) continue;
    selected = { axes, speech, safeword };
    break;
  }
  if (selected === null) return null;
  config.axes = selected.axes;
  config.speech_level = selected.speech;
  config.safeword = selected.safeword;

  config.preset = marker[1] === "unsaved" ? null : marker[1]!;
  config.unsaved = marker[1] === "unsaved";
  const parsed = recoverSettings(JSON.stringify(config), t);
  if (parsed === null) return null;
  const absent = ["language", "unsaved", "active-history", ...unknown,
    ...(config.persona.user === null ? ["persona.user"] : []),
    ...(config.persona.agent === null ? ["persona.agent"] : []),
    ...(marker[1] === "unsaved" ? ["preset"] : [])];
  return {
    ...parsed,
    recovered: parsed.recovered.filter((field) => !absent.includes(field) &&
      !(field === "persona" && unknown.includes("persona.address"))),
    invalid: [...new Set([...parsed.invalid, ...absent])],
    defaulted: [...new Set([...(parsed.defaulted ?? []), ...absent])],
    metadataLost: true,
    legacy: null,
  };
}
