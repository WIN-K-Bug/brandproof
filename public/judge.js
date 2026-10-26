// Judge demo: what a visitor sees when the server runs the isolated fictional demo (meta.judge.enabled).
// The session itself is a server-side cookie the page never reads; this file only shows its status, how to get started,
// what happens when it ends, and a way to start over. Nothing here is an identity: the "Acting as" switch is a simulation.
//
// Wording rule: say what is true. Data typed here IS sent to the server that runs the demo and stored there; the demo keeps one visitor's
// session separate from other visitors' sessions, but it does not hide it from whoever operates the server, and whoever holds a session's
// cookie can act as that session. So the copy talks about separation and fictional data, and asks for nothing confidential.
import { h, clear, api, state, openDialog, toast } from './ui.js';

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
