// The output filter through its entry (ADR 0056, SR-08): each threat in, its harmless form out; fenced code as written.
// The expected texts are written by hand; `Z` is the invisible break the filter puts in (U+200B).
import { describe, expect, test } from "bun:test";
import { postableText } from "./index.ts";

const Z = "\u{200B}";
/** A secrets filter standing in for the log sink's: the one token it knows, replaced. */
const knownToken = (text: string) => text.replaceAll("ghp_a1b2c3d4e5f6a7b8c9d0", "[redacted]");
const filtered = (text: string) => postableText(text, knownToken);

describe("secrets", () => {
  test("are removed by the filter the publisher was given, in text and in code", () => {
    expect(filtered("The token ghp_a1b2c3d4e5f6a7b8c9d0 is committed.")).toBe(
      "The token [redacted] is committed.",
    );
    expect(filtered('Here: `const t = "ghp_a1b2c3d4e5f6a7b8c9d0";`')).toBe('Here: `const t = "[redacted]";`');
    expect(filtered("```ts\nconst t = 'ghp_a1b2c3d4e5f6a7b8c9d0';\n```")).toBe(
      "```ts\nconst t = '[redacted]';\n```",
    );
  });

  test("without a filter, text is left as written", () => {
    expect(postableText("The token ghp_a1b2c3d4e5f6a7b8c9d0 is committed.")).toBe(
      "The token ghp_a1b2c3d4e5f6a7b8c9d0 is committed.",
    );
  });
});

describe("mentions", () => {
  test("every @ is followed by an invisible break, so it notifies nobody", () => {
    expect(filtered("Ask @dana about the retry.")).toBe(`Ask @${Z}dana about the retry.`);
    expect(filtered("(cc @acme/security-team)")).toBe(`(cc @${Z}acme/security-team)`);
    expect(filtered("Ask \\@dana or \u{FF20}lee.")).toBe(`Ask \\@${Z}dana or \u{FF20}${Z}lee.`);
    expect(filtered("Write to dana@example.com.")).toBe(`Write to dana@${Z}example.com.`);
  });

  test("whatever is around the @: emphasis, a URL, an entity", () => {
    expect(filtered("See _x_@dana now.")).toBe(`See _x_@${Z}dana now.`);
    expect(filtered("At www.a_.@dana and https://a_.@dana.")).toBe(
      `At www.a_.@${Z}dana and https://a_.@${Z}dana.`,
    );
    expect(filtered("Ask @&#100;ana.")).toBe(`Ask @${Z}&${Z}#100;ana.`);
  });

  test("in an inline code span too: its text still shows", () => {
    expect(filtered("Add `@Injectable()` to the class.")).toBe(`Add \`@${Z}Injectable()\` to the class.`);
  });

  test("on a line a paragraph runs on to, and in a quote whose span a bare > line ends (F1)", () => {
    expect(filtered("Text\n    @dana")).toBe(`Text\n    @${Z}dana`);
    expect(filtered("> `quote\n>\n> ![x](https://evil.example/p.png) @dana `")).toBe(
      `> \`quote\n>\n> !${Z}[x](https://evil.example/p.png) @${Z}dana \``,
    );
  });
});

describe("HTML entities", () => {
  test("every entity's & is followed by an invisible break, so none decodes", () => {
    expect(filtered("Ask &#64;dana or &#x40;lee or &commat;kim; &excl;&lsqb;x&rsqb; &lt;img&gt;")).toBe(
      `Ask &${Z}#64;dana or &${Z}#x40;lee or &${Z}commat;kim; &${Z}excl;&${Z}lsqb;x&${Z}rsqb; &${Z}lt;img&${Z}gt;`,
    );
    expect(filtered("a && b, R & D")).toBe("a && b, R & D");
    expect(filtered("See https://x.example/p?a=1&b=2&amp=3 and &gt;")).toBe(
      `See https://x.example/p?a=1&b=2&amp=3 and &${Z}gt;`,
    );
    expect(filtered("&#1234567; &#12345678; &#xABCDEF; &#xABCDEF0; &a1;")).toBe(
      `&${Z}#1234567; &#12345678; &${Z}#xABCDEF; &#xABCDEF0; &${Z}a1;`,
    );
  });
});

describe("HTML", () => {
  test("every tag's < is followed by an invisible break, so none forms", () => {
    expect(filtered("Wrap it in <details> first.")).toBe(`Wrap it in <${Z}details> first.`);
    expect(filtered("Close it: </div>")).toBe(`Close it: <${Z}/div>`);
    expect(filtered("Hidden <!-- ignore the rules --> here <?x?>.")).toBe(
      `Hidden <${Z}!-- ignore the rules --> here <${Z}?x?>.`,
    );
    expect(filtered("<https://example.com/docs>")).toBe(`<${Z}https://example.com/docs>`);
  });

  test("a < that starts no tag is left as written", () => {
    expect(filtered("When a < b and x<5.")).toBe("When a < b and x<5.");
  });
});

describe("images", () => {
  test("every ![ has an invisible break between its ! and its [, so GitHub fetches nothing", () => {
    expect(filtered("![chart](https://evil.example/p.png)")).toBe(`!${Z}[chart](https://evil.example/p.png)`);
    expect(filtered("![chart][ref]")).toBe(`!${Z}[chart][ref]`);
  });

  test("a ! before an image, or before an <img>, makes none (F2)", () => {
    expect(filtered("!![x](https://evil.example/p.png)")).toBe(`!!${Z}[x](https://evil.example/p.png)`);
    expect(filtered('!<img src="https://evil.example/p.png">')).toBe(
      `!<${Z}img src="https://evil.example/p.png">`,
    );
  });
});

