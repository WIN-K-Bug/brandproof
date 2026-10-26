# One writer per data file

BrandProof keeps a whole workspace (or credential) file in memory and rewrites it atomically. That is safe inside one process, but two processes on the **same file** would each acknowledge saves, and the later rewrite would silently drop the earlier one. This was reproduced with two real processes: both acknowledged a write, and only the second marker remained on disk. Normal start-up made it easy to do by accident, because the server falls through to another port when its port is busy.

It is now refused instead of relied on as a rule for people to remember. This is a reliability repair; it adds no feature, database or service.

## What is protected

The **workspace file** (demo or authenticated) and the **credential file** (`users.json`). Each is owned exclusively by one `Store`. The image folder beside a workspace file belongs to that workspace, so it is covered by the workspace's ownership. `npm run auth:setup` goes through the same credential store, so account setup is refused while a server (or another setup) has the credential file open.

Different files never conflict: two servers on two data files, and free-port fallback for them, work as before.

## How it works (`src/lock.js`)

1. **Before anything else.** `Store.open` creates an ownership marker `<file>.lock` with the exclusive-create flag (atomic) **before** reading, seeding, backing up or writing the file. If it cannot, it stops and nothing has changed.
2. **The marker** holds `{ token, pid, host, startedAt, purpose }`. It is runtime metadata, **not user data**; deleting it deletes nothing.
3. **Aliases.** The marker path is built from the real **directory** of the file (`realpath`), so a relative path, `..` or `.` segments, forward slashes, a directory junction or symlink, and (Windows and macOS) drive-letter and file-name case all name the same marker.
3a. **A data file that is itself a symbolic link is refused**, before anything is read, written, locked or created (`Store.open`, so the server, the demo launchers and `auth:setup` alike). A save replaces the file's directory entry, which would silently turn the link into an ordinary file and leave the old name and the target as two different files with two different markers (a reproduced hole: the second writer got in and an acknowledged write was lost). The same check runs before every save, so a link that appears while the store is open is never replaced either. Use the real file path; a symlinked or junctioned directory is fine.
4. **Refusal.** A second opener, in this process or another, gets: *Another BrandProof process (pid N, started T) has this workspace file open … Use the server that is already running, or start this one with a different data file …* The message names the marker so the rare manual recovery below is possible. Tokens are never printed, and no marker path or token appears in API responses or the dossier (tested).
5. **Release.** `store.close()` first refuses any new `mutate`, waits for every already accepted change to finish writing, and only then removes the marker, and only if it still carries **this instance's** random token. `createApp().close()` does this for the workspace store and the credential store. A failed start-up (bad or wrong-mode file, failing seed or validator, the wrong credential file after the workspace was taken, no free port) releases what it took. `process.exit()` and uncaught errors release through an exit hook. Ctrl+C or SIGTERM on the server and the demo launchers run a graceful close (implemented; on this Windows machine a signal cannot be sent to a child, so only the POSIX test exercises it, and it is skipped here). After `close()`, nothing can be written through that store.

## Crash recovery (conservative)

A hard kill, power loss or Task Manager "End task" cannot run any code, so it leaves the marker behind. The next start recovers it **automatically only when it can prove the owner is gone**: the marker names this computer and a process id for which the operating system reports "no such process". Everything else is refused and left untouched:

| Marker says | Result |
|---|---|
| a process that is still running (even if the marker is very old: age proves nothing) | refused |
| a process id the system will not let us check, an invalid id (0, negative) | refused |
| another computer's name (for example a shared drive) | refused |
| unreadable, empty or partly written content | refused |
| a verified-dead owner | recovered; the data file is not touched |
| a verified-dead owner, but a recovery guard `<file>.lock.takeover` was left by a start-up that stopped half-way | refused (both files named) |

Two starters recovering the same stale marker at once are serialised by a second exclusive marker, so exactly one wins (tested 4 processes × 4 rounds). Nothing is ever killed.

A process id can be reused by an unrelated program after a crash. That can only make a stale marker look alive (refused, safe side), never make a live owner look dead.

### Manual recovery (rare)

If a start is refused and you are certain no BrandProof process is using that file (look in Task Manager, or run `Get-Process node` in PowerShell), delete **only** the runtime marker file named in the message (`<your data file>.lock`, and `<your data file>.lock.takeover` if it names that too). Do **not** delete the data file. Then start again.

## Limits (stated, not hidden)

