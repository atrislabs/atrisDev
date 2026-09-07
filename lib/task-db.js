// SQLite-backed task store. node:sqlite (built-in, v22+).
// Local state layer for `atris task`. TODO.md is a regenerated human-readable
// view; this store gives agents atomic claims plus an append-only event trail.
//
// Path: ~/.atris/tasks.db (gitignored, never blobbed). Per-workspace scope via
// workspace_root column. Rows survive across machines only when explicitly
// synced (out of scope for tick 1).

'use strict';

// node:sqlite emits an ExperimentalWarning. Suppress only that exact class by
// monkey-patching process.emit at this narrow filter, other warnings (and
// any pre-existing listeners installed by host code) are untouched.
{
  const originalEmit = process.emit;
  process.emit = function patchedEmit(name, data, ...args) {
    if (name === 'warning' && data && data.name === 'ExperimentalWarning'
        && /SQLite/i.test(data.message || '')) {
      return false;
    }
    return originalEmit.apply(process, [name, data, ...args]);
  };
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const reviewIntegrity = require('./review-integrity');
const { isGenericScratchRoot } = require('./scratch-root');
const { isDecisionTask } = require('./task-decision');
const { parseVerifyCommand } = require('./auto-accept-certified');
const { taskExplanation } = require('./task-explanation');
const { treeHashFor } = require('./tree-hash');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.atris', 'tasks.db');
const TASK_EPISODES_FILE = path.join('.atris', 'state', 'task_episodes.jsonl');
const TODO_RENDER_DONE_LIMIT = 8;
const TODO_RENDER_FAILED_LIMIT = 12;
const PROJECTION_DONE_LIMIT = 8;
const PROJECTION_EVENT_LIMIT = 8;
const PROJECTION_MESSAGE_LIMIT = 6;
const PROJECTION_PAYLOAD_TEXT_LIMIT = 1000;
const AGENT_CERTIFICATION_REVIEW_PASSES = 2;
const OPEN_TASK_STATUSES = new Set(['open', 'claimed', 'review']);
const TERMINAL_MISSION_STATUSES = new Set(['complete', 'stopped']);
const TASK_REF_GENERIC_TOKENS = new Set(['app', 'atris', 'atrisos', 'project', 'repo', 'workspace']);
const TASK_PLAN_TAGS = new Set([
  'agent',
  'autopilot',
  'cron',
  'endgame',
  'execute',
  'explore',
  'feature',
  'goal',
  'goal-step',
  'loop',
  'plan',
  'planned',
  'schedule',
  'scheduled',
  'shape',
  'shaping',
  'ui',
  'ux',
]);

function todayLogName() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`;
}

function compactLogText(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function logFieldRows(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `- ${key}: ${compactLogText(value, 500)}`);
}

function taskMemberCandidates(row, actor) {
  const metadata = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return [
    metadata.assigned_to,
    metadata.stage_owner,
    metadata.planned_by,
    metadata.agent_certified_by,
    row && row.claimed_by,
    actor,
  ].map(value => String(value || '').trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function existingMemberSlug(workspaceRoot, row, actor) {
  for (const candidate of taskMemberCandidates(row, actor)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(candidate)) continue;
    const memberFile = path.join(workspaceRoot, 'atris', 'team', candidate, 'MEMBER.md');
    if (fs.existsSync(memberFile)) return candidate;
  }
  return null;
}

function appendTaskCompletionLogs(db, row, { status, actor, action, proof } = {}) {
  if (!row || !row.workspace_root || !fs.existsSync(path.join(row.workspace_root, 'atris'))) return {};
  const logName = todayLogName();
  const stamp = new Date().toTimeString().slice(0, 5);
  const allRows = listTasks(db, { workspaceRoot: row.workspace_root });
  const ref = taskDisplayRefMap(allRows).get(row.id) || shortestUniqueTaskRef(row.id, allRows.map(task => task.id), 8) || row.id;
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const proofText = compactLogText(proof || metadata.latest_agent_proof || metadata.verify || '', 500);
  const member = existingMemberSlug(row.workspace_root, row, actor);
  const title = status === 'archived' ? 'Task archived'
    : status === 'failed' ? 'Task failed'
    : action === 'accepted' ? 'Task accepted'
    : 'Task completed';
  const fields = {
    task: ref,
    title: row.title,
    status,
    action,
    tag: row.tag,
    member,
    actor,
    proof: proofText,
  };

  const projectDir = path.join(row.workspace_root, 'atris', 'logs', logName.slice(0, 4));
  fs.mkdirSync(projectDir, { recursive: true });
  const projectLogPath = path.join(projectDir, logName);
  fs.appendFileSync(projectLogPath, [
    `## ${stamp} · ${title}`,
    ...logFieldRows(fields),
    '',
  ].join('\n'), 'utf8');

  let memberLogPath = null;
  if (member) {
    const memberLogsDir = path.join(row.workspace_root, 'atris', 'team', member, 'logs');
    fs.mkdirSync(memberLogsDir, { recursive: true });
    memberLogPath = path.join(memberLogsDir, logName);
    fs.appendFileSync(memberLogPath, [
      `## ${stamp} · ${title}`,
      ...logFieldRows({ ...fields, member }),
      '',
    ].join('\n'), 'utf8');
  }

  return {
    project_log_path: projectLogPath,
    member_log_path: memberLogPath,
    member,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  tag             TEXT,
  workspace_root  TEXT NOT NULL,
  source_key      TEXT,
  claimed_by      TEXT,
  claimed_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  done_at         INTEGER,
  metadata        TEXT
);
CREATE TABLE IF NOT EXISTS task_events (
  event_id        TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  version         INTEGER NOT NULL,
  workspace_root  TEXT NOT NULL,
  actor           TEXT,
  event_type      TEXT NOT NULL,
  payload         TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace   ON tasks(workspace_root);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by  ON tasks(claimed_by);
CREATE INDEX IF NOT EXISTS idx_task_events_task  ON task_events(task_id, version);
CREATE INDEX IF NOT EXISTS idx_task_events_ws    ON task_events(workspace_root, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_source ON tasks(workspace_root, source_key)
  WHERE source_key IS NOT NULL;
`;

let _cachedDb = null;
let _cachedPath = null;

function getDbPath() {
  return process.env.ATRIS_TASKS_DB || DEFAULT_DB_PATH;
}

function open(dbPath) {
  const target = dbPath || getDbPath();
  if (_cachedDb && _cachedPath === target) return _cachedDb;
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(target);
  // Concurrency: WAL gives readers + one writer concurrency; busy_timeout
  // makes contended writers wait instead of returning SQLITE_BUSY at the
  // C library level. We additionally wrap the setup PRAGMAs + DDL in our
  // own retry, under heavy spawn-storm contention, node:sqlite leaks
  // SQLITE_BUSY past the busy_timeout for `db.exec()` calls.
  withBusyRetry(() => db.exec('PRAGMA journal_mode = WAL'));
  withBusyRetry(() => db.exec('PRAGMA busy_timeout = 30000'));
  withBusyRetry(() => db.exec('PRAGMA foreign_keys = ON'));
  withBusyRetry(() => db.exec(SCHEMA));
  // Schema version. Bump at every additive migration.
  // Future migrations read this and apply diffs idempotently.
  withBusyRetry(() => db.exec('PRAGMA user_version = 2'));
  _cachedDb = db;
  _cachedPath = target;
  return db;
}

function close() {
  if (_cachedDb) {
    try { _cachedDb.close(); } catch (_) {}
    _cachedDb = null;
    _cachedPath = null;
  }
}

// 26-char ULID-ish (sortable by time prefix). Crockford-safe alphabet.
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newId() {
  const ts = Date.now();
  let head = '';
  let n = ts;
  for (let i = 0; i < 10; i++) {
    head = ULID_ALPHABET[n % 32] + head;
    n = Math.floor(n / 32);
  }
  let tail = '';
  const rand = crypto.randomBytes(10);
  for (let i = 0; i < 16; i++) tail += ULID_ALPHABET[rand[i % rand.length] % 32];
  return head + tail;
}

// Resolve the canonical workspace root so `atris task` from any subdirectory
// keys the SAME store as the repo root. Precedence (nearest ancestor wins per
// pass):
//   1. A deliberate workspace spine, .atris/business.json (a bound customer
//      sub-workspace) or atris/atris.md (the framework protocol file). These are
//      intentional nested workspaces INSIDE a repo and must stay isolated.
//   2. The git toplevel (.git). One git repo == one workspace; this rescues a
//      subdirectory whose only markers are a bare atris/ or .atris/ dir.
//   3. Legacy fallback for non-git trees: a bare atris/ or .atris/ dir.
//
// Before this, a bare atris/ or .atris/ dir short-circuited ahead of the git
// root, so a subdir like backend/ (which has an atris/ folder plus a stray
// .atris) hijacked itself as a second workspace root and split task/usage state
// into backend/.atris (proven footgun 2026-07-16). Checking .git only at the
// same level meant the walk returned before ever reaching the real repo root.
function findWorkspaceRoot(start) {
  const origin = path.resolve(start || process.cwd());
  // Cap each walk at 32 levels to avoid pathological symlink loops.
  const walkUp = (test) => {
    let cur = origin;
    for (let i = 0; i < 32; i++) {
      if (test(cur)) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      // /tmp (and the other first-minute scratch roots) may themselves be a
      // workspace. A child of that root is a new room and must not inherit it.
      if (isGenericScratchRoot(parent)) break;
      cur = parent;
    }
    return null;
  };
  const spine = walkUp((dir) => fs.existsSync(path.join(dir, '.atris', 'business.json'))
    || fs.existsSync(path.join(dir, 'atris', 'atris.md')));
  if (spine) return spine;
  const gitRoot = walkUp((dir) => fs.existsSync(path.join(dir, '.git')));
  if (gitRoot) return gitRoot;
  const legacy = walkUp((dir) => fs.existsSync(path.join(dir, 'atris'))
    || fs.existsSync(path.join(dir, '.atris')));
  if (legacy) return legacy;
  return origin;
}

function workspaceRoot(cwd) {
  // Normalize symlinks (notably macOS /tmp → /private/tmp), then walk up to
  // the project root so subdirs and the repo root agree on the same key.
  let target = cwd || process.cwd();
  try { target = fs.realpathSync(target); } catch {}
  return findWorkspaceRoot(target);
}

function normalizeTitle(t) {
  return String(t || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '');
}

function sourceKey(sourceFile, title) {
  if (!sourceFile) return null;
  // Realpath the source file so symlinked / relative imports collapse to the
  // same key. Falls back to input string when the path doesn't resolve.
  let canonical = sourceFile;
  try { canonical = fs.realpathSync(sourceFile); } catch {}
  const h = crypto.createHash('sha1');
  h.update(`${canonical}${normalizeTitle(title)}`);
  return h.digest('hex');
}

function normalizeTaskRef(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function workspaceRefPrefix(ws) {
  const base = path.basename(String(ws || 'task')).toLowerCase();
  const parts = base.split(/[^a-z0-9]+/).filter(Boolean);
  const useful = parts.filter(p => !TASK_REF_GENERIC_TOKENS.has(p));
  if (useful.length > 1) {
    const leading = useful.slice(0, -1).map(p => p[0]).join('').toUpperCase();
    const last = useful[useful.length - 1].toUpperCase().replace(/[^A-Z0-9]/g, '');
    const lastKey = last[0] + last.slice(1).replace(/[AEIOU]/g, '');
    const combined = `${leading}${lastKey}`.replace(/[^A-Z0-9]/g, '');
    if (combined) return combined.slice(0, 3).padEnd(3, 'X');
  }
  const picked = useful.pop()
    || parts[parts.length - 1]
    || 'task';
  const token = picked.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!token) return 'TSK';
  if (token.length <= 3) return token.padEnd(3, 'X');
  const consonantKey = token[0] + token.slice(1).replace(/[AEIOU]/g, '');
  return (consonantKey.length >= 3 ? consonantKey : token).slice(0, 3);
}

function taskDisplayRef(row, index) {
  return `${workspaceRefPrefix(row && row.workspace_root)}-${Number(index) + 1}`;
}

function shortestUniqueTaskRef(id, ids, minLength = 8) {
  const normalized = normalizeTaskRef(id);
  if (!normalized) return '';
  const all = (Array.isArray(ids) ? ids : []).map(normalizeTaskRef).filter(Boolean);
  for (let length = Math.min(minLength, normalized.length); length <= normalized.length; length += 1) {
    const prefix = normalized.slice(0, length);
    const matches = all.filter(candidate => candidate.startsWith(prefix));
    if (matches.length <= 1) return prefix;
  }
  return normalized;
}

function withTaskDisplayRefs(rows, refRows = rows) {
  const list = Array.isArray(rows) ? rows : [];
  const referenceInput = Array.isArray(refRows) ? refRows : list;
  const referenceIds = new Set(referenceInput.map(row => row && row.id).filter(Boolean));
  const referenceList = [
    ...referenceInput,
    ...list.filter(row => row && row.id && !referenceIds.has(row.id) && !(row.metadata && row.metadata.markdown_source)),
  ];
  const byWorkspace = new Map();
  for (const row of referenceList) {
    const key = row && row.workspace_root || '';
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key).push(row);
  }
  const refs = new Map();
  for (const group of byWorkspace.values()) {
    const sorted = [...group]
      .sort((a, b) => (Number(a.created_at || 0) - Number(b.created_at || 0)) || String(a.id || '').localeCompare(String(b.id || '')))
    const ids = sorted.map(row => row && row.id);
    sorted.forEach((row, index) => {
      refs.set(row.id, {
        display_id: row.display_id || taskDisplayRef(row, index),
        legacy_ref: row.legacy_ref || shortestUniqueTaskRef(row.id, ids, 8),
      });
    });
  }
  return list.map(row => ({ ...row, ...(refs.get(row.id) || {}) }));
}

function taskDisplayRefMap(rows) {
  const map = new Map();
  for (const row of withTaskDisplayRefs(rows)) {
    map.set(row.id, row.display_id);
  }
  return map;
}

// One chokepoint every production addTask caller passes through, so a task
// created by mission, play, business, gm, lesson, the context gatherer, the
// self-drive lane, the CLI, or the board API all carry the same plain-language
// first layer. Explicit fields from the caller are kept verbatim; the rest get
// an honest derived default recorded as such.
function taskCreationMetadata(metadata, { title, tag } = {}) {
  const next = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  const verify = typeof next.verify === 'string' ? next.verify.trim() : '';
  if (!verify || verify.toLowerCase() === 'git diff --check') {
    next.verification_status = 'degraded';
    next.verification_degraded_reason = verify ? 'diff_only_verify' : 'missing_verify';
  }
  if (!next.explanation || typeof next.explanation !== 'object') {
    next.explanation = taskExplanation({ title, tag, metadata: next });
  }
  return next;
}

function addTask(db, { title, tag, workspaceRoot: ws, sourceKey: sk, metadata, status, claimedBy }) {
  if (!title || !String(title).trim()) throw new Error('title required');
  const now = Date.now();
  const id = newId();
  const taskStatus = ['open', 'claimed', 'review', 'done', 'failed'].includes(status) ? status : 'open';
  const initialClaimedBy = (taskStatus === 'claimed' || taskStatus === 'review') ? (claimedBy || null) : null;
  const claimedAt = initialClaimedBy ? now : null;
  // Idempotent on (workspace_root, source_key) when source_key supplied.
  if (sk) {
    const existing = db.prepare(
      'SELECT id FROM tasks WHERE workspace_root = ? AND source_key = ?'
    ).get(ws, sk);
    if (existing) return { id: existing.id, inserted: false };
  }
  const taskMetadata = taskCreationMetadata(metadata, { title: String(title).trim(), tag: tag || null });
  withBusyRetry(() => db.prepare(`
    INSERT INTO tasks (id, title, status, tag, workspace_root, source_key,
                       claimed_by, claimed_at, created_at, updated_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(title).trim(),
    taskStatus,
    tag || null,
    ws,
    sk || null,
    initialClaimedBy,
    claimedAt,
    now,
    now,
    JSON.stringify(taskMetadata),
  ));
  appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: ws,
    actor: claimedBy || null,
    eventType: taskStatus === 'claimed' ? 'claimed' : 'created',
    payload: {
      title: String(title).trim(),
      tag: tag || null,
      status: taskStatus,
      source_key: sk || null,
      metadata: taskMetadata,
    },
  });
  return { id, inserted: true };
}

