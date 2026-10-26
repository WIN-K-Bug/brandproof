/**
 * Optional local OCR: read the text out of a RETAINED campaign image, as an editable DRAFT for a person to check.
 *
 * What this is: an offline Tesseract.js (pinned, see ocr-engine.json) in a dedicated worker thread, run only when a person
 * asks, on image bytes this workspace retains and has just verified. What it is not: it is not a verifier. Its confidence is the
 * engine's own heuristic, not correctness. Numbers are never "fixed". A draft is held only in memory, bound to the exact image
 * digest and engine, and becomes part of a campaign only when a person confirms (a possibly corrected) transcription.
 *
 * Bounds: ONE recognition at a time, at most `maxQueued` waiting (more are refused with 429), a hard timeout that terminates
 * the worker thread, cancellation through an AbortSignal, a result-size cap, a bounded draft cache, and the worker is stopped
 * after it has been idle. Any worker failure (error event, exit, timeout, cancel) fails only the job that was running, and the
 * next job starts a fresh worker; callbacks from a worker that is no longer the current one are ignored.
 *
 * Absent or damaged components are reported as unavailable, never replaced by a download: the language data must exist locally
 * and match its pinned SHA-256 before a worker is started, and the worker is always given a local path.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { HttpError } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const ENGINE = JSON.parse(readFileSync(path.join(here, 'ocr-engine.json'), 'utf8'));
export const OCR_ROOT = process.env.BRANDPROOF_OCR_DIR || path.join(here, '..', '.cache', 'ocr');
export const LANG_DIR = path.join(OCR_ROOT, ENGINE.language.code);
export const LANG_FILE = path.join(LANG_DIR, ENGINE.language.file);

export const OCR_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  startTimeoutMs: 20_000,
  idleMs: 60_000,
  maxQueued: 2,
  maxTextChars: 4000,
  maxPixels: 4_000_000,
  maxBytes: 2 * 1024 * 1024,
  cacheEntries: 32,
  cacheTtlMs: 3_600_000,
});

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Quick, cheap check: is the optional package installed at the pinned version and is the language file present and the right size? */
export function ocrAvailability({ langFile = LANG_FILE } = {}) {
  const problems = [];
  try {
    const v = require('tesseract.js/package.json').version;
    if (v !== ENGINE.package.version) problems.push(`tesseract.js ${v} is installed but ${ENGINE.package.version} is required (run: npm install)`);
    const c = require('tesseract.js-core/package.json').version;
    if (c !== ENGINE.core.version) problems.push(`tesseract.js-core ${c} is installed but ${ENGINE.core.version} is required`);
  } catch {
    problems.push('the optional package tesseract.js is not installed (run: npm install)');
  }
  if (!existsSync(langFile) || statSync(langFile).size !== ENGINE.language.bytes) problems.push(`English language data is missing or the wrong size (run: npm run fetch-ocr)`);
  return problems.length ? { ok: false, reason: problems.join('; ') } : { ok: true };
}

let verified = null; // { mtimeMs, size } of a language file whose SHA-256 has been checked
/** Full check (hashes the 4 MB language file once per file version). Throws a plain Error naming the problem. */
export function verifyLanguageData(langFile = LANG_FILE) {
  const st = statSync(langFile);
  if (verified && verified.file === langFile && verified.mtimeMs === st.mtimeMs && verified.size === st.size) return;
  const got = sha256(readFileSync(langFile));
  if (got !== ENGINE.language.sha256) throw new Error('the English language data does not match its pinned SHA-256 (run: npm run fetch-ocr)');
  verified = { file: langFile, mtimeMs: st.mtimeMs, size: st.size };
}

const FINGERPRINT = `${ENGINE.package.name}@${ENGINE.package.version}+${ENGINE.core.name}@${ENGINE.core.version}+${ENGINE.language.code}:${ENGINE.language.sha256.slice(0, 16)}`;

/** Remove anything that looks like a file path from an engine message before it can reach a client. */
const clean = (m) => String(m ?? '').replace(/[A-Za-z]:[\\/][^\s'"]*/g, '[path]').replace(/(^|[\s'"(])\/[^\s'"]+/g, '$1[path]').replace(/\s+/g, ' ').slice(0, 200);