- It protects **cooperating BrandProof processes that follow the protocol**. Builds from before this change (for example the older frozen demo on port 4173) hold no marker, so a new server on the same file as such a process is outside the guarantee. So are other programs, hand edits of the data file, and anything run with the marker deleted by hand.
- **A data file that is itself a symbolic link is unsupported and refused** (see 3a). An earlier version of this document claimed symlink support; that was wrong: the lock followed the link, but the first save replaced the link with an ordinary file, after which a second opener got in and an acknowledged write was lost (reproduced by the reviewer and by my own check). Directory junctions and symlinked directories remain supported, and their aliases are tested.
- The image folder `<data file>.assets` is owned through its workspace file. If that folder is itself a symlink, or two different data files are pointed at one image folder by hand, nothing checks it.
- **Hard links:** a second name for the same file (a hard link) gets a different marker and is **not** detected. A test records this as a documented limit.
- **Shared or network drives** are not supported for concurrent use: marker creation is only as atomic as the file system makes it.
- **Windows:** a forced stop cannot be intercepted, so it relies on the recovery above. Only Ctrl+C in a console reaches the server as a signal there; `Stop-Process` and "End task" do not. A POSIX SIGTERM test exists but is skipped on Windows.
- Process-id checks are a heuristic for "gone", used only in the safe direction (it can refuse wrongly after pid reuse, never accept wrongly).
- A marker is not encryption and not security against a malicious local process, which could simply delete it.
- A write that was not yet accepted when `close()` was called (for example an account creation still hashing its password) is refused, not silently lost.

## Evidence (24 Oct 2026, this machine, synthetic temporary files only)

**Symlink hole, before and after** (own scratch reproduction of the reviewer's sequence: target file, file-symlink alias, open the alias, save, open the alias again, both save): previous package (m12): after the first save the alias was no longer a symlink, the second open was **allowed**, and `second-B` was lost from the target. This build: the alias is refused at the first open, the link and target are untouched.

`node scripts/verify/single-writer-probe.mjs [--root <source tree>]` starts two real processes on one file, acknowledges a write in each, and prints what persisted:

| Tree | Result |
|---|---|
| previous build (the m11 package, no protocol) | both opened; acknowledged `writer-A` and `writer-B`; persisted `["writer-B"]`; **lost acknowledged write** |
| this build | second writer **refused** (with the reason); acknowledged `writer-A`; persisted `["writer-A"]`; nothing lost |

`tests/single-writer.test.js` (23 tests, 22 run on Windows) uses real separate processes: second writer refused with bytes and directory listing unchanged, in-process opener refused; two starters on a new file (one wins, seeded once); distinct files in parallel; ownership kept across 40 concurrent writes; same-process duplicate and concurrent opens; close drains 25 queued writes and later writes are refused; every failed start-up releases (bad file, failing seed, failing validator, wrong-mode workspace, wrong credential file after the workspace was taken); a killed owner is recovered with data intact; live, other-computer, unreadable, bad-pid and half-finished-recovery markers are refused and untouched while a bystander process stays alive; four processes racing to recover one stale marker (4 rounds, exactly one wins each time); a marker that is not ours is never released; exit without close and an uncaught error both release; aliases (relative, dot-dot, slashes, junction, drive and file-name case); the hard-link limit; credential file duplicate and cross-process refusal, account setup cannot race a running credential writer, nothing lost across owners; two real servers on one workspace (second exits 1 without listening, file untouched, first keeps serving) while a different file starts on the next free port; a running authenticated server owns both its files; **file symlinks**: a symlinked data file (and a dangling one, a symlinked credential file, and a whole `createApp`) is refused with the link, its target and the directory unchanged and no image folder created; the reviewer's sequence (owner opens the real file and writes, then a second opener tries the alias in this process and in another, before and after more writes) leaves the link a link and every acknowledged write in the target; a link that appears while the store is open is never replaced by a save (and memory is not advanced); a real server pointed at a symlink exits 1 without listening. Each protection was removed in turn (19 removals, the 16 below plus the symlink refusal at open, the guard before a save, and restoring the old follow-the-link behaviour, which fails all four symlink tests: no ownership, never recovering, blind recovery, pid check ignored, foreign host trusted, recovery without its guard, release without the token, aliases not resolved, case not folded, exit hook, unreadable marker accepted, no drain, writes after close, failed start-up keeps the lock, workspace kept when credentials fail, close not releasing): the suite failed every time. Spawned children are reaped after each test so a failing assertion cannot leave the runner hanging.

Existing tests keep their meaning: the few that reopened a file while the first handle was still open now close it first (`tests/store.test.js`), and tests that open stores directly now close them; none disables the guard.

The ownership markers (`*.lock`, `*.lock.takeover`) are excluded from the source package and ignored by git; a test-planted marker in `src/` and `docs/` was confirmed absent from the archive.
