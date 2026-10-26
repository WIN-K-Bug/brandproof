# Isolated fictional judge demo (m20)

**Status, plainly.** This is built and tested on this computer. Nothing is deployed, published or uploaded; no accounts or credentials are involved; it has not been run on a hosting platform, a container runtime or behind a real TLS proxy. Everything a visitor sees and stores is fictional.

**What it is.** An opt-in way to run the existing BrandProof product so that a judge can open it with **no sign-in** and get **their own separate workspace**: each browser gets its own session with its own fictional data, campaigns, comments, decisions and images, kept apart from every other visitor's session. **Separation is not secrecy from the operator:** what a visitor types is sent to, and stored on, the server that runs the demo (as plain files), so the people who operate the server can read every session, and anyone who obtains a browser's session cookie can act as that session. The demo therefore asks for fictional data only and says so in the page. The product itself (rules, evidence, approval gates, stale-approval behaviour, the m17 look) is unchanged: every visitor runs the real application. The authenticated local workspace is unchanged.

## Run it

```
BRANDPROOF_JUDGE_DEMO=1  BRANDPROOF_JUDGE_ROOT=<a new or empty folder>  npm start
```

PowerShell: `$env:BRANDPROOF_JUDGE_DEMO='1'; $env:BRANDPROOF_JUDGE_ROOT="$env:TEMP\bp-judge-demo"; npm start`. It works with either start style in [deployment.md](deployment.md): the local default (loopback, port 4173 with retry) or `BRANDPROOF_DEPLOY=1` (every interface, exactly the assigned `PORT`, `BRANDPROOF_ALLOWED_HOSTS` for the public host name). For an `https://` address also set `BRANDPROOF_JUDGE_SECURE_COOKIE=1`.

| Setting | Default | Meaning |
|---|---|---|
| `BRANDPROOF_JUDGE_ROOT` | required | The dedicated folder that holds every session. See "The demo root". |
| `BRANDPROOF_JUDGE_MAX_SESSIONS` | 100 (1 to 5000) | Sessions that may exist at once. |
| `BRANDPROOF_JUDGE_MAX_LIVE` | 12 (1 to 200) | Sessions held open in memory at once. |
| `BRANDPROOF_JUDGE_IDLE_MINUTES` | 120 (1 to 1440) | Minutes without activity before a session expires. |
| `BRANDPROOF_JUDGE_MAX_HOURS` | 12 (1 to 168) | Hours after which a session expires however active it is. |
| `BRANDPROOF_JUDGE_NEW_PER_MINUTE` | 20 (1 to 1000) | New sessions that may start per minute. |
| `BRANDPROOF_JUDGE_SESSION_KIB` | 5120 (64 to 524288) | Storage per session (workspace file plus images). |
| `BRANDPROOF_JUDGE_IMAGE_KIB` / `_IMAGE_COUNT` | 3072 / 6 | Image storage and count per session. |
| `BRANDPROOF_JUDGE_MAX_CONNECTIONS` | 200 | Simultaneous connections. |
| `BRANDPROOF_JUDGE_SECURE_COOKIE` | off | Adds `Secure` and the `__Host-` cookie prefix (use behind https). Needs `BRANDPROOF_ALLOWED_HOSTS` to name the public host, or the start fails. |
| `BRANDPROOF_JUDGE_EPHEMERAL` | off | Declares the demo root is on temporary storage (a free hosting tier); the page then says sessions are lost when the service restarts or sleeps. |

Every limit is a whole number inside its range; anything else fails the start with the setting's name. The demo **refuses to start** with `BRANDPROOF_DATA` set (so no real workspace file is in play), with authenticated mode, or with a judge setting but no `BRANDPROOF_JUDGE_DEMO=1`.

## What a visitor sees

- **A top strip** (the demo tape): "Demo session. Your own demo session: fictional data only, nothing confidential. Roles are a simulation, not sign-in. Ends about HH:MM if left idle", with **How to try it**, **Reset my demo** and **About & limits**.
- **A compact three-step guide** above the work (hide-able, and the choice is remembered in the browser): **Add content** ("New submission" or the sample), **Read the findings** (the claim, the approved fact, its source), **Record a decision** (request review, then act as Reviewer), plus the line "Fictional data only: do not enter confidential information". The three steps are always visible, one short line each, so the way through is obvious even on a phone (the guide was 120% of a 390 px screen and 178% of a 320 px one; it is now under two thirds of either). The fuller explanations, including the storage and simulation notes, are in a native "More detail" disclosure (keyboard operable, readable by screen readers) that starts open on a wide screen and closed on a phone; nothing was removed.
- **The role picker** keeps its "demo role" tag and the guide says it is a simulation of different people, not sign-in.
- **When a session ends** (idle, absolute limit, or the server lost it) the page says so in plain words and offers "Start a new demo session"; it never silently shows an empty workspace. A fresh session started after one ended says so in the strip.
- **When the demo is full or busy** a visitor with no session gets a plain page saying so and when to retry, not a hang.
- **Reset my demo** (asks first) clears only the caller's session back to the original fictional data. It does not extend the session's lifetime.

