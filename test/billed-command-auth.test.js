'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { ensureBilledCommandAuth } = require('../commands/auth');
const { xSearchApplyRel } = require('../commands/x-search');

const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const agentExp = Math.floor(Date.now() / 1000) + 3600;
const youtubeAgent = jwt({ type: 'agent_access', scopes: ['youtube'], exp: agentExp });

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const SECRET = 'minted-billed-agent-token-secret';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-billed-auth-'));
}

function writeCredentials(home, creds) {
  const dir = path.join(home, '.atris');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(creds, null, 2));
}

function writePlacedToken(dir, value) {
  const file = path.join(dir, 'agent-token.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function writeProcessApply(cwd, id = 'abc123') {
  const applyDir = path.join(cwd, 'atris', 'wiki', 'briefs');
  fs.mkdirSync(applyDir, { recursive: true });
  fs.writeFileSync(path.join(applyDir, `youtube-${id}.apply.md`), [
    `source: https://youtu.be/${id}`,
    'change: commands/youtube.js',
    'receipt: node --test test/billed-command-auth.test.js',
    '',
  ].join('\n'));
}

function readCredentials(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.atris', 'credentials.json'), 'utf8'));
}

function cliEnv(extra = {}) {
  return {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_NONINTERACTIVE: '1',
    ATRIS_YOUTUBE_LOCAL_TRANSCRIPT: '0',
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

test('ensureBilledCommandAuth mints one requested scope after the user wall', async () => {
  const calls = [];
  const persisted = [];
  const result = await ensureBilledCommandAuth('x-search', {
    ensureValidCredentials: async () => ({ error: 'token_invalid', detail: 'Token expired' }),
    loadCredentials: () => ({
      token: 'user-jwt',
      refresh_token: 'refresh-jwt',
      email: 'owner@example.com',
    }),
    persistMintedAgentToken: (_credentials, token) => {
      persisted.push(token);
    },
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: { access_token: SECRET, scopes: ['x-search'], daily_credit_cap: 50 },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.minted, true);
  assert.equal(result.token, SECRET);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/auth/agent-token');
  assert.deepEqual(calls[0].options.body.scopes, ['x-search']);
  assert.equal(calls[0].options.body.scopes.includes('youtube'), false);
  assert.deepEqual(persisted, [SECRET]);
});

test('ensureBilledCommandAuth with no stored JWT stays off the login wall', async () => {
  const calls = [];
  const result = await ensureBilledCommandAuth('youtube', {
    ensureValidCredentials: async () => ({ error: 'not_logged_in' }),
    loadCredentials: () => null,
    persistMintedAgentToken: () => {
      throw new Error('should not persist');
    },
    apiRequestJson: async () => {
      calls.push('called');
      return { ok: true, status: 200, data: { token: SECRET } };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'not signed in. run atris login first.');
  assert.deepEqual(calls, []);
  assert.doesNotMatch(result.error, /\/auth\/cli|Choose login method|Opening browser/);
});

test('ensureBilledCommandAuth forceMint requests only the youtube scope', async () => {
  const calls = [];
  const result = await ensureBilledCommandAuth('youtube', {
    forceMint: true,
    ensureValidCredentials: async () => ({ credentials: { token: 'user-jwt' } }),
    loadCredentials: () => ({ token: 'user-jwt' }),
    persistMintedAgentToken: () => {},
    apiRequestJson: async (pathname, options) => {
      calls.push(options.body);
      return {
        ok: true,
        status: 200,
        data: { token: SECRET, scopes: ['youtube'] },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.minted, true);
  assert.deepEqual(calls[0].scopes, ['youtube']);
  assert.equal(calls[0].scopes.includes('x-search'), false);
});

test('atris youtube search --paid with no stored JWT prints one sentence and no login wall', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  try {
    const res = runCli(['youtube', 'search', '--paid', 'MCP agents'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 1, res.stderr);
    const text = `${res.stdout}\n${res.stderr}`;
    assert.match(text, /not signed in\. run atris login first\./);
    assert.doesNotMatch(text, /Choose login method|Opening browser|\/auth\/cli|Google/);
    assert.doesNotMatch(text, new RegExp(SECRET));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris x-search with no stored JWT prints one sentence and no login wall', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  try {
    const res = runCli(['x-search', 'MCP agents'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 1, res.stderr);
    const text = `${res.stdout}\n${res.stderr}`;
    assert.match(text, /not signed in\. run atris login first\./);
    assert.doesNotMatch(text, /Choose login method|Opening browser|\/auth\/cli|Google/);
    assert.doesNotMatch(text, new RegExp(SECRET));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris x-search mints an x-search token from the stored JWT and retries', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  writeCredentials(home, {
    token: 'stored-user-jwt',
    refresh_token: 'stored-refresh-jwt',
    email: 'owner@example.com',
    user_id: 'u-9',
    provider: 'atris',
  });

  const mock = await startHttpMock((request) => {
    if (request.url === '/api/auth/validate') {
      return { status: 200, body: { valid: false, error: 'Token expired' } };
    }
    if (request.url === '/api/auth/refresh') {
      return { status: 401, body: { error: 'refresh expired' } };
    }
    if (request.url === '/api/auth/agent-token') {
      return {
        status: 200,
        body: {
          access_token: SECRET,
          token_type: 'agent_access',
          scopes: ['x-search'],
          daily_credit_cap: 50,
          expires_at: '2026-08-26T15:00:00.000Z',
        },
      };
    }
    if (request.url === '/api/x-search/search') {
      return {
        status: 200,
        body: {
          status: 'success',
          credits_used: 5,
          credits_remaining: 995,
          data: { content: 'minted search worked', citations: [] },
        },
      };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  const applyDir = path.join(dir, 'atris', 'wiki', 'briefs');
  fs.mkdirSync(applyDir, { recursive: true });
  fs.writeFileSync(path.join(dir, xSearchApplyRel('MCP agents')), [
    'source: MCP agents',
    'change: commands/x-search.js',
    'receipt: node --test test/billed-command-auth.test.js',
    '',
  ].join('\n'));

  try {
    const res = await runCliAsync(['x-search', 'MCP agents'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
      },
    });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    const mint = mock.requests.find((req) => req.url === '/api/auth/agent-token');
    const search = mock.requests.find((req) => req.url === '/api/x-search/search');
    assert.ok(mint, 'expected agent-token mint');
    assert.ok(search, 'expected x-search retry');
    assert.equal(mint.method, 'POST');
    assert.equal(mint.authorization, 'Bearer stored-user-jwt');
    assert.deepEqual(mint.body.scopes, ['x-search']);
    assert.equal(mint.body.scopes.includes('youtube'), false);
    assert.equal(search.authorization, `Bearer ${SECRET}`);
    assert.match(res.stdout, /minted search worked/);
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

test('atris youtube search --paid mints a youtube token from the stored JWT and retries', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  writeCredentials(home, {
    token: 'stored-user-jwt',
    refresh_token: 'stored-refresh-jwt',
    email: 'owner@example.com',
    user_id: 'u-9',
    provider: 'atris',
  });

  const mock = await startHttpMock((request) => {
    if (request.url === '/api/auth/validate') {
      return { status: 200, body: { valid: false, error: 'Token expired' } };
    }
    if (request.url === '/api/auth/refresh') {
      return { status: 401, body: { error: 'refresh expired' } };
    }
    if (request.url === '/api/auth/agent-token') {
      return {
        status: 200,
        body: {
          access_token: SECRET,
          token_type: 'agent_access',
          scopes: ['youtube'],
          daily_credit_cap: 50,
        },
      };
    }
    if (request.url === '/api/youtube/search') {
      return {
        status: 200,
        body: {
          status: 'success',
          credits_used: 5,
          credits_remaining: 40,
          data: {
            results: [
              { title: 'minted youtube search worked', url: 'https://www.youtube.com/watch?v=paid123' },
            ],
          },
        },
      };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(['youtube', 'search', '--paid', 'MCP agents'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
      },
    });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    const mint = mock.requests.find((req) => req.url === '/api/auth/agent-token');
    const search = mock.requests.find((req) => req.url === '/api/youtube/search');
    assert.ok(mint, 'expected agent-token mint');
    assert.ok(search, 'expected youtube search retry');
    assert.equal(mint.method, 'POST');
    assert.deepEqual(mint.body.scopes, ['youtube']);
    assert.equal(mint.body.scopes.includes('x-search'), false);
    assert.equal(search.authorization, `Bearer ${SECRET}`);
    assert.deepEqual(search.body, { query: 'MCP agents', limit: 5 });
    assert.match(res.stdout, /minted youtube search worked/);
    assert.match(res.stdout, /https:\/\/www\.youtube\.com\/watch\?v=paid123/);
    assert.match(res.stdout, /Credits: 5 used, 40 remaining/);
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

test('atris youtube process mints a youtube token from the stored JWT and retries', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  writeCredentials(home, {
    token: 'stored-user-jwt',
    refresh_token: 'stored-refresh-jwt',
    email: 'owner@example.com',
    user_id: 'u-9',
    provider: 'atris',
  });

  const applyDir = path.join(dir, 'atris', 'wiki', 'briefs');
  fs.mkdirSync(applyDir, { recursive: true });
  fs.writeFileSync(path.join(applyDir, 'youtube-abc123.apply.md'), [
    'source: https://youtu.be/abc123',
    'change: commands/youtube.js',
    'receipt: node --test test/billed-command-auth.test.js',
    '',
  ].join('\n'));

  const mock = await startHttpMock((request) => {
    if (request.url === '/api/auth/validate') {
      return { status: 200, body: { valid: false, error: 'Token expired' } };
    }
    if (request.url === '/api/auth/refresh') {
      return { status: 401, body: { error: 'refresh expired' } };
    }
    if (request.url === '/api/auth/agent-token') {
      return {
        status: 200,
        body: {
          access_token: SECRET,
          token_type: 'agent_access',
          scopes: ['youtube'],
          daily_credit_cap: 50,
        },
      };
    }
    if (request.url === '/api/agent/process_youtube') {
      return {
        status: 200,
        body: {
          status: 'success',
          message: 'ok',
          video_analysis: 'minted youtube worked',
          credits_used: 5,
          credits_remaining: 40,
        },
      };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(['youtube', 'process', 'https://youtu.be/abc123'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
      },
    });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    const mint = mock.requests.find((req) => req.url === '/api/auth/agent-token');
    const processCall = mock.requests.find((req) => req.url === '/api/agent/process_youtube');
    assert.ok(mint, 'expected agent-token mint');
    assert.ok(processCall, 'expected youtube process retry');
    assert.deepEqual(mint.body.scopes, ['youtube']);
    assert.equal(mint.body.scopes.includes('x-search'), false);
    assert.equal(processCall.authorization, `Bearer ${SECRET}`);
    assert.match(res.stdout, /minted youtube worked/);
    assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, new RegExp(SECRET));
    assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, /Choose login method|Opening browser|\/auth\/cli/);

    const stored = readCredentials(home);
    assert.equal(stored.token, 'stored-user-jwt');
    assert.equal(stored.agent_token, SECRET);
    assert.equal(stored.refresh_token, 'stored-refresh-jwt');
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris youtube process uses a login-field scoped token and does not remint', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  writeCredentials(home, { token: youtubeAgent, provider: 'atris' });

  const applyDir = path.join(dir, 'atris', 'wiki', 'briefs');
  fs.mkdirSync(applyDir, { recursive: true });
  fs.writeFileSync(path.join(applyDir, 'youtube-abc123.apply.md'), [
    'source: https://youtu.be/abc123',
    'change: commands/youtube.js',
    'receipt: node --test test/billed-command-auth.test.js',
    '',
  ].join('\n'));

  const mock = await startHttpMock((request) => {
    if (request.url === '/api/auth/agent-token') {
      return { status: 500, body: { error: 'scoped login must not remint' } };
    }
    if (request.url === '/api/agent/process_youtube') {
      assert.equal(request.authorization, `Bearer ${youtubeAgent}`);
      return {
        status: 200,
        body: {
          status: 'success',
          message: 'ok',
          video_analysis: 'scoped login youtube worked',
          credits_used: 5,
          credits_remaining: 40,
        },
      };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(['youtube', 'process', 'https://youtu.be/abc123'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
      },
    });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.equal(mock.requests.some((req) => req.url === '/api/auth/agent-token'), false);
    const processCall = mock.requests.find((req) => req.url === '/api/agent/process_youtube');
    assert.ok(processCall, 'expected youtube process');
    assert.equal(processCall.authorization, `Bearer ${youtubeAgent}`);
    assert.match(res.stdout, /scoped login youtube worked/);
    assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, /Refusing to save a scoped agent token/);
    assert.equal(readCredentials(home).token, youtubeAgent);
    assert.equal(readCredentials(home).agent_token, undefined);
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris x-search with a youtube-only scoped login token stays off remint and the paid pull', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  writeCredentials(home, { token: youtubeAgent, provider: 'atris' });

  const mock = await startHttpMock((request) => {
    return { status: 500, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(['x-search', 'MCP agents'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
      },
    });
    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    const text = `${res.stdout}\n${res.stderr}`;
    assert.match(text, /not signed in\. run atris login first\./);
    assert.doesNotMatch(text, /Refusing to save a scoped agent token/);
    assert.equal(mock.requests.length, 0);
    assert.equal(readCredentials(home).token, youtubeAgent);
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris youtube process uses a leftover youtube placed token and does not remint', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const placedToken = 'fresh-placed-youtube-token';
  const tokenFile = writePlacedToken(dir, {
    token: placedToken,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    scopes: ['youtube'],
  });
  writeProcessApply(dir);

  const mock = await startHttpMock((request) => {
    if (request.url === '/api/auth/validate') {
      return { status: 401, body: { error: 'placed leftover is not a user jwt' } };
    }
    if (request.url === '/api/auth/agent-token') {
      return { status: 500, body: { error: 'placed leftover must not remint' } };
    }
    if (request.url === '/api/agent/process_youtube') {
      assert.equal(request.authorization, `Bearer ${placedToken}`);
      return {
        status: 200,
        body: {
          status: 'success',
          message: 'ok',
          video_analysis: 'placed leftover youtube worked',
          credits_used: 5,
          credits_remaining: 40,
        },
      };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(['youtube', 'process', 'https://youtu.be/abc123'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_AGENT_TOKEN_FILE: tokenFile,
        ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
      },
    });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.equal(mock.requests.some((req) => req.url === '/api/auth/agent-token'), false);
    const processCall = mock.requests.find((req) => req.url === '/api/agent/process_youtube');
    assert.ok(processCall, 'expected youtube process');
    assert.equal(processCall.authorization, `Bearer ${placedToken}`);
    assert.match(res.stdout, /placed leftover youtube worked/);
    assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, /Refusing to save a scoped agent token/);
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris youtube process with an x-search-only placed leftover stays off remint and the paid pull', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const tokenFile = writePlacedToken(dir, {
    token: 'fresh-placed-x-search-token',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    scopes: ['x-search'],
  });
  writeProcessApply(dir);

  const mock = await startHttpMock((request) => {
    return { status: 500, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(['youtube', 'process', 'https://youtu.be/abc123'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_AGENT_TOKEN_FILE: tokenFile,
        ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
      },
    });
    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    const text = `${res.stdout}\n${res.stderr}`;
    assert.match(text, /not signed in\. run atris login first\./);
    assert.doesNotMatch(text, /Refusing to save a scoped agent token/);
    assert.equal(mock.requests.some((req) => req.url === '/api/auth/agent-token'), false);
    assert.equal(mock.requests.some((req) => req.url === '/api/agent/process_youtube'), false);
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
