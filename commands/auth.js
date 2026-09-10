const { AGENT_TOKEN_EXPIRED_DETAIL, decodeJwtClaims, loadCredentials, saveCredentials, deleteCredentials, getCredentialsPath, openBrowser, promptUser, displayAccountSummary, ensureValidCredentials, loadProfile, listProfiles, profileNameFromEmail, deleteProfile, saveProfile, getTokenExpiryEpochSeconds, getTerminalSessionId, setSessionProfile, getSessionProfile, clearSessionProfile, cleanStaleSessions, getSessionsDir } = require('../utils/auth');
const { getAppBaseUrl, apiRequestJson } = require('../utils/api');
const { isNonInteractive, wantsJson } = require('../lib/noninteractive');
const { hasFlag, readFlag } = require('../lib/arg-parser');
const fs = require('fs');
const path = require('path');

const AGENT_TOKEN_PATH = '/auth/agent-token';
const DEFAULT_AGENT_SCOPES = ['x-search', 'youtube'];
const DEFAULT_DAILY_CREDIT_CAP = 50;
const NO_STORED_JWT_MESSAGE = 'not signed in. run atris login first.';

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function wantsAgentToken(args = []) {
  if (hasFlag(args, '--agent')) return true;
  const first = args.find((arg) => arg && !String(arg).startsWith('-'));
  return first === 'agent-token';
}

function parseScopeList(raw) {
  if (!raw) return [...DEFAULT_AGENT_SCOPES];
  const scopes = String(raw).split(',').map((part) => part.trim()).filter(Boolean);
  if (scopes.length === 0) {
    throw new Error('scopes must list at least one value');
  }
  return scopes;
}

function parseDailyCreditCap(args) {
  const present = args.some((arg) => arg === '--daily-credit-cap' || String(arg).startsWith('--daily-credit-cap='));
  const raw = readFlag(args, '--daily-credit-cap', '');
  if (!present) return DEFAULT_DAILY_CREDIT_CAP;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('daily credit cap must be a positive integer');
  }
  return value;
}

function parseAgentTokenArgs(args = []) {
  return {
    agent: wantsAgentToken(args),
    scopes: parseScopeList(readFlag(args, '--scopes', '')),
    dailyCreditCap: parseDailyCreditCap(args),
    json: wantsJson(args),
    help: hasFlag(args, '--help') || hasFlag(args, '-h') || args[0] === 'help',
  };
}

function extractAgentAccessToken(data) {
  if (!data || typeof data !== 'object') return null;
  return firstNonEmptyString(
    data.access_token,
    data.token,
    data.agent_access,
    data.agent_token,
    data.agent_access_token,
  );
}

function expiryFromValue(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  return null;
}

function extractAgentTokenMeta(data, requested, token) {
  const payload = data && typeof data === 'object' ? data : {};
  const scopes = Array.isArray(payload.scopes) && payload.scopes.length
    ? payload.scopes.map(String)
    : requested.scopes;
  const rawCap = payload.daily_credit_cap;
  const dailyCreditCap = Number.isFinite(Number(rawCap)) ? Number(rawCap) : requested.dailyCreditCap;
  const expiresAt = expiryFromValue(payload.expires_at ?? payload.expiry ?? payload.expires ?? payload.exp)
    || expiryFromValue(getTokenExpiryEpochSeconds(token));
  return { scopes, dailyCreditCap, expiresAt };
}

function isAgentAccessToken(token) {
  return decodeJwtClaims(token)?.type === 'agent_access';
}

function scopedTokenCandidate(credentials = {}) {
  if (credentials.agent_token) return credentials.agent_token;
  if (
    credentials.source === 'env'
    || credentials.source === 'agent_token_file'
    || isAgentAccessToken(credentials.token)
  ) {
    return firstNonEmptyString(credentials.token);
  }
  return null;
}

function canMintFromLogin(credentials = {}) {
  if (credentials.source === 'agent_token_file') return false;
  const login = firstNonEmptyString(credentials.token);
  const refresh = firstNonEmptyString(credentials.refresh_token);
  if (isAgentAccessToken(login) && !refresh) return false;
  return Boolean(login || refresh);
}

