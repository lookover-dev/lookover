// Home: one sentence and one list. A section exists only when it has content.
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useApp, useAppState, useListScope } from "../store.tsx";
import { Button, Empty, Group, Icon, Search, Segmented } from "../ui/basics.tsx";
import { allReviews, matchesSearch } from "../view-model/filters.ts";
import { plural } from "../view-model/format.ts";
import {
  type ChangeReview,
  changeReviews,
  homeGroups,
  nothingReviewedYet,
  problems,
  sentence,
  status,
  statusLine,
} from "../view-model/select.ts";
import type { Filter } from "../view-model/status.ts";
import { Page, ReviewRow, ScopeTabs, Sentence } from "./common.tsx";

/** Rows that arrived after the page was opened rise in. */
function useFresh(ids: string[]): Set<string> {
  const firstSeen = useRef<Map<string, number> | null>(null);
  firstSeen.current ??= new Map(ids.map((id) => [id, 0]));
  const seen = firstSeen.current;
  const now = performance.now();
  for (const id of ids) if (!seen.has(id)) seen.set(id, now);
  // Fresh for as long as the animation runs.
  return new Set(ids.filter((id) => now - (seen.get(id) ?? 0) < 600));
}

export function Home() {
  const state = useAppState();
  const { openPalette } = useApp();
  const { scope } = useListScope();
  const [query, setQuery] = useState("");
  const g = homeGroups(state, scope);
  const s = sentence(state);
  const all = changeReviews(state);
  const fresh = useFresh(all.map((i) => i.change.id));
  const earlier = g.earlier.filter((i) => matchesSearch(i, query, statusLine(state, i)));
  // Problems are shown by the alert band above every page, not here.
  const calm = g.needs.length === 0 && problems(state).length === 0 && !state.service.paused;
  const list = (rows: ChangeReview[]) => (
    <div className="list">
      {rows.map((i) => (
        <ReviewRow key={i.change.id} item={i} fresh={fresh.has(i.change.id)} />
      ))}
    </div>
  );

  return (
    <Page screen="home">
      <Sentence
        title={s.title}
        small={s.small}
        still={calm}
        action={
          <Button icon="search" onClick={() => openPalette("review")}>
            Review a pull request…
          </Button>
        }
      />
      <ScopeTabs items={all} />
      {g.needs.length > 0 ? <Group title="Needs you">{list(g.needs)}</Group> : null}
      {g.running.length > 0 ? <Group title="Reviewing now">{list(g.running)}</Group> : null}
      {g.waiting.length > 0 ? <Group title="Waiting">{list(g.waiting)}</Group> : null}
      {g.earlier.length > 0 ? (
        <Group title="Earlier today">
          {g.earlier.length > 4 ? (
            <div className="list-search">
              <Search
                placeholder="Search today"
                aria-label="Search today's reviews"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                kbd="/"
              />
            </div>
          ) : null}
          {earlier.length > 0 ? (
            list(earlier)
          ) : (
            <p className="t-small">Nothing from today matches “{query}”.</p>
          )}
        </Group>
      ) : null}
      {g.notReviewed.length > 0 ? <Group title="Not reviewed">{list(g.notReviewed)}</Group> : null}
      {g.notReviewed.length === 0 && g.tab.every((i) => status(i).kind === "not-asked") ? (
        <Empty title="Nothing reviewed yet">{nothingReviewedYet(state.repos)}</Empty>
      ) : (
        <Link className="more-row" to="/reviews">
          <span>All reviews</span>
          <span className="t-small">{plural(g.tab.length, "pull request")}, every outcome</span>
          <Icon name="next" />
        </Link>
      )}
    </Page>
  );
}

export function AllReviews() {
  const state = useAppState();
  const { scope } = useListScope();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const all = changeReviews(state);
  const { options, rows } = allReviews(all, scope, filter, query, (i) => statusLine(state, i));
  return (
    <Page screen="reviews">
      <div className="crumb">
        <Link to="/">Reviews</Link> / <b>All reviews</b>
      </div>
      <Sentence title="All reviews." small="Every pull request Lookover has seen, with its outcome." />
      <ScopeTabs items={all} />
      <div className="filters">
        <Segmented label="Outcome" value={filter} options={options} onChange={setFilter} />
        <Search
          placeholder="Search"
          aria-label="Search all reviews"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          kbd="/"
        />
      </div>
      {rows.length > 0 ? (
        <div className="list">
          {rows.map((i) => (
            <ReviewRow key={i.change.id} item={i} />
          ))}
        </div>
      ) : (
        <Empty title="No pull request here">Nothing matches this filter.</Empty>
      )}
    </Page>
  );
}
