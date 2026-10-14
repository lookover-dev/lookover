# Contributing to Lookover

Thanks for helping. Lookover is kept by one maintainer, so a short, focused change with its tests is the easiest to take. Bugs and ideas go in [issues](https://github.com/lookover-dev/lookover/issues/new/choose); security flaws go to [private reporting](SECURITY.md), never in an issue.

## Build and test

You need [Bun](https://bun.sh), `git`, and Edge or Chrome for the site's checks (Edge on Windows, Chrome elsewhere; `CHROME_PATH` names another). Nothing here needs `claude`, `codex`, a GitHub App or the network: the tests and demo mode run on fakes.

```sh
bun install           # installs the exact versions in bun.lock
bun run check         # types, Biome, import rules, knip, the tests, then the site built and checked
bun run build         # dist/lookover (dist/lookover.exe on Windows), the app inside, then checks it starts
bun dev               # the service in demo mode on scripted fakes; prints the address to open
```

`bun run check` must be green before a commit. A few rules it holds you to:

- Tests drive Lookover from the outside, through its ports, with the fakes of `packages/testkit`. Never a real AI, a real repository or a real secret.
- A test, a lint rule or an expected value is never weakened to make a change pass.
- Each package imports only what its `package.json` declares, under `"lookover"`.
- The app's colours, sizes and radii come from the design tokens in `apps/web/src/styles/system.css`.

## Commits

Commit messages and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/): `fix: …`, `feat: …`, `docs: …`, `test: …`, `ci: …`, `chore: …`, with `!` after the type for a breaking change. The next version is made from them.

## Before a large pull request

Open an issue first for anything bigger than a bug fix: a new setting, a command, a screen, a change to what Lookover posts. Say what you are trying to do; the maintainer answers whether it fits before you spend the time.

## What happens to your pull request

This repository holds the released code, one commit per release. Day-to-day work happens in a private repository, and each release is exported here. So your pull request is reviewed and tested here, but it isn't merged here: it is ported to the private repository and comes back with the next release.

The maintainer ports it like this:

1. Review the pull request here until its CI is green and it is approved.
2. In the private repository, on a new branch, apply its commits with their author kept:
   `curl -fsSL https://github.com/lookover-dev/lookover/pull/<number>.patch | git am`
   (if the trees have drifted, `git am -3`, then fix the conflicts). A change rewritten on the way keeps you as `Co-authored-by`.
3. Run every check there, open a pull request in the private repository, and merge it.
4. Comment here with a link to the release that will hold it, and close this pull request once that release is out.

Your commits keep your name in the private history, and the release's changelog lists your change with thanks.

## Conduct

Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).
