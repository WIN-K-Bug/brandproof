import { h, clear, api, describeError, short, STATUS_LABEL } from './ui.js';

// Read-only preview of what activating a pending source version, or withdrawing an active source, would change.
// Everything shown comes from the server's calculation on a saved snapshot. Nothing here writes, relinks or approves.

const CONTINUITY = {
  unchanged: ['Same words, same place', 'approved'],
  moved: ['Same words, one other place', 'in_review'],
  ambiguous: ['Same words, several places', 'needs_review'],
  absent: ['These words are gone', 'approval_stale'],
  not_comparable: ['Too short to match', 'draft'],
  withdrawn: ['Evidence withdrawn', 'approval_stale'],
};

const EFFECT = {
  approved_becomes_stale: 'Approved → Re-review required',
  already_stale: 'Already needs re-review',
  review_view_changes: 'In review: the reviewer’s view changes',
  draft_with_references: 'Draft that cites a dependent rule',
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sourceLink = (id, version, start, end) => `#/sources/${id}/${version}?start=${start}&end=${end}`;

/**
 * A panel that loads the preview and can be reloaded. `ctx.close` (optional) closes the dialog the panel lives in, so
 * following a link to another screen does not leave a modal open on top of it.
 * panel.ready resolves with the preview once loaded; panel.current is the preview the person is looking at.
 */
export function impactPanel({ sourceId, action, version, ctx = {} }) {
  const root = h('div', { class: 'impact', 'aria-live': 'polite' });
  const panel = {
    el: root,
    current: null,
    stale: false,
    ready: null,
    async reload() {
      panel.current = null;
      panel.stale = false;
      clear(root).append(h('p', { class: 'muted', role: 'status' }, 'Loading the impact preview… nothing is being changed.'));
      root.setAttribute('aria-busy', 'true');
      panel.ready = (async () => {
        try {
          const q = action === 'withdraw' ? 'action=withdraw' : `action=activate&version=${encodeURIComponent(version)}`;
          const p = await api('GET', `/api/sources/${encodeURIComponent(sourceId)}/impact?${q}`);
          panel.current = p;
          clear(root).append(impactBody(p, ctx));
          return p;
        } catch (e) {
          clear(root).append(
            h('div', { class: 'notice err', role: 'alert' }, h('strong', null, 'The impact preview could not be loaded. '), describeError(e), ' ', h('button', { class: 'btn small', type: 'button', onclick: () => panel.reload() }, 'Try again')),
          );
          return null;
        } finally {
          root.removeAttribute('aria-busy');
        }
      })();
      return panel.ready;
    },
    /** The server said the preview no longer matches (409 stale_preview): say so, and load the current one. */
    async markStale() {
      panel.stale = true;
      await panel.reload();
      root.prepend(h('div', { class: 'notice warn', role: 'alert' }, h('strong', null, 'The preview was out of date and has been reloaded. '), 'The source, the guidelines or a campaign changed while you were reading. Read it again before continuing.'));
    },
  };
  panel.reload();
  return panel;
}

function link(href, text, ctx) {
  return h('a', { href, onclick: () => ctx.close?.() }, text);
}

export function impactBody(p, ctx = {}) {
  const c = p.campaigns.counts;
  const activate = p.action === 'activate';
  const lead = activate
    ? `Approving ${p.source.id} version ${p.versions.candidate.n} (${p.versions.candidate.chars} characters, digest ${short(p.versions.candidate.textSha256)}…) ${p.versions.active ? `makes it the version in force, replacing version ${p.versions.active.n}${p.direction === 'replaces_newer' ? ', which is a NEWER version: this is a step back' : ''}.` : 'makes it the first version in force.'}`
    : `Withdrawing ${p.source.id} stops version ${p.versions.active.n} being evidence. Nothing is deleted.`;

  return h(
    'div',
    { class: 'impact-body' },
    h('p', { class: 'impact-lead' }, lead),
    h('p', { class: 'small muted' }, `Read-only preview of saved data: guidelines v${p.baseline.guidelineVersion}, evidence digest ${short(p.baseline.evidenceHash)}… → ${short(p.proposed.evidenceHash)}…. Nothing has been saved, relinked, approved or rewritten.`),
    !p.approvalGate.allowed ? h('div', { class: 'notice warn' }, p.approvalGate.reasons.join(' ')) : null,

    h('h3', null, 'What happens to campaigns'),
    p.proposed.evidenceChanges
      ? h(
          'ul',
          { class: 'impact-counts' },
          h('li', null, h('strong', null, plural(c.approvedNewlyStale, 'approved campaign')), ' will show Re-review required.'),
          h('li', null, h('strong', null, `${c.alreadyStale}`), ' already need re-review.'),
          h('li', null, h('strong', null, plural(c.inReviewViewChanges, 'campaign')), ` in review: the reviewer’s view changes${c.inReviewBlocked ? `, and approval stays blocked until ${plural(p.proposed.brokenLinks, 'rule link')} ${p.proposed.brokenLinks === 1 ? 'is' : 'are'} repaired` : ''}.`),
          h('li', null, h('strong', null, plural(c.draftsWithReferences, 'draft')), ` ${c.draftsWithReferences === 1 ? 'cites' : 'cite'} a rule that depends on this source.`),
          h('li', null, `${c.unaffected} of ${c.total} campaigns are unaffected.`),
        )
      : h('p', null, 'No rule or fact in the current guidelines cites this source, so no approval’s evidence binding changes. Nothing else changes for campaigns.'),
    p.proposed.evidenceChanges ? h('p', { class: 'small muted' }, 'Approvals are bound to the whole guideline and evidence set, so every approved campaign is affected, including ones with no finding from the rules below.') : null,

    h('h3', null, `Rules and facts that cite this source (${p.dependencies.length})`),
    p.dependencies.length ? p.dependencies.map((d) => dependency(p, d, ctx)) : h('p', { class: 'muted' }, 'None. Zero registered dependencies is not a statement that nothing relies on this document: see “Not covered” below.'),

    p.textChange ? textChange(p, ctx) : null,

    h('h3', null, `Campaign findings that cite those rules (${p.campaigns.references.length})`),
    p.campaigns.references.length
      ? h('ul', { class: 'impact-list' }, p.campaigns.references.map((r) => h('li', null, link(`#/workspace/${r.submissionId}`, `${r.submissionId} ${r.title}`, ctx), ` · revision ${r.revision} · `, h('span', { class: `chip ${r.status}` }, STATUS_LABEL[r.status] ?? r.status), h('div', { class: 'small muted' }, r.findings.map((f) => `${f.ruleId} ${f.status.replace('_', ' ')}${f.quote ? ` “${f.quote}”` : ''}`).join('; ')))))
      : h('p', { class: 'muted' }, 'None on the current revisions. This lists only findings that cite these rules today; it is not a prediction of future findings.'),

    p.campaigns.workflow.length
      ? [
          h('h3', null, `Campaigns whose workflow changes (${p.campaigns.workflow.length}${p.campaigns.listTruncated ? '+' : ''})`),
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'table impact-table' },
              h('caption', { class: 'sr-only' }, 'Campaigns whose workflow status changes'),
              h('thead', null, h('tr', null, ['Campaign', 'Now', 'After', 'What it means'].map((t) => h('th', { scope: 'col' }, t)))),
              h(
                'tbody',
                null,
                p.campaigns.workflow.map((w) =>
                  h('tr', null, h('td', null, link(`#/workspace/${w.submissionId}`, w.submissionId, ctx), h('div', { class: 'small muted' }, w.title)), h('td', null, h('span', { class: `chip ${w.before}` }, STATUS_LABEL[w.before] ?? w.before)), h('td', null, h('span', { class: `chip ${w.after}` }, STATUS_LABEL[w.after] ?? w.after)), h('td', { class: 'small' }, EFFECT[w.effect], w.referencesBySource ? ` · ${plural(w.referencesBySource, 'finding')} cite this source` : ' · no finding cites this source')),
                ),
              ),
            ),
          ),
        ]
      : null,

    h('h3', null, 'Not covered'),
    h(
      'ul',
      { class: 'impact-list' },
      h('li', null, `${plural(p.coverage.legacy, 'rule or fact', 'rules and facts')} still ${p.coverage.legacy === 1 ? 'has' : 'have'} a typed (legacy) source. They are not linked to any registered document, so this preview cannot say whether they rest on this one.`),
      h('li', null, `${plural(p.coverage.citingOtherSources, 'rule or fact', 'rules and facts')} cite${p.coverage.citingOtherSources === 1 ? 's' : ''} other registered sources and are not affected by this change.`),
      h('li', null, `AI source matching would search ${p.retrieval.passagesAfter} passages instead of ${p.retrieval.passagesNow}. It reports relevance only and is not part of any approval.`),
    ),
    h('p', { class: 'small muted' }, 'Equal wording is not equal meaning, and a changed passage is not proof that a claim is wrong. This preview shows exact text and does not judge.'),
  );
}