function persistMintedAgentToken(credentials, token, extras = {}) {
  if (isAgentAccessToken(credentials.token)) {
    throw new Error('Refusing to save a scoped agent token as the login token; keep it under agent_token');
  }
  const next = {
    ...credentials,
    refresh_token: extras.refresh_token || credentials.refresh_token || null,
    agent_token: token,
    agent_token_scopes: extras.scopes || [],
    agent_token_expires_at: extras.expiresAt || null,
  };
  if (credentials.source_profile) {
    saveProfile(credentials.source_profile, next);
    return next;
  }
  saveCredentials(next.token, next.refresh_token, next.email, next.user_id, next.provider, next);
  return next;
}

function printAgentTokenMint(meta, output) {
  output('minted scoped agent token');
  output(`scopes: ${meta.scopes.join(', ')}`);
  output(`daily credit cap: ${meta.dailyCreditCap}`);
  if (meta.expiresAt) output(`expires: ${meta.expiresAt}`);
}

function redactSecret(text, secret) {
  if (!secret || !text) return text;
  return String(text).split(secret).join('[redacted]');
}

async function postAgentToken(api, token, body) {
  return api(AGENT_TOKEN_PATH, {
    method: 'POST',
    token,
    body,
    retries: 0,
  });
}

async function mintScopedAgentToken(requested = {}, deps = {}) {
  const api = deps.apiRequestJson || apiRequestJson;
  const load = deps.loadCredentials || loadCredentials;
  const persist = deps.persistMintedAgentToken || persistMintedAgentToken;
  const now = deps.now || (() => new Date().toISOString());

  const scopes = Array.isArray(requested.scopes)
    ? requested.scopes.map((part) => String(part).trim()).filter(Boolean)
    : parseScopeList(requested.scopes);
  if (scopes.length === 0) {
    return { ok: false, code: 'invalid_scopes', error: 'scopes must list at least one value' };
  }
  const dailyCreditCap = Number.isInteger(requested.dailyCreditCap) && requested.dailyCreditCap > 0
    ? requested.dailyCreditCap
    : DEFAULT_DAILY_CREDIT_CAP;

  const credentials = await load(api) || {};
  const accessToken = firstNonEmptyString(credentials.token);
  const refreshToken = firstNonEmptyString(credentials.refresh_token);
  if (!canMintFromLogin(credentials)) {
    return { ok: false, code: 'not_logged_in', error: NO_STORED_JWT_MESSAGE };
  }

  const body = {
    scopes,
    daily_credit_cap: dailyCreditCap,
  };
  let authToken = isAgentAccessToken(accessToken) ? refreshToken : (accessToken || refreshToken);
  let result = await postAgentToken(api, authToken, body);
  if (!result.ok && result.status === 401 && refreshToken && authToken !== refreshToken) {
    authToken = refreshToken;
    result = await postAgentToken(api, authToken, body);
  }

  if (!result.ok) {
    const detail = redactSecret(result.error || 'agent token request failed', accessToken);
    return {
      ok: false,
      code: 'mint_failed',
      status: result.status || 0,
      error: redactSecret(detail, refreshToken),
    };
  }

  const minted = extractAgentAccessToken(result.data);
  if (!minted) {
    return { ok: false, code: 'missing_token', error: 'backend did not return an agent token' };
  }

  const meta = extractAgentTokenMeta(result.data, { scopes, dailyCreditCap }, minted);
  persist(credentials, minted, {
    ...meta,
    refresh_token: firstNonEmptyString(result.data && result.data.refresh_token) || refreshToken,
    saved_at: now(),
  });

  return {
    ok: true,
    token: minted,
    meta,
    storedIn: credentials.source_profile ? `profile ${credentials.source_profile}, agent_token` : '~/.atris/credentials.json, agent_token',
  };
}

