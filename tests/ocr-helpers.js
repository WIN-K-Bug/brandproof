import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcr, OCR_LIMITS } from '../src/ocr.js';
import { sha256Hex } from '../src/assets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name) => readFileSync(path.join(here, 'fixtures', 'ocr', `${name}.png`));
export const fixtureSha = (name) => sha256Hex(fixture(name));

/**
 * A stand-in for the worker thread (the same small message protocol as src/ocr-worker.js), so the service's timeouts,
 * crashes, cancellation and late callbacks can be tested deterministically without the real engine.
 * `behave(job, worker)` decides what each recognition does: 'ok' | 'hang' | 'error' | 'crash' | 'exit' | { text, confidence } | a function.
 */
export function fakeReader({ behave = () => 'ok', startup = 'ready', texts = {} } = {}) {
  const log = { created: 0, terminated: 0, jobs: [], workers: [] };
  const factory = () => {
    const w = new EventEmitter();
    w.id = ++log.created;
    w.dead = false;
    w.postMessage = (m) => {
      if (m.type !== 'recognize') return;
      log.jobs.push({ worker: w.id, id: m.id, bytes: m.bytes.length });
      const act = typeof behave === 'function' ? behave({ id: m.id, bytes: m.bytes, worker: w.id, n: log.jobs.length }, w) : behave;
      const send = (extra) => setImmediate(() => !w.dead && w.emit('message', { type: 'result', id: m.id, text: 'DRAFT TEXT', confidence: 91.4, ms: 5, ...extra }));
      if (act === 'ok') send({});
      else if (act && typeof act === 'object' && 'text' in act) send(act);
      else if (act === 'error') setImmediate(() => w.emit('message', { type: 'error', id: m.id, message: 'engine failed at C:\\Users\\someone\\secret\\path\\x.wasm and /home/me/secret' }));
      else if (act === 'crash') setImmediate(() => w.emit('error', new Error('worker blew up at C:\\Users\\someone\\x')));
      else if (act === 'exit') setImmediate(() => w.emit('exit', 7));
      // 'hang': never answers
    };
    w.terminate = () => {
      log.terminated++;
      w.dead = true;
      return Promise.resolve();
    };
    log.workers.push(w);
    if (startup === 'ready') setImmediate(() => w.emit('message', { type: 'ready', runtime: { tesseractJs: 'fake', core: 'fake' } }));
    else if (startup === 'error') setImmediate(() => w.emit('message', { type: 'error', message: 'language data missing at C:\\Users\\someone\\x' }));
    // 'never': no ready, no error
    return w;
  };
  return { factory, log };
}

/** A reader service over the fake worker; verification and availability are stubbed (the real checks have their own tests). */
export function fakeOcr(opts = {}, limits = {}) {
  const fake = fakeReader(opts);
  const ocr = createOcr({ limits: { ...OCR_LIMITS, ...limits }, workerFactory: fake.factory, availability: () => ({ ok: true }), verify: () => {}, ...(opts.service ?? {}) });
  return { ocr, ...fake };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
