import { h, clear, api, describeError, openDialog, state, icon, field, toast, isAuthed, roleLabel, focusMainHeading } from './ui.js';
import { renderWorkspace } from './workspace.js';
import { renderLibrary } from './library.js';
import { renderQueue } from './queue.js';
import { renderInsights } from './insights.js';
import { renderPeople } from './people.js';
import { renderSources } from './sources.js';
import { renderDossier } from './dossier.js';
import { isJudge, loadJudgeSession, judgeBanner, judgeAboutLines, paintGuide, showSessionEnded, refreshScenario } from './judge.js';

const BASE_PAGES = [
  ['workspace', 'Workspace'],
  ['library', 'Brand library'],
  ['sources', 'Sources'],
  ['queue', 'Review queue'],
  ['insights', 'Insights'],
];
const pages = () => (state.user?.owner ? [...BASE_PAGES, ['people', 'People']] : BASE_PAGES);

// A visitor who arrived from another site passes through /?entry=1 (src/judge.js): show the clean address again.
if (location.search === '?entry=1') history.replaceState(null, '', '/' + location.hash);

const main = document.getElementById('main');

function go(hash, replace = false) {
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
  if (replace) route();
}

function parse() {
  const [path, query = ''] = location.hash.split('?');
  const [, page = 'workspace', arg, arg2] = path.split('/');
  return { page: page === 'dossier' || pages().some(([id]) => id === page) ? page : 'workspace', arg: arg ? decodeURIComponent(arg) : null, arg2: arg2 ? decodeURIComponent(arg2) : null, query };
}

// In the phone layout the navigation is a sideways-scrolling row. Browsers leave a link that is only partly visible where it is when it receives
// keyboard focus, so a link focused with Tab is scrolled fully into view here.
document.getElementById('nav')?.addEventListener('focusin', (e) => e.target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));

function paintNav(page, queueCount) {
  clear(document.getElementById('nav')).append(
    ...pages().map(([id, label]) =>
      h('a', { href: `#/${id}`, 'aria-current': id === page ? 'page' : null }, icon(id === 'people' || id === 'sources' ? 'library' : id), label, id === 'queue' && queueCount ? h('span', { class: 'count', title: 'Waiting for review' }, queueCount) : null),
    ),
  );
}

async function route(opts = {}) {
  if (isAuthed() && !state.user) return showSignIn();
  const { page, arg, arg2, query } = parse();
  const token = ++state.route;
  const pageName = page === 'dossier' ? 'Review dossier' : pages().find(([id]) => id === page)[1];
  document.getElementById('crumb').textContent = pageName;
  document.title = `${pageName} · BrandProof`;
  try {
    const list = (await api('GET', '/api/submissions')).submissions;
    if (token !== state.route) return;
    paintNav(page === 'dossier' ? 'workspace' : page, list.filter((s) => s.status === 'in_review' || s.status === 'approval_stale').length || null);
    if (page === 'dossier') await renderDossier(main, arg);
    else if (page === 'workspace') await renderWorkspace(main, arg, go);
    else if (page === 'library') await renderLibrary(main);
    else if (page === 'sources') await renderSources(main, arg, arg2, query, go);
    else if (page === 'queue') await renderQueue(main, go);
    else if (page === 'people') await renderPeople(main);
    else await renderInsights(main);
    // After navigating, put focus on the new page's heading so keyboard and screen-reader users start at the top of the content.
    if (opts.focus && token === state.route) focusMainHeading();
    if (isJudge() && token === state.route) void refreshScenario(); // where the optional evidence-change scenario stands, from the stored state
  } catch (e) {
    if (token !== state.route) return;
    if (state.sessionEnded) return; // the judge demo already replaced the page with its "session ended" state
    if (isAuthed() && e.status === 401) return signedOut('Your session ended. Please sign in again.');
    clear(main).append(h('div', { class: 'notice err' }, describeError(e)));
  }
}

function paintBanner() {
  const foot = document.querySelector('.sidebar-foot');
  if (foot) foot.textContent = isAuthed() ? 'Local workspace · fictional brand · Codex 48 prototype' : 'Demo mode · fictional brand · Codex 48 prototype';
  const b = clear(document.getElementById('banner'));
  if (isJudge()) return void b.append(...judgeBanner({ onAbout: openAbout }));
  // One honest line about data use. The technical detail (no HTTPS, no encryption at rest, rules-only checks...) lives in About.
  b.append(
    h('strong', null, isAuthed() ? 'Local prototype' : 'Demo mode'),
    h('span', { class: 'banner-text' }, isAuthed() ? 'Fictional brand. Data stays on this computer, unencrypted: do not enter confidential information.' : 'Fictional brand. Roles are a demo switch, not sign-in. Data stays on this computer.'),
    h('button', { class: 'btn small', type: 'button', onclick: openAbout }, 'About & limits'),
  );
}

