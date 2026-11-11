// Settings: your defaults, a short list, then more pages one click away.
// A repository's page shows the same settings; the few that differ from your defaults say so.
// Every change goes through the page's save stamp: "Saved" once the service took it (ADR 0049).
import type { Command, Repository, Rule, SettingKey, SettingValue } from "@lookover/contracts";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { browserLanding, keepPlace, pageOf } from "../keep-place.ts";
import { MORE_SETTINGS } from "../shell.tsx";
import {
  useApp,
  useAppState,
  useCollapsedGroups,
  useHeld,
  useLeftSummary,
  useRepositoriesBar,
  useSend,
  useTheme,
} from "../store.tsx";
import {
  Button,
  Card,
  Check,
  Empty,
  Group,
  Icon,
  IconButton,
  LinkButton,
  LogFile,
  Row,
  Said,
  SaveState,
  Search,
  Segmented,
  SetRow,
  Switch,
} from "../ui/basics.tsx";
import { type Fold, foldMarks } from "../ui/fold.tsx";
import { Select } from "../ui/layers.tsx";
import { openChangeCount, pullRequestsCell, repositoryStanding } from "../view-model/accounts.ts";
import { AGENT_INTRO } from "../view-model/coding-agent.ts";
import { departedShown } from "../view-model/departed.ts";
import { plural, repositoryLabel, SEPARATOR } from "../view-model/format.ts";
import { followLogs, logRunsShown } from "../view-model/logs.ts";
import { addRepositoryLink, repositoriesFoot, repositoriesLook } from "../view-model/onboarding.ts";
import { REPOSITORIES_BAR, RepositoriesChoice, repositoriesList } from "../view-model/repositories.ts";
import { differences, lastReviewAt } from "../view-model/select.ts";
import {
  pickOf,
  RULES_INTRO,
  ruleSource,
  ruleSwitch,
  SETTING_KEYS,
  SETTING_TEXT,
  settingChange,
  settingValueText,
  WHEN_TEXT,
} from "../view-model/settings.ts";
import { GITHUB_SETTINGS_TEXT, type GitHubSettingsView, githubSettings } from "../view-model/sign-in.ts";
import { offersStartThisOne, START_THIS_ONE, startAtLoginHelp } from "../view-model/start-at-login.ts";
import { CodingAgent } from "./coding-agent.tsx";
import { Page, Sentence, useSaving } from "./common.tsx";
import { DepartedNotices } from "./departed.tsx";
import { AccountsList, CodeActions } from "./github-app.tsx";
import { LookLine } from "./look-line.tsx";
import { RepositoryGroupRows } from "./repository-group.tsx";

/** The control for one setting, used for your defaults and for a repository's own value. */
function SettingControl({
  k,
  value,
  onChange,
}: {
  k: SettingKey;
  value: SettingValue;
  onChange: (value: SettingValue) => void;
}) {
  const label = SETTING_TEXT[k].title;
  const pick = pickOf(k, value);
  if (pick !== null)
    return (
      <Select
        label={label}
        width={240}
        value={pick.choice.value}
        options={pick.choices}
        onChange={onChange}
      />
    );
  return <Switch checked={value === true} onChange={onChange} label={label} />;
}

/** The settings of your defaults picked from a list, in the order the page shows them. */
const DEFAULT_PICKS = ["strictness", "depth", "reviewers"] as const satisfies readonly SettingKey[];

