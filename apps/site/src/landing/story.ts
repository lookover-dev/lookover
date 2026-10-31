// The three-sided story: one pull request between the coding agent's terminal, GitHub and Lookover's own screen, a
// 1280 × 712 stage that `three-sides.js` plays and `three-sides.css` draws. Built here as markup, at build time, so
// the page has it without a script; drawn in its last frame until the script takes it to its first (with no
// reduced-motion preference). Every part the script moves is named by a `ts-` class or a `data-` hook.
//
// The story is the demo's S2 scenario, shortened: ledger-api, pull request #148, "Add rate limiting to
// /v1/invoices", the commits a1f9c2e and b2c3d4e, one finding found by Codex and double-checked by Claude, verified
// fixed in round 2. Its words are the ones Lookover says: the review and the summary as `publish` writes them, each
// opening with "Lookover ·", posted as the person signed in to the shared App (ADR 0065), the badge on the summary
// alone, as design-system.md's "The story" draws it, and the thread resolved by `lookover wait`, as Lookover posts no
// reply on a fixed thread.
import { eyes, ICON, mark } from "../brand/eyes.generated.ts";

/** The review pattern the app's panel shows: find, then confirm. */
const PATTERN = {
  name: "Find, then confirm",
  hint: "One engine finds everything it can; the other re-checks each finding alone.",
  steps: ["Codex looks for problems", "Claude double-checks each finding", "Posted on GitHub"],
};

/** The person signed in, an example: the shared App posts the review and the summary as them. */
const PERSON = "mira";

/** Their avatar, a round with their initial; with Lookover's badge on what GitHub shows was posted through the App. */
const avatar = (badged: boolean) =>
  `<span class="ts-person" aria-hidden="true">${PERSON.charAt(0).toUpperCase()}${badged ? `<span class="ts-badge">${ICON}</span>` : ""}</span>`;

/** The story in five beats, at the scene's time (ms): the phone's list, and where each starts. */
export const THREE_SIDES_BEATS = [
  { at: 0, text: "The agent pushes and opens a pull request. GitHub is the only thing it talks to." },
  { at: 2900, text: "Lookover sees the push and runs the review: Codex finds, Claude double-checks." },
  {
    at: 6900,
    text: "One review lands: the verdict, one finding on its line, the check. The agent is told what to do.",
  },
  { at: 11000, text: "The agent reads it, fixes, replies, pushes. Round 2 checks the fix only." },
  { at: 17300, text: "Verified fixed. The check turns green. Merging stays your call." },
] as const;

