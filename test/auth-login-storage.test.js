const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const auth = require('../utils/auth');
const { persistMintedAgentToken, ensureBilledCommandAuth } = require('../commands/auth');
const jwt = claims => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const exp = Math.floor(Date.now() / 1000) + 3600;
const agent = jwt({ type: 'agent_access', scopes: ['youtube'], exp });

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-login-storage-'));
  t.mock.method(os, 'homedir', () => dir);
  for (const name of ['ATRIS_TOKEN', 'ATRIS_PROFILE', 'ATRIS_AGENT_TOKEN_FILE']) {
    const before = process.env[name];
    delete process.env[name];
    t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = auth.getCredentialsPath();
  return { file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('saveCredentials rejects agent_access before changing any login file', t => {
  const { file } = sandbox(t);
  auth.saveCredentials('session', 'refresh', null, null, null);
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => auth.saveCredentials(agent, 'refresh'), /Refusing to save a scoped agent token as the login token; keep it under agent_token/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('persistMintedAgentToken refuses a scoped login token without writing', t => {
  const { file } = sandbox(t);
  fs.writeFileSync(file, JSON.stringify({ token: agent }));
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(
    () => persistMintedAgentToken({ token: agent }, jwt({ type: 'agent_access', scopes: ['x-search'], exp })),
    /Refusing to save a scoped agent token as the login token/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('persistMintedAgentToken preserves session and stores scoped metadata', t => {
  const { read } = sandbox(t);
  auth.saveCredentials('session', 'refresh', 'owner@example.com', 'owner', 'google');
  const before = read();
  const next = persistMintedAgentToken(before, agent, { scopes: ['youtube'], expiresAt: new Date(exp * 1000).toISOString() });
  assert.equal(next.token, before.token);
  assert.equal(next.agent_token, agent);
  assert.deepEqual(read(), { ...before, saved_at: read().saved_at, agent_token: agent, agent_token_scopes: ['youtube'], agent_token_expires_at: new Date(exp * 1000).toISOString() });
});

for (const rotated of [false, true]) {
  test(`loader repairs scoped login with refresh rotation ${rotated}`, async t => {
    const { file, read } = sandbox(t);
    fs.writeFileSync(file, JSON.stringify({ token: agent, refresh_token: 'refresh', email: 'owner@example.com', provider: 'google' }));
    const logs = [];
    t.mock.method(console, 'error', line => logs.push(line));
    const result = await auth.loadCredentials(async (route, options) => {
      assert.equal(route, '/auth/refresh');
      assert.deepEqual(options, { method: 'POST', body: { refresh_token: 'refresh' } });
      return { ok: true, data: { access_token: 'session', ...(rotated ? { refresh_token: 'rotated' } : {}) } };
    });
    assert.equal(result.token, 'session');
    assert.equal(read().token, 'session');
    assert.equal(read().agent_token, agent);
    assert.deepEqual(read().agent_token_scopes, ['youtube']);
    assert.equal(read().agent_token_expires_at, new Date(exp * 1000).toISOString());
    assert.equal(read().refresh_token, rotated ? 'rotated' : 'refresh');
    assert.deepEqual(logs, ['Repaired login file: moved a scoped agent token aside.']);
  });
}

test('loader without refresh leaves bytes untouched and prints login command', async t => {
  const { file } = sandbox(t);
  const before = JSON.stringify({ token: agent });
  fs.writeFileSync(file, before);
  const logs = [];
  t.mock.method(console, 'error', line => logs.push(line));
  await auth.loadCredentials(() => { throw new Error('unexpected network'); });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(logs, ['atris login']);
});

test('failed repair leaves login file untouched', async t => {
  const { file } = sandbox(t);
  const before = JSON.stringify({ token: agent, refresh_token: 'refresh' });
  fs.writeFileSync(file, before);
  await assert.rejects(auth.loadCredentials(async () => ({ ok: false })), /Could not repair login file/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

for (const state of ['valid', 'expired', 'wrong-scope', 'missing']) {
  test(`billed auth handles ${state} cached agent token`, async () => {
    const token = state === 'missing' ? undefined : jwt({ type: 'agent_access', scopes: state === 'wrong-scope' ? ['x-search'] : ['youtube'], exp: state === 'expired' ? 1 : exp });
    let calls = 0;
    const result = await ensureBilledCommandAuth('youtube', {
      loadCredentials: () => ({ token: 'session', agent_token: token }),
      mintScopedAgentToken: async () => { calls++; return { ok: true, token: 'new-agent' }; },
    });
    assert.equal(calls, state === 'valid' ? 0 : 1);
    assert.equal(result.token, state === 'valid' ? token : 'new-agent');
  });
}

test('billed auth uses a login-field scoped token when the scope matches', async () => {
  let minted = 0;
  const result = await ensureBilledCommandAuth('youtube', {
    loadCredentials: () => ({ token: agent }),
    mintScopedAgentToken: async () => {
      minted += 1;
      return { ok: true, token: 'new-agent' };
    },
    apiRequestJson: async () => {
      throw new Error('scoped login must not remint');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.minted, false);
  assert.equal(result.token, agent);
  assert.equal(minted, 0);
});

test('billed auth uses leftover placed-file scopes when they match', async () => {
  let minted = 0;
  const leftover = {
    token: 'fresh-placed-token',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    scopes: ['youtube'],
    provider: null,
    source: 'agent_token_file',
  };
  const result = await ensureBilledCommandAuth('youtube', {
    loadCredentials: () => leftover,
    mintScopedAgentToken: async () => {
      minted += 1;
      return { ok: true, token: 'new-agent' };
    },
    apiRequestJson: async () => {
      throw new Error('placed leftover must not remint');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.minted, false);
  assert.equal(result.token, leftover.token);
  assert.equal(minted, 0);
});

test('billed auth does not remint youtube from an x-search-only placed leftover', async () => {
  let minted = 0;
  const leftover = {
    token: 'fresh-placed-token',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    scopes: ['x-search'],
    provider: null,
    source: 'agent_token_file',
  };
  const result = await ensureBilledCommandAuth('youtube', {
    loadCredentials: () => leftover,
    persistMintedAgentToken: () => {
      throw new Error('should not persist');
    },
    mintScopedAgentToken: async () => {
      minted += 1;
      return { ok: true, token: 'new-agent' };
    },
    apiRequestJson: async () => {
      throw new Error('placed leftover must not remint');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not signed in. run atris login first.');
  assert.equal(minted, 0);
});

test('billed auth does not remint from a login-field scoped token for another scope', async () => {
  let minted = 0;
  const result = await ensureBilledCommandAuth('x-search', {
    loadCredentials: () => ({ token: agent }),
    persistMintedAgentToken: () => {
      throw new Error('should not persist');
    },
    mintScopedAgentToken: async () => {
      minted += 1;
      return { ok: true, token: 'new-agent' };
    },
    apiRequestJson: async () => {
      throw new Error('scoped login must not remint');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not signed in. run atris login first.');
  assert.equal(minted, 0);
});

test('authenticated loader repairs before validating the restored session', async t => {
  const { file, read } = sandbox(t);
  fs.writeFileSync(file, JSON.stringify({ token: agent, refresh_token: 'refresh' }));
  t.mock.method(console, 'error', () => {});
  const routes = [];
  const result = await auth.ensureValidCredentials(async (route, options) => {
    routes.push(route);
    if (route === '/auth/refresh') return { ok: true, data: { access_token: 'session' } };
    assert.equal(options.token, 'session');
    return { ok: true, data: { valid: true } };
  });
  assert.deepEqual(routes, ['/auth/refresh', '/auth/validate']);
  assert.equal(result.credentials.token, 'session');
  assert.equal(read().agent_token, agent);
});
