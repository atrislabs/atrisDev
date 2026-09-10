const os = require('os');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const readline = require('readline');

/**
 * Open a URL in the system's default browser.
 * @param {string} url - URL to open
 */
function openBrowser(url) {
  const platform = os.platform();
  // Sanitize URL to prevent shell injection — only allow valid URL characters
  const sanitizedUrl = url.replace(/[^a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/g, '');
  let command;

  if (platform === 'darwin') {
    command = `open "${sanitizedUrl}"`;
  } else if (platform === 'win32') {
    command = `start "" "${sanitizedUrl}"`;
  } else {
    command = `xdg-open "${sanitizedUrl}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.log(`\nCouldn't open browser automatically. Please visit:\n${url}`);
    }
  });
}

// Shared readline for piped input
let sharedRl = null;
let inputLines = [];
let inputIndex = 0;

/**
 * Prompt the user for input, handling both TTY and piped input.
 * @param {string} question - Prompt text to display
 * @returns {Promise<string>} User's input
 */
function promptUser(question) {
  // If stdin is not a TTY (piped input), read all lines upfront
  if (!process.stdin.isTTY && inputLines.length === 0 && !sharedRl) {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => data += chunk);
      process.stdin.on('error', () => {
        inputLines = [];
        resolve('');
      });
      process.stdin.on('end', () => {
        inputLines = data.trim().split('\n');
        process.stdout.write(question);
        const answer = inputLines[inputIndex++] || '';
        console.log(answer);
        resolve(answer.trim());
      });
      process.stdin.resume();
    });
  }

  // If we already have buffered lines from piped input
  if (inputLines.length > 0 && inputIndex < inputLines.length) {
    return new Promise((resolve) => {
      process.stdout.write(question);
      const answer = inputLines[inputIndex++] || '';
      console.log(answer);
      resolve(answer.trim());
    });
  }

  // Interactive TTY mode - create readline per prompt
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const TOKEN_REFRESH_BUFFER_SECONDS = 300;
const AGENT_TOKEN_EXPIRED_DETAIL = 'Agent token expired. Mint a new one: atris login --agent';

/**
 * Decode and parse the claims from a JWT token.
 * @param {string} token - JWT token string
 * @returns {Object|null} Decoded claims or null if invalid
 */
function decodeJwtClaims(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

/**
 * Get the expiration time of a JWT token in epoch seconds.
 * @param {string} token - JWT token string
 * @returns {number|null} Expiry epoch seconds or null if invalid
 */
function getTokenExpiryEpochSeconds(token) {
  const claims = decodeJwtClaims(token);
  if (!claims || typeof claims.exp !== 'number') {
    return null;
  }
  return claims.exp;
}

/**
 * Check if a JWT token should be refreshed based on expiry.
 * @param {string} token - JWT token string
 * @param {number} [bufferSeconds=300] - Seconds before expiry to trigger refresh
 * @returns {boolean} True if token needs refresh
 */
function shouldRefreshToken(token, bufferSeconds = TOKEN_REFRESH_BUFFER_SECONDS) {
  const exp = getTokenExpiryEpochSeconds(token);
  if (!exp) {
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return exp <= nowSeconds + bufferSeconds;
}

// Credentials management

// Create a directory owner-only (0o700). Under the default umask (0o022) a bare
// recursive mkdir yields 0o755, leaving ~/.atris and its profiles/sessions
// world-traversable so any local user can enumerate tokens and workspace ids.
function mkPrivateDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort: permissions may be unsupported on this platform.
  }
  return dir;
}

function getAtrisDir() {
  const homeDir = os.homedir();
  return mkPrivateDir(path.join(homeDir, '.atris'));
}

function getCredentialsPath() {
  return path.join(getAtrisDir(), 'credentials.json');
}

function getPlacedAgentTokenPath() {
  const override = process.env.ATRIS_AGENT_TOKEN_FILE;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.atris', 'agent-token.json');
}

function expiryTimeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadPlacedAgentToken() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getPlacedAgentTokenPath(), 'utf8'));
    const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
    if (!token || expiryTimeMs(parsed?.expires_at) === null) return null;
    return {
      token,
      expires_at: parsed.expires_at,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
      provider: null,
      source: 'agent_token_file',
    };
  } catch {
    return null;
  }
}

