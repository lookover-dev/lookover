// The loop's skill (ADR 0058), `skill/SKILL.md`, as text: the template Lookover renders into the coding agents'
// folders. Imported as text, so `bun build --compile` carries it inside the binary. Its spots are `{{lookover}}`
// (Lookover's command) and `{{powershell}}` (the same line as PowerShell runs it), and its first HTML comment after
// the front matter says so for a reader of this repository: the renderer (the service's `skill.ts`) puts its stamp
// there. Read with LF line ends whatever the checkout wrote: the renderer finds that comment by them.
import template from "../skill/SKILL.md" with { type: "text" };

/** The template's text from a file's: its line ends LF, as a checkout with CRLF ones (Windows' Git) would not be. */
export const skillTemplateOf = (text: string): string => text.replaceAll("\r\n", "\n");

/** `skill/SKILL.md`, as written in this repository, its line ends LF. */
export const SKILL_TEMPLATE: string = skillTemplateOf(template);
