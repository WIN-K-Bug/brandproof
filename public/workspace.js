import { h, clear, api, apiUpload, focusMainHeading, tabList, describeError, toast, openDialog, fmtTime, short, statusChip, findingChip, roleLabel, roleChip, isAuthed, field, debounce, sha256Hex, state, STATUS_LABEL } from './ui.js';

const switchHint = (what) => (isAuthed() ? `Your role cannot ${what}.` : `Switch to the Creator or Manager demo role to ${what}.`);

const MAX_TEXT = 5000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FIELD_LABEL = { text: 'Campaign copy', imageText: 'Text in the image', alt: 'Alt text', asset: 'Image details' };
const REASON_LABEL = { content: 'the copy changed', asset: 'the image details changed', imagetext: 'the confirmed text in the image changed', guideline: 'the brand guidelines changed', evidence: 'the registered source evidence changed (a cited source was replaced or withdrawn)' };

const view = {
  id: null,
  list: [],
  detail: null,
  tab: 'findings',
  mode: 'view', // view | edit | compare
  draft: null,
  draftCheck: null,
  compare: null,
  active: null, // finding index
  root: null,
  sideEl: null,
  go: null,
};

// ---------- entry ----------

export async function renderWorkspace(root, id, go) {
  view.root = root;
  view.go = go;
  view.list = (await api('GET', '/api/submissions')).submissions;
  if (!id) {
    const first = [...view.list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (first) return go(`#/workspace/${first.id}`, true);
    return paintEmpty();
  }
  if (view.id !== id) {
    view.mode = 'view';
    view.draft = null;
    view.compare = null;
    view.active = null;
    view.tab = 'findings';
  }
  view.id = id;
  if (view.detail?.id !== id) {
    sem.selected.clear();
    sem.result = null;
    sem.note = '';
  }
  await refreshSemanticStatus();
  try {
    view.detail = await api('GET', `/api/submissions/${encodeURIComponent(id)}`);
  } catch (e) {
    clear(root).append(h('div', { class: 'notice err' }, describeError(e)));
    return;
  }
  paint();
}

async function reload(detail) {
  view.list = (await api('GET', '/api/submissions')).submissions;
  view.detail = detail ?? (await api('GET', `/api/submissions/${encodeURIComponent(view.id)}`));
  paint();
}

function paintEmpty() {
  clear(view.root).append(
    h('div', { class: 'card empty' }, h('h2', null, 'No campaigns yet'), h('p', { class: 'muted' }, 'Create a submission to review campaign copy against the brand library.'), h('p', null, newButton())),
  );
}

const can = (key) => view.detail.workflow.eligibility[key]?.allowed;
const head = () => view.detail.revisions.at(-1);

// ---------- page ----------

function paint() {
  const d = view.detail;
  const root = clear(view.root);
  document.getElementById('crumb').textContent = `Workspace / ${d.id}`;
  root.append(header(), h('div', { class: 'ws' }, h('div', { class: 'col' }, ...leftColumn()), (view.sideEl = h('div', { class: 'col' }))));
  paintSide();
}

function header() {
  const d = view.detail;
  const wf = d.workflow;
  const picker = h(
    'select',
    { 'aria-label': 'Choose submission', onchange: (e) => view.go(`#/workspace/${e.target.value}`) },
    view.list.map((s) => h('option', { value: s.id, selected: s.id === d.id }, `${s.id} · ${s.title}`)),
  );
  return h(
    'div',
    { class: 'ws-head' },
    h('div', { class: 'row between' }, h('div', { class: 'row' }, h('label', { class: 'sr-only', for: 'x' }, 'Submission'), picker), h('div', { class: 'row' }, h('a', { class: 'btn', href: `#/dossier/${encodeURIComponent(d.id)}`, title: 'A readable, printable record of this campaign, with a JSON download' }, 'Review dossier'), newButton())),
    h(
      'div',
      { class: 'ws-title' },
      h('h1', { tabindex: -1 }, d.title),
      statusChip(wf.status),
      h('span', { class: 'chip' }, `Revision ${d.headRevision}`),
      h('span', { class: 'chip teal', title: `Guideline hash ${short(d.current.guidelineHash)}` }, `Guidelines v${d.current.guidelineVersion}`),
    ),
    flowBar(),
    staleNotice(),
  );
}

function newButton() {
  return h(
    'button',
    {
      class: 'btn',
      type: 'button',
      disabled: !['creator', 'manager'].includes(state.role),
      title: ['creator', 'manager'].includes(state.role) ? '' : switchHint('create a submission'),
      onclick: openNewDialog,
    },
    '+ New submission',
  );
}

function staleNotice() {
  const wf = view.detail.workflow;
  const s = wf.staleApproval;
  if (!s) return null;
  const why = s.reasons.map((r) => REASON_LABEL[r]).join(' and ');
  if (wf.status === 'approval_stale') {
    return h('div', { class: 'notice warn', role: 'alert' }, h('strong', null, 'Re-review required. '), `Revision ${s.fromRevision} was approved ${fmtTime(s.approvedAt)}, but ${why} since then, so that approval no longer applies. Request a new review before this is published.`);
  }
  return h('div', { class: 'notice warn' }, h('strong', null, 'Earlier approval no longer applies. '), `Revision ${s.fromRevision} was approved, but ${why} since then.`);
}

/**
 * The ONE primary next step for this campaign, derived only from what the server already allows and from the blocking findings:
 * with blocking findings the useful step is a new revision (change the copy, or replace the image); otherwise the decision or the review request.
 */
function nextStep() {
  const d = view.detail;
  const wf = d.workflow;
  const el = wf.eligibility;
  const blocking = d.current.findings.filter((f) => f.severity === 'error').length;
  if (wf.status === 'approved') return { blocking, primary: null };
  if (blocking > 0 && el.revise?.allowed) return { blocking, primary: 'edit' };
  if (wf.status === 'in_review') return { blocking, primary: 'approve' };
  return { blocking, primary: el.requestReview.allowed ? 'review' : null };
}

function flowBar() {
  const d = view.detail;
  const wf = d.workflow;
  const { blocking, primary } = nextStep();
  const last = [...d.events].reverse().find((e) => e.revision === d.headRevision && e.type !== 'review_requested');
  const msg = {
    draft: 'Not yet sent for review.',
    in_review: `Waiting for a reviewer decision on revision ${d.headRevision}.`,
    approved: `Approved against guidelines v${wf.binding.guidelineVersion}. The approval covers this exact copy, image details and guideline version.`,
    rejected: last?.note ? `Rejected: ${last.note}` : 'Rejected.',
    approval_stale: 'An earlier approval no longer applies.',
  }[wf.status];
  const el = wf.eligibility;
  const hint =
    wf.status === 'in_review'
      ? !el.approve.allowed
        ? el.approve.reasons[0]
        : null
      : !el.requestReview.allowed && wf.status !== 'approved'
        ? el.requestReview.reasons[0]
        : null;
  const btn = (label, gate, onclick, cls = '') =>
    h('button', { class: `btn ${cls}`, type: 'button', disabled: !gate.allowed, title: gate.allowed ? '' : gate.reasons.join(' '), onclick }, label);
  // The bar's look (and its decorative rubber stamp) follows this state; the words above it carry the meaning.
  const state = blocking ? 'blocked' : wf.status === 'draft' && primary === 'review' ? 'ready' : wf.status;
  return h(
    'div',
    { class: 'flow', 'data-state': state },
    h(
      'div',
      { class: 'grow' },
      // With blocking findings the order is: what stops approval, what to do about it, then the workflow state.
      blocking ? h('div', { class: 'lead' }, `${blocking} blocking ${blocking === 1 ? 'finding stops' : 'findings stop'} approval.`) : null,
      blocking ? h('div', null, `Fix ${blocking === 1 ? 'it' : 'them'} in a new revision: change the copy, or replace the image if the claim is printed in it.`) : h('div', null, msg),
      blocking ? h('div', { class: 'why' }, msg) : null,
      hint ? h('div', { class: 'why' }, hint) : null,
    ),
    h('div', { class: 'actions' }, primary === 'edit' ? h('button', { class: 'btn primary', type: 'button', onclick: () => startEdit() }, 'Edit as new revision') : null, btn('Request review', el.requestReview, requestReview, primary === 'review' ? 'primary' : ''), btn('Approve…', el.approve, openApprove, primary === 'approve' ? 'primary' : ''), btn('Reject…', el.reject, openReject, 'danger')),
  );
}

// ---------- workflow actions ----------

async function guarded(fn) {
  try {
    await fn();
  } catch (e) {
    if (e.status === 409) {
      toast(`${describeError(e)}`, 'err');
      await reload();
    } else toast(describeError(e), 'err');
    return false;
  }
  return true;
}

function requestReview() {
  const d = view.detail;
  return guarded(async () => {
    const r = await api('POST', `/api/submissions/${d.id}/request-review`, { revision: d.headRevision, expected: d.workflow.binding });
    toast('Review requested.', 'ok');
    await reload(r);
    focusMainHeading();
  });
}

function summaryLine() {
  const d = view.detail;
  const wf = d.workflow;
  return h(
    'p',
    { class: 'muted' },
    `Revision ${d.headRevision} · guidelines v${wf.binding.guidelineVersion} · ${wf.blockingCount} blocking · ${wf.warningCount} warning${wf.warningCount === 1 ? '' : 's'}. Your decision is recorded against exactly this copy, these image details and this guideline version.`,
  );
}

function openApprove() {
  const d = view.detail;
  const g = d.workflow.eligibility.approve;
  const note = h('textarea', { id: 'dn', rows: 3, maxLength: 500 });
  const ack = h('input', { type: 'checkbox', id: 'ack' });
  openDialog({
    title: `Approve revision ${d.headRevision}`,
    content: [
      summaryLine(),
      g.requiresAcknowledgement ? h('div', { class: 'field inline' }, ack, h('label', { for: 'ack' }, `I have reviewed the ${g.warningCount} warning${g.warningCount === 1 ? '' : 's'} and approve anyway.`)) : null,
      field('Note (optional)', note, null, 'dn'),
    ],
    actions: [
      { label: 'Cancel', closes: true },
      {
        label: 'Approve',
        kind: 'primary',
        onClick: async (close) => {
          if (g.requiresAcknowledgement && !ack.checked) {
            toast('Tick the box to confirm you reviewed the warnings.', 'err');
            return false;
          }
          const ok = await guarded(async () => {
            const r = await api('POST', `/api/submissions/${d.id}/approve`, { revision: d.headRevision, expected: d.workflow.binding, note: note.value, acknowledgeWarnings: ack.checked });
            toast('Approved. The approval is bound to this exact content and guideline version.', 'ok');
            await reload(r);
            focusMainHeading();
          });
          if (!ok) close();
          return ok ? true : false;
        },
      },
    ],
  });
}

function openReject() {
  const d = view.detail;
  const note = h('textarea', { id: 'rn', rows: 3, maxLength: 500 });
  const err = h('p', { class: 'err-text', role: 'alert' });
  openDialog({
    title: `Reject revision ${d.headRevision}`,
    content: [summaryLine(), field('Reason (required)', note, 'The creator sees this note.', 'rn'), err],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Reject',
        kind: 'danger',
        onClick: async (close) => {
          if (!note.value.trim()) {
            err.textContent = 'Please say why, so the creator can fix it.';
            err.id = 'rn-err';
            note.setAttribute('aria-invalid', 'true');
            note.setAttribute('aria-describedby', 'rn-err');
            note.focus(); // the alert is announced and the keyboard lands on the field that needs fixing
            return false;
          }
          const ok = await guarded(async () => {
            const r = await api('POST', `/api/submissions/${d.id}/reject`, { revision: d.headRevision, expected: d.workflow.binding, note: note.value });
            toast('Rejected with your note.', 'ok');
            await reload(r);
            focusMainHeading();
          });
          if (!ok) close();
          return ok ? true : false;
        },
      },
    ],
  });
}

