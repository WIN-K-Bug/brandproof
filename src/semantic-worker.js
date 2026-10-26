// Runs the local embedding model in a worker thread so the HTTP server stays responsive.
// Offline only: the model files are loaded from the project cache after an integrity check.
import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { model, modelDir, modelsRoot } = workerData;
let extractor = null;

function verifyFiles() {
  for (const [name, meta] of Object.entries(model.files)) {
    const buf = readFileSync(path.join(modelDir, name));
    if (buf.length !== meta.size) throw new Error(`Model file ${name} has the wrong size.`);
    const sha = createHash('sha256').update(buf).digest('hex');
    if (meta.sha256 && sha !== meta.sha256) throw new Error(`Model file ${name} failed its SHA-256 check.`);
  }
}

async function init() {
  verifyFiles();
  const tf = await import('@huggingface/transformers');
  tf.env.allowRemoteModels = false;
  tf.env.allowLocalModels = true;
  tf.env.useBrowserCache = false;
  tf.env.localModelPath = modelsRoot.replace(/\\/g, '/') + '/';
  extractor = await tf.pipeline('feature-extraction', model.id, { dtype: model.dtype, local_files_only: true });
  return { runtime: `@huggingface/transformers ${tf.env.version ?? ''}`.trim() };
}

async function embed(texts) {
  const out = await extractor(texts, { pooling: model.pooling, normalize: model.normalize });
  const [n, dim] = out.dims;
  const flat = Float32Array.from(out.data);
  return { n, dim, buffer: flat.buffer };
}

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'init') parentPort.postMessage({ id: msg.id, ok: true, info: await init() });
    else {
      const r = await embed(msg.texts);
      parentPort.postMessage({ id: msg.id, ok: true, ...r }, [r.buffer]);
    }
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String(e?.message ?? e) });
  }
});
