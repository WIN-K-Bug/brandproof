import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deepFreeze } from './util.js';
import { acquireOwnership, assertNotSymlink } from './lock.js';

export const SCHEMA_VERSION = 1;

export const emptyState = () => ({
  schemaVersion: SCHEMA_VERSION,
  seq: { submission: 0, comment: 0, event: 0 },
  guidelineVersions: [],
  submissions: [],
});

/**
 * Single-process JSON store. Every change goes through mutate(), which
 *  - runs strictly one at a time (promise queue), so read-modify-write cannot interleave,
 *  - applies the change to a clone and only publishes it after the file is safely written,
 *  - writes temp file -> fsync -> rename, so a crash never leaves a half-written file.
 * Committed state is deep-frozen: readers cannot mutate it by accident.
 * This is local single-machine persistence, not a confidential multi-user database.
 */
export class Store {
  #file;
  #state;
  #fileMode;
  #queue = Promise.resolve();
  #ownership;
  #closed = false;

  constructor(file, state, fileMode, ownership = null) {
    this.#file = file;
    this.#fileMode = fileMode;
    this.#ownership = ownership;
    this.#state = deepFreeze(state);
  }

  /**
   * options.validate(state): throw to REFUSE a file (wrong kind/mode); the file is left untouched.
   * options.backup: keep a timestamped copy of an existing file (last 3) before this process writes to it.
   * options.fileMode: permission bits for new files (POSIX; ignored on Windows), e.g. 0o600 for credentials.
   * options.purpose: 'workspace' | 'credentials' (wording of the refusal only).
   *
   * Exclusive ownership of the file is taken FIRST (before any read, seeding or backup) and a second opener, in this process or
   * another, is refused (see lock.js). The owner must call close() to drain pending writes and release it.
   */
  static async open(file, seed, { validate, backup = false, fileMode, purpose = 'workspace' } = {}) {
    const ownership = await acquireOwnership(file, { purpose });
    try {
      return await Store.#openOwned(file, seed, { validate, backup, fileMode }, ownership);
    } catch (e) {
      await ownership.release(); // a failed start-up must not leave the file locked
      throw e;
    }
  }

  static async #openOwned(file, seed, { validate, backup, fileMode }, ownership) {
    let raw = null;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    let state;
    if (raw === null) {
      state = seed();
      await Store.#write(file, state, fileMode);
    } else {
      try {
        state = JSON.parse(raw);
      } catch {
        throw new Error(`Data file ${file} is not valid JSON. Fix or move it; BrandProof will not overwrite it.`);
      }
      if (state.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(`Data file ${file} has schema version ${state.schemaVersion}; expected ${SCHEMA_VERSION}.`);
      }
      validate?.(state);
      if (backup) await Store.#backup(file, raw);
    }
    return new Store(file, state, fileMode, ownership);
  }

  get state() {
    return this.#state;
  }

  /** fn receives a mutable draft and must be synchronous. Its return value is returned. */
  mutate(fn) {
    if (this.#closed) return Promise.reject(new Error('This workspace store is closed; nothing more can be saved through it.'));
    const run = this.#queue.then(async () => {
      const draft = structuredClone(this.#state);
      const result = fn(draft);
      if (result && typeof result.then === 'function') throw new Error('mutate() callbacks must be synchronous');
      await Store.#write(this.#file, draft, this.#fileMode);
      this.#state = deepFreeze(draft);
      return result;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * Stop accepting changes, let every change already accepted finish writing, then release ownership of the file.
   * Idempotent. After close() every mutate() is refused, so nothing can be written once another process may own the file.
   */
  async close() {
    this.#closed = true;
    await this.#queue; // pending mutations drain (a failed one was already reported to its caller)
    const o = this.#ownership;
    this.#ownership = null;
    await o?.release();
  }

  static async #backup(file, raw) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.[0-9]+Z$/, 'Z');
    await fs.writeFile(`${file}.bak-${stamp}`, raw, { mode: 0o600 });
    const dir = path.dirname(file);
    const base = path.basename(file) + '.bak-';
    const old = (await fs.readdir(dir)).filter((n) => n.startsWith(base)).sort();
    for (const n of old.slice(0, -3)) await fs.rm(path.join(dir, n), { force: true });
  }

  static async #write(file, state, fileMode) {
    await assertNotSymlink(file); // never replace a symbolic link with an ordinary file
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const fh = await fs.open(tmp, 'w', fileMode);
    try {
      await fh.writeFile(JSON.stringify(state, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (e) {
        // Windows can briefly lock the target (antivirus/indexer); retry a few times.
        if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
          await fs.rm(tmp, { force: true });
          throw e;
        }
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
      }
    }
  }
}