const ICONS = {
  agent: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4l4 4-4 4"/><path d="M8 12h6"/></svg>`,
  github: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="5.5" r="1.5"/><path d="M4 5v6"/><path d="M12 7c0 3-8 2-8 4"/></svg>`,
};

/** A run's step in the app's step list: the empty ring, the reading eyes, the check. */
const stepLi = (id: string, label: string) =>
  `<li class="ts-astep"><span class="ts-ast"><i class="ts-aring-s"></i><span class="ts-aeyes">${eyes(id)}</span><i class="ts-acheck">✓</i></span><span class="ts-alabel">${label}</span></li>`;

const ring = () =>
  `<span class="ts-aring"><svg viewBox="0 0 36 36"><circle class="trk" cx="18" cy="18" r="15"/><circle class="prg" cx="18" cy="18" r="15" pathLength="100"/></svg></span>`;

/**
 * GitHub's side: the pull request, its check, the review, the finding on its line and its thread, the merge button.
 * The scene's middle panel, and the card the phone shows under the beats.
 */
export function githubPanelHTML(): string {
  return `<div class="ts-panel ts-gh gh">
        <div class="ts-ghbar">ledger-api<span>/</span><b>Pull requests</b></div>
        <div class="ts-ghbody">
          <div class="ts-layer ts-empty" data-gh="empty"><p>No open pull requests.</p></div>
          <div class="ts-layer" data-gh="pr">
            <div class="ts-prtitle">Add rate limiting to /v1/invoices <span>#148</span></div>
            <div class="ts-prmeta"><span class="ts-open">Open</span><span><code>add-rate-limit</code> into <code>main</code> · by the agent</span></div>
            <div class="ts-check">
              <span class="ts-chkico">${ICON}</span>
              <span class="ts-chkname">Lookover<span class="ts-chkslot"><span class="ts-chktext wait" data-chk="wait">Waiting</span><span class="ts-chktext run" data-chk="r1">Reviewing · round 1</span><span class="ts-chktext acc" data-chk="found">1 blocking finding</span><span class="ts-chktext run" data-chk="r2">Checking the fix</span><span class="ts-chktext ok" data-chk="clear">Nothing to fix</span></span></span>
            </div>
            <div class="ts-review" data-review>
              ${avatar(false)}
              <div><div class="ts-rvhead"><b class="ts-who">${PERSON}</b> <span class="ts-muted">reviewed</span></div>
                <div class="ts-rvslot"><p class="ts-rvtext" data-verdict="1">Lookover · Looked over <code>a1f9c2e</code>. One thing to fix, rateLimit.ts line 42. The rest can go.</p><p class="ts-rvtext" data-verdict="2">Lookover · Looked over <code>b2c3d4e</code>. Nothing new to fix. The rest can go.</p></div></div>
            </div>
            <div class="ts-finding" data-finding>
              <div class="ts-fpath"><code>src/middleware/rateLimit.ts</code> line 42</div>
              <div class="ts-fcode"><div><i>41</i><span>if (limited) {</span></div><div class="hl"><em class="ts-mkr"></em><i>42</i><span>  log.warn("throttled", req.headers);</span></div></div>
              <div class="ts-fbody"><span class="ts-sevslot"><span class="ts-sev" data-sev="blocking">Blocking</span><span class="ts-sev ok" data-sev="fixed">Verified fixed</span></span><b>API key is written to the request log</b><p>When a client is throttled, the full headers are logged, including Authorization.</p></div>
              <div class="ts-thread"><span data-reply><b>agent</b> · Fixed in <code>b2c3d4e</code></span><span data-verified><b>Resolved</b> · verified fixed in <code>b2c3d4e</code> <em>✓</em></span></div>
            </div>
            <div class="ts-summary" data-summary>
              ${avatar(true)}
              <span class="ts-sumslot"><span class="ts-sumtext" data-verdict="1"><b>Lookover</b> · round 1 · One thing to fix.</span><span class="ts-sumtext" data-verdict="2"><b>Lookover</b> · round 2 · Nothing to fix.</span></span>
            </div>
            <div class="ts-merge" data-merge><span class="ts-mergebtn">Merge pull request</span><span>Your call, not the reviewer's.</span></div>
          </div>
        </div>
      </div>`;
}

/**
 * The stage, in its last frame: what the details say (round 2, on b2c3d4e, at /reviews/148) is the end's; the
 * script sets the start's when it takes the stage. `id` starts the ids of its drawings' masks.
 */
export function threeSidesHTML(id = "ts"): string {
  let n = 0;
  const next = () => `${id}-${++n}`;
  return `<div class="ts-stage" data-stage="three-sides">

    <div class="ts-side agent" data-side="agent">
      <div class="ts-label"><i>${ICONS.agent}</i><b>The coding agent</b><span>Claude Code, in your terminal</span></div>
      <div class="ts-panel ts-term">
        <div class="ts-tbar"><i></i><i></i><i></i><b>agent · zsh</b></div>
        <div class="ts-tbody">
          <div class="ts-ln" data-l="1"><em class="ts-pr">$</em><span class="ts-ty">claude -p "Rate limit /v1/invoices"</span><i class="ts-caret"></i></div>
          <div class="ts-ln out" data-l="2"><em class="ts-ok">✓</em>pushed <b>add-rate-limit</b>, opened <b>#148</b></div>
          <div class="ts-ln" data-l="4"><em class="ts-pr">$</em><span class="ts-ty">lookover wait</span><i class="ts-caret"></i></div>
          <div class="ts-slot"><div class="ts-ln dim" data-l="5"><i class="ts-dot"></i>waiting for the review…</div><div class="ts-ln out" data-l="6"><em class="ts-acc">!</em>action needed · <b>1 blocking finding</b></div></div>
          <div class="ts-ln" data-l="7"><em class="ts-pr">$</em><span class="ts-ty">claude -p "Fix the finding"</span><i class="ts-caret"></i></div>
          <div class="ts-ln out" data-l="8"><em class="ts-ok">✓</em>pushed <b>b2c3d4e</b> · replied <b>Fixed</b></div>
          <div class="ts-ln" data-l="10"><em class="ts-pr">$</em><span class="ts-ty">lookover wait</span><i class="ts-caret"></i></div>
          <div class="ts-slot"><div class="ts-ln dim" data-l="11"><i class="ts-dot"></i>waiting for the review…</div><div class="ts-ln out" data-l="12"><em class="ts-ok">✓</em>clear · nothing to fix</div></div>
        </div>
      </div>
      <div class="ts-halo"></div>
    </div>

    <div class="ts-side github" data-side="github">
      <div class="ts-label"><i>${ICONS.github}</i><b>GitHub</b><span>the pull request: the only place they meet</span></div>
      ${githubPanelHTML()}
      <div class="ts-halo"></div>
    </div>

    <div class="ts-side app" data-side="app">
      <div class="ts-label"><i>${mark(next())}</i><b>Lookover · running locally</b><span>the app, on your machine, on your plans</span></div>
      <div class="ts-panel ts-app">
        <div class="ts-aaddr"><span>localhost:4242</span><i data-addr>/reviews/148</i></div>
        <div class="ts-atop"><span class="ts-amark">${mark(next())}</span><span class="ts-asep"></span><span class="ts-anav"><b>Reviews</b></span></div>
        <div class="ts-abody">
          <div class="ts-ahome" data-ap="home"><h4>Nothing needs you.</h4><p class="ts-muted">7 reviewed today. The next one shows up here.</p></div>
          <div class="ts-areview" data-ap="review">
            <div class="ts-acrumb">Reviews / <b>ledger-api #148</b></div>
            <h4 class="ts-atitle">Add rate limiting to /v1/invoices</h4>
            <div class="ts-ameta"><code>#148</code> written by Claude</div>
            <div class="ts-achips">
              <span class="ts-achip run" data-chip="r1">${eyes(next())} Reviewing…</span>
              <span class="ts-achip warn" data-chip="fix"><i></i>To fix</span>
              <span class="ts-achip run" data-chip="r2">${eyes(next())} Checking the fix</span>
              <span class="ts-achip ok" data-chip="clean"><i></i>Clean</span>
            </div>
            <div class="ts-amain">
              <div class="ts-acard" data-round="1">
                <div class="ts-arh">${ring()}<div><b>Round 1</b><span class="ts-muted">on a1f9c2e</span></div><span class="ts-apat" title="${PATTERN.hint}">${PATTERN.name}</span></div>
                <ol class="ts-asteps">${PATTERN.steps.map((step) => stepLi(next(), step)).join("")}</ol>
              </div>
              <div class="ts-acard" data-verdict="1">
                <div class="ts-averdict"><span class="ts-aveyes">${eyes(next(), true)}</span><div><p>Looked over a1f9c2e. One thing to fix, rateLimit.ts line 42. The rest can go.</p><small>1 found by Codex · double-checked by Claude · posted</small></div></div>
                <div class="ts-afinding"><span class="ts-sevl">1 blocking finding</span><b>API key is written to the request log</b><small><code>rateLimit.ts</code> line 42</small></div>
              </div>
              <div class="ts-acard" data-round="2">
                <div class="ts-arh">${ring()}<div><b>Round 2</b><span class="ts-muted">on b2c3d4e</span></div></div>
                <ol class="ts-asteps">${["Checking the fix", "Posted on GitHub"].map((step) => stepLi(next(), step)).join("")}</ol>
              </div>
              <div class="ts-acard" data-verdict="2">
                <div class="ts-averdict"><span class="ts-aveyes ok">${eyes(next(), true)}</span><div><p>Looked over b2c3d4e. Nothing to fix. The rest can go.</p><small>the finding is verified fixed · nothing new</small></div></div>
              </div>
            </div>
            <div class="ts-adetails">
              <div class="ts-adrow"><b>How this review ran</b><span class="ts-muted">Codex, then Claude</span></div>
              <div class="ts-adrow"><b>Rounds</b><span class="ts-muted"><span data-det="rounds">2</span> · on <code data-det="sha">b2c3d4e</code></span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="ts-halo"></div>
    </div>
    <svg class="ts-links" viewBox="0 0 1280 712" aria-hidden="true"></svg>
  </div>`;
}
