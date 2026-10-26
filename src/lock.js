/**
 * Exclusive ownership of one data file: at most one BrandProof writer per workspace file or credential file.
 *
 * Why: the store keeps the whole file in memory and rewrites it atomically. Two processes (or two instances in one
 * process) on the SAME file would each acknowledge writes and the later rewrite would silently drop the earlier one.
 *
 * How: before anything is read, seeded, backed up or written, an ownership marker `<file>.lock` is created with the
 * exclusive-create flag (atomic on local file systems). It holds { token, pid, host, startedAt, purpose }. It is a runtime
 * marker, NOT user data: it is never packaged, and removing it deletes nothing.
 *
 *  - The path that names the marker is resolved through the real DIRECTORY of the file (realpath), so relative paths, `..`,
 *    directory junctions or symlinks, forward/back slashes and drive-letter case map to the same marker. On Windows and macOS
 *    the base name is lower-cased because those file systems are case-insensitive.
 *  - A data file that is ITSELF a symbolic link is refused (before anything is read, written or locked). An atomic save
 *    replaces the file's directory entry, so it would silently turn the link into an ordinary file, after which the old name
 *    and the target would be two different files. Use the real path instead.
 *  - A second opener, in this process or another, is REFUSED with an actionable message. Different files never conflict.
 *  - Only a marker that belongs to this instance (its random token) is ever released, and only after pending writes drained.
 *  - Crash recovery is conservative. A marker is taken over automatically ONLY when it names this computer and a process id
 *    that no longer exists (`kill(pid, 0)` says ESRCH). A live pid, a pid we cannot check, another computer, an unreadable
 *    marker or a half-finished recovery are all refused, with the manual step. The takeover itself is serialised by a second
 *    exclusive marker so two starters cannot both "recover" the same stale lock. Nothing is ever killed.
 *
 * Limits (also in docs/architecture.md): this protects cooperating BrandProof processes that follow the protocol. Builds
 * that predate it, other programs, hand edits, hard links to the same file under another name, and a shared network drive
 * (the host name is compared but file semantics there are not guaranteed) are outside the guarantee. A marker is not
 * encryption and not security against a malicious local process.
 */
import { promises as fs, readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** The data path itself cannot be used safely (a symbolic link). Nothing was read, written or locked. */
export class DataPathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataPathError';
    this.code = 'data_path_unsupported';
  }
}

/**
 * Refuse a data file that is a symbolic link (a regular file, a missing file, or a path through a directory junction/symlink is
 * fine). Checked when ownership is taken AND before every save, so a link that appears later is never silently replaced.
 */
export async function assertNotSymlink(file) {
  let st;
  try {
    st = await fs.lstat(path.resolve(file));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return;
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw new DataPathError(`${file} is a symbolic link. BrandProof does not support a symlinked data file: saving replaces the file itself, which would turn the link into an ordinary file and leave two different files behind. Nothing was read or changed. Point the data setting at the real file instead (a symlinked or junctioned DIRECTORY is fine).`);
  }
}

export class OwnershipError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'OwnershipError';
    this.code = 'workspace_in_use';
    this.details = details;
  }
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const WHAT = { workspace: 'this workspace file', credentials: 'this credential file' };
const held = new Map(); // markerPath -> { token } for markers THIS process holds
let exitHook = false;

/** The marker path for `file`, after resolving aliases. Creates the (empty) parent directory if needed; nothing else. */
export async function markerPathFor(file) {
  const abs = path.resolve(file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const dir = await fs.realpath(path.dirname(abs)); // resolves directory junctions/symlinks and case
  const base = path.basename(abs);
  return path.join(dir, `${CASE_INSENSITIVE ? base.toLowerCase() : base}.lock`);
}

function parse(text) {
  try {
    const m = JSON.parse(text);
    if (m && typeof m === 'object' && typeof m.token === 'string' && Number.isInteger(m.pid) && m.pid > 0 && typeof m.host === 'string') return m;
  } catch {}
  return null;
}

/** Reads a marker, tolerating one that is still being written. Returns a parsed marker, 'gone', or 'unreadable'. */
async function readMarker(markerPath) {
  for (let i = 0; i < 6; i++) {
    let text;
    try {
      text = await fs.readFile(markerPath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return 'gone';
      return 'unreadable';
    }
    const m = parse(text);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 40));
  }
  return 'unreadable';
}

/** 'self' | 'dead' | 'live'. Anything we cannot prove is dead counts as live. */
function judge(m) {
  if (m.host !== os.hostname()) return 'live';
  if (m.pid === process.pid) return 'self';
  try {
    process.kill(m.pid, 0);
    return 'live';
  } catch (e) {
    return e.code === 'ESRCH' ? 'dead' : 'live'; // EPERM: it exists but is not ours
  }
}

