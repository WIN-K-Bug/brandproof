# Deployment start-up (local preparation, m19)

**Status, plainly.** This is a start-up mode that was written and tested *on this computer*. Nothing has been deployed, no hosting provider, account, container image or public address is involved, and it has not been run on any hosting platform or container runtime. It prepares the entry point; it does not publish anything. All data in demo mode is fictional.

`npm start` (`node server.js`) has two start styles. The environment chooses; with nothing set, nothing changes.

| | Local (the default) | Deployment (opt-in, `BRANDPROOF_DEPLOY=1`) |
|---|---|---|
| Listens on | `127.0.0.1` only | `BRANDPROOF_HOST`, default `0.0.0.0` (every IPv4 interface) |
| Port | `PORT` if set, else 4173; if busy, the next free one, up to 20 ports | **exactly** `PORT`, which must be set; if it is unavailable the start fails and exits with code 1. It never tries another port |
| Data file | `BRANDPROOF_DATA`, else `data/brandproof.json` in the project | `BRANDPROOF_DATA` **required**; it never falls back to the project's `data/` folder |
| Host names answered | `localhost` and `127.0.0.1` | those, plus `BRANDPROOF_ALLOWED_HOSTS` |
| Authenticated mode | yes (loopback, plain HTTP) | **refused** (see below) |

## Settings

| Variable | Meaning |
|---|---|
| `PORT` | Local: preferred port (an unusable value means 4173, as before). Deployment: the assigned port, a whole number from 1 to 65535, required. |
| `BRANDPROOF_DEPLOY` | `1`/`true` turns on the deployment start; `0`/`false`/unset is local. Any other value is an error, not a guess. |
| `BRANDPROOF_HOST` | The address to listen on, as an **IP address** (`127.0.0.1`, `127.0.0.2`, `0.0.0.0`, `::`, `::1`). Host *names* are refused, because a name can resolve to different addresses. Works in either style; without it the local default is `127.0.0.1` and the deployment default is `0.0.0.0`. |
| `BRANDPROOF_ALLOWED_HOSTS` | Comma-separated host names (or IPv4 addresses) the server answers to in addition to localhost, for example `judge.example.com`. No scheme, port or path. `*` means any host name and is accepted only with `BRANDPROOF_DEPLOY=1`. |
| `BRANDPROOF_DATA` | The workspace file. See "Files" below. |
| `BRANDPROOF_MODE`, `BRANDPROOF_AUTH_FILE` | Authenticated workspace, local only (see [authentication.md](authentication.md)). |
| `BRANDPROOF_SEMANTIC=off`, `BRANDPROOF_MODEL_DIR`, `BRANDPROOF_OCR_DIR` | Optional features (see "Optional features"). |

Example (a platform that assigns `PORT` and mounts a persistent volume at `/var/data`):

```
BRANDPROOF_DEPLOY=1  PORT=<assigned>  BRANDPROOF_DATA=/var/data/brandproof.json  BRANDPROOF_ALLOWED_HOSTS=<public host name>  npm start
```

PowerShell: `$env:BRANDPROOF_DEPLOY='1'; $env:PORT='8080'; $env:BRANDPROOF_DATA="$env:TEMP\bp-deploy-test.json"; npm start`. For a trial on your own computer use `BRANDPROOF_HOST=127.0.0.1` so nothing is reachable from the network.

A start that cannot work fails **before anything is opened** with a line that begins `Could not start:` and says what to change: no `PORT`, a bad `PORT`, no `BRANDPROOF_DATA`, a host name where an IP address is needed, `*` outside a deployment, or authenticated mode combined with any of the deployment settings. A port that is taken fails with `Could not start server: port N on HOST cannot be used: it is already in use ...`. In both cases the workspace file is released and the exit code is 1.

## Host names and HTTPS

The server refuses any request whose `Host` header is not `localhost`/`127.0.0.1` (a guard against DNS-rebinding), answering 403 `bad_host`. Binding to `0.0.0.0` alone therefore does **not** make it usable from outside: list the public host name in `BRANDPROOF_ALLOWED_HOSTS`. Matching is exact and case-insensitive (`judge.example.com.evil.example` and `xjudge.example.com` do not match). `*` removes that check and is meant only for a server that is public by design and holds only fictional data.

The app serves plain HTTP; **it does not terminate TLS and sets no HSTS header**. For an `https://` address a proxy in front must terminate TLS and pass the original `Host` header through unchanged (a proxy that rewrites it to an internal name gets 403). Writes check that the `Origin` is the same site: for a host name that deployment listed, both `http://HOST` and `https://HOST` count as the same site; for `localhost` only `http://` does. A request with a missing `Origin` is still tolerated in demo mode (scripts), as before. `X-Forwarded-*` headers are not trusted or read.

## Files: what is written, and where

Everything is derived from the one `BRANDPROOF_DATA` path (call it `W`). The folder must exist or be creatable and be writable by the process.

| Path | What | Notes |
|---|---|---|
| `W` | The whole workspace as JSON | Created and seeded with the fictional Fernlight data on first start. Written as `W.<pid>.tmp`, fsynced, then renamed over `W`, so a crash does not leave a half-written file. |
| `W.assets/` | Retained campaign images, `<sha256>.png` | Beside `W`; never shared between workspaces. |
| `W.lock` (and briefly `W.lock.takeover`) | Ownership marker: pid, computer name, start time | Runtime marker, **not user data**. Removing it deletes nothing. |