export function Settings() {
  const state = useAppState();
  const { mode } = useApp();
  const { stamp, save } = useSaving();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const { hash } = useLocation();
  const s = state.settings;

  // Once the page has come in: measured while `page-in` still lifts it, the place would land 6 px off. Then kept
  // until the person acts (ADR 0091): another hash or the page left ends it here.
  useEffect(() => {
    if (!hash) return;
    let gone = false;
    let stop = () => {};
    const coming = document
      .getAnimations()
      .filter((a) => a instanceof CSSAnimation && a.animationName === "page-in")
      .map((a) => a.finished);
    void Promise.allSettled(coming).then(() => {
      if (gone) return;
      const place = () => document.getElementById(hash.slice(1));
      stop = keepPlace(place, browserLanding(pageOf(place())));
    });
    return () => {
      gone = true;
      stop();
    };
  }, [hash]);

  // Changes apply at once and say so quietly (the save stamp), not with a toast each time. A value that is
  // already the one shown sends nothing.
  const set = (key: SettingKey, value: SettingValue) => {
    const change = settingChange(null, key, s[key].value, value);
    if (change) save(change);
  };
  const row = (id: string) => ({ id, "data-target": hash === `#${id}` || undefined });
  const github = githubSettings(state);
  return (
    <Page screen="settings">
      <Sentence
        title="Your defaults."
        small="They apply to every repository. Changes save by themselves."
        action={<SaveState {...stamp} />}
      />
      <Card className="setcard">
        {DEFAULT_PICKS.map((k) => (
          <div key={k} {...row(k)}>
            <SetRow title={SETTING_TEXT[k].title} help={SETTING_TEXT[k].help}>
              <SettingControl k={k} value={s[k].value} onChange={(v) => set(k, v)} />
            </SetRow>
          </div>
        ))}
        <div {...row("when")}>
          <SetRow title="When to review" help={WHEN_TEXT}>
            <div className="stack">
              <Check checked={s.onOpen.value} onChange={(v) => set("onOpen", v)}>
                When a pull request is opened
              </Check>
              <Check checked={s.onPush.value} onChange={(v) => set("onPush", v)}>
                Again after every push
              </Check>
            </div>
          </SetRow>
        </div>
        <div {...row("login")}>
          {/* Another Lookover holds it (ADR 0068): its command in the help and, while on, the one way to take it on
              purpose. The switch sits level with the title at every width, so the help and action changing under
              it never move it. */}
          <SetRow
            atTitle
            title="Start at login"
            help={<Said words={startAtLoginHelp(state.service, mode)} />}
            extra={
              offersStartThisOne(state.service) ? (
                <div className="setrow-act">
                  <Button
                    size="sm"
                    onClick={() => save({ type: "service.startAtLogin", on: true, takeOver: true })}
                  >
                    {START_THIS_ONE}
                  </Button>
                </div>
              ) : null
            }
          >
            <Switch
              checked={state.service.startAtLogin}
              onChange={(on) => save({ type: "service.startAtLogin", on })}
              label="Start at login"
            />
          </SetRow>
        </div>
        <div {...row("appearance")}>
          <SetRow title="Appearance" help="Dark is the default. This is kept in this browser only.">
            <Segmented
              label="Theme"
              value={theme}
              onChange={setTheme}
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
                { value: "system", label: "System" },
              ]}
            />
          </SetRow>
        </div>
      </Card>
      <Group title="GitHub" landing>
        <GitHubGroup view={github} anchor={row("github")} />
      </Group>
      <Group title="Your coding agent" landing>
        <div {...row("agent")}>
          <p className="t-small t-help section-intro">{AGENT_INTRO}</p>
          <CodingAgent place="settings" />
        </div>
      </Group>
      <Group title="More settings">
        <div className="list more-settings">
          {MORE_SETTINGS.map((m) => (
            <Row
              key={m.id}
              title={m.title}
              meta={<span>{m.line}</span>}
              lead={null}
              action={<Icon name="next" />}
              onOpen={() => navigate(`/settings/${m.id}`)}
            />
          ))}
        </div>
      </Group>
    </Page>
  );
}

/**
 * Settings › GitHub (ADR 0067, ADR 0073): who is signed in, with Sign in again, and the code it gives in place, also
 * while connected (Cancel keeps the sign-in); the accounts list, setup's own. Nothing else: there is one way in.
 * `anchor`, the row Settings' links point at.
 */
function GitHubGroup({
  view,
  anchor,
}: {
  view: GitHubSettingsView;
  anchor: { id: string; "data-target": true | undefined };
}) {
  const send = useSend();
  const T = GITHUB_SETTINGS_TEXT;
  return (
    <Card className="setcard">
      {/* Setup's sign-in row, not a SetRow: its detail and actions nest spans a SetRow would restyle. */}
      <div {...anchor} className="signed-in-row">
        <div>
          <b>{T.title}</b>
          <div className="t-small t-help">
            <Said words={view.signIn.text} />
          </div>
        </div>
        <div className="sign-in-acts">
          <CodeActions
            code={view.signIn.code}
            onCancel={() => send({ type: "connection.cancelSignIn" })}
            idle={
              <Button size="sm" onClick={() => send({ type: "connection.signIn" })}>
                {T.again}
              </Button>
            }
          />
        </div>
      </div>
      {view.list.rows.length > 0 ? (
        <div className="setcard-accounts">
          <AccountsList list={view.list} />
        </div>
      ) : null}
      {view.look === null ? null : <LookLine look={view.look} />}
    </Card>
  );
}

/**
 * A rule's switch: its own, or held off with the rule it sits in (ADR 0049), the same off switch, disabled. Why is
 * said by `RuleTitle`, in words on the row, never in a tooltip over the row's values.
 */
