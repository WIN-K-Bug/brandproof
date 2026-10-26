import { h, clear, api, describeError, toast, openDialog, fmtTime, short, field, state } from './ui.js';
import { impactPanel } from './impact.js';

const MAX_FILE_BYTES = 100 * 1024;
const STATE_LABEL = { active: 'Active', pending: 'Pending review', rejected: 'Rejected', superseded: 'Replaced', withdrawn: 'Withdrawn' };
const STATE_CLASS = { active: 'approved', pending: 'in_review', rejected: 'rejected', superseded: 'approval_stale', withdrawn: 'approval_stale' };

export const stateChip = (st) => h('span', { class: `chip ${STATE_CLASS[st] ?? ''}` }, STATE_LABEL[st] ?? st);
export const sourceHref = (id, version, start, end) => `#/sources/${id}/${version}${start != null ? `?start=${start}&end=${end}` : ''}`;

const canRegister = () => ['creator', 'manager'].includes(state.role);
const isManager = () => state.role === 'manager';

export async function renderSources(root, id, version, query, go) {
  if (id) return renderDetail(root, id, version, query, go);
  const { sources, evidence } = await api('GET', '/api/sources');
  const paint = () => renderSources(root, null, null, null, go);
  clear(root).append(
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'row between' },
        h('div', null, h('h1', null, 'Sources'), h('p', { class: 'muted' }, 'Registered documents that rules and facts can cite. A new source or version is only a draft until a manager approves it; only the active approved version counts as evidence.')),
        h('button', { class: 'btn primary', type: 'button', disabled: !canRegister(), title: canRegister() ? '' : 'Only Creators and Managers register sources.', onclick: () => registerDialog(null, paint) }, '+ Register source'),
      ),
      evidence.broken.length ? h('div', { class: 'notice warn', role: 'alert' }, h('strong', null, `${evidence.broken.length} rule${evidence.broken.length === 1 ? '' : 's'} cite evidence that is no longer in force. `), 'Approvals that rest on them need re-review and nobody can approve until a manager relinks them in the ', h('a', { href: '#/library' }, 'Brand library'), '.') : null,
      h(
        'section',
        { class: 'card' },
        sources.length
          ? h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                { class: 'table' },
                h('caption', { class: 'sr-only' }, 'Registered sources'),
                h('thead', null, h('tr', null, ['Source', 'In force', 'Versions', 'Cited by', 'Registered by'].map((t) => h('th', { scope: 'col' }, t)))),
                h(
                  'tbody',
                  null,
                  sources.map((s) =>
                    h(
                      'tr',
                      null,
                      h('td', null, h('a', { class: 'title', href: `#/sources/${s.id}` }, s.title), h('div', { class: 'muted small mono' }, s.id)),
                      h('td', null, s.activeVersion ? [stateChip('active'), ` v${s.activeVersion}`] : s.withdrawn ? stateChip('withdrawn') : stateChip('pending')),
                      h('td', null, `${s.versionCount}`, s.pendingVersions ? h('span', { class: 'chip in_review' }, `${s.pendingVersions} pending`) : null),
                      h('td', null, `${s.linkedEntries} rule${s.linkedEntries === 1 ? '' : 's'}`, s.brokenLinks ? h('span', { class: 'chip violation-warning' }, `${s.brokenLinks} need relinking`) : null),
                      h('td', { class: 'small muted' }, s.createdBy.name, h('div', null, fmtTime(s.createdAt))),
                    ),
                  ),
                ),
              ),
            )
          : h('div', { class: 'empty' }, h('p', null, 'No sources registered yet.'), h('p', { class: 'small' }, 'Rules and facts in the Brand library that are not linked to a registered source are shown as “legacy”: typed by a manager, not verifiable against a document.')),
      ),
    ),
  );
}

// ---------- detail + viewer ----------

