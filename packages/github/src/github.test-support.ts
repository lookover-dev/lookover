// What the adapter's tests share: GitHub's API stubbed as a list of routes, and a route answering one token only.
// Imported by tests only.

export type Call = {
  method: string;
  path: string;
  body: unknown;
  authorization: string;
  /** The ETag the request was sent with, if any. */
  ifNoneMatch: string | null;
  /** The address's origin: where the request went. */
  origin: string;
};
type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
export type Route = (call: Call) => Answer | undefined;

/** GitHub's API as a list of routes: the first that answers wins. Records every call it got. */
export function stubGitHub(...routes: Route[]) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init.headers);
    const call = {
      method: init.method ?? "GET",
      path: url.pathname + url.search,
      body,
      authorization: headers.get("authorization") ?? "",
      ifNoneMatch: headers.get("if-none-match"),
      origin: url.origin,
    };
    calls.push(call);
    const answer = routes.map((r) => r(call)).find((a) => a !== undefined) ?? {
      status: 404,
      body: { message: "Not Found" },
    };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json", ...answer.headers },
    });
  };
  return { fetch, calls };
}

export const AT = Date.UTC(2026, 9, 6, 12, 0, 0);

/** A route that answers only to its token: with another one, the stub falls through to its 404. */
export const withToken =
  (token: string, route: Route): Route =>
  (call) =>
    call.authorization === `Bearer ${token}` ? route(call) : undefined;

/**
 * The waits a client takes, fake: each pause and each time limit asked is recorded, nothing is slept. `expire` runs
 * out every time limit not yet cleared, its signal aborted as Bun aborts on a timeout; `open` counts those left.
 */
export function fakeWaits() {
  const sleeps: number[] = [];
  const limits: number[] = [];
  const running = new Set<AbortController>();
  return {
    sleeps,
    limits,
    open: () => running.size,
    expire: () => {
      for (const controller of running)
        controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    },
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    deadline: (ms: number) => {
      limits.push(ms);
      const controller = new AbortController();
      running.add(controller);
      return { signal: controller.signal, clear: () => void running.delete(controller) };
    },
  };
}

/** No waits at all: for a test whose failures go through the retries but which doesn't look at them. */
export const noWaits = () => {
  const { sleep, deadline } = fakeWaits();
  return { sleep, deadline };
};

/**
 * What a try meets before GitHub answers it: an error thrown as Bun's `fetch` throws it, with its `code` (or, with
 * `cause`, its cause's), an answer of that status, no answer at all until the try's time limit runs out (`hang`), or
 * an answer whose body never ends until then (`hang-body`).
 */
export type Failure = { code: string; cause?: boolean } | { status: number } | "hang" | "hang-body";

/** Which requests meet the failures: those for which it says true. */
export type FailsOn = (input: string, init: RequestInit) => boolean;

/**
 * `fetch` meeting `failures` first, in order, one a request, on the requests `which` picks (every one by default),
 * then answering as `fetch` does. A hanging try runs `waits`' time limits out once it waits on its signal. `sent`
 * records every try, failed or not, as its method and path.
 */
export function failing(
  fetch: (input: string, init: RequestInit) => Promise<Response>,
  waits: ReturnType<typeof fakeWaits>,
  failures: Failure[],
  which: FailsOn = () => true,
) {
  const left = [...failures];
  const sent: string[] = [];
  const failingFetch = (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    sent.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
    const failure = which(input, init) ? left.shift() : undefined;
    if (failure === undefined) return fetch(input, init);
    const signal = init.signal ?? new AbortController().signal;
    if (failure === "hang")
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
        waits.expire();
      });
    if (failure === "hang-body") {
      const body = new ReadableStream(
        {
          start: (controller) => signal.addEventListener("abort", () => controller.error(signal.reason)),
          pull: () => {
            waits.expire();
            return new Promise<void>(() => {});
          },
        },
        { highWaterMark: 0 },
      );
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    if ("status" in failure)
      return Promise.resolve(
        new Response(JSON.stringify({ message: "Server Error" }), { status: failure.status }),
      );
    const coded = Object.assign(new Error(`${failure.code}: the connection failed`), { code: failure.code });
    return Promise.reject(
      failure.cause ? Object.assign(new TypeError("fetch failed"), { cause: coded }) : coded,
    );
  };
  return { fetch: failingFetch, sent };
}