const manual = (markerPath) =>
  ` If you are sure no BrandProof process is using it (check Task Manager, or "Get-Process node"), delete only this runtime marker file, which holds no user data: ${markerPath}`;

function refusal(purpose, file, m, markerPath, why) {
  const what = WHAT[purpose] ?? 'this data file';
  const self = Boolean(m && typeof m === 'object' && judge(m) === 'self');
  const who = m && typeof m === 'object' ? (self ? 'This process already has' : `Another BrandProof process (pid ${m.pid}${m.startedAt ? `, started ${m.startedAt}` : ''}${m.host !== os.hostname() ? `, on computer ${m.host}` : ''}) has`) : 'Another process may have';
  const advice = purpose === 'credentials' ? 'Stop that server before running account setup, or use a different BRANDPROOF_AUTH_FILE.' : 'Use the server that is already running, or start this one with a different data file (BRANDPROOF_DATA for the server; the demo launchers have their own data-file settings).';
  return new OwnershipError(`${who} ${what} open: ${file}. Two writers on one file would lose saved changes, so this start was refused and nothing was read or changed. ${advice}${why ? ` (${why})` : ''}${self ? '' : manual(markerPath)}`, { purpose });
}

async function createMarker(markerPath, meta) {
  const fh = await fs.open(markerPath, 'wx', 0o600);
  try {
    await fh.writeFile(JSON.stringify(meta));
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await fs.rm(markerPath, { force: true }); // our own, incomplete marker
    throw e;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Remove a stale marker of a verified-dead process, serialised by a second exclusive marker. */
async function recoverStale(markerPath, stale, file, purpose) {
  const guardPath = `${markerPath}.takeover`;
  let guard;
  try {
    guard = await fs.open(guardPath, 'wx', 0o600);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw refusal(purpose, file, stale, markerPath, 'another start-up is recovering this marker, or one stopped half-way; if no BrandProof process is starting, also delete the file ending in .lock.takeover');
  }
  try {
    await guard.writeFile(String(process.pid));
    const again = await readMarker(markerPath);
    if (again === 'gone' || again === 'unreadable' || again.token !== stale.token || judge(again) !== 'dead') return; // changed meanwhile: re-judge
    await fs.unlink(markerPath);
  } finally {
    await guard.close().catch(() => {});
    await fs.rm(guardPath, { force: true });
  }
}

function ensureExitHook() {
  if (exitHook) return;
  exitHook = true;
  // Best effort on process.exit(), uncaught errors and normal exit: release only markers that are ours. (A hard kill cannot
  // run this; that is what the dead-pid recovery above is for.)
  process.on('exit', () => {
    for (const [markerPath, { token }] of held) {
      try {
        if (parse(readFileSync(markerPath, 'utf8'))?.token === token) unlinkSync(markerPath);
      } catch {}
    }
  });
}

/**
 * Take exclusive ownership of `file`. Resolves to { release() } or rejects with OwnershipError (nothing was changed).
 * purpose: 'workspace' | 'credentials' (only used to word the message).
 */
export async function acquireOwnership(file, { purpose = 'workspace' } = {}) {
  await assertNotSymlink(file); // before the marker, the directory or anything else is created
  const markerPath = await markerPathFor(file);
  const token = randomBytes(16).toString('hex');
  const meta = { v: 1, token, pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), purpose };
  let acquired = false;
  for (let attempt = 0; attempt < 6 && !acquired; attempt++) {
    try {
      await createMarker(markerPath, meta);
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const existing = await readMarker(markerPath);
      if (existing === 'gone') continue;
      if (existing === 'unreadable') throw refusal(purpose, file, null, markerPath, 'its ownership marker cannot be read');
      const verdict = judge(existing);
      if (verdict !== 'dead') throw refusal(purpose, file, existing, markerPath, null);
      await recoverStale(markerPath, existing, file, purpose);
    }
  }
  if (!acquired) throw refusal(purpose, file, null, markerPath, 'its ownership marker kept changing');
  held.set(markerPath, { token });
  ensureExitHook();
  let released = false;
  return {
    markerPath,
    /** Releases only a marker that still carries OUR token. Idempotent. */
    async release() {
      if (released) return;
      released = true;
      held.delete(markerPath);
      try {
        if (parse(await fs.readFile(markerPath, 'utf8'))?.token === token) await fs.unlink(markerPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    },
  };
}

/**
 * Run `closeFn` once on Ctrl+C (SIGINT) or SIGTERM, then exit. (On Windows only Ctrl+C in a console reaches Node as a signal;
 * a forced stop cannot be intercepted and leaves a marker that the next start recovers only if the process is verifiably gone.)
 */
export function onTermination(closeFn) {
  let started = false;
  const handler = (signal) => {
    if (started) return;
    started = true;
    const timer = setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 8000);
    Promise.resolve()
      .then(closeFn)
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}
