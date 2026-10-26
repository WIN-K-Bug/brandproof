import { h, clear, api, tabList, describeError, toast, openDialog, fmtTime, short, field, state, isAuthed } from './ui.js';
import { selectionIn } from './sources.js';

const lib = { current: null, draft: null, original: '', tab: 'terms', versions: null, sources: null, root: null };

const canEdit = () => state.role === 'manager';
const dirty = () => lib.draft && JSON.stringify(lib.draft) !== lib.original;

export async function renderLibrary(root) {
  lib.root = root;
  const data = await api('GET', '/api/guidelines');
  if (!lib.current || lib.current.version !== data.version || !dirty()) {
    lib.draft = structuredClone(data.guidelines);
    lib.original = JSON.stringify(lib.draft);
  }
  lib.current = data;
  lib.versions = (await api('GET', '/api/guidelines/versions')).versions;
  lib.sources = await api('GET', '/api/sources');
  paint();
}

function paint() {
  const g = lib.draft;
  const c = lib.current;
  const tabs = [
    ['terms', 'Terminology', g.terms.length],
    ['facts', 'Approved facts', g.facts.length],
    ['palette', 'Palette', g.palette.colors.length],
    ['settings', 'Rules & thresholds', null],
    ['versions', 'Versions', lib.versions.length],
  ];
  const body = { terms: termsTab, facts: factsTab, palette: paletteTab, settings: settingsTab, versions: versionsTab }[lib.tab]();
  clear(lib.root).append(
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'stack' },
        h('div', { class: 'row' }, h('h1', null, 'Brand library'), h('span', { class: 'chip teal' }, `${g.brand.name}${g.brand.fictional ? ' · fictional demo brand' : ''}`), h('span', { class: 'chip', title: `hash ${c.hash}` }, `Guidelines v${c.version}`)),
        h('p', { class: 'muted' }, g.brand.summary),
        canEdit() ? null : h('div', { class: 'notice info' }, isAuthed() ? 'Read-only: only people with the Manager role can edit and publish a new version.' : ['Read-only for this demo role. Switch to ', h('strong', null, 'Manager'), ' to edit and publish a new version.']),
      ),
      repairPanel(),
      dirtyBar(),
      h(
        'section',
        { class: 'card' },
        tabList({ label: 'Brand library sections', idBase: 'lib', selected: lib.tab, tabs: tabs.map(([id, label, n]) => ({ id, label, count: n })), onSelect: (id) => ((lib.tab = id), paint()) }),
        h('div', { role: 'tabpanel', id: 'lib-panel', 'aria-labelledby': `tab-lib-${lib.tab}` }, body),
      ),
    ),
  );
}

function dirtyBar() {
  if (!dirty()) return null;
  const note = h('input', { type: 'text', id: 'pub-note', maxLength: 200, placeholder: 'What changed? (optional)' });
  return h(
    'div',
    { class: 'notice warn sticky-save' },
    h(
      'div',
      { class: 'row' },
      h('strong', null, 'Unsaved changes.'),
      h('span', { class: 'grow small' }, 'Publishing creates a new guideline version. Any approval made under the old version will show “Re-review required”.'),
      note,
      h('button', { class: 'btn primary', type: 'button', onclick: () => publish(note.value) }, 'Publish new version'),
      h('button', { class: 'btn', type: 'button', onclick: () => ((lib.draft = structuredClone(lib.current.guidelines)), (lib.original = JSON.stringify(lib.draft)), paint()) }, 'Discard'),
    ),
  );
}

async function publish(note) {
  try {
    const r = await api('PUT', '/api/guidelines', { baseVersion: lib.current.version, note, guidelines: lib.draft });
    toast(`Published guidelines v${r.version}.`, 'ok');
    lib.draft = null;
    lib.current = null;
    await renderLibrary(lib.root);
  } catch (e) {
    toast(describeError(e), 'err');
  }
}

function itemActions(onEdit, onDelete) {
  if (!canEdit()) return null;
  return h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: onEdit }, 'Edit'), h('button', { class: 'btn small danger', type: 'button', onclick: onDelete }, 'Delete'));
}

