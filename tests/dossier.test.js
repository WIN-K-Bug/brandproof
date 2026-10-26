import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { canonical, sha256 } from '../src/util.js';
import { sha256Hex } from '../src/assets.js';
import { startApp, cleanContent, blankAsset } from './helpers.js';
import { startAuthApp } from './auth-helpers.js';
import { makeStripedPng } from './png-helpers.js';
import { FACT_SHEET, FACT_SHEET_CHANGED, demoAs, authAs, registerSource, approveVersion, link, publishWithLink, sha } from './sources-helpers.js';

const BATTERY = 'A full charge lasts up to 12 hours at medium brightness.';
const FIXED_NOW = '2026-10-24T12:00:00.000Z';
const OCTET = { 'content-type': 'application/octet-stream' };
const SECRETS = /password|passwd|csrf|cookie|session|scrypt|token|secret|syn-/i;

const dossier = (api, id) => api('GET', `/api/submissions/${id}/dossier`);

async function world(appOptions = {}) {
  const t = await startApp({ appOptions: { clock: () => FIXED_NOW, ...appOptions } });
  return { t, creator: demoAs(t, 'creator'), manager: demoAs(t, 'manager'), reviewer: demoAs(t, 'reviewer') };
}

async function linkedBattery(w) {
  const src = await registerSource(w.creator);
  assert.equal((await approveVersion(w.manager, src.id, 1, FACT_SHEET)).status, 201);
  const l = link(src.id, 1, FACT_SHEET, BATTERY);
  const { res } = await publishWithLink(w.manager, 'FCT-001', l);
  assert.equal(res.status, 201, res.text);
  return { src, l };
}

async function campaign(w, { text = 'A full charge lasts up to 12 hours.', asset = cleanContent().asset, title = 'Battery claim' } = {}) {
  const made = await w.creator('POST', '/api/submissions', { title, text, asset });
  assert.equal(made.status, 201, made.text);
  return made.json;
}

async function decide(w, made, type = 'approve') {
  const rr = await w.creator('POST', `/api/submissions/${made.id}/request-review`, { revision: 1, expected: made.workflow.binding });
  assert.equal(rr.status, 201, rr.text);
  const seen = (await w.reviewer('GET', `/api/submissions/${made.id}`)).json;
  const r = await w.reviewer('POST', `/api/submissions/${made.id}/${type}`, { revision: 1, expected: seen.workflow.binding });
  assert.equal(r.status, 201, r.text);
}

const withImage = async (w, png = makeStripedPng()) => {
  const up = await w.t.call('POST', '/api/assets', { role: 'creator', raw: png, headers: OCTET });
  assert.equal(up.status, 201, up.text);
  return { sha: up.json.asset.sha256, asset: { ...cleanContent().asset, name: 'campaign.png', retainedSha256: up.json.asset.sha256 }, png };
};

