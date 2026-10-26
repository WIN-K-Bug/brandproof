# Authenticated workspace mode

BrandProof has two **separate** modes.

| | Demo mode (default) | Authenticated workspace (opt-in) |
|---|---|---|
| Start | `npm start` | `BRANDPROOF_MODE=authenticated npm start` |
| Who you are | A role picked in the browser (`X-Demo-Role`). **Not security.** | A named account. Identity and role come only from a server-side session. |
| Data files | `data/brandproof.json` (seeded fictional campaigns) | `data/auth-workspace.json` (guidelines only, no sample people) and `data/auth/users.json` (credentials) |
| Actors in history | "Demo Creator" etc. | Stable account IDs (`U-1`) plus the name at the time |
| Self-approval | Not preventable (no identity) | Blocked: anyone who wrote or edited a submission cannot approve it |

A local authenticated mode **does not** mean production readiness: there is no HTTPS, no encryption at rest, no multi-tenancy and no confidentiality guarantee. See [Limits](#limits).

## Owner setup (when a human is ready)

There are **no default accounts or passwords**. With the server stopped:

```
npm run auth:setup            # (refused while a server or another setup has the credential file open) create the owner: username, display name, password typed with echo off
npm run auth:setup -- add-user
npm run auth:setup -- list
npm run auth:setup -- reset U-2
BRANDPROOF_MODE=authenticated npm start
```

Passwords are never accepted as command-line arguments or environment variables, are never printed, and are stored only as scrypt hashes. The owner can then add people (and reset passwords) in the browser under **People**; owners themselves can only be created with the setup command, never over HTTP. The setup command needs an interactive terminal and was not run during development; tests use synthetic accounts in temporary directories.

A single-person workspace cannot approve anything (approval needs a different person from everyone who edited). Add at least a second account.

## Bounded threat model

**Defended** (and tested):

- A person at the keyboard or on the same machine guessing passwords → scrypt, per-account lockout, generic errors.
- A client that lies about its role (`X-Demo-Role`, or fields such as `author` / `actor` in request bodies) → never read in this mode; identity is the session.
- A malicious web page in the same browser forging requests (CSRF, login CSRF) → `SameSite=Strict` cookie, mandatory matching `Origin`, per-session CSRF token header, JSON-only bodies.
- Script injection reading the session → `HttpOnly` cookie, strict CSP, DOM built with text nodes only.
- Theft of the credential file → scrypt hashes (OWASP-minimum cost); session secrets are never stored on disk at all.
- A stale or stolen session → idle (30 min) and absolute (8 h) expiry enforced on the server, server-side revocation on logout, password change, disable and reset.
- A creator, or an editor, approving their own work.
- Reviewer decisions made on an out-of-date view (unchanged: 409 `stale_view`).
- DNS rebinding / foreign Host header (unchanged).
- **Not exposed beyond this computer (m19).** Authenticated mode refuses to start with the opt-in deployment settings, on any address other than loopback, or with extra host names (`BRANDPROOF_DEPLOY`, `BRANDPROOF_HOST`, `BRANDPROOF_ALLOWED_HOSTS`), and `createApp` refuses a host list in this mode. Cookies, HTTPS and origin behaviour for a public workspace have not been reviewed. See [deployment.md](deployment.md).

**Not defended (out of scope):** a compromised or shared computer account, malware, an attacker who can read the server process memory or the whole disk (the workspace file is plain JSON), network eavesdropping (plain HTTP on 127.0.0.1 only), multi-tenant isolation, MFA, phishing, insider abuse by the owner (an owner can reset any password; this is audited).

## Decisions and the guidance behind them

| Decision | Reason / source |
|---|---|
| **scrypt** via Node `crypto.scrypt`, N=2^17, r=8, p=1, 16-byte random salt per password, 32-byte key, `maxmem` raised to fit | OWASP Password Storage Cheat Sheet lists scrypt N=2^17, r=8, p=1 as the minimum configuration when Argon2id is unavailable. Node's built-in; no third-party crypto. Node's default `maxmem` (32 MiB) is too small for that cost, so it is raised. |
| Constant-time comparison (`timingSafeEqual`), NFKC-normalised passwords, cost parameters stored in each hash and bounds-checked on read | Node `crypto` docs; NIST SP 800-63B normalisation; a tampered file cannot demand absurd memory. |
| A dummy scrypt computation for unknown or disabled users; one generic message for every failure | OWASP Authentication Cheat Sheet: same message, status and timing so accounts cannot be enumerated. |
| Passwords: **15 to 128 characters**, any characters (spaces and Unicode allowed), no composition rules, refused if common or containing the username/name | OWASP Authentication Cheat Sheet / NIST SP 800-63B (15 when there is no second factor; no truncation; no composition rules). The common-password list is a small built-in list; **no breach-database lookup** (that would send data to a third party). |
| **Opaque sessions**: 128-bit session id + 256-bit secret from `crypto.randomBytes`; the server keeps only SHA-256 of the secret and compares in constant time | OWASP Session Management Cheat Sheet (≥ 64 bits entropy, CSPRNG; store a hash of the verifier; split lookup id and verifier). |
| New session id on every sign-in, and after a password change; old ids destroyed | OWASP: regenerate after login and after privilege/credential changes (session fixation). A planted cookie is not adopted (tested). |
| Idle timeout 30 min, absolute 8 h, enforced server-side | OWASP: 15 to 30 min idle for low-risk apps; 4 to 8 h absolute for office use. |
| Sessions are **memory-only**; a restart signs everyone out | Nothing session-like is ever written to disk, backups or packages. Trade-off: restarts are visible to users. |
| Cookie `bp_session`: `HttpOnly; SameSite=Strict; Path=/`, no `Domain`, session cookie (no `Max-Age`). With `secureCookies` (HTTPS): `__Host-` prefix and `Secure` | OWASP Session Management. The `__Host-` prefix requires `Secure`, which a plain-HTTP localhost deployment cannot use portably, so it is switched on only when HTTPS is used. |
| **CSRF**: synchronizer token (random per session, sent in `X-CSRF-Token`, constant-time compare) **and** exact `Origin` match on every unsafe request (missing or `null` Origin is rejected) **and** `SameSite=Strict` **and** JSON-only bodies (custom content type forces a preflight) | OWASP CSRF Prevention Cheat Sheet: tokens for stateful apps, Origin verification, SameSite as defence in depth, custom headers, login CSRF. Missing/`null` Origin is not accepted as evidence of same-origin. |
| **Rate limiting**: 5 failures per account name per 15 min → 15 min lockout, doubling on repeat up to 2 h; 30 failures per address → lockout; success clears the account counter; applies to names that do not exist, so it reveals nothing | OWASP Authentication Cheat Sheet: count per account rather than only per address; exponential lockout. Known trade-off: a lockout can be used to deny a person sign-in; the owner can reset via the CLI, and lockouts are short. |
| At most 2 concurrent scrypt jobs, bounded queue | Each hash can use ~128 MiB; prevents memory exhaustion by parallel sign-ins. |
| **No sensitive payload logging**: the server logs nothing per request; the audit trail records event, account id, source address and time only | OWASP Authentication/Logging guidance: log authentication events, never credentials or tokens. Tested by capturing console output and scanning stored files. |
| Authorise **before** validating (e.g. publishing guidelines) | A caller without the right learns nothing about payload validation. |
| Role read from the **current** account record on every request; disabling an account ends its sessions at once | Role or status changes take effect immediately, never from a cached session. |
| Authenticated mode **requires** a session even for reads, including `/api/check` and `/api/semantic/*` | All workspace content is behind sign-in; only the static shell and a minimal `/api/meta` (mode and whether setup is needed) are public. |

## Credential generations and concurrency

An independent review found two real races and a resource-bounding gap in the first version of this mode (items 1 to 4 below, with the stale password change found while fixing the first); all are fixed and have regression tests that were shown to fail when the fix is removed.

1. **Password reset versus an in-flight sign-in.** Sign-in verified a copy of the account read before an `await`, so a reset could finish during verification and the sign-in then minted a session for the *old* password. **Fix:** every account has a credential generation (`credVersion`) bumped, inside the serialised store mutation, by a password change, a reset, and a disable/enable. Sign-in snapshots the generation and hash before verifying, and at the success boundary re-reads the **current** account and requires the same hash, generation and not-disabled. There is **no await between that check and issuing the session**. Sessions are stamped with the generation and `authenticate()` rejects a session from an older generation, so even a skipped revocation cannot leave an obsolete session usable. If the audit entry for a successful sign-in cannot be written, the session is discarded (fail closed); if a revoke happens while it is being written, the sign-in is refused.
2. **Stale password change.** A password change verified the current password, hashed the new one, then wrote it unconditionally; a reset (or another change) that landed in between would be overwritten. **Fix:** the write is decided against the current record inside the serialised mutation and refused with `409 credential_changed` if the hash or generation moved. Two concurrent changes from the same old password: exactly one wins.
3. **Last-owner invariant.** The check ran before the queued mutation, so two owners could both pass it and disable themselves (or each other). **Fix:** the invariant is enforced against the draft inside the serialised mutation; one request fails with `409 last_owner`.
4. **Bounded hashing.** The dummy hash (used so unknown accounts cost the same as real ones) was created lazily *outside* the 2-job gate, so concurrent first sign-ins could each start an expensive hash. **Fix:** one shared promise, created through the same gate and warmed at start-up; a failed start-up is not cached. Tests count calls and concurrency through a hashing seam (`hasher` option; tests only), so nothing stresses the machine.

Failed disk writes were checked on purpose: a failed reset or disable changes nothing in memory and revokes nothing; a sign-in whose audit entry cannot be written is refused and leaves no session; a refusal stays a refusal; the service recovers when writes work again.

Residual, deliberate limits: the per-account lockout counters and sessions are in memory (a restart clears them); the success audit record is written *after* the session is created, so there is a brief window where the session exists but the entry is not yet on disk (it is discarded if the write fails).

## Accountable review

- Every revision, comment, review request and decision stores `{ id, name, role }` taken from the session (request-body fields such as `author` are ignored, tested).
- **Self-approval rule:** a person cannot approve a submission if they created it or authored any of its revisions. This applies to Manager and Owner too; the role alone does not bypass it. The reasons appear in the eligibility response (`selfReview: true`) and in the UI, and the server enforces it (403).
- Distinct approval is recorded with the approver's account id; the approval stays bound to copy, image details and guideline version, and stale-view and stale-approval behaviour are unchanged (tested in this mode).
- Rejecting is allowed for the author's own work (it cannot approve anything).

## Files, separation and compatibility

- `data/` is git-ignored and excluded from the source package. The package script additionally refuses any file named `users.json`, `*.bak-*` or `auth-workspace*`, and any file containing a real-looking scrypt hash or session cookie.
- Credentials (`data/auth/users.json`) are a **different file** from the workspace (`data/auth-workspace.json`); the server refuses to start if they are the same path. New files are created `0600` on POSIX (Windows ignores POSIX modes: rely on your user profile's permissions).
- **No automatic migration from demo data.** Demo records carry made-up actors; adopting them into an accountable audit trail would be misleading. The modes refuse each other's workspace files (`meta.mode` marker), so a demo file can never be opened, written or silently converted by authenticated mode, and vice versa. To move content, re-enter it under real accounts. The existing demo file format is unchanged and still opens in demo mode.
- **Backups:** when authenticated mode opens an existing workspace or credential file it first writes a timestamped copy (`*.bak-<UTC time>`, newest 3 kept) next to it. Restore by stopping the server and copying a backup over the file.
- **Failure refusal:** a file that is corrupt, of the wrong kind, or of an unknown schema version is refused with a message and left byte-for-byte untouched (tested).

## Limits

- Local sign-in over plain HTTP on `127.0.0.1`. Do not expose the port. HTTPS needs a reverse proxy or TLS support and `secureCookies`, which is not wired to a switch yet.
- Plain-JSON storage: anyone with file access can read workspace content, and can edit it. Hashes of credentials resist offline guessing; the workspace has no encryption.
- No MFA, password-breach screening, e-mail recovery or SSO. Password reset is by the owner or the CLI.
- One role per account; owners are a flag. No fine-grained per-submission permissions.
- Sessions are lost on restart.
- Source addresses in the audit log are always loopback today (the server only listens locally).
- The setup CLI's hidden prompt reads the terminal in raw mode; it was checked by code review and the non-interactive refusal path, not by automated typing.
- Dependencies: the credential code uses only Node built-ins.

## Tests

`tests/auth.test.js` (34 tests) and `tests/auth-concurrency.test.js` (13 tests, deterministic scheduling seam) use synthetic, randomly generated accounts in temporary directories and a reduced scrypt cost (`N=1024`, tests only). It covers: unauthenticated access to every route family, forged role header and body fields, role boundaries, owner-only administration, self-approval (creator, editor, distinct manager/reviewer), actor provenance, stale-view and stale-approval behaviour, idle/absolute expiry, logout revocation, restart persistence with stable ids and backups, disable/enable/reset/change-password session revocation, CSRF/Origin/Host, rate limiting and lockout doubling, no secrets in logs or files, hashing and policy, mode/file refusal, corrupt-file refusal, secure-cookie option, and demo mode unchanged. Controls were also checked by mutation: disabling self-approval, CSRF, role derivation or logout revocation makes `auth.test.js` fail, and re-introducing each of the five concurrency bugs (pre-await user snapshot, unconditional password write, pre-mutation last-owner check, ungated dummy hash, sessions ignoring the generation) makes `auth-concurrency.test.js` fail. An independent probe by the reviewer (read-only script, synthetic accounts) now reports `issueReproduced: false` for both the reset-versus-login and last-owner cases, with one active owner left.

Browser evidence: `npm run ui-smoke-auth` (17 checks, synthetic accounts, throwaway data) and screenshots `docs/evidence/auth-*.png`.