function addBar(label, onAdd) {
  return canEdit() ? h('div', { class: 'card-b' }, h('button', { class: 'btn', type: 'button', onclick: onAdd }, label)) : null;
}

// ---------- terminology ----------

function termsTab() {
  const g = lib.draft;
  return h(
    'div',
    { class: 'lib-cols' },
    g.terms.map((t, i) =>
      h(
        'div',
        { class: 'lib-item' },
        h('div', { class: 'head' }, h('span', { class: 'chip' }, t.kind), h('strong', null, t.preferred ? `Use “${t.preferred}”` : `Avoid: ${t.avoid.map((a) => a.text).join(', ')}`), h('span', { class: 'mono' }, t.id ?? '(new)'), h('span', { class: `chip ${t.severity === 'error' ? 'violation' : 'violation-warning'}` }, t.severity), h('span', { class: 'grow' }), itemActions(() => termDialog(i), () => remove(g.terms, i))),
        t.avoid.length ? h('div', null, t.avoid.map((a) => h('span', { class: 'tag' }, a.replacement ? `${a.text} → ${a.replacement}` : `${a.text} (no automatic fix)`))) : null,
        t.enforceCase ? h('div', { class: 'small muted' }, 'Exact capitalisation is enforced.') : null,
        h('p', { class: 'small' }, t.reason),
        sourceBox(t.source, t),
      ),
    ),
    addBar('+ Add terminology rule', () => termDialog(null)),
  );
}

function remove(list, i) {
  list.splice(i, 1);
  paint();
}

// ---------- evidence: registered vs legacy, passage picker, repair ----------

const STATE_TEXT = { active: 'in force', superseded: 'replaced', withdrawn: 'withdrawn', missing: 'missing', pending: 'pending', rejected: 'rejected' };

/** Manifest state of a saved entry (unsaved/new ones have none yet and count as in force until published). */
const manifestOf = (entry) => lib.sources?.evidence.entries.find((x) => x.entryId === entry?.id);

function provenance(entry) {
  const s = entry.source;
  if (!s?.sourceId) return h('span', { class: 'prov' }, h('span', { class: 'chip legacy', title: 'A manager typed this label and quote. It is not linked to a registered source.' }, 'Legacy: typed, not linked'));
  const st = manifestOf(entry)?.state ?? 'active';
  return h(
    'span',
    { class: 'prov' },
    h('span', { class: 'chip registered' }, 'Registered'),
    h('a', { class: 'mono small', href: `#/sources/${s.sourceId}/${s.version}?start=${s.start}&end=${s.end}` }, `${s.sourceId} v${s.version} · ${s.start}–${s.end}`),
    st === 'active' ? null : h('span', { class: 'chip violation-warning' }, `source ${STATE_TEXT[st] ?? st}: relink required`),
  );
}

function sourceBox(s, entry) {
  const registered = Boolean(s?.sourceId);
  return h(
    'div',
    { class: 'source' },
    entry ? h('div', null, provenance(entry)) : null,
    h('div', { class: 'src-h' }, registered ? 'Cited passage' : 'Source (typed)'),
    h('div', { class: 'small' }, `${s.doc} · ${s.section}`),
    h('q', { class: 'small' }, s.quote),
  );
}

/**
 * Source section of the rule/fact dialogs: either a typed LEGACY source, or a link to an exact passage of the ACTIVE
 * approved version of a registered source. The server re-cuts the quote from the registry; the client only chooses
 * source, version and span.
 */