test('dossier content: snapshot, recorded vs recomputed, exact cited excerpt, registered and legacy provenance, no fabrication', async () => {
  const w = await world();
  try {
    const { src, l } = await linkedBattery(w);
    const made = await campaign(w, { text: 'A full charge lasts up to 30 hours. Fully waterproof!' });
    const r = await dossier(w.reviewer, made.id);
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const d = r.json;
    assert.equal(d.format, 'brandproof-review-dossier');
    assert.equal(d.formatVersion, 3);
    assert.equal(d.snapshot.generatedAt, FIXED_NOW);
    assert.match(d.snapshot.outdatedNote, /out of date as soon as anything changes/);
    assert.equal(d.workspace.mode, 'demo');
    assert.equal(d.campaign.id, made.id);
    assert.equal(d.currentRevision.text, 'A full charge lasts up to 30 hours. Fully waterproof!');
    assert.equal(d.currentRevision.contentSha256, made.workflow.binding.contentHash);
    assert.equal(d.currentBinding.guidelineVersion, 2);
    assert.equal(d.guidelines.version, 2);
    assert.equal(d.evidence.linkedEntries, 1);
    assert.ok(d.evidence.legacyEntries > 0);
    assert.equal(d.recordedEvents.kind, 'RECORDED');
    assert.equal(d.recomputedFindings.kind, 'RECOMPUTED');
    assert.match(d.recomputedFindings.note, /not what any reviewer saw/);
    assert.match(d.recordedEvents.note, /NOT stored and are not reconstructed/);
    assert.deepEqual(d.recordedEvents.events, [], 'no review has happened: nothing is invented');
    assert.match(d.status.headline, /No review has been requested/);

    const battery = d.recomputedFindings.findings.find((f) => f.ruleId === 'FCT-001');
    assert.equal(battery.status, 'contradicted');
    assert.equal(battery.quote, '30 hours');
    assert.equal(made.current.findings.find((f) => f.ruleId === 'FCT-001').span.start, battery.span.start);
    assert.equal(battery.provenance, 'registered');
    assert.deepEqual([battery.source.sourceId, battery.source.version, battery.source.start, battery.source.end], [src.id, 1, l.start, l.end]);
    const ex = d.sourceExcerpts.find((x) => x.sourceId === src.id);
    assert.equal(ex.excerpt, BATTERY, 'the exact cited passage, cut from the registry text');
    assert.equal(ex.excerpt, FACT_SHEET.slice(l.start, l.end));
    assert.equal(ex.excerptMatchesCitedQuote, true);
    assert.equal(ex.versionTextSha256, sha(FACT_SHEET));
    assert.equal(ex.localLink, `#/sources/${src.id}/1?start=${l.start}&end=${l.end}`);
    assert.match(d.links.note, /not public or shareable/);
    const legacy = d.recomputedFindings.findings.find((f) => f.ruleId === 'FCT-002');
    assert.equal(legacy.provenance, 'legacy');
    assert.equal(legacy.source.sourceId, undefined);
    assert.ok(d.sourceExcerpts.every((x) => x.sourceId === src.id), 'legacy rules produce no excerpt');
    assert.ok(d.limitations.some((x) => /Not a compliance certificate/.test(x)));
    assert.ok(d.limitations.some((x) => /anyone can recompute it/.test(x)));
    // the same state, asked twice, gives exactly the same file
    assert.equal(JSON.stringify((await dossier(w.reviewer, made.id)).json), JSON.stringify(d));
  } finally {
    await w.t.close();
  }
});

test('dossier checksum covers every other field and changes when any of them changes', async () => {
  const w = await world();
  try {
    await linkedBattery(w);
    const made = await campaign(w);
    const d = (await dossier(w.reviewer, made.id)).json;
    const { checksum, ...rest } = d;
    assert.equal(checksum.value, sha256(canonical(rest)));
    assert.match(checksum.note, /not an authenticity check/);
    const tampered = structuredClone(rest);
    tampered.currentRevision.text += ' ';
    assert.notEqual(sha256(canonical(tampered)), checksum.value);
    const again = (await w.creator('POST', `/api/submissions/${made.id}/revisions`, { baseRevision: 1, text: 'A full charge lasts up to 12 hours, really.', asset: cleanContent().asset }));
    assert.equal(again.status, 201);
    assert.notEqual((await dossier(w.reviewer, made.id)).json.checksum.value, checksum.value);
  } finally {
    await w.t.close();
  }
});

test('dossier is read-only: the data file is byte-identical after exports', async () => {
  const w = await world();
  try {
    await linkedBattery(w);
    const made = await campaign(w);
    const file = path.join(w.t.dir, 'data.json');
    const before = await fs.readFile(file);
    for (let i = 0; i < 3; i++) assert.equal((await dossier(w.manager, made.id)).status, 200);
    assert.ok(before.equals(await fs.readFile(file)));
  } finally {
    await w.t.close();
  }
});