/** Normalise engine output: LF line endings, no control characters, trailing spaces removed. Digits and words are never touched. */
export function normaliseDraftText(raw) {
  return String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .normalize('NFC')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function createOcr({ limits = OCR_LIMITS, workerFactory, availability = ocrAvailability, verify = verifyLanguageData, now = () => Date.now() } = {}) {
  const workerFile = path.join(here, 'ocr-worker.js');
  const make = workerFactory ?? (() => new Worker(workerFile, { workerData: { lang: ENGINE.language.code, langDir: LANG_DIR }, resourceLimits: { maxOldGenerationSizeMb: 512 } }));
  const queue = [];
  const cache = new Map(); // `${fingerprint}|${imageSha}` -> result
  const byId = new Map(); // draftId -> result
  let current = null; // { gen, worker, ready: Promise, runtime }
  let running = null;
  let gen = 0;
  let idleTimer = null;
  let lastError = null;

  const trim = () => {
    const t = now();
    for (const [k, r] of cache) {
      if (t - r.createdMs > limits.cacheTtlMs) {
        cache.delete(k);
        byId.delete(r.draftId);
      }
    }
    while (cache.size > limits.cacheEntries) {
      const [k, r] = cache.entries().next().value;
      cache.delete(k);
      byId.delete(r.draftId);
    }
  };

  /** Stop worker `g` if it is still current and fail the job running on it. A stale `g` is ignored. */
  function kill(g, reason, status = 502, code = 'ocr_failed') {
    if (!current || current.gen !== g) return;
    const w = current.worker;
    current = null;
    lastError = reason ?? null;
    const job = running;
    try {
      w.terminate();
    } catch {}
    if (job && job.gen === g) settle(job, { error: new HttpError(status, code, reason ?? 'The text reader stopped.') });
  }

  function settle(job, { value, error }) {
    if (job.done) return;
    job.done = true;
    if (running === job) running = null; // the service is free the moment the job is settled
    clearTimeout(job.timer);
    job.signal?.removeEventListener?.('abort', job.onAbort);
    if (error) job.reject(error);
    else job.resolve(value);
    job.wake?.(); // lets run() move on to the next job
  }

  function armIdle() {
    clearTimeout(idleTimer);
    if (!current || running || queue.length) return;
    idleTimer = setTimeout(() => {
      if (current && !running && !queue.length) kill(current.gen, null);
    }, limits.idleMs);
    idleTimer.unref?.();
  }

  async function ensureWorker() {
    if (current) return current;
    try {
      verify(); // never start a worker unless the language data is present and matches its pin: it must never go looking for it
    } catch (e) {
      throw new HttpError(503, 'ocr_unavailable', `Reading text from images is not available here: ${clean(e?.message ?? e)}. Type the text instead.`);
    }
    const g = ++gen;
    const worker = make();
    const entry = { gen: g, worker, runtime: null };
    entry.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the text reader did not start in time')), limits.startTimeoutMs); // not unref'd: a pending start must be able to time out
      worker.on('message', (m) => {
        if (current?.gen !== g) return; // late message from a worker that is no longer current
        if (m?.type === 'ready') {
          entry.runtime = m.runtime ?? null;
          clearTimeout(t);
          resolve();
        } else if (m?.type === 'error' && !m.id) {
          clearTimeout(t);
          reject(new Error(clean(m.message)));
          kill(g, clean(m.message));
        } else if (m?.type === 'result' && running?.gen === g && running.id === m.id) {
          onResult(running, m);
        } else if (m?.type === 'error' && running?.gen === g && running.id === m.id) {
          kill(g, clean(m.message));
        }
      });
      worker.on('error', (e) => {
        clearTimeout(t);
        reject(e);
        kill(g, clean(e?.message ?? e));
      });
      worker.on('exit', (code) => {
        clearTimeout(t);
        reject(new Error('the text reader stopped'));
        kill(g, code ? `the text reader stopped (exit ${code})` : null);
      });
    });
    current = entry;
    try {
      await entry.ready;
      return entry;
    } catch (e) {
      kill(g, clean(e?.message ?? e));
      throw new HttpError(503, 'ocr_unavailable', `The text reader could not start: ${clean(e?.message ?? e)}`);
    }
  }

  function onResult(job, m) {
    const text = normaliseDraftText(m.text);
    if (text.length > limits.maxTextChars) return settle(job, { error: new HttpError(422, 'ocr_result_too_large', `The reader returned more than ${limits.maxTextChars} characters, which is far more than a banner or post carries. Nothing was kept; type the text instead.`) });
    const result = {
      draftId: `OCR-${randomBytes(8).toString('hex')}`,
      imageSha256: job.sha256,
      text,
      textSha256: sha256(text),
      confidence: m.confidence === null ? null : Math.round(m.confidence),
      engine: { name: ENGINE.package.name, version: ENGINE.package.version, core: ENGINE.core.version, language: ENGINE.language.code, languageData: ENGINE.language.variant, languageSha256: ENGINE.language.sha256, oem: ENGINE.oem },
      ms: m.ms ?? null,
      createdMs: now(),
      createdAt: new Date(now()).toISOString(),
    };
    cache.set(`${FINGERPRINT}|${job.sha256}`, result);
    byId.set(result.draftId, result);
    trim();
    settle(job, { value: { ...result, cached: false } });
  }

  async function run(job) {
    try {
      const w = await ensureWorker();
      if (job.done) return;
      job.gen = w.gen;
      job.timer = setTimeout(() => kill(w.gen, `The text reader took longer than ${Math.round(limits.timeoutMs / 1000)} seconds and was stopped.`, 504, 'ocr_timeout'), limits.timeoutMs); // not unref'd: a running job must always be able to time out
      w.worker.postMessage({ type: 'recognize', id: job.id, bytes: job.bytes });
      await job.promise.catch(() => {});
    } catch (e) {
      settle(job, { error: e instanceof HttpError ? e : new HttpError(502, 'ocr_failed', clean(e?.message ?? e)) });
    }
  }

  async function pump() {
    if (running || !queue.length) return;
    const job = queue.shift();
    running = job;
    clearTimeout(idleTimer);
    await run(job);
    if (running === job) running = null;
    armIdle();
    pump();
  }

  return {
    status() {
      const a = availability();
      return {
        state: a.ok ? (current ? 'running' : 'ready') : 'unavailable',
        ...(a.ok ? {} : { reason: a.reason }),
        ...(lastError ? { lastError } : {}),
        engine: { name: ENGINE.package.name, version: ENGINE.package.version, core: ENGINE.core.version, language: ENGINE.language.code, languageData: ENGINE.language.variant, licenses: 'Apache-2.0 (engine, WASM core and English data)' },
        limits: { timeoutSeconds: limits.timeoutMs / 1000, queued: limits.maxQueued, maxPixels: limits.maxPixels, maxResultChars: limits.maxTextChars },
        busy: Boolean(running),
        queued: queue.length,
        note: 'Runs on this computer in its own worker thread; no image or text is sent anywhere. It reads text only when asked, and returns a DRAFT for a person to check: its confidence is the engine\'s own heuristic, not correctness, and it does not read colours, contrast or logos.',
      };
    },

    /** The stored draft with this id, if it is still held (drafts live in memory only). */
    lookup(draftId) {
      trim();
      return byId.get(draftId) ?? null;
    },

    /**
     * Read the text of the image whose bytes (already verified against `sha256` by the caller) are given.
     * Resolves a result bound to that exact digest. Rejects with an HttpError: 503 unavailable, 429 busy, 504 timeout,
     * 502 failed, 422 result too large, 409 cancelled.
     */
    extract({ sha256: imageSha, bytes, signal }) {
      const a = availability();
      if (!a.ok) return Promise.reject(new HttpError(503, 'ocr_unavailable', `Reading text from images is not available here: ${a.reason}. Type the text instead.`));
      trim();
      const hit = cache.get(`${FINGERPRINT}|${imageSha}`);
      if (hit) return Promise.resolve({ ...hit, cached: true });
      if (signal?.aborted) return Promise.reject(new HttpError(409, 'ocr_cancelled', 'The request was cancelled.'));
      if (queue.length >= limits.maxQueued) return Promise.reject(new HttpError(429, 'ocr_busy', 'The text reader is busy with other images. Try again in a moment.'));
      return new Promise((resolve, reject) => {
        const job = { id: randomBytes(6).toString('hex'), sha256: imageSha, bytes, resolve, reject, signal, done: false, gen: 0, timer: null };
        job.promise = new Promise((res) => (job.wake = res));
        job.onAbort = () => {
          const i = queue.indexOf(job);
          if (i >= 0) queue.splice(i, 1);
          if (running === job && current) kill(current.gen, 'The request was cancelled.', 409, 'ocr_cancelled');
          settle(job, { error: new HttpError(409, 'ocr_cancelled', 'The request was cancelled.') });
        };
        signal?.addEventListener?.('abort', job.onAbort, { once: true });
        queue.push(job);
        pump();
      });
    },

    /** Stop the worker and fail everything pending (server shutdown). */
    stop() {
      clearTimeout(idleTimer);
      for (const job of queue.splice(0)) settle(job, { error: new HttpError(503, 'ocr_unavailable', 'The server is stopping.') });
      if (running) settle(running, { error: new HttpError(503, 'ocr_unavailable', 'The server is stopping.') });
      if (current) kill(current.gen, null);
    },
  };
}
