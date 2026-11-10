// Home: one sentence and one list. A section exists only when it has content.
import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useApp, useAppState, useListScope } from "../store.tsx";
import { Button, Empty, Group, Icon, Search, Segmented } from "../ui/basics.tsx";
import { PresenceList, type Shown } from "../ui/presence.tsx";
import { allReviews, matchesSearch } from "../view-model/filters.ts";
import { plural } from "../view-model/format.ts";
import {
  type ChangeReview,
  type HomeGroups,
  homeGroups,
  listedReviews,
  nothingReviewedYet,
  problems,
  sentence,
  status,
  statusLine,
} from "../view-model/select.ts";
import type { Filter } from "../view-model/status.ts";
import { Page, ReviewRow, ScopeTabs, Sentence } from "./common.tsx";

/** Home's sections, in their order down the page. */
const ORDER = ["needs", "running", "waiting", "earlier", "notReviewed"] as const;
type SectionKey = (typeof ORDER)[number];

/** Each section's title: every group of `homeGroups` has one, and is in `ORDER`, or this fails to compile. */
const SECTIONS: Record<SectionKey, string> = {
  needs: "Needs you",
  running: "Reviewing now",
  waiting: "Waiting",
  earlier: "Earlier today",
  notReviewed: "Not reviewed",
} satisfies Record<Exclude<keyof HomeGroups, "tab">, string>;

interface Section {
  key: SectionKey;
  /** Its rows: in Earlier today, those the search keeps. */
  rows: ChangeReview[];
  /** Whether it shows its search (Earlier today, past four rows): as it last was, while it leaves whole. */
  searchable: boolean;
}

/**
 * What moves on Home (ADR 0087): only what the world changed. A row is new in a section it wasn't in at the last
 * render, and a row gone leaves through the presence, unless this render is the person's own (a search, a change of
 * scope: what they `asked` changed), where rows come and go with no motion. The page's first render has nothing new.
 */
function useMoves(sections: Section[], asked: readonly unknown[]) {
  const previous = useRef<{ asked: readonly unknown[]; rows: Map<SectionKey, Set<string>> } | null>(null);
  const before = previous.current;
  const world = before !== null && asked.every((v, i) => v === before.asked[i]);
  const rows = new Map(sections.map((s) => [s.key, new Set(s.rows.map((i) => String(i.change.id)))]));
  // What this render showed, once it is on the page: the next one is told against it.
  useLayoutEffect(() => {
    previous.current = { asked, rows };
  });
  return {
    exits: world,
    /** Whether the section `key` came with this render. */
    newSection: (key: SectionKey) => world && !(before?.rows.has(key) ?? false),
    /** Whether row `id` came to section `key` with this render. */
    newRow: (key: SectionKey, id: string) => world && !(before?.rows.get(key)?.has(id) ?? false),
  };
}

export function Home() {
  const state = useAppState();
  const { openPalette } = useApp();
  const { scope } = useListScope();
  const [query, setQuery] = useState("");
  const g = homeGroups(state, scope);
  const s = sentence(state);
  const all = listedReviews(state);
  const earlier = g.earlier.filter((i) => matchesSearch(i, query, statusLine(state, i)));
  // Problems are shown by the alert band above every page, not here.
  const calm = g.needs.length === 0 && problems(state).length === 0 && !state.service.paused;
  // A section is there while it has rows; Earlier today while it has any, whether its search keeps some or none.
  const sections: Section[] = ORDER.filter((key) => g[key].length > 0).map((key) =>
    key === "earlier"
      ? { key, rows: earlier, searchable: g.earlier.length > 4 }
      : { key, rows: g[key], searchable: false },
  );
  const moves = useMoves(sections, [scope, query]);
  // `leaving`: the whole list leaves with its last rows (Earlier today's search), each of them leaving as a row does.
  const list = (key: SectionKey, rows: ChangeReview[], leaving?: Shown) => (
    <div className="list" {...leaving?.mark}>
      <PresenceList items={rows} keyOf={(i) => i.change.id} exits={moves.exits}>
        {(i, shown) => (
          <ReviewRow item={i} fresh={moves.newRow(key, String(i.change.id))} shown={leaving ?? shown} />
        )}
      </PresenceList>
    </div>
  );
  const body = ({ key, rows, searchable }: Section) =>
    key === "earlier" ? (
      <>
        {searchable ? (
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
        {/* Its list is kept while the world takes the search's last match away, so that row leaves as any does; what
            says nothing matches comes once it has gone (a search of the person's own drops the rows at once). */}
        <PresenceList
          items={rows.length > 0 ? [rows] : []}
          keyOf={() => "list"}
          exits={moves.exits}
          empty={<p className="t-small">Nothing from today matches “{query}”.</p>}
        >
          {(last, shown) => list(key, last, shown.leaving ? shown : undefined)}
        </PresenceList>
      </>
    ) : (
      list(key, rows)
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
      {/* A section leaves with its last row, as it last was; one that comes with a row fades in. */}
      <PresenceList items={sections} keyOf={(section) => section.key} exits={moves.exits}>
        {(section, shown) => (
          <Group title={SECTIONS[section.key]} fresh={moves.newSection(section.key)} shown={shown}>
            {body(section)}
          </Group>
        )}
      </PresenceList>
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
  const all = listedReviews(state);
  const { options, rows } = allReviews(all, scope, filter, query, (i) => statusLine(state, i));
  return (
    <Page screen="reviews">
      <div className="crumb">
        <Link to="/">Reviews</Link> / <b>All reviews</b>
      </div>
      <Sentence
        title="All reviews."
        small="Every pull request in the repositories that are on, with its outcome."
      />
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
