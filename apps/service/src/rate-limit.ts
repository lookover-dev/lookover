// GitHub asking to wait, told from any other refusal: one test, shared by the poller and the installation's listings,
// so both read a rate limit the same way (ADR 0043, ADR 0088).
import { HostError } from "@lookover/contracts";

/** Whether `error` is GitHub asking to wait (its rate limit). */
export const isRateLimit = (error: unknown): error is HostError =>
  error instanceof HostError && error.failure === "rate_limited";