test('dossier contains no paths, secrets, usernames, source full texts, image bytes or comment bodies', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const { asset, png } = await withImage(w);
    const made = await campaign(w, { asset });
    assert.equal((await w.creator('POST', `/api/submissions/${made.id}/comments`, { revision: 1, text: 'PRIVATE-COMMENT-BODY-123' })).status, 201);
    await decide(w, made);
    const r = await dossier(w.reviewer, made.id);
    const text = r.text;
    assert.ok(!text.includes(w.t.dir), 'no filesystem path');
    assert.ok(!/[A-Za-z]:\\\\|\/tmp\/|\/Users\//.test(text), 'no path-looking strings');
    assert.ok(!text.includes('PRIVATE-COMMENT-BODY-123'));
    assert.ok(!text.includes('Environment. Indoor use only'), 'source full text is not embedded (only the cited excerpt)');
    assert.ok(!text.includes(png.toString('base64').slice(0, 40)));
    assert.ok(!text.includes(`${w.t.dir}`.replaceAll('\\', '/')));
    assert.ok(!SECRETS.test(text.replace(/The checksum covers[^"]*/g, '').replace(/Detects accidental[^"]*/g, '')), (text.match(SECRETS) ?? [])[0]);
    const d = r.json;
    assert.equal(d.campaign.commentCount, 1);
    assert.equal(d.campaign.commentBodiesIncluded, false);
    assert.equal(d.image.sha256, asset.retainedSha256);
    assert.equal(src.id, 'SRC-1');
  } finally {
    await w.t.close();
  }
});

test('images: retained and verified, metadata-only, none, corrupt (same size), missing file, and a past approval is not called ready', async () => {
  const w = await world();
  try {
    // none
    const plain = await campaign(w, { title: 'No image', asset: blankAsset() });
    assert.equal((await dossier(w.reviewer, plain.id)).json.image.state, 'none');
    // metadata only
    const meta = await campaign(w, { title: 'Metadata', asset: { ...cleanContent().asset, name: 'old.png', fileSha256: 'a'.repeat(64) } });
    const m = (await dossier(w.reviewer, meta.id)).json.image;
    assert.equal(m.state, 'metadata_only');
    assert.equal(m.integrity, 'not_applicable');
    assert.match(m.note, /not retained/);
    assert.equal(m.sha256, undefined, 'a browser fingerprint is not presented as a retained digest');
    assert.match(m.browserReportedFingerprint.note, /cannot be checked/);
    // retained, ok, approved
    const { sha: imgSha, asset, png } = await withImage(w);
    const made = await campaign(w, { asset, title: 'Retained' });
    await decide(w, made);
    const ok = (await dossier(w.reviewer, made.id)).json;
    assert.equal(ok.image.state, 'retained');
    assert.equal(ok.image.integrity, 'ok');
    assert.equal(ok.image.sha256, imgSha);
    assert.equal(ok.image.bytes, png.length);
    assert.deepEqual([ok.image.width, ok.image.height], [240, 120]);
    assert.equal(ok.status.workflow, 'approved');
    assert.deepEqual(ok.status.currentBlocks, []);
    assert.match(ok.status.headline, /still match the binding recorded with that approval/);
    // the same-size corruption of the stored file after approval
    const file = path.join(`${path.join(w.t.dir, 'data.json')}.assets`, `${imgSha}.png`);
    const b = await fs.readFile(file);
    b[Math.floor(b.length / 2)] ^= 1;
    await fs.writeFile(file, b);
    const bad = (await dossier(w.reviewer, made.id)).json;
    assert.equal(bad.image.integrity, 'corrupt');
    assert.equal(bad.status.workflow, 'approved', 'the recorded binding still matches the saved inputs');
    assert.ok(bad.status.currentBlocks.some((x) => /retained image is corrupt/.test(x)));
    assert.match(bad.status.headline, /It is not ready today/);
    assert.match(bad.image.note, /could NOT be verified/);
    // missing file
    await fs.rm(file);
    const gone = (await dossier(w.reviewer, made.id)).json;
    assert.equal(gone.image.integrity, 'missing');
    assert.ok(gone.status.currentBlocks.some((x) => /is missing/.test(x)));
    // restored by identical re-upload
    assert.equal((await w.t.call('POST', '/api/assets', { role: 'creator', raw: png, headers: OCTET })).status, 200);
    const back = (await dossier(w.reviewer, made.id)).json;
    assert.equal(back.image.integrity, 'ok');
    assert.deepEqual(back.status.currentBlocks, []);
  } finally {
    await w.t.close();
  }
});