export function RuleSwitch({ rule, save }: { rule: RuleView; save: (command: Command) => void }) {
  const { checked, why } = ruleSwitch(rule);
  return (
    <Switch
      checked={checked}
      label={why === null ? rule.text : `${rule.text} ${why}`}
      disabled={why !== null}
      onChange={(enabled) => save({ type: "rule.setEnabled", ruleId: rule.id, enabled })}
    />
  );
}

/** What a rule's row needs of it. */
type RuleView = Pick<Rule, "id" | "text" | "enabled" | "parentOff" | "nestedIn">;

/** A page's save stamp, as `useSaving` gives it. */
type SaveStamp = ReturnType<typeof useSaving>["stamp"];

/**
 * A rule's words, and under them, when its switch is held, why: only then, no room kept for it (ADR 0086), so the
 * line comes under the switch of the rule it sits in, which stays put.
 */
export function RuleTitle({ rule }: { rule: RuleView }) {
  const { why } = ruleSwitch(rule);
  return (
    <>
      <b>{rule.text}</b>
      {why === null ? null : <span className="rule-held">{why}</span>}
    </>
  );
}

/**
 * The line over the rules' table, under the title: the page's one description (round 6: the title's own line and
 * this one said it twice), and at its end, over the switches, the page's save stamp, by what it confirms rather than
 * alone by the title.
 */
export function RulesIntro({ stamp }: { stamp: SaveStamp }) {
  return (
    <div className="rules-intro">
      <p className="t-small t-help">{RULES_INTRO}</p>
      <SaveState {...stamp} />
    </div>
  );
}

/**
 * The rules table's heads: no name a word of another's, so the findings verified fixed (Verified fixed, never "Fixed"
 * alone, GLOSSARY.md) and whether the rule is checked (In use, its switch) can't be read for each other.
 */
export function RulesHead() {
  return (
    <thead>
      <tr>
        <th>Rule</th>
        <th>From</th>
        <th>Raised</th>
        <th>Verified fixed</th>
        <th>In use</th>
      </tr>
    </thead>
  );
}

/**
 * One rule's row: its words, where it is from, its counts and its switch. A rule nested in another is set in under
 * it (`.nested`), so its switch, held off with that rule, reads as that rule's.
 */
export function RuleRow({
  rule,
  source,
  save,
}: {
  rule: RuleView & Pick<Rule, "raised" | "acted">;
  source: ReturnType<typeof ruleSource>;
  save: (command: Command) => void;
}) {
  return (
    <tr>
      <td className={rule.nestedIn ? "rule nested" : "rule"}>
        <RuleTitle rule={rule} />
      </td>
      <td className="from">
        {source.repo === null ? null : <span className="t-small">{source.repo}</span>}
        <span className="t-small">{source.where}</span>
      </td>
      <td className="num">{rule.raised}×</td>
      <td className="num">{rule.acted}×</td>
      <td>
        <RuleSwitch rule={rule} save={save} />
      </td>
    </tr>
  );
}