function openAbout() {
  const li = (t) => h('li', null, t);
  const authed = isAuthed();
  openDialog({
    title: authed ? 'About BrandProof (local authenticated workspace)' : 'About BrandProof (demo mode)',
    content: [
      h('p', null, `BrandProof is a local prototype by team ${state.meta.team} for the Codex 48 hackathon. It reviews campaign copy and image details against approved brand guidelines before publication.`),
      h(
        'ul',
        null,
        li('The brand, its documents and its campaigns are fictional.'),
        authed
          ? li('You are signed in as a named account. The server decides your role; nothing in the browser can change it. Someone who wrote or edited a submission cannot approve it, whatever their role.')
          : li('Roles (Creator, Manager, Reviewer) are a switch for the walkthrough, not authentication. Anyone using this page can pick any role.'),
        authed
          ? li('This is local sign-in only: plain HTTP on this computer, sessions kept in server memory, data in files on this disk without encryption. It is not production multi-tenancy and not suitable for confidential data.')
          : isJudge()
            ? judgeAboutLines().map(li)
            : li('Data is saved in one file on this computer. This is not confidential multi-user storage.'),
        li('Findings come from deterministic rules. Contextual AI review is unavailable; nothing here is generated by an AI model.'),
        li('“AI source matching”, when available, uses a small embedding model that runs on this computer to show which approved sources are about the same topic as a passage. It measures relevance only, is not generative review, and plays no part in findings or approval.'),
        li('“Unverified” means no matching approved fact was found by these checks. It does not mean the claim is false, and it does not mean no source exists.'),
        li('Contrast and palette checks use only the colours you select for an image. They do not certify the whole image.'),
        isJudge()
          ? li('Text inside an image is checked only through a transcription a person confirms. An optional reader on the demo server can draft it, but a draft can be wrong or incomplete, is never source evidence or an approval, and the image is not sent to any other service.')
          : li('Text inside an image is checked only through a transcription a person confirms. An optional reader that runs on this computer can draft it, but a draft can be wrong or incomplete, is never source evidence or an approval, and nothing is sent anywhere.'),
        li('A PNG attached to a revision is uploaded to this computer’s workspace storage, checked by the server (PNG only, up to 2 MB and 4 million pixels) and kept with its SHA-256 digest. Approvals are bound to those exact bytes. Images cannot be deleted in this version, and the workspace has a storage limit. Older revisions that only saved a file name and a browser-reported fingerprint are shown as “Metadata only”: their image was never retained. Text and palette colours are chosen by a person (typed, picked, or taken from one clicked pixel of the image); nothing evaluates the whole image’s palette, contrast or logos automatically. Words printed in an image are checked only through a transcription a person confirms: it may start as an optional local OCR draft and must match the printed words and digits.'),
        li('An approval is bound to the exact copy, image details, guideline version and the registered source evidence the rules rest on. Changing any of them, including replacing or withdrawing a cited source, means re-review is required.'),
        li('A rule or fact marked “Registered” cites an exact passage of an approved source version that the server checked. “Legacy” means a manager typed the label and quote; it is not linked to a registered source and cannot be verified against a document.'),
        li('Source addresses (URLs) are labels only. BrandProof never opens, fetches or verifies them, and only pasted text or small UTF-8 .txt/.md files are read. The text digest is of the normalised text, not of any original file.'),
      ),
    ],
    actions: [{ label: 'Close', kind: 'primary' }],
  });
}

// ---------- demo-mode role switch ----------

function paintRole() {
  const sel = document.getElementById('role');
  clear(sel).append(...state.meta.roles.map((r) => h('option', { value: r.id, selected: r.id === state.role }, r.label)));
  sel.onchange = () => {
    state.role = sel.value;
    try {
      localStorage.setItem('brandproof-role', state.role);
    } catch {}
    route();
  };
}

// ---------- authenticated mode: sign-in, who am I, sign-out ----------

function setSignedOutLayout(on) {
  document.body.classList.toggle('signed-out', on);
}

function signedOut(message) {
  state.user = null;
  state.csrf = null;
  showSignIn(message);
}