## Architecture, and what it costs

**Chosen: one process, one listener, one real app instance per active visitor.** `src/judge.js` is the only code that listens on a socket. A visitor is identified by a server-chosen cookie of 256 random bits; its value is hashed and the hash names the visitor's folder inside the demo root. The visitor's requests are handed to *that visitor's own* `createApp` instance, which works on that visitor's workspace file and never listens. The workspace is chosen from the cookie **only**: nothing in a URL, query, header or body can select another visitor's data, so there is no identifier to tamper with.

| Alternative | Why not |
|---|---|
| One shared workspace with per-visitor filtering | Every route and rule would need to be rewritten to filter; one missed filter leaks data. It would also change the product. |
| One listener or process per visitor | Resource growth (ports, memory, processes) with no ceiling; harder to bound and to host. |
| Sessions in a database or provider service | Out of scope (no accounts, providers or services); the single-writer JSON store already exists. |

Costs of the chosen design: each open session holds its workspace in memory (bounded by the open-session cap, with transparent close and reopen); there is one process, so one failure domain; per-request latency includes a lookup and, after an eviction, a file open.

## What is and is not guaranteed

**Verified by tests** (see "Checks"): two cookie jars cannot read or write each other's submissions, comments, decisions, images, image text or counts; a cookie of unknown, tampered, malformed, duplicated or expired shape never selects a session; the page, not the API, is the only thing that starts a session, and it never adopts a client-supplied value; an id or session value placed in a header, query, path, body or another cookie changes nothing; the approval gate, evidence checks and stale-approval behaviour work inside a session; the host and origin protections are unchanged.

**Not guaranteed:**
- **The cookie is a bearer credential.** Whoever holds a session's cookie *is* that visitor (as with any session cookie). It is `HttpOnly`, `SameSite=Strict`, and `Secure` with the `__Host-` prefix when configured, but a stolen cookie, a shared browser profile or a malicious browser extension is out of scope. It holds no personal information.
- Visitors share one process, one CPU and the optional reading/matching queues (their own queue limits bound the total work). There is **no per-address rate limit** (behind a proxy the real address is not trusted); the limits are global.
- Anyone with access to the server's disk or the demo root can read every session: the files are plain JSON. This is a fictional demo, not confidential storage.
- A browser that blocks cookies cannot keep a session; the page says the session ended and why that may be.

## Lifetime, expiry and restart

| Situation | What happens |
|---|---|
| Reload in the same browser | Same session and data. The cookie lifetime slides with activity. |
| Idle for `IDLE_MINUTES` | Expires. The old cookie never works again and the folder is removed. |
| Active for `MAX_HOURS` | Expires at that age whatever the activity; the cookie never outlives it. |
| Tab open when the session ends | The next request shows "This demo session has ended" with a way back. |
| Reopening the page after expiry, a tampered or unknown cookie | A **new** session is made (never the offered value); the strip says the earlier one had ended. |
| Server restart or stop | Sessions are found again from the demo root and keep working until they expire; sessions that expired while it was stopped are removed on start. If the root is lost (an ephemeral disk), cookies are unknown and visitors get fresh sessions, with the notice. |
| A hard stop (no graceful shutdown) | A runtime lock marker is left in the affected session folders. A stale marker inside the demo root is cleared when the session reopens (everything there belongs to this process). The demo root's own owner marker is handled as in [deployment.md](deployment.md): automatic on the same computer; a replacement container with a different computer name needs the manual step in that document (the path is in the error). Not tested on a container runtime. |
| A bookmarked deep link (for example `#/workspace/SUB-4`) after a new session was made | The new session does not have that submission: the page says so and offers an "Open the workspace" button back to the seeded campaign (m22). |
| Reset my demo | That session returns to the fictional seed. Others are untouched. |

## Bounds, and what a visitor sees at each

| Bound | At the limit |
|---|---|
| Sessions that may exist (`MAX_SESSIONS`) | A new visitor gets the "demo is full" page (503, `Retry-After`) and no cookie; existing visitors are unaffected. A slot is reused once a session expires. |
| New sessions per minute | The "demo is busy" page (429). |
| Sessions open at once (`MAX_LIVE`) | The least recently used idle one is closed and reopens from its file on its next request; if every open session is mid-request, a request waits briefly, then gets a 503 `demo_busy`. |
| Storage per session (`SESSION_KIB`) | Writes are refused with 413 `session_full` and a message pointing to Reset; reads keep working. |
| Images per session | The app's own quota message (count and bytes). |
| Request size | The app's existing limits (512 KB JSON, 2 MB image). |
| Connections, header time and request time | `MAX_CONNECTIONS`; 15 s for headers, 60 s per request. |

