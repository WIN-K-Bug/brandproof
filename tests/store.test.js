import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Store, emptyState } from '../src/store.js';
import { createUnconfiguredProvider, validateProvider, describeEngine, AiUnavailableError } from '../src/ai.js';
import { diffText } from '../src/diff.js';
import { tempDir } from './helpers.js';

test('concurrent mutations are serialised: no lost updates', async () => {
  const tmp = await tempDir();
  try {
    const file = path.join(tmp.dir, 's.json');
    const store = await Store.open(file, () => ({ ...emptyState(), counter: 0, items: [] }));
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.mutate((d) => {
          d.counter += 1;
          d.items.push(i);
        }),
      ),
    );
    await store.close();
    assert.equal(store.state.counter, 50);
    assert.deepEqual([...store.state.items].sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i));
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(onDisk.counter, 50);
    assert.deepEqual((await fs.readdir(tmp.dir)).filter((n) => n.endsWith('.tmp')), []);
  } finally {
    await tmp.cleanup();
  }
});

test('a failing mutation changes nothing in memory or on disk, and does not block later ones', async () => {
  const tmp = await tempDir();
  try {
    const file = path.join(tmp.dir, 's.json');
    const store = await Store.open(file, () => ({ ...emptyState(), n: 1 }));
    await assert.rejects(
      store.mutate((d) => {
        d.n = 999;
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(store.state.n, 1);
    await store.mutate((d) => {
      d.n = 2;
    });
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).n, 2);
  } finally {
    await tmp.cleanup();
  }
});

test('committed state is frozen and survives a reload', async () => {
  const tmp = await tempDir();
  try {
    const file = path.join(tmp.dir, 's.json');
    const store = await Store.open(file, () => ({ ...emptyState(), items: ['a'] }));
    assert.throws(() => store.state.items.push('b'), TypeError);
    await store.mutate((d) => d.items.push('b'));
    await store.close(); // the first owner lets go before the file is opened again
    const again = await Store.open(file, () => assert.fail('must not reseed'));
    assert.deepEqual(again.state.items, ['a', 'b']);
    await again.close();
  } finally {
    await tmp.cleanup();
  }
});

test('async mutate callbacks are refused; corrupted or wrong-schema files are never overwritten', async () => {
  const tmp = await tempDir();
  try {
    const file = path.join(tmp.dir, 's.json');
    const store = await Store.open(file, () => emptyState());
    await assert.rejects(store.mutate(async () => {}), /synchronous/);
    await store.close();

    await fs.writeFile(file, '{not json');
    await assert.rejects(Store.open(file, () => emptyState()), /not valid JSON/);
    assert.equal(await fs.readFile(file, 'utf8'), '{not json');

    await fs.writeFile(file, JSON.stringify({ schemaVersion: 99 }));
    await assert.rejects(Store.open(file, () => emptyState()), /schema version/);
  } finally {
    await tmp.cleanup();
  }
});

test('word diff marks insertions and deletions and round-trips both sides', () => {
  const a = 'Meet the aurora lamp today.';
  const b = 'Meet the Aurora Lamp today, friends.';
  const ops = diffText(a, b);
  assert.equal(ops.filter((o) => o.type !== 'add').map((o) => o.text).join(''), a);
  assert.equal(ops.filter((o) => o.type !== 'del').map((o) => o.text).join(''), b);
  assert.deepEqual(diffText('same', 'same'), [{ type: 'equal', text: 'same' }]);
});

test('AI adapter contract: unconfigured provider refuses, engine never claims contextual AI', async () => {
  const p = createUnconfiguredProvider();
  assert.deepEqual(validateProvider(p), []);
  await assert.rejects(p.review({}), (e) => e instanceof AiUnavailableError && e.code === 'AI_UNAVAILABLE');
  const e = describeEngine(p);
  assert.equal(e.mode, 'rules');
  assert.equal(e.contextualAi.available, false);
  assert.match(e.contextualAi.message, /unavailable/i);
  assert.ok(validateProvider({}).length >= 3);
  // even a provider that claims to be ready is not reported as available: the pipeline does not call it yet
  const fakeReady = { id: 'x', status: 'ready', describe: () => ({ status: 'ready', message: 'ok' }), review: async () => ({ findings: [] }) };
  assert.equal(describeEngine(fakeReady).contextualAi.available, false);
});
