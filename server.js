import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { createJudgeDemo } from './src/judge.js';
import { onTermination } from './src/lock.js';
import { startServer } from './src/startup.js';

const root = path.dirname(fileURLToPath(import.meta.url));

// Local start (the default): 127.0.0.1, PORT or 4173, the next 19 ports if one is busy.
// BRANDPROOF_MODE=authenticated starts the separate authenticated workspace: real sign-in, no demo role switch.
//   It uses its own files (never the demo data file). Create the first owner with `npm run auth:setup` BEFORE starting.
// BRANDPROOF_DEPLOY=1 is the opt-in deployment start: the configured BRANDPROOF_HOST (default 0.0.0.0), EXACTLY the assigned PORT
//   (no fallback; a busy port is a clear failure), a required BRANDPROOF_DATA, BRANDPROOF_ALLOWED_HOSTS for the public host name.
// BRANDPROOF_JUDGE_DEMO=1 (with BRANDPROOF_JUDGE_ROOT) serves the isolated fictional judge demo: every visitor's browser gets its own private
//   workspace, no sign-in; see src/judge.js and docs/judge-demo.md. It works with either start-up style above.
// All settings and their rules are in src/startup.js, docs/deployment.md and docs/judge-demo.md.
let started;
try {
  started = await startServer({ env: process.env, root, createApp, createJudgeDemo, log: (line) => console.log(line) });
} catch (e) {
  console.error(e.name === 'StartupError' ? e.message : `Could not start: ${e.message}`);
  process.exit(1);
}
// Ctrl+C or a termination request: finish pending saves and release ownership of the data file(s) before exiting.
onTermination(() => started.app.close());
