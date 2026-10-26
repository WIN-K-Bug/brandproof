// Small DOM toolkit. Text is only ever added as text nodes, so server data cannot inject markup.

export const state = { role: 'creator', meta: null, user: null, csrf: null };

export const isAuthed = () => state.meta?.mode === 'authenticated';

const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'type', 'id', 'href', 'title', 'placeholder', 'rows', 'min', 'max', 'step', 'selected', 'open', 'name', 'textContent', 'maxLength', 'readOnly', 'accept', 'required']);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'for') el.htmlFor = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (PROP_KEYS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const clear = (el) => {
  el.replaceChildren();
  return el;
};

export async function api(method, path, body, signal) {
  // Demo mode picks a role in the header. Authenticated mode NEVER sends one: identity is the session cookie, and
  // unsafe requests carry the per-session CSRF token.
  const headers = {};
  if (isAuthed()) {
    if (state.csrf) headers['x-csrf-token'] = state.csrf;
  } else headers['x-demo-role'] = state.role;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw Object.assign(new Error('Cancelled.'), { status: 0, aborted: true });
    throw Object.assign(new Error('Could not reach the BrandProof server. Is it still running?'), { status: 0 });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    // The judge demo's private session is gone (expired, or lost in a restart): the page shows an "ended" state with the way back.
    if (res.status === 401 && e?.code === 'session_unavailable') state.onSessionEnded?.();
    throw Object.assign(new Error(e?.message || res.statusText), { status: res.status, code: e?.code, details: e?.details });
  }
  return data;
}

/** Upload raw image bytes. The server validates everything; the browser only moves the bytes. */
export async function apiUpload(path, bytes) {
  const headers = { 'content-type': 'application/octet-stream' };
  if (isAuthed()) {
    if (state.csrf) headers['x-csrf-token'] = state.csrf;
  } else headers['x-demo-role'] = state.role;
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers, body: bytes });
  } catch {
    throw Object.assign(new Error('Could not reach the BrandProof server. Is it still running?'), { status: 0 });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && data?.error?.code === 'session_unavailable') state.onSessionEnded?.();
    throw Object.assign(new Error(data?.error?.message || res.statusText), { status: res.status, code: data?.error?.code });
  }
  return data;
}

export function describeError(e) {
  const f = e.details?.fields;
  if (e.code === 'validation_failed' && f?.length) return f.map((x) => `${x.path} ${x.message}`).join('; ');
  if (e.code === 'evidence_invalid' && e.details?.problems?.length) return `${e.message} ${e.details.problems.map((p) => `${p.id ?? p.path}: ${p.message}`).join('; ')}`;
  return e.message;
}

/** Move keyboard and screen-reader focus to the page heading after a screen has been rebuilt. */
export function focusMainHeading() {
  const h1 = document.querySelector('main h1');
  if (!h1) return;
  h1.tabIndex = -1;
  h1.focus();
}

/**
 * Accessible tabs: roving tabindex, arrow keys, Home/End, aria-controls and a matching tabpanel id (`${idBase}-panel`).
 * `onSelect(id)` must re-render; the selected tab is re-focused afterwards when it was chosen with the keyboard.
 */
export function tabList({ label, idBase, tabs, selected, onSelect }) {
  const ids = tabs.map((t) => t.id);
  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': label });
  tabs.forEach((t, i) => {
    const choose = (id, viaKey) => {
      onSelect(id);
      if (viaKey) setTimeout(() => document.getElementById(`tab-${idBase}-${id}`)?.focus(), 0);
    };
    list.append(
      h(
        'button',
        {
          class: 'tab',
          role: 'tab',
          type: 'button',
          id: `tab-${idBase}-${t.id}`,
          'aria-selected': String(selected === t.id),
          'aria-controls': `${idBase}-panel`,
          tabindex: selected === t.id ? 0 : -1,
          onclick: () => choose(t.id, false),
          onkeydown: (e) => {
            const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
            if (to === undefined) return;
            e.preventDefault();
            choose(ids[(to + ids.length) % ids.length], true);
          },
        },
        t.label,
        t.count !== null && t.count !== undefined ? h('span', { class: 'n' }, t.count) : null,
      ),
    );
  });
  return list;
}

export function toast(message, kind = '') {
  // Errors are announced immediately (role=alert); other messages politely (role=status).
  const t = h('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, message);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 8000 : 4500);
}

export function openDialog({ title, content, actions = [], wide = false }) {
  const dlg = h('dialog', { 'aria-labelledby': 'dlg-title' });
  const opener = document.activeElement; // focus goes back here when the dialog closes
  const close = () => {
    dlg.close(); // the browser restores focus to the opener if it is still on the page
    dlg.remove();
    // If the action rebuilt the page the opener is gone: land on the page heading instead of losing focus.
    if (opener && !opener.isConnected) focusMainHeading();
  };
  const body = h('div', { class: 'dlg-b' }, content);
  dlg.append(
    h('div', { class: 'dlg-h' }, h('h2', { id: 'dlg-title' }, title), h('button', { class: 'btn small ghost dlg-x', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close'))),
    body,
  );
  if (actions.length) {
    dlg.append(
      h(
        'div',
        { class: 'dlg-f' },
        actions.map((a) =>
          h(
            'button',
            {
              class: `btn ${a.kind || ''}`,
              type: 'button',
              onclick: async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                try {
                  const keep = await a.onClick?.(close);
                  if (keep !== false && a.closes !== false) close();
                } finally {
                  btn.disabled = false;
                }
              },
            },
            a.label,
          ),
        ),
      ),
    );
  }
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.getElementById('dialogs').append(dlg);
  dlg.showModal();
  if (wide) dlg.style.width = 'min(900px, calc(100vw - 24px))';
  return { dlg, close, body };
}

export const fmtTime = (iso) => {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
};

export const short = (hash) => (hash ? hash.slice(0, 8) : '');

export const STATUS_LABEL = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
  approval_stale: 'Re-review required',
};

export const FINDING_LABEL = {
  violation: 'Rule violation',
  contradicted: 'Contradicts fact',
  unverified: 'Unverified claim',
  needs_review: 'Needs review',
  supported: 'Consistent',
};

export const statusChip = (status) => h('span', { class: `chip ${status}` }, h('span', { class: 'dot' }), STATUS_LABEL[status] || status);

export function findingChip(f) {
  const cls = f.status === 'violation' && f.severity === 'warning' ? 'violation-warning' : f.status;
  return h('span', { class: `chip ${cls}` }, FINDING_LABEL[f.status] || f.status);
}

/** Chip beside a person's name: demo roles say so; real accounts just show the role. */
export const roleChip = (role) => h('span', { class: isAuthed() ? 'chip' : 'chip demo' }, isAuthed() ? roleLabel(role) : `${roleLabel(role)} · demo role`);

export const roleLabel = (role) => state.meta?.roles.find((r) => r.id === role)?.label ?? role;

const ICONS = {
  workspace: '<path d="M4 5h16v11H4zM8 20h8M12 16v4" />',
  library: '<path d="M5 4h4v16H5zM11 4h4v16h-4zM17 6l3 .8-3.5 13.2-3-.8" />',
  queue: '<path d="M4 6h16M4 12h16M4 18h10" />',
  close: '<path d="M6 6l12 12M18 6L6 18" />',
  insights: '<path d="M5 20V10M12 20V4M19 20v-7" />',
};

export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg xmlns="${ns}">${ICONS[name] || ''}</svg>`;
  for (const n of tpl.content.firstChild.childNodes) svg.append(n.cloneNode(true));
  return svg;
}

export function field(label, control, hint, id) {
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

export const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