function sourceFields(prefix, s = { doc: '', section: '', quote: '' }) {
  const linkedNow = Boolean(s.sourceId);
  let mode = linkedNow ? 'registered' : 'legacy';
  // ----- legacy -----
  const doc = h('input', { type: 'text', id: `${prefix}-doc`, maxLength: 120, value: s.sourceId ? '' : s.doc });
  const section = h('input', { type: 'text', id: `${prefix}-sec`, maxLength: 80, value: s.sourceId ? '' : s.section });
  const quote = h('textarea', { id: `${prefix}-q`, rows: 2, maxLength: 400, value: s.sourceId ? '' : s.quote });
  const legacyBox = h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Typed by you. It will show as “Legacy: typed, not linked” because it cannot be checked against a document.'), h('div', { class: 'grid2' }, field('Source document', doc, null, `${prefix}-doc`), field('Section', section, null, `${prefix}-sec`)), field('Exact source quote', quote, 'Shown to reviewers as evidence.', `${prefix}-q`));

  // ----- registered -----
  const active = (lib.sources?.sources ?? []).filter((x) => x.activeVersion != null);
  const select = h('select', { id: `${prefix}-src`, 'aria-describedby': `${prefix}-src-hint` }, [h('option', { value: '' }, active.length ? 'Choose a source…' : 'No approved sources yet'), ...active.map((x) => h('option', { value: x.id, selected: s.sourceId === x.id }, `${x.title} (${x.id}) · version ${x.activeVersion} in force`))]);
  const startIn = h('input', { type: 'number', id: `${prefix}-start`, min: 0, step: 1 });
  const endIn = h('input', { type: 'number', id: `${prefix}-end`, min: 1, step: 1 });
  const preview = h('blockquote', { class: 'quote', 'aria-live': 'polite' }, 'No passage chosen yet.');
  const holder = h('div', { class: 'picker' });
  let loaded = null; // { sourceId, version, text }
  const refreshPreview = () => {
    if (!loaded) return;
    const a = Number(startIn.value);
    const b = Number(endIn.value);
    preview.textContent = Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= loaded.text.length ? `“${loaded.text.slice(a, b)}”` : 'Select text above, or enter a valid start and end.';
  };
  const load = async (id) => {
    clear(holder);
    loaded = null;
    if (!id) return;
    const meta = active.find((x) => x.id === id);
    const { version } = await api('GET', `/api/sources/${id}/versions/${meta.activeVersion}`);
    loaded = { sourceId: id, version: version.n, text: version.text };
    const pre = h('pre', { class: 'source-text', id: `${prefix}-pre`, tabindex: 0, 'aria-label': `Text of ${meta.title}, version ${version.n}` }, version.text);
    const use = h('button', { class: 'btn small', type: 'button', onclick: () => {
      const sel = selectionIn(pre);
      if (!sel) return toast('Select some of the text above first (drag over it).', 'err');
      startIn.value = sel.start;
      endIn.value = sel.end;
      refreshPreview();
    } }, 'Use selected passage');
    holder.append(h('p', { class: 'small muted' }, `Version ${version.n} of ${meta.title}. Select the exact passage with the mouse, or type start and end numbers (characters of this text).`), pre, h('div', { class: 'row' }, use), h('div', { class: 'grid2' }, field('Start (character)', startIn, null, `${prefix}-start`), field('End (character)', endIn, null, `${prefix}-end`)));
    if (s.sourceId === id && s.version === version.n) {
      startIn.value = s.start;
      endIn.value = s.end;
    } else {
      startIn.value = '';
      endIn.value = '';
    }
    refreshPreview();
  };
  select.addEventListener('change', () => load(select.value).catch((e) => toast(describeError(e), 'err')));
  startIn.addEventListener('input', refreshPreview);
  endIn.addEventListener('input', refreshPreview);
  const registeredBox = h(
    'div',
    { class: 'stack' },
    linkedNow ? h('div', { class: 'notice info' }, `Currently linked to ${s.sourceId} version ${s.version}, characters ${s.start} to ${s.end}. Pick a passage again to change it.`) : null,
    h('p', { class: 'small muted', id: `${prefix}-src-hint` }, 'Only the version in force can be cited. The server re-checks the passage against the approved text when you publish.'),
    field('Source', select, null, `${prefix}-src`),
    holder,
    h('div', { class: 'field' }, h('label', null, 'Passage that will be cited'), preview),
  );
  if (linkedNow) load(s.sourceId).catch(() => {});

  // ----- mode switch -----
  const radio = (value, label) => h('label', { class: 'row small' }, h('input', { type: 'radio', name: `${prefix}-mode`, value, checked: mode === value, onchange: () => { mode = value; sync(); } }), label);
  const sync = () => {
    legacyBox.hidden = mode !== 'legacy';
    registeredBox.hidden = mode !== 'registered';
  };
  sync();
  return {
    el: [h('fieldset', { class: 'field' }, h('legend', null, 'Evidence'), h('div', { class: 'row' }, radio('registered', 'Cite a registered source passage'), radio('legacy', 'Legacy: type a label and quote (not linked)'))), registeredBox, legacyBox],
    read() {
      if (mode === 'legacy') return { doc: doc.value, section: section.value, quote: quote.value };
      const a = Number(startIn.value);
      const b = Number(endIn.value);
      if (!loaded) throw new Error('Choose a source and a passage, or switch to a legacy typed source.');
      if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= loaded.text.length)) throw new Error('Choose the passage to cite: select text in the source, or enter a valid start and end.');
      return { sourceId: loaded.sourceId, version: loaded.version, start: a, end: b };
    },
  };
}

