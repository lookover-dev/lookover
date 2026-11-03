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
