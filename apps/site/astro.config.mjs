// lookover.dev (ADR 0062, ADR 0064): the docs on Starlight under /docs/, the landing page a page of its own at /.
// The colours, type and spacing are the app's tokens (`@lookover/web/tokens.css`, imported by src/components/Head.astro); the fonts
// are served by the site itself, from the app's @fontsource packages: nothing is fetched from another host.

import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://lookover.dev",
  // `/docs/` and every page under it are folders with an index.html; a link without the slash opens them too.
  trailingSlash: "ignore",
  integrations: [
    starlight({
      title: "Lookover",
      description:
        "A second look before merge. Lookover reviews your GitHub pull requests with Claude and ChatGPT, on the subscriptions you already pay for.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/lookover-dev/lookover" }],
      // The theme switch: one round button, shared with the landing page (design-system.md, "The site").
      // Head adds the fonts, the tokens and site.css (see there why not `customCss`).
      components: {
        Head: "./src/components/Head.astro",
        Header: "./src/components/DocsHeader.astro",
        MarkdownContent: "./src/components/MarkdownContent.astro",
        ThemeSelect: "./src/components/ThemeSwitch.astro",
      },
      // Code blocks on the tokens: Starlight's Expressive Code takes them as plain CSS values.
      expressiveCode: {
        styleOverrides: {
          borderColor: "var(--line-2)",
          borderRadius: "var(--r-1)",
          codeBackground: "var(--line)",
          codeForeground: "var(--ink)",
          codeFontFamily: "var(--mono)",
          codeFontSize: "var(--t-13)",
          codeLineHeight: "1.6",
          uiFontFamily: "var(--body)",
          frames: {
            editorActiveTabBackground: "var(--code-bg)",
            editorTabBarBackground: "var(--surface)",
            terminalBackground: "var(--line)",
            terminalTitlebarBackground: "var(--surface)",
            terminalTitlebarBorderBottomColor: "var(--line)",
            terminalTitlebarForeground: "var(--muted)",
            frameBoxShadowCssValue: "none",
            inlineButtonForeground: "var(--muted)",
            inlineButtonBorder: "var(--line-2)",
            tooltipSuccessBackground: "var(--ok)",
            tooltipSuccessForeground: "var(--bg)",
          },
        },
      },
      // The eight pages of ADR 0062's D5, in the order a new user meets them; src/docs.test.ts holds the list to the files.
      sidebar: [
        { label: "Getting started", slug: "docs" },
        { label: "The setup", slug: "docs/setup" },
        { label: "Your coding agent", slug: "docs/coding-agent" },
        { label: "The commands", slug: "docs/commands" },
        { label: "Where your code goes", slug: "docs/security" },
        { label: "Your plan's terms", slug: "docs/terms" },
        { label: "Updating and removing", slug: "docs/updating" },
        { label: "What it doesn't do yet", slug: "docs/not-yet" },
      ],
    }),
  ],
});
