'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  parseAgentTokenArgs,
  mintAgentToken,
  wantsAgentToken,
} = require('../commands/auth');
const { ensureValidCredentials } = require('../utils/auth');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const SECRET = 'minted-agent-access-token-secret';

function jwtWithExp(exp) {
  return jwtWithClaims({ exp });
}

function jwtWithClaims(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-agent-token-'));
}

function writeCredentials(home, creds) {
  const dir = path.join(home, '.atris');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(creds, null, 2));
}

function readCredentials(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.atris', 'credentials.json'), 'utf8'));
}

function cliEnv(extra = {}) {
  return {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_NONINTERACTIVE: '1',
    ATRIS_TOKEN: '',
    ATRIS_PROFILE: '',
    ...extra,
  };
}

function runCli(args, { cwd, env, timeout = 15000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: cliEnv(env),
  });
  if (result.error) throw result.error;
  return result;
}

function runCliAsync(args, { cwd, env, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: cliEnv(env),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`cli hung past ${timeout}ms (args: ${args.join(' ')})`));
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function startHttpMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      const request = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      };
      requests.push(request);
      Promise.resolve()
        .then(() => handler(request))
        .catch((error) => ({ status: 500, body: { error: String(error.message || error) } }))
        .then((response) => {
          res.statusCode = response?.status || 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(response?.body || {}));
        });
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

test('unexpired agent_access token skips the user-token validation preflight', async () => {
  const previousToken = process.env.ATRIS_TOKEN;
  const token = jwtWithClaims({
    type: 'agent_access',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  process.env.ATRIS_TOKEN = token;

  try {
    const result = await ensureValidCredentials(async () => {
      throw new Error('agent token must not make a validation request');
    });

    assert.equal(result.error, undefined);
    assert.equal(result.credentials.token, token);
    assert.equal(result.user, null);
    assert.equal(result.source, 'agent_token');
  } finally {
    restoreEnv('ATRIS_TOKEN', previousToken);
  }
});

test('expired agent_access token without refresh returns a mint hint', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  const previousHome = process.env.HOME;
  const previousToken = process.env.ATRIS_TOKEN;
  const previousProfile = process.env.ATRIS_PROFILE;
  const token = jwtWithClaims({
    type: 'agent_access',
    exp: Math.floor(Date.now() / 1000) - 60,
  });

  process.env.HOME = home;
  delete process.env.ATRIS_TOKEN;
  delete process.env.ATRIS_PROFILE;
  writeCredentials(home, {
    token,
    refresh_token: null,
    provider: 'atris',
  });

  let networkCalls = 0;
  try {
    const result = await ensureValidCredentials(async () => {
      networkCalls += 1;
      throw new Error('expired agent token must not make a refresh request');
    });

    assert.deepEqual(result, {
      error: 'token_invalid',
      detail: 'Agent token expired. Mint a new one: atris login --agent',
    });
    assert.equal(networkCalls, 0);
  } finally {
    restoreEnv('HOME', previousHome);
    restoreEnv('ATRIS_TOKEN', previousToken);
    restoreEnv('ATRIS_PROFILE', previousProfile);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normal user token still uses the user-token validation preflight', async () => {
  const previousToken = process.env.ATRIS_TOKEN;
  const token = jwtWithClaims({
    type: 'user_access',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const calls = [];
  process.env.ATRIS_TOKEN = token;

  try {
    const result = await ensureValidCredentials(async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: { valid: true, user: { id: 'user-1' } },
      };
    });

    assert.equal(result.error, undefined);
    assert.equal(result.source, 'access_token');
    assert.deepEqual(calls, [{
      pathname: '/auth/validate',
      options: {
        method: 'POST',
        body: { token },
        token,
      },
    }]);
  } finally {
    restoreEnv('ATRIS_TOKEN', previousToken);
  }
});

test('parseAgentTokenArgs defaults scopes and cap, and accepts overrides', () => {
  assert.equal(wantsAgentToken(['--agent']), true);
  assert.equal(wantsAgentToken(['agent-token']), true);
  assert.equal(wantsAgentToken(['--force']), false);

  const defaults = parseAgentTokenArgs(['--agent']);
  assert.equal(defaults.agent, true);
  assert.deepEqual(defaults.scopes, ['x-search', 'youtube']);
  assert.equal(defaults.dailyCreditCap, 50);

  const youtubeOnly = parseAgentTokenArgs(['--agent', '--scopes', 'youtube', '--daily-credit-cap', '25']);
  assert.deepEqual(youtubeOnly.scopes, ['youtube']);
  assert.equal(youtubeOnly.dailyCreditCap, 25);

  const inline = parseAgentTokenArgs(['agent-token', '--scopes=x-search, youtube', '--daily-credit-cap=10']);
  assert.deepEqual(inline.scopes, ['x-search', 'youtube']);
  assert.equal(inline.dailyCreditCap, 10);
});

test('mintAgentToken writes the store and prints scopes, cap, and expiry without the token', async () => {
  const calls = [];
  const output = [];
  const errors = [];
  const persisted = [];
  const expiresAt = '2026-08-26T12:00:00.000Z';

  const code = await mintAgentToken(['--agent'], {
    output: (line) => output.push(line),
    outputError: (line) => errors.push(line),
    loadCredentials: () => ({
      token: 'user-jwt',
      refresh_token: 'refresh-jwt',
      email: 'agent@example.com',
      user_id: 'u-1',
      provider: 'atris',
    }),
    persistMintedAgentToken: (credentials, token, extras) => {
      persisted.push({ credentials, token, extras });
    },
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          access_token: SECRET,
          token_type: 'agent_access',
          scopes: ['x-search', 'youtube'],
          daily_credit_cap: 50,
          expires_at: expiresAt,
        },
      };
    },
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/auth/agent-token');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.token, 'user-jwt');
  assert.deepEqual(calls[0].options.body, {
    scopes: ['x-search', 'youtube'],
    daily_credit_cap: 50,
  });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].token, SECRET);
  assert.equal(persisted[0].credentials.email, 'agent@example.com');

  const text = output.join('\n');
  assert.match(text, /minted scoped agent token/);
  assert.match(text, /scopes: x-search, youtube/);
  assert.match(text, /daily credit cap: 50/);
  assert.match(text, /expires: 2026-08-26T12:00:00.000Z/);
  assert.doesNotMatch(text, new RegExp(SECRET));
  assert.equal(errors.length, 0);
});

