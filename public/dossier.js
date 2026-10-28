import { h, clear, api, routeStamp, describeError, toast, fmtTime, short, STATUS_LABEL } from './ui.js';
import { receiptBody } from './receipt.js';

// Review dossier: a readable, printable report of ONE campaign's saved state, plus an explicit JSON download.
// Everything is added as text nodes. Nothing is sent anywhere: the download is built in the browser from what the
// server returned, and only when the person presses the button.

const SAFE_ID = /^SUB-[0-9]{1,9}$/;
const STATE = { active: 'In force', superseded: 'Replaced', withdrawn: 'Withdrawn', pending: 'Pending', rejected: 'Rejected', missing: 'Missing' };

function actorText(a) {
  return a ? `${a.name ?? 'unknown'}${a.role ? ` (${a.role})` : ''}${a.id ? `, ${a.id}` : ''}` : 'unknown';
}

const dd = (label, ...value) => [h('dt', null, label), h('dd', null, ...value)];

export function downloadName(d) {
  return SAFE_ID.test(d.campaign.id) ? `brandproof-dossier-${d.campaign.id}-rev${d.currentRevision.n}.json` : 'brandproof-dossier.json';
}

/** Build the file in the browser. The text is exactly the server's snapshot, pretty-printed. */
export function saveSnapshot(d) {
  const blob = new Blob([`${JSON.stringify(d, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: downloadName(d), hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function renderDossier(root, id) {
  const stale = routeStamp(); // an answer that arrives after the person has gone elsewhere is dropped
  let d;
  try {
    d = await api('GET', `/api/submissions/${encodeURIComponent(id)}/dossier`);
  } catch (e) {
    if (stale()) return;
    clear(root).append(h('div', { class: 'stack' }, h('a', { href: '#/workspace', class: 'small' }, '← Workspace'), h('div', { class: 'notice err', role: 'alert' }, describeError(e), ' ', h('button', { class: 'btn small', type: 'button', onclick: () => renderDossier(root, id) }, 'Try again'))));
    return;
  }
  if (stale()) return;
  document.getElementById('crumb').textContent = `Review dossier / ${d.campaign.id}`;
  document.title = `Review dossier ${d.campaign.id} · BrandProof`;
  const c = d.status.counts;
  const cur = d.currentRevision;
  const im = d.image;

  clear(root).append(
    h(
      'article',
      { class: 'dossier stack' },
      h('div', { class: 'row between no-print' }, h('a', { href: `#/workspace/${d.campaign.id}`, class: 'small' }, '← Back to the campaign'), h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Print'), h('button', { class: 'btn primary', type: 'button', id: 'dossier-download', onclick: () => (saveSnapshot(d), toast(`Saved ${downloadName(d)} to your browser's download location. Nothing was uploaded.`, 'ok')) }, 'Download JSON snapshot'))),
      h('h1', { tabindex: -1 }, `Review dossier: ${d.campaign.title}`),
      h('div', { class: 'notice warn dossier-banner', role: 'note' }, h('strong', null, `Snapshot taken ${fmtTime(d.snapshot.generatedAt)}. `), d.snapshot.outdatedNote, ' ', 'This is a factual local record, not a compliance certificate, a signature, a tamper-proof ledger or permission to publish.'),

      h(
        'section',
        { class: 'card', 'aria-labelledby': 'dz-status' },
        h('div', { class: 'card-h' }, h('h2', { id: 'dz-status' }, 'Status today')),
        h(
          'div',
          { class: 'card-b stack' },
          h('div', { class: 'row' }, h('span', { class: `chip ${d.status.workflow}` }, d.status.label), h('span', { class: 'chip' }, `Revision ${cur.n} of ${d.campaign.revisionCount}`), h('span', { class: 'chip teal' }, `Guidelines v${d.guidelines.version}`), h('span', { class: 'chip' }, d.workspace.mode === 'authenticated' ? 'Signed-in workspace' : 'Demo mode')),
          h('p', { class: 'dossier-headline' }, d.status.headline),
          d.status.currentBlocks.length ? h('div', { class: 'notice err' }, h('strong', null, 'Standing in the way today: '), h('ul', null, d.status.currentBlocks.map((b) => h('li', null, b)))) : h('p', { class: 'small muted' }, 'Nothing currently blocks approval of the saved inputs (per these checks).'),
          h('p', { class: 'small' }, `Recomputed findings today: ${c.blocking} blocking, ${c.warnings} warning${c.warnings === 1 ? '' : 's'} (${c.needsReview} needs review, ${c.unverified} unverified), ${c.supported} consistent with an approved fact. These are counts of rule findings, not a readiness score.`),
          d.status.separationOfDuties ? h('p', { class: 'small muted' }, d.status.separationOfDuties.approverWasContributor === null ? d.status.separationOfDuties.note : `Latest approver ${d.status.separationOfDuties.approverWasContributor ? 'WAS' : 'was not'} also an author of this campaign (compared by account id).`) : null,
          h('p', { class: 'small muted' }, d.workspace.identityNote),
        ),
      ),

      h(
        'section',
        { class: 'card', 'aria-labelledby': 'dz-copy' },
        h('div', { class: 'card-h' }, h('h2', { id: 'dz-copy' }, 'Copy as saved')),
        h('div', { class: 'card-b stack' }, h('pre', { class: 'dossier-text', tabindex: 0, 'aria-label': 'Saved campaign copy' }, cur.text), h('dl', { class: 'dossier-dl' }, dd('Revision', `${cur.n}, saved ${fmtTime(cur.createdAt)} by ${actorText(cur.author)}`), dd('Content digest (SHA-256)', h('span', { class: 'mono' }, cur.contentSha256)), dd('Campaign', `${d.campaign.id}, created ${fmtTime(d.campaign.createdAt)} by ${actorText(d.campaign.createdBy)}; ${d.campaign.commentCount} comment${d.campaign.commentCount === 1 ? '' : 's'} (bodies not included)`))),
      ),

      h(
        'section',
        { class: 'card', 'aria-labelledby': 'dz-image' },
        h('div', { class: 'card-h' }, h('h2', { id: 'dz-image' }, 'Image')),
        h(
          'div',
          { class: 'card-b stack' },
          h('div', { class: 'row' }, h('span', { class: `chip ${im.state === 'retained' && im.integrity === 'ok' ? 'approved' : im.state === 'none' || im.state === 'metadata_only' ? 'draft' : 'rejected'}` }, { retained: 'Retained', metadata_only: 'Metadata only', none: 'No image', registry_entry_missing: 'Not registered' }[im.state] ?? im.state), im.state === 'retained' ? h('span', { class: `chip ${im.integrity === 'ok' ? 'approved' : 'rejected'}` }, im.integrity === 'ok' ? 'Integrity verified now' : `Integrity: ${im.integrity}`) : null),
          h('p', null, im.note),
          h('dl', { class: 'dossier-dl' }, im.state === 'retained' ? [dd('Image digest (SHA-256)', h('span', { class: 'mono' }, im.sha256)), dd('Size', `${im.width} × ${im.height} pixels, ${im.bytes} bytes, ${im.mime}`), dd('Uploaded', `${fmtTime(im.uploadedAt)} by ${actorText(im.uploadedBy)}`)] : null, dd('Name and alt text as saved', `${im.name ?? '(none)'} · ${im.alt ?? '(no alt text)'}`), im.browserReportedFingerprint ? dd('Browser-reported fingerprint', h('span', { class: 'mono' }, im.browserReportedFingerprint.value), ` (${im.browserReportedFingerprint.note})`) : null),
          h('p', { class: 'small muted' }, im.coloursNote),
        ),
      ),

      imageTextSection(d),

      h(
        'section',
        { class: 'card', 'aria-labelledby': 'dz-evidence' },
        h('div', { class: 'card-h' }, h('h2', { id: 'dz-evidence' }, 'Guidelines and evidence in force')),
        h(
          'div',
          { class: 'card-b stack' },
          h('dl', { class: 'dossier-dl' }, dd('Guidelines', `version ${d.guidelines.version}, published ${fmtTime(d.guidelines.createdAt)}${d.guidelines.createdBy ? ` by ${d.guidelines.createdBy}` : ''}`), dd('Guideline hash', h('span', { class: 'mono' }, d.guidelines.hash)), dd('Evidence hash', h('span', { class: 'mono' }, d.evidence.hash)), dd('Entries', `${d.evidence.linkedEntries} linked to registered sources, ${d.evidence.legacyEntries} legacy (typed, not linked)`)),
          d.evidence.entries.length
            ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'sr-only' }, 'Rules and facts linked to registered sources'), h('thead', null, h('tr', null, ['Rule or fact', 'Source version', 'Passage', 'State'].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', null, d.evidence.entries.map((e) => h('tr', null, h('td', null, h('span', { class: 'mono' }, e.entryId), ' ', e.label), h('td', null, `${e.sourceId} v${e.version}`), h('td', null, h('a', { href: `#/sources/${e.sourceId}/${e.version}?start=${e.start}&end=${e.end}` }, `characters ${e.start} to ${e.end}`)), h('td', null, h('span', { class: `chip ${e.state === 'active' ? 'approved' : 'approval_stale'}` }, STATE[e.state] ?? e.state)))))))
            : h('p', { class: 'muted' }, 'No rule or fact is linked to a registered source.'),
          h('p', { class: 'small muted' }, d.evidence.note),
        ),
      ),

      h(
        'section',
        { class: 'card', 'aria-labelledby': 'dz-events' },
        h('div', { class: 'card-h' }, h('h2', { id: 'dz-events' }, 'Recorded decisions'), h('span', { class: 'chip' }, 'Recorded')),
        h(
          'div',
          { class: 'card-b stack' },
          h('p', { class: 'small muted' }, d.recordedEvents.note),
          d.recordedEvents.events.length
            ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'sr-only' }, 'Recorded review events'), h('thead', null, h('tr', null, ['When', 'Event', 'Who', 'Revision', 'Bound to', 'Against the saved inputs now'].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', null, d.recordedEvents.events.map((e) => h('tr', null, h('td', { class: 'small' }, fmtTime(e.at)), h('td', null, e.type.replaceAll('_', ' '), e.note ? h('div', { class: 'small muted' }, `Note: ${e.note}`) : null), h('td', { class: 'small' }, actorText(e.actor)), h('td', null, e.revision ?? ''), h('td', { class: 'small mono' }, e.binding ? `content ${short(e.binding.contentHash)}… image ${short(e.binding.assetHash)}… guidelines v${e.binding.guidelineVersion} ${short(e.binding.guidelineHash)}… evidence ${short(e.binding.evidenceHash ?? '')}…` : '—'), h('td', null, e.bindingComparedWithCurrentInputs ? (e.bindingComparedWithCurrentInputs.matches ? 'Still matches' : `Differs: ${e.bindingComparedWithCurrentInputs.differs.join(', ')} changed`) : '—'))))))
            : h('p', { class: 'muted' }, 'No review has been requested or decided.'),
          d.recordedEvents.truncated ? h('p', { class: 'small muted' }, 'Only the most recent events are listed.') : null,
          h('h3', { class: 'receipt-section-h', id: 'dz-receipts' }, 'Decision receipts: recorded then, recomputed now'),
          h('p', { class: 'small muted' }, `${d.recordedEvents.receipts.recorded} recorded, ${d.recordedEvents.receipts.unavailable} not recorded (made before receipts existed). ${d.recordedEvents.receipts.note}`),
          d.recordedEvents.events.some((e) => e.receiptStatus)
            ? d.recordedEvents.events.filter((e) => e.receiptStatus).map((e) => h('div', { class: 'receipt-item stack' }, h('h4', { class: 'receipt-h' }, `${e.type === 'approved' ? 'Approved' : 'Rejected'} on revision ${e.revision}`, h('span', { class: 'muted small' }, ` ${e.id} by ${actorText(e.actor)}, ${fmtTime(e.at)}`)), receiptBody(e)))
            : h('p', { class: 'muted' }, 'No decision has been recorded yet.'),
        ),
      ),

      h(
        'section',
        { class: 'card', 'aria-labelledby': 'dz-findings' },
        h('div', { class: 'card-h' }, h('h2', { id: 'dz-findings' }, `Findings recomputed today (${d.recomputedFindings.findings.length})`), h('span', { class: 'chip needs_review' }, 'Recomputed')),
        h(
          'div',
          { class: 'card-b stack' },
          h('p', { class: 'small muted' }, d.recomputedFindings.note),
          d.recomputedFindings.findings.length ? h('ol', { class: 'dossier-findings' }, d.recomputedFindings.findings.map((f) => finding(f))) : h('p', { class: 'muted' }, 'The rules produced no findings for the saved inputs.'),
          d.recomputedFindings.notChecked.length ? h('details', null, h('summary', null, `Not checked (${d.recomputedFindings.notChecked.length})`), h('ul', null, d.recomputedFindings.notChecked.map((n) => h('li', { class: 'small' }, n.reason)))) : null,
        ),
      ),

      h(
        'section',
        { class: 'card', 'aria-labelledby': 'dz-excerpts' },
        h('div', { class: 'card-h' }, h('h2', { id: 'dz-excerpts' }, `Cited source passages (${d.sourceExcerpts.length})`)),
        h(
          'div',
          { class: 'card-b stack' },
          h('p', { class: 'small muted' }, d.links.note),
          d.sourceExcerpts.length
            ? d.sourceExcerpts.map((x) => h('div', { class: 'lib-item dossier-excerpt' }, h('div', { class: 'head' }, h('strong', null, x.title ?? x.sourceId), h('span', { class: 'mono' }, `${x.sourceId} v${x.version}`), h('span', { class: `chip ${x.versionState === 'active' ? 'approved' : 'approval_stale'}` }, STATE[x.versionState] ?? x.versionState), h('span', { class: 'muted small' }, `cited by ${x.citedBy.join(', ')}`)), h('blockquote', { class: 'quote' }, x.excerpt ?? '(passage unavailable)'), h('div', { class: 'small muted' }, `Characters ${x.start} to ${x.end}; source version digest ${short(x.versionTextSha256)}…${x.excerptMatchesCitedQuote ? '' : ' (the passage no longer equals the quote cited by the finding)'} `, h('a', { href: x.localLink, class: 'no-print' }, 'Open in this workspace'))))
            : h('p', { class: 'muted' }, 'No finding currently cites a registered source passage. Legacy rules cite a typed document name only.'),
        ),
      ),

      h(
        'section',
        { class: 'card', 'aria-labelledby': 'dz-hashes' },
        h('div', { class: 'card-h' }, h('h2', { id: 'dz-hashes' }, 'What each digest is a digest of')),
        h('div', { class: 'card-b stack' }, h('p', { class: 'small muted' }, d.hashMethods.note), h('dl', { class: 'dossier-dl' }, dd('Content digest', d.hashMethods.contentSha256), dd('Image digest', d.hashMethods.imageSha256), dd('Source version digest', d.hashMethods.sourceVersionTextSha256), dd('Binding hashes', d.hashMethods.bindingHashes), dd('Checksum', d.hashMethods.checksum), dd('Canonical JSON', d.hashMethods.canonicalJson))),
      ),

      h(
        'section',
        { class: 'card', 'aria-labelledby': 'dz-limits' },
        h('div', { class: 'card-h' }, h('h2', { id: 'dz-limits' }, 'Limits of this record')),
        h(
          'div',
          { class: 'card-b stack' },
          h('ul', null, d.limitations.map((l) => h('li', null, l))),
          h('dl', { class: 'dossier-dl' }, dd('Format', `${d.format} version ${d.formatVersion}`), dd('Engine', `${d.snapshot.engine.description} Checker revision ${d.snapshot.engine.checkerRevision}. ${d.snapshot.engine.checkerRevisionNote}`), dd('Checksum (SHA-256)', h('span', { class: 'mono' }, d.checksum.value), ` ${d.checksum.note}`)),
        ),
      ),
    ),
  );
}

