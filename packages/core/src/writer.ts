// Who wrote a change (ADR 0044): read from what the host shows, so the engine that didn't write it finds. The
// signals, oldest first: the branch prefix (`claude/`, `codex/`, set when the branch was made), then each commit's
// `Co-authored-by` trailers, as Claude Code and Codex sign their commits. The newest signal wins; none means unknown.
// A trailer names Claude when its address is Claude Code's (`noreply@anthropic.com`) or Claude's GitHub bot's, or
// its name has the word "Claude" with no address or an `anthropic.com` one; Codex the same way (a `codex` address at
// `openai.com`, its GitHub bot, or the word "Codex" with no address or an `openai.com` one). A person named Claude
// elsewhere, another co-author, or the words in a commit's body are no signal.
import type { EngineId } from "@lookover/contracts";

/** What the host shows of who wrote a change. */
export interface WriterFacts {
  /** The change's branch, as the host names it (`head.ref`). */
  branch: string;
  /** The full messages of the commits read now, oldest first: a change's own, or those a push brought. */
  messages: readonly string[];
  /** Who wrote the change as known before these commits (from older commits or the branch); null when unknown. */
  before: EngineId | null;
}

const TRAILER = /^co-authored-by:(.*)$/gim;
const BRANCH = /^(claude|codex)\//i;
const ENGINES = Object.values({ claude: "claude", codex: "codex" } as const satisfies Record<
  EngineId,
  EngineId
>);

/**
 * How each engine signs: the word in a co-author's name, the company's domain, its GitHub bot's no-reply address,
 * and the addresses that are the engine on their own, whatever the name.
 */
const SIGNS = {
  claude: {
    word: /\bclaude\b/i,
    domain: "@anthropic.com",
    bot: /\+claude\[bot\]@users\.noreply\.github\.com$/,
    alone: /^noreply@anthropic\.com$/,
  },
  codex: {
    word: /\bcodex\b/i,
    domain: "@openai.com",
    bot: /\+(chatgpt-codex-connector|codex)\[bot\]@users\.noreply\.github\.com$/,
    alone: /^codex[^@]*@openai\.com$/,
  },
} satisfies Record<EngineId, { word: RegExp; domain: string; bot: RegExp; alone: RegExp }>;

/**
 * The engine a trailer's value (`Name <address>`) names; null for anyone else. The name counts only with no
 * address, the company's or the engine's bot: "Claude Shannon <claude@example.com>" is a person.
 */
function namedIn(value: string): EngineId | null {
  const text = value.trim();
  const address = /<([^>]*)>/.exec(text)?.[1]?.trim().toLowerCase() ?? "";
  const name = text.replace(/<[^>]*>/, "");
  for (const engine of ENGINES) {
    const sign = SIGNS[engine];
    if (sign.alone.test(address) || sign.bot.test(address)) return engine;
    if ((address === "" || address.endsWith(sign.domain)) && sign.word.test(name)) return engine;
  }
  return null;
}

/** The engine a commit's last trailer naming one names; null when none does. */
function signedBy(message: string): EngineId | null {
  let last: EngineId | null = null;
  for (const [, value = ""] of message.matchAll(TRAILER)) last = namedIn(value) ?? last;
  return last;
}

/** Who wrote the change: the newest commit signed by an engine, else what was known before, else the branch. */
export function writerOf(facts: WriterFacts): EngineId | null {
  for (let i = facts.messages.length - 1; i >= 0; i--) {
    const engine = signedBy(facts.messages[i] ?? "");
    if (engine !== null) return engine;
  }
  if (facts.before !== null) return facts.before;
  const prefix = BRANCH.exec(facts.branch)?.[1]?.toLowerCase();
  return prefix === "claude" || prefix === "codex" ? prefix : null;
}