test('stale approval after a source change: recorded decision kept, current state says Re-review required and why', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const made = await campaign(w);
    await decide(w, made);
    const before = (await dossier(w.reviewer, made.id)).json;
    assert.equal(before.status.workflow, 'approved');
    const approvedEvent = before.recordedEvents.events.find((e) => e.type === 'approved');
    assert.equal(approvedEvent.bindingComparedWithCurrentInputs.matches, true);
    const added = await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_CHANGED, origin: 'paste' });
    assert.equal(added.status, 201);
    assert.equal((await approveVersion(w.manager, src.id, 2, FACT_SHEET_CHANGED)).status, 201);
    const after = (await dossier(w.reviewer, made.id)).json;
    assert.equal(after.status.workflow, 'approval_stale');
    assert.deepEqual(after.status.staleApproval.reasons, ['evidence']);
    assert.match(after.status.headline, /no longer applies: Re-review required/);
    assert.ok(after.status.currentBlocks.some((x) => /no longer in force/.test(x)));
    const ev = after.recordedEvents.events.find((e) => e.type === 'approved');
    assert.deepEqual(ev.bindingComparedWithCurrentInputs, { matches: false, differs: ['evidence'] });
    assert.deepEqual(ev.binding, approvedEvent.binding, 'the recorded binding is exactly what was stored then');
    assert.equal(after.evidence.entries[0].state, 'superseded');
    assert.equal(after.sourceExcerpts[0].versionState, 'superseded', 'the old excerpt is shown as belonging to a replaced version');
  } finally {
    await w.t.close();
  }
});

test('coherence: a change committed while the image is being verified is never half-included; the snapshot is rebuilt', async () => {
  let fired = 0;
  let w;
  const hook = async (attempt) => {
    if (fired === 0) {
      fired++;
      const r = await w.creator('POST', `/api/submissions/${madeId}/revisions`, { baseRevision: 1, text: 'A full charge lasts up to 12 hours, rebuilt.', asset: assetRef });
      assert.equal(r.status, 201, r.text);
    }
  };
  let madeId;
  let assetRef;
  w = await world({ hooks: { dossierAfterVerify: hook } });
  try {
    const { asset } = await withImage(w);
    assetRef = asset;
    const made = await campaign(w, { asset });
    madeId = made.id;
    const d = (await dossier(w.reviewer, made.id)).json;
    assert.equal(fired, 1);
    assert.equal(d.campaign.revisionCount, 2, 'the snapshot reflects the committed change');
    assert.equal(d.currentRevision.n, 2);
    assert.equal(d.currentRevision.text, 'A full charge lasts up to 12 hours, rebuilt.');
    assert.equal(d.revisionHistory.length, 2);
    assert.equal(d.currentBinding.contentHash, d.currentRevision.contentSha256);
    const live = (await w.reviewer('GET', `/api/submissions/${made.id}`)).json;
    assert.equal(d.currentBinding.contentHash, live.workflow.binding.contentHash);
    assert.equal(d.currentBinding.assetHash, live.workflow.binding.assetHash);
  } finally {
    await w.t.close();
  }
});