function imageTextSection(d) {
  const t = d.imageText;
  const p = t.provenance;
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'dz-imagetext' },
    h('div', { class: 'card-h' }, h('h2', { id: 'dz-imagetext' }, 'Text in the image'), h('span', { class: `chip ${t.state === 'confirmed' ? 'registered' : 'legacy'}` }, t.state === 'confirmed' ? 'Confirmed by a person' : 'Not transcribed')),
    h(
      'div',
      { class: 'card-b stack' },
      t.state === 'confirmed'
        ? [
            t.text ? h('pre', { class: 'dossier-text', tabindex: 0, 'aria-label': 'Confirmed text in the image' }, t.text) : h('p', { class: 'muted' }, 'The person confirmed there is no text to transcribe in this image.'),
            h(
              'dl',
              { class: 'dossier-dl' },
              dd('Confirmed by', `${actorText(t.confirmedBy)} on ${fmtTime(t.confirmedAt)}, in revision ${t.confirmedInRevision ?? '?'}${t.carriedFromRevision ? `; kept in later revisions because the image is unchanged` : ''}`),
              dd('Image digest it was confirmed against', h('span', { class: 'mono' }, t.imageSha256), t.matchesRetainedImage ? ' (matches the retained image)' : ' (DOES NOT match the retained image)'),
              dd('Where the words came from', p.kind === 'ocr-draft' ? `An automatic reading (${p.automaticReading.engine.name} ${p.automaticReading.engine.version}, English data ${short(p.automaticReading.engine.languageSha256)}…), ${p.editedAfterReading ? 'then corrected by the person' : 'confirmed without changes'}. Reader confidence ${p.automaticReading.confidenceHeuristic ?? 'n/a'} is the engine's own heuristic, not correctness.` : p.draftUnavailable ? 'Typed by the person (an automatic reading was mentioned but is no longer held).' : 'Typed by the person.'),
            ),
          ]
        : null,
      t.printedRule ? h('p', { class: 'small', id: 'dz-imagetext-rule' }, h('strong', null, 'Match the words actually printed. '), t.printedRule.replace('Match the words actually printed. ', '')) : null,
      h('p', { class: 'small muted' }, t.note),
      t.limit ? h('p', { class: 'small muted' }, t.limit) : null,
    ),
  );
}