function openNewDialog() {
  const title = h('input', { type: 'text', id: 'nt', maxLength: 120 });
  const text = h('textarea', { id: 'nx', rows: 6, maxLength: MAX_TEXT });
  openDialog({
    title: 'New submission',
    content: [field('Campaign name', title, null, 'nt'), field('Campaign copy', text, 'You can add the image details after saving.', 'nx')],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Create',
        kind: 'primary',
        onClick: async () => {
          try {
            const r = await api('POST', '/api/submissions', { title: title.value, text: text.value, asset: {} });
            toast(`${r.id} created.`, 'ok');
            view.go(`#/workspace/${r.id}`);
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

// ---------- left column ----------

function leftColumn() {
  if (view.mode === 'edit') return [editorCard()];
  if (view.mode === 'compare') return [compareCard(), assetCard()];
  return [copyCard(), assetCard(), imageTextCard()];
}

function highlighted(text, findings, fieldName = 'text') {
  const items = findings.map((f, idx) => ({ f, idx })).filter(({ f }) => f.field === fieldName && f.span);
  const cuts = new Set([0, text.length]);
  items.forEach(({ f }) => {
    cuts.add(f.span.start);
    cuts.add(f.span.end);
  });
  const pts = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [s, e] = [pts[i], pts[i + 1]];
    const cover = items.filter(({ f }) => f.span.start <= s && f.span.end >= e);
    const piece = text.slice(s, e);
    if (!cover.length) {
      out.push(piece);
      continue;
    }
    const sev = cover.some(({ f }) => f.severity === 'error') ? 'error' : cover.some(({ f }) => f.status === 'needs_review') ? 'review' : cover.some(({ f }) => f.severity === 'warning') ? 'warning' : 'info';
    const target = cover.find(({ f }) => f.severity !== 'info') ?? cover[0];
    out.push(
      h(
        'mark',
        {
          class: `hl ${sev}${view.active === target.idx ? ' active' : ''}`,
          tabindex: 0,
          role: 'button',
          'aria-label': `Show finding: ${target.f.title}`,
          onclick: () => focusFinding(target.idx),
          onkeydown: (ev) => ev.key === 'Enter' && focusFinding(target.idx),
        },
        piece,
      ),
    );
  }
  return out;
}

function focusFinding(idx) {
  view.active = idx;
  view.tab = 'findings';
  paintSide();
  document.querySelectorAll('mark.hl').forEach((m) => m.classList.remove('active'));
  document.getElementById(`finding-${idx}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function copyCard() {
  const d = view.detail;
  const rev = head();
  return h(
    'section',
    { class: 'card', 'aria-label': 'Campaign copy' },
    h(
      'div',
      { class: 'card-h' },
      h('h2', null, 'Campaign copy'),
      h('span', { class: 'muted small' }, `Revision ${rev.n} · ${rev.author.name} · ${fmtTime(rev.createdAt)}`),
      nextStep().primary === 'edit' ? null : h('button', { class: 'btn small', type: 'button', disabled: !can('revise'), title: can('revise') ? '' : switchHint('edit'), onclick: () => startEdit() }, 'Edit as new revision'),
    ),
    h(
      'div',
      { class: 'card-b stack' },
      h('div', { class: 'copy' }, highlighted(rev.text, d.current.findings)),
      h('div', { class: 'legend', 'aria-hidden': 'true' }, h('span', { class: 'l-err' }, h('i'), 'Blocking'), h('span', { class: 'l-warn' }, h('i'), 'Warning'), h('span', { class: 'l-rev' }, h('i'), 'Needs review'), h('span', { class: 'l-ok' }, h('i'), 'Consistent with an approved fact')),
    ),
  );
}

function swatch(hex, label) {
  const i = h('i');
  i.style.background = hex;
  return h('span', { class: 'swatch' }, i, label ?? hex);
}

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The retained image itself, with real alt text, size and dimensions; or an honest statement of what is NOT retained. */
function imageFigure(img, a, { rev } = {}) {
  if (img.status === 'retained') {
    const alt = a.alt?.trim() || 'Campaign image (no alt text was provided)';
    return h(
      'figure',
      { class: 'retained' },
      h('img', {
        class: 'retained-img',
        src: img.url,
        alt,
        width: img.width,
        height: img.height,
        onerror: (e) => e.target.closest('figure')?.replaceChildren(h('div', { class: 'notice err', role: 'alert' }, h('strong', null, 'This image could not be loaded. '), 'The stored file is missing or damaged. It cannot be reviewed or approved until the creator uploads the same image again.')),
      }),
      h('figcaption', { class: 'small muted' }, `${a.name} · ${img.width} × ${img.height} px · ${kb(img.bytes)} · digest ${short(img.sha256)}…`, rev ? ` · revision ${rev}` : ''),
    );
  }
  if (img.status === 'missing') return h('div', { class: 'notice err', role: 'alert' }, 'This revision refers to an image that this workspace does not hold. It cannot be shown or approved.');
  return null;
}

function assetCard() {
  const d = view.detail;
  const a = head().asset;
  const img = d.current.image;
  const hasImage = img.status !== 'none';
  const sample = a.fg && a.bg ? h('span', { class: `contrast-sample ${a.textSize === 'large' ? 'large' : ''}` }, 'Sample text Aa') : null;
  if (sample) {
    sample.style.color = a.fg;
    sample.style.background = a.bg;
  }
  const status =
    img.status === 'retained'
      ? h('span', { class: 'chip registered', title: 'The image bytes are stored in this workspace and identified by their SHA-256 digest.' }, 'Retained image')
      : img.status === 'metadata_only'
        ? h('span', { class: 'chip legacy' }, 'Metadata only: image not retained')
        : null;
  return h(
    'section',
    { class: 'card', 'aria-label': 'Campaign image' },
    h('div', { class: 'card-h' }, h('h2', null, 'Campaign image'), status),
    h(
      'div',
      { class: 'card-b stack' },
      !hasImage ? h('p', { class: 'muted' }, 'No image attached to this revision. Use “Edit as new revision” to attach a PNG.') : null,
      imageFigure(img, a),
      img.status === 'metadata_only' ? h('div', { class: 'notice warn' }, h('strong', null, 'Only details were saved. '), img.note, ' Reviewers cannot see this image. Attach the PNG in a new revision to retain it.') : null,
      hasImage
        ? h(
            'dl',
            { class: 'kv' },
            h('dt', null, 'Name'),
            h('dd', null, a.name, img.status === 'retained' ? null : a.fileSha256 ? h('span', { class: 'muted small' }, ` · browser-reported fingerprint ${short(a.fileSha256)}… (not verified)`) : null),
            h('dt', null, 'Alt text'),
            h('dd', null, a.alt || h('em', { class: 'muted' }, 'none')),
            h('dt', null, 'Text colours'),
            h('dd', null, a.fg && a.bg ? h('div', { class: 'row' }, swatch(a.fg, `text ${a.fg}`), swatch(a.bg, `background ${a.bg}`), h('span', { class: 'muted small' }, `${a.textSize} text`), sample) : h('span', { class: 'muted' }, 'not selected')),
            h('dt', null, 'Colours used'),
            h('dd', null, a.colors.length ? h('div', { class: 'swatches' }, a.colors.map((c) => swatch(c))) : h('span', { class: 'muted' }, 'none listed')),
          )
        : null,
      h('p', { class: 'muted small' }, 'Text colours and colours used are chosen by a person for this revision: typed, picked, or taken from one clicked pixel of the image. BrandProof does not evaluate the whole image’s palette, contrast or logos automatically and does not certify the whole image. Text inside the picture is covered only through a transcription a person confirms: it may start as an optional local OCR draft and must match the words and digits actually printed (see “Text in the image”).'),
    ),
  );
}

/** The confirmed transcription of the text in this revision's image, with who confirmed it and where the words came from. */
function imageTextCard() {
  const d = view.detail;
  const rev = head();
  const img = d.current.image;
  const it = rev.imageText;
  if (img.status !== 'retained' && !it) return null;
  const body = [];
  if (it) {
    const p = it.provenance ?? {};
    const origin = p.kind === 'ocr-draft' ? `Started from an automatic reading${p.edited ? ' and then corrected by the person' : ', confirmed without changes'} (the reader's own confidence heuristic was ${p.draft?.confidence ?? 'n/a'}; that is not correctness).` : p.draftUnavailable ? 'Typed by the person (an automatic reading was mentioned but is no longer held).' : 'Typed by the person.';
    body.push(
      h('div', { class: 'copy imagetext-text', id: 'imagetext-text', tabindex: 0, 'aria-label': 'Confirmed text in the image' }, it.text ? highlighted(it.text, d.current.findings, 'imageText') : h('em', { class: 'muted' }, 'The person confirmed there is no text to transcribe in this image.')),
      h('p', { class: 'small' }, `Confirmed by ${it.confirmedBy.name} on ${fmtTime(it.confirmedAt)} as their transcription of THIS image (digest ${short(it.imageSha256)}…), saved with revision ${it.confirmedInRevision ?? rev.n}${it.carriedFromRevision ? `; kept in revision ${rev.n} because the image is unchanged` : ''}.`),
      h('p', { class: 'small muted' }, origin),
      h('p', { class: 'small', id: 'imagetext-rule' }, h('strong', null, 'Match the words actually printed. '), 'Editing this transcript does not change the image. To fix a claim in the artwork, replace the image, then transcribe and confirm again.'),
      h('p', { class: 'small muted' }, 'A confirmed transcription is a person\u2019s record of what the image says. It is not verification: any text that was not transcribed is not checked, and no palette, contrast or logo evaluation of the whole image is done automatically. The transcription may have started as an optional local OCR draft; it must still match the words and digits actually printed. BrandProof cannot compare the transcript with the pixels, so a person could still type words the image does not print. That would defeat this check, which is why who confirmed it is recorded.'),
    );
  } else {
    body.push(h('p', { class: 'muted' }, 'No transcription of the text in this image has been confirmed, so the text in the image has NOT been checked.'), h('p', { class: 'small muted' }, 'Use “Edit as new revision” to read it from the image (if available) or type it, compare it with the image, and confirm it.'));
  }
  return h('section', { class: 'card', id: 'imagetext-card', 'aria-label': 'Text in the image' }, h('div', { class: 'card-h' }, h('h2', null, 'Text in the image'), it ? h('span', { class: 'chip registered', title: 'A person confirmed this transcription against this exact image.' }, 'Confirmed by a person') : h('span', { class: 'chip legacy' }, 'Not transcribed')), h('div', { class: 'card-b stack' }, body));
}

// ---------- compare ----------

async function openCompare(from, to) {
  try {
    view.compare = await api('GET', `/api/submissions/${view.id}/compare?from=${from}&to=${to}`);
    view.mode = 'compare';
    paint();
  } catch (e) {
    toast(describeError(e), 'err');
  }
}

function miniFinding(f) {
  return h('li', null, findingChip(f), ' ', f.title, f.quote ? h('span', { class: 'muted' }, ` · “${f.quote}”`) : null);
}

function compareCard() {
  const c = view.compare;
  const diff = h(
    'div',
    { class: 'diff copy' },
    c.text.map((o) => (o.type === 'add' ? h('ins', null, o.text) : o.type === 'del' ? h('del', null, o.text) : o.text)),
  );
  const list = (title, items) => (items.length ? h('div', null, h('h3', null, `${title} (${items.length})`), h('ul', null, items.map(miniFinding))) : null);
  return h(
    'section',
    { class: 'card', 'aria-label': 'Revision comparison' },
    h('div', { class: 'card-h' }, h('h2', null, `Revision ${c.from} → revision ${c.to}`), h('button', { class: 'btn small', type: 'button', onclick: () => ((view.mode = 'view'), paint()) }, 'Close comparison')),
    h(
      'div',
      { class: 'card-b stack' },
      diff,
      c.assetFields.length ? h('p', { class: 'small' }, h('strong', null, 'Image details changed: '), c.assetFields.map((f) => ({ retainedSha256: 'image file', fileSha256: 'file fingerprint', fg: 'text colour', bg: 'background colour', textSize: 'text size' }[f] ?? f)).join(', ')) : h('p', { class: 'small muted' }, 'Image details unchanged.'),
      list('Resolved', c.findings.resolved),
      list('New', c.findings.introduced),
      list('Still open', c.findings.persisting),
      h('p', { class: 'muted small' }, c.note),
    ),
  );
}

// ---------- editor ----------

function startEdit(prefillFinding) {
  const rev = head();
  const im = view.detail.current.image;
  view.draft = {
    baseRevision: rev.n,
    text: rev.text,
    asset: structuredClone(rev.asset),
    imageUrl: null,
    pick: 'none',
    // what this draft would save for the image: retained bytes, metadata only, or nothing. `seq` invalidates late uploads.
    image: { info: im.status === 'retained' ? { sha256: im.sha256, bytes: im.bytes, width: im.width, height: im.height } : null, legacy: im.status === 'metadata_only', uploading: false, error: null, note: null, keptNote: '', seq: 0 },
    // The transcription of the text in the image. `dirty` = this draft has new or edited text the person must confirm; otherwise the
    // previous confirmation is carried by the server (only while the image stays identical).
    imageText: { text: rev.imageText?.text ?? '', draftId: null, dirty: false, confirmed: Boolean(rev.imageText), carried: rev.imageText ? { by: rev.imageText.confirmedBy.name, at: rev.imageText.confirmedAt, revision: rev.imageText.confirmedInRevision ?? rev.n } : null, reading: false, error: null, note: null, pending: null, confidence: null, seq: 0, abort: null },
  };
  refreshOcrStatus();
  if (prefillFinding) applyToDraft(prefillFinding, false);
  view.mode = 'edit';
  view.draftCheck = null;
  runDraftCheck();
  paint();
  document.getElementById('draft-text')?.focus();
}

function applyToDraft(f, rerun = true) {
  const dr = view.draft;
  if (!f.correction || f.correction.type !== 'replace' || f.field !== 'text') return false;
  if (dr.text.slice(f.span.start, f.span.end) !== f.quote) {
    toast('The text has changed since this finding was made; re-check first.', 'err');
    return false;
  }
  dr.text = dr.text.slice(0, f.span.start) + f.correction.replacement + dr.text.slice(f.span.end);
  if (rerun) {
    const ta = document.getElementById('draft-text');
    if (ta) ta.value = dr.text;
    runDraftCheck();
  }
  return true;
}

// Draft checks: a response is shown only if it answers the CURRENT draft of the CURRENT campaign.
// Every edit bumps the sequence number (invalidating anything in flight) and marks the shown
// findings stale until the new answer arrives.
let draftSeq = 0;
const draftIdentity = () => JSON.stringify({ id: view.id, base: view.draft?.baseRevision, text: view.draft?.text, asset: view.draft?.asset, it: view.draft?.imageText?.text });

/** The text of the image to check in the live preview: only when the draft keeps a retained image and has some transcription. */
const draftImageText = (dr) => (dr.asset.retainedSha256 && (dr.imageText.dirty || dr.imageText.carried) ? { text: dr.imageText.text } : undefined);

async function refreshOcrStatus() {
  try {
    view.ocr = await api('GET', '/api/ocr/status');
  } catch {
    view.ocr = { state: 'unavailable', reason: 'status could not be loaded' };
  }
  if (view.mode === 'edit') view.draft?.paintImageText?.();
}

const checkDraftNow = debounce(async () => {
  const dr = view.draft;
  if (!dr || view.mode !== 'edit') return;
  const seq = draftSeq;
  const identity = draftIdentity();
  let result;
  try {
    result = await api('POST', '/api/check', { text: dr.text, asset: dr.asset, imageText: draftImageText(dr) });
  } catch (e) {
    result = { error: describeError(e) };
  }
  if (seq !== draftSeq || view.mode !== 'edit' || !view.draft || identity !== draftIdentity()) return; // stale answer: drop it
  view.draftCheck = result;
  paintSide();
}, 300);

function runDraftCheck() {
  draftSeq++;
  if (view.draftCheck && !view.draftCheck.error) view.draftCheck = { ...view.draftCheck, stale: true };
  if (view.mode === 'edit') paintSide();
  checkDraftNow();
}

function colorControl(label, id, get, set, { clearable = true } = {}) {
  const picker = h('input', { type: 'color', id, 'aria-label': `${label} colour picker` });
  const text = h('input', { type: 'text', 'aria-label': `${label} hex`, placeholder: '#RRGGBB', maxLength: 7 });
  const sync = () => {
    const v = get();
    picker.value = /^#[0-9A-F]{6}$/i.test(v || '') ? v : '#000000';
    text.value = v || '';
  };
  picker.addEventListener('input', () => {
    set(picker.value.toUpperCase());
    sync();
    runDraftCheck();
  });
  text.addEventListener('input', () => {
    const v = text.value.trim();
    if (v === '') set(null);
    else if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) set(v.startsWith('#') ? v : `#${v}`);
    else return;
    if (/^#[0-9A-F]{6}$/i.test(get() || '')) picker.value = get();
    runDraftCheck();
  });
  sync();
  const el = h('div', { class: 'field' }, h('label', { for: id }, label), h('div', { class: 'color-row' }, picker, text, clearable ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => (set(null), sync(), runDraftCheck()) }, 'Clear') : null));
  el.sync = sync;
  return el;
}

function editorCard() {
  const dr = view.draft;
  const a = dr.asset;
  const counter = h('span', { class: 'muted small' });
  const updateCounter = () => (counter.textContent = `${dr.text.length} / ${MAX_TEXT}`);
  const textArea = h('textarea', {
    id: 'draft-text',
    rows: 9,
    maxLength: MAX_TEXT,
    value: dr.text,
    oninput: (e) => {
      dr.text = e.target.value;
      updateCounter();
      runDraftCheck();
    },
  });
  updateCounter();

  const coloursEl = h('div', { class: 'row' });
  const paintColours = () => {
    clear(coloursEl);
    a.colors.forEach((c, i) => {
      const b = h('button', { type: 'button', 'aria-label': `Remove ${c}`, onclick: () => (a.colors.splice(i, 1), paintColours(), runDraftCheck()) }, '×');
      coloursEl.append(h('span', { class: 'chip-x' }, swatch(c), b));
    });
    if (!a.colors.length) coloursEl.append(h('span', { class: 'muted small' }, 'No colours listed yet.'));
  };
  paintColours();
  const addPicker = h('input', { type: 'color', id: 'add-col', 'aria-label': 'Colour to add', value: '#1B9C8F' });
  const addColor = (hex) => {
    const v = hex.toUpperCase();
    if (a.colors.length >= 12) return toast('At most 12 colours.', 'err');
    if (!a.colors.includes(v)) a.colors.push(v);
    paintColours();
    runDraftCheck();
  };

  const fg = colorControl('Text colour (foreground)', 'fg', () => a.fg, (v) => (a.fg = v));
  const bg = colorControl('Background colour', 'bg', () => a.bg, (v) => (a.bg = v));

  const canvasWrap = h('div', { class: 'canvas-wrap' });
  canvasWrap.hidden = true;
  const pickRadios = ['none', 'fg', 'bg', 'add'].map((v) =>
    h('label', null, h('input', { type: 'radio', name: 'pick', checked: dr.pick === v, onchange: () => (dr.pick = v) }), ' ', { none: 'Look only', fg: 'Pick text colour', bg: 'Pick background', add: 'Add to colours used' }[v]),
  );
  const pickBar = h('div', { class: 'picker-bar' }, h('strong', null, 'Click the image to sample a colour:'), pickRadios);
  pickBar.hidden = true;

  const drawImage = (url) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 560 / img.naturalWidth);
      const canvas = h('canvas', { 'aria-label': 'Image preview. Click to sample a colour.' });
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.addEventListener('click', (ev) => {
        if (dr.pick === 'none') return toast('Choose what to pick first (text colour, background, or colours used).');
        const r = canvas.getBoundingClientRect();
        const x = Math.floor(((ev.clientX - r.left) / r.width) * canvas.width);
        const y = Math.floor(((ev.clientY - r.top) / r.height) * canvas.height);
        const [R, G, B] = ctx.getImageData(x, y, 1, 1).data;
        const hex = '#' + [R, G, B].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
        if (dr.pick === 'fg') (a.fg = hex), fg.sync();
        else if (dr.pick === 'bg') (a.bg = hex), bg.sync();
        else addColor(hex);
        runDraftCheck();
      });
      clear(canvasWrap).append(canvas);
      canvasWrap.hidden = false;
      pickBar.hidden = false;
    };
    img.onerror = () => toast('That file could not be read as an image.', 'err');
    img.src = url;
  };

  const nameInput = h('input', { type: 'text', id: 'asset-name', maxLength: 120, value: a.name, oninput: (e) => ((a.name = e.target.value.trim()), runDraftCheck()) });
  const imageBox = h('div', { class: 'image-box', 'aria-live': 'polite' });
  const save = h('button', { class: 'btn primary', type: 'button', onclick: saveRevision }, 'Save as revision ' + (dr.baseRevision + 1));
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => ((dr.image.seq += 1), (view.mode = 'view'), (view.draft = null), paint()) }, 'Cancel');

  // What the draft would save, said plainly. Re-rendered whenever the image state changes.
  const paintImage = () => {
    const im = dr.image;
    save.disabled = im.uploading;
    save.title = im.uploading ? 'Wait for the image upload to finish.' : '';
    clear(imageBox);
    if (im.uploading) imageBox.append(h('div', { class: 'notice info', role: 'status' }, 'Uploading and checking the image… Nothing has changed yet: the draft still uses its previous image until this succeeds.'));
    if (im.error) imageBox.append(h('div', { class: 'notice err', role: 'alert' }, h('strong', null, 'The image was not saved. '), im.error, ' ', im.keptNote));
    if (im.note && !im.error) imageBox.append(h('div', { class: 'notice info', role: 'status' }, im.note));
    if (im.info) {
      imageBox.append(
        imageFigure({ status: 'retained', ...im.info, url: `/api/assets/${im.info.sha256}` }, a),
        h('div', { class: 'row' }, h('span', { class: 'chip registered' }, 'Retained image'), h('button', { class: 'btn small danger', type: 'button', onclick: removeImage }, 'Remove image from this revision')),
      );
    } else if (im.legacy && a.fileSha256) {
      imageBox.append(h('div', { class: 'notice warn' }, h('strong', null, 'Metadata only. '), 'The earlier revision saved only a file name and a browser-reported fingerprint; the image itself was not retained. Choose the PNG below to retain it.'));
    } else {
      imageBox.append(h('p', { class: 'muted small' }, 'No image is attached to this draft.'));
    }
  };

  const drawRetained = () => {
    if (dr.image.info) drawImage(`/api/assets/${dr.image.info.sha256}`);
    else {
      canvasWrap.hidden = true;
      pickBar.hidden = true;
    }
  };

  function removeImage() {
    dr.image.seq += 1; // an upload still in flight must not come back and re-attach itself
    dr.image.uploading = false;
    dr.image.error = null;
    dr.image.info = null;
    dr.image.legacy = false;
    dr.image.note = 'The image was removed from this draft. Saving creates a revision with no image; earlier revisions keep theirs.';
    a.retainedSha256 = null;
    a.fileSha256 = null;
    a.name = '';
    nameInput.value = '';
    drawRetained();
    paintImage();
    resetImageText('The image was removed.');
    runDraftCheck();
  }

  const fileInput = h('input', {
    type: 'file',
    id: 'asset-file',
    accept: 'image/png',
    onchange: async (e) => {
      const f = e.target.files?.[0];
      e.target.value = ''; // the same file can be chosen again
      if (!f) return;
      const im = dr.image;
      const mySeq = ++im.seq; // any earlier upload that is still running becomes stale
      const hadImage = Boolean(im.info);
      const previous = im.info ? `the previous image (${a.name})` : im.legacy ? 'no retained image (metadata only)' : 'no image';
      const fail = (message) => {
        if (view.draft !== dr || mySeq !== im.seq) return;
        im.uploading = false;
        im.error = message;
        im.keptNote = `The draft still has ${previous}. Choose a PNG again, or remove the image.`;
        paintImage();
      };
      im.error = null;
      im.note = null;
      if (f.size > 2 * 1024 * 1024) return fail('That file is over 2 MB.');
      let bytes;
      try {
        bytes = await f.arrayBuffer();
      } catch {
        return fail('That file could not be read.');
      }
      const head8 = new Uint8Array(bytes.slice(0, 8));
      if (![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => head8[i] === v)) return fail('That is not a PNG image. Only PNG is accepted.');
      im.uploading = true;
      paintImage();
      try {
        const r = await apiUpload('/api/assets', bytes);
        if (view.draft !== dr || mySeq !== im.seq) return; // a newer choice, a removal, a cancel or another draft: drop this late result
        const changedImage = dr.asset.retainedSha256 !== r.asset.sha256;
        im.info = r.asset;
        im.legacy = false;
        im.uploading = false;
        a.retainedSha256 = r.asset.sha256;
        a.fileSha256 = r.asset.sha256;
        a.name = f.name.slice(0, 120);
        nameInput.value = a.name;
        im.note = (r.asset.deduplicated ? 'This exact image was already retained; the draft now points at it.' : 'Image retained. The draft now uses it.') + (hadImage && a.alt.trim() ? ' The alt text was kept from the previous image: check that it still describes this one.' : '');
        drawRetained();
        paintImage();
        if (changedImage) resetImageText('The image was replaced.');
        else paintImageText();
        runDraftCheck();
      } catch (err) {
        fail(describeError(err));
      }
    },
  });
  // ----- text in the image: read (optional), correct, confirm -----
  const it = dr.imageText;
  const itStatus = h('div', { id: 'imagetext-status', 'aria-live': 'polite' });
  const itArea = h('textarea', {
    id: 'imagetext',
    rows: 4,
    maxLength: 4000,
    value: it.text,
    oninput: (e) => {
      it.text = e.target.value;
      it.dirty = true;
      it.confirmed = false;
      it.error = null;
      itConfirm.checked = false;
      paintImageText();
      runDraftCheck();
    },
  });
  const itConfirm = h('input', { type: 'checkbox', id: 'imagetext-confirm', checked: it.confirmed, onchange: (e) => ((it.confirmed = e.target.checked), paintImageText()) });
  const itRead = h('button', { class: 'btn', type: 'button', id: 'imagetext-read', onclick: () => readFromImage() }, 'Read text from image');
  const itCancel = h('button', { class: 'btn ghost', type: 'button', id: 'imagetext-cancel', onclick: () => cancelReading() }, 'Cancel reading');
  const itUse = h('button', { class: 'btn small', type: 'button', id: 'imagetext-use', onclick: () => useDraft() }, 'Replace my text with the automatic draft');
  const itBox = h('div', { class: 'imagetext-box stack' });

  function resetImageText(why) {
    it.seq += 1; // a reading still in flight can no longer attach
    it.abort?.abort();
    it.abort = null;
    const had = Boolean(it.text) || it.dirty || it.carried;
    it.text = '';
    it.draftId = null;
    it.dirty = false;
    it.confirmed = false;
    it.carried = null;
    it.reading = false;
    it.error = null;
    it.pending = null;
    it.confidence = null;
    it.note = had ? `${why} The earlier transcription belonged to the previous image, so it was removed: read or type the text of this image and confirm it.` : null;
    itArea.value = '';
    itConfirm.checked = false;
    paintImageText();
    runDraftCheck();
  }
  dr.resetImageText = resetImageText;

  function cancelReading() {
    it.seq += 1;
    it.abort?.abort();
    it.abort = null;
    it.reading = false;
    it.note = 'Reading was cancelled. Nothing was changed.';
    paintImageText();
  }

  function useDraft() {
    if (!it.pending) return;
    it.text = it.pending.text;
    it.draftId = it.pending.draftId;
    it.confidence = it.pending.confidence;
    it.pending = null;
    it.dirty = true;
    it.confirmed = false;
    itConfirm.checked = false;
    itArea.value = it.text;
    paintImageText();
    runDraftCheck();
    itArea.focus();
  }

  async function readFromImage() {
    const sha = dr.image.info?.sha256;
    if (!sha || it.reading) return;
    const mySeq = ++it.seq;
    const ac = new AbortController();
    it.abort = ac;
    it.reading = true;
    it.error = null;
    it.note = null;
    paintImageText();
    try {
      // Tie the request to the saved revision when this draft's image IS that revision's image; otherwise the digest alone identifies the bytes.
      const sameAsSaved = sha === head().asset.retainedSha256;
      const r = await api('POST', `/api/assets/${sha}/ocr`, sameAsSaved ? { submissionId: view.id, revision: dr.baseRevision } : {}, ac.signal);
      // Only an answer for THIS draft, THIS reading and THIS image may land. Anything late or for another image is dropped.
      if (view.draft !== dr || mySeq !== it.seq || dr.image.info?.sha256 !== sha || r.draft.imageSha256 !== sha) return;
      it.reading = false;
      it.abort = null;
      const d = r.draft;
      if (!it.text.trim() || !it.dirty) {
        it.text = d.text;
        it.draftId = d.draftId;
        it.confidence = d.confidence;
        it.pending = null;
        it.dirty = true;
        it.confirmed = false;
        itConfirm.checked = false;
        itArea.value = it.text;
        it.note = d.text ? 'Automatic draft read from the image. It may contain mistakes, including in numbers, and may miss text: compare it with the image, correct it, then confirm it.' : 'The reader found no text in this image. If you can see text, type it; if there is none, confirm that.';
        runDraftCheck();
      } else {
        it.pending = d;
        it.note = 'The reader produced a draft, but you already have text here, so yours was kept.';
      }
      paintImageText();
      itArea.focus();
    } catch (e) {
      if (e.aborted || view.draft !== dr || mySeq !== it.seq) return;
      it.reading = false;
      it.abort = null;
      it.error = describeError(e);
      paintImageText();
    }
  }

  function paintImageText() {
    // Re-painting moves the controls in the DOM: keep keyboard focus and the cursor exactly where the person had them.
    const keepId = itBox.contains(document.activeElement) ? document.activeElement.id : null;
    const sel = keepId === 'imagetext' ? [itArea.selectionStart, itArea.selectionEnd] : null;
    paintImageTextNow();
    if (keepId) {
      const el = document.getElementById(keepId);
      if (el && !el.disabled) {
        el.focus();
        if (sel && el === itArea) el.setSelectionRange(sel[0], sel[1]);
      }
    }
  }

  function paintImageTextNow() {
    const hasImage = Boolean(dr.image.info);
    const ocrOk = view.ocr && view.ocr.state !== 'unavailable';
    save.disabled = dr.image.uploading || it.reading;
    save.title = dr.image.uploading ? 'Wait for the image upload to finish.' : it.reading ? 'Wait for the reading to finish or cancel it.' : '';
    clear(itStatus);
    clear(itBox);
    if (!hasImage) {
      itBox.append(h('p', { class: 'muted small' }, dr.image.legacy ? 'This revision only has image details, not the image. Retain the PNG above to transcribe its text.' : 'Attach a PNG above to read or type the text it contains.'));
      return;
    }
    itRead.disabled = !ocrOk || it.reading;
    itRead.title = ocrOk ? (state.meta?.judge?.enabled ? 'Reads the text on the demo server; the image is not sent to any other service.' : 'Reads the text on this computer; nothing is sent anywhere.') : `Reading text from images is not available here${view.ocr?.reason ? `: ${view.ocr.reason}` : ''}. You can type the text instead.`;
    const carried = it.carried && !it.dirty;
    // DOM append() would turn a null into the text "null": keep only real nodes.
    itBox.append(
      ...[
      h('div', { class: 'row' }, itRead, it.reading ? itCancel : null, ocrOk ? h('span', { class: 'muted small' }, 'Local, offline reading. It gives a draft, not an answer.') : h('span', { class: 'muted small' }, 'Automatic reading is not available here. Type the text yourself.')),
      it.reading ? h('div', { class: 'notice info', role: 'status' }, (state.meta?.judge?.enabled ? 'Reading the text from the image on the demo server… it is not sent to any other service.' : 'Reading the text from the image on this computer… nothing is sent anywhere.')) : null,
      it.error ? h('div', { class: 'notice err', role: 'alert' }, h('strong', null, 'The text could not be read. '), it.error) : null,
      it.note && !it.error ? h('div', { class: 'notice info', role: 'status' }, it.note) : null,
      carried ? h('div', { class: 'notice info', role: 'status' }, `A transcription confirmed by ${it.carried.by} (revision ${it.carried.revision}) is kept because the image is unchanged. Edit it to confirm a new one.`) : null,
      field('Text in the image (your transcription)', itArea, 'Correct only what the reader misread, so that it matches the words printed in the image above. Leave it empty and confirm if the image has no text. Only what you confirm here is checked against the guidelines.', 'imagetext'),
      it.pending ? h('div', { class: 'row' }, itUse, h('span', { class: 'muted small' }, 'Your text is kept until you choose this.')) : null,
      it.confidence !== null && it.dirty && it.draftId ? h('p', { class: 'small muted' }, `Reader confidence ${it.confidence} out of 100: the engine's own heuristic, not correctness. Numbers and small or low-contrast text are the likeliest to be wrong.`) : null,
      it.dirty ? h('div', { class: 'field inline' }, itConfirm, h('label', { for: 'imagetext-confirm' }, 'I compared this text with the words printed in the image, digit by digit, and confirm that it matches them.')) : null,
      it.dirty && !it.confirmed ? h('p', { class: 'small', id: 'imagetext-needs-confirm' }, 'Confirm it to save it with this revision. Unconfirmed text is not saved.') : null,
      ].filter(Boolean),
    );
  }
  dr.paintImageText = paintImageText;
  paintImage();
  drawRetained();
  paintImageText();

  return h(
    'section',
    { class: 'card', 'aria-label': 'Edit campaign' },
    h('div', { class: 'card-h' }, h('h2', null, `Draft of revision ${dr.baseRevision + 1}`), h('span', { class: 'chip demo' }, 'unsaved'), cancel, save),
    h(
      'div',
      { class: 'card-b editor' },
      h('div', { class: 'field' }, h('label', { for: 'draft-text' }, 'Campaign copy'), textArea, counter),
      h('hr'),
      h('h3', null, 'Campaign image'),
      imageBox,
      h('div', { class: 'grid2' }, field('Choose a PNG to retain', fileInput, 'PNG only, up to 2 MB. The server checks and stores it; the revision then refers to exactly those bytes.', 'asset-file'), field('Image name (label)', nameInput, null, 'asset-name')),
      pickBar,
      canvasWrap,
      h('hr'),
      h('h3', { id: 'imagetext-h' }, 'Text in the image'),
      h('p', { class: 'small muted' }, 'Text inside the picture is checked only after a person transcribes it and confirms the transcription. BrandProof can read a draft for you, offline, but never treats it as correct or approved.'),
      h('p', { class: 'notice info', id: 'imagetext-match-printed' }, h('strong', null, 'Match the words actually printed. '), 'Editing this transcript does not change the image. To fix a claim in the artwork, replace the image, then transcribe and confirm again.'),
      itBox,
      itStatus,
      h('hr'),
      field('Alt text', h('textarea', { id: 'alt', rows: 2, maxLength: 300, value: a.alt, oninput: (e) => ((a.alt = e.target.value), runDraftCheck()) }), 'Describe what the image shows.', 'alt'),
      h(
        'div',
        { class: 'grid3' },
        fg,
        bg,
        field('Text size', h('select', { id: 'size', onchange: (e) => ((a.textSize = e.target.value), runDraftCheck()) }, h('option', { value: 'normal', selected: a.textSize === 'normal' }, 'Normal'), h('option', { value: 'large', selected: a.textSize === 'large' }, 'Large (≥ 24px, or ≥ 19px bold)')), null, 'size'),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'add-col' }, 'Colours used in the image'),
        coloursEl,
        h('div', { class: 'row' }, addPicker, h('button', { class: 'btn small', type: 'button', onclick: () => addColor(addPicker.value) }, 'Add colour')),
      ),
      h('p', { class: 'muted small' }, 'Only the colours you select here are compared with the palette and used for contrast. The findings update as you type.'),
    ),
  );
}

