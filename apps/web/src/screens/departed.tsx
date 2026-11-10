// Repositories' departed repositories, said by how they went (design-system.md "Departed summary and No access", ADR
// 0082): each account gone in its No access notice, then the quiet ones, one alone or the summary. What each shows is
// the view model's (`departedShown`); every command is sent from here, with the ids the notice showed.
import type { Command, Connection } from "@lookover/contracts";
import { Button, IconButton, LinkButton, Notice, NoticeDisclosure } from "../ui/basics.tsx";
import { type Shown as Leaving, leavingProps, PresenceList } from "../ui/presence.tsx";
import { type AccountGone, DEPARTED, type departedShown } from "../view-model/departed.ts";
import { repositoryLabel } from "../view-model/format.ts";
import { departedNotice } from "../view-model/onboarding.ts";

type Shown = ReturnType<typeof departedShown>;
type Quiet = Extract<Shown["quiet"], { kind: "summary" }>;
type Send = (command: Command) => unknown;

/** Every departed repository's notice, above the bar and the table; nothing when none departed. */
export function DepartedNotices({
  shown,
  connection,
  send,
}: {
  shown: Shown;
  connection: Connection;
  send: Send;
}) {
  const { gone, quiet } = shown;
  const notices: OneNotice[] = [
    ...gone.map((g): OneNotice => ({ gone: g })),
    // One key for the quiet ones, alone or summed up: one turning into the other changes in place. An account's key
    // is namespaced, so an account called `quiet` is never taken for them.
    ...(quiet.kind === "none" ? [] : [{ quiet }]),
  ];
  // A dismissed notice leaves (ADR 0087); the place leaves with the last one, whole, as it last was.
  return (
    <PresenceList items={notices.length > 0 ? [notices] : []} keyOf={() => "departed"} exits>
      {(held, place) => (
        <div {...leavingProps("departed", place)}>
          <PresenceList items={held} keyOf={(n) => ("gone" in n ? `account:${n.gone.key}` : "quiet")} exits>
            {(n, leaving) => noticeOf(n, connection, send, leaving)}
          </PresenceList>
        </div>
      )}
    </PresenceList>
  );
}

/** One notice of the place: an account gone, or the quiet ones (one alone, or the summary). */
type OneNotice = { gone: AccountGone } | { quiet: Exclude<Shown["quiet"], { kind: "none" }> };

function noticeOf(n: OneNotice, connection: Connection, send: Send, shown: Leaving) {
  if ("gone" in n) {
    const g = n.gone;
    return (
      <NoAccess
        gone={g}
        ask={g.fix.command === undefined ? undefined : () => g.fix.command && send(g.fix.command)}
        dismiss={() => send({ type: "repos.dismiss", repoIds: g.repoIds })}
        shown={shown}
      />
    );
  }
  const { quiet } = n;
  return quiet.kind === "one" ? (
    <LeftOne
      name={repositoryLabel(quiet.repo)}
      {...departedNotice(connection, quiet.repo)}
      dismiss={() => send({ type: "repos.dismiss", repoIds: [quiet.repo.id] })}
      shown={shown}
    />
  ) : (
    <LeftSummaryNotice
      quiet={quiet}
      dismissAll={() => send({ type: "repos.dismiss", repoIds: quiet.repoIds })}
      dismiss={(repoId) => send({ type: "repos.dismiss", repoIds: [repoId] })}
      shown={shown}
    />
  );
}

/** An account the App no longer reaches: amber, though nothing waits, since it may be a loss the person didn't choose. */
function NoAccess({
  gone,
  ask,
  dismiss,
  shown,
}: {
  gone: AccountGone;
  ask: (() => void) | undefined;
  dismiss: () => void;
  shown: Leaving;
}) {
  return (
    <Notice
      label={gone.label}
      tone="warn"
      shown={shown}
      action={
        <span className="banner-acts">
          <LinkButton size="sm" href={gone.fix.href} {...(ask === undefined ? {} : { onClick: ask })}>
            {gone.fix.label}
          </LinkButton>
          <IconButton icon="close" label={DEPARTED.dismiss} onClick={dismiss} />
        </span>
      }
    >
      {gone.text}
    </Notice>
  );
}

/** One repository gone from an account still there: said as before, with Add it back. */
function LeftOne({
  name,
  label,
  text,
  addBack,
  dismiss,
  shown,
}: {
  name: string;
  label: string;
  text: string;
  addBack: string;
  dismiss: () => void;
  shown: Leaving;
}) {
  return (
    <Notice
      label={label}
      tone="mute"
      shown={shown}
      action={
        <span className="banner-acts">
          <LinkButton size="sm" href={addBack}>
            {DEPARTED.addBack}
          </LinkButton>
          <IconButton icon="close" label={DEPARTED.dismiss} onClick={dismiss} />
        </span>
      }
    >
      <b className="nowrap">{name}</b> {text}
    </Notice>
  );
}

/**
 * From two up, laid out as No access (round 6): its label over its sentence, flush on the text column, then at the
 * action edge its Show (Hide once open), named by the list it opens, beside its × named Dismiss all (`NoticeDisclosure`,
 * Tab following the screen, #643); the list under them on the text column, each line with its own quiet Dismiss at
 * the action edge. A line dismissed leaves as a notice does.
 */
function LeftSummaryNotice({
  quiet,
  dismissAll,
  dismiss,
  shown,
}: {
  quiet: Quiet;
  dismissAll: () => void;
  dismiss: (repoId: Quiet["repoIds"][number]) => void;
  shown: Leaving;
}) {
  return (
    <NoticeDisclosure
      label={DEPARTED.left}
      tone="mute"
      shown={shown}
      toggle={quiet.toggle}
      dismiss={{ label: DEPARTED.dismissAll, onClick: dismissAll }}
      below={
        <ul className="departed-list">
          <PresenceList items={quiet.lines} keyOf={(line) => line.id} exits>
            {(line, { leaving, mark }) => (
              <li className={leaving ? "leaving" : undefined} {...mark}>
                <span className="departed-name">{line.name}</span>
                <Button variant="quiet" size="sm" aria-label={line.dismiss} onClick={() => dismiss(line.id)}>
                  {DEPARTED.dismiss}
                </Button>
              </li>
            )}
          </PresenceList>
        </ul>
      }
    >
      {quiet.summary}
    </NoticeDisclosure>
  );
}
