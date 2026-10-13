// Port: what time it is. Injected, so code that reads the time can be tested with a frozen clock (ADR 0033).

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}