async function saveRevision() {
  const dr = view.draft;
  const it = dr.imageText;
  if (it.reading) return toast('Wait for the reading to finish or cancel it.', 'err');
  if (dr.asset.retainedSha256 && it.dirty && !it.confirmed) {
    toast('Confirm the transcription of the text in the image (tick the box), or clear your edits, before saving.', 'err');
    document.getElementById('imagetext-confirm')?.focus();
    return;
  }
  try {
    const body = { baseRevision: dr.baseRevision, text: dr.text, asset: dr.asset };
    // Only a person's explicit confirmation is sent. With nothing new to confirm the server carries the earlier one forward for the identical image, or none.
    if (dr.asset.retainedSha256 && it.dirty && it.confirmed) body.imageText = { text: it.text, draftId: it.draftId, confirmed: true };
    const r = await api('POST', `/api/submissions/${view.id}/revisions`, body);
    toast(`Saved revision ${r.headRevision}.`, 'ok');
    view.mode = 'view';
    view.draft = null;
    view.active = null;
    await reload(r);
    focusMainHeading();
  } catch (e) {
    toast(describeError(e), 'err');
    if (e.status === 409) toast('Your draft is still here. Copy it, reload, and re-apply.', 'err');
  }
}

// ---------- side panel ----------

function paintSide() {
  if (!view.sideEl) return;
  const hadFocus = view.sideEl.contains(document.activeElement) ? document.activeElement : null;
  const keepId = hadFocus?.id || null;
  const keepLabel = !keepId && hadFocus?.tagName === 'BUTTON' ? hadFocus.innerText.trim() : null;
  const d = view.detail;
  const editing = view.mode === 'edit';
  const tabs = [
    ['findings', editing ? 'Draft findings' : 'Findings', null],
    ['discussion', 'Discussion', d.comments.length],
    ['history', 'History', d.revisions.length],
  ];
  const body = view.tab === 'findings' ? findingsPanel() : view.tab === 'discussion' ? discussionPanel() : historyPanel();
  clear(view.sideEl).append(
    h(
      'section',
      { class: 'card' },
      tabList({ label: 'Review details', idBase: 'side', selected: view.tab, tabs: tabs.map(([id, label, n]) => ({ id, label, count: n })), onSelect: (id) => ((view.tab = id), paintSide()) }),
      h('div', { role: 'tabpanel', id: 'side-panel', 'aria-labelledby': `tab-side-${view.tab}` }, body),
    ),
  );
  if (keepId) document.getElementById(keepId)?.focus({ preventScroll: true });
  else if (keepLabel) [...view.sideEl.querySelectorAll('button')].find((b) => b.innerText.trim() === keepLabel)?.focus({ preventScroll: true });
}

