// The Logs page's file: each line's time in its own column, then its words; a pull request named once, as the head of
// its lines. Copied, a line reads as the file has it, a space between the time and the words.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LogFile } from "./basics.tsx";

/** The text a copy takes: the markup without its tags. */
const copied = (html: string) => html.replace(/<[^>]+>/g, "");

const line = { day: null };

test("a line's time is followed by a space, so a copied line keeps its words apart", () => {
  const html = renderToStaticMarkup(
    <LogFile
      runs={[
        {
          pr: null,
          day: true,
          lines: [
            { ...line, time: "08:52:00", words: "Lookover is up." },
            { ...line, day: "11-05", time: "08:52:01", words: "Reviewing." },
            { ...line, time: null, words: "  at main.ts:1" },
          ],
        },
      ]}
    />,
  );
  expect(copied(html)).toBe("08:52:00 Lookover is up.11-05 08:52:01 Reviewing.  at main.ts:1");
});

test("a run about a pull request opens on a head naming it once; a run about none has no head (ADR 0083, round 6)", () => {
  const html = renderToStaticMarkup(
    <LogFile
      runs={[
        {
          pr: null,
          day: false,
          lines: [{ ...line, time: "08:52:00", words: "self-test of claude 2.4.1: passed" }],
        },
        {
          pr: "o/r#1",
          day: false,
          lines: [
            { ...line, time: "08:52:01", words: "opened by sasensi" },
            { ...line, time: "08:52:02", words: "round 1 posted" },
          ],
        },
      ]}
    />,
  );
  expect(html).toContain(
    '<span class="run"><span class="line"><span class="when">08:52:00 </span>self-test of claude 2.4.1: passed</span></span>',
  );
  expect(html).toContain(
    '<span class="run"><span class="head">o/r#1</span><span class="line"><span class="when">08:52:01 </span>opened by sasensi</span>',
  );
  expect(html.match(/o\/r#1/g)).toHaveLength(1);
});

test("a run that says the day on any line holds the day's wider column for its head and every line, across midnight too", () => {
  const html = renderToStaticMarkup(
    <LogFile
      runs={[
        {
          pr: "o/r#1",
          day: true,
          lines: [
            { day: "11-07", time: "23:59:58", words: "round 1 started" },
            { ...line, time: "00:00:03", words: "round 1 posted" },
          ],
        },
      ]}
    />,
  );
  // The column is the run's, so the head and both lines' words start on one x.
  expect(html).toContain(
    '<span class="run day"><span class="head">o/r#1</span><span class="line"><span class="when">11-07 23:59:58 </span>round 1 started</span><span class="line"><span class="when">00:00:03 </span>round 1 posted</span></span>',
  );
});
