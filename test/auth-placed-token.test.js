'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadCredentials } = require('../utils/auth');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-placed-token-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function withEnv(updates, fn) {
  const previous = {};
  for (const [name, value] of Object.entries(updates)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('fresh placed token wins over a different stale environment token', () => {
  const dir = makeTempDir();
  const tokenFile = path.join(dir, 'backend', 'agent-token.json');
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  writeJson(tokenFile, {
    token: 'fresh-placed-token',
    expires_at: expiresAt,
    scopes: ['x-search'],
  });

  try {
    withEnv({
      ATRIS_TOKEN: 'stale-baked-token',
      ATRIS_AGENT_TOKEN_FILE: tokenFile,
      ATRIS_PROFILE: undefined,
    }, () => {
      assert.deepEqual(loadCredentials(), {
        token: 'fresh-placed-token',
        expires_at: expiresAt,
        scopes: ['x-search'],
        provider: null,
        source: 'agent_token_file',
      });

      process.env.ATRIS_TOKEN = 'fresh-placed-token';
      assert.deepEqual(loadCredentials(), {
        token: 'fresh-placed-token',
        expires_at: expiresAt,
        scopes: ['x-search'],
        provider: null,
        source: 'agent_token_file',
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('expired placed token falls through to the next credential source', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  const tokenFile = path.join(home, '.atris', 'agent-token.json');
  const profileFile = path.join(home, '.atris', 'profiles', 'cloud.json');
  writeJson(tokenFile, {
    token: 'expired-placed-token',
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    scopes: ['x-search'],
  });
  writeJson(profileFile, { token: 'profile-token', provider: 'atris' });

  try {
    withEnv({
      HOME: home,
      ATRIS_TOKEN: undefined,
      ATRIS_AGENT_TOKEN_FILE: undefined,
      ATRIS_PROFILE: 'cloud',
    }, () => {
      const credentials = loadCredentials();
      assert.equal(credentials.token, 'profile-token');
      assert.equal(credentials.source_profile, 'cloud');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing and corrupt placed token files are ignored silently', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  const credentialsFile = path.join(home, '.atris', 'credentials.json');
  const tokenFile = path.join(dir, 'alternate-agent-token.json');
  writeJson(credentialsFile, { token: 'saved-token', provider: 'atris' });
  const errors = [];
  const originalError = console.error;

  try {
    console.error = (...args) => errors.push(args.join(' '));
    withEnv({
      HOME: home,
      ATRIS_TOKEN: undefined,
      ATRIS_AGENT_TOKEN_FILE: tokenFile,
      ATRIS_PROFILE: undefined,
    }, () => {
      assert.equal(loadCredentials().token, 'saved-token');
      fs.writeFileSync(tokenFile, '{not json');
      assert.equal(loadCredentials().token, 'saved-token');
    });
    assert.deepEqual(errors, []);
  } finally {
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('expired selected token prints one error and the agent re-mint command', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  writeJson(path.join(home, '.atris', 'credentials.json'), {
    token: 'expired-selected-token',
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  });

  try {
    const result = spawnSync(process.execPath, [cliPath, 'whoami'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ATRIS_NONINTERACTIVE: '1',
        ATRIS_TOKEN: '',
        ATRIS_PROFILE: '',
        ATRIS_AGENT_TOKEN_FILE: path.join(dir, 'missing-agent-token.json'),
      },
    });
    if (result.error) throw result.error;

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'the agent key expired.\natris login --agent\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