async function renderDetail(root, id, versionArg, query, go) {
  let data;
  try {
    data = await api('GET', `/api/sources/${encodeURIComponent(id)}`);
  } catch (e) {
    clear(root).append(h('div', { class: 'notice err' }, describeError(e)));
    return;
  }
  const { source: s, citedBy } = data;
  const n = Number(versionArg) || s.activeVersion || s.latestVersion;
  const vmeta = s.versions.find((v) => v.n === n);
  const paint = () => renderSources(root, id, n, query, go);
  const full = vmeta ? (await api('GET', `/api/sources/${encodeURIComponent(id)}/versions/${n}`)).version : null;
  const params = new URLSearchParams(query || '');
  const hl = params.has('start') ? { start: Number(params.get('start')), end: Number(params.get('end')) } : null;

  document.getElementById('crumb').textContent = `Sources / ${s.id}`;
  clear(root).append(
    h(
      'div',
      { class: 'stack' },
      h('a', { href: '#/sources', class: 'small' }, '← All sources'),
      h(
        'div',
        { class: 'row between' },
        h('div', { class: 'stack' }, h('div', { class: 'row' }, h('h1', null, s.title), s.activeVersion ? [stateChip('active'), h('span', { class: 'chip' }, `v${s.activeVersion} in force`)] : s.withdrawn ? stateChip('withdrawn') : stateChip('pending')), h('p', { class: 'muted small' }, `${s.id} · registered by ${s.createdBy.name} · ${fmtTime(s.createdAt)}`), s.url ? h('p', { class: 'small' }, 'Address (label only, never opened or verified): ', h('span', { class: 'mono' }, s.url)) : null),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', type: 'button', disabled: !canRegister(), onclick: () => registerDialog(s, paint) }, 'Add new version'),
          h('button', { class: 'btn danger', type: 'button', disabled: !isManager() || s.activeVersion == null, title: s.activeVersion == null ? 'Nothing is in force.' : isManager() ? '' : 'Only Managers withdraw sources.', onclick: () => withdrawDialog(s, citedBy, paint) }, 'Withdraw…'),
        ),
      ),
      citedBy.length ? h('div', { class: 'notice info' }, h('strong', null, `Cited by ${citedBy.length} rule${citedBy.length === 1 ? '' : 's'}: `), citedBy.map((c) => h('span', { class: 'tag' }, `${c.entryId} → v${c.version} ${c.state === 'active' ? '' : `(${STATE_LABEL[c.state]})`}`))) : null,
      h(
        'div',
        { class: 'ws' },
        h(
          'section',
          { class: 'card' },
          h(
            'div',
            { class: 'card-h' },
            h('h2', null, `Version ${n} text`),
            full ? stateChip(full.state) : null,
            full ? h('span', { class: 'muted small mono', title: 'SHA-256 of the normalised text (not of any original file)' }, `digest ${short(full.textSha256)}…`) : null,
          ),
          h('div', { class: 'card-b stack' }, full ? sourceText(full.text, hl) : null, hl ? h('p', { class: 'small muted' }, `Highlighted: characters ${hl.start} to ${hl.end} of version ${n}.`) : null, h('p', { class: 'small muted' }, 'Offsets count characters of this normalised text (line endings are LF, accents are composed).')),
          full && full.status === 'pending' ? reviewBar(s, full, citedBy, paint) : null,
        ),
        h(
          'div',
          { class: 'col' },
          h(
            'section',
            { class: 'card' },
            h('div', { class: 'card-h' }, h('h2', null, 'Versions')),
            h(
              'div',
              null,
              [...s.versions].reverse().map((v) =>
                h(
                  'div',
                  { class: `lib-item${v.n === n ? ' current' : ''}` },
                  h('div', { class: 'head' }, h('a', { href: `#/sources/${s.id}/${v.n}`, class: 'title' }, `Version ${v.n}`), stateChip(v.state), v.status === 'approved' && v.state !== 'active' ? h('span', { class: 'muted small' }, 'was approved') : null),
                  h('div', { class: 'small muted' }, `${v.chars} characters · ${v.origin === 'file' ? `file ${v.filename ?? ''}` : 'pasted'} · digest ${short(v.textSha256)}…`),
                  h('div', { class: 'small muted' }, `Registered by ${v.createdBy.name}, ${fmtTime(v.createdAt)}`),
                  v.note ? h('div', { class: 'small' }, `Note: ${v.note}`) : null,
                  v.reviewedBy ? h('div', { class: 'small' }, `${v.status === 'rejected' ? 'Rejected' : 'Approved'} by ${v.reviewedBy.name}, ${fmtTime(v.reviewedAt)}${v.reviewNote ? `: ${v.reviewNote}` : ''}`) : null,
                ),
              ),
            ),
          ),
          h(
            'section',
            { class: 'card' },
            h('div', { class: 'card-h' }, h('h2', null, 'History')),
            h('ol', { class: 'timeline' }, s.events.map((e) => h('li', null, h('span', { class: `pin ${e.type === 'approved' ? 'approved' : e.type === 'rejected' || e.type === 'withdrawn' ? 'rejected' : 'revision'}` }), h('div', null, h('strong', null, e.type.replaceAll('_', ' ')), ` v${e.version} by ${e.actor.name}`, h('div', { class: 'muted small' }, fmtTime(e.at)), e.note ? h('div', { class: 'small' }, e.note) : null)))),
          ),
        ),
      ),
    ),
  );
  if (hl) document.querySelector('.source-text mark')?.scrollIntoView({ block: 'center' });
}