async function ensureBilledCommandAuth(scope, deps = {}) {
  const wanted = String(scope || '').trim();
  if (!wanted) {
    return { ok: false, error: NO_STORED_JWT_MESSAGE };
  }

  const api = deps.apiRequestJson || apiRequestJson;
  const load = deps.loadCredentials || loadCredentials;
  const mint = deps.mintScopedAgentToken || mintScopedAgentToken;

  const ensured = !deps.forceMint && deps.ensureValidCredentials
    ? await deps.ensureValidCredentials(api) : null;
  const credentials = ensured?.credentials || await load(api) || {};
  const candidate = scopedTokenCandidate(credentials);
  const claims = decodeJwtClaims(candidate);
  const scopes = claims?.scopes || credentials.agent_token_scopes || credentials.scopes || [];
  const expiry = claims?.exp
    ? claims.exp * 1000
    : Date.parse(credentials.agent_token_expires_at || credentials.expires_at);
  if (!deps.forceMint && candidate && Array.isArray(scopes) && scopes.includes(wanted) && Number.isFinite(expiry) && expiry > Date.now()) {
    return { ok: true, token: candidate, minted: false, credentials };
  }

  if (!canMintFromLogin(credentials)) {
    return { ok: false, error: NO_STORED_JWT_MESSAGE };
  }

  const minted = await mint({ scopes: [wanted] }, deps);
  if (!minted.ok) {
    return { ok: false, error: minted.error || NO_STORED_JWT_MESSAGE };
  }
  return {
    ok: true,
    token: minted.token,
    minted: true,
    credentials: load() || credentials,
    meta: minted.meta,
  };
}