function dependency(p, d, ctx) {
  const [label, chip] = CONTINUITY[d.continuity.kind];
  const facts = [d.continuity.occurrences > 1 ? ` The words occur ${d.continuity.atLeast ? 'at least ' : ''}${d.continuity.occurrences} times in the new text.` : '', d.continuity.repeated ? ' (the same offsets match, and the words also occur elsewhere)' : ''].join('');
  return h(
    'div',
    { class: 'impact-dep' },
    h('div', { class: 'row' }, h('strong', { class: 'mono' }, d.entryId), h('span', null, d.label), h('span', { class: `chip ${chip}` }, label), h('span', { class: 'muted small' }, `linked to v${d.link.version}, characters ${d.link.start} to ${d.link.end}`)),
    h('div', { class: 'small' }, 'Cited now:'),
    h('blockquote', { class: 'quote' }, d.quote),
    d.proposedPassage ? [h('div', { class: 'small' }, `In version ${p.versions.candidate.n}${d.continuity.kind === 'moved' ? ' (moved)' : ''}:`), h('blockquote', { class: 'quote' }, d.proposedPassage.text)] : null,
    h(
      'div',
      { class: 'row small' },
      link(sourceLink(p.source.id, d.link.version, d.link.start, d.link.end), `Open the old passage (v${d.link.version})`, ctx),
      d.proposedPassage ? link(sourceLink(p.source.id, p.versions.candidate.n, d.proposedPassage.start, d.proposedPassage.end), `Open the proposed passage (v${p.versions.candidate.n})`, ctx) : null,
      link('#/library', `Repair in the Brand library`, ctx),
    ),
    h('div', { class: 'small muted' }, `${d.nextStep}${facts}`),
  );
}

function textChange(p, ctx) {
  const t = p.textChange;
  const same = !t.removedCount && !t.addedCount;
  return [
    h('h3', null, 'What changed in the text'),
    same
      ? h('p', { class: 'muted' }, 'No line was removed or added (only ordering, spacing or blank lines can differ).')
      : h(
          'ul',
          { class: 'impact-list' },
          t.removed.map((l) => h('li', null, h('span', { class: 'chip rejected' }, 'Removed'), ' ', link(sourceLink(p.source.id, p.versions.active.n, l.start, l.end), l.text, ctx))),
          t.added.map((l) => h('li', null, h('span', { class: 'chip approved' }, 'Added'), ' ', link(sourceLink(p.source.id, p.versions.candidate.n, l.start, l.end), l.text, ctx))),
          t.truncated ? h('li', { class: 'muted small' }, `Showing the first lines only: ${t.removedCount} removed and ${t.addedCount} added in all.`) : null,
        ),
    h('p', { class: 'small muted' }, 'Lines are compared as whole lines of the normalised text; moved lines can appear as removed and added.'),
  ];
}