function listTasks(db, { workspaceRoot: ws, status, claimedBy, limit }) {
  const where = [];
  const args = [];
  if (ws) { where.push('workspace_root = ?'); args.push(ws); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (claimedBy) { where.push('claimed_by = ?'); args.push(claimedBy); }
  const sql = `
    SELECT id, title, status, tag, workspace_root, source_key, claimed_by, claimed_at, created_at, updated_at, done_at, metadata
    FROM tasks
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY
      CASE status WHEN 'open' THEN 0 WHEN 'claimed' THEN 1 WHEN 'review' THEN 2 WHEN 'failed' THEN 3 WHEN 'done' THEN 4 WHEN 'archived' THEN 5 ELSE 6 END,
      CASE WHEN tag='endgame' THEN 0 ELSE 1 END,
      created_at DESC
    ${limit ? 'LIMIT ' + Number(limit) : ''}
  `;
  return db.prepare(sql).all(...args).map(r => ({
    ...r,
    metadata: r.metadata ? safeJSON(r.metadata) : null,
  }));
}

function getTask(db, id) {
  if (!id) throw new Error('id required');
  const row = db.prepare(`
    SELECT id, title, status, tag, workspace_root, source_key, claimed_by, claimed_at, created_at, updated_at, done_at, metadata
    FROM tasks
    WHERE id = ?
  `).get(id);
  if (!row) return null;
  return { ...row, metadata: row.metadata ? safeJSON(row.metadata) : null };
}

// Atomic claim. Returns { claimed: true, row } only if THIS call won the row.
// Race-safe via single UPDATE with WHERE status='open' guard. SQLite serializes
// writes; busy_timeout absorbs contention. Caller must check `.claimed`.
function claimTask(db, { id, claimedBy }) {
  if (!id) throw new Error('id required');
  if (!claimedBy) throw new Error('claimedBy required');
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE tasks
       SET status = 'claimed',
           claimed_by = ?,
           claimed_at = ?,
           updated_at = ?
     WHERE id = ?
       AND status = 'open'
  `);
  const result = withBusyRetry(() => stmt.run(claimedBy, now, now, id));
  if (result.changes === 1) {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    appendTaskEvent(db, {
      taskId: id,
      workspaceRoot: row.workspace_root,
      actor: claimedBy,
      eventType: 'claimed',
      payload: { claimed_by: claimedBy },
    });
    return { claimed: true, row: { ...row, metadata: row.metadata ? safeJSON(row.metadata) : null } };
  }
  // Either id doesn't exist or status != 'open'. Tell the caller which.
  const row = db.prepare('SELECT id, status, claimed_by FROM tasks WHERE id = ?').get(id);
  if (!row) return { claimed: false, reason: 'not_found' };
  return { claimed: false, reason: 'already_' + row.status, claimed_by: row.claimed_by };
}

function releaseTask(db, { id, actor }) {
  if (!id) throw new Error('id required');
  if (!actor) throw new Error('actor required');
  const row = getTask(db, id);
  if (!row) return { released: false, reason: 'not_found' };
  if (row.status !== 'claimed') {
    return { released: false, reason: `already_${row.status}`, claimed_by: row.claimed_by || null };
  }
  if (row.claimed_by !== actor) {
    return { released: false, reason: 'held_by_other', claimed_by: row.claimed_by || null };
  }
  const now = Date.now();
  const result = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET status = 'open',
           claimed_by = NULL,
           claimed_at = NULL,
           updated_at = ?
     WHERE id = ?
       AND status = 'claimed'
       AND claimed_by = ?
  `).run(now, id, actor));
  if (result.changes !== 1) return { released: false, reason: 'stale_task_state', claimed_by: row.claimed_by || null };
  const updated = getTask(db, id);
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: updated.workspace_root,
    actor,
    eventType: 'claim_released',
    payload: {
      released_by: actor,
      previous_claimed_by: row.claimed_by || null,
    },
  });
  return { released: true, row: updated, event };
}