async function mintAgentToken(args = [], deps = {}) {
  const output = deps.output || console.log;
  const outputError = deps.outputError || console.error;

  let options;
  try {
    options = parseAgentTokenArgs(args);
  } catch (error) {
    const message = error.message || String(error);
    if (wantsJson(args)) {
      output(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      outputError(message);
    }
    return 1;
  }

  const minted = await mintScopedAgentToken({
    scopes: options.scopes,
    dailyCreditCap: options.dailyCreditCap,
  }, deps);

  if (!minted.ok) {
    if (options.json) {
      output(JSON.stringify({
        ok: false,
        error: minted.code === 'not_logged_in' ? 'not_logged_in' : minted.error,
        next: minted.code === 'not_logged_in' ? 'atris login' : undefined,
        status: minted.status || undefined,
      }, null, 2));
    } else if (minted.code === 'not_logged_in') {
      output('not signed in. run atris login first, then atris login --agent.');
    } else {
      outputError(minted.error);
    }
    return 1;
  }

  if (options.json) {
    output(JSON.stringify({
      ok: true,
      minted: true,
      stored_in: minted.storedIn,
      scopes: minted.meta.scopes,
      daily_credit_cap: minted.meta.dailyCreditCap,
      expires_at: minted.meta.expiresAt,
    }, null, 2));
    return 0;
  }

  printAgentTokenMint(minted.meta, output);
  output(`stored in ${minted.storedIn}`);
  return 0;
}

async function printWhoamiPayload(asJson) {
  const ensured = await ensureValidCredentials(apiRequestJson);
  if (ensured.error) {
    if (!asJson && ensured.detail === AGENT_TOKEN_EXPIRED_DETAIL) {
      console.error('the agent key expired.');
      console.error('atris login --agent');
      process.exit(1);
    }
    if (asJson) {
      console.log(JSON.stringify({
        ok: false,
        logged_in: false,
        error: ensured.error,
        detail: ensured.detail || null,
      }, null, 2));
    } else {
      console.log('Status: Not logged in');
      if (ensured.detail) console.log(`Reason: ${ensured.detail}`);
      console.log('\nRun "atris login" to sign in.');
    }
    process.exit(1);
  }

  const { credentials, user } = ensured;
  const email = user?.email || credentials?.email || 'unknown';
  const userId = user?.id || credentials?.user_id || 'unknown';
  const provider = user?.provider || credentials?.provider || 'unknown';
  const savedAt = credentials?.saved_at || 'unknown';
  const payload = {
    ok: true,
    logged_in: true,
    email,
    user_id: userId,
    provider,
    credentials_saved: savedAt,
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  const summary = await displayAccountSummary(apiRequestJson);
  if (summary.error) {
    console.log('\nRun "atris login" to sign in.');
    process.exit(1);
  }
  process.exit(0);
}

async function loginAtris(options = {}) {
  // Support: atris login --token <token> --force
  const args = process.argv.slice(3);
  const forceFlag = args.includes('--force') || args.includes('-f') || options.force;
  const tokenIndex = args.indexOf('--token');
  const directToken = tokenIndex !== -1 ? args[tokenIndex + 1] : options.token;
  const asJson = wantsJson(args);
  const nonInteractive = isNonInteractive(args);

  try {
    const existing = loadCredentials();

    if (wantsAgentToken(args)) {
      if (directToken) {
        saveCredentials(
          String(directToken).trim(),
          existing?.refresh_token || null,
          existing?.email || null,
          existing?.user_id || null,
          existing?.provider || 'manual',
        );
      }
      const code = await mintAgentToken(args);
      process.exit(code);
    }

    // Direct token mode (non-interactive)
    if (directToken) {
      const trimmed = directToken.trim();
      saveCredentials(trimmed, null, existing?.email || null, existing?.user_id || null, existing?.provider || 'manual');
      if (asJson) {
        return printWhoamiPayload(true);
      }
      console.log('Token saved. Validating…\n');
      const summary = await displayAccountSummary(apiRequestJson);
      if (summary.error) {
        console.log('\n⚠️ Token saved, but validation failed.');
        process.exit(1);
      }
      console.log('\n✓ Logged in successfully.');
      process.exit(0);
    }

    // Already signed in without --force: behave like whoami (no menu).
    // Print local identity without waiting on the network so headless agents
    // never hang on a stale token validation.
    if (existing && !forceFlag) {
      const email = existing.email || null;
      const userId = existing.user_id || null;
      const provider = existing.provider || null;
      if (asJson) {
        console.log(JSON.stringify({
          ok: true,
          logged_in: true,
          email,
          user_id: userId,
          provider,
          credentials_saved: existing.saved_at || null,
          next: 'atris whoami --json',
        }, null, 2));
        process.exit(0);
      }
      console.log(`Currently signed in as: ${email || userId || 'unknown'}`);
      if (provider) console.log(`Provider: ${provider}`);
      console.log('Next: atris whoami');
      process.exit(0);
    }

    if (nonInteractive) {
      if (asJson) {
        console.log(JSON.stringify({
          ok: false,
          logged_in: false,
          error: 'login requires --token in non-interactive mode',
          next: 'atris login --token <token>',
        }, null, 2));
      } else {
        console.log('Not signed in.');
        console.log('login needs a terminal for browser OAuth, or pass a token.');
        console.log('Next: atris login --token <token>');
      }
      process.exit(1);
    }

    if (!existing) {
      console.log('Welcome to Atris! Let\'s get you signed in.\n');
    }

    console.log('Choose login method:');
    console.log('  1. Browser OAuth (recommended)');
    console.log('  2. Paste existing API token');
    console.log('  3. Cancel');

    const methodChoice = await promptUser('\nEnter choice (1-3): ');

    if (methodChoice === '1') {
      const loginUrl = `${getAppBaseUrl()}/auth/cli`;
      console.log('\nOpening browser…');
      console.log('If it doesn\'t open, visit:');
      console.log(`  ${loginUrl}\n`);
      console.log('After signing in, paste the CLI code shown in the browser.\n');

      openBrowser(loginUrl);

      const code = await promptUser('CLI code: ');
      if (!code) {
        console.error('Error: Code is required.');
        process.exit(1);
      }

      const exchange = await apiRequestJson('/auth/cli/exchange', {
        method: 'POST',
        body: { code: code.trim() },
      });

      if (!exchange.ok || !exchange.data) {
        console.error(`Error: ${exchange.error || 'Invalid or expired code'}`);
        process.exit(1);
      }

      const payload = exchange.data;
      const token = payload.token;
      const refreshToken = payload.refresh_token;

      if (!token || !refreshToken) {
        console.error('Error: Backend did not return tokens. Try again.');
        process.exit(1);
      }

      const email = payload.email || null;
      const userId = payload.user_id || null;
      const provider = payload.provider || 'atris';

      saveCredentials(token, refreshToken, email, userId, provider);
      const name = profileNameFromEmail(email);
      console.log(`\n✓ Signed in as ${email || 'unknown'}${name ? ` (profile: ${name})` : ''}`);
      await displayAccountSummary(apiRequestJson);
      process.exit(0);
    } else if (methodChoice === '2') {
      console.log('\nGet your token from: https://atris.ai/auth/cli\n');

      const tokenInput = await promptUser('API token: ');

      if (!tokenInput) {
        console.error('Error: Token is required.');
        process.exit(1);
      }

      const trimmed = tokenInput.trim();
      saveCredentials(trimmed, null, existing?.email || null, existing?.user_id || null, existing?.provider || 'manual');
      console.log('\nValidating…\n');

      const summary = await displayAccountSummary(apiRequestJson);
      if (summary.error) {
        console.log('\n⚠️ Token saved, but validation failed.');
      } else {
        console.log('\n✓ Token validated.');
      }

      process.exit(0);
    } else {
      console.log('Cancelled.');
      process.exit(0);
    }
  } catch (error) {
    console.error(`\nLogin failed: ${error.message || error}`);
    process.exit(1);
  }
}

function logoutAtris() {
  const credentials = loadCredentials();

  if (!credentials) {
    console.log('Not signed in.');
    process.exit(0);
  }

  const profiles = listProfiles();
  const currentName = profileNameFromEmail(credentials?.email);

  deleteCredentials();
  console.log(`✓ Signed out from ${credentials.email || 'current account'}`);

  // Remind about other profiles
  const remaining = profiles.filter(p => p !== currentName);
  if (remaining.length > 0) {
    console.log(`\n${remaining.length} other account${remaining.length > 1 ? 's' : ''} saved.`);
    console.log(`Switch to one: atris switch ${remaining[0]}`);
    console.log('Or remove all: atris accounts remove --all');
  }
}

async function whoamiAtris() {
  const args = process.argv.slice(3);
  const asJson = wantsJson(args);

  try {
    return await printWhoamiPayload(asJson);
  } catch (error) {
    if (asJson) {
      console.log(JSON.stringify({
        ok: false,
        logged_in: false,
        error: error.message || String(error),
      }, null, 2));
    } else {
      console.error(`Failed to fetch account: ${error.message || error}`);
    }
    process.exit(1);
  }
}

async function switchAccount() {
  const args = process.argv.slice(3);
  const globalFlag = args.includes('--global') || args.includes('-g');
  const targetName = args.filter(a => !a.startsWith('-'))[0];

  // Clean up stale session files in the background
  cleanStaleSessions();

  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log('No saved accounts. Run "atris login" to add one.');
    process.exit(1);
  }

  const current = loadCredentials();
  const currentName = profileNameFromEmail(current?.email);

  if (!targetName) {
    // Interactive: show list and let user pick
    console.log('Switch account:\n');
    profiles.forEach((name, i) => {
      const profile = loadProfile(name);
      const email = profile?.email || 'unknown';
      const marker = name === currentName ? '  ← active' : '';
      console.log(`  ${i + 1}. ${name}, ${email}${marker}`);
    });
    console.log(`  ${profiles.length + 1}. Add new account`);
    console.log(`  ${profiles.length + 2}. Cancel`);

    const choice = await promptUser(`\nChoice (1-${profiles.length + 2}): `);
    const idx = parseInt(choice, 10) - 1;

    if (idx === profiles.length) {
      // Add new account
      return loginAtris({ force: true });
    }

    if (isNaN(idx) || idx < 0 || idx >= profiles.length) {
      console.log('Cancelled.');
      process.exit(0);
    }

    const chosen = profiles[idx];
    return activateProfile(chosen, currentName, { global: globalFlag });
  }

  // Direct: atris switch <name>
  // Fuzzy match: exact → startsWith → substring → email substring
  const q = targetName.toLowerCase();
  const match = profiles.find(p => p.toLowerCase() === q)
    || profiles.find(p => p.toLowerCase().startsWith(q))
    || profiles.find(p => p.toLowerCase().includes(q))
    || profiles.find(p => {
      const profile = loadProfile(p);
      return profile?.email?.toLowerCase().includes(q);
    });

  if (!match) {
    console.error(`No account matching "${targetName}".`);
    console.log(`Available: ${profiles.join(', ')}`);
    process.exit(1);
  }

  return activateProfile(match, currentName, { global: globalFlag });
}

function activateProfile(name, currentName, { global = false } = {}) {
  if (name === currentName) {
    console.log(`Already on "${name}".`);
    process.exit(0);
  }

  const profile = loadProfile(name);
  if (!profile || !profile.token) {
    console.error(`Profile "${name}" is corrupted. Run "atris login" to fix.`);
    process.exit(1);
  }

  if (global || !getTerminalSessionId()) {
    // Global switch, write to credentials.json (affects all terminals)
    const credentialsPath = getCredentialsPath();
    fs.writeFileSync(credentialsPath, JSON.stringify(profile, null, 2));
    try { fs.chmodSync(credentialsPath, 0o600); } catch {}
    console.log(`Switched to ${profile.email || name} (global, all terminals)`);
  } else {
    // Per-terminal switch, write session file (only this terminal)
    setSessionProfile(name);
    console.log(`Switched to ${profile.email || name}`);
  }
}

function useAccount() {
  const args = process.argv.slice(3);
  const targetName = args.filter(a => !a.startsWith('-'))[0];

  if (!targetName) {
    // Show current per-terminal override or global
    const envProfile = process.env.ATRIS_PROFILE;
    if (envProfile) {
      const profile = loadProfile(envProfile);
      const email = profile?.email || envProfile;
      console.log(`This terminal: ${email} (ATRIS_PROFILE=${envProfile})`);
    } else {
      const current = loadCredentials();
      if (current) {
        console.log(`Global: ${current.email || 'unknown'} (no per-terminal override)`);
      } else {
        console.log('Not signed in.');
      }
    }
    console.log('\nSet per-terminal account:');
    console.log('  eval "$(atris use <name>)"');
    console.log('\nOr manually:');
    console.log('  export ATRIS_PROFILE=<name>');
    process.exit(0);
  }

  // Fuzzy match the profile
  const profiles = listProfiles();
  const q = targetName.toLowerCase();
  const match = profiles.find(p => p.toLowerCase() === q)
    || profiles.find(p => p.toLowerCase().startsWith(q))
    || profiles.find(p => p.toLowerCase().includes(q))
    || profiles.find(p => {
      const profile = loadProfile(p);
      return profile?.email?.toLowerCase().includes(q);
    });

  if (!match) {
    console.error(`No account matching "${targetName}".`);
    console.error(`Available: ${profiles.join(', ')}`);
    process.exit(1);
  }

  const profile = loadProfile(match);
  const email = profile?.email || match;

  // If stdout is piped (eval mode), output just the export
  if (!process.stdout.isTTY) {
    process.stdout.write(`export ATRIS_PROFILE=${match}\n`);
  } else {
    // Interactive, print instructions
    console.log(`export ATRIS_PROFILE=${match}`);
    console.log(`\n# Run this to activate ${email} in this terminal:`);
    console.log(`#   eval "$(atris use ${targetName})"`);
    console.log(`# Or just copy the export line above.`);
  }
}

async function accountsCmd(argv = null) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(3);
  const { parseScopeFlag } = require('../lib/cli-scope');
  const scope = parseScopeFlag(args);
  const subCmd = scope.args[0];

  if (subCmd === 'add' || subCmd === 'login') {
    return loginAtris({ force: true });
  }

  if (subCmd === 'remove' || subCmd === 'rm') {
    const target = scope.args[1];
    if (target === '--all') {
      const profiles = listProfiles();
      if (profiles.length === 0) {
        console.log('No accounts to remove.');
        process.exit(0);
      }
      const confirm = await promptUser(`Remove all ${profiles.length} accounts? (y/N): `);
      if (confirm.toLowerCase() !== 'y') {
        console.log('Cancelled.');
        process.exit(0);
      }
      profiles.forEach(p => deleteProfile(p));
      deleteCredentials();
      console.log(`✓ Removed ${profiles.length} ${profiles.length === 1 ? 'account' : 'accounts'}.`);
      process.exit(0);
    }
    if (!target) {
      console.log('Usage: atris accounts remove <name>');
      console.log('       atris accounts remove --all');
      process.exit(1);
    }
    // Fuzzy match
    const profiles = listProfiles();
    const q = target.toLowerCase();
    const match = profiles.find(p => p.toLowerCase() === q)
      || profiles.find(p => p.toLowerCase().startsWith(q))
      || profiles.find(p => p.toLowerCase().includes(q));
    if (!match) {
      console.error(`No account matching "${target}".`);
      console.log(`Available: ${profiles.join(', ')}`);
      process.exit(1);
    }
    const profile = loadProfile(match);
    const email = profile?.email || 'unknown';
    const confirm = await promptUser(`Remove ${match} (${email})? (y/N): `);
    if (confirm.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      process.exit(0);
    }
    deleteProfile(match);
    // If this was the active account, clear credentials
    const current = loadCredentials();
    if (current && profileNameFromEmail(current.email) === match) {
      deleteCredentials();
      const remaining = listProfiles();
      if (remaining.length > 0) {
        console.log(`✓ Removed ${email}. No active account.`);
        console.log(`Switch to another: atris switch ${remaining[0]}`);
      } else {
        console.log(`✓ Removed ${email}. No accounts remaining.`);
        console.log('Run "atris login" to add one.');
      }
    } else {
      console.log(`✓ Removed ${email}.`);
    }
    process.exit(0);
  }

  // Default: list accounts (workspace = active only; --global = all profiles)
  return listAccountsCmd({ global: scope.global, json: scope.args.includes('--json') || args.includes('--json') });
}