function findingsPanel() {
  const editing = view.mode === 'edit';
  const src = editing ? view.draftCheck : view.detail.current;
  const engine = view.detail.current.engine;
  const wrap = h('div', null);
  wrap.append(h('div', { class: 'card-b' }, h('div', { class: 'row' }, h('span', { class: 'chip' }, engine.label), h('span', { class: 'muted small' }, engine.contextualAi.message)), editing ? h('p', { class: 'small muted' }, 'Preview of your unsaved draft against the current guidelines.') : null));
  if (!src) return (wrap.append(h('div', { class: 'empty' }, 'Checking…')), wrap);
  if (src.error) return (wrap.append(h('div', { class: 'card-b' }, h('div', { class: 'notice err' }, src.error))), wrap);

  const findings = src.findings;
  if (src.stale) wrap.append(h('div', { class: 'card-b' }, h('div', { class: 'notice info', role: 'status' }, 'Updating for your latest edit… the list below is from your previous text, so fixes are paused.')));
  const canApply = !src.stale && (editing || can('revise'));
  const onApply = (f) => {
    if (editing) {
      applyToDraft(f);
    } else {
      startEdit(f);
    }
  };
  const idx = new Map(findings.map((f, i) => [f, i]));
  const attention = findings.filter((f) => f.severity === 'error');
  const warn = findings.filter((f) => f.severity === 'warning');
  const ok = findings.filter((f) => f.severity === 'info');
  const group = (title, items) =>
    items.length ? h('div', { class: 'stack' }, h('div', { class: 'group-title' }, `${title} (${items.length})`), items.map((f) => findingCard(f, idx.get(f), { canApply, onApply, editing }))) : null;

  const list = h(
    'div',
    { class: 'findings' },
    !attention.length && !warn.length ? h('div', { class: 'notice info' }, 'No blocking issues or warnings found by the rules.') : null,
    group('Blocking', attention),
    group('Warnings and items to check', warn),
    ok.length ? h('details', { class: 'group' }, h('summary', null, `Consistent with guidelines (${ok.length})`), h('div', { class: 'stack' }, ok.map((f) => findingCard(f, idx.get(f), { canApply: false, onApply, editing })))) : null,
    src.notChecked?.length
      ? h('details', { class: 'group' }, h('summary', null, `Not checked (${src.notChecked.length})`), h('ul', null, src.notChecked.map((n) => h('li', { class: 'small' }, n.reason))))
      : null,
  );
  wrap.append(list);
  wrap.append(semanticCard());
  return wrap;
}

