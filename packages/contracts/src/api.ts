import type { Command } from "./command.ts";
import type { Event } from "./event.ts";
import type { State } from "./state.ts";

/**
 * The service boundary. The UI knows only this: a snapshot, a stream of events to apply to it,
 * and commands. The service implements it over HTTP, in live mode and in demo mode alike (ADR 0046).
 * Beside the state, the log file (ADR 0055), which is a file and not state (ADR 0054): `logs` reads its last 200
 * lines (today's file, topped up from yesterday's when today's is short), each as the file keeps it, its stamp
 * first, its secrets removed; `subscribeLogs` hears each new line as the service writes it, never numbered, stored,
 * replayed nor applied, and hears `connected` each time the stream it travels on opens, since a line written while
 * it was closed is never sent again: the tail is read again then.
 */
export interface LookoverApi {
  snapshot(): Promise<State>;
  subscribe(listener: (event: Event) => void): () => void;
  send(command: Command): Promise<void>;
  logs(): Promise<string[]>;
  subscribeLogs(listener: (message: LogMessage) => void): () => void;
}

/** What `subscribeLogs` hears: a line the log file gained, or the stream opened again (read the tail). */
export type LogMessage = { type: "line"; line: string } | { type: "connected" };

/**
 * Where `LookoverApi` is over HTTP (ADR 0010, ADR 0028, ADR 0038), on the app's own origin: the service and
 * its client both read the names here, so neither can drift. `session` takes the one-time token (`?token=`)
 * and answers with the cookie; `events` is a server-sent event stream whose event ids are the sequence
 * numbers, and takes the last number seen in `Last-Event-ID` or in the `after` query parameter. `logs` answers
 * `LookoverApi.logs` as a JSON array of lines (ADR 0055), empty when the service writes no log file.
 * Beside `LookoverApi`, for the `lookover` commands (ADR 0054), under the same checks: `link` (POST) mints a one-time
 * link to open the app with, answered as a `MintedLink`; `stop` (POST) answers, then stops the service as Ctrl+C does.
 */
export const API = {
  prefix: "/api/v1",
  session: "/api/v1/session",
  snapshot: "/api/v1/snapshot",
  events: "/api/v1/events",
  commands: "/api/v1/commands",
  link: "/api/v1/link",
  stop: "/api/v1/stop",
  logs: "/api/v1/logs",
  after: "after",
} as const;

/**
 * What every session-checked route answers without the session, with status 401 (ADR 0058). `open`: the command line
 * that opens Lookover (Lookover's command, then `open`), for the screen to name; absent in development (`bun dev`,
 * `bun dev --live`), where the screen names the link `bun dev` printed.
 */
export interface NoSession {
  error: "no session";
  open?: string;
}

/** What `API.link` answers: the URL that opens the app once, within two minutes (ADR 0054). */
export interface MintedLink {
  url: string;
}

/**
 * The manifest flow's pages on the service (ADR 0053), named once for the service and the web app. `manifest`: the
 * page "Create it on GitHub" opens in a new tab (session-checked), which opens a flow and posts the manifest to
 * GitHub with its state; it is also "Open GitHub again" while no App is kept. `callback`: where GitHub's redirect
 * brings the code back (no session, no same-site check: the flow's state alone, its query never logged).
 * `installed`: the install's `setup_url`, a page in Lookover's look with Back to setup (ADR 0058) that trusts nothing
 * it is given.
 */
export const APP_FLOW = {
  manifest: "/api/v1/github/new",
  callback: "/api/v1/github/callback",
  installed: "/api/v1/github/installed",
} as const;

/**
 * The names on the event stream: `event` carries an `Event` as JSON; `reload` says to fetch the snapshot
 * again; `keepalive` says a quiet stream is still alive (a comment wouldn't reach the browser's `EventSource`),
 * so a client can tell a dead connection, which a proxy or a sleeping laptop keeps open, from a quiet one;
 * `log` carries a line the log file gained as `{ line }` (ADR 0055), with no id: it is no event, and never replayed.
 */
export const SSE = { event: "event", reload: "reload", keepalive: "keepalive", log: "log" } as const;