/** Rules whose cited evidence is no longer in force, with the repair actions a manager needs. */
function repairPanel() {
  const broken = lib.sources?.evidence.broken ?? [];
  if (!broken.length) return null;
  const find = (id) => {
    for (const key of ['terms', 'facts']) {
      const i = lib.draft[key].findIndex((e) => e.id === id);
      if (i >= 0) return { key, i, entry: lib.draft[key][i] };
    }
    return null;
  };
  const sameQuote = async (b) => {
    const hit = find(b.entryId);
    const src = lib.sources.sources.find((x) => x.id === b.sourceId);
    if (!hit || !src?.activeVersion) return toast('This source has no version in force. Approve a version first, or unlink the rule.', 'err');
    const { version } = await api('GET', `/api/sources/${b.sourceId}/versions/${src.activeVersion}`);
    const q = hit.entry.source.quote;
    const at = [];
    for (let from = version.text.indexOf(q); from >= 0; from = version.text.indexOf(q, from + 1)) at.push(from);
    if (at.length !== 1) return toast(at.length ? 'That quote appears more than once in the new version: choose the passage yourself.' : 'That quote is not in the new version: choose a new passage.', 'err');
    hit.entry.source = { sourceId: b.sourceId, version: version.n, start: at[0], end: at[0] + q.length, quote: q };
    toast(`Relinked ${b.entryId} to version ${version.n}. Publish to apply.`, 'ok');
    paint();
  };
  const unlink = (b) => {
    const hit = find(b.entryId);
    if (!hit) return;
    const s = hit.entry.source;
    hit.entry.source = { doc: s.doc.replace(/ \(SRC-[0-9]+\)$/, ''), section: `${s.section} (was linked to ${s.sourceId}; unlinked)`.slice(0, 80), quote: s.quote };
    toast(`${b.entryId} is now a typed legacy source. Publish to apply.`, 'ok');
    paint();
  };
  const edit = (b) => {
    const hit = find(b.entryId);
    if (!hit) return;
    hit.key === 'terms' ? termDialog(hit.i) : factDialog(hit.i);
  };
  return h(
    'div',
    { class: 'notice warn', role: 'alert' },
    h('strong', null, `${broken.length} rule${broken.length === 1 ? '' : 's'} cite${broken.length === 1 ? 's' : ''} evidence that is no longer in force. `),
    'Approvals that depend on them need re-review, and nobody can approve until a manager repairs each link and publishes. You cannot publish other guideline changes while a link is broken.',
    h(
      'ul',
      null,
      broken.map((b) =>
        h(
          'li',
          null,
          h('span', { class: 'mono' }, b.entryId),
          ` · ${b.label} · cites ${b.sourceId} v${b.version} (${STATE_TEXT[b.state] ?? b.state}) `,
          canEdit()
            ? h('span', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: () => sameQuote(b).catch((e) => toast(describeError(e), 'err')) }, 'Relink to same quote in version in force'), h('button', { class: 'btn small', type: 'button', onclick: () => edit(b) }, 'Choose passage…'), h('button', { class: 'btn small danger', type: 'button', onclick: () => unlink(b) }, 'Unlink (legacy)'))
            : null,
        ),
      ),
    ),
  );
}

