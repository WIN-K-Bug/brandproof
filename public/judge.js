// Judge demo: what a visitor sees when the server runs the isolated fictional demo (meta.judge.enabled).
// The session itself is a server-side cookie the page never reads; this file only shows its status, how to get started,
// what happens when it ends, and a way to start over. Nothing here is an identity: the "Acting as" switch is a simulation.
//
// Wording rule: say what is true. Data typed here IS sent to the server that runs the demo and stored there; the demo keeps one visitor's
// session separate from other visitors' sessions, but it does not hide it from whoever operates the server, and whoever holds a session's
// cookie can act as that session. So the copy talks about separation and fictional data, and asks for nothing confidential.
import { h, clear, api, state, openDialog, toast, roleLabel, describeError } from './ui.js';

export const isJudge = () => Boolean(state.meta?.judge?.enabled);

const GUIDE_HIDDEN = 'brandproof-judge-guide-hidden';
const store = {
  get: () => {
    try {
      return localStorage.getItem(GUIDE_HIDDEN) === '1';
    } catch {
      return false;
    }
  },
  set: (hidden) => {
    try {
      localStorage.setItem(GUIDE_HIDDEN, hidden ? '1' : '0');
    } catch {}
  },
};

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Ask the server about THIS browser's session (it knows it from the cookie alone). */
export async function loadJudgeSession() {
  try {
    state.judge = await api('GET', '/api/judge/session');
  } catch {
    state.judge = null; // an ended session is reported through state.onSessionEnded by the API layer
  }
  if (state.judge) {
    try {
      state.scenario = await api('GET', '/api/judge/scenario'); // known before the first page is drawn, so the entry button is only shown while it can be used
    } catch {
      state.scenario = null;
    }
  }
}

/** The About text for this mode, as separate list items (the page's other lines still apply). */
export function judgeAboutLines() {
  const j = state.judge;
  const life = j ? ` A session expires after about ${j.idleMinutes} minutes without activity (${j.maxHours} hours at most) and can be reset at any time.` : ' A session expires after a period without activity and can be reset at any time.';
  return [
    'This is the judge demo. Use fictional data only: do not enter confidential or personal information.',
    `What you type, and any PNG you attach, is sent to the server that runs this demo and stored there, as plain files, in a session that only this browser’s session cookie opens. Other visitors’ sessions are kept separate from yours, but the people who operate the server can read them, and anyone who obtains this browser’s cookie can act as this session.${life}`,
    ...(j?.ephemeral ? ['This is a temporary demo on temporary storage: a session, and everything in it, is lost when the demo server restarts, sleeps or is redeployed, which on a free hosting tier can happen after a short idle period. If that happens you will see “session ended” and can start a new one.'] : []),
    'In the other lines here, “this computer” means the server that runs this demo, not your own device. There is no sign-in, and the “Acting as” switch is a simulation of different people.',
  ];
}

/** The banner (the strip across the top) for a judge-demo session. */
export function judgeBanner({ onAbout }) {
  const j = state.judge;
  const ended = state.sessionEnded;
  const text = ended
    ? 'This session has ended. Reload the page to start a new one.'
    : `${j?.replacedPrevious ? 'This browser’s earlier session had ended, so this is a new one. ' : ''}Your own demo session: fictional data only, nothing confidential. Roles are a simulation, not sign-in.${j ? ` Ends about ${clock(j.expiresAt)} if left idle.` : ''}`;
  return [
    h('strong', null, ended ? 'Session ended' : 'Demo session'),
    h('span', { class: 'banner-text' }, text),
    ended ? null : h('button', { class: 'btn small', type: 'button', onclick: () => toggleGuide() }, 'How to try it'),
    ended ? null : h('button', { class: 'btn small', type: 'button', onclick: openReset }, 'Reset my demo'),
    h('button', { class: 'btn small', type: 'button', onclick: onAbout }, 'About & limits'),
  ].filter(Boolean); // append(null) would print the word "null"
}

/**
 * The guide above the page. The three steps are always visible, one short line each, so the way through (add content, read the findings,
 * record a human decision) is obvious at once, even on a phone. The fuller explanations are in a "More detail" disclosure (a native
 * <details>: keyboard operable, readable by screen readers) that starts open only on a wide screen, where there is room.
 */
