// The loop (ADR 0029): one change's back-and-forth between the reviewer and its author, across rounds.
// `open`: findings are open, the author has work. `needs_owner`: a finding is escalated and only the owner can
// settle it. `settled`: nothing is open. Computed by `core`. There is no round cap: the author decides when
// to stop asking.
export type LoopState = "open" | "needs_owner" | "settled";
