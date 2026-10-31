// Settings: your defaults, a short list, then more pages one click away.
// A repository's page shows the same settings; the few that differ from your defaults say so.
// Every change goes through the page's save stamp: "Saved" once the service took it (ADR 0049).
import {
  type Command,
  type Connection,
  type DepartedRepository,
  githubLinks,
  type Repository,
  type Rule,
  type SettingKey,
  type SettingValue,
} from "@lookover/contracts";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { MORE_SETTINGS } from "../shell.tsx";
import { useApp, useAppState, useSend, useTheme } from "../store.tsx";
import {
  Button,
  Card,
  Check,
  Code,
  Disclosure,
  Empty,
  Group,
  Icon,
  IconButton,
  LinkButton,
  Notice,
  Row,
  Said,
  SaveState,
  Segmented,
  SetRow,
  Switch,
} from "../ui/basics.tsx";
import { Select, Tip } from "../ui/layers.tsx";
import { type RepositoryGroupHead, repositoryGroups } from "../view-model/accounts.ts";
import { AGENT_INTRO } from "../view-model/coding-agent.ts";
import { agoSentence, plural } from "../view-model/format.ts";
import { followLogs, logLinesShown } from "../view-model/logs.ts";
import {
  addRepositoryLink,
  departedNotice,
  NEW_KEY_TEXT,
  repositoriesFoot,
} from "../view-model/onboarding.ts";
import { differences, lastReviewAt, openChangeCount, repositoryLabel } from "../view-model/select.ts";
import {
  pickOf,
  ruleSourceText,
  ruleSwitch,
  SETTING_KEYS,
  SETTING_TEXT,
  settingChange,
  settingValueText,
  WHEN_TEXT,
} from "../view-model/settings.ts";
import { GITHUB_SETTINGS_TEXT, type GitHubSettingsView, githubSettings } from "../view-model/sign-in.ts";
import { startAtLoginHelp } from "../view-model/start-at-login.ts";
import { AgentRows } from "./coding-agent.tsx";
import { HeldDetail, Page, Sentence, useSaving } from "./common.tsx";
import { AccountAction, AccountsList, AgentAppLine, CodeActions, UseAppForm } from "./github-app.tsx";

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

  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "center" });
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
          <SetRow title="Start at login" help={<Said words={startAtLoginHelp(state.service, mode)} />}>
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
      <Group title="GitHub">
        {github.way === "shared" ? (
          <SharedGitHub view={github} anchor={row("github")} />
        ) : (
          <>
            <Card className="setcard">
              <div {...row("github")}>
                <SetRow
                  title="Your App"
                  help={github.text}
                  extra={<AgentAppLine connection={state.connection} />}
                >
                  {state.connection.app ? (
                    <LinkButton
                      size="sm"
                      href={githubLinks.app(
                        state.connection.web,
                        state.connection.app.account,
                        state.connection.app.slug,
                      )}
                    >
                      Open on GitHub
                    </LinkButton>
                  ) : null}
                </SetRow>
              </div>
            </Card>
            <Disclosure summary="Use an existing App">
              <p>{NEW_KEY_TEXT}</p>
              <UseAppForm appId={state.connection.app?.id ?? null} />
            </Disclosure>
          </>
        )}
      </Group>
      <Group title="Your coding agent">
        <div {...row("agent")}>
          <p className="t-small">{AGENT_INTRO}</p>
          <AgentRows place="settings" />
        </div>
      </Group>
      <Group title="More settings">
        <div className="list">
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
 * Settings › GitHub on the shared App (ADR 0067): who is signed in, with Sign in again, and the code it gives in place,
 * also while connected (Cancel keeps the sign-in); the accounts list, setup's own; Use your own App, which replaces the
 * sign-in. `anchor`, the row Settings' links point at.
 */
function SharedGitHub({
  view,
  anchor,
}: {
  view: Extract<GitHubSettingsView, { way: "shared" }>;
  anchor: { id: string; "data-target": true | undefined };
}) {
  const send = useSend();
  const T = GITHUB_SETTINGS_TEXT;
  return (
    <>
      <Card className="setcard">
        {/* Setup's sign-in row, not a SetRow: its detail and actions nest spans a SetRow would restyle. */}
        <div {...anchor} className="signed-in-row">
          <div>
            <b>{T.title}</b>
            <div className="t-small sign-in-detail code-whole">
              <HeldDetail shown={view.signIn.text} details={view.signIn.held} />
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
      </Card>
      <Disclosure summary={T.own}>
        <p>{T.ownBody}</p>
        <UseAppForm appId={null} />
      </Disclosure>
    </>
  );
}

/** A rule's switch: its own, or held off with the rule it sits in, the tooltip saying so (ADR 0049). */
function RuleSwitch({ rule, save }: { rule: Rule; save: (command: Command) => void }) {
  const { checked, why } = ruleSwitch(rule);
  const control = (
    <Switch
      checked={checked}
      label={why === null ? rule.text : `${rule.text} ${why}`}
      disabled={why !== null}
      onChange={(enabled) => save({ type: "rule.setEnabled", ruleId: rule.id, enabled })}
    />
  );
  return why === null ? (
    control
  ) : (
    <Tip text={why} end>
      {control}
    </Tip>
  );
}

