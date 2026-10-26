// Preloaded with `node --require block-network.cjs ...`. Worker threads inherit execArgv, so the worker that runs recognition
// is covered too. Every attempt to open a network connection, resolve a name, or call fetch/http(s) is RECORDED to a file
// (visible across threads) and then REFUSED, so a run that succeeds under it provably made no network request.
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { isMainThread } = require('node:worker_threads');

// The log path is fixed in the main thread BEFORE any worker starts, so worker threads inherit it and every attempt lands in one file.
if (isMainThread && !process.env.NET_ATTEMPT_LOG) process.env.NET_ATTEMPT_LOG = require('node:path').join(require('node:os').tmpdir(), `brandproof-net-attempts-${process.pid}.log`);
const LOG = process.env.NET_ATTEMPT_LOG;
const who = isMainThread ? 'main' : 'worker';
const record = (kind, detail) => {
  const line = JSON.stringify({ at: new Date().toISOString(), thread: who, kind, detail: String(detail).slice(0, 200) });
  if (LOG) fs.appendFileSync(LOG, line + '\n');
};
const refuse = (kind, detail) => {
  record(kind, detail);
  throw Object.assign(new Error(`NETWORK BLOCKED (${kind}): ${String(detail).slice(0, 120)}`), { code: 'ENETBLOCKED' });
};

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0]; // Node passes already-normalised [options, callback]
  const target = typeof a === 'object' && a ? `${a.host ?? a.path ?? ''}:${a.port ?? ''}` : String(a);
  if (/^(127\.0\.0\.1|localhost|::1)/.test(target) === false && !(typeof a === 'object' && a?.path)) refuse('net.connect', target);
  return origConnect.apply(this, args);
};
for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  const orig = dns[fn];
  dns[fn] = (host, ...rest) => (host === 'localhost' || host === '127.0.0.1' ? orig.call(dns, host, ...rest) : refuse(`dns.${fn}`, host));
}
for (const [name, mod] of [['http', http], ['https', https]]) {
  for (const fn of ['request', 'get']) {
    const orig = mod[fn];
    mod[fn] = (...args) => {
      const target = typeof args[0] === 'string' ? args[0] : args[0]?.href ?? `${args[0]?.host ?? args[0]?.hostname}:${args[0]?.port ?? ''}`;
      if (/^(https?:\/\/)?(127\.0\.0\.1|localhost)/.test(target)) return orig.apply(mod, args);
      return refuse(`${name}.${fn}`, target);
    };
  }
}
tls.connect = (...args) => refuse('tls.connect', JSON.stringify(args[0]?.host ?? args[0]));
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (input, ...rest) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) return origFetch(input, ...rest);
    record('fetch', url);
    return Promise.reject(Object.assign(new Error(`NETWORK BLOCKED (fetch): ${url}`), { code: 'ENETBLOCKED' }));
  };
}
