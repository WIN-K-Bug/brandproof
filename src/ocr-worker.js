// Dedicated worker thread that hosts Tesseract.js. The parent (src/ocr.js) can terminate THIS thread at any time (timeout,
// cancel, crash) and everything Tesseract started inside it goes with it. It only ever reads language data from the local
// directory it is given; with `langPath` always set the library never falls back to a CDN (verified in the Phase A proof).
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const say = (m) => parentPort.postMessage(m);
let tess = null;

async function start() {
  const Tesseract = require('tesseract.js');
  tess = await Tesseract.createWorker(workerData.lang, Tesseract.OEM.LSTM_ONLY, {
    langPath: workerData.langDir,
    gzip: false,
    cacheMethod: 'none',
    logger: () => {},
    // Without an errorHandler the library throws from an event callback and takes the whole process down.
    errorHandler: (e) => say({ type: 'error', message: String(e?.message ?? e) }),
  });
  say({ type: 'ready', runtime: { tesseractJs: require('tesseract.js/package.json').version, core: require('tesseract.js-core/package.json').version } });
}

parentPort.on('message', async (m) => {
  if (m?.type !== 'recognize') return;
  try {
    const t0 = performance.now();
    const r = await tess.recognize(Buffer.from(m.bytes), {}, { text: true });
    say({ type: 'result', id: m.id, text: String(r.data.text ?? ''), confidence: Number.isFinite(r.data.confidence) ? r.data.confidence : null, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    say({ type: 'error', id: m.id, message: String(e?.message ?? e) });
  }
});

start().catch((e) => say({ type: 'error', message: String(e?.message ?? e) }));
