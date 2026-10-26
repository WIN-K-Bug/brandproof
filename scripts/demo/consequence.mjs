// Builds a SEPARATE fictional scenario in which a source change has real consequences: the fact sheet says battery life is
// "up to 12 hours at medium brightness" and a pending replacement version says "up to 8 hours". Unlike the showcase (whose
// pending version 2 only adds a care note), activating this one makes the governing passage disappear, so the narration
// "the battery claim changes from 12 to 8 hours, an approved campaign goes stale, the manager repairs, a person decides again"
// is literally what happens.
//
// Same rules as the showcase bootstrap: it talks to the server it is given through the supported API, is IDEMPOTENT and
// NEVER deletes or resets anything. It leaves the story at the moment BEFORE the manager looks at the pending version.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { makeStripedPng } from '../../tests/png-helpers.js';

const ENV = 'Indoor use only; not waterproof or water resistant.';
const WARR = 'Every Aurora Lamp carries a 2-year limited warranty.';
export const BAT12 = 'A full charge lasts up to 12 hours at medium brightness.';
export const BAT8 = 'A full charge lasts up to 8 hours at medium brightness.';
// The battery paragraph is last, so changing it leaves the two other cited passages at the same offsets.
const sheet = (battery) => ['Fernlight Aurora Lamp: Product Facts (fictional, 12 to 8 hours scenario)', '', `Environment. ${ENV}`, '', `Warranty. ${WARR}`, '', `Battery. ${battery}`].join('\n');
export const SHEET_V1 = sheet(BAT12);
export const SHEET_V2 = sheet(BAT8);

export const TITLES = { source: 'Fernlight Aurora Lamp fact sheet (fictional, 12 to 8 hours scenario)', campaign: 'Aurora battery launch (12 to 8 hours scenario)' };
export const IMAGE = makeStripedPng({ width: 320, height: 160, colors: [[15, 42, 67], [27, 156, 143], [242, 169, 59]] });

const sha = (b) => createHash('sha256').update(b).digest('hex');
const at = (text, needle) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });

/** Refuses any data file that could be real data or the showcase. Returns a message, or null when the path is acceptable. */
export function protectedReason(file, root) {
  const f = path.resolve(file).toLowerCase();
  const dataDir = path.join(root, 'data').toLowerCase();
  if (f === dataDir || f.startsWith(dataDir + path.sep)) return `${file} is inside data/, which holds real workspace data.`;
  if (f.startsWith(path.join(root, 'demo-data', 'fernlight-showcase.json').toLowerCase())) return `${file} is the showcase data file.`;
  return null;
}

export async function bootstrapConsequence(base, log = () => {}) {
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
    const json = await res.json().catch(() => null);
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

  let src = (await call('GET', '/api/sources')).json.sources.find((s) => s.title === TITLES.source);
  if (!src) {
    src = must(await call('POST', '/api/sources', { title: TITLES.source, text: SHEET_V1, origin: 'paste', note: 'Fictional document for the 12 to 8 hours scenario.' }, 'creator'), 'register source').source;
    step(`registered source ${src.id} (draft)`);
  }
  let detail = (await call('GET', `/api/sources/${src.id}`)).json.source;
  if (detail.versions[0].status === 'pending') {
    must(await call('POST', `/api/sources/${src.id}/versions/1/approve`, { expectedSha256: detail.versions[0].textSha256, note: 'Read in full.' }), 'approve version 1');
    step(`approved ${src.id} version 1 (now in force)`);
  }

  const g = must(await call('GET', '/api/guidelines'), 'read guidelines');
  const wanted = [['FCT-001', BAT12], ['FCT-002', ENV], ['FCT-004', WARR]];
  const edited = structuredClone(g.guidelines);
  let changed = false;
  for (const [id, needle] of wanted) {
    const fact = edited.facts.find((f) => f.id === id);
    if (fact.source?.sourceId === src.id) continue;
    fact.source = { sourceId: src.id, version: 1, ...at(SHEET_V1, needle) };
    changed = true;
  }
  if (changed) {
    must(await call('PUT', '/api/guidelines', { baseVersion: g.version, note: 'Link three facts to the scenario fact sheet', guidelines: edited }), 'link facts');
    step('linked FCT-001, FCT-002, FCT-004 to the fact sheet and published guidelines');
  }

  const subs = (await call('GET', '/api/submissions')).json.submissions;
  if (!subs.some((s) => s.title === TITLES.campaign)) {
    const up = must(await call('POST', '/api/assets', IMAGE, 'creator', true), 'upload image');
    const asset = { name: 'aurora-banner.png', alt: 'Three vertical stripes in navy, teal and amber, the Fernlight colours', retainedSha256: up.asset.sha256 };
    const made = must(await call('POST', '/api/submissions', { title: TITLES.campaign, text: BAT12, asset }, 'creator'), 'create campaign');
    step(`saved campaign ${made.id} with a retained image (${sha(IMAGE).slice(0, 8)}…)`);
    must(await call('POST', `/api/submissions/${made.id}/request-review`, { revision: 1, expected: made.workflow.binding }, 'creator'), 'request review');
    step(`${made.id}: review requested`);
    const seen = must(await call('GET', `/api/submissions/${made.id}`, undefined, 'reviewer'), 'read campaign');
    must(await call('POST', `/api/submissions/${made.id}/approve`, { revision: 1, expected: seen.workflow.binding }, 'reviewer'), 'approve campaign');
    step(`${made.id}: approved by the Reviewer demo role`);
  }

  detail = (await call('GET', `/api/sources/${src.id}`)).json.source;
  if (detail.versions.length === 1) {
    must(await call('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: SHEET_V2, origin: 'paste', note: 'Battery life reduced from 12 to 8 hours.' }, 'creator'), 'register version 2');
    step(`${src.id}: version 2 registered as a PENDING draft (battery 12 to 8 hours); approve it live to show the effect`);
  }
  return { alreadyDone: did.length === 0, did, sourceId: src.id };
}