function reopenTask(db, { id, actor, reason, metadata: metadataPatch } = {}) {
  if (!id) throw new Error('id required');
  const row = getTask(db, id);
  if (!row) return { reopened: false, reason: 'not_found' };
  if (OPEN_TASK_STATUSES.has(row.status)) return { reopened: false, reason: `already_${row.status}`, row };
  if (!['done', 'failed', 'archived'].includes(row.status)) {
    return { reopened: false, reason: `not_reopenable_${row.status}` };
  }

  const now = Math.max(Date.now(), Number(row.updated_at || 0) + 1);
  const actorText = actor || process.env.ATRIS_AGENT_ID || process.env.USER || null;
  const reasonText = String(reason || 'reopened').trim();
  const metadata = {
    ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
    ...(metadataPatch && typeof metadataPatch === 'object' ? metadataPatch : {}),
    reopened_at: new Date(now).toISOString(),
    reopened_by: actorText,
    reopened_from: row.status,
    reopen_reason: reasonText,
  };
  for (const key of [
    'accepted_at',
    'accepted_by',
    'agent_certification_policy',
    'agent_certified',
    'agent_certified_at',
    'agent_certified_by',
    'agent_review_actors',
    'agent_review_pass_count',
    'agent_reviewed_at',
    'agent_reviewed_by',
    'approval_status',
    'archived_at',
    'archived_by',
    'archived_from',
    'archived_reason',
    'independent_review_by',
    'latest_agent_lesson',
    'latest_agent_next_task',
    'latest_agent_proof',
  ]) delete metadata[key];

  const result = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET status = 'open',
           claimed_by = NULL,
           claimed_at = NULL,
           done_at = NULL,
           updated_at = ?,
           metadata = ?
     WHERE id = ?
       AND status = ?
       AND updated_at = ?
  `).run(now, JSON.stringify(metadata), id, row.status, row.updated_at));
  if (result.changes !== 1) return { reopened: false, reason: 'stale_task_state' };
  const updated = getTask(db, id);
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: updated.workspace_root,
    actor: actorText,
    eventType: 'reopened',
    payload: { previous_status: row.status, reason: reasonText },
  });
  return { reopened: true, event, row: updated };
}

function doneTask(db, { id, status, actor, allowReview = false, action, proof, autoAccepted = false } = {}) {
  if (!id) throw new Error('id required');
  const final = status || 'done';
  if (!['done', 'failed'].includes(final)) throw new Error('status must be done|failed');
  // 'archived' is a distinct terminal status written by archiveTask(), never
  // by this function, a bulk sweep of duplicate/off-roadmap tasks must not
  // read as a real failure. See archiveTask() below.
  const now = Date.now();
  const allowedStatuses = allowReview ? "'open', 'claimed', 'review'" : "'open', 'claimed'";
  const result = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET status = ?, done_at = ?, updated_at = ?
     WHERE id = ?
       AND status IN (${allowedStatuses})
  `).run(final, now, now, id));
  if (result.changes === 1) {
    const row = getTask(db, id);
    appendTaskEvent(db, {
      taskId: id,
      workspaceRoot: row.workspace_root,
      actor: actor || process.env.ATRIS_AGENT_ID || process.env.USER || null,
      eventType: final === 'done' ? 'completed' : 'blocked',
      payload: {
        status: final,
        action: action || final,
        ...(autoAccepted ? { auto_accepted: true } : {}),
      },
    });
    const logs = appendTaskCompletionLogs(db, row, {
      status: final,
      actor: actor || process.env.ATRIS_AGENT_ID || process.env.USER || null,
      action: action || final,
      proof,
    });
    return { updated: true, logs };
  }
  return { updated: false };
}

function reapMissionBlockerTasks(db, { workspaceRoot: ws, missions = [], actor } = {}) {
  const missionById = new Map((Array.isArray(missions) ? missions : [])
    .filter(mission => mission && mission.id)
    .map(mission => [String(mission.id), mission]));
  const candidates = listTasks(db, { workspaceRoot: ws || null, limit: null })
    .filter(row => OPEN_TASK_STATUSES.has(row.status))
    .filter(row => row.tag === 'mission-blocker')
    .filter(row => row.metadata && row.metadata.mission_id && row.metadata.mission_blocker_class)
    .map(row => ({ row, mission: missionById.get(String(row.metadata.mission_id)) }))
    .filter(({ mission }) => mission && TERMINAL_MISSION_STATUSES.has(String(mission.status || '').toLowerCase()));
  const closed = [];
  for (const { row, mission } of candidates) {
    const missionStatus = String(mission.status).toLowerCase();
    const reason = `mission ${mission.id} is ${missionStatus}`;
    const result = archiveTask(db, {
      id: row.id,
      actor,
      reason,
    });
    if (!result.archived) continue;
    closed.push({
      task_id: row.id,
      title: row.title,
      previous_status: row.status,
      mission_id: mission.id,
      mission_status: missionStatus,
      blocker_class: row.metadata.mission_blocker_class,
      reason,
    });
  }
  return { closed, count: closed.length };
}

// Distinct terminal status for housekeeping sweeps (duplicate loop-ticks,
// off-roadmap backlog resets, synthetic-test cleanup). Never conflate this
// with `failed`, 'failed' means the work itself did not succeed, 'archived'
// means the work was swept off the board for reasons unrelated to whether it
// succeeded. Reward/RSI signal readers must treat the two differently.
// `fromFailed: true` is an explicit opt-in for sanctioned historical cleanup
// (e.g. the 109 duplicate "Loop tick:" orphans fail-closed before 'archived'
// existed, cluster 1 of failed-tasks-analysis-2026-07-03). It permits the
// failed→archived transition and records the prior status in
// metadata.archived_from. Individual archive commands never archive 'done'
// rows. The clear-done sweep opts in through fromDone after selecting only the
// same 'done' rows counted by `atris status`.
function archiveTask(db, { id, actor, reason, fromFailed = false, fromDone = false } = {}) {
  if (!id) throw new Error('id required');
  const reasonText = String(reason || '').trim();
  if (!reasonText) throw new Error('reason required');
  const row = getTask(db, id);
  if (!row) return { archived: false, reason: 'not_found' };
  const allowedStatuses = ['open', 'claimed', 'review'];
  if (fromFailed) allowedStatuses.push('failed');
  if (fromDone) allowedStatuses.push('done');
  if (!allowedStatuses.includes(row.status)) {
    return { archived: false, reason: `already_${row.status}` };
  }
  const now = Date.now();
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  metadata.archived_reason = reasonText;
  metadata.archived_at = new Date(now).toISOString();
  metadata.archived_by = actor || process.env.ATRIS_AGENT_ID || process.env.USER || null;
  metadata.approval_status = 'archived';
  if (row.status === 'failed' || row.status === 'done') metadata.archived_from = row.status;
  const terminalAt = row.status === 'done' && row.done_at ? row.done_at : now;
  const statusPlaceholders = allowedStatuses.map(() => '?').join(', ');
  const result = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET status = 'archived',
           done_at = ?,
           updated_at = ?,
           metadata = ?
     WHERE id = ?
       AND status IN (${statusPlaceholders})
  `).run(terminalAt, now, JSON.stringify(metadata), id, ...allowedStatuses));
  if (result.changes !== 1) return { archived: false, reason: 'stale_task_state' };
  const updated = getTask(db, id);
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: updated.workspace_root,
    actor: metadata.archived_by,
    eventType: 'archived',
    payload: {
      reason: reasonText,
      ...(['failed', 'done'].includes(row.status) ? { previous_status: row.status } : {}),
    },
  });
  const logs = appendTaskCompletionLogs(db, updated, {
    status: 'archived',
    actor: metadata.archived_by,
    action: 'archived',
    proof: reasonText,
  });
  return { archived: true, event, row: updated, logs };
}

// Marks metadata written by the 2026-06-10 "first-principles backlog reset"
// (see atris/logs/2026/2026-06-10.md), a bulk pass that closed off-roadmap
// tasks, including certified/proof-backed done work, by writing status
// 'failed' because no distinct 'archived' status existed yet. This
// identifies exactly those rows so relabelArchivedTasks() can fix the label
// without touching any task that failed for a real reason.
function isJune10BacklogResetMarker(metadata) {
  const m = metadata && typeof metadata === 'object' ? metadata : {};
  if (!m.archived_at) return false;
  return /first-principles backlog reset 2026-06-10/i.test(String(m.archive_reason || ''));
}

// One-time migration (OBL-1622): relabel the June-10 mislabeled rows from
// 'failed' to 'archived'. Dry-run only counts/samples; --apply performs the
// same status write path as archiveTask() (direct projection UPDATE +
// appendTaskEvent), never a raw projection-JSON edit.
function relabelArchivedTasks(db, { workspaceRoot: ws, apply = false, actor, limit = 5000 } = {}) {
  const candidates = listTasks(db, { workspaceRoot: ws || null, status: 'failed', limit })
    .filter(row => isJune10BacklogResetMarker(row.metadata));
  const sample = candidates.slice(0, 10).map(row => ({ id: row.id, title: row.title }));
  if (!apply) {
    return { applied: false, count: candidates.length, sample };
  }
  const now = Date.now();
  const actorText = actor || process.env.ATRIS_AGENT_ID || process.env.USER || null;
  const relabeledIds = [];
  for (const row of candidates) {
    const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
    metadata.relabeled_from_status = 'failed';
    metadata.relabeled_at = new Date(now).toISOString();
    metadata.relabeled_by = actorText;
    metadata.relabel_reason = 'obl_1622_june_10_backlog_reset_relabel';
    const result = withBusyRetry(() => db.prepare(`
      UPDATE tasks
         SET status = 'archived',
             updated_at = ?,
             metadata = ?
       WHERE id = ?
         AND status = 'failed'
    `).run(now, JSON.stringify(metadata), row.id));
    if (result.changes === 1) {
      appendTaskEvent(db, {
        taskId: row.id,
        workspaceRoot: row.workspace_root,
        actor: actorText,
        eventType: 'relabeled_archived',
        payload: { previous_status: 'failed', reason: 'obl_1622_june_10_backlog_reset_relabel' },
      });
      relabeledIds.push(row.id);
    }
  }
  return { applied: true, count: relabeledIds.length, ids: relabeledIds, sample };
}

function cleanLandingText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || null;
}

// Record who delivered this review pass and answer whether certification is
// allowed: at least one recorded pass actor must differ from the builder.
// The first pass actor stamps built_by; judge != worker from then on.
function recordReviewPassActor(metadata, claimedBy, rawActor) {
  const actorNorm = reviewIntegrity.normalizeActor(
    rawActor || process.env.ATRIS_AGENT_ID || process.env.USER || ''
  );
  if (!metadata.built_by && actorNorm) metadata.built_by = actorNorm;
  const actors = Array.isArray(metadata.agent_review_actors) ? [...metadata.agent_review_actors] : [];
  if (actorNorm && !actors.includes(actorNorm)) actors.push(actorNorm);
  metadata.agent_review_actors = actors;
  const builder = reviewIntegrity.normalizeActor(metadata.built_by || claimedBy || '');
  const independent = builder
    ? (actors.find((a) => a && a !== builder) || null)
    : (actors.length >= 2 ? actors[1] : null);
  return { builder: builder || null, independent };
}

function readyTask(db, { id, actor, proof, lesson, nextTask, landing = {}, resultTrace, result: resultSentence, reason }) {
  if (!id) throw new Error('id required');
  const text = String(proof || '').trim();
  if (!text) throw new Error('proof required');
  const row = getTask(db, id);
  if (!row) return { ready: false, reason: 'not_found' };
  if (!['open', 'claimed', 'review'].includes(row.status)) {
    return { ready: false, reason: `already_${row.status}` };
  }
  const now = Date.now();
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  const reviewPassCount = Number(metadata.agent_review_pass_count || 0) + 1;
  metadata.approval_status = 'pending';
  metadata.agent_review_pass_count = reviewPassCount;
  metadata.agent_reviewed_at = new Date(now).toISOString();
  metadata.agent_reviewed_by = actor || process.env.ATRIS_AGENT_ID || process.env.USER || null;
  metadata.latest_agent_proof = text;
  metadata.latest_agent_lesson = String(lesson || '').trim() || null;
  metadata.latest_agent_next_task = String(nextTask || '').trim() || null;
  const resultText = cleanLandingText(resultSentence);
  if (resultText) metadata.result = resultText;
  const reasonText = cleanLandingText(reason);
  if (reasonText) metadata.result_reason = reasonText;
  const landingInput = landing && typeof landing === 'object' ? landing : {};
  for (const key of ['happened', 'checked', 'tested', 'decision']) {
    const cleaned = cleanLandingText(landingInput[key]);
    if (cleaned) metadata[`landing_${key}`] = cleaned;
  }
  const passRecord = recordReviewPassActor(metadata, row.claimed_by, actor);
  if (reviewPassCount >= AGENT_CERTIFICATION_REVIEW_PASSES && passRecord.independent) {
    metadata.agent_certified = true;
    metadata.agent_certified_at = new Date(now).toISOString();
    metadata.agent_certified_by = actor || process.env.ATRIS_AGENT_ID || process.env.USER || null;
    metadata.agent_certification_policy = `${AGENT_CERTIFICATION_REVIEW_PASSES}_agent_review_passes`;
    metadata.independent_review_by = passRecord.independent;
  }
  const result = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET status = 'review',
           done_at = NULL,
           updated_at = ?,
           metadata = ?
     WHERE id = ?
       AND status IN ('open', 'claimed', 'review')
  `).run(now, JSON.stringify(metadata), id));
  if (result.changes !== 1) return { ready: false, reason: 'not_open_claimed_or_review' };
  const updated = getTask(db, id);
  const payload = {
    proof: text,
    lesson: metadata.latest_agent_lesson,
    next_task: metadata.latest_agent_next_task,
    approval_status: 'pending',
    review_pass_count: reviewPassCount,
    agent_certified: metadata.agent_certified === true,
    agent_certification_policy: metadata.agent_certification_policy || null,
    result: metadata.result || null,
  };
  if (resultTrace && typeof resultTrace === 'object') {
    payload.result_trace = resultTrace;
    payload.result_packet = `TASK_RESULT_TRACE ${JSON.stringify(resultTrace)}`;
  }
  payload.landing = {
    happened: metadata.landing_happened || null,
    checked: metadata.landing_checked || null,
    tested: metadata.landing_tested || null,
    decision: metadata.landing_decision || null,
  };
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: updated.workspace_root,
    actor: actor || null,
    eventType: 'proof_ready',
    payload,
  });
  return { ready: true, event, row: updated };
}

