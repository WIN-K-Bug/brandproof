// m32: a page's answer that arrives AFTER the person has moved on must not paint, redirect, or change which campaign and draft the page belongs to.
// The browser proof is scripts/browser/ui-smoke-route-order.mjs (real browser, real server, only response delivery held). These are the fast checks of
// the same rules on the real source: renderWorkspace and routeStamp are lifted out of public/*.js and run with controllable requests.
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

/** The real routeStamp and state from ui.js, and the real renderWorkspace from workspace.js, wired to fake requests. */
function rig() {
  const ui = between(publicFile('ui.js'), 'export const state', 'export const isAuthed').replaceAll('export ', '');
  const fn = between(publicFile('workspace.js'), 'export async function renderWorkspace', '\nasync function reload').replace('export async', 'async');
  const log = { paints: [], errors: [], redirects: [], requests: [] };
  const campaigns = { A: { id: 'A' }, B: { id: 'B' }, C: { id: 'C' } };
  const sandbox = {
    console,
    view: { id: null, list: [], detail: null, tab: 'findings', mode: 'view', draft: null, compare: null, active: null, root: null },
    sem: { selected: new Set(), result: null, note: '' },
    refreshSemanticStatus: async () => {},
    paintEmpty: () => log.paints.push('empty'),
    describeError: (e) => e.message,
    h: (tag, props, ...kids) => ({ tag, props, kids }),
    clear: () => ({ append: (...n) => log.errors.push(n.map((x) => x?.kids?.[0] ?? x?.tag ?? '?').join('|')) }),
    api: async (method, p) => {
      log.requests.push(p);
      if (p === '/api/submissions') {
        return { submissions: [{ id: 'A', updatedAt: '2' }, { id: 'B', updatedAt: '1' }] };
      }
      const id = decodeURIComponent(p.split('/').pop());
      if (id === 'GONE') throw Object.assign(new Error('No submission GONE.'), { status: 404 });
      return campaigns[id];
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${ui}\n${fn}\nglobalThis.state = state;\nglobalThis.render = renderWorkspace;`, sandbox);
  sandbox.paint = () => log.paints.push({ selected: sandbox.view.id, detail: sandbox.view.detail.id });
  const root = { scrollIntoView() {} };
  const go = (hash) => log.redirects.push(hash);
  // route(): every navigation bumps the counter, then renders
  const navigate = (id) => {
    sandbox.state.route++;
    return sandbox.render(root, id, go);
  };
  return { sandbox, log, navigate };
}

function gate() {
  let open;
  const promise = new Promise((r) => (open = r));
  return { promise, open };
}

function rigWithGates() {
  const r = rig();
  const gates = new Map();
  const origApi = r.sandbox.api;
  r.sandbox.api = async (method, p) => {
    const id = p === '/api/submissions' ? 'LIST' : decodeURIComponent(p.split('/').pop());
    const g = gates.get(id);
    if (g && !g.used) {
      g.used = true;
      g.entered = true;
      const answered = origApi(method, p).then((v) => ({ v }), (e) => ({ e })); // the server answers at once ...
      await g.promise; // ... only the delivery is held
      const out = await answered;
      if (out.e) throw out.e;
      return out.v;
    }
    return origApi(method, p);
  };
  r.hold = (id) => {
    const g = { ...gate(), used: false, entered: false };
    gates.set(id, g);
    return g;
  };
  return r;
}
const until = async (cond) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(cond(), 'condition not reached');
};

test('control: moving from A to B paints B, with the campaign id and detail in agreement', async () => {
  const r = rigWithGates();
  await r.navigate('A');
  await r.navigate('B');
  assert.deepEqual(r.log.paints, [{ selected: 'A', detail: 'A' }, { selected: 'B', detail: 'B' }]);
});

test('late success: A held, B completes, A released: A is never painted and B stays selected', async () => {
  const r = rigWithGates();
  await r.navigate('B');
  const g = r.hold('A');
  const a = r.navigate('A');
  await until(() => g.entered);
  await r.navigate('B');
  g.open();
  await a;
  assert.deepEqual(r.log.paints, [{ selected: 'B', detail: 'B' }, { selected: 'B', detail: 'B' }]);
  assert.equal(r.sandbox.view.id, 'B');
  assert.equal(r.sandbox.view.detail.id, 'B');
});

test('late refusal: a 404 for an address the person has left paints no error over the current page', async () => {
  const r = rigWithGates();
  await r.navigate('B');
  const g = r.hold('GONE');
  const gone = r.navigate('GONE');
  await until(() => g.entered);
  await r.navigate('B');
  g.open();
  await gone;
  assert.deepEqual(r.log.errors, []);
  assert.equal(r.sandbox.view.id, 'B');
});

test('a refusal for the CURRENT address is still shown (the guard does not hide real errors)', async () => {
  const r = rigWithGates();
  await r.navigate('GONE');
  assert.equal(r.log.errors.length, 1);
  assert.match(r.log.errors[0], /No submission GONE/);
});

test('away: the person leaves the workspace while the detail is pending: nothing is painted afterwards', async () => {
  const r = rigWithGates();
  await r.navigate('B');
  const g = r.hold('A');
  const a = r.navigate('A');
  await until(() => g.entered);
  r.sandbox.state.route++; // the person opens the library; its own renderer owns the page now
  g.open();
  await a;
  assert.equal(r.log.paints.length, 1);
  assert.deepEqual(r.log.errors, []);
  assert.equal(r.sandbox.view.id, 'B');
});

test('list pending, no campaign in the address: a late list does not redirect the person back to the workspace', async () => {
  const r = rigWithGates();
  const g = r.hold('LIST');
  const w = r.navigate(null);
  await until(() => g.entered);
  r.sandbox.state.route++;
  g.open();
  await w;
  assert.deepEqual(r.log.redirects, []);
  assert.equal(r.log.paints.length, 0);
});

test('draft identity: while B is still loading, the page, campaign id and draft stay A\'s; they change to B together, and the draft is dropped', async () => {
  const r = rigWithGates();
  await r.navigate('A');
  r.sandbox.view.mode = 'edit';
  r.sandbox.view.draft = { text: 'A copy being edited' };
  const g = r.hold('B');
  const b = r.navigate('B');
  await until(() => g.entered);
  assert.equal(r.sandbox.view.id, 'A', 'the campaign id does not move ahead of the page');
  assert.equal(r.sandbox.view.detail.id, 'A');
  assert.equal(r.sandbox.view.draft.text, 'A copy being edited', 'the draft still belongs to the page that is still shown');
  g.open();
  await b;
  assert.equal(r.sandbox.view.id, 'B');
  assert.equal(r.sandbox.view.detail.id, 'B');
  assert.equal(r.sandbox.view.draft, null, 'A\'s draft is not carried onto B');
  assert.equal(r.sandbox.view.mode, 'view');
});

test('reload of the same campaign keeps its draft (normal navigation is unchanged)', async () => {
  const r = rigWithGates();
  await r.navigate('A');
  r.sandbox.view.mode = 'edit';
  r.sandbox.view.draft = { text: 'A copy being edited' };
  await r.navigate('A');
  assert.equal(r.sandbox.view.draft?.text, 'A copy being edited');
  assert.equal(r.sandbox.view.mode, 'edit');
});

test('every other page renderer drops its answer once the person has moved on (stamp taken first, checked after each await)', () => {
  const entries = [
    ['dossier.js', 'export async function renderDossier', '\n}\n'],
    ['library.js', 'export async function renderLibrary', '\n}\n'],
    ['queue.js', 'export async function renderQueue', 'const paint = () =>'],
    ['insights.js', 'export async function renderInsights', 'const max ='],
    ['sources.js', 'export async function renderSources', 'const paint = () =>'],
    ['sources.js', 'async function renderDetail', 'const params ='],
  ];
  for (const [file, from, to] of entries) {
    const body = between(publicFile(file), from, to);
    const awaits = (body.match(/\bawait\b/g) || []).length;
    const checks = (body.match(/if \(stale\(\)\) return/g) || []).length;
    assert.match(body, /routeStamp\(\)/, `${file} ${from}: takes a stamp`);
    assert.ok(awaits >= 1 && checks >= awaits, `${file} ${from}: ${awaits} awaits, ${checks} stale checks`);
    // the stamp is taken before the first request
    assert.ok(body.indexOf('routeStamp()') < body.indexOf('await'), `${file} ${from}: the stamp is taken before the first await`);
  }
});

test('the router bumps the counter on every navigation (and there is no second counter)', () => {
  const app = publicFile('app.js');
  assert.match(app, /const token = \+\+state\.route;/);
  assert.doesNotMatch(app, /renderToken/);
});

// ---------- m32b: an ACTION's answer (save, reload) that arrives after the person has gone to another page ----------

/** The real reload and saveRevision from workspace.js, with controllable requests. `route` is state.route: a navigation bumps it. */
function actionRig() {
  const ui = between(publicFile('ui.js'), 'export const state', 'export const isAuthed').replaceAll('export ', '');
  const fns = between(publicFile('workspace.js'), 'async function reload', '\nfunction paintEmpty') + between(publicFile('workspace.js'), 'async function saveRevision', '// ---------- side panel');
  const log = { paints: [], toasts: [], focus: 0, requests: [] };
  const gates = new Map();
  const sandbox = {
    console,
    view: { id: 'A', list: [], detail: { id: 'A', headRevision: 1 }, mode: 'edit', draft: null, active: null, route: 0 },
    toast: (text, kind) => log.toasts.push({ text, kind }),
    describeError: (e) => e.message,
    focusMainHeading: () => log.focus++,
    document: { getElementById: () => null, querySelector: () => null },
    paint: () => log.paints.push(sandbox.view.detail.headRevision),
    api: async (method, p, body) => {
      log.requests.push(`${method} ${p}`);
      const g = gates.get(`${method} ${p}`);
      let out;
      try {
        out = { v: await sandbox.serve(method, p, body) };
      } catch (e) {
        out = { e };
      }
      if (g) await g.promise; // the server answered; only the delivery is held
      if (out.e) throw out.e;
      return out.v;
    },
    serve: async (method, p) => {
      if (p === '/api/submissions') return { submissions: [{ id: 'A' }] };
      if (method === 'POST') return { id: 'A', headRevision: 2 };
      return { id: 'A', headRevision: 2 };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${ui}\n${fns}\nglobalThis.state = state;\nglobalThis.reload = reload;\nglobalThis.saveRevision = saveRevision;`, sandbox);
  const draft = () => ({ saving: false, baseRevision: 1, text: 'x', asset: {}, imageText: {}, lock() {} });
  const hold = (key) => {
    const g = gate();
    gates.set(key, g);
    return g;
  };
  return { sandbox, log, draft, hold, navigate: () => sandbox.state.route++ };
}

test('action: a reload on the page the person is on paints and says so; after they move to another page it brings the state up to date and paints nothing', async () => {
  const r = actionRig();
  assert.equal(await r.sandbox.reload(), true);
  assert.deepEqual(r.log.paints, [2]);
  r.navigate(); // the person opens the library
  r.sandbox.view.detail = { id: 'A', headRevision: 1 };
  assert.equal(await r.sandbox.reload(), false);
  assert.deepEqual(r.log.paints, [2], 'nothing painted over the page they are on');
  assert.equal(r.sandbox.view.detail.headRevision, 2, 'but the campaign state is current for when they return');
});

test('action: a reload for a campaign that is no longer the current one paints and changes nothing', async () => {
  const r = actionRig();
  const g = r.hold('GET /api/submissions');
  const p = r.sandbox.reload();
  await new Promise((x) => setTimeout(x, 5));
  r.sandbox.view.id = 'B';
  r.sandbox.view.detail = { id: 'B', headRevision: 7 };
  g.open();
  assert.equal(await p, false);
  assert.equal(r.sandbox.view.detail.id, 'B');
  assert.deepEqual(r.log.paints, []);
});

test('action: a normal save on the page closes the draft, paints, and moves the focus', async () => {
  const r = actionRig();
  r.sandbox.view.route = r.sandbox.state.route;
  r.sandbox.view.draft = r.draft();
  await r.sandbox.saveRevision();
  assert.deepEqual(r.log.toasts, [{ text: 'Saved revision 2.', kind: 'ok' }]);
  assert.deepEqual(r.log.paints, [2]);
  assert.equal(r.log.focus, 1);
  assert.equal(r.sandbox.view.draft, null);
  assert.equal(r.sandbox.view.mode, 'view');
});

test('action: a save whose answer arrives after the person went to another page is committed, named, closes its draft, and paints nothing', async () => {
  const r = actionRig();
  r.sandbox.view.route = r.sandbox.state.route;
  r.sandbox.view.draft = r.draft();
  const g = r.hold('POST /api/submissions/A/revisions');
  const p = r.sandbox.saveRevision();
  await new Promise((x) => setTimeout(x, 5));
  r.navigate(); // the library
  g.open();
  await p;
  assert.deepEqual(r.log.toasts, [{ text: 'Saved revision 2 of A.', kind: 'ok' }]);
  assert.deepEqual(r.log.paints, []);
  assert.equal(r.log.focus, 0);
  assert.equal(r.sandbox.view.draft, null, 'the saved draft is closed, so going back shows the saved revision, not a stale editor');
  assert.equal(r.sandbox.view.mode, 'view');
  assert.equal(r.sandbox.view.detail.headRevision, 2);
});

test('action: the person goes away while the FOLLOW-UP request of a save is out: nothing is painted and the focus is not moved', async () => {
  const r = actionRig();
  r.sandbox.view.route = r.sandbox.state.route;
  r.sandbox.view.draft = r.draft();
  const g = r.hold('GET /api/submissions');
  const p = r.sandbox.saveRevision();
  await new Promise((x) => setTimeout(x, 5));
  assert.equal(r.log.toasts.length, 1, 'the save itself is already committed and announced');
  r.navigate();
  g.open();
  await p;
  assert.deepEqual(r.log.paints, []);
  assert.equal(r.log.focus, 0);
});

test('action: a save refused after the person went to another page names the campaign and KEEPS the draft', async () => {
  const r = actionRig();
  r.sandbox.view.route = r.sandbox.state.route;
  const dr = r.draft();
  r.sandbox.view.draft = dr;
  r.sandbox.serve = async (method) => {
    if (method === 'POST') throw Object.assign(new Error('Someone saved revision 2 first.'), { status: 409 });
    return { submissions: [] };
  };
  const g = r.hold('POST /api/submissions/A/revisions');
  const p = r.sandbox.saveRevision();
  await new Promise((x) => setTimeout(x, 5));
  r.navigate();
  g.open();
  await p;
  assert.equal(r.log.toasts.length, 1);
  assert.match(r.log.toasts[0].text, /^The save of A was not made\. Someone saved revision 2 first\./);
  assert.equal(r.log.toasts[0].kind, 'err');
  assert.equal(r.sandbox.view.draft, dr, 'the person\'s words are kept for when they come back');
  assert.deepEqual(r.log.paints, []);
});

test('action: a save refused while the person is still on the page is reported as before (unnamed, with the draft note for a conflict)', async () => {
  const r = actionRig();
  r.sandbox.view.route = r.sandbox.state.route;
  r.sandbox.view.draft = r.draft();
  r.sandbox.serve = async () => {
    throw Object.assign(new Error('Someone saved revision 2 first.'), { status: 409 });
  };
  await r.sandbox.saveRevision();
  assert.deepEqual(r.log.toasts.map((t) => t.text), ['Someone saved revision 2 first.', 'Your draft is still here. Copy it, reload, and re-apply.']);
});