function leftoverStoredAgentToken(parsed, envToken) {
  if (!parsed || !envToken) return null;
  const leftover = typeof parsed.agent_token === 'string' ? parsed.agent_token.trim() : '';
  if (!leftover || leftover !== envToken) return null;
  const expiresAt = parsed.agent_token_expires_at;
  if (expiryTimeMs(expiresAt) === null) return null;
  const scopes = Array.isArray(parsed.agent_token_scopes) ? parsed.agent_token_scopes : [];
  return {
    token: leftover,
    expires_at: expiresAt,
    scopes,
    provider: null,
    source: 'env',
    agent_token: leftover,
    agent_token_scopes: scopes,
    agent_token_expires_at: expiresAt,
  };
}

function loadLeftoverCredentialsAgentToken(envToken) {
  if (!envToken) return null;
  try {
    return leftoverStoredAgentToken(JSON.parse(fs.readFileSync(getCredentialsPath(), 'utf8')), envToken);
  } catch {
    return null;
  }
}

function resolveProfileOverride(profileOverride) {
  if (!profileOverride) return null;
  if (loadProfile(profileOverride)) return profileOverride;
  const profiles = listProfiles();
  const q = String(profileOverride).toLowerCase();
  return profiles.find((name) => name.toLowerCase() === q)
    || profiles.find((name) => name.toLowerCase().startsWith(q))
    || profiles.find((name) => name.toLowerCase().includes(q))
    || null;
}

function loadLeftoverProfileAgentToken(envToken) {
  const name = resolveProfileOverride(process.env.ATRIS_PROFILE);
  if (!envToken || !name) return null;
  return leftoverStoredAgentToken(loadProfile(name), envToken);
}

function isUnexpiredCredential(credentials) {
  const expiresAt = expiryTimeMs(credentials?.expires_at);
  return expiresAt !== null && expiresAt > Date.now();
}

function getSessionsDir() {
  return mkPrivateDir(path.join(getAtrisDir(), 'sessions'));
}