const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

function termDialog(index) {
  const g = lib.draft;
  const t = index === null ? { kind: 'banned', preferred: '', enforceCase: false, avoid: [], reason: '', severity: 'warning', source: undefined } : g.terms[index];
  const kind = h('select', { id: 't-kind' }, ['naming', 'banned', 'tone'].map((k) => h('option', { value: k, selected: t.kind === k }, k)));
  const preferred = h('input', { type: 'text', id: 't-pref', maxLength: 80, value: t.preferred });
  const enforce = h('input', { type: 'checkbox', id: 't-case', checked: t.enforceCase });
  const avoid = h('textarea', { id: 't-avoid', rows: 4, value: t.avoid.map((a) => (a.replacement ? `${a.text} => ${a.replacement}` : a.text)).join('\n') });
  const reason = h('textarea', { id: 't-reason', rows: 2, maxLength: 300, value: t.reason });
  const sev = h('select', { id: 't-sev' }, ['warning', 'error'].map((k) => h('option', { value: k, selected: t.severity === k }, k === 'error' ? 'error (blocks approval)' : 'warning')));
  const src = sourceFields('t', t.source);
  openDialog({
    title: index === null ? 'Add terminology rule' : `Edit ${t.id}`,
    content: [
      h('div', { class: 'grid2' }, field('Kind', kind, null, 't-kind'), field('Severity', sev, null, 't-sev')),
      field('Preferred wording', preferred, 'Required for naming rules.', 't-pref'),
      h('div', { class: 'field inline' }, enforce, h('label', { for: 't-case' }, 'Enforce the exact capitalisation of the preferred wording')),
      field('Phrases to avoid', avoid, 'One per line. Optionally add a safe fix: “cheap => affordable”. Leave the fix out if there is no safe automatic rewrite.', 't-avoid'),
      field('Why', reason, null, 't-reason'),
      src.el,
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save to draft',
        kind: 'primary',
        onClick: () => {
          let source;
          try {
            source = src.read();
          } catch (e) {
            toast(e.message, 'err');
            return false;
          }
          const next = {
            ...(t.id ? { id: t.id } : {}),
            kind: kind.value,
            preferred: preferred.value.trim(),
            enforceCase: enforce.checked,
            avoid: avoid.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => {
                const [text, ...rest] = l.split('=>');
                return { text: text.trim(), replacement: rest.join('=>').trim() || null };
              }),
            reason: reason.value,
            severity: sev.value,
            source,
          };
          index === null ? g.terms.push(next) : (g.terms[index] = next);
          paint();
        },
      },
    ],
  });
}

// ---------- facts ----------

function factsTab() {
  const g = lib.draft;
  return h(
    'div',
    { class: 'lib-cols' },
    g.facts.map((f, i) =>
      h(
        'div',
        { class: 'lib-item' },
        h('div', { class: 'head' }, h('span', { class: 'chip' }, f.type), h('strong', null, f.label), h('span', { class: 'mono' }, f.id ?? '(new)'), h('span', { class: 'grow' }), itemActions(() => factDialog(i), () => remove(g.facts, i))),
        h('p', null, f.statement),
        f.type === 'numeric'
          ? h('div', { class: 'small muted' }, `Compares figures in “${f.unitAliases.join(' / ')}” when the same clause mentions: ${f.topicTerms.join(', ')}. Rule: ${f.claimRule === 'at-most' ? `at most ${f.value}` : `exactly ${f.value}`} ${f.unit}. ${f.conditions?.length ? `Approved condition: ${f.conditions.join('; ')}. Other wording about ${(f.conditionTerms ?? []).join(', ') || 'it'} is sent to review.` : 'No operating condition recorded: corrections to this figure are advice only.'}`)
          : h('div', { class: 'small muted' }, f.contradictedBy.length ? `Contradicted by: ${f.contradictedBy.join(', ')}. ` : '', f.confirmedBy.length ? `Confirmed by: ${f.confirmedBy.join(', ')}.` : ''),
        sourceBox(f.source, f),
      ),
    ),
    addBar('+ Add approved fact', () => factDialog(null)),
  );
}