function finding(f) {
  return h(
    'li',
    { class: 'dossier-finding' },
    h('div', { class: 'row' }, h('span', { class: `chip ${f.status}` }, STATUS_LABEL[f.status] ?? f.status.replace('_', ' ')), h('strong', { class: 'mono' }, f.ruleId), h('span', null, f.title)),
    f.quote ? h('blockquote', { class: 'quote' }, f.quote, f.span ? h('span', { class: 'muted small' }, `  (${f.field}, characters ${f.span.start} to ${f.span.end})`) : null) : null,
    h('p', { class: 'small' }, f.explanation),
    f.correction ? h('p', { class: 'small' }, h('strong', null, f.correction.type === 'replace' ? 'Suggested replacement: ' : 'Suggestion: '), f.correction.type === 'replace' ? f.correction.replacement : f.correction.text) : null,
    f.source
      ? h('p', { class: 'small muted' }, f.provenance === 'registered' ? `Registered source ${f.source.sourceId} v${f.source.version}, characters ${f.source.start} to ${f.source.end} (${f.source.sourceVersionState}): ` : 'Legacy source (typed by a manager, not linked to a registered document): ', `${f.source.doc ?? ''}${f.source.section ? `, ${f.source.section}` : ''}`, f.source.quote ? ` “${f.source.quote}”` : '')
      : null,
  );
}