function listAccountsCmd(options = {}) {
  const profiles = listProfiles();
  const current = loadCredentials();
  const currentUid = current?.user_id;
  const envProfile = process.env.ATRIS_PROFILE;
  const sessionProfile = getSessionProfile();
  const scopeKind = options.global ? 'global' : 'workspace';

  const rows = profiles.map((name) => {
    const profile = loadProfile(name);
    const email = profile?.email || 'unknown';
    const isActive = profile?.user_id === currentUid
      || name === envProfile
      || name === sessionProfile;
    return { name, email, active: Boolean(isActive) };
  });

  const visible = options.global ? rows : rows.filter((row) => row.active);

  if (options.json) {
    console.log(JSON.stringify({
      scope: scopeKind,
      accounts: visible,
      total_profiles: profiles.length,
    }, null, 2));
    process.exit(0);
  }

  if (visible.length === 0) {
    if (profiles.length === 0) {
      console.log('No accounts saved. Run "atris login" to add one.');
    } else {
      console.log('No active account in this workspace.');
      console.log('Pass --global to list all saved profiles, or atris switch <name>.');
    }
    process.exit(0);
  }

  console.log(`\n  Accounts (${scopeKind})\n`);
  visible.forEach((row) => {
    if (row.active) {
      console.log(`  ● ${row.name}  ${row.email}`);
    } else {
      console.log(`    ${row.name}  ${row.email}`);
    }
  });
  if (!options.global && profiles.length > visible.length) {
    console.log(`\n  ${profiles.length - visible.length} more profile(s) hidden. Pass --global to list them.`);
  }
  console.log(`\n  Switch:  atris switch <name>`);
  console.log(`  Add:     atris accounts add`);
  console.log(`  Remove:  atris accounts remove <name>\n`);
}

