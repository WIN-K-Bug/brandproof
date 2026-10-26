# Render free-tier candidate for the judge demo (m21)

**Status, plainly.** This is a *candidate*: a configuration and a clean source package, tested locally. **Nothing has been deployed.** No Render account, repository, remote, upload, submission or payment method has been created or used, and none is needed for the preparation. It has **not** been run on Render, on Linux, in a container or behind real TLS, so no cloud result is claimed. Each of those is an acceptance gate (below).

## What it deploys

The isolated fictional judge demo from [judge-demo.md](judge-demo.md): a judge opens the public address with **no sign-in** and gets their own separate fictional session of the real BrandProof (add content, rule checks against approved facts, explained findings, a human decision). The "Acting as" switch is a simulation. **It is a temporary demo, not storage:** on Render's free tier the files are lost whenever the service sleeps, restarts or redeploys, so every session is lost then. The page says so (`BRANDPROOF_JUDGE_EPHEMERAL=1`).

## What Render's documentation says (reviewed 26 Oct 2026, by the task that prepared this; not re-verified by me)

- [Free instances](https://render.com/docs/free): a free web service sleeps after 15 idle minutes and takes about a minute to start again; local files are lost on sleep, restart or redeploy; there is no free persistent disk; included usage limits apply.
- [Web services](https://render.com/docs/web-services): bind `0.0.0.0` to the `PORT` Render assigns; the service gets a public `onrender.com` host name and Render terminates TLS.
- [Node version](https://render.com/docs/node-version): pin the Node version explicitly; Render's default differs from the version this code was tested on (22.19.0).

## Exact settings (`render.yaml` carries all of these)

| Setting | Value | Why |
|---|---|---|
| Service type, runtime, plan | Web Service, Node, **Free** | no paid plan, disk or payment method is used |
| Auto-deploy | **Off** | a deploy happens only when a person triggers it |
| Build command | `node --version && echo "BrandProof core profile: nothing to install"` | the core profile has no runtime dependencies: nothing to install or download; the log shows the pinned version |
| Start command | `npm start` (runs `node server.js`) | |
| Health check path | `/healthz` | constant `{"status":"ok"}`; allocates no session, needs no cookie, any Host, reveals nothing |
| `NODE_VERSION` | `22.19.0` | the tested version (also `.node-version` and `package.json` `engines`: `>=22.19.0 <23`) |
| `BRANDPROOF_DEPLOY` | `1` | deployment start-up: `0.0.0.0` on exactly Render's `PORT`; a taken port is a clear failure |
| `BRANDPROOF_JUDGE_DEMO` | `1` | the isolated judge demo |
| `BRANDPROOF_JUDGE_ROOT` | `/tmp/brandproof-judge-demo` | a dedicated, disposable folder on temporary storage; the demo refuses any folder holding something else |
| `BRANDPROOF_JUDGE_EPHEMERAL` | `1` | the page tells visitors sessions are lost when the service sleeps or restarts |
| `BRANDPROOF_JUDGE_SECURE_COOKIE` | `1` | `Secure` + `__Host-` session cookie (the public address is https) |
| `BRANDPROOF_ALLOWED_HOSTS` | **your exact `onrender.com` host name**, no scheme, port or wildcard | entered by hand (`sync: false`); the server refuses to start with the Secure cookie and no host name |
| `BRANDPROOF_SEMANTIC` | `off` | no model (it would need a download and memory) |
| `BRANDPROOF_JUDGE_MAX_SESSIONS` / `_MAX_LIVE` | `30` / `5` | sessions that exist / open in memory (free instance: 512 MB) |
| `BRANDPROOF_JUDGE_IDLE_MINUTES` / `_MAX_HOURS` | `60` / `6` | session lifetimes (the service itself sleeps after 15 idle minutes) |
| `BRANDPROOF_JUDGE_NEW_PER_MINUTE` | `10` | rate of new sessions |
| `BRANDPROOF_JUDGE_SESSION_KIB` / `_IMAGE_KIB` / `_IMAGE_COUNT` | `2048` / `1024` / `3` | storage per session; worst case about 60 MB of temporary disk |
| `BRANDPROOF_JUDGE_MAX_CONNECTIONS` | `100` | simultaneous connections |

Do **not** set `PORT` (Render sets it), `BRANDPROOF_HOST` (the deployment default is every interface), `BRANDPROOF_DATA`, `BRANDPROOF_MODE`, or any account or credential variable. The demo refuses `BRANDPROOF_DATA` and authenticated mode. No real workspace or showcase data is in the package or used.

## Steps (a person performs these; each marked gate needs the user's authorization)

1. **[Gate] Choose a licence and decide what is public** (see "Gates"). Build the package: `node scripts/package-public.mjs`. It writes `dist/public-candidate-m22/brandproof/` (the folder), `dist/brandproof-public-candidate-m22.zip` and a per-file hash inventory, and fails if anything it should not publish is found.
2. **[Gate] Create a public repository** under the owner's account and put the **contents of that folder** at its root (the zip has the same layout). Compare the files with `INVENTORY.sha256.txt`. Nothing here initialises a repository or touches a remote.
3. **[Gate] Create the Render service** from that repository (Blueprint from `render.yaml`, or a Web Service with the settings above). Render needs an account; the free plan needs no payment method on the documented terms, which Render may change. Keep auto-deploy off.
4. **Enter `BRANDPROOF_ALLOWED_HOSTS`.** The host name exists only once the service does. Create it with your best guess (`brandproof-judge-demo.onrender.com`), read the real host name Render shows, and if it differs (Render adds a suffix when a name is taken) correct the variable and trigger a Manual Deploy. Until it is right, `/healthz` answers but every page gets a refusal naming the host rule.
5. **Run the acceptance checklist** (below) from a clean private browser window.

## What a visitor sees when the free service sleeps or restarts

- A visitor who arrives while it is asleep waits about a minute for the platform to wake it (Render's behaviour, not ours).
- All sessions are gone after any sleep, restart or redeploy, because the folder lived on temporary storage. A tab that was open shows **"This demo session has ended"** with a **Start a new demo session** button; reloading the page starts a new session with fresh fictional data and says the earlier one had ended. The About text and the "More detail" note say the demo is temporary and loses sessions on restart or sleep.
- Nothing is recoverable by us: there is no backup, by design.

## Optional-feature profile: **core**

The first acceptance path needs **no OCR, model, download or paid API.** `BRANDPROOF_SEMANTIC=off` switches matching off; the OCR package is simply not installed (`optionalDependencies` are not installed because the build installs nothing). `/api/meta` and the page then report each as **unavailable, with the reason**; the core path (add copy, rule checks, explained findings, human decision, stale approval) does not use them. Text printed in an image is covered only by a transcription a person types and confirms.

*If you later want OCR* (not part of this candidate): the build would be `npm ci --omit=dev` (npm fetches `tesseract.js` 7.0.0 and its WASM core) plus `npm run fetch-ocr` (a pinned English language file of about 4 MB, checked by SHA-256), both needing network at *build* time; the app never downloads anything while serving. The footprint on Render's free instance was **not measured**, so it is not recommended for the first acceptance. The text-matching model is heavier (a model download and more memory than a free instance is likely to give) and is not recommended.

## Verified locally, and what that does not cover

Verified from a clean extraction of the candidate package (details and logs are in the development handoff `m21-deployment-candidate.md`, which is not part of the public package): the exact `render.yaml` environment starts the real server; the health check allocates no session; two visitors are isolated and the core review path works through the https-style `Host` and `Origin` a TLS proxy would send; foreign hosts, cross-site origins and look-alike host names are refused; the cookie is `Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-`; restart on the same folder keeps sessions and restart on a new empty folder ends them clearly; start-up refuses the Secure cookie without a host name. The package scan found no e-mail, key, token, local path, data file, lock, cache or installed package.

**Not verified (next acceptance gates):** `render.yaml` against Render's own parser; that Render accepts this build and start command; that `/tmp` is writable on a free instance; what `Host` header Render's health check and public proxy send; Render's npm version and Node 22.19.0 availability; cold-start behaviour and timing; memory on 512 MB; Linux and containers (all tests ran on Windows 11 with Node 22.19.0); real TLS; the public acceptance run from a clean browser (below).

## Public acceptance checklist (to run after a deployment is authorized)

From a clean private browser window, with no sign-in: open the public https address; add campaign content; see findings checked against approved facts; open an issue explanation; record a human decision as the simulated Reviewer; edit afterwards and see "re-review required"; reload and confirm the state persists; open a second private window and confirm it shows none of the first one's work; confirm the strip, About and guide say fictional data and temporary storage; check a 390 px layout; confirm every URL is https; wait for the 15-minute sleep and confirm the "session ended" recovery; open the public repository without signing in. Record the actual results; do not record any of them as passed before they are run.

## Gates (what still needs the user)

- Authorize a **public repository** and its owner/visibility, and a **Render account** and service creation.
- Choose a **licence**: none has been chosen for BrandProof's own code (the README says so).
- Decide whether the **participants' names** may be public: they appear in `README.md`, `docs/contributions.md` and `docs/round-1-plan.md` (no e-mail addresses or other personal details are in the package).
- Confirm the exact **public host name** (step 4) and that the free tier's terms and limits are acceptable.
- Run the Render and public acceptance checks above and report the real results.
