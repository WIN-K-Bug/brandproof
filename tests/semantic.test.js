import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemantic, createWorkerEmbedder, localAvailability, semanticSources, bandOf, LIMITS, DISCLAIMER } from '../src/semantic.js';
import { guidelineHash } from '../src/service.js';
import { guidelinesFixture, startApp, cleanContent } from './helpers.js';

const G = guidelinesFixture();
const GH = guidelineHash(G);

/** TEST DOUBLE ONLY: a bag-of-words hashing embedder, so plumbing can be tested without the model. Never used by the app. */
function fakeEmbedder({ gate } = {}) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  return {
    state: 'ready',
    error: null,
    runtime: 'test double',
    calls,
    available: () => ({ ok: true }),
    start: async () => {},
    async embed(texts) {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push(texts);
      if (gate) await gate.promise;
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return texts.map((t) => {
        const v = new Float32Array(64);
        for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          let h = 0;
          for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 64;
          v[h] += 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
    get maxActive() {
      return maxActive;
    },
  };
}

const passage = (text) => ({ start: 0, end: text.length, text });

/** Wait (bounded) until the embedder has started a call; fail fast if the request settled first (e.g. was rejected). */
async function untilInferenceStarts(emb, pending, ms = 3000) {
  let settled = null;
  pending.then((r) => (settled = r), (e) => (settled = e));
  const deadline = Date.now() + ms;
  while (emb.calls.length === 0) {
    if (settled) throw new Error(`request ended before inference started: ${JSON.stringify(settled.json ?? String(settled))}`);
    if (Date.now() > deadline) throw new Error('inference did not start within the time limit');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('sources come only from the approved guidelines, with exact quotes and real ids', () => {
  const src = semanticSources(G);
  const battery = src.find((s) => s.id === 'FCT-001');
  assert.equal(battery.quote, G.facts[0].source.quote);
  assert.equal(battery.doc, G.facts[0].source.doc);
  assert.equal(battery.kind, 'Approved fact');
  assert.ok(src.some((s) => s.id === 'CLM-001' && s.kind === 'Policy'));
  assert.equal(new Set(src.map((s) => s.id)).size, src.length);
});

test('bands are descriptive and ordered', () => {
  assert.equal(bandOf(0.7), 'relevant');
  assert.equal(bandOf(0.4), 'possible');
  assert.equal(bandOf(0.1), 'low');
});

test('source embeddings are cached by guideline hash; a new hash recomputes; the cache is bounded', async () => {
  const emb = fakeEmbedder();
  const sem = createSemantic({ embedder: emb });
  const a = await sem.match({ passages: [passage('battery hours')], guidelines: G, guidelineHash: GH });
  const b = await sem.match({ passages: [passage('recycled aluminium')], guidelines: G, guidelineHash: GH });
  assert.equal(a.sourceCacheHit, false);
  assert.equal(b.sourceCacheHit, true);
  assert.equal(emb.calls.filter((c) => c.length === a.sourceCount).length, 1, 'sources embedded once');
  const c = await sem.match({ passages: [passage('x')], guidelines: G, guidelineHash: 'f'.repeat(64) });
  assert.equal(c.sourceCacheHit, false);
  for (let i = 0; i < 6; i++) await sem.match({ passages: [passage('x')], guidelines: G, guidelineHash: String(i).repeat(64) });
  assert.ok(sem.cache.size <= LIMITS.cachedGuidelines);
});

test('results are ranked by cosine similarity, top K only, with exact quotes and no verdict fields', async () => {
  const sem = createSemantic({ embedder: fakeEmbedder() });
  const out = await sem.match({ passages: [passage('Battery life: up to 12 hours at medium brightness.')], guidelines: G, guidelineHash: GH });
  const [r] = out.results;
  assert.equal(r.matches.length, LIMITS.topK);
  assert.equal(r.matches[0].sourceId, 'FCT-001');
  assert.deepEqual([...r.matches].sort((a, b) => b.similarity - a.similarity), r.matches);
  assert.equal(r.matches[0].quote, G.facts[0].source.quote);
  for (const m of r.matches) {
    for (const forbidden of ['supported', 'contradicted', 'true', 'false', 'probability', 'violation', 'verdict']) assert.equal(forbidden in m, false);
    assert.ok(m.similarity >= -1 && m.similarity <= 1);
  }
});

test('inference concurrency is limited to one job and the queue is bounded (429 when busy)', async () => {
  let release;
  const gate = { promise: new Promise((r) => (release = r)) };
  const emb = fakeEmbedder({ gate });
  const sem = createSemantic({ embedder: emb });
  const jobs = Array.from({ length: LIMITS.maxPending }, (_, i) => sem.match({ passages: [passage('p' + i)], guidelines: G, guidelineHash: GH }));
  await assert.rejects(sem.match({ passages: [passage('overflow')], guidelines: G, guidelineHash: GH }), (e) => e.status === 429 && e.code === 'busy');
  release();
  await Promise.all(jobs);
  assert.equal(emb.maxActive, 1, 'never more than one embedding call at a time');
  await sem.match({ passages: [passage('again')], guidelines: G, guidelineHash: GH }); // recovers
});

test('unavailable or failing embedders give a 503 and an honest status, never fake output', async () => {
  const off = createSemantic({ embedder: null });
  assert.equal(off.status().state, 'unavailable');
  await assert.rejects(off.match({ passages: [passage('x')], guidelines: G, guidelineHash: GH }), (e) => e.status === 503);

  const missing = createSemantic({ embedder: { ...fakeEmbedder(), available: () => ({ ok: false, reason: 'model files missing' }) } });
  assert.equal(missing.status().state, 'unavailable');
  assert.match(missing.status().reason, /model files missing/);

  const broken = createSemantic({
    embedder: {
      ...fakeEmbedder(),
      embed: async () => {
        throw new Error('boom');
      },
    },
  });
  await assert.rejects(broken.match({ passages: [passage('x')], guidelines: G, guidelineHash: GH }), (e) => e.status === 503 && /boom/.test(e.message));
});

// ---------- HTTP ----------

const detail = async (t, id) => (await t.call('GET', `/api/submissions/${id}`, { role: 'reviewer' })).json;
const req = (d, passages, over = {}) => ({
  submissionId: d.id,
  revision: d.headRevision,
  passages,
  expected: { contentHash: d.workflow.binding.contentHash, guidelineHash: d.workflow.binding.guidelineHash },
  ...over,
});

test('API: status endpoint, meta, and a successful match tagged with revision and guideline', async () => {
  const t = await startApp({ semantic: createSemantic({ embedder: fakeEmbedder() }) });
  try {
    const st = (await t.call('GET', '/api/semantic/status')).json;
    assert.equal(st.state, 'ready');
    assert.equal(st.mode, 'local-embeddings');
    assert.equal(st.model.id, 'Xenova/all-MiniLM-L6-v2');
    assert.match(st.note, /Not a generative model/);
    assert.equal((await t.call('GET', '/api/meta')).json.semantic.state, 'ready');

    const d = await detail(t, 'SUB-3');
    const s = d.current.sentences[0];
    const r = await t.call('POST', '/api/semantic/match', { body: req(d, [{ start: s.start, end: s.end }]) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.revision, d.headRevision);
    assert.equal(r.json.guidelineHash, d.workflow.binding.guidelineHash);
    assert.equal(r.json.disclaimer, DISCLAIMER);
    assert.equal(r.json.results[0].text, d.revisions[0].text.slice(s.start, s.end));
  } finally {
    await t.close();
  }
});

test('API: matching changes no finding, eligibility, status or stored data', async () => {
  const t = await startApp({ semantic: createSemantic({ embedder: fakeEmbedder() }) });
  try {
    const before = await detail(t, 'SUB-1');
    const stored = JSON.stringify(t.app.store.state);
    const r = await t.call('POST', '/api/semantic/match', { body: req(before, [{ start: 0, end: 40 }]) });
    assert.equal(r.status, 200);
    const after = await detail(t, 'SUB-1');
    assert.deepEqual(after.current.findings, before.current.findings);
    assert.deepEqual(after.workflow, before.workflow);
    assert.equal(JSON.stringify(t.app.store.state), stored);
    assert.equal(JSON.stringify(r.json).includes('"findings"'), false);
  } finally {
    await t.close();
  }
});

test('API: bounded and validated requests', async () => {
  const t = await startApp({ semantic: createSemantic({ embedder: fakeEmbedder() }) });
  try {
    const d = await detail(t, 'SUB-1');
    const len = d.revisions[0].text.length;
    const bad = async (passages, over) => (await t.call('POST', '/api/semantic/match', { body: req(d, passages, over) })).status;
    assert.equal(await bad([]), 422);
    assert.equal(await bad(Array.from({ length: 9 }, () => ({ start: 0, end: 5 }))), 422);
    assert.equal(await bad([{ start: 5, end: 5 }]), 422);
    assert.equal(await bad([{ start: 0, end: len + 10 }]), 422);
    assert.equal(await bad([{ start: 0, end: 5 }], { submissionId: '../x' }), 422);
    assert.equal(await bad([{ start: 0, end: 5 }], { expected: { contentHash: 'zz', guidelineHash: 'zz' } }), 422);
    assert.equal(await bad([{ start: 0, end: 5 }], { submissionId: 'SUB-99' }), 404);
    const long = await t.call('POST', '/api/submissions', { role: 'creator', body: { title: 'long', text: 'word '.repeat(200).trim(), asset: {} } });
    assert.equal((await t.call('POST', '/api/semantic/match', { body: req(long.json, [{ start: 0, end: 700 }]) })).status, 422);
    assert.equal((await t.call('POST', '/api/semantic/match', { raw: '{bad', headers: { 'content-type': 'application/json' } })).status, 400);
  } finally {
    await t.close();
  }
});

test('API: a stale view of the copy or guidelines is refused before any inference runs', async () => {
  const emb = fakeEmbedder();
  const t = await startApp({ semantic: createSemantic({ embedder: emb }) });
  try {
    const d = await detail(t, 'SUB-3');
    const good = req(d, [{ start: 0, end: 10 }]);
    let r = await t.call('POST', '/api/semantic/match', { body: { ...good, expected: { ...good.expected, contentHash: 'a'.repeat(64) } } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'stale_result');
    assert.equal(emb.calls.length, 0, 'no inference for a stale request');

    const g = (await t.call('GET', '/api/guidelines')).json;
    const edited = structuredClone(g.guidelines);
    edited.claims.signals.push('unbeatable');
    await t.call('PUT', '/api/guidelines', { role: 'manager', body: { baseVersion: 1, guidelines: edited } });
    r = await t.call('POST', '/api/semantic/match', { body: good });
    assert.equal(r.status, 409);
    assert.match(r.json.error.message, /guidelines changed/i);
  } finally {
    await t.close();
  }
});

test('regression: a guideline publish DURING inference discards the result (409)', async () => {
  let release;
  const gate = { promise: new Promise((r) => (release = r)) };
  const emb = fakeEmbedder({ gate });
  const t = await startApp({ semantic: createSemantic({ embedder: emb }) });
  try {
    const d = await detail(t, 'SUB-3');
    const pending = t.call('POST', '/api/semantic/match', { body: req(d, [{ start: 0, end: 20 }]) });
    await untilInferenceStarts(emb, pending); // inference is now running
    const g = (await t.call('GET', '/api/guidelines')).json;
    const edited = structuredClone(g.guidelines);
    edited.claims.signals.push('unbeatable');
    assert.equal((await t.call('PUT', '/api/guidelines', { role: 'manager', body: { baseVersion: 1, guidelines: edited } })).status, 201);
    release();
    const r = await pending;
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'stale_result');
    assert.match(r.json.error.message, /discarded/);
  } finally {
    release(); // never leave the gate closed, even if an assertion above failed
    await t.close();
  }
});

test('regression: a new revision DURING inference discards the result (409)', async () => {
  let release;
  const gate = { promise: new Promise((r) => (release = r)) };
  const emb = fakeEmbedder({ gate });
  const t = await startApp({ semantic: createSemantic({ embedder: emb }) });
  try {
    const d = await detail(t, 'SUB-3');
    const pending = t.call('POST', '/api/semantic/match', { body: req(d, [{ start: 0, end: 20 }]) });
    await untilInferenceStarts(emb, pending);
    const rev = await t.call('POST', '/api/submissions/SUB-3/revisions', { role: 'creator', body: { baseRevision: 1, text: 'Brand new copy for the lamp.', asset: cleanContent().asset } });
    assert.equal(rev.status, 201);
    release();
    const r = await pending;
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'stale_result');
    assert.equal((await t.call('POST', '/api/semantic/match', { body: req(d, [{ start: 0, end: 5 }]) })).status, 409); // old revision refused too
  } finally {
    release();
    await t.close();
  }
});

test('API: when semantic matching is off the app still works and says so', async () => {
  const t = await startApp();
  try {
    assert.equal((await t.call('GET', '/api/semantic/status')).json.state, 'unavailable');
    const d = await detail(t, 'SUB-3');
    const r = await t.call('POST', '/api/semantic/match', { body: req(d, [{ start: 0, end: 5 }]) });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'semantic_unavailable');
    assert.equal((await t.call('GET', '/api/submissions')).status, 200);
  } finally {
    await t.close();
  }
});

// ---------- REAL model (skipped, with the reason, if the optional package/model is not installed) ----------

const real = localAvailability();
test('REAL local model: a paraphrase retrieves the battery source; unrelated text gets no confident match', { skip: real.ok ? false : `unavailable: ${real.reason}`, timeout: 120000 }, async () => {
  const embedder = createWorkerEmbedder();
  const sem = createSemantic({ embedder });
  try {
    const out = await sem.match({
      passages: [passage('How long can the lamp stay lit before recharging?'), passage('The weather in Paris is rainy in autumn.')],
      guidelines: G,
      guidelineHash: GH,
    });
    const [para, unrelated] = out.results;
    assert.equal(para.matches[0].sourceId, 'FCT-001');
    assert.equal(para.matches[0].quote, G.facts[0].source.quote);
    assert.notEqual(para.matches[0].band, 'low');
    assert.equal(unrelated.matches[0].band, 'low');
    assert.ok(unrelated.best < para.best);
    assert.equal(sem.status().state, 'ready');
    assert.match(embedder.runtime, /transformers/);
  } finally {
    embedder.stop();
  }
});

// ---------- worker lifecycle (fake Worker objects; no model involved) ----------

import { EventEmitter } from 'node:events';

class FakeWorker extends EventEmitter {
  constructor({ failInit = false } = {}) {
    super();
    this.terminated = false;
    this.failInit = failInit;
  }
  postMessage(msg) {
    setImmediate(() => {
      if (this.terminated) return;
      if (msg.type === 'init') {
        this.emit('message', this.failInit ? { id: msg.id, ok: false, error: 'init failed' } : { id: msg.id, ok: true, info: { runtime: 'fake' } });
      } else {
        const buffer = new Float32Array(msg.texts.length * 2).fill(0.5).buffer;
        this.emit('message', { id: msg.id, ok: true, n: msg.texts.length, dim: 2, buffer });
      }
    });
  }
  terminate() {
    this.terminated = true;
  }
}

const fakeFactory = (options = []) => {
  const workers = [];
  return { workers, make: () => (workers[workers.push(new FakeWorker(options[workers.length] ?? {})) - 1]) };
};

test('lifecycle: a late error/exit from an OLD worker cannot kill its replacement after stop + quick retry', async () => {
  const f = fakeFactory();
  const emb = createWorkerEmbedder({ workerFactory: f.make, availability: () => ({ ok: true }) });
  await emb.start();
  assert.equal(emb.state, 'ready');
  emb.stop();
  assert.equal(emb.state, 'idle');
  assert.equal(f.workers[0].terminated, true);

  await emb.start(); // rapid retry creates a second worker
  assert.equal(f.workers.length, 2);
  assert.equal(emb.state, 'ready');

  // the old worker reports its death late
  f.workers[0].emit('error', new Error('late crash'));
  f.workers[0].emit('exit', 1);
  assert.equal(emb.state, 'ready');
  assert.equal(emb.error, null);
  assert.equal(f.workers[1].terminated, false);
  assert.equal((await emb.embed(['a', 'b'])).length, 2);

  // the CURRENT worker dying is still handled, and the next call starts a fresh one
  f.workers[1].emit('exit', 1);
  assert.equal(emb.state, 'error');
  assert.match(emb.error, /exited with code 1/);
  assert.equal((await emb.embed(['x'])).length, 1);
  assert.equal(f.workers.length, 3);
  assert.equal(emb.state, 'ready');
  emb.stop();
});

test('lifecycle: a failed load reports an error, and the retry is not poisoned by the failed worker', async () => {
  const f = fakeFactory([{ failInit: true }, {}]);
  const emb = createWorkerEmbedder({ workerFactory: f.make, availability: () => ({ ok: true }) });
  await assert.rejects(emb.start(), /init failed/);
  assert.equal(emb.state, 'error');
  assert.equal(f.workers[0].terminated, true);
  await emb.start();
  assert.equal(emb.state, 'ready');
  f.workers[0].emit('exit', 1); // old failed worker exits late
  assert.equal(emb.state, 'ready');
  assert.equal(f.workers[1].terminated, false);
  emb.stop();
});

test('lifecycle: stopping rejects work that was waiting on the stopped worker', async () => {
  const f = fakeFactory();
  const emb = createWorkerEmbedder({ workerFactory: f.make, availability: () => ({ ok: true }), timeoutMs: 5000 });
  await emb.start();
  const w = f.workers[0];
  w.postMessage = () => {}; // this worker will never answer
  const job = emb.embed(['stuck']);
  await new Promise((r) => setImmediate(r));
  emb.stop();
  await assert.rejects(job, /Stopped/);
});