/** Source text, with an optional highlighted span. Built from text nodes only (never parsed as markup). */
export function sourceText(text, hl) {
  const pre = h('pre', { class: 'source-text', id: 'source-text', tabindex: 0, 'aria-label': 'Source text' });
  if (hl && hl.end <= text.length && hl.start < hl.end) {
    pre.append(document.createTextNode(text.slice(0, hl.start)), h('mark', { class: 'hl info cited' }, text.slice(hl.start, hl.end)), document.createTextNode(text.slice(hl.end)));
  } else pre.append(document.createTextNode(text));
  return pre;
}

function reviewBar(s, v, citedBy, repaint) {
  const impact = citedBy.filter((c) => c.state === 'active' && c.version !== v.n);
  return h(
    'div',
    { class: 'card-b review-bar' },
    h('div', { class: 'stack' }, h('strong', null, 'Review this version'), h('p', { class: 'small muted' }, 'Read the text above. Approving makes this the version in force.', impact.length ? ` ${impact.length} rule${impact.length === 1 ? ' cites' : 's cite'} the current version and will need relinking; approvals that rest on them will show Re-review required.` : ''), h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', disabled: !isManager(), title: isManager() ? 'Read what approving would change. Nothing is saved.' : 'Only Managers can preview the impact.', onclick: () => previewDialog(s, v, repaint) }, 'Preview impact…'), h('button', { class: 'btn primary', type: 'button', disabled: !isManager(), title: isManager() ? '' : 'Only Managers approve sources.', onclick: () => approveDialog(s, v, impact, repaint) }, 'Approve version…'), h('button', { class: 'btn danger', type: 'button', disabled: !isManager(), onclick: () => rejectDialog(s, v, repaint) }, 'Reject…'))),
  );
}

function previewDialog(s, v, repaint) {
  const ctx = {};
  const panel = impactPanel({ sourceId: s.id, action: 'activate', version: v.n, ctx });
  const dialog = openDialog({
    title: `Impact preview: ${s.id} version ${v.n}`,
    wide: true,
    content: [panel.el],
    actions: [
      { label: 'Close' },
      {
        label: 'Continue to approve…',
        kind: 'primary',
        onClick: (close) => {
          close();
          approveDialog(s, v, [], repaint);
          return false;
        },
      },
    ],
  });
  ctx.close = dialog.close;
}

function approveDialog(s, v, impact, repaint) {
  const read = h('input', { type: 'checkbox', id: 'sa-read' });
  const note = h('textarea', { id: 'sa-note', rows: 2, maxLength: 500 });
  const ctx = {};
  const panel = impactPanel({ sourceId: s.id, action: 'activate', version: v.n, ctx });
  const dialog = openDialog({
    title: `Approve ${s.id} version ${v.n}`,
    wide: true,
    content: [
      h('p', null, `You are approving the exact text with digest ${short(v.textSha256)}… (${v.chars} characters). It becomes the version in force${s.activeVersion ? `, replacing version ${s.activeVersion}` : ''}.`),
      panel.el,
      h('div', { class: 'field inline' }, read, h('label', { for: 'sa-read' }, 'I have read this version of the text and the impact preview.')),
      field('Note (optional)', note, null, 'sa-note'),
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Approve',
        kind: 'primary',
        onClick: async () => {
          if (!read.checked) {
            toast('Tick the box to confirm you read the text and the impact preview.', 'err');
            return false;
          }
          const seen = await panel.ready;
          if (!seen) {
            toast('The impact preview is not loaded, so nothing was approved. Try again.', 'err');
            return false;
          }
          try {
            await api('POST', `/api/sources/${s.id}/versions/${v.n}/approve`, { expectedSha256: v.textSha256, note: note.value, previewDigest: seen.digest });
            toast('Approved. This version is now in force.', 'ok');
            await repaint();
            return true;
          } catch (e) {
            if (e.code === 'stale_preview') {
              read.checked = false;
              await panel.markStale();
              toast('The preview was out of date, so nothing was approved. Read the new preview, then approve again.', 'err');
            } else toast(describeError(e), 'err');
            return false;
          }
        },
      },
    ],
  });
  ctx.close = dialog.close;
}