/** Where a finding's evidence comes from: a registered source passage (openable), or a legacy typed label. */
function sourceBox(f, srcLabel) {
  const ev = f.sourceEvidence;
  const box = h('div', { class: 'source' });
  if (ev?.provenance === 'registered') {
    const inForce = ev.state === 'active';
    box.append(
      h('div', { class: 'prov' }, h('span', { class: 'chip registered' }, 'Registered source'), h('span', { class: 'mono small' }, `${ev.sourceId} v${ev.version}`), inForce ? null : h('span', { class: 'chip violation-warning' }, ev.state === 'withdrawn' ? 'Source withdrawn: relink required' : ev.state === 'superseded' ? 'Source replaced: relink required' : 'Evidence unavailable')),
      h('div', { class: 'src-h' }, srcLabel),
      h('div', { class: 'small' }, `${f.source.doc} · ${f.source.section}`),
      h('q', { class: 'small' }, f.source.quote),
      h('a', { class: 'small', href: `#/sources/${ev.sourceId}/${ev.version}?start=${ev.start}&end=${ev.end}` }, 'Open the exact passage in the source'),
    );
  } else {
    box.append(
      ev?.provenance === 'legacy' ? h('div', { class: 'prov' }, h('span', { class: 'chip legacy' }, 'Legacy source'), h('span', { class: 'muted small' }, 'typed label and quote, not linked to a registered source')) : null,
      h('div', { class: 'src-h' }, srcLabel),
      h('div', { class: 'small' }, `${f.source.doc} · ${f.source.section}`),
      h('q', { class: 'small' }, f.source.quote),
    );
  }
  return box;
}

