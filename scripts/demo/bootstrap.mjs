// Builds the fictional "Fernlight showcase" story through the app's own supported API.
// It is IDEMPOTENT and NON-DESTRUCTIVE: every step first checks whether it is already done, and nothing is ever deleted
// or reset. It only ever talks to the server it is given (the demo server on its own data file).
//
// The story (all fictional): a registered, approved fact sheet; three facts linked to exact passages; an approved
// campaign with a corrected revision and a retained image; an approval that went stale because the image was replaced;
// a problematic draft whose findings cite exact registered passages; and a pending replacement of the source, left
// unapproved so the effect of activating a source can be shown live.
import { createHash } from 'node:crypto';
import { makeStripedPng } from '../../tests/png-helpers.js';

export const FACT_SHEET = [
  'Fernlight Aurora Lamp: Product Facts (fictional showcase document)',
  '',
  'Battery. A full charge lasts up to 12 hours at medium brightness.',
  '',
  'Environment. Rated IP20. Indoor use only; not waterproof or water resistant.',
  '',
  'Warranty. Every Aurora Lamp carries a 2-year limited warranty.',
].join('\n');

/** A replacement version that leaves the cited passages where they are, so relinking is a one-click repair. */
export const FACT_SHEET_V2 = `${FACT_SHEET}\n\nCare. Wipe with a dry cloth. Do not immerse.`;

export const TITLES = {
  source: 'Fernlight Aurora Lamp fact sheet (fictional showcase)',
  banner: 'Aurora launch banner (showcase)',
  winter: 'Winter reading lamp post (showcase)',
  draft: 'Waterproof claim draft (showcase)',
};

const sha = (b) => createHash('sha256').update(b).digest('hex');
const at = (needle) => {
  const start = FACT_SHEET.indexOf(needle);
  if (start < 0) throw new Error(`passage not found: ${needle}`);
  return { start, end: start + needle.length };
};

export const IMAGES = {
  A: makeStripedPng({ width: 320, height: 160, colors: [[15, 42, 67], [27, 156, 143], [242, 169, 59]] }),
  B: makeStripedPng({ width: 320, height: 160, colors: [[27, 156, 143], [247, 243, 236], [15, 42, 67], [242, 169, 59]] }),
};