function resolveProfile() {
  // Hidden command: atris _resolve <query> → prints resolved profile name
  const query = process.argv[3];
  if (!query) { process.exit(1); }
  const profiles = listProfiles();
  const q = query.toLowerCase();
  const match = profiles.find(p => p.toLowerCase() === q)
    || profiles.find(p => p.toLowerCase().startsWith(q))
    || profiles.find(p => p.toLowerCase().includes(q))
    || profiles.find(p => {
      const profile = loadProfile(p);
      return profile?.email?.toLowerCase().includes(q);
    });
  if (match) {
    process.stdout.write(match);
    process.exit(0);
  }
  process.exit(1);
}

function profileEmail() {
  // Hidden command: atris _profile-email <name> → prints email
  const name = process.argv[3];
  if (!name) { process.exit(1); }
  const profile = loadProfile(name);
  if (profile?.email) {
    process.stdout.write(profile.email);
    process.exit(0);
  }
  process.exit(1);
}

function activateGlobal() {
  // Hidden command: atris _activate <name> → copy profile to credentials.json
  // Called by the shell wrapper so `atris switch` persists across terminals.
  const name = process.argv[3];
  if (!name) { process.exit(1); }
  const profile = loadProfile(name);
  if (!profile || !profile.token) { process.exit(1); }
  const credentialsPath = getCredentialsPath();
  fs.writeFileSync(credentialsPath, JSON.stringify(profile, null, 2));
  try { fs.chmodSync(credentialsPath, 0o600); } catch {}
  process.exit(0);
}

