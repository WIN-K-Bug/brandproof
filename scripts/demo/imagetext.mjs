// Builds a SEPARATE fictional scenario for reading the text out of a campaign image: a registered fact sheet (battery "up to 12
// hours at medium brightness"), and a campaign whose retained banner says "The battery lasts 30 hours on a single charge" with NO
// transcription yet. A presenter then does: Edit as new revision -> Read text from image -> compare and correct -> confirm ->
// the 30-hour claim is a finding on the image text -> replace the image -> the confirmation does not follow it.
//
// Same rules as the other demo bootstraps: through the supported API of the server it is given, IDEMPOTENT, never deletes or resets.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(path.join(here, '..', '..', 'tests', 'fixtures', 'ocr', `${n}.png`));
const ENV = 'Indoor use only; not waterproof or water resistant.';
export const BAT12 = 'A full charge lasts up to 12 hours at medium brightness.';
export const SHEET = ['Fernlight Aurora Lamp: Product Facts (fictional, image text scenario)', '', `Environment. ${ENV}`, '', `Battery. ${BAT12}`].join('\n');
export const TITLES = { source: 'Fernlight Aurora Lamp fact sheet (fictional, image text scenario)', campaign: 'Banner with text in the image (image text scenario)' };
export const IMAGES = { wrong: fx('clear-30-hours'), right: fx('qualified-banner') };
const at = (needle) => ({ start: SHEET.indexOf(needle), end: SHEET.indexOf(needle) + needle.length });
const sha = (b) => createHash('sha256').update(b).digest('hex');

export async function bootstrapImageText(base, log = () => {}) {
  const call = async (method, p, body, role = 'manager', raw = false) => {
    const h = { 'x-demo-role': role };
    let payload;
    if (raw) {
      h['content-type'] = 'application/octet-stream';
      payload = body;
    } else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + p, { method, headers: h, body: payload });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const must = (r, what) => {
    if (r.status < 200 || r.status >= 300) throw new Error(`${what} failed: HTTP ${r.status} ${JSON.stringify(r.json?.error ?? '')}`);
    return r.json;
  };
  const did = [];
  const step = (m) => {
    did.push(m);
    log(`  + ${m}`);
  };

  let src = (await call('GET', '/api/sources')).json.sources.find((s) => s.title === TITLES.source);
  if (!src) {
    src = must(await call('POST', '/api/sources', { title: TITLES.source, text: SHEET, origin: 'paste', note: 'Fictional document for the image text scenario.' }, 'creator'), 'register source').source;
    step(`registered source ${src.id} (draft)`);
  }
  const detail = (await call('GET', `/api/sources/${src.id}`)).json.source;
  if (detail.versions[0].status === 'pending') {
    must(await call('POST', `/api/sources/${src.id}/versions/1/approve`, { expectedSha256: detail.versions[0].textSha256, note: 'Read in full.' }), 'approve version 1');
    step(`approved ${src.id} version 1 (now in force)`);
  }
  const g = must(await call('GET', '/api/guidelines'), 'read guidelines');
  const edited = structuredClone(g.guidelines);
  let changed = false;
  for (const [id, needle] of [['FCT-001', BAT12], ['FCT-002', ENV]]) {
    const fact = edited.facts.find((f) => f.id === id);
    if (fact.source?.sourceId === src.id) continue;
    fact.source = { sourceId: src.id, version: 1, ...at(needle) };
    changed = true;
  }
  if (changed) {
    must(await call('PUT', '/api/guidelines', { baseVersion: g.version, note: 'Link two facts to the image text scenario fact sheet', guidelines: edited }), 'link facts');
    step('linked FCT-001 and FCT-002 to the fact sheet and published guidelines');
  }
  // Both banners are retained so the presenter can replace one with the other; only the wrong one is attached. The "right" one is the CORRECTED ARTWORK: it really prints every approved qualifier. Fixing a claim means replacing the image, never editing the transcript.
  const up = {};
  for (const [k, bytes] of Object.entries(IMAGES)) up[k] = must(await call('POST', '/api/assets', bytes, 'creator', true), `upload ${k} banner`).asset.sha256;
  if (!(await call('GET', '/api/submissions')).json.submissions.some((s) => s.title === TITLES.campaign)) {
    const asset = { name: 'banner.png', alt: 'A banner with two short lines of text on a plain background', retainedSha256: up.wrong };
    const made = must(await call('POST', '/api/submissions', { title: TITLES.campaign, text: 'A reading lamp for your desk.', asset }, 'creator'), 'create campaign');
    step(`saved campaign ${made.id} with a retained banner (${sha(IMAGES.wrong).slice(0, 8)}…) and NO transcription yet`);
  }
  return { alreadyDone: did.length === 0, did, sourceId: src.id };
}
