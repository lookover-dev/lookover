# Evaluation: the default depth

> Research note, written by `writeReport` from the answers committed in `apps/evals/recorded/` ([ADR 0050](../adr/0050-the-evaluation-harness.md)). The generated part is written again from them each time; the reading is the author's, kept.

<!-- reading:start: the author's reading, kept when the report is written again -->

## Reading

Not read yet.

<!-- reading:end -->

<!-- generated:start: written by writeReport from apps/evals/recorded/; edit the reading above, never this -->

## The run

Run on 2026-10-10: 2 cases (1 with a planted bug, 1 clean), 2 compared (every setup complete). One run: each setup reviewed each case once, so no difference smaller than the rule's margin (0.05 of F0.5) means anything.

Claude: version 2.1.283, model claude-opus-4-1. Codex: version 0.50.0, model gpt-5.5.

## The verdict

**No verdict: 2 cases compared, 13 needed.** ADR 0050: “Fewer than thirteen complete cases: no verdict, the missing sessions run again first.”

The rule read the kept findings over the 2 compared cases: F0.5 Quick 0.38, Standard cross-model 0.00, Deep 0.56; bugs found Standard cross-model 0, Deep 1; noise Standard cross-model 1, Deep 0.

Standard, one engine against cross-model decides nothing about the default: it says what an owner with one subscription gets.

## The setups

What each setup keeps: what its round would post at the default strictness, over the 2 compared cases, one run.

| Setup | Bugs found | Precision | F0.5 | Noise | Duplicates |
|---|---|---|---|---|---|
| Quick | 1 of 1, 100 % | 1 of 3, 33 % | 0.38 | 1 | 0 |
| Quick on Codex | 1 of 1, 100 % | 1 of 1, 100 % | 1.00 | 0 | 0 |
| Standard, one engine | 1 of 1, 100 % | 1 of 2, 50 % | 0.56 | 0 | 0 |
| Standard, cross-model | 0 of 1, 0 % | 0 of 2, 0 % | 0.00 | 1 | 0 |
| Deep | 1 of 1, 100 % | 1 of 2, 50 % | 0.56 | 0 | 0 |

With its hidden findings counted too:

| Setup | Bugs found | Precision | F0.5 | Noise | Duplicates |
|---|---|---|---|---|---|
| Quick | 1 of 1, 100 % | 1 of 3, 33 % | 0.38 | 1 | 0 |
| Quick on Codex | 1 of 1, 100 % | 1 of 1, 100 % | 1.00 | 0 | 0 |
| Standard, one engine | 1 of 1, 100 % | 1 of 2, 50 % | 0.56 | 0 | 0 |
| Standard, cross-model | 0 of 1, 0 % | 0 of 2, 0 % | 0.00 | 1 | 0 |
| Deep | 1 of 1, 100 % | 1 of 2, 50 % | 0.56 | 0 | 0 |

## Per case

| Case | Planted | Quick | Quick on Codex | Standard, one engine | Standard, cross-model | Deep |
|---|---|---|---|---|---|---|
| `replay-rename-total` | clean | 1 unmatched | nothing | nothing | 1 unmatched | nothing |
| `replay-sum-prices` | `src/prices.ts:3`: The loop starts at 1, so the first price is never added. | found, 1 unmatched | found | found, 1 unmatched | missed, 1 unmatched | found, 1 unmatched |

## The confirm

| Setup | Confirmer | Planted bugs it refuted (lost) | Unmatched candidates it refuted (gained) | Demoted |
|---|---|---|---|---|
| Standard, one engine | Claude | 0 | 1 | 0 |
| Standard, cross-model | Codex | 1 | 0 | 0 |
| Deep | Codex | 0 | 1 | 0 |

## Cost

| Setup | Sessions | Input tokens | Output tokens | Wall time |
|---|---|---|---|---|
| Quick | 2 | 30,000 | 1,250 | 2 min 44 s |
| Quick on Codex | 2 | 32,000 | 950 | 2 min 44 s |
| Standard, one engine | 4 | 48,000 | 1,850 | 5 min 28 s |
| Standard, cross-model | 4 | 48,000 | 1,850 | 5 min 28 s |
| Deep | 6 | 80,000 | 2,800 | 6 min 50 s |

## Findings on the bug

- `replay-sum-prices`, Quick: `src/prices.ts:3` sum() skips the first price
- `replay-sum-prices`, Quick on Codex: `src/prices.ts:3` The first price is left out of the sum
- `replay-sum-prices`, Standard, one engine: `src/prices.ts:3` sum() skips the first price
- `replay-sum-prices`, Deep: `src/prices.ts:3` sum() skips the first price

## Findings that matched nothing

- `replay-rename-total`, Quick: `app/total.py:2` total_cents() of no amounts is 0
- `replay-rename-total`, Standard, cross-model: `app/total.py:2` total_cents() of no amounts is 0
- `replay-sum-prices`, Quick: `src/prices.ts:8` average() of an empty list is NaN
- `replay-sum-prices`, Standard, one engine: `src/prices.ts:8` average() of an empty list is NaN
- `replay-sum-prices`, Standard, cross-model: `src/prices.ts:8` average() of an empty list is NaN
- `replay-sum-prices`, Deep: `src/prices.ts:8` average() of an empty list is NaN

<!-- generated:end -->