Put `W` on a **persistent writable volume** if saved state must survive a restart. On a container's own writable layer or a temporary directory the workspace starts again from the seed after every redeploy; that is acceptable only for an explicitly temporary, fictional judge sandbox. Authenticated mode would also keep `.bak-*` copies and a credential file; deployment does not use it. Never copy `data/`, credential files or the `.lock` marker from a real workspace into a deployment.

## One process per workspace

- Only one BrandProof process may own `W`. A second process on the same file is refused at start (`Another BrandProof process (pid N ...) has this workspace file open ...`), checked on the deployment entry point. Several instances on separate disks share **nothing**: each has its own, diverging copy. Run exactly one instance, and do not let a platform start the new version while the old one still holds the volume.
- In demo mode every visitor shares the one workspace and may change or delete anything in it. The role picker is a simulation, not sign-in. This single-workspace mode is not the isolated judge demo; for private per-visitor sessions use `BRANDPROOF_JUDGE_DEMO=1` (see "The judge demo" below).
- Sessions are not an issue in demo mode (there are none). Authenticated sessions are in memory and are not available in deployment.

## Restart behaviour

- A save is on disk **before** the server answers the request that made it (checked: the file contained the new submission when its 201 arrived). A hard stop therefore loses nothing that was acknowledged. The deployment test stops the server without a graceful shutdown, starts a new process on the same file and finds the same approved campaign bound to the same content, image and guideline version.
- On `SIGINT`/`SIGTERM` the server finishes pending saves and removes its lock marker. (On Windows only Ctrl+C in a console can do this; a hard kill cannot.)
- After a hard stop the marker `W.lock` is left behind. A new start takes it over automatically **only** when it names this same computer and a process id that no longer exists. Verified on one computer: a killed process, then a restart, succeeds.
- **Expected, not tested on a container runtime:** a replacement container usually has a different computer name, and the marker of the killed one then looks like another computer's, so the start is **refused** with the exact path of the marker and the manual step: delete only `W.lock` (and `W.lock.takeover`, if present) once you are sure no other BrandProof process uses that volume. A restart that keeps the same computer name and reuses the same process id (for example pid 1) is, by reading the code, treated as "this process already has it" and also refused. Platforms that hard-kill without a graceful-stop signal can therefore need that manual step, or a start script that removes a stale marker. This is a known limit of this milestone, not solved here.
- If the workspace file is corrupt or has an unknown schema the server refuses to start and leaves the file alone.

## Optional features and their fallback

Reading text from images (OCR, [ocr-image-text.md](ocr-image-text.md)) and semantic source matching (local embeddings, README) are optional. Their packages and data (`tesseract.js` and its language data under `.cache/ocr`, or `BRANDPROOF_OCR_DIR`; the embedding package and model under `.cache/models`, or `BRANDPROOF_MODEL_DIR`) are **not part of the source package** and are not present in a fresh extraction. Nothing is downloaded while the server runs; `npm install`, `npm run fetch-ocr` and `npm run fetch-model` are explicit, separate steps. Without them:

- `/api/meta` reports each feature as `unavailable` with a reason (not installed, data missing, or switched off), and the app shows that instead of failing. `BRANDPROOF_SEMANTIC=off` switches semantic matching off explicitly.
- The core path does not depend on either: campaign copy, the rule checks against approved facts and sources, explained findings, comments, review and the human decision all work. Text printed inside an image is then covered only by a transcription a person types and confirms.
- A deployment's acceptance must not depend on a first-use download. The deployment test records each feature's state and requires an unavailable one to give a reason.

## The judge demo (m20)

For visitors who must use the product with no sign-in and without sharing one workspace, `BRANDPROOF_JUDGE_DEMO=1` with `BRANDPROOF_JUDGE_ROOT` serves separate (per-visitor), fictional, expiring sessions from this same entry point and works with either start style above (it replaces `BRANDPROOF_DATA`, which it refuses). See [judge-demo.md](judge-demo.md). The one-process-per-workspace and restart notes on this page apply to its demo root.

## Hosting candidate (m21)

A free-tier Render configuration for the judge demo, with its exact settings, restart-loss disclosure, optional-feature profile and acceptance gates, is in [render-deploy.md](render-deploy.md). It is prepared and tested locally only; nothing is deployed.

## Not done in this milestone

(Written for m19; isolated per-visitor sessions were added in m20 and are described in [judge-demo.md](judge-demo.md).) No hosting provider setup, container image, public address or HTTPS in this single-workspace mode; no change to approval, evidence-versioning or source gates; authenticated mode is not exposed; no stale-lock recovery for replacement containers; nothing was tested through a real proxy (the `https://` Host/Origin behaviour is tested by sending those headers directly).

## Checks

```
node --test tests/startup.test.js tests/deploy-host.test.js tests/deploy-entry.test.js   # 27 tests, isolated fictional data in a temp folder
npm test                                                                                 # the whole unit suite
```
`tests/startup.test.js`: every setting rule and the port policy against real sockets. `tests/deploy-host.test.js`: the Host and Origin guard with and without a host list. `tests/deploy-entry.test.js`: the real `node server.js` as a child process: loopback-only default, preserved port retry, a configured host (`127.0.0.2`), every-interface mode (reachable on the computer's own network address when it has one), the assigned-port conflict, refusals before anything is opened, the core product flow through a TLS-proxy style Host/Origin, a second process refused, and a restart after a hard stop. A child's complete stdout and stderr is attached to the test report. Every wait in those tests is bounded.
