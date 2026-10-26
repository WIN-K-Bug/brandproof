import { createHash } from 'node:crypto';

/** FICTIONAL source text used only by tests and the browser walkthrough. */
export const FACT_SHEET = [
  'Fernlight Aurora Lamp: Product Facts (fictional)',
  '',
  'Battery. A full charge lasts up to 12 hours at medium brightness.',
  '',
  'Environment. Rated IP20. Indoor use only; not waterproof or water resistant.',
  '',
  'Warranty. Every Aurora Lamp carries a 2-year limited warranty.',
].join('\n');

/** A new version that leaves the governing battery passage untouched (same offsets), so relinking is straightforward. */
export const FACT_SHEET_V2 = `${FACT_SHEET}\n\nCare. Wipe with a dry cloth.`;
/** A new version that CHANGES the governing passage. */
export const FACT_SHEET_CHANGED = FACT_SHEET.replace('up to 12 hours', 'up to 14 hours');

export const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Adapters so the same helpers drive demo mode (role header) and authenticated mode (session). */
export const demoAs = (t, role) => (method, path, body, extra = {}) => t.call(method, path, { role, body, ...extra });
export const authAs = (client) => (method, path, body, extra = {}) => client.call(method, path, { body, ...extra });

export async function registerSource(api, { title = 'Fernlight fact sheet (fictional)', text = FACT_SHEET, ...rest } = {}) {
  const r = await api('POST', '/api/sources', { title, text, origin: 'paste', ...rest });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${r.text}`);
  return r.json.source;
}

export async function approveVersion(api, id, n, text, note = 'checked') {
  return api('POST', `/api/sources/${id}/versions/${n}/approve`, { expectedSha256: sha(text), note });
}

/** Start/end offsets of the Nth occurrence of `needle` in `text` (as the server normalises it: LF endings). */
export function span(text, needle, occurrence = 0) {
  let from = -1;
  for (let i = 0; i <= occurrence; i++) {
    from = text.indexOf(needle, from + 1);
    if (from < 0) throw new Error(`"${needle}" not found`);
  }
  return { start: from, end: from + needle.length };
}

export const link = (sourceId, version, text, needle, occurrence = 0) => ({ sourceId, version, ...span(text, needle, occurrence) });

/** Replace the source of one existing entry (by id) with a registered link, then publish. */
export async function publishWithLink(api, entryId, source, note = 'link evidence') {
  const g = (await api('GET', '/api/guidelines')).json;
  const edited = structuredClone(g.guidelines);
  const entry = [...edited.facts, ...edited.terms].find((e) => e.id === entryId);
  entry.source = source;
  return { res: await api('PUT', '/api/guidelines', { baseVersion: g.version, note, guidelines: edited }), edited, entry };
}