function SectionBody({
  id,
  save,
  stamp,
}: {
  id: string;
  save: (command: Command) => void;
  stamp: SaveStamp;
}) {
  const state = useAppState();
  switch (id) {
    case "rules":
      return (
        <>
          <RulesIntro stamp={stamp} />
          <div className="tbl-wrap">
            <table className="tbl rules">
              <RulesHead />
              <tbody>
                {state.rules.map((r) => (
                  <RuleRow key={r.id} rule={r} source={ruleSource(state.repos, r)} save={save} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      );
    default:
      return <Empty title="No such page" />;
  }
}

export function SettingsSection() {
  const { section } = useParams();
  const entry = MORE_SETTINGS.find((m) => m.id === section);
  const { stamp, save } = useSaving();
  return (
    <Page screen={entry ? "settings-section" : undefined}>
      <div className="crumb">
        <Link to="/settings">Settings</Link> / <b>{entry?.title ?? section}</b>
      </div>
      <Sentence title={`${entry?.title ?? "Settings"}.`} />
      <SectionBody id={section ?? ""} save={save} stamp={stamp} />
    </Page>
  );
}

/** Whether the page is scrolled up from its end by more than a line or so. */
const awayFromBottom = () => window.scrollY + window.innerHeight < document.documentElement.scrollHeight - 32;

/**
 * Reached from the status pill: the service's log file, live (ADR 0055). Not a setting. Its list is the page's own,
 * never the store's: the file is not state.
 */
export function Logs() {
  const { store } = useApp();
  const [lines, setLines] = useState<string[]>([]);
  // Away from the bottom, the reader is reading: no line leaves the top under them (rule 5, "Nothing shifts").
  useEffect(() => followLogs(store.api, setLines, awayFromBottom), [store]);
  return (
    <Page screen="logs">
      <div className="crumb">
        <Link to="/">Reviews</Link> / <b>Logs</b>
      </div>
      <Sentence
        title="Logs."
        small="The log file's last lines, and each new one as it is written. Secrets removed."
      />
      <LogFile runs={logRunsShown(lines)} />
    </Page>
  );
}

export function Repositories() {
  // The bar's choice, its filter and search, lives as long as this visit of the page; whether it shows, the app's.
  const [choice] = useState(() => new RepositoriesChoice());
  return <RepositoriesOn choice={choice} />;
}

/**
 * Repositories on its bar's `choice` (design-system.md "Repositories' search and filter"): the notices, the search
 * and the filter once more than ten repositories are watched, then the groups they leave, or the empty line in the
 * table's place, so nothing above the table moves.
 */
export function RepositoriesOn({ choice }: { choice: RepositoriesChoice }) {
  const state = useAppState();
  const send = useSend();
  const { collapsed, toggle, remember } = useCollapsedGroups();
  const chosen = useHeld(choice);
  const barShown = useRepositoriesBar();
  const leftSummary = useLeftSummary();
  const list = repositoriesList(state, chosen, collapsed);
  // Each group's first fold, held the first time it shows: one growing past ten while watched never folds by itself.
  useEffect(() => remember(list.firstFolds), [remember, list.firstFolds]);
  // GitHub decides what the App sees: more repositories are granted in the installation's settings (ADR 0053).
  const add = addRepositoryLink(state.connection);
  const look = repositoriesLook(state);
  return (
    <Page screen="repositories">
      <Sentence
        title="Repositories."
        small="Pull requests opened by you or your agents in these repositories are reviewed automatically."
        action={
          add ? (
            <LinkButton href={add.href} onClick={() => add.command && send(add.command)}>
              {add.label}
            </LinkButton>
          ) : null
        }
      />
      <DepartedNotices shown={departedShown(state, leftSummary)} connection={state.connection} send={send} />
      {barShown ? (
        <div className="filters repos-bar">
          <Segmented
            label={REPOSITORIES_BAR.filterLabel}
            value={chosen.filter}
            options={list.options}
            onChange={(filter) => choice.filter(state, filter)}
          />
          <Search
            placeholder={REPOSITORIES_BAR.search}
            aria-label={REPOSITORIES_BAR.search}
            value={chosen.query}
            onChange={(e) => choice.search(state, e.target.value)}
            kbd="/"
          />
        </div>
      ) : null}
      {/* Nothing left: the empty line in the table's place, under everything above it. No sideways scroll wrapper: the
          table never is wider than the page, and its heads stick on the page's scroll. */}
      {list.empty ? (
        <Empty title={list.empty.title}>{list.empty.text}</Empty>
      ) : (
        <table className="tbl repos">
          <thead>
            <tr>
              <th>Repository</th>
              {/* On a phone the column keeps no width and its text isn't displayed (app.css). */}
              <th className="repos-prs">
                <span>Pull requests</span>
              </th>
              <th>Reviewing</th>
            </tr>
          </thead>
          {list.groups.map(({ group, collapsed }) => (
            <RepositoryGroupRows
              key={group.key}
              group={group}
              collapsed={collapsed}
              chosenBy={chosen.held}
              // While the search has text, a chevron collapses its group until the search changes.
              toggle={() =>
                list.searching ? choice.collapseInSearch(group.key) : toggle(group.key, collapsed)
              }
              send={send}
            >
              {group.repos.map((r) => (
                <RepositoryRow key={r.id} repo={r} />
              ))}
            </RepositoryGroupRows>
          ))}
        </table>
      )}
      {/* The page's end: who is signed in, then the look line (ADR 0088), so the person back from Add a repository
          sees Lookover look and what arrived; as tall as its words, it moves nothing above it. */}
      <div className="foot">
        <div>{repositoriesFoot(state.connection)}</div>
        {look === null ? null : <LookLine look={look} />}
      </div>
    </Page>
  );
}

/**
 * One repository's row: its name and its settings of its own, its pull requests, its switch, a group of one's
 * included (ADR 0083, round 4).
 */
function RepositoryRow({ repo: r, fold }: { repo: Repository; fold?: Fold }) {
  const state = useAppState();
  const send = useSend();
  const navigate = useNavigate();
  const cell = pullRequestsCell(
    { enabled: r.enabled, open: openChangeCount(state, r.id), lastAt: lastReviewAt(state, r.id) },
    state.now,
  );
  const d = differences(r).length;
  return (
    <tr
      onClick={() => navigate(`/repositories/${r.owner}/${r.name}`)}
      className={fold?.leaving ? "clickable fold-row leaving" : "clickable fold-row"}
      {...foldMarks(fold)}
    >
      <td>
        <Link
          to={`/repositories/${r.owner}/${r.name}`}
          // Read out of its group, the link still says whose: two accounts may each have an api.
          aria-label={repositoryLabel(r)}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Its group's head names the account: the owner would repeat on every row of it. */}
          <b>{r.name}</b>
        </Link>
        {/* Quiet on purpose: differing from the defaults is the exception. */}
        {d > 0 ? <div className="t-small">{plural(d, "setting")} of its own</div> : null}
      </td>
      <td className="repos-prs">
        <span>
          {cell.on ? (
            // The count, zero included: zero is data, muted so the few rows with an open pull request stand out.
            <>
              <span className={cell.zero ? "repos-open open-zero" : "repos-open"}>{cell.open}</span>
              {cell.last === null ? null : (
                <span className="t-small">
                  {SEPARATOR}
                  {cell.last}
                </span>
              )}
            </>
          ) : (
            <span className="t-small">{cell.text}</span>
          )}
        </span>
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        <Switch
          checked={r.enabled}
          label={`Review ${repositoryLabel(r)}`}
          onChange={(enabled) => send({ type: "repo.setEnabled", repoId: r.id, enabled })}
        />
      </td>
    </tr>
  );
}

/**
 * One setting on a repository's page. Every row works the same way: the control shows what applies here;
 * a row that differs from your default says so, says who decided, and has one way back. Choosing the value your
 * default gives is no override: the service keeps no value of its own for it (ADR 0049).
 */
function RepoSetting({
  repo,
  k,
  save,
}: {
  repo: Repository;
  k: SettingKey;
  save: (command: Command) => void;
}) {
  const setting = repo.settings[k];
  // What applies without the repository's own value: the owner's default, which it goes back to.
  const under = setting.origin === "owner-repository" ? setting.overrode : null;
  const set = (value: SettingValue) => {
    const change = settingChange(repo.id, k, setting.value, value);
    if (change) save(change);
  };
  const reset = () => save({ type: "repo.resetSetting", repoId: repo.id, key: k });

  // A setting that differs shows one thing: the way back, as an icon beside the control. Its tooltip says who
  // decided and where it goes back to. A setting that follows the default shows nothing, in the same room.
  return (
    <div className={`setrow repo-setting ${under ? "is-different" : ""}`}>
      <div>
        <b>{SETTING_TEXT[k].title}</b>
      </div>
      <div className="override">
        <span className="revert-slot">
          {under ? (
            <IconButton
              icon="revert"
              label={`Set by you, here. Use my default: ${settingValueText(k, under.value)}`}
              onClick={reset}
              end
            />
          ) : null}
        </span>
        <SettingControl k={k} value={setting.value} onChange={set} />
      </div>
    </div>
  );
}

export function RepositoryPage() {
  const state = useAppState();
  const { owner, name } = useParams();
  const { stamp, save } = useSaving();
  const repo = state.repos.find((r) => r.owner === owner && r.name === name);
  if (!repo) {
    return (
      <Page>
        <Empty title="No such repository">
          <Link to="/repositories">Back to repositories</Link>
        </Empty>
      </Page>
    );
  }
  const d = differences(repo).length;
  return (
    <Page screen="repository">
      <div className="crumb">
        <Link to="/repositories">Repositories</Link> / {repo.owner} / <b>{repo.name}</b>
      </div>
      <Sentence
        title={repo.id}
        small={repositoryStanding(
          {
            enabled: repo.enabled,
            open: openChangeCount(state, repo.id),
            lastAt: lastReviewAt(state, repo.id),
          },
          state.now,
        )}
        action={
          <>
            <SaveState {...stamp} />
            <Switch
              checked={repo.enabled}
              onChange={(enabled) => save({ type: "repo.setEnabled", repoId: repo.id, enabled })}
            >
              Reviewing
            </Switch>
          </>
        }
      />
      <Group title="Settings for this repository">
        <p className="t-small t-help repo-lede">
          {d === 0 ? "It follows " : `${plural(d, "setting differs", "settings differ")} from `}
          <Link to="/settings">your defaults</Link>. Change a setting here and it applies to {repo.name} only.
        </p>
        <Card className="setcard">
          {SETTING_KEYS.map((k) => (
            <RepoSetting key={k} repo={repo} k={k} save={save} />
          ))}
        </Card>
      </Group>
    </Page>
  );
}