function rejectDialog(s, v, repaint) {
  const note = h('textarea', { id: 'sr-note', rows: 3, maxLength: 500 });
  openDialog({
    title: `Reject ${s.id} version ${v.n}`,
    content: [field('Reason (required)', note, 'The person who registered it sees this.', 'sr-note')],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Reject',
        kind: 'danger',
        onClick: async () => {
          try {
            await api('POST', `/api/sources/${s.id}/versions/${v.n}/reject`, { note: note.value });
            toast('Rejected.', 'ok');
            await repaint();
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

function withdrawDialog(s, citedBy, repaint) {
  const note = h('textarea', { id: 'sw-note', rows: 3, maxLength: 500 });
  const read = h('input', { type: 'checkbox', id: 'sw-read' });
  const ctx = {};
  const panel = impactPanel({ sourceId: s.id, action: 'withdraw', ctx });
  const dialog = openDialog({
    title: `Withdraw ${s.id}`,
    wide: true,
    content: [
      h('p', null, `Version ${s.activeVersion} stops being evidence. Nothing is deleted: the text and its history stay.`),
      panel.el,
      h('div', { class: 'field inline' }, read, h('label', { for: 'sw-read' }, 'I have read the impact preview.')),
      field('Reason (required)', note, null, 'sw-note'),
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Withdraw source',
        kind: 'danger',
        onClick: async () => {
          if (!read.checked) {
            toast('Tick the box to confirm you read the impact preview.', 'err');
            return false;
          }
          const seen = await panel.ready;
          if (!seen) {
            toast('The impact preview is not loaded, so nothing was withdrawn. Try again.', 'err');
            return false;
          }
          try {
            await api('POST', `/api/sources/${s.id}/withdraw`, { expectedActiveVersion: s.activeVersion, note: note.value, previewDigest: seen.digest });
            toast('Source withdrawn.', 'ok');
            await repaint();
            return true;
          } catch (e) {
            if (e.code === 'stale_preview') {
              read.checked = false;
              await panel.markStale();
              toast('The preview was out of date, so nothing was withdrawn. Read the new preview, then try again.', 'err');
            } else toast(describeError(e), 'err');
            return false;
          }
        },
      },
    ],
  });
  ctx.close = dialog.close;
}

// ---------- registration (paste or small text file) ----------

function registerDialog(existing, done) {
  let origin = 'paste';
  let filename = null;
  const title = h('input', { type: 'text', id: 'rs-title', maxLength: 120, value: existing?.title ?? '', readOnly: Boolean(existing) });
  const url = h('input', { type: 'text', id: 'rs-url', maxLength: 300, placeholder: 'https://… (optional)' });
  const text = h('textarea', { id: 'rs-text', rows: 10, maxLength: 100000 });
  const note = h('textarea', { id: 'rs-note', rows: 2, maxLength: 500 });
  const fileInfo = h('span', { class: 'hint' }, 'Plain text or Markdown, UTF-8, up to 100 KB. Other formats are not read.');
  const file = h('input', {
    type: 'file',
    id: 'rs-file',
    accept: '.txt,.md,.markdown,text/plain,text/markdown',
    onchange: async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (f.size > MAX_FILE_BYTES) return toast('That file is over 100 KB.', 'err'), (e.target.value = '');
      if (!/\.(txt|md|markdown)$/i.test(f.name)) return toast('Only .txt and .md files are read in this version.', 'err'), (e.target.value = '');
      try {
        const buf = await f.arrayBuffer();
        text.value = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        origin = 'file';
        filename = f.name.slice(0, 120);
        fileInfo.textContent = `Loaded ${filename}. Review the text below before saving. The file itself is not stored, only this text.`;
      } catch {
        toast('That file is not valid UTF-8 text. Save it as UTF-8 and try again.', 'err');
        e.target.value = '';
      }
    },
  });
  openDialog({
    title: existing ? `New version of ${existing.id}` : 'Register a source',
    wide: true,
    content: [
      h('p', { class: 'small muted' }, 'This saves a DRAFT. Nothing is approved until a manager reads the text and approves this exact version. The text is stored as normalised plain text (LF line endings, composed accents).'),
      field('Title', title, null, 'rs-title'),
      existing ? null : field('Address (optional, label only)', url, 'Never opened, fetched or verified. It is only shown as a label.', 'rs-url'),
      field('Text file (optional)', file, null, 'rs-file'),
      fileInfo,
      field('Source text', text, 'Paste the wording that rules and facts will cite. Up to 100,000 characters.', 'rs-text'),
      field('Note (optional)', note, 'What changed or why it is being registered.', 'rs-note'),
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save draft',
        kind: 'primary',
        onClick: async () => {
          try {
            const body = existing ? { baseVersion: existing.latestVersion, text: text.value, origin, filename, note: note.value } : { title: title.value, url: url.value, text: text.value, origin, filename, note: note.value };
            const r = await api('POST', existing ? `/api/sources/${existing.id}/versions` : '/api/sources', body);
            toast(`Saved as a draft${existing ? ` (version ${r.source.latestVersion})` : ''}. A manager must approve it.`, 'ok');
            if (!existing) location.hash = `#/sources/${r.source.id}`;
            else await done();
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

/** Exposed for the library's passage picker: returns { start, end } of the current text selection inside `pre`, or null. */
export function selectionIn(pre) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = pre.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE || range.startContainer !== node || range.endContainer !== node) return null;
  return { start: Math.min(range.startOffset, range.endOffset), end: Math.max(range.startOffset, range.endOffset) };
}