test('coherence: if the workspace keeps changing the export refuses with 409 instead of returning a mixed snapshot', async () => {
  let n = 0;
  let w;
  let madeId;
  let assetRef;
  w = await world({
    hooks: {
      dossierAfterVerify: async () => {
        n++;
        assert.equal((await w.creator('POST', `/api/submissions/${madeId}/comments`, { revision: 1, text: `noise ${n}` })).status, 201);
      },
    },
  });
  try {
    const { asset } = await withImage(w);
    assetRef = asset;
    const made = await campaign(w, { asset: assetRef });
    madeId = made.id;
    const r = await dossier(w.reviewer, made.id);
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'snapshot_changed');
    assert.equal(n, 4, 'bounded attempts');
  } finally {
    await w.t.close();
  }
});

test('hostile text in titles, copy, source and notes stays data: JSON round-trips and nothing is interpreted', async () => {
  const w = await world();
  try {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)> "quotes" \\ and   line separators';
    const src = await registerSource(w.creator, { title: evil, text: `Battery. ${BATTERY}\n\nExtra. ${evil}` });
    assert.equal((await w.manager('POST', `/api/sources/${src.id}/versions/1/approve`, { expectedSha256: sha(`Battery. ${BATTERY}\n\nExtra. ${evil}`) })).status, 201);
    const text = `Battery. ${BATTERY}\n\nExtra. ${evil}`;
    const { res } = await publishWithLink(w.manager, 'FCT-001', link(src.id, 1, text, BATTERY));
    assert.equal(res.status, 201, res.text);
    const made = await campaign(w, { title: evil, text: `${evil} A full charge lasts 30 hours.` });
    const r = await dossier(w.reviewer, made.id);
    assert.equal(r.status, 200);
    const d = JSON.parse(r.text);
    assert.equal(d.campaign.title, evil);
    assert.equal(d.currentRevision.text, `${evil} A full charge lasts 30 hours.`);
    assert.equal(d.sourceExcerpts[0].title, evil);
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await w.t.close();
  }
});

test('demo mode: any role can read it; unknown or malformed ids are 404', async () => {
  const w = await world();
  try {
    const made = await campaign(w);
    for (const role of [w.creator, w.manager, w.reviewer]) assert.equal((await dossier(role, made.id)).status, 200);
    assert.equal((await w.t.call('GET', `/api/submissions/${made.id}/dossier`)).status, 200, 'reads need no role in demo mode, like the campaign itself');
    for (const bad of ['SUB-999', '..%2f..%2fdata', 'x']) assert.equal((await dossier(w.reviewer, bad)).status, 404, bad);
    assert.equal((await w.t.call('POST', `/api/submissions/${made.id}/dossier`, { role: 'manager', body: {} })).status, 405, 'no write verb');
  } finally {
    await w.t.close();
  }
});

test('authenticated mode: a session is required, identities are recorded by id, no usernames leak, self-approval is reported factually', async () => {
  const t = await startAuthApp({ users: ['creator', 'manager', 'reviewer'], appOptions: { clock: () => FIXED_NOW } });
  try {
    const [creator, manager, reviewer] = [await t.as('creator'), await t.as('manager'), await t.as('reviewer')];
    const [c, m, rv] = [authAs(creator), authAs(manager), authAs(reviewer)];
    const made = (await c('POST', '/api/submissions', { title: 'Auth campaign', ...cleanContent() })).json;
    assert.equal((await t.client().call('GET', `/api/submissions/${made.id}/dossier`)).status, 401);
    assert.equal((await t.client().call('GET', `/api/submissions/${made.id}/dossier`, { headers: { 'x-demo-role': 'manager' } })).status, 401);
    const rr = await c('POST', `/api/submissions/${made.id}/request-review`, { revision: 1, expected: made.workflow.binding });
    assert.equal(rr.status, 201, rr.text);
    const seen = (await rv('GET', `/api/submissions/${made.id}`)).json;
    assert.equal((await rv('POST', `/api/submissions/${made.id}/approve`, { revision: 1, expected: seen.workflow.binding })).status, 201);
    for (const who of [c, m, rv]) assert.equal((await dossier(who, made.id)).status, 200, 'every signed-in role may read it');
    const r = await dossier(m, made.id);
    const d = r.json;
    assert.equal(d.workspace.mode, 'authenticated');
    assert.match(d.workspace.identityNote, /local accounts/);
    const approved = d.recordedEvents.events.find((e) => e.type === 'approved');
    assert.deepEqual(approved.actor, { id: t.ids.reviewer, name: 'Synthetic reviewer', role: 'reviewer' });
    assert.deepEqual(d.campaign.createdBy, { id: t.ids.creator, name: 'Synthetic creator', role: 'creator' });
    assert.equal(d.status.separationOfDuties.approverWasContributor, false);
    assert.ok(!/syn-(creator|manager|reviewer)/.test(r.text), 'usernames are not exported');
    assert.ok(!r.text.includes(t.passwords.creator) && !r.text.includes(t.passwords.reviewer));
    assert.ok(!r.text.includes(creator.csrf) && !r.text.includes(creator.cookie.split('=')[1]));
    assert.ok(!r.text.includes(t.dir), 'no path');
    assert.equal((await dossier(m, 'SUB-404')).status, 404);
  } finally {
    await t.close();
  }
});

