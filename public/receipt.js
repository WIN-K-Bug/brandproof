import { h, fmtTime } from './ui.js';

// Decision receipts: what the server recorded as the findings of a decision at the moment it was saved ("then"), beside what today's rules and evidence say about
// exactly the same revision ("now"). Both sides come from the server (the receipt is stored data; the comparison is computed on read). The browser adds no verdict of
// its own and sends nothing: everything here is text nodes built from the saved record, so hostile text in a quote or a note stays plain text.

const STATE = { active: 'In force', superseded: 'Replaced', withdrawn: 'Withdrawn', pending: 'Pending', rejected: 'Rejected', missing: 'Missing' };
const STATUS = { supported: 'supported', contradicted: 'contradicted', violation: 'violation', needs_review: 'needs review', unverified: 'unverified' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const countsText = (c) => `${plural(c.error, 'blocking finding')}, ${plural(c.warning, 'warning')}, ${c.supported} supported, ${c.needs_review} needing review, ${c.unverified} unverified`;
const verdict = (f) => (f ? `${STATUS[f.status] ?? f.status} (${f.severity})` : 'not present');

function sourceText(s) {
  if (!s) return null;
  if (s.provenance === 'registered') return `${s.sourceId} v${s.version}, characters ${s.start} to ${s.end}, ${STATE[s.state] ?? s.state} then`;
  return `${s.doc ?? 'typed source'} (typed, not linked to a registered source)`;
}

/** The "now" half: one honest sentence, then only what changed. */
function nowBlock(e) {
  const c = e.receiptComparison;
  if (!c) return h('p', { class: 'small muted' }, e.receiptComparisonNote ?? 'No comparison with today is available for this decision.');
  const reasons = c.bindingDiffers.length ? `${c.bindingDiffers.join(', ')} changed` : null;
  let line;
  if (e.type === 'rejected') line = 'This was a rejection. The comparison below shows how today\'s rules and evidence differ from what was on screen then.';
  else if (c.appliesNow) line = 'Still applies: the saved inputs are the ones this approval covered.';
  else if (reasons) line = `No longer applies: ${reasons} since this approval, so re-review is required.`;
  else line = `This approval covered revision ${c.revision}, which is no longer the latest (revision ${c.headRevision}).`;
  const bits = [];
  if (!c.checker.same) bits.push(h('li', null, `The rules were revised: recorded with ${c.checker.then}, today ${c.checker.now}.`));
  if (c.guidelines.then !== c.guidelines.now) bits.push(h('li', null, `Guidelines v${c.guidelines.then} then, v${c.guidelines.now} now.`));
  for (const f of c.findings.changed) {
    const what = f.kind === 'new' ? 'new today' : f.kind === 'cleared' ? 'no longer reported' : 'changed';
    bits.push(h('li', null, h('span', { class: 'mono' }, f.ruleId), ` ${what}: then ${verdict(f.then)}, now ${verdict(f.now)}.`));
  }
  for (const x of c.evidence.changed) bits.push(h('li', null, h('span', { class: 'mono' }, x.entryId), ` evidence: then ${x.thenSource} ${STATE[x.then] ?? x.then}, now ${x.now}.`));
  return h(
    'div',
    { class: 'receipt-now stack' },
    h('div', { class: 'row' }, h('strong', null, 'Today'), h('span', { class: 'chip needs_review' }, 'Recomputed now')),
    h('p', { class: 'receipt-line' }, line),
    bits.length ? h('ul', { class: 'receipt-changes' }, bits) : h('p', { class: 'small muted' }, `Today's rules find the same ${c.findings.unchanged} finding${c.findings.unchanged === 1 ? '' : 's'} at the same severity, and the evidence is as it was.`),
    c.findings.partial ? h('p', { class: 'small muted' }, 'The receipt kept only the most serious findings, so findings that are new today cannot be told apart from ones it left out.') : null,
    h('p', { class: 'small muted' }, `Today: ${countsText(c.counts.now)}.`),
  );
}

/** The whole then-and-now body for one decision. Returns a plain block, to be placed in a card or inside <details>. */
export function receiptBody(e) {
  const r = e.receipt;
  if (!r) return h('p', { class: 'small muted receipt-unavailable' }, h('span', { class: 'chip legacy' }, 'Not recorded'), ' ', e.receiptNote ?? 'No receipt was recorded for this decision.');
  return h(
    'div',
    { class: 'receipt-body stack' },
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row' }, h('strong', null, 'Then'), h('span', { class: 'chip approved' }, 'Recorded'), h('span', { class: 'muted small' }, fmtTime(e.at))),
      h('p', { class: 'small muted' }, `${countsText(r.counts)}. Rules ${r.checkerRevision}.${e.type === 'approved' ? (r.acknowledgedWarnings ? ' Warnings were acknowledged.' : ' No warnings needed acknowledging.') : ''}`),
      r.findings.length
        ? h(
            'ol',
            { class: 'receipt-findings' },
            r.findings.map((f) =>
              h(
                'li',
                null,
                h('div', { class: 'row' }, h('span', { class: 'mono' }, f.ruleId), h('span', { class: `chip ${f.status}` }, STATUS[f.status] ?? f.status), h('span', { class: 'small muted' }, f.severity)),
                h('div', null, f.title),
                f.quote ? h('div', { class: 'small' }, `In the copy: “${f.quote}”`) : null,
                f.source ? h('div', { class: 'small muted' }, `Source: ${sourceText(f.source)}`) : null,
              ),
            ),
          )
        : h('p', { class: 'small muted' }, 'The rules reported no findings.'),
      r.omittedFindings ? h('p', { class: 'small muted' }, `${plural(r.omittedFindings, 'further finding')} not listed (the receipt keeps the most serious ${r.findings.length}); the counts above include them.`) : null,
      r.evidence.entries.length ? h('p', { class: 'small muted' }, `Registered evidence behind it: ${r.evidence.entries.map((x) => `${x.entryId} on ${x.sourceId} v${x.version} (${STATE[x.state] ?? x.state})`).join('; ')}.`) : h('p', { class: 'small muted' }, 'No registered source evidence was linked to the rules it used.'),
      h('p', { class: 'small muted' }, r.engine.note),
    ),
    nowBlock(e),
    h('p', { class: 'small muted' }, r.note),
  );
}

/** For a history entry: a native disclosure (keyboard and screen-reader friendly), closed until asked for. */
export function receiptDisclosure(e) {
  if (e.type !== 'approved' && e.type !== 'rejected') return null;
  if (!e.receipt) return receiptBody(e);
  const now = e.receiptComparison;
  const tag = e.type === 'approved' && now ? (now.appliesNow ? 'still applies' : 'no longer applies') : null;
  return h('details', { class: 'receipt' }, h('summary', null, 'What was checked then and what it says now', tag ? ` · ${tag}` : ''), receiptBody(e));
}