function showSignIn(message) {
  setSignedOutLayout(true);
  document.getElementById('who').hidden = true;
  document.getElementById('crumb').textContent = 'Sign in';
  const user = h('input', { type: 'text', id: 'si-user', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pass = h('input', { type: 'password', id: 'si-pass', name: 'password', autocomplete: 'current-password', required: true });
  const err = h('p', { class: 'err-text', role: 'alert', id: 'si-err' }, message ?? '');
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h(
    'form',
    {
      class: 'card signin',
      'aria-labelledby': 'si-title',
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        try {
          const r = await api('POST', '/api/auth/login', { username: user.value, password: pass.value });
          pass.value = '';
          await afterSignIn(r.user, r.csrf);
        } catch (e) {
          pass.value = '';
          const wait = e.details?.retryAfterSeconds;
          err.textContent = e.status === 429 ? `Too many failed attempts. Try again in about ${Math.max(1, Math.ceil(wait / 60))} minute(s).` : e.status === 401 ? 'Invalid username or password.' : describeError(e);
          pass.focus();
        } finally {
          btn.disabled = false;
        }
      },
    },
    h('h1', { id: 'si-title' }, 'Sign in to BrandProof'),
    h('p', { class: 'muted small' }, 'Local authenticated workspace. Your role comes from your account, not from this page.'),
    state.meta.setupRequired ? h('div', { class: 'notice warn' }, h('strong', null, 'No accounts exist yet. '), 'The owner creates the first account on this computer with ', h('code', null, 'npm run auth:setup'), ' (stop the server first).') : null,
    field('Username', user, null, 'si-user'),
    field('Password', pass, null, 'si-pass'),
    err,
    h('div', { class: 'row' }, btn),
  );
  clear(main).append(form);
  clear(document.getElementById('nav'));
  user.focus();
}

async function afterSignIn(user, csrf) {
  state.user = user;
  state.csrf = csrf;
  state.role = user.role;
  state.meta = await api('GET', '/api/meta'); // the full metadata, now that we are signed in
  setSignedOutLayout(false);
  paintBanner();
  paintWho();
  if (!location.hash || location.hash === '#/') location.hash = '#/workspace';
  await route();
}

function paintWho() {
  const who = document.getElementById('who');
  who.hidden = false;
  document.getElementById('role-picker').hidden = true;
  clear(who).append(
    h('span', { class: 'who-name' }, state.user.name),
    h('span', { class: 'chip teal', title: 'Your role is set by the server' }, `${roleLabel(state.user.role)}${state.user.owner ? ' · owner' : ''}`),
    h('button', { class: 'btn small', type: 'button', onclick: openPassword }, 'Change password'),
    h('button', { class: 'btn small', type: 'button', onclick: signOut }, 'Sign out'),
  );
}

async function signOut() {
  try {
    await api('POST', '/api/auth/logout', {});
  } catch {}
  state.user = null;
  state.csrf = null;
  state.meta = await api('GET', '/api/meta').catch(() => state.meta);
  location.hash = '#/workspace';
  showSignIn('You have signed out.');
}

function openPassword() {
  const cur = h('input', { type: 'password', id: 'pw-cur', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', id: 'pw-new', autocomplete: 'new-password' });
  openDialog({
    title: 'Change your password',
    content: [field('Current password', cur, null, 'pw-cur'), field('New password', next, 'At least 15 characters. A passphrase of several words is fine.', 'pw-new'), h('p', { class: 'muted small' }, 'Changing it signs you out of every other device.')],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Change password',
        kind: 'primary',
        onClick: async () => {
          try {
            const r = await api('POST', '/api/auth/password', { current: cur.value, next: next.value });
            state.csrf = r.csrf;
            toast('Password changed.', 'ok');
            return true;
          } catch (e) {
            toast(describeError(e), 'err');
            return false;
          }
        },
      },
    ],
  });
}

// ---------- boot ----------

async function boot() {
  // The judge demo's session can end while a tab is open; the API layer reports it here (once), and the page says so instead of failing quietly.
  state.onSessionEnded = () => showSessionEnded(main, paintBanner);
  try {
    state.meta = await api('GET', '/api/meta');
  } catch (e) {
    if (!state.sessionEnded) clear(main).append(h('div', { class: 'notice err' }, describeError(e)));
    return;
  }
  window.addEventListener('hashchange', () => route({ focus: true }));
  if (isAuthed()) {
    document.getElementById('role-picker').hidden = true;
    try {
      const me = await api('GET', '/api/auth/me');
      state.user = me.user;
      state.csrf = me.csrf;
      state.role = me.user.role;
      state.meta = await api('GET', '/api/meta');
      setSignedOutLayout(false);
      paintBanner();
      paintWho();
      await route();
    } catch (e) {
      if (e.status !== 401) clear(main).append(h('div', { class: 'notice err' }, describeError(e)));
      else {
        paintBanner();
        showSignIn();
      }
    }
    return;
  }
  try {
    const saved = localStorage.getItem('brandproof-role');
    if (state.meta.roles.some((r) => r.id === saved)) state.role = saved;
  } catch {}
  if (isJudge()) await loadJudgeSession();
  paintBanner();
  paintRole();
  paintGuide();
  await route();
}

boot();