function getTerminalSessionId() {
  // Unique per terminal window/tab — works across macOS terminals, tmux, VS Code, Ghostty
  const envId = process.env.TERM_SESSION_ID     // macOS Terminal.app
    || process.env.ITERM_SESSION_ID              // iTerm2
    || process.env.TMUX_PANE                     // tmux pane
    || process.env.WT_SESSION                    // Windows Terminal
    || process.env.WEZTERM_PANE;                 // WezTerm
  if (envId) return envId;

  // Universal fallback: TTY device name (unique per terminal tab on macOS/Linux)
  // Each Ghostty/iTerm/Terminal tab gets a unique /dev/ttysNNN
  try {
    // Method 1: check if stdin is a TTY and resolve its path
    if (process.stdin.isTTY) {
      const resolved = fs.realpathSync('/dev/stdin');
      if (resolved && resolved.startsWith('/dev/tty')) return resolved;
    }
  } catch {}

  try {
    // Method 2: shell out to tty command
    const { execSync } = require('child_process');
    const tty = execSync('tty', { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
    if (tty && tty !== 'not a tty' && tty.startsWith('/dev/')) return tty;
  } catch {}

  return null;
}

function sanitizeSessionId(id) {
  // Make filesystem-safe: replace non-alphanumeric with dashes, truncate
  return id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

function getSessionFilePath() {
  const sessionId = getTerminalSessionId();
  if (!sessionId) return null;
  return path.join(getSessionsDir(), `${sanitizeSessionId(sessionId)}.json`);
}

function setSessionProfile(profileName) {
  const sessionPath = getSessionFilePath();
  if (!sessionPath) {
    // No terminal session ID — fall back to global switch
    return false;
  }
  fs.writeFileSync(sessionPath, JSON.stringify({
    profile: profileName,
    set_at: new Date().toISOString(),
  }));
  return true;
}

function getSessionProfile() {
  const sessionPath = getSessionFilePath();
  if (!sessionPath || !fs.existsSync(sessionPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    return data.profile || null;
  } catch {
    return null;
  }
}

function clearSessionProfile() {
  const sessionPath = getSessionFilePath();
  if (sessionPath && fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
}

function cleanStaleSessions() {
  // Remove session files older than 7 days
  const dir = path.join(getAtrisDir(), 'sessions');
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}

function getProfilesDir() {
  return mkPrivateDir(path.join(getAtrisDir(), 'profiles'));
}

function profileNameFromEmail(email) {
  if (!email) return null;
  // "keshav@atrislabs.com" → "keshav"
  const name = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return name || null; // Guard against emails like "@domain.com"
}

function saveProfile(name, credentials) {
  const profilePath = path.join(getProfilesDir(), `${name}.json`);
  fs.writeFileSync(profilePath, JSON.stringify(credentials, null, 2));
  try { fs.chmodSync(profilePath, 0o600); } catch {}
}

function loadProfile(name) {
  const profilePath = path.join(getProfilesDir(), `${name}.json`);
  if (!fs.existsSync(profilePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch {
    return null;
  }
}

function listProfiles() {
  const dir = getProfilesDir();
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

function deleteProfile(name) {
  const profilePath = path.join(getProfilesDir(), `${name}.json`);
  if (fs.existsSync(profilePath)) {
    fs.unlinkSync(profilePath);
    return true;
  }
  return false;
}

function autoSaveProfile(credentials) {
  const name = profileNameFromEmail(credentials?.email);
  if (name) {
    saveProfile(name, credentials);
  }
}

function saveCredentials(token, refreshToken, email, userId, provider, extras = {}) {
  if (decodeJwtClaims(token)?.type === 'agent_access') {
    throw new Error('Refusing to save a scoped agent token as the login token; keep it under agent_token');
  }
  const credentialsPath = getCredentialsPath();
  const credentials = {
    ...extras,
    token,
    refresh_token: refreshToken || null,
    email: email || null,
    user_id: userId || null,
    provider: provider || null,
    saved_at: new Date().toISOString()
  };

  fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
  try {
    fs.chmodSync(credentialsPath, 0o600);
  } catch {
    // Best effort: permissions may be unsupported on this platform.
  }

  // Auto-save as named profile
  autoSaveProfile(credentials);
}

// Supplying the auth client enables asynchronous repair. Local-only readers stay synchronous.
function loadCredentials(apiRequestJson) {
  const credentials = readCredentials();
  if (!credentials || credentials.source || decodeJwtClaims(credentials.token)?.type !== 'agent_access') {
    return credentials;
  }
  if (!credentials.refresh_token) {
    console.error('atris login');
    return credentials;
  }
  if (!apiRequestJson) return credentials;
  return repairLoginCredentials(credentials, apiRequestJson);
}

async function repairLoginCredentials(credentials, apiRequestJson) {
  const refreshed = await refreshAccessToken(credentials.refresh_token, null, apiRequestJson);
  const token = refreshed.data?.access_token;
  if (!refreshed.ok || !token || decodeJwtClaims(token)?.type === 'agent_access') {
    throw new Error('Could not repair login file. Run atris login');
  }
  const claims = decodeJwtClaims(credentials.token);
  const { source_profile, ...rest } = credentials;
  const next = {
    ...rest,
    token,
    refresh_token: refreshed.data.refresh_token || credentials.refresh_token,
    agent_token: credentials.token,
    agent_token_scopes: claims.scopes || [],
    agent_token_expires_at: typeof claims.exp === 'number' ? new Date(claims.exp * 1000).toISOString() : null,
  };
  if (source_profile) saveProfile(source_profile, next);
  else saveCredentials(token, next.refresh_token, next.email, next.user_id, next.provider, next);
  console.error('Repaired login file: moved a scoped agent token aside.');
  return { ...next, ...(source_profile ? { source_profile } : {}) };
}

function readCredentials() {
  // Priority: ATRIS_TOKEN env var → placed agent token → ATRIS_PROFILE env var
  // → per-terminal session file → global credentials.json. A fresh placed token
  // overrides env when the leftover is newer or when env only repeats that
  // leftover, so billed auth still sees leftover scopes.

  // 0. Raw token injection. Headless boxes (cloud business computers) have no
  //    browser for `atris login`; the runner injects a scoped token as env
  //    instead, so no credentials file ever lands on disk.
  const envToken = process.env.ATRIS_TOKEN;
  const normalizedEnvToken = envToken && envToken.trim();
  const placedAgentToken = loadPlacedAgentToken();
  if (normalizedEnvToken && placedAgentToken && isUnexpiredCredential(placedAgentToken)) {
    // Fresh placed leftover wins over env, including when env repeats the same
    // token, so billed auth still sees leftover scopes and does not remint.
    return placedAgentToken;
  }
  if (normalizedEnvToken) {
    const leftoverCredentials = loadLeftoverCredentialsAgentToken(normalizedEnvToken);
    if (leftoverCredentials && isUnexpiredCredential(leftoverCredentials)) {
      // Env repeating leftover credentials.agent_token keeps leftover scopes
      // and expiry so billed auth does not remint.
      return leftoverCredentials;
    }
    const leftoverProfile = loadLeftoverProfileAgentToken(normalizedEnvToken);
    if (leftoverProfile && isUnexpiredCredential(leftoverProfile)) {
      // Env repeating leftover profile agent_token keeps leftover scopes
      // and expiry so billed auth does not remint.
      return leftoverProfile;
    }
    return { token: normalizedEnvToken, provider: null, source: 'env' };
  }

  // 1. Backend-placed key for per-user cloud computers. Missing, malformed,
  //    incomplete, and expired files are ignored so later sources keep their
  //    existing order.
  if (placedAgentToken && isUnexpiredCredential(placedAgentToken)) {
    return placedAgentToken;
  }

  // 2. Explicit env var override
  const profileOverride = process.env.ATRIS_PROFILE;
  if (profileOverride) {
    const profile = loadProfile(profileOverride);
    if (profile) return { ...profile, source_profile: profileOverride };
    const profiles = listProfiles();
    const q = profileOverride.toLowerCase();
    const match = profiles.find(p => p.toLowerCase() === q)
      || profiles.find(p => p.toLowerCase().startsWith(q))
      || profiles.find(p => p.toLowerCase().includes(q));
    if (match) {
      const matched = loadProfile(match);
      if (matched) return { ...matched, source_profile: match };
    }
  }

  // 3. Per-terminal session override (set by atris switch)
  const sessionProfile = getSessionProfile();
  if (sessionProfile) {
    const profile = loadProfile(sessionProfile);
    if (profile) return { ...profile, source_profile: sessionProfile };
  }

  // 4. Global credentials.json
  const credentialsPath = getCredentialsPath();

  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(credentialsPath, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed.provider) {
      parsed.provider = null;
    }
    if (!parsed.saved_at && parsed.created_at) {
      parsed.saved_at = parsed.created_at;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function deleteCredentials() {
  const credentialsPath = getCredentialsPath();

  if (fs.existsSync(credentialsPath)) {
    fs.unlinkSync(credentialsPath);
  }
}

// Token validation and refresh
async function validateAccessToken(token, apiRequestJson) {
  if (!token) {
    return { ok: false, status: 0, error: 'Missing token' };
  }
  return apiRequestJson('/auth/validate', {
    method: 'POST',
    body: { token },
    token,
  });
}

function refreshProviderHint(provider, refreshToken) {
  const hint = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (!hint) return null;
  // provider=google makes /auth/refresh skip app-JWT refresh and POST the
  // minted refresh JWT to Google OAuth, which returns google_refresh_failed.
  // Only send that hint when the stored token is actually a Google OAuth
  // refresh token (they start with 1//). Pack refresh already strips this.
  if (hint === 'google' && !String(refreshToken || '').startsWith('1//')) {
    return null;
  }
  return hint;
}

async function refreshAccessToken(refreshToken, provider, apiRequestJson) {
  if (!refreshToken) {
    return { ok: false, status: 0, error: 'Missing refresh token' };
  }
  const body = { refresh_token: refreshToken };
  const hint = refreshProviderHint(provider, refreshToken);
  if (hint) {
    body.provider = hint;
  }
  return apiRequestJson('/auth/refresh', {
    method: 'POST',
    body,
  });
}

function isAuthFailure(result) {
  const status = result && result.status;
  return status === 401 || status === 403;
}

function printAuthRequired() {
  console.error('Auth problem. Run: atris login');
  console.error('Check with: atris whoami');
}

function abortOnAuthFailure(result, printedWake = false, exitFn = (code) => process.exit(code)) {
  if (!isAuthFailure(result)) return false;
  if (printedWake) console.log('auth failed');
  printAuthRequired();
  exitFn(1);
  return true;
}

async function performTokenRefresh(credentials, apiRequestJson) {
  if (!credentials || !credentials.refresh_token) {
    return { ok: false, error: 'missing_refresh_token' };
  }

  const refreshed = await refreshAccessToken(credentials.refresh_token, credentials.provider, apiRequestJson);
  if (!refreshed.ok) {
    return { ok: false, error: refreshed.error || 'Refresh request failed' };
  }

  const accessToken = refreshed.data?.access_token;
  if (!accessToken) {
    return { ok: false, error: 'No access token returned by refresh API' };
  }

  const newRefreshToken = refreshed.data?.refresh_token || credentials.refresh_token;
  const refreshUser = refreshed.data?.user || null;
  const provider = refreshed.data?.provider || credentials.provider;
  const email = refreshUser?.email || credentials.email;
  const userId = refreshUser?.id || credentials.user_id;

  // Refreshed tokens must land in the file they were loaded from. Writing a
  // profile's refresh to the global credentials.json leaves the profile token
  // to expire permanently (every ATRIS_PROFILE session then 401s forever).
  const persistRefreshed = () => {
    if (credentials.source_profile) {
      const { source_profile, source, ...rest } = { ...credentials };
      saveProfile(credentials.source_profile, {
        ...rest,
        token: accessToken,
        refresh_token: newRefreshToken,
        email,
        user_id: userId,
        provider,
        saved_at: new Date().toISOString(),
      });
    } else {
      saveCredentials(accessToken, newRefreshToken, email, userId, provider, credentials);
    }
  };

  persistRefreshed();
  let latestCreds = loadCredentials();

  const validation = await validateAccessToken(accessToken, apiRequestJson);
  let finalUser = refreshUser;

  if (validation.ok && validation.data?.valid) {
    finalUser = validation.data.user || refreshUser || null;
    const updatedEmail = finalUser?.email || latestCreds?.email || email;
    const updatedProvider = finalUser?.provider || latestCreds?.provider || provider;
    const updatedUserId = finalUser?.id || latestCreds?.user_id || userId;

    if (
      !latestCreds ||
      updatedEmail !== latestCreds.email ||
      updatedProvider !== latestCreds.provider ||
      updatedUserId !== latestCreds.user_id
    ) {
      if (credentials.source_profile) {
        const { source_profile, source, ...rest } = { ...credentials };
        saveProfile(credentials.source_profile, {
          ...rest,
          token: accessToken,
          refresh_token: newRefreshToken,
          email: updatedEmail,
          user_id: updatedUserId,
          provider: updatedProvider,
          saved_at: new Date().toISOString(),
        });
      } else {
        saveCredentials(accessToken, newRefreshToken, updatedEmail, updatedUserId, updatedProvider, credentials);
      }
      latestCreds = loadCredentials();
    }
  }

  return {
    ok: true,
    payload: {
      credentials: latestCreds || loadCredentials(),
      user: finalUser,
      source: 'refreshed',
    },
  };
}

async function ensureValidCredentials(apiRequestJson, options = {}) {
  let credentials = await loadCredentials(apiRequestJson);
  if (!credentials || !credentials.token) {
    return { error: 'not_logged_in' };
  }

  const selectedExpiry = expiryTimeMs(credentials.expires_at);
  if (selectedExpiry !== null && selectedExpiry <= Date.now()) {
    return { error: 'token_invalid', detail: AGENT_TOKEN_EXPIRED_DETAIL };
  }

  const claims = decodeJwtClaims(credentials.token);
  if (claims?.type === 'agent_access') {
    if (typeof claims.exp === 'number' && claims.exp <= Math.floor(Date.now() / 1000)) {
      return { error: 'token_invalid', detail: AGENT_TOKEN_EXPIRED_DETAIL };
    }
    // Server-side scope enforcement on every real request is unchanged and remains the actual security boundary.
    return { credentials, user: null, source: 'agent_token' };
  }

  if (credentials.refresh_token && shouldRefreshToken(credentials.token)) {
    const proactive = await performTokenRefresh(credentials, apiRequestJson);
    if (proactive.ok) {
      return proactive.payload;
    }
    credentials = loadCredentials() || credentials;
  }

  const validation = await validateAccessToken(credentials.token, apiRequestJson);
  if (validation.ok && validation.data?.valid) {
    const user = validation.data.user || null;
    const updatedEmail = user?.email || credentials.email;
    const updatedProvider = user?.provider || credentials.provider;
    const updatedUserId = user?.id || credentials.user_id;

    if (
      credentials.source !== 'env' &&
      credentials.source !== 'agent_token_file' &&
      (updatedEmail !== credentials.email ||
        updatedProvider !== credentials.provider ||
        updatedUserId !== credentials.user_id)
    ) {
      if (credentials.source_profile) {
        const { source_profile, source, ...rest } = { ...credentials };
        saveProfile(credentials.source_profile, {
          ...rest,
          email: updatedEmail,
          user_id: updatedUserId,
          provider: updatedProvider,
          saved_at: new Date().toISOString(),
        });
      } else {
        saveCredentials(
          credentials.token,
          credentials.refresh_token,
          updatedEmail,
          updatedUserId,
          updatedProvider,
          credentials
        );
      }
    }

    return {
      credentials: loadCredentials(),
      user,
      source: 'access_token',
    };
  }

  if (!credentials.refresh_token) {
    return { error: 'token_invalid', detail: validation.error || 'Token expired' };
  }

  const refreshed = await performTokenRefresh(credentials, apiRequestJson);
  if (!refreshed.ok) {
    return { error: 'refresh_failed', detail: refreshed.error };
  }

  return refreshed.payload;
}

async function fetchMyAgents(token, apiRequestJson) {
  if (!token) {
    return null;
  }

  const response = await apiRequestJson('/agent/my-agents', {
    method: 'GET',
    token,
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(response.error || 'Failed to fetch agents');
  }

  return response.data;
}

async function displayAccountSummary(apiRequestJson) {
  const ensured = await ensureValidCredentials(apiRequestJson);

  if (ensured.error) {
    console.log('Status: Not logged in');
    if (ensured.detail) {
      console.log(`Reason: ${ensured.detail}`);
    }
    return { error: ensured.error, detail: ensured.detail };
  }

  const { credentials, user } = ensured;
  const email = user?.email || credentials?.email || 'unknown';
  const userId = user?.id || credentials?.user_id || 'unknown';
  const provider = user?.provider || credentials?.provider || 'unknown';
  const savedAt = credentials?.saved_at || 'unknown';

  console.log('Status: Logged in ✓');
  console.log(`Email: ${email}`);
  console.log(`User ID: ${userId}`);
  console.log(`Provider: ${provider}`);
  console.log(`Credentials saved: ${savedAt}`);

  try {
    const agentsResponse = await fetchMyAgents(credentials.token, apiRequestJson);
    if (agentsResponse && agentsResponse.my_agents) {
      const agents = agentsResponse.my_agents;
      const total = agentsResponse.total ?? agents.length;
      console.log(`Agents: ${total}`);
      agents.slice(0, 5).forEach((agent) => {
        const name = agent.name || agent.id || 'Unnamed agent';
        console.log(`  • ${name}`);
      });
      if (total > 5) {
        console.log(`  …and ${total - 5} more`);
      }
    }
  } catch (error) {
    console.log(`Agents: Unable to load (${error.message})`);
  }

  return { credentials, user };
}

module.exports = {
  AGENT_TOKEN_EXPIRED_DETAIL,
  decodeJwtClaims,
  getTokenExpiryEpochSeconds,
  shouldRefreshToken,
  getCredentialsPath,
  saveCredentials,
  loadCredentials,
  deleteCredentials,
  openBrowser,
  promptUser,
  validateAccessToken,
  refreshAccessToken,
  performTokenRefresh,
  ensureValidCredentials,
  isAuthFailure,
  abortOnAuthFailure,
  fetchMyAgents,
  displayAccountSummary,
  // Profile switching
  saveProfile,
  loadProfile,
  listProfiles,
  deleteProfile,
  profileNameFromEmail,
  // Per-terminal sessions
  getTerminalSessionId,
  getSessionsDir,
  setSessionProfile,
  getSessionProfile,
  clearSessionProfile,
  cleanStaleSessions,
};
