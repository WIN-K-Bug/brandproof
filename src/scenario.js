/**
 * The fictional "evidence change" scenario: a registered source says a full charge lasts up to 12 hours; a campaign is approved against that
 * exact evidence; version 2 of the source (up to 8 hours) is registered and left PENDING. Everything after that (previewing the change,
 * activating it, the approval going stale, the repair, the new review and the new decision) is done by the visitor with the real features.
 *
 * Nothing here decides anything. Every step goes through a `call` function that sends a request to the visitor's OWN app (the real routes, role
 * checks, validation and approval gates), so the stored state is exactly what the same clicks would have produced. Status is derived from the
 * stored state on every read; no stage, badge or sentence is stored or hard-coded.
 *
 * Used by the isolated judge demo (in-process, one session at a time) and by scripts/demo/consequence.mjs (over HTTP, on its own data file).
 *
 * Safe to run again: every step first checks whether it is already done, nothing is deleted or reset, and anything in the visitor's workspace
 * that is not this scenario's own is left alone. If the workspace already holds something that conflicts (a different source with the scenario's
 * title, a fact the visitor linked elsewhere) it stops BEFORE changing anything and says so.
 */
import zlib from 'node:zlib';
import { HttpError } from './util.js';
import { normalizeSourceText, textDigest } from './sources.js';
import { seedGuidelines } from './seed.js';
import { assignIds, validateGuidelines } from './validate.js';

const ENV = 'Indoor use only; not waterproof or water resistant.';
const WARR = 'Every Aurora Lamp carries a 2-year limited warranty.';
export const BAT12 = 'A full charge lasts up to 12 hours at medium brightness.';
export const BAT8 = 'A full charge lasts up to 8 hours at medium brightness.';
// The battery paragraph is last, so changing it leaves the two other cited passages at the same offsets.
const sheet = (battery) => ['Fernlight Aurora Lamp: Product Facts (fictional, 12 to 8 hours scenario)', '', `Environment. ${ENV}`, '', `Warranty. ${WARR}`, '', `Battery. ${battery}`].join('\n');
export const SHEET_V1 = sheet(BAT12);
export const SHEET_V2 = sheet(BAT8);
export const TITLES = { source: 'Fernlight Aurora Lamp fact sheet (fictional, 12 to 8 hours scenario)', campaign: 'Aurora battery launch (12 to 8 hours scenario)' };
export const ALT = 'Three vertical stripes in navy, teal and amber, the Fernlight colours';

/** The facts the scenario links (the demo brand's battery, indoor-use and warranty facts) and the passage each one cites. */
const LINKS = [
  ['FCT-001', BAT12],
  ['FCT-002', ENV],
  ['FCT-004', WARR],
];

// Wording that keeps the preloaded history honest: it is part of the fictional sample, not something the visitor did.
const SAMPLE = 'Sample history in the fictional scenario, not a decision you made.';

/** A small synthetic PNG (three vertical stripes). Built here so the product does not depend on the test helpers. */
function stripedPng(width, height, colors) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    const c = colors[Math.min(colors.length - 1, Math.floor((x * colors.length) / width))];
    row[1 + x * 3] = c[0];
    row[2 + x * 3] = c[1];
    row[3 + x * 3] = c[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export const IMAGE = stripedPng(320, 160, [[15, 42, 67], [27, 156, 143], [242, 169, 59]]);

/** An upper bound on what starting the scenario adds to one session (workspace file and the image), used for the storage check before anything is written. */
export const SCENARIO_FOOTPRINT_BYTES = 96 * 1024;

const sourceDigest = textDigest(normalizeSourceText(SHEET_V1));
const seedFacts = new Map(assignIds(validateGuidelines(seedGuidelines()).value).facts.map((f) => [f.id, f]));
const at = (text, needle) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });
const conflict = (message) => new HttpError(409, 'scenario_conflict', message);

/** The scenario's own objects in this workspace, found by what they ARE (title and the digest or text of version 1), never by an id number alone. */
async function locate(call) {
  const listed = (await call('GET', '/api/sources')).json?.sources ?? [];
  const sameTitle = listed.filter((s) => s.title === TITLES.source);
  let source = null;
  for (const s of sameTitle) {
    const d = (await call('GET', `/api/sources/${s.id}`)).json?.source;
    if (d?.versions?.[0]?.textSha256 === sourceDigest) {
      source = d;
      break;
    }
  }
  if (sameTitle.length && !source) throw conflict(`This session already has a source called “${TITLES.source}” that is not the scenario’s. Use “Reset my demo” to start from the original fictional data, or rename it first.`);
  const subs = ((await call('GET', '/api/submissions')).json?.submissions ?? []).filter((s) => s.title === TITLES.campaign);
  let campaign = null;
  for (const s of subs) {
    const d = (await call('GET', `/api/submissions/${s.id}`, undefined, 'reviewer')).json;
    if (d?.revisions?.[0]?.text === BAT12) {
      campaign = d;
      break;
    }
  }
  if (subs.length && !campaign) throw conflict(`This session already has a campaign called “${TITLES.campaign}” that is not the scenario’s. Use “Reset my demo” to start from the original fictional data, or rename it first.`);
  return { source, campaign };
}

