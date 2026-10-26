import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { openAuth, hashPassword, verifyPassword } from '../src/auth.js';
import { tempDir } from './helpers.js';
import { synthPassword, TEST_COST } from './auth-helpers.js';

/**
 * Deterministic scheduling for the auth service. The hasher wraps the real scrypt functions but can PARK
 * verification or hashing until released, and counts calls and concurrency. Nothing here stresses the machine.
 */
function schedulingHasher({ holdHash = false } = {}) {
  const st = { hashCalls: 0, verifyCalls: 0, active: 0, maxActive: 0, failNextHash: false };
  let verifyGate = null;
  let parkBudget = 0; // how many upcoming verifications to park
  let hashGate = holdHash ? defer() : null;
  function defer() {
    let release;
    const promise = new Promise((r) => (release = r));
    return { promise, release };
  }
  const enter = () => {
    st.active++;
    st.maxActive = Math.max(st.maxActive, st.active);
  };
  return {
    st,
    holdVerify: (count = Infinity) => {
      verifyGate = defer();
      parkBudget = count;
    },
    releaseVerify: () => verifyGate?.release(),
    releaseHash: () => hashGate?.release(),
    hasher: {
      async hashPassword(pw, cost) {
        st.hashCalls++;
        enter();
        try {
          if (hashGate) await hashGate.promise;
          if (st.failNextHash) {
            st.failNextHash = false;
            throw new Error('simulated hashing failure');
          }
          return await hashPassword(pw, cost);
        } finally {
          st.active--;
        }
      },
      async verifyPassword(pw, rec) {
        st.verifyCalls++;
        enter();
        try {
          if (verifyGate && parkBudget > 0) {
            parkBudget--;
            await verifyGate.promise;
          }
          return await verifyPassword(pw, rec);
        } finally {
          st.active--;
        }
      },
    },
  };
}

const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 2));
  }
};

async function setup({ hold = false } = {}) {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'auth.json');
  const sched = schedulingHasher({ holdHash: hold });
  const auth = await openAuth(file, { cost: TEST_COST, hasher: sched.hasher });
  // closing the credential store releases its ownership marker (and lets pending writes finish) before the directory goes
  return { tmp: { ...tmp, cleanup: async () => { await auth.close(); await tmp.cleanup(); } }, file, sched, auth };
}

const settle = (p) => p.then((value) => ({ ok: true, value }), (e) => ({ ok: false, code: e.code, status: e.status }));

async function twoOwnersAndUser(auth) {
  const pw = { a: synthPassword(), b: synthPassword(), u: synthPassword() };
  const a = await auth.createUser({ username: 'syn-owner-a', displayName: 'Owner A', role: 'manager', password: pw.a, owner: true });
  const b = await auth.createUser({ username: 'syn-owner-b', displayName: 'Owner B', role: 'manager', password: pw.b, owner: true });
  const u = await auth.createUser({ username: 'syn-creator', displayName: 'Creator', role: 'creator', password: pw.u });
  return { a, b, u, pw };
}

// ---------- password reset / disable versus an in-flight sign-in ----------

test('REGRESSION: a password reset that finishes while a sign-in is still verifying the OLD password issues no session', async () => {
  const { tmp, sched, auth } = await setup();
  try {
    const { a, u, pw } = await twoOwnersAndUser(auth);
    sched.holdVerify();
    const pending = settle(auth.login(u.username, pw.u, 'loopback'));
    await until(() => sched.st.verifyCalls === 1); // verification is parked mid-flight
    const newPw = synthPassword();
    await auth.adminResetPassword(a.id, u.id, newPw); // the reset completes completely
    sched.releaseVerify();
    const r = await pending;
    assert.equal(r.ok, false);
    assert.equal(r.code, 'invalid_credentials');
    assert.equal(auth.sessionCount(), 0, 'no usable session was minted for the obsolete credential');
    assert.equal((await settle(auth.login(u.username, pw.u, 'loopback'))).ok, false, 'old password stays dead');
    assert.equal((await settle(auth.login(u.username, newPw, 'loopback'))).ok, true);
  } finally {
    await tmp.cleanup();
  }
});