function setTaskResult(db, { id, actor, result }) {
  if (!id) throw new Error('id required');
  const text = cleanLandingText(result);
  if (!text) throw new Error('result required');
  const row = getTask(db, id);
  if (!row) return { saved: false, reason: 'not_found' };
  const now = Date.now();
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  metadata.result = text;
  metadata.result_at = new Date(now).toISOString();
  metadata.result_by = actor || process.env.ATRIS_AGENT_ID || process.env.USER || null;
  const updated = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET metadata = ?,
           updated_at = ?
     WHERE id = ?
  `).run(JSON.stringify(metadata), now, id));
  if (updated.changes !== 1) return { saved: false, reason: 'stale_task_state' };
  const latest = getTask(db, id);
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: latest.workspace_root,
    actor: metadata.result_by,
    eventType: 'result_set',
    payload: { result: text },
  });
  return { saved: true, event, row: latest };
}

function reviseTask(db, { id, actor, note, allowDone = false }) {
  if (!id) throw new Error('id required');
  const text = String(note || '').trim();
  if (!text) throw new Error('note required');
  const row = getTask(db, id);
  if (!row) return { revised: false, reason: 'not_found' };
  const acceptedDone = allowDone
    && row.status === 'done'
    && row.metadata
    && row.metadata.approval_status === 'accepted';
  if (row.status !== 'review' && !acceptedDone) {
    return { revised: false, reason: `not_reviewable_${row.status}` };
  }
  const now = Date.now();
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  const revisionCount = Number(metadata.human_revision_count || 0) + 1;
  for (const key of [
    'agent_review_pass_count',
    'agent_reviewed_at',
    'agent_reviewed_by',
    'latest_agent_proof',
    'latest_agent_lesson',
    'latest_agent_next_task',
    'agent_certified',
    'agent_certified_at',
    'agent_certified_by',
    'agent_certification_policy',
  ]) {
    delete metadata[key];
  }
  metadata.approval_status = 'revise';
  metadata.human_revision_count = revisionCount;
  metadata.human_revision_at = new Date(now).toISOString();
  metadata.human_revision_by = actor || process.env.ATRIS_AGENT_ID || process.env.USER || null;
  metadata.human_revision_note = text;
  if (acceptedDone) {
    for (const key of [
      'accepted_at',
      'accepted_by',
      'auto_accepted_at',
      'auto_accepted_by',
      'auto_accept_policy',
    ]) {
      delete metadata[key];
    }
  }
  const revisedStatus = row.claimed_by ? 'claimed' : 'open';
  const expectedStatus = acceptedDone ? 'done' : 'review';
  const result = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET status = ?,
           done_at = NULL,
           updated_at = ?,
           metadata = ?
     WHERE id = ?
       AND status = ?
  `).run(revisedStatus, now, JSON.stringify(metadata), id, expectedStatus));
  if (result.changes !== 1) return { revised: false, reason: 'not_updated' };
  const updated = getTask(db, id);
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: updated.workspace_root,
    actor: actor || null,
    eventType: 'revision_requested',
    payload: {
      note: text,
      approval_status: 'revise',
      revision_count: revisionCount,
      ...(acceptedDone ? { previous_status: row.status } : {}),
    },
  });
  const episode = taskEpisodeFromRevision(updated, event, event.payload);
  appendTaskEpisode(updated.workspace_root, episode);
  return { revised: true, event, row: updated, episode };
}

function cleanStageText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedTaskPart(value) {
  return cleanStageText(value).toLowerCase().replace(/\s+/g, '-');
}

function backlogTag(value) {
  const requested = cleanStageText(value) || 'capture';
  return TASK_PLAN_TAGS.has(normalizedTaskPart(requested)) ? 'capture' : requested;
}

function taskHasPlanSignal(row) {
  const metadata = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const tag = normalizedTaskPart(row && row.tag);
  const stage = normalizedTaskPart(metadata.stage);
  return TASK_PLAN_TAGS.has(tag)
    || TASK_PLAN_TAGS.has(stage)
    || Boolean(
      metadata.planned_at
      || metadata.stage_plan_recorded_at
      || metadata.verify
      || metadata.proof_needed
      || metadata.exit_condition
      || metadata.stage_goal
      || metadata.stage_owner
      || metadata.goal
      || metadata.loop
      || metadata.cron
      || metadata.next_run_at
    );
}

function clearPlanMetadata(metadata, { actor, reason, previousTag } = {}) {
  const next = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  const clearedKeys = [];
  const taskGoal = cleanStageText(next.task_goal || next.goal_objective || next.objective || next.stage_goal);
  if (taskGoal && !next.task_goal) next.task_goal = taskGoal;
  for (const key of [
    'stage',
    'stage_goal',
    'stage_summary',
    'exit_condition',
    'verify',
    'proof_needed',
    'first_move',
    'next_button',
    'stage_updated_at',
    'stage_updated_by',
    'stage_owner',
    'stage_confidence',
    'goal_objective',
    'objective',
    'goal',
    'loop',
    'cron',
    'next_run_at',
    'planned_at',
    'planned_by',
    'stage_plan_recorded_at',
  ]) {
    if (next[key] !== undefined) {
      delete next[key];
      clearedKeys.push(key);
    }
  }
  const delegatedAssignment = Boolean(metadata.delegate_via || metadata.swarlo_channel || metadata.created_for_day);
  if (
    next.assigned_to
    && !delegatedAssignment
    && (next.assigned_to === metadata.stage_owner || next.assigned_to === metadata.planned_by)
  ) {
    delete next.assigned_to;
    clearedKeys.push('assigned_to');
  }
  next.backlogged_at = new Date().toISOString();
  next.backlogged_by = cleanStageText(actor) || null;
  next.backlog_reason = cleanStageText(reason) || 'clear_plan';
  if (previousTag) next.backlog_previous_tag = previousTag;
  return { metadata: next, clearedKeys };
}