/**
 * Make sure the scenario exists, step by step. `call(method, path, body, role, raw)` returns { status, json }.
 * Returns { created, did, sourceId, campaignId }. Idempotent: a second run changes nothing.
 */
export async function runScenario(call, { log = () => {} } = {}) {
  const did = [];
  const step = (msg) => {
    did.push(msg);
    log(`  + ${msg}`);
  };
  const must = (r, what) => {
    if (r.status < 200 || r.status >= 300) {
      const e = new HttpError(r.status === 413 || r.status === 429 || r.status === 503 ? r.status : 500, r.json?.error?.code ?? 'scenario_failed', `${what} failed${r.json?.error?.message ? `: ${r.json.error.message}` : ''}. Whatever was already added is kept; run the scenario again to continue.`);
      throw e;
    }
    return r.json;
  };

  let { source, campaign } = await locate(call);

  // Before changing anything: the facts the scenario links must be the untouched demo facts, and unlinked or already linked to THIS source.
  const guidelines = must(await call('GET', '/api/guidelines'), 'read the guidelines');
  const setupOpen = !source || source.versions.length === 1;
  if (setupOpen) {
    for (const [id] of LINKS) {
      const fact = guidelines.guidelines.facts.find((f) => f.id === id);
      const seed = seedFacts.get(id);
      if (!fact || fact.statement !== seed?.statement || fact.value !== seed?.value) throw conflict(`The demo fact ${id} was changed in this session, so the scenario cannot link it safely. Use “Reset my demo” to start from the original fictional data.`);
      if (fact.source?.sourceId && (!source || fact.source.sourceId !== source.id)) throw conflict(`The demo fact ${id} is already linked to a different source in this session, and the scenario will not overwrite that. Use “Reset my demo” to start again.`);
    }
  }
  if (!campaign && !source) {
    // The image is the one thing with its own quota: refuse BEFORE the first write if there is no room for it.
    const u = must(await call('GET', '/api/assets/usage'), 'check image room');
    if (u.count + 1 > u.limits.count || u.bytes + IMAGE.length > u.limits.totalBytes) {
      throw new HttpError(409, 'scenario_no_room', 'This session already holds as many images as it may keep, so there is no room for the scenario’s one small image. Use “Reset my demo” to start again. Nothing was changed.');
    }
  }

  if (!source) {
    const made = must(await call('POST', '/api/sources', { title: TITLES.source, text: SHEET_V1, origin: 'paste', note: 'Fictional document for the 12 to 8 hours scenario.' }, 'creator'), 'register the source').source;
    step(`registered source ${made.id} (draft)`);
    source = (await call('GET', `/api/sources/${made.id}`)).json.source;
  }
  if (source.versions[0].state === 'rejected' || (source.versions[0].state === 'withdrawn')) throw conflict('The scenario’s fact sheet was rejected or withdrawn in this session. Use “Reset my demo” to start it again.');
  if (source.versions[0].status === 'pending') {
    must(await call('POST', `/api/sources/${source.id}/versions/1/approve`, { expectedSha256: source.versions[0].textSha256, note: `Read in full. ${SAMPLE}` }), 'approve version 1');
    step(`approved ${source.id} version 1 (now in force)`);
  }

  if (setupOpen) {
    const edited = structuredClone(guidelines.guidelines);
    let changed = false;
    for (const [id, needle] of LINKS) {
      const fact = edited.facts.find((f) => f.id === id);
      if (fact.source?.sourceId === source.id) continue;
      fact.source = { sourceId: source.id, version: 1, ...at(SHEET_V1, needle) };
      changed = true;
    }
    if (changed) {
      must(await call('PUT', '/api/guidelines', { baseVersion: guidelines.version, note: 'Link three facts to the scenario fact sheet', guidelines: edited }), 'link the facts');
      step('linked FCT-001, FCT-002, FCT-004 to the fact sheet and published the guidelines');
    }
  }

  if (!campaign) {
    const up = must(await call('POST', '/api/assets', IMAGE, 'creator', true), 'retain the image');
    const asset = { name: 'aurora-banner.png', alt: ALT, retainedSha256: up.asset.sha256 };
    const made = must(await call('POST', '/api/submissions', { title: TITLES.campaign, text: BAT12, asset }, 'creator'), 'save the campaign');
    step(`saved campaign ${made.id} with a retained image`);
    campaign = made;
  }
  if (setupOpen) {
    campaign = (await call('GET', `/api/submissions/${campaign.id}`, undefined, 'reviewer')).json;
    if (!campaign.events.some((e) => e.type === 'review_requested') && campaign.workflow.status === 'draft') {
      must(await call('POST', `/api/submissions/${campaign.id}/request-review`, { revision: campaign.headRevision, expected: campaign.workflow.binding }, 'creator'), 'request review');
      step(`${campaign.id}: review requested (sample history)`);
      campaign = (await call('GET', `/api/submissions/${campaign.id}`, undefined, 'reviewer')).json;
    }
    if (!campaign.events.some((e) => e.type === 'approved') && campaign.workflow.status === 'in_review') {
      must(await call('POST', `/api/submissions/${campaign.id}/approve`, { revision: campaign.headRevision, expected: campaign.workflow.binding, note: `Approved against version 1 of the fact sheet. ${SAMPLE}` }, 'reviewer'), 'record the sample approval');
      step(`${campaign.id}: approved on version 1 (sample history)`);
    }
  }

  source = (await call('GET', `/api/sources/${source.id}`)).json.source;
  if (source.versions.length === 1) {
    must(await call('POST', `/api/sources/${source.id}/versions`, { baseVersion: 1, text: SHEET_V2, origin: 'paste', note: 'Battery life reduced from 12 to 8 hours. Left pending on purpose: a Manager decides.' }, 'creator'), 'register version 2');
    step(`${source.id}: version 2 registered as a PENDING draft (battery 12 to 8 hours)`);
  }
  return { created: did.length > 0, did, sourceId: source.id, campaignId: campaign.id };
}

