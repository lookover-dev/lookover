// Port: new IDs. Injected, so code that makes IDs can be tested with seeded ones (ADR 0033).
// It makes plain strings; the caller brands one as the ID it needs (`jobId(ids.next())`).

export interface IdGen {
  /** An ID never given before by this generator. */
  next(): string;
}