function backlogTask(db, { id, actor, reason, tag = 'capture' }) {
  if (!id) throw new Error('id required');
  const row = getTask(db, id);
  if (!row) return { backlogged: false, reason: 'not_found' };
  if (row.status !== 'open') {
    return { backlogged: false, reason: `already_${row.status}`, claimed_by: row.claimed_by || null };
  }
  if (!taskHasPlanSignal(row)) return { backlogged: false, reason: 'not_planned' };

  const actorText = cleanStageText(actor) || null;
  const previousTag = row.tag || null;
  const nextTag = backlogTag(tag);
  const { metadata, clearedKeys } = clearPlanMetadata(row.metadata || {}, {
    actor: actorText,
    reason,
    previousTag: previousTag && normalizedTaskPart(previousTag) !== normalizedTaskPart(nextTag) ? previousTag : null,
  });
  const now = Math.max(Date.now(), Number(row.updated_at || 0) + 1);
  const result = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET tag = ?,
           metadata = ?,
           updated_at = ?
     WHERE id = ?
       AND status = 'open'
       AND updated_at = ?
  `).run(nextTag, JSON.stringify(metadata), now, id, row.updated_at));
  if (result.changes !== 1) return { backlogged: false, reason: 'stale_task_state' };
  const updated = getTask(db, id);
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: updated.workspace_root,
    actor: actorText,
    eventType: 'task_backlogged',
    payload: {
      reason: cleanStageText(reason) || 'clear_plan',
      previous_tag: previousTag,
      tag: nextTag,
      cleared_keys: clearedKeys,
    },
  });
  return { backlogged: true, event, row: updated, cleared_keys: clearedKeys };
}

function clearPlanTasks(db, { workspaceRoot: ws, actor, reason, tag = 'capture', limit } = {}) {
  const rows = listTasks(db, { workspaceRoot: ws || null, status: 'open', limit }).filter(taskHasPlanSignal);
  const cleared = [];
  const skipped = [];
  for (const row of rows) {
    const result = backlogTask(db, {
      id: row.id,
      actor,
      reason: reason || 'clear_plan_bulk',
      tag,
    });
    if (result.backlogged) cleared.push(result.row);
    else skipped.push({ id: row.id, reason: result.reason });
  }
  return { cleared, skipped };
}

function stagePacketFromPayload(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const lines = [
    'TASK_STAGE_UPDATE',
    `stage: ${cleanStageText(data.stage)}`,
  ];
  if (data.confidence !== undefined && data.confidence !== null) lines.push(`confidence: ${data.confidence}`);
  if (data.summary) lines.push(`summary: ${data.summary}`);
  if (data.owner) lines.push(`owner: ${data.owner}`);
  if (data.goal) lines.push(`goal: ${data.goal}`);
  if (data.exit) lines.push(`exit: ${data.exit}`);
  if (data.proof_needed) lines.push(`proof_needed: ${data.proof_needed}`);
  if (data.first_move) lines.push(`first_move: ${data.first_move}`);
  if (data.next_button) lines.push(`next_button: ${data.next_button}`);
  if (data.plan_trace && typeof data.plan_trace === 'object') {
    lines.push(`TASK_PLAN_TRACE ${JSON.stringify(data.plan_trace)}`);
  }
  return lines.filter(Boolean).join('\n');
}

function backlogPacketFromPayload(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const lines = [
    'TASK_BACKLOG_UPDATE',
    `reason: ${cleanStageText(data.reason || 'clear_plan')}`,
  ];
  if (data.previous_tag) lines.push(`previous_tag: ${cleanStageText(data.previous_tag)}`);
  if (data.tag) lines.push(`tag: ${cleanStageText(data.tag)}`);
  if (Array.isArray(data.cleared_keys) && data.cleared_keys.length) lines.push(`cleared_keys: ${data.cleared_keys.join(', ')}`);
  return lines.filter(Boolean).join('\n');
}

function stageTask(db, {
  id,
  actor,
  stage,
  goal,
  summary,
  owner,
  ownerExplicit = false,
  exit,
  proofNeeded,
  firstMove,
  nextButton,
  confidence,
  planTrace,
}) {
  if (!id) throw new Error('id required');
  const targetStage = cleanStageText(stage).toLowerCase();
  if (!['plan', 'do'].includes(targetStage)) throw new Error('stage must be plan|do');
  const row = getTask(db, id);
  if (!row) return { staged: false, reason: 'not_found' };
  if (['done', 'failed'].includes(row.status)) return { staged: false, reason: `already_${row.status}` };
  if (row.status === 'review') return { staged: false, reason: 'not_reviewable_use_revise' };

  const requestedOwner = cleanStageText(owner);
  const requestedGoal = cleanStageText(goal);
  const requestedProof = cleanStageText(proofNeeded);
  const requestedExit = cleanStageText(exit);
  const actorText = cleanStageText(actor);
  let metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  let stageOwner = requestedOwner || actorText || cleanStageText(row.claimed_by) || null;
  let goalText = requestedGoal || cleanStageText(metadata.task_goal || metadata.goal_objective || metadata.objective || metadata.stage_goal);
  let proofText = requestedProof || cleanStageText(metadata.verify || metadata.proof_needed);
  let exitText = requestedExit || cleanStageText(metadata.exit_condition);

  function recordedDoPlan(currentRow, { claimedOwnerWins = false } = {}) {
    const currentMetadata = currentRow && currentRow.metadata && typeof currentRow.metadata === 'object'
      ? { ...currentRow.metadata }
      : {};
    const claimedOwner = cleanStageText(currentRow && currentRow.claimed_by);
    const planOwner = cleanStageText(currentMetadata.stage_owner || currentMetadata.assigned_to);
    const recordedOwner = claimedOwnerWins && claimedOwner ? claimedOwner : (claimedOwner || planOwner);
    const caller = actorText || requestedOwner || null;
    const recordedGoal = cleanStageText(currentMetadata.goal_objective || currentMetadata.objective || currentMetadata.stage_goal || currentMetadata.task_goal);
    const recordedProof = cleanStageText(currentMetadata.verify || currentMetadata.proof_needed);
    const recordedExit = cleanStageText(currentMetadata.exit_condition);
    const planRecorded = cleanStageText(currentMetadata.planned_at)
      || cleanStageText(currentMetadata.stage) === 'plan'
      || cleanStageText(currentMetadata.stage_plan_recorded_at);
    if (!planRecorded) {
      return { ok: false, reason: requestedGoal || requestedProof || requestedExit ? 'plan_required' : 'goal_required' };
    }
    if (!recordedGoal) return { ok: false, reason: 'goal_required' };
    if (!recordedExit) return { ok: false, reason: 'exit_required' };
    if (!recordedProof) return { ok: false, reason: 'proof_needed_required' };
    if (requestedGoal && requestedGoal !== recordedGoal) return { ok: false, reason: 'plan_goal_mismatch' };
    if (requestedProof && requestedProof !== recordedProof) return { ok: false, reason: 'plan_proof_mismatch' };
    if (requestedExit && requestedExit !== recordedExit) return { ok: false, reason: 'plan_exit_mismatch' };
    if (claimedOwner && planOwner && claimedOwner !== planOwner && !claimedOwnerWins) {
      return { ok: false, reason: 'claimed_by_other', claimed_by: planOwner };
    }
    if (recordedOwner && caller && recordedOwner !== caller) {
      return { ok: false, reason: 'claimed_by_other', claimed_by: recordedOwner };
    }
    return {
      ok: true,
      metadata: currentMetadata,
      stageOwner: recordedOwner || requestedOwner || actorText || null,
      goalText: recordedGoal,
      proofText: recordedProof,
      exitText: recordedExit,
    };
  }

  if (targetStage === 'plan') {
    if (!goalText) return { staged: false, reason: 'goal_required' };
    if (!exitText || !proofText) {
      return { staged: false, reason: !exitText ? 'exit_required' : 'proof_needed_required' };
    }
    const claimedBy = cleanStageText(row.claimed_by);
    if (row.status === 'claimed' && claimedBy) {
      if ((actorText && actorText !== claimedBy) || (requestedOwner && requestedOwner !== claimedBy)) {
        return { staged: false, reason: 'claimed_by_other', claimed_by: claimedBy };
      }
      stageOwner = claimedBy;
    }
  } else {
    const plan = recordedDoPlan(row, { claimedOwnerWins: row.status === 'claimed' });
    if (!plan.ok) return { staged: false, reason: plan.reason, claimed_by: plan.claimed_by || null };
    metadata = plan.metadata;
    stageOwner = plan.stageOwner;
    goalText = plan.goalText;
    proofText = plan.proofText;
    exitText = plan.exitText;
  }

  const hasConfidence = confidence !== undefined && confidence !== null && confidence !== '';
  const confidenceValue = hasConfidence ? Number(confidence) : NaN;

  let workingRow = row;
  let claimedFromOpen = false;
  let claimedFromUnowned = false;
  let claimedWorker = null;
  function rollbackOpenDoClaim(reasonRow) {
    if (!claimedFromOpen || !claimedWorker || !reasonRow) return;
    const rollbackTime = Math.max(Date.now(), Number(reasonRow.updated_at || 0) + 1);
    withBusyRetry(() => db.prepare(`
      UPDATE tasks
         SET status = 'open',
             claimed_by = NULL,
             claimed_at = NULL,
             updated_at = ?
       WHERE id = ?
         AND status = 'claimed'
         AND claimed_by IS ?
         AND updated_at = ?
    `).run(rollbackTime, id, claimedWorker, reasonRow.updated_at));
  }
  if (targetStage === 'do' && workingRow.status === 'open') {
    claimedWorker = stageOwner || cleanStageText(actor) || process.env.ATRIS_AGENT_ID || process.env.USER || 'unknown';
    const claimTime = Math.max(Date.now(), Number(workingRow.updated_at || 0) + 1);
    const claimed = withBusyRetry(() => db.prepare(`
      UPDATE tasks
         SET status = 'claimed',
             claimed_by = ?,
             claimed_at = ?,
             updated_at = ?
       WHERE id = ?
         AND status = 'open'
         AND updated_at = ?
    `).run(claimedWorker, claimTime, claimTime, id, workingRow.updated_at));
    if (claimed.changes !== 1) return { staged: false, reason: 'stale_task_state' };
    claimedFromOpen = true;
    workingRow = getTask(db, id);
    if (!workingRow) return { staged: false, reason: 'not_found' };
    const plan = recordedDoPlan(workingRow);
    if (!plan.ok) {
      rollbackOpenDoClaim(workingRow);
      return { staged: false, reason: plan.reason, claimed_by: plan.claimed_by || null };
    }
    metadata = plan.metadata;
    stageOwner = plan.stageOwner;
    goalText = plan.goalText;
    proofText = plan.proofText;
    exitText = plan.exitText;
  }

  const updateTime = Math.max(Date.now(), Number(workingRow && workingRow.updated_at || row.updated_at || 0) + 1);
  const updateIso = new Date(updateTime).toISOString();
  metadata.stage = targetStage;
  metadata.task_goal = goalText;
  metadata.goal_objective = goalText;
  metadata.stage_goal = goalText;
  if (targetStage === 'plan') {
    metadata.planned_at = updateIso;
    metadata.planned_by = cleanStageText(actor) || null;
    metadata.stage_plan_recorded_at = metadata.planned_at;
  }
  metadata.stage_summary = cleanStageText(summary) || metadata.stage_summary || null;
  metadata.exit_condition = exitText || metadata.exit_condition || null;
  metadata.verify = proofText || metadata.verify || null;
  metadata.proof_needed = proofText || metadata.proof_needed || null;
  metadata.first_move = cleanStageText(firstMove) || metadata.first_move || null;
  metadata.next_button = cleanStageText(nextButton) || (targetStage === 'plan' ? 'Start do' : 'Move to review');
  metadata.stage_updated_at = updateIso;
  metadata.stage_updated_by = cleanStageText(actor) || null;
  if (stageOwner) {
    metadata.stage_owner = stageOwner;
    // Plan keeps an existing delegated assignee unless the caller named an
    // owner on purpose; do always records the worker who is doing it.
    const reassign = targetStage === 'do' || Boolean(ownerExplicit && requestedOwner);
    metadata.assigned_to = reassign ? stageOwner : (metadata.assigned_to || stageOwner);
  }
  if (hasConfidence && Number.isFinite(confidenceValue)) metadata.stage_confidence = Math.max(0, Math.min(1, confidenceValue));

  let result;
  if (targetStage === 'plan') {
    const whereClaim = row.status === 'claimed'
      ? 'AND status = ? AND claimed_by IS ? AND updated_at = ?'
      : 'AND status = ? AND updated_at = ?';
    const params = row.status === 'claimed'
      ? [updateTime, JSON.stringify(metadata), id, row.status, row.claimed_by || null, row.updated_at]
      : [updateTime, JSON.stringify(metadata), id, row.status, row.updated_at];
    result = withBusyRetry(() => db.prepare(`
      UPDATE tasks
         SET done_at = NULL,
             updated_at = ?,
             metadata = ?
       WHERE id = ?
         ${whereClaim}
    `).run(...params));
  } else {
    const worker = workingRow && workingRow.claimed_by || stageOwner || cleanStageText(actor) || null;
    if (workingRow && workingRow.status === 'claimed' && !workingRow.claimed_by && worker) {
      result = withBusyRetry(() => db.prepare(`
        UPDATE tasks
           SET done_at = NULL,
               claimed_by = ?,
               claimed_at = ?,
               updated_at = ?,
               metadata = ?
         WHERE id = ?
           AND status = 'claimed'
           AND claimed_by IS NULL
           AND updated_at = ?
      `).run(worker, updateTime, updateTime, JSON.stringify(metadata), id, workingRow.updated_at));
      claimedFromUnowned = result.changes === 1;
      claimedWorker = worker;
    } else {
      result = withBusyRetry(() => db.prepare(`
        UPDATE tasks
           SET done_at = NULL,
               updated_at = ?,
               metadata = ?
         WHERE id = ?
           AND status = 'claimed'
           AND claimed_by IS ?
           AND updated_at = ?
      `).run(updateTime, JSON.stringify(metadata), id, worker, workingRow.updated_at));
    }
  }
  if (result.changes !== 1) {
    rollbackOpenDoClaim(workingRow);
    return { staged: false, reason: 'stale_task_state' };
  }

  const payload = {
    stage: targetStage,
    goal: goalText,
    summary: cleanStageText(summary) || null,
    owner: stageOwner,
    exit: exitText || null,
    proof_needed: proofText || null,
    first_move: cleanStageText(firstMove) || null,
    next_button: metadata.next_button || null,
    confidence: Number.isFinite(confidenceValue) ? metadata.stage_confidence : null,
    plan_trace: targetStage === 'plan' && planTrace && typeof planTrace === 'object' ? planTrace : null,
  };
  payload.stage_packet = stagePacketFromPayload(payload);
  const updated = getTask(db, id);
  if ((claimedFromOpen || claimedFromUnowned) && targetStage === 'do') {
    appendTaskEvent(db, {
      taskId: id,
      workspaceRoot: updated.workspace_root,
      actor: claimedWorker,
      eventType: 'claimed',
      payload: { claimed_by: claimedWorker },
    });
  }
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: updated.workspace_root,
    actor: cleanStageText(actor) || null,
    eventType: targetStage === 'plan' ? 'task_planned' : 'work_started',
    payload,
  });
  return { staged: true, event, row: updated, stage_packet: payload.stage_packet };
}

function appendTaskEvent(db, { taskId, workspaceRoot: ws, actor, eventType, payload }) {
  if (!taskId) throw new Error('taskId required');
  if (!ws) throw new Error('workspaceRoot required');
  if (!eventType) throw new Error('eventType required');
  const current = db.prepare('SELECT MAX(version) AS version FROM task_events WHERE task_id = ?').get(taskId);
  const version = Number(current && current.version || 0) + 1;
  const eventId = newId();
  const now = Date.now();
  withBusyRetry(() => db.prepare(`
    INSERT INTO task_events (event_id, task_id, version, workspace_root, actor, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    taskId,
    version,
    ws,
    actor || null,
    eventType,
    payload ? JSON.stringify(payload) : null,
    now,
  ));
  return {
    event_id: eventId,
    task_id: taskId,
    version,
    workspace_root: ws,
    actor: actor || null,
    event_type: eventType,
    payload: payload || null,
    created_at: now,
  };
}

