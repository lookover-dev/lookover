---
title: Your plan's terms
description: Is Lookover allowed by Claude's and ChatGPT's terms? What Lookover does, what your plan's terms ask of you, and what to leave off.
---

Lookover only runs the official `claude` and `codex` programs, signed in through their own flows, on your machine, for your own pull requests. It never reads or stores your tokens. Your plan's terms apply: one subscription, one person, so each colleague runs their own. Lookover is not affiliated with Anthropic or OpenAI.

## What Lookover does

- **It runs the official programs, unmodified.** Each review is a session of the `claude` or `codex` CLI installed on your computer, as you would run it in your terminal. Lookover never calls the AI's servers itself.
- **You sign in through their own flows.** The setup opens the program's own sign-in. Lookover never reads, copies or stores your subscription's tokens, and has no sign-in of its own.
- **No API key.** Lookover gives the CLIs no API key, and Codex must be signed in with ChatGPT.
- **Sign Claude in with your subscription.** Lookover checks only that `claude` is signed in, not to which account. Signed in to an Anthropic Console account, its reviews are billed to that account's API usage.
- **It waits at your plan's limit.** It reviews one pull request at a time per AI. When an AI reaches its limit, Lookover sends it nothing until the limit resets, then the waiting reviews start by themselves.

## What your plan's terms ask of you

- **Personal use.** Your subscription, your repositories, your computer. Anthropic's limits for Pro and Max assume ordinary, individual use.
- **One subscription, one person.** Both forbid making your account available to anyone else. A team doesn't share one Lookover on one person's plan: each colleague runs their own, on their own plan.
- **In the EEA and Switzerland,** Anthropic's consumer terms add "non-commercial use only". Read them before you review work repositories on a personal plan.

The terms change. They, not this page, say what holds today:

- Anthropic: the [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and Claude Code's [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page.
- OpenAI: its [terms and policies](https://openai.com/policies/).

Either can act on an account it judges outside its terms.

## Leave paid extra usage off

A plan can go on past its limit at a cost: Claude's extra usage, ChatGPT's credits. Leave that off for the account Lookover reviews with.

Lookover never uses an API key, and waits for your plan's limit to reset rather than paying past it. But it can't see or stop what your plan itself is set to spend: with paid extra usage on, the CLI goes on, and the reviews draw on it.

## The names

Claude and ChatGPT are trademarks of their owners, Anthropic and OpenAI. Lookover is not affiliated with either.