test('REGRESSION: disabling an account while its sign-in is verifying issues no session, even after re-enabling', async () => {
  const { tmp, sched, auth } = await setup();
  try {
    const { a, u, pw } = await twoOwnersAndUser(auth);
    sched.holdVerify();
    const pending = settle(auth.login(u.username, pw.u, 'loopback'));
    await until(() => sched.st.verifyCalls === 1);
    await auth.adminSetDisabled(a.id, u.id, true);
    await auth.adminSetDisabled(a.id, u.id, false); // back on again before the verification finishes
    sched.releaseVerify();
    const r = await pending;
    assert.equal(r.ok, false, 'the generation changed twice, so the old verification must not be honoured');
    assert.equal(auth.sessionCount(), 0);
  } finally {
    await tmp.cleanup();
  }
});

test('REGRESSION: a password change that lands while a sign-in verifies the old password also invalidates that sign-in', async () => {
  const { tmp, sched, auth } = await setup();
  try {
    const { u, pw } = await twoOwnersAndUser(auth);
    const first = await auth.login(u.username, pw.u, 'loopback');
    const me = auth.authenticate(first.cookie.split(';')[0]);
    const base = sched.st.verifyCalls;
    sched.holdVerify(1); // only the next verification is parked: the stale sign-in
    const stale = settle(auth.login(u.username, pw.u, 'loopback')); // second device, parked on the old password
    await until(() => sched.st.verifyCalls === base + 1);
    const next = synthPassword();
    await auth.changePassword(me, { current: pw.u, next }, 'loopback'); // completes while the sign-in is still parked
    sched.releaseVerify();
    assert.equal((await stale).ok, false);
    assert.equal(auth.sessionCount(), 1, 'only the session issued by the password change exists');
  } finally {
    await tmp.cleanup();
  }
});

test('REGRESSION: sessions carry a credential generation; one from an obsolete generation is rejected even if revocation was missed', async () => {
  const { tmp, auth } = await setup();
  try {
    const { u, pw } = await twoOwnersAndUser(auth);
    const s = await auth.login(u.username, pw.u, 'loopback');
    const cookie = s.cookie.split(';')[0];
    assert.ok(auth.authenticate(cookie));
    // bump the generation WITHOUT calling any revocation, as if a revoke had been skipped by a race
    await auth.store.mutate((d) => {
      d.users.find((x) => x.id === u.id).credVersion = 7;
    });
    assert.equal(auth.sessionCount(), 1);
    assert.equal(auth.authenticate(cookie), null);
    assert.equal(auth.sessionCount(), 0, 'and it is dropped');
  } finally {
    await tmp.cleanup();
  }
});

// ---------- stale verification must not overwrite a newer credential change ----------

test('REGRESSION: a password change verified BEFORE an owner reset cannot overwrite the reset', async () => {
  const { tmp, sched, auth } = await setup();
  try {
    const { a, u, pw } = await twoOwnersAndUser(auth);
    const s = await auth.login(u.username, pw.u, 'loopback');
    const me = auth.authenticate(s.cookie.split(';')[0]);
    sched.holdVerify();
    const change = settle(auth.changePassword(me, { current: pw.u, next: synthPassword() }, 'loopback'));
    await until(() => sched.st.verifyCalls === 2); // login + the change's verification (parked)
    const reset = synthPassword();
    await auth.adminResetPassword(a.id, u.id, reset);
    sched.releaseVerify();
    const r = await change;
    assert.equal(r.ok, false);
    assert.equal(r.code, 'credential_changed');
    assert.equal(r.status, 409);
    assert.equal((await settle(auth.login(u.username, reset, 'loopback'))).ok, true, 'the reset password is still the credential');
  } finally {
    await tmp.cleanup();
  }
});

test('REGRESSION: two concurrent password changes from the same old password: exactly one wins, the other is refused', async () => {
  const { tmp, sched, auth } = await setup();
  try {
    const { u, pw } = await twoOwnersAndUser(auth);
    const s1 = await auth.login(u.username, pw.u, 'loopback');
    const s2 = await auth.login(u.username, pw.u, 'loopback');
    const me1 = auth.authenticate(s1.cookie.split(';')[0]);
    const me2 = auth.authenticate(s2.cookie.split(';')[0]);
    const [n1, n2] = [synthPassword(), synthPassword()];
    sched.holdVerify();
    const base = sched.st.verifyCalls;
    const c1 = settle(auth.changePassword(me1, { current: pw.u, next: n1 }, 'loopback'));
    const c2 = settle(auth.changePassword(me2, { current: pw.u, next: n2 }, 'loopback'));
    await until(() => sched.st.verifyCalls === base + 2); // both have captured the same generation
    sched.releaseVerify();
    const [r1, r2] = await Promise.all([c1, c2]);
    assert.equal([r1, r2].filter((r) => r.ok).length, 1);
    assert.equal([r1, r2].find((r) => !r.ok).code, 'credential_changed');
    const winner = r1.ok ? n1 : n2;
    const loser = r1.ok ? n2 : n1;
    assert.equal((await settle(auth.login(u.username, winner, 'loopback'))).ok, true);
    assert.equal((await settle(auth.login(u.username, loser, 'loopback'))).ok, false);
  } finally {
    await tmp.cleanup();
  }
});