function listTaskEvents(db, { taskId, workspaceRoot: ws, limit, order = 'asc' }) {
  const where = [];
  const args = [];
  if (taskId) { where.push('task_id = ?'); args.push(taskId); }
  if (ws) { where.push('workspace_root = ?'); args.push(ws); }
  const sort = String(order || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const sql = `
    SELECT event_id, task_id, version, workspace_root, actor, event_type, payload, created_at
    FROM task_events
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at ${sort}, version ${sort}
    ${limit ? 'LIMIT ' + Number(limit) : ''}
  `;
  return db.prepare(sql).all(...args).map(r => ({
    ...r,
    payload: r.payload ? safeJSON(r.payload) : null,
  }));
}

function noteTask(db, { id, actor, content }) {
  if (!id) throw new Error('id required');
  const text = String(content || '').trim();
  if (!text) throw new Error('content required');
  const row = getTask(db, id);
  if (!row) return { noted: false, reason: 'not_found' };
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: row.workspace_root,
    actor: actor || null,
    eventType: 'message',
    payload: { content: text },
  });
  return { noted: true, event };
}

function normalizeTagToken(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// Update a task's flag list (`metadata.tags`) on an already-created task.
// Tags are only settable at creation elsewhere; this is the after-the-fact
// escape hatch so an open task that becomes an owner decision can be marked
// `needs-human`, which sweep and fleet staffing both honor, instead of
// being restaffed forever (CLI-879). Every change appends a
// `task_tags_updated` event so the trail shows who flagged it and when.
function tagTask(db, { id, actor, add = [], remove = [] } = {}) {
  if (!id) throw new Error('id required');
  const addTags = [...new Set((Array.isArray(add) ? add : [add]).map(normalizeTagToken).filter(Boolean))];
  const removeSet = new Set((Array.isArray(remove) ? remove : [remove]).map(normalizeTagToken).filter(Boolean));
  if (!addTags.length && !removeSet.size) return { tagged: false, reason: 'no_tags' };
  const row = getTask(db, id);
  if (!row) return { tagged: false, reason: 'not_found' };
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  const before = [...new Set((Array.isArray(metadata.tags) ? metadata.tags : []).map(normalizeTagToken).filter(Boolean))];
  const removed = [];
  const next = before.filter((tag) => {
    if (removeSet.has(tag)) { removed.push(tag); return false; }
    return true;
  });
  const added = [];
  for (const tag of addTags) {
    // An explicit --remove of the same token wins over --add.
    if (removeSet.has(tag)) continue;
    if (!next.includes(tag)) { next.push(tag); added.push(tag); }
  }
  if (!added.length && !removed.length) {
    return { tagged: false, reason: 'no_changes', tags: before };
  }
  metadata.tags = next;
  const actorText = cleanStageText(actor) || null;
  const now = Math.max(Date.now(), Number(row.updated_at || 0) + 1);
  const result = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET metadata = ?,
           updated_at = ?
     WHERE id = ?
       AND updated_at = ?
  `).run(JSON.stringify(metadata), now, id, row.updated_at));
  if (result.changes !== 1) return { tagged: false, reason: 'stale_task_state' };
  const updated = getTask(db, id);
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: updated.workspace_root,
    actor: actorText,
    eventType: 'task_tags_updated',
    payload: { added, removed, tags: next, previous_tags: before },
  });
  return { tagged: true, event, row: updated, tags: next, added, removed };
}

function taskChatPacketFromPayload(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const lines = ['TASK_CHAT_UPDATE'];
  if (data.goal) lines.push(`goal: ${data.goal}`);
  if (data.summary) lines.push(`summary: ${data.summary}`);
  if (data.content) lines.push(`message: ${data.content}`);
  return lines.join('\n');
}

function chatTask(db, { id, actor, content, goal, summary }) {
  if (!id) throw new Error('id required');
  const text = cleanStageText(content);
  const goalText = cleanStageText(goal);
  const summaryText = cleanStageText(summary);
  if (!text && !goalText && !summaryText) return { chatted: false, reason: 'content_required' };
  const row = getTask(db, id);
  if (!row) return { chatted: false, reason: 'not_found' };
  if (['done', 'failed'].includes(row.status)) return { chatted: false, reason: `already_${row.status}` };

  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  const previousGoal = cleanStageText(metadata.task_goal || metadata.goal_objective || metadata.objective || metadata.stage_goal);
  const actorText = cleanStageText(actor) || null;
  const now = Math.max(Date.now(), Number(row.updated_at || 0) + 1);
  const payload = {
    content: text || null,
    goal: goalText || null,
    summary: summaryText || null,
    previous_goal: goalText && previousGoal && previousGoal !== goalText ? previousGoal : null,
  };
  payload.chat_packet = taskChatPacketFromPayload(payload);

  if (goalText || summaryText) {
    metadata.task_goal = goalText || metadata.task_goal || null;
    if (goalText && !metadata.goal_objective) metadata.goal_objective = goalText;
    if (goalText && !metadata.objective) metadata.objective = goalText;
    if (summaryText) metadata.task_summary = summaryText;
    metadata.task_refined_at = new Date(now).toISOString();
    metadata.task_refined_by = actorText;
    const updated = withBusyRetry(() => db.prepare(`
      UPDATE tasks
         SET metadata = ?,
             updated_at = ?
       WHERE id = ?
         AND updated_at = ?
    `).run(JSON.stringify(metadata), now, id, row.updated_at));
    if (updated.changes !== 1) return { chatted: false, reason: 'stale_task_state' };
  }

  const latest = goalText || summaryText ? getTask(db, id) : row;
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: latest.workspace_root,
    actor: actorText,
    eventType: 'task_chat',
    payload,
  });
  return {
    chatted: true,
    event,
    row: latest,
    goal_changed: Boolean(goalText && goalText !== previousGoal),
    chat_packet: payload.chat_packet,
  };
}

function reviewTask(db, { id, actor, reward, lesson, nextTask, proof, verify, careerXpEligible = false, clearedFields = [], landing = {}, autoAccepted = false }) {
  if (!id) throw new Error('id required');
  const row = getTask(db, id);
  if (!row) return { reviewed: false, reason: 'not_found' };
  const numericReward = Number.isFinite(Number(reward)) ? Number(reward) : 0;
  const now = Date.now();
  const reviewer = actor || process.env.ATRIS_AGENT_ID || process.env.USER || null;
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  const reviewerNorm = reviewIntegrity.normalizeActor(reviewer);
  const builderNorm = reviewIntegrity.taskBuilder(row);
  // judge != worker applies pre-acceptance only: a builder cannot positive-
  // reward their own row while it still sits in review. Done rows are past
  // the human gate; finish and post-acceptance XP bookkeeping stay open.
  if (numericReward > 0 && row.status === 'review' && builderNorm && reviewerNorm && reviewerNorm === builderNorm) {
    return { reviewed: false, reason: 'judge_equals_worker', builder: builderNorm };
  }
  const proofText = String(proof || '').trim();
  const verifyText = cleanStageText(verify);
  const lessonText = String(lesson || '').trim();
  const nextTaskText = String(nextTask || '').trim();
  const clearedReviewFields = Array.isArray(clearedFields)
    ? Array.from(new Set(clearedFields.filter(field => field === 'lesson' || field === 'next_task')))
    : [];
  const landingInput = landing && typeof landing === 'object' ? landing : {};
  let landingUpdated = false;
  for (const key of ['happened', 'checked', 'tested', 'decision']) {
    const cleaned = cleanLandingText(landingInput[key]);
    if (cleaned) {
      metadata[`landing_${key}`] = cleaned;
      landingUpdated = true;
    }
  }
  const reviewingPendingProof = row.status === 'review'
    && metadata.approval_status === 'pending'
    && numericReward <= 0
    && metadata.agent_certified !== true;
  const updatingPendingReviewProof = row.status === 'review'
    && metadata.approval_status === 'pending'
    && numericReward <= 0
    && Boolean(proofText || verifyText || lessonText || nextTaskText || clearedReviewFields.length);
  let reviewPassCount = Number(metadata.agent_review_pass_count || 0);
  if (reviewingPendingProof || updatingPendingReviewProof) {
    metadata.agent_reviewed_at = new Date(now).toISOString();
    metadata.agent_reviewed_by = reviewer;
    if (proofText) metadata.latest_agent_proof = proofText;
    if (verifyText) {
      // Gate at the write path, not just cmdReview: a verify the strict parser
      // rejects can never be run by the hourly autoland recheck, so storing it
      // silently parks the task on a human forever (observed 2026-07-31: five
      // certified tasks stalled for days on unrunnable verifies stored by
      // fleet lanes that bypass the command-layer gate).
      const parsedVerify = parseVerifyCommand(verifyText);
      if (!parsedVerify.ok) {
        const error = new Error(
          `verify command is not runnable by the hourly recheck (${parsedVerify.reason || 'verify_command_not_allowed'}); `
          + 'use an allowlisted shape: cd backend && ../venv/bin/python -m pytest <file> -q, '
          + 'test -s <artifact>, npm test, node --test <file>, tsc, or git diff --check',
        );
        error.reason = parsedVerify.reason || 'verify_command_not_allowed';
        throw error;
      }
      metadata.verify = verifyText;
      metadata.latest_agent_verify = verifyText;
    }
    if (clearedReviewFields.includes('lesson')) metadata.latest_agent_lesson = null;
    else if (lessonText) metadata.latest_agent_lesson = lessonText;
    if (clearedReviewFields.includes('next_task')) metadata.latest_agent_next_task = null;
    else if (nextTaskText) metadata.latest_agent_next_task = nextTaskText;
  }
  if (reviewingPendingProof) {
    reviewPassCount += 1;
    metadata.agent_review_pass_count = reviewPassCount;
    const passRecord = recordReviewPassActor(metadata, row.claimed_by, reviewer);
    if (reviewPassCount >= AGENT_CERTIFICATION_REVIEW_PASSES && passRecord.independent) {
      metadata.agent_certified = true;
      metadata.agent_certified_at = new Date(now).toISOString();
      metadata.agent_certified_by = reviewer;
      metadata.agent_certification_policy = `${AGENT_CERTIFICATION_REVIEW_PASSES}_agent_review_passes`;
      metadata.independent_review_by = passRecord.independent;
    }
  }
  if (numericReward > 0 && row.status === 'done') {
    metadata.approval_status = 'accepted';
    metadata.accepted_at = new Date().toISOString();
    metadata.accepted_by = reviewer;
  }
  if (reviewingPendingProof || updatingPendingReviewProof || (numericReward > 0 && row.status === 'done') || landingUpdated) {
    withBusyRetry(() => db.prepare(`
      UPDATE tasks
         SET metadata = ?,
             updated_at = ?
       WHERE id = ?
    `).run(JSON.stringify(metadata), now, id));
  }
  const payload = {
    reward: numericReward,
    lesson: lessonText,
    next_task: nextTaskText || null,
    proof: proofText || null,
    verify: verifyText || null,
    career_xp_eligible: Boolean(careerXpEligible),
  };
  if (autoAccepted) payload.auto_accepted = true;
  if (reviewingPendingProof) {
    payload.review_pass_count = reviewPassCount;
    payload.agent_certified = metadata.agent_certified === true;
    payload.agent_certification_policy = metadata.agent_certification_policy || null;
  }
  if (landingUpdated) {
    payload.landing = {
      happened: metadata.landing_happened || null,
      checked: metadata.landing_checked || null,
      tested: metadata.landing_tested || null,
      decision: metadata.landing_decision || null,
    };
  }
  if (clearedReviewFields.length) payload.cleared_review_fields = clearedReviewFields;
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: row.workspace_root,
    actor: reviewer,
    eventType: 'reviewed',
    payload,
  });
  const episode = taskEpisodeFromReview({ ...row, metadata }, event, payload);
  appendTaskEpisode(row.workspace_root, episode);
  return { reviewed: true, event, episode };
}

function compactEpisodeText(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function goalSignalFromTaskMetadata(metadata) {
  const goalId = compactEpisodeText(metadata.goal_id || metadata.goalId || metadata.goal?.id || '', 120);
  const objective = compactEpisodeText(
    metadata.task_goal || metadata.goal_objective || metadata.goalObjective || metadata.goal?.objective || metadata.goal || '',
    240,
  );
  if (!goalId && !objective) return null;
  return {
    goal_id: goalId,
    objective,
  };
}

function reviewOutcomeLabel(reward) {
  const value = Number(reward);
  if (!Number.isFinite(value)) return 'reviewed';
  if (value > 0) return 'accepted';
  if (value < 0) return 'rejected';
  return 'revised';
}

function reviewLandingSignal(metadata) {
  const landing = {
    happened: compactEpisodeText(metadata.landing_happened, 220),
    checked: compactEpisodeText(metadata.landing_checked, 220),
    tested: compactEpisodeText(metadata.landing_tested, 260),
    decision: compactEpisodeText(metadata.landing_decision, 220),
  };
  const present = Object.entries(landing)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key);
  const missing = Object.keys(landing).filter(key => !landing[key]);
  return {
    landing: present.length ? landing : null,
    quality: {
      present,
      missing,
      completeness: present.length / Object.keys(landing).length,
      has_decision: Boolean(landing.decision),
    },
  };
}

function humanFeedbackFromMetadata(metadata, label, payload = {}) {
  return {
    approval_status: metadata.approval_status || (label === 'accepted' ? 'accepted' : label),
    human_revision_count: Number(metadata.human_revision_count || 0),
    human_revision_note: metadata.human_revision_note || payload.note || null,
  };
}

function taskEpisodeFromReview(row, event, payload) {
  const metadata = row.metadata || {};
  const rewardValue = Number(payload.reward);
  const hasProof = Boolean(String(payload.proof || '').trim());
  const label = reviewOutcomeLabel(payload.reward);
  const doneForXp = row.status === 'done';
  const landingSignal = reviewLandingSignal(metadata);
  const humanFeedback = humanFeedbackFromMetadata(metadata, label, payload);
  return {
    schema: 'atris.task_episode.v1',
    tree_hash: treeHashFor(row.workspace_root),
    episode_id: event.event_id,
    task_id: row.id,
    workspace_root: row.workspace_root,
    created_at: new Date(event.created_at).toISOString(),
    state: {
      title: row.title,
      status: row.status,
      tag: row.tag,
      claimed_by: row.claimed_by,
      metadata,
    },
    action: {
      event_type: 'reviewed',
      actor: event.actor || null,
      version: event.version,
    },
    reward: {
      value: payload.reward,
      source: 'task_review',
    },
    lesson: payload.lesson,
    proof: payload.proof,
    next_task_suggestion: payload.next_task,
    goal: goalSignalFromTaskMetadata(metadata),
    review_landing: landingSignal.landing,
    landing_quality: landingSignal.quality,
    human_feedback: humanFeedback,
    career_xp: {
      eligible: payload.career_xp_eligible === true && label === 'accepted' && hasProof && doneForXp,
      source: 'task_review',
      reward: Number.isFinite(rewardValue) ? rewardValue : 0,
      proof_required: true,
    },
    rl: {
      label,
      source: 'task_review',
      reward: Number.isFinite(rewardValue) ? rewardValue : 0,
      has_proof: hasProof,
      has_lesson: Boolean(String(payload.lesson || '').trim()),
      has_next_task: Boolean(String(payload.next_task || '').trim()),
      landing_completeness: landingSignal.quality.completeness,
      approval_status: humanFeedback.approval_status,
    },
  };
}

function taskEpisodeFromRevision(row, event, payload) {
  const metadata = row.metadata || {};
  const landingSignal = reviewLandingSignal(metadata);
  const humanFeedback = humanFeedbackFromMetadata(metadata, 'revise', payload);
  return {
    schema: 'atris.task_episode.v1',
    tree_hash: treeHashFor(row.workspace_root),
    episode_id: event.event_id,
    task_id: row.id,
    workspace_root: row.workspace_root,
    created_at: new Date(event.created_at).toISOString(),
    state: {
      title: row.title,
      status: row.status,
      tag: row.tag,
      claimed_by: row.claimed_by,
      metadata,
    },
    action: {
      event_type: 'revision_requested',
      actor: event.actor || null,
      version: event.version,
    },
    reward: {
      value: 0,
      source: 'task_revision',
    },
    lesson: '',
    proof: null,
    next_task_suggestion: null,
    goal: goalSignalFromTaskMetadata(metadata),
    review_landing: landingSignal.landing,
    landing_quality: landingSignal.quality,
    human_feedback: humanFeedback,
    career_xp: {
      eligible: false,
      source: 'task_revision',
      reward: 0,
      proof_required: true,
    },
    rl: {
      label: 'rework_requested',
      source: 'task_revision',
      reward: 0,
      has_proof: false,
      has_lesson: false,
      has_next_task: false,
      landing_completeness: landingSignal.quality.completeness,
      approval_status: humanFeedback.approval_status,
    },
  };
}

function appendTaskEpisode(workspaceRoot, episode) {
  const filePath = path.join(workspaceRoot, TASK_EPISODES_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(episode) + '\n', 'utf8');
  return filePath;
}

function clipProjectionText(value, max = PROJECTION_PAYLOAD_TEXT_LIMIT) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function compactProjectionPayload(value) {
  if (typeof value === 'string') return clipProjectionText(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(compactProjectionPayload);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = clipProjectionText(item);
    else if (item && typeof item === 'object') out[key] = compactProjectionPayload(item);
    else out[key] = item;
  }
  return out;
}

function compactProjectionEvent(event) {
  return {
    ...event,
    payload: compactProjectionPayload(event.payload),
  };
}

function selectProjectionRows(rows, { taskId, includeHistory, doneLimit }) {
  if (taskId || includeHistory) {
    return {
      visibleRows: rows,
      hiddenDoneCount: 0,
      hiddenArchivedCount: 0,
    };
  }
  const visibleRows = [];
  let shownDone = 0;
  let hiddenDoneCount = 0;
  // Archived rows get the same recency cap as done rows. Without it the
  // projection carries every archived task forever (full events/messages) and
  // the file balloons; `--history` or a taskId still returns everything.
  let shownArchived = 0;
  let hiddenArchivedCount = 0;
  for (const row of rows) {
    if (row.status === 'done') {
      if (shownDone < doneLimit) {
        visibleRows.push(row);
        shownDone += 1;
      } else {
        hiddenDoneCount += 1;
      }
      continue;
    }
    if (row.status === 'archived') {
      if (shownArchived < doneLimit) {
        visibleRows.push(row);
        shownArchived += 1;
      } else {
        hiddenArchivedCount += 1;
      }
      continue;
    }
    visibleRows.push(row);
  }
  return { visibleRows, hiddenDoneCount, hiddenArchivedCount };
}

function taskProjection(db, {
  workspaceRoot: ws,
  taskId,
  limit = 500,
  includeHistory = Boolean(taskId),
  doneLimit = PROJECTION_DONE_LIMIT,
  eventLimit = PROJECTION_EVENT_LIMIT,
  messageLimit = PROJECTION_MESSAGE_LIMIT,
} = {}) {
  const rows = taskId
    ? [getTask(db, taskId)].filter(Boolean)
    : listTasks(db, { workspaceRoot: ws || null, limit });
  const refRows = taskId && rows[0]
    ? listTasks(db, { workspaceRoot: rows[0].workspace_root })
    : listTasks(db, { workspaceRoot: ws || null });
  const refById = new Map(withTaskDisplayRefs(refRows).map(row => [row.id, {
    display_id: row.display_id,
    legacy_ref: row.legacy_ref,
  }]));
  const { visibleRows, hiddenDoneCount, hiddenArchivedCount } = selectProjectionRows(rows, {
    taskId,
    includeHistory,
    doneLimit: Math.max(0, Number(doneLimit) || 0),
  });
  const events = listTaskEvents(db, {
    taskId: taskId || null,
    workspaceRoot: taskId ? null : (ws || null),
    limit: limit * 20,
  });
  const byTask = new Map();
  for (const e of events) {
    if (!byTask.has(e.task_id)) byTask.set(e.task_id, []);
    byTask.get(e.task_id).push(e);
  }
  return {
    schema: 'atris.task_projection.v1',
    generated_at: new Date().toISOString(),
    workspace_root: ws || (rows[0] && rows[0].workspace_root) || null,
    surface: {
      compact: !includeHistory,
      full_task_count: rows.length,
      visible_task_count: visibleRows.length,
      hidden_done_count: hiddenDoneCount,
      hidden_archived_count: hiddenArchivedCount,
      done_limit: includeHistory ? null : Math.max(0, Number(doneLimit) || 0),
      event_limit: includeHistory ? null : Math.max(0, Number(eventLimit) || 0),
      message_limit: includeHistory ? null : Math.max(0, Number(messageLimit) || 0),
      full_ledger_command: taskId ? `atris task events ${taskId}` : 'atris task events --all',
    },
    tasks: visibleRows.map(row => {
      const taskEvents = byTask.get(row.id) || [];
      const latest = taskEvents.length ? taskEvents[taskEvents.length - 1] : null;
      const allMessages = taskEvents
        .filter(e => e.event_type === 'message' || e.event_type === 'task_chat' || e.event_type === 'task_planned' || e.event_type === 'work_started' || e.event_type === 'task_backlogged')
        .map(e => ({
          version: e.version,
          actor: e.actor,
          content: e.event_type === 'message'
            ? (e.payload && e.payload.content || '')
            : e.event_type === 'task_chat'
              ? (e.payload && (e.payload.chat_packet || taskChatPacketFromPayload(e.payload)) || '')
            : e.event_type === 'task_backlogged'
              ? (e.payload && backlogPacketFromPayload(e.payload) || '')
              : (e.payload && (e.payload.stage_packet || stagePacketFromPayload(e.payload)) || ''),
          created_at: e.created_at,
        }));
      const visibleMessages = includeHistory
        ? allMessages
        : allMessages.slice(-Math.max(0, Number(messageLimit) || 0)).map(message => ({
          ...message,
          content: clipProjectionText(message.content),
        }));
      const visibleEvents = includeHistory ? taskEvents : taskEvents.slice(-Math.max(0, Number(eventLimit) || 0)).map(compactProjectionEvent);
      return {
        id: row.id,
        ...(refById.get(row.id) || {}),
        title: row.title,
        // First layer, ahead of the detail. Legacy rows with no stored
        // explanation get the same three fields derived here.
        explanation: taskExplanation(row),
        result: row.metadata && row.metadata.result || null,
        status: row.status,
        tag: row.tag,
        workspace_root: row.workspace_root,
        claimed_by: row.claimed_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        done_at: row.done_at,
        metadata: row.metadata || {},
        current_version: latest ? latest.version : 0,
        latest_event_type: latest ? latest.event_type : null,
        messages: visibleMessages,
        events: visibleEvents,
        history: {
          event_count: taskEvents.length,
          message_count: allMessages.length,
          events_visible: visibleEvents.length,
          messages_visible: visibleMessages.length,
          events_truncated: !includeHistory && taskEvents.length > visibleEvents.length,
          messages_truncated: !includeHistory && allMessages.length > visibleMessages.length,
        },
      };
    }),
  };
}

function renderTodoMarkdown(rows, { title = 'TODO.md', doneLimit = TODO_RENDER_DONE_LIMIT, failedLimit = TODO_RENDER_FAILED_LIMIT, refRows = rows, preservedSections = [] } = {}) {
  const displayRows = withTaskDisplayRefs(rows, refRows);
  const buckets = {
    open: displayRows.filter(r => r.status === 'open'),
    claimed: displayRows.filter(r => r.status === 'claimed'),
    review: displayRows.filter(r => r.status === 'review'),
    failed: displayRows.filter(r => r.status === 'failed'),
    done: displayRows.filter(r => r.status === 'done'),
  };
  const lines = [`# ${title}`, '', '> Regenerated from durable Atris task state. Do not treat this file as truth.', ''];
  for (const section of preservedSections) {
    const text = String(section || '').trim();
    if (!text) continue;
    lines.push(text, '');
  }
  appendSection(lines, 'Backlog', buckets.open);
  appendSection(lines, 'In Progress', buckets.claimed);
  appendSection(lines, 'Review', buckets.review);
  const renderedFailed = buckets.failed.slice(0, Math.max(0, Number(failedLimit) || 0));
  appendSection(lines, 'Blocked', renderedFailed);
  const archivedFailed = Math.max(0, buckets.failed.length - renderedFailed.length);
  if (archivedFailed > 0) {
    lines.push(`(${archivedFailed} older blocked task${archivedFailed === 1 ? '' : 's'} archived in \`atris task list --status failed\` and \`atris task events\`.)`, '');
  }
  const renderedDone = buckets.done.slice(0, Math.max(0, Number(doneLimit) || 0));
  appendSection(lines, 'Completed', renderedDone);
  const archivedDone = Math.max(0, buckets.done.length - renderedDone.length);
  if (archivedDone > 0) {
    lines.push(`(${archivedDone} older completed task${archivedDone === 1 ? '' : 's'} archived in \`atris task list --status done\` and \`atris task events\`.)`, '');
  }
  while (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

function appendSection(lines, name, rows) {
  lines.push(`## ${name}`, '');
  if (!rows.length) {
    lines.push('(Empty)', '');
    return;
  }
  for (const row of rows) {
    const meta = row.metadata || {};
    const tags = Array.isArray(meta.todo_tags) && meta.todo_tags.length
      ? meta.todo_tags
      : (row.tag ? [row.tag] : []);
    const tag = [...new Set(tags.filter(Boolean).map(value => String(value).trim()).filter(Boolean))]
      .map(value => ` [${value}]`)
      .join('');
    // Decision holds live in metadata.tags (or the primary tag). Surface them
    // so a human judgment row never blends into ordinary work on the board.
    const decision = isDecisionTask(row) ? ' [decision]' : '';
    const displayRef = meta.todo_id || row.display_id || row.id;
    const explanation = taskExplanation(row);
    // The plain face leads. The exact original title remains immediately below
    // it so old TODO-only projects and deep inspection keep full fidelity.
    lines.push(`- **[${displayRef}]** ${explanation.what_changes}${tag}${decision}`);
    lines.push(`  **Why it matters:** ${explanation.why_it_matters}`);
    lines.push(`  **Done looks like:** ${explanation.done_looks_like}`);
    lines.push(`  **Approve or change:** \`atris task show ${displayRef}\` shows the actions allowed by the current plan and proof checks.`);
    lines.push(`  **Technical details:** ${row.title}`);
    if (row.claimed_by && row.status === 'claimed') lines.push(`  **Claimed by:** ${row.claimed_by}`);
    if (meta.verify) lines.push(`  **Verify:** ${meta.verify}`);
  }
  lines.push('');
}

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Wrap a write op so SQLITE_BUSY (concurrent writers from other processes)
// retries with exponential backoff. busy_timeout pragma alone leaks busy
// errors under spawn-storm contention with node:sqlite (~3% raw lock rate
// observed at 1000 attempts). Total wait ≤ ~6s; well above realistic
// contention windows for our agent fleet.
function withBusyRetry(fn, attempts = 8) {
  let delay = 5;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return fn(); }
    catch (e) {
      lastErr = e;
      const msg = String(e && e.message || '');
      const code = e && (e.code || e.errcode);
      const busy = /SQLITE_BUSY|database is locked/i.test(msg) || code === 'SQLITE_BUSY' || code === 5;
      if (!busy) throw e;
      // Sleep synchronously, node:sqlite is sync; matches the rest of the API
      const end = Date.now() + delay + Math.floor(Math.random() * delay);
      while (Date.now() < end) {} // tight loop is fine, delay is small
      delay = Math.min(delay * 2, 500);
    }
  }
  throw lastErr;
}

module.exports = {
  open,
  close,
  getDbPath,
  workspaceRoot,
  sourceKey,
  normalizeTitle,
  addTask,
  getTask,
  listTasks,
  claimTask,
  releaseTask,
  reopenTask,
  backlogTask,
  clearPlanTasks,
  doneTask,
  reapMissionBlockerTasks,
  archiveTask,
  relabelArchivedTasks,
  readyTask,
  setTaskResult,
  reviseTask,
  stageTask,
  noteTask,
  chatTask,
  tagTask,
  reviewTask,
  appendTaskEvent,
  listTaskEvents,
  taskProjection,
  renderTodoMarkdown,
  normalizeTaskRef,
  taskDisplayRefMap,
  withTaskDisplayRefs,
  newId,
};
