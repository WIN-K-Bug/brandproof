// m30 DIAGNOSTIC helper: did the "private" flags really give the headless browser a private (off-the-record) window?
// A throwaway plain-http server on 127.0.0.1 sets one persistent cookie; after the browser closes, its profile folder is searched for that cookie's
// NAME (a cookie file on disk means the window was a regular one; a private window keeps its cookies in memory only). Also prints the target's
// browser-context id. Fictional, local, no BrandProof code involved.
//   node scripts/browser/diag-private-engaged.mjs
import http from 'node:http';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { findBrowser, launch } from './cdp.mjs';

const BRAVE = path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/Application/brave.exe');
const PROFILES = {
  'edge-regular': { exe: findBrowser(), args: [] },
  'edge-private': { exe: findBrowser(), args: ['--inprivate'] },
  'brave-regular': { exe: BRAVE, args: [] },
  'brave-private': { exe: BRAVE, args: ['--incognito'] },
};
const NAME = 'm30probe_cookie';
const srv = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `${NAME}=1; Path=/; Max-Age=3000` });
  r.end('<!doctype html><title>probe</title>probe');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;
function files(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) files(p, out);
    else out.push({ p, size: st.size });
  }
  return out;
}
let port = 9490;
for (const [name, p] of Object.entries(PROFILES)) {
  if (!p.exe || !existsSync(p.exe)) {
    console.log(name, 'browser not installed');
    continue;
  }
  const b = await launch(url, { port: port++, exe: p.exe, args: p.args });
  await b.wait(800);
  const targets = (await b.send('Target.getTargets')).result?.targetInfos?.filter((t) => t.type === 'page').map((t) => t.browserContextId ? 'context-id-present' : 'no-context-id');
  const ctxs = (await b.send('Target.getBrowserContexts')).result?.browserContextIds?.length;
  const cookieSeen = await b.eval('document.cookie').catch(() => null);
  const profile = b.profile;
  await b.close();
  await new Promise((r) => setTimeout(r, 1500));
  let onDisk = [];
  try {
    for (const f of files(profile)) {
      if (!/Cookies/i.test(path.basename(f.p)) || /journal$/.test(f.p)) continue;
      onDisk.push({ file: path.relative(profile, f.p), size: f.size, hasName: readFileSync(f.p).includes(Buffer.from(NAME)) });
    }
  } catch (e) {
    onDisk = [{ error: e.message }];
  }
  console.log(name, JSON.stringify({ pageContexts: targets, nonDefaultContexts: ctxs, documentCookieSeen: cookieSeen, cookieFiles: onDisk }));
}
srv.close();
process.exit(0);