// ---------- last-owner invariant ----------

test('REGRESSION: two owners disabling themselves at the same time cannot leave zero active owners', async () => {
  const { tmp, auth } = await setup();
  try {
    const { a, b } = await twoOwnersAndUser(auth);
    const results = await Promise.allSettled([auth.adminSetDisabled(a.id, a.id, true), auth.adminSetDisabled(b.id, b.id, true)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const refused = results.find((r) => r.status === 'rejected');
    assert.equal(refused.reason.code, 'last_owner');
    assert.equal(refused.reason.status, 409);
    assert.equal(auth.listUsers().filter((x) => x.owner && !x.disabled).length, 1);
  } finally {
    await tmp.cleanup();
  }
});

test('REGRESSION: two owners disabling EACH OTHER at the same time also leaves one', async () => {
  const { tmp, auth } = await setup();
  try {
    const { a, b } = await twoOwnersAndUser(auth);
    for (let i = 0; i < 3; i++) {
      const results = await Promise.allSettled([auth.adminSetDisabled(a.id, b.id, true), auth.adminSetDisabled(b.id, a.id, true)]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(auth.listUsers().filter((x) => x.owner && !x.disabled).length, 1);
      for (const x of [a, b]) await auth.adminSetDisabled(x.id, x.id, false).catch(() => {}); // reset for the next round
    }
  } finally {
    await tmp.cleanup();
  }
});

test('last-owner invariant keeps its normal behaviour: one owner may disable another, not the last; others are free; unknown ids 404', async () => {
  const { tmp, auth } = await setup();
  try {
    const { a, b, u } = await twoOwnersAndUser(auth);
    assert.equal((await auth.adminSetDisabled(a.id, u.id, true)).disabled, true); // a non-owner is always fine
    assert.equal((await auth.adminSetDisabled(a.id, b.id, true)).disabled, true); // another owner exists (a)
    const last = await settle(auth.adminSetDisabled(a.id, a.id, true));
    assert.equal(last.code, 'last_owner');
    assert.equal((await auth.adminSetDisabled(a.id, b.id, false)).disabled, false);
    assert.equal((await auth.adminSetDisabled(a.id, a.id, true)).disabled, true); // allowed again: b is active
    assert.equal((await settle(auth.adminSetDisabled(a.id, 'U-404', true))).status, 404);
    assert.equal((await settle(auth.adminSetDisabled(a.id, 'U-404', true))).code, 'not_found');
  } finally {
    await tmp.cleanup();
  }
});

// ---------- bounded hashing ----------

test('REGRESSION: the dummy hash is created once and under the same bounded gate; first sign-ins cannot each start their own', async () => {
  const { tmp, sched, auth } = await setup({ hold: true }); // hashing is parked from the very start (the start-up warm-up)
  try {
    assert.equal(sched.st.hashCalls, 1, 'the start-up warm-up computes the dummy hash once');
    const attempts = Array.from({ length: 8 }, (_, i) => settle(auth.login(`syn-ghost-${i}`, synthPassword(), 'loopback')));
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); // let every attempt reach its first await
    assert.equal(sched.st.hashCalls, 1, 'eight concurrent first sign-ins share ONE dummy hash computation');
    assert.ok(sched.st.maxActive <= 2, `at most 2 scrypt jobs at once (saw ${sched.st.maxActive})`);
    sched.releaseHash();
    const out = await Promise.all(attempts);
    assert.ok(out.every((r) => !r.ok && r.code === 'invalid_credentials'));
    assert.equal(sched.st.hashCalls, 1, 'still one: the dummy hash is reused');
    assert.ok(sched.st.maxActive <= 2, `at most 2 scrypt jobs at once (saw ${sched.st.maxActive})`);
    assert.equal(sched.st.verifyCalls, 8, 'every unknown-account attempt still pays for one verification');
  } finally {
    await tmp.cleanup();
  }
});

test('hashing and verification together never exceed the gate, and overload is refused with 503 rather than queued without bound', async () => {
  const { tmp, sched, auth } = await setup();
  try {
    const { u, pw } = await twoOwnersAndUser(auth);
    sched.holdVerify();
    let refusedEarly = 0;
    const attempts = Array.from({ length: 14 }, () =>
      settle(auth.login(u.username, pw.u, `ip-${Math.random()}`)).then((r) => {
        if (!r.ok) refusedEarly++;
        return r;
      }),
    );
    await until(() => refusedEarly >= 4 && sched.st.verifyCalls >= 2); // 2 running, 8 waiting, the rest refused (no fixed sleeps)
    assert.ok(sched.st.maxActive <= 2);
    sched.releaseVerify();
    const out = await Promise.all(attempts);
    assert.ok(sched.st.maxActive <= 2);
    const busy = out.filter((r) => !r.ok && r.code === 'busy');
    assert.ok(busy.length >= 1, 'beyond 2 running + 8 waiting, extra attempts are refused');
    assert.equal(out.filter((r) => r.ok).length + busy.length, 14);
  } finally {
    await tmp.cleanup();
  }
});

test('a failed dummy-hash start-up is not cached: the next attempt retries instead of failing forever', async () => {
  const tmp = await tempDir();
  try {
    const sched = schedulingHasher();
    sched.st.failNextHash = true; // the warm-up at creation fails
    const auth = await openAuth(path.join(tmp.dir, 'auth.json'), { cost: TEST_COST, hasher: sched.hasher });
    await new Promise((r) => setTimeout(r, 30));
    const first = await settle(auth.login('syn-ghost', synthPassword(), 'loopback'));
    assert.equal(first.code, 'invalid_credentials', 'a normal refusal, after retrying the dummy hash');
    assert.equal(sched.st.hashCalls, 2);
    await auth.close();
  } finally {
    await tmp.cleanup();
  }
});

// ---------- failed disk writes ----------

test('failed disk write: a reset is refused and changes nothing; sign-in fails closed with no leaked session; service recovers', async () => {
  const { tmp, file, auth } = await setup();
  try {
    const { a, u, pw } = await twoOwnersAndUser(auth);
    const live = await auth.login(u.username, pw.u, 'loopback');
    const liveCookie = live.cookie.split(';')[0];
    const before = JSON.stringify(auth.store.state.users);

    const blocker = `${file}.${process.pid}.tmp`; // a directory where the temp file must go: every write now fails
    await mkdir(blocker);
    const reset = await settle(auth.adminResetPassword(a.id, u.id, synthPassword()));
    assert.equal(reset.ok, false);
    assert.equal(JSON.stringify(auth.store.state.users), before, 'nothing was changed in memory');
    assert.ok(auth.authenticate(liveCookie), 'and nothing was revoked: the failed reset did not half-apply');

    const sessionsBefore = auth.sessionCount();
    const login = await settle(auth.login(u.username, pw.u, 'loopback'));
    assert.equal(login.ok, false, 'no audit record could be written, so no session is granted');
    assert.equal(auth.sessionCount(), sessionsBefore, 'and none is left behind');

    const disable = await settle(auth.adminSetDisabled(a.id, u.id, true));
    assert.equal(disable.ok, false);
    assert.equal(auth.listUsers().find((x) => x.id === u.id).disabled, false);

    const bad = await settle(auth.login(u.username, 'wrong-password-entirely', 'loopback'));
    assert.equal(bad.code, 'invalid_credentials', 'a refusal stays a refusal even if its audit entry cannot be written');

    await rm(blocker, { recursive: true });
    assert.equal((await settle(auth.login(u.username, pw.u, 'loopback'))).ok, true, 'recovers once the disk works');
    const fresh = synthPassword();
    await auth.adminResetPassword(a.id, u.id, fresh);
    assert.equal(auth.authenticate(liveCookie), null);
    assert.equal((await settle(auth.login(u.username, fresh, 'loopback'))).ok, true);
  } finally {
    await tmp.cleanup();
  }
});