test('provenance: only legacy metadata says the image was not held; a retained image reports whether its saved fingerprint equals the server digest', async () => {
  const w = await world();
  try {
    const { sha: imgSha, asset } = await withImage(w);
    // 1. the normal attach flow stores the server digest as the fingerprint
    const same = await campaign(w, { asset: { ...asset, fileSha256: imgSha }, title: 'Fingerprint equals digest' });
    const a = (await dossier(w.reviewer, same.id)).json.image;
    assert.equal(a.state, 'retained');
    assert.equal(a.integrity, 'ok');
    assert.match(a.browserReportedFingerprint.note, /equals the retained image digest the server computed/);
    assert.doesNotMatch(JSON.stringify(a), /was not held|cannot be checked/, 'a retained, verified image is never described as unretained');
    // 2. the server refuses a retained image whose fingerprint disagrees, so the "differs" wording is defensive only:
    //    check it directly on a cloned state (for example a hand-edited data file)
    const bad = await w.creator('POST', '/api/submissions', { title: 'x', text: 'Hello there.', asset: { ...asset, fileSha256: 'b'.repeat(64) } });
    assert.equal(bad.status, 422);
    const { buildDossier } = await import('../src/dossier.js');
    const edited = structuredClone(w.t.app.store.state);
    edited.submissions.find((x) => x.id === same.id).revisions.at(-1).asset.fileSha256 = 'b'.repeat(64);
    const b = buildDossier(edited, same.id, { integrity: 'ok', now: FIXED_NOW, mode: 'demo' }).image;
    assert.match(b.browserReportedFingerprint.note, /DIFFERS from the retained image digest/);
    assert.match(b.browserReportedFingerprint.note, /server-computed digest is the one that is verified/);
    // 3. legacy metadata-only is the one case that says the image was not held
    const meta = await campaign(w, { asset: { ...cleanContent().asset, name: 'old.png', fileSha256: 'c'.repeat(64) }, title: 'Legacy' });
    const c = (await dossier(w.reviewer, meta.id)).json.image;
    assert.equal(c.state, 'metadata_only');
    assert.match(c.browserReportedFingerprint.note, /not held, so this cannot be checked/);
  } finally {
    await w.t.close();
  }
});

