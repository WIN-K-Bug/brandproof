// Builds a SEPARATE fictional scenario in which a source change has real consequences: the fact sheet says battery life is
// "up to 12 hours at medium brightness" and a pending replacement version says "up to 8 hours". Unlike the showcase (whose
// pending version 2 only adds a care note), activating this one makes the governing passage disappear, so the narration
// "the battery claim changes from 12 to 8 hours, an approved campaign goes stale, the manager repairs, a person decides again"
// is literally what happens.
//
// Same rules as the showcase bootstrap: it talks to the server it is given through the supported API, is IDEMPOTENT and
// NEVER deletes or resets anything. It leaves the story at the moment BEFORE the manager looks at the pending version.
//
// The steps themselves live in src/scenario.js, shared with the judge demo's optional "Try an evidence change" action (which sends the same
// requests to a visitor's own app without a network socket); this file only supplies the HTTP transport and the launcher's data-file guard.
import path from 'node:path';
import { runScenario, BAT12, BAT8, SHEET_V1, SHEET_V2, TITLES, IMAGE } from '../../src/scenario.js';

export { BAT12, BAT8, SHEET_V1, SHEET_V2, TITLES, IMAGE };

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
  const r = await runScenario(call, { log });
  return { alreadyDone: !r.created, did: r.did, sourceId: r.sourceId };
}
