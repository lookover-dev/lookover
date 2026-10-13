// @lookover/retrieval: Lookover's copies of a repository (ADR 0033, ADR 0039).
// The decision it hides: how the change's code reaches the engine's working directory without the host's
// token ever reaching the disk. One bare mirror per repository (`<root>/mirrors/<owner>/<name>.git`, fetched
// again before every job: the refs the `FetchSpec` names in the host's own layout, pruned, no tags); one
// detached worktree per job at the change's head commit (`<root>/worktrees/<job>`); the diff from the merge
// base of the base commit and the head commit, as git prints it, rename-aware, `a/` and `b/` prefixes. Git
// runs through `process` (ADR 0012): the program by absolute path, no shell, the caller's environment minus
// every `GIT_*` variable (a hook's would point git elsewhere), never a terminal prompt. Every git command runs
// with the safe options (ADR 0056, SR-06) in its environment, above the user's own configuration and never
// written to any: hooks from `<root>/no-hooks`, an empty folder; links checked out as plain files; no
// fsmonitor; LFS's filter off; no submodule followed; no file protocol but in the fetch, where a local folder is a clone URL.
// The credentials: asked from the `FetchSpec` at fetch time, a username and a secret in the host's own form
// (retrieval knows no host's), sent as they are as a basic credential in git's `http.extraheader` through
// that one command's environment (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`: never on a
// command line, which any process can list), with credential helpers off for that command. The secret is
// never put in a URL, a config file, a remote, a logged line or an error (`log` and `RetrievalError.detail`
// have every form of it replaced by `<hidden>`), so no file in the mirror or the worktree holds it and a
// reviewed change cannot read it.
// Interface: `createRetrieval({ root, runner, git?, env, log? })` returns `prepare(request, signal?)`, which
// gives `{ cwd, diff, rules, mergeBase, diffFile, dispose }` (`cwd` and `diff` are contracts' `Prepared`, what
// `review` reads). `rules`: `REVIEW.md`, `AGENTS.md` and `CLAUDE.md`, in that order, as they stand at the root
// of the commit the `FetchSpec`'s default branch is at in the mirror after the fetch (ADR 0048), never the worktree's
// copies, which are the change's: the branch named in full (`refs/heads/<name>`, so no revision syntax in a name
// reaches git), each file's path, text and that commit. A missing file is left out; a link, a submodule, a folder or
// a file that isn't UTF-8 text (a byte that isn't, or a NUL) is left out and logged; a default branch the fetch
// didn't bring, or a git that fails reading them, gives no rules and a logged line: nothing about rules fails a
// prepare but a cancellation. `diffFile` is the whole diff saved as a file at the worktree's root, untracked, its
// path relative to `cwd`: a name of its own each time (`.lookover-change-<16 hex>.diff`), created only where nothing
// is, so a file or a link the change holds is never written through (a link to the service's database would be
// overwritten with its rights). It is for an engine shown only part of a long diff: it can read files but not run
// git, and the checkout has no removed line or deleted file. `dispose()` removes the worktree, the mirror stays. A
// worktree a crashed run left behind is replaced on the next prepare of the same job.
// Ordering: `prepare` makes the mirror if it is missing, asks the `FetchSpec` for credentials just before the
// fetch (never earlier, so a token is as fresh as it can be), fetches, checks both commits, reads the rules files,
// finds the merge base, then adds the worktree, reads the diff and saves it there; it stops at the first step that fails. Prepares
// of one repository run one at a time, in the order they were asked, whoever asks (two gits on one mirror race for
// its locks: the service runs a Claude review and a Codex review at once, ADR 0043); a failed one doesn't hold the
// next, and a signal fired while one waits cancels it before its first git. Prepares of two repositories run at once.
// Error modes: `prepare` and `dispose` throw `RetrievalError { problem, detail }` and nothing else, whatever
// failed (git, the disk or the host): `git_not_found` (no git, or it can't start), `mirror_failed` (the mirror
// or its folder can't be made), `fetch_failed` (git's fetch failed, or the `FetchSpec` gave no credentials: the
// host's refusal in `detail`, its `HostError` code first), `commit_not_found` (the head or base commit is not in
// the repository after the fetch), `worktree_failed` (added or removed), `diff_failed` (read or saved),
// `cancelled` (the signal fired; the running git was killed). `rules_unread` is never thrown: a rules file git
// couldn't read is only logged. A git that runs past its limit fails with its step's problem.
// It must never know: what runs in the worktree, the engines, any host's API, ref layout or credential form,
// the service, the UI.
export {
  createRetrieval,
  type Prepared,
  type PrepareRequest,
  type Retrieval,
  RetrievalError,
  type RetrievalOptions,
  type RetrievalProblem,
} from "./retrieval.ts";