/** The signature of the finding: the approved fact and its exact source passage, as one annotation that ties the claim above it to its evidence. */
function evidenceBlock(f, srcLabel) {
  const facts = f.evidence.filter((e) => e.type !== 'palette-color').map((e) => h('div', { class: 'small' }, h('strong', null, e.type === 'possibly-related-fact' ? 'May relate to ' : 'Approved fact '), h('span', { class: 'mono' }, e.id), ` · ${e.statement}`));
  const src = f.source ? sourceBox(f, srcLabel) : null;
  return facts.length || src ? h('div', { class: 'evidence' }, ...facts, src) : null;
}

function findingCard(f, i, { canApply, onApply, editing }) {
  const isReplace = f.correction?.type === 'replace' && f.field === 'text';
  const srcLabel = f.status === 'unverified' ? 'Policy requiring evidence' : f.status === 'needs_review' ? 'Possibly related source' : 'Source';
  let measure = null;
  if (f.ruleKind === 'contrast' && f.measured) {
    const s = h('span', { class: 'contrast-sample' }, 'Sample text Aa');
    s.style.color = f.measured.fg;
    s.style.background = f.measured.bg;
    measure = h('div', { class: 'row' }, s, h('span', { class: 'small muted' }, `${f.measured.ratio}:1 measured · ${f.measured.required}:1 needed for ${f.measured.textSize} text`));
  } else if (f.ruleKind === 'palette' && f.measured) {
    measure = h('div', { class: 'row small' }, swatch(f.measured.color), '→ closest approved', swatch(f.measured.nearest.hex, `${f.measured.nearest.name} ${f.measured.nearest.hex}`), h('span', { class: 'muted' }, `distance ${f.measured.deltaE} (tolerance ${f.measured.tolerance})`));
  }
  return h(
    'article',
    { class: `finding sev-${f.severity} status-${f.status}${view.active === i ? ' active' : ''}`, id: `finding-${i}` },
    h('div', { class: 'row' }, findingChip(f), h('span', { class: 'mono muted' }, f.ruleId), h('span', { class: 'muted small' }, FIELD_LABEL[f.field])),
    h('h3', null, f.title),
    f.quote && f.ruleKind !== 'palette' ? h('blockquote', { class: 'quote' }, `“${f.quote}”`) : null,
    h('p', { class: 'small' }, f.explanation),
    measure,
    f.status === 'unverified' ? h('div', { class: 'evidence-none' }, h('strong', null, 'No matching approved fact was found by these checks. '), 'This is not a finding that the claim is false.') : null,
    evidenceBlock(f, srcLabel),
    f.correction
      ? h(
          'div',
          { class: 'fix' },
          f.correction.type === 'replace'
            ? [h('span', null, 'Suggested:'), h('span', { class: 'from' }, f.quote), '→', h('span', { class: 'to' }, f.correction.replacement)]
            : h('span', null, h('strong', null, 'Suggestion: '), f.correction.text),
          isReplace && canApply ? h('button', { class: 'btn small', type: 'button', onclick: () => onApply(f) }, editing ? 'Apply to draft' : 'Apply in new draft') : null,
        )
      : null,
    f.field === 'imageText'
      ? h('div', { class: 'row' }, h('button', { class: 'link-btn small', type: 'button', onclick: () => showInImageText(i) }, editing ? 'Go to the text-in-image box' : 'Show in the text in the image'))
      : null,
    !editing
      ? h('div', { class: 'row' }, h('button', { class: 'link-btn small', type: 'button', onclick: () => commentOn(f) }, 'Comment on this'))
      : null,
  );
}