function SectionBody({ id, save }: { id: string; save: (command: Command) => void }) {
  const state = useAppState();
  switch (id) {
    case "rules":
      return (
        <>
          <p className="t-small">
            What the reviewer is asked to check, read from each repository's default branch. “Acted on” counts
            findings that were verified fixed.
          </p>
          <div className="tbl-wrap">
            <table className="tbl rules">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>From</th>
                  <th>Raised</th>
                  <th>Acted on</th>
                  <th>On</th>
                </tr>
              </thead>
              <tbody>
                {state.rules.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <b>{r.text}</b>
                    </td>
                    <td>
                      <span className="t-small">{ruleSourceText(state.repos, r)}</span>
                    </td>
                    <td className="num">{r.raised}×</td>
                    <td className="num">{r.acted}×</td>
                    <td>
                      <RuleSwitch rule={r} save={save} />
                    </td>
                  </tr>
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
      <Sentence
        title={`${entry?.title ?? "Settings"}.`}
        small={entry?.line}
        action={entry ? <SaveState {...stamp} /> : undefined}
      />
      <SectionBody id={section ?? ""} save={save} />
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
      <Code lines={logLinesShown(lines)} />
    </Page>
  );
}

export function Repositories() {
  const state = useAppState();
  const send = useSend();
  const navigate = useNavigate();
  // GitHub decides what the App sees: more repositories are granted in the installation's settings (ADR 0053).
  const add = addRepositoryLink(state.connection);
  return (
    <Page screen="repositories">
      <Sentence
        title="Repositories."
        small="Pull requests opened by you or your agents in these repositories are reviewed automatically."
        action={add ? <LinkButton href={add}>Add a repository</LinkButton> : null}
      />
      {state.departed.length > 0 ? (
        <div className="departed">
          {state.departed.map((repo) => (
            <Departed
              key={repo.id}
              repo={repo}
              connection={state.connection}
              dismiss={() => send({ type: "repo.dismiss", repoId: repo.id })}
            />
          ))}
        </div>
      ) : null}
      <div className="tbl-wrap">
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
          {repositoryGroups(state).map((group) => (
            <tbody key={group.key}>
              {group.head === null ? null : <GroupHead head={group.head} />}
              {group.repos.map((r) => {
                const n = openChangeCount(state, r.id);
                const last = lastReviewAt(state, r.id);
                const d = differences(r).length;
                return (
                  <tr
                    key={r.id}
                    onClick={() => navigate(`/repositories/${r.owner}/${r.name}`)}
                    className="clickable"
                  >
                    <td>
                      <Link to={`/repositories/${r.owner}/${r.name}`} onClick={(e) => e.stopPropagation()}>
                        <b>{repositoryLabel(r)}</b>
                      </Link>
                      {/* Quiet on purpose: differing from the defaults is the exception. */}
                      {d > 0 ? <div className="t-small">{plural(d, "setting")} of its own</div> : null}
                    </td>
                    <td className="repos-prs">
                      <span>
                        {r.enabled ? (
                          <>
                            {n === 0 ? "none open" : `${n} open`}
                            {last ? (
                              <span className="t-small"> · last review {agoSentence(state.now, last)}</span>
                            ) : null}
                          </>
                        ) : (
                          <span className="t-small">not reviewed</span>
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
              })}
            </tbody>
          ))}
        </table>
      </div>
      <div className="foot">{repositoriesFoot(state.connection)}</div>
    </Page>
  );
}

/**
 * A group of Repositories' head on the shared App (design-system.md "Repositories' group heads"): the account, in the
 * table's header style and the only text of the group's header cell, then its cause's line held at every line a cause
 * can say, and its one fix on the right, its place as wide as every fix the account can have, so a cause coming or
 * going moves nothing. The cause and the fix are said twice, one shown: beside the account on a wide screen, in a row
 * of their own under it on a phone, where the Pull requests column has no width.
 */
function GroupHead({ head }: { head: RepositoryGroupHead }) {
  const fix = (
    <span className="repos-group-fix" data-state={head.state}>
      <span className="t-small repos-group-cause">
        <HeldDetail shown={head.cause} details={head.held} />
      </span>
      <AccountAction link={head.fix} labels={head.labels} variant="secondary" />
    </span>
  );
  return (
    <>
      <tr className="repos-group">
        <th scope="rowgroup">{head.account}</th>
        <td colSpan={2} className="repos-group-wide">
          {fix}
        </td>
      </tr>
      <tr className="repos-group repos-group-narrow">
        <td colSpan={3}>{fix}</td>
      </tr>
    </>
  );
}

/** A repository that left the App's installation (ADR 0059): said until it is back or dismissed. */
function Departed({
  repo,
  connection,
  dismiss,
}: {
  repo: DepartedRepository;
  connection: Connection;
  dismiss: () => void;
}) {
  const { label, text, addBack } = departedNotice(connection, repo);
  return (
    <Notice
      label={label}
      tone="mute"
      action={
        <span className="banner-acts">
          {addBack ? (
            <LinkButton size="sm" href={addBack}>
              Add it back
            </LinkButton>
          ) : null}
          <IconButton icon="close" label="Dismiss" onClick={dismiss} />
        </span>
      }
    >
      <b className="nowrap">{repositoryLabel(repo)}</b> {text}
    </Notice>
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
  const n = openChangeCount(state, repo.id);
  const last = lastReviewAt(state, repo.id);
  const d = differences(repo).length;
  return (
    <Page screen="repository">
      <div className="crumb">
        <Link to="/repositories">Repositories</Link> / {repo.owner} / <b>{repo.name}</b>
      </div>
      <Sentence
        title={repo.id}
        small={
          repo.enabled
            ? `Reviewing · ${n === 0 ? "no open pull requests" : plural(n, "open pull request")}${last ? ` · last review ${agoSentence(state.now, last)}` : ""}`
            : "Off · pull requests here are not reviewed"
        }
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
        <p className="t-small repo-lede">
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