function factDialog(index) {
  const g = lib.draft;
  const f = index === null ? { type: 'numeric', label: '', statement: '', topicTerms: [], unit: '', unitAliases: [], value: 0, claimRule: 'exact', contradictedBy: [], confirmedBy: [], source: undefined } : g.facts[index];
  const type = h('select', { id: 'f-type', onchange: () => toggle() }, ['numeric', 'statement'].map((k) => h('option', { value: k, selected: f.type === k }, k)));
  const label = h('input', { type: 'text', id: 'f-label', maxLength: 80, value: f.label });
  const statement = h('textarea', { id: 'f-stmt', rows: 2, maxLength: 300, value: f.statement });
  const topics = h('input', { type: 'text', id: 'f-topics', value: (f.topicTerms ?? []).join(', ') });
  const unit = h('input', { type: 'text', id: 'f-unit', maxLength: 20, value: f.unit ?? '' });
  const aliases = h('input', { type: 'text', id: 'f-alias', value: (f.unitAliases ?? []).join(', ') });
  const value = h('input', { type: 'number', id: 'f-val', step: 'any', value: String(f.value ?? 0) });
  const rule = h('select', { id: 'f-rule' }, [['exact', 'exactly this value'], ['at-most', 'at most this value (e.g. “up to 12 hours”)']].map(([k, l]) => h('option', { value: k, selected: f.claimRule === k }, l)));
  const conds = h('input', { type: 'text', id: 'f-conds', value: (f.conditions ?? []).join(', ') });
  const condTerms = h('input', { type: 'text', id: 'f-condterms', value: (f.conditionTerms ?? []).join(', ') });
  const contra = h('input', { type: 'text', id: 'f-contra', value: (f.contradictedBy ?? []).join(', ') });
  const confirm = h('input', { type: 'text', id: 'f-conf', value: (f.confirmedBy ?? []).join(', ') });
  const src = sourceFields('f', f.source);
  const numeric = h('div', { class: 'stack' }, field('Topic words (comma separated)', topics, 'The figure only counts when one of these is in the same clause.', 'f-topics'), h('div', { class: 'grid3' }, field('Unit', unit, null, 'f-unit'), field('Other spellings of the unit', aliases, 'comma separated', 'f-alias'), field('Value', value, null, 'f-val')), field('Copy may claim', rule, null, 'f-rule'), field('Approved operating condition (optional)', conds, 'Exact wording, e.g. “at medium brightness”. When recorded, a safe correction keeps it; when empty, corrections are advice only.', 'f-conds'), field('Words that signal a condition (optional)', condTerms, 'e.g. brightness. Copy that mentions one of these without the approved wording is sent to review.', 'f-condterms'));
  const statementBox = h('div', { class: 'stack' }, field('Phrases that contradict this fact', contra, 'comma separated, e.g. waterproof, water-resistant', 'f-contra'), field('Phrases that confirm it', confirm, 'comma separated', 'f-conf'));
  const toggle = () => {
    numeric.hidden = type.value !== 'numeric';
    statementBox.hidden = type.value !== 'statement';
  };
  toggle();
  openDialog({
    title: index === null ? 'Add approved fact' : `Edit ${f.id}`,
    content: [field('Type', type, null, 'f-type'), field('Label', label, null, 'f-label'), field('Approved statement', statement, null, 'f-stmt'), numeric, statementBox, src.el],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save to draft',
        kind: 'primary',
        onClick: () => {
          let source;
          try {
            source = src.read();
          } catch (e) {
            toast(e.message, 'err');
            return false;
          }
          const base = { ...(f.id ? { id: f.id } : {}), type: type.value, label: label.value, statement: statement.value, source };
          const next =
            type.value === 'numeric'
              ? { ...base, topicTerms: csv(topics.value), unit: unit.value.trim(), unitAliases: csv(aliases.value), value: Number(value.value), claimRule: rule.value, ...(csv(conds.value).length ? { conditions: csv(conds.value) } : {}), ...(csv(condTerms.value).length ? { conditionTerms: csv(condTerms.value) } : {}) }
              : { ...base, contradictedBy: csv(contra.value), confirmedBy: csv(confirm.value) };
          index === null ? g.facts.push(next) : (g.facts[index] = next);
          paint();
        },
      },
    ],
  });
}

