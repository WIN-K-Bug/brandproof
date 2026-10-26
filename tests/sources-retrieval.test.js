import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemantic, semanticSources } from '../src/semantic.js';
import { validateGuidelines, assignIds } from '../src/validate.js';
import { seedGuidelines } from '../src/seed.js';
import { startApp, cleanContent } from './helpers.js';
import { FACT_SHEET, FACT_SHEET_V2, demoAs, registerSource, approveVersion, link, publishWithLink } from './sources-helpers.js';

const BATTERY = 'A full charge lasts up to 12 hours at medium brightness.';

/** Test double embedder (bag of words) that records what was embedded. Never used by the app. */
function recordingEmbedder() {
  const calls = [];
  return {
    calls,
    state: 'ready',
    error: null,
    runtime: 'test double',
    available: () => ({ ok: true }),
    start: async () => {},
    async embed(texts) {
      calls.push(texts);
      return texts.map((t) => {
        const v = new Float32Array(32);
        for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          let h = 0;
          for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 32;
          v[h] += 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
}

const RETR_TEXT = 'Battery life. A full charge lasts up to 12 hours at medium brightness. Indoor use only; not waterproof or water resistant.';
const P_BATTERY = { start: 0, end: RETR_TEXT.indexOf('brightness.') + 'brightness.'.length };
const P_INDOOR = { start: RETR_TEXT.indexOf('Indoor use only'), end: RETR_TEXT.length };

async function world() {
  const emb = recordingEmbedder();
  const t = await startApp({ semantic: createSemantic({ embedder: emb }) });
  const w = { t, creator: demoAs(t, 'creator'), manager: demoAs(t, 'manager'), reviewer: demoAs(t, 'reviewer') };
  const made = await w.creator('POST', '/api/submissions', { title: 'Retrieval', text: RETR_TEXT, asset: cleanContent().asset });
  const ask = async () => {
    const d = (await w.reviewer('GET', `/api/submissions/${made.json.id}`)).json;
    const r = await t.call('POST', '/api/semantic/match', { body: { submissionId: d.id, revision: 1, passages: [P_BATTERY, P_INDOOR], expected: d.workflow.binding } });
    assert.equal(r.status, 200, r.text);
    return r.json;
  };
  const ids = (out, i) => out.results[i].matches.map((m) => m.sourceId);
  return { emb, t, w, made, ask, ids };
}

async function linkedBattery(w) {
  const src = await registerSource(w.creator);
  assert.equal((await approveVersion(w.manager, src.id, 1, FACT_SHEET)).status, 201);
  const l = link(src.id, 1, FACT_SHEET, BATTERY);
  const { res } = await publishWithLink(w.manager, 'FCT-001', l);
  assert.equal(res.status, 201, res.text);
  return { src, l };
}

test('RETRIEVAL: an active linked rule is a candidate WITH registered provenance (openable exact passage); legacy rules stay candidates', async () => {
  const { t, w, ask, ids } = await world();
  try {
    const { src, l } = await linkedBattery(w);
    const out = await ask();
    assert.equal(out.sourceCacheHit, false);
    const hit = out.results[0].matches.find((m) => m.sourceId === 'FCT-001');
    assert.ok(hit, `FCT-001 should be retrieved, got ${ids(out, 0)}`);
    assert.deepEqual(hit.registered, { sourceId: src.id, version: 1, start: l.start, end: l.end });
    assert.equal(hit.quote, BATTERY);
    assert.equal(FACT_SHEET.slice(hit.registered.start, hit.registered.end), hit.quote, 'the provenance really opens the cited passage');
    const legacy = out.results[1].matches.find((m) => m.sourceId === 'FCT-002');
    assert.ok(legacy, 'a legacy typed rule is still a candidate');
    assert.equal(legacy.registered, null, 'and is not presented as registered');
    assert.equal((await ask()).sourceCacheHit, true, 'warm cache while nothing changed');
  } finally {
    await t.close();
  }
});

test('RETRIEVAL: withdrawing the cited source removes the linked rule from candidates even with a warm cache; legacy stays; history is kept', async () => {
  const { emb, t, w, made, ask, ids } = await world();
  try {
    const { src } = await linkedBattery(w);
    assert.ok(ids(await ask(), 0).includes('FCT-001'));
    assert.equal((await ask()).sourceCacheHit, true, 'cache is warm');

    await w.manager('POST', `/api/sources/${src.id}/withdraw`, { expectedActiveVersion: 1, note: 'retired' });
    emb.calls.length = 0;
    const out = await ask();
    assert.equal(out.sourceCacheHit, false, 'the cache is bound to the evidence state, so it was rebuilt');
    for (let i = 0; i < 2; i++) assert.equal(ids(out, i).includes('FCT-001'), false, 'retired evidence is not returned through the rule either');
    // calls[0] is the rebuilt candidate batch; calls[1] is the user's own passages (which legitimately contain the same words)
    assert.equal(emb.calls.length, 2);
    assert.doesNotMatch(emb.calls[0].join(' | '), /Battery life\. A full charge lasts/, 'and the retired rule text was not even embedded as a candidate');
    assert.ok(ids(out, 1).includes('FCT-002'), 'the legacy rule is untouched');
    assert.equal(out.results[1].matches.find((m) => m.sourceId === 'FCT-002').registered, null);
    assert.equal(out.results.flatMap((r) => r.matches).some((m) => m.registered?.sourceId === src.id), false, 'no passage of the withdrawn source either');

    // history: the saved finding still shows the evidence it was made with, now flagged as withdrawn
    const d = (await w.reviewer('GET', `/api/submissions/${made.json.id}`)).json;
    const f = d.current.findings.find((x) => x.ruleId === 'FCT-001');
    assert.equal(f.source.quote, BATTERY);
    assert.equal(f.sourceEvidence.state, 'withdrawn');
  } finally {
    await t.close();
  }
});

test('RETRIEVAL: replacing the cited version removes the linked rule until it is relinked; then it returns pointing at the NEW version', async () => {
  const { t, w, ask, ids } = await world();
  try {
    const { src } = await linkedBattery(w);
    assert.ok(ids(await ask(), 0).includes('FCT-001'));
    assert.equal((await ask()).sourceCacheHit, true);

    await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2 });
    const draftOnly = await ask();
    assert.ok(ids(draftOnly, 0).includes('FCT-001'), 'a pending replacement changes nothing: the rule is still in force');
    assert.equal(draftOnly.sourceCacheHit, true);

    await approveVersion(w.manager, src.id, 2, FACT_SHEET_V2);
    const replaced = await ask();
    assert.equal(replaced.sourceCacheHit, false);
    assert.equal(ids(replaced, 0).includes('FCT-001'), false, 'version 1 is superseded: its rule is not a candidate');
    assert.equal(replaced.results.flatMap((r) => r.matches).some((m) => m.registered?.version === 1), false);

    const g = (await w.manager('GET', '/api/guidelines')).json;
    const fixed = structuredClone(g.guidelines);
    fixed.facts.find((f) => f.id === 'FCT-001').source = link(src.id, 2, FACT_SHEET_V2, BATTERY);
    assert.equal((await w.manager('PUT', '/api/guidelines', { baseVersion: g.version, guidelines: fixed })).status, 201);
    const relinked = await ask();
    const hit = relinked.results[0].matches.find((m) => m.sourceId === 'FCT-001');
    assert.ok(hit, 'after relinking it is a candidate again');
    assert.equal(hit.registered.version, 2);
    assert.equal(FACT_SHEET_V2.slice(hit.registered.start, hit.registered.end), BATTERY);
  } finally {
    await t.close();
  }
});

test('RETRIEVAL: unlinking to a typed legacy source brings the rule back as explicitly legacy', async () => {
  const { t, w, ask, ids } = await world();
  try {
    const { src } = await linkedBattery(w);
    await w.manager('POST', `/api/sources/${src.id}/withdraw`, { expectedActiveVersion: 1, note: 'retired' });
    assert.equal(ids(await ask(), 0).includes('FCT-001'), false);
    const g = (await w.manager('GET', '/api/guidelines')).json;
    const legacy = structuredClone(g.guidelines);
    legacy.facts.find((f) => f.id === 'FCT-001').source = { doc: 'Typed again (fictional)', section: '1', quote: 'Battery life: up to 12 hours at medium brightness.' };
    assert.equal((await w.manager('PUT', '/api/guidelines', { baseVersion: g.version, guidelines: legacy })).status, 201);
    const hit = (await ask()).results[0].matches.find((m) => m.sourceId === 'FCT-001');
    assert.ok(hit);
    assert.equal(hit.registered, null);
  } finally {
    await t.close();
  }
});

test('RETRIEVAL unit: semanticSources keeps legacy entries, keeps active links with provenance, drops everything else and fails closed without states', () => {
  const g = assignIds(validateGuidelines(seedGuidelines()).value);
  g.facts[0].source = { doc: 'x (SRC-1)', section: 's', quote: 'Battery life: up to 12 hours', sourceId: 'SRC-1', version: 1, start: 5, end: 33, textSha256: 'a'.repeat(64) };
  g.terms[0].source = { doc: 'y (SRC-2)', section: 's', quote: 'Aurora Lamp', sourceId: 'SRC-2', version: 3, start: 0, end: 11, textSha256: 'b'.repeat(64) };
  const idsOf = (list) => list.map((x) => x.id);
  const active = semanticSources(g, { 'FCT-001': 'active', 'TRM-001': 'superseded' });
  assert.ok(idsOf(active).includes('FCT-001'));
  assert.deepEqual(active.find((x) => x.id === 'FCT-001').registered, { sourceId: 'SRC-1', version: 1, start: 5, end: 33 });
  assert.equal(idsOf(active).includes('TRM-001'), false);
  assert.ok(idsOf(active).includes('FCT-002'), 'legacy fact kept');
  assert.equal(active.find((x) => x.id === 'FCT-002').registered, null);
  for (const st of ['withdrawn', 'superseded', 'missing', 'pending', 'rejected', undefined]) {
    assert.equal(idsOf(semanticSources(g, { 'FCT-001': st })).includes('FCT-001'), false, String(st));
  }
  assert.equal(idsOf(semanticSources(g)).includes('FCT-001'), false, 'no states supplied: fail closed');
  assert.equal(idsOf(semanticSources(g)).includes('FCT-002'), true);
});
