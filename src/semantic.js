/**
 * "AI source matching": local embeddings + cosine similarity between campaign passages and
 * approved source statements.
 *
 * What this is: a relevance retriever. What it is NOT: a fact checker. Similarity never means a
 * claim is true, false, supported, contradicted or in breach of policy, and nothing here feeds
 * findings, eligibility or approval. No text leaves this machine: the model runs in a worker
 * thread from files in the project cache, with remote model loading switched off.
 */
import { Worker } from 'node:worker_threads';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './util.js';
import { MODEL, MODEL_DIR, MODELS_ROOT } from './semantic-paths.js';

export const LIMITS = { passages: 8, passageChars: 500, totalChars: 2000, topK: 3, maxPending: 4, timeoutMs: 60_000, cachedGuidelines: 4 };

/** Descriptive bands over cosine similarity. Heuristic thresholds, not probabilities. */
export const BANDS = { relevant: 0.5, possible: 0.35 };
export const bandOf = (s) => (s >= BANDS.relevant ? 'relevant' : s >= BANDS.possible ? 'possible' : 'low');

export const DISCLAIMER =
  'Similarity shows topical relevance only. It does not say a claim is true, false, supported, contradicted or in breach of a rule, and it plays no part in findings or approval.';

/**
 * Retrieval candidates from the guideline library.
 * `linkStates` maps entry id -> the CURRENT state of the registered source version it cites (from the evidence manifest).
 *  - a legacy (typed) entry is kept as before;
 *  - an entry linked to a registered source is kept ONLY while that version is active, and then carries `registered`
 *    provenance so the exact passage can be opened;
 *  - a linked entry whose source was withdrawn, replaced or is missing is dropped. If the states are not supplied at all,
 *    linked entries are dropped too (fail closed).
 */
export function semanticSources(g, linkStates = null) {
  const out = [];
  const add = (id, kind, label, text, source, entry) => {
    let registered = null;
    if (entry?.source?.sourceId) {
      if (linkStates?.[entry.id] !== 'active') return;
      const l = entry.source;
      registered = { sourceId: l.sourceId, version: l.version, start: l.start, end: l.end };
    }
    out.push({ id, kind, label, text, quote: source.quote, doc: source.doc, section: source.section, registered });
  };
  for (const f of g.facts) add(f.id, 'Approved fact', f.label, `${f.label}. ${f.statement}`, f.source, f);
  for (const t of g.terms) add(t.id, 'Terminology rule', t.preferred || t.avoid.map((a) => a.text).join(', '), t.reason, t.source, t);
  add(g.claims.ruleId, 'Policy', 'Claims substantiation', g.claims.source.quote, g.claims.source);
  add(g.accessibility.ruleId, 'Policy', 'Text contrast', g.accessibility.source.quote, g.accessibility.source);
  add(g.altText.ruleId, 'Policy', 'Image alt text', g.altText.source.quote, g.altText.source);
  add(g.palette.ruleId, 'Policy', 'Brand palette', g.palette.source.quote, g.palette.source);
  add(g.style.exclamation.ruleId, 'Policy', 'Punctuation style', g.style.exclamation.source.quote, g.style.exclamation.source);
  return out;
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

// ---------- worker-backed embedder ----------

export function localAvailability() {
  const missing = [];
  try {
    import.meta.resolve('@huggingface/transformers');
  } catch {
    missing.push('the optional package @huggingface/transformers is not installed (run: npm install)');
  }
  for (const [name, meta] of Object.entries(MODEL.files)) {
    const f = path.join(MODEL_DIR, name);
    if (!existsSync(f) || statSync(f).size !== meta.size) {
      missing.push(`model file ${name} is missing from ${MODELS_ROOT} (run: npm run fetch-model)`);
      break;
    }
  }
  return missing.length ? { ok: false, reason: missing.join('; ') } : { ok: true };
}

/**
 * Worker-backed embedder. Every worker is wrapped with its own identity: callbacks from a worker that
 * is no longer the current one (a late error/exit/message after kill + quick retry) are ignored, so a
 * dying old worker can never take down its replacement.
 *
 * Test seams (never used by the app): `workerFactory` builds the Worker, `availability` replaces the file check.
 */
export function createWorkerEmbedder({ timeoutMs = LIMITS.timeoutMs, workerFactory, availability = localAvailability } = {}) {
  const workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'semantic-worker.js');
  const makeWorker = workerFactory ?? (() => new Worker(workerFile, { workerData: { model: MODEL, modelDir: MODEL_DIR, modelsRoot: MODELS_ROOT } }));
  let current = null; // the only worker whose callbacks count
  let starting = null;
  let nextId = 0;
  const waiting = new Map(); // id -> { worker, resolve, reject, timer }
  const self = { state: 'idle', error: null, runtime: null };

  /** Stop `w` (if it is still current) and fail everything waiting on it. */
  function kill(w, reason) {
    if (w !== current) return; // already replaced or stopped: nothing to do
    current = null; // clear the reference BEFORE terminating, so its exit event is recognised as stale
    starting = null;
    self.state = reason ? 'error' : 'idle';
    self.error = reason ?? null;
    for (const [id, job] of waiting) {
      if (job.worker !== w) continue;
      clearTimeout(job.timer);
      waiting.delete(id);
      job.reject(new Error(reason ?? 'Stopped'));
    }
    try {
      w.terminate();
    } catch {}
  }

  const call = (w, payload, transfer) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        if (!waiting.has(id)) return;
        kill(w, 'The local model timed out and was stopped.');
        if (waiting.delete(id)) reject(new Error('Local model did not answer in time.'));
      }, timeoutMs);
      waiting.set(id, { worker: w, resolve, reject, timer });
      w.postMessage({ id, ...payload }, transfer);
    });

  function start() {
    if (starting) return starting;
    const avail = availability();
    if (!avail.ok) {
      self.state = 'unavailable';
      self.error = avail.reason;
      return Promise.reject(new Error(avail.reason));
    }
    self.state = 'loading';
    self.error = null;
    const w = makeWorker();
    current = w;
    w.on('message', (m) => {
      const job = waiting.get(m.id);
      if (!job || job.worker !== w || w !== current) return;
      clearTimeout(job.timer);
      waiting.delete(m.id);
      m.ok ? job.resolve(m) : job.reject(new Error(m.error));
    });
    w.on('error', (e) => kill(w, `Local model worker crashed: ${e.message}`));
    w.on('exit', (code) => {
      if (code !== 0) kill(w, `Local model worker exited with code ${code}.`);
    });
    starting = call(w, { type: 'init' }).then(
      (m) => {
        if (w === current) {
          self.state = 'ready';
          self.runtime = m.info.runtime;
        }
        return m;
      },
      (e) => {
        kill(w, `Local model failed to load: ${e.message}`);
        throw e;
      },
    );
    return starting;
  }

  self.start = start;
  self.available = availability;
  self.embed = async (texts) => {
    await start();
    const w = current;
    if (!w) throw new Error('Local model is not running.');
    const m = await call(w, { type: 'embed', texts });
    const flat = new Float32Array(m.buffer);
    return Array.from({ length: m.n }, (_, i) => flat.slice(i * m.dim, (i + 1) * m.dim));
  };
  self.stop = () => kill(current, null);
  return self;
}

