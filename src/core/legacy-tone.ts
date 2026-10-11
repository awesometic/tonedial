// Decode known current and historical English artifact bodies. Unknown prose is never a data source.
import {
  ANCHORS, AXIS_ORDER, CONTROLS, PERSONA, REGISTER_COMPOSITION, SCOPE_HEADER, SPEECH_LEVEL, type Axis, type Level,
} from "./anchors.ts";
import {
  AGE_BANDS, GENDERS, defaultConfig, recoverSettings, safewordRejection,
  type Config, type SettingsRecovery,
} from "./config.ts";
import { composites } from "./combos.ts";
import type { Messages } from "./i18n.ts";

// Historical producer text is decoder evidence only, never a current tone instruction.
const OLD_ANCHORS: Record<Axis, readonly string[]> = {
  ...ANCHORS,
  formality: [
    "Use the most casual register the language offers, including slang.",
    "Mix casual and polite forms.",
    "Use the standard polite register.",
    "Use the formal register, mixing in deferential forms.",
    "Use the most formal register consistently.",
  ],
  warmth: [...ANCHORS.warmth.slice(0, 2), "Express feeling at a courteous level.", ...ANCHORS.warmth.slice(3)],
  profanity: [...ANCHORS.profanity.slice(0, 4),
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
  if (!rest.startsWith(notePrefix)) {
    const newline = rest.indexOf("\n");
    const line = newline === -1 ? rest : rest.slice(0, newline);
    rest = newline === -1 ? "" : rest.slice(newline + 1);
    if (!line.startsWith("- ")) return null;
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
    if (line === "- ") return null;
  }
  if (rest !== "") {
    if (!rest.startsWith(notePrefix)) return null;
    const note = rest.slice(notePrefix.length);
    if (note === "" || note.includes("\n") || note.trim() !== note) return null;
    config.persona.note = note;
  }
  return unknown;
}

export function recoverLegacyTone(text: string, t: Messages): SettingsRecovery | null {
  const source = text.replace(/\r\n/g, "\n");
  if (source.includes("\r")) return null;
  const marker = /^<!-- generated by tonedial · preset: ([a-z0-9]+(?:-[a-z0-9]+)*) -->\n/.exec(source);
  if (marker === null) return null;
  const prefix = `${marker[0]}${SCOPE_HEADER}\n`;
  if (!source.startsWith(prefix)) return null;
  let body = source.slice(prefix.length);
  const config = defaultConfig();
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
  const anchors = historical ? OLD_ANCHORS : ANCHORS;
  const speechLevels = historical ? OLD_SPEECH_LEVEL : SPEECH_LEVEL;
  for (const [position, axis] of AXIS_ORDER.entries()) {
    const matches = anchors[axis].map((anchor, index) => ({ anchor, level: index + 1 }))
      .filter(({ anchor }) => rules[position] === `- ${anchor}`);
    if (matches.length !== 1) return null;
    config.axes[axis] = matches[0]!.level as Level;
  }
  const speech = rules.at(-1);
  config.speech_level = speech === `- ${speechLevels.polite}` ? "polite"
    : speech === `- ${speechLevels.plain}` ? "plain" : "auto";
  const expectedRules = [
    ...AXIS_ORDER.map((axis) => `- ${anchors[axis][config.axes[axis] - 1]}`),
    ...(historical ? [
      ...(config.axes.warmth >= 4 && config.axes.profanity >= 4
        ? ["Keep the swearing affectionate and aimed at the situation only."] : []),
      ...(config.axes.compliance <= 2 && config.axes.conviction <= 2
        ? ["Grumble without being passive; make the complaint itself clear."] : []),
    ] : composites(config.axes)).map((line) => `- ${line}`),
    ...(historical ? [] : [`- ${REGISTER_COMPOSITION}`]),
    ...(speechLevels[config.speech_level] === null ? [] : [`- ${speechLevels[config.speech_level]}`]),
  ];
  if (rules.length !== expectedRules.length || rules.some((line, index) => line !== expectedRules[index])) return null;

  const controls = body.slice(controlsAt + heading.length).replace(/\n$/, "");
  const remaining = historical && controls.startsWith(OLD_GUARD_BUNDLE)
    ? controls.slice(OLD_GUARD_BUNDLE.length) : controls;
  const safeword = /^- Safeword: when the user's message contains "([^"\n]+)" or a near-identical rewording,\n/.exec(remaining);
  config.safeword = safeword?.[1] ?? null;
  if (config.safeword !== null && safewordRejection(config.safeword, t) !== null) return null;
  const tail = `${historical ? `- ${OLD_EMERGENCY}\n` : ""}- ${CONTROLS.fallback}`;
  const known = config.safeword === null ? [tail] : [
    `- ${CONTROLS.safeword(config.safeword)}\n${tail}`,
    ...(historical ? [`- ${oldSafeword(config.safeword)}\n${tail}`] : []),
  ];
  if (!known.includes(remaining)) return null;

  config.preset = marker[1] === "unsaved" ? null : marker[1]!;
  config.unsaved = marker[1] === "unsaved";
  const parsed = recoverSettings(JSON.stringify(config), t);
  if (parsed === null) return null;
  const absent = ["language", "unsaved", "active-history", ...unknown,
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