test('hash methods are stated and each one is true: every digest in the file is recomputed independently by the method named', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const { sha: imgSha, asset, png } = await withImage(w);
    const text = 'A full charge lasts up to 12 hours.\r\nCafé — “quoted”';
    const made = await campaign(w, { asset: { ...asset, fileSha256: imgSha }, text });
    await decide(w, made);
    const d = (await dossier(w.reviewer, made.id)).json;
    const m = d.hashMethods;
    for (const k of ['note', 'contentSha256', 'imageSha256', 'sourceVersionTextSha256', 'bindingHashes', 'checksum', 'canonicalJson']) assert.ok(typeof m[k] === 'string' && m[k].length > 20, k);
    assert.match(m.contentSha256, /canonical JSON \{"text"/);
    assert.match(m.contentSha256, /NOT a hash of the raw text bytes/);
    assert.match(m.imageSha256, /actual bytes of the retained PNG/);
    assert.match(m.sourceVersionTextSha256, /UTF-8 bytes of the source version's NORMALISED text/);
    assert.match(m.sourceVersionTextSha256, /not a digest of any original file/);
    assert.match(m.bindingHashes, /canonical JSON of metadata/);
    assert.match(m.bindingHashes, /retained image digest as a string, not the bytes/);
    assert.match(m.checksum, /every other field/);
    // contentSha256 = SHA-256 of canonical {text}, and demonstrably NOT of the raw text
    const savedText = d.currentRevision.text;
    assert.equal(d.currentRevision.contentSha256, sha256(canonical({ text: savedText })));
    assert.notEqual(d.currentRevision.contentSha256, sha256(savedText));
    assert.notEqual(d.currentRevision.contentSha256, sha256(Buffer.from(savedText, 'utf8').toString('utf8')));
    // image digest = SHA-256 of the actual bytes
    assert.equal(d.image.sha256, sha256Hex(png));
    assert.equal(d.revisionHistory[0].retainedImageSha256, sha256Hex(png));
    // source version digest = SHA-256 of the normalised UTF-8 text; the excerpt belongs to exactly that text
    const ex = d.sourceExcerpts.find((x) => x.sourceId === src.id);
    assert.equal(ex.versionTextSha256, sha256(FACT_SHEET));
    assert.equal(FACT_SHEET.slice(ex.start, ex.end), ex.excerpt);
    // binding hashes are canonical JSON of metadata (image details incl. the retained digest string; the whole guideline set)
    const g = (await w.manager('GET', '/api/guidelines')).json;
    assert.equal(d.guidelines.hash, sha256(canonical(g.guidelines)));
    const a = { ...asset, fileSha256: imgSha };
    assert.equal(d.revisionHistory[0].assetBindingHash, sha256(canonical({ name: a.name, alt: a.alt, fileSha256: a.fileSha256, fg: a.fg, bg: a.bg, textSize: a.textSize, colors: [...a.colors].sort(), retainedSha256: a.retainedSha256 })));
    const entries = d.evidence.entries.map(({ entryId, sourceId, version, start, end, textSha256, state }) => ({ entryId, sourceId, version, start, end, textSha256, state }));
    assert.equal(d.evidence.hash, sha256(canonical(entries)));
    // the established bindings are unchanged: they equal what the workflow itself reports
    const live = (await w.reviewer('GET', `/api/submissions/${made.id}`)).json.workflow.binding;
    assert.deepEqual(d.currentBinding, live);
    // checksum
    const { checksum, ...rest } = d;
    assert.equal(checksum.value, sha256(canonical(rest)));
  } finally {
    await w.t.close();
  }
});

test('engine: a stable, hand-maintained checker revision is stated, with an honest note that it is not a build identity', async () => {
  const { CHECKER_REVISION } = await import('../src/checks.js');
  const w = await world();
  try {
    const made = await campaign(w);
    const d = (await dossier(w.reviewer, made.id)).json;
    assert.equal(d.snapshot.engine.checkerRevision, CHECKER_REVISION);
    assert.match(CHECKER_REVISION, /^rules-\d{4}\.\d{2}\.\d{2}-[a-z-]+$/);
    assert.match(d.snapshot.engine.checkerRevisionNote, /hand-maintained/);
    assert.match(d.snapshot.engine.checkerRevisionNote, /not a build identity or signature/);
    assert.match(d.snapshot.engine.checkerRevisionNote, /forgotten bump is possible/);
    assert.ok(d.limitations.some((x) => /which build produced it/.test(x)));
    assert.equal((await dossier(w.reviewer, made.id)).json.snapshot.engine.checkerRevision, CHECKER_REVISION, 'stable across calls');
  } finally {
    await w.t.close();
  }
});
