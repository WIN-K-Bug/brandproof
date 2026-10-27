import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { seedState, seedAuthState } from './seed.js';
import { openAuth } from './auth.js';
import { HttpError } from './util.js';
import { describeEngine, AI_PROVIDER_CONTRACT } from './ai.js';
import { runChecks } from './checks.js';
import * as svc from './service.js';
import {
  validateContent,
  validateComment,
  validateDecision,
  validateGuidelines,
  validateNewRevision,
  validateNewSubmission,
  validateReviewRequest,
  validateSemanticRequest,
  validateOcrRequest,
  validateNewSource,
  validateNewSourceVersion,
  validateSourceApproval,
  validateSourceRejection,
  validateSourceWithdrawal,
} from './validate.js';
import * as reg from './sources.js';
import { previewSourceChange, assertPreviewCurrent } from './impact.js';
import { buildDossier } from './dossier.js';
import { createOcr, OCR_LIMITS } from './ocr.js';
import { AssetStore, ASSET_LIMITS, createUploader, retainedEntry, usage as assetUsage, sha256Hex, SHA256 } from './assets.js';
import { createSemantic, createWorkerEmbedder, LIMITS as SEM_LIMITS, DISCLAIMER as SEM_DISCLAIMER } from './semantic.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 512 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const HOST_NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
// A Host header that is a plain name or IPv4 address with an optional port, checked against the deployment's list.
// (A bracketed IPv6 literal is only ever accepted when the list is "*".)
const HOST_HEADER = /^([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(:\d{1,5})?$/i;
export function hostAllowed(header, answersTo) {
  const m = HOST_HEADER.exec(header);
  if (!m) return false;
  return answersTo(m[1].toLowerCase());
}
/** The host-name rule, shared with the judge demo: localhost always; any other name only if the deployment listed it. */
export function hostAnswerer(allowedHosts) {
  return allowedHosts === '*' ? () => true : (name) => allowedHosts.includes(name);
}
/** An origin is "the same site" as the Host it was sent to. A host name the deployment admitted may sit behind a TLS proxy, so its https:// origin counts; localhost's does not. */
export const sameSite = (origin, host, local) => origin === `http://${host}` || (!local && origin === `https://${host}`);

/** The web app's files: every top-level file of public/ whose extension is a known type, keyed by URL path. */
export async function loadPublicFiles() {
  const files = new Map();
  for (const name of await fs.readdir(PUBLIC_DIR)) {
    const ext = path.extname(name);
    if (MIME[ext]) files.set('/' + name, { file: path.join(PUBLIC_DIR, name), type: MIME[ext] });
  }
  return files;
}

/** Send one of those files (GET or HEAD). Windows can briefly lock a file (antivirus, editor save): retry a couple of times before giving up. */
export async function serveStaticFile(entry, req, res, extraHeaders = {}) {
  let data;
  for (let attempt = 0; ; attempt++) {
    try {
      data = await fs.readFile(entry.file);
      break;
    } catch (e) {
      if (attempt >= 3 || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
    }
  }
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': entry.type, 'cache-control': 'no-cache', ...extraHeaders });
  res.end(req.method === 'HEAD' ? undefined : data);
}

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'content-security-policy':
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
};

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(new HttpError(413, 'too_large', `Request body must be at most ${limit} bytes.`));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too_large', `Request body must be at most ${limit} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Raw bytes (image upload). The declared content type is only a gate: the content itself is validated by the server. */
async function readRaw(req, limit) {
  if (!/^(application\/octet-stream|image\/png)(;|$)/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send the image bytes with Content-Type: application/octet-stream.');
  }
  const chunks = [];
  let size = 0;
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new HttpError(413, 'asset_too_large', 'The image is larger than the allowed size.');
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      req.destroy();
      throw new HttpError(413, 'asset_too_large', 'The image is larger than the allowed size.');
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
  }
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.');
  }
}

const invalid = (errors) => new HttpError(422, 'validation_failed', 'Some fields are invalid.', { fields: errors });

function checked({ errors, value }) {
  if (errors.length) throw invalid(errors);
  return value;
}

function roleOf(req, { required }) {
  const raw = req.headers['x-demo-role'];
  if (raw === undefined) {
    if (required) throw new HttpError(400, 'role_required', 'Missing X-Demo-Role header (demo role: creator, manager or reviewer).');
    return null;
  }
  if (!Object.hasOwn(svc.ROLES, raw)) throw new HttpError(400, 'bad_role', 'X-Demo-Role must be creator, manager or reviewer.');
  return raw;
}

/**
 * mode 'demo' (default): the original demo. Roles come from the X-Demo-Role header and are NOT security.
 * mode 'authenticated': identity and role come only from a server-side session; the demo header is ignored.
 *   Requires `authFile` (credentials, kept apart from the workspace file) and uses its own workspace file.
 *   The two modes refuse each other's data files.
 */