function showInImageText(i) {
  if (view.mode === 'edit') {
    document.getElementById('imagetext')?.focus();
    return;
  }
  view.active = i;
  paint();
  const el = document.getElementById('imagetext-card');
  el?.scrollIntoView({ block: 'center' });
  document.getElementById('imagetext-text')?.focus();
}

function commentOn(f) {
  view.tab = 'discussion';
  view.prefill = { ruleId: f.ruleId, text: `Re ${f.ruleId} (${f.title}): ` };
  paintSide();
  document.getElementById('comment-text')?.focus();
}

function discussionPanel() {
  const d = view.detail;
  const pre = view.prefill;
  view.prefill = null;
  const text = h('textarea', { id: 'comment-text', rows: 3, maxLength: 1000, value: pre?.text ?? '' });
  const send = h(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      onclick: async () => {
        try {
          await api('POST', `/api/submissions/${d.id}/comments`, { revision: d.headRevision, text: text.value, ruleId: pre?.ruleId ?? null });
          toast('Comment added.', 'ok');
          view.tab = 'discussion';
          await reload();
        } catch (e) {
          toast(describeError(e), 'err');
        }
      },
    },
    'Add comment',
  );
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'card-b stack' },
      d.comments.length
        ? d.comments.map((c) =>
            h(
              'div',
              { class: 'comment' },
              h('div', { class: 'row small muted' }, h('strong', null, c.author.name), roleChip(c.author.role), `rev ${c.revision}`, c.ruleId ? h('span', { class: 'mono' }, c.ruleId) : null, fmtTime(c.createdAt)),
              h('p', null, c.text),
            ),
          )
        : h('p', { class: 'muted' }, 'No comments yet.'),
    ),
    h('div', { class: 'card-b stack' }, field(`Comment on revision ${d.headRevision} as ${roleLabel(state.role)}`, text, null, 'comment-text'), h('div', null, send)),
  );
}

