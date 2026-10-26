// Owner setup for the authenticated workspace. Run it yourself, in a terminal, when you are ready:
//
//   npm run auth:setup                 create the first owner (asks for a username, display name and password)
//   npm run auth:setup -- add-user     add a creator / manager / reviewer
//   npm run auth:setup -- list         list accounts (no secrets)
//   npm run auth:setup -- reset <id>   set a new password for an account (e.g. U-2)
//
// Stop the BrandProof server first: this writes the credential file directly.
// Passwords are typed with echo off, are never accepted as command-line arguments or environment variables,
// are never printed, and nothing is stored but a scrypt hash. There are no default accounts or passwords.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAuth } from '../src/auth.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const authFile = process.env.BRANDPROOF_AUTH_FILE || path.join(root, 'data', 'auth', 'users.json');

// Reads one line from the terminal in raw mode; when hidden, typed characters are not echoed.
function ask(prompt, hidden = false) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        const code = ch.codePointAt(0);
        if (code === 13 || code === 10 || code === 4) {
          // Enter (or Ctrl+D) finishes the line
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write(String.fromCharCode(10));
          return resolve(buf);
        }
        if (code === 3) process.exit(130); // Ctrl+C
        if (code === 127 || code === 8) {
          // Backspace
          if (buf) buf = [...buf].slice(0, -1).join('');
          continue;
        }
        buf += ch;
        if (!hidden) process.stdout.write(ch);
      }
    };
    stdin.on('data', onData);
  });
}
const askHidden = (q) => ask(q, true);

if (!process.stdin.isTTY) {
  console.error('This command needs an interactive terminal (it asks for a password without echoing it).');
  process.exit(2);
}

const cmd = process.argv[2] ?? 'create-owner';
let auth = null;
try {
  // Takes exclusive ownership of the credential file first: refused while a server (or another setup) has it open.
  auth = await openAuth(authFile);
  if (cmd === 'list') {
    for (const u of auth.listUsers()) console.log(`${u.id}  ${u.username.padEnd(20)} ${u.role.padEnd(9)} ${u.owner ? 'owner ' : '      '}${u.disabled ? 'disabled' : ''}  ${u.name}`);
    if (!auth.userCount()) console.log('(no accounts yet)');
  } else if (cmd === 'create-owner' || cmd === 'add-user') {
    const first = cmd === 'create-owner';
    if (first && auth.userCount() > 0) throw new Error('Accounts already exist. Use "add-user", or "reset <id>" to change a password.');
    console.log(first ? 'Create the owner account (a manager who can add people).' : 'Add an account.');
    const username = await ask('Username: ');
    const displayName = await ask('Display name: ');
    const role = first ? 'manager' : (await ask('Role (creator / manager / reviewer): ')).trim();
    const password = await askHidden('Password (at least 15 characters; a passphrase is fine): ');
    const again = await askHidden('Repeat password: ');
    if (password !== again) throw new Error('The two passwords did not match. Nothing was saved.');
    const u = await auth.createUser({ username, displayName, role, password, owner: first, createdBy: 'setup' });
    console.log(`Created ${u.id} (${u.username}, ${u.role}${u.owner ? ', owner' : ''}).`);
  } else if (cmd === 'reset') {
    const id = process.argv[3];
    if (!id) throw new Error('Usage: npm run auth:setup -- reset U-2');
    const password = await askHidden('New password: ');
    const again = await askHidden('Repeat password: ');
    if (password !== again) throw new Error('The two passwords did not match. Nothing was saved.');
    await auth.adminResetPassword('setup', id, password);
    console.log(`Password updated for ${id}.`);
  } else {
    throw new Error(`Unknown command "${cmd}".`);
  }
} catch (e) {
  const fields = e.details?.fields;
  console.error(fields?.length ? `Not saved: ${fields.map((f) => `${f.path} ${f.message}`).join('; ')}` : `Not saved: ${e.message}`);
  process.exitCode = 1;
} finally {
  process.stdin.pause();
  await auth?.close(); // pending writes finish, then the credential file is released
}
