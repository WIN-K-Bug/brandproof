// Minimal Chrome DevTools Protocol driver for the UI smoke test (no dependencies).
// Drives a headless Edge or Chrome that is already installed. Set BRANDPROOF_BROWSER to a browser executable to override.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.BRANDPROOF_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findBrowser() {
  return CANDIDATES.find((p) => existsSync(p));
}

export async function launch(url, { width = 1360, height = 900, port = 9333 } = {}) {
  const edge = findBrowser();
  if (!edge) throw new Error('No Edge/Chrome found. Set BRANDPROOF_BROWSER to a browser executable.');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'bp-edge-'));
  const proc = spawn(edge, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.find((t) => t.type === 'page')) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const consoleMsgs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === 'Runtime.consoleAPICalled') consoleMsgs.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    else if (d.method === 'Runtime.exceptionThrown') consoleMsgs.push('EXCEPTION ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    else if (d.method === 'Log.entryAdded') consoleMsgs.push(`LOG ${d.params.entry.level}: ${d.params.entry.text} ${d.params.entry.url ?? ''}`);
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  const api = {
    consoleMsgs,
    async goto(u) {
      await send('Page.navigate', { url: u });
      await new Promise((r) => setTimeout(r, 1200));
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails));
      return r.result.result.value;
    },
    async wait(ms = 600) {
      await new Promise((r) => setTimeout(r, ms));
    },
    async click(selectorOrText) {
      const ok = await api.eval(`(()=>{const q=${JSON.stringify(selectorOrText)};let el=null;try{el=document.querySelector(q)}catch{};if(!el){el=[...document.querySelectorAll('button,a,[role=tab],summary')].find(e=>e.textContent.trim()===q||e.textContent.trim().startsWith(q))}if(!el)return false;el.click();return true})()`);
      if (!ok) throw new Error('click target not found: ' + selectorOrText);
      await api.wait();
    },
    async type(selector, value) {
      await api.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`);
      await api.wait(500);
    },
    async select(selector, value) {
      await api.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}))})()`);
      await api.wait(900);
    },
    /** Real keyboard events (the same path a keyboard-only user takes). */
    async key(name, { shift = false } = {}) {
      const map = {
        Tab: [9, 'Tab', ''],
        Enter: [13, 'Enter', '\r'],
        Escape: [27, 'Escape', ''],
        ' ': [32, 'Space', ' '],
        ArrowDown: [40, 'ArrowDown', ''],
        ArrowUp: [38, 'ArrowUp', ''],
        ArrowRight: [39, 'ArrowRight', ''],
        ArrowLeft: [37, 'ArrowLeft', ''],
        Home: [36, 'Home', ''],
        End: [35, 'End', ''],
      };
      const [vk, code, text] = map[name];
      const modifiers = shift ? 8 : 0;
      const r1 = await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, text });
      if (r1.error) throw new Error('key down: ' + JSON.stringify(r1.error));
      const r2 = await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
      if (r2.error) throw new Error('key up: ' + JSON.stringify(r2.error));
      await api.wait(140);
    },
    /** What currently has keyboard focus. */
    async active() {
      return api.eval(`(() => { const e = document.activeElement; if (!e) return null; const dlg = e.closest('dialog'); return { tag: e.tagName.toLowerCase(), id: e.id || '', role: e.getAttribute('role') || '', text: (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().slice(0, 60), inDialog: Boolean(dlg), type: e.type || '' }; })()`);
    },
    /** Press Tab until the focused element satisfies `predicate` (a function source taking the element). Returns the number of presses, or -1. */
    async tabTo(predicate, { max = 90, shift = false } = {}) {
      for (let i = 0; i <= max; i++) {
        const hit = await api.eval(`(${predicate})(document.activeElement)`);
        if (hit) return i;
        await api.key('Tab', { shift });
      }
      return -1;
    },
    /** Choose files in an <input type=file> through the DevTools protocol (no native dialog is opened). */
    async setFiles(selector, files) {
      await send('DOM.enable');
      const doc = await send('DOM.getDocument', { depth: 0 });
      const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
      if (!q.result.nodeId) throw new Error('file input not found: ' + selector);
      await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files });
      await api.wait(900);
    },
    /** Let the browser save downloads into `dir` (headless browsers otherwise drop them). */
    async downloads(dir) {
      const r = await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
      if (r.error) {
        const r2 = await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
        if (r2.error) throw new Error('cannot enable downloads: ' + JSON.stringify(r2.error));
      }
    },
    /** Emulate a CSS media type ('print' or 'screen'). */
    async media(type) {
      await send('Emulation.setEmulatedMedia', { media: type });
      await api.wait(300);
    },
    /** Emulate media features such as [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-contrast', value: 'more' }]. */
    async features(list) {
      await send('Emulation.setEmulatedMedia', { features: list });
      await api.wait(300);
    },
    async viewport(width, height, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await api.wait(400);
    },
    async shot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    },
    async close() {
      try {
        await send('Browser.close');
      } catch {}
      ws.close();
      proc.kill();
    },
  };
  await api.goto(url);
  return api;
}