export async function createApp({ dataFile, clock = () => new Date().toISOString(), semantic, mode = 'demo', authFile, authOptions = {}, assetLimits = ASSET_LIMITS, hooks = {}, ocr: ocrOption, allowedHosts = [], sharedServices = false, metaExtra = {} } = {}) {
  if (!['demo', 'authenticated'].includes(mode)) throw new Error(`Unknown mode ${mode}`);
  const authed = mode === 'authenticated';
  if (authed && !authFile) throw new Error('Authenticated mode needs an authFile for credentials.');
  // Host names (besides localhost) this server answers to; [] (the default) keeps it localhost-only. '*' means any host name.
  // This is the deployment opt-in (docs/deployment.md); authenticated mode is local sign-in and never accepts it.
  if (allowedHosts !== '*' && !(Array.isArray(allowedHosts) && allowedHosts.every((h) => typeof h === 'string' && HOST_NAME.test(h)))) {
    throw new Error('allowedHosts must be "*" or a list of lower-case host names without scheme or port.');
  }
  if (authed && (allowedHosts === '*' || allowedHosts.length)) throw new Error('Authenticated mode answers on localhost only; allowedHosts is for demo-mode deployments.');
  const answersTo = hostAnswerer(allowedHosts);
  if (authed && path.resolve(authFile) === path.resolve(dataFile)) throw new Error('The credential file and the workspace file must be different files.');
  const store = authed
    ? await Store.open(dataFile, () => seedAuthState(clock()), {
        backup: true,
        fileMode: 0o600,
        validate: (s) => {
          if (s.meta?.mode !== 'authenticated') throw new Error(`${dataFile} is a demo-mode workspace. Authenticated mode will not adopt demo data (its actors are made up). Use a different data file.`);
        },
      })
    : await Store.open(dataFile, () => seedState(clock()), {
        validate: (s) => {
          if (s.meta?.mode === 'authenticated') throw new Error(`${dataFile} is an authenticated-mode workspace. Demo mode will not open it. Use a different data file.`);
        },
      });
  let auth = null;
  try {
    auth = authed ? await openAuth(authFile, authOptions) : null;
  } catch (e) {
    await store.close(); // a failed start-up must not leave the workspace file owned
    throw e;
  }
  // Image bytes live beside THIS workspace file (never shared between workspaces or modes).
  const blobs = new AssetStore(`${dataFile}.assets`);
  const uploader = createUploader({ store, blobs, limits: assetLimits });
  // semantic: undefined -> real local embeddings if the optional package and model are present;
  // null -> switched off; or a service made with createSemantic() (tests pass their own embedder).
  const sem = semantic === undefined ? createSemantic({ embedder: process.env.BRANDPROOF_SEMANTIC === 'off' ? null : createWorkerEmbedder() }) : (semantic ?? createSemantic({ embedder: null }));

  // Optional local text reading (undefined: the real reader if it is installed; null: switched off; or a service made with createOcr()).
  const ocr = ocrOption === undefined ? createOcr() : (ocrOption ?? createOcr({ availability: () => ({ ok: false, reason: 'reading text from images is switched off' }) }));

  let files;
  try {
    files = await loadPublicFiles();
  } catch (e) {
    await auth?.close();
    await store.close();
    throw e;
  }

  const routes = [];
  // write: needs a demo role and a JSON body. json: reads a JSON body but needs no role (read-only checks).
  // public: reachable without signing in (authenticated mode). owner: only users flagged as owner. maxBody: tighter body limit.
  // raw: body is the raw bytes (image upload). roles: only these roles, checked BEFORE the body is read.
  const route = (method, pattern, handler, { write = false, json = write, raw = false, roles = null, public: isPublic = false, owner = false, maxBody = MAX_BODY } = {}) => {
    routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, write, json: json && !raw, raw, roles, public: isPublic, owner, maxBody });
  };

  const now = () => clock();
  const mutateWith = (fn) => store.mutate(fn);

  const roleList = Object.entries(svc.ROLES).map(([id, r]) => ({ id, label: r.label, actor: r.actor }));
  route(
    'GET',
    '/api/meta',
    ({ user }) => {
      if (authed && !user) {
        // Before sign-in: only what the sign-in screen needs.
        return { app: 'BrandProof', team: 'bhangaledhruv7', mode, demo: false, roles: roleList, engine: describeEngine(), setupRequired: auth.userCount() === 0 };
      }
      return {
        app: 'BrandProof',
        team: 'bhangaledhruv7',
        mode,
        demo: !authed,
        roles: roleList,
        engine: describeEngine(),
        aiContract: AI_PROVIDER_CONTRACT,
        guidelineVersion: svc.currentVersion(store.state).version,
        semantic: sem.status(),
        ocr: { state: ocr.status().state, reason: ocr.status().reason ?? null },
        ...metaExtra,
      };
    },
    { public: true },
  );

  if (authed) {
    const bodyOf = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});
    const bad = (path, message) => invalid([{ path, message }]);
    route(
      'POST',
      '/api/auth/login',
      async ({ body, ip }) => {
        const b = bodyOf(body);
        if (typeof b.username !== 'string' || typeof b.password !== 'string' || !b.username || !b.password) throw bad('credentials', 'username and password are required');
        const r = await auth.login(b.username, b.password, ip);
        return [200, { user: r.user, csrf: r.csrf, idleSeconds: r.idleSeconds, absoluteSeconds: r.absoluteSeconds }, { 'set-cookie': r.cookie }];
      },
      { public: true, json: true, maxBody: 8 * 1024 },
    );
    route('GET', '/api/auth/me', ({ user, session }) => ({ user, csrf: session.csrf, expiresAt: session.expiresAt, idleSeconds: auth.idleSeconds }));
    route(
      'POST',
      '/api/auth/logout',
      async ({ user, session, ip }) => [200, { ok: true }, { 'set-cookie': await auth.logout(session.sid, user, ip) }],
      { json: true, maxBody: 1024 },
    );
    route(
      'POST',
      '/api/auth/password',
      async ({ body, user, session, ip }) => {
        const b = bodyOf(body);
        const r = await auth.changePassword({ user, session }, { current: b.current, next: b.next }, ip);
        return [200, { ok: true, csrf: r.csrf }, { 'set-cookie': r.cookie }];
      },
      { json: true, maxBody: 8 * 1024 },
    );
    route('GET', '/api/admin/users', () => ({ users: auth.listUsers() }), { owner: true });
    route('GET', '/api/admin/audit', () => ({ events: auth.recentAudit(200) }), { owner: true });
    route(
      'POST',
      '/api/admin/users',
      async ({ body, user }) => {
        const b = bodyOf(body);
        // owners are only created by the local setup command, never over HTTP
        const u = await auth.createUser({ username: b.username, displayName: b.displayName, role: b.role, password: b.password, owner: false, createdBy: user.id });
        return [201, u];
      },
      { json: true, owner: true, maxBody: 8 * 1024 },
    );
    for (const [action, fn] of [
      ['disable', (id, user) => auth.adminSetDisabled(user.id, id, true)],
      ['enable', (id, user) => auth.adminSetDisabled(user.id, id, false)],
    ]) {
      route('POST', `/api/admin/users/:id/${action}`, async ({ params, user }) => [200, await fn(params.id, user)], { json: true, owner: true, maxBody: 1024 });
    }
    route(
      'POST',
      '/api/admin/users/:id/reset-password',
      async ({ params, body, user }) => [200, await auth.adminResetPassword(user.id, params.id, bodyOf(body).password)],
      { json: true, owner: true, maxBody: 8 * 1024 },
    );
  }

  // ----- AI source matching (relevance only; never part of findings or approval) -----
  route('GET', '/api/semantic/status', () => sem.status());
  route(
    'POST',
    '/api/semantic/match',
    async ({ body }) => {
      const req = checked(validateSemanticRequest(body));
      const snapshot = () => {
        const sub = store.state.submissions.find((s) => s.id === req.submissionId);
        if (!sub) throw new HttpError(404, 'not_found', `No submission ${req.submissionId}.`);
        const head = sub.revisions.at(-1);
        const version = svc.currentVersion(store.state);
        const retrieval = reg.retrievalSources(store.state);
        const evidence = svc.evidenceFor(store.state);
        // Current state of every registered source version a rule cites: retired evidence must not come back through the rules.
        const linkStates = Object.fromEntries(evidence.entries.map((e) => [e.entryId, e.state]));
        return { head, version, guidelineHash: svc.guidelineHash(version.guidelines), evidenceHash: evidence.hash, retrieval, linkStates };
      };
      const stale = (why) => new HttpError(409, 'stale_result', `${why} This result was discarded. Run the match again.`);
      const before = snapshot();
      if (before.head.n !== req.revision) throw stale(`Revision ${req.revision} is no longer the latest.`);
      if (svc.contentHash(before.head.text) !== req.expected.contentHash) throw stale('The copy changed.');
      if (before.guidelineHash !== req.expected.guidelineHash) throw stale('The guidelines changed.');
      if (before.evidenceHash !== (req.expected.evidenceHash ?? reg.EMPTY_EVIDENCE_HASH)) throw stale('The registered source evidence changed.');
      let total = 0;
      const passages = req.passages.map((p) => {
        if (p.end > before.head.text.length) throw invalid([{ path: 'passages', message: 'extends past the end of the copy' }]);
        const text = before.head.text.slice(p.start, p.end).trim();
        total += text.length;
        if (!text || text.length > SEM_LIMITS.passageChars) throw invalid([{ path: 'passages', message: `each passage must be 1 to ${SEM_LIMITS.passageChars} characters` }]);
        return { ...p, text };
      });
      if (total > SEM_LIMITS.totalChars) throw invalid([{ path: 'passages', message: `at most ${SEM_LIMITS.totalChars} characters in total` }]);

      const out = await sem.match({ passages, guidelines: before.version.guidelines, guidelineHash: before.guidelineHash, extraSources: before.retrieval.items, sourcesKey: `${before.retrieval.hash}:${before.evidenceHash}`, linkStates: before.linkStates });

      const after = snapshot(); // edits that landed while the model was running
      // Edits, guideline publications or source approvals/withdrawals that landed while the model was running: discard.
      if (after.head.n !== before.head.n || after.guidelineHash !== before.guidelineHash || after.evidenceHash !== before.evidenceHash || after.retrieval.hash !== before.retrieval.hash) {
        throw stale('The copy, guidelines or approved sources changed while matching.');
      }
      return {
        mode: 'local-embeddings',
        status: sem.status(),
        disclaimer: SEM_DISCLAIMER,
        submissionId: req.submissionId,
        revision: before.head.n,
        contentHash: req.expected.contentHash,
        guidelineVersion: before.version.version,
        guidelineHash: before.guidelineHash,
        evidenceHash: before.evidenceHash,
        retrievalHash: before.retrieval.hash,
        retrievalNote: 'Passages come only from ACTIVE approved registered sources and the guideline library. Similarity is relevance, not truth or compliance.',
        ...out,
      };
    },
    { json: true },
  );

  // ----- campaign images (PNG only; bytes retained beside the workspace file) -----
  route('GET', '/api/assets/usage', () => ({ ...assetUsage(store.state), limits: { imageBytes: assetLimits.imageBytes, maxDimension: assetLimits.maxDimension, maxPixels: assetLimits.maxPixels, totalBytes: assetLimits.totalBytes, count: assetLimits.count } }));
  route(
    'POST',
    '/api/assets',
    async ({ body, role, actor }) => {
      const who = actor ? { id: actor.id, name: actor.name, role: actor.role } : { role, name: svc.ROLES[role].actor };
      const { entry, created, restored } = await uploader.upload(body, { who, now: now() });
      return [created ? 201 : 200, { asset: { ...entry, retained: true, deduplicated: !created, restored: restored ?? null, url: `/api/assets/${entry.sha256}` } }];
    },
    { write: true, raw: true, roles: ['creator', 'manager'], maxBody: assetLimits.imageBytes + 16 },
  );
  route('GET', '/api/assets/:sha', async ({ params }) => {
    // Only a 64-hex reference that is registered in THIS workspace is ever turned into a file path.
    if (!SHA256.test(params.sha)) throw new HttpError(404, 'not_found', 'No such image.');
    const entry = retainedEntry(store.state, params.sha);
    if (!entry) throw new HttpError(404, 'not_found', 'No such image.');
    let bytes;
    try {
      bytes = await blobs.read(params.sha);
    } catch {
      throw new HttpError(404, 'asset_missing', 'This image is registered but its file is missing from storage.');
    }
    if (bytes.length !== entry.bytes || sha256Hex(bytes) !== params.sha) throw new HttpError(500, 'asset_corrupt', 'The stored image failed its integrity check and was not served.');
    return {
      binary: bytes,
      type: 'image/png', // fixed: never taken from the upload
      headers: {
        'content-security-policy': "default-src 'none'; sandbox",
        'content-disposition': 'inline; filename="image.png"',
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'private, no-store',
      },
    };
  });

  // ----- reading text from a retained image (optional, local, human-confirmed) -----
  route('GET', '/api/ocr/status', () => ocr.status());
  route(
    'POST',
    '/api/assets/:sha/ocr',
    async ({ params, body, signal }) => {
      if (!SHA256.test(params.sha)) throw new HttpError(404, 'not_found', 'No such image.');
      const entry = retainedEntry(store.state, params.sha);
      if (!entry) throw new HttpError(404, 'not_found', 'No such image.'); // only a digest registered in THIS workspace; no paths, no URLs
      const ref = checked(validateOcrRequest(body));
      const subOf = (state) => (ref.submissionId ? state.submissions.find((x) => x.id === ref.submissionId) : null);
      if (ref.submissionId) {
        const rev = subOf(store.state)?.revisions.find((r) => r.n === ref.revision);
        if (!rev) throw new HttpError(404, 'not_found', `No revision ${ref.revision} of ${ref.submissionId}.`);
        if (rev.asset.retainedSha256 !== params.sha) throw new HttpError(409, 'image_mismatch', `Revision ${ref.revision} does not hold this image, so its text cannot be read from it.`);
      }
      if (entry.width * entry.height > OCR_LIMITS.maxPixels || entry.bytes > OCR_LIMITS.maxBytes) throw new HttpError(422, 'ocr_image_too_large', 'This image is larger than the text reader accepts. Type the text instead.');
      const st = ocr.status();
      if (st.state === 'unavailable') throw new HttpError(503, 'ocr_unavailable', `Reading text from images is not available here: ${st.reason}. Type the text instead.`);
      // The bytes are read and checked against their digest right now: a missing or damaged file blocks reading.
      let bytes;
      try {
        bytes = await blobs.read(params.sha);
      } catch {
        throw new HttpError(404, 'asset_missing', 'This image is registered but its file is missing from storage, so its text cannot be read. Upload the same image again to restore it.');
      }
      if (bytes.length !== entry.bytes || sha256Hex(bytes) !== params.sha) throw new HttpError(409, 'asset_corrupt', 'The stored image failed its integrity check, so its text was not read. Upload the same image again to restore it.');
      const draft = await ocr.extract({ sha256: params.sha, bytes, signal });
      // After the slow part: it must still be this workspace's retained image, and a revision it was asked for is reported if it has been superseded.
      if (!retainedEntry(store.state, params.sha)) throw new HttpError(409, 'image_gone', 'The image is no longer retained in this workspace.');
      const head = ref.submissionId ? subOf(store.state)?.revisions.at(-1).n : null;
      const { createdMs, ...pub } = draft;
      return {
        draft: pub,
        revision: ref.submissionId ? { submissionId: ref.submissionId, revision: ref.revision, headRevision: head, superseded: head !== ref.revision } : null,
        note: 'This is an automatic DRAFT. It may contain mistakes, including in numbers, and it may miss text. Compare it with the image, correct it, and confirm it yourself. Its confidence is the engine\'s own heuristic, not correctness.',
      };
    },
    { write: true, roles: ['creator', 'manager'] },
  );

  /** No review request or approval on bytes that are no longer in storage. */
  const requireImageBytes = async (submissionId) => {
    const sub = store.state.submissions.find((x) => x.id === submissionId);
    const sha = sub?.revisions.at(-1).asset.retainedSha256;
    if (!sha) return;
    const e = retainedEntry(store.state, sha);
    const state = e ? await blobs.verify(sha, e.bytes) : 'missing';
    if (state !== 'ok') {
      throw new HttpError(
        409,
        state === 'corrupt' ? 'asset_corrupt' : 'asset_missing',
        state === 'corrupt'
          ? "The image attached to this revision failed its integrity check: the stored file no longer matches its digest, so it cannot be sent for review or approved. Upload the same image again to restore it, then try again."
          : 'The image attached to this revision is not available in storage, so it cannot be sent for review or approved. Upload the same image again to restore it, then try again.',
      );
    }
  };

  // ----- approved-source registry -----
  route('GET', '/api/sources', () => svc.sourcesOverview(store.state));
  route('GET', '/api/sources/:id', ({ params }) => svc.sourceDetail(store.state, params.id));
  route('GET', '/api/sources/:id/versions/:n', ({ params }) => reg.sourceVersionDetail(store.state, params.id, Number(params.n)));
  // Read-only impact preview. Managers only (it exposes campaign and approval detail); it never writes.
  route(
    'GET',
    '/api/sources/:id/impact',
    ({ params, query, actor }) => {
      const action = query.get('action') ?? '';
      const rawVersion = query.get('version');
      const version = rawVersion === null ? undefined : /^[0-9]{1,6}$/.test(rawVersion) ? Number(rawVersion) : NaN;
      return previewSourceChange(store.state, { sourceId: params.id, action, version, actor });
    },
    { roles: ['manager'] },
  );
  route(
    'POST',
    '/api/sources',
    async ({ body, role, actor }) => {
      if (!['creator', 'manager'].includes(role)) throw new HttpError(403, 'forbidden', 'Only Creator or Manager roles can register sources.');
      const input = checked(validateNewSource(body));
      const src = await mutateWith((d) => reg.registerSource(d, { ...input, role, actor, now: now() }, svc.ROLES));
      return [201, svc.sourceDetail(store.state, src.id)];
    },
    { write: true },
  );
  route(
    'POST',
    '/api/sources/:id/versions',
    async ({ params, body, role, actor }) => {
      if (!['creator', 'manager'].includes(role)) throw new HttpError(403, 'forbidden', 'Only Creator or Manager roles can register sources.');
      const input = checked(validateNewSourceVersion(body));
      await mutateWith((d) => reg.addSourceVersion(d, { id: params.id, ...input, role, actor, now: now() }, svc.ROLES));
      return [201, svc.sourceDetail(store.state, params.id)];
    },
    { write: true },
  );
  route(
    'POST',
    '/api/sources/:id/versions/:n/approve',
    async ({ params, body, role, actor }) => {
      if (role !== 'manager') throw new HttpError(403, 'forbidden', 'Only the Manager role can approve a source version.');
      const input = checked(validateSourceApproval(body));
      await mutateWith((d) => {
        // A preview the manager read must still describe this exact state, or nothing is approved.
        if (input.previewDigest) assertPreviewCurrent(d, { sourceId: params.id, action: 'activate', version: Number(params.n), actor, previewDigest: input.previewDigest });
        return reg.approveSourceVersion(d, { id: params.id, n: Number(params.n), expectedSha256: input.expectedSha256, note: input.note, role, actor, now: now() }, svc.ROLES);
      });
      return [201, svc.sourceDetail(store.state, params.id)];
    },
    { write: true },
  );
  route(
    'POST',
    '/api/sources/:id/versions/:n/reject',
    async ({ params, body, role, actor }) => {
      if (role !== 'manager') throw new HttpError(403, 'forbidden', 'Only the Manager role can reject a source version.');
      const input = checked(validateSourceRejection(body));
      await mutateWith((d) => reg.rejectSourceVersion(d, { id: params.id, n: Number(params.n), ...input, role, actor, now: now() }, svc.ROLES));
      return [201, svc.sourceDetail(store.state, params.id)];
    },
    { write: true },
  );
  route(
    'POST',
    '/api/sources/:id/withdraw',
    async ({ params, body, role, actor }) => {
      if (role !== 'manager') throw new HttpError(403, 'forbidden', 'Only the Manager role can withdraw a source.');
      const input = checked(validateSourceWithdrawal(body));
      await mutateWith((d) => {
        if (input.previewDigest) assertPreviewCurrent(d, { sourceId: params.id, action: 'withdraw', actor, previewDigest: input.previewDigest });
        return reg.withdrawSource(d, { id: params.id, expectedActiveVersion: input.expectedActiveVersion, note: input.note, role, actor, now: now() }, svc.ROLES);
      });
      return [201, svc.sourceDetail(store.state, params.id)];
    },
    { write: true },
  );

  // ----- guidelines -----
  route('GET', '/api/guidelines', () => {
    const v = svc.currentVersion(store.state);
    return { version: v.version, hash: v.hash, createdAt: v.createdAt, createdBy: v.createdBy, note: v.note, guidelines: v.guidelines };
  });
  route('GET', '/api/guidelines/versions', () => {
    const vs = store.state.guidelineVersions;
    return { versions: vs.map((v, i) => svc.versionSummary(v, vs[i - 1])).reverse() };
  });
  route('GET', '/api/guidelines/versions/:n', ({ params }) => {
    const v = store.state.guidelineVersions.find((x) => x.version === Number(params.n));
    if (!v) throw new HttpError(404, 'not_found', 'No such guideline version.');
    return v;
  });
  route(
    'PUT',
    '/api/guidelines',
    async ({ body, role, actor }) => {
      // authorise BEFORE validating, so a caller without the right never learns anything about the payload
      if (role !== 'manager') throw new HttpError(403, 'forbidden', 'Only the Manager role can publish guideline versions.');
      const b = body && typeof body === 'object' ? body : {};
      const baseVersion = b.baseVersion;
      if (!Number.isInteger(baseVersion)) throw invalid([{ path: 'baseVersion', message: 'must be a whole number' }]);
      const note = typeof b.note === 'string' ? b.note.trim().slice(0, 200) : '';
      const guidelines = checked(validateGuidelines(b.guidelines));
      const v = await mutateWith((d) => svc.publishGuidelines(d, { baseVersion, guidelines, note, role, actor, now: now() }));
      return [201, { version: v.version, hash: v.hash }];
    },
    { write: true },
  );

  // ----- live check (no persistence) -----
  route(
    'POST',
    '/api/check',
    ({ body }) => {
      const content = checked(validateContent(body));
      const v = svc.currentVersion(store.state);
      const result = runChecks({ text: content.text, asset: content.asset, imageText: content.imageText?.text }, v.guidelines);
      reg.decorateFindings(result.findings, store.state);
      return { engine: describeEngine(), guidelineVersion: v.version, ...result };
    },
    { json: true },
  );

  // ----- submissions -----
  route('GET', '/api/submissions', () => ({ submissions: svc.listSubmissions(store.state) }));
  route(
    'POST',
    '/api/submissions',
    async ({ body, role, actor }) => {
      const input = checked(validateNewSubmission(body));
      const draft = input.imageText?.draftId ? ocr.lookup(input.imageText.draftId) : null;
      const sub = await mutateWith((d) => svc.createSubmission(d, { ...input, draft, role, actor, now: now() }));
      return [201, svc.describeSubmission(store.state, sub.id, role, actor)];
    },
    { write: true },
  );
  route('GET', '/api/submissions/:id', ({ params, role, actor }) => svc.describeSubmission(store.state, params.id, role, actor));
  // Review dossier: a read-only snapshot of ONE campaign. The only asynchronous input is the image's integrity (read from
  // disk); the snapshot is accepted only if the committed state is still the very one it was built from, otherwise it is
  // rebuilt, and after a few attempts the caller is told to retry. Nothing is written, logged or sent anywhere.
  route('GET', '/api/submissions/:id/dossier', async ({ params }) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = store.state;
      const sub = state.submissions.find((s) => s.id === params.id);
      if (!sub) throw new HttpError(404, 'not_found', `No submission ${params.id}.`);
      const sha = sub.revisions.at(-1).asset.retainedSha256;
      let integrity;
      if (sha) {
        const e = retainedEntry(state, sha);
        integrity = e ? await blobs.verify(sha, e.bytes) : 'missing';
        await hooks.dossierAfterVerify?.(attempt);
      }
      if (store.state !== state) continue;
      return buildDossier(state, params.id, { integrity, now: now(), mode });
    }
    throw new HttpError(409, 'snapshot_changed', 'The workspace kept changing while the dossier was being prepared. Try again in a moment.');
  });
  route('GET', '/api/submissions/:id/compare', ({ params, query }) => {
    const from = Number(query.get('from'));
    const to = Number(query.get('to'));
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw invalid([{ path: 'from/to', message: 'must be revision numbers' }]);
    return svc.compareRevisions(store.state, params.id, from, to);
  });
  route(
    'POST',
    '/api/submissions/:id/revisions',
    async ({ params, body, role, actor }) => {
      const input = checked(validateNewRevision(body));
      const draft = input.imageText?.draftId ? ocr.lookup(input.imageText.draftId) : null;
      await mutateWith((d) => svc.addRevision(d, { id: params.id, ...input, draft, role, actor, now: now() }));
      return [201, svc.describeSubmission(store.state, params.id, role, actor)];
    },
    { write: true },
  );
  route(
    'POST',
    '/api/submissions/:id/comments',
    async ({ params, body, role, actor }) => {
      const input = checked(validateComment(body));
      const c = await mutateWith((d) => svc.addComment(d, { id: params.id, ...input, role, actor, now: now() }));
      return [201, c];
    },
    { write: true },
  );
  route(
    'POST',
    '/api/submissions/:id/request-review',
    async ({ params, body, role, actor }) => {
      const input = checked(validateReviewRequest(body));
      await requireImageBytes(params.id);
      await mutateWith((d) => svc.requestReview(d, { id: params.id, ...input, role, actor, now: now() }));
      return [201, svc.describeSubmission(store.state, params.id, role, actor)];
    },
    { write: true },
  );
  for (const [action, decision, noteRequired] of [['approve', 'approved', false], ['reject', 'rejected', true]]) {
    route(
      'POST',
      `/api/submissions/:id/${action}`,
      async ({ params, body, role, actor }) => {
        const input = checked(validateDecision(body, { noteRequired }));
        if (decision === 'approved') await requireImageBytes(params.id);
        await mutateWith((d) => svc.decide(d, { id: params.id, decision, ...input, role, actor, now: now() }));
        return [201, svc.describeSubmission(store.state, params.id, role, actor)];
      },
      { write: true },
    );
  }

  route('GET', '/api/insights', () => svc.insights(store.state));

  // ----- http plumbing -----
  let port = null;

  async function handle(req, res) {
    const send = (status, payload, type = 'application/json; charset=utf-8', extra = {}) => {
      const body = type.startsWith('application/json') ? JSON.stringify(payload) : payload;
      res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store', ...extra });
      res.end(body);
    };
    try {
      const host = req.headers.host || '';
      // Localhost always; other host names only when a deployment listed them (or chose "*"). A name outside the list is refused.
      const local = LOCAL_HOST.test(host);
      if (!local && !hostAllowed(host, answersTo)) throw new HttpError(403, 'bad_host', 'This server only answers on localhost.');
      const url = new URL(req.url, `http://${host}`);

      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
        const sameOrigin = origin !== undefined && sameSite(origin, host, local);
        // Demo mode tolerates a missing Origin (scripts, tests). Authenticated mode requires it to match on every unsafe request.
        if (isWrite && (authed ? !sameOrigin : origin && !sameOrigin)) throw new HttpError(403, 'bad_origin', 'Cross-origin requests are not allowed.');
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const params = Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
          let role = null;
          let actor;
          let user = null;
          let session = null;
          if (authed) {
            // Identity comes ONLY from the server-side session. X-Demo-Role is never read in this mode.
            const a = auth.authenticate(req.headers.cookie);
            if (a) ({ user, session } = a);
            if (!r.public) {
              if (!a) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
              if (isWrite && !auth.csrfOk(session, req.headers['x-csrf-token'])) throw new HttpError(403, 'bad_csrf', 'Missing or invalid request token. Reload the page and try again.');
              if (r.owner && !user.owner) throw new HttpError(403, 'forbidden', 'Only an owner can do this.');
            }
            if (user) {
              role = user.role;
              actor = { id: user.id, name: user.name, role: user.role };
            }
          } else {
            role = roleOf(req, { required: r.write });
          }
          if (r.roles && !r.roles.includes(role)) throw new HttpError(403, 'forbidden', `Only ${r.roles.map((x) => svc.ROLES[x].label).join(' or ')} roles can do this.`);
          const body = r.json ? await readJson(req, r.maxBody) : r.raw ? await readRaw(req, r.maxBody) : undefined;
          // A handler that waits on slow work (reading text from an image) is told if the browser went away.
          const ac = new AbortController();
          res.on('close', () => {
            if (!res.writableEnded) ac.abort();
          });
          const out = await r.handler({ params, query: url.searchParams, body, role, actor, user, session, signal: ac.signal, ip: req.socket.remoteAddress ?? 'unknown' });
          if (out && out.binary) return send(200, out.binary, out.type, out.headers);
          return Array.isArray(out) ? send(out[0], out[1], 'application/json; charset=utf-8', out[2]) : send(200, out);
        }
        if (routes.some((r) => r.re.test(url.pathname))) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
        throw new HttpError(404, 'not_found', 'No such API route.');
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      const entry = files.get(url.pathname === '/' ? '/index.html' : url.pathname);
      if (!entry) throw new HttpError(404, 'not_found', 'Not found.');
      await serveStaticFile(entry, req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        send(e.status, { error: { code: e.code, message: e.message, details: e.details } });
      } else {
        console.error('Unhandled error:', e);
        send(500, { error: { code: 'internal', message: 'Something went wrong on the server.' } });
      }
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  if (semantic === undefined) sem.warm();

  /**
   * Send ONE request to this app's own handler without a network socket (the judge demo's scenario setup uses it). It goes through the very same
   * route table, role checks, validation and workspace rules as a request over HTTP; nothing is bypassed. Demo mode only (it carries a demo role).
   */
  async function inject({ method = 'GET', url, role, body, raw = false }) {
    if (authed) throw new Error('inject is for demo-mode apps.');
    const headers = { host: '127.0.0.1' };
    if (role) headers['x-demo-role'] = role;
    let payload = null;
    if (raw) {
      payload = Buffer.from(body);
      headers['content-type'] = 'application/octet-stream';
    } else if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['content-type'] = 'application/json';
    }
    if (payload) headers['content-length'] = String(payload.length);
    const req = Object.assign(Readable.from(payload ? [payload] : []), { method, url, headers, socket: { remoteAddress: '127.0.0.1' } });
    const out = { status: 200, chunks: [] };
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false,
      headersSent: false,
      setHeader() {},
      writeHead(status) {
        out.status = status;
        res.headersSent = true;
      },
      end(data) {
        if (data !== undefined) out.chunks.push(Buffer.from(data));
        res.writableEnded = true;
        res.emit('close');
      },
    });
    await handle(req, res);
    const text = Buffer.concat(out.chunks).toString('utf8');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: out.status, json, text };
  }

  return {
    server,
    store,
    auth,
    mode,
    inject,
    /** Listen on `wantedPort` (0 = any free port) at `host`. Loopback (127.0.0.1) is the default and what everything local uses. */
    listen(wantedPort = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        // A failed attempt (port in use) must leave nothing behind: callers retry on the next port, and each stale
        // "listening" callback would otherwise pile up and trigger Node's MaxListeners warning after ten busy ports.
        const onListening = () => {
          server.off('error', onError);
          port = server.address().port;
          resolve(`http://${host.includes(':') ? `[${host}]` : host}:${port}`);
        };
        const onError = (e) => {
          server.off('listening', onListening);
          reject(e);
        };
        server.once('error', onError);
        server.listen(wantedPort, host, onListening);
      });
    },
    /**
     * Stop serving, let pending saves finish, then release ownership of the workspace and credential files.
     * Nothing can be written through this app afterwards (the stores refuse), so another process may safely take over.
     */
    async close() {
      // The reading and matching services may be shared by many apps (the judge demo); whoever created them stops them.
      if (!sharedServices) {
        sem.stop?.();
        ocr.stop();
      }
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await auth?.close();
      await store.close();
    },
  };
}
