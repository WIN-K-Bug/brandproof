import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { startApp, tempDir, cleanContent } from './helpers.js';

const body = (extra = {}) => ({ title: 'API test', ...cleanContent(), ...extra });
const expectedOf = (wf) => wf.binding;

async function create(t, extra) {
  const r = await t.call('POST', '/api/submissions', { role: 'creator', body: body(extra) });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

test('server binds to 127.0.0.1 only, and serves the page with strict security headers', async () => {
  const t = await startApp();
  try {
    assert.equal(t.app.server.address().address, '127.0.0.1');
    assert.match(t.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await t.call('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.doesNotMatch(r.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  } finally {
    await t.close();
  }
});

test('static serving cannot escape the public directory; unknown paths and methods are refused', async () => {
  const t = await startApp();
  try {
    for (const p of ['/%2e%2e/package.json', '/..%2fpackage.json', '/server.js', '/src/app.js', '/data/brandproof.json']) {
      assert.equal((await t.call('GET', p)).status, 404, p);
    }
    assert.equal((await t.call('POST', '/', { raw: '' })).status, 405);
    assert.equal((await t.call('GET', '/api/nope')).status, 404);
    assert.equal((await t.call('DELETE', '/api/submissions')).status, 405);
  } finally {
    await t.close();
  }
});

test('requests with a foreign Host header or foreign Origin are rejected (DNS-rebinding / CSRF guard)', async () => {
  const t = await startApp();
  try {
    const port = new URL(t.url).port;
    const status = await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/meta', headers: { host: 'evil.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on('error', reject);
    });
    assert.equal(status, 403);
    const r = await t.call('POST', '/api/submissions', { role: 'creator', body: body(), headers: { origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    const ok = await t.call('POST', '/api/submissions', { role: 'creator', body: body(), headers: { origin: t.url } });
    assert.equal(ok.status, 201);
  } finally {
    await t.close();
  }
});

test('input hygiene: role header, content type, JSON, size limit and field validation', async () => {
  const t = await startApp();
  try {
    assert.equal((await t.call('POST', '/api/submissions', { body: body() })).status, 400); // no role
    assert.equal((await t.call('POST', '/api/submissions', { role: 'admin', body: body() })).status, 400);
    assert.equal((await t.call('POST', '/api/submissions', { role: 'creator', raw: 'x', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await t.call('POST', '/api/submissions', { role: 'creator', raw: '{oops', headers: { 'content-type': 'application/json' } })).status, 400);
    const big = await t.call('POST', '/api/submissions', { role: 'creator', raw: JSON.stringify({ title: 'x', text: 'y'.repeat(600 * 1024) }), headers: { 'content-type': 'application/json' } });
    assert.equal(big.status, 413);
    const bad = await t.call('POST', '/api/submissions', { role: 'creator', body: { title: '', text: '', asset: { fg: 'nope' } } });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.error.code, 'validation_failed');
    assert.deepEqual(bad.json.error.details.fields.map((f) => f.path).sort(), ['asset.fg', 'text', 'title']);
    assert.equal((await t.call('GET', '/api/submissions')).json.submissions.length, 3); // nothing was created
    // the server survived all of the above
    assert.equal((await t.call('GET', '/api/meta')).status, 200);
  } finally {
    await t.close();
  }
});

test('meta: team id, demo roles and rules-mode statement; AI adapter is unconfigured', async () => {
  const t = await startApp();
  try {
    const m = (await t.call('GET', '/api/meta')).json;
    assert.equal(m.team, 'bhangaledhruv7');
    assert.equal(m.demo, true);
    assert.deepEqual(m.roles.map((r) => r.id), ['creator', 'manager', 'reviewer']);
    assert.equal(m.engine.mode, 'rules');
    assert.equal(m.engine.contextualAi.available, false);
    assert.match(m.engine.contextualAi.message, /unavailable/i);
    assert.ok(m.aiContract.version);
  } finally {
    await t.close();
  }
});

test('live check returns findings without saving anything', async () => {
  const t = await startApp();
  try {
    const r = await t.call('POST', '/api/check', { body: { text: 'A full charge lasts 30 hours.', asset: {} } });
    assert.equal(r.status, 200);
    assert.equal(r.json.summary.contradicted, 1);
    assert.equal(r.json.engine.contextualAi.available, false);
    assert.equal((await t.call('GET', '/api/submissions')).json.submissions.length, 3);
    assert.equal((await t.call('POST', '/api/check', { body: { text: '' } })).status, 422);
  } finally {
    await t.close();
  }
});

test('end-to-end: create, revise, comment, request review, approve, edit -> re-review required', async () => {
  const t = await startApp();
  try {
    const sub = await create(t);
    const id = sub.id;
    assert.equal(sub.workflow.status, 'draft');
    assert.equal(sub.current.summary.error, 0);

    // approve before review is requested -> refused by server-derived eligibility
    let r = await t.call('POST', `/api/submissions/${id}/approve`, { role: 'reviewer', body: { revision: 1, expected: expectedOf(sub.workflow) } });
    assert.equal(r.status, 403);

    r = await t.call('POST', `/api/submissions/${id}/comments`, { role: 'manager', body: { revision: 1, text: 'Please double-check the alt text.' } });
    assert.equal(r.status, 201);
    assert.equal(r.json.author.name, 'Demo Manager');

    r = await t.call('POST', `/api/submissions/${id}/request-review`, { role: 'creator', body: { revision: 1, expected: expectedOf(sub.workflow) } });
    assert.equal(r.status, 201);
    assert.equal(r.json.workflow.status, 'in_review');

    r = await t.call('POST', `/api/submissions/${id}/reject`, { role: 'reviewer', body: { revision: 1, expected: expectedOf(r.json.workflow) } });
    assert.equal(r.status, 422); // rejection needs a note
    const inReview = (await t.call('GET', `/api/submissions/${id}`, { role: 'reviewer' })).json;
    r = await t.call('POST', `/api/submissions/${id}/approve`, { role: 'reviewer', body: { revision: 1, expected: expectedOf(inReview.workflow), note: 'Good to go' } });
    assert.equal(r.status, 201);
    assert.equal(r.json.workflow.status, 'approved');
    assert.equal(r.json.events.at(-1).actor.name, 'Demo Reviewer');

    // edit -> new revision, approval no longer valid, shown consistently in detail and list
    r = await t.call('POST', `/api/submissions/${id}/revisions`, { role: 'creator', body: { baseRevision: 1, text: cleanContent().text + ' Quiet by design.', asset: cleanContent().asset } });
    assert.equal(r.status, 201);
    assert.equal(r.json.workflow.status, 'approval_stale');
    assert.deepEqual(r.json.workflow.staleApproval.reasons, ['content']);
    assert.equal(r.json.revisions.length, 2);
    const listed = (await t.call('GET', '/api/submissions')).json.submissions.find((s) => s.id === id);
    assert.equal(listed.status, 'approval_stale');

    const cmp = await t.call('GET', `/api/submissions/${id}/compare?from=1&to=2`);
    assert.equal(cmp.status, 200);
    assert.ok(cmp.json.text.some((o) => o.type === 'add'));
    assert.equal((await t.call('GET', `/api/submissions/${id}/compare?from=1&to=x`)).status, 422);
  } finally {
    await t.close();
  }
});

test('decision payload must carry what the reviewer saw; a guideline publish in between gives 409', async () => {
  const t = await startApp();
  try {
    const sub = await create(t);
    const id = sub.id;
    const rv = await t.call('POST', `/api/submissions/${id}/request-review`, { role: 'creator', body: { revision: 1, expected: expectedOf(sub.workflow) } });
    const seen = expectedOf(rv.json.workflow);

    let r = await t.call('POST', `/api/submissions/${id}/approve`, { role: 'reviewer', body: { revision: 1 } });
    assert.equal(r.status, 422);
    assert.ok(r.json.error.details.fields.some((f) => f.path === 'expected'));

    const g = (await t.call('GET', '/api/guidelines')).json;
    const edited = structuredClone(g.guidelines);
    edited.claims.signals.push('unbeatable');
    r = await t.call('PUT', '/api/guidelines', { role: 'manager', body: { baseVersion: g.version, note: 'new signal', guidelines: edited } });
    assert.equal(r.status, 201);
    assert.equal(r.json.version, 2);

    r = await t.call('POST', `/api/submissions/${id}/approve`, { role: 'reviewer', body: { revision: 1, expected: seen } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'stale_view');
    assert.deepEqual(r.json.error.details.changed, ['guideline']);
    const after = (await t.call('GET', `/api/submissions/${id}`, { role: 'reviewer' })).json;
    assert.equal(after.workflow.status, 'in_review');
    assert.equal(after.events.filter((e) => e.type === 'approved').length, 0);

    r = await t.call('POST', `/api/submissions/${id}/approve`, { role: 'reviewer', body: { revision: 1, expected: expectedOf(after.workflow) } });
    assert.equal(r.status, 201);
    assert.equal(r.json.events.at(-1).binding.guidelineVersion, 2);
  } finally {
    await t.close();
  }
});

test('guideline API: manager-only, versioned, validated, conflict-checked, history and diff summary', async () => {
  const t = await startApp();
  try {
    const g = (await t.call('GET', '/api/guidelines')).json;
    assert.equal(g.version, 1);
    assert.equal(g.guidelines.brand.fictional, true);
    const edit = structuredClone(g.guidelines);
    edit.terms.push({ kind: 'banned', avoid: [{ text: 'bargain', replacement: 'good value' }], reason: 'Say good value.', severity: 'warning', source: { doc: 'Voice (fictional)', section: '3.9', quote: 'We say good value, never bargain.' } });

    assert.equal((await t.call('PUT', '/api/guidelines', { role: 'creator', body: { baseVersion: 1, guidelines: edit } })).status, 403);
    assert.equal((await t.call('PUT', '/api/guidelines', { role: 'manager', body: { baseVersion: 1, guidelines: { ...edit, palette: { colors: [{ name: 'x', hex: 'nope' }], source: edit.palette.source } } } })).status, 422);
    assert.equal((await t.call('PUT', '/api/guidelines', { role: 'manager', body: { guidelines: edit } })).status, 422); // no baseVersion
    const ok = await t.call('PUT', '/api/guidelines', { role: 'manager', body: { baseVersion: 1, note: 'Add bargain', guidelines: edit } });
    assert.equal(ok.status, 201);
    assert.equal((await t.call('PUT', '/api/guidelines', { role: 'manager', body: { baseVersion: 1, guidelines: edit } })).status, 409);

    const versions = (await t.call('GET', '/api/guidelines/versions')).json.versions;
    assert.deepEqual(versions.map((v) => v.version), [2, 1]);
    assert.deepEqual(versions[0].changes.terms.added, ['TRM-005']);
    assert.equal(versions[0].note, 'Add bargain');
    assert.equal(versions[0].createdBy, 'Demo Manager (demo role)');
    assert.equal((await t.call('GET', '/api/guidelines/versions/1')).json.version, 1);
    assert.equal((await t.call('GET', '/api/guidelines/versions/9')).status, 404);

    const chk = await t.call('POST', '/api/check', { body: { text: 'A bargain lamp.' } });
    assert.equal(chk.json.findings[0].ruleId, 'TRM-005');
    assert.equal(chk.json.guidelineVersion, 2);
  } finally {
    await t.close();
  }
});

test('concurrency: parallel comments are all kept', async () => {
  const t = await startApp();
  try {
    const rs = await Promise.all(
      Array.from({ length: 30 }, (_, i) => t.call('POST', '/api/submissions/SUB-1/comments', { role: i % 2 ? 'manager' : 'reviewer', body: { revision: 1, text: `comment ${i}` } })),
    );
    assert.ok(rs.every((r) => r.status === 201));
    const sub = (await t.call('GET', '/api/submissions/SUB-1', { role: 'creator' })).json;
    const mine = sub.comments.filter((c) => /^comment \d+$/.test(c.text));
    assert.equal(mine.length, 30);
    assert.equal(new Set(sub.comments.map((c) => c.id)).size, sub.comments.length); // unique ids
  } finally {
    await t.close();
  }
});

test('concurrency: parallel revisions from the same base -> exactly one wins, the rest get 409, nothing is lost', async () => {
  const t = await startApp();
  try {
    const rs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        t.call('POST', '/api/submissions/SUB-1/revisions', { role: 'creator', body: { baseRevision: 1, text: `Competing edit number ${i}.`, asset: cleanContent().asset } }),
      ),
    );
    const statuses = rs.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1);
    assert.equal(statuses.filter((s) => s === 409).length, 11);
    const sub = (await t.call('GET', '/api/submissions/SUB-1', { role: 'creator' })).json;
    assert.deepEqual(sub.revisions.map((r) => r.n), [1, 2]);
  } finally {
    await t.close();
  }
});

test('concurrency: parallel creations get unique ids and all persist across a restart', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'data.json');
  let app = await createApp({ dataFile: file, semantic: null });
  let url = await app.listen(0);
  try {
    const post = (b) => fetch(url + '/api/submissions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'creator' }, body: JSON.stringify(b) });
    const rs = await Promise.all(Array.from({ length: 15 }, (_, i) => post(body({ title: `Parallel ${i}` }))));
    assert.ok(rs.every((r) => r.status === 201));
    const ids = (await Promise.all(rs.map((r) => r.json()))).map((j) => j.id);
    assert.equal(new Set(ids).size, 15);

    await app.close();
    app = await createApp({ dataFile: file, semantic: null });
    url = await app.listen(0);
    const list = (await (await fetch(url + '/api/submissions')).json()).submissions;
    assert.equal(list.length, 18);
    assert.equal(list.filter((s) => s.title.startsWith('Parallel')).length, 15);
  } finally {
    await app.close();
    await tmp.cleanup();
  }
});

test('hostile text is stored and returned as inert JSON data (the UI renders it with textContent)', async () => {
  const t = await startApp();
  try {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const sub = await create(t, { title: evil, text: evil + ' best', asset: { ...cleanContent().asset, alt: evil } });
    assert.equal(sub.title, evil);
    const r = await t.call('GET', `/api/submissions/${sub.id}`, { role: 'creator' });
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.json.revisions[0].text, evil + ' best');
  } finally {
    await t.close();
  }
});

test('insights endpoint reports recurring issues and statuses', async () => {
  const t = await startApp();
  try {
    const i = (await t.call('GET', '/api/insights')).json;
    assert.equal(i.submissions, 3);
    assert.ok(i.recurring.length > 3);
    assert.equal(i.statuses.in_review, 1);
  } finally {
    await t.close();
  }
});