function switchSession() {
  // Hidden command: atris _switch-session <name> [--session-id <id>]
  // Per-terminal switch: writes session file so each tab keeps its own account.
  // Falls back to global (credentials.json) when no session ID is available.
  const args = process.argv.slice(3);
  const name = args.filter(a => !a.startsWith('-'))[0];
  if (!name) { process.exit(1); }

  const profile = loadProfile(name);
  if (!profile || !profile.token) { process.exit(1); }

  // Accept explicit session ID from the shell wrapper (more reliable than
  // detecting it from inside a child process where TTY env vars may be missing).
  const sidIdx = args.indexOf('--session-id');
  const explicitId = sidIdx !== -1 ? args[sidIdx + 1] : null;

  if (explicitId) {
    // Write session file directly using the caller's session ID
    const sanitized = explicitId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
    const sessPath = path.join(getSessionsDir(), `${sanitized}.json`);
    fs.writeFileSync(sessPath, JSON.stringify({
      profile: name,
      set_at: new Date().toISOString(),
    }));
  } else {
    // Try to detect terminal ID from this process; fall back to global
    const termId = getTerminalSessionId();
    if (termId) {
      setSessionProfile(name);
    } else {
      // No terminal ID, global fallback
      const credentialsPath = getCredentialsPath();
      fs.writeFileSync(credentialsPath, JSON.stringify(profile, null, 2));
      try { fs.chmodSync(credentialsPath, 0o600); } catch {}
    }
  }
  process.exit(0);
}

