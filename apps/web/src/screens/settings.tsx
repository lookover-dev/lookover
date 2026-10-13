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
import { AGENT_INTRO } from "../view-model/coding-agent.ts";
import { agoSentence, plural } from "../view-model/format.ts";
import { followLogs, logLinesShown } from "../view-model/logs.ts";
import {
  addRepositoryLink,
  appText,
  departedNotice,
  NEW_KEY_TEXT,
  repositoriesFoot,
} from "../view-model/onboarding.ts";
import { differences, lastReviewAt, openChangeCount } from "../view-model/select.ts";
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
import { startAtLoginHelp } from "../view-model/start-at-login.ts";
import { AgentRows } from "./coding-agent.tsx";
import { Page, Sentence, useSaving } from "./common.tsx";
import { AgentAppLine, UseAppForm } from "./github-app.tsx";

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
        <Card className="setcard">
          <div {...row("github")}>
            <SetRow
              title="Your App"
              help={appText(state.connection)}
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
              <th>Pull requests</th>
              <th>Reviewing</th>
            </tr>
          </thead>
          <tbody>
            {state.repos.map((r) => {
              const n = openChangeCount(state, r.id);
              const last = lastReviewAt(state, r.id);
              const d = differences(r).length;
              return (
                <tr key={r.id} onClick={() => navigate(`/repositories/${r.name}`)} className="clickable">
                  <td>
                    <Link to={`/repositories/${r.name}`} onClick={(e) => e.stopPropagation()}>
                      <b>{r.name}</b>
                    </Link>
                    {/* Quiet on purpose: differing from the defaults is the exception. */}
                    {d > 0 ? <div className="t-small">{plural(d, "setting")} of its own</div> : null}
                  </td>
                  <td>
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
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={r.enabled}
                      label={`Review ${r.name}`}
                      onChange={(enabled) => send({ type: "repo.setEnabled", repoId: r.id, enabled })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="foot">{repositoriesFoot(state.connection)}</div>
    </Page>
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
  const { label, text, addBack } = departedNotice(connection);
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
      <b className="nowrap">{repo.name}</b> {text}
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
  const { name } = useParams();
  const { stamp, save } = useSaving();
  const repo = state.repos.find((r) => r.name === name);
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
        <Link to="/repositories">Repositories</Link> / <b>{repo.name}</b>
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