test('mintAgentToken youtube-only request omits x-search from the body', async () => {
  const calls = [];
  const output = [];
  const code = await mintAgentToken(['--agent', '--scopes', 'youtube'], {
    output: (line) => output.push(line),
    outputError: () => {},
    loadCredentials: () => ({ token: 'user-jwt' }),
    persistMintedAgentToken: () => {},
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          token: SECRET,
          scopes: ['youtube'],
          daily_credit_cap: 50,
        },
      };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls[0].options.body.scopes, ['youtube']);
  assert.doesNotMatch(output.join('\n'), /x-search/);
  assert.doesNotMatch(output.join('\n'), new RegExp(SECRET));
});

test('mintAgentToken --json omits the token and still records the mint', async () => {
  const output = [];
  const persisted = [];
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const minted = jwtWithExp(exp);

  const code = await mintAgentToken(['--agent', '--json'], {
    output: (line) => output.push(line),
    loadCredentials: () => ({ token: 'user-jwt' }),
    persistMintedAgentToken: (_credentials, token) => persisted.push(token),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { agent_access: minted, scopes: ['youtube'], daily_credit_cap: 12 },
    }),
  });

  assert.equal(code, 0);
  assert.deepEqual(persisted, [minted]);
  const payload = JSON.parse(output.join('\n'));
  assert.equal(payload.ok, true);
  assert.equal(payload.minted, true);
  assert.deepEqual(payload.scopes, ['youtube']);
  assert.equal(payload.daily_credit_cap, 12);
  assert.equal(payload.expires_at, new Date(exp * 1000).toISOString());
  assert.equal('token' in payload, false);
  assert.equal('access_token' in payload, false);
  assert.doesNotMatch(output.join('\n'), new RegExp(minted));
});