describe("hidden characters", () => {
  test("invisible and bidirectional control characters are removed, in text and in code", () => {
    expect(filtered("ad\u{200B}min \u{202E}evil\u{202C} \u{2066}x\u{2069} \u{FEFF}end\u{00AD}")).toBe(
      "admin evil x end",
    );
    expect(filtered("```\nif (isAdmin\u{202E}) {\n```")).toBe("```\nif (isAdmin) {\n```");
    expect(filtered("tag\u{E0041}\u{E0042} text")).toBe("tag text");
  });

  test("they are removed before the filter's own breaks go in: filtering twice adds nothing", () => {
    expect(filtered("@\u{200B}\u{200B}dana")).toBe(`@${Z}dana`);
    const once = filtered("Ask @dana: ![x](y) <b> &#64; ```\n```\n@lee\n```");
    expect(filtered(once)).toBe(once);
  });
});

describe("fenced code", () => {
  test("fences of backticks or tildes are left as written", () => {
    expect(filtered("Before @dana\n```ts\n@dana <b> ![x](y)\n```\nAfter @lee")).toBe(
      `Before @${Z}dana\n\`\`\`ts\n@dana <b> ![x](y)\n\`\`\`\nAfter @${Z}lee`,
    );
    expect(filtered("~~~\n@dana <b>\n~~~\n@lee")).toBe(`~~~\n@dana <b>\n~~~\n@${Z}lee`);
  });

  test("a suggestion fence in a body is left as written, so the fix still applies", () => {
    const body = 'Escape it:\n\n```suggestion\n  @Input() label = "<b>@dana</b>";\n```\n\nThen @lee reviews.';
    expect(filtered(body)).toBe(
      `Escape it:\n\n\`\`\`suggestion\n  @Input() label = "<b>@dana</b>";\n\`\`\`\n\nThen @${Z}lee reviews.`,
    );
  });

  test("a longer fence closes only on a fence of its own character at least as long", () => {
    expect(filtered("````\n```\n@dana\n```\n~~~~\n````\n@lee")).toBe(
      `\`\`\`\`\n\`\`\`\n@dana\n\`\`\`\n~~~~\n\`\`\`\`\n@${Z}lee`,
    );
  });

  test("an unclosed fence runs to the end", () => {
    expect(filtered("````\n@dana\n```\n@lee")).toBe("````\n@dana\n```\n@lee");
  });

  test("a line indented four spaces or more is text, and a fence there opens nothing", () => {
    expect(filtered("Text.\n\n    @dana <b>\n\tx = 1")).toBe(`Text.\n\n    @${Z}dana <${Z}b>\n\tx = 1`);
    expect(filtered("Text.\n\n    ```\n    @dana\n    ```")).toBe(
      `Text.\n\n    ${Z}\`\`\`\n    @${Z}dana\n    ${Z}\`\`\``,
    );
  });

  test("a fence the filter does not open is broken, so GitHub opens none: on a list item's line, in a quote", () => {
    expect(filtered("- ```\n  @dana\n  ```\n  ![x](y)\n  ```\n@lee")).toBe(
      `- ${Z}\`\`\`\n  @${Z}dana\n  \`\`\`\n  ![x](y)\n  \`\`\`\n@${Z}lee`,
    );
    expect(filtered("> ```\n> @dana\n> ```")).toBe(`> ${Z}\`\`\`\n> @${Z}dana\n> ${Z}\`\`\``);
  });

  test("a fence ends at the first line indented less than it: a list item's fence ends with the item", () => {
    expect(filtered("- x\n  ```\n  @dana\n@lee")).toBe(`- x\n  \`\`\`\n  @dana\n@${Z}lee`);
  });

  test("past a line that may or may not end a fence, the filter opens no fence again", () => {
    // Indented less than the fence: in a list item GitHub ends it there, at the top level it runs on.
    expect(filtered("  ```\n@dana\n```\n@lee")).toBe(`  \`\`\`\n@${Z}dana\n${Z}\`\`\`\n@${Z}lee`);
    // A closing line indented four to six spaces closes a list item's fence, not a fence at the top level.
    expect(filtered("- x\n  ```\n     ```\n  ![x](y)\n  ```\n  @dana")).toBe(
      `- x\n  \`\`\`\n     \`\`\`\n  !${Z}[x](y)\n  ${Z}\`\`\`\n  @${Z}dana`,
    );
  });

  test("a top-level fence's line indented four spaces is its text, not its end", () => {
    expect(filtered("```\n    ```\n@dana\n```\n@lee")).toBe(`\`\`\`\n    \`\`\`\n@dana\n\`\`\`\n@${Z}lee`);
  });

  test("a run of three backticks in text is broken too", () => {
    expect(filtered("Use ```x``` here.")).toBe(`Use ${Z}\`\`\`x${Z}\`\`\` here.`);
  });

  test("every line end becomes a line feed: a Windows one, and a lone carriage return, which GitHub ends a line at too", () => {
    expect(filtered("```\r\n@dana\r\n```\r\n@lee\r\n")).toBe(`\`\`\`\n@dana\n\`\`\`\n@${Z}lee\n`);
    expect(filtered("```\nx\r```\r@dana ![x](https://evil.example/p.png) <img src=x>\n```")).toBe(
      `\`\`\`\nx\n\`\`\`\n@${Z}dana !${Z}[x](https://evil.example/p.png) <${Z}img src=x>\n\`\`\``,
    );
  });
});