export async function bootstrapShowcase(base, log = () => {}) {
  const call = async (method, path, body, role = 'manager', headers = {}) => {
    const h = { 'x-demo-role': role, ...headers };
    let payload;
    if (Buffer.isBuffer(body)) payload = body;
    else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers: h, body: payload });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {}
    return { status: res.status, json };
  };
  const must = (r, what) => {
    if (r.status < 200 || r.status >= 300) throw new Error(`${what} failed: HTTP ${r.status} ${JSON.stringify(r.json?.error ?? '')}`);
    return r.json;
  };
  const did = [];
  const step = (msg) => {
    did.push(msg);
    log(`  + ${msg}`);
  };

  // 1. registered source, approved by a manager (a different role from the registrant)
  let src = (await call('GET', '/api/sources')).json.sources.find((s) => s.title === TITLES.source);
  if (!src) {
    src = must(await call('POST', '/api/sources', { title: TITLES.source, text: FACT_SHEET, origin: 'paste', note: 'Fictional document written for the showcase.' }, 'creator'), 'register source').source;
    step(`registered source ${src.id} (draft)`);
  }
  let detail = (await call('GET', `/api/sources/${src.id}`)).json.source;
  if (detail.versions[0].status === 'pending') {
    must(await call('POST', `/api/sources/${src.id}/versions/1/approve`, { expectedSha256: detail.versions[0].textSha256, note: 'Read in full; matches the showcase fact sheet.' }), 'approve source');
    step(`approved ${src.id} version 1 (now in force)`);
  }

  // 2. link three facts to exact passages of that version, then publish once
  const wanted = {
    'FCT-001': at('A full charge lasts up to 12 hours at medium brightness.'),
    'FCT-002': at('Indoor use only; not waterproof or water resistant.'),
    'FCT-004': at('Every Aurora Lamp carries a 2-year limited warranty.'),
  };
  const g = (await call('GET', '/api/guidelines')).json;
  const needsLink = Object.entries(wanted).filter(([id, sp]) => {
    const s = g.guidelines.facts.find((f) => f.id === id)?.source;
    return !(s?.sourceId === src.id && s.version === 1 && s.start === sp.start && s.end === sp.end);
  });
  if (needsLink.length) {
    const edited = structuredClone(g.guidelines);
    for (const [id, sp] of needsLink) edited.facts.find((f) => f.id === id).source = { sourceId: src.id, version: 1, ...sp };
    must(await call('PUT', '/api/guidelines', { baseVersion: g.version, note: 'Link battery, indoor-use and warranty facts to the registered fact sheet.', guidelines: edited }), 'publish links');
    step(`linked ${needsLink.map(([id]) => id).join(', ')} to ${src.id} v1 and published guidelines`);
  }

  // 3. retained images (idempotent: identical bytes are stored once)
  const up = {};
  for (const [k, bytes] of Object.entries(IMAGES)) {
    const r = await call('POST', '/api/assets', bytes, 'creator', { 'content-type': 'application/octet-stream' });
    if (r.status !== 200 && r.status !== 201) throw new Error(`upload ${k} failed: ${r.status}`);
    if (r.status === 201) step(`retained showcase image ${k} (${sha(bytes).slice(0, 8)}…)`);
    up[k] = r.json.asset.sha256;
  }

  const list = async () => (await call('GET', '/api/submissions')).json.submissions;
  const find = async (title) => (await list()).find((s) => s.title === title);
  const view = async (id, role = 'reviewer') => (await call('GET', `/api/submissions/${id}`, undefined, role)).json;
  const sendForReview = async (id) => {
    const d = await view(id, 'creator');
    must(await call('POST', `/api/submissions/${id}/request-review`, { revision: d.headRevision, expected: d.workflow.binding }, 'creator'), 'request review');
  };
  const approve = async (id, note) => {
    const d = await view(id);
    must(await call('POST', `/api/submissions/${id}/approve`, { revision: d.headRevision, expected: d.workflow.binding, note, acknowledgeWarnings: true }, 'reviewer'), 'approve');
  };
  const newRevision = async (id, text, asset) => {
    const d = await view(id, 'creator');
    must(await call('POST', `/api/submissions/${id}/revisions`, { baseRevision: d.headRevision, text, asset }, 'creator'), 'revision');
  };
  const palette = { fg: '#0F2A43', bg: '#FFFFFF', textSize: 'normal', colors: ['#0F2A43', '#1B9C8F', '#F2A93B'] };

  // 4. banner: problematic first draft -> corrected revision with a retained image -> approved
  let banner = await find(TITLES.banner);
  if (!banner) {
    const first = must(
      await call('POST', '/api/submissions', {
        title: TITLES.banner,
        text: "Meet the aurora lamp!!! A full charge lasts 30 hours and it's totally waterproof. The cheapest, best reading light ever.",
        asset: { name: 'aurora-banner-draft.png', alt: 'image', fg: '#9BB7B5', bg: '#FFFFFF', colors: ['#FF00AA'] },
      }, 'creator'),
      'create banner',
    );
    banner = { id: first.id };
    step(`${banner.id}: first draft with real problems saved (name-only image details)`);
  }
  let bd = await view(banner.id);
  if (bd.revisions.length === 1) {
    await newRevision(banner.id, 'Meet the Aurora Lamp. A full charge lasts up to 12 hours at medium brightness. Designed for indoor use.', {
      name: 'aurora-banner.png',
      alt: 'Three vertical stripes in navy, teal and amber, the Fernlight colours',
      retainedSha256: up.A,
      ...palette,
    });
    step(`${banner.id}: corrected revision 2 saved with retained image A`);
    bd = await view(banner.id);
  }
  if (!bd.events.length) {
    await sendForReview(banner.id);
    step(`${banner.id}: review requested`);
  }
  bd = await view(banner.id);
  if (!bd.events.some((e) => e.type === 'approved')) {
    await approve(banner.id, 'Facts match the registered fact sheet; image and alt text checked.');
    must(await call('POST', `/api/submissions/${banner.id}/comments`, { revision: 2, text: 'Approved against the registered fact sheet. Please keep the 12 hour wording.' }, 'reviewer'), 'comment');
    step(`${banner.id}: approved by the Reviewer demo role`);
  }

  // 5. winter post: approved with image A, then the image is replaced -> approval is stale
  let winter = await find(TITLES.winter);
  if (!winter) {
    const w = must(
      await call('POST', '/api/submissions', {
        title: TITLES.winter,
        text: 'Our reading lamp runs up to 12 hours on a full charge.',
        asset: { name: 'winter-post.png', alt: 'Navy, teal and amber stripes for the winter reading lamp post', retainedSha256: up.A, ...palette },
      }, 'creator'),
      'create winter post',
    );
    winter = { id: w.id };
    step(`${winter.id}: winter post saved with retained image A`);
  }
  let wd = await view(winter.id);
  if (!wd.events.length) {
    await sendForReview(winter.id);
    wd = await view(winter.id);
  }
  if (!wd.events.some((e) => e.type === 'approved')) {
    await approve(winter.id, 'Copy and image reviewed.');
    step(`${winter.id}: approved with image A`);
  }
  wd = await view(winter.id);
  if (wd.revisions.length === 1) {
    await newRevision(winter.id, 'Our reading lamp runs up to 12 hours on a full charge.', { name: 'winter-post-v2.png', alt: 'Teal, paper white, navy and amber stripes for the winter reading lamp post', retainedSha256: up.B, ...palette });
    step(`${winter.id}: image replaced in revision 2: the approval now shows Re-review required`);
  }

  // 6. a problematic draft whose findings cite exact registered passages
  if (!(await find(TITLES.draft))) {
    const d = must(await call('POST', '/api/submissions', { title: TITLES.draft, text: 'A full charge lasts 30 hours, and the lamp is waterproof. It is the best reading light there is.', asset: {} }, 'creator'), 'create draft');
    step(`${d.id}: problematic draft saved (findings cite registered passages)`);
  }

  // 7. a pending replacement of the source, deliberately NOT approved
  detail = (await call('GET', `/api/sources/${src.id}`)).json.source;
  if (detail.versions.length === 1) {
    must(await call('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2, origin: 'paste', note: 'Adds care advice. Left pending on purpose: approving it replaces version 1.' }, 'creator'), 'add version');
    step(`${src.id}: version 2 registered as a PENDING draft (approve it live to show the effect)`);
  }

  return { did, source: src.id, alreadyDone: did.length === 0 };
}