/**
 * Where the visitor is in the journey, derived from the stored state alone (the real source versions, the real approval status and bindings,
 * the real findings and evidence checks). Returns { started: false } when the scenario has not been started.
 * `next` is a suggestion with a link; it never does anything by itself.
 */
export async function scenarioStatus(call) {
  const { source, campaign } = await locate(call);
  if (!source && !campaign) return { started: false };
  const base = { started: true, sourceId: source?.id ?? null, campaignId: campaign?.id ?? null };
  const v2 = source?.versions.find((v) => v.n === 2);
  if (!source || !campaign || !v2 || !campaign.events.some((e) => e.type === 'approved')) {
    return { ...base, ready: false, stage: 'incomplete', headline: 'The scenario was only partly set up.', next: { label: 'Finish setting it up', action: 'start' } };
  }
  const w = campaign.workflow;
  const approvals = campaign.events.filter((e) => e.type === 'approved').length;
  const broken = campaign.current.evidence.broken.length;
  const out = (stage, headline, next) => ({ ...base, ready: true, stage, headline, next, approvals, status: w.status });
  if (v2.state === 'pending') {
    return out('pending_change', `“${campaign.title}” is approved against version ${source.activeVersion} of its fact sheet. Version 2 is waiting for a Manager’s decision.`, {
      label: 'Preview what version 2 would change',
      hash: `#/sources/${source.id}/2`,
      role: 'manager',
    });
  }
  if (v2.state === 'rejected') return out('change_rejected', 'Version 2 was rejected, so the fact sheet and the approval are unchanged.', { label: 'Open the campaign', hash: `#/workspace/${campaign.id}`, role: null });
  if (broken > 0) {
    return out('repair_evidence', `Version ${source.activeVersion} is now in force. The approval was given on the earlier version and no longer applies; ${broken} fact${broken === 1 ? '' : 's'} still cite${broken === 1 ? 's' : ''} the replaced text, so a new approval is blocked.`, {
      label: 'Relink the facts to the new version',
      hash: '#/library',
      role: 'manager',
    });
  }
  if (w.status === 'approved' && approvals >= 2) {
    return out('done', `Approved again on version ${source.activeVersion}. The dossier keeps both approvals and what each one covered.`, { label: 'Open the review dossier', hash: `#/dossier/${campaign.id}`, role: null });
  }
  if (w.blockingCount > 0) {
    return out('repair_copy', `The facts are repaired, but the campaign copy now has ${w.blockingCount} blocking finding${w.blockingCount === 1 ? '' : 's'} against them.`, { label: 'Open the campaign to correct its copy', hash: `#/workspace/${campaign.id}`, role: 'creator' });
  }
  if (['draft', 'approval_stale', 'rejected'].includes(w.status)) {
    return out('request_review', 'The copy matches the repaired facts. It needs a new review request.', { label: 'Open the campaign to request review', hash: `#/workspace/${campaign.id}`, role: 'creator' });
  }
  if (w.status === 'in_review') {
    return out('decide', 'Review is requested on the repaired evidence. A person decides.', { label: 'Open the campaign to record the decision', hash: `#/workspace/${campaign.id}`, role: 'reviewer' });
  }
  return out('done', 'The campaign is approved on the current evidence.', { label: 'Open the review dossier', hash: `#/dossier/${campaign.id}`, role: null });
}