function shellInit() {
  // Output shell function for per-terminal account switching
  // Usage: eval "$(atris shell-init)"  (add to ~/.zshrc)
  // Use array join to avoid JS template literal parsing issues with ${}
  const lines = [
    '# Atris per-terminal account switching',
    '# Added by: eval "$(atris shell-init)"',
    '_atris_session_id() {',
    '  # Detect terminal session ID, same priority as the Node.js code',
    '  local _sid="${TERM_SESSION_ID:-${ITERM_SESSION_ID:-${TMUX_PANE:-${WT_SESSION:-${WEZTERM_PANE:-}}}}}"',
    '  if [[ -n "$_sid" ]]; then echo "$_sid"; return; fi',
    '  # Fallback: TTY device (unique per macOS/Linux terminal tab)',
    '  local _tty',
    '  _tty=$(tty 2>/dev/null)',
    '  if [[ $? -eq 0 && "$_tty" == /dev/* ]]; then echo "$_tty"; return; fi',
    '}',
    'atris() {',
    '  if [[ "$1" == "switch" && -n "$2" && "$2" != "--"* ]]; then',
    '    local _profile',
    '    _profile=$(command atris _resolve "$2" 2>/dev/null)',
    '    if [[ $? -eq 0 && -n "$_profile" ]]; then',
    '      export ATRIS_PROFILE="$_profile"',
    '      local _sid',
    '      _sid=$(_atris_session_id)',
    '      if [[ -n "$_sid" ]]; then',
    '        command atris _switch-session "$_profile" --session-id "$_sid" 2>/dev/null',
    '      fi',
    '      command atris _activate "$_profile" 2>/dev/null',
    '      local _email',
    '      _email=$(command atris _profile-email "$_profile" 2>/dev/null)',
    '      echo "Switched to ${_email:-$_profile}"',
    '    else',
    '      echo "No account matching \'$2\'."',
    '      command atris accounts',
    '    fi',
    '  elif [[ "$1" == "switch" && $# -eq 1 ]]; then',
    '    command atris accounts',
    '    echo ""',
    '    printf "Switch to: "',
    '    read _pick',
    '    if [[ -n "$_pick" ]]; then',
    '      local _profile',
    '      _profile=$(command atris _resolve "$_pick" 2>/dev/null)',
    '      if [[ $? -eq 0 && -n "$_profile" ]]; then',
    '        export ATRIS_PROFILE="$_profile"',
    '        local _sid',
    '        _sid=$(_atris_session_id)',
    '        if [[ -n "$_sid" ]]; then',
    '          command atris _switch-session "$_profile" --session-id "$_sid" 2>/dev/null',
    '        fi',
    '        command atris _activate "$_profile" 2>/dev/null',
    '        local _email',
    '        _email=$(command atris _profile-email "$_profile" 2>/dev/null)',
    '        echo "Switched to ${_email:-$_profile}"',
    '      else',
    '        echo "No account matching \'$_pick\'."',
    '      fi',
    '    fi',
    '  else',
    '    command atris "$@"',
    '  fi',
    '}',
  ];
  console.log(lines.join('\n'));
}

module.exports = {
  loginAtris,
  logoutAtris,
  whoamiAtris,
  switchAccount,
  useAccount,
  accountsCmd,
  resolveProfile,
  profileEmail,
  activateGlobal,
  switchSession,
  shellInit,
  parseAgentTokenArgs,
  mintAgentToken,
  persistMintedAgentToken,
  ensureBilledCommandAuth,
  wantsAgentToken,
};
