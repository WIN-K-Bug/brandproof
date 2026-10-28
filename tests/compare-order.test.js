// m33: the answer to "Compare with revision N" belongs to the comparison the person is waiting for. The browser proof is
// scripts/browser/ui-smoke-compare-order.mjs (real browser, real server, only response delivery held). These are the fast checks of the same rules on the real
// source: openCompare is lifted out of public/workspace.js and run with controllable requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const publicFile = (name) => readFileSync(path.join(import.meta.dirname, '..', 'public', name), 'utf8');
const between = (text, from, to) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `source markers not found: ${from} .. ${to}`);
  return text.slice(a, b);
};

function rig() {
  const ui = between(publicFile('ui.js'), 'export const state', 'export const isAuthed').replaceAll('export ', '');
  const fn = between(publicFile('workspace.js'), 'async function openCompare', '\nfunction miniFinding');
  const log = { paints: [], toasts: [] };
  const gates = [];
  const sandbox = {
    console,
    view: { id: 'A', route: 0, mode: 'view', compare: null },
    toast: (text, kind) => log.toasts.push({ text, kind }),
    describeError: (e) => e.message,
    paint: () => log.paints.push({ id: sandbox.view.id, mode: sandbox.view.mode, from: sandbox.view.compare?.from, to: sandbox.view.compare?.to }),
    // each comparison request is answered by the "server" at once and DELIVERED when its gate is opened (or refused when `refuse` is set)
    api: async (method, p) => {
      const m = p.match(/^\/api\/submissions\/([^/]+)\/compare\?from=(\d+)&to=(\d+)$/);
      assert.ok(m, `unexpected request ${p}`);
      const g = gates.shift();
      const answer = g?.refuse ? { e: Object.assign(new Error('Revision not found.'), { status: 404 }) } : { v: { id: m[1], from: Number(m[2]), to: Number(m[3]), text: [], assetFields: [], findings: {}, note: '' } };
      if (g) await g.promise;
      if (answer.e) throw answer.e;
      return answer.v;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${ui}\nlet compareSeq = 0;\n${fn}\nglobalThis.state = state;\nglobalThis.openCompare = openCompare;\nglobalThis.bump = () => compareSeq++;`, sandbox);
  const hold = (refuse = false) => {
    let open;
    const g = { promise: new Promise((r) => (open = r)), refuse, open: () => open() };
    gates.push(g);
    return g;
  };
  return { sandbox, log, hold };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('control: a comparison the person is waiting for is shown', async () => {
  const r = rig();
  await r.sandbox.openCompare(1, 2);
  assert.deepEqual(r.log.paints, [{ id: 'A', mode: 'compare', from: 1, to: 2 }]);
  assert.deepEqual(r.log.toasts, []);
});

test('control: a refusal for the comparison the person is waiting for is reported', async () => {
  const r = rig();
  r.hold(true).open();
  await r.sandbox.openCompare(1, 99);
  assert.deepEqual(r.log.toasts, [{ text: 'Revision not found.', kind: 'err' }]);
  assert.deepEqual(r.log.paints, []);
  assert.equal(r.sandbox.view.mode, 'view');
});

test('late success after the person went to another campaign: nothing is applied, painted or announced', async () => {
  const r = rig();
  const g = r.hold();
  const p = r.sandbox.openCompare(1, 2);
  await tick();
  r.sandbox.view.id = 'B'; // B committed ...
  r.sandbox.bump(); // ... which invalidates a comparison still on its way
  g.open();
  await p;
  assert.deepEqual(r.log.paints, []);
  assert.equal(r.sandbox.view.compare, null);
  assert.equal(r.sandbox.view.mode, 'view');
});

test('late success after the person went to another PAGE (the library, a dossier): dropped', async () => {
  const r = rig();
  const g = r.hold();
  const p = r.sandbox.openCompare(1, 2);
  await tick();
  r.sandbox.state.route++; // another page owns the screen now; the workspace was not repainted
  g.open();
  await p;
  assert.deepEqual(r.log.paints, []);
  assert.equal(r.sandbox.view.compare, null);
  assert.equal(r.sandbox.view.mode, 'view');
});

test('late refusal after the person moved on: silent (no message over another page)', async () => {
  const toAnotherCampaign = (r) => {
    r.sandbox.view.id = 'B';
    r.sandbox.bump();
  };
  const toAnotherPage = (r) => r.sandbox.state.route++;
  for (const away of [toAnotherCampaign, toAnotherPage]) {
    const r = rig();
    const g = r.hold(true);
    const p = r.sandbox.openCompare(1, 99);
    await tick();
    away(r);
    g.open();
    await p;
    assert.deepEqual(r.log.toasts, []);
    assert.deepEqual(r.log.paints, []);
  }
});

test('two overlapping choices, the latest answer arriving first: the latest choice stays', async () => {
  const r = rig();
  const g1 = r.hold();
  const g2 = r.hold();
  const older = r.sandbox.openCompare(1, 2);
  const latest = r.sandbox.openCompare(2, 3);
  await tick();
  g2.open();
  await latest;
  g1.open();
  await older;
  assert.deepEqual(r.log.paints, [{ id: 'A', mode: 'compare', from: 2, to: 3 }]);
  assert.equal(r.sandbox.view.compare.to, 3);
});

test('two overlapping choices, the oldest answer arriving first: it is not shown, the latest choice ends up shown', async () => {
  const r = rig();
  const g1 = r.hold();
  const g2 = r.hold();
  const older = r.sandbox.openCompare(1, 2);
  const latest = r.sandbox.openCompare(2, 3);
  await tick();
  g1.open();
  await older;
  assert.deepEqual(r.log.paints, [], 'the older answer never flashes up');
  g2.open();
  await latest;
  assert.deepEqual(r.log.paints, [{ id: 'A', mode: 'compare', from: 2, to: 3 }]);
});

test('closing the comparison, or starting an edit, while one is pending cannot bring it back', async () => {
  const r = rig();
  const g = r.hold();
  const p = r.sandbox.openCompare(1, 2);
  await tick();
  r.sandbox.bump(); // what Close comparison and startEdit do
  g.open();
  await p;
  assert.deepEqual(r.log.paints, []);
  assert.equal(r.sandbox.view.mode, 'view');
});

test('the three places that must invalidate a pending comparison do: Close comparison, startEdit, and a new paint of the campaign page', () => {
  const src = publicFile('workspace.js');
  assert.match(between(src, 'function startEdit', 'const rev = head();'), /compareSeq\+\+/, 'startEdit');
  const closeLine = src.split('\n').find((l) => l.includes("'Close comparison')"));
  assert.ok(closeLine && /compareSeq\+\+/.test(closeLine), 'Close comparison');
  assert.match(between(src, '  view.route = state.route;', '  paint();'), /compareSeq\+\+/, 'the commit in renderWorkspace');
  assert.doesNotMatch(between(src, 'async function openCompare', '\nfunction miniFinding'), /view\.compare = await/, 'the answer is never stored before it is checked');
});

test('defence in depth: the campaign is compared too, not only the counter (an answer for A is never applied while the page is on B)', async () => {
  const r = rig();
  const g = r.hold();
  const p = r.sandbox.openCompare(1, 2);
  await tick();
  r.sandbox.view.id = 'B'; // deliberately WITHOUT the counter bump that the commit in renderWorkspace adds today
  g.open();
  await p;
  assert.deepEqual(r.log.paints, []);
  assert.equal(r.sandbox.view.compare, null);
});