export function paintGuide() {
  const box = document.getElementById('judge-guide');
  if (!box) return;
  clear(box);
  if (!isJudge() || state.sessionEnded) {
    box.hidden = true;
    return;
  }
  state.afterWrite = () => void refreshScenario(); // any saved change may move the scenario on (an approval, a published fact)
  queueMicrotask(paintScenario); // the row is filled from the last answer the server gave (refreshScenario asks again)
  box.hidden = store.get();
  const wide = typeof matchMedia === 'function' && matchMedia('(min-width: 900px)').matches;
  const step = (label, hint) => h('li', null, h('strong', null, label), h('span', { class: 'jg-hint' }, hint));
  box.append(
    h(
      'section',
      { class: 'jg-card', 'aria-labelledby': 'jg-title' },
      h('div', { class: 'jg-head' }, h('h2', { id: 'jg-title' }, 'Try it in three steps'), h('button', { class: 'btn small', type: 'button', onclick: () => toggleGuide(true) }, 'Hide')),
      h(
        'div',
        { class: 'jg-body' },
        h(
          'ol',
          { class: 'jg-steps' },
          step('Add content', 'Use “New submission” or the sample.'),
          step('Read the findings', 'See the claim, approved fact, source.'),
          step('Record a decision', 'Request review, then act as Reviewer.'),
        ),
        h('p', { class: 'small jg-fiction' }, 'Fictional data only: do not enter confidential information.'),
        h('div', { class: 'jg-scenario', id: 'jg-scenario' }),
        h(
          'details',
          { class: 'jg-more', open: wide },
          h('summary', null, 'More detail'),
          h(
            'div',
            { class: 'jg-more-body stack' },
            h('p', null, 'To add content, choose “New submission” and paste campaign copy (try “A full charge lasts 30 hours.”), or open “Aurora Lamp: spring launch hero”, which already has problems to find.'),
            h('p', null, 'Each finding shows the claim, the approved fact it contradicts and the exact source passage. Blocking findings stop approval; “Unverified” means no approved fact backs the claim.'),
            h('p', null, 'To record a decision, fix the copy with “Edit as new revision”, choose “Request review”, then set “Acting as” to Reviewer and approve or reject. If you change the copy afterwards, the approval turns into “re-review required”.'),
            h('p', { class: 'small muted' }, 'What you enter is stored on the demo server in a session separate from other visitors’ sessions, until it expires or you reset it.' + (state.judge?.ephemeral ? ' This is a temporary demo: everything is also lost if the demo server restarts or sleeps.' : '') + ' “Acting as” switches between simulated people for this walkthrough; it is not sign-in. “About & limits” has the details.'),
          ),
        ),
      ),
    ),
  );
}

// ---------- the optional "evidence change" scenario ----------
// A second, separate way through the demo (the three steps above are unchanged): a source changes after a campaign was approved. Starting it adds
// a fictional source, a campaign approved against it and a pending new version to THIS session, through the real routes; the visitor then does
// every step with the real features. The strip in the guide says where the visitor is, read from the server's stored state each time (never kept here).

/** Ask the server where this session is in the scenario, then repaint its row. */
export async function refreshScenario() {
  if (!isJudge() || state.sessionEnded) return;
  try {
    state.scenario = await api('GET', '/api/judge/scenario');
  } catch {
    state.scenario = null;
  }
  paintScenario();
}

/** The optional entry, shown beside "New submission" in the workspace header while the scenario has not been started in this session. */
export function scenarioEntry() {
  if (!isJudge() || state.scenario?.started) return null;
  return h('button', { class: 'btn', type: 'button', id: 'scenario-entry', title: 'Optional: a source changes after a campaign was approved. See what that does, then repair it. Fictional data.', onclick: openScenarioStart }, 'Try an evidence change');
}

function paintScenario() {
  const box = document.getElementById('jg-scenario');
  if (!box) return;
  clear(box);
  const s = state.scenario;
  // Before it is started the entry is the "Try an evidence change" button beside "New submission" (scenarioEntry): the guide keeps the size it was
  // accepted at. Once it is started, this strip says where the visitor is.
  if (!s || !s.started) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const next = s.next;
  const who = next?.role ? `Switch “Acting as” to ${roleLabel(next.role)}, then open it.` : null;
  box.append(
    h('div', { class: 'jg-scenario-text', role: 'group', 'aria-label': 'Evidence change: where you are' }, h('strong', null, 'Evidence change'), h('span', { class: 'jg-hint' }, s.headline), who ? h('span', { class: 'jg-hint jg-role' }, who) : null),
    next?.action === 'start'
      ? h('button', { class: 'btn small primary', type: 'button', onclick: () => startScenario() }, next.label)
      : next
        ? h('a', { class: 'btn small primary', href: next.hash }, next.label)
        : null,
  );
}