test('mintAgentToken without stored credentials does not call the API or open a login wall', async () => {
  const calls = [];
  const output = [];
  const code = await mintAgentToken(['--agent'], {
    output: (line) => output.push(line),
    outputError: () => {},
    loadCredentials: () => null,
    persistMintedAgentToken: () => {
      throw new Error('should not persist');
    },
    apiRequestJson: async () => {
      calls.push('called');
      return { ok: true, status: 200, data: { token: SECRET } };
    },
  });

  assert.equal(code, 1);
  assert.deepEqual(calls, []);
  assert.match(output.join('\n'), /not signed in/);
  assert.doesNotMatch(output.join('\n'), /Choose login method|Opening browser|\/auth\/cli|Google/);
});

test('mintAgentToken retries with the refresh JWT after a 401', async () => {
  const calls = [];
  const persisted = [];
  const code = await mintAgentToken(['--agent'], {
    output: () => {},
    outputError: () => {},
    loadCredentials: () => ({
      token: 'expired-user-jwt',
      refresh_token: 'refresh-jwt',
    }),
    persistMintedAgentToken: (_credentials, token) => persisted.push(token),
    apiRequestJson: async (_pathname, options) => {
      calls.push(options.token);
      if (options.token === 'expired-user-jwt') {
        return { ok: false, status: 401, error: 'expired' };
      }
      return {
        ok: true,
        status: 200,
        data: { access_token: SECRET, scopes: ['x-search'], daily_credit_cap: 50 },
      };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, ['expired-user-jwt', 'refresh-jwt']);
  assert.deepEqual(persisted, [SECRET]);
});

test('login --help lists --agent without touching credentials', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  try {
    const res = runCli(['login', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris login/);
    assert.match(res.stdout, /--agent/);
    assert.match(res.stdout, /--scopes/);
    assert.match(res.stdout, /--daily-credit-cap/);
    assert.doesNotMatch(res.stdout, /Choose login method|Opening browser/);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('login --agent without credentials stays off the login wall', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  try {
    const res = runCli(['login', '--agent'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stdout, /not signed in/);
    assert.match(res.stdout, /atris login --agent/);
    assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, /Choose login method|Opening browser|\/auth\/cli|Google/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris login --agent mints through the live CLI with mocked HTTP', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  writeCredentials(home, {
    token: 'stored-user-jwt',
    refresh_token: 'stored-refresh-jwt',
    email: 'owner@example.com',
    user_id: 'u-9',
    provider: 'atris',
  });

  const mock = await startHttpMock((request) => ({
    status: 200,
    body: {
      access_token: SECRET,
      token_type: 'agent_access',
      scopes: ['x-search', 'youtube'],
      daily_credit_cap: 50,
      expires_at: '2026-08-26T15:00:00.000Z',
    },
  }));

  try {
    const res = await runCliAsync(['login', '--agent'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
      },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].method, 'POST');
    assert.equal(mock.requests[0].url, '/api/auth/agent-token');
    assert.equal(mock.requests[0].authorization, 'Bearer stored-user-jwt');
    assert.deepEqual(mock.requests[0].body, {
      scopes: ['x-search', 'youtube'],
      daily_credit_cap: 50,
    });
    assert.match(res.stdout, /minted scoped agent token/);
    assert.match(res.stdout, /scopes: x-search, youtube/);
    assert.match(res.stdout, /daily credit cap: 50/);
    assert.match(res.stdout, /expires: 2026-08-26T15:00:00.000Z/);
    assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, new RegExp(SECRET));
    assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, /Choose login method|Opening browser|\/auth\/cli/);

    const stored = readCredentials(home);
    assert.equal(stored.token, 'stored-user-jwt');
    assert.equal(stored.agent_token, SECRET);
    assert.equal(stored.refresh_token, 'stored-refresh-jwt');
    assert.equal(stored.email, 'owner@example.com');
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
