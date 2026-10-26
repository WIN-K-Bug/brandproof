// A separate OS process that opens a workspace store (mode "store") or a credential store (mode "auth") and obeys commands on
// stdin. Used only by tests/single-writer.test.js to exercise REAL cross-process behaviour. Synthetic data only.
//
//   node writer-child.mjs <mode> <file>
// stdout lines: READY | REFUSED <message> | WROTE <marker> | USER <name> | COUNT <n> | CLOSED | ERROR <message>
// commands:     write <marker> | user <name> | count | quit (drain, close, exit 0) | exit (process.exit without close) | throw
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { Store, emptyState } from '../../src/store.js';
import { openAuth } from '../../src/auth.js';

const [mode, file] = process.argv.slice(2);
const say = (s) => process.stdout.write(`${s}\n`);

let handle;
try {
  if (mode === 'auth') {
    handle = await openAuth(file, { cost: { N: 1024, r: 8, p: 1 } });
  } else {
    handle = await Store.open(file, () => ({ ...emptyState(), markers: [] }));
  }
} catch (e) {
  say(`REFUSED ${String(e.message).replace(/\s+/g, ' ')}`);
  process.exit(3);
}
say('READY');

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const [cmd, arg] = line.trim().split(/\s+/);
  try {
    if (cmd === 'write') {
      await handle.mutate((d) => d.markers.push(arg));
      say(`WROTE ${arg}`);
    } else if (cmd === 'user') {
      await handle.createUser({ username: arg, displayName: arg, role: 'creator', password: `synthetic-${randomBytes(12).toString('hex')}-pw` });
      say(`USER ${arg}`);
    } else if (cmd === 'count') {
      say(`COUNT ${mode === 'auth' ? handle.userCount() : handle.state.markers.length}`);
    } else if (cmd === 'quit') {
      await (mode === 'auth' ? handle.close() : handle.close());
      say('CLOSED');
      process.exit(0);
    } else if (cmd === 'exit') {
      process.exit(0); // no close(): only the exit hook can release
    } else if (cmd === 'throw') {
      setImmediate(() => {
        throw new Error('synthetic uncaught error');
      });
    }
  } catch (e) {
    say(`ERROR ${String(e.message).replace(/\s+/g, ' ')}`);
  }
}