function openScenarioStart() {
  openDialog({
    title: 'Try an evidence change',
    content: [
      h('p', null, 'This adds, to your session only: one fictional fact sheet (version 1 approved, version 2 waiting), one sample campaign that was approved against version 1, and links three of the demo brand’s facts to that fact sheet (a new guidelines version). The approval you will see is sample history in the scenario, not a decision of yours.'),
      h('p', null, 'Your own campaigns, comments and images are kept. Because the guidelines change, a campaign that was already approved (such as the sample newsletter blurb) will show “Re-review required”.'),
      h('p', { class: 'small muted' }, 'Nothing is reset. “Reset my demo” removes everything, including this, at any time.'),
    ],
    actions: [
      { label: 'Cancel', closes: true },
      { label: 'Start the scenario', kind: 'primary', onClick: async (close) => (await startScenario(close)) },
    ],
  });
}

let starting = false;
async function startScenario(close) {
  if (starting) return false; // a double click is one request; the server also runs it once
  starting = true;
  try {
    const r = await api('POST', '/api/judge/scenario', {});
    state.scenario = r;
    close?.();
    paintScenario();
    toast(r.created ? 'The scenario is ready: the sample campaign is approved on version 1.' : 'The scenario is already in your session.');
    if (r.campaignId) location.hash = `#/workspace/${r.campaignId}`;
    await refreshScenario();
    return true;
  } catch (e) {
    toast(describeError(e), 'err');
    await refreshScenario();
    return false;
  } finally {
    starting = false;
  }
}

function toggleGuide(hide) {
  const box = document.getElementById('judge-guide');
  if (!box) return;
  const hidden = hide === true ? true : !box.hidden;
  store.set(hidden);
  box.hidden = hidden;
  if (!hidden) box.scrollIntoView?.({ block: 'nearest' });
}

function openReset() {
  openDialog({
    title: 'Reset my demo',
    content: [
      h('p', null, 'This clears everything in your demo session (your submissions, comments, decisions and images) and starts again with the original fictional data. Other visitors’ sessions are not affected.'),
    ],
    actions: [
      { label: 'Cancel', closes: true },
      {
        label: 'Reset my demo',
        kind: 'danger',
        onClick: async (close) => {
          try {
            await api('POST', '/api/judge/reset', {});
          } catch (e) {
            toast(e.message, 'err');
            return false;
          }
          close();
          location.hash = '#/workspace';
          location.reload();
          return true;
        },
      },
    ],
  });
}

/** The session is gone (expired, or the server no longer has it). Say so plainly and offer the way back; never silently start over. */
export function showSessionEnded(main, repaintBanner) {
  if (state.sessionEnded) return;
  state.sessionEnded = true;
  const idle = state.judge?.idleMinutes;
  clear(main).append(
    h(
      'div',
      { class: 'card', role: 'alert' },
      h('div', { class: 'card-h' }, h('h1', { tabindex: -1, id: 'session-ended-title' }, 'This demo session has ended')),
      h(
        'div',
        { class: 'card-b stack' },
        h('p', null, `A demo session belongs to one browser and expires after ${idle ? `about ${idle} minutes` : 'a while'} without activity, or when the demo server no longer has it${state.judge?.ephemeral ? ' (this temporary demo loses its sessions when the service restarts or sleeps)' : ''}. What was in this one is no longer available here, and the server removes expired sessions’ data when it cleans up.`),
        h('p', null, 'Reload to start a new session with fresh fictional data.'),
        h('p', { class: 'small muted' }, 'If this keeps happening straight away, this browser may be blocking cookies for this site. The demo needs one cookie to tell your session apart from other visitors’; it holds no personal information.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Start a new demo session')),
      ),
    ),
  );
  repaintBanner();
  paintGuide();
  document.getElementById('session-ended-title')?.focus();
}