// ---------- palette ----------

function paletteTab() {
  const g = lib.draft;
  return h(
    'div',
    null,
    h('div', { class: 'card-b' }, h('p', { class: 'small muted' }, `Colours are compared by perceptual distance (CIE76 ΔE). Tolerance: ${g.palette.tolerance}.`), sourceBox(g.palette.source)),
    g.palette.colors.map((c, i) => {
      const sw = h('span', { class: 'thumb' });
      sw.style.background = c.hex;
      sw.style.width = '44px';
      sw.style.height = '44px';
      sw.style.aspectRatio = '1';
      return h('div', { class: 'lib-item' }, h('div', { class: 'head' }, sw, h('strong', null, c.name), h('span', { class: 'mono' }, c.hex), h('span', { class: 'mono' }, c.id ?? '(new)'), h('span', { class: 'grow' }), itemActions(() => colorDialog(i), () => remove(g.palette.colors, i))));
    }),
    addBar('+ Add colour', () => colorDialog(null)),
  );
}

function colorDialog(index) {
  const g = lib.draft;
  const c = index === null ? { name: '', hex: '#0F2A43' } : g.palette.colors[index];
  const name = h('input', { type: 'text', id: 'c-name', maxLength: 60, value: c.name });
  const hex = h('input', { type: 'text', id: 'c-hex', maxLength: 7, value: c.hex });
  const picker = h('input', { type: 'color', id: 'c-pick', value: /^#[0-9A-F]{6}$/i.test(c.hex) ? c.hex : '#000000', oninput: (e) => (hex.value = e.target.value.toUpperCase()) });
  openDialog({
    title: index === null ? 'Add colour' : `Edit ${c.id}`,
    content: [field('Name', name, null, 'c-name'), h('div', { class: 'color-row' }, picker, field('Hex', hex, null, 'c-hex'))],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save to draft',
        kind: 'primary',
        onClick: () => {
          const next = { ...(c.id ? { id: c.id } : {}), name: name.value, hex: hex.value };
          index === null ? g.palette.colors.push(next) : (g.palette.colors[index] = next);
          paint();
        },
      },
    ],
  });
}

// ---------- settings ----------

function settingsTab() {
  const g = lib.draft;
  const ro = !canEdit();
  const num = (id, label, get, set, hint, step = 'any') =>
    field(label, h('input', { type: 'number', id, step, readOnly: ro, value: String(get()), oninput: (e) => (e.target.value !== '' && Number.isFinite(Number(e.target.value)) ? (set(Number(e.target.value)), paintDirtyOnly()) : null) }), hint, id);
  const signals = h('textarea', { id: 's-signals', rows: 6, readOnly: ro, value: g.claims.signals.join('\n'), oninput: (e) => ((g.claims.signals = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)), paintDirtyOnly()) });
  const pct = h('input', { type: 'checkbox', id: 's-pct', disabled: ro, checked: g.claims.flagPercentages, onchange: (e) => ((g.claims.flagPercentages = e.target.checked), paintDirtyOnly()) });
  return h(
    'div',
    { class: 'card-b stack' },
    h('h3', null, 'Claims that need an approved fact'),
    field('Claim words and phrases', signals, 'One per line. A claim containing one of these is flagged as unverified when no approved fact matches it.', 's-signals'),
    h('div', { class: 'field inline' }, pct, h('label', { for: 's-pct' }, 'Also flag percentages such as “99%” unless an approved fact matches')),
    sourceBox(g.claims.source),
    h('h3', null, 'Style, accessibility and palette'),
    h(
      'div',
      { class: 'grid3' },
      num('s-excl', 'Most exclamation marks per piece', () => g.style.exclamation.max, (v) => (g.style.exclamation.max = v), null, '1'),
      num('s-norm', 'Minimum contrast, normal text', () => g.accessibility.minNormal, (v) => (g.accessibility.minNormal = v), 'WCAG AA is 4.5'),
      num('s-large', 'Minimum contrast, large text', () => g.accessibility.minLarge, (v) => (g.accessibility.minLarge = v), 'WCAG AA is 3'),
      num('s-alt', 'Minimum alt-text length', () => g.altText.minLength, (v) => (g.altText.minLength = v), 'characters', '1'),
      num('s-tol', 'Palette tolerance (ΔE)', () => g.palette.tolerance, (v) => (g.palette.tolerance = v), 'Lower is stricter'),
    ),
    h('p', { class: 'muted small' }, 'The sources behind the policies above are fixed in this milestone and shown in each finding.'),
  );
}