// ---------- service ----------

export function createSemantic({ embedder, lazy = true } = {}) {
  const cache = new Map(); // guideline hash -> { sources, vectors }
  let pending = 0;
  let chain = Promise.resolve();

  const status = () => {
    if (!embedder) return { state: 'unavailable', reason: 'Semantic matching is switched off.', model: null, mode: 'off' };
    const a = embedder.available?.() ?? { ok: true };
    const state = !a.ok ? 'unavailable' : embedder.state;
    return {
      state,
      reason: !a.ok ? a.reason : embedder.error,
      mode: 'local-embeddings',
      model: { id: MODEL.id, revision: MODEL.revision, dtype: MODEL.dtype, license: MODEL.license, dimensions: MODEL.dimensions },
      runtime: embedder.runtime ?? null,
      note: 'Runs on this computer in a worker thread. No text is sent to any service. Not a generative model.',
      cachedGuidelineSets: cache.size,
    };
  };

  /** One embedding job at a time, bounded queue. */
  const enqueue = (fn) => {
    if (pending >= LIMITS.maxPending) throw new HttpError(429, 'busy', 'The local matcher is busy. Try again in a moment.');
    pending++;
    const run = chain.then(fn);
    chain = run.catch(() => {}).finally(() => pending--);
    return run;
  };

  // Cached per guideline hash AND per set of active registered passages (sourcesKey): either changing means new vectors.
  async function sourceVectors(cacheKey, guidelines, extraSources, linkStates) {
    const hit = cache.get(cacheKey);
    if (hit) {
      cache.delete(cacheKey); // refresh LRU order
      cache.set(cacheKey, hit);
      return { ...hit, cached: true };
    }
    const sources = [...semanticSources(guidelines, linkStates), ...extraSources];
    const vectors = await embedder.embed(sources.map((s) => s.text));
    const entry = { sources, vectors };
    cache.set(cacheKey, entry);
    while (cache.size > LIMITS.cachedGuidelines) cache.delete(cache.keys().next().value);
    return { ...entry, cached: false };
  }

  async function match({ passages, guidelines, guidelineHash, extraSources = [], sourcesKey = '', linkStates = null }) {
    if (!embedder) throw new HttpError(503, 'semantic_unavailable', 'Semantic matching is switched off.');
    const avail = embedder.available?.() ?? { ok: true };
    if (!avail.ok) throw new HttpError(503, 'semantic_unavailable', `AI source matching is unavailable: ${avail.reason}`);
    return enqueue(async () => {
      const t0 = Date.now();
      let src;
      let vecs;
      try {
        src = await sourceVectors(`${guidelineHash}|${sourcesKey}`, guidelines, extraSources, linkStates);
        vecs = await embedder.embed(passages.map((p) => p.text));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(503, 'semantic_unavailable', `AI source matching failed: ${e.message}`);
      }
      const results = passages.map((p, i) => {
        const ranked = src.sources
          .map((s, j) => ({ s, sim: Math.max(-1, Math.min(1, dot(vecs[i], src.vectors[j]))) }))
          .sort((a, b) => b.sim - a.sim);
        const top = ranked.slice(0, LIMITS.topK).map(({ s, sim }) => ({
          sourceId: s.id,
          kind: s.kind,
          label: s.label,
          similarity: Math.round(sim * 1000) / 1000,
          band: bandOf(sim),
          quote: s.quote,
          doc: s.doc,
          section: s.section,
          registered: s.registered ?? null, // set only for passages of ACTIVE approved registered sources
        }));
        return { start: p.start, end: p.end, text: p.text, best: top[0]?.similarity ?? null, matches: top };
      });
      return { results, sourceCount: src.sources.length, sourceCacheHit: src.cached, ms: Date.now() - t0 };
    });
  }

  return { status, match, warm: () => embedder?.start?.().catch(() => {}), cache, stop: () => embedder?.stop?.() };
}
