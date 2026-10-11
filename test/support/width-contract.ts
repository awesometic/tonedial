// The width contract's exemptions, in one place because two suites apply them.
//
// `ui.test.ts` measures every line every command emits; `doctor-context.test.ts` measures the
// lines of one command it drives directly. A rule about which lines are exempt that lives in two
// files is a rule that gets tightened in one of them.

/**
 * A line holding one whitespace-free token — a filesystem path — is exempt, and the exemption
 * is narrow on purpose. Folding a path makes it uncopyable, so those lines are left to the
 * terminal's own soft wrap. Anything the tool composed from words it chose has no such excuse.
 */
export const isUnbreakable = (line: string): boolean => line.trim().split(/\s+/).length === 1;

/**
 * A diff body line is exempt, and this is the one exemption that is about meaning rather than
 * mechanics. These lines are the bytes that will be written to someone else's file, and the
 * whole point of showing a diff is that what is displayed is what lands — folding or truncating
 * one would make the preview lie about the thing it exists to preview. They are left to the
 * terminal's own soft wrap, which alters nothing.
 */
export const isDiffBody = (line: string): boolean => /^ {2}[+\-] /.test(line) || /^ {4}/.test(line);