function paintDirtyOnly() {
  const bar = lib.root.querySelector('.sticky-save');
  const next = dirtyBar();
  if (bar && next) bar.replaceWith(next);
  else if (bar && !next) bar.remove();
  else if (next) lib.root.firstChild.insertBefore(next, lib.root.firstChild.children[1]);
}

// ---------- versions ----------

function versionsTab() {
  return h(
    'div',
    null,
    lib.versions.map((v) => {
      const c = v.changes;
      const parts = c
        ? [
            ...['terms', 'facts', 'colors'].flatMap((k) => [...(c[k].added.length ? [`added ${c[k].added.join(', ')}`] : []), ...(c[k].changed.length ? [`changed ${c[k].changed.join(', ')}`] : []), ...(c[k].removed.length ? [`removed ${c[k].removed.join(', ')}`] : [])]),
            ...c.settingsChanged.map((s) => `${s} settings changed`),
          ]
        : ['first version'];
      return h(
        'div',
        { class: 'lib-item' },
        h('div', { class: 'head' }, h('strong', null, `Version ${v.version}`), v.version === lib.current.version ? h('span', { class: 'chip teal' }, 'current') : null, h('span', { class: 'mono' }, short(v.hash)), h('span', { class: 'grow' }), h('button', { class: 'btn small', type: 'button', onclick: () => viewVersion(v.version) }, 'View')),
        h('div', { class: 'small muted' }, `${v.createdBy} · ${fmtTime(v.createdAt)} · ${v.counts.terms} terms, ${v.counts.facts} facts, ${v.counts.colors} colours`),
        v.note ? h('p', { class: 'small' }, v.note) : null,
        h('div', { class: 'small' }, parts.length ? parts.join(' · ') : 'no entry changes'),
      );
    }),
  );
}

async function viewVersion(n) {
  try {
    const v = await api('GET', `/api/guidelines/versions/${n}`);
    const g = v.guidelines;
    openDialog({
      title: `Guidelines v${v.version} (read-only)`,
      wide: true,
      content: [
        h('p', { class: 'small muted' }, `${v.createdBy} · ${fmtTime(v.createdAt)}`),
        h('h3', null, `Terminology (${g.terms.length})`),
        h('ul', null, g.terms.map((t) => h('li', null, h('span', { class: 'mono' }, t.id), ' ', t.preferred ? `Use “${t.preferred}”` : `Avoid ${t.avoid.map((a) => a.text).join(', ')}`))),
        h('h3', null, `Approved facts (${g.facts.length})`),
        h('ul', null, g.facts.map((f) => h('li', null, h('span', { class: 'mono' }, f.id), ' ', f.statement))),
        h('h3', null, `Palette (${g.palette.colors.length})`),
        h('ul', null, g.palette.colors.map((c) => h('li', null, h('span', { class: 'mono' }, c.id), ` ${c.name} ${c.hex}`))),
      ],
      actions: [{ label: 'Close' }],
    });
  } catch (e) {
    toast(describeError(e), 'err');
  }
}