The worst case on disk is about `MAX_SESSIONS` times `SESSION_KIB` (500 MB with the defaults); lower them for a small disk.

## Limits hold under simultaneous requests (m20b)

A limit that is checked and only later counted can be passed by many requests at once; the m20 review reproduced 12 sessions admitted under a cap of 1. Now:
- **Starting a session** claims its slot in one synchronous step: the start-rate check, the session-cap check and the claim itself have no `await` between them, and a claim counts against both limits immediately. Simultaneous starts therefore admit exactly the cap (or exactly `NEW_PER_MINUTE`). If a claim fails (a disk error, or an id that collides with an existing folder, which can never overwrite it), it is rolled back completely: it uses up neither a slot nor a place in the rate. When the cap is reached, expired sessions are swept and the claim is tried again as one step.
- **Writes to one session take turns** (reads never wait), so each write's storage check sees the result of the previous write. At most **one** write can land beyond the cap, however many arrive together; the rest get 413 `session_full`. At most 16 writes may be waiting per session; more get 429 `session_busy`. A write's turn ends when its response has been sent, that is, after it has been saved.
- **Sessions open at once** was already atomic (the check and the count have no `await` between them); the image count is enforced inside the workspace's own atomic update. Both are covered by simultaneous tests.
- Not changed: the global limits are still global (no per-address limit).

## Health check (m21)

`GET /healthz` (and `HEAD`) answers `{"status":"ok"}` from a constant, **before** any session, host or rate logic: it allocates no session, takes no admission slot, counts toward no rate, needs no cookie, answers whatever `Host` a platform's checker sends, and reveals no path, token, session or count. Other methods get 405; look-alike paths are ordinary unknown paths. Covered by `tests/judge-health.test.js`.

## The demo root

All state lives under one folder, `BRANDPROOF_JUDGE_ROOT`:

```
.brandproof-judge-root          marker: this folder belongs to the judge demo
root-owner.lock                 one process per root (runtime marker)
sessions/<sha256 of the cookie>/session.json     our marker: created, last seen
sessions/<sha256>/workspace.json  (+ .assets/<sha>.png, .lock)   the visitor's workspace
```

- A **new or empty** folder is adopted and marked. A folder that already holds anything else, without our marker, is **refused untouched** (nothing is read, changed or deleted), so real data cannot be adopted or swept by accident. A symlink or a file is refused.
- It only ever creates and deletes inside this root. A folder is removed only if its name is 64 hex characters, it is a real directory (not a link) and it carries our own session marker. Half-created or unknown entries are left alone.
- The cookie value is never written to disk. It is safe to delete the whole root when the demo is stopped.

## Optional model and OCR

The demo shares one text-matching service and one image-text reader across all visitors, if they are installed; they are optional and absent from a fresh extraction. Without them `/api/meta` says each is `unavailable` and why, the page says so, and the core path (add copy, rule checks against approved facts, explained findings, human decision, stale approval) works unchanged. The browser proof and the tests run with both switched off.

## Not done in this milestone

No hosting provider setup or public address; no HTTPS termination (a proxy must do it); no per-address rate limiting, administration page or metrics; no cleanup of half-created folders; no stale-lock recovery for a replacement container's root marker; no isolation between visitors at the operating-system level.

## Checks

```
node --test tests/judge.test.js tests/judge-startup.test.js tests/judge-entry.test.js tests/judge-concurrency.test.js   # 38 tests, fictional data in temp folders
node scripts/browser/ui-smoke-judge.mjs                                                 # two independent browsers, desktop and narrow; needs Edge or Chrome
```
`judge.test.js` (19): the demo root rules; the cookie; cross-visitor read/write/image isolation (two cookie jars) and every tamper channel; unknown, tampered, malformed and expired sessions; capacity, rate, storage, image and open-session bounds; one listener only and shared services not stopped; reload, restart and stale-lock recovery; reset; the core approve and stale path; fallback without the optional features; host and origin protections. `judge-startup.test.js` (6): every setting and refusal. `judge-concurrency.test.js` (9): the limits under simultaneous requests (see above), including rollback of a failed start and simultaneous writes against the storage cap. `judge-entry.test.js` (4): the real `node server.js`, isolation over real HTTP, a restart after a hard stop, refusals before anything is opened, the deployment style with the Secure cookie. `ui-smoke-judge.mjs` (33 checks): see [verification.md](verification.md) §4a11. Every wait in these tests is bounded.