function historyPanel() {
  const d = view.detail;
  const items = [];
  for (const r of d.revisions) {
    items.push(
      h(
        'li',
        null,
        h('span', { class: 'pin revision' }),
        h(
          'div',
          null,
          h('strong', null, `Revision ${r.n}`),
          ` saved by ${r.author.name} `,
          h('span', { class: 'muted small' }, fmtTime(r.createdAt)),
          h('div', { class: 'muted small' }, `Checked with guidelines v${r.guidelineVersion} · today’s rules find ${r.summary.error} blocking, ${r.summary.warning} warning`),
          r.image?.status === 'retained'
            ? h('a', { class: 'thumb-link', href: r.image.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open the image saved in this revision' }, h('img', { class: 'thumb-sm', src: r.image.url, alt: `Image saved in revision ${r.n}: ${r.asset.alt || r.asset.name}` }), h('span', { class: 'small' }, `${r.image.width} × ${r.image.height} px · digest ${short(r.image.sha256)}…`))
            : r.image?.status === 'metadata_only'
              ? h('div', { class: 'small' }, h('span', { class: 'chip legacy' }, 'Image not retained'), ' details only')
              : null,
          h(
            'div',
            { class: 'row' },
            r.n > 1 ? h('button', { class: 'link-btn small', type: 'button', onclick: () => openCompare(r.n - 1, r.n) }, `Compare with revision ${r.n - 1}`) : null,
            r.n < d.headRevision ? h('button', { class: 'link-btn small', type: 'button', onclick: () => openCompare(r.n, d.headRevision) }, 'Compare with latest') : null,
          ),
        ),
      ),
    );
    for (const e of d.events.filter((x) => x.revision === r.n)) {
      const verb = { review_requested: 'Review requested', approved: 'Approved', rejected: 'Rejected' }[e.type];
      items.push(
        h(
          'li',
          null,
          h('span', { class: `pin ${e.type}` }),
          h(
            'div',
            null,
            h('strong', null, verb),
            ` by ${e.actor.name} `,
            roleChip(e.actor.role),
            h('div', { class: 'muted small' }, fmtTime(e.at)),
            e.note ? h('div', { class: 'small' }, e.note) : null,
            e.type === 'approved' ? h('div', { class: 'muted small mono' }, `bound to guidelines v${e.binding.guidelineVersion} · copy ${short(e.binding.contentHash)} · image ${short(e.binding.assetHash)}`) : null,
          ),
        ),
      );
    }
  }
  return h('ol', { class: 'timeline' }, items);
}

// ---------- AI source matching (relevance only; separate from rule findings and approval) ----------

const sem = { status: null, selected: new Set(), running: false, result: null, note: '', poll: null, key: '' };
const BAND_LABEL = { relevant: 'Likely relevant', possible: 'Possibly relevant', low: 'Low relevance' };
const SEM_STATE = { ready: 'Ready', idle: 'Ready to start', loading: 'Loading model…', unavailable: 'Unavailable', error: 'Error' };

/** Identity of what the matcher would run against. A result is shown only while this is unchanged. */
const semKey = () => {
  const d = view.detail;
  return `${d.id}|${d.headRevision}|${d.workflow.binding.contentHash}|${d.workflow.binding.guidelineHash}|${d.workflow.binding.evidenceHash}`;
};

async function refreshSemanticStatus() {
  try {
    sem.status = await api('GET', '/api/semantic/status');
  } catch {
    sem.status = { state: 'error', reason: 'Could not read matcher status.' };
  }
  clearTimeout(sem.poll);
  if (sem.status.state === 'loading') {
    const was = sem.status.state;
    sem.poll = setTimeout(async () => {
      await refreshSemanticStatus();
      // Repaint only if something visible changed: an unconditional repaint would pull keyboard focus away from the user.
      if (sem.status.state !== was && view.tab === 'findings' && view.mode === 'view') paintSide();
    }, 1500);
  }
}

function semanticCard() {
  if (view.mode === 'edit') {
    return h('div', { class: 'card-b' }, h('div', { class: 'notice info' }, h('strong', null, 'AI source matching '), 'works on saved revisions only. Save this draft as a revision to match it against the approved sources.'));
  }
  const d = view.detail;
  if (sem.result && sem.result.key !== semKey()) sem.result = null; // copy or guidelines changed since: never show it
  const st = sem.status ?? { state: 'loading' };
  const usable = ['ready', 'idle', 'loading'].includes(st.state);
  const sentences = d.current.sentences;
  const head = h(
    'div',
    { class: 'row' },
    h('h3', null, 'AI source matching'),
    h('span', { class: `chip ${st.state === 'ready' || st.state === 'idle' ? 'teal' : st.state === 'loading' ? 'draft' : 'violation-warning'}` }, SEM_STATE[st.state] ?? st.state),
    st.model ? h('span', { class: 'muted small' }, `local embeddings · ${st.model.id.split('/')[1]}`) : null,
  );
  const explain = h('p', { class: 'small muted' }, 'Finds approved sources that are about the same topic as a passage, using a small model that runs on this computer. This is not generative AI review: it writes no findings and decides nothing. Contextual AI review remains unavailable.');
  const body = [head, explain];

  if (!usable) {
    body.push(h('div', { class: 'notice warn' }, h('strong', null, 'AI source matching is unavailable. '), st.reason || 'No reason reported.', ' Everything else in BrandProof works without it.'));
    return h('div', { class: 'card-b stack semantic' }, body);
  }

  const picks = sentences.slice(0, 40).map((s, i) => {
    const tooLong = s.end - s.start > 500;
    const cb = h('input', {
      type: 'checkbox',
      id: `sem-${i}`,
      checked: sem.selected.has(i),
      disabled: tooLong || (!sem.selected.has(i) && sem.selected.size >= 8),
      onchange: (e) => {
        e.target.checked ? sem.selected.add(i) : sem.selected.delete(i);
        paintSide();
      },
    });
    return h('div', { class: 'field inline' }, cb, h('label', { for: `sem-${i}` }, s.text.length > 110 ? `${s.text.slice(0, 110)}…` : s.text));
  });
  const run = h('button', { class: 'btn small primary', type: 'button', disabled: sem.running || sem.selected.size === 0, onclick: runSemantic }, sem.running ? 'Matching…' : 'Find relevant sources');
  body.push(h('div', { class: 'stack' }, h('div', { class: 'small' }, h('strong', null, `Choose up to 8 passages from revision ${d.headRevision} (saved copy)`)), picks, h('div', { class: 'row' }, run, sem.note ? h('span', { class: 'small muted', role: 'status' }, sem.note) : null)));

  if (sem.result) body.push(semanticResults(sem.result.data));
  return h('div', { class: 'card-b stack semantic' }, body);
}

function semanticResults(r) {
  const shown = r.results.map((p) => {
    const lowOnly = p.matches.every((m) => m.band === 'low');
    const list = (items) =>
      h(
        'div',
        { class: 'stack' },
        items.map((m) => {
          const bar = h('i');
          bar.style.width = `${Math.max(2, Math.round(Math.max(0, m.similarity) * 100))}%`;
          return h(
            'div',
            { class: 'source' },
            h('div', { class: 'row' }, h('span', { class: 'chip' }, m.sourceId), h('strong', { class: 'small' }, m.label), h('span', { class: 'muted small' }, m.kind), h('span', { class: 'grow' }), h('span', { class: 'small' }, BAND_LABEL[m.band])),
            h('div', { class: 'row small muted' }, h('div', { class: 'bar', 'aria-hidden': 'true' }, bar), `similarity score ${m.similarity.toFixed(3)}`),
            h('q', { class: 'small' }, m.quote),
            h('div', { class: 'muted small' }, `${m.doc} · ${m.section}`),
            m.registered ? h('a', { class: 'small', href: `#/sources/${m.registered.sourceId}/${m.registered.version}?start=${m.registered.start}&end=${m.registered.end}` }, 'Open this passage in its source') : null,
          );
        }),
      );
    return h(
      'div',
      { class: 'stack sem-passage' },
      h('blockquote', { class: 'quote' }, `“${p.text}”`),
      lowOnly ? h('p', { class: 'small' }, `No approved source looks clearly relevant to this passage (best similarity ${p.best?.toFixed(3)}).`) : null,
      lowOnly ? h('details', null, h('summary', { class: 'small' }, 'Closest sources, all low relevance'), list(p.matches)) : list(p.matches),
    );
  });
  return h(
    'div',
    { class: 'stack', 'aria-live': 'polite' },
    h('div', { class: 'group-title' }, 'Matches'),
    shown,
    h('p', { class: 'small muted' }, r.disclaimer),
    h('p', { class: 'small muted' }, `Revision ${r.revision} · guidelines v${r.guidelineVersion} · local embeddings (${r.status.model.id}) · ${r.ms} ms · approved-source embeddings ${r.sourceCacheHit ? 'reused from cache' : 'computed'}. Scores are cosine similarity, not probabilities.`),
  );
}

async function runSemantic() {
  const d = view.detail;
  const key = semKey();
  const passages = [...sem.selected].sort((a, b) => a - b).map((i) => ({ start: d.current.sentences[i].start, end: d.current.sentences[i].end }));
  sem.running = true;
  sem.note = '';
  sem.result = null;
  paintSide();
  try {
    const data = await api('POST', '/api/semantic/match', {
      submissionId: d.id,
      revision: d.headRevision,
      passages,
      expected: { contentHash: d.workflow.binding.contentHash, guidelineHash: d.workflow.binding.guidelineHash, evidenceHash: d.workflow.binding.evidenceHash },
    });
    if (key !== semKey() || view.detail !== d) {
      sem.note = 'Result discarded: the copy, revision or guidelines changed while matching. Run it again.';
    } else {
      sem.result = { key, data };
    }
  } catch (e) {
    sem.note = e.status === 409 ? `${e.message}` : e.status === 429 ? 'The matcher is busy. Try again in a moment.' : describeError(e);
    if (e.status === 409) {
      sem.running = false;
      await reload();
      sem.note = e.message;
    }
  } finally {
    sem.running = false;
    await refreshSemanticStatus();
    paintSide();
  }
}

export { STATUS_LABEL };
