import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { tempDir } from './helpers.js';

const occupy = (count) =>
  Promise.all(
    Array.from({ length: count }, () => new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => resolve(s));
    })),
  );

test('port fallback: retrying a run of busy ports leaves no listeners behind (no MaxListeners warning) and the first free port works', async () => {
  const tmp = await tempDir();
  const blockers = await occupy(14);
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on('warning', onWarning);
  const app = await createApp({ dataFile: path.join(tmp.dir, 'data.json'), semantic: null });
  const baseline = { listening: app.server.listenerCount('listening'), error: app.server.listenerCount('error') };
  try {
    const busy = blockers.map((s) => s.address().port);
    for (const p of busy) {
      await assert.rejects(app.listen(p), (e) => e.code === 'EADDRINUSE');
    }
    assert.equal(app.server.listenerCount('listening'), baseline.listening, 'failed attempts removed their callbacks');
    assert.equal(app.server.listenerCount('error'), baseline.error);
    await new Promise((r) => setImmediate(r));
    assert.ok(!warnings.includes('MaxListenersExceededWarning'), warnings.join(','));
    const url = await app.listen(0);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${url}/api/meta`);
    assert.equal(res.status, 200);
    assert.equal(app.server.listenerCount('listening'), baseline.listening, 'the success path also cleans up');
    assert.equal(app.server.listenerCount('error'), baseline.error);
  } finally {
    process.off('warning', onWarning);
    await app.close();
    await Promise.all(blockers.map((s) => new Promise((r) => s.close(r))));
    await tmp.cleanup();
  }
});
