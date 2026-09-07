// `atris task` - SQLite-backed task state. TODO.md is a regenerated view;
// events are the durable trail that web/desktop/cloud projections can read.

'use strict';

const fs = require('fs');
const http = require('http');
const { execSync } = require('node:child_process');
const path = require('path');
const os = require('os');
const { hasFlag } = require('../lib/arg-parser');
const { argsWantHelp } = require('../lib/noninteractive');
const {
  compactErrorPayload,
  compactSuccessPayload,
  printCliJson,
} = require('../lib/cli-json');
const {
  taskProofState,
  LOCAL_SUCCESS_PROOF_EXAMPLE,
  unrunNamedProofCommandIssue,
} = require('../lib/task-proof');
const {
  candidatePolicyGate,
  evaluateAutoAccept,
  isAgentCertified,
  isAutoCertifyVerifyCommandAllowed,
  parseVerifyCommand,
  runVerifyCommand,
  runVerifyCommandCached,
  DENIED_TAGS,
} = require('../lib/auto-accept-certified');
const { evaluateAcceptVerify } = require('../lib/accept-verify-gate');
const {
  taskExplanation,
  explanationFieldsFromInput,
  explanationLines,
  taskApprovalControls,
  approvalLines,
} = require('../lib/task-explanation');
const { extractReceiptEvidence, RECEIPT_PATH_PATTERN } = require('../lib/receipt-evidence');
const escapeRegExp = require('../lib/escape-regexp');
const reviewIntegrity = require('../lib/review-integrity');
const { gateForHuman, isRetiredFillerReason, landingWhyClause, numberWord, plainLandingReason } = require('../lib/voice-gate');
const {
  normalizeOwnerSlug,
  resolveFunctionalOwner: resolveFunctionalTaskOwner,
} = require('../lib/functional-owner');
const { operatorReady, hasAgentJargon, explainResult } = require('./autoland');
const {
  TASK_INSPECT_FIELDS,
  readFieldsFlag,
  stripInspectArgs,
  validateFields,
  inspectTextLines,
  buildInspectPayload,
} = require('../lib/inspect-fields');
const {
  isDecisionTask,
  decisionMarkerFor,
  DECISION_REFUSE_REASON,
} = require('../lib/task-decision');
const {
  buildFirstMinute,
  deskNextCommand,
  firstTalkCommand,
  folderName,
  personName,
  pickNext,
  speakFirstMinute,
  taskCommand,
  taskNextCommand,
} = require('../lib/first-minute');
const { loadContext } = require('../lib/state-detection');

const DEFAULT_OWNER = process.env.ATRIS_AGENT_ID
  || process.env.USER
  || os.userInfo().username
  || 'unknown';
const AGENT_CERTIFICATION_REVIEW_PASSES = 2;
const RESULT_SAVED_TEXT_LIMIT = 200;
const REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS = 3;
const REVIEW_LANE_LOOP_MAX_STEPS = 10;
const REVIEW_LANE_RUN_DEFAULT_MAX_RUNS = 3;
const REVIEW_LANE_RUN_MAX_RUNS = 20;
const PENDING_REVIEW_CHAT_STOP_REASON = 'pending_review_chat_waiting_for_agent_review';
const PROOF_BOUNDARY_BLOCKED_ACTION = 'proof_boundary_blocked';
const PROOF_BOUNDARY_BLOCKED_REASON = 'proof_boundary_blocked_requires_revision';
const MISSION_XP_END_TO_END_REASON = 'mission_xp_requires_end_to_end_receipt';
const MISSION_XP_END_TO_END_DETAIL = 'mission XP proof must name a zero-papercut end-to-end fresh-laptop pass through install, init, first mission, and first self-landed task; generic mission/tick receipts are not enough';
const READY_RESULT_TEACHING = 'ready needs --result: one plain sentence someone new to the project can understand. say what someone can do now and why it matters. no ids, no paths, no commands. example: operators can now read the whole team day on one page instead of scrolling raw logs.';
const REVIEW_AUTO_ACCEPT_ACTOR = 'auto (certified, small)';
const REVIEW_AUTO_ACCEPT_POLICY = 'review_autoaccept_certified_small';
const REVIEW_AUTO_ACCEPT_FILE_LIMIT = 10;
const REVIEW_AUTO_ACCEPT_LINE_LIMIT = 300;

const STATUS_PLAN_TAGS = new Set([
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
const TASK_QUEUE_COLUMN_ORDER = ['do', 'review', 'plan', 'backlog', 'blocked', 'done'];
const TASK_QUEUE_COLUMN_LABELS = {
  backlog: 'Backlog',
  plan: 'Plan',
  do: 'Do',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
};
const TASK_REVIEW_STATE_LANES = ['needs-agent', 'continue-work', 'proof-boundary-blocked', 'human-accept-waiting', 'certified'];
const TASK_REVIEW_STATE_ALIASES = {
  'needs-agent': ['needs-review', 'agent-review'],
  'continue-work': ['continue', 'agent-actionable', 'executable'],
  'proof-boundary-blocked': ['proof-boundary', 'boundary-blocked', 'stale-pr-proof', 'unmerged-pr-proof'],
  'human-accept-waiting': ['human-accept', 'accept-waiting', 'waiting-accept', 'no-next-task'],
  certified: ['waiting-human', 'human-waiting'],
};

let taskDbModule = null;

function getTaskDb() {
  if (taskDbModule) return taskDbModule;
  try {
    taskDbModule = require('../lib/task-db');
    return taskDbModule;
  } catch (e) {
    const message = String(e && (e.message || e));
    const missingSqlite = e && (
      e.code === 'ERR_UNKNOWN_BUILTIN_MODULE'
      || /node:sqlite|No such built-in module/i.test(message)
    );
    if (missingSqlite) {
      console.error('atris task requires Node.js 22+ because it uses built-in node:sqlite.');
      console.error('Use the markdown TODO.md flow on older Node versions.');
      process.exit(1);
    }
    throw e;
  }
}

function warnIfTaskTitleNeedsOperatorWhy(title, options = {}) {
  const text = String(title || '').trim();
  if (!text || operatorReady(text)) return null;
  const warning = 'Warning: put the why in this task title in plain words: what it buys or costs, and who benefits. Drop flags and ids.';
  if (options.print !== false) console.error(warning);
  return warning;
}

function taskUsageText() {
  return `
atris task - durable local task state (SQLite, gitignored)

  golden path (one tick, by cron or by hand):
    atris task delegate "fix the login bug" --to <member>
    atris task claim <id> --as <member>
    ... build ...
    atris task ready <id> --verify
    atris autoland tick   # second check runs, task lands

  atris task                              Same two-line next as bare atris
  atris task desk [--all]                 Show the full task desk
  atris task new "<title>" [--what-changes "..."] [--why-it-matters "..."] [--done-looks-like "..."] [--verify <cmd>]
                                           Create a task with a plain explanation; omitted fields get honest defaults
  atris task next [--tag <tag>] [--create-next]
                                           Same next command as bare atris and the task desk; --create-next still seeds Endgame fallback
  atris task continue-work <id>           Create/reuse a certified Review follow-up task
  atris task say <id> "<message>"         Add context to a task
  atris task chat <id> "<message>" [--goal "..."]  Refine a task chat + working goal
  atris task ready <id> --proof "..." --result "<sentence>"
                                           Agent proof ready; native goal can complete
  atris task ready <id> --verify "<cmd>" --result "<sentence>"
                                           Run <cmd>; only ready if it exits 0 (executed proof)
                                           Writes atris/runs/ receipt (pass or fail); that local pass is enough proof
                                           Optional CI URL only with --proof-url and --i-fetched
  atris task receipt <id> --verify "<cmd>" Run <cmd> and write an atris/runs/ receipt without going to ready
  atris task plan-preview "<purpose>" [--tag <tag>] [--owner <member>] [--task <id>]
                                           Show the plain Plan before work starts
  atris task ready <id> --proof "..." --result "<sentence>" [--changed "..." --checked "..." --saved "..." --try "..."]
                                           Agent proof ready; records Result if needed
  atris task ready <id> --proof "..." --result "<sentence>" [--happened "..." --checked "..." --tested "..." --decision "..."]
                                           Agent proof ready; writes the human result receipt
  atris task result <id> "<sentence>"       Set or replace the day-one PM result sentence
  atris task result <id> --changed "..." --checked "..." [--saved "..."] [--try "..."]
                                           Show the plain Result and store trace on the task
  atris task review-chat <id> [--as <owner>]  Start a task-owned /codex verification chat
  atris task accept <id> [--proof "..."] [--public]
                                           Human accepts proof, marks done; --public also publishes AgentXP
  atris task certify-verified [--dry-run] [--limit <n>] [--as <actor>]
                                           Re-run the runnable check named in each Review proof as a second actor; passing rows certify (denied lanes and check-less rows wait for a human)
  atris task auto-accept-certified --dry-run [--strict-verify] [--all] [--limit <n>]
                                           Preview certified Review rows; live accept needs --confirm-human-accept --as <human>
  atris task sweep --auto-accept [--json]   Auto-accept verified Review rows; protected lanes wait for human
  atris task audit [--limit <n>] [--revise] re-run stored verifies for newest accepted tasks; report-only unless --revise
  atris task revise <id> --note "..."      Send reviewed work back to Do

  atris task add "<title>" [--tag <tag>] [--goal-id <id>] [--what-changes "..."] [--why-it-matters "..."] [--done-looks-like "..."] [--verify <cmd>]  Create a task
  atris task delegate "<title>" [--to <member>] [--executed-by <engine>] [--goal-id <id>] [--tag <tag>] [--what-changes "..."] [--why-it-matters "..."] [--done-looks-like "..."] [--verify <cmd>]  Create assigned work
  atris task plan <id> --goal "..." --exit "..." --proof-needed "..."
                                           Record a task-owned Plan stage
  atris task do <id> --as <owner> --first-move "..."
                                           Start task-owned Do work from the plan
  atris task backlog <id> [--reason "..."] Move a planned open task back to Backlog
  atris task clear-plan --yes              Move all planned open tasks back to Backlog
  atris task day [--full] [--all] [--everywhere] [--json]  show today's owner-grouped task list
                                           text shows eight current rows; --full shows every active row
                                           --all stays in this workspace; --everywhere spans workspaces
  atris task list [--all] [--everywhere] [--status <s>]
                                           list tasks in this workspace; --everywhere spans workspaces
  atris task claim <id> [--as <owner>]     Atomic claim
  atris task release <id> [--as <owner>]   Release your own mistaken claim back to open
  atris task capabilities [--json]         Read-only task CLI/API capability contract
  atris task capabilities-check [--json]   Verify task capability contract conformance
  atris task review-lane-drain [--json]    Pick next safe Review-lane agent action
  atris task review-lane-act [--json]      Execute next safe Review-lane agent action
  atris task review-lane-loop [--json]     Run bounded safe Review-lane actions
  atris task review-lane-run [--json]      Run bounded review-lane loops and write receipts
  atris task current [--json] [--goal-id <id>] [--tag <tag>] [--status <s>] [--review-state <lane>]
                                           Read-only best next task page + queue
  atris task queue [--json] [--goal-id <id>] [--tag <tag>] [--status <s>] [--review-state <lane>]
                                           Read-only task lanes + current page
  atris task current-step [--json] [--goal-id <id>] [--tag <tag>] [--review-state <lane>]
                                           Advance the scoped current task one safe step
                                           review-state lanes: needs-agent, continue-work, human-accept-waiting, certified
  atris task note <id> "<message>"         Append dialogue/context to a task
  atris task retitle <id> "<new title>"    Rename a task and preserve the old title in dialogue
  atris task tag <id> --add <tag> [--remove <tag>]
                                           Update tags on an existing task (e.g. --add needs-human to hold it
                                           from sweep + fleet staffing); logs a task_tags_updated event
  atris task show <id> [--json]            Show a task card + dialogue
  atris task inspect <id> --fields review,status,title [--json]
                                           Field-selectable task state (review metadata, status, title, owner, tag)
  atris task page <id> [--json]            Show the one-task page contract
  atris task step <id> [--json]            Refine chat, then advance one safe Plan/Do/Review step
  atris task done <id> --proof "..."       Mark complete with proof
  atris task done <id> --failed [--proof "..."]  Mark failed, optionally reviewed
  atris task archive <id> --reason "..." [--from-failed]
                                           Sweep off-roadmap/duplicate work as archived (not failed);
                                           --from-failed opts in to relabel a fail-closed row (never done)
  atris task clear-done [--before <days>] [--dry-run] [--json]  Archive completed rows, oldest first
  atris task reap-mission-blockers [--json] Close blocker rows whose missions are complete or stopped
  atris task relabel-archived [--dry-run|--apply]
                                           One-time OBL-1622 migration: relabel June-10 backlog-reset rows failed -> archived
  atris task finish <id> --proof "..."     Legacy alias for done with proof
  atris task review <id> --reward <n> [--verify "<cmd>"]
                                           Write review event + RSI episode
  atris task reviews [--all|--limit <n>] [--verbose]   Show certified Review items for human accept/revise
  atris task reviews --group-by <tag|owner|source>   Cluster approval-ready work for fast triage
  atris task accept-group <key>=<value> --spot-check K --confirm-human-accept --as <you> --verified <ids>
                                           Accept a whole cluster; career XP only on the K you verified
  atris task status [--json] [--history]   Compact live status for web/Swarlo
  atris task setup [--import-todo]         Create/refresh task projection
  atris task serve [--port <n>]            Open local task factory board
  atris task sync --dry-run                Plan cloud/Swarlo task sync writes
  atris task import <file>                 One-shot import from TODO.md
  atris task lineage <id> [--json]          Show endgame -> tasks -> commits chain
  atris task events [id] [--limit <n>]     print recent task events
  atris task events --all                  print the full current-workspace ledger
  atris task events --everywhere           print the full ledger across workspaces
  atris task export [--all] [--everywhere] [--out <file>]
                                           write web/desktop JSON projection
  atris task render [--all] [--everywhere] [--out <file>]
                                           regenerate compact TODO.md view from state
  atris task where                          Print db path + workspace scope
  atris task help                           This help

Confidence Gate:
  Before plan/do/review advances, find loopholes, patch them with proof,
  verifier, owner, rollback, or name the residual risk.

Env:
  ATRIS_TASKS_DB    Override db path (default ~/.atris/tasks.db)
  ATRIS_AGENT_ID    Owner id for claim/done (default: $USER)

Refs:
  Human views use semantic refs like OBL-18. Commands accept OBL-18,
  OBL18, full 26-char task IDs, and any unique legacy prefix. JSON/API
  keep the full id as canonical and also expose display_id + legacy_ref.

Headless:
  Add --json to task commands for machine-readable output and stable automation.
`.trim();
}

function taskUsageLines() {
  return taskUsageText().split('\n');
}

function help() {
  console.log(taskUsageText());
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] || true;
}

function taskScopeEverywhere(args = [], options = {}) {
  if (options.everywhere !== undefined) return Boolean(options.everywhere);
  return hasFlag(args, '--everywhere');
}

function scopedWorkspaceRoot(taskDb, args = [], options = {}) {
  return taskScopeEverywhere(args, options) ? null : taskDb.workspaceRoot();
}

function hasEmptyFlagValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] === '';
}

function wantsJson(args) {
  return hasFlag(args, '--json');
}

function parseAcceptReward(value, { defaultValue = 1 } = {}) {
  if (value === undefined || value === null || value === true) return { ok: true, value: defaultValue };
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { ok: false, reason: 'invalid_reward' };
  }
  return { ok: true, value: numeric };
}

function validHumanActorFlag(value) {
  if (typeof value !== 'string') return false;
  const actor = value.trim();
  return Boolean(actor) && !actor.startsWith('--') && actor !== 'auto-accept-certified';
}

const AGENT_ENV_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CURSOR_AGENT',
  'DEVIN_SESSION_ID',
];

function agentProofOnlyMode() {
  const explicit = process.env.ATRIS_AGENT_PROOF_ONLY;
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return AGENT_ENV_MARKERS.some((marker) => String(process.env[marker] || '').trim() !== '');
}

function failAgentProofOnly(label, detail) {
  failTask(
    label,
    'agent_proof_only_human_accept_blocked',
    detail || 'Agent proof-only mode can write notes, ready proof, and zero-reward reviews, but cannot mark tasks done or accept XP.',
  );
}

function printJson(value) {
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const retryWait = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(process.stdout.fd, buffer, offset, buffer.length - offset);
    } catch (err) {
      if (err && err.code === 'EAGAIN') {
        Atomics.wait(retryWait, 0, 0, 10);
        continue;
      }
      throw err;
    }
  }
}

function refreshCareerXpProjection(workspaceRoot) {
  if (!workspaceRoot) return null;
  try {
    const { collectLocalXpProjection } = require('../commands/xp');
    return collectLocalXpProjection(['--workspace', workspaceRoot]);
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
    };
  }
}

function refreshCareerXpAfterReview(reviewed) {
  return refreshCareerXpProjection(reviewed?.episode?.workspace_root);
}

function compactCareerXpProjection(projection) {
  if (!projection || typeof projection !== 'object') return projection;
  const progress = projection.next_level_progress && typeof projection.next_level_progress === 'object'
    ? {
      level: projection.next_level_progress.level ?? null,
      next_level: projection.next_level_progress.next_level ?? null,
      current_xp: projection.next_level_progress.current_xp ?? null,
      required_xp: projection.next_level_progress.required_xp ?? null,
      remaining_xp: projection.next_level_progress.remaining_xp ?? null,
      percent: projection.next_level_progress.percent ?? null,
    }
    : null;
  const latest = projection.latest_accepted_proof && typeof projection.latest_accepted_proof === 'object'
    ? {
      label: projection.latest_accepted_proof.label ?? null,
      receipt_id: projection.latest_accepted_proof.receipt_id ?? null,
      source: projection.latest_accepted_proof.source ?? null,
      source_task_id: projection.latest_accepted_proof.source_task_id ?? null,
      title: projection.latest_accepted_proof.title ?? null,
      xp: projection.latest_accepted_proof.xp ?? null,
      reward: projection.latest_accepted_proof.reward ?? null,
      accepted_at: projection.latest_accepted_proof.accepted_at ?? null,
      goal: projection.latest_accepted_proof.goal ?? null,
    }
    : null;
  const integrity = projection.integrity && typeof projection.integrity === 'object'
    ? {
      status: projection.integrity.status ?? null,
      receipts_count: projection.integrity.receipts_count ?? projection.receipts_count ?? null,
      head_hash: projection.integrity.head_hash ?? null,
    }
    : null;
  return {
    schema: projection.schema,
    compact: true,
    total_xp: projection.total_xp ?? projection.total_agent_xp ?? projection.agent_xp ?? null,
    agent_xp: projection.agent_xp ?? projection.total_agent_xp ?? null,
    today_xp: projection.today_xp ?? projection.today_agent_xp ?? null,
    collected_receipts: projection.collected_receipts ?? 0,
    receipts_count: projection.receipts_count ?? null,
    level: projection.level ?? null,
    leaderboard_eligible: projection.leaderboard_eligible ?? null,
    integrity_status: projection.integrity_status ?? integrity?.status ?? null,
    next_level_progress: progress,
    latest_accepted_proof: latest,
    integrity,
    omitted: [
      'contribution_graph',
      'career',
      'earning_model',
      'local_activity',
      'ledger',
      'sources',
    ],
  };
}

function jsonModeActive() {
  return process.argv.includes('--json');
}

function failTask(label, reason, detail, exitCode = 2) {
  if (jsonModeActive()) {
    printCliJson(
      {
        ok: false,
        command: label,
        reason,
        detail: detail || null,
        selected_ref: null,
        next_command: null,
      },
      compactErrorPayload({ reason, detail: detail || null }),
      process.argv.slice(2),
    );
  } else {
    console.error(detail || `${label}: ${reason}`);
  }
  process.exit(exitCode);
}

function refuseCandidatePolicyGate(label, gate) {
  if (jsonModeActive()) {
    printJson({ ok: false, command: label, ...gate });
  } else {
    console.error(`${label}: ${gate.reason}: ${gate.message}`);
    if (Array.isArray(gate.offenders)) {
      gate.offenders.forEach((offender) => console.error(`  ${offender}`));
    }
    if (Array.isArray(gate.lesson_ids) && gate.lesson_ids.length) {
      console.error(`  lessons: ${gate.lesson_ids.join(', ')}`);
    }
  }
  process.exit(1);
}

function proofFlagValue(args) {
  const proof = flag(args, '--proof');
  return typeof proof === 'string' ? proof.trim() : '';
}

function resultSentenceIssue(value, { allowCommandMention = false } = {}) {
  const check = explainResult(value, { allowCommandMention });
  return check.ok ? null : check.reason;
}

function readyResultDetail(reason) {
  return reason ? `${READY_RESULT_TEACHING}\n${reason}` : READY_RESULT_TEACHING;
}

function requireResultSentence(label, value, { ready = false, allowCommandMention = false } = {}) {
  const issue = resultSentenceIssue(value, { allowCommandMention });
  if (!issue) return String(value || '').replace(/\s+/g, ' ').trim();
  const detail = ready ? readyResultDetail(issue) : issue;
  failTask(label, 'weak_result', detail);
}

function weakProofDetail(issue) {
  return `meaningful proof required: ${issue}\n${LOCAL_SUCCESS_PROOF_EXAMPLE}`;
}

function requireMeaningfulTaskProof(label, proof, { required = true } = {}) {
  const issue = meaningfulTaskProofIssue(proof, { required });
  if (issue) failTask(label, 'weak_proof', weakProofDetail(issue));
}

function requireRanNamedProofCommand(label, proof, ranCommand = '') {
  const issue = unrunNamedProofCommandIssue(proof, ranCommand);
  if (issue) failTask(label, issue.reason, issue.detail);
}

function sendProofIssue(res, proof, issue) {
  return sendJson(res, 400, {
    ok: false,
    reason: String(proof || '').trim() ? 'weak_proof' : 'proof_required',
    detail: weakProofDetail(issue),
  });
}

function textFlag(args, names) {
  for (const name of names) {
    const value = flag(args, name);
    if (typeof value === 'string') return value.trim();
  }
  return '';
}

// Callers may write the plain explanation themselves. Anything they leave out
// gets an honest derived default at creation time.
function explanationFlags(args) {
  return explanationFieldsFromInput({
    what_changes: textFlag(args, ['--what-changes']),
    why_it_matters: textFlag(args, ['--why-it-matters']),
    done_looks_like: textFlag(args, ['--done-looks-like']),
  });
}

function landingFlags(args) {
  return {
    happened: textFlag(args, ['--landing', '--happened', '--what-happened']),
    checked: textFlag(args, ['--checked', '--how-checked']),
    tested: textFlag(args, ['--tested', '--what-tested']),
    decision: textFlag(args, ['--decision', '--acceptance']),
  };
}

function normalizedLandingSentence(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function defaultLandingSentenceForTitle(title) {
  return `Completed: ${String(title || '').trim()}.`;
}

function landingNeedsDayOnePm(sentence, title) {
  const text = normalizedLandingSentence(sentence);
  if (!text) return true;
  if (text.toLowerCase() === normalizedLandingSentence(defaultLandingSentenceForTitle(title)).toLowerCase()) return true;
  return hasAgentJargon(text) || /\bas\s+exists?\b/i.test(text) || !operatorReady(text);
}

function warnIfLandingNeedsDayOnePm(landing, title) {
  const sentence = landing && typeof landing === 'object' ? landing.happened : '';
  if (!landingNeedsDayOnePm(sentence, title)) return null;
  const warning = 'Advisory: add --landing with one plain sentence saying what someone can do now, in words a new teammate would get. No flags, no ids.';
  console.error(warning);
  return warning;
}

function requireExplicitLandingDayOnePm(label, landing, title) {
  const sentence = landing && typeof landing === 'object' ? normalizedLandingSentence(landing.happened) : '';
  if (!sentence || !landingNeedsDayOnePm(sentence, title)) return;
  failTask(
    label,
    'weak_landing',
    'landing needs one plain sentence saying what someone can do now and why it matters, in words a new teammate would understand. no flags, ids, or unnamed filters.',
  );
}

function numericFlag(args, name) {
  const value = flag(args, name);
  if (value === null || value === true || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function meaningfulTaskProofIssue(proof, { required = true } = {}) {
  const text = String(proof || '').trim();
  if (!required && !text) return null;
  const state = taskProofState(text);
  return state.ok ? null : state.reason;
}

function goldenPathMissionXpTask(task) {
  if (!task) return false;
  const metadata = task.metadata || {};
  const text = [
    task.title,
    task.tag,
    metadata.goal_id,
    metadata.goalId,
    metadata.mission_id,
    metadata.stop_condition,
    metadata.goal_objective,
    metadata.objective,
  ].filter(Boolean).join(' ');
  const missionXp = String(task.title || '').trim().toLowerCase().startsWith('mission xp:')
    || String(task.tag || '').toLowerCase() === 'agent-xp';
  return missionXp
    && /\b(?:golden[- ]path|zero[- ]knowledge|zero[- ]papercuts?|fresh[- ](?:laptop|environment|install|home)|self[- ]landed)\b/i.test(text);
}

function receiptTextForProof(proof, root = process.cwd()) {
  const chunks = [];
  const pattern = new RegExp(RECEIPT_PATH_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(String(proof || ''))) && chunks.length < 3) {
    const rel = match[1];
    if (!rel || rel.includes('*')) continue;
    try {
      const raw = fs.readFileSync(path.resolve(root, rel), 'utf8');
      const parsed = JSON.parse(raw);
      chunks.push(JSON.stringify({
        schema: parsed.schema || null,
        mission_id: parsed.mission_id || null,
        result: parsed.result || null,
        landing: parsed.landing || null,
        last_landing: parsed.last_landing || null,
        summary: parsed.summary || null,
      }).slice(0, 12000));
    } catch {}
  }
  return chunks.join(' ');
}

// Mission ticks already compose a real landing sentence into the run receipt.
// When a mission-bridged task lands with only a receipt proof, lift that
// sentence so the review queue shows the work instead of echoing the title.
function missionReceiptResultForProof(task, proof, root = process.cwd()) {
  const metadata = task?.metadata || {};
  if (!metadata.mission_id && !metadata.goal_id) return null;
  const pattern = new RegExp(RECEIPT_PATH_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(String(proof || '')))) {
    const rel = match[1];
    if (!rel || rel.includes('*')) continue;
    let landing = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(root, rel), 'utf8'));
      landing = parsed?.result?.landing || parsed?.landing || parsed?.last_landing || null;
    } catch { continue; }
    const changed = String(landing?.changed || landing?.happened || '').replace(/\s+/g, ' ').trim();
    if (!changed) continue;
    if (/\brecorded tick \d+\.?$/i.test(changed) || /^recorded a proof heartbeat\b/i.test(changed)) continue;
    const reason = String(landing?.reason || landing?.why || '').replace(/\s+/g, ' ').trim();
    return { changed, reason: reason && !isRetiredFillerReason(reason) ? reason : null };
  }
  return null;
}

function missionXpEndToEndProofIssue(task, proof, root = process.cwd()) {
  if (!goldenPathMissionXpTask(task)) return null;
  const corpus = `${String(proof || '')} ${receiptTextForProof(proof, root)}`
    .replace(/\s+/g, ' ')
    .trim();
  const hasZeroPapercut = /\b(?:zero|0|no)\s+(?:new\s+)?papercuts?\b|\bzero[- ]papercut\b/i.test(corpus);
  const hasEndToEnd = /\bend[- ]to[- ]end\b|\bfull\s+(?:fresh[- ](?:laptop|environment)\s+)?pass\b|\bfresh[- ](?:laptop|environment|install)\b|\bclean\s+temp\s+home\b|\bnpm\s+pack\b/i.test(corpus);
  const hasSelfLanded = /\bself[- ]landed\b|\bfirst\s+self[- ]landed\s+task\b|\btask\s+reaches\s+done\b|\binstall\b.{0,120}\binit\b.{0,120}\bmission\b.{0,120}\b(?:self[- ]landed|task)\b/i.test(corpus);
  return hasZeroPapercut && hasEndToEnd && hasSelfLanded ? null : MISSION_XP_END_TO_END_DETAIL;
}

function missionXpProofBoundaryEvaluation(task, proofOverride = null) {
  if (!goldenPathMissionXpTask(task)) return null;
  const metadata = task.metadata || {};
  const review = task.review || {};
  const proof = proofOverride === null
    ? String(review.proof || metadata.latest_agent_proof || '').trim()
    : String(proofOverride || '').trim();
  const issue = missionXpEndToEndProofIssue(task, proof, task.workspace_root || process.cwd());
  if (!issue) return null;
  return {
    eligible: false,
    ref: taskRef(task),
    reason: MISSION_XP_END_TO_END_REASON,
    next_action: 'attach the zero-papercut end-to-end fresh-laptop receipt, then resubmit Mission XP proof',
    proof,
  };
}

function positional(args) {
  return args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && args[i - 1].startsWith('--')) return false;
    return true;
  });
}

function writeDefaultProjection(taskDb, db, options = {}) {
  const workspaceRoot = scopedWorkspaceRoot(taskDb, [], options);
  const projection = enrichTaskProjection(taskDb.taskProjection(db, {
    workspaceRoot,
    limit: options.all ? null : 500,
  }));
  const outPath = path.resolve(path.join('.atris', 'state', 'tasks.projection.json'));
  const output = JSON.stringify(projection, null, 2) + '\n';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  let shouldWrite = true;
  try {
    shouldWrite = fs.readFileSync(outPath, 'utf8') !== output;
  } catch {
    shouldWrite = true;
  }
  if (shouldWrite) fs.writeFileSync(outPath, output, 'utf8');
  return { projection, outPath };
}

function taskFromProjection(projection, id) {
  return projection.tasks.find(t => t.id === id) || null;
}

function taskRef(taskOrId) {
  if (!taskOrId) return 'TASK';
  if (typeof taskOrId === 'string') return taskOrId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8);
  return taskOrId.display_id || taskOrId.legacy_ref || taskRef(taskOrId.id);
}

function normalizeTaskLookupRef(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function taskLookupRefs(task) {
  if (!task) return [];
  return [task.id, task.display_id, task.legacy_ref, taskRef(task)]
    .map(normalizeTaskLookupRef)
    .filter(Boolean);
}

function resolveProjectionTaskRef(ref, taskByRef) {
  const key = normalizeTaskLookupRef(ref);
  return key ? taskByRef.get(key) || null : null;
}

function reviewNextTaskTitle(task) {
  return normalizeReviewNextTaskInput(rawReviewNextTaskTitle(task)).nextTask;
}

function rawReviewNextTaskTitle(task) {
  const review = task && task.review || {};
  const metadata = task && task.metadata || {};
  return String(review.next_task || metadata.latest_agent_next_task || '').trim();
}

function reviewNextTaskTitleIsSpecific(title) {
  const text = String(title || '').trim();
  if (!text) return false;
  const compact = text.toLowerCase().replace(/\s+/g, ' ');
  return ![
    /^human accept remains pending\b/,
    /^agent double-check complete\b/,
    /^proof is in review\b/,
    /^continue work elsewhere\b/,
    /\bnext agent-actionable work can continue\b/,
    /\bagentxp waits for human accept\b/,
  ].some(pattern => pattern.test(compact));
}

function normalizeReviewNextTaskInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return { nextTask: '', ignored: null };
  if (reviewNextTaskTitleIsSpecific(raw)) return { nextTask: raw, ignored: null };
  return {
    nextTask: '',
    ignored: {
      reason: 'non_specific_next_task',
      value: raw,
    },
  };
}

function genericContinuationIssues(task) {
  const issues = [];
  const titleInput = normalizeReviewNextTaskInput(task && task.title);
  if (titleInput.ignored) {
    issues.push({
      field: 'title',
      reason: titleInput.ignored.reason,
      value: titleInput.ignored.value,
    });
  }
  const nextTitle = rawReviewNextTaskTitle(task);
  const nextInput = normalizeReviewNextTaskInput(nextTitle);
  if (nextInput.ignored) {
    issues.push({
      field: 'review.next_task',
      reason: nextInput.ignored.reason,
      value: nextInput.ignored.value,
    });
  }
  return issues;
}

function findExistingReviewNextTask(taskDb, db, currentTask, title) {
  const parentId = currentTask && currentTask.id || null;
  const nextTitle = String(title || '').trim();
  if (!parentId || !nextTitle) return null;
  const children = taskDb.listTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
  }).filter(task => {
    const metadata = task.metadata || {};
    return metadata.parent_task_id === parentId
      && metadata.source === 'task_review_next';
  });
  return children.find(task => String(task.title || '').trim() === nextTitle)
    || children[0]
    || null;
}

function buildReviewFollowUpChildPredicate(taskDb, db, workspaceRoot) {
  const rows = taskDb.listTasks(db, {
    workspaceRoot: workspaceRoot || null,
  });
  const childrenByParent = new Map();
  for (const task of rows) {
    const metadata = task && task.metadata || {};
    const parentId = metadata.parent_task_id || null;
    if (!parentId || metadata.source !== 'task_review_next') continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(task);
  }
  return task => {
    const parentId = task && task.id || null;
    return Boolean(parentId && childrenByParent.has(parentId));
  };
}

function taskEventOrderValue(event) {
  const version = Number(event && event.version);
  if (Number.isFinite(version) && version > 0) return version;
  const createdAt = Number(event && event.created_at);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function eventIsTaskReviewChat(event) {
  const content = event && event.payload && event.payload.content;
  return event && event.event_type === 'message'
    && /\bTASK_REVIEW_CHAT\b/.test(String(content || ''));
}

function eventClearsPendingReviewChat(event) {
  return Boolean(event && [
    'proof_ready',
    'reviewed',
    'revision_requested',
    'completed',
    'blocked',
  ].includes(event.event_type));
}

function buildPendingReviewChatPredicate(taskDb, db, workspaceRoot) {
  const events = taskDb.listTaskEvents(db, {
    workspaceRoot: workspaceRoot || null,
  });
  const latestReviewChatByTask = new Map();
  const latestClearByTask = new Map();
  for (const event of events) {
    const taskId = event && event.task_id;
    if (!taskId) continue;
    const order = taskEventOrderValue(event);
    if (eventIsTaskReviewChat(event)) {
      latestReviewChatByTask.set(taskId, Math.max(latestReviewChatByTask.get(taskId) || 0, order));
    } else if (eventClearsPendingReviewChat(event)) {
      latestClearByTask.set(taskId, Math.max(latestClearByTask.get(taskId) || 0, order));
    }
  }
  return task => {
    const taskId = task && task.id || null;
    if (!taskId) return false;
    const latestReviewChat = latestReviewChatByTask.get(taskId) || 0;
    if (!latestReviewChat) return false;
    return latestReviewChat > (latestClearByTask.get(taskId) || 0);
  };
}

function createReviewNextTask(taskDb, db, currentTask, title) {
  const nextTitle = String(title || '').trim();
  if (!nextTitle) return null;
  const operatorTitleWarning = warnIfTaskTitleNeedsOperatorWhy(nextTitle);
  const currentMetadata = currentTask && currentTask.metadata && typeof currentTask.metadata === 'object'
    ? currentTask.metadata
    : {};
  const existing = findExistingReviewNextTask(taskDb, db, currentTask, nextTitle);
  if (existing) return { id: existing.id, inserted: false, operator_title_warning: operatorTitleWarning };
  const goalId = currentMetadata.goal_id || currentMetadata.goalId || null;
  const parentId = currentTask && currentTask.id || null;
  const sourceKey = parentId && typeof taskDb.sourceKey === 'function'
    ? taskDb.sourceKey(`task_review_next:${parentId}`, nextTitle)
    : null;
  try {
    const created = taskDb.addTask(db, {
      title: nextTitle,
      tag: currentTask && currentTask.tag || null,
      workspaceRoot: taskDb.workspaceRoot(),
      sourceKey,
      metadata: {
        parent_task_id: parentId,
        ...(goalId ? { goal_id: String(goalId) } : {}),
        source: 'task_review_next',
      },
    });
    return { ...created, operator_title_warning: operatorTitleWarning };
  } catch (error) {
    if (sourceKey && /constraint|unique/i.test(String(error && (error.code || error.message) || error))) {
      const racedExisting = findExistingReviewNextTask(taskDb, db, currentTask, nextTitle);
      if (racedExisting) return { id: racedExisting.id, inserted: false, operator_title_warning: operatorTitleWarning };
    }
    throw error;
  }
}

function createNextTaskIfRequested(taskDb, db, args, currentTask, title) {
  if (!hasFlag(args, '--create-next')) return null;
  return createReviewNextTask(taskDb, db, currentTask, title);
}

function continueWorkCommandForTask(task, { owner } = {}) {
  if (!reviewNextTaskTitle(task)) return null;
  const actor = String(owner || (task && (task.claimed_by || taskAssignee(task))) || DEFAULT_OWNER).trim() || DEFAULT_OWNER;
  return `atris task continue-work ${taskRef(task)} --as ${actor} --json`;
}

function certifiedReviewNextAction(nextTaskTitle) {
  return String(nextTaskTitle || '').trim() ? 'continue_work' : 'human_accept_waiting';
}

function proofBoundaryBlockedEvaluation(task) {
  const missionXpBoundary = missionXpProofBoundaryEvaluation(task);
  if (missionXpBoundary) return missionXpBoundary;
  // This is a render-path probe for the boundary reason only. strictVerify
  // alone is not enough to keep it read-only because probationary actors
  // still require strict verification. Never execute a stored verifier while
  // drawing task reviews, status, queues, or projections.
  const evaluation = evaluateAutoAccept(task, {
    strictVerify: false,
    minPasses: 0,
    executeVerify: false,
  });
  return evaluation && evaluation.reason === 'proof_unmerged_or_draft_pr_boundary'
    ? evaluation
    : null;
}

function handoffAllowsHumanAccept(handoff) {
  return handoff && !handoffIsProofBoundaryBlocked(handoff);
}

function handoffIsProofBoundaryBlocked(handoff) {
  return handoff && handoff.next_action === PROOF_BOUNDARY_BLOCKED_ACTION;
}

function readLocalBusinessBinding(root = process.cwd()) {
  const file = path.join(root, '.atris', 'business.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read .atris/business.json: ${e.message || e}`);
  }
}

function extractGoalLines(text) {
  const goals = [];
  let inFrontmatter = false;
  let seenContent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '---' && !seenContent) {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;
    if (!line) continue;
    seenContent = true;
    if (line.startsWith('#') || line.startsWith('---') || /^\|[-\s|]+\|$/.test(line)) continue;
    if (/^\|/.test(line)) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cells[0] && !/^goal$/i.test(cells[0])) goals.push(cells.slice(0, 3).join(' / '));
      continue;
    }
    goals.push(line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''));
  }
  return goals.filter(Boolean).slice(0, 8);
}

function readGoalSources(root = process.cwd()) {
  const candidates = [
    path.join(root, 'atris', 'goals.md'),
    path.join(root, 'goals.md'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const goals = extractGoalLines(fs.readFileSync(file, 'utf8'));
    if (goals.length) return { path: file, goals };
  }
  return { path: null, goals: [] };
}

function reviewSummary(task, payload = {}) {
  const metadata = task.metadata || {};
  const explicit = payload.summary
    || payload.meaning
    || metadata.review_summary
    || metadata.review_meaning
    || metadata.plain_language_summary
    || metadata.human_summary;
  if (explicit) return clipStatusText(explicit, 240);

  const title = String(task.title || 'this task').replace(/\s+/g, ' ').trim();
  const plainTitle = title ? title.charAt(0).toLowerCase() + title.slice(1) : 'this task';
  const approvalStatus = payload.approval_status || metadata.approval_status || null;
  if (approvalStatus === 'revise') {
    return `Rework requested for ${plainTitle}.`;
  }
  const careerText = [
    task.tag,
    metadata.goal_id,
    metadata.task_goal,
    metadata.goal_objective,
    metadata.review_goal,
  ].filter(Boolean).join(' ').toLowerCase();
  if (
    careerText.includes('career-xp')
    || careerText.includes('career xp')
    || careerText.includes('agent-xp')
    || careerText.includes('agent xp')
  ) {
    if (task.status === 'done') {
      return `Completed AgentXP result for ${plainTitle}.`;
    }
    if (task.status === 'review') {
      return `${plainTitle}: proof is ready for human approval; approve only if the evidence is real.`;
    }
    return `This explains the AgentXP result ${plainTitle} would make real.`;
  }
  if (task.status === 'done') {
    return `Completed result for ${plainTitle}.`;
  }
  if (task.status === 'review') {
    return `${plainTitle}: review the completed result, then approve or ask for rework.`;
  }
  return `This explains what ${plainTitle} would make real.`;
}

function titleToResultText(title) {
  const text = String(title || 'this task').replace(/\s+/g, ' ').trim();
  if (!text) return 'Completed this task.';
  const resultSentence = (prefix, body) => {
    const clean = String(body || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
    return clean ? `${prefix} ${clean}.` : `${prefix}.`;
  };
  const missionXp = text.match(/^Mission XP:\s*(.+)$/i);
  if (missionXp) {
    const missionResult = titleToResultText(missionXp[1]).replace(/[.!?]+$/, '');
    return resultSentence('Completed mission work:', missionResult.replace(/^Completed:\s*/i, ''));
  }
  const [first, ...restParts] = text.split(' ');
  const rest = restParts.join(' ');
  const firstLower = String(first || '').toLowerCase();
  const compound = rest.match(/^and\s+([a-z]+)\s+(.+)$/i);
  const compoundPast = compound ? ({
    audit: { close: 'Audited and closed' },
    decide: { start: 'Decided and started' },
    prune: { compress: 'Pruned and compressed' },
  }[firstLower] || {})[String(compound[1] || '').toLowerCase()] : null;
  if (compoundPast && compound[2]) return resultSentence(compoundPast, compound[2]);
  const past = {
    add: 'Added',
    approve: 'Prepared approval for',
    audit: 'Audited',
    batch: 'Batched',
    build: 'Built',
    clean: 'Cleaned',
    create: 'Created',
    decide: 'Decided',
    design: 'Designed',
    document: 'Documented',
    find: 'Found',
    fix: 'Fixed',
    heal: 'Healed',
    ignore: 'Ignored',
    infer: 'Inferred',
    keep: 'Kept',
    make: 'Made',
    number: 'Numbered',
    prune: 'Pruned',
    reconcile: 'Reconciled',
    refresh: 'Refreshed',
    render: 'Rendered',
    repair: 'Repaired',
    replace: 'Replaced',
    respect: 'Respected',
    route: 'Routed',
    run: 'Ran',
    ship: 'Shipped',
    show: 'Showed',
    stop: 'Stopped',
    summarize: 'Summarized',
    suppress: 'Suppressed',
    trim: 'Trimmed',
    update: 'Updated',
    use: 'Used',
    validate: 'Validated',
    wire: 'Wired',
  }[firstLower];
  if (past && rest) return resultSentence(past, rest);
  return resultSentence('Completed:', text);
}

function proofToReasonText(proof) {
  const text = String(proof || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const label = /\b(?:Product proof|Why it matters)\s*:\s*/i.exec(text);
  if (!label) return '';
  const rest = text.slice(label.index + label[0].length);
  const stop = rest.search(/(?:^|[.;]\s+)\b(?:Checks?|Mission receipt|Receipt|Landing|Changed|How I checked|What I tested|Saved|Decision)\s*:/i);
  let section = (stop >= 0 ? rest.slice(0, stop) : rest)
    .replace(/^(?:[-:]\s*)+/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[;,:-]\s*$/, '')
    .trim();
  const sentenceStop = section.search(/[.!?]\s+/);
  if (sentenceStop >= 0) section = section.slice(0, sentenceStop + 1).trim();
  if (!section) return '';
  return /[.!?]$/.test(section) ? section : `${section}.`;
}

// A landing sentence written for --result already carries its own why
// ("..., so operators keep deciding instead of waiting"). Reuse that clause
// as the reason instead of inventing one; with no clause, stay silent.
// landingWhyClause lives in lib/voice-gate.js so every human-bound landing
// composer (task reviews, mission receipts) shares the same why extraction.

function proofToHumanCheck(proof) {
  const text = String(proof || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Proof is attached below.';
  const lower = text.toLowerCase();
  const passSignal = /\b(?:pass(?:es|ed|ing)?|ok|green|succeeded|verified)\b/.test(lower);
  const verifierCommandSignal = /\b(?:npm|node|git|atris|npx|pnpm|yarn|python3?|pytest|bash|sh|tsc|vitest|curl|gh|rg)\s+\S+/.test(lower);
  if (/\b(?:atris\s+)?task\s+(?:show|page)\b/.test(lower) && /\b(?:print|prints|printed|render|renders|rendered|show|shows|showed)\b/.test(lower)) {
    return 'I opened the real task screen and checked the receipt renders before raw proof.';
  }
  if (/git\s+diff\s+--check/.test(lower) && passSignal) {
    if (/node\s+--test/.test(lower)) return 'I ran the behavior check and the diff cleanliness check.';
    return 'I ran the diff cleanliness check.';
  }
  if (/\btypecheck\b/.test(lower) && passSignal) return 'I ran the typecheck.';
  if (/\bbuild\b/.test(lower) && passSignal) return 'I ran the build check.';
  if (/\btest\b/.test(lower) && passSignal) return 'I ran the verifier named in the proof.';
  if (/\bvalidat(?:e|ion|ed)\b/.test(lower) && passSignal) return 'I ran the validation check.';
  if (verifierCommandSignal && /\b(?:print|prints|printed|show|shows|showed|report|reports|reported|return|returns|returned)\b/.test(lower)) {
    return 'I checked the verifier output named in the proof.';
  }
  if (verifierCommandSignal && passSignal) return 'I ran the verifier named in the proof.';
  if (/atris\/runs\/[^\s),.;:]+\.json/.test(text)) {
    return passSignal
      ? 'I inspected the passing receipt named in the proof.'
      : 'I inspected the receipt named in the proof.';
  }
  if (/(?:^|\s)(?:\.{0,2}\/)?scripts\/[^\s),.;:]+\.(?:js|mjs|cjs|py|sh)\b/.test(text)) {
    return 'I inspected the verifier artifact named in the proof.';
  }
  if (/\breview(?:ed)?\b/.test(lower)) return 'Review proof is attached below.';
  return 'Proof is attached below.';
}

function taskReviewFormatCommandList(commands) {
  const list = Array.isArray(commands)
    ? commands.map(command => String(command || '').trim()).filter(Boolean)
    : [];
  if (!list.length) return '';
  if (list.length > 1) {
    return list.map((command, index) => `command ${index + 1}: ${command}`).join('; ');
  }
  return list[0];
}

function taskReviewProseCheckLabels(proof) {
  const text = String(proof || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const lower = text.toLowerCase();
  const hasPass = /\b(?:pass(?:es|ed|ing)?|green|verified|current|clean|complete|completed)\b/.test(lower);
  if (!hasPass) return [];
  const labels = [];
  const add = label => {
    if (!labels.includes(label)) labels.push(label);
  };
  if (/\bhelp output\b/.test(lower)) add('help output');
  if (/\b(?:wiki verify|public wiki verify|loop wiki)\b/.test(lower)) add('wiki verification');
  if (/\bclean dry-run\b/.test(lower)) add('clean dry-run');
  if (/\b(?:test slice|regression run|tests?|test)\b.*\bpass(?:es|ed|ing)?\b/.test(lower)
    || /\bpass(?:es|ed|ing)?\b.*\b(?:test slice|regression run|tests?|test)\b/.test(lower)) {
    add('passing tests');
  }
  if (/\bverifier\b.*\bpass(?:es|ed|ing)?\b/.test(lower)
    || /\bpass(?:es|ed|ing)?\b.*\bverifier\b/.test(lower)) {
    add('passing verifier');
  }
  if (/\bmission\b.*\bcomplete(?:d)?\b/.test(lower)) add('completed mission');
  if (/\bgit diff --check\b/.test(lower) || /\bdiff cleanliness\b/.test(lower)) add('diff cleanliness');
  return labels;
}

function taskReviewLandingTested(proof) {
  const maxVisible = 3;
  const commands = taskReviewEvidenceCommands(proof, 20);
  if (commands.length) {
    return commands.length === 1
      ? 'I ran the listed check for this result.'
      : 'I ran the listed checks for this result.';
  }
  const paths = taskReviewEvidencePaths(proof, 20);
  if (paths.length) {
    return paths.length === 1
      ? 'I inspected the artifact named in the proof.'
      : `I inspected ${paths.length} artifacts named in the proof.`;
  }
  const proseChecks = taskReviewProseCheckLabels(proof);
  if (proseChecks.length) {
    const visible = proseChecks.slice(0, maxVisible);
    const omitted = proseChecks.length - visible.length;
    const suffix = omitted > 0 ? `, and ${omitted} more ${omitted === 1 ? 'check' : 'checks'}` : '';
    return `I checked: ${visible.join(', ')}${suffix}.`;
  }
  return String(proof || '').trim() ? 'I attached the proof below.' : 'No verifier command recorded yet.';
}

function landingPayloadValue(payload, metadata, key) {
  const landing = payload && payload.landing && typeof payload.landing === 'object' ? payload.landing : {};
  return landing[key]
    || payload && payload[`landing_${key}`]
    || metadata[`landing_${key}`]
    || null;
}

function taskReviewLanding(task, review = {}, payload = {}) {
  const metadata = task.metadata || {};
  const proof = review.proof || payload.proof || metadata.latest_agent_proof || '';
  const agentCertified = review.agent_certified === true || metadata.agent_certified === true;
  const approvalStatus = review.approval_status || metadata.approval_status || null;
  const explicitHappened = landingPayloadValue(payload, metadata, 'happened')
    || payload.result || metadata.result || payload.changed || metadata.result_changed || metadata.human_changed || metadata.changed;
  const explicitChecked = landingPayloadValue(payload, metadata, 'checked')
    || payload.checked || metadata.result_checked || metadata.human_checked || metadata.checked;
  const explicitTested = landingPayloadValue(payload, metadata, 'tested');
  const explicitDecision = landingPayloadValue(payload, metadata, 'decision');
  const explicitReasonRaw = landingPayloadValue(payload, metadata, 'reason')
    || landingPayloadValue(payload, metadata, 'why')
    || payload.reason || payload.why || metadata.result_reason || metadata.review_reason || metadata.why_it_matters;
  const explicitReason = explicitReasonRaw && !isRetiredFillerReason(explicitReasonRaw) ? explicitReasonRaw : null;
  const missionLift = explicitHappened
    ? null
    : missionReceiptResultForProof(task, proof, task.workspace_root || process.cwd());
  let happened = clipStatusText(explicitHappened || (missionLift && missionLift.changed) || titleToResultText(task.title), 220);
  let reason = clipStatusText(explicitReason || proofToReasonText(proof) || (missionLift && missionLift.reason) || '', 220);
  if (!reason) {
    const clause = landingWhyClause(happened);
    if (clause) {
      happened = clipStatusText(clause.change, 220);
      reason = clipStatusText(clause.why, 220);
    }
  }
  return {
    happened,
    reason,
    checked: clipStatusText(explicitChecked || proofToHumanCheck(proof), 220),
    tested: clipStatusText(explicitTested || taskReviewLandingTested(proof), 260),
    decision: clipStatusText(explicitDecision || (task.status === 'done'
      ? 'Done. No action needed unless this regresses.'
      : approvalStatus === 'revise'
        ? 'Rework requested. Fix the note, then send a new receipt.'
        : approvalStatus === 'pending' && !agentCertified
          ? 'Needs one more check; ask for rework if the receipt misses the point.'
          : 'Approve if this matches the request; ask for rework if not.'), 220),
  };
}

function taskReviewResult(task, review = {}, payload = {}) {
  const metadata = task.metadata || {};
  const ref = taskRef(task);
  const landing = taskReviewLanding(task, review, payload);
  const explicitSaved = payload.saved || metadata.result_saved || metadata.human_saved || metadata.saved;
  return {
    changed: landing.happened,
    reason: landing.reason,
    checked: landing.checked,
    saved: clipStatusText(explicitSaved || taskReviewSavedText(task, review, ref), 180),
    accept: landing.decision,
  };
}

function taskReviewSavedText(task, review = {}, ref = taskRef(task)) {
  if (task.status === 'done') return `Result accepted as ${ref}.`;
  const metadata = task.metadata || {};
  const agentCertified = review.agent_certified === true || metadata.agent_certified === true;
  if (task.status === 'review' && agentCertified) return `Result is ready for human approval as ${ref}.`;
  if (task.status === 'review') return `Completed result saved for review as ${ref}.`;
  return `Work record saved as ${ref}.`;
}

function cleanReviewProofText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function reviewMessageLooksLikeProof(value) {
  const text = cleanReviewProofText(value);
  return Boolean(text && /\b(?:proof|verified|verifier|passed|receipt|git diff --check|node --test|npm test|pnpm test|yarn test|pytest|typecheck)\b/i.test(text));
}

function taskReviewEventProof(task) {
  const events = Array.isArray(task.events) ? task.events : [];
  for (const event of events.slice().reverse()) {
    const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
    const explicit = cleanReviewProofText(payload.proof || payload.verify);
    if (explicit) return explicit;
    const message = cleanReviewProofText(payload.content || payload.chat_packet || payload.stage_packet);
    if (message && reviewMessageLooksLikeProof(message)) return message;
  }
  const messages = Array.isArray(task.messages) ? task.messages : [];
  for (const message of messages.slice().reverse()) {
    const content = cleanReviewProofText(message && message.content);
    if (content && reviewMessageLooksLikeProof(content)) return content;
  }
  return null;
}

function taskReviewProofFallback(task, payload = {}) {
  if (!task || task.status !== 'review') return null;
  const metadata = task.metadata || {};
  return cleanReviewProofText(metadata.latest_agent_proof)
    || cleanReviewProofText(payload.proof)
    || cleanReviewProofText(metadata.proof)
    || cleanReviewProofText(metadata.verify)
    || cleanReviewProofText(metadata.latest_agent_verify)
    || cleanReviewProofText(payload.verify)
    || taskReviewEventProof(task);
}

function reviewReceiptPath(proofText, root) {
  const evidence = extractReceiptEvidence(proofText, root);
  if (!evidence) return null;
  return evidence.receipts?.[0]?.path || evidence.missing?.[0] || null;
}

function withReviewReceiptPath(review, root) {
  if (!review) return null;
  return {
    ...review,
    receipt_path: reviewReceiptPath(review.proof, root),
  };
}

function taskReviewSummary(task) {
  const reviewed = (task.events || []).slice().reverse().find(e => e.event_type === 'reviewed' || e.event_type === 'proof_ready' || e.event_type === 'revision_requested');
  const payload = reviewed && reviewed.payload || {};
  const metadata = task.metadata || {};
  const fallbackProof = taskReviewProofFallback(task, payload);
  if (!reviewed && !metadata.approval_status && !metadata.agent_review_pass_count && !metadata.human_revision_count && !metadata.agent_certified && !fallbackProof) return null;
  if (reviewed && reviewed.event_type === 'revision_requested') {
    const review = {
      summary: reviewSummary(task, payload),
      reward: null,
      proof: null,
      lesson: null,
      next_task: null,
      approval_status: metadata.approval_status || payload.approval_status || 'revise',
      agent_review_pass_count: null,
      agent_certified: false,
      agent_certification_policy: null,
      human_revision_count: metadata.human_revision_count || payload.revision_count || null,
      human_revision_note: metadata.human_revision_note || payload.note || null,
    };
    review.landing = taskReviewLanding(task, review, payload);
    review.result = taskReviewResult(task, review, payload);
    return reviewSummaryWithVerificationChat(task, review);
  }
  const reviewPassCount = Number(metadata.agent_review_pass_count || payload.review_pass_count || 0);
  const agentCertified = metadata.agent_certified === true
    || payload.agent_certified === true
    || reviewPassCount >= AGENT_CERTIFICATION_REVIEW_PASSES;
  const reviewedEventHas = (key) => reviewed && reviewed.event_type === 'reviewed'
    && Object.prototype.hasOwnProperty.call(payload, key);
  const clearedReviewFields = new Set(Array.isArray(payload.cleared_review_fields) ? payload.cleared_review_fields : []);
  const readyField = (key, metadataKey) => {
    if (task.status === 'review' && metadata.approval_status === 'pending' && metadata[metadataKey]) {
      return metadata[metadataKey];
    }
    if (reviewedEventHas(key)) {
      if (payload[key]) return payload[key];
      if (key === 'proof' || !clearedReviewFields.has(key)) return metadata[metadataKey] || null;
      return null;
    }
    return payload[key] || metadata[metadataKey] || null;
  };
  const review = {
    summary: reviewSummary(task, payload),
    reward: reviewed && reviewed.event_type === 'reviewed' && payload.reward !== undefined ? payload.reward : null,
    proof: readyField('proof', 'latest_agent_proof') || fallbackProof,
    lesson: readyField('lesson', 'latest_agent_lesson'),
    next_task: readyField('next_task', 'latest_agent_next_task'),
    approval_status: metadata.approval_status || (task.status === 'review' ? 'pending' : null),
    agent_review_pass_count: reviewPassCount || null,
    agent_certified: agentCertified,
    agent_certification_policy: metadata.agent_certification_policy
      || payload.agent_certification_policy
      || (agentCertified ? `${AGENT_CERTIFICATION_REVIEW_PASSES}_agent_review_passes` : null),
    human_revision_count: metadata.human_revision_count || null,
  };
  review.landing = taskReviewLanding(task, review, payload);
  review.result = taskReviewResult(task, review, payload);
  return reviewSummaryWithVerificationChat(task, review);
}

function taskReviewInspectMetadata(task) {
  const review = task.review || taskReviewSummary(task);
  if (!review) return null;
  return {
    approval_status: review.approval_status || null,
    agent_certified: review.agent_certified === true,
    agent_review_pass_count: review.agent_review_pass_count || null,
    agent_certification_policy: review.agent_certification_policy || null,
    summary: review.summary || null,
    proof: review.proof || null,
    lesson: review.lesson || null,
    next_task: review.next_task || null,
    human_revision_count: review.human_revision_count || null,
    human_revision_note: review.human_revision_note || null,
    reward: review.reward ?? null,
    receipt_path: review.receipt_path || null,
  };
}

function taskInspectFieldValues(task, fields) {
  const values = {};
  for (const field of fields) {
    switch (field) {
      case 'status':
        values.status = task.status || null;
        break;
      case 'title':
        values.title = task.title || null;
        break;
      case 'claimed_by':
        values.claimed_by = task.claimed_by || null;
        break;
      case 'tag':
        values.tag = task.tag || null;
        break;
      case 'review':
        values.review = taskReviewInspectMetadata(task);
        break;
      default:
        break;
    }
  }
  return values;
}

function reviewSummaryWithVerificationChat(task, review) {
  if (!review || task.status !== 'review' || review.approval_status !== 'pending') return review;
  const verifierTask = taskWithReviewEvidence(task, {
    proof: review.proof,
    lesson: review.lesson,
    nextTask: review.next_task,
  });
  const reviewChat = taskReviewChatHandoff(verifierTask);
  return reviewChat ? { ...review, verification_chat: reviewChat } : review;
}

function taskAssignee(task) {
  const metadata = task && task.metadata || {};
  return metadata.assigned_to || task.claimed_by || null;
}

const GOAL_MATCH_STOPWORDS = new Set([
  'daily',
  'goal',
  'goals',
  'loop',
  'loops',
  'make',
  'task',
  'tasks',
  'work',
]);

function scoreGoalMatch(task, goal) {
  const haystack = `${task.title} ${task.tag || ''}`.toLowerCase();
  const words = (String(goal || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [])
    .filter(word => !GOAL_MATCH_STOPWORDS.has(word));
  return words.reduce((score, word) => {
    const singular = word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word;
    return score + (haystack.includes(word) || haystack.includes(singular) ? 1 : 0);
  }, 0);
}

function pickTaskGoal(task, goals) {
  if (!goals.length) return null;
  let best = goals[0];
  let bestScore = -1;
  for (const goal of goals) {
    const score = scoreGoalMatch(task, goal);
    if (score > bestScore) {
      best = goal;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function taskBaseObjective(task, goals) {
  const metadata = task && task.metadata || {};
  return task.objective
    || metadata.task_goal
    || metadata.goal_objective
    || metadata.objective
    || pickTaskGoal(task, goals);
}

function taskObjective(task, parent, goals, { parentLinkType = null, baseObjectives = new Map() } = {}) {
  const metadata = task && task.metadata || {};
  const explicit = task.objective || metadata.task_goal || metadata.goal_objective || metadata.objective;
  if (explicit) return explicit;
  if (parent) {
    if (parentLinkType === 'parent_task_id') return baseObjectives.get(parent.id) || parent.title;
    if (parentLinkType === 'goal_id') return parent.title;
    return baseObjectives.get(parent.id) || parent.title;
  }
  return pickTaskGoal(task, goals);
}

function buildTaskStreams(tasks, goals) {
  const buckets = new Map();
  for (const task of tasks) {
    const objective = task.objective || 'Unmapped work';
    if (!buckets.has(objective)) {
      buckets.set(objective, {
        objective,
        active_count: 0,
        done_count: 0,
        open_count: 0,
        doing_count: 0,
        blocked_count: 0,
        review_count: 0,
        tasks: [],
      });
    }
    const stream = buckets.get(objective);
    const column = taskColumn(task);
    if (task.status === 'done') stream.done_count += 1; else stream.active_count += 1;
    if (column === 'open') stream.open_count += 1;
    if (column === 'doing') stream.doing_count += 1;
    if (column === 'blocked') stream.blocked_count += 1;
    if (column === 'review') stream.review_count += 1;
    const review = task.review || {};
    const metadata = task.metadata || {};
    stream.tasks.push({
      id: task.id,
      title: task.title,
      explanation: task.explanation || taskExplanation(task),
      status: task.status,
      tag: task.tag,
      claimed_by: task.claimed_by,
      assigned_to: taskAssignee(task),
      parent_task_id: task.lineage && task.lineage.parent_task_id || null,
      child_task_ids: task.lineage && task.lineage.child_task_ids || [],
      proof: review.proof || metadata.latest_agent_proof || null,
    });
  }
  for (const goal of goals) {
    if (!buckets.has(goal)) {
      buckets.set(goal, {
        objective: goal,
        active_count: 0,
        done_count: 0,
        open_count: 0,
        doing_count: 0,
        blocked_count: 0,
        review_count: 0,
        tasks: [],
      });
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => (b.active_count - a.active_count) || (b.done_count - a.done_count) || a.objective.localeCompare(b.objective));
}

// The approval half of the plain layer: one clear way to approve proposed
// work, one clear way to ask for a change. Every enabled/blocked answer comes
// from the existing review handoff, so this relabels what the certification
// rules already allow and can never widen it.
function taskApprovalFor(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  const metadata = task && task.metadata || {};
  const approvalStatus = (task && task.review && task.review.approval_status) || metadata.approval_status || null;
  if (task && task.status === 'done' && approvalStatus === 'accepted') {
    return taskApprovalControls({
      question: 'Landed and accepted. Nothing to do.',
      approveLabel: 'Approve the completed work',
      acceptEnabled: false,
      acceptCommand: null,
      requestChangeEnabled: false,
      requestChangeCommand: null,
      blockedReason: null,
      waitingOn: null,
    });
  }
  const current = taskPageCurrentStage(task);
  const actions = taskPageActions(task, { reviewer, hasExistingReviewFollowUp });
  const inReview = current === 'review';
  const handoff = inReview
    ? reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp })
    : null;
  const planned = current === 'plan';
  const planReady = planned && Boolean(
    (metadata.task_goal || metadata.goal_objective || task.objective)
    && metadata.exit_condition
    && (metadata.verify || metadata.proof_needed)
    && metadata.first_move
  );
  const acceptEnabled = inReview ? handoffAllowsHumanAccept(handoff) : planReady;
  const planOwner = task && (task.claimed_by || taskAssignee(task)) || DEFAULT_OWNER;
  const acceptCommand = inReview
    ? actions.human_accept_command
    : planReady
      ? `atris task do ${taskRef(task)} --as ${planOwner} --first-move ${taskCommandQuote(metadata.first_move)}`
      : null;
  const requestChangeEnabled = !['done', 'blocked', 'missing'].includes(current);
  const requestChangeCommand = inReview
    ? actions.revise_command
    : planned
      ? `atris task backlog ${taskRef(task)} --reason "<what needs to change>"`
      : actions.note_command;
  const blockedReason = inReview
    ? handoffIsProofBoundaryBlocked(handoff)
      ? 'The proof points at unfinished or unsafe work. Ask for a change before approval.'
      : 'The proof still needs its required checks before a person can approve it.'
    : planned
      ? 'The plan still needs a goal, finish line, check, and first move before approval.'
      : current === 'backlog'
        ? 'This task still needs a complete plan before approval.'
        : current === 'do'
          ? 'Work is underway. Approval opens after the proof clears review.'
          : 'This task is already closed.';
  const question = inReview
    ? 'Approve the completed work, or ask for a change?'
    : planned
      ? 'Approve this plan, or ask for a change?'
      : requestChangeEnabled
        ? 'Ask for a change before work moves forward.'
        : 'No action is available on this closed task.';
  return taskApprovalControls({
    question,
    approveLabel: inReview ? 'Approve the completed work' : 'Approve this plan',
    acceptEnabled,
    acceptCommand,
    requestChangeEnabled,
    requestChangeCommand,
    blockedReason,
    waitingOn: acceptEnabled ? 'a person' : inReview ? 'the proof check' : planned ? 'a complete plan' : null,
  });
}

function enrichTaskProjection(projection) {
  const root = projection.workspace_root || process.cwd();
  const goalSource = readGoalSources(root);
  const byRef = new Map();
  for (const task of projection.tasks || []) {
    for (const ref of taskLookupRefs(task)) byRef.set(ref, task);
  }
  const baseObjectives = new Map();
  for (const task of projection.tasks || []) {
    const objective = taskBaseObjective(task, goalSource.goals);
    if (objective) baseObjectives.set(task.id, objective);
  }
  const children = new Map();
  for (const task of projection.tasks || []) {
    const metadata = task.metadata || {};
    const parent = resolveProjectionTaskRef(metadata.parent_task_id, byRef) || resolveProjectionTaskRef(metadata.goal_id, byRef);
    if (!parent) continue;
    if (!children.has(parent.id)) children.set(parent.id, []);
    children.get(parent.id).push(task);
  }
  const enrichedTasks = (projection.tasks || []).map(task => {
      const metadata = task.metadata || {};
      const parentFromParentId = resolveProjectionTaskRef(metadata.parent_task_id, byRef);
      const parentFromGoalId = resolveProjectionTaskRef(metadata.goal_id, byRef);
      const parent = parentFromParentId || parentFromGoalId;
      const parentLinkType = parentFromParentId ? 'parent_task_id' : parentFromGoalId ? 'goal_id' : null;
      const parentId = parent ? parent.id : metadata.parent_task_id || null;
      const childTasks = children.get(task.id) || [];
      const review = withReviewReceiptPath(taskReviewSummary(task), root);
      const enriched = {
        ...task,
        objective: taskObjective(task, parent, goalSource.goals, { parentLinkType, baseObjectives }),
        review,
        lineage: {
          parent_task_id: parentId,
          parent_title: parent ? parent.title : null,
          child_task_ids: childTasks.map(child => child.id),
          child_titles: childTasks.map(child => child.title),
          next_task_suggestion: review ? review.next_task : null,
        },
      };
      // Recomputed here so the derived reason can use the enriched objective
      // and lineage that only exist after this pass. Explicit fields written
      // by the caller still win; nothing below this layer is dropped.
      return {
        ...enriched,
        explanation: taskExplanation(enriched),
        approval: taskApprovalFor(enriched),
      };
    });
  return {
    ...projection,
    goals: {
      source_path: goalSource.path,
      items: goalSource.goals,
    },
    streams: buildTaskStreams(enrichedTasks, goalSource.goals),
    tasks: enrichedTasks,
    missions: projectionMissions(root),
    wishes: projectionWishes(root),
  };
}

// The desktop app renders projection.missions but the writer never filled it,
// so live workers were invisible on every dashboard. Best-effort: a broken
// mission or wish store must never take the task projection down with it.
const PROJECTION_MISSION_LIMIT = 50;
const PROJECTION_WISH_LIMIT = 30;
const PROJECTION_CLIP = 240;

function clipForProjection(value) {
  const text = String(value || '');
  return text.length > PROJECTION_CLIP ? `${text.slice(0, PROJECTION_CLIP - 3)}...` : text;
}

function projectionMissions(root) {
  try {
    const { listMissions } = require('./mission.js');
    const recentCutoff = Date.now() - 48 * 60 * 60 * 1000;
    return listMissions(root)
      .filter(mission => {
        const status = String(mission.status || '');
        if (!['complete', 'stopped'].includes(status)) return true;
        const updated = Date.parse(mission.updated_at || mission.created_at || '') || 0;
        return updated >= recentCutoff;
      })
      .slice(0, PROJECTION_MISSION_LIMIT)
      .map(mission => ({
        id: mission.id,
        objective: clipForProjection(String(mission.objective || '')),
        status: mission.status || null,
        owner: mission.owner || null,
        runner: mission.runner || null,
        cadence: mission.cadence || null,
        lane: mission.lane || null,
        next_action: clipForProjection(String(mission.next_action || '')),
        last_tick_at: mission.last_tick_at || null,
        last_tick_status: mission.last_tick_status || null,
        receipt_path: mission.receipt_path || null,
        wish_id: mission.wish_id || null,
        created_at: mission.created_at || null,
        updated_at: mission.updated_at || null,
      }));
  } catch {
    return [];
  }
}

function projectionWishes(root) {
  try {
    const { readWishes } = require('../lib/wish-store');
    return readWishes(root)
      .filter(wish => String(wish.status || '') !== 'closed')
      .slice(-PROJECTION_WISH_LIMIT)
      .map(wish => ({
        id: wish.id,
        n: wish.n ?? null,
        text: clipForProjection(String(wish.text || '')),
        status: wish.status || null,
        created_at: wish.first_ts || wish.ts || null,
      }));
  } catch {
    return [];
  }
}

function taskTypeForCloud(task) {
  const tag = String(task.tag || '').toLowerCase();
  if (['inbound', 'outbound', 'creative', 'improvement'].includes(tag)) return tag;
  if (['design', 'writing', 'image', 'video', 'launch'].includes(tag)) return 'creative';
  if (['sales', 'gtm', 'customer', 'email'].includes(tag)) return 'outbound';
  return 'improvement';
}

function taskStateForCloud(task) {
  if (task.status === 'review') return 'doing';
  if (task.status === 'claimed') return 'doing';
  if (task.status === 'failed' && taskHasReview(task)) return 'done';
  if (task.status === 'failed') return 'blocked';
  if (task.status === 'done') return 'done';
  return 'open';
}

function taskNeedsApprovalForCloud(task) {
  const approvalStatus = task?.review?.approval_status || task?.metadata?.approval_status || null;
  return task?.status === 'review' || approvalStatus === 'pending';
}

function ownerMemberIdForCloud(task) {
  const ownerValue = task.claimed_by || taskAssignee(task);
  if (!ownerValue) return null;
  const owner = String(ownerValue).trim();
  if (!owner) return null;
  if (owner.includes(':')) return owner;
  return `agent:${owner}`;
}

function taskDescriptionForCloud(task) {
  const explanation = task.explanation || taskExplanation(task);
  const approval = task.approval || taskApprovalFor(task);
  const lines = [
    ...explanationLines(explanation),
    ...approvalLines(approval),
    '',
    `Technical details: ${task.title}`,
    `Local task: ${task.id}`,
    `Status: ${task.status}`,
    `Latest event: ${task.latest_event_type || 'none'}`,
  ];
  if (task.messages && task.messages.length) {
    lines.push('', 'Thread:');
    for (const message of task.messages.slice(-5)) {
      lines.push(`- ${message.actor || 'unknown'}: ${message.content}`);
    }
  }
  const landing = reviewLandingForDisplay(task.review);
  if (landing) {
    lines.push('', 'Result:');
    if (landing.happened) lines.push(`What happened: ${landing.happened}`);
    if (landing.reason) lines.push(`Why it matters: ${landing.reason}`);
    if (landing.checked) lines.push(`How checked: ${landing.checked}`);
    if (landing.tested) lines.push(`Tested: ${landing.tested}`);
    if (landing.decision) lines.push(`Decision: ${landing.decision}`);
  }
  const reviewed = (task.events || []).slice().reverse().find(e => e.event_type === 'reviewed');
  if (reviewed && reviewed.payload) {
    if (reviewed.payload.proof) lines.push('', `Proof: ${reviewed.payload.proof}`);
    if (reviewed.payload.lesson) lines.push(`Lesson: ${reviewed.payload.lesson}`);
    if (reviewed.payload.next_task) lines.push(`Next: ${reviewed.payload.next_task}`);
  } else if (task.review && task.review.proof) {
    lines.push('', `Proof: ${task.review.proof}`);
    if (task.review.lesson) lines.push(`Lesson: ${task.review.lesson}`);
    if (task.review.next_task) lines.push(`Next: ${task.review.next_task}`);
  }
  return lines.join('\n').slice(0, 5000);
}

function reviewLandingForDisplay(review) {
  if (!review) return null;
  if (review.landing) return review.landing;
  if (!review.result) return null;
  return {
    happened: review.result.changed || null,
    reason: review.result.reason || null,
    checked: review.result.checked || null,
    tested: review.proof ? taskReviewLandingTested(review.proof) : null,
    decision: review.result.accept || null,
  };
}

function printReviewLanding(review) {
  const landing = reviewLandingForDisplay(review);
  if (!landing) return false;
  console.log('Result:');
  if (landing.happened) console.log(`  What happened: ${landing.happened}`);
  if (landing.reason) console.log(`  Why it matters: ${landing.reason}`);
  if (landing.checked) console.log(`  How I checked: ${landing.checked}`);
  if (landing.tested) console.log(`  What I tested: ${landing.tested}`);
  if (review.result && review.result.saved) console.log(`  Saved: ${review.result.saved}`);
  if (landing.decision) console.log(`  Decision: ${landing.decision}`);
  return true;
}

function cloudPayloadForTask(task, businessId) {
  const metadata = task.metadata || {};
  const claimedAtEvent = (task.events || []).find(e => e.event_type === 'claimed');
  return {
    type: taskTypeForCloud(task),
    title: String(task.title || '').slice(0, 200),
    description: taskDescriptionForCloud(task),
    owner_member_id: ownerMemberIdForCloud(task),
    needs_approval: taskNeedsApprovalForCloud(task),
    metadata: {
      ...metadata,
      source: 'atris_cli_task',
      business_id: businessId,
      local_task_id: task.id,
      local_status: task.status,
      local_tag: task.tag || null,
      current_version: task.current_version,
      latest_event_type: task.latest_event_type,
      workspace_root: task.workspace_root,
      swarlo: {
        lease_owner: task.claimed_by || null,
        lease_state: task.status === 'claimed' ? 'held' : 'none',
        lease_started_at: claimedAtEvent ? new Date(claimedAtEvent.created_at).toISOString() : null,
      },
    },
  };
}

function syncPlanForProjection(projection, businessId) {
  const endpoint = `/business/${businessId}/work/tasks`;
  const plan = [];
  for (const task of projection.tasks) {
    const payload = cloudPayloadForTask(task, businessId);
    const cloudTaskId = task.metadata && (task.metadata.cloud_task_id || task.metadata.supabase_task_id);
    if (cloudTaskId) {
      plan.push({
        action: 'patch',
        method: 'PATCH',
        endpoint: `${endpoint}/${cloudTaskId}`,
        local_task_id: task.id,
        cloud_task_id: cloudTaskId,
        body: {
          ...payload,
          state: taskStateForCloud(task),
        },
      });
    } else {
      plan.push({
        action: 'post',
        method: 'POST',
        endpoint,
        local_task_id: task.id,
        body: payload,
        after_create: taskStateForCloud(task) === 'open' ? [] : [{
          method: 'PATCH',
          endpoint: `${endpoint}/{created_task_id}`,
          body: { state: taskStateForCloud(task) },
        }],
      });
    }
  }
  return plan;
}

function latestTaskEvent(task) {
  const events = task.events || [];
  return events.length ? events[events.length - 1] : null;
}

function verifiedProofCommand(proof) {
  const match = String(proof || '').match(/\[verified\]\s+`([^`]+)`\s+passed\s+\(exit 0\)/i);
  return match ? String(match[1] || '').trim() : '';
}

function autoCertifyCommandCandidatesForTask(task) {
  const metadata = task && task.metadata || {};
  const review = task && task.review || {};
  const proof = String(review.proof || metadata.latest_agent_proof || '');
  const candidates = [
    metadata.verify,
    metadata.latest_agent_verify,
    verifiedProofCommand(review.proof),
    verifiedProofCommand(metadata.latest_agent_proof),
    ...taskReviewEvidenceCommands(proof),
  ].map(value => String(value || '').trim()).filter(Boolean);
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reviewBlockerForTask(task) {
  const ref = taskRef(task);
  const candidates = autoCertifyCommandCandidatesForTask(task);
  const safe = candidates.find(command => isAutoCertifyVerifyCommandAllowed(command));
  const unsafe = candidates.find(command => !isAutoCertifyVerifyCommandAllowed(command));
  const reason = !safe && unsafe ? 'verify_command_not_allowed' : 'needs_second_actor_review';
  return {
    reason,
    verify_command: (!safe && unsafe) ? unsafe : (safe || candidates[0] || null),
    next_command: `atris task review-chat ${ref} --as codex-review`,
  };
}

function reviewHandoffForTask(task, { suppressExistingFollowUp = false, hasExistingReviewFollowUp = null } = {}) {
  const review = task && task.review || {};
  if (task && task.status !== 'review') return null;
  if (review.approval_status !== 'pending') return null;
  const agentCertified = review.agent_certified === true;
  const nextTask = reviewNextTaskTitle(task);
  const hasExistingFollowUp = Boolean(suppressExistingFollowUp && taskHasReviewFollowUpChild(task, { hasExistingReviewFollowUp }));
  const proofBoundary = agentCertified ? proofBoundaryBlockedEvaluation(task) : null;
  const nextAction = agentCertified
    ? (proofBoundary ? PROOF_BOUNDARY_BLOCKED_ACTION : certifiedReviewNextAction(hasExistingFollowUp ? '' : nextTask))
    : 'agent_review_again';
  const handoff = {
    native_goal_status: agentCertified ? 'agent_certified' : 'needs_second_agent_review',
    career_xp_status: proofBoundary ? 'blocked_proof_boundary' : 'pending_human_accept',
    next_action: nextAction,
  };
  if (proofBoundary) {
    handoff.reason = proofBoundary.reason;
    handoff.next_action_detail = proofBoundary.next_action || null;
    const note = proofBoundary.reason === MISSION_XP_END_TO_END_REASON
      ? '<attach zero-papercut end-to-end fresh-laptop receipt or move back to Do>'
      : '<replace stale PR proof with merged proof or move back to Do>';
    handoff.revise_command = `atris task revise ${taskRef(task)} --note "${note}"`;
  } else if (!agentCertified) {
    const blocker = reviewBlockerForTask(task);
    handoff.reason = blocker.reason;
    handoff.next_action_detail = blocker.verify_command || null;
    handoff.review_chat_command = blocker.next_command;
  } else if (agentCertified && nextTask && !hasExistingFollowUp) {
    handoff.next_task = nextTask;
    handoff.continue_work_command = continueWorkCommandForTask(task);
  } else if (agentCertified && nextTask && hasExistingFollowUp) {
    handoff.next_task = nextTask;
    handoff.existing_follow_up_child = true;
  }
  return handoff;
}

function reviewActor(value) {
  const actor = String(value || 'codex-review').trim().replace(/[^a-zA-Z0-9:_-]/g, '-');
  return actor || 'codex-review';
}

function taskReviewClip(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function taskReviewFullEvidence(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function taskReviewEvidencePaths(text, limit = 8) {
  const source = String(text || '');
  const matches = source.match(/(?:\.{0,2}\/|~\/|\/)?[\w@.+-]+(?:\/[\w@.+-]+)+(?:\.[A-Za-z0-9]+)?|[\w@.+-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|sh|yml|yaml|toml|lock|txt)/g) || [];
  const out = [];
  const seen = new Set();
  for (const raw of matches) {
    const clean = raw.replace(/[),.;:]+$/g, '');
    const basename = clean.split('/').pop() || clean;
    const hasPathPrefix = /^(?:\.{1,2}\/|~\/|\/)/.test(clean);
    const hasFileExtension = /\.[A-Za-z0-9]+$/.test(basename);
    if (!hasPathPrefix && !hasFileExtension) continue;
    if (!clean || clean.includes('://') || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function taskReviewCommandLooksSpecific(command) {
  const text = String(command || '').trim();
  if (!text) return false;
  if (/^(?:npm|node|git|atris|npx|pnpm|yarn|python3?|pytest|bash|sh|tsc|vitest|curl|gh|rg)$/i.test(text)) return false;
  if (/^atris\s+task\s+\w+\s*$/i.test(text)) return false;
  if (/^atris\s+task\s+(?:accept|auto-accept-certified)\b/i.test(text)) return false;
  if (/^atris[/.]/i.test(text)) return false;
  if (/^atris-\S+/i.test(text)) return false;
  if (/^atris\s+task\s+\w+\s+json\s*$/i.test(text) && !/--json\b/i.test(text)) return false;
  if (/^atris\s+(?:command|review-chat|smoke|temp)\b/i.test(text)) return false;
  if (/^(?:npm|npx|pnpm|yarn|python3?|pytest|bash|sh|tsc|vitest|curl|gh|rg|git)\s+commands?\b/i.test(text)) return false;
  if (/^(?:npm|pnpm|yarn)\s+(?:tests|checks?)$/i.test(text)) return false;
  if (/^(?:git|gh|rg|curl|bash|sh|tsc)\s+(?:tests?|checks?)$/i.test(text)) return false;
  if (/\s+(?:and|then)\s+\S+/i.test(taskReviewWithoutQuotedSegments(text))) return false;
  if (/^node\s+(?!-|\S*(?:[/.]))/i.test(text)) return false;
  if (/^node\s+--test\s+[\w-]+(?:\s+[\w-]+)+$/i.test(text)) return false;
  return true;
}

function taskReviewUnescapedQuoteCount(text, quote) {
  let count = 0;
  const source = String(text || '');
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === quote && source[index - 1] !== '\\') count += 1;
  }
  return count;
}

function taskReviewCommandStartsInsideQuote(clause, commandIndex) {
  const before = String(clause || '').slice(0, Math.max(0, commandIndex));
  return taskReviewUnescapedQuoteCount(before, "'") % 2 === 1
    || taskReviewUnescapedQuoteCount(before, '"') % 2 === 1;
}

function taskReviewWithoutQuotedSegments(text) {
  const source = String(text || '');
  let quote = null;
  let out = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if ((char === "'" || char === '"') && source[index - 1] !== '\\') {
      quote = quote === char ? null : (!quote ? char : quote);
      out += ' ';
      continue;
    }
    out += quote ? ' ' : char;
  }
  return out;
}

function taskReviewTrimOutsideQuotedTail(text, pattern) {
  const source = String(text || '');
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const scanner = new RegExp(pattern.source, flags);
  let match;
  while ((match = scanner.exec(source)) !== null) {
    if (!taskReviewCommandStartsInsideQuote(source, match.index)) {
      return source.slice(0, match.index);
    }
    if (match[0] === '') scanner.lastIndex += 1;
  }
  return source;
}

function taskReviewTrimTrailingOutsideQuote(text) {
  let clean = String(text || '');
  while (clean.length > 0) {
    const index = clean.length - 1;
    if (!/[\]),.;:]/.test(clean[index])) break;
    if (taskReviewCommandStartsInsideQuote(clean, index)) break;
    clean = clean.slice(0, index);
  }
  return clean;
}

function taskReviewCleanEvidenceCommand(command) {
  let clean = String(command || '');
  const tailPatterns = [
    /\s+from\s+[^,;]*(?:showed|shows|showing|returned|returns|printed|prints|wrote|writes|reported|reports)\b.*$/i,
    /\s+(?:showed|shows|showing|returned|returns|printed|prints|wrote|writes|reported|reports)\b.*$/i,
    /\.\s+(?:Reward remains|No human|Human accept|AgentXP|XP)\b.*$/i,
    /\s+with\s+\d+\s+(?:passing\s+)?(?:tests?|checks?|passes|passed|pass|ok|clean)\b.*$/i,
    /\s+\((?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\)$/i,
    /\s+\(?(?:exit|status|code)\s+\d+\)?$/i,
    /\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\s+\d+\/\d+(?:[,.]\s+.*)?$/i,
    /\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\s+\d+\/\d+(?:\s+(?:tests?|checks?|passed|pass|ok|clean|failed|failures?))?$/i,
    /\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)(?:[,.]\s+.*|\s+and\b.*)$/i,
    /\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\s+with\b.*$/i,
    /,\s+(?:command suite|mission-status tests?|live\b|focused suite|clean dry-run|brain compile)\b.*$/i,
    /\.\s+(?:The|This|It|Focused|Dogfood|Landing|Product|Review|Receipt|Human|No|Note)\b.*$/i,
    /\s+\(?\d+\s+(?:passes|passed|pass|ok|clean|tests?|checks?)\)?$/i,
    /\s+only$/i,
    /\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)(?:[.:]\s+.*|\s+after\b.*)$/i,
    /\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\)?$/i,
    /\s+\(?\d+\/\d+(?:\s+(?:tests?|checks?|passed|pass|ok|clean|failed|failures?))?\)?$/i,
    /\s+\d+\/\d+(?:\s+(?:tests?|checks?|passed|pass|ok|clean|failed|failures?))?$/i,
  ];
  for (const pattern of tailPatterns) {
    clean = taskReviewTrimOutsideQuotedTail(clean, pattern);
    clean = taskReviewTrimTrailingOutsideQuote(clean);
  }
  return clean.replace(/\s+/g, ' ').trim();
}

function taskReviewSplitEvidenceClauses(source, commandStart) {
  const text = String(source || '');
  const hardBoundaryPattern = /^(?:;\s*|\n\s*|\s+&&\s+)/;
  const softBoundaryPattern = new RegExp(`^(?:,\\s+|\\.\\s+|\\s+and\\s+|\\s+then\\s+|\\.\\s+(?:focused|full|behavior|verifier)[^\\n.;:]{0,80}:\\s+)(?=${commandStart})`, 'i');
  const clauses = [];
  let clause = '';
  let quote = null;
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if ((char === "'" || char === '"') && text[index - 1] !== '\\') {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      clause += char;
      index += 1;
      continue;
    }
    if (!quote) {
      const rest = text.slice(index);
      const boundary = rest.match(hardBoundaryPattern) || rest.match(softBoundaryPattern);
      if (boundary) {
        if (clause.trim()) clauses.push(clause);
        clause = '';
        index += boundary[0].length;
        continue;
      }
    }
    clause += char;
    index += 1;
  }
  if (clause.trim()) clauses.push(clause);
  return clauses;
}

function taskReviewCommandIsDescribedSubject(clause, commandIndex) {
  const before = String(clause || '').slice(Math.max(0, commandIndex - 80), commandIndex);
  return /\b(?:contains?|displays?|extracts?|lists?|mentions?|names?|prints?|renders?|shows?)\s+(?:only\s+)?$/i.test(before)
    || /\b(?:including|includes?|like|such as|for example|e\.g\.)\s+$/i.test(before);
}

function taskReviewEvidenceCommands(text, limit = 8) {
  const source = String(text || '').trim();
  if (!source) return [];
  const commandWord = '(?:npm|node|git|atris|npx|pnpm|yarn|python3?|pytest|bash|sh|tsc|vitest|curl|gh|rg)';
  const envPrefix = '(?:(?:[A-Z_][A-Z0-9_]*=[^\\s,;|]+)\\s+)*';
  const prosePrefix = '(?:(?:rechecked|reran|re-run|run|verified|validated|passed|validation(?:\\s+passed)?|verification(?:\\s+passed)?|focused|live|scoped|installed|direct|full|current|fresh|then|and|commands?|checks?)[:\\s]+)*';
  const commandStart = `${prosePrefix}${envPrefix}${commandWord}\\b`;
  const commandStartPattern = new RegExp(`(^|[^\\w./=-])(${commandStart})`, 'i');
  const commandStartInnerPattern = new RegExp(`${envPrefix}${commandWord}\\b`, 'i');
  const normalized = source
    .replace(/\r/g, '\n')
    .replace(/```[ \t]*(?:bash|sh|shell|zsh|console|text|txt)?[ \t]*\n/gi, '\n')
    .replace(/```/g, '\n')
    .replace(/`/g, '');
  const clauses = taskReviewSplitEvidenceClauses(normalized, commandStart);
  const out = [];
  const seen = new Set();
  for (const clause of clauses) {
    const start = clause.match(commandStartPattern);
    if (!start || start.index == null) continue;
    const commandStartOffset = start[0].indexOf(start[2]);
    const raw = clause.slice(start.index + Math.max(0, commandStartOffset));
    const prefix = raw.match(commandStartInnerPattern);
    const commandOffset = prefix && prefix.index != null ? prefix.index : 0;
    const commandIndex = start.index + Math.max(0, commandStartOffset) + Math.max(0, commandOffset);
    if (
      taskReviewCommandStartsInsideQuote(clause, commandIndex)
      || taskReviewCommandIsDescribedSubject(clause, commandIndex)
    ) continue;
    const command = raw.slice(Math.max(0, commandOffset));
    const clean = taskReviewCleanEvidenceCommand(command);
    if (!taskReviewCommandLooksSpecific(clean) || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function taskReviewRecentThread(task, limit = 4) {
  return (task && Array.isArray(task.messages) ? task.messages : [])
    .slice(-limit)
    .map(message => ({
      version: message.version || null,
      actor: message.actor || null,
      content: taskReviewClip(message.content, 220),
    }))
    .filter(message => message.content);
}

function taskReviewObjective(task) {
  const metadata = task && task.metadata || {};
  return task && (
    metadata.task_goal
    || task.title
    || metadata.goal_objective
    || metadata.objective
    || task.objective
  ) || '';
}

function taskReviewVerificationFocus(task) {
  const review = task && task.review || {};
  const metadata = task && task.metadata || {};
  const proof = review.proof || metadata.latest_agent_proof || '';
  const lesson = review.lesson || metadata.latest_agent_lesson || '';
  const nextTask = review.next_task || metadata.latest_agent_next_task || '';
  const objective = taskReviewObjective(task);
  const evidenceText = [proof].filter(Boolean).join('\n');
  return {
    objective: taskReviewClip(objective, 260) || null,
    proof_claim: taskReviewFullEvidence(proof) || null,
    commands_to_verify: taskReviewEvidenceCommands(evidenceText),
    files_to_inspect: taskReviewEvidencePaths(evidenceText),
    recent_thread: taskReviewRecentThread(task),
    decision_rule: 'Certify only if the current files, commands, receipts, and task thread prove the Review proof. Otherwise revise with the exact missing proof.',
  };
}

function taskReviewSpecificCodexPrompt(task, focus, actor) {
  const ref = taskRef(task);
  const title = taskReviewClip(task && task.title, 180);
  const proof = focus && focus.proof_claim ? ` Proof: ${taskReviewClip(focus.proof_claim, 1800)}` : '';
  const commands = focus && focus.commands_to_verify && focus.commands_to_verify.length
    ? ` Commands: ${taskReviewFormatCommandList(focus.commands_to_verify)}.`
    : '';
  const files = focus && focus.files_to_inspect && focus.files_to_inspect.length
    ? ` Files/artifacts: ${focus.files_to_inspect.join(', ')}.`
    : '';
  return `/codex review ${ref}: verify "${title}".${proof}${commands}${files} Inspect the task thread, then run ${`atris task review ${ref} --reward 0 --as ${actor} --proof "<specific verifier commands passed and diff/proof inspected>" --verify "<safe verifier command>"`} or revise with the exact missing proof. Do not accept XP.`;
}

function taskReviewChatHandoff(task, { reviewer = 'codex-review', allowCertified = false } = {}) {
  if (!task) return null;
  if (!taskAllowsReviewChat(task, { allowCertified })) return null;
  const ref = taskRef(task);
  const actor = reviewActor(reviewer);
  const verificationFocus = taskReviewVerificationFocus(task);
  const reviewHandoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true });
  const humanAcceptCommand = reviewHandoff && reviewHandoff.next_action === PROOF_BOUNDARY_BLOCKED_ACTION
    ? null
    : `atris task accept ${ref}`;
  return {
    schema: 'atris.task_review_chat.v1',
    command: `atris task review-chat ${ref} --as ${actor}`,
    codex_prompt: taskReviewSpecificCodexPrompt(task, verificationFocus, actor),
    pass_command: `atris task review ${ref} --reward 0 --as ${actor} --proof "<specific verifier commands passed and diff/proof inspected>" --verify "<safe verifier command>"`,
    revise_command: `atris task revise ${ref} --as ${actor} --note "<specific missing proof or required change>"`,
    human_accept_command: humanAcceptCommand,
    verification_focus: {
      objective: verificationFocus.objective,
      proof_claim: verificationFocus.proof_claim,
      commands_to_verify: verificationFocus.commands_to_verify,
      files_to_inspect: verificationFocus.files_to_inspect,
      decision_rule: verificationFocus.decision_rule,
    },
  };
}

function taskWithReviewEvidence(task, { proof, lesson, nextTask } = {}) {
  if (!task) return task;
  const metadata = { ...(task.metadata || {}) };
  const review = { ...(task.review || {}) };
  if (proof !== undefined && proof !== null) {
    const text = String(proof);
    metadata.latest_agent_proof = text;
    review.proof = text;
  }
  if (lesson !== undefined && lesson !== null) {
    const text = String(lesson);
    metadata.latest_agent_lesson = text;
    review.lesson = text;
  }
  if (nextTask !== undefined && nextTask !== null) {
    const text = String(nextTask);
    metadata.latest_agent_next_task = text;
    review.next_task = text;
  }
  return {
    ...task,
    metadata,
    review,
  };
}

function taskWithAgentCertification(task, agentCertified) {
  if (!task || !agentCertified) return task;
  return {
    ...task,
    metadata: {
      ...(task.metadata || {}),
      agent_certified: true,
      agent_review_pass_count: Math.max(Number(task.metadata?.agent_review_pass_count || 0), AGENT_CERTIFICATION_REVIEW_PASSES),
      approval_status: task.metadata?.approval_status || 'pending',
    },
    review: {
      ...(task.review || {}),
      agent_certified: true,
      agent_review_pass_count: Math.max(Number(task.review?.agent_review_pass_count || 0), AGENT_CERTIFICATION_REVIEW_PASSES),
      approval_status: task.review?.approval_status || task.metadata?.approval_status || 'pending',
    },
  };
}

function taskReviewChatContract(task, { reviewer = 'codex-review', allowCertified = false } = {}) {
  const handoff = taskReviewChatHandoff(task, { reviewer, allowCertified });
  const review = task && task.review || {};
  const metadata = task && task.metadata || {};
  const proof = review.proof || metadata.latest_agent_proof || '';
  const lesson = review.lesson || metadata.latest_agent_lesson || '';
  const nextTask = review.next_task || metadata.latest_agent_next_task || '';
  const objective = taskReviewObjective(task);
  const verificationFocus = taskReviewVerificationFocus(task);
  const actor = reviewActor(reviewer);
  return {
    ...handoff,
    codex_prompt: taskReviewSpecificCodexPrompt(task, verificationFocus, actor),
    task: {
      id: task.id,
      ref: taskRef(task),
      title: task.title,
      status: task.status,
      objective: objective || null,
      claimed_by: task.claimed_by || null,
    },
    review: {
      approval_status: review.approval_status || metadata.approval_status || null,
      agent_review_pass_count: review.agent_review_pass_count || metadata.agent_review_pass_count || null,
      agent_certified: review.agent_certified === true || metadata.agent_certified === true,
      proof: proof || null,
      lesson: lesson || null,
      next_task: nextTask || null,
    },
    verification_focus: verificationFocus,
    required_checks: [
      `Run ${`atris task show ${taskRef(task)} --json`} and read the current proof plus dialogue.`,
      verificationFocus.commands_to_verify.length
        ? `Re-run or inspect these proof commands: ${taskReviewFormatCommandList(verificationFocus.commands_to_verify)}.`
        : 'Find the concrete verifier command because the proof did not name one.',
      verificationFocus.files_to_inspect.length
        ? `Inspect these named files/artifacts before certifying: ${verificationFocus.files_to_inspect.join(', ')}.`
        : 'Inspect the relevant diff/artifact boundary before certifying.',
      'Compare current task thread state against the proof claim; stale or unrelated proof must be revised.',
      'Use revise instead of review when proof is vague, stale, too narrow, or missing.',
      'Do not run task accept unless the human explicitly approves XP.',
    ],
  };
}

function taskReviewChatNote(contract) {
  const checks = (contract.required_checks || []).map((check, index) => `${index + 1}. ${check}`).join('\n');
  return [
    'TASK_REVIEW_CHAT',
    `task: ${contract.task.ref}`,
    `reviewer: ${reviewActor(contract.command.split('--as ')[1] || 'codex-review')}`,
    `pass: ${contract.pass_command}`,
    `revise: ${contract.revise_command}`,
    `human_accept_xp: ${contract.human_accept_command}`,
    '',
    `objective: ${contract.verification_focus.objective || 'unknown'}`,
    `proof_claim: ${contract.verification_focus.proof_claim || 'missing'}`,
    '',
    'commands_to_verify:',
    ...(contract.verification_focus.commands_to_verify.length
      ? contract.verification_focus.commands_to_verify.map(command => `- ${command}`)
      : ['- missing: find or request a concrete verifier command']),
    '',
    'files_to_inspect:',
    ...(contract.verification_focus.files_to_inspect.length
      ? contract.verification_focus.files_to_inspect.map(file => `- ${file}`)
      : ['- missing: inspect the relevant diff/artifact boundary']),
    '',
    'recent_thread:',
    ...(contract.verification_focus.recent_thread.length
      ? contract.verification_focus.recent_thread.map(message => `- v${message.version || '?'} ${message.actor || 'unknown'}: ${message.content}`)
      : ['- no recent task dialogue captured']),
    '',
    contract.codex_prompt,
    '',
    'checks:',
    checks,
  ].join('\n');
}

function compactTaskForStatus(task) {
  if (!task) return null;
  const metadata = task.metadata || {};
  const title = clipStatusTitle(task.title, 140);
  const out = {
    id: task.id,
    display_id: task.display_id || null,
    legacy_ref: task.legacy_ref || taskRef(task.id),
    title,
    result: clipStatusText(task.result || metadata.result, 180) || null,
    status: task.status,
    updated_at: task.updated_at,
    explanation: taskExplanation({ ...task, title }),
    approval: task.approval || taskApprovalFor(task),
  };
  if (task.tag) out.tag = task.tag;
  if (task.claimed_by) out.claimed_by = task.claimed_by;
  const assignedTo = taskAssignee(task);
  if (assignedTo) out.assigned_to = assignedTo;
  if (task.latest_event_type) out.latest_event_type = task.latest_event_type;
  if (task.objective) out.objective = clipStatusText(task.objective, 180);
  if (task.review) {
    const review = {};
    if (typeof task.review.reward === 'number') review.reward = task.review.reward;
    else if (task.review.reward === null) review.reward = null;
    if (task.review.landing) review.landing = task.review.landing;
    if (task.review.result) review.result = task.review.result;
    if (task.review.summary) review.summary = clipStatusText(task.review.summary, 240);
    if (task.review.proof) review.proof = clipStatusText(task.review.proof, 180);
    if (task.review.lesson) review.lesson = clipStatusText(task.review.lesson, 180);
    if (task.review.next_task) review.next_task = clipStatusText(task.review.next_task, 140);
    if (Object.prototype.hasOwnProperty.call(task.review, 'receipt_path')) review.receipt_path = task.review.receipt_path || null;
    if (task.review.approval_status) review.approval_status = task.review.approval_status;
    if (task.review.agent_review_pass_count) review.agent_review_pass_count = task.review.agent_review_pass_count;
    if (task.review.agent_certified) review.agent_certified = task.review.agent_certified;
    if (task.review.agent_certification_policy) review.agent_certification_policy = task.review.agent_certification_policy;
    if (task.review.human_revision_count) review.human_revision_count = task.review.human_revision_count;
    if (task.review.verification_chat) review.verification_chat = task.review.verification_chat;
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true });
    if (handoff) review.handoff = handoff;
    if (Object.keys(review).length) out.review = review;
  }
  if (task.lineage) {
    const lineage = {};
    if (task.lineage.parent_task_id) lineage.parent_task_id = task.lineage.parent_task_id;
    if (task.lineage.parent_title) lineage.parent_title = clipStatusText(task.lineage.parent_title, 140);
    if (task.lineage.child_task_ids && task.lineage.child_task_ids.length) lineage.child_task_ids = task.lineage.child_task_ids;
    if (task.lineage.next_task_suggestion) lineage.next_task_suggestion = clipStatusText(task.lineage.next_task_suggestion, 140);
    if (Object.keys(lineage).length) out.lineage = lineage;
  }
  const compactMetadata = {};
  for (const key of ['todo_id', 'stage', 'verify', 'delegate_via', 'owner_resolution', 'requested_owner', 'executed_by', 'proposed_member', 'proposed_member_command', 'goal_id', 'task_goal', 'goal_objective', 'approval_status', 'agent_review_pass_count', 'agent_certified', 'agent_certification_policy', 'human_revision_count', 'human_revision_note']) {
    if (metadata[key]) compactMetadata[key] = key === 'verify' ? clipStatusText(metadata[key], 180) : metadata[key];
  }
  if (Object.keys(compactMetadata).length) out.metadata = compactMetadata;
  return out;
}

function compactTaskFromProjection(projection, id) {
  return compactTaskForStatus(taskFromProjection(projection, id));
}

function compactEventPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const out = {};
  for (const key of ['title', 'status', 'tag', 'content', 'goal', 'summary', 'proof', 'lesson', 'reward', 'next_task', 'result']) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') out[key] = payload[key];
  }
  return Object.keys(out).length ? out : null;
}

function compactTaskEvent(event) {
  if (!event) return null;
  return {
    event_id: event.event_id,
    task_id: event.task_id,
    version: event.version,
    actor: event.actor || null,
    event_type: event.event_type,
    created_at: event.created_at,
    payload: compactEventPayload(event.payload),
  };
}

function clipStatusText(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function clipStatusTitle(value, max = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const boundaries = [...cut.matchAll(/[.!?;](?=\s|$)/g)];
  const boundary = boundaries.map((match) => match.index).filter((index) => index >= max * 0.45).pop();
  if (Number.isInteger(boundary)) {
    return cut.slice(0, boundary + 1).replace(/[;:]+$/, '').trim();
  }
  const wholeWords = text.slice(0, max).replace(/\s+\S*$/, '').trim();
  return `${wholeWords || text.slice(0, max).trim()}...`;
}

function compactReviewActionRef(task, { hasExistingReviewFollowUp = null } = {}) {
  if (!task) return null;
  const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp }) || {};
  return {
    id: task.id,
    display_id: task.display_id || null,
    ref: taskRef(task),
    title: clipStatusText(task.title, 120),
    claimed_by: task.claimed_by || null,
    assigned_to: taskAssignee(task),
    next_action: handoff.next_action || null,
    next_task: handoff.next_task || null,
    command: handoff.continue_work_command || handoff.revise_command || null,
    reason: handoff.reason || null,
    next_action_detail: handoff.next_action_detail || null,
  };
}

function taskStatusSummary(projection, { history = false, hasExistingReviewFollowUp = null } = {}) {
  const tasks = projection.tasks || [];
  const hiddenDoneCount = Math.max(0, Number(projection.surface && projection.surface.hidden_done_count || 0));
  const fullTaskCount = Math.max(tasks.length + hiddenDoneCount, Number(projection.surface && projection.surface.full_task_count || 0));
  const columns = {
    backlog: tasks.filter(task => taskColumn(task) === 'backlog'),
    plan: tasks.filter(task => taskColumn(task) === 'open'),
    do: tasks.filter(task => taskColumn(task) === 'doing'),
    review: tasks.filter(task => taskColumn(task) === 'review'),
    blocked: tasks.filter(task => taskColumn(task) === 'blocked'),
    done: tasks.filter(task => taskColumn(task) === 'done'),
  };
  const active = [...columns.do, ...columns.review, ...columns.blocked, ...columns.plan];
  const reviewNeedingAgentAction = columns.review.filter(task => {
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    return handoff && handoff.next_action === 'agent_review_again';
  });
  const reviewContinueWork = columns.review.filter(task => {
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    return handoff && handoff.next_action === 'continue_work';
  });
  const reviewHumanAcceptWaiting = columns.review.filter(task => {
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    return handoff && handoff.next_action === 'human_accept_waiting';
  });
  const reviewProofBoundaryBlocked = columns.review.filter(task => {
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    return handoffIsProofBoundaryBlocked(handoff);
  });
  const reviewAgentCertified = reviewContinueWork.length + reviewHumanAcceptWaiting.length + reviewProofBoundaryBlocked.length;
  const blocked = columns.blocked.length;
  const lastUpdated = tasks.reduce((max, task) => Math.max(max, Number(task.updated_at || 0)), 0);
  const swarloFeed = history ? tasks
    .flatMap(task => (task.events || []).map(event => ({
      task_id: task.id,
      task_title: clipStatusText(task.title, 120),
      actor: event.actor || task.claimed_by || null,
      kind: event.event_type === 'claimed'
        ? 'claim'
        : event.event_type === 'completed' || event.event_type === 'reviewed'
          ? 'result'
          : 'note',
      channel: task.tag || 'tasks',
      content: clipStatusText(
        event.payload && (event.payload.content || event.payload.proof || event.payload.lesson)
          || humanEventType(event.event_type),
        180,
      ),
      created_at: event.created_at,
      metadata: {
        swarlo: {
          task_key: task.id,
          kind: event.event_type === 'claimed' ? 'claim' : event.event_type === 'completed' || event.event_type === 'reviewed' ? 'result' : 'note',
          status: taskStateForCloud(task),
        },
      },
    })))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 12) : [];
  const status = {
    schema: 'atris.task_status.v1',
    generated_at: projection.generated_at,
    workspace_root: projection.workspace_root,
    goals: projection.goals || { source_path: null, items: [] },
    counts: {
      total: fullTaskCount,
      active: columns.plan.length + columns.do.length + reviewNeedingAgentAction.length + reviewProofBoundaryBlocked.length,
      backlog: columns.backlog.length,
      plan: columns.plan.length,
      do: columns.do.length,
      review: columns.review.length,
      review_blocking: reviewNeedingAgentAction.length,
      review_certified: reviewAgentCertified,
      review_continue_work: reviewContinueWork.length,
      review_proof_boundary_blocked: reviewProofBoundaryBlocked.length,
      review_human_accept_waiting: reviewHumanAcceptWaiting.length,
      blocked,
      done: tasks.filter(task => task.status === 'done' || (task.status === 'failed' && taskHasReview(task))).length + hiddenDoneCount,
    },
    current: compactTaskForStatus(columns.do[0] || reviewNeedingAgentAction[0] || reviewProofBoundaryBlocked[0] || null),
    next: compactTaskForStatus(columns.plan[0] || null),
    review_actions: {
      continue_work: {
        count: reviewContinueWork.length,
        first: compactReviewActionRef(reviewContinueWork[0] || null, { hasExistingReviewFollowUp }),
      },
      proof_boundary_blocked: {
        count: reviewProofBoundaryBlocked.length,
        first: compactReviewActionRef(reviewProofBoundaryBlocked[0] || null, { hasExistingReviewFollowUp }),
      },
      human_accept_waiting: {
        count: reviewHumanAcceptWaiting.length,
        first: compactReviewActionRef(reviewHumanAcceptWaiting[0] || null, { hasExistingReviewFollowUp }),
      },
    },
    needs_review: columns.review.slice(0, 5).map(compactTaskForStatus),
    streams: (projection.streams || []).slice(0, 8).map(stream => ({
      objective: stream.objective,
      active_count: stream.active_count,
      done_count: stream.done_count,
      open_count: stream.open_count,
      doing_count: stream.doing_count,
      review_count: stream.review_count,
      blocked_count: stream.blocked_count,
      tasks: (stream.tasks || []).map(task => ({
        id: task.id,
        title: clipStatusText(task.title, 120),
        status: task.status,
        tag: task.tag || null,
        claimed_by: task.claimed_by || null,
        assigned_to: task.assigned_to || null,
        parent_task_id: task.parent_task_id || null,
        child_task_ids: task.child_task_ids || [],
        proof: task.proof || null,
      })),
    })),
    last_updated_at: lastUpdated ? new Date(lastUpdated).toISOString() : null,
  };
  if (history) {
    status.last_event = active.map(task => ({ task: compactTaskForStatus(task), event: compactTaskEvent(latestTaskEvent(task)) })).filter(row => row.event)
      .sort((a, b) => b.event.created_at - a.event.created_at)[0] || null;
    status.swarlo = {
      feed: swarloFeed,
      realtime_contract: {
        claim: 'Swarlo claim -> canonical task state=doing + lease metadata',
        report_done: 'Swarlo report(done) -> canonical task state=done + proof metadata',
        web: 'atrisos-web reads canonical tasks through /api/agent/:id/tasks or /api/business/* and live activity through public business/Swarlo posts',
      },
    };
  }
  return status;
}

function taskQueueColumnKey(task) {
  const column = taskColumn(task);
  if (column === 'open') return 'plan';
  if (column === 'doing') return 'do';
  return column;
}

function sortTasksNewestFirst(tasks) {
  return [...tasks].sort((a, b) => {
    const byUpdated = Number(b.updated_at || 0) - Number(a.updated_at || 0);
    if (byUpdated) return byUpdated;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

function sortTasksOldestFirst(tasks) {
  return [...tasks].sort((a, b) => {
    const byUpdated = Number(a.updated_at || 0) - Number(b.updated_at || 0);
    if (byUpdated) return byUpdated;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

function taskQueueItem(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  const page = taskPageContract(task, { reviewer, hasExistingReviewFollowUp });
  const item = compactTaskForStatus(task) || {};
  item.ref = taskRef(task);
  item.display_id = item.display_id || task.display_id || null;
  item.legacy_ref = item.legacy_ref || task.legacy_ref || taskRef(task.id);
  if (item.review && item.review.verification_chat) {
    item.review = { ...item.review };
    delete item.review.verification_chat;
  }
  item.column = taskQueueColumnKey(task);
  item.stage_current = page.stage.current;
  item.next_action = page.stage.next_action;
  item.commands = {
    page: page.actions.page_command,
    step: page.actions.step_command,
    chat: page.actions.chat_command,
  };
  if (page.actions.review_chat_command) item.commands.review_chat = page.actions.review_chat_command;
  if (page.actions.continue_work_command) {
    item.commands.continue_work = page.actions.continue_work_command;
    item.continue_work_command = page.actions.continue_work_command;
  }
  if (page.actions.human_accept_command) item.commands.human_accept = page.actions.human_accept_command;
  item.api = {
    detail: page.api.detail,
    page: page.api.page,
    step: page.api.step,
  };
  if (page.stage.next_action.api) item.api.next_action = page.stage.next_action.api;
  return item;
}

function taskQueueLimit(args) {
  if (hasFlag(args, '--all')) return Number.POSITIVE_INFINITY;
  const raw = flag(args, '--limit');
  const limit = raw && raw !== true ? Number(raw) : 8;
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8;
}

function cleanTaskScopeValue(value) {
  if (value === undefined || value === null || value === true) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeTaskQueueScope(scope = {}) {
  return {
    goal_id: cleanTaskScopeValue(scope.goal_id || scope.goalId),
    tag: cleanTaskScopeValue(scope.tag),
    status: cleanTaskScopeValue(scope.status),
    review_state: cleanTaskScopeValue(scope.review_state || scope.reviewState),
  };
}

function taskQueueScopeFromArgs(args = []) {
  return normalizeTaskQueueScope({
    goal_id: flag(args, '--goal-id') || flag(args, '--goal_id'),
    tag: flag(args, '--tag'),
    status: flag(args, '--status'),
    review_state: flag(args, '--review-state') || flag(args, '--review_state'),
  });
}

function taskQueueScopeFromSearchParams(searchParams) {
  return normalizeTaskQueueScope({
    goal_id: searchParams.get('goal_id') || searchParams.get('goal-id') || searchParams.get('goalId'),
    tag: searchParams.get('tag'),
    status: searchParams.get('status'),
    review_state: searchParams.get('review_state') || searchParams.get('review-state') || searchParams.get('reviewState'),
  });
}

function taskQueueScopeFromBody(body = {}) {
  const scope = body.scope && typeof body.scope === 'object' ? body.scope : {};
  return normalizeTaskQueueScope({
    goal_id: body.goal_id || body.goalId || scope.goal_id || scope.goalId,
    tag: body.tag || scope.tag,
    status: body.status || scope.status,
    review_state: body.review_state || body.reviewState || scope.review_state || scope.reviewState,
  });
}

function mergeTaskQueueScopes(primary = {}, fallback = {}) {
  const a = normalizeTaskQueueScope(primary);
  const b = normalizeTaskQueueScope(fallback);
  return normalizeTaskQueueScope({
    goal_id: a.goal_id || b.goal_id,
    tag: a.tag || b.tag,
    status: a.status || b.status,
    review_state: a.review_state || b.review_state,
  });
}

function taskQueueScopeIsEmpty(scope = {}) {
  const normalized = normalizeTaskQueueScope(scope);
  return !normalized.goal_id && !normalized.tag && !normalized.status && !normalized.review_state;
}

function taskScopeEquals(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function taskGoalScopeValues(task) {
  const metadata = task && task.metadata || {};
  const lineage = task && task.lineage || {};
  return [
    task && task.id,
    task && task.display_id,
    task && task.legacy_ref,
    metadata.goal_id,
    metadata.goalId,
    metadata.goal && metadata.goal.id,
    metadata.parent_task_id,
    lineage.parent_task_id,
    task && task.parent_task_id,
  ].filter(Boolean);
}

function taskReviewStateMatches(task, reviewState, { hasExistingReviewFollowUp = null } = {}) {
  const wanted = String(reviewState || '').trim().toLowerCase().replace(/_/g, '-');
  if (!wanted || wanted === 'any') return true;
  const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
  if (wanted === 'continue-work' || wanted === 'continue' || wanted === 'agent-actionable' || wanted === 'executable') {
    return handoff?.next_action === 'continue_work';
  }
  if (wanted === 'proof-boundary-blocked' || wanted === 'proof-boundary' || wanted === 'boundary-blocked' || wanted === 'stale-pr-proof' || wanted === 'unmerged-pr-proof') {
    return handoff?.next_action === PROOF_BOUNDARY_BLOCKED_ACTION;
  }
  if (wanted === 'human-accept-waiting' || wanted === 'human-accept' || wanted === 'accept-waiting' || wanted === 'waiting-accept' || wanted === 'no-next-task') {
    return handoff?.next_action === 'human_accept_waiting';
  }
  if (wanted === 'needs-agent' || wanted === 'needs-review' || wanted === 'agent-review') {
    return handoff?.next_action === 'agent_review_again';
  }
  if (wanted === 'certified' || wanted === 'waiting-human' || wanted === 'human-waiting') {
    return handoff?.next_action === 'continue_work'
      || handoff?.next_action === 'human_accept_waiting'
      || handoff?.next_action === PROOF_BOUNDARY_BLOCKED_ACTION;
  }
  return false;
}

function taskMatchesQueueScope(task, scope = {}, options = {}) {
  const normalized = normalizeTaskQueueScope(scope);
  if (normalized.goal_id && !taskGoalScopeValues(task).some(value => taskScopeEquals(value, normalized.goal_id))) {
    return false;
  }
  if (normalized.tag && !taskScopeEquals(task && task.tag, normalized.tag)) {
    return false;
  }
  if (normalized.status) {
    const rawStatus = task && task.status;
    const columnStatus = taskQueueColumnKey(task);
    if (!taskScopeEquals(rawStatus, normalized.status) && !taskScopeEquals(columnStatus, normalized.status)) {
      return false;
    }
  }
  if (normalized.review_state && !taskReviewStateMatches(task, normalized.review_state, options)) {
    return false;
  }
  return true;
}

function filterTasksByScope(tasks = [], scope = {}, options = {}) {
  const normalized = normalizeTaskQueueScope(scope);
  if (taskQueueScopeIsEmpty(normalized)) return tasks;
  return tasks.filter(task => taskMatchesQueueScope(task, normalized, options));
}

function taskQueueScopeWithoutReviewState(scope = {}) {
  const normalized = normalizeTaskQueueScope(scope);
  return normalizeTaskQueueScope({
    goal_id: normalized.goal_id,
    tag: normalized.tag,
    status: normalized.status,
  });
}

function taskReviewStateCounts(tasks = [], { hasExistingReviewFollowUp = null } = {}) {
  const counts = {
    total: 0,
    needs_agent: 0,
    continue_work: 0,
    proof_boundary_blocked: 0,
    human_accept_waiting: 0,
    certified: 0,
  };
  for (const task of tasks || []) {
    if (!task || taskQueueColumnKey(task) !== 'review') continue;
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    if (!handoff) continue;
    counts.total += 1;
    if (handoff.next_action === 'agent_review_again') counts.needs_agent += 1;
    if (handoff.next_action === 'continue_work') counts.continue_work += 1;
    if (handoff.next_action === PROOF_BOUNDARY_BLOCKED_ACTION) counts.proof_boundary_blocked += 1;
    if (handoff.next_action === 'human_accept_waiting') counts.human_accept_waiting += 1;
  }
  counts.certified = counts.continue_work + counts.proof_boundary_blocked + counts.human_accept_waiting;
  return counts;
}

function taskHasReviewFollowUpChild(task, { hasExistingReviewFollowUp = null } = {}) {
  const nextTitle = reviewNextTaskTitle(task);
  if (!nextTitle) return false;
  if (typeof hasExistingReviewFollowUp === 'function' && hasExistingReviewFollowUp(task)) return true;
  const childIds = task && task.lineage && task.lineage.child_task_ids;
  if (!Array.isArray(childIds) || !childIds.some(Boolean)) return false;
  const childTitles = task && task.lineage && task.lineage.child_titles;
  if (Array.isArray(childTitles) && childTitles.some(title => String(title || '').trim() === nextTitle)) return true;
  // A certified review row should spawn one follow-up; later next_task edits should not reopen the parent.
  return true;
}

function taskQueueReviewStateCounts(projection, scope = {}, { hasExistingReviewFollowUp = null } = {}) {
  const normalizedScope = normalizeTaskQueueScope(scope);
  const countScope = taskQueueScopeWithoutReviewState(normalizedScope);
  const tasks = filterTasksByScope(sortTasksNewestFirst(projection.tasks || []), countScope, { hasExistingReviewFollowUp });
  return {
    schema: 'atris.task_review_state_counts.v1',
    scope: countScope,
    active_filter: normalizedScope.review_state || null,
    ...taskReviewStateCounts(tasks, { hasExistingReviewFollowUp }),
  };
}

function taskReviewStateActionSample(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  if (!task) return null;
  const page = taskPageContract(task, { reviewer, hasExistingReviewFollowUp });
  const nextAction = page.stage && page.stage.next_action || {};
  const sample = {
    id: task.id,
    display_id: task.display_id || null,
    ref: taskRef(task),
    title: clipStatusText(task.title, 120),
    claimed_by: task.claimed_by || null,
    assigned_to: taskAssignee(task),
    next_action: nextAction.key || null,
    label: nextAction.label || null,
    command: nextAction.command || null,
    api: nextAction.api || null,
    step_command: page.actions.step_command,
    step_api: page.api.step,
    human_accept: {
      enabled: Boolean(page.review && page.review.human_accept && page.review.human_accept.enabled),
      human_only: true,
      command: page.review && page.review.human_accept ? page.review.human_accept.command : null,
    },
  };
  if (page.actions.review_chat_command) sample.review_chat_command = page.actions.review_chat_command;
  if (page.actions.continue_work_command) sample.continue_work_command = page.actions.continue_work_command;
  if (page.actions.revise_command) sample.revise_command = page.actions.revise_command;
  if (nextAction.reason) sample.reason = nextAction.reason;
  if (nextAction.next_action_detail) sample.next_action_detail = nextAction.next_action_detail;
  return sample;
}

function normalizeTaskIdSet(values) {
  if (!values) return new Set();
  const list = values instanceof Set ? Array.from(values) : Array.isArray(values) ? values : [values];
  return new Set(list.map(value => String(value || '').trim()).filter(Boolean));
}

function taskHasPendingReviewChat(task, { hasPendingReviewChat = null } = {}) {
  return Boolean(typeof hasPendingReviewChat === 'function' && hasPendingReviewChat(task));
}

function pendingReviewChatActionSample(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  const sample = taskReviewStateActionSample(task, { reviewer, hasExistingReviewFollowUp });
  if (!sample) return null;
  sample.next_action = 'pending_review_chat';
  sample.label = 'Pending review chat';
  sample.command = null;
  sample.api = null;
  sample.step_command = null;
  sample.step_api = null;
  sample.reason = PENDING_REVIEW_CHAT_STOP_REASON;
  delete sample.review_chat_command;
  delete sample.continue_work_command;
  return sample;
}

function taskQueueReviewStateActions(projection, scope = {}, { reviewer = 'codex-review', hasExistingReviewFollowUp = null, hasPendingReviewChat = null, excludeTaskIds = null } = {}) {
  const normalizedScope = normalizeTaskQueueScope(scope);
  const actionScope = taskQueueScopeWithoutReviewState(normalizedScope);
  const tasks = filterTasksByScope(sortTasksNewestFirst(projection.tasks || []), actionScope, { hasExistingReviewFollowUp });
  const excluded = normalizeTaskIdSet(excludeTaskIds);
  const firstByState = {
    needs_agent: null,
    continue_work: null,
    proof_boundary_blocked: null,
    human_accept_waiting: null,
  };
  const skippedContinueWorkWithFollowUp = [];
  const pendingReviewChats = [];
  for (const task of tasks || []) {
    if (!task || taskQueueColumnKey(task) !== 'review') continue;
    if (excluded.has(String(task.id || ''))) continue;
    const rawHandoff = reviewHandoffForTask(task);
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    if (!handoff) continue;
    if (handoff.next_action === 'agent_review_again' && taskHasPendingReviewChat(task, { hasPendingReviewChat })) {
      pendingReviewChats.push(task);
      continue;
    }
    if (handoff.next_action === 'agent_review_again' && !firstByState.needs_agent) {
      firstByState.needs_agent = task;
    }
    if (rawHandoff?.next_action === 'continue_work' && taskHasReviewFollowUpChild(task, { hasExistingReviewFollowUp })) {
      skippedContinueWorkWithFollowUp.push(task);
    }
    if (handoff.next_action === 'continue_work' && !firstByState.continue_work) {
      firstByState.continue_work = task;
    }
    if (handoff.next_action === PROOF_BOUNDARY_BLOCKED_ACTION && !firstByState.proof_boundary_blocked) {
      firstByState.proof_boundary_blocked = task;
    }
    if (handoff.next_action === 'human_accept_waiting' && !firstByState.human_accept_waiting) {
      firstByState.human_accept_waiting = task;
    }
  }
  return {
    schema: 'atris.task_review_state_actions.v1',
    scope: actionScope,
    active_filter: normalizedScope.review_state || null,
    needs_agent: taskReviewStateActionSample(firstByState.needs_agent, { reviewer, hasExistingReviewFollowUp }),
    continue_work: taskReviewStateActionSample(firstByState.continue_work, { reviewer, hasExistingReviewFollowUp }),
    proof_boundary_blocked: taskReviewStateActionSample(firstByState.proof_boundary_blocked, { reviewer, hasExistingReviewFollowUp }),
    human_accept_waiting: taskReviewStateActionSample(firstByState.human_accept_waiting, { reviewer, hasExistingReviewFollowUp }),
    skipped_continue_work_with_follow_up_count: skippedContinueWorkWithFollowUp.length,
    skipped_continue_work_with_follow_up: skippedContinueWorkWithFollowUp
      .slice(0, 5)
      .map(task => taskReviewStateActionSample(task, { reviewer, hasExistingReviewFollowUp })),
    pending_review_chat_count: pendingReviewChats.length,
    pending_review_chat: pendingReviewChats
      .slice(0, 5)
      .map(task => pendingReviewChatActionSample(task, { reviewer, hasExistingReviewFollowUp })),
  };
}

function taskQueueCapabilities() {
  return {
    schema: 'atris.task_capabilities.v1',
    read_only_semantics: 'read_only means no task DB mutation; some read surfaces may refresh projection cache files',
    surfaces: {
      capabilities: {
        command: 'atris task capabilities --json',
        api: { method: 'GET', path: '/api/tasks/capabilities' },
        read_only: true,
        mutates_task_db: false,
        writes_projection: false,
        requires_task_db: {
          cli: false,
          api_route_handler: false,
          api_server: true,
        },
      },
      capabilities_check: {
        command: 'atris task capabilities-check --json',
        api: { method: 'GET', path: '/api/tasks/capabilities/check' },
        read_only: true,
        mutates_task_db: false,
        writes_projection: true,
        requires_task_db: true,
      },
      review_lane_drain: {
        command: 'atris task review-lane-drain --json',
        api: { method: 'GET', path: '/api/tasks/review-lane-drain' },
        read_only: true,
        mutates_task_db: false,
        writes_projection: true,
        requires_task_db: true,
        skips_existing_follow_up_children: true,
        output_fields: {
          identity: ['selected_task_id', 'selected_ref', 'selected_next_key'],
        },
      },
      review_lane_act: {
        command: 'atris task review-lane-act --json',
        api: { method: 'POST', path: '/api/tasks/review-lane-act' },
        read_only: false,
        mutates_task_db: 'conditional',
        writes_projection: true,
        requires_task_db: true,
        dry_run_flag: '--dry-run',
        allowed_actions: ['review_chat', 'continue_work'],
        blocked_actions: [PROOF_BOUNDARY_BLOCKED_ACTION, 'human_accept_waiting', 'pending_review_chat', 'capabilities_drift', 'none'],
        output_fields: {
          identity: ['selected_task_id', 'selected_ref', 'selected_next_key'],
        },
      },
      review_lane_loop: {
        command: 'atris task review-lane-loop --json',
        api: { method: 'POST', path: '/api/tasks/review-lane-loop' },
        read_only: false,
        mutates_task_db: 'conditional',
        writes_projection: true,
        requires_task_db: true,
        dry_run_flag: '--dry-run',
        max_steps_flag: '--max-steps <n>',
        default_max_steps: REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS,
        max_steps_cap: REVIEW_LANE_LOOP_MAX_STEPS,
        orchestrates: 'review_lane_act',
        allowed_actions: ['review_chat', 'continue_work'],
        stopped_by: ['dry_run_preview', PROOF_BOUNDARY_BLOCKED_REASON, 'human_accept_waiting_is_human_only', PENDING_REVIEW_CHAT_STOP_REASON, 'capabilities_check_failed', 'no_review_lane_action', 'continue_work_reused_existing_follow_up', 'repeat_selection', 'max_steps_reached'],
        blocked_actions: [PROOF_BOUNDARY_BLOCKED_ACTION, 'human_accept_waiting', 'pending_review_chat'],
      },
      review_lane_run: {
        command: 'atris task review-lane-run --json',
        api: { method: 'POST', path: '/api/tasks/review-lane-run' },
        read_only: false,
        mutates_task_db: 'conditional',
        writes_projection: true,
        writes_receipt: true,
        receipt_path: '.atris/state/review-lane-runs.jsonl',
        latest_receipt_path: '.atris/state/review-lane-run.latest.json',
        requires_task_db: true,
        dry_run_flag: '--dry-run',
        max_runs_flag: '--max-runs <n>',
        max_steps_flag: '--max-steps <n>',
        default_max_runs: REVIEW_LANE_RUN_DEFAULT_MAX_RUNS,
        max_runs_cap: REVIEW_LANE_RUN_MAX_RUNS,
        default_max_steps: REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS,
        max_steps_cap: REVIEW_LANE_LOOP_MAX_STEPS,
        orchestrates: 'review_lane_loop',
        allowed_actions: ['review_chat', 'continue_work'],
        stopped_by: ['dry_run_preview', PROOF_BOUNDARY_BLOCKED_REASON, 'human_accept_waiting_is_human_only', PENDING_REVIEW_CHAT_STOP_REASON, 'capabilities_check_failed', 'no_review_lane_action', 'continue_work_reused_existing_follow_up', 'repeat_selection', 'max_runs_reached'],
        blocked_actions: [PROOF_BOUNDARY_BLOCKED_ACTION, 'human_accept_waiting', 'pending_review_chat'],
      },
      current: {
        command: 'atris task current --review-state <lane> --json',
        api: { method: 'GET', path: '/api/tasks/current?review_state=<lane>' },
        read_only: true,
        mutates_task_db: false,
        writes_projection: true,
        requires_task_db: true,
        output_fields: {
          identity: ['selected_task_id', 'selected_ref', 'selected_next_key'],
        },
      },
      queue: {
        command: 'atris task queue --review-state <lane> --json',
        api: { method: 'GET', path: '/api/tasks/queue?review_state=<lane>' },
        read_only: true,
        mutates_task_db: false,
        writes_projection: true,
        requires_task_db: true,
        output_fields: {
          identity: ['selected_task_id', 'selected_ref', 'selected_next_key'],
        },
      },
    },
    filters: {
      review_state: {
        cli_flag: '--review-state <lane>',
        query: 'review_state=<lane>',
        accepted: [...TASK_REVIEW_STATE_LANES],
        aliases: { ...TASK_REVIEW_STATE_ALIASES },
      },
    },
    commands: {
      capabilities: 'atris task capabilities --json',
      capabilities_check: 'atris task capabilities-check --json',
      review_lane_drain: 'atris task review-lane-drain --json',
      review_lane_act: 'atris task review-lane-act --json',
      review_lane_loop: 'atris task review-lane-loop --json',
      review_lane_run: 'atris task review-lane-run --json',
      current: 'atris task current --review-state <lane> --json',
      queue: 'atris task queue --review-state <lane> --json',
      current_step: 'atris task current-step --review-state <lane> --json',
    },
    current_step: {
      api: { method: 'POST', path: '/api/tasks/current/step?review_state=<lane>' },
      output_fields: {
        identity: ['selected_task_id', 'selected_ref', 'selected_next_key'],
      },
      safety: {
        read_only: false,
        claims_work: 'conditional',
        claiming_stages: ['plan'],
        human_accept: false,
        xp_after_human_accept: true,
      },
      stage_safety: {
        backlog: { step_action: 'planned', claims_work: false },
        plan: { step_action: 'doing', claims_work: true },
        do: { step_action: 'ready', claims_work: false },
        review: { step_action: 'review_chat_or_continue_work_or_blocked', claims_work: false },
      },
      lanes: {
        'needs-agent': {
          selected_next_action: 'review_chat',
          step_action: 'review_chat',
          claims_work: false,
          safe_for_agent: true,
        },
        'continue-work': {
          selected_next_action: 'continue_work',
          step_action: 'continue_work',
          claims_work: false,
          safe_for_agent: true,
          creates_or_reuses_follow_up: true,
        },
        'proof-boundary-blocked': {
          selected_next_action: PROOF_BOUNDARY_BLOCKED_ACTION,
          step_action: null,
          claims_work: false,
          safe_for_agent: false,
          reason: PROOF_BOUNDARY_BLOCKED_REASON,
        },
        'human-accept-waiting': {
          selected_next_action: 'human_accept_waiting',
          step_action: null,
          claims_work: false,
          safe_for_agent: false,
          reason: 'agent_certified_waiting_human',
        },
        certified: {
          selected_next_action: ['continue_work', PROOF_BOUNDARY_BLOCKED_ACTION, 'human_accept_waiting'],
          step_action: 'depends_on_selected_next_action',
          claims_work: false,
          safe_for_agent: 'depends_on_selected_next_action',
        },
      },
    },
  };
}

function taskCapabilitiesContract() {
  return taskQueueCapabilities();
}

function stableCapabilityJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableCapabilityJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableCapabilityJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function capabilityValuesEqual(left, right) {
  return stableCapabilityJson(left) === stableCapabilityJson(right);
}

function capabilityCheck(name, ok, detail = null) {
  return {
    name,
    ok: Boolean(ok),
    ...(detail ? { detail } : {}),
  };
}

function reviewLaneDrainBehaviorConformance() {
  const needsAgent = {
    id: 'needs-agent-id',
    ref: 'OBL-NEEDS',
    title: 'Needs agent review',
    status: 'review',
    next_action: 'review_chat',
    command: 'atris task review-chat OBL-NEEDS --as codex-review',
    api: { method: 'POST', path: '/api/tasks/needs-agent-id/review-chat' },
  };
  const continueWork = {
    id: 'continue-work-id',
    ref: 'OBL-CONTINUE',
    title: 'Continue certified work',
    status: 'review',
    next_action: 'continue_work',
    command: 'atris task continue-work OBL-CONTINUE --as codex --json',
    api: { method: 'POST', path: '/api/tasks/continue-work-id/continue-work' },
  };
  const proofBoundaryBlocked = {
    id: 'proof-boundary-id',
    ref: 'OBL-BOUNDARY',
    title: 'Stale PR proof boundary',
    status: 'review',
    next_action: PROOF_BOUNDARY_BLOCKED_ACTION,
    command: 'atris task revise OBL-BOUNDARY --note "<replace stale PR proof>"',
    revise_command: 'atris task revise OBL-BOUNDARY --note "<replace stale PR proof>"',
    api: null,
  };
  const humanAcceptWaiting = {
    id: 'human-accept-id',
    ref: 'OBL-HUMAN',
    title: 'Human accept only',
    status: 'review',
    next_action: 'human_accept_waiting',
    command: 'atris task accept OBL-HUMAN',
    api: { method: 'POST', path: '/api/tasks/human-accept-id/accept' },
  };
  const capabilityOk = { ok: true };
  const withAll = taskReviewLaneDrainSelection({
    needs_agent: needsAgent,
    continue_work: continueWork,
    human_accept_waiting: humanAcceptWaiting,
  }, capabilityOk);
  const continueOnly = taskReviewLaneDrainSelection({
    continue_work: continueWork,
    human_accept_waiting: humanAcceptWaiting,
  }, capabilityOk);
  const humanOnly = taskReviewLaneDrainSelection({
    human_accept_waiting: humanAcceptWaiting,
  }, capabilityOk);
  const proofBoundaryOnly = taskReviewLaneDrainSelection({
    proof_boundary_blocked: proofBoundaryBlocked,
    human_accept_waiting: humanAcceptWaiting,
  }, capabilityOk);
  const drift = taskReviewLaneDrainSelection({
    needs_agent: needsAgent,
    continue_work: continueWork,
    proof_boundary_blocked: proofBoundaryBlocked,
    human_accept_waiting: humanAcceptWaiting,
  }, { ok: false });
  const followedContinueWork = taskHasReviewFollowUpChild({
    ...continueWork,
    review: { next_task: 'Add child follow-up' },
    lineage: { child_task_ids: ['child-task-id'], child_titles: ['Add child follow-up'] },
  });
  const retitledContinueWork = taskHasReviewFollowUpChild({
    ...continueWork,
    review: { next_task: 'Add newer follow-up wording' },
    lineage: { child_task_ids: ['child-task-id'], child_titles: ['Add child follow-up'] },
  });
  const freshContinueWork = !taskHasReviewFollowUpChild({
    ...continueWork,
    review: { next_task: 'Add child follow-up' },
    lineage: { child_task_ids: [], child_titles: [] },
  });
  const checks = {
    prefers_review_chat: withAll.next_action === 'review_chat'
      && withAll.review_state === 'needs-agent'
      && withAll.command === needsAgent.command
      && capabilityValuesEqual(withAll.api, needsAgent.api),
    uses_continue_work_from_review_state_actions: continueOnly.next_action === 'continue_work'
      && continueOnly.review_state === 'continue-work'
      && continueOnly.command === continueWork.command
      && capabilityValuesEqual(continueOnly.api, continueWork.api),
    selected_human_accept_waiting_is_non_executable: humanOnly.next_action === 'human_accept_waiting'
      && humanOnly.safe_for_agent === false
      && humanOnly.command === null
      && humanOnly.api === null
      && humanOnly.human_accept_waiting
      && humanOnly.human_accept_waiting.command === null
      && humanOnly.human_accept_waiting.api === null,
    selected_proof_boundary_is_non_executable: proofBoundaryOnly.next_action === PROOF_BOUNDARY_BLOCKED_ACTION
      && proofBoundaryOnly.review_state === 'proof-boundary-blocked'
      && proofBoundaryOnly.safe_for_agent === false
      && proofBoundaryOnly.command === null
      && proofBoundaryOnly.api === null
      && proofBoundaryOnly.proof_boundary_blocked
      && proofBoundaryOnly.proof_boundary_blocked.revise_command === proofBoundaryBlocked.revise_command,
    capability_drift_blocks_execution: drift.next_action === 'capabilities_drift'
      && drift.safe_for_agent === false
      && drift.command === null
      && drift.api === null,
    skips_continue_work_with_existing_follow_up_child: followedContinueWork && retitledContinueWork && freshContinueWork,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

function taskReviewLaneActDecision(drain = {}) {
  const nextAction = drain && drain.next_action;
  if (nextAction === 'pending_review_chat') {
    // The posted review chat is answerable by the lane itself, but only with
    // disk-backed evidence: the act step re-checks receipts before any pass.
    if (!drain.task || !drain.task.id) {
      return {
        ok: false,
        step_action: nextAction,
        reason: drain && drain.reason || PENDING_REVIEW_CHAT_STOP_REASON,
      };
    }
    return {
      ok: true,
      step_action: 'auto_review',
      task_id: drain.task.id,
      command: null,
      api: null,
    };
  }
  if (nextAction !== 'review_chat' && nextAction !== 'continue_work') {
    return {
      ok: false,
      step_action: nextAction || 'none',
      reason: drain && drain.reason || 'unsafe_review_lane_action',
    };
  }
  if (!drain.safe_for_agent || !drain.command || !drain.task || !drain.task.id) {
    return {
      ok: false,
      step_action: nextAction,
      reason: 'unsafe_review_lane_action',
    };
  }
  return {
    ok: true,
    step_action: nextAction,
    task_id: drain.task.id,
    command: drain.command,
    api: drain.api || null,
  };
}

function reviewLaneActBehaviorConformance() {
  const reviewChat = taskReviewLaneActDecision({
    next_action: 'review_chat',
    safe_for_agent: true,
    command: 'atris task review-chat OBL-NEEDS --as codex-review',
    api: { method: 'POST', path: '/api/tasks/needs-agent-id/review-chat' },
    task: { id: 'needs-agent-id' },
  });
  const continueWork = taskReviewLaneActDecision({
    next_action: 'continue_work',
    safe_for_agent: true,
    command: 'atris task continue-work OBL-CONTINUE --as codex --json',
    api: { method: 'POST', path: '/api/tasks/continue-work-id/continue-work' },
    task: { id: 'continue-work-id' },
  });
  const humanAccept = taskReviewLaneActDecision({
    next_action: 'human_accept_waiting',
    safe_for_agent: true,
    command: 'atris task accept OBL-HUMAN',
    api: { method: 'POST', path: '/api/tasks/human-accept-id/accept' },
    task: { id: 'human-accept-id' },
  });
  const drift = taskReviewLaneActDecision({
    next_action: 'capabilities_drift',
    safe_for_agent: false,
    command: null,
    api: null,
    task: null,
    reason: 'capability_conformance_failed',
  });
  const proofBoundary = taskReviewLaneActDecision({
    next_action: PROOF_BOUNDARY_BLOCKED_ACTION,
    safe_for_agent: false,
    command: null,
    api: null,
    task: { id: 'proof-boundary-id' },
    reason: PROOF_BOUNDARY_BLOCKED_REASON,
  });
  const pendingReviewChat = taskReviewLaneActDecision({
    next_action: 'pending_review_chat',
    safe_for_agent: false,
    command: null,
    api: null,
    task: { id: 'pending-review-chat-id' },
    reason: PENDING_REVIEW_CHAT_STOP_REASON,
  });
  const pendingReviewChatNoTask = taskReviewLaneActDecision({
    next_action: 'pending_review_chat',
    safe_for_agent: false,
    command: null,
    api: null,
    task: null,
    reason: PENDING_REVIEW_CHAT_STOP_REASON,
  });
  const checks = {
    allows_review_chat: reviewChat.ok === true && reviewChat.step_action === 'review_chat',
    allows_continue_work: continueWork.ok === true && continueWork.step_action === 'continue_work',
    allows_evidence_gated_auto_review: pendingReviewChat.ok === true
      && pendingReviewChat.step_action === 'auto_review'
      && pendingReviewChat.command === null,
    blocks_auto_review_without_task: pendingReviewChatNoTask.ok === false
      && pendingReviewChatNoTask.reason === PENDING_REVIEW_CHAT_STOP_REASON,
    blocks_human_accept_waiting_even_if_marked_safe: humanAccept.ok === false && humanAccept.reason !== null,
    blocks_proof_boundary_blocked: proofBoundary.ok === false && proofBoundary.reason === PROOF_BOUNDARY_BLOCKED_REASON,
    blocks_capability_drift: drift.ok === false && drift.reason === 'capability_conformance_failed',
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

function reviewLaneLoopBehaviorConformance() {
  const dryRun = taskReviewLaneLoopStopIsSafe('dry_run_preview');
  const humanOnly = taskReviewLaneLoopStopIsSafe('human_accept_waiting_is_human_only');
  const proofBoundary = taskReviewLaneLoopStopIsSafe(PROOF_BOUNDARY_BLOCKED_REASON);
  const pendingReviewChat = taskReviewLaneLoopStopIsSafe(PENDING_REVIEW_CHAT_STOP_REASON);
  const autoReviewNoEvidence = taskReviewLaneLoopStopIsSafe(AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON);
  const noAction = taskReviewLaneLoopStopIsSafe('no_review_lane_action');
  const repeated = taskReviewLaneLoopStopIsSafe('repeat_selection');
  const drift = taskReviewLaneLoopStopIsSafe('capabilities_check_failed');
  const maxSteps = normalizeReviewLaneLoopMaxSteps(99) === REVIEW_LANE_LOOP_MAX_STEPS
    && normalizeReviewLaneLoopMaxSteps(0) === 1
    && normalizeReviewLaneLoopMaxSteps(undefined) === REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS;
  const checks = {
    dry_run_stops_without_mutation: dryRun.ok === true && dryRun.read_only === true,
    human_accept_waiting_stops_without_execution: humanOnly.ok === true && humanOnly.human_accept === false,
    proof_boundary_blocked_stops_without_execution: proofBoundary.ok === true && proofBoundary.human_accept === false,
    pending_review_chat_stops_without_execution: pendingReviewChat.ok === true && pendingReviewChat.human_accept === false,
    auto_review_without_evidence_stops_without_certification: autoReviewNoEvidence.ok === true && autoReviewNoEvidence.human_accept === false,
    no_action_stops_without_execution: noAction.ok === true,
    repeat_selection_stops_before_duplicate_execution: repeated.ok === true,
    capability_drift_blocks_loop: drift.ok === false,
    max_steps_are_bounded: maxSteps,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

function reviewLaneRunBehaviorConformance() {
  const dryRun = taskReviewLaneRunStopIsSafe('dry_run_preview');
  const humanOnly = taskReviewLaneRunStopIsSafe('human_accept_waiting_is_human_only');
  const proofBoundary = taskReviewLaneRunStopIsSafe(PROOF_BOUNDARY_BLOCKED_REASON);
  const pendingReviewChat = taskReviewLaneRunStopIsSafe(PENDING_REVIEW_CHAT_STOP_REASON);
  const autoReviewNoEvidence = taskReviewLaneRunStopIsSafe(AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON);
  const noAction = taskReviewLaneRunStopIsSafe('no_review_lane_action');
  const reusedFollowUp = taskReviewLaneRunStopIsSafe('continue_work_reused_existing_follow_up');
  const repeated = taskReviewLaneRunStopIsSafe('repeat_selection');
  const drift = taskReviewLaneRunStopIsSafe('capabilities_check_failed');
  const maxRuns = taskReviewLaneRunStopIsSafe('max_runs_reached');
  const boundedRuns = normalizeReviewLaneRunMaxRuns(99) === REVIEW_LANE_RUN_MAX_RUNS
    && normalizeReviewLaneRunMaxRuns(0) === 1
    && normalizeReviewLaneRunMaxRuns(undefined) === REVIEW_LANE_RUN_DEFAULT_MAX_RUNS;
  const checks = {
    dry_run_stops_without_receipt: dryRun.ok === true && dryRun.write_receipt === false,
    human_accept_waiting_stops_without_execution: humanOnly.ok === true && humanOnly.human_accept === false,
    proof_boundary_blocked_stops_without_execution: proofBoundary.ok === true && proofBoundary.human_accept === false,
    pending_review_chat_stops_without_execution: pendingReviewChat.ok === true && pendingReviewChat.human_accept === false,
    auto_review_without_evidence_stops_without_certification: autoReviewNoEvidence.ok === true && autoReviewNoEvidence.human_accept === false,
    no_action_stops_without_execution: noAction.ok === true,
    reused_follow_up_stops_without_duplicate_action: reusedFollowUp.ok === true,
    repeat_selection_stops_before_duplicate_execution: repeated.ok === true,
    capability_drift_blocks_run: drift.ok === false,
    max_runs_are_bounded: maxRuns.ok === true && boundedRuns,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

function taskCapabilitiesCheckReport(taskDb, db, args = [], options = {}) {
  const owner = options.owner || flag(args, '--as') || flag(args, '--owner') || DEFAULT_OWNER;
  const reviewer = reviewActor(options.reviewer || flag(args, '--reviewer') || flag(args, '--as-reviewer') || 'codex-review');
  const all = options.all !== undefined ? Boolean(options.all) : hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args, options);
  const limit = options.limit !== undefined ? options.limit : taskQueueLimit(args);
  const scope = normalizeTaskQueueScope(options.scope || taskQueueScopeFromArgs(args));
  const standalone = taskCapabilitiesContract();
  const { outPath, current } = buildTaskCurrent(taskDb, db, [], {
    owner,
    reviewer,
    all,
    everywhere,
    limit,
    scope,
  });
  const acceptedLanes = standalone.filters.review_state.accepted || [];
  const currentStepLanes = standalone.current_step.lanes || {};
  const currentStepIdentityFields = standalone.current_step.output_fields?.identity || [];
  const currentIdentityFields = standalone.surfaces.current.output_fields?.identity || [];
  const queueIdentityFields = standalone.surfaces.queue.output_fields?.identity || [];
  const reviewLaneDrainIdentityFields = standalone.surfaces.review_lane_drain.output_fields?.identity || [];
  const reviewLaneActIdentityFields = standalone.surfaces.review_lane_act.output_fields?.identity || [];
  const drainBehavior = reviewLaneDrainBehaviorConformance();
  const actBehavior = reviewLaneActBehaviorConformance();
  const loopBehavior = reviewLaneLoopBehaviorConformance();
  const runBehavior = reviewLaneRunBehaviorConformance();
  const checks = [
    capabilityCheck('current_capabilities_match_standalone', capabilityValuesEqual(current.capabilities, standalone)),
    capabilityCheck('queue_capabilities_match_standalone', capabilityValuesEqual(current.queue.capabilities, standalone)),
    capabilityCheck('current_queue_capabilities_match', capabilityValuesEqual(current.capabilities, current.queue.capabilities)),
    capabilityCheck(
      'review_state_lanes_cover_current_step_lanes',
      acceptedLanes.every(lane => Object.prototype.hasOwnProperty.call(currentStepLanes, lane)),
      { accepted: acceptedLanes, current_step_lanes: Object.keys(currentStepLanes) }
    ),
    capabilityCheck(
      'current_step_declares_mutating_conditional_claims',
      standalone.current_step.safety.read_only === false
        && standalone.current_step.safety.claims_work === 'conditional'
        && Array.isArray(standalone.current_step.safety.claiming_stages)
        && standalone.current_step.safety.claiming_stages.includes('plan')
    ),
    capabilityCheck(
      'current_step_never_human_accepts',
      standalone.current_step.safety.human_accept === false
        && standalone.current_step.safety.xp_after_human_accept === true
        && standalone.current_step.lanes['human-accept-waiting']
        && standalone.current_step.lanes['human-accept-waiting'].safe_for_agent === false
    ),
    capabilityCheck(
      'current_step_declares_identity_output_fields',
      ['selected_task_id', 'selected_ref', 'selected_next_key'].every(field => currentStepIdentityFields.includes(field)),
      { identity: currentStepIdentityFields }
    ),
    capabilityCheck(
      'current_and_queue_declare_identity_output_fields',
      ['selected_task_id', 'selected_ref', 'selected_next_key'].every(field => currentIdentityFields.includes(field) && queueIdentityFields.includes(field)),
      { current: currentIdentityFields, queue: queueIdentityFields }
    ),
    capabilityCheck(
      'review_lane_drain_declares_identity_output_fields',
      ['selected_task_id', 'selected_ref', 'selected_next_key'].every(field => reviewLaneDrainIdentityFields.includes(field)),
      { identity: reviewLaneDrainIdentityFields }
    ),
    capabilityCheck(
      'review_lane_act_declares_identity_output_fields',
      ['selected_task_id', 'selected_ref', 'selected_next_key'].every(field => reviewLaneActIdentityFields.includes(field)),
      { identity: reviewLaneActIdentityFields }
    ),
    capabilityCheck(
      'read_only_projection_semantics_declared',
      standalone.surfaces.capabilities.mutates_task_db === false
        && standalone.surfaces.capabilities.writes_projection === false
        && standalone.surfaces.capabilities_check.mutates_task_db === false
        && standalone.surfaces.capabilities_check.writes_projection === true
        && standalone.surfaces.review_lane_drain.mutates_task_db === false
        && standalone.surfaces.review_lane_drain.writes_projection === true
        && standalone.surfaces.review_lane_act.mutates_task_db === 'conditional'
        && standalone.surfaces.review_lane_act.writes_projection === true
        && standalone.surfaces.review_lane_loop.mutates_task_db === 'conditional'
        && standalone.surfaces.review_lane_loop.writes_projection === true
        && standalone.surfaces.review_lane_run.mutates_task_db === 'conditional'
        && standalone.surfaces.review_lane_run.writes_projection === true
        && standalone.surfaces.review_lane_run.writes_receipt === true
        && standalone.surfaces.current.mutates_task_db === false
        && standalone.surfaces.current.writes_projection === true
        && standalone.surfaces.queue.mutates_task_db === false
        && standalone.surfaces.queue.writes_projection === true
    ),
    capabilityCheck(
      'capabilities_check_surface_declared',
      standalone.commands.capabilities_check === 'atris task capabilities-check --json'
        && standalone.surfaces.capabilities_check.command === 'atris task capabilities-check --json'
        && standalone.surfaces.capabilities_check.api.path === '/api/tasks/capabilities/check'
        && standalone.surfaces.capabilities_check.requires_task_db === true
    ),
    capabilityCheck(
      'review_lane_drain_surface_declared',
      standalone.commands.review_lane_drain === 'atris task review-lane-drain --json'
        && standalone.surfaces.review_lane_drain.command === 'atris task review-lane-drain --json'
        && standalone.surfaces.review_lane_drain.api.path === '/api/tasks/review-lane-drain'
        && standalone.surfaces.review_lane_drain.requires_task_db === true
        && standalone.surfaces.review_lane_drain.skips_existing_follow_up_children === true
    ),
    capabilityCheck(
      'review_lane_drain_behavior_conforms',
      drainBehavior.ok,
      drainBehavior.checks
    ),
    capabilityCheck(
      'review_lane_act_surface_declared',
      standalone.commands.review_lane_act === 'atris task review-lane-act --json'
        && standalone.surfaces.review_lane_act.command === 'atris task review-lane-act --json'
        && standalone.surfaces.review_lane_act.api.method === 'POST'
        && standalone.surfaces.review_lane_act.api.path === '/api/tasks/review-lane-act'
        && standalone.surfaces.review_lane_act.requires_task_db === true
        && standalone.surfaces.review_lane_act.allowed_actions.includes('review_chat')
        && standalone.surfaces.review_lane_act.allowed_actions.includes('continue_work')
        && standalone.surfaces.review_lane_act.blocked_actions.includes('human_accept_waiting')
    ),
    capabilityCheck(
      'review_lane_act_behavior_conforms',
      actBehavior.ok,
      actBehavior.checks
    ),
    capabilityCheck(
      'review_lane_loop_surface_declared',
      standalone.commands.review_lane_loop === 'atris task review-lane-loop --json'
        && standalone.surfaces.review_lane_loop.command === 'atris task review-lane-loop --json'
        && standalone.surfaces.review_lane_loop.api.method === 'POST'
        && standalone.surfaces.review_lane_loop.api.path === '/api/tasks/review-lane-loop'
        && standalone.surfaces.review_lane_loop.requires_task_db === true
        && standalone.surfaces.review_lane_loop.default_max_steps === REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS
        && standalone.surfaces.review_lane_loop.max_steps_cap === REVIEW_LANE_LOOP_MAX_STEPS
        && standalone.surfaces.review_lane_loop.orchestrates === 'review_lane_act'
        && standalone.surfaces.review_lane_loop.allowed_actions.includes('review_chat')
        && standalone.surfaces.review_lane_loop.allowed_actions.includes('continue_work')
        && standalone.surfaces.review_lane_loop.stopped_by.includes(PROOF_BOUNDARY_BLOCKED_REASON)
        && standalone.surfaces.review_lane_loop.stopped_by.includes('human_accept_waiting_is_human_only')
        && standalone.surfaces.review_lane_loop.stopped_by.includes(PENDING_REVIEW_CHAT_STOP_REASON)
        && standalone.surfaces.review_lane_loop.stopped_by.includes('capabilities_check_failed')
        && standalone.surfaces.review_lane_loop.stopped_by.includes('repeat_selection')
    ),
    capabilityCheck(
      'review_lane_loop_behavior_conforms',
      loopBehavior.ok,
      loopBehavior.checks
    ),
    capabilityCheck(
      'review_lane_run_surface_declared',
      standalone.commands.review_lane_run === 'atris task review-lane-run --json'
        && standalone.surfaces.review_lane_run.command === 'atris task review-lane-run --json'
        && standalone.surfaces.review_lane_run.api.method === 'POST'
        && standalone.surfaces.review_lane_run.api.path === '/api/tasks/review-lane-run'
        && standalone.surfaces.review_lane_run.requires_task_db === true
        && standalone.surfaces.review_lane_run.default_max_runs === REVIEW_LANE_RUN_DEFAULT_MAX_RUNS
        && standalone.surfaces.review_lane_run.max_runs_cap === REVIEW_LANE_RUN_MAX_RUNS
        && standalone.surfaces.review_lane_run.default_max_steps === REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS
        && standalone.surfaces.review_lane_run.max_steps_cap === REVIEW_LANE_LOOP_MAX_STEPS
        && standalone.surfaces.review_lane_run.orchestrates === 'review_lane_loop'
        && standalone.surfaces.review_lane_run.writes_receipt === true
        && standalone.surfaces.review_lane_run.receipt_path === '.atris/state/review-lane-runs.jsonl'
        && standalone.surfaces.review_lane_run.latest_receipt_path === '.atris/state/review-lane-run.latest.json'
        && standalone.surfaces.review_lane_run.stopped_by.includes(PROOF_BOUNDARY_BLOCKED_REASON)
        && standalone.surfaces.review_lane_run.stopped_by.includes('human_accept_waiting_is_human_only')
        && standalone.surfaces.review_lane_run.stopped_by.includes(PENDING_REVIEW_CHAT_STOP_REASON)
        && standalone.surfaces.review_lane_run.stopped_by.includes('capabilities_check_failed')
        && standalone.surfaces.review_lane_run.stopped_by.includes('continue_work_reused_existing_follow_up')
        && standalone.surfaces.review_lane_run.stopped_by.includes('max_runs_reached')
    ),
    capabilityCheck(
      'review_lane_run_behavior_conforms',
      runBehavior.ok,
      runBehavior.checks
    ),
  ];
  const failed = checks.filter(check => !check.ok);
  return {
    schema: 'atris.task_capabilities_check.v1',
    generated_at: new Date().toISOString(),
    ok: failed.length === 0,
    action: 'capabilities_check',
    projection_path: outPath,
    scope: current.scope,
    owner: String(owner || DEFAULT_OWNER),
    reviewer,
    capabilities: standalone,
    checks,
    summary: {
      total: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
    },
    safety: {
      mutates_task_db: false,
      writes_projection: true,
      human_accept: false,
      xp_after_human_accept: true,
    },
  };
}

function formatTaskQueueScope(scope = {}) {
  const normalized = normalizeTaskQueueScope(scope);
  return Object.entries(normalized)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function noOpenTasksMessage(scope = {}) {
  const scopeText = formatTaskQueueScope(scope);
  return scopeText ? `No open tasks for ${scopeText}.` : 'No open tasks.';
}

function taskQueueContract(projection, { reviewer = 'codex-review', limit = 8, scope = {}, hasExistingReviewFollowUp = null, hasPendingReviewChat = null, excludeTaskIds = null } = {}) {
  const normalizedScope = normalizeTaskQueueScope(scope);
  const tasks = filterTasksByScope(sortTasksNewestFirst(projection.tasks || []), normalizedScope, { hasExistingReviewFollowUp });
  const reviewStateCounts = taskQueueReviewStateCounts(projection, normalizedScope, { hasExistingReviewFollowUp });
  const reviewStateActions = taskQueueReviewStateActions(projection, normalizedScope, { reviewer, hasExistingReviewFollowUp, hasPendingReviewChat, excludeTaskIds });
  const grouped = new Map(TASK_QUEUE_COLUMN_ORDER.map(key => [key, []]));
  for (const task of tasks) {
    const key = taskQueueColumnKey(task);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(task);
  }
  const columns = TASK_QUEUE_COLUMN_ORDER.map(key => {
    const columnTasks = grouped.get(key) || [];
    const shown = Number.isFinite(limit) ? columnTasks.slice(0, limit) : columnTasks;
    return {
      key,
      label: TASK_QUEUE_COLUMN_LABELS[key] || key,
      count: columnTasks.length,
      items: shown.map(task => taskQueueItem(task, { reviewer, hasExistingReviewFollowUp })),
    };
  });
  const counts = {};
  for (const column of columns) counts[column.key] = column.count;
  counts.active = counts.plan + counts.do + counts.review + counts.blocked;
  counts.total = tasks.length;
  return {
    schema: 'atris.task_queue.v1',
    generated_at: projection.generated_at,
    workspace_root: projection.workspace_root,
    scope: normalizedScope,
    columns,
    counts,
    review_state_counts: reviewStateCounts,
    review_state_actions: reviewStateActions,
    capabilities: taskQueueCapabilities(),
  };
}

function selectTaskForCurrent(projection, { owner = DEFAULT_OWNER, scope = {}, hasExistingReviewFollowUp = null } = {}) {
  const normalizedScope = normalizeTaskQueueScope(scope);
  const tasks = filterTasksByScope(sortTasksNewestFirst(projection.tasks || []), normalizedScope, { hasExistingReviewFollowUp });
  const columns = {
    backlog: [],
    plan: [],
    do: [],
    review: [],
    blocked: [],
    done: [],
  };
  for (const task of tasks) {
    const key = taskQueueColumnKey(task);
    if (!columns[key]) columns[key] = [];
    columns[key].push(task);
  }
  const actor = String(owner || DEFAULT_OWNER);
  const claimedByOwner = columns.do.find(task => task.claimed_by === actor);
  if (claimedByOwner) return { task: claimedByOwner, reason: 'claimed_by_owner' };
  const reviewNeedsAgent = columns.review.find(task => reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp })?.next_action === 'agent_review_again');
  if (reviewNeedsAgent) return { task: reviewNeedsAgent, reason: 'review_needs_agent_verification' };
  const reviewProofBoundaryBlocked = columns.review.find(task => reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp })?.next_action === PROOF_BOUNDARY_BLOCKED_ACTION);
  if (reviewProofBoundaryBlocked) return { task: reviewProofBoundaryBlocked, reason: 'review_proof_boundary_blocked' };
  // Scoped selection (goal_id, tag, status, or review_state) implies a sequenced
  // work stream (e.g. golden-path "pass 1a" before "pass 2"): earlier-created
  // tasks must win over newer ones, not the newest-first default used for the
  // unscoped desk view.
  const planQueue = !taskQueueScopeIsEmpty(normalizedScope) ? sortTasksOldestFirst(columns.plan) : columns.plan;
  const planReady = planQueue[0];
  if (planReady) return { task: planReady, reason: 'plan_ready' };
  const backlogIdea = columns.backlog[0];
  if (backlogIdea) return { task: backlogIdea, reason: 'backlog_idea' };
  const activeOther = columns.do[0];
  if (activeOther) return { task: activeOther, reason: 'active_do_elsewhere' };
  const blocked = columns.blocked[0];
  if (blocked) return { task: blocked, reason: 'blocked_task' };
  const certifiedReview = columns.review.find(task => {
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    return handoff?.next_action === 'continue_work' || handoff?.next_action === 'human_accept_waiting';
  });
  if (certifiedReview) return { task: certifiedReview, reason: 'review_certified_waiting_human' };
  const done = columns.done[0];
  if (done) return { task: done, reason: 'done_reference' };
  return { task: null, reason: 'none' };
}

function taskCurrentContract(projection, { owner = DEFAULT_OWNER, reviewer = 'codex-review', limit = 8, scope = {}, hasExistingReviewFollowUp = null, hasPendingReviewChat = null, excludeTaskIds = null } = {}) {
  const normalizedScope = normalizeTaskQueueScope(scope);
  const queue = taskQueueContract(projection, { reviewer, limit, scope: normalizedScope, hasExistingReviewFollowUp, hasPendingReviewChat, excludeTaskIds });
  const selection = selectTaskForCurrent(projection, { owner, scope: normalizedScope, hasExistingReviewFollowUp });
  const page = selection.task ? taskPageContract(selection.task, { reviewer, hasExistingReviewFollowUp }) : null;
  const selected = selection.task ? taskQueueItem(selection.task, { reviewer, hasExistingReviewFollowUp }) : null;
  return {
    schema: 'atris.task_current.v1',
    generated_at: projection.generated_at,
    workspace_root: projection.workspace_root,
    owner: String(owner || DEFAULT_OWNER),
    reviewer: reviewActor(reviewer || 'codex-review'),
    scope: normalizedScope,
    selected_reason: selection.reason,
    selected_task_id: selection.task ? selection.task.id : null,
    selected_ref: selection.task ? taskRef(selection.task) : null,
    selected_next_key: page ? page.stage.next_action.key : null,
    selected,
    page,
    next: page ? {
      key: page.stage.next_action.key,
      label: page.stage.next_action.label,
      command: page.stage.next_action.command || null,
      api: page.stage.next_action.api || null,
      reason: page.stage.next_action.reason || null,
      revise_command: page.stage.next_action.revise_command || null,
      human_accept_command: page.stage.next_action.human_accept_command || null,
      step_command: page.actions.step_command,
      step_api: page.api.step,
    } : null,
    review_state_counts: queue.review_state_counts,
    review_state_actions: queue.review_state_actions,
    capabilities: queue.capabilities,
    queue,
    safety: {
      read_only: true,
      claims_work: false,
      human_accept: false,
      xp_after_human_accept: true,
    },
  };
}

function buildTaskCurrent(taskDb, db, args = [], options = {}) {
  const owner = options.owner || flag(args, '--as') || flag(args, '--owner') || DEFAULT_OWNER;
  const reviewer = reviewActor(options.reviewer || flag(args, '--reviewer') || flag(args, '--as-reviewer') || 'codex-review');
  const all = options.all !== undefined ? Boolean(options.all) : hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args, options);
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args, { everywhere });
  const limit = options.limit !== undefined ? options.limit : taskQueueLimit(args);
  const scope = normalizeTaskQueueScope(options.scope || taskQueueScopeFromArgs(args));
  const { projection, outPath } = writeDefaultProjection(taskDb, db, { all, everywhere });
  const hasExistingReviewFollowUp = buildReviewFollowUpChildPredicate(
    taskDb,
    db,
    workspaceRoot,
  );
  const hasPendingReviewChat = buildPendingReviewChatPredicate(
    taskDb,
    db,
    workspaceRoot,
  );
  return {
    projection,
    outPath,
    current: taskCurrentContract(projection, { owner, reviewer, limit, scope, hasExistingReviewFollowUp, hasPendingReviewChat, excludeTaskIds: options.excludeTaskIds }),
  };
}

function printTaskCurrent(current) {
  if (!current.page) {
    console.log('TASK CURRENT');
    console.log('No task selected.');
    return;
  }
  console.log('TASK CURRENT');
  const scopeText = formatTaskQueueScope(current.scope);
  if (scopeText) console.log(`Scope: ${scopeText}`);
  console.log(`${current.page.task.ref} ${current.selected_reason}`);
  console.log(current.page.task.title);
  console.log(`Stage: ${current.page.stage.current}`);
  console.log(`Next: ${current.next.command || current.next.label}`);
  console.log(`Step: ${current.next.step_command}`);
}

function printTaskQueue(queue, current = null) {
  console.log('TASK QUEUE');
  const scopeText = formatTaskQueueScope(queue.scope);
  if (scopeText) console.log(`Scope: ${scopeText}`);
  if (current && current.page) console.log(`current ${current.page.task.ref} ${current.page.stage.current}`);
  for (const column of queue.columns) {
    console.log(`${column.label}: ${column.count}`);
    for (const item of column.items.slice(0, 5)) {
      console.log(`  ${taskRef(item)} ${item.title}`);
    }
  }
}

function cmdCurrent(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { outPath, current } = buildTaskCurrent(taskDb, db, args);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'current',
      projection_path: outPath,
      selected_task_id: current.selected_task_id,
      selected_ref: current.selected_ref,
      selected_next_key: current.selected_next_key,
      current,
      selected: current.selected,
      page: current.page,
      queue: current.queue,
    });
    return;
  }
  printTaskCurrent(current);
}

function cmdQueue(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { outPath, current } = buildTaskCurrent(taskDb, db, args);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'queue',
      projection_path: outPath,
      selected_task_id: current.selected_task_id,
      selected_ref: current.selected_ref,
      selected_next_key: current.selected_next_key,
      current,
      selected: current.selected,
      page: current.page,
      queue: current.queue,
    });
    return;
  }
  printTaskQueue(current.queue, current);
}

function cmdCapabilities(args) {
  const capabilities = taskCapabilitiesContract();
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'capabilities',
      capabilities,
      safety: {
        read_only: true,
        claims_work: false,
        human_accept: false,
        xp_after_human_accept: true,
      },
    });
    return;
  }
  console.log(capabilities.schema);
  console.log(`current: ${capabilities.commands.current}`);
  console.log(`queue: ${capabilities.commands.queue}`);
  console.log(`current-step: ${capabilities.commands.current_step}`);
  console.log(`review-state lanes: ${capabilities.filters.review_state.accepted.join(', ')}`);
}

function cmdCapabilitiesCheck(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const report = taskCapabilitiesCheckReport(taskDb, db, args);
  if (wantsJson(args)) {
    printJson(report);
    if (!report.ok) process.exit(1);
    return;
  }
  console.log(`TASK CAPABILITIES CHECK ${report.ok ? 'ok' : 'failed'}`);
  for (const check of report.checks) {
    console.log(`${check.ok ? 'ok' : 'fail'} ${check.name}`);
  }
  if (!report.ok) process.exit(1);
}

function taskReviewLaneDrainTask(action) {
  if (!action) return null;
  return {
    id: action.id,
    ref: action.ref,
    title: action.title,
    status: action.status,
    next_action: action.next_action,
  };
}

function humanAcceptWaitingDrain(action) {
  if (!action) return null;
  return {
    task: taskReviewLaneDrainTask(action),
    safe_for_agent: false,
    command: null,
    api: null,
    reason: 'human_accept_waiting_is_human_only',
  };
}

function proofBoundaryBlockedDrain(action) {
  if (!action) return null;
  return {
    task: taskReviewLaneDrainTask(action),
    safe_for_agent: false,
    command: null,
    api: null,
    reason: PROOF_BOUNDARY_BLOCKED_REASON,
    revise_command: action.revise_command || action.command || null,
  };
}

function pendingReviewChatDrain(action) {
  if (!action) return null;
  return {
    task: taskReviewLaneDrainTask(action),
    safe_for_agent: false,
    command: null,
    api: null,
    reason: PENDING_REVIEW_CHAT_STOP_REASON,
  };
}

function taskReviewLaneDrainSelection(actions = {}, capabilitiesCheck = {}) {
  if (!capabilitiesCheck.ok) {
    return {
      key: 'capabilities_drift',
      next_action: 'capabilities_drift',
      review_state: null,
      safe_for_agent: false,
      command: null,
      api: null,
      task: null,
      reason: 'capability_conformance_failed',
      proof_boundary_blocked: proofBoundaryBlockedDrain(actions.proof_boundary_blocked),
      human_accept_waiting: humanAcceptWaitingDrain(actions.human_accept_waiting),
    };
  }
  if (actions.needs_agent) {
    return {
      key: 'review_chat',
      next_action: 'review_chat',
      review_state: 'needs-agent',
      safe_for_agent: true,
      command: actions.needs_agent.command || null,
      api: actions.needs_agent.api || null,
      task: taskReviewLaneDrainTask(actions.needs_agent),
      reason: 'needs_agent_review',
      proof_boundary_blocked: proofBoundaryBlockedDrain(actions.proof_boundary_blocked),
      human_accept_waiting: humanAcceptWaitingDrain(actions.human_accept_waiting),
    };
  }
  if (actions.continue_work) {
    return {
      key: 'continue_work',
      next_action: 'continue_work',
      review_state: 'continue-work',
      safe_for_agent: true,
      command: actions.continue_work.command || null,
      api: actions.continue_work.api || null,
      task: taskReviewLaneDrainTask(actions.continue_work),
      reason: 'certified_review_has_follow_up',
      proof_boundary_blocked: proofBoundaryBlockedDrain(actions.proof_boundary_blocked),
      human_accept_waiting: humanAcceptWaitingDrain(actions.human_accept_waiting),
    };
  }
  if (actions.proof_boundary_blocked) {
    return {
      key: PROOF_BOUNDARY_BLOCKED_ACTION,
      next_action: PROOF_BOUNDARY_BLOCKED_ACTION,
      review_state: 'proof-boundary-blocked',
      safe_for_agent: false,
      command: null,
      api: null,
      task: taskReviewLaneDrainTask(actions.proof_boundary_blocked),
      reason: PROOF_BOUNDARY_BLOCKED_REASON,
      proof_boundary_blocked: proofBoundaryBlockedDrain(actions.proof_boundary_blocked),
      human_accept_waiting: humanAcceptWaitingDrain(actions.human_accept_waiting),
    };
  }
  const pendingReviewChat = Array.isArray(actions.pending_review_chat)
    ? actions.pending_review_chat[0]
    : actions.pending_review_chat;
  if (pendingReviewChat) {
    return {
      key: 'pending_review_chat',
      next_action: 'pending_review_chat',
      review_state: 'pending-review-chat',
      safe_for_agent: false,
      command: null,
      api: null,
      task: taskReviewLaneDrainTask(pendingReviewChat),
      reason: PENDING_REVIEW_CHAT_STOP_REASON,
      proof_boundary_blocked: proofBoundaryBlockedDrain(actions.proof_boundary_blocked),
      human_accept_waiting: humanAcceptWaitingDrain(actions.human_accept_waiting),
      pending_review_chat: pendingReviewChatDrain(pendingReviewChat),
    };
  }
  if (actions.human_accept_waiting) {
    return {
      key: 'human_accept_waiting',
      next_action: 'human_accept_waiting',
      review_state: 'human-accept-waiting',
      safe_for_agent: false,
      command: null,
      api: null,
      task: taskReviewLaneDrainTask(actions.human_accept_waiting),
      reason: 'human_accept_waiting_is_human_only',
      proof_boundary_blocked: proofBoundaryBlockedDrain(actions.proof_boundary_blocked),
      human_accept_waiting: humanAcceptWaitingDrain(actions.human_accept_waiting),
    };
  }
  return {
    key: 'none',
    next_action: 'none',
    review_state: null,
    safe_for_agent: false,
    command: null,
    api: null,
    task: null,
    reason: 'no_review_lane_action',
    proof_boundary_blocked: null,
    human_accept_waiting: null,
  };
}

function taskReviewLaneDrainReport(taskDb, db, args = [], options = {}) {
  const owner = options.owner || flag(args, '--as') || flag(args, '--owner') || DEFAULT_OWNER;
  const reviewer = reviewActor(options.reviewer || flag(args, '--reviewer') || flag(args, '--as-reviewer') || 'codex-review');
  const all = options.all !== undefined ? Boolean(options.all) : hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args, options);
  const limit = options.limit !== undefined ? options.limit : taskQueueLimit(args);
  const scope = normalizeTaskQueueScope(options.scope || taskQueueScopeFromArgs(args));
  const capabilitiesCheck = taskCapabilitiesCheckReport(taskDb, db, [], {
    owner,
    reviewer,
    all,
    everywhere,
    limit,
    scope,
  });
  const { outPath, current } = buildTaskCurrent(taskDb, db, [], {
    owner,
    reviewer,
    all,
    everywhere,
    limit,
    scope,
    excludeTaskIds: options.excludeTaskIds,
  });
  const reviewStateActions = current.review_state_actions || {};
  const drain = taskReviewLaneDrainSelection(reviewStateActions, capabilitiesCheck);
  return {
    schema: 'atris.task_review_lane_drain.v1',
    generated_at: new Date().toISOString(),
    ok: Boolean(capabilitiesCheck.ok),
    action: 'review_lane_drain',
    projection_path: outPath,
    selected_task_id: drain.task ? drain.task.id : null,
    selected_ref: drain.task ? drain.task.ref : null,
    selected_next_key: drain.task ? drain.key : null,
    scope: current.scope,
    owner: String(owner || DEFAULT_OWNER),
    reviewer,
    capabilities_check: {
      schema: capabilitiesCheck.schema,
      ok: capabilitiesCheck.ok,
      summary: capabilitiesCheck.summary,
      checks: capabilitiesCheck.checks,
      safety: capabilitiesCheck.safety,
    },
    review_state_counts: current.review_state_counts,
    review_state_actions: reviewStateActions,
    drain,
    safety: {
      read_only: true,
      mutates_task_db: false,
      writes_projection: true,
      human_accept: false,
      xp_after_human_accept: true,
      safe_to_execute_next_action: Boolean(drain.safe_for_agent && drain.command),
    },
  };
}

function cmdReviewLaneDrain(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const report = taskReviewLaneDrainReport(taskDb, db, args);
  if (wantsJson(args)) {
    printJson(report);
    if (!report.ok) process.exit(1);
    return;
  }
  console.log(`TASK REVIEW LANE DRAIN ${report.ok ? 'ok' : 'failed'}`);
  console.log(`next: ${report.drain.next_action}`);
  console.log(`safe_for_agent: ${report.drain.safe_for_agent ? 'true' : 'false'}`);
  console.log(`command: ${report.drain.command || 'none'}`);
  if (!report.ok) process.exit(1);
}

function taskReviewLaneActOptionsFromArgs(args = []) {
  return {
    owner: flag(args, '--as') || flag(args, '--owner') || DEFAULT_OWNER,
    reviewer: reviewActor(flag(args, '--reviewer') || flag(args, '--as-reviewer') || 'codex-review'),
    all: hasFlag(args, '--all'),
    everywhere: hasFlag(args, '--everywhere'),
    limit: taskQueueLimit(args),
    scope: taskQueueScopeFromArgs(args),
    dryRun: hasFlag(args, '--dry-run'),
  };
}

function taskReviewLaneActOptionsFromBody(body = {}, searchParams = new URLSearchParams()) {
  const queryScope = taskQueueScopeFromSearchParams(searchParams);
  const bodyScope = taskQueueScopeFromBody(body);
  const queryOwner = searchParams.get('owner') || searchParams.get('as') || searchParams.get('actor');
  const queryReviewer = searchParams.get('reviewer') || searchParams.get('as_reviewer') || searchParams.get('as-reviewer');
  const limitParam = searchParams.get('limit') || body.limit;
  const limit = limitParam ? Number(limitParam) : 8;
  return {
    owner: String(queryOwner || body.owner || body.as || body.actor || DEFAULT_OWNER),
    reviewer: reviewActor(queryReviewer || body.reviewer || body.review_actor || body.reviewActor || 'codex-review'),
    all: searchParams.get('all') === '1' || searchParams.get('all') === 'true' || Boolean(body.all),
    everywhere: searchParams.get('everywhere') === '1' || searchParams.get('everywhere') === 'true' || Boolean(body.everywhere),
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8,
    scope: mergeTaskQueueScopes(queryScope, bodyScope),
    dryRun: searchParams.get('dry_run') === '1'
      || searchParams.get('dry-run') === '1'
      || searchParams.get('dryRun') === 'true'
      || Boolean(body.dry_run || body.dryRun),
  };
}

const AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON = 'auto_review_no_green_evidence';

// Evidence gate for the lane's own second review pass: every receipt named in
// the proof must exist on disk and carry an explicit passing verifier state.
// Prose-only proof, missing receipts, or unknown verifier state never certify.
function autoReviewableEvidence(proofText, root = process.cwd()) {
  const evidence = extractReceiptEvidence(proofText, root);
  if (!evidence || evidence.missing.length || !evidence.receipts.length) return { ok: false, evidence };
  return { ok: evidence.receipts.every((entry) => entry.verifier_passed === true), evidence };
}

function autoReviewPendingReviewTask(taskDb, db, taskId, { reviewer = 'codex-review' } = {}) {
  const actor = reviewActor(reviewer);
  const task = taskDetail(taskDb, db, taskId);
  if (!task) return { acted: false, reason: 'not_found' };
  if (task.status !== 'review') return { acted: false, reason: `not_reviewable_${task.status}` };
  const metadata = task.metadata || {};
  const review = task.review || {};
  if (review.agent_certified === true || metadata.agent_certified === true) {
    return { acted: false, reason: 'already_agent_certified' };
  }
  const proof = String(review.proof || metadata.latest_agent_proof || '').trim();
  const { ok, evidence } = autoReviewableEvidence(proof);
  if (!ok) return { acted: false, reason: AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON, evidence };
  const reviewed = taskDb.reviewTask(db, {
    id: taskId,
    actor,
    reward: 0,
    proof,
    lesson: `auto-review: receipts verified passing on disk: ${evidence.receipts.map((entry) => entry.path).join(', ')}`,
  });
  if (!reviewed.reviewed) return { acted: false, reason: reviewed.reason || 'auto_review_failed' };
  const { outPath } = writeDefaultProjection(taskDb, db);
  return {
    acted: true,
    reason: null,
    auto_review: {
      reviewer: actor,
      receipts: evidence.receipts.map((entry) => entry.path),
      review_pass_count: reviewed.event?.payload?.review_pass_count ?? null,
      agent_certified: reviewed.event?.payload?.agent_certified === true,
    },
    evidence,
    projection_path: outPath,
  };
}

function taskReviewLaneAct(taskDb, db, options = {}) {
  const owner = String(options.owner || DEFAULT_OWNER);
  const reviewer = reviewActor(options.reviewer || 'codex-review');
  const scope = normalizeTaskQueueScope(options.scope || {});
  const dryRun = Boolean(options.dryRun);
  const drainReport = taskReviewLaneDrainReport(taskDb, db, [], {
    owner,
    reviewer,
    all: Boolean(options.all),
    everywhere: Boolean(options.everywhere),
    limit: options.limit !== undefined ? options.limit : 8,
    scope,
    excludeTaskIds: options.excludeTaskIds,
  });
  const drain = drainReport.drain || null;
  const decision = taskReviewLaneActDecision(drain || {});
  const base = {
    schema: 'atris.task_review_lane_act.v1',
    generated_at: new Date().toISOString(),
    action: 'review_lane_act',
    selected_task_id: drain && drain.task ? drain.task.id : null,
    selected_ref: drain && drain.task ? drain.task.ref : null,
    selected_next_key: drain && drain.task ? drain.key : null,
    owner,
    reviewer,
    scope,
    dry_run: dryRun,
    drain,
    drain_report: drainReport,
    decision,
    safety: {
      read_only: dryRun,
      mutates_task_db: dryRun ? false : 'conditional',
      writes_projection: true,
      human_accept: false,
      xp_after_human_accept: true,
      allowed_actions: ['review_chat', 'continue_work', 'auto_review'],
    },
  };
  if (!drainReport.ok) {
    return {
      ...base,
      ok: false,
      acted: false,
      reason: 'capabilities_check_failed',
      detail: 'review-lane-act refuses to execute while capabilities-check is failing',
      status: 409,
    };
  }
  if (!decision.ok) {
    return {
      ...base,
      ok: false,
      acted: false,
      reason: decision.reason || 'unsafe_review_lane_action',
      detail: 'review-lane-act only executes review_chat or continue_work actions selected by review-lane-drain',
      status: 409,
    };
  }
  if (dryRun) {
    return {
      ...base,
      ok: true,
      acted: false,
      result: null,
      projection_path: drainReport.projection_path,
    };
  }
  try {
    if (decision.step_action === 'review_chat') {
      const result = appendTaskReviewChat(taskDb, db, decision.task_id, { reviewer });
      return {
        ...base,
        ok: true,
        acted: true,
        selected_action: 'review_chat',
        projection_path: result.projection_path,
        result,
      };
    }
    if (decision.step_action === 'continue_work') {
      const result = continueWorkForReviewTask(taskDb, db, decision.task_id, { owner });
      const created = Boolean(result && result.created);
      return {
        ...base,
        ok: true,
        acted: created,
        selected_action: 'continue_work',
        reason: created ? null : 'continue_work_reused_existing_follow_up',
        projection_path: result.projection_path,
        result,
      };
    }
    if (decision.step_action === 'auto_review') {
      const result = autoReviewPendingReviewTask(taskDb, db, decision.task_id, { reviewer });
      return {
        ...base,
        ok: true,
        acted: Boolean(result.acted),
        selected_action: 'auto_review',
        reason: result.acted ? null : result.reason,
        projection_path: result.projection_path || drainReport.projection_path,
        result,
      };
    }
  } catch (error) {
    return {
      ...base,
      ok: false,
      acted: false,
      selected_action: decision.step_action,
      reason: error.reason || 'review_lane_act_failed',
      detail: error.message,
      status: error.status || 409,
    };
  }
  return {
    ...base,
    ok: false,
    acted: false,
    reason: 'unsupported_review_lane_action',
    detail: `unsupported review-lane action: ${decision.step_action}`,
    status: 409,
  };
}

function cmdReviewLaneAct(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = taskReviewLaneAct(taskDb, db, taskReviewLaneActOptionsFromArgs(args));
  if (wantsJson(args)) {
    printJson(result);
    if (!result.ok) process.exit(1);
    return;
  }
  console.log(`TASK REVIEW LANE ACT ${result.ok ? 'ok' : 'blocked'}`);
  console.log(`next: ${result.drain ? result.drain.next_action : 'none'}`);
  console.log(`acted: ${result.acted ? 'true' : 'false'}`);
  console.log(`dry_run: ${result.dry_run ? 'true' : 'false'}`);
  if (result.reason) console.log(`reason: ${result.reason}`);
  if (!result.ok) process.exit(1);
}

function normalizeReviewLaneLoopMaxSteps(value) {
  const parsed = Number(value === undefined || value === null || value === true ? REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS : value);
  if (!Number.isFinite(parsed)) return REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS;
  return Math.max(1, Math.min(REVIEW_LANE_LOOP_MAX_STEPS, Math.floor(parsed)));
}

function taskReviewLaneLoopStopIsSafe(reason) {
  const expected = new Set([
    'dry_run_preview',
    PROOF_BOUNDARY_BLOCKED_REASON,
    'human_accept_waiting_is_human_only',
    PENDING_REVIEW_CHAT_STOP_REASON,
    AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON,
    'no_review_lane_action',
    'continue_work_reused_existing_follow_up',
    'repeat_selection',
    'max_steps_reached',
  ]);
  return {
    ok: expected.has(reason),
    read_only: reason === 'dry_run_preview',
    human_accept: false,
  };
}

function taskReviewLaneActSelectionKey(act) {
  const decision = act && act.decision || {};
  if (!decision.step_action || !decision.task_id) return null;
  return `${decision.step_action}:${decision.task_id}`;
}

function taskReviewLaneLoopOptionsFromArgs(args = []) {
  return {
    ...taskReviewLaneActOptionsFromArgs(args),
    maxSteps: normalizeReviewLaneLoopMaxSteps(flag(args, '--max-steps') || flag(args, '--limit')),
  };
}

function taskReviewLaneLoopOptionsFromBody(body = {}, searchParams = new URLSearchParams()) {
  const options = taskReviewLaneActOptionsFromBody(body, searchParams);
  const maxSteps = searchParams.get('max_steps')
    || searchParams.get('max-steps')
    || searchParams.get('limit')
    || body.max_steps
    || body.maxSteps
    || body.limit;
  return {
    ...options,
    maxSteps: normalizeReviewLaneLoopMaxSteps(maxSteps),
  };
}

function compactReviewLaneLoopStep(index, act, { phase = 'act' } = {}) {
  return {
    index,
    phase,
    ok: Boolean(act && act.ok),
    acted: Boolean(act && act.acted),
    dry_run: Boolean(act && act.dry_run),
    selected_action: act && act.selected_action || null,
    reason: act && act.reason || null,
    decision: act && act.decision || null,
    drain: act && act.drain ? {
      next_action: act.drain.next_action,
      review_state: act.drain.review_state,
      safe_for_agent: act.drain.safe_for_agent,
      task: act.drain.task || null,
      reason: act.drain.reason || null,
      command: act.drain.command || null,
      api: act.drain.api || null,
    } : null,
    result: act && act.result ? {
      ok: act.result.ok,
      action: act.result.action,
      task_id: act.result.task_id,
      parent_task_id: act.result.parent_task_id,
      next_task_id: act.result.next_task_id,
      appended: act.result.appended,
      created: act.result.created,
      projection_path: act.result.projection_path,
    } : null,
  };
}

function taskReviewLaneLoop(taskDb, db, options = {}) {
  const owner = String(options.owner || DEFAULT_OWNER);
  const reviewer = reviewActor(options.reviewer || 'codex-review');
  const scope = normalizeTaskQueueScope(options.scope || {});
  const dryRun = Boolean(options.dryRun);
  const maxSteps = normalizeReviewLaneLoopMaxSteps(options.maxSteps);
  const steps = [];
  const seenActions = new Set();
  const excludeTaskIds = normalizeTaskIdSet(options.excludeTaskIds);
  let stoppedReason = 'max_steps_reached';
  let skippedNoEvidence = false;
  let status = 200;
  let finalDrain = null;
  let finalDecision = null;
  let projectionPath = null;

  for (let index = 1; index <= maxSteps; index += 1) {
	    const preview = taskReviewLaneAct(taskDb, db, {
	      owner,
	      reviewer,
	      all: Boolean(options.all),
	      everywhere: Boolean(options.everywhere),
	      limit: options.limit !== undefined ? options.limit : 8,
	      scope,
	      excludeTaskIds,
	      dryRun: true,
	    });
    finalDrain = preview.drain || null;
    finalDecision = preview.decision || null;
    projectionPath = preview.projection_path || projectionPath;

    if (!preview.ok) {
      stoppedReason = preview.reason || 'review_lane_act_failed';
      // An empty lane after evidence-less skips is the skips' story, not "no action".
      if (stoppedReason === 'no_review_lane_action' && skippedNoEvidence) {
        stoppedReason = AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON;
      }
      status = taskReviewLaneLoopStopIsSafe(stoppedReason).ok ? 200 : preview.status || 409;
      steps.push(compactReviewLaneLoopStep(index, preview, { phase: 'preview' }));
      break;
    }

    const actionKey = taskReviewLaneActSelectionKey(preview);
    if (!actionKey) {
      stoppedReason = skippedNoEvidence ? AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON : 'no_review_lane_action';
      steps.push(compactReviewLaneLoopStep(index, {
        ...preview,
        ok: true,
        acted: false,
        reason: stoppedReason,
      }, { phase: 'preview' }));
      break;
    }

    if (seenActions.has(actionKey)) {
      stoppedReason = 'repeat_selection';
      steps.push(compactReviewLaneLoopStep(index, {
        ...preview,
        reason: stoppedReason,
      }, { phase: 'preview' }));
      break;
    }
    seenActions.add(actionKey);

    if (dryRun) {
      stoppedReason = 'dry_run_preview';
      steps.push(compactReviewLaneLoopStep(index, preview, { phase: 'dry_run' }));
      break;
    }

	    const act = taskReviewLaneAct(taskDb, db, {
	      owner,
	      reviewer,
	      all: Boolean(options.all),
	      everywhere: Boolean(options.everywhere),
	      limit: options.limit !== undefined ? options.limit : 8,
	      scope,
	      excludeTaskIds,
	      dryRun: false,
	    });
    finalDrain = act.drain || finalDrain;
    finalDecision = act.decision || finalDecision;
    projectionPath = act.projection_path || act.result && act.result.projection_path || projectionPath;
	    const liveKey = taskReviewLaneActSelectionKey(act);
	    if (liveKey) seenActions.add(liveKey);
	    if (act.acted && act.decision && act.decision.task_id) excludeTaskIds.add(String(act.decision.task_id));
	    steps.push(compactReviewLaneLoopStep(index, act, { phase: 'act' }));

    if (!act.ok) {
      stoppedReason = act.reason || 'review_lane_act_failed';
      status = taskReviewLaneLoopStopIsSafe(stoppedReason).ok ? 200 : act.status || 409;
      break;
    }
    if (!act.acted) {
      // Evidence-less pending reviews must not head-block the lane: exclude the
      // task and keep draining whatever sits behind it.
      if (act.reason === AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON && act.decision && act.decision.task_id) {
        excludeTaskIds.add(String(act.decision.task_id));
        skippedNoEvidence = true;
        continue;
      }
      stoppedReason = act.reason || 'no_review_lane_action';
      break;
    }
  }

  const actedCount = steps.filter(step => step.acted).length;
  const stopSafety = taskReviewLaneLoopStopIsSafe(stoppedReason);
  return {
    schema: 'atris.task_review_lane_loop.v1',
    generated_at: new Date().toISOString(),
    ok: status < 400 || stopSafety.ok,
    action: 'review_lane_loop',
    owner,
    reviewer,
    scope,
    dry_run: dryRun,
    max_steps: maxSteps,
    acted_count: actedCount,
    stopped_reason: stoppedReason,
    stopped_on: finalDrain ? finalDrain.next_action : null,
    final_decision: finalDecision,
    final_drain: finalDrain,
    steps,
    status,
    projection_path: projectionPath,
    safety: {
      read_only: dryRun,
      mutates_task_db: dryRun ? false : 'conditional',
      writes_projection: true,
      human_accept: false,
      xp_after_human_accept: true,
      max_steps_cap: REVIEW_LANE_LOOP_MAX_STEPS,
      repeat_selection_guard: true,
    },
  };
}

function cmdReviewLaneLoop(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = taskReviewLaneLoop(taskDb, db, taskReviewLaneLoopOptionsFromArgs(args));
  if (wantsJson(args)) {
    printJson(result);
    if (!result.ok) process.exit(1);
    return;
  }
  console.log(`TASK REVIEW LANE LOOP ${result.ok ? 'ok' : 'blocked'}`);
  console.log(`acted: ${result.acted_count}`);
  console.log(`stopped: ${result.stopped_reason}`);
  console.log(`dry_run: ${result.dry_run ? 'true' : 'false'}`);
  if (!result.ok) process.exit(1);
}

function normalizeReviewLaneRunMaxRuns(value) {
  const parsed = Number(value === undefined || value === null || value === true ? REVIEW_LANE_RUN_DEFAULT_MAX_RUNS : value);
  if (!Number.isFinite(parsed)) return REVIEW_LANE_RUN_DEFAULT_MAX_RUNS;
  return Math.max(1, Math.min(REVIEW_LANE_RUN_MAX_RUNS, Math.floor(parsed)));
}

function taskReviewLaneRunOptionsFromArgs(args = []) {
  return {
    ...taskReviewLaneLoopOptionsFromArgs(args),
    maxRuns: normalizeReviewLaneRunMaxRuns(flag(args, '--max-runs') || flag(args, '--runs')),
  };
}

function taskReviewLaneRunOptionsFromBody(body = {}, searchParams = new URLSearchParams()) {
  const options = taskReviewLaneLoopOptionsFromBody(body, searchParams);
  const maxRuns = searchParams.get('max_runs')
    || searchParams.get('max-runs')
    || searchParams.get('runs')
    || body.max_runs
    || body.maxRuns
    || body.runs;
  return {
    ...options,
    maxRuns: normalizeReviewLaneRunMaxRuns(maxRuns),
  };
}

function taskReviewLaneRunStopIsSafe(reason) {
  const expected = new Set([
    'dry_run_preview',
    PROOF_BOUNDARY_BLOCKED_REASON,
    'human_accept_waiting_is_human_only',
    PENDING_REVIEW_CHAT_STOP_REASON,
    AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON,
    'no_review_lane_action',
    'continue_work_reused_existing_follow_up',
    'repeat_selection',
    'max_runs_reached',
  ]);
  return {
    ok: expected.has(reason),
    write_receipt: reason !== 'dry_run_preview',
    human_accept: false,
  };
}

function reviewLaneRunReceiptPaths() {
  const stateDir = path.resolve(path.join('.atris', 'state'));
  return {
    stateDir,
    receiptPath: path.join(stateDir, 'review-lane-runs.jsonl'),
    latestPath: path.join(stateDir, 'review-lane-run.latest.json'),
  };
}

function compactReviewLaneRunLoop(index, loop) {
  return {
    index,
    ok: Boolean(loop && loop.ok),
    dry_run: Boolean(loop && loop.dry_run),
    max_steps: loop && loop.max_steps || null,
    acted_count: loop && loop.acted_count || 0,
    stopped_reason: loop && loop.stopped_reason || null,
    stopped_on: loop && loop.stopped_on || null,
    status: loop && loop.status || null,
    projection_path: loop && loop.projection_path || null,
    final_decision: loop && loop.final_decision || null,
    final_drain: loop && loop.final_drain ? {
      next_action: loop.final_drain.next_action,
      review_state: loop.final_drain.review_state,
      safe_for_agent: loop.final_drain.safe_for_agent,
      task: loop.final_drain.task || null,
      reason: loop.final_drain.reason || null,
      command: loop.final_drain.command || null,
      api: loop.final_drain.api || null,
    } : null,
    steps: Array.isArray(loop && loop.steps) ? loop.steps : [],
  };
}

function writeReviewLaneRunReceipt(receipt) {
  const { stateDir, receiptPath, latestPath } = reviewLaneRunReceiptPaths();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, 'utf8');
  fs.writeFileSync(latestPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  return { receiptPath, latestPath };
}

function taskReviewLaneRun(taskDb, db, options = {}) {
  const owner = String(options.owner || DEFAULT_OWNER);
  const reviewer = reviewActor(options.reviewer || 'codex-review');
  const scope = normalizeTaskQueueScope(options.scope || {});
  const dryRun = Boolean(options.dryRun);
  const maxRuns = normalizeReviewLaneRunMaxRuns(options.maxRuns);
  const maxSteps = normalizeReviewLaneLoopMaxSteps(options.maxSteps);
  const runs = [];
  const excludeTaskIds = normalizeTaskIdSet(options.excludeTaskIds);
  let stoppedReason = 'max_runs_reached';
  let skippedNoEvidence = false;
  let stoppedOn = null;
  let status = 200;
  let projectionPath = null;

  for (let index = 1; index <= maxRuns; index += 1) {
	    const loop = taskReviewLaneLoop(taskDb, db, {
	      owner,
	      reviewer,
	      all: Boolean(options.all),
	      everywhere: Boolean(options.everywhere),
	      limit: options.limit !== undefined ? options.limit : 8,
	      scope,
	      excludeTaskIds,
	      dryRun,
	      maxSteps,
	    });
	    runs.push(compactReviewLaneRunLoop(index, loop));
	    for (const step of loop.steps || []) {
	      if (step && step.acted && step.decision && step.decision.task_id) {
	        excludeTaskIds.add(String(step.decision.task_id));
	      } else if (step && !step.acted && step.reason === AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON
	        && step.decision && step.decision.task_id) {
	        // Refused auto-reviews stay refused for this run: exclude them so the
	        // next inner loop drains the tasks behind them instead of re-selecting.
	        excludeTaskIds.add(String(step.decision.task_id));
	        skippedNoEvidence = true;
	      }
	    }
    projectionPath = loop.projection_path || projectionPath;
    stoppedOn = loop.stopped_on || stoppedOn;

    if (dryRun) {
      stoppedReason = loop.stopped_reason || 'dry_run_preview';
      status = loop.status || 200;
      break;
    }

    if (!loop.ok) {
      stoppedReason = loop.stopped_reason || 'review_lane_loop_failed';
      status = loop.status || 409;
      break;
    }

    if (loop.stopped_reason !== 'max_steps_reached') {
      stoppedReason = loop.stopped_reason || 'no_review_lane_action';
      status = loop.status || 200;
      break;
    }
  }
  if (stoppedReason === 'no_review_lane_action' && skippedNoEvidence) {
    stoppedReason = AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON;
  }

  const totalActedCount = runs.reduce((sum, run) => sum + (Number(run.acted_count) || 0), 0);
  const stopSafety = taskReviewLaneRunStopIsSafe(stoppedReason);
  const { receiptPath, latestPath } = reviewLaneRunReceiptPaths();
  const receipt = {
    schema: 'atris.task_review_lane_run.v1',
    generated_at: new Date().toISOString(),
    ok: status < 400 || stopSafety.ok,
    action: 'review_lane_run',
    owner,
    reviewer,
    scope,
    dry_run: dryRun,
    max_runs: maxRuns,
    max_steps: maxSteps,
    run_count: runs.length,
    total_acted_count: totalActedCount,
    stopped_reason: stoppedReason,
    stopped_on: stoppedOn,
    runs,
    status,
    projection_path: projectionPath,
    receipt_path: dryRun ? null : receiptPath,
    latest_receipt_path: dryRun ? null : latestPath,
    would_write_receipt_path: dryRun ? receiptPath : null,
    receipt_written: false,
    safety: {
      read_only: dryRun,
      mutates_task_db: dryRun ? false : 'conditional',
      writes_projection: true,
      writes_receipt: !dryRun,
      human_accept: false,
      xp_after_human_accept: true,
      max_runs_cap: REVIEW_LANE_RUN_MAX_RUNS,
      max_steps_cap: REVIEW_LANE_LOOP_MAX_STEPS,
      orchestrates: 'review_lane_loop',
    },
  };

  if (!dryRun) {
    receipt.receipt_written = true;
    const written = writeReviewLaneRunReceipt(receipt);
    receipt.receipt_path = written.receiptPath;
    receipt.latest_receipt_path = written.latestPath;
  }

  return receipt;
}

function cmdReviewLaneRun(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = taskReviewLaneRun(taskDb, db, taskReviewLaneRunOptionsFromArgs(args));
  if (wantsJson(args)) {
    printJson(result);
    if (!result.ok) process.exit(1);
    return;
  }
  console.log(`TASK REVIEW LANE RUN ${result.ok ? 'ok' : 'blocked'}`);
  console.log(`runs: ${result.run_count}`);
  console.log(`acted: ${result.total_acted_count}`);
  console.log(`stopped: ${result.stopped_reason}`);
  console.log(`dry_run: ${result.dry_run ? 'true' : 'false'}`);
  if (result.receipt_written) console.log(`receipt: ${result.receipt_path}`);
  if (!result.ok) process.exit(1);
}

function configValueDisabled(value) {
  if (value === false) return true;
  const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  return ['0', 'false', 'off', 'no'].includes(text);
}

function reviewAutoAcceptEnabled() {
  try {
    const { loadConfig } = require('../utils/config');
    const config = loadConfig();
    const value = Object.prototype.hasOwnProperty.call(config, 'autoaccept')
      ? config.autoaccept
      : Object.prototype.hasOwnProperty.call(config, 'review_autoaccept')
        ? config.review_autoaccept
        : config.reviewAutoaccept;
    return !configValueDisabled(value);
  } catch {
    return true;
  }
}

function reviewAutoAcceptStatePath(root = process.cwd()) {
  return path.join(root, '.atris', 'state', 'review-autoaccept.json');
}

function readReviewAutoAcceptState(root = process.cwd()) {
  const file = reviewAutoAcceptStatePath(root);
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeReviewAutoAcceptState(root = process.cwd(), state = {}) {
  const file = reviewAutoAcceptStatePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstNumberFromObject(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'string' && value.includes(',')) {
      const parts = value.split(',').map(part => part.trim()).filter(Boolean);
      if (parts.length > 1) return parts.length;
    }
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function arrayFromPathValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(arrayFromPathValue);
  if (typeof value === 'object') {
    if (typeof value.path === 'string') return [value.path];
    if (typeof value.file === 'string') return [value.file];
    if (typeof value.filename === 'string') return [value.filename];
    return [];
  }
  return String(value)
    .split(/[\n,]+/)
    .map(part => part.trim())
    .filter(Boolean);
}

function collectRecordedDiffPaths(source) {
  if (!source || typeof source !== 'object') return [];
  const keys = [
    'files',
    'paths',
    'touched_files',
    'touchedFiles',
    'changed_files',
    'changedFiles',
    'modified_files',
    'modifiedFiles',
  ];
  const out = [];
  for (const key of keys) out.push(...arrayFromPathValue(source[key]));
  return out;
}

function normalizeRecordedDiffStats(source, label = 'recorded') {
  if (!source || typeof source !== 'object') return null;
  const fileKeys = [
    'files_touched',
    'filesTouched',
    'changed_files_count',
    'changedFilesCount',
    'files_changed',
    'filesChanged',
    'file_count',
    'fileCount',
    'files',
    'changed_files',
    'changedFiles',
  ];
  const changedLineKeys = [
    'changed_lines',
    'changedLines',
    'lines_changed',
    'linesChanged',
    'changed_line_count',
    'changedLineCount',
    'total_changed_lines',
    'totalChangedLines',
    'line_count',
    'lineCount',
  ];
  const insertions = firstNumberFromObject(source, ['insertions', 'added', 'additions', 'lines_added', 'linesAdded']);
  const deletions = firstNumberFromObject(source, ['deletions', 'deleted', 'removals', 'lines_deleted', 'linesDeleted']);
  const paths = collectRecordedDiffPaths(source);
  const filesTouched = firstNumberFromObject(source, fileKeys) ?? (paths.length ? paths.length : null);
  const changedLines = firstNumberFromObject(source, changedLineKeys)
    ?? (insertions !== null || deletions !== null ? Number(insertions || 0) + Number(deletions || 0) : null);
  if (filesTouched === null && changedLines === null && !paths.length) return null;
  return {
    source: label,
    files_touched: filesTouched,
    changed_lines: changedLines,
    paths,
  };
}

function recordedDiffStatsForTask(task) {
  const metadata = task && task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const candidates = [
    metadata.diff_stats,
    metadata.diffStats,
    metadata.git_diff_stats,
    metadata.gitDiffStats,
    metadata.change_stats,
    metadata.changeStats,
    metadata.stats,
    metadata,
  ];
  for (const candidate of candidates) {
    const stats = normalizeRecordedDiffStats(candidate, 'recorded');
    if (stats) return stats;
  }
  return null;
}

function proofDiffStats(proof) {
  const text = String(proof || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  let filesTouched = null;
  let changedLines = null;
  const gitStat = text.match(/(\d+)\s+files?\s+changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/i);
  if (gitStat) {
    filesTouched = Number(gitStat[1]);
    const insertions = gitStat[2] ? Number(gitStat[2]) : 0;
    const deletions = gitStat[3] ? Number(gitStat[3]) : 0;
    if (gitStat[2] || gitStat[3]) changedLines = insertions + deletions;
  }
  const filePatterns = [
    /files?\s+(?:touched|changed|modified)\s*[:=]\s*(\d+)/i,
    /(\d+)\s+files?\s+(?:touched|changed|modified)/i,
  ];
  for (const pattern of filePatterns) {
    const match = text.match(pattern);
    if (match) filesTouched = Number(match[1]);
  }
  const linePatterns = [
    /changed\s+lines?\s*[:=]\s*(\d+)/i,
    /(\d+)\s+changed\s+lines?/i,
    /lines?\s+changed\s*[:=]\s*(\d+)/i,
  ];
  for (const pattern of linePatterns) {
    const match = text.match(pattern);
    if (match) changedLines = Number(match[1]);
  }
  if (filesTouched === null && changedLines === null) return null;
  return {
    source: 'proof',
    files_touched: filesTouched,
    changed_lines: changedLines,
    paths: [],
  };
}

function safeGitRef(value) {
  const text = String(value || '').trim();
  if (!text || text.startsWith('-') || text.includes('..')) return null;
  if (!/^[a-zA-Z0-9_./@=+~^-]+$/.test(text)) return null;
  return text;
}

function runGitForAutoAccept(root, args) {
  try {
    const { spawnSync } = require('child_process');
    return spawnSync('git', args, {
      cwd: root || process.cwd(),
      encoding: 'utf8',
      timeout: 10000,
    });
  } catch {
    return { status: 1, stdout: '', stderr: '' };
  }
}

function gitRefExists(root, ref) {
  const result = runGitForAutoAccept(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return result.status === 0;
}

function defaultDiffBase(root) {
  for (const ref of ['origin/master', 'origin/main', 'master', 'main']) {
    if (gitRefExists(root, ref)) return ref;
  }
  return null;
}

function branchDiffStatsForTask(task, root) {
  const metadata = task && task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const branch = safeGitRef(
    metadata.branch
      || metadata.worktree_branch
      || metadata.git_branch
      || metadata.pr_branch
      || metadata.head_branch
      || metadata.worktree?.branch
  );
  if (!branch) return null;
  const base = safeGitRef(
    metadata.base
      || metadata.base_ref
      || metadata.target_ref
      || metadata.target_branch
      || metadata.worktree?.base
  ) || defaultDiffBase(root);
  if (!base) return null;
  const result = runGitForAutoAccept(root, ['diff', '--numstat', `${base}...${branch}`]);
  if (result.status !== 0) return null;
  const lines = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { source: 'branch', files_touched: 0, changed_lines: 0, paths: [] };
  let changedLines = 0;
  let unknownLines = false;
  const paths = [];
  for (const line of lines) {
    const parts = line.split(/\t+/);
    const added = Number(parts[0]);
    const deleted = Number(parts[1]);
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) unknownLines = true;
    else changedLines += added + deleted;
    if (parts[2]) paths.push(parts.slice(2).join('\t'));
  }
  return {
    source: 'branch',
    files_touched: lines.length,
    changed_lines: unknownLines ? null : changedLines,
    paths,
  };
}

function reviewAutoAcceptDiffStats(task, root) {
  const recorded = recordedDiffStatsForTask(task);
  if (recorded) return recorded;
  const branch = branchDiffStatsForTask(task, root);
  if (branch) return branch;
  const proof = String(task?.review?.proof || task?.metadata?.latest_agent_proof || '');
  return proofDiffStats(proof);
}

function reviewAutoAcceptBigTitle(task) {
  const metadata = task && task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const text = [
    task && task.title,
    metadata.kind,
    metadata.type,
    metadata.category,
    metadata.report_type,
  ].map(value => String(value || '')).join(' ').toLowerCase();
  const match = text.match(/\b(daily\s+update|summary|report|digest|retro|retrospective)\b/i);
  if (!match) return null;
  return {
    ok: false,
    reason: `big_title_${match[1].toLowerCase().replace(/\s+/g, '_')}`,
  };
}

function reviewAutoAcceptSizeGate(task, root) {
  const titleGate = reviewAutoAcceptBigTitle(task);
  if (titleGate) return titleGate;
  const stats = reviewAutoAcceptDiffStats(task, root);
  if (!stats) return { ok: false, reason: 'size_unknown', stats: null };
  const filesTouched = finiteNumber(stats.files_touched);
  const changedLines = finiteNumber(stats.changed_lines);
  if (filesTouched !== null && filesTouched > REVIEW_AUTO_ACCEPT_FILE_LIMIT) {
    return { ok: false, reason: 'big_files', stats };
  }
  if (changedLines !== null && changedLines > REVIEW_AUTO_ACCEPT_LINE_LIMIT) {
    return { ok: false, reason: 'big_changed_lines', stats };
  }
  if (filesTouched === null || changedLines === null) {
    return { ok: false, reason: 'size_unknown', stats };
  }
  return { ok: true, reason: 'small_change', stats };
}

function reviewAutoAcceptMetadataText(task) {
  const metadata = task && task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  return [
    task && task.title,
    task && task.tag,
    task && task.source_key,
    metadata.kind,
    metadata.type,
    metadata.category,
    metadata.lane,
    metadata.stage,
    metadata.area,
    JSON.stringify(metadata),
  ].map(value => String(value || '')).join(' ').toLowerCase();
}

function reviewAutoAcceptTouchedPaths(task) {
  const metadata = task && task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const stats = recordedDiffStatsForTask(task);
  const proof = String(task?.review?.proof || metadata.latest_agent_proof || '');
  return [
    ...(stats && stats.paths ? stats.paths : []),
    ...collectRecordedDiffPaths(metadata),
    ...taskReviewEvidencePaths(proof, 50),
  ].map(value => String(value || '').trim()).filter(Boolean);
}

function reviewProtectedMatch(task) {
  const text = reviewAutoAcceptMetadataText(task);
  const paths = reviewAutoAcceptTouchedPaths(task).join(' ').toLowerCase();
  const combined = `${text} ${paths}`;
  const checks = [
    ['auth', /\b(auth|authentication|authorization|oauth|login|session)\b/i],
    ['credentials', /\b(credentials?|secrets?|passwords?|api[-_ ]?keys?|tokens?)\b/i],
    ['csp', /\b(csp|content[-_ ]security[-_ ]policy)\b/i],
    ['sandbox', /\b(sandbox|allow-scripts|allow-same-origin)\b/i],
    ['billing', /\b(billing|invoice|invoices|subscription|subscriptions)\b/i],
    ['payments', /\b(payments?|stripe|checkout|refunds?)\b/i],
    ['outbound_sends', /\b(outbound|send|sending|email|sms|webhook|notification|notifications)\b/i],
  ];
  for (const [key, pattern] of checks) {
    if (pattern.test(combined)) return { ok: false, reason: `protected_${key}` };
  }
  return { ok: true };
}

function evaluateReviewAutoAccept(task, root) {
  const ref = taskRef(task);
  if (!task) return { eligible: false, ref, reason: 'task_not_found' };
  const protectedGate = reviewProtectedMatch(task);
  if (!protectedGate.ok) return { eligible: false, ref, reason: protectedGate.reason };
  const sizeGate = reviewAutoAcceptSizeGate(task, root);
  if (!sizeGate.ok) return { eligible: false, ref, reason: sizeGate.reason, size: sizeGate.stats };
  // executeVerify: false, this is a READ path. The verdict comes from
  // metadata.verify_cache, stamped by the two lanes allowed to spawn
  // checks (certify-verified, autoland landing re-check). Spawning here is
  // what turned `atris task reviews` into a fork-bomb multiplier.
  const evaluation = evaluateAutoAccept(task, { strictVerify: true, executeVerify: false });
  if (!evaluation.eligible) {
    return {
      ...evaluation,
      size: sizeGate.stats,
    };
  }
  if (evaluation.verification_pending) {
    const verdict = cachedVerifyVerdict(task, root);
    if (!verdict.fresh) {
      return {
        eligible: false,
        ref,
        reason: 'verification_pending',
        verify: verdict.command || null,
        next_action: 'no fresh executed verify on record; `atris task certify-verified` or the autoland tick runs the stored check and stamps metadata.verify_cache',
        size: sizeGate.stats,
      };
    }
    if (!verdict.ok) {
      return {
        eligible: false,
        ref,
        reason: verdict.reason || 'verify_failed',
        verify: verdict.command,
        verify_cache: verdict,
        size: sizeGate.stats,
      };
    }
    return {
      ...evaluation,
      verification_pending: false,
      verify_cache: verdict,
      eligible: true,
      reason: 'certified_small',
      policy: REVIEW_AUTO_ACCEPT_POLICY,
      size: sizeGate.stats,
    };
  }
  return {
    ...evaluation,
    eligible: true,
    reason: 'certified_small',
    policy: REVIEW_AUTO_ACCEPT_POLICY,
    size: sizeGate.stats,
  };
}

function autoAcceptCertifiedSmallReviews(taskDb, db, projection) {
  const enabled = reviewAutoAcceptEnabled();
  const root = projection.workspace_root || process.cwd();
  const results = [];
  if (!enabled) {
    return {
      enabled,
      scanned: 0,
      accepted: 0,
      changed: false,
      results,
    };
  }
  const certified = certifiedPendingReviewTasks(projection);
  for (const item of certified) {
    const fullProjection = enrichTaskProjection(taskDb.taskProjection(db, { taskId: item.id }));
    const task = fullProjection.tasks[0] || null;
    const evaluation = evaluateReviewAutoAccept(task, root);
    if (!evaluation.eligible) {
      results.push({ ...evaluation, action: 'queued', task_id: task?.id || item.id || null });
      continue;
    }
    const policyGate = candidatePolicyGate(task, { executeDetectors: true });
    if (!policyGate.ok) {
      results.push({ ...policyGate, action: 'queued', task_id: task?.id || item.id || null });
      continue;
    }
    evaluation.candidate_gate = policyGate.gate;
    const accepted = acceptReviewTask(taskDb, db, task.id, {
      actor: REVIEW_AUTO_ACCEPT_ACTOR,
      proof: evaluation.proof,
      reward: 1,
      lesson: String(task.review?.lesson || task.metadata?.latest_agent_lesson || ''),
      nextTask: String(task.review?.next_task || task.metadata?.latest_agent_next_task || ''),
      autoAccepted: true,
    });
    if (!accepted.ok) {
      results.push({ ...evaluation, action: 'accept_failed', task_id: task.id, reason: accepted.reason });
      continue;
    }
    stampAutoAcceptMetadata(taskDb, db, task.id, REVIEW_AUTO_ACCEPT_ACTOR, REVIEW_AUTO_ACCEPT_POLICY);
    refreshCareerXpAfterReview(accepted.reviewed);
    results.push({
      ...evaluation,
      action: 'accepted',
      task_id: task.id,
      reward: accepted.reviewed.episode.reward.value,
    });
  }
  const acceptedCount = results.filter(row => row.action === 'accepted').length;
  return {
    enabled,
    scanned: certified.length,
    accepted: acceptedCount,
    changed: acceptedCount > 0,
    results,
  };
}

function autoAcceptedReviewRowsSince(taskDb, db, workspaceRoot, sinceIso, acceptedNowIds = []) {
  const sinceMs = Date.parse(sinceIso || '');
  const rows = taskDb.withTaskDisplayRefs(taskDb.listTasks(db, { workspaceRoot }));
  const acceptedNow = new Set(acceptedNowIds.filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const acceptedAt = Date.parse(metadata.auto_accepted_at || metadata.accepted_at || '');
    const policyMatch = metadata.auto_accept_policy === REVIEW_AUTO_ACCEPT_POLICY
      || metadata.auto_accepted_by === REVIEW_AUTO_ACCEPT_ACTOR
      || metadata.accepted_by === REVIEW_AUTO_ACCEPT_ACTOR;
    const isCurrent = acceptedNow.has(row.id);
    const isSince = Number.isFinite(sinceMs) && Number.isFinite(acceptedAt) && acceptedAt > sinceMs;
    const firstLook = !Number.isFinite(sinceMs) && Number.isFinite(acceptedAt);
    if (row.status !== 'done' || !policyMatch || (!isCurrent && !isSince && !firstLook)) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({
      id: row.id,
      ref: row.display_id || taskRef(row),
      title: row.title,
      accepted_at: metadata.auto_accepted_at || metadata.accepted_at || null,
    });
  }
  out.sort((a, b) => String(b.accepted_at || '').localeCompare(String(a.accepted_at || '')));
  return out;
}

function reviewAutoAcceptRollup(taskDb, db, workspaceRoot, previousState, autoAcceptRun) {
  const acceptedNowIds = (autoAcceptRun.results || [])
    .filter(row => row.action === 'accepted')
    .map(row => row.task_id)
    .filter(Boolean);
  const rows = autoAcceptedReviewRowsSince(taskDb, db, workspaceRoot, previousState.last_look_at, acceptedNowIds);
  return {
    count: rows.length,
    items: rows,
    since: previousState.last_look_at || null,
  };
}

function reviewQueueLimit(args, total) {
  if (hasFlag(args, '--all')) return total;
  const raw = flag(args, '--limit');
  const limit = raw && raw !== true ? Number(raw) : 5;
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
}

function reviewQueueVerbose(args) {
  return hasFlag(args, '--verbose') || hasFlag(args, '--details') || hasFlag(args, '--all');
}

function reviewGroupTextLimit(args, total) {
  if (hasFlag(args, '--all')) return total;
  const raw = flag(args, '--limit');
  const limit = raw && raw !== true ? Number(raw) : 10;
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
}

function plainReviewBlockerMessage(item) {
  const ref = item.display_id || taskRef(item.id);
  if (item.reason === 'verify_command_not_allowed') {
    return `${ref} used a check command the system does not allow; rerun with an approved check`;
  }
  if (item.reason === 'needs_second_actor_review') {
    return `${ref} needs a second reviewer before it can land`;
  }
  return `${ref} needs another check before it can land`;
}

// Risk order for human attention: named receipts that are missing/failing (0)
// beat prose-only proofs (1) beat fully validated green evidence (2).
function evidenceRiskRank(evidence) {
  if (!evidence) return 1;
  return evidence.all_passing ? 2 : 0;
}

function reviewQueueItem(task, root = process.cwd(), evidence = undefined) {
  const ref = taskRef(task);
  const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true });
  const reviewChat = taskReviewChatHandoff(task, { reviewer: 'codex-review', allowCertified: true });
  const continueWorkCommand = continueWorkCommandForTask(task);
  const genericIssues = genericContinuationIssues(task);
  const acceptCommand = handoffAllowsHumanAccept(handoff) ? `atris task accept ${ref}` : null;
  const item = {
    id: task.id,
    display_id: task.display_id || null,
    title: task.title,
    explanation: task.explanation || taskExplanation(task),
    approval: task.approval || taskApprovalFor(task),
    tag: task.tag || null,
    updated_at: task.updated_at || null,
    review_pass_count: task.review?.agent_review_pass_count || null,
    landing: reviewLandingForDisplay(task.review),
    result: task.review?.result || null,
    proof: taskReviewClip(task.review?.proof, 500) || null,
    next_action: handoff?.next_action || null,
    accept_command: acceptCommand,
    land_command: acceptCommand,
    revise_command: `atris task revise ${ref} --note "<what must change>"`,
    send_back_command: `atris task revise ${ref} --note "<what must change>"`,
  };
  const resolvedEvidence = evidence === undefined ? extractReceiptEvidence(task.review?.proof, root) : evidence;
  if (resolvedEvidence) item.evidence = resolvedEvidence;
  if (!acceptCommand && handoff?.reason) {
    item.blocked_accept_reason = handoff.reason;
    item.next_action_detail = handoff.next_action_detail || null;
  }
  if (continueWorkCommand && handoff?.next_action === 'continue_work') {
    item.continue_work_command = continueWorkCommand;
    item.continue_work_api = { method: 'POST', path: `/api/tasks/${encodeURIComponent(task.id)}/continue-work` };
  }
  if (reviewChat) {
    item.review_chat_command = reviewChat.command;
    item.codex_prompt = reviewChat.codex_prompt;
    item.verification_focus = reviewChat.verification_focus;
  }
  if (genericIssues.length) {
    item.hygiene = {
      generic_continuation_issues: genericIssues,
    };
  }
  return item;
}

function blockedReviewQueueItem(task, root = process.cwd()) {
  const item = reviewQueueItem(task, root);
  const blocker = reviewBlockerForTask(task);
  item.queue_role = 'blocked';
  item.reason = blocker.reason;
  item.blocked_reason = blocker.reason;
  item.next_command = blocker.next_command;
  item.verify_command = blocker.verify_command;
  item.accept_command = null;
  item.land_command = null;
  return item;
}

function reviewQueueHygiene(tasks) {
  const genericContinuations = (tasks || []).map(task => {
    const issues = genericContinuationIssues(task);
    if (!issues.length) return null;
    return {
      id: task.id,
      display_id: task.display_id || null,
      title: task.title,
      issues,
    };
  }).filter(Boolean);
  return {
    generic_continuation_count: genericContinuations.length,
    generic_continuations: genericContinuations,
  };
}

function taskReviewQueue(projection, args = []) {
  const reviewTasks = (projection.tasks || [])
    .filter(task => task && task.status === 'review' && task.review && task.review.approval_status === 'pending')
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  const reviewHandoff = (task) => task.review?.handoff || reviewHandoffForTask(task, { suppressExistingFollowUp: true });
  const blocking = reviewTasks.filter(task => reviewHandoff(task)?.next_action === 'agent_review_again');
  const proofBoundaryBlocked = reviewTasks.filter(task => reviewHandoff(task)?.next_action === PROOF_BOUNDARY_BLOCKED_ACTION);
  const certified = reviewTasks.filter(task => {
    const handoff = reviewHandoff(task);
    return handoff?.next_action === 'continue_work'
      || handoff?.next_action === PROOF_BOUNDARY_BLOCKED_ACTION
      || handoff?.next_action === 'human_accept_waiting'
      || task.review?.agent_certified === true;
  });
  const limit = reviewQueueLimit(args, certified.length);
  const root = projection.workspace_root || process.cwd();
  // Green-evidence items float to the top: they are the cheapest accepts.
  const evidenceByTaskId = new Map(certified.map((task) => [task.id, extractReceiptEvidence(task.review?.proof, root)]));
  const ordered = [...certified].sort((a, b) =>
    evidenceRiskRank(evidenceByTaskId.get(b.id)) - evidenceRiskRank(evidenceByTaskId.get(a.id))
    || Number(b.updated_at || 0) - Number(a.updated_at || 0));
  const certifiedItems = ordered.slice(0, limit).map((task) => reviewQueueItem(task, root, evidenceByTaskId.get(task.id)));
  const blockedLimit = reviewQueueLimit(args, blocking.length);
  const blockedItems = blocking.slice(0, blockedLimit).map((task) => blockedReviewQueueItem(task, root));
  const items = [...certifiedItems, ...blockedItems];
  return {
    schema: 'atris.task_review_queue.v1',
    generated_at: projection.generated_at,
    workspace_root: projection.workspace_root,
    counts: {
      review: reviewTasks.length,
      certified: certified.length,
      evidence_passing: certified.filter((task) => evidenceByTaskId.get(task.id)?.all_passing).length,
      blocking: blocking.length,
      proof_boundary_blocked: proofBoundaryBlocked.length,
      shown: certifiedItems.length,
      blocking_shown: blockedItems.length,
    },
    hygiene: reviewQueueHygiene(reviewTasks),
    items,
  };
}

// ── Fast unblock: cluster the certified-pending wall so a human reviews ~15 groups, not 473 rows ──
function certifiedPendingReviewTasks(projection) {
  return (projection.tasks || [])
    .filter(task => task && task.status === 'review' && task.review && task.review.approval_status === 'pending')
    .filter(task => {
      const handoff = task.review?.handoff || reviewHandoffForTask(task, { suppressExistingFollowUp: true });
      return handoff?.next_action === 'continue_work'
        || handoff?.next_action === 'human_accept_waiting'
        || task.review?.agent_certified === true;
    });
}

function reviewGroupKey(value) {
  const v = String(value || 'tag').toLowerCase();
  return ['tag', 'owner', 'source'].includes(v) ? v : 'tag';
}

function reviewGroupValue(task, key) {
  if (key === 'owner') return String(task.claimed_by || '(unclaimed)');
  if (key === 'source') return String(task.source_key || (task.metadata && task.metadata.source) || '(no source)');
  return String(task.tag || '(untagged)');
}

function taskReviewGroups(projection, key) {
  const certified = certifiedPendingReviewTasks(projection);
  const root = projection.workspace_root || process.cwd();
  const groups = new Map();
  for (const task of certified) {
    const value = reviewGroupValue(task, key);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(task);
  }
  const list = [...groups.entries()].map(([value, tasks]) => ({
    value,
    count: tasks.length,
    evidence_passing: tasks.filter(t => extractReceiptEvidence(t.review?.proof, root)?.all_passing).length,
    sample_titles: tasks.slice(0, 3).map(t => t.title).filter(Boolean),
    oldest_updated_at: tasks.reduce((min, t) => Math.min(min, Number(t.updated_at || 0) || 0), Infinity),
    accept_group_command: `atris task accept-group ${key}=${JSON.stringify(value)} --spot-check 3`,
  })).sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
  return {
    schema: 'atris.task_review_groups.v1',
    generated_at: projection.generated_at,
    workspace_root: projection.workspace_root,
    group_by: key,
    total_certified: certified.length,
    group_count: list.length,
    groups: list,
  };
}

function taskReviewLandingLines(item) {
  if (!item?.landing) return [];
  const clean = value => value
    ? gateForHuman(value, { title: item.title }).text
    : '';
  const happened = clean(item.landing.happened);
  const reason = clean(item.landing.reason);
  const unperiod = value => value.replace(/\.$/, '');
  const checked = unperiod(clean(item.landing.checked));
  const tested = unperiod(clean(item.landing.tested));
  return [
    happened ? `   what's new: ${happened}` : '',
    reason ? `   why it matters: ${reason}` : '',
    checked ? `   checked: ${checked}${tested && tested !== checked ? `; tested: ${tested}` : ''}.` : '',
  ].filter(Boolean);
}

function cmdReviews(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  // Reviews is a view, not an execution lane. Certification and landing are
  // persisted by certify-verified, explicit receipt/ready commands, sweep,
  // and autoland; this command only reports that stored state.
  const autoAcceptView = {
    enabled: false,
    read_only: true,
    accepted_now: 0,
    accepted_since_last_look: 0,
    results: [],
  };
  const groupByRaw = flag(args, '--group-by');
  if (groupByRaw) {
    const key = reviewGroupKey(groupByRaw);
    const groups = taskReviewGroups(projection, key);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'review_groups',
        projection_path: outPath,
        autoaccept: autoAcceptView,
        groups,
      });
      return;
    }
    console.log(gateForHuman(`${numberWord(groups.total_certified)} finished things are waiting, grouped by ${key}.`).text);
    const visibleGroups = groups.groups.slice(0, reviewGroupTextLimit(args, groups.groups.length));
    visibleGroups.forEach((g, index) => {
      console.log('');
      console.log(`${index + 1}. ${g.value} - ${numberWord(g.count)} task${g.count === 1 ? '' : 's'}`);
      g.sample_titles.forEach(title => console.log(`   • ${gateForHuman(title, { title }).text}`));
      console.log(`   approve this group: ${g.accept_group_command} --confirm-human-accept --as <you>`);
    });
    if (visibleGroups.length < groups.groups.length) {
      console.log('');
      console.log(`showing ${numberWord(visibleGroups.length)} of ${numberWord(groups.groups.length)} groups; rerun with --all for every group or --limit N to adjust.`);
    }
    return;
  }
  const queue = taskReviewQueue(projection, args);
  const verbose = reviewQueueVerbose(args);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'review_queue',
      projection_path: outPath,
      autoaccept: autoAcceptView,
      queue,
    });
    return;
  }
  const approvalItems = queue.items.filter(item => item.queue_role !== 'blocked');
  const blockedItems = queue.items.filter(item => item.queue_role === 'blocked');
  if (!approvalItems.length && !blockedItems.length) {
    console.log('nothing is waiting on you. everything that finished has already landed.');
    return;
  }
  if (queue.counts.certified > 0) {
    const header = queue.counts.certified === 1
      ? 'one finished thing is waiting for your ok. it passed both checks.'
      : `${numberWord(queue.counts.certified)} finished things are waiting for your ok. all of them passed both checks.`;
    console.log(gateForHuman(header).text);
  }
  if (queue.counts.blocking > 0) {
    console.log(gateForHuman(queue.counts.blocking === 1
      ? 'one more is almost ready; a second check is still running.'
      : `${numberWord(queue.counts.blocking)} more are almost ready; second checks are still running.`).text);
  }
  approvalItems.forEach((item, index) => {
    if (index > 0) console.log('');
    const ref = item.display_id || taskRef(item.id);
    const badge = item.evidence?.any_forced
      ? ' [evidence:forced]'
      : item.evidence?.all_passing ? ' [evidence:passing]' : '';
    console.log(`${index + 1}. ${item.explanation.what_changes} (${ref})${badge}`);
    console.log(`   why it matters: ${item.explanation.why_it_matters}`);
    console.log(`   done looks like: ${item.explanation.done_looks_like}`);
    if (item.landing) {
      taskReviewLandingLines(item).forEach(line => console.log(line));
      if (verbose && item.result?.saved) console.log(`   saved: ${item.result.saved}`);
    }
    if (verbose && item.proof) console.log(`   details: ${item.proof}`);
    if (verbose && item.evidence) {
      item.evidence.receipts.forEach((receipt) => {
        const verdict = receipt.verifier_passed === true ? ' verifier:passed'
          : receipt.verifier_passed === false ? ' verifier:FAILED' : '';
        console.log(`   receipt: ${receipt.path}${verdict}`);
      });
      item.evidence.missing.forEach((missingPath) => console.log(`   receipt: ${missingPath} MISSING`));
    }
    if (verbose && item.review_chat_command) console.log(`   /codex: ${item.review_chat_command}`);
    if (item.accept_command) {
      console.log(`   say yes: atris task accept ${item.display_id || taskRef(item.id)}`);
      console.log(`   ask for a change: ${item.revise_command}`);
    } else if (item.blocked_accept_reason) {
      console.log(`   approve: blocked; ${plainLandingReason(item.blocked_accept_reason)}`);
      console.log(`   rework: ${item.revise_command}`);
    }
  });
  if (blockedItems.length > 0) {
    if (approvalItems.length > 0) console.log('');
    console.log('still being checked:');
    for (const item of blockedItems) {
      console.log(`${plainReviewBlockerMessage(item)}; next: ${item.next_command}`);
    }
  }
  if (queue.counts.shown < queue.counts.certified) {
    console.log('');
    console.log(`showing ${numberWord(queue.counts.shown)} of ${numberWord(queue.counts.certified)}; rerun with --all for every row or --verbose for proof details.`);
  }
}

function stampAcceptGroupMetadata(taskDb, db, taskId, { actor, group, verified, sampleVerifiedIds }) {
  const row = taskDb.getTask(db, taskId);
  if (!row) return;
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  metadata.accept_group = group;
  metadata.accept_group_by = actor;
  metadata.accept_group_at = new Date().toISOString();
  metadata.accepted_by_sampling = !verified;
  if (!verified) metadata.sample_verified_ids = sampleVerifiedIds;
  db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(metadata), Date.now(), taskId);
}

// Accept a whole certified cluster honestly: the human spot-checks K rows (real career XP), the rest
// are accepted-by-sampling (cleared from the backlog, provenance recorded, NO career XP, never fake XP).
function cmdAcceptGroup(args) {
  const pos = positional(args);
  const spec = pos[0];
  if (!spec || !spec.includes('=')) {
    console.error('atris task accept-group: <key>=<value> required (key = tag|owner|source, e.g. tag=self-improve)');
    process.exit(2);
  }
  const eq = spec.indexOf('=');
  const key = reviewGroupKey(spec.slice(0, eq));
  const value = spec.slice(eq + 1);
  const spotCheck = Math.max(1, Math.floor(Number(flag(args, '--spot-check')) || 3));
  const confirm = hasFlag(args, '--confirm-human-accept');
  const actor = String(flag(args, '--as') || '');
  const verifiedRaw = flag(args, '--verified');

  if (confirm && agentProofOnlyMode()) {
    failAgentProofOnly('atris task accept-group', 'Only a human can accept tasks / award XP. Leave proof in Review.');
  }

  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection } = writeDefaultProjection(taskDb, db);
  const group = certifiedPendingReviewTasks(projection).filter(task => reviewGroupValue(task, key) === value);
  if (!group.length) {
    console.error(`accept-group: no certified-pending tasks in ${key}=${value}`);
    process.exit(1);
  }
  // Deterministic sample, weakest evidence first: missing/failing receipts beat
  // prose-only proofs beat validated green evidence; id tie-break keeps the same
  // command surfacing the same rows to verify.
  const groupRoot = projection.workspace_root || process.cwd();
  const groupEvidence = new Map(group.map(task => [task.id, extractReceiptEvidence(task.review?.proof, groupRoot)]));
  const need = Math.min(spotCheck, group.length);
  const sample = [...group].sort((a, b) =>
    evidenceRiskRank(groupEvidence.get(a.id)) - evidenceRiskRank(groupEvidence.get(b.id))
    || String(a.id).localeCompare(String(b.id))).slice(0, need);

  if (!confirm) {
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'accept_group_preview',
        group: `${key}=${value}`,
        count: group.length,
        evidence_passing: group.filter(task => groupEvidence.get(task.id)?.all_passing).length,
        spot_check: sample.map(task => ({ ref: taskRef(task), id: task.id, title: task.title, proof: taskReviewClip(task.review?.proof, 240) || null, evidence: groupEvidence.get(task.id) || null })),
        verified_ids_to_paste: sample.map(task => task.id),
      });
      return;
    }
    console.log(`accept-group DRY RUN, ${key}=${value}: ${group.length} certified task(s)`);
    console.log(`Spot-check these ${need} (weakest evidence first; open + verify), then accept the whole cluster:`);
    sample.forEach((task) => {
      console.log(`  ${taskRef(task)}  ${task.title}`);
      const proof = taskReviewClip(task.review?.proof, 200);
      if (proof) console.log(`     proof: ${proof}`);
      const evidence = groupEvidence.get(task.id);
      if (evidence) {
        evidence.receipts.forEach((receipt) => {
          const verdict = receipt.verifier_passed === true ? ' verifier:passed'
            : receipt.verifier_passed === false ? ' verifier:FAILED' : '';
          console.log(`     receipt: ${receipt.path}${verdict}`);
        });
        evidence.missing.forEach((missingPath) => console.log(`     receipt: ${missingPath} MISSING`));
      }
    });
    console.log('');
    console.log(`If they hold up, accept all ${group.length} (career XP only on the ${need} you verified):`);
    console.log(`  atris task accept-group ${key}=${JSON.stringify(value)} --spot-check ${spotCheck} --confirm-human-accept --as <you> --verified ${sample.map(task => task.id).join(',')}`);
    return;
  }

  if (!actor) {
    console.error('accept-group: --as <human> required to accept');
    process.exit(2);
  }
  const verifiedInput = typeof verifiedRaw === 'string' ? verifiedRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const groupIds = new Set(group.map(task => task.id));
  const verifiedIds = new Set();
  for (const ref of verifiedInput) {
    let resolved = groupIds.has(ref) ? ref : null;
    if (!resolved) { try { resolved = requireTaskId(taskDb, db, ref, 'atris task accept-group'); } catch { resolved = null; } }
    if (resolved && groupIds.has(resolved)) verifiedIds.add(resolved);
  }
  if (verifiedIds.size < need) {
    console.error(`accept-group: spot-check requires you to verify ${need} task(s) IN this group via --verified <ids>. Got ${verifiedIds.size}.`);
    console.error('Run the same command without --confirm-human-accept to see which rows to verify.');
    process.exit(2);
  }

  const groupLabel = `${key}=${value}`;
  const accepted = [];
  for (const task of group) {
    const isVerified = verifiedIds.has(task.id);
    const proof = String(task.review?.proof || task.metadata?.latest_agent_proof || '').trim()
      || `Accepted via group spot-check (${groupLabel}); human ${actor} verified ${verifiedIds.size}/${group.length}.`;
    const missionXpIssue = missionXpEndToEndProofIssue(task, proof, task.workspace_root || taskDb.workspaceRoot());
    if (missionXpIssue) {
      accepted.push({ id: task.id, ok: false, reason: MISSION_XP_END_TO_END_REASON, detail: missionXpIssue });
      continue;
    }
    const done = taskDb.doneTask(db, {
      id: task.id,
      status: 'done',
      actor,
      allowReview: true,
      action: 'accepted',
      proof,
    });
    if (!done.updated) { accepted.push({ id: task.id, ok: false, reason: 'not_review' }); continue; }
    taskDb.reviewTask(db, {
      id: task.id,
      actor,
      reward: 1,
      lesson: String(task.review?.lesson || ''),
      nextTask: String(task.review?.next_task || ''),
      proof,
      careerXpEligible: isVerified, // honest: career XP ONLY for rows the human actually verified
    });
    stampAcceptGroupMetadata(taskDb, db, task.id, { actor, group: groupLabel, verified: isVerified, sampleVerifiedIds: [...verifiedIds] });
    accepted.push({ id: task.id, ok: true, verified: isVerified, career_xp: isVerified });
  }
  const { outPath: afterPath } = writeDefaultProjection(taskDb, db);
  const okCount = accepted.filter(a => a.ok).length;
  const verifiedCount = accepted.filter(a => a.ok && a.verified).length;
  const sampledCount = accepted.filter(a => a.ok && !a.verified).length;
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'accept_group',
      group: groupLabel,
      accepted: okCount,
      verified_career_xp: verifiedCount,
      sampled_no_career_xp: sampledCount,
      projection_path: afterPath,
      results: accepted,
    });
    return;
  }
  console.log(`accept-group ${groupLabel}: accepted ${okCount}/${group.length}`);
  console.log(`  ${verifiedCount} verified (career XP) + ${sampledCount} accepted-by-sampling (no career XP, provenance recorded)`);
}

function humanEventType(type) {
  return String(type || 'event').replace(/_/g, ' ');
}

function taskEventSummary(event) {
  const payload = event && event.payload || {};
  const raw = payload.content || payload.proof || payload.lesson || payload.title || payload.status || humanEventType(event && event.event_type);
  return clipStatusText(raw, 140);
}

function formatTaskEventCompact(event, refById = new Map()) {
  const actor = event.actor ? ` @${event.actor}` : '';
  const when = event.created_at ? new Date(Number(event.created_at)).toISOString() : '';
  return `${when}\t${event.event_type.padEnd(9)}\t${refById.get(event.task_id) || taskRef(event.task_id)}${actor}\t${taskEventSummary(event)}`;
}

function normalizedStatusPart(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function taskIsPlannedOpen(task) {
  const metadata = task && task.metadata || {};
  const tag = normalizedStatusPart(task && task.tag);
  const stage = normalizedStatusPart(metadata.stage);
  return STATUS_PLAN_TAGS.has(tag)
    || STATUS_PLAN_TAGS.has(stage)
    || Boolean(metadata.verify || metadata.goal || metadata.loop || metadata.cron || metadata.next_run_at);
}

function formatTaskLine(task) {
  if (!task) return 'none';
  const explanation = task.explanation || taskExplanation(task);
  return explanation.what_changes.replace(/\.$/, '');
}

function printStatusTask(label, task) {
  console.log(`${label.padEnd(7)} ${formatTaskLine(task)}`);
  if (!task) return;
  for (const line of approvalLines(task.approval || taskApprovalFor(task), { indent: '        ' })) console.log(line);
  const owner = task.claimed_by || taskAssignee(task);
  const ownerText = owner ? `; owner: ${owner}` : '';
  console.log(`        Technical details: atris task show ${taskRef(task)}${ownerText}`);
}

function cmdStatus(args) {
  const all = hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args);
  const history = hasFlag(args, '--history');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args, { everywhere });
  const compact = writeDefaultProjection(taskDb, db, { all, everywhere });
  const projection = history
    ? enrichTaskProjection(taskDb.taskProjection(db, {
      workspaceRoot,
      limit: all ? null : 500,
      includeHistory: true,
    }))
    : compact.projection;
  const outPath = compact.outPath;
  const hasExistingReviewFollowUp = buildReviewFollowUpChildPredicate(taskDb, db, workspaceRoot);
  const status = taskStatusSummary(projection, { history, hasExistingReviewFollowUp });
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'status',
      projection_path: outPath,
      status,
    });
    return;
  }
  console.log('TASK STATUS');
  console.log(`workspace ${status.workspace_root || '(all)'}`);
  console.log(`plan ${status.counts.plan} / do ${status.counts.do} / review ${status.counts.review} / backlog ${status.counts.backlog} / done ${status.counts.done}`);
  printStatusTask('current', status.current);
  printStatusTask('next', status.next);
  if (status.needs_review.length) {
    console.log('review');
    for (const task of status.needs_review.slice(0, 3)) printStatusTask('review', task);
  }
  if (history) console.log(`history feed ${status.swarlo.feed.length} event${status.swarlo.feed.length === 1 ? '' : 's'}`);
}

function readProjectionFile(workspaceRoot) {
  const candidatePaths = [
    workspaceRoot ? path.join(workspaceRoot, '.atris', 'state', 'tasks.projection.json') : null,
    path.resolve('.atris', 'state', 'tasks.projection.json'),
  ].filter(Boolean);
  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && Array.isArray(parsed.tasks)) return parsed;
      }
    } catch {}
  }
  return null;
}

function resolveTaskRef(taskDb, db, ref) {
  const token = String(ref || '').trim();
  if (!token) return { ok: false, reason: 'missing' };
  const exact = db ? taskDb.getTask(db, token) : null;
  if (exact) return { ok: true, id: exact.id, row: exact };
  const normalized = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(token) : token.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const wsRoot = taskDb.workspaceRoot ? taskDb.workspaceRoot() : process.cwd();

  const proj = readProjectionFile(wsRoot);
  if (proj && Array.isArray(proj.tasks)) {
    const seen = new Set();
    const matches = proj.tasks.filter(r => {
      const id = String(r.id || '').toUpperCase();
      const display = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(r.display_id) : String(r.display_id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const legacy = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(r.legacy_ref) : String(r.legacy_ref || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const matched = id.startsWith(normalized) || (display && display === normalized) || (legacy && legacy === normalized);
      if (!matched || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    if (matches.length === 1) {
      const match = matches[0];
      const row = db ? (taskDb.getTask(db, match.id) || match) : match;
      return { ok: true, id: match.id, row };
    }
    if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches };
  }

  if (db) {
    const rows = taskDb.withTaskDisplayRefs(taskDb.listTasks(db, { workspaceRoot: wsRoot }));
    const seen = new Set();
    const matches = rows.filter(r => {
      const id = String(r.id || '').toUpperCase();
      const display = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(r.display_id) : String(r.display_id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const legacy = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(r.legacy_ref) : String(r.legacy_ref || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const matched = id.startsWith(normalized) || (display && display === normalized) || (legacy && legacy === normalized);
      if (!matched || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    if (matches.length === 1) return { ok: true, id: matches[0].id, row: matches[0] };
    if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches };
  }
  return { ok: false, reason: 'not_found' };
}

function requireTaskId(taskDb, db, ref, label) {
  const resolved = resolveTaskRef(taskDb, db, ref);
  if (resolved.ok) return resolved.id;
  if (resolved.reason === 'ambiguous') {
    failTask(label, 'ambiguous', `ambiguous task id prefix "${ref}"`);
  } else if (resolved.reason === 'missing') {
    failTask(label, 'missing_id', 'task id required');
  } else {
    failTask(label, 'not_found', `task not found: ${ref}`);
  }
}

function workspaceRefRows(taskDb, db, options = {}) {
  return taskDb.listTasks(db, { workspaceRoot: scopedWorkspaceRoot(taskDb, [], options) });
}

function renderTaskDesk(rows, refRows = rows) {
  const displayRows = (rows && rows.length && rows[0].display_id) ? rows : getTaskDb().withTaskDisplayRefs(rows, refRows);
  const active = displayRows.filter(r => r.status !== 'done' && r.status !== 'archived');
  const done = displayRows.filter(r => r.status === 'done');
  if (rows.length === 0) {
    console.log('No tasks yet.');
    console.log('Start with: atris task new "Ship the smallest useful thing"');
    return;
  }
  console.log('TASK DESK');
  console.log('');
  for (const r of active.slice(0, 12)) {
    const explanation = r.explanation || taskExplanation(r);
    const owner = r.claimed_by ? ` @${r.claimed_by}` : '';
    const assigned = !r.claimed_by && taskAssignee(r) ? ` -> ${taskAssignee(r)}` : '';
    const tag = r.tag ? ` #${r.tag}` : '';
    const decision = decisionMarkerFor(r) ? ` ${decisionMarkerFor(r)}` : '';
    console.log(`What changes: ${explanation.what_changes}`);
    console.log(`        ${r.status.padEnd(7)} ${taskRef(r)}${owner}${assigned}${tag}${decision}`);
    console.log(`        Why it matters: ${explanation.why_it_matters}`);
    console.log(`        Done looks like: ${explanation.done_looks_like}`);
    for (const line of approvalLines(taskApprovalFor(r), { indent: '        ' })) console.log(line);
    console.log(`        Technical details: ${compactTechnicalDetails(r)}`);
  }
  if (active.length === 0) console.log('clear   no active tasks');
  console.log('');
  console.log(`active ${active.length} / done ${done.length}`);
  console.log(`next: ${deskNextCommand(displayRows, personName())}`);
}

function cmdAdd(args) {
  const root = process.cwd();
  // Empty folder talks like bare atris. A leftover title is not a
  // task desk. After init, a title still files.
  if (isUninitializedTaskFolder(root)) {
    if (wantsJson(args)) {
      printJson({
        ok: false,
        action: 'none',
        command: firstTalkCommand(folderName(root)),
        task_id: null,
        projection_path: null,
        task: null,
      });
      return;
    }
    return speakFirstMinute({ root, fresh: true });
  }
  const pos = positional(args);
  const title = pos.join(' ').trim();
  if (!title) {
    failTask('atris task add', 'missing_title', 'title required');
  }
  const tag = flag(args, '--tag');
  const goalId = flag(args, '--goal-id');
  const goalObjective = flag(args, '--goal-objective') || flag(args, '--goal');
  const verify = flag(args, '--verify');
  const metadata = {};
  if (goalId && goalId !== true) metadata.goal_id = String(goalId);
  if (goalObjective && goalObjective !== true) {
    metadata.task_goal = String(goalObjective);
    metadata.goal_objective = String(goalObjective);
  }
  if (typeof verify === 'string' && verify.trim()) metadata.verify = verify.trim();
  Object.assign(metadata, explanationFlags(args));
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot();
  const operatorTitleWarning = warnIfTaskTitleNeedsOperatorWhy(title);
  // Generation throttle, the named root cause is generation > human-review rate. An AGENT cannot keep
  // minting tasks while a wall of certified-but-unaccepted work waits; that treadmill is what accept-group
  // only drains. Humans and --force bypass. Closes the tap instead of just enlarging the bucket.
  if (agentProofOnlyMode() && !hasFlag(args, '--force')) {
    const { projection: backlogProjection } = writeDefaultProjection(taskDb, db);
    const pending = certifiedPendingReviewTasks(backlogProjection).length;
    const cap = Math.max(1, Number(process.env.ATRIS_TASK_BACKLOG_CAP || 200) || 200);
    if (pending >= cap) {
      failTask('atris task add', 'backlog_throttle', `refusing agent add: ${pending} certified task(s) await human review (cap ${cap}). Drain with 'atris task accept-group' or pass --force.`);
    }
  }
  const result = taskDb.addTask(db, {
    title,
    tag: typeof tag === 'string' ? tag : null,
    workspaceRoot: ws,
    metadata: Object.keys(metadata).length ? metadata : null,
  });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const task = compactTaskFromProjection(projection, result.id);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'created',
      task_id: result.id,
      inserted: result.inserted !== false,
      operator_title_warning: operatorTitleWarning,
      projection_path: outPath,
      task,
    });
    return;
  }
  console.log(`${taskRef(task)}\t${title}`);
}

function delegateHandoff(task, owner, via, tag) {
  const ref = taskRef(task);
  const handoff = {
    command: `atris task claim ${ref} --as ${owner}`,
  };
  if (via === 'swarlo') {
    handoff.swarlo = {
      task_key: task.id,
      action: 'claim',
      channel: tag || 'tasks',
      assignee: owner,
    };
  }
  return handoff;
}

function delegateTask(args, options = {}) {
  const pos = positional(args);
  const title = pos.join(' ').trim();
  if (!title) {
    failTask('atris task delegate', 'missing_title', 'title required');
  }
  const viaFlag = flag(args, '--via');
  const via = viaFlag === 'swarlo' ? 'swarlo' : 'local';
  const tag = flag(args, '--tag');
  const note = flag(args, '--note');
  const goalId = flag(args, '--goal-id');
  const goalObjective = flag(args, '--goal-objective') || flag(args, '--goal');
  const verify = flag(args, '--verify');
  const claimNow = hasFlag(args, '--claim');
  const requestedOwner = flag(args, '--to') || flag(args, '--as');
  const explicitExecutedBy = flag(args, '--executed-by');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot();
  const operatorTitleWarning = warnIfTaskTitleNeedsOperatorWhy(title, { print: options.warnOperatorTitle !== false });
  const ownerResolution = resolveFunctionalTaskOwner({
    requestedOwner: requestedOwner && requestedOwner !== true ? requestedOwner : null,
    title,
    tag,
    note,
    goal: goalObjective && goalObjective !== true ? goalObjective : '',
    root: ws,
  });
  const owner = ownerResolution.owner;
  const executedBy = explicitExecutedBy && explicitExecutedBy !== true
    ? normalizeOwnerSlug(explicitExecutedBy)
    : ownerResolution.executed_by;
  const metadata = {
    assigned_to: owner,
    delegate_via: via,
    swarlo_channel: via === 'swarlo' ? String(tag || 'tasks') : null,
    created_for_day: new Date().toISOString().slice(0, 10),
    owner_resolution: ownerResolution.reason,
  };
  if (ownerResolution.requested_owner) metadata.requested_owner = ownerResolution.requested_owner;
  if (executedBy) metadata.executed_by = executedBy;
  if (ownerResolution.proposed_member) {
    metadata.proposed_member = ownerResolution.proposed_member;
    metadata.proposed_member_command = `atris member create ${ownerResolution.proposed_member} --role="${ownerResolution.proposed_member.replace(/-/g, ' ')}"`;
  }
  if (goalId && goalId !== true) metadata.goal_id = String(goalId);
  if (goalObjective && goalObjective !== true) {
    metadata.task_goal = String(goalObjective);
    metadata.goal_objective = String(goalObjective);
  }
  if (typeof verify === 'string' && verify.trim()) metadata.verify = verify.trim();
  Object.assign(metadata, explanationFlags(args));
  const result = taskDb.addTask(db, {
    title,
    tag: typeof tag === 'string' ? tag : null,
    workspaceRoot: ws,
    status: claimNow ? 'claimed' : 'open',
    claimedBy: claimNow ? owner : null,
    metadata,
  });
  if (typeof note === 'string' && note.trim()) {
    taskDb.noteTask(db, { id: result.id, actor: DEFAULT_OWNER, content: note });
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const task = compactTaskFromProjection(projection, result.id);
  const handoff = delegateHandoff(task, owner, via, typeof tag === 'string' ? tag : null);
  return {
    ok: true,
    action: 'delegated',
    task_id: result.id,
    inserted: result.inserted !== false,
    owner,
    owner_resolution: ownerResolution,
    executed_by: executedBy || null,
    via,
    tag: typeof tag === 'string' ? tag : null,
    handoff,
    proposed_member_command: metadata.proposed_member_command || null,
    operator_title_warning: operatorTitleWarning,
    projection_path: outPath,
    task,
  };
}

function cmdDelegate(args) {
  const payload = delegateTask(args);
  if (wantsJson(args)) {
    printJson(payload);
    return;
  }
  const tagText = payload.tag ? ` #${payload.tag}` : '';
  console.log(`delegated ${taskRef(payload.task)} -> ${payload.owner}${tagText} via=${payload.via}`);
  if (payload.executed_by) console.log(`executed_by: ${payload.executed_by}`);
  if (payload.proposed_member_command) console.log(`member: ${payload.proposed_member_command}`);
  console.log(`claim: ${payload.handoff.command}`);
  if (payload.handoff.swarlo) console.log(`swarlo: ${payload.handoff.swarlo.channel}/${payload.handoff.swarlo.action}`);
}

// Failed tasks older than this stop earning a daily owner-group row;
// they collapse into one stale summary line instead (target state = clean day view).
const DAY_STALE_FAILED_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_TEXT_TASK_LIMIT = 8;

function taskDayTextGroups(groups, { full = false } = {}) {
  if (full) return { groups, hiddenTasks: 0, hiddenOwners: 0 };
  const statusOrder = { claimed: 0, open: 1, review: 2, failed: 3, done: 4 };
  const ranked = groups
    .flatMap((group) => group.tasks)
    .sort((a, b) => ((statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5))
      || ((b.updated_at || 0) - (a.updated_at || 0)));
  const selected = new Set(ranked.slice(0, DAY_TEXT_TASK_LIMIT));
  const visibleGroups = groups
    .map((group) => ({ ...group, tasks: group.tasks.filter((task) => selected.has(task)) }))
    .filter((group) => group.tasks.length > 0);
  return {
    groups: visibleGroups,
    hiddenTasks: Math.max(0, ranked.length - selected.size),
    hiddenOwners: Math.max(0, groups.length - visibleGroups.length),
  };
}

function taskDayTitle(title, maxLength = 120) {
  const text = String(title || '').replace(/\s*[\u2014\u2013]\s*/g, ' - ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const sentence = text.slice(0, maxLength + 1).match(/^(.{48,}?[.!?])(?:\s|$)/);
  if (sentence) return sentence[1];
  const clipped = text.slice(0, maxLength).replace(/\s+\S*$/, '').trim();
  return `${clipped || text.slice(0, maxLength).trim()}...`;
}

function compactTechnicalDetails(task, formatTitle = value => value) {
  const explanation = task.explanation || taskExplanation(task);
  return explanation.sources && explanation.sources.what_changes === 'derived'
    ? `atris task show ${taskRef(task)}`
    : formatTitle(task.title);
}

function taskDayGroups(tasks, { now = Date.now() } = {}) {
  const active = tasks.filter(task => task.status !== 'done');
  const staleFailed = [];
  const visible = [];
  for (const task of active) {
    const isStaleFailed = task.status === 'failed' && (now - (task.updated_at || 0)) > DAY_STALE_FAILED_MS;
    if (isStaleFailed) staleFailed.push(task);
    else visible.push(task);
  }
  const groups = new Map();
  for (const task of visible) {
    const owner = taskAssignee(task) || 'unassigned';
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(task);
  }
  const grouped = Array.from(groups.entries())
    .sort((a, b) => {
      if (a[0] === 'unassigned') return 1;
      if (b[0] === 'unassigned') return -1;
      return a[0].localeCompare(b[0]);
    })
    .map(([owner, ownerTasks]) => ({
      owner,
      tasks: ownerTasks.sort((a, b) => {
        const statusOrder = { claimed: 0, open: 1, failed: 2, done: 3 };
        return (statusOrder[a.status] - statusOrder[b.status]) || (b.updated_at - a.updated_at);
      }),
    }));
  return { groups: grouped, staleFailed };
}

function cmdDay(args) {
  const all = hasFlag(args, '--all');
  const full = hasFlag(args, '--full');
  const everywhere = taskScopeEverywhere(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection, outPath } = writeDefaultProjection(taskDb, db, { all, everywhere });
  const { groups, staleFailed } = taskDayGroups(projection.tasks || []);
  const counts = {
    active: groups.reduce((sum, group) => sum + group.tasks.length, 0),
    owners: groups.length,
    open: (projection.tasks || []).filter(task => task.status === 'open').length,
    claimed: (projection.tasks || []).filter(task => task.status === 'claimed').length,
    review: (projection.tasks || []).filter(task => task.status === 'review').length,
    failed: (projection.tasks || []).filter(task => task.status === 'failed').length,
    stale_failed: staleFailed.length,
  };
  const date = new Date().toISOString().slice(0, 10);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'day',
      date,
      projection_path: outPath,
      counts,
      groups,
      stale_failed: {
        count: staleFailed.length,
        refs: staleFailed.map(task => taskRef(task)),
      },
    });
    return;
  }
  const textView = taskDayTextGroups(groups, { full });
  console.log('task day');
  const failedText = counts.failed > 0 ? ` / failed ${counts.failed}` : '';
  console.log(`${date}  active ${counts.active} / owners ${counts.owners} / review ${counts.review}${failedText}`);
  console.log('');
  if (!groups.length) {
    console.log('clear   no active tasks');
  }
  for (const group of textView.groups) {
    console.log(`${group.owner}`);
    for (const task of group.tasks) {
      const explanation = task.explanation || taskExplanation(task);
      const tag = task.tag ? ` #${task.tag}` : '';
      const claim = task.claimed_by ? ` @${task.claimed_by}` : '';
      const decision = decisionMarkerFor(task) ? ` ${decisionMarkerFor(task)}` : '';
      console.log(`  What changes: ${explanation.what_changes}`);
      console.log(`          ${task.status.padEnd(7)} ${taskRef(task)}${claim}${tag}${decision}`);
      console.log(`          Why it matters: ${explanation.why_it_matters}`);
      console.log(`          Done looks like: ${explanation.done_looks_like}`);
      for (const line of approvalLines(task.approval || taskApprovalFor(task), { indent: '          ' })) console.log(line);
      console.log(`          Technical details: ${compactTechnicalDetails(task, taskDayTitle)}`);
    }
  }
  if (textView.hiddenTasks > 0) {
    console.log('');
    const ownerText = textView.hiddenOwners > 0 ? `, ${textView.hiddenOwners} owners not shown` : '';
    console.log(`more    ${textView.hiddenTasks} active rows hidden${ownerText} - atris task day --full`);
  }
  if (staleFailed.length) {
    console.log('');
    console.log(`stale   ${staleFailed.length} failed >7d hidden - atris task list --status failed`);
  }
  console.log('');
  console.log('add: atris task delegate "..." --to task-planner --tag tasks');
}

function cmdFirstMinute() {
  const root = process.cwd();
  const fresh = !fs.existsSync(path.join(root, 'atris'));
  let context = {};
  if (!fresh) {
    try {
      context = loadContext(root);
    } catch {
      context = {};
    }
  }
  const screen = buildFirstMinute({
    root,
    fresh,
    context,
  });
  console.log(screen.text);
}

function cmdHome(args) {
  const all = hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args, { everywhere });
  const rows = taskDb.listTasks(db, {
    workspaceRoot,
    limit: all ? null : 200,
  });
  let projection;
  let outPath;
  const existingProj = readProjectionFile(workspaceRoot);
  if (rows.length === 0 && existingProj && Array.isArray(existingProj.tasks) && existingProj.tasks.length > 0) {
    projection = existingProj;
    outPath = path.resolve(path.join(workspaceRoot || '.', '.atris', 'state', 'tasks.projection.json'));
  } else {
    const written = writeDefaultProjection(taskDb, db, { all, everywhere });
    projection = written.projection;
    outPath = written.outPath;
  }
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'desk',
      projection_path: outPath,
      active_count: projection.tasks.filter(t => t.status !== 'done').length,
      done_count: projection.tasks.filter(t => t.status === 'done').length,
      projection,
    });
    return;
  }
  renderTaskDesk(projection.tasks);
}

function cmdList(args) {
  const all = hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args);
  const status = flag(args, '--status');
  const scope = taskQueueScopeFromArgs(args);
  const scoped = !taskQueueScopeIsEmpty(scope);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args, { everywhere });
  const rawRows = taskDb.listTasks(db, {
    workspaceRoot,
    status: typeof status === 'string' ? status : null,
    limit: scoped || all ? null : 200,
  });
  const rows = filterTasksByScope(rawRows, scope);
  const displayRows = taskDb.withTaskDisplayRefs(rows, workspaceRefRows(taskDb, db, { everywhere }));
  if (wantsJson(args)) {
    const tasks = displayRows.map(task => ({
      ...task,
      explanation: taskExplanation(task),
      approval: taskApprovalFor(task),
    }));
    printJson({ ok: true, action: 'list', scope: normalizeTaskQueueScope(scope), tasks });
    return;
  }
  if (rows.length === 0) {
    const scopeText = formatTaskQueueScope(scope);
    console.log(scopeText ? `(no tasks for ${scopeText})` : '(no tasks)');
    return;
  }
  for (const r of displayRows) {
    const explanation = taskExplanation(r);
    const claim = r.claimed_by ? ` [${r.claimed_by}]` : '';
    const tag = r.tag ? ` #${r.tag}` : '';
    const decision = decisionMarkerFor(r) ? ` ${decisionMarkerFor(r)}` : '';
    console.log(`What changes: ${explanation.what_changes}`);
    console.log(`         ${r.status.padEnd(8)} ${taskRef(r)}${claim}${tag}${decision}`);
    console.log(`         Why it matters: ${explanation.why_it_matters}`);
    console.log(`         Done looks like: ${explanation.done_looks_like}`);
    for (const line of approvalLines(taskApprovalFor(r), { indent: '         ' })) console.log(line);
    console.log(`         Technical details: ${compactTechnicalDetails(r)}`);
  }
}

// judge != worker support: reserved system names (autoland-verifier and co)
// can never be assumed via --as, and unknown names warn by default or fail
// under ATRIS_ACTOR_VALIDATION=enforce. Only explicit --as values are
// checked; the DEFAULT_OWNER fallback stays silent.
function guardExplicitActor(command, value) {
  if (typeof value !== 'string' || !value.trim()) return;
  const check = reviewIntegrity.validateActor(value, { root: process.cwd() });
  if (!check.ok) {
    if (check.reason === 'reserved_actor') {
      console.error(`${command}: reserved_actor: '${value}' is a system actor and cannot be used with --as`);
    } else {
      console.error(`${command}: actor_not_on_roster: '${value}' is not a workspace member or engine (actor validation is enforced)`);
    }
    process.exit(1);
  }
  if (check.reason === 'actor_not_on_roster' && check.mode === 'warn') {
    console.error(`Warning: '${value}' is not a workspace member or engine; reviews under unknown names weaken the audit trail.`);
  }
}

// A claim against an already-done task burns a whole dispatch when a
// rendered view (atris/TODO.md) is stale: the agent claims, builds, then
// discovers the work was already done. Point straight at a real open task
// instead of just reporting the failure, straight from the live projection
// (never the rendered file), preferring the same tag when one is open.
function suggestNextClaimableTask(projection, { excludeId = null, tag = '' } = {}) {
  // Decision rows (needs-human / decision) belong to a human. Autonomous
  // recovery after already_done must not hand an agent a judgment call.
  const open = (projection && projection.tasks || []).filter((t) => (
    t && t.status === 'open' && t.id !== excludeId && !isDecisionTask(t)
  ));
  if (!open.length) return null;
  const normalizedTag = String(tag || '').trim().toLowerCase();
  if (normalizedTag) {
    const sameTag = open.find((t) => String(t.tag || '').trim().toLowerCase() === normalizedTag);
    if (sameTag) return sameTag;
  }
  return open[0];
}

function cmdClaim(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task claim', 'missing_id', 'id required');
  }
  guardExplicitActor('atris task claim', flag(args, '--as'));
  const owner = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task claim');
  const result = taskDb.claimTask(db, { id: taskId, claimedBy: String(owner) });
  if (result.claimed) {
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'claimed',
        task_id: taskId,
        owner: String(owner),
        projection_path: outPath,
        task: compactTaskFromProjection(projection, taskId),
      });
      return;
    }
    const ref = taskRef(compactTaskFromProjection(projection, taskId));
    console.log(`claimed ${ref} as ${owner}`);
    console.log(`Next: make the change, then run: atris task ready ${ref} --verify "git diff --check" --result "<who can do what now and why>" --landing "<what someone can do now>"`);
    console.log('Use a different verifier only if autoland can rerun it, such as `node --test <file>`.');
    console.log('Then: atris autoland tick');
  } else {
    const recoveryCommand = result.reason === 'already_claimed' && result.claimed_by
      ? `atris task release ${id} --as ${result.claimed_by}`
      : null;
    let nextClaimable = null;
    if (result.reason === 'already_done') {
      const doneRow = taskDb.getTask(db, taskId);
      const { projection } = writeDefaultProjection(taskDb, db);
      nextClaimable = suggestNextClaimableTask(projection, { excludeId: taskId, tag: doneRow && doneRow.tag });
    }
    if (wantsJson(args)) {
      printJson({
        ok: false,
        command: 'atris task claim',
        reason: result.reason,
        claimed_by: result.claimed_by || null,
        recovery_command: recoveryCommand,
        next_claimable: nextClaimable ? { id: nextClaimable.id, ref: taskRef(nextClaimable), tag: nextClaimable.tag || null, title: nextClaimable.title } : null,
        detail: `claim failed: ${result.reason}${result.claimed_by ? ` (held by ${result.claimed_by})` : ''}`,
      });
      process.exit(1);
    }
    console.error(`claim failed: ${result.reason}${result.claimed_by ? ` (held by ${result.claimed_by})` : ''}`);
    if (recoveryCommand) console.error(`Recovery: ${recoveryCommand}`);
    if (nextClaimable) {
      console.error(`next claimable: ${taskRef(nextClaimable)} ${String(nextClaimable.title || '').slice(0, 80)} (atris task claim ${taskRef(nextClaimable)} --as ${owner})`);
    }
    process.exit(1);
  }
}

function cmdRelease(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task release', 'missing_id', 'id required');
  }
  const owner = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task release');
  const result = taskDb.releaseTask(db, { id: taskId, actor: String(owner) });
  if (result.released) {
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    const task = compactTaskFromProjection(projection, taskId);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'released',
        task_id: taskId,
        owner: String(owner),
        projection_path: outPath,
        task,
        event_version: result.event && result.event.version || null,
      });
      return;
    }
    console.log(`released ${taskRef(task)} from ${owner}`);
    console.log(`Next: atris task next --as ${owner}`);
    return;
  }
  if (wantsJson(args)) {
    printJson({
      ok: false,
      command: 'atris task release',
      reason: result.reason,
      claimed_by: result.claimed_by || null,
      detail: `release failed: ${result.reason}${result.claimed_by ? ` (held by ${result.claimed_by})` : ''}`,
    });
    process.exit(1);
  }
  console.error(`release failed: ${result.reason}${result.claimed_by ? ` (held by ${result.claimed_by})` : ''}`);
  process.exit(1);
}

function liveTaskWithTitle(tasks, title) {
  const wanted = String(title || '').trim().toLowerCase();
  if (!wanted) return null;
  return (tasks || []).find(task => {
    const taskTitle = String(task.title || task.task || '').trim().toLowerCase();
    const status = String(task.status || '').toLowerCase();
    return taskTitle === wanted && !new Set(['done', 'accepted', 'failed']).has(status);
  }) || null;
}

function readEndgameAgentAction(root, owner, { tasks = [] } = {}) {
  const todoPath = path.join(root || process.cwd(), 'atris', 'TODO.md');
  if (!fs.existsSync(todoPath)) return null;
  const content = fs.readFileSync(todoPath, 'utf8');
  const section = extractTodoSectionMarkdown(content, 'Endgame');
  if (!section) return null;
  const slug = (section.match(/\*\*Slug:\*\*\s*([^\n]+)/i)?.[1] || '').trim();
  const horizon = (section.match(/\*\*Horizon:\*\*\s*([^\n]+)/i)?.[1] || '').trim();
  if (!slug && !horizon) return null;
  const member = String(owner || DEFAULT_OWNER);
  const taskSeed = buildEndgameTaskSeed({ slug, horizon, owner: member });
  const existing = liveTaskWithTitle(tasks, taskSeed.title);
  if (existing) return null;
  return {
    kind: 'create_bounded_endgame_task',
    endgame_slug: slug || null,
    horizon: horizon || null,
    task_seed: taskSeed,
    command: `atris brain activate --member ${member} --root . --verify`,
    message: `Create the next bounded task from Endgame${slug ? ` ${slug}` : ''}${horizon ? `: ${horizon}` : ''}. Do not accept XP.`,
  };
}

function shellQuoteTaskArg(value) {
  const s = String(value || '');
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildEndgameTaskSeed({ slug, horizon, owner }) {
  const combined = `${slug || ''} ${horizon || ''}`.toLowerCase();
  const runnerEndgame = /\b(runner|heartbeat|autopilot\/run|claude -p|model retirement|runner swap)\b/.test(combined);
  const title = runnerEndgame
    ? 'Audit and close next runner-agnostic heartbeat gap'
    : `Advance Endgame ${slug || 'current horizon'}`;
  const tag = runnerEndgame ? 'runner' : 'endgame';
  const files = runnerEndgame
    ? ['commands/autopilot.js', 'commands/run.js', 'lib/runner-command.js', 'test/autopilot-runner-model.test.js']
    : ['atris/TODO.md', 'atris/MAP.md'];
  const verifier = runnerEndgame
    ? 'node --test test/autopilot-runner-model.test.js test/runner-command.test.js'
    : 'git diff --check';
  const stopRule = 'Move proof-ready work to Review; do not accept XP.';
  const goal = runnerEndgame
    ? 'Find and close one remaining runner-agnostic heartbeat gap, or record proof that the next gap is documentation/state only.'
    : `Move the Endgame forward with one bounded, verifiable slice${horizon ? `: ${horizon}` : ''}.`;
  const note = `Goal: ${goal} Files: ${files.join(', ')}. Done: one scoped Endgame slice is implemented or the audited gap is closed with proof. Check: ${verifier}; git diff --check. Stop: ${stopRule}`;
  return {
    title,
    tag,
    files,
    verifier,
    stop_rule: stopRule,
    create_command: `atris task new ${shellQuoteTaskArg(title)} --tag ${shellQuoteTaskArg(tag)}`,
    claim_command: `atris task claim <id> --as ${shellQuoteTaskArg(owner || DEFAULT_OWNER)}`,
    note,
    note_command: `atris task note <id> ${shellQuoteTaskArg(note)}`,
  };
}

function createEndgameSeedTask(taskDb, db, seed, owner) {
  const taskOwner = String(owner || DEFAULT_OWNER);
  const operatorTitleWarning = warnIfTaskTitleNeedsOperatorWhy(seed.title);
  const result = taskDb.addTask(db, {
    title: seed.title,
    tag: seed.tag,
    workspaceRoot: taskDb.workspaceRoot(),
    metadata: {
      generated_from: 'task_next_endgame_seed',
      verifier: seed.verifier,
      files: seed.files,
      stop_rule: seed.stop_rule,
    },
  });
  const claim = taskDb.claimTask(db, { id: result.id, claimedBy: taskOwner });
  if (!claim.claimed) {
    return { ok: false, reason: claim.reason || 'claim_failed', task_id: result.id };
  }
  const note = taskDb.noteTask(db, { id: result.id, actor: taskOwner, content: seed.note });
  if (!note.noted) {
    return { ok: false, reason: note.reason || 'note_failed', task_id: result.id };
  }
  return {
    ok: true,
    task_id: result.id,
    inserted: result.inserted !== false,
    operator_title_warning: operatorTitleWarning,
    note_version: note.event.version,
  };
}

function nextActionFromCommand(command) {
  const text = String(command || '').trim();
  const match = text.match(/^atris (?:task|mission) (\S+)/);
  const verb = match ? match[1] : '';
  if (verb && verb !== 'new') return verb;
  if (/^atris do\b/.test(text)) return 'do';
  return 'none';
}

function cmdNextTruth(args) {
  const owner = flag(args, '--as') || personName() || DEFAULT_OWNER;
  const scope = taskQueueScopeFromArgs(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot();
  const rows = taskDb.listTasks(db, { workspaceRoot, limit: 500 });
  const existingProj = readProjectionFile(workspaceRoot);
  const dbHasActionable = rows.some((task) => {
    const status = task && task.status;
    return status === 'open' || status === 'claimed' || status === 'review';
  });
  const projHasActionable = Boolean(
    existingProj
    && Array.isArray(existingProj.tasks)
    && existingProj.tasks.some((task) => {
      const status = task && task.status;
      return status === 'open' || status === 'claimed' || status === 'review';
    }),
  );
  let projection;
  let outPath;
  if (!dbHasActionable && projHasActionable) {
    projection = existingProj;
    outPath = path.resolve(path.join(workspaceRoot || '.', '.atris', 'state', 'tasks.projection.json'));
  } else if (rows.length === 0 && existingProj && Array.isArray(existingProj.tasks) && existingProj.tasks.length > 0) {
    projection = existingProj;
    outPath = path.resolve(path.join(workspaceRoot || '.', '.atris', 'state', 'tasks.projection.json'));
  } else {
    const written = writeDefaultProjection(taskDb, db);
    projection = written.projection;
    outPath = written.outPath;
  }
  const scoped = filterTasksByScope(projection.tasks || [], scope);
  const openDecisions = scoped.filter((task) => task && isDecisionTask(task) && task.status === 'open');
  const actionable = scoped.filter((task) => task && !isDecisionTask(task));
  const picked = pickNext({ tasks: actionable, person: owner });
  const command = picked.task ? (picked.command || taskCommand(picked.task, owner)) : taskNextCommand(actionable, owner);
  const task = picked.task || null;

  if (!task && openDecisions.length) {
    if (wantsJson(args)) {
      printJson({
        ok: false,
        action: 'refused',
        reason: DECISION_REFUSE_REASON,
        skipped_decision_count: openDecisions.length,
        owner: String(owner),
        scope: normalizeTaskQueueScope(scope),
        projection_path: outPath,
      });
      process.exit(1);
    }
    console.error(DECISION_REFUSE_REASON);
    process.exit(1);
  }

  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: nextActionFromCommand(command),
      command,
      task_id: task ? task.id : null,
      owner: String(owner),
      scope: normalizeTaskQueueScope(scope),
      projection_path: outPath,
      task: task ? compactTaskFromProjection(projection, task.id) : null,
    });
    return;
  }

  if (!task) {
    console.log(noOpenTasksMessage(scope));
    console.log(`next: ${command}`);
    return;
  }
  console.log(`next: ${command}`);
}

function isUninitializedTaskFolder(cwd = process.cwd()) {
  const workspace = getTaskDb().workspaceRoot(cwd);
  if (fs.existsSync(path.join(workspace, 'atris'))) return false;
  const existing = readProjectionFile(workspace);
  return !(existing && Array.isArray(existing.tasks) && existing.tasks.length > 0);
}

function cmdNext(args) {
  const root = process.cwd();
  // Empty folder talks like bare atris. Walk up like the task db so a
  // project subdir stays in the room; stop before inheriting /tmp.
  // A leftover projection with live tasks still names that work.
  if (isUninitializedTaskFolder(root)) {
    if (wantsJson(args)) {
      printJson({
        ok: false,
        action: 'none',
        command: firstTalkCommand(folderName(root)),
        task_id: null,
        owner: String(flag(args, '--as') || personName() || DEFAULT_OWNER),
        scope: normalizeTaskQueueScope(taskQueueScopeFromArgs(args)),
        projection_path: null,
        task: null,
      });
      return;
    }
    return speakFirstMinute({ root, fresh: true });
  }
  if (!hasFlag(args, '--create-next')) return cmdNextTruth(args);
  const owner = flag(args, '--as') || DEFAULT_OWNER;
  const scope = taskQueueScopeFromArgs(args);
  const scoped = !taskQueueScopeIsEmpty(scope);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const claimed = filterTasksByScope(taskDb.listTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
    status: 'claimed',
    claimedBy: String(owner),
    limit: scoped ? null : 1,
  }), scope);
  if (claimed.length) {
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'current',
        task_id: claimed[0].id,
        owner: String(owner),
        scope: normalizeTaskQueueScope(scope),
        projection_path: outPath,
        task: compactTaskFromProjection(projection, claimed[0].id),
      });
      return;
    }
    console.log(`current ${taskRef(compactTaskFromProjection(projection, claimed[0].id))} @${owner}`);
    console.log(claimed[0].title);
    return;
  }
  const reviewProjection = writeDefaultProjection(taskDb, db);
  const reviewTasks = filterTasksByScope(reviewProjection.projection.tasks || [], scope)
    .map(compactTaskForStatus)
    .filter(task => task && task.review && task.review.handoff);
  const openAll = filterTasksByScope(taskDb.listTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
    status: 'open',
    limit: scoped ? null : 50,
  }), scope);
  const open = openAll.filter((task) => !isDecisionTask(task));
  const skippedDecisions = openAll.length - open.length;
  if (!open.length) {
    const { projection, outPath } = reviewProjection;
    if (skippedDecisions > 0 && !reviewTasks.length) {
      if (wantsJson(args)) {
        printJson({
          ok: false,
          action: 'refused',
          reason: DECISION_REFUSE_REASON,
          skipped_decision_count: skippedDecisions,
          owner: String(owner),
          scope: normalizeTaskQueueScope(scope),
          projection_path: outPath,
        });
        process.exit(1);
      }
      console.error(DECISION_REFUSE_REASON);
      process.exit(1);
    }
    const reviewTask = reviewTasks.find(task => task.review.handoff.next_action === 'agent_review_again')
      || reviewTasks.find(task => task.review.handoff.next_action === 'continue_work')
      || reviewTasks.find(task => task.review.handoff.next_action === 'human_accept_waiting');
    if (reviewTask) {
      const handoff = reviewTask.review.handoff;
      const continueWorkCommand = handoff.next_action === 'continue_work'
        ? continueWorkCommandForTask(reviewTask, { owner })
        : null;
      const nextAgentAction = handoff.next_action === 'human_accept_waiting' && !scoped
        ? readEndgameAgentAction(taskDb.workspaceRoot(), owner, { tasks: projection.tasks || [] })
        : null;
      if (hasFlag(args, '--create-next')) {
        if (!nextAgentAction || !nextAgentAction.task_seed) {
          failTask('atris task next', 'no_create_next_seed', 'no concrete Endgame seed is available to create');
        }
        const created = createEndgameSeedTask(taskDb, db, nextAgentAction.task_seed, owner);
        if (!created.ok) {
          failTask('atris task next', created.reason || 'create_next_failed', `failed to create next task: ${created.reason || 'unknown'}`);
        }
        const { projection: createdProjection, outPath: createdOutPath } = writeDefaultProjection(taskDb, db);
        const createdTask = compactTaskFromProjection(createdProjection, created.task_id);
        if (wantsJson(args)) {
          printJson({
            ok: true,
            action: 'created_next',
            task_id: created.task_id,
            owner: String(owner),
            scope: normalizeTaskQueueScope(scope),
            projection_path: createdOutPath,
            handoff,
            next_agent_action: nextAgentAction,
            note_version: created.note_version,
            operator_title_warning: created.operator_title_warning || null,
            task: createdTask,
            review_task: reviewTask,
          });
          return;
        }
        console.log(`created ${taskRef(createdTask)} @${owner}`);
        console.log(createdTask.title);
        console.log(`Noted v${created.note_version}. Landing remains pending on ${taskRef(reviewTask)}.`);
        console.log(`Verify: ${nextAgentAction.task_seed.verifier}`);
        return;
      }
      if (wantsJson(args)) {
        printJson({
          ok: true,
          action: handoff.next_action,
          task_id: handoff.next_action === 'continue_work' ? null : reviewTask.id,
          owner: String(owner),
          scope: normalizeTaskQueueScope(scope),
          projection_path: outPath,
          handoff,
          next_agent_action: nextAgentAction,
          continue_work_command: continueWorkCommand,
          continue_work_api: continueWorkCommand ? { method: 'POST', path: `/api/tasks/${encodeURIComponent(reviewTask.id)}/continue-work` } : null,
          review_task: reviewTask,
        });
        return;
      }
      console.log(noOpenTasksMessage(scope));
      console.log(handoff.next_action === 'agent_review_again'
        ? `${taskRef(reviewTask)} needs one more agent check before approval.`
        : `${taskRef(reviewTask)} is ready for approval.`);
      console.log(handoff.next_action === 'continue_work'
        ? 'Continue work elsewhere; XP is awarded only after the human approves this task.'
        : handoff.next_action === 'human_accept_waiting'
        ? (nextAgentAction ? nextAgentAction.message : 'No next agent task is attached; this task is ready for human approval.')
        : 'Review this task again before continuing.');
      if (nextAgentAction) console.log(`Command: ${nextAgentAction.command}`);
      if (nextAgentAction && nextAgentAction.task_seed) {
        console.log(`Create: ${nextAgentAction.task_seed.create_command}`);
        console.log(`Claim: ${nextAgentAction.task_seed.claim_command}`);
        console.log(`Note: ${nextAgentAction.task_seed.note_command}`);
        console.log(`Verify: ${nextAgentAction.task_seed.verifier}`);
      }
      if (continueWorkCommand) console.log(`Command: ${continueWorkCommand}`);
      return;
    }
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'none',
        task_id: null,
        owner: String(owner),
        scope: normalizeTaskQueueScope(scope),
        projection_path: outPath,
      });
      return;
    }
    console.log(noOpenTasksMessage(scope));
    console.log('Start with: atris task new "..."');
    return;
  }
  const result = taskDb.claimTask(db, { id: open[0].id, claimedBy: String(owner) });
  if (!result.claimed) {
    console.error(`next failed: ${result.reason}`);
    process.exit(1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'next',
      task_id: open[0].id,
      owner: String(owner),
      scope: normalizeTaskQueueScope(scope),
      projection_path: outPath,
      task: compactTaskFromProjection(projection, open[0].id),
    });
    return;
  }
  console.log(`next ${taskRef(compactTaskFromProjection(projection, open[0].id))} @${owner}`);
  console.log(open[0].title);
  const ref = taskRef(compactTaskFromProjection(projection, open[0].id));
  const { printOperatorNext } = require('../lib/operator-next');
  printOperatorNext(`atris task step ${ref}`);
}

function continueWorkForReviewTask(taskDb, db, taskId, { owner = DEFAULT_OWNER } = {}) {
  const task = taskDetail(taskDb, db, taskId);
  if (!task) {
    const error = new Error(`task not found: ${taskId}`);
    error.reason = 'not_found';
    error.status = 404;
    throw error;
  }
  const handoff = reviewHandoffForTask(task);
  if (handoff && handoff.next_action === 'human_accept_waiting') {
    const error = new Error('agent-certified Review row has no specific next_task suggestion');
    error.reason = 'no_next_task';
    error.status = 409;
    throw error;
  }
  if (!handoff || handoff.next_action !== 'continue_work') {
    const error = new Error('task is not an agent-certified Review row ready for continuation');
    error.reason = 'not_continue_work_ready';
    error.status = 409;
    throw error;
  }
  const nextTitle = reviewNextTaskTitle(task);
  if (!nextTitle) {
    const error = new Error('agent-certified Review row has no specific next_task suggestion');
    error.reason = 'no_next_task';
    error.status = 409;
    throw error;
  }
  const nextCreated = createReviewNextTask(taskDb, db, task, nextTitle);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const parent = compactTaskFromProjection(projection, taskId) || compactTaskForStatus(taskDetail(taskDb, db, taskId));
  const nextTask = nextCreated
    ? compactTaskFromProjection(projection, nextCreated.id) || compactTaskForStatus(taskDetail(taskDb, db, nextCreated.id))
    : null;
  return {
    ok: true,
    action: 'continue_work',
    task_id: taskId,
    parent_task_id: taskId,
    next_task_id: nextCreated ? nextCreated.id : null,
    created: Boolean(nextCreated && nextCreated.inserted !== false),
    operator_title_warning: nextCreated ? nextCreated.operator_title_warning || null : null,
    owner: String(owner || DEFAULT_OWNER),
    projection_path: outPath,
    parent,
    next_task: nextTask,
    safety: {
      accepts_parent: false,
      human_accept: false,
      xp_after_human_accept: true,
    },
  };
}

function cmdContinueWork(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task continue-work', 'missing_id', 'id required');
  }
  const owner = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task continue-work');
  let result;
  try {
    result = continueWorkForReviewTask(taskDb, db, taskId, { owner });
  } catch (error) {
    failTask('atris task continue-work', error.reason || 'continue_work_failed', error.message, error.status === 404 ? 1 : 2);
  }
  if (wantsJson(args)) {
    printJson(result);
    return;
  }
  console.log(`continue-work ${taskRef(result.parent)} -> ${taskRef(result.next_task)}`);
  console.log(result.created ? 'created follow-up task' : 'reused follow-up task');
  console.log('Human accept and XP remain pending on the parent.');
}

function cmdNote(args) {
  const pos = positional(args);
  const id = pos[0];
  const content = pos.slice(1).join(' ').trim();
  if (!id || !content) {
    failTask('atris task note', 'missing_args', 'id and message required');
  }
  const actor = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task note');
  const result = taskDb.noteTask(db, { id: taskId, actor: String(actor), content });
  if (!result.noted) {
    console.error(`note failed: ${result.reason}`);
    process.exit(1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'noted',
      task_id: taskId,
      version: result.event.version,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`noted ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
}

function cmdRetitle(args) {
  const pos = positional(args);
  const id = pos[0];
  const title = pos.slice(1).join(' ').trim();
  if (!id) failTask('atris task retitle', 'missing_id', 'task id required');
  if (!title) failTask('atris task retitle', 'missing_title', 'new title required');
  warnIfTaskTitleNeedsOperatorWhy(title);

  const actor = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task retitle');
  const current = taskDb.getTask(db, taskId);
  const oldTitle = String(current.title || '');
  const now = Math.max(Date.now(), Number(current.updated_at || 0) + 1);
  const updated = db.prepare(`
    UPDATE tasks
       SET title = ?,
           updated_at = ?
     WHERE id = ?
       AND updated_at = ?
  `).run(title, now, taskId, current.updated_at);
  if (updated.changes !== 1) {
    failTask('atris task retitle', 'stale_task_state', 'retitle failed: stale task state', 1);
  }
  const history = taskDb.noteTask(db, {
    id: taskId,
    actor: String(actor),
    content: `previous title: ${oldTitle}`,
  });
  if (!history.noted) {
    failTask('atris task retitle', history.reason || 'history_failed', `retitle history failed: ${history.reason || 'unknown'}`, 1);
  }

  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const task = compactTaskFromProjection(projection, taskId);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'retitled',
      task_id: taskId,
      old_title: oldTitle,
      title,
      version: history.event.version,
      projection_path: outPath,
      task,
    });
    return;
  }
  console.log(`retitled ${taskRef(task)}: ${title}`);
}

// Collect EVERY value for a repeatable flag (flag() only returns the first),
// so `--add a --add b` and `--add a,b` both work.
function collectFlagValues(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && i + 1 < args.length && !String(args[i + 1]).startsWith('--')) {
      values.push(args[i + 1]);
    }
  }
  return values
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function cmdTag(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) failTask('atris task tag', 'missing_id', 'task id required');
  const add = collectFlagValues(args, '--add');
  const remove = collectFlagValues(args, '--remove');
  if (!add.length && !remove.length) {
    failTask('atris task tag', 'missing_tags', 'at least one --add <tag> or --remove <tag> required');
  }
  const actor = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task tag');
  const result = taskDb.tagTask(db, { id: taskId, actor: String(actor), add, remove });
  if (!result.tagged) {
    if (result.reason === 'no_changes') {
      const { projection, outPath } = writeDefaultProjection(taskDb, db);
      const task = compactTaskFromProjection(projection, taskId);
      if (wantsJson(args)) {
        printJson({
          ok: true,
          action: 'unchanged',
          task_id: taskId,
          added: [],
          removed: [],
          tags: result.tags || [],
          projection_path: outPath,
          task,
        });
        return;
      }
      console.log(`no change ${taskRef(task)} tags [${(result.tags || []).join(', ')}]`);
      return;
    }
    failTask('atris task tag', result.reason || 'tag_failed', `tag failed: ${result.reason || 'unknown'}`, 1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const task = compactTaskFromProjection(projection, taskId);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'tagged',
      task_id: taskId,
      added: result.added,
      removed: result.removed,
      tags: result.tags,
      version: result.event.version,
      projection_path: outPath,
      task,
    });
    return;
  }
  const parts = [];
  if (result.added.length) parts.push(`+${result.added.join(' +')}`);
  if (result.removed.length) parts.push(`-${result.removed.join(' -')}`);
  console.log(`tagged ${taskRef(task)} ${parts.join(' ')} -> [${result.tags.join(', ')}] v${result.event.version}`);
}

function cmdChat(args) {
  const pos = positional(args);
  const id = pos[0];
  const content = pos.slice(1).join(' ').trim();
  const goal = textFlag(args, ['--goal', '--objective']);
  const summary = textFlag(args, ['--summary']);
  if (!id) failTask('atris task chat', 'missing_id', 'id required');
  if (!content && !goal && !summary) {
    failTask('atris task chat', 'content_required', 'atris task chat: message, --goal, or --summary required');
  }
  const actor = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task chat');
  const result = taskDb.chatTask(db, {
    id: taskId,
    actor: String(actor),
    content,
    goal,
    summary,
  });
  if (!result.chatted) {
    failTask('atris task chat', result.reason || 'chat_failed', stageErrorDetail('atris task chat', result.reason, result), 1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'chatted',
      task_id: taskId,
      version: result.event.version,
      goal_changed: result.goal_changed,
      chat_packet: result.chat_packet,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`chat ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
}

function stageErrorDetail(command, reason, extra = {}) {
  if (reason === 'goal_required') return `${command}: --goal required`;
  if (reason === 'content_required') return `${command}: message, --goal, or --summary required`;
  if (reason === 'plan_required') return `${command}: run atris task plan first`;
  if (reason === 'exit_required') return `${command}: --exit required`;
  if (reason === 'proof_needed_required') return `${command}: --proof-needed required`;
  if (reason === 'plan_goal_mismatch') return `${command}: Do must use the recorded Plan goal`;
  if (reason === 'plan_proof_mismatch') return `${command}: Do must use the recorded Plan proof requirement`;
  if (reason === 'plan_exit_mismatch') return `${command}: Do must use the recorded Plan exit condition`;
  if (reason === 'not_planned') return `${command}: task is already in Backlog`;
  if (reason === 'confirm_required') return `${command}: --yes required`;
  if (reason === 'claimed_by_other') return `${command}: task is claimed by ${extra.claimed_by || 'another owner'}`;
  if (reason === 'not_reviewable_use_revise') return `${command}: task is in review; use atris task revise first`;
  if (reason === 'stale_task_state') return `${command}: task changed while staging; reload and try again`;
  if (reason && reason.startsWith('already_')) return `${command}: task is ${reason.slice('already_'.length)}`;
  return `${command}: ${reason || 'stage_failed'}`;
}

function cmdPlan(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) failTask('atris task plan', 'missing_id', 'id required');
  const actorFlag = flag(args, '--as');
  const actor = String(actorFlag || DEFAULT_OWNER);
  const goal = textFlag(args, ['--goal', '--objective']);
  const exit = textFlag(args, ['--exit', '--exit-condition']);
  const proofNeeded = textFlag(args, ['--proof-needed', '--proof', '--verify']);
  const summary = textFlag(args, ['--summary', '--plan']);
  const owner = textFlag(args, ['--owner', '--assignee']);
  const firstMove = textFlag(args, ['--first-move', '--first']);
  const nextButton = textFlag(args, ['--next-button']);
  const confidence = numericFlag(args, '--confidence');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task plan');
  const task = taskDetail(taskDb, db, taskId);
  const automaticPlan = buildAutomaticPlanTrace(taskDb, task, {
    actor,
    actorExplicit: typeof actorFlag === 'string' && Boolean(actorFlag.trim()),
    owner,
    goal,
    summary,
    firstMove,
    exit,
  });
  const result = taskDb.stageTask(db, {
    id: taskId,
    actor,
    stage: 'plan',
    goal,
    summary,
    owner: automaticPlan.ownerForStage || owner,
    ownerExplicit: Boolean(owner),
    exit,
    proofNeeded,
    firstMove,
    nextButton,
    confidence,
    planTrace: automaticPlan.trace,
  });
  if (!result.staged) {
    failTask('atris task plan', result.reason || 'stage_failed', stageErrorDetail('atris task plan', result.reason, result), 1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'planned',
      task_id: taskId,
      version: result.event.version,
      plan_trace: automaticPlan.trace ? {
        plan: automaticPlan.plan,
        owner_choice: automaticPlan.ownerChoice,
        trace: automaticPlan.trace,
      } : null,
      stage_packet: result.stage_packet,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`planned ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
}

function cmdDo(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) failTask('atris task do', 'missing_id', 'id required');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const goal = textFlag(args, ['--goal', '--objective']);
  const proofNeeded = textFlag(args, ['--proof-needed', '--proof', '--verify']);
  const exit = textFlag(args, ['--exit', '--exit-condition']);
  const summary = textFlag(args, ['--summary']);
  const firstMove = textFlag(args, ['--first-move', '--first']) || pos.slice(1).join(' ').trim();
  if (!firstMove) failTask('atris task do', 'first_move_required', 'atris task do: --first-move required');
  const nextButton = textFlag(args, ['--next-button']);
  const confidence = numericFlag(args, '--confidence');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task do');
  const result = taskDb.stageTask(db, {
    id: taskId,
    actor,
    stage: 'do',
    goal,
    summary,
    owner: actor,
    exit,
    proofNeeded,
    firstMove,
    nextButton,
    confidence,
  });
  if (!result.staged) {
    failTask('atris task do', result.reason || 'stage_failed', stageErrorDetail('atris task do', result.reason, result), 1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'doing',
      task_id: taskId,
      version: result.event.version,
      stage_packet: result.stage_packet,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`doing ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version} @${actor}`);
}

function cmdBacklog(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) failTask('atris task backlog', 'missing_id', 'id required');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const reason = textFlag(args, ['--reason', '--note']);
  const tag = textFlag(args, ['--tag']) || 'capture';
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task backlog');
  const result = taskDb.backlogTask(db, { id: taskId, actor, reason, tag });
  if (!result.backlogged) {
    failTask('atris task backlog', result.reason || 'backlog_failed', stageErrorDetail('atris task backlog', result.reason, result), 1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'backlogged',
      task_id: taskId,
      version: result.event.version,
      cleared_keys: result.cleared_keys,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`backlog ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
}

function cmdClearPlan(args) {
  const confirmed = hasFlag(args, '--yes') || hasFlag(args, '--confirm');
  if (!confirmed) failTask('atris task clear-plan', 'confirm_required', stageErrorDetail('atris task clear-plan', 'confirm_required'), 2);
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const reason = textFlag(args, ['--reason', '--note']) || 'clear_plan';
  const tag = textFlag(args, ['--tag']) || 'capture';
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = taskDb.clearPlanTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
    actor,
    reason,
    tag,
  });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const taskById = new Map((projection.tasks || []).map(task => [task.id, task]));
  const tasks = result.cleared.map(task => compactTaskForStatus(taskById.get(task.id) || task)).filter(Boolean);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'clear_plan',
      cleared_count: result.cleared.length,
      skipped_count: result.skipped.length,
      skipped: result.skipped,
      projection_path: outPath,
      tasks,
    });
    return;
  }
  console.log(`clear-plan moved ${result.cleared.length} task${result.cleared.length === 1 ? '' : 's'} to Backlog`);
}

function cmdInspect(args) {
  const parsed = readFieldsFlag(args, '--fields');
  if (!parsed || parsed.error) {
    failTask('atris task inspect', 'missing_fields', parsed?.error || 'Usage: atris task inspect <id> --fields review,status,title [--json]');
  }
  const fieldError = validateFields(parsed.fields, TASK_INSPECT_FIELDS, 'task');
  if (fieldError) failTask('atris task inspect', 'unknown_fields', fieldError);
  const ref = stripInspectArgs(args)[0] || '';
  if (!ref) {
    failTask('atris task inspect', 'missing_id', 'Usage: atris task inspect <id> --fields review,status,title [--json]');
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, ref, 'atris task inspect');
  const projection = enrichTaskProjection(taskDb.taskProjection(db, { taskId }));
  let task = projection.tasks[0];
  if (!task) {
    const wsRoot = scopedWorkspaceRoot(taskDb, args) || process.cwd();
    const proj = readProjectionFile(wsRoot);
    if (proj && Array.isArray(proj.tasks)) {
      task = proj.tasks.find(t => t.id === taskId) || null;
    }
  }
  if (!task) {
    failTask('atris task inspect', 'not_found', `task not found: ${ref}`, 1);
  }
  const values = taskInspectFieldValues(task, parsed.fields);
  const payload = buildInspectPayload({
    action: 'task_inspect',
    idKey: 'task_id',
    idValue: task.id,
    fields: parsed.fields,
    values,
  });
  if (wantsJson(args)) {
    printJson(payload);
    return;
  }
  for (const line of inspectTextLines(parsed.fields, values)) console.log(line);
}

function cmdShow(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task show', 'missing_id', 'id required');
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task show');
  const projection = enrichTaskProjection(taskDb.taskProjection(db, { taskId }));
  let task = projection.tasks[0];
  if (!task) {
    const wsRoot = scopedWorkspaceRoot(taskDb, args) || process.cwd();
    const proj = readProjectionFile(wsRoot);
    if (proj && Array.isArray(proj.tasks)) {
      task = proj.tasks.find(t => t.id === taskId) || null;
    }
  }
  if (!task) {
    console.error(`task not found: ${id}`);
    process.exit(1);
  }
  if (hasFlag(args, '--json')) {
    printJson(task);
    return;
  }
  const owner = task.claimed_by ? ` / ${task.claimed_by}` : '';
  const tag = task.tag ? ` #${task.tag}` : '';
  const statusLabel = task.status === 'review'
    ? 'ready for approval'
    : task.status === 'done'
      ? 'DONE'
      : task.status.toUpperCase();
  // Plain layer first. Everything below stays exactly as it was.
  for (const line of explanationLines(task.explanation || taskExplanation(task))) console.log(line);
  for (const line of approvalLines(task.approval || taskApprovalFor(task))) console.log(line);
  console.log('');
  console.log('Technical details:');
  console.log(`${statusLabel} ${taskRef(task)} v${task.current_version}${owner}${tag}`);
  console.log(task.title);
  if (task.metadata?.verification_status === 'degraded') {
    const reason = task.metadata.verification_degraded_reason === 'diff_only_verify'
      ? 'diff-only verify command'
      : 'missing verify command';
    console.log(`verification: degraded (${reason})`);
  }
  if (task.review) {
    console.log('');
    printReviewLanding(task.review);
    if (task.review.summary) console.log(`Short version: ${task.review.summary}`);
    if (task.review.proof) console.log(`Details: ${task.review.proof}`);
    if (task.review.lesson) console.log(`Lesson: ${task.review.lesson}`);
    if (task.review.next_task) console.log(`Next: ${task.review.next_task}`);
    if (task.review.approval_status) {
      const landingStatus = task.review.approval_status === 'pending'
        ? 'waiting on human'
        : task.review.approval_status === 'revise'
          ? 'sent back'
          : task.review.approval_status;
      console.log(`Landing: ${landingStatus}`);
    }
    if (task.review.verification_chat) console.log(`Check command: ${task.review.verification_chat.command}`);
    if (task.review.agent_certified) console.log(`Checked: yes (${task.review.agent_review_pass_count || AGENT_CERTIFICATION_REVIEW_PASSES} agent checks)`);
  }
  if (task.messages.length) {
    console.log('');
    console.log('Dialogue:');
    for (const m of task.messages) {
      const who = m.actor || 'unknown';
      console.log(`- v${m.version} ${who}: ${m.content}`);
    }
  }
}

function cmdPage(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task page', 'missing_id', 'id required');
  }
  const reviewer = reviewActor(flag(args, '--as') || 'codex-review');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task page');
  const task = taskDetail(taskDb, db, taskId);
  if (!task) {
    console.error(`task not found: ${id}`);
    process.exit(1);
  }
  const { outPath } = writeDefaultProjection(taskDb, db);
  const page = taskPageContract(task, { reviewer });
  if (hasFlag(args, '--json')) {
    printJson({
      ok: true,
      action: 'page',
      task_id: taskId,
      projection_path: outPath,
      page,
    });
    return;
  }
  for (const line of explanationLines(page.explanation)) console.log(line);
  for (const line of approvalLines(page.approval)) console.log(line);
  console.log('');
  console.log(`Technical details: TASK PAGE ${taskRef(task)} - ${task.title}`);
  console.log(`Goal: ${page.goal.text || '(none)'}`);
  console.log(`Stage: ${page.stage.current}`);
  printReviewLanding(page.review);
  console.log(`Next: ${page.stage.next_action.command || page.stage.next_action.label}`);
  console.log(`Chat: ${page.chat.command}`);
  if (page.review.verification_chat) console.log(`Check command: ${page.review.verification_chat.command}`);
  if (page.review.human_accept.enabled) console.log(`Land: ${page.review.human_accept.command}`);
}

function cmdReviewChat(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task review-chat', 'missing_id', 'id required');
  }
  const reviewer = reviewActor(flag(args, '--as') || 'codex-review');
  const dryRun = hasFlag(args, '--dry-run') || hasFlag(args, '--no-note');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task review-chat');
  let result;
  try {
    result = appendTaskReviewChat(taskDb, db, taskId, { reviewer, dryRun });
  } catch (error) {
    failTask('atris task review-chat', error.reason || 'review_chat_failed', error.message, error.exitCode || 2);
  }
  const { task, contract, event, compactProjection, outPath } = result;
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'review_chat',
      task_id: taskId,
      appended: !dryRun,
      version: event ? event.version : null,
      projection_path: outPath,
      contract,
      task,
      compact_task: compactTaskFromProjection(compactProjection, taskId),
    });
    return;
  }
  console.log(`REVIEW CHAT ${taskRef(task)}`);
  console.log(contract.codex_prompt);
  console.log(`show: atris task show ${taskRef(task)} --json`);
  console.log(`pass: ${contract.pass_command}`);
  console.log(`revise: ${contract.revise_command}`);
  if (!dryRun && event) console.log(`thread: appended v${event.version}`);
}

function taskDetail(taskDb, db, taskId) {
  const detailedProjection = taskDb.taskProjection(db, { taskId });
  let detailedTask = detailedProjection.tasks[0] || null;
  if (!detailedTask) {
    const wsRoot = taskDb.workspaceRoot ? taskDb.workspaceRoot() : process.cwd();
    const proj = readProjectionFile(wsRoot);
    if (proj && Array.isArray(proj.tasks)) {
      detailedTask = proj.tasks.find(t => t.id === taskId) || null;
    }
  }
  if (!detailedTask) return null;
  const workspaceRoot = detailedTask.workspace_root || taskDb.workspaceRoot();
  const contextProjection = enrichTaskProjection(taskDb.taskProjection(db, {
    workspaceRoot,
    limit: 5000,
  }));
  const enrichedTask = contextProjection.tasks.find(task => task.id === detailedTask.id) || null;
  if (!enrichedTask) return enrichTaskProjection(detailedProjection).tasks[0] || detailedTask;
  return {
    ...enrichedTask,
    current_version: detailedTask.current_version,
    latest_event_type: detailedTask.latest_event_type,
    messages: detailedTask.messages,
    events: detailedTask.events,
    history: detailedTask.history,
  };
}

function taskCommandQuote(value) {
  const text = String(value || '').replace(/\s+/g, ' ').replace(/"/g, '\\"').trim();
  return `"${text || '...'}"`;
}

function cleanPublicText(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function publicWords(value) {
  return (String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .map(word => word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word)
    .filter(word => !new Set([
      'and',
      'for',
      'from',
      'into',
      'the',
      'this',
      'that',
      'task',
      'work',
      'with',
    ]).has(word));
}

function parseMemberFrontmatter(text) {
  const source = String(text || '');
  if (!source.startsWith('---')) return {};
  const end = source.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = source.slice(3, end).split(/\r?\n/);
  const data = {};
  for (const raw of block) {
    const match = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    data[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
  }
  return data;
}

function readTeamMembers(root = process.cwd()) {
  const teamDir = path.join(root, 'atris', 'team');
  if (!fs.existsSync(teamDir)) return [];
  return fs.readdirSync(teamDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const slug = entry.name;
      const memberPath = path.join(teamDir, slug, 'MEMBER.md');
      if (!fs.existsSync(memberPath)) return null;
      const text = fs.readFileSync(memberPath, 'utf8');
      const frontmatter = parseMemberFrontmatter(text);
      return {
        slug,
        role: cleanPublicText(frontmatter.role || slug.replace(/[-_]/g, ' '), 120),
        description: cleanPublicText(frontmatter.description || '', 240),
        path: memberPath,
      };
    })
    .filter(Boolean);
}

const GENERIC_MEMBER_SLUGS = new Set([
  '_template',
  'coordinator',
  'executor',
  'generalist',
  'navigator',
  'supervisor',
]);

function scoreTeamMember(member, words, tag) {
  const slug = String(member.slug || '').toLowerCase();
  const role = String(member.role || '').toLowerCase();
  const description = String(member.description || '').toLowerCase();
  const haystack = `${slug} ${role} ${description}`.replace(/[-_]/g, ' ');
  let score = 0;
  const cleanTag = String(tag || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (cleanTag) {
    if (slug === cleanTag || slug.replace(/[-_]/g, ' ') === cleanTag) score += 12;
    else if (haystack.includes(cleanTag)) score += 5;
  }
  for (const word of words) {
    if (slug.includes(word)) score += 5;
    else if (role.includes(word)) score += 3;
    else if (description.includes(word)) score += 2;
  }
  if (GENERIC_MEMBER_SLUGS.has(slug)) score -= 3;
  return score;
}

function plainMemberDescription(member) {
  const description = cleanPublicText(member && member.description, 220);
  if (!description) return '';
  const lowered = `${description.charAt(0).toLowerCase()}${description.slice(1)}`;
  return /[.!?]$/.test(lowered) ? lowered : `${lowered}.`;
}

function chooseTaskOwner({ purpose, tag, requestedOwner, root = process.cwd() } = {}) {
  const members = readTeamMembers(root);
  const requested = cleanPublicText(requestedOwner, 80);
  if (requested) {
    const match = members.find(member => member.slug === requested);
    if (match) {
      const description = plainMemberDescription(match);
      return {
        owner: match.slug,
        member: match,
        source: 'requested',
        reason: `${match.slug} matches this work${description ? ` because ${description}` : '.'}`,
      };
    }
    return {
      owner: requested,
      member: null,
      source: 'requested',
      reason: `${requested} was requested, but no matching atris/team member was found.`,
    };
  }
  const words = publicWords(`${purpose || ''} ${tag || ''}`);
  let best = null;
  for (const member of members) {
    const score = scoreTeamMember(member, words, tag);
    if (!best || score > best.score) best = { member, score };
  }
  if (best && best.score > 0) {
    const member = best.member;
    const description = plainMemberDescription(member);
    return {
      owner: member.slug,
      member,
      source: 'team',
      score: best.score,
      reason: `${member.slug} fits this work${description ? ` because ${description}` : '.'}`,
    };
  }
  return {
    owner: DEFAULT_OWNER,
    member: null,
    source: 'fallback',
    reason: `${DEFAULT_OWNER} is handling it because no specific atris/team owner matched this work.`,
  };
}

function isGenericPlanActor(value) {
  const actor = cleanPublicText(value, 80).toLowerCase();
  if (!actor) return true;
  if (actor === String(DEFAULT_OWNER || '').toLowerCase()) return true;
  return GENERIC_MEMBER_SLUGS.has(actor) || new Set([
    'codex',
    'codex-executor',
    'claude',
    'claude-code',
    'cursor',
    'devin',
  ]).has(actor);
}

function taskTextMentionsActor(actor, text) {
  const actorWords = publicWords(actor);
  if (!actorWords.length) return false;
  const words = new Set(publicWords(text));
  return actorWords.some(word => words.has(word));
}

function buildPublicPlan({ purpose, owner, ownerReason, plan, expected }) {
  const cleanPurpose = cleanPublicText(purpose, 240);
  const cleanOwner = cleanPublicText(owner, 80);
  const cleanReason = cleanPublicText(ownerReason, 240);
  const cleanPlan = cleanPublicText(plan, 320) || `${cleanOwner || 'The owner'} will make the smallest needed change, then check the result.`;
  const cleanExpected = cleanPublicText(expected, 240) || 'the check passes and the result is ready to review.';
  return {
    purpose: cleanPurpose,
    owner: cleanOwner,
    owner_reason: cleanReason,
    plan: cleanPlan,
    expected_result: cleanExpected,
  };
}

function renderPublicPlan(plan) {
  const lines = [];
  if (plan.purpose) lines.push(`Purpose: ${plan.purpose}`);
  if (plan.owner) lines.push(`Owner: ${plan.owner} is handling it.`);
  if (plan.owner_reason) lines.push(`Why: ${plan.owner_reason}`);
  if (plan.plan) lines.push(`Plan: ${plan.plan}`);
  if (plan.expected_result) lines.push(`Expected result: ${plan.expected_result}`);
  return lines.join('\n');
}

function planTraceData(plan, ownerChoice) {
  return {
    schema: 'atris.task_plan_trace.v1',
    purpose: plan.purpose,
    owner: plan.owner,
    owner_reason: plan.owner_reason,
    plan: plan.plan,
    expected_result: plan.expected_result,
    owner_source: ownerChoice && ownerChoice.source || null,
    owner_score: ownerChoice && ownerChoice.score || null,
    recorded_at: new Date().toISOString(),
  };
}

function planTraceNote(plan, ownerChoice) {
  return `TASK_PLAN_TRACE ${JSON.stringify(planTraceData(plan, ownerChoice))}`;
}

function traceLineFromContent(content, prefix) {
  const lines = String(content || '').split(/\r?\n/);
  return lines.find(line => line.startsWith(prefix)) || '';
}

function latestTraceValue(task, prefix, key) {
  const messages = Array.isArray(task && task.messages) ? task.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = String(messages[i] && messages[i].content || '');
    const line = traceLineFromContent(content, prefix);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line.slice(prefix.length).trim());
      const value = parsed && parsed[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value);
    } catch (_) {
      continue;
    }
  }
  return '';
}

function taskHasTrace(task, prefix) {
  const messages = Array.isArray(task && task.messages) ? task.messages : [];
  if (messages.some(message => traceLineFromContent(message && message.content, prefix))) return true;
  const events = Array.isArray(task && task.events) ? task.events : [];
  return events.some(event => {
    const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (traceLineFromContent(payload.stage_packet, prefix)) return true;
    if (traceLineFromContent(payload.result_packet, prefix)) return true;
    if (prefix === 'TASK_RESULT_TRACE ' && payload.result_trace && typeof payload.result_trace === 'object') return true;
    if (prefix === 'TASK_PLAN_TRACE ' && payload.plan_trace && typeof payload.plan_trace === 'object') return true;
    return false;
  });
}

function taskPurpose(task) {
  const metadata = task && task.metadata || {};
  return cleanPublicText(
    metadata.task_goal
      || metadata.goal_objective
      || metadata.objective
      || metadata.stage_goal
      || latestTraceValue(task, 'TASK_PLAN_TRACE ', 'purpose')
      || task && task.title
      || '',
    240,
  );
}

function buildPublicResult(task, fields) {
  const owner = cleanPublicText(
    fields.owner
      || latestTraceValue(task, 'TASK_PLAN_TRACE ', 'owner')
      || taskAssignee(task)
      || task && task.claimed_by
      || fields.actor,
    80,
  );
  const result = {
    purpose: cleanPublicText(fields.purpose || taskPurpose(task), 240),
    owner,
    changed: cleanPublicText(fields.changed, 320),
    checked: cleanPublicText(fields.checked, 320),
    passed: cleanPublicText(fields.passed, 240),
    failed: cleanPublicText(fields.failed, 240),
    cost: cleanPublicText(fields.cost, 80),
    saved: cleanPublicText(fields.saved, RESULT_SAVED_TEXT_LIMIT),
    try_next: cleanPublicText(fields.tryNext, 240),
    status: cleanPublicText(fields.status, 160) || 'ready for review',
  };
  return result;
}

function renderPublicResult(result) {
  return [
    `Changed: ${cleanPublicText(result && result.changed, 320) || 'changed the requested work'}`,
    `Checked: ${cleanPublicText(result && result.checked, 320) || 'checked the result'}`,
    `Try: ${cleanPublicText(result && result.try_next, 240) || 'try the changed work'}`,
  ].join('\n');
}

function latestResultTrace(task) {
  const messages = Array.isArray(task && task.messages) ? task.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = String(messages[i] && messages[i].content || '');
    const line = traceLineFromContent(content, 'TASK_RESULT_TRACE ');
    if (!line) continue;
    try {
      const parsed = JSON.parse(line.slice('TASK_RESULT_TRACE '.length).trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
  }

  const events = Array.isArray(task && task.events) ? task.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i] && events[i].payload && typeof events[i].payload === 'object'
      ? events[i].payload
      : {};
    if (payload.result_trace && typeof payload.result_trace === 'object') return payload.result_trace;
    const packetLine = traceLineFromContent(payload.result_packet, 'TASK_RESULT_TRACE ');
    if (!packetLine) continue;
    try {
      const parsed = JSON.parse(packetLine.slice('TASK_RESULT_TRACE '.length).trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
  }
  return null;
}

function buildAcceptHumanResult({ task, proof, nextTask, publicSync }) {
  const trace = latestResultTrace(task) || {};
  const traceChanged = cleanPublicText(trace.changed, 320);
  const changed = traceChanged === 'prepared the work for review'
    ? 'accepted the completed work'
    : traceChanged
    || cleanPublicText(task && task.title, 260)
    || 'accepted the completed work';
  let checked = cleanPublicText(trace.checked, 320)
    || cleanPublicText(proof, 320)
    || 'checked the proof';
  if (publicSync && publicSync.enabled === true && !publicSync.ok) {
    const error = cleanPublicText(publicSync.error || 'publish failed', 140);
    checked = `${checked}; AgentXP publish failed${error ? ` (${error})` : ''}`;
  }
  const tryNext = cleanPublicText(nextTask, 240)
    || cleanPublicText(trace.try_next, 240)
    || 'try the changed work';
  return { changed, checked, try_next: tryNext };
}

function refreshBrainScorecardsAfterAccept(root = process.cwd()) {
  try {
    const { recordTaskEpisodeScorecards } = require('../commands/brain');
    return { ok: true, ...recordTaskEpisodeScorecards({ root }) };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
    };
  }
}

function nextMissionRouteAfterAccept(root = process.cwd()) {
  try {
    const { selectCodexGoalMission } = require('../commands/mission');
    const selected = selectCodexGoalMission(root);
    const mission = selected && selected.mission;
    if (!mission) return { ok: true, objective: null, route: 'next mission: none' };
    return {
      ok: true,
      mission_id: mission.id,
      objective: mission.objective,
      reason: selected.reason,
      route: `next mission: ${cleanPublicText(mission.objective, 160)}`,
      command: mission.next_action || `atris mission run ${mission.id}`,
    };
  } catch (error) {
    return {
      ok: false,
      route: 'next mission: needs refresh',
      error: error && error.message ? error.message : String(error),
    };
  }
}

function xpLandingText(xpProjection) {
  if (!xpProjection) return 'XP updated';
  if (xpProjection.ok === false) return 'XP refresh failed';
  const candidates = [
    xpProjection.total_agent_xp,
    xpProjection.total_xp,
    xpProjection.summary && xpProjection.summary.total_agent_xp,
    xpProjection.totals && xpProjection.totals.total_agent_xp,
  ];
  const total = candidates.map(Number).find((value) => Number.isFinite(value));
  return Number.isFinite(total) ? `XP updated (${total} total)` : 'XP updated';
}

function brainScorecardLandingText(brainScorecards) {
  if (!brainScorecards) return 'brain scorecards checked';
  if (brainScorecards.ok === false) return 'brain scorecard refresh failed';
  const written = Number(brainScorecards.written);
  return Number.isFinite(written) ? `brain scorecards +${written}` : 'brain scorecards checked';
}

function buildVisibleAcceptReceipt(result, { xpProjection, brainScorecards, nextMissionRoute } = {}) {
  const updates = [
    xpLandingText(xpProjection),
    brainScorecardLandingText(brainScorecards),
  ].filter(Boolean);
  const checked = updates.length ? `${result.checked}; ${updates.join('; ')}` : result.checked;
  const route = cleanPublicText(nextMissionRoute && nextMissionRoute.route, 180);
  const tryNext = route ? `${result.try_next}; ${route}` : result.try_next;
  return { ...result, checked, try_next: tryNext };
}

function renderAcceptLanding({ task, proof, nextTask, publicSync, xpProjection, brainScorecards, nextMissionRoute }) {
  const result = buildAcceptHumanResult({
    task,
    proof,
    nextTask,
    publicSync,
  });
  return renderPublicResult(buildVisibleAcceptReceipt(result, { xpProjection, brainScorecards, nextMissionRoute }));
}

async function publishAcceptAgentXp(args, actor) {
  const token = flag(args, '--token');
  const syncArgs = ['--all', '--root', process.cwd(), '--public', '--as', actor];
  if (typeof token === 'string' && token.trim()) syncArgs.push('--token', token.trim());
  try {
    const { syncAgentXp } = require('../commands/xp');
    const result = await syncAgentXp(syncArgs);
    const server = result && result.server ? result.server : {};
    const publicCount = Number(server.public_accepted_count);
    const acceptedCount = Number(server.accepted_count);
    const published = (
      (Number.isFinite(publicCount) && publicCount > 0)
      || (Number.isFinite(acceptedCount) && acceptedCount > 0 && server.private_agentxp !== true)
    );
    return {
      enabled: true,
      ok: published,
      result,
      error: published ? null : 'server accepted no public AgentXP rows',
    };
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      error: error && error.message ? error.message : String(error),
    };
  }
}

function todayResultLogName() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`;
}

function appendResultOwnerLog(root, task, result) {
  const owner = cleanPublicText(result && result.owner, 80);
  if (!owner || !/^[A-Za-z0-9._-]+$/.test(owner)) return null;
  const memberFile = path.join(root, 'atris', 'team', owner, 'MEMBER.md');
  if (!fs.existsSync(memberFile)) return null;
  const logName = todayResultLogName();
  const logDir = path.join(root, 'atris', 'team', owner, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, logName);
  const stamp = new Date().toTimeString().slice(0, 5);
  const lines = [
    `## ${stamp} - Result`,
    `- task: ${taskRef(task)}`,
    `- purpose: ${result.purpose || ''}`,
    `- result: ${result.changed || ''}`,
    `- checked: ${result.checked || ''}`,
    `- saved: ${result.saved || ''}`,
    `- try: ${result.try_next || ''}`,
    `- status: ${result.status || ''}`,
    '',
  ];
  fs.appendFileSync(logPath, lines.join('\n'), 'utf8');
  return {
    member_log_path: path.relative(root, logPath),
  };
}

function resultTraceData(result, fields) {
  return {
    schema: 'atris.task_result_trace.v1',
    purpose: result.purpose,
    owner: result.owner || null,
    changed: result.changed,
    checked: result.checked,
    passed: result.passed || null,
    failed: result.failed || null,
    cost: result.cost || null,
    saved: result.saved || null,
    try_next: result.try_next || null,
    status: result.status,
    files: cleanPublicText(fields.files, 500) || null,
    commands: cleanPublicText(fields.commands, 500) || null,
    member_log_path: fields.savedPaths && fields.savedPaths.member_log_path || null,
    recorded_at: new Date().toISOString(),
  };
}

function resultTraceNote(result, fields) {
  return `TASK_RESULT_TRACE ${JSON.stringify(resultTraceData(result, fields))}`;
}

function cmdPlanPreview(args) {
  const pos = positional(args);
  const purpose = cleanPublicText(textFlag(args, ['--purpose', '--goal', '--objective']) || pos.join(' '), 240);
  if (!purpose) failTask('atris task plan-preview', 'missing_purpose', 'purpose required');
  const tag = textFlag(args, ['--tag']);
  const requestedOwner = textFlag(args, ['--owner', '--as', '--member']);
  const planText = textFlag(args, ['--plan', '--action', '--first-move']);
  const expected = textFlag(args, ['--expected', '--expected-result', '--exit']);
  const recordRef = textFlag(args, ['--task', '--record']);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ownerChoice = chooseTaskOwner({
    purpose,
    tag,
    requestedOwner,
    root: taskDb.workspaceRoot(),
  });
  const publicPlan = buildPublicPlan({
    purpose,
    owner: ownerChoice.owner,
    ownerReason: ownerChoice.reason,
    plan: planText,
    expected,
  });
  let recorded = null;
  if (recordRef) {
    const taskId = requireTaskId(taskDb, db, recordRef, 'atris task plan-preview');
    const note = taskDb.noteTask(db, {
      id: taskId,
      actor: publicPlan.owner || DEFAULT_OWNER,
      content: planTraceNote(publicPlan, ownerChoice),
    });
    if (!note.noted) failTask('atris task plan-preview', note.reason || 'note_failed', `plan-preview failed: ${note.reason || 'note_failed'}`, 1);
    const { outPath } = writeDefaultProjection(taskDb, db);
    recorded = {
      task_id: taskId,
      version: note.event.version,
      projection_path: outPath,
    };
  }
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'plan_preview',
      plan: publicPlan,
      owner_choice: {
        owner: ownerChoice.owner,
        source: ownerChoice.source,
        score: ownerChoice.score || null,
        member: ownerChoice.member ? {
          slug: ownerChoice.member.slug,
          role: ownerChoice.member.role,
          description: ownerChoice.member.description,
        } : null,
      },
      recorded,
      text: renderPublicPlan(publicPlan),
    });
    return;
  }
  console.log(renderPublicPlan(publicPlan));
}

function buildAutomaticPlanTrace(taskDb, task, { actor, actorExplicit = false, owner, goal, summary, firstMove, exit } = {}) {
  if (!task) return { trace: null, plan: null, ownerChoice: null, ownerForStage: owner || null };
  const metadata = task.metadata || {};
  const purpose = cleanPublicText(goal, 240) || taskPurpose(task);
  const claimedOwner = cleanPublicText(task.claimed_by, 80);
  // A delegated owner (metadata.assigned_to) is a functional decision already
  // recorded on the task. Only an explicit caller owner or an existing claim
  // outranks it; automatic team choice never does.
  const delegatedOwner = cleanPublicText(metadata.assigned_to, 80);
  const actorNamed = taskTextMentionsActor(actor, `${purpose} ${task.title || ''} ${task.tag || ''}`);
  const requestedActor = actorExplicit && (!isGenericPlanActor(actor) || actorNamed) ? actor : null;
  const requestedOwner = owner || claimedOwner || delegatedOwner || requestedActor || null;
  const ownerChoice = chooseTaskOwner({
    purpose,
    tag: task.tag,
    requestedOwner,
    root: taskDb.workspaceRoot(),
  });
  const publicPlan = buildPublicPlan({
    purpose,
    owner: ownerChoice.owner,
    ownerReason: ownerChoice.reason,
    plan: firstMove || summary || metadata.first_move || metadata.stage_summary || '',
    expected: exit || metadata.exit_condition || '',
  });
  return {
    trace: planTraceData(publicPlan, ownerChoice),
    plan: publicPlan,
    ownerChoice: {
      owner: ownerChoice.owner,
      source: ownerChoice.source,
      score: ownerChoice.score || null,
    },
    ownerForStage: publicPlan.owner || actor || DEFAULT_OWNER,
  };
}

function buildAutomaticResultTrace(taskDb, db, taskId, { actor, proof, changed, checked, passed, failed, cost, saved, tryNext, status, files, commands } = {}) {
  const task = taskDetail(taskDb, db, taskId);
  if (!task || taskHasTrace(task, 'TASK_RESULT_TRACE ')) return null;
  const fields = {
    actor,
    changed: cleanPublicText(changed, 320) || 'prepared the work for review',
    checked: cleanPublicText(checked, 320) || cleanPublicText(proof, 320),
    passed: cleanPublicText(passed, 240),
    failed: cleanPublicText(failed, 240),
    cost: cleanPublicText(cost, 80),
    saved: cleanPublicText(saved, RESULT_SAVED_TEXT_LIMIT) || 'task trace was updated',
    tryNext: cleanPublicText(tryNext, 240) || 'review the proof and try the changed work',
    status: cleanPublicText(status, 160) || 'ready for review',
    files,
    commands,
  };
  const result = buildPublicResult(task, fields);
  const savedPaths = appendResultOwnerLog(taskDb.workspaceRoot(), task, result);
  const trace = resultTraceData(result, { ...fields, savedPaths });
  return {
    result,
    trace,
    saved_paths: savedPaths,
  };
}

function cmdResult(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) failTask('atris task result', 'missing_id', 'id required');
  const sentence = pos.slice(1).join(' ').trim();
  if (sentence) {
    const resultSentence = requireResultSentence('atris task result', sentence);
    const actor = String(flag(args, '--as') || DEFAULT_OWNER);
    const taskDb = getTaskDb();
    const db = taskDb.open();
    const taskId = requireTaskId(taskDb, db, id, 'atris task result');
    const saved = taskDb.setTaskResult(db, {
      id: taskId,
      actor,
      result: resultSentence,
    });
    if (!saved.saved) failTask('atris task result', saved.reason || 'result_failed', `result failed: ${saved.reason || 'result_failed'}`, 1);
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'result',
        task_id: taskId,
        version: saved.event.version,
        result: resultSentence,
        projection_path: outPath,
        task: compactTaskFromProjection(projection, taskId),
      });
      return;
    }
    console.log(`result saved ${taskRef(compactTaskFromProjection(projection, taskId))}: ${resultSentence}`);
    return;
  }
  const fields = {
    purpose: textFlag(args, ['--purpose', '--goal', '--objective']),
    changed: textFlag(args, ['--changed', '--done']),
    checked: textFlag(args, ['--checked', '--check', '--verified']),
    passed: textFlag(args, ['--passed', '--pass']),
    failed: textFlag(args, ['--failed', '--fail']),
    cost: textFlag(args, ['--cost']),
    saved: textFlag(args, ['--saved', '--savings']),
    tryNext: textFlag(args, ['--try', '--try-next', '--handoff']),
    status: textFlag(args, ['--status']),
    files: textFlag(args, ['--files']),
    commands: textFlag(args, ['--commands', '--command']),
  };
  if (!fields.changed) failTask('atris task result', 'changed_required', '--changed required');
  if (!fields.checked) failTask('atris task result', 'checked_required', '--checked required');
  if (!fields.tryNext) failTask('atris task result', 'try_required', '--try required');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task result');
  const task = taskDetail(taskDb, db, taskId);
  if (!task) failTask('atris task result', 'not_found', `task not found: ${id}`, 1);
  const result = buildPublicResult(task, { ...fields, actor });
  const savedPaths = appendResultOwnerLog(taskDb.workspaceRoot(), task, result);
  const note = taskDb.noteTask(db, {
    id: taskId,
    actor,
    content: resultTraceNote(result, { ...fields, savedPaths }),
  });
  if (!note.noted) failTask('atris task result', note.reason || 'note_failed', `result failed: ${note.reason || 'note_failed'}`, 1);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const text = renderPublicResult(result);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'result',
      task_id: taskId,
      version: note.event.version,
      projection_path: outPath,
      result,
      saved_paths: savedPaths,
      text,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(text);
}

function taskPageGoal(task) {
  const metadata = task && task.metadata || {};
  const candidates = [
    ['task_goal', metadata.task_goal],
    ['goal_objective', metadata.goal_objective],
    ['objective', task && task.objective],
    ['metadata_objective', metadata.objective],
    ['title', task && task.title],
  ];
  const picked = candidates.find(([, value]) => String(value || '').trim());
  return {
    text: picked ? String(picked[1]).trim() : null,
    source: picked ? picked[0] : null,
  };
}

function taskPageCurrentStage(task) {
  if (!task) return 'missing';
  if (task.status === 'done' && !taskHasReview(task)) return 'review';
  if (task.status === 'done' || (task.status === 'failed' && taskHasReview(task))) return 'done';
  if (task.status === 'failed') return 'blocked';
  if (task.status === 'review') return 'review';
  const metadata = task.metadata || {};
  const explicitStage = normalizedStatusPart(metadata.stage);
  if (explicitStage === 'plan') return 'plan';
  if (explicitStage === 'do') return 'do';
  const column = taskColumn(task);
  if (column === 'open') return 'plan';
  if (column === 'doing') return 'do';
  return column;
}

function taskPageStageRail(current) {
  const order = ['backlog', 'plan', 'do', 'review', 'done'];
  const effectiveCurrent = current === 'blocked' ? 'do' : current;
  const currentIndex = order.indexOf(effectiveCurrent);
  return order.map((key, index) => {
    let state = 'upcoming';
    if (current === 'blocked' && key === 'do') state = 'blocked';
    else if (index < currentIndex) state = 'complete';
    else if (index === currentIndex) state = 'current';
    return {
      key,
      label: key === 'do' ? 'Do' : key.charAt(0).toUpperCase() + key.slice(1),
      state,
    };
  });
}

function taskPageActions(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  const ref = taskRef(task);
  const owner = task && (task.claimed_by || taskAssignee(task)) || DEFAULT_OWNER;
  const goal = taskPageGoal(task).text || '<goal>';
  const actor = reviewActor(reviewer);
  const canReviewChat = taskAllowsReviewChat(task, { allowCertified: true });
  const actions = {
    show_command: `atris task show ${ref} --json`,
    page_command: `atris task page ${ref} --json`,
    step_command: `atris task step ${ref} --json`,
    chat_command: `atris task chat ${ref} "<message>" --goal ${taskCommandQuote(goal)}`,
    note_command: `atris task note ${ref} "<context>" --as ${owner}`,
    plan_command: `atris task plan ${ref} --goal ${taskCommandQuote(goal)} --exit "<exit condition>" --proof-needed "<verification command>" --first-move "<first move>"`,
    do_command: `atris task do ${ref} --as ${owner} --first-move "<first move>"`,
    ready_command: `atris task ready ${ref} --as ${owner} --proof "<specific proof command/result>" --result "<one day-one PM sentence>" --happened "<what happened>" --checked "<how you know>" --tested "<what you ran or inspected>" --decision "<accept/rework guidance>"`,
    review_command: `atris task review ${ref} --reward 0 --as ${actor} --proof "<specific proof command/result>" --verify "<safe verifier command>"`,
  };
  if (task && task.status === 'review') {
    actions.revise_command = `atris task revise ${ref} --as ${actor} --note "<specific missing proof or required change>"`;
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    if (handoffAllowsHumanAccept(handoff)) {
      actions.human_accept_command = `atris task accept ${ref}`;
    }
    const continueWorkCommand = handoff?.next_action === 'continue_work'
      ? continueWorkCommandForTask(task, { owner })
      : null;
    if (continueWorkCommand) actions.continue_work_command = continueWorkCommand;
    if (canReviewChat) {
      actions.review_chat_command = `atris task review-chat ${ref} --as ${actor}`;
    }
  }
  return actions;
}

function taskPageNextAction(task, current, actions, { hasExistingReviewFollowUp = null } = {}) {
  const ref = taskRef(task);
  const apiBase = `/api/tasks/${encodeURIComponent(task && task.id || ref)}`;
  if (current === 'backlog') {
    return { key: 'plan', label: 'Plan task', command: actions.plan_command, api: { method: 'POST', path: `${apiBase}/plan` } };
  }
  if (current === 'plan') {
    return { key: 'do', label: 'Start Do', command: actions.do_command, api: { method: 'POST', path: `${apiBase}/do` } };
  }
  if (current === 'do') {
    return { key: 'ready', label: 'Move to Review', command: actions.ready_command, api: { method: 'POST', path: `${apiBase}/ready` } };
  }
  if (current === 'review') {
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    if (handoff && handoff.next_action === 'continue_work') {
      return {
        key: 'continue_work',
        label: 'Agent certified; continue work',
        command: actions.continue_work_command || null,
        api: actions.continue_work_command ? { method: 'POST', path: `${apiBase}/continue-work` } : null,
        human_accept_command: actions.human_accept_command || null,
      };
    }
    if (handoffIsProofBoundaryBlocked(handoff)) {
      return {
        key: PROOF_BOUNDARY_BLOCKED_ACTION,
        label: 'Proof boundary blocked',
        command: actions.revise_command || null,
        api: null,
        reason: PROOF_BOUNDARY_BLOCKED_REASON,
        next_action_detail: handoff.next_action_detail || null,
        revise_command: actions.revise_command || null,
        human_accept_command: null,
      };
    }
    if (handoff && handoff.next_action === 'human_accept_waiting') {
      return {
        key: 'human_accept_waiting',
        label: 'Ready for approval',
        command: null,
        api: null,
        human_accept_command: actions.human_accept_command || null,
      };
    }
    if (!actions.review_chat_command) {
      return { key: 'review', label: 'Record review proof', command: actions.review_command, api: { method: 'POST', path: `${apiBase}/review` } };
    }
    return { key: 'review_chat', label: 'Start verification chat', command: actions.review_chat_command, api: { method: 'POST', path: `${apiBase}/review-chat` } };
  }
  if (current === 'blocked') {
    return { key: 'blocked', label: 'Blocked', command: null, blocked_reason: 'Task is failed without accepted review proof.' };
  }
  return { key: 'none', label: 'No next agent action', command: null };
}

function taskPageContract(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  const metadata = task && task.metadata || {};
  const current = taskPageCurrentStage(task);
  const actions = taskPageActions(task, { reviewer, hasExistingReviewFollowUp });
  const review = task && (task.review || taskReviewSummary(task));
  const recentMessages = (task && Array.isArray(task.messages) ? task.messages : []).slice(-10).map(message => ({
    version: message.version || null,
    actor: message.actor || null,
    content: message.content || '',
    created_at: message.created_at || null,
  }));
  const reviewChat = task && task.status === 'review'
    && taskAllowsReviewChat(task, { allowCertified: true })
    ? taskReviewChatHandoff(task, { reviewer, allowCertified: true })
    : null;
  const reviewHandoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
  const humanAcceptEnabled = task.status === 'review' && handoffAllowsHumanAccept(reviewHandoff);
  return {
    schema: 'atris.task_page.v1',
    // First layer: what changes, why it matters, what done looks like, and the
    // two things a person can do about it. The full contract follows unchanged.
    explanation: task.explanation || taskExplanation(task),
    approval: taskApprovalFor(task, { reviewer, hasExistingReviewFollowUp }),
    task: {
      id: task.id,
      ref: taskRef(task),
      display_id: task.display_id || null,
      legacy_ref: task.legacy_ref || null,
      title: task.title,
      status: task.status,
      tag: task.tag || null,
      claimed_by: task.claimed_by || null,
      assigned_to: taskAssignee(task),
      objective: task.objective || metadata.task_goal || metadata.goal_objective || null,
      current_version: task.current_version || null,
      latest_event_type: task.latest_event_type || null,
      updated_at: task.updated_at || null,
    },
    goal: taskPageGoal(task),
    chat: {
      command: actions.chat_command,
      api: { method: 'POST', path: `/api/tasks/${encodeURIComponent(task.id)}/chat` },
      recent_messages: recentMessages,
      can_chat: !['done', 'failed'].includes(task.status),
    },
    stage: {
      current,
      rail: taskPageStageRail(current),
      next_action: taskPageNextAction(task, current, actions, { hasExistingReviewFollowUp }),
    },
    actions,
    review: {
      landing: review && review.landing || null,
      result: review && review.result || null,
      summary: review && review.summary || null,
      proof: review && review.proof || null,
      approval_status: review && review.approval_status || metadata.approval_status || null,
      agent_review_pass_count: review && review.agent_review_pass_count || metadata.agent_review_pass_count || null,
      agent_certified: Boolean(review && review.agent_certified || metadata.agent_certified),
      verification_chat: reviewChat,
      handoff: reviewHandoff,
      human_accept: {
        enabled: humanAcceptEnabled,
        command: humanAcceptEnabled ? actions.human_accept_command : null,
        human_only: true,
        xp_after_accept: true,
      },
    },
    api: {
      detail: `/api/tasks/${encodeURIComponent(task.id)}`,
      page: `/api/tasks/${encodeURIComponent(task.id)}/page`,
      step: `/api/tasks/${encodeURIComponent(task.id)}/step`,
      events: `/api/tasks/${encodeURIComponent(task.id)}/events`,
    },
  };
}

function taskReviewChatError(reason, detail, { status = 400, exitCode = 2 } = {}) {
  const error = new Error(detail || reason);
  error.reason = reason;
  error.status = status;
  error.exitCode = exitCode;
  return error;
}

function taskAllowsReviewChat(task, { allowCertified = false } = {}) {
  if (!task || task.status !== 'review') return false;
  const review = task.review || {};
  const metadata = task.metadata || {};
  const approvalStatus = review.approval_status || metadata.approval_status || null;
  if (approvalStatus && approvalStatus !== 'pending') return false;
  if (allowCertified) return true;
  if (review.agent_certified === true || metadata.agent_certified === true) return false;
  const reviewPassCount = Number(review.agent_review_pass_count || metadata.agent_review_pass_count || 0);
  if (reviewPassCount >= AGENT_CERTIFICATION_REVIEW_PASSES) return false;
  const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true });
  return !(handoff && (handoff.next_action === 'continue_work' || handoff.next_action === 'human_accept_waiting'));
}

function appendTaskReviewChat(taskDb, db, taskId, { reviewer = 'codex-review', dryRun = false } = {}) {
  const actor = reviewActor(reviewer);
  let task = taskDetail(taskDb, db, taskId);
  if (!task) {
    throw taskReviewChatError('not_found', `task not found: ${taskId}`, { status: 404, exitCode: 1 });
  }
  if (task.status !== 'review') {
    throw taskReviewChatError(`not_reviewable_${task.status}`, `review chat requires a task in Review; current status is ${task.status}`, { status: 409, exitCode: 1 });
  }
  if (!taskAllowsReviewChat(task, { allowCertified: true })) {
    throw taskReviewChatError('agent_certified_continue_work', 'review chat is closed after agent certification; continue other work or wait for human approval/rework on this task', { status: 409, exitCode: 1 });
  }
  const contract = taskReviewChatContract(task, { reviewer: actor, allowCertified: true });
  let event = null;
  if (!dryRun) {
    const noted = taskDb.noteTask(db, {
      id: taskId,
      actor,
      content: taskReviewChatNote(contract),
    });
    if (!noted.noted) {
      throw taskReviewChatError(noted.reason || 'note_failed', `review chat failed: ${noted.reason || 'note_failed'}`, { status: 409, exitCode: 1 });
    }
    event = noted.event;
    task = taskDetail(taskDb, db, taskId) || task;
  }
  const { projection: compactProjection, outPath } = writeDefaultProjection(taskDb, db);
  return {
    ok: true,
    action: 'review_chat',
    task_id: taskId,
    appended: !dryRun,
    version: event ? event.version : null,
    projection_path: outPath,
    contract,
    task,
    compact_task: compactTaskFromProjection(compactProjection, taskId),
    event,
    compactProjection,
    outPath,
  };
}

function taskStepError(reason, detail, { status = 409, exitCode = 1, page = null } = {}) {
  const error = new Error(detail || reason);
  error.reason = reason;
  error.status = status;
  error.exitCode = exitCode;
  error.page = page;
  return error;
}

function taskStepStatusForReason(reason) {
  if (['goal_required', 'exit_required', 'proof_needed_required', 'first_move_required', 'proof_required', 'weak_proof', 'proof_command_not_run', 'invalid_reward'].includes(reason)) {
    return 400;
  }
  if (reason === 'not_found') return 404;
  return 409;
}

function taskStepOptionsFromArgs(args) {
  const pos = positional(args);
  const messageFlag = textFlag(args, ['--message', '--content', '--text']);
  return {
    id: pos[0],
    options: {
      actor: String(flag(args, '--as') || DEFAULT_OWNER),
      reviewer: reviewActor(flag(args, '--reviewer') || flag(args, '--as-reviewer') || 'codex-review'),
      message: messageFlag || pos.slice(1).join(' ').trim(),
      goal: textFlag(args, ['--goal', '--objective']),
      summary: textFlag(args, ['--summary']),
      exit: textFlag(args, ['--exit', '--exit-condition']),
      proofNeeded: textFlag(args, ['--proof-needed', '--verify']) || proofFlagValue(args),
      firstMove: textFlag(args, ['--first-move', '--first']),
      proof: proofFlagValue(args),
      lesson: textFlag(args, ['--lesson']),
      nextTask: textFlag(args, ['--next']),
      reward: flag(args, '--reward'),
      dryRun: hasFlag(args, '--dry-run') || hasFlag(args, '--no-note'),
    },
  };
}

function taskCurrentStepOptionsFromArgs(args) {
  const pos = positional(args);
  const messageFlag = textFlag(args, ['--message', '--content', '--text']);
  const owner = String(flag(args, '--owner') || flag(args, '--as') || DEFAULT_OWNER);
  return {
    owner,
    scope: taskQueueScopeFromArgs(args),
    stepOptions: {
      actor: String(flag(args, '--as') || owner),
      reviewer: reviewActor(flag(args, '--reviewer') || flag(args, '--as-reviewer') || 'codex-review'),
      message: messageFlag || pos.join(' ').trim(),
      goal: textFlag(args, ['--goal', '--objective']),
      summary: textFlag(args, ['--summary']),
      exit: textFlag(args, ['--exit', '--exit-condition']),
      proofNeeded: textFlag(args, ['--proof-needed', '--verify']) || proofFlagValue(args),
      firstMove: textFlag(args, ['--first-move', '--first']),
      proof: proofFlagValue(args),
      lesson: textFlag(args, ['--lesson']),
      nextTask: textFlag(args, ['--next']),
      reward: flag(args, '--reward'),
      dryRun: hasFlag(args, '--dry-run') || hasFlag(args, '--no-note'),
    },
  };
}

function taskStepOptionsFromBody(body = {}) {
  return {
    actor: String(body.actor || DEFAULT_OWNER),
    reviewer: reviewActor(body.reviewer || body.review_actor || body.reviewActor || 'codex-review'),
    message: String(body.message || body.content || body.text || '').trim(),
    goal: String(body.goal || body.objective || '').trim(),
    summary: String(body.summary || '').trim(),
    exit: String(body.exit || body.exit_condition || body.exitCondition || '').trim(),
    proofNeeded: String(body.proof_needed || body.proofNeeded || body.verify || body.proof || '').trim(),
    firstMove: String(body.first_move || body.firstMove || body.first || '').trim(),
    proof: String(body.proof || '').trim(),
    lesson: String(body.lesson || '').trim(),
    nextTask: String(body.next || body.next_task || body.nextTask || '').trim(),
    reward: body.reward,
    dryRun: Boolean(body.dryRun || body.noNote || body.dry_run),
  };
}

function taskCurrentStepOptionsFromBody(body = {}, searchParams = new URLSearchParams()) {
  const stepOptions = taskStepOptionsFromBody(body);
  const queryScope = taskQueueScopeFromSearchParams(searchParams);
  const bodyScope = taskQueueScopeFromBody(body);
  const queryOwner = searchParams.get('owner') || searchParams.get('as') || searchParams.get('actor');
  const queryReviewer = searchParams.get('reviewer') || searchParams.get('as_reviewer') || searchParams.get('as-reviewer');
  const bodyOwner = body.owner || body.as;
  const owner = String(queryOwner || bodyOwner || body.actor || DEFAULT_OWNER);
  stepOptions.actor = String(body.actor || body.as || body.owner || queryOwner || owner);
  stepOptions.reviewer = reviewActor(body.reviewer || body.review_actor || body.reviewActor || queryReviewer || stepOptions.reviewer);
  return {
    owner,
    scope: mergeTaskQueueScopes(queryScope, bodyScope),
    stepOptions,
  };
}

function parseStepReviewReward(value) {
  if (value === undefined || value === null || value === true || value === '') return { ok: true, value: 0 };
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return { ok: false, reason: 'invalid_reward' };
  return { ok: true, value: numeric };
}

function taskStepFailure(command, result, page) {
  const reason = result && result.reason || 'step_failed';
  throw taskStepError(reason, stageErrorDetail(command, reason, result || {}), {
    status: taskStepStatusForReason(reason),
    exitCode: reason === 'not_found' ? 1 : 2,
    page,
  });
}

function readyHandoffForStep(task, proof, lesson, nextTask, agentCertified) {
  const verifierTask = taskWithReviewEvidence(taskWithAgentCertification(task, agentCertified), { proof, lesson, nextTask });
  const reviewChat = taskReviewChatHandoff(verifierTask, { reviewer: 'codex-review' });
  const handoff = {
    native_goal_status: agentCertified ? 'agent_certified' : 'needs_second_agent_review',
    career_xp_status: 'pending_human_accept',
    next_action: agentCertified ? certifiedReviewNextAction(nextTask) : 'agent_review_again',
    rule: agentCertified
      ? 'Double-check complete; ready to keep moving. XP is awarded only after the human approves the task.'
      : 'Proof is ready; one more agent check before human approval. XP waits for the human.',
  };
  if (reviewChat) {
    handoff.review_chat_command = reviewChat.command;
    handoff.codex_prompt = reviewChat.codex_prompt;
    handoff.verification_focus = reviewChat.verification_focus;
  }
  return handoff;
}

function runTaskStep(taskDb, db, taskId, options = {}) {
  const actor = String(options.actor || DEFAULT_OWNER);
  const reviewer = reviewActor(options.reviewer || 'codex-review');
  let task = taskDetail(taskDb, db, taskId);
  if (!task) throw taskStepError('not_found', `task not found: ${taskId}`, { status: 404, exitCode: 1 });
  const initialPage = taskPageContract(task, { reviewer });
  const initialHandoffState = task.status === 'review' ? reviewHandoffForTask(task, { suppressExistingFollowUp: true }) : null;
  if (initialHandoffState && (initialHandoffState.next_action === 'continue_work' || initialHandoffState.next_action === 'human_accept_waiting')) {
    const reason = initialHandoffState.next_action === 'continue_work'
      ? 'agent_certified_continue_work'
      : 'agent_certified_waiting_human';
    throw taskStepError(reason, 'atris task step: approval-ready rows have no safe agent step; continue other work or wait for human approval/rework on this task', { status: 409, exitCode: 1, page: initialPage });
  }
  let chat = null;
  const message = String(options.message || '').trim();
  const goal = String(options.goal || '').trim();
  const summary = String(options.summary || '').trim();
  if (message || goal || summary) {
    const chatted = taskDb.chatTask(db, { id: taskId, actor, content: message, goal, summary });
    if (!chatted.chatted) taskStepFailure('atris task step', chatted, initialPage);
    chat = {
      action: 'chatted',
      version: chatted.event.version,
      goal_changed: chatted.goal_changed,
      chat_packet: chatted.chat_packet,
    };
    task = taskDetail(taskDb, db, taskId) || task;
  }
  const actionPage = taskPageContract(task, { reviewer });
  const current = actionPage.stage.current;
  let stepAction = null;
  let version = null;
  let stagePacket = null;
  let handoff = null;
  let contract = null;
  let episode = null;
  let xpProjection = null;
  if (current === 'backlog') {
    const automaticPlan = buildAutomaticPlanTrace(taskDb, task, {
      actor,
      owner: actor,
      goal,
      summary,
      firstMove: String(options.firstMove || ''),
      exit: String(options.exit || ''),
    });
    const planned = taskDb.stageTask(db, {
      id: taskId,
      actor,
      stage: 'plan',
      goal,
      summary,
      owner: automaticPlan.ownerForStage || actor,
      exit: String(options.exit || ''),
      proofNeeded: String(options.proofNeeded || ''),
      firstMove: String(options.firstMove || ''),
      planTrace: automaticPlan.trace,
    });
    if (!planned.staged) taskStepFailure('atris task step', planned, actionPage);
    stepAction = 'planned';
    version = planned.event.version;
    stagePacket = planned.stage_packet;
  } else if (current === 'plan') {
    const firstMove = String(options.firstMove || '').trim();
    if (!firstMove) {
      throw taskStepError('first_move_required', 'atris task step: --first-move required', { status: 400, exitCode: 2, page: actionPage });
    }
    const doing = taskDb.stageTask(db, {
      id: taskId,
      actor,
      stage: 'do',
      goal,
      summary,
      owner: actor,
      exit: String(options.exit || ''),
      proofNeeded: String(options.proofNeeded || ''),
      firstMove,
    });
    if (!doing.staged) taskStepFailure('atris task step', doing, actionPage);
    stepAction = 'doing';
    version = doing.event.version;
    stagePacket = doing.stage_packet;
  } else if (current === 'do') {
    const proof = String(options.proof || '').trim();
    const proofIssue = meaningfulTaskProofIssue(proof);
    if (proofIssue) {
      throw taskStepError(proof ? 'weak_proof' : 'proof_required', weakProofDetail(proofIssue), { status: 400, exitCode: 2, page: actionPage });
    }
    const unrunIssue = unrunNamedProofCommandIssue(proof, '');
    if (unrunIssue) {
      throw taskStepError(unrunIssue.reason, unrunIssue.detail, { status: 400, exitCode: 2, page: actionPage });
    }
    const missionXpIssue = missionXpEndToEndProofIssue(task, proof, task.workspace_root || process.cwd());
    if (missionXpIssue) {
      throw taskStepError(MISSION_XP_END_TO_END_REASON, missionXpIssue, { status: 409, exitCode: 1, page: actionPage });
    }
    const lesson = String(options.lesson || '');
    const nextTask = String(options.nextTask || '');
    const resultTrace = buildAutomaticResultTrace(taskDb, db, taskId, { actor, proof });
    const missionResult = missionReceiptResultForProof(task, proof, task.workspace_root || process.cwd());
    const ready = taskDb.readyTask(db, {
      id: taskId,
      actor,
      proof,
      lesson,
      nextTask,
      resultTrace: resultTrace && resultTrace.trace,
      result: missionResult ? missionResult.changed : undefined,
      reason: missionResult ? missionResult.reason : undefined,
    });
    if (!ready.ready) taskStepFailure('atris task step', ready, actionPage);
    task = taskDetail(taskDb, db, taskId) || task;
    stepAction = 'ready';
    version = ready.event.version;
    handoff = readyHandoffForStep(task, proof, lesson, nextTask, ready.event.payload.agent_certified === true);
  } else if (current === 'review' && task.status === 'review') {
    const handoffState = reviewHandoffForTask(task, { suppressExistingFollowUp: true });
    if (handoffState && handoffState.next_action === PROOF_BOUNDARY_BLOCKED_ACTION) {
      const detail = handoffState.reason === MISSION_XP_END_TO_END_REASON
        ? `atris task step: ${MISSION_XP_END_TO_END_DETAIL}`
        : 'atris task step: Review proof cites an open/draft/unmerged PR boundary; revise the row before further stepping';
      throw taskStepError(PROOF_BOUNDARY_BLOCKED_REASON, detail, { status: 409, exitCode: 1, page: actionPage });
    }
    if (handoffState && (handoffState.next_action === 'continue_work' || handoffState.next_action === 'human_accept_waiting')) {
      const reason = handoffState.next_action === 'continue_work'
        ? 'agent_certified_continue_work'
        : 'agent_certified_waiting_human';
      throw taskStepError(reason, 'atris task step: approval-ready rows have no safe agent step; continue other work or wait for human approval/rework on this task', { status: 409, exitCode: 1, page: actionPage });
    }
    const reviewed = appendTaskReviewChat(taskDb, db, taskId, { reviewer, dryRun: Boolean(options.dryRun) });
    stepAction = 'review_chat';
    version = reviewed.version;
    contract = reviewed.contract;
  } else if (current === 'review') {
    const proof = String(options.proof || '').trim();
    const proofIssue = meaningfulTaskProofIssue(proof);
    if (proofIssue) {
      throw taskStepError(proof ? 'weak_proof' : 'proof_required', weakProofDetail(proofIssue), { status: 400, exitCode: 2, page: actionPage });
    }
    const unrunIssue = unrunNamedProofCommandIssue(proof, '');
    if (unrunIssue) {
      throw taskStepError(unrunIssue.reason, unrunIssue.detail, { status: 400, exitCode: 2, page: actionPage });
    }
    const parsedReward = parseStepReviewReward(options.reward);
    if (!parsedReward.ok) {
      throw taskStepError('invalid_reward', 'atris task step: --reward must be zero or a positive number', { status: 400, exitCode: 2, page: actionPage });
    }
    const reviewed = taskDb.reviewTask(db, {
      id: taskId,
      actor: reviewer,
      reward: parsedReward.value,
      lesson: String(options.lesson || ''),
      nextTask: String(options.nextTask || ''),
      proof,
      careerXpEligible: false,
    });
    if (!reviewed.reviewed) taskStepFailure('atris task step', reviewed, actionPage);
    stepAction = 'reviewed';
    version = reviewed.event.version;
    episode = reviewed.episode;
    xpProjection = refreshCareerXpAfterReview(reviewed);
  } else {
    throw taskStepError('no_next_action', `atris task step: no safe agent action for ${current}`, { status: 409, exitCode: 1, page: actionPage });
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const finalTask = taskDetail(taskDb, db, taskId) || task;
  return {
    ok: true,
    action: 'stepped',
    task_id: taskId,
    step_action: stepAction,
    version,
    chat,
    stage_packet: stagePacket,
    handoff,
    contract,
    episode,
    xp_projection: xpProjection,
    projection_path: outPath,
    previous_page: initialPage,
    page: taskPageContract(finalTask, { reviewer }),
    task: compactTaskFromProjection(projection, taskId),
  };
}

function runCurrentTaskStep(taskDb, db, { owner = DEFAULT_OWNER, reviewer = 'codex-review', scope = {}, stepOptions = {} } = {}) {
  const before = buildTaskCurrent(taskDb, db, [], { owner, reviewer, scope });
  const current = before.current;
  if (!current.selected_task_id) {
    const error = taskStepError('no_current_task', 'atris task current-step: no scoped current task selected', {
      status: 409,
      exitCode: 1,
      page: null,
    });
    error.current = current;
    throw error;
  }
  const actor = String(stepOptions.actor || owner || DEFAULT_OWNER);
  const selectedTask = taskDetail(taskDb, db, current.selected_task_id);
  if (selectedTask && selectedTask.claimed_by && selectedTask.claimed_by !== actor) {
    const error = taskStepError('claimed_by_other', `atris task current-step: scoped current task is claimed by ${selectedTask.claimed_by}; rerun as that owner or narrow the scope`, {
      status: 409,
      exitCode: 1,
      page: current.page,
    });
    error.current = current;
    throw error;
  }
  const safeReasons = new Set(['claimed_by_owner', 'review_needs_agent_verification', 'review_proof_boundary_blocked', 'plan_ready', 'backlog_idea', 'review_certified_waiting_human']);
  if (!safeReasons.has(current.selected_reason)) {
    const error = taskStepError(
      'unsafe_current_selection',
      `atris task current-step: ${current.selected_reason} is read-only; select a task owned by ${current.owner} or use atris task step <id> intentionally`,
      {
        status: 409,
        exitCode: 1,
        page: current.page,
      },
    );
    error.current = current;
    throw error;
  }
  if (current.selected_reason === 'claimed_by_owner' && current.selected?.claimed_by && current.selected.claimed_by !== actor) {
    const error = taskStepError(
      'current_step_owner_mismatch',
      `atris task current-step: selected task is claimed by ${current.selected.claimed_by}, but step actor is ${actor}`,
      {
        status: 409,
        exitCode: 1,
        page: current.page,
      },
    );
    error.current = current;
    throw error;
  }
  const nextActionKey = selectedNextKeyFromCurrent(current);
  if (nextActionKey === 'human_accept_waiting') {
    const error = taskStepError(
      'agent_certified_waiting_human',
      'atris task current-step: selected row is ready for human approval; no agent mutation is safe',
      {
        status: 409,
        exitCode: 1,
        page: current.page,
      },
    );
    error.current = current;
    throw error;
  }
  if (nextActionKey === PROOF_BOUNDARY_BLOCKED_ACTION) {
    const boundaryReason = current.page?.review?.handoff?.reason || current.selected?.review?.handoff?.reason || '';
    const detail = boundaryReason === MISSION_XP_END_TO_END_REASON
      ? `atris task current-step: ${MISSION_XP_END_TO_END_DETAIL}`
      : 'atris task current-step: selected Review row has stale/open/draft/unmerged PR proof; revise it instead of accepting or auto-stepping';
    const error = taskStepError(
      PROOF_BOUNDARY_BLOCKED_REASON,
      detail,
      {
        status: 409,
        exitCode: 1,
        page: current.page,
      },
    );
    error.current = current;
    throw error;
  }
  if (nextActionKey === 'continue_work') {
    const continued = continueWorkForReviewTask(taskDb, db, current.selected_task_id, { owner: actor });
    const after = buildTaskCurrent(taskDb, db, [], { owner, reviewer, scope });
    const nextTask = continued.next_task_id ? taskDetail(taskDb, db, continued.next_task_id) : null;
    const nextPage = nextTask ? taskPageContract(nextTask, { reviewer }) : current.page;
    const step = {
      ok: true,
      action: 'stepped',
      task_id: current.selected_task_id,
      step_action: 'continue_work',
      version: null,
      chat: null,
      stage_packet: null,
      handoff: current.page && current.page.review ? current.page.review.handoff : null,
      contract: null,
      episode: null,
      xp_projection: null,
      projection_path: continued.projection_path,
      previous_page: current.page,
      page: nextPage,
      task: continued.next_task,
      parent: continued.parent,
      next_task: continued.next_task,
      continue_work: continued,
    };
    return {
      ok: true,
      action: 'current_step',
      projection_path: after.outPath,
      selected_task_id: current.selected_task_id,
      selected_ref: current.selected_ref || null,
      selected_next_key: nextActionKey,
      selected_reason: current.selected_reason,
      scope: current.scope,
      before: current,
      before_current: current,
      step,
      after: {
        current: after.current,
        page: step.page,
        task: step.task,
      },
      after_current: after.current,
      current: after.current,
      page: step.page,
      task: step.task,
      safety: {
        read_only: false,
        claims_work: false,
        human_accept: false,
        xp_after_human_accept: true,
      },
    };
  }
  let step;
  try {
    step = runTaskStep(taskDb, db, current.selected_task_id, { ...stepOptions, actor });
  } catch (error) {
    error.current = current;
    throw error;
  }
  const after = buildTaskCurrent(taskDb, db, [], { owner, reviewer, scope });
  return {
    ok: true,
    action: 'current_step',
    projection_path: after.outPath,
    selected_task_id: current.selected_task_id,
    selected_ref: current.selected_ref || null,
    selected_next_key: nextActionKey,
    selected_reason: current.selected_reason,
    scope: current.scope,
    before: current,
    before_current: current,
    step,
    after: {
      current: after.current,
      page: step.page,
      task: step.task,
    },
    after_current: after.current,
    current: after.current,
    page: step.page,
    task: step.task,
    safety: {
      read_only: false,
      claims_work: step.step_action === 'doing',
      human_accept: false,
      xp_after_human_accept: true,
    },
  };
}

function cmdCurrentStep(args) {
  const { owner, scope, stepOptions } = taskCurrentStepOptionsFromArgs(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  let result;
  try {
    result = runCurrentTaskStep(taskDb, db, {
      owner,
      reviewer: stepOptions.reviewer,
      scope,
      stepOptions,
    });
  } catch (error) {
    const errorCurrent = error.current || null;
    if (wantsJson(args)) {
      const selectedRef = errorCurrent ? errorCurrent.selected_ref : null;
      const nextCommand = error.page?.stage?.next_action?.command
        || (errorCurrent && errorCurrent.next && errorCurrent.next.command)
        || null;
      printCliJson(
        {
          ok: false,
          action: 'current_step',
          reason: error.reason || 'step_failed',
          detail: error.message,
          selected_task_id: errorCurrent ? errorCurrent.selected_task_id : null,
          selected_ref: selectedRef,
          selected_next_key: selectedNextKeyFromCurrent(errorCurrent),
          next_command: nextCommand,
          current: errorCurrent,
          page: error.page || null,
        },
        compactErrorPayload({
          reason: error.reason || 'step_failed',
          detail: error.message,
          selected_ref: selectedRef,
          next_command: nextCommand,
        }),
        args,
      );
    } else {
      console.error(error.message || 'atris task current-step failed');
    }
    process.exit(error.exitCode || 1);
  }
  if (wantsJson(args)) {
    const nextCommand = result.page?.stage?.next_action?.command || null;
    printCliJson(
      result,
      compactSuccessPayload({
        action: 'current_step',
        ids: {
          selected_task_id: result.selected_task_id || null,
          selected_ref: result.selected_ref || null,
          step_action: result.step && result.step.step_action ? result.step.step_action : null,
        },
        next_command: nextCommand,
      }),
      args,
    );
    return;
  }
  console.log(`current-step ${taskRef(result.task)} -> ${result.step.step_action}`);
  console.log(`Stage: ${result.page.stage.current}`);
  if (result.page.stage.next_action && result.page.stage.next_action.command) {
    console.log(`Next: ${result.page.stage.next_action.command}`);
  }
}

function selectedNextKeyFromCurrent(current) {
  if (!current) return null;
  if (current.next && current.next.key) return current.next.key;
  if (current.page && current.page.stage && current.page.stage.next_action) {
    return current.page.stage.next_action.key || null;
  }
  return null;
}

function cmdStep(args) {
  const { id, options } = taskStepOptionsFromArgs(args);
  if (!id) {
    failTask('atris task step', 'missing_id', 'id required');
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task step');
  let result;
  try {
    result = runTaskStep(taskDb, db, taskId, options);
  } catch (error) {
    if (wantsJson(args)) {
      printJson({
        ok: false,
        action: 'step',
        task_id: taskId,
        reason: error.reason || 'step_failed',
        detail: error.message,
        page: error.page || null,
      });
    } else {
      console.error(error.message || 'atris task step failed');
    }
    process.exit(error.exitCode || 1);
  }
  if (wantsJson(args)) {
    printJson(result);
    return;
  }
  console.log(`step ${taskRef(result.task)} -> ${result.step_action}`);
  console.log(`Stage: ${result.page.stage.current}`);
  if (result.page.stage.next_action && result.page.stage.next_action.command) {
    console.log(`Next: ${result.page.stage.next_action.command}`);
  }
}

function cmdDone(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task done', 'missing_id', 'id required');
  }
  const failed = hasFlag(args, '--failed');
  const proof = proofFlagValue(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task done');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const beforeTask = taskDb.getTask(db, taskId);
  const hasReview = hasFlag(args, '--review') || flag(args, '--lesson') || flag(args, '--next') || flag(args, '--proof') || flag(args, '--reward');
  if (agentProofOnlyMode() && !failed) {
    failAgentProofOnly(
      'atris task done',
      'Agent proof-only mode cannot mark tasks done. Use `atris task ready <id> --proof "..." --result "<day-one PM sentence>"` or `atris task review <id> --reward 0 --proof "..."`.',
    );
  }
  const canComplete = beforeTask && (beforeTask.status === 'open' || beforeTask.status === 'claimed');
  if (canComplete) {
    if (!failed || hasReview) requireMeaningfulTaskProof('atris task done', proof);
    else if (proof) requireMeaningfulTaskProof('atris task done', proof);
  }
  const result = taskDb.doneTask(db, {
    id: taskId,
    status: failed ? 'failed' : 'done',
    actor,
    action: failed ? 'failed' : 'done',
    proof,
  });
  if (result.updated) {
    const review = hasReview ? taskDb.reviewTask(db, {
      id: taskId,
      actor,
      reward: flag(args, '--reward') || (failed ? 0 : 1),
      lesson: typeof flag(args, '--lesson') === 'string' ? flag(args, '--lesson') : '',
      nextTask: typeof flag(args, '--next') === 'string' ? flag(args, '--next') : '',
      proof,
      careerXpEligible: false,
    }) : null;
    const xpProjection = refreshCareerXpAfterReview(review);
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: failed ? 'failed' : 'done',
        task_id: taskId,
        reviewed: Boolean(review && review.reviewed),
        reward: review && review.episode ? review.episode.reward.value : null,
        episode: review && review.episode || null,
        xp_projection: xpProjection,
        projection_path: outPath,
        task: compactTaskFromProjection(projection, taskId),
      });
      return;
    }
    const task = compactTaskFromProjection(projection, taskId);
    if (review && review.reviewed) {
      console.log(`${failed ? 'failed' : 'done'} ${taskRef(task)} reward=${review.episode.reward.value}`);
    } else {
      console.log(`${failed ? 'failed' : 'done'} ${taskRef(task)}`);
    }
  } else {
    const detail = `done failed: ${taskId} not in open|claimed`;
    if (wantsJson(args)) {
      printJson({
        ok: false,
        command: 'atris task done',
        reason: 'not_open_or_claimed',
        task_id: taskId,
        detail,
      });
      process.exit(1);
    }
    console.error(detail);
    process.exit(1);
  }
}

function cmdFinish(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task finish', 'missing_id', 'id required');
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task finish');
  const currentTask = taskDb.getTask(db, taskId);
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const proof = proofFlagValue(args);
  const landing = landingFlags(args);
  const failed = hasFlag(args, '--failed');
  const hasReview = hasFlag(args, '--review') || flag(args, '--lesson') || flag(args, '--next') || flag(args, '--proof') || flag(args, '--reward');
  if (agentProofOnlyMode() && !failed) {
    failAgentProofOnly(
      'atris task finish',
      'Agent proof-only mode cannot finish tasks. Use `atris task ready <id> --proof "..." --result "<day-one PM sentence>"` or `atris task review <id> --reward 0 --proof "..."`.',
    );
  }
  const canComplete = currentTask && (currentTask.status === 'open' || currentTask.status === 'claimed');
  if (canComplete) {
    if (!failed || hasReview) requireMeaningfulTaskProof('atris task finish', proof);
    else if (proof) requireMeaningfulTaskProof('atris task finish', proof);
    if (!failed && hasReview) requireExplicitLandingDayOnePm('atris task finish', landing, currentTask.title);
  }
  const done = taskDb.doneTask(db, {
    id: taskId,
    status: failed ? 'failed' : 'done',
    actor,
    action: failed ? 'failed' : 'finished',
    proof,
  });
  if (!done.updated) {
    const detail = `finish failed: ${taskId} not in open|claimed`;
    if (wantsJson(args)) {
      printJson({
        ok: false,
        command: 'atris task finish',
        reason: 'not_open_or_claimed',
        task_id: taskId,
        detail,
      });
      process.exit(1);
    }
    console.error(detail);
    process.exit(1);
  }
  if (hasReview) {
    const landingAdvisory = !failed ? warnIfLandingNeedsDayOnePm(landing, currentTask && currentTask.title) : null;
    const result = taskDb.reviewTask(db, {
      id: taskId,
      actor,
      reward: flag(args, '--reward') || 1,
      lesson: typeof flag(args, '--lesson') === 'string' ? flag(args, '--lesson') : '',
      nextTask: typeof flag(args, '--next') === 'string' ? flag(args, '--next') : '',
      proof,
      careerXpEligible: false,
      landing,
    });
    const nextCreated = createNextTaskIfRequested(taskDb, db, args, currentTask, result.episode.next_task_suggestion);
    const xpProjection = refreshCareerXpAfterReview(result);
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'finished',
        task_id: taskId,
        reviewed: true,
        reward: result.episode.reward.value,
        episode: result.episode,
        xp_projection: xpProjection,
        landing_advisory: landingAdvisory,
        next_task_id: nextCreated ? nextCreated.id : null,
        projection_path: outPath,
        task: compactTaskFromProjection(projection, taskId),
        next_task: nextCreated ? compactTaskFromProjection(projection, nextCreated.id) : null,
      });
      return;
    }
    console.log(`finished ${taskRef(compactTaskFromProjection(projection, taskId))} reward=${result.episode.reward.value}`);
    if (result.episode.next_task_suggestion) console.log(`next: ${result.episode.next_task_suggestion}`);
    if (nextCreated) console.log(`created next ${taskRef(compactTaskFromProjection(projection, nextCreated.id))}`);
    return;
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'finished',
      task_id: taskId,
      reviewed: false,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`finished ${taskRef(compactTaskFromProjection(projection, taskId))}`);
}

// Distinct from `done --failed`: a bulk sweep of duplicates/off-roadmap work
// closes the task without ever claiming it did or didn't succeed. Writing
// 'failed' here would corrupt the reward signal readers rely on (see
// atris/reports/failed-tasks-analysis-2026-07-03.md, cluster 2, OBL-1622).
function cmdArchive(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task archive', 'missing_id', 'id required');
  }
  const reason = textFlag(args, ['--reason']);
  if (!reason) {
    failTask('atris task archive', 'missing_reason', 'atris task archive requires --reason "<why this is being swept, not failed>"');
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task archive');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  // Explicit opt-in for sanctioned failed→archived cleanup (e.g. duplicate
  // loop-tick orphans fail-closed before 'archived' existed). Without the
  // flag, failed rows stay failed; done rows are never archivable.
  const fromFailed = hasFlag(args, '--from-failed');
  const result = taskDb.archiveTask(db, { id: taskId, actor, reason, fromFailed });
  if (result.archived) {
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'archived',
        task_id: taskId,
        reason,
        archived_from: result.row && result.row.metadata && result.row.metadata.archived_from || null,
        projection_path: outPath,
        task: compactTaskFromProjection(projection, taskId),
      });
      return;
    }
    const fromNote = result.row && result.row.metadata && result.row.metadata.archived_from
      ? ` (was ${result.row.metadata.archived_from})`
      : '';
    console.log(`archived ${taskRef(compactTaskFromProjection(projection, taskId))}${fromNote}: ${reason}`);
  } else {
    const hint = result.reason === 'already_failed'
      ? ' (use --from-failed to archive a fail-closed duplicate/off-roadmap row)'
      : '';
    const detail = `archive failed: ${taskId} ${result.reason}${hint}`;
    if (wantsJson(args)) {
      printJson({ ok: false, command: 'atris task archive', reason: result.reason, task_id: taskId, detail });
      process.exit(1);
    }
    console.error(detail);
    process.exit(1);
  }
}

function taskCompletionTime(row) {
  const doneAt = Number(row && row.done_at);
  if (Number.isFinite(doneAt) && doneAt > 0) return doneAt;
  const acceptedAt = Date.parse(String(row && row.metadata && row.metadata.accepted_at || ''));
  if (Number.isFinite(acceptedAt)) return acceptedAt;
  return Number(row && (row.updated_at || row.created_at) || 0);
}

function cmdClearDone(args) {
  const beforeRaw = flag(args, '--before');
  let beforeDays = null;
  if (beforeRaw !== null) {
    beforeDays = Number(beforeRaw);
    if (beforeRaw === true || !Number.isFinite(beforeDays) || beforeDays < 0) {
      failTask('atris task clear-done', 'invalid_before', '--before requires a non-negative number of days');
    }
  }

  const dryRun = hasFlag(args, '--dry-run');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot();
  const cutoff = beforeDays === null ? null : Date.now() - (beforeDays * 24 * 60 * 60 * 1000);
  const candidates = taskDb.listTasks(db, { workspaceRoot, status: 'done', limit: null })
    .filter(row => cutoff === null || taskCompletionTime(row) < cutoff)
    .sort((a, b) => taskCompletionTime(a) - taskCompletionTime(b) || String(a.id).localeCompare(String(b.id)));
  const sample = candidates.slice(0, 5).map(row => ({
    task_id: row.id,
    title: row.title,
    completed_at: new Date(taskCompletionTime(row)).toISOString(),
  }));

  if (dryRun) {
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'clear-done',
        dry_run: true,
        before_days: beforeDays,
        count: candidates.length,
        sample,
      });
      return;
    }
    console.log(`clear-done dry-run: ${candidates.length} completed task(s) would be archived.`);
    for (const row of sample) console.log(`  - ${row.title}`);
    if (candidates.length > sample.length) console.log(`  ...and ${candidates.length - sample.length} more`);
    return;
  }

  const reason = 'cleared by clear-done sweep';
  for (const row of candidates) {
    const result = taskDb.archiveTask(db, {
      id: row.id,
      actor: String(flag(args, '--as') || DEFAULT_OWNER),
      reason,
      fromDone: true,
    });
    if (!result.archived) {
      failTask('atris task clear-done', result.reason, `clear-done failed: ${row.id} ${result.reason}`, 1);
    }
  }
  const { outPath } = writeDefaultProjection(taskDb, db);

  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'clear-done',
      dry_run: false,
      before_days: beforeDays,
      count: candidates.length,
      reason,
      sample,
      projection_path: outPath,
    });
    return;
  }
  console.log(`cleared ${candidates.length} completed task(s).`);
}

function cmdReapMissionBlockers(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot();
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const missions = require('./mission').listMissions(workspaceRoot);
  const result = taskDb.reapMissionBlockerTasks(db, { workspaceRoot, missions, actor });
  const { outPath } = writeDefaultProjection(taskDb, db);
  const taskById = new Map(taskDb.withTaskDisplayRefs(taskDb.listTasks(db, { workspaceRoot, limit: null }))
    .map(task => [task.id, task]));
  const closed = result.closed.map(row => ({
    ...row,
    task_ref: taskRef(taskById.get(row.task_id)),
  }));
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'reaped_mission_blockers',
      closed_count: closed.length,
      closed,
      projection_path: outPath,
    });
    return;
  }
  console.log(`closed ${closed.length} mission blocker task(s).`);
  for (const row of closed) {
    console.log(`closed ${row.task_ref} because its mission is ${row.mission_status}.`);
  }
}

// One-time migration for OBL-1622: the 2026-06-10 "first-principles backlog
// reset" archived ~125 certified, proof-backed tasks by writing status
// 'failed' (no distinct archived status existed yet). This relabels exactly
// the rows that carry that reset's metadata marker, using the same
// UPDATE+appendTaskEvent write path as every other status transition in
// lib/task-db.js, never a raw projection-JSON edit.
function cmdRelabelArchived(args) {
  const apply = hasFlag(args, '--apply');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot();
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const result = taskDb.relabelArchivedTasks(db, { workspaceRoot, apply, actor });
  if (apply && result.count > 0) {
    appendRelabelArchivedJournalReceipt(workspaceRoot, { actor, count: result.count, ids: result.ids });
  }
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: apply ? 'relabeled' : 'preview',
      dry_run: !apply,
      workspace_root: workspaceRoot,
      ...result,
    });
    return;
  }
  if (!apply) {
    console.log(`relabel-archived (dry-run): ${result.count} failed task(s) match the June 10 backlog-reset marker.`);
    for (const s of result.sample) console.log(`  - ${s.id} ${s.title}`);
    if (result.count > result.sample.length) console.log(`  ...and ${result.count - result.sample.length} more`);
    console.log('Run with --apply --as <you> to relabel these failed -> archived.');
    return;
  }
  console.log(`relabeled ${result.count} task(s) failed -> archived (June 10 backlog reset, OBL-1622).`);
}

function appendRelabelArchivedJournalReceipt(workspaceRoot, { actor, count, ids }) {
  if (!workspaceRoot || !fs.existsSync(path.join(workspaceRoot, 'atris'))) return null;
  const now = new Date();
  const logName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`;
  const stamp = now.toTimeString().slice(0, 5);
  const projectDir = path.join(workspaceRoot, 'atris', 'logs', logName.slice(0, 4));
  fs.mkdirSync(projectDir, { recursive: true });
  const logPath = path.join(projectDir, logName);
  const idPreview = ids.slice(0, 10).join(', ') + (ids.length > 10 ? `, ...(+${ids.length - 10} more)` : '');
  fs.appendFileSync(logPath, [
    `## ${stamp} · Task relabel: failed -> archived (OBL-1622)`,
    `- count: ${count}`,
    `- reason: June 10 backlog-reset rows mislabeled failed; relabeled to archived`,
    `- actor: ${actor}`,
    `- ids: ${idPreview}`,
    '',
  ].join('\n'), 'utf8');
  return logPath;
}

function cmdReady(args) {
  const pos = positional(args);
  const id = pos[0];
  const proofFlag = flag(args, '--proof');
  const verifyFlag = flag(args, '--verify');
  const resultFlag = textFlag(args, ['--result']);
  if (!id || (!proofFlag && !verifyFlag && !resultFlag)) {
    console.log('Usage: atris task ready <id> --proof "..." --result "<sentence>"');
    process.exit(2);
  }
  // Two ways to prove: --proof "<note>" (claimed, pattern-checked) or
  // --verify "<command>" which actually RUNS the command and gates ready on exit 0.
  // If --proof names npm test, node --test, or git diff --check, this process
  // must have run that command. A sentence that names one of those is a lie.
  const proofUrl = textFlag(args, ['--proof-url']);
  const iFetched = hasFlag(args, '--i-fetched');
  if (proofUrl && !iFetched) {
    failTask(
      'atris task ready',
      'unfetched_proof_url',
      'CI run URLs only count after atris fetches them, or with --proof-url and --i-fetched',
    );
  }
  if (iFetched && !proofUrl && !(typeof proofFlag === 'string' && /https?:\/\/github[.]com\//i.test(proofFlag))) {
    failTask(
      'atris task ready',
      'proof_url_required',
      '--i-fetched requires --proof-url <actions-run-url> (or a URL inside --proof)',
    );
  }
  const usedVerify = typeof verifyFlag === 'string' ? verifyFlag.trim() : '';
  const resultSentence = requireResultSentence('atris task ready', textFlag(args, ['--result']), {
    ready: true,
    allowCommandMention: Boolean(usedVerify),
  });
  let proof = typeof proofFlag === 'string' ? proofFlag : '';
  if (proofUrl && iFetched) {
    const attested = `[i-fetched] ${proofUrl}`;
    proof = proof.trim() ? `${proof.trim()} ${attested}` : attested;
  }
  const verifyAutoCertifyAllowed = !usedVerify || isAutoCertifyVerifyCommandAllowed(verifyFlag);
  if (usedVerify) {
    // Run the verifier once and write a receipt (pass or fail) so the review
    // gate in lib/receipt-evidence.js can validate the exact path named in
    // the proof, not just trust the prose.
    const { writeTaskReceipt } = require('../lib/task-receipt');
    const receipt = writeTaskReceipt({ taskId: id, command: verifyFlag, root: process.cwd() });
    if (!receipt.passed) {
      const detail = receipt.exit != null ? ` (exit ${receipt.exit})` : (receipt.signal ? ` (signal ${receipt.signal})` : '');
      console.error(`atris task ready: verifier failed${detail}: ${verifyFlag}`);
      if (receipt.output) console.error(receipt.output);
      else if (receipt.error) console.error(receipt.error);
      if (receipt.receiptPath) console.error(`receipt: ${receipt.receiptPath}`);
      process.exit(1);
    }
    // Exit 0 says the check passed. It does not say the check could have
    // failed. Run it again with none of the work present: a check anchored to
    // this codebase fails there, and one that passes anywhere passes there too.
    if (!hasFlag(args, '--no-falsify-check')) {
      const { probeVerifierCanFail } = require('../lib/falsifier-probe');
      const { classifyVerifier } = require('../lib/verifier-quality');
      const quality = classifyVerifier(verifyFlag);
      if (!quality.ok) {
        console.error(`atris task ready: weak verifier, ${quality.reason}`);
        console.error(`  command: ${verifyFlag}`);
        console.error('  allowlisted examples: node --test, npm test, git diff --check, node --check, rg <symbol>');
        console.error('  or pass --no-falsify-check to accept anyway.');
        process.exit(1);
      }
      const probe = probeVerifierCanFail({ command: verifyFlag });
      if (probe.probed && probe.canFail === false) {
        console.error(`atris task ready: this check cannot fail, ${probe.reason}`);
        console.error(`  command: ${verifyFlag}`);
        console.error('  give a check that fails when the work is missing, or pass --no-falsify-check to accept anyway.');
        process.exit(1);
      }
      if (!probe.probed && !wantsJson(args)) console.log(`  ${probe.reason}`);
    }
    const base = proof.trim();
    proof = `[verified] \`${verifyFlag}\` passed (exit 0)${base ? `, ${base}` : ''}${receipt.output ? `\n${receipt.output}` : ''}\nReceipt: ${receipt.receiptPath}`;
    if (!wantsJson(args)) console.log(`✓ verified: \`${verifyFlag}\` exited 0 (receipt ${receipt.receiptPath})`);
  }
  if (!proof) {
    console.error('atris task ready: --proof or --verify required');
    process.exit(2);
  }
  requireMeaningfulTaskProof('atris task ready', proof);
  requireRanNamedProofCommand('atris task ready', proof, usedVerify);
  const lesson = flag(args, '--lesson') || '';
  const nextTaskInput = normalizeReviewNextTaskInput(typeof flag(args, '--next') === 'string' ? flag(args, '--next') : '');
  const landing = landingFlags(args);
  guardExplicitActor('atris task ready', flag(args, '--as'));
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const resultFields = {
    changed: textFlag(args, ['--changed', '--done']),
    checked: textFlag(args, ['--checked', '--check', '--verified']),
    passed: textFlag(args, ['--passed', '--pass']),
    failed: textFlag(args, ['--failed', '--fail']),
    cost: textFlag(args, ['--cost']),
    saved: textFlag(args, ['--saved', '--savings']),
    tryNext: textFlag(args, ['--try', '--try-next', '--handoff']),
    status: textFlag(args, ['--status']),
    files: textFlag(args, ['--files']),
    commands: textFlag(args, ['--commands', '--command']),
  };
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task ready');
  const beforeTask = taskDetail(taskDb, db, taskId);
  requireExplicitLandingDayOnePm('atris task ready', landing, beforeTask && beforeTask.title);
  const missionXpIssue = missionXpEndToEndProofIssue(beforeTask, proof, taskDb.workspaceRoot());
  if (missionXpIssue) {
    failTask('atris task ready', MISSION_XP_END_TO_END_REASON, missionXpIssue);
  }
  const readyPolicyTask = {
    ...beforeTask,
    workspace_root: process.cwd(),
    metadata: {
      ...(beforeTask && beforeTask.metadata || {}),
      ...(resultFields.files ? { changed_files: resultFields.files } : {}),
    },
  };
  const readyPolicyGate = candidatePolicyGate(readyPolicyTask, { executeDetectors: true });
  if (!readyPolicyGate.ok) refuseCandidatePolicyGate('atris task ready', readyPolicyGate);
  const resultTrace = buildAutomaticResultTrace(taskDb, db, taskId, {
    actor,
    proof: String(proof),
    ...resultFields,
    changed: resultFields.changed || resultSentence,
  });
  const result = taskDb.readyTask(db, {
    id: taskId,
    actor,
    proof: String(proof),
    lesson: typeof lesson === 'string' ? lesson : '',
    nextTask: nextTaskInput.nextTask,
    resultTrace: resultTrace && resultTrace.trace,
    landing,
    result: resultSentence,
  });
  if (!result.ready) {
    console.error(`ready failed: ${result.reason}`);
    process.exit(1);
  }
  // Store the exact verifier command on the task itself (not just baked into
  // proof prose) so sweep --auto-accept and certify-verified can re-run it
  // live against the current checkout later, instead of re-deriving it from
  // text or trusting a receipt file that may no longer exist.
  if (usedVerify) stampReadyVerifyMetadata(taskDb, db, taskId, usedVerify);
  const landingAdvisory = warnIfLandingNeedsDayOnePm(landing, result.row && result.row.title);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const agentCertified = result.event.payload.agent_certified === true;
  const projectionTask = taskFromProjection(projection, taskId)
    || compactTaskFromProjection(projection, taskId)
    || result.row;
  const verifierTask = taskWithReviewEvidence(taskWithAgentCertification(projectionTask, agentCertified), {
    proof: String(proof),
    lesson: typeof lesson === 'string' ? lesson : '',
    nextTask: nextTaskInput.nextTask,
  });
  const reviewChat = taskReviewChatHandoff(verifierTask, { reviewer: 'codex-review' });
  const autolandLib = require('../lib/autoland');
  const workspaceRoot = taskDb.workspaceRoot();
  const autolandOn = autolandLib.liveAcceptAuthorization(workspaceRoot).ok;
  const whenLands = autolandLib.whenAutolandLands(workspaceRoot);
  const needsExternalVerifier = Boolean(usedVerify && !verifyAutoCertifyAllowed);
  const handoff = {
    native_goal_status: agentCertified ? 'agent_certified' : 'needs_second_agent_review',
    career_xp_status: 'pending_human_accept',
    next_action: agentCertified ? certifiedReviewNextAction(nextTaskInput.nextTask) : 'agent_review_again',
    rule: autolandOn
      ? (agentCertified
        ? `double-check complete; autoland will accept this ${whenLands}.`
        : needsExternalVerifier
        ? 'proof is ready; this verifier needs a second agent review because autoland cannot rerun it.'
        : `proof is ready; autoland runs the second check and lands it ${whenLands}.`)
      : (agentCertified
        ? 'double-check complete; ready to keep moving. XP is awarded only after the human approves the task.'
        : 'proof is ready; one more agent check before human approval. XP waits for the human.'),
  };
  if (reviewChat) {
    handoff.review_chat_command = reviewChat.command;
    handoff.codex_prompt = reviewChat.codex_prompt;
    handoff.verification_focus = reviewChat.verification_focus;
  }
  // Mined proof lessons without runnable detectors remain coaching. Promoted,
  // path-scoped detector lessons already passed the hard gate above.
  const { readPolicyLessons, policyHintsForProof } = require('../lib/policy-lessons');
  const policyHints = policyHintsForProof(String(proof), readPolicyLessons(taskDb.workspaceRoot()), taskDb.workspaceRoot());
  if (policyHints.length) handoff.policy_hints = policyHints;
  if (readyPolicyGate.gate.advisories.length) handoff.policy_gate = readyPolicyGate.gate;
  if (wantsJson(args)) {
    const taskCard = compactTaskFromProjection(projection, taskId);
    const nextCommand = handoff.review_chat_command
      || (agentCertified
        ? `atris task accept ${taskRef(taskCard || result.row || taskId)}`
        : `atris task reviews`);
    const fullReady = {
      ok: true,
      action: 'ready',
      task_id: taskId,
      version: result.event.version,
      approval_status: 'pending',
      review_pass_count: result.event.payload.review_pass_count,
      agent_certified: agentCertified,
      handoff,
      result_trace: resultTrace,
      landing_advisory: landingAdvisory,
      ...(nextTaskInput.ignored ? { review_next_task_ignored: nextTaskInput.ignored } : {}),
      projection_path: outPath,
      task: taskCard,
      next_command: nextCommand,
    };
    printCliJson(
      fullReady,
      compactSuccessPayload({
        action: 'ready',
        ids: {
          task_id: taskId,
          selected_ref: taskRef(taskCard || result.row || taskId),
          version: result.event.version,
          agent_certified: agentCertified,
        },
        next_command: nextCommand,
      }),
      args,
    );
    return;
  }
  console.log(`ready for approval ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
  if (resultTrace) console.log('Result trace recorded.');
  console.log(handoff.rule);
  if (!verifyAutoCertifyAllowed) {
    const ref = taskRef(compactTaskFromProjection(projection, taskId) || result.row || taskId);
    console.log(`note: this verify command is outside the auto-certify allowlist, so autoland cannot run the second check itself. use a test command like node --test <file> or git diff --check, or have a second agent run: atris task review-chat ${ref} --as <reviewer>`);
  }
  for (const hint of policyHints) {
    console.log(`policy (${hint.id}): ${hint.hint}`);
  }
}

// Standalone receipt writer: runs a verifier for a task and writes atris/runs/
// evidence without moving the task to ready. Useful when you want a receipt
// on record before or independent of a ready call, or to record a failed
// verifier run for the audit trail. `atris task ready --verify` calls the
// same writer inline and folds the resulting path into the proof.
function cmdTaskReceipt(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task receipt: id required');
    process.exit(2);
  }
  const verifyFlag = flag(args, '--verify');
  if (typeof verifyFlag !== 'string' || !verifyFlag.trim()) {
    console.error('atris task receipt: --verify "<cmd>" required');
    process.exit(2);
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task receipt');
  const { writeTaskReceipt } = require('../lib/task-receipt');
  const receipt = writeTaskReceipt({ taskId, command: verifyFlag, root: process.cwd() });
  if (wantsJson(args)) {
    printJson({
      ok: receipt.passed,
      task_id: taskId,
      command: verifyFlag,
      receipt_path: receipt.receiptPath,
      exit: receipt.exit,
      passed: receipt.passed,
    });
    if (!receipt.passed) process.exit(1);
    return;
  }
  if (receipt.passed) {
    console.log(`receipt written: ${receipt.receiptPath} (exit 0)`);
    console.log(`use: atris task ready ${taskId} --proof "Receipt: ${receipt.receiptPath}" --result "<what someone can do now and why it matters>"`);
  } else {
    console.error(`verifier failed (exit ${receipt.exit}); receipt written: ${receipt.receiptPath}`);
    if (receipt.output) console.error(receipt.output);
    process.exit(1);
  }
}

async function cmdAccept(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task accept: id required');
    process.exit(2);
  }
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const reward = flag(args, '--reward');
  const lessonFlag = flag(args, '--lesson');
  const nextTaskFlag = flag(args, '--next');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task accept');
  if (agentProofOnlyMode()) {
    failAgentProofOnly(
      'atris task accept',
      'Agent proof-only mode cannot accept tasks or award XP. Leave proof in Review for human accept/revise.',
    );
  }
  const beforeProjection = enrichTaskProjection(taskDb.taskProjection(db, { taskId }));
  const beforeTask = beforeProjection.tasks[0] || null;
  const proofFlag = flag(args, '--proof');
  const hasExplicitProof = typeof proofFlag === 'string';
  const proof = hasExplicitProof
    ? proofFlag
    : String(beforeTask?.metadata?.latest_agent_proof || '').trim();
  if (!proof) {
    console.error('atris task accept: proof required or task must already have fresh proof_ready proof');
    process.exit(2);
  }
  requireMeaningfulTaskProof('atris task accept', proof);
  const missionXpIssue = missionXpEndToEndProofIssue(beforeTask, proof, taskDb.workspaceRoot());
  if (missionXpIssue) {
    failTask('atris task accept', MISSION_XP_END_TO_END_REASON, missionXpIssue);
  }
  // The proof must be able to fail. Run the stored verify command and refuse the
  // accept if it does not parse, does not run, or does not pass. Prose describing a
  // check is not a check.
  const acceptVerify = evaluateAcceptVerify(beforeTask, taskDb.workspaceRoot());
  const verifyOverride = hasFlag(args, '--accept-unverified');
  const overrideReason = String(flag(args, '--reason') || '').trim();
  if (!acceptVerify.ok && !verifyOverride) {
    failTask(
      'atris task accept',
      acceptVerify.reason,
      `${acceptVerify.detail}. Stored verify: ${acceptVerify.command || '(none)'}. `
        + 'Fix the verify command and re-run, or accept deliberately with '
        + '--accept-unverified --reason "why this cannot be machine-checked".',
    );
  }
  if (!acceptVerify.ok && verifyOverride && !overrideReason) {
    failTask(
      'atris task accept',
      'unverified_accept_needs_reason',
      '--accept-unverified records an unfalsifiable accept in the ledger, so it requires --reason "<why>".',
    );
  }
  const readyReview = beforeTask?.review || {};
  const clearLesson = hasEmptyFlagValue(args, '--lesson');
  const clearNextTask = hasEmptyFlagValue(args, '--next');
  const lesson = clearLesson
    ? ''
    : typeof lessonFlag === 'string'
    ? lessonFlag
    : String(readyReview.lesson || beforeTask?.metadata?.latest_agent_lesson || '');
  const nextTask = clearNextTask
    ? ''
    : typeof nextTaskFlag === 'string'
    ? nextTaskFlag
    : String(readyReview.next_task || beforeTask?.metadata?.latest_agent_next_task || '');
  const clearedFields = [];
  if (clearLesson || (typeof lessonFlag === 'string' && !String(lessonFlag).trim())) clearedFields.push('lesson');
  if (clearNextTask || (typeof nextTaskFlag === 'string' && !String(nextTaskFlag).trim())) clearedFields.push('next_task');
  const parsedReward = parseAcceptReward(reward);
  if (!parsedReward.ok) {
    console.error('atris task accept: reward must be a positive number');
    process.exit(2);
  }
  const done = taskDb.doneTask(db, {
    id: taskId,
    status: 'done',
    actor,
    allowReview: true,
    action: 'accepted',
    proof,
  });
  if (!done.updated) {
    console.error(`accept failed: ${taskId} not open|claimed|review`);
    process.exit(1);
  }
  const reviewed = taskDb.reviewTask(db, {
    id: taskId,
    actor,
    reward: parsedReward.value,
    lesson,
    nextTask,
    proof,
    careerXpEligible: true,
    clearedFields,
  });
  const xpProjection = refreshCareerXpAfterReview(reviewed);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const workspaceRoot = projection.workspace_root || process.cwd();
  refreshExistingTodoMarkdown(taskDb, db, workspaceRoot);
  const brainScorecards = refreshBrainScorecardsAfterAccept(workspaceRoot);
  const nextMissionRoute = nextMissionRouteAfterAccept(workspaceRoot);
  // Inform the gate, never block it: show what the receipts named in the proof
  // actually say so the accepting human isn't trusting prose.
  const evidence = extractReceiptEvidence(proof, workspaceRoot);
  const publicSync = hasFlag(args, '--public') ? await publishAcceptAgentXp(args, actor) : null;
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'accepted',
      task_id: taskId,
      reviewed: true,
      reward: reviewed.episode.reward.value,
      episode: reviewed.episode,
      evidence,
      public_sync: publicSync,
      xp_projection: xpProjection,
      brain_scorecards: brainScorecards,
      next_mission_route: nextMissionRoute,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    if (publicSync && !publicSync.ok) process.exitCode = 1;
    return;
  }
  console.log(renderAcceptLanding({
    task: taskDetail(taskDb, db, taskId) || compactTaskFromProjection(projection, taskId),
    proof,
    nextTask,
    publicSync,
    xpProjection,
    brainScorecards,
    nextMissionRoute,
  }));
  if (publicSync && !publicSync.ok) process.exitCode = 1;
}

function stampAutoAcceptMetadata(taskDb, db, taskId, actor, policy) {
  const row = taskDb.getTask(db, taskId);
  if (!row) return;
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  metadata.auto_accepted_at = new Date().toISOString();
  metadata.auto_accepted_by = actor;
  metadata.auto_accept_policy = policy;
  db.prepare(`
    UPDATE tasks
       SET metadata = ?,
           updated_at = ?
     WHERE id = ?
  `).run(JSON.stringify(metadata), Date.now(), taskId);
}

function acceptReviewTask(taskDb, db, taskId, { actor, proof, reward, lesson = '', nextTask = '', autoAccepted = false }) {
  const task = taskDetail(taskDb, db, taskId);
  const missionXpIssue = missionXpEndToEndProofIssue(task, proof, taskDb.workspaceRoot());
  if (missionXpIssue) {
    return { ok: false, reason: MISSION_XP_END_TO_END_REASON, detail: missionXpIssue };
  }
  const done = taskDb.doneTask(db, {
    id: taskId,
    status: 'done',
    actor,
    allowReview: true,
    action: 'accepted',
    proof,
    autoAccepted,
  });
  if (!done.updated) {
    return { ok: false, reason: 'not_open_claimed_or_review' };
  }
  const reviewed = taskDb.reviewTask(db, {
    id: taskId,
    actor,
    reward,
    lesson,
    nextTask,
    proof,
    careerXpEligible: true,
    autoAccepted,
  });
  const acceptedRow = taskDb.getTask(db, taskId);
  refreshExistingTodoMarkdown(taskDb, db, acceptedRow && acceptedRow.workspace_root);
  return { ok: true, reviewed };
}

// Second-actor certification for proof-backed Review rows whose proof names a
// runnable, allowlisted check. Re-running that check as a distinct actor IS
// the independent verification the certification gate asks for, the row
// becomes certified and autoland can land it on the same heartbeat. Rows in
// denied lanes, without a runnable check, or already certified keep their
// existing paths (review chats, human accept).
function certifyVerifyCandidate(task) {
  const metadata = task.metadata || {};
  const review = task.review || {};
  const recorded = typeof metadata.verify === 'string' && metadata.verify.trim() ? [metadata.verify.trim()] : [];
  const proof = String(review.proof || metadata.latest_agent_proof || '');
  for (const raw of [...recorded, ...taskReviewEvidenceCommands(proof)]) {
    // The evidence extractor can keep trailing prose ("git diff --check. Evidence
    // inspected: ..."); try the full clause, then the first sentence of it.
    for (const candidate of [raw, raw.split(/\.(?:\s|$)/)[0]].map((c) => String(c || '').trim())) {
      if (candidate && parseVerifyCommand(candidate).ok) return candidate;
    }
  }
  return null;
}

function stampCertifyVerifyMetadata(taskDb, db, taskId, actor, verify) {
  const row = taskDb.getTask(db, taskId);
  if (!row) return;
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  metadata.verify = metadata.verify || verify;
  metadata.certified_verified_at = new Date().toISOString();
  metadata.certified_verified_by = actor;
  metadata.machine_verified = true;
  db.prepare(`
    UPDATE tasks
       SET metadata = ?,
           updated_at = ?
     WHERE id = ?
  `).run(JSON.stringify(metadata), Date.now(), taskId);
}

function currentHeadSha(workspaceRoot) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: workspaceRoot || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

// metadata.verify_cache is the read path's only verify verdict: `reviews`
// must never spawn a check (that read-side execution fork-bombed the fleet
// on 2026-07-29), so the two lanes that legitimately execute verifies,
// certify-verified and the autoland landing re-check, persist the outcome
// here for the read path to consult.
function stampVerifyCacheMetadata(taskDb, db, taskId, { verify, result, actor, workspaceRoot }) {
  const row = taskDb.getTask(db, taskId);
  if (!row) return;
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  metadata.verify_cache = {
    command: verify,
    ok: result && result.ok === true,
    reason: (result && result.reason) || null,
    ran_at: new Date().toISOString(),
    ran_by: actor,
    code_sha: currentHeadSha(workspaceRoot),
  };
  db.prepare(`
    UPDATE tasks
       SET metadata = ?,
           updated_at = ?
     WHERE id = ?
  `).run(JSON.stringify(metadata), Date.now(), taskId);
}

function cachedVerifyVerdict(task, root) {
  const metadata = (task && task.metadata) || {};
  const cache = metadata.verify_cache;
  if (!cache || typeof cache !== 'object') return { fresh: false, command: metadata.verify || null };
  const fresh = cache.command === metadata.verify
    && (!cache.code_sha || cache.code_sha === currentHeadSha(task.workspace_root || root));
  return { ...cache, fresh: Boolean(fresh) };
}

// `atris task ready --verify "<cmd>"` already runs the command live and
// gates on exit 0, but that alone leaves no machine re-runnable trace once
// the proof text scrolls out of easy reach: storing the exact command on
// metadata.verify is what lets sweep --auto-accept (and certify-verified)
// re-run it later against the current checkout instead of re-parsing prose.
function stampReadyVerifyMetadata(taskDb, db, taskId, verify) {
  const row = taskDb.getTask(db, taskId);
  if (!row) return;
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  metadata.verify = verify;
  db.prepare(`
    UPDATE tasks
       SET metadata = ?,
           updated_at = ?
     WHERE id = ?
  `).run(JSON.stringify(metadata), Date.now(), taskId);
}

function landingVerifyFailureNote(verify, result) {
  const exit = result && result.status != null ? result.status : 'unknown';
  return `Autoland re-ran allowlisted verify at landing and it failed: ${verify} (exit ${exit}).`;
}

function reverifyBeforeLanding(taskDb, db, task, { actor = 'autoland-verifier', verifyCache = null } = {}) {
  const verify = certifyVerifyCandidate(task);
  if (!verify) {
    // No runnable check on record. Landing anyway converts "never verified"
    // into "accepted with XP", the exact signal poisoning this gate exists
    // to prevent, so bounce the task back for a recorded verify instead.
    const note = 'Autoland refused to land without a runnable verify command: record one with `atris task ready --verify "<cmd>" --result "<sentence>"`.';
    const revised = taskDb.reviseTask(db, { id: task.id, actor, note });
    return {
      ok: false,
      verify: null,
      result: { reason: 'strict_verify_missing', status: null },
      note,
      revised: revised.revised === true,
      revise_reason: revised.reason || null,
    };
  }
  const result = runVerifyCommandCached(verify, task.workspace_root || process.cwd(), verifyCache);
  stampVerifyCacheMetadata(taskDb, db, task.id, { verify, result, actor, workspaceRoot: task.workspace_root });
  if (result.ok) return { ok: true, verify, result };
  const note = landingVerifyFailureNote(verify, result);
  const revised = taskDb.reviseTask(db, {
    id: task.id,
    actor,
    note,
  });
  return {
    ok: false,
    verify,
    result,
    note,
    revised: revised.revised === true,
    revise_reason: revised.reason || null,
  };
}

function cmdCertifyVerified(args, options = {}) {
  const dryRun = hasFlag(args, '--dry-run');
  const asJson = wantsJson(args);
  const silent = options.silent === true;
  const verifyCache = options.verifyCache || null;
  const actor = String(flag(args, '--as') || 'autoland-verifier');
  const limitRaw = flag(args, '--limit');
  const max = limitRaw && limitRaw !== true ? Math.max(1, Number(limitRaw) || 6) : 6;

  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection } = writeDefaultProjection(taskDb, db);
  const candidates = (projection.tasks || [])
    .filter((t) => t && t.status === 'review')
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
    .slice(0, max);
  const results = [];
  for (const item of candidates) {
    const fullProjection = enrichTaskProjection(taskDb.taskProjection(db, { taskId: item.id }));
    const task = fullProjection.tasks[0] || null;
    if (!task) {
      results.push({ ref: item.display_id || item.id, action: 'skipped', reason: 'task_not_found' });
      continue;
    }
    const ref = task.display_id || task.legacy_ref || task.id;
    const metadata = task.metadata || {};
    const review = task.review || {};
    if (task.status !== 'review') {
      results.push({ ref, action: 'skipped', reason: 'not_in_review' });
      continue;
    }
    const approval = String(review.approval_status || metadata.approval_status || 'pending').toLowerCase();
    if (approval !== 'pending') {
      results.push({ ref, action: 'skipped', reason: `approval_${approval}` });
      continue;
    }
    const tag = String(task.tag || '').toLowerCase();
    if (DENIED_TAGS.has(tag)) {
      results.push({ ref, action: 'skipped', reason: `denied_tag_${tag}` });
      continue;
    }
    const proofBoundary = proofBoundaryBlockedEvaluation(task);
    if (proofBoundary) {
      results.push({ ref, action: 'skipped', reason: proofBoundary.reason });
      continue;
    }
    // Skip only rows the accept lane can already land, or rows blocked by
    // something an executed second-actor check cannot cure. A row with two
    // passes from ONE actor is exactly what this command exists to cure,
    // "certified" alone is not landable.
    // strictVerify stays off in this eligibility probe: certify-verified runs
    // the check itself right below, and strict mode here would execute it a
    // second time per row before the real run. executeVerify: false as well,
    // an untrusted trust tier re-enables the strict block internally even
    // with strictVerify off, which is how this probe spawned a verify per row.
    const evaluation = evaluateAutoAccept(task, { strictVerify: false, executeVerify: false });
    if (evaluation.eligible) {
      results.push({ ref, action: 'skipped', reason: 'already_landable' });
      continue;
    }
    // proof_not_executed is curable by definition: this command re-runs the
    // named check and replaces the free-text claim with executed evidence.
    const curable = ['not_agent_certified', 'needs_independent_reviewer', 'needs_second_reviewer_or_third_pass', 'insufficient_review_passes', 'proof_not_executed'];
    if (!curable.includes(evaluation.reason)) {
      results.push({ ref, action: 'skipped', reason: evaluation.reason });
      continue;
    }
    // judge != worker: the re-run only counts as an independent check when
    // its actor is not the builder of the row it is judging.
    const builder = reviewIntegrity.taskBuilder(task);
    if (builder && reviewIntegrity.normalizeActor(actor) === builder) {
      results.push({ ref, action: 'skipped', reason: 'verifier_is_builder' });
      continue;
    }
    const verify = certifyVerifyCandidate(task);
    if (!verify) {
      results.push({ ref, action: 'skipped', reason: 'no_runnable_check_in_proof' });
      continue;
    }
    if (dryRun) {
      results.push({ ref, action: 'would_certify', verify });
      continue;
    }
    const run = runVerifyCommandCached(verify, task.workspace_root || process.cwd(), verifyCache);
    stampVerifyCacheMetadata(taskDb, db, task.id, { verify, result: run, actor, workspaceRoot: task.workspace_root });
    if (!run.ok) {
      results.push({ ref, action: 'verify_failed', reason: run.reason, verify });
      continue;
    }
    const policyGate = candidatePolicyGate(task, { verifyCache, executeDetectors: true });
    if (!policyGate.ok) {
      results.push({ ...policyGate, ref, action: 'skipped' });
      continue;
    }
    const builderProof = String(review.proof || metadata.latest_agent_proof || '').slice(0, 200);
    const readied = taskDb.readyTask(db, {
      id: task.id,
      actor,
      proof: `Second-actor check: \`${verify}\` re-run by ${actor}, exited 0. Builder proof inspected: ${builderProof}`,
      lesson: '',
      nextTask: '',
    });
    if (!readied.ready) {
      results.push({ ref, action: 'certify_failed', reason: readied.reason, verify });
      continue;
    }
    stampCertifyVerifyMetadata(taskDb, db, task.id, actor, verify);
    const certifiedNow = readied.event?.payload?.agent_certified === true;
    results.push({ ref, action: certifiedNow ? 'certified' : 'pass_recorded', verify });
  }
  const { outPath } = writeDefaultProjection(taskDb, db);
  const certified = results.filter((r) => r.action === 'certified').length;
  const payload = {
    ok: true,
    action: dryRun ? 'certify_verified_dry_run' : 'certify_verified',
    actor,
    certified,
    would_certify: results.filter((r) => r.action === 'would_certify').length,
    skipped: results.filter((r) => r.action === 'skipped').length,
    failed: results.filter((r) => r.action === 'verify_failed' || r.action === 'certify_failed').length,
    results,
    projection_path: outPath,
  };
  if (silent) {
    return payload;
  }
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (results.length === 0) {
    console.log('certify-verified: no review rows to consider.');
  } else {
    for (const r of results) {
      const gateDetail = r.reason === 'slop_gate' && Array.isArray(r.offenders)
        ? `  [${r.offenders.join('; ')}]`
        : (r.reason === 'lesson_gate' && Array.isArray(r.lesson_ids)
          ? `  [lessons: ${r.lesson_ids.join(', ')}]`
          : '');
      console.log(`${r.action.padEnd(14)} ${r.ref}${r.verify ? `  \`${r.verify}\`` : ''}${r.reason ? `  (${r.reason})` : ''}${gateDetail}`);
    }
    console.log(`certified ${certified}; humans keep denied lanes and rows without a runnable check.`);
  }
  return payload;
}

// The landing: everything certified, one summary, one human gesture.
// Review-by-N-pastes was the operator pain; this is the batch gate that
// keeps human accept as the one gate without making it N gates.
function cmdLanding(args) {
  if (hasFlag(args, '--accept')) {
    const passthrough = args.filter(arg => arg !== '--accept');
    if (!passthrough.includes('--confirm-human-accept')) passthrough.push('--confirm-human-accept');
    return cmdAutoAcceptCertified(passthrough);
  }
  cmdReviews(args);
  console.log('');
  console.log('land everything certified above in one gesture:');
  console.log('  atris task landing --accept --as <you>');
  console.log('(items needing one more check stay in review; only certified work lands)');
}

function cmdAutoAcceptCertified(args) {
  const dryRun = hasFlag(args, '--dry-run');
  const acceptAll = hasFlag(args, '--all');
  const certifyFirst = hasFlag(args, '--certify-first');
  const strictVerify = !hasFlag(args, '--no-strict-verify') && !acceptAll;
  const actorFlag = flag(args, '--as');
  const hasHumanActor = validHumanActorFlag(actorFlag);
  const confirmedHumanAccept = hasFlag(args, '--confirm-human-accept');
  // Standing owner authorization: when the autoland policy is on for this
  // workspace, live accepts run as the owner who flipped it, no per-run
  // confirmation needed. See lib/autoland.js and 'atris autoland'.
  const dryRunEarly = hasFlag(args, '--dry-run');
  const policyAuth = (!dryRunEarly && !confirmedHumanAccept)
    ? require('../lib/autoland').liveAcceptAuthorization()
    : { ok: false };
  const actor = String(actorFlag || (policyAuth.ok ? policyAuth.actor : 'auto-accept-certified'));
  const limitRaw = flag(args, '--limit');
  const hasExplicitLimit = Boolean(limitRaw) && limitRaw !== true;
  // --all means sweep the full certified backlog, not just the first page of
  // it. Before this fix `max` was hard-capped at 12 even under --all, so a
  // real backlog (78 certified rows observed live) only ever drained 12/run,
  // an invisible undercount the autoland heartbeat repeated every hour.
  // AUTO_ACCEPT_ALL_SWEEP_CAP is a safety ceiling, not a target: a well-formed
  // --all run should always scan fewer rows than this.
  const AUTO_ACCEPT_ALL_SWEEP_CAP = 500;
  const max = hasExplicitLimit
    ? Math.max(1, Number(limitRaw) || 12)
    : (acceptAll ? AUTO_ACCEPT_ALL_SWEEP_CAP : 12);
  const parsedReward = parseAcceptReward(flag(args, '--reward'));
  if (!parsedReward.ok) {
    console.error('atris task auto-accept-certified: reward must be a positive number');
    process.exit(2);
  }
  if (!dryRun && !confirmedHumanAccept && !policyAuth.ok) {
    failTask(
      'atris task auto-accept-certified',
      'human_accept_confirmation_required',
      'live auto-accept requires --confirm-human-accept --as <human>, or the owner flips the standing policy with atris autoland on; use --dry-run to preview',
    );
  }
  if (!dryRun && !hasHumanActor && !policyAuth.ok) {
    failTask(
      'atris task auto-accept-certified',
      'human_actor_required',
      'live auto-accept requires --as <human> so XP has an explicit human acceptance actor',
    );
  }
  // The standing autoland policy clears this gate too, same as the two
  // per-run human gates above: the owner flipped the policy, accepts run as
  // that owner, and the cron tick would land the same rows an hour later
  // anyway. Without this exception `atris autoland tick` was blind whenever
  // invoked from an agent session (CLAUDECODE etc. in env): the spawned
  // sweep failTask'd with no summary and the tick receipt showed nulls.
  // A per-run --confirm-human-accept claim from an agent is still refused,
  // policyAuth is only consulted when no per-run confirmation is passed.
  if (agentProofOnlyMode() && !dryRun && !policyAuth.ok) {
    failAgentProofOnly(
      'atris task auto-accept-certified',
      'Agent proof-only mode can preview certified rows with --dry-run, but cannot live-accept them without the standing autoland policy.',
    );
  }

  // A heartbeat certifies and lands in one process so its live verifier result
  // remains available to the landing gate. The cache is process-local and is
  // never persisted: a later heartbeat must prove the checkout again.
  const verifyCache = new Map();
  const certification = certifyFirst && !dryRun
    ? cmdCertifyVerified([], { verifyCache, silent: true })
    : null;

  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const queue = taskReviewQueue(projection, ['--limit', String(max)]);
  const pendingReview = (projection.tasks || [])
    .filter((t) => t && t.status === 'review' && t.review && t.review.approval_status === 'pending');
  // Honest denominator for the summary line below: how many rows the
  // projection actually certified, independent of any scan cap. If `scanned`
  // ever comes in under `certified`, the undercount is visible instead of
  // silent (the exact failure mode this fix closes).
  const certifiedTotal = pendingReview.filter((t) => isAgentCertified(t)).length;
  // The review queue only surfaces certified rows. Under --all the bar is
  // the protected lanes, not certification, so scan every pending review.
  const pool = acceptAll
    ? pendingReview
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
      .slice(0, max)
    : queue.items.filter(item => item.queue_role !== 'blocked');
  const results = [];

  for (const item of pool) {
    const fullProjection = enrichTaskProjection(taskDb.taskProjection(db, { taskId: item.id }));
    const task = fullProjection.tasks[0] || null;
    if (!task) {
      results.push({ ref: item.display_id || item.id, eligible: false, reason: 'task_not_found', action: 'skipped' });
      continue;
    }
    const proofBoundary = proofBoundaryBlockedEvaluation(task);
    if (proofBoundary) {
      results.push({ ...proofBoundary, action: 'skipped' });
      continue;
    }
    const evaluation = evaluateAutoAccept(task, { strictVerify, acceptAll, verifyCache });
    if (!evaluation.eligible) {
      results.push({ ...evaluation, action: 'skipped' });
      continue;
    }
    if (dryRun) {
      results.push({ ...evaluation, action: 'would_accept', reward: parsedReward.value });
      continue;
    }
    const landingVerify = reverifyBeforeLanding(taskDb, db, task, { verifyCache });
    if (!landingVerify.ok) {
      // A refused landing whose revise also failed is the worst state in the
      // loop: the work does not land AND nobody is told to fix it, so the row
      // sits in review forever being re-refused every hour. Mark it so the
      // heartbeat can raise it instead of counting it as routine.
      results.push({
        ...evaluation,
        eligible: false,
        action: landingVerify.revised ? 'revised' : 'revise_failed',
        reason: landingVerify.result.reason || landingVerify.revise_reason || 'verify_failed',
        ...(landingVerify.result.unrunnable_cause
          ? { unrunnable_cause: landingVerify.result.unrunnable_cause }
          : {}),
        alarm: landingVerify.revised !== true || landingVerify.result.reason === 'verify_unrunnable',
        verify: landingVerify.verify,
        exit_code: landingVerify.result.status,
        revision_note: landingVerify.note,
        task_id: task.id,
      });
      continue;
    }
    const accepted = acceptReviewTask(taskDb, db, task.id, {
      actor,
      proof: evaluation.proof,
      reward: parsedReward.value,
      lesson: String(task.review?.lesson || task.metadata?.latest_agent_lesson || ''),
      nextTask: String(task.review?.next_task || task.metadata?.latest_agent_next_task || ''),
      autoAccepted: true,
    });
    if (!accepted.ok) {
      results.push({ ...evaluation, action: 'accept_failed', reason: accepted.reason });
      continue;
    }
    stampAutoAcceptMetadata(taskDb, db, task.id, actor, evaluation.policy);
    refreshCareerXpAfterReview(accepted.reviewed);
    results.push({
      ...evaluation,
      action: 'accepted',
      reward: accepted.reviewed.episode.reward.value,
      task_id: task.id,
    });
  }

  const { projection: finalProjection, outPath: finalPath } = writeDefaultProjection(taskDb, db);
  const summary = {
    certified: certifiedTotal,
    scanned: pool.length,
    accepted: results.filter(row => row.action === 'accepted').length,
    would_accept: results.filter(row => row.action === 'would_accept').length,
    revised: results.filter(row => row.action === 'revised').length,
    skipped: results.filter(row => row.action === 'skipped').length,
    failed: results.filter(row => row.action === 'accept_failed' || row.action === 'revise_failed').length,
    // Visible undercount flag: true only if the pool was cut short by `max`
    // while certified rows still existed beyond it. --all uses a high safety
    // cap (AUTO_ACCEPT_ALL_SWEEP_CAP), so this should stay false in practice;
    // if it ever flips true, the cap itself needs raising, not silence.
    undercounted: certifiedTotal > pool.length,
  };
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: dryRun ? 'auto_accept_certified_dry_run' : 'auto_accept_certified',
      strict_verify: strictVerify,
      accept_all: acceptAll,
      summary,
      ...summary,
      results,
      certification,
      projection_path: finalPath,
      queue,
    });
    return { ...summary, results, certification, projection_path: finalPath, queue };
  }
  console.log(`AUTO-ACCEPT CERTIFIED (${dryRun ? 'dry-run' : 'execute'})`);
  console.log(`${summary.certified} certified, ${summary.scanned} scanned, ${summary.accepted || summary.would_accept} accepted, ${summary.skipped} skipped${summary.revised ? `, ${summary.revised} revised` : ''}${summary.failed ? `, ${summary.failed} failed` : ''}${summary.undercounted ? ' (UNDERCOUNTED, raise --limit or the sweep cap)' : ''}`);
  for (const row of results) {
    const nextAction = row.next_action ? ` next_action=${row.next_action}` : '';
    const reviewChat = row.review_chat_command ? ` review_chat=${row.review_chat_command}` : '';
    console.log(`${row.action.toUpperCase()} ${row.ref}: ${row.reason}${row.reward ? ` reward=${row.reward}` : ''}${nextAction}${reviewChat}`);
  }
  return { ...summary, results, certification, projection_path: finalPath, queue };
}

const SWEEP_AUTO_ACCEPT_PROTECTED = new Set([
  'money', 'deploy', 'release', 'publish', 'security', 'customer', 'outward',
]);

function autoAcceptSweepLabelValues(task) {
  const metadata = task && task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  return [
    task && task.tag,
    task && task.lane,
    metadata.tag,
    metadata.lane,
    metadata.mission_lane,
    metadata.stage,
    ...tags,
  ].filter(value => value !== undefined && value !== null && String(value).trim());
}

function autoAcceptSweepNormalizedTokens(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return [];
  return [normalized, ...normalized.split(/[^a-z0-9-]+/).filter(Boolean)];
}

function autoAcceptSweepDeniedReason(task) {
  for (const value of autoAcceptSweepLabelValues(task)) {
    const tokens = autoAcceptSweepNormalizedTokens(value);
    for (const token of tokens) {
      if (token === 'needs-human' || token === 'needshuman' || token === 'decision') {
        return 'needs_human';
      }
      const protectedLane = [...SWEEP_AUTO_ACCEPT_PROTECTED].find((denied) =>
        token === denied || token.replace(/s$/, '') === denied
      );
      if (protectedLane) return 'protected_lane';
    }
  }
  return null;
}

function autoAcceptSweepLatestProof(task) {
  const metadata = task && task.metadata || {};
  const review = task && task.review || {};
  return String(review.proof || metadata.latest_agent_proof || '').trim();
}

function autoAcceptSweepVerifierEvidence(proof, root) {
  const evidence = extractReceiptEvidence(proof, root);
  if (!evidence || !evidence.receipts || !evidence.receipts.length) {
    return { ok: false, reason: 'no_passing_verifier', evidence: evidence || null };
  }
  if (evidence.missing && evidence.missing.length) {
    return { ok: false, reason: 'receipt_missing', evidence };
  }
  const passing = evidence.receipts.filter((receipt) => receipt.verifier_passed === true);
  if (!passing.length) {
    return { ok: false, reason: 'no_passing_verifier', evidence };
  }
  const notPassed = evidence.receipts.find((receipt) => receipt.verifier_passed !== true);
  if (notPassed) {
    return { ok: false, reason: 'receipt_verifier_not_passed', evidence };
  }
  return {
    ok: true,
    evidence,
    passing,
    proved_by: passing.map((receipt) => `${receipt.path} verifier_passed=true`),
  };
}

function autoAcceptSweepHappened(task) {
  const review = task && task.review || {};
  return clipStatusText(
    review.landing?.happened
      || review.result?.changed
      || task?.title
      || 'accepted verified task',
    180,
  );
}

function evaluateSweepAutoAccept(task, root) {
  const ref = taskRef(task);
  if (!task) return { eligible: false, ref, reason: 'task_not_found' };
  if (task.status !== 'review') return { eligible: false, ref, reason: 'not_in_review' };
  const metadata = task.metadata || {};
  const review = task.review || {};
  const approval = String(review.approval_status || metadata.approval_status || 'pending').toLowerCase();
  if (approval !== 'pending') return { eligible: false, ref, reason: `approval_${approval}` };
  if (metadata.auto_accepted_at) return { eligible: false, ref, reason: 'already_auto_accepted' };
  const denied = autoAcceptSweepDeniedReason(task);
  if (denied) return { eligible: false, ref, reason: denied };
  const proof = autoAcceptSweepLatestProof(task);
  if (!proof) return { eligible: false, ref, reason: 'no_proof' };
  const policyGate = candidatePolicyGate(task, { executeDetectors: true });
  if (!policyGate.ok) return { ...policyGate, ref };

  // 1. An explicit, stored verifier (`atris task ready --verify`, or a prior
  // certify-verified stamp) is the strongest signal: re-run it live, right
  // now, against the current checkout, and let it decide outright. This is
  // what unblocks CLI-762/CLI-861-shaped proofs: a real green test cited (or
  // executed) in the proof, but the older receipt-path check below could not
  // find file evidence for it once `ready --verify` stopped writing a
  // receipt file and started embedding the executed result into proof text.
  const storedVerify = typeof metadata.verify === 'string' ? metadata.verify.trim() : '';
  if (storedVerify) {
    const result = runVerifyCommand(storedVerify, root);
    if (!result.ok) return { eligible: false, ref, reason: result.reason, verify: storedVerify };
    return {
      eligible: true,
      ref,
      reason: 'verified_command',
      policy: 'sweep_auto_accept_verified_command',
      proof,
      verify: storedVerify,
      candidate_gate: policyGate.gate,
      proved_by: [`${storedVerify} exited 0`],
      happened: autoAcceptSweepHappened(task),
    };
  }

  // 2. Legacy path: a receipt file explicitly named in proof text.
  const verifier = autoAcceptSweepVerifierEvidence(proof, root);
  if (verifier.ok) {
    return {
      eligible: true,
      ref,
      reason: 'verified_receipt',
      policy: 'sweep_auto_accept_verified',
      proof,
      evidence: verifier.evidence,
      candidate_gate: policyGate.gate,
      proved_by: verifier.proved_by,
      happened: autoAcceptSweepHappened(task),
    };
  }

  // 3. No stored verifier and no receipt was even cited: try deriving a
  // safe, runnable command straight from the proof text itself (same
  // extractor certify-verified uses) and re-run it live. Only reached when
  // there is nothing else to go on, so a proof that legitimately cites a
  // real receipt keeps taking the receipt path above rather than racing an
  // unrelated command mentioned in the same sentence.
  if (verifier.reason === 'no_passing_verifier') {
    const derived = certifyVerifyCandidate(task);
    if (derived) {
      const result = runVerifyCommand(derived, root);
      if (result.ok) {
        return {
          eligible: true,
          ref,
          reason: 'verified_derived_command',
          policy: 'sweep_auto_accept_verified_derived',
          proof,
          verify: derived,
          candidate_gate: policyGate.gate,
          proved_by: [`${derived} exited 0`],
          happened: autoAcceptSweepHappened(task),
        };
      }
      return { eligible: false, ref, reason: result.reason, verify: derived };
    }
  }

  return { eligible: false, ref, reason: verifier.reason, evidence: verifier.evidence };
}

function cmdSweep(args) {
  if (!hasFlag(args, '--auto-accept')) {
    failTask(
      'atris task sweep',
      'missing_auto_accept',
      'atris task sweep currently requires --auto-accept for the explicit verified accept policy',
    );
  }
  const actor = String(flag(args, '--as') || 'orb-autoaccept');
  const parsedReward = parseAcceptReward(flag(args, '--reward'));
  if (!parsedReward.ok) {
    failTask('atris task sweep', 'invalid_reward', 'atris task sweep --auto-accept reward must be a positive number');
  }
  const limitRaw = flag(args, '--limit');
  const explicitLimit = limitRaw && limitRaw !== true ? Math.max(1, Number(limitRaw) || 0) : null;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection } = writeDefaultProjection(taskDb, db);
  const root = projection.workspace_root || process.cwd();
  let pendingReview = (projection.tasks || [])
    .filter((task) => task && task.status === 'review' && task.review && task.review.approval_status === 'pending')
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  if (explicitLimit) pendingReview = pendingReview.slice(0, explicitLimit);
  const results = [];
  for (const item of pendingReview) {
    const fullProjection = enrichTaskProjection(taskDb.taskProjection(db, { taskId: item.id }));
    const task = fullProjection.tasks[0] || null;
    const evaluation = evaluateSweepAutoAccept(task, root);
    if (!evaluation.eligible) {
      results.push({ ...evaluation, action: 'skipped', task_id: task?.id || item.id || null });
      continue;
    }
    const accepted = acceptReviewTask(taskDb, db, task.id, {
      actor,
      proof: evaluation.proof,
      reward: parsedReward.value,
      lesson: String(task.review?.lesson || task.metadata?.latest_agent_lesson || ''),
      nextTask: String(task.review?.next_task || task.metadata?.latest_agent_next_task || ''),
      autoAccepted: true,
    });
    if (!accepted.ok) {
      results.push({ ...evaluation, action: 'accept_failed', task_id: task.id, reason: accepted.reason });
      continue;
    }
    stampAutoAcceptMetadata(taskDb, db, task.id, actor, evaluation.policy);
    refreshCareerXpAfterReview(accepted.reviewed);
    results.push({
      ...evaluation,
      action: 'accepted',
      task_id: task.id,
      reward: accepted.reviewed.episode.reward.value,
    });
  }
  const { outPath } = writeDefaultProjection(taskDb, db);
  const summary = {
    scanned: pendingReview.length,
    accepted: results.filter((row) => row.action === 'accepted').length,
    skipped: results.filter((row) => row.action === 'skipped').length,
    failed: results.filter((row) => row.action === 'accept_failed').length,
  };
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'sweep_auto_accept',
      actor,
      summary,
      ...summary,
      results,
      projection_path: outPath,
    });
    return;
  }
  console.log(`TASK SWEEP AUTO-ACCEPT: ${summary.accepted} accepted / ${summary.scanned} scanned / ${summary.skipped} skipped${summary.failed ? ` / ${summary.failed} failed` : ''}`);
  for (const row of results.filter((item) => item.action === 'accepted')) {
    console.log(`ACCEPTED ${row.ref}: ${row.happened} | proved by ${row.proved_by.join(', ')}`);
  }
}

function cmdRevise(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task revise: id required');
    process.exit(2);
  }
  const note = flag(args, '--note') || flag(args, '--reason') || pos.slice(1).join(' ');
  if (!note || note === true) {
    console.error('atris task revise: --note required');
    process.exit(2);
  }
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task revise');
  const result = taskDb.reviseTask(db, { id: taskId, actor, note: String(note) });
  if (!result.revised) {
    console.error(`revise failed: ${result.reason}`);
    process.exit(1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'revise',
      task_id: taskId,
      version: result.event.version,
      approval_status: 'revise',
      revision_count: result.event.payload.revision_count,
      episode: result.episode || null,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`revise ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
}

function taskAuditTimestamp(task) {
  const acceptedAt = Date.parse(String(task?.metadata?.accepted_at || ''));
  if (Number.isFinite(acceptedAt)) return acceptedAt;
  return Number(task?.done_at || task?.updated_at || task?.created_at || 0);
}

function taskAuditOutput(value, max = 800) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `...${text.slice(-max)}`;
}

function taskAuditReceiptPath(at) {
  const safeTime = at.replace(/[:.]/g, '-');
  return path.join('atris', 'runs', `task-audit-${safeTime}.json`);
}

function runTaskAuditVerify(task, verify) {
  const { spawnSync } = require('child_process');
  // Same measured ceiling as the landing gate: honest suites need minutes,
  // not seconds. See lib/auto-accept-certified.js verifyTimeoutMs().
  const rawTimeout = Number(process.env.ATRIS_VERIFY_TIMEOUT_MS);
  const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(rawTimeout, 60 * 60 * 1000)
    : 10 * 60 * 1000;
  const result = spawnSync('bash', ['-c', verify], {
    cwd: task.workspace_root,
    encoding: 'utf8',
    timeout,
  });
  const passed = !result.error && result.status === 0;
  return {
    passed,
    exit: result.status,
    signal: result.signal || null,
    error: result.error ? result.error.message : null,
    output: taskAuditOutput(`${result.stdout || ''}${result.stderr || ''}`),
  };
}

function cmdAudit(args) {
  const limitRaw = flag(args, '--limit');
  const limit = limitRaw === null ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error('atris task audit: --limit must be a positive integer');
    process.exit(2);
  }

  const revise = hasFlag(args, '--revise');
  const actor = String(flag(args, '--as') || 'task-audit');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot();
  const allRows = taskDb.listTasks(db, { workspaceRoot });
  const accepted = taskDb.withTaskDisplayRefs(
    allRows
      .filter(task => task.status === 'done' && task.metadata?.approval_status === 'accepted')
      .sort((a, b) => taskAuditTimestamp(b) - taskAuditTimestamp(a))
      .slice(0, limit),
    allRows,
  );
  const at = new Date().toISOString();
  const receiptPath = taskAuditReceiptPath(at);
  const results = accepted.map(task => {
    const verify = typeof task.metadata?.verify === 'string' ? task.metadata.verify : '';
    if (!verify.trim()) {
      return {
        task_id: task.id,
        ref: task.display_id || task.legacy_ref || taskRef(task),
        status: 'skipped-no-verify',
        verify: null,
      };
    }
    const run = runTaskAuditVerify(task, verify);
    return {
      task_id: task.id,
      ref: task.display_id || task.legacy_ref || taskRef(task),
      status: run.passed ? 'passed' : 'failed',
      verify,
      exit: run.exit,
      signal: run.signal,
      error: run.error,
      output: run.output,
    };
  });

  const failing = results.filter(row => row.status === 'failed');
  if (revise) {
    const note = `task audit re-ran the stored verify and it failed; see ${receiptPath}`;
    for (const row of failing) {
      const revised = taskDb.reviseTask(db, {
        id: row.task_id,
        actor,
        note,
        allowDone: true,
      });
      row.revised = revised.revised === true;
      row.revise_reason = revised.revised ? null : revised.reason;
    }
    if (failing.some(row => row.revised)) writeDefaultProjection(taskDb, db);
  }

  const summary = {
    sampled: results.length,
    passed: results.filter(row => row.status === 'passed').length,
    failed: failing.length,
    'skipped-no-verify': results.filter(row => row.status === 'skipped-no-verify').length,
    revised: results.filter(row => row.revised === true).length,
  };
  const receipt = {
    schema: 'atris.task_audit_receipt.v1',
    at,
    workspace_root: workspaceRoot,
    limit,
    revise,
    summary,
    failing_task_ids: failing.map(row => row.task_id),
    results,
  };
  const receiptFile = path.join(workspaceRoot, receiptPath);
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'task_audit',
      receipt_path: receiptPath,
      ...receipt,
    });
    return;
  }
  console.log(`task audit: sampled ${summary.sampled}, passed ${summary.passed}, failed ${summary.failed}, skipped-no-verify ${summary['skipped-no-verify']}`);
  console.log(`failing task ids: ${failing.length ? failing.map(row => row.ref).join(', ') : 'none'}`);
  if (revise) console.log(`revised: ${summary.revised}`);
  console.log(`receipt: ${receiptPath}`);
}

function cmdReview(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task review', 'missing_id', 'id required');
  }
  const reward = flag(args, '--reward');
  const lessonFlag = flag(args, '--lesson');
  const nextTaskFlag = flag(args, '--next');
  const clearLesson = hasEmptyFlagValue(args, '--lesson');
  const clearNextTask = hasEmptyFlagValue(args, '--next');
  const lesson = clearLesson
    ? ''
    : typeof lessonFlag === 'string'
    ? lessonFlag
    : '';
  const nextTaskInput = normalizeReviewNextTaskInput(
    clearNextTask
      ? ''
      : typeof nextTaskFlag === 'string'
      ? nextTaskFlag
      : ''
  );
  const clearedFields = [];
  if (clearLesson || (typeof lessonFlag === 'string' && !String(lessonFlag).trim())) clearedFields.push('lesson');
  if (clearNextTask || (typeof nextTaskFlag === 'string' && !String(nextTaskFlag).trim())) clearedFields.push('next_task');
  const proof = proofFlagValue(args);
  const verify = textFlag(args, ['--verify']);
  guardExplicitActor('atris task review', flag(args, '--as'));
  const actor = flag(args, '--as') || DEFAULT_OWNER;
  const rewardValue = reward === true || reward === null ? 0 : reward;
  if (agentProofOnlyMode() && Number(rewardValue) > 0) {
    failAgentProofOnly(
      'atris task review',
      'Agent proof-only mode allows verifier notes with `--reward 0` only. Positive reward and acceptance stay human-gated.',
    );
  }
  if (Number(rewardValue) > 0 || proof) {
    requireMeaningfulTaskProof('atris task review', proof);
  }
  if (verify) {
    const parsedVerify = parseVerifyCommand(verify);
    if (!parsedVerify.ok) {
      failTask(
        'atris task review',
        parsedVerify.reason || 'invalid_verify_command',
        'Verify command must be a safe simple command accepted by strict auto-accept.',
      );
    }
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task review');
  const currentTask = taskDb.getTask(db, taskId);
  const result = taskDb.reviewTask(db, {
    id: taskId,
    actor: String(actor),
    reward: rewardValue,
    lesson: typeof lesson === 'string' ? lesson : '',
    nextTask: nextTaskInput.nextTask,
    proof,
    verify,
    careerXpEligible: false,
    clearedFields,
  });
  if (!result.reviewed) {
    if (result.reason === 'judge_equals_worker') {
      console.error(`review failed: judge_equals_worker: ${result.builder} built this task and cannot judge it. Hand off: atris task review ${id} --reward 1 --as <another member>`);
    } else {
      console.error(`review failed: ${result.reason}`);
    }
    process.exit(1);
  }
  const nextCreated = createNextTaskIfRequested(taskDb, db, args, currentTask, result.episode.next_task_suggestion);
  const xpProjection = refreshCareerXpAfterReview(result);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'reviewed',
      task_id: taskId,
      version: result.event.version,
      reward: result.episode.reward.value,
      episode: result.episode,
      xp_projection: compactCareerXpProjection(xpProjection),
      next_task_id: nextCreated ? nextCreated.id : null,
      ...(nextTaskInput.ignored ? { review_next_task_ignored: nextTaskInput.ignored } : {}),
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
      next_task: nextCreated ? compactTaskFromProjection(projection, nextCreated.id) : null,
    });
    return;
  }
  console.log(`reviewed ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version} reward=${result.episode.reward.value}`);
  if (result.episode.next_task_suggestion) console.log(`next: ${result.episode.next_task_suggestion}`);
  if (nextCreated) console.log(`created next ${taskRef(compactTaskFromProjection(projection, nextCreated.id))}`);
}

function importTodoFile(taskDb, db, target) {
  const filePath = path.resolve(target);
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'not_found', filePath };
  }
  const { parseTodoFile } = require('../lib/todo-fallback');
  const parsed = parseTodoFile(filePath);
  const ws = taskDb.workspaceRoot();
  const all = [
    ...parsed.backlog.map(t => ({ ...t, importStatus: 'open', sourceFile: filePath })),
    ...parsed.inProgress.map(t => ({ ...t, importStatus: 'claimed', sourceFile: filePath })),
    ...(parsed.review || []).map(t => ({ ...t, importStatus: 'review', sourceFile: filePath })),
  ];
  const knownTitles = new Set(
    taskDb.listTasks(db, { workspaceRoot: ws, limit: 500 }).map((row) => taskDb.normalizeTitle(row.title))
  );
  let inserted = 0;
  let skipped = 0;
  for (const t of all) {
    if (!t.title) continue;
    const normalized = taskDb.normalizeTitle(t.title);
    if (knownTitles.has(normalized)) {
      skipped++;
      continue;
    }
    const sk = taskDb.sourceKey(t.sourceFile || filePath, t.title);
    const result = taskDb.addTask(db, {
      title: t.title,
      tag: t.tag || null,
      workspaceRoot: ws,
      sourceKey: sk,
      status: t.importStatus,
      claimedBy: t.claimed || null,
      metadata: { todo_id: t.id, todo_tags: t.tags || [], claimed: t.claimed, stage: t.stage, verify: t.verify },
    });
    if (result.inserted) {
      inserted++;
      knownTitles.add(normalized);
    } else {
      skipped++;
    }
  }
  return { ok: true, inserted, skipped, filePath, knownTitles };
}

function importJournalFile(taskDb, db, journalPath, knownTitles = null) {
  const filePath = path.resolve(journalPath);
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'not_found', filePath, inserted: 0, skipped: 0 };
  }
  const { parseSection } = require('../lib/todo-fallback');
  const { parseInboxItems } = require('../lib/file-ops');
  const content = fs.readFileSync(filePath, 'utf8');
  const ws = taskDb.workspaceRoot();
  const titles = knownTitles || new Set(
    taskDb.listTasks(db, { workspaceRoot: ws, limit: 500 }).map((row) => taskDb.normalizeTitle(row.title))
  );
  const all = [
    ...parseSection(content, 'Backlog').map((t) => ({ ...t, importStatus: 'open' })),
    ...parseSection(content, 'In Progress').map((t) => ({ ...t, importStatus: 'claimed' })),
    ...parseInboxItems(content).map((item) => ({
      id: `I${item.id}`,
      title: item.text,
      tag: 'inbox',
      importStatus: 'open',
    })),
  ];
  let inserted = 0;
  let skipped = 0;
  for (const t of all) {
    if (!t.title) continue;
    const normalized = taskDb.normalizeTitle(t.title);
    if (titles.has(normalized)) {
      skipped++;
      continue;
    }
    const sk = taskDb.sourceKey(filePath, t.title);
    const result = taskDb.addTask(db, {
      title: t.title,
      tag: t.tag || null,
      workspaceRoot: ws,
      sourceKey: sk,
      status: t.importStatus,
      claimedBy: t.claimed || null,
      metadata: { todo_id: t.id, source: 'journal_import' },
    });
    if (result.inserted) {
      inserted++;
      titles.add(normalized);
    } else {
      skipped++;
    }
  }
  return { ok: true, inserted, skipped, filePath };
}

function todayJournalPath() {
  const { getLogPath } = require('../lib/file-ops');
  return getLogPath().logFile;
}

function cmdImport(args) {
  const pos = positional(args);
  const target = pos[0] || 'atris/TODO.md';
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = importTodoFile(taskDb, db, target);
  if (!result.ok) {
    console.error(`atris task import: file not found: ${result.filePath}`);
    process.exit(2);
  }
  const journalResult = importJournalFile(taskDb, db, todayJournalPath(), result.knownTitles);
  const inserted = result.inserted + (journalResult.ok ? journalResult.inserted : 0);
  const skipped = result.skipped + (journalResult.ok ? journalResult.skipped : 0);
  const { outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'imported',
      inserted,
      skipped,
      source: result.filePath,
      journal: journalResult.ok ? journalResult.filePath : null,
      projection_path: outPath,
    });
    return;
  }
  console.log(`imported ${inserted} new, skipped ${skipped} (already imported), source=${result.filePath}`);
  if (journalResult.ok && journalResult.inserted > 0) {
    console.log(`journal imported ${journalResult.inserted} from ${journalResult.filePath}`);
  }
}

function cmdWhere(args) {
  const taskDb = getTaskDb();
  if (wantsJson(args)) {
    printJson({
      ok: true,
      db: taskDb.getDbPath(),
      workspace: taskDb.workspaceRoot(),
      owner: DEFAULT_OWNER,
    });
    return;
  }
  console.log(`db:        ${taskDb.getDbPath()}`);
  console.log(`workspace: ${taskDb.workspaceRoot()}`);
  console.log(`owner:     ${DEFAULT_OWNER}`);
}

function cmdEvents(args) {
  const pos = positional(args);
  let taskId = pos[0] || null;
  const all = hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args);
  const rawLimit = flag(args, '--limit');
  const explicitLimit = rawLimit && rawLimit !== true ? Number(rawLimit) : null;
  const defaultRecentLimit = 24;
  const limit = explicitLimit || (taskId ? 500 : (all || everywhere ? null : defaultRecentLimit));
  const taskDb = getTaskDb();
  const db = taskDb.open();
  if (taskId) taskId = requireTaskId(taskDb, db, taskId, 'atris task events');
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args, { everywhere });
  const events = taskDb.listTaskEvents(db, {
    taskId,
    workspaceRoot: taskId ? null : workspaceRoot,
    limit,
    order: taskId || all || everywhere ? 'asc' : 'desc',
  });
  const refRows = taskDb.listTasks(db, {
    workspaceRoot: everywhere ? null : (taskId ? (taskDb.getTask(db, taskId) || {}).workspace_root : workspaceRoot),
  });
  const refById = taskDb.taskDisplayRefMap(refRows);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'events',
      task_id: taskId,
      mode: taskId ? 'task' : (everywhere ? 'ledger_everywhere' : (all ? 'ledger' : 'recent')),
      limit,
      events,
    });
    return;
  }
  if (events.length === 0) {
    console.log('(no task events)');
    return;
  }
  if (!taskId && !all && !everywhere) {
    console.log('TASK EVENTS');
    console.log(`recent ${events.length} event${events.length === 1 ? '' : 's'} (use --all for the full ledger, --limit N to adjust)`);
    console.log('');
    for (const e of events) console.log(formatTaskEventCompact(e, refById));
    return;
  }
  for (const e of events) {
    const actor = e.actor ? ` actor=${e.actor}` : '';
    console.log(`${e.version}\t${e.event_type}\t${refById.get(e.task_id) || taskRef(e.task_id)}${actor}\t${JSON.stringify(e.payload || {})}`);
  }
}

function cmdLineage(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task lineage', 'missing_id', 'id required');
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task lineage');
  const enriched = enrichTaskProjection(taskDb.taskProjection(db, { workspaceRoot: taskDb.workspaceRoot(), limit: 1000 }));
  const byId = new Map();
  for (const t of enriched.tasks) byId.set(t.id, t);
  const target = byId.get(taskId);
  if (!target) {
    console.error(`task not found: ${id}`);
    process.exit(1);
  }

  const parents = [];
  let cursor = target;
  const seen = new Set();
  while (cursor) {
    const parentId = cursor.lineage && cursor.lineage.parent_task_id;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    parents.unshift(parent);
    cursor = parent;
  }

  const childIds = target.lineage && target.lineage.child_task_ids || [];
  const children = childIds.map(cid => byId.get(cid)).filter(Boolean);

  const chain = [...parents, target, ...children];

  let commits = [];
  try {
    const { spawnSync: sp } = require('child_process');
    const displayRefs = chain.map(t => taskRef(t)).filter(Boolean);
    const pattern = displayRefs.join('\\|');
    const result = sp('git', ['log', '--oneline', '--all', `--grep=${pattern}`], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      commits = result.stdout.trim().split('\n').filter(Boolean);
    }
  } catch (_) {
    commits = [];
  }

  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'lineage',
      chain: {
        endgame: parents.length ? parents[0] : null,
        parents: parents.slice(1),
        target,
        children,
        commits,
      },
    });
    return;
  }

  if (parents.length) {
    for (let i = 0; i < parents.length; i += 1) {
      const p = parents[i];
      console.log(`${'  '.repeat(i)}${taskRef(p)} ${p.title} [${p.status}]`);
    }
  }
  const indent = '  '.repeat(parents.length);
  console.log(`${indent}${taskRef(target)} ${target.title} [${target.status}]`);
  for (const child of children) {
    console.log(`${'  '.repeat(parents.length + 1)}${taskRef(child)} ${child.title} [${child.status}]`);
  }
  if (commits.length) {
    console.log('');
    console.log('commits:');
    for (const c of commits) console.log(`  ${c}`);
  }
}

function cmdExport(args) {
  const out = flag(args, '--out') || path.join('.atris', 'state', 'tasks.projection.json');
  const all = hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const outPath = path.resolve(String(out));
  const projection = enrichTaskProjection(taskDb.taskProjection(db, {
    workspaceRoot: scopedWorkspaceRoot(taskDb, args, { everywhere }),
    limit: all ? null : 500,
  }));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(projection, null, 2) + '\n', 'utf8');
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'exported',
      count: projection.tasks.length,
      projection_path: outPath,
      projection,
    });
    return;
  }
  console.log(`exported ${projection.tasks.length} task${projection.tasks.length === 1 ? '' : 's'} -> ${outPath}`);
}

function cmdSetup(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot();
  let importResult = null;
  let journalResult = null;
  if (hasFlag(args, '--import-todo')) {
    importResult = importTodoFile(taskDb, db, flag(args, '--todo') || 'atris/TODO.md');
    if (!importResult.ok && flag(args, '--todo')) {
      console.error(`atris task setup: TODO file not found: ${importResult.filePath}`);
      process.exit(2);
    }
    if (importResult.ok) {
      journalResult = importJournalFile(taskDb, db, todayJournalPath(), importResult.knownTitles);
      importResult = {
        ...importResult,
        inserted: importResult.inserted + (journalResult.ok ? journalResult.inserted : 0),
        skipped: importResult.skipped + (journalResult.ok ? journalResult.skipped : 0),
        journal: journalResult.ok ? journalResult.filePath : null,
      };
    }
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'setup',
      count: projection.tasks.length,
      projection_path: outPath,
      import: importResult && importResult.ok ? {
        inserted: importResult.inserted,
        skipped: importResult.skipped,
        source: importResult.filePath,
        journal: importResult.journal || null,
      } : null,
      projection,
    });
    return;
  }
  console.log(`tasks ready: ${projection.tasks.length} task${projection.tasks.length === 1 ? '' : 's'}`);
  console.log(`projection: ${outPath}`);
  if (importResult && importResult.ok) {
    console.log(`imported ${importResult.inserted} new, skipped ${importResult.skipped}`);
  }
}

function extractTodoSectionMarkdown(content, sectionName) {
  const escaped = escapeRegExp(sectionName || '');
  const match = String(content || '').match(new RegExp(`(?:^|\\n)(##\\s+${escaped}[^\\n]*\\n[\\s\\S]*?)(?=\\n##(?!#)\\s+|$)`, 'i'));
  return match ? match[1].trimEnd() : null;
}

function normalizeRenderedTaskRef(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function renderedTaskRefSet(taskDb, rows, refRows) {
  const byId = new Map();
  for (const row of [...(Array.isArray(rows) ? rows : []), ...(Array.isArray(refRows) ? refRows : [])]) {
    if (row && row.id && !byId.has(row.id)) byId.set(row.id, row);
  }
  const displayRows = taskDb.withTaskDisplayRefs([...byId.values()]);
  const refs = new Set();
  for (const row of displayRows) {
    for (const value of [row.id, row.display_id, row.legacy_ref]) {
      const ref = normalizeRenderedTaskRef(value);
      if (ref) refs.add(ref);
    }
  }
  return refs;
}

function markdownRowsForRender(taskDb, existingTodoPath, rows, refRows) {
  if (!existingTodoPath || !fs.existsSync(existingTodoPath)) return [];
  const { parseTodoFile } = require('../lib/todo-fallback');
  const existingTodo = fs.readFileSync(existingTodoPath, 'utf8');
  const generatedTodo = existingTodo.includes('Regenerated from durable Atris task state');
  const parsed = parseTodoFile(existingTodoPath);
  const ws = taskDb.workspaceRoot();
  const existingRefs = renderedTaskRefSet(taskDb, rows, refRows);
  const existingSourceKeys = new Set(
    (Array.isArray(refRows) ? refRows : [])
      .map(row => row && row.source_key)
      .filter(Boolean)
  );
  const existingTitles = new Set(
    [...(Array.isArray(rows) ? rows : []), ...(Array.isArray(refRows) ? refRows : [])]
      .map(row => taskDb.normalizeTitle(row && row.title))
      .filter(Boolean)
  );
  const sections = [
    ['backlog', 'open'],
    ['inProgress', 'claimed'],
    ['review', 'review'],
    ['completed', 'done'],
  ];
  const out = [];
  let index = 0;
  for (const [bucket, status] of sections) {
    for (const task of parsed[bucket] || []) {
      if (!task.title) continue;
      const sk = taskDb.sourceKey(existingTodoPath, task.title);
      const normalizedTitle = taskDb.normalizeTitle(task.title);
      const renderedRef = normalizeRenderedTaskRef(task.id);
      if (
        (renderedRef && existingRefs.has(renderedRef)) ||
        (sk && existingSourceKeys.has(sk)) ||
        existingTitles.has(normalizedTitle) ||
        generatedTodo
      ) continue;
      out.push({
        id: `markdown:${status}:${task.id || index}:${sk ? sk.slice(0, 10) : index}`,
        title: task.title,
        status,
        tag: task.tag || null,
        workspace_root: ws,
        claimed_by: status === 'claimed' ? (task.claimed || null) : null,
        created_at: index,
        updated_at: index,
        done_at: null,
        metadata: {
          todo_id: task.id || null,
          todo_tags: task.tags || [],
          claimed: task.claimed || null,
          stage: task.stage || null,
          verify: task.verify || null,
          markdown_source: existingTodoPath,
        },
      });
      if (sk) existingSourceKeys.add(sk);
      existingTitles.add(normalizedTitle);
      index += 1;
    }
  }
  return out;
}

function taskRenderStatusCounts(rows) {
  const counts = {
    backlog: 0,
    in_progress: 0,
    review: 0,
    blocked: 0,
    done: 0,
    total: 0,
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    counts.total += 1;
    if (row.status === 'open') counts.backlog += 1;
    else if (row.status === 'claimed') counts.in_progress += 1;
    else if (row.status === 'review') counts.review += 1;
    else if (row.status === 'failed') counts.blocked += 1;
    else if (row.status === 'done') counts.done += 1;
  }
  return counts;
}

function taskRenderCountLabel(count) {
  return count === 0 ? 'empty' : String(count);
}

function taskRenderSummaryLine(counts) {
  return [
    `Backlog: ${taskRenderCountLabel(counts.backlog)}`,
    `In Progress: ${taskRenderCountLabel(counts.in_progress)}`,
    `Review: ${taskRenderCountLabel(counts.review)}`,
    `Blocked: ${taskRenderCountLabel(counts.blocked)}`,
    `Done saved: ${taskRenderCountLabel(counts.done)}`,
  ].join('; ');
}

function refreshExistingTodoMarkdown(taskDb, db, workspaceRoot) {
  const ws = workspaceRoot || taskDb.workspaceRoot();
  const outPath = path.join(ws, 'atris', 'TODO.md');
  if (!fs.existsSync(outPath)) return null;
  const rows = taskDb.listTasks(db, { workspaceRoot: ws, limit: 500 });
  const refRows = taskDb.listTasks(db, { workspaceRoot: ws });
  const existingTodo = fs.readFileSync(outPath, 'utf8');
  const preservedSections = [];
  const endgameSection = extractTodoSectionMarkdown(existingTodo, 'Endgame');
  if (endgameSection) preservedSections.push(endgameSection);
  const markdownRows = markdownRowsForRender(taskDb, outPath, rows, refRows);
  const markdown = taskDb.renderTodoMarkdown([...rows, ...markdownRows], {
    refRows,
    preservedSections,
  });
  fs.writeFileSync(outPath, markdown, 'utf8');
  return outPath;
}

// TODO.md is a projection of task-db state. Keep this best-effort and silent
// because it runs after every successful mutating task command.
function autoRenderTodoFromDb(cwd = process.cwd()) {
  try {
    const atrisDir = path.join(cwd, 'atris');
    if (!fs.existsSync(atrisDir)) return null;
    const taskDb = getTaskDb();
    const db = taskDb.open();
    const outPath = path.join(atrisDir, 'TODO.md');
    if (fs.existsSync(outPath)) return refreshExistingTodoMarkdown(taskDb, db, cwd);
    const rows = taskDb.listTasks(db, { workspaceRoot: cwd, limit: 500 });
    const refRows = taskDb.listTasks(db, { workspaceRoot: cwd });
    fs.writeFileSync(outPath, taskDb.renderTodoMarkdown(rows, { refRows }), 'utf8');
    return outPath;
  } catch {
    return null;
  }
}

function cmdRender(args) {
  const out = flag(args, '--out') || path.join('atris', 'TODO.md');
  const all = hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args);
  const doneLimitRaw = flag(args, '--done-limit');
  const doneLimit = doneLimitRaw && doneLimitRaw !== true ? Number(doneLimitRaw) : undefined;
  const failedLimitRaw = flag(args, '--failed-limit');
  const failedLimit = failedLimitRaw && failedLimitRaw !== true ? Number(failedLimitRaw) : undefined;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args, { everywhere });
  const rows = taskDb.listTasks(db, {
    workspaceRoot,
    limit: all ? null : 500,
  });
  const refRows = taskDb.listTasks(db, {
    workspaceRoot,
  });
  const outPath = path.resolve(String(out));
  const existingTodo = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  const preservedSections = [];
  const endgameSection = extractTodoSectionMarkdown(existingTodo, 'Endgame');
  if (endgameSection) preservedSections.push(endgameSection);
  const markdownRows = markdownRowsForRender(taskDb, outPath, rows, refRows);
  const rowsToRender = [...rows, ...markdownRows];
  const statusCounts = taskRenderStatusCounts(rowsToRender);
  const markdown = taskDb.renderTodoMarkdown(rowsToRender, { doneLimit, failedLimit, refRows, preservedSections });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown, 'utf8');
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'rendered',
      count: rowsToRender.length,
      status_counts: statusCounts,
      backlog_empty: statusCounts.backlog === 0,
      path: outPath,
    });
    return;
  }
  console.log(`rendered TODO.md -> ${outPath}`);
  console.log(taskRenderSummaryLine(statusCounts));
}

function cmdSync(args) {
  const dryRun = hasFlag(args, '--dry-run');
  const businessIdFlag = flag(args, '--business-id');
  if (!dryRun) {
    console.error('atris task sync: only --dry-run is supported right now');
    process.exit(2);
  }

  const taskDb = getTaskDb();
  const db = taskDb.open();
  const binding = readLocalBusinessBinding(taskDb.workspaceRoot());
  const businessId = String(
    businessIdFlag && businessIdFlag !== true
      ? businessIdFlag
      : binding && (binding.business_id || binding.id) || ''
  ).trim();
  if (!businessId) {
    const detail = 'business id required: run inside a business workspace or pass --business-id <id>';
    if (wantsJson(args)) {
      printJson({ ok: false, action: 'sync_plan', reason: 'missing_business_id', detail });
      return;
    }
    console.error(`atris task sync: ${detail}`);
    process.exit(2);
  }

  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const plan = syncPlanForProjection(projection, businessId);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'sync_plan',
      dry_run: true,
      business_id: businessId,
      workspace_root: projection.workspace_root,
      projection_path: outPath,
      planned_writes: plan.length,
      plan,
    });
    return;
  }

  console.log(`task sync dry-run: ${plan.length} planned write${plan.length === 1 ? '' : 's'}`);
  console.log(`business: ${businessId}`);
  const refById = taskDb.taskDisplayRefMap(projection.tasks || []);
  for (const item of plan) {
    console.log(`${item.method.padEnd(5)} ${item.endpoint} <= ${refById.get(item.local_task_id) || taskRef(item.local_task_id)} ${item.body.title}`);
    for (const followup of item.after_create || []) {
      console.log(`      then ${followup.method} ${followup.endpoint} state=${followup.body.state}`);
    }
  }
}

function taskColumn(task) {
  if (task.status === 'open') return taskIsPlannedOpen(task) ? 'open' : 'backlog';
  if (task.status === 'claimed') return 'doing';
  if (task.status === 'review') return 'review';
  if (task.status === 'failed' && taskHasReview(task)) return 'done';
  if (task.status === 'failed') return 'blocked';
  if (task.status === 'done' && !taskHasReview(task)) return 'review';
  return 'done';
}

function taskHasReview(task) {
  if (task.latest_event_type === 'reviewed') return true;
  const review = task.review || {};
  return review.reward != null || Boolean(review.proof || review.lesson || review.next_task);
}

const TASK_BOARD_COLUMNS = [
  ['backlog', 'Backlog'],
  ['open', 'Open'],
  ['doing', 'Doing'],
  ['review', 'Review'],
  ['blocked', 'Blocked'],
  ['done', 'Done'],
];

// Pure state shaping: projection in, board view model out. No markup here.
function taskBoardViewModel(projection = {}) {
  const tasks = Array.isArray(projection.tasks) ? projection.tasks : [];
  const rows = tasks.map((task) => ({
    id: task.id,
    task,
    column: taskColumn(task),
    decision: taskHasReview(task),
  }));
  const columns = TASK_BOARD_COLUMNS.map(([key, label]) => ({
    key,
    label,
    rows: rows.filter((row) => row.column === key),
  }));
  const counts = {};
  for (const column of columns) counts[column.key] = column.rows.length;
  return {
    columns,
    counts,
    rows,
    total: rows.length,
    planTags: Array.from(STATUS_PLAN_TAGS),
  };
}

// Markup only: view model in, board page out. The page hydrates itself from
// /api/tasks in the browser, so the template bakes in just the shared
// plan-tag list; the column keys and labels must stay in step with
// TASK_BOARD_COLUMNS above.
function taskBoardTemplate(model) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Atris Task Factory</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    /* aesthetic: machine-room telemetry, warm-tinted dark, mono data, calm signals (no neon) */
    :root {
      color-scheme: dark;
      --bg: oklch(18% 0.012 160);
      --panel: oklch(22% 0.014 160);
      --panel-2: oklch(25% 0.016 160);
      --line: oklch(32% 0.015 160);
      --text: oklch(93% 0.012 150);
      --muted: oklch(70% 0.018 160);
      --accent: oklch(74% 0.115 158);
      --warn: oklch(81% 0.11 80);
      --bad: oklch(69% 0.14 25);
      --info: oklch(75% 0.10 240);
      --violet: oklch(73% 0.10 300);
      --sans: 'Space Grotesk', ui-sans-serif, system-ui, -apple-system, sans-serif;
      --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin:0; color:var(--text);
      font-family: var(--sans);
      -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
      background:
        radial-gradient(1100px 520px at 82% -12%, oklch(30% 0.04 160 / 0.55), transparent 62%),
        repeating-linear-gradient(0deg, oklch(32% 0.015 160 / 0.16) 0 1px, transparent 1px 34px),
        var(--bg);
      background-attachment: fixed;
    }
    header { height:60px; display:flex; align-items:center; justify-content:space-between; padding:0 22px; border-bottom:1px solid var(--line); background:linear-gradient(180deg, var(--panel-2), var(--panel)); }
    h1 { font-size:17px; margin:0; font-weight:700; letter-spacing:-0.01em; }
    .sub { color:var(--muted); font-size:12px; }
    main { display:grid; grid-template-columns: 320px 1fr; height:calc(100vh - 60px); }
    aside { border-right:1px solid var(--line); padding:16px; overflow:auto; background:var(--panel); }
    section { min-width:0; overflow:auto; padding:16px; }
    label { display:block; color:var(--muted); font-size:12px; margin:10px 0 5px; }
    input, textarea, select { width:100%; border:1px solid var(--line); background:oklch(15% 0.012 160); color:var(--text); border-radius:8px; padding:9px 11px; font:inherit; font-size:13px; transition:border-color .18s cubic-bezier(0.25,1,0.5,1); }
    input:focus, textarea:focus, select:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
    textarea { min-height:82px; resize:vertical; font-family:var(--mono); font-size:12px; }
    button { border:1px solid var(--line); background:var(--panel-2); color:var(--text); border-radius:8px; padding:8px 12px; font:inherit; font-size:12px; cursor:pointer; transition:background .18s cubic-bezier(0.25,1,0.5,1), border-color .18s; }
    button:hover { border-color:var(--muted); background:oklch(29% 0.018 160); }
    button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    button:active { transform:translateY(1px); }
    .primary { background:oklch(38% 0.07 158); border-color:oklch(48% 0.09 158); color:oklch(96% 0.02 158); }
    .primary:hover { background:oklch(43% 0.085 158); border-color:var(--accent); }
    .grid { display:grid; grid-template-columns: repeat(var(--board-columns, 6), minmax(160px, 1fr)); gap:12px; align-items:start; }
    .overview { display:grid; grid-template-columns: minmax(260px, 1.4fr) minmax(260px, 1fr); gap:12px; margin-bottom:12px; }
    .goalbox, .chainbox { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:11px; min-height:88px; }
    .goalbox h2, .chainbox h2 { margin:0 0 8px; color:var(--muted); font-size:12px; font-weight:650; }
    .goalitem { font-size:13px; line-height:1.3; margin:5px 0; }
    .chainitem { display:grid; grid-template-columns:72px 1fr; gap:8px; font-size:12px; line-height:1.3; margin:5px 0; color:var(--muted); }
    .chainitem strong { color:var(--text); font-weight:600; }
    .streams { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:12px; margin-bottom:12px; }
    .stream { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:11px; min-height:126px; }
    .stream h2 { margin:0 0 8px; font-size:12px; color:var(--text); line-height:1.25; font-weight:500; }
    .streambar { display:flex; height:7px; overflow:hidden; border-radius:999px; background:oklch(15% 0.012 160); border:1px solid var(--line); margin:8px 0; }
    .streambar span { display:block; min-width:2px; }
    .seg-open { background:var(--muted); }
    .seg-doing { background:var(--accent); }
    .seg-review { background:var(--warn); }
    .seg-blocked { background:var(--bad); }
    .streamtask { display:grid; grid-template-columns:64px 1fr; gap:8px; color:var(--muted); font-size:11px; line-height:1.25; margin-top:6px; }
    .streamtask strong { color:var(--text); font-weight:550; }
    .col { background:var(--panel); border:1px solid var(--line); border-radius:8px; min-height:160px; overflow:hidden; }
    .col h2 { margin:0; padding:10px 11px; font-size:12px; color:var(--muted); border-bottom:1px solid var(--line); display:flex; justify-content:space-between; }
    .cards { padding:8px; display:flex; flex-direction:column; gap:8px; }
    .card { text-align:left; width:100%; background:var(--panel-2); border:1px solid var(--line); border-radius:8px; padding:9px; transition:transform .18s cubic-bezier(0.25,1,0.5,1), border-color .18s, background .18s; }
    .card:hover { transform:scale(1.02); border-color:var(--muted); background:oklch(28% 0.018 160); }
    .card.active { border-color:var(--accent); box-shadow:0 0 0 1px oklch(74% 0.115 158 / 0.3); }
    .title { font-size:13px; line-height:1.25; }
    .meta { margin-top:6px; color:var(--muted); font-size:11px; display:flex; gap:6px; flex-wrap:wrap; font-family:var(--mono); }
    .pill { border:1px solid var(--line); border-radius:999px; padding:1px 6px; }
    .why { margin-top:7px; color:var(--muted); font-size:11px; line-height:1.25; }
    .plain { margin-top:6px; font-size:11px; line-height:1.35; color:var(--text); }
    .plain div + div { color:var(--muted); }
    .fact { margin:10px 0; background:oklch(15% 0.012 160); border:1px solid var(--line); border-radius:7px; padding:8px; font-size:12px; line-height:1.35; }
    .fact b { color:var(--muted); font-size:11px; display:block; margin-bottom:3px; }
    .room { margin-top:14px; border-top:1px solid var(--line); padding-top:12px; }
    .room h3 { margin:0 0 4px; font-size:14px; }
    .thread { margin:10px 0; display:flex; flex-direction:column; gap:7px; }
    .msg { background:oklch(15% 0.012 160); border:1px solid var(--line); border-radius:7px; padding:8px; font-size:12px; }
    .msg .who { color:var(--muted); font-size:11px; margin-bottom:3px; }
    .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }
    .full { grid-column:1 / -1; }
    .empty { color:var(--muted); font-size:12px; padding:10px; }
    /* heartbeat strip */
    .beat { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted); font-family:var(--mono); }
    .beat .dot { width:9px; height:9px; border-radius:50%; background:var(--muted); flex:none; }
    .beat.alive .dot { background:var(--accent); box-shadow:0 0 0 0 oklch(74% 0.115 158 / 0.6); animation:beat 2s cubic-bezier(0.25,1,0.5,1) infinite; }
    .beat.stale .dot { background:var(--bad); }
    .beat b { color:var(--accent); font-weight:600; }
    .beat .warn { color:var(--warn); }
    @keyframes beat { 0%{box-shadow:0 0 0 0 oklch(74% 0.115 158 / 0.5)} 70%{box-shadow:0 0 0 8px oklch(74% 0.115 158 / 0)} 100%{box-shadow:0 0 0 0 oklch(74% 0.115 158 / 0)} }
    @media (prefers-reduced-motion: reduce) { .beat.alive .dot { animation:none; } *, *::before, *::after { transition:none !important; } }
    /* activity feed */
    .activity { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:0; margin-bottom:12px; max-height:46vh; overflow:auto; }
    .activity h2 { margin:0; position:sticky; top:0; background:var(--panel); padding:11px; font-size:12px; color:var(--muted); font-weight:650; border-bottom:1px solid var(--line); z-index:1; }
    .ev { display:grid; grid-template-columns:52px 64px 1fr auto; gap:10px; align-items:baseline; padding:7px 11px; border-bottom:1px solid oklch(28% 0.013 160); font-size:12px; line-height:1.3; font-family:var(--mono); transition:background .15s ease; }
    .ev:last-child { border-bottom:0; }
    .ev:hover { background:oklch(25% 0.016 160); }
    .ev .t { color:var(--muted); font-variant-numeric:tabular-nums; font-size:11px; }
    .ev .src { font-size:11px; border:1px solid var(--line); border-radius:999px; padding:1px 7px; color:var(--muted); text-align:center; }
    .ev .src.pulse { color:var(--accent); border-color:oklch(74% 0.115 158 / 0.45); }
    .ev .src.reward { color:var(--warn); border-color:oklch(81% 0.11 80 / 0.45); }
    .ev .src.xp { color:var(--info); border-color:oklch(75% 0.10 240 / 0.45); }
    .ev .src.mission { color:var(--violet); border-color:oklch(73% 0.10 300 / 0.45); }
    .ev .msg { color:var(--text); min-width:0; }
    .ev .msg .d { color:var(--muted); font-size:11px; }
    .ev.bad .msg { color:var(--bad); }
    .ev .rw { font-variant-numeric:tabular-nums; font-size:11px; color:var(--muted); }
    .ev .rw.pos { color:var(--accent); } .ev .rw.neg { color:var(--bad); }
    @media (max-width: 980px) { main { grid-template-columns:1fr; height:auto; } aside { border-right:0; border-bottom:1px solid var(--line); } .grid, .overview { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Atris Task Factory</h1>
      <div class="beat" id="heartbeat"><span class="dot"></span><span>heartbeat: loading…</span></div>
    </div>
    <button id="refresh">Refresh</button>
  </header>
  <main>
    <aside>
      <form id="create">
        <label>New task</label>
        <textarea id="title" placeholder="Need something done..."></textarea>
        <label>Lane</label>
        <input id="tag" value="tasks">
        <button class="primary full" type="submit" style="margin-top:10px;width:100%">Create task</button>
      </form>
      <div class="room" id="room">
        <div class="empty">Select a task to open its room.</div>
      </div>
    </aside>
    <section>
      <div class="overview" id="overview"></div>
      <div class="activity" id="activity"><h2>Live Stream</h2><div class="empty">waiting for the agent…</div></div>
      <div class="streams" id="streams"></div>
      <div class="grid" id="board"></div>
    </section>
  </main>
  <script>
    const columns = [
      ['backlog', 'Backlog'],
      ['open', 'Open'],
      ['doing', 'Doing'],
      ['review', 'Review'],
      ['blocked', 'Blocked'],
      ['done', 'Done']
    ];
    const planTags = new Set(${JSON.stringify(model.planTags)});
    let state = { tasks: [] };
    let selected = null;
    const $ = (id) => document.getElementById(id);

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) }
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.detail || data.reason || 'request failed');
      return data;
    }

    function taskColumn(task) {
      if (task.status === 'open') {
        const metadata = task.metadata || {};
        const tag = String(task.tag || '').trim().toLowerCase().replace(/\\s+/g, '-');
        const stage = String(metadata.stage || '').trim().toLowerCase().replace(/\\s+/g, '-');
        const planned = planTags.has(tag) || planTags.has(stage) || metadata.verify || metadata.goal || metadata.loop || metadata.cron || metadata.next_run_at;
        return planned ? 'open' : 'backlog';
      }
      if (task.status === 'claimed') return 'doing';
      if (task.status === 'review') return 'review';
      const reviewed = task.latest_event_type === 'reviewed' || !!(task.review && (task.review.reward != null || task.review.proof || task.review.lesson || task.review.next_task));
      if (task.status === 'failed' && reviewed) return 'done';
      if (task.status === 'failed') return 'blocked';
      if (task.status === 'done' && !reviewed) return 'review';
      return 'done';
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function fmtTime(ms) {
      try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
      catch (e) { return ''; }
    }

    function renderHeartbeat(hb) {
      const el = $('heartbeat');
      el.className = 'beat ' + (hb.state || 'idle');
      if (hb.state === 'stale') {
        el.innerHTML = '<span class="dot"></span><span class="warn">stale</span><span>· ' + esc(hb.stale_reason || '') + ' · ' + (hb.total_ticks || 0) + ' ticks</span>';
        return;
      }
      if (!hb.total_ticks) {
        el.innerHTML = '<span class="dot"></span><span>idle · no ticks yet · run: atris pulse tick</span>';
        return;
      }
      const age = hb.last_tick_age_min == null ? '' : (hb.last_tick_age_min === 0 ? 'just now' : hb.last_tick_age_min + 'm ago');
      el.innerHTML = '<span class="dot"></span><b>alive</b>'
        + '<span>· last tick ' + age + '</span>'
        + (hb.last_what ? '<span>· ' + esc(hb.last_what) + '</span>' : '')
        + '<span>· ' + hb.total_ticks + ' ticks, reward ' + (hb.reward_sum || 0) + '</span>';
    }

    function renderActivity(events) {
      const el = $('activity');
      if (!events.length) { el.innerHTML = '<h2>Live Stream</h2><div class="empty">no activity yet, fire a tick: atris pulse tick</div>'; return; }
      let html = '<h2>Live Stream · ' + events.length + ' events</h2>';
      for (const e of events) {
        const rwCls = e.reward == null ? '' : (e.reward > 0 ? 'pos' : (e.reward < 0 ? 'neg' : ''));
        const rw = e.reward == null ? '' : (e.reward > 0 ? '+' + e.reward : '' + e.reward);
        html += '<div class="ev ' + (e.status === 'bad' ? 'bad' : '') + '">'
          + '<span class="t">' + (e.ms ? fmtTime(e.ms) : '') + '</span>'
          + '<span class="src ' + esc(e.source) + '">' + esc(e.source) + '</span>'
          + '<span class="msg">' + esc(e.title) + (e.detail ? ' <span class="d">' + esc(e.detail) + '</span>' : '') + '</span>'
          + '<span class="rw ' + rwCls + '">' + rw + '</span>'
          + '</div>';
      }
      el.innerHTML = html;
    }

    async function loadStream() {
      const data = await api('/api/stream');
      renderHeartbeat(data.heartbeat || {});
      renderActivity(data.events || []);
    }

    async function load() {
      const data = await api('/api/tasks');
      state = data.projection;
      render();
      loadStream().catch(() => {});
    }

    function render() {
      renderOverview();
      renderStreams();
      const board = $('board');
      board.style.setProperty('--board-columns', columns.length);
      board.innerHTML = '';
      for (const [key, label] of columns) {
        const tasks = state.tasks.filter((task) => taskColumn(task) === key);
        const col = document.createElement('div');
        col.className = 'col';
        col.innerHTML = '<h2><span>' + label + '</span><span>' + tasks.length + '</span></h2><div class="cards"></div>';
        const cards = col.querySelector('.cards');
        if (!tasks.length) cards.innerHTML = '<div class="empty">No tasks</div>';
        for (const task of tasks) cards.appendChild(card(task));
        board.appendChild(col);
      }
      renderRoom();
    }

    function taskById(id) {
      return state.tasks.find((task) => task.id === id) || null;
    }

    function renderOverview() {
      const active = state.tasks.filter((task) => task.status !== 'done');
      const reviewed = state.tasks.filter((task) => task.latest_event_type === 'reviewed');
      const goals = state.goals && state.goals.items || [];
      const goalHtml = goals.length
        ? goals.slice(0, 4).map((goal) => '<div class="goalitem"></div>').join('')
        : '<div class="empty">No atris/goals.md found. Add goals to give tasks a north star.</div>';
      const latest = reviewed.slice(0, 3);
      const chainHtml = latest.length
        ? latest.map((task) => '<div class="chainitem"><span>' + (task.display_id || task.id.slice(0, 8)) + '</span><strong></strong></div>').join('')
        : '<div class="empty">Complete a task with proof to start the chain.</div>';
      $('overview').innerHTML = [
        '<div class="goalbox"><h2>Goals</h2>' + goalHtml + '</div>',
        '<div class="chainbox"><h2>Compounding Chain</h2><div class="chainitem"><span>active</span><strong>' + active.length + ' open loops</strong></div>' + chainHtml + '</div>'
      ].join('');
      $('overview').querySelectorAll('.goalitem').forEach((el, i) => { el.textContent = goals[i]; });
      $('overview').querySelectorAll('.chainbox .chainitem strong').forEach((el, i) => {
        if (i === 0) return;
        const task = latest[i - 1];
        const what = task.explanation && task.explanation.what_changes || task.title;
        el.textContent = (task.review && task.review.next_task) ? what + ' -> ' + task.review.next_task : what;
      });
    }

    function renderStreams() {
      const streams = (state.streams || []).filter((stream) => stream.active_count || stream.done_count).slice(0, 6);
      const root = $('streams');
      if (!streams.length) {
        root.innerHTML = '';
        return;
      }
      root.innerHTML = streams.map((stream) => {
        const total = Math.max(1, stream.open_count + stream.doing_count + stream.review_count + stream.blocked_count);
        const widths = {
          open: Math.max(0, Math.round(stream.open_count / total * 100)),
          doing: Math.max(0, Math.round(stream.doing_count / total * 100)),
          review: Math.max(0, Math.round(stream.review_count / total * 100)),
          blocked: Math.max(0, Math.round(stream.blocked_count / total * 100))
        };
        const tasks = stream.tasks.filter((task) => task.status !== 'done').slice(0, 3);
        const taskHtml = tasks.length
          ? tasks.map((task) => '<div class="streamtask"><span>' + (task.display_id || task.id.slice(0, 8)) + '</span><strong></strong></div>').join('')
          : '<div class="empty">No active tasks in this stream.</div>';
        return [
          '<div class="stream">',
          '<h2></h2>',
          '<div class="meta"><span class="pill">' + stream.active_count + ' active</span><span class="pill">' + stream.done_count + ' done</span></div>',
          '<div class="streambar"><span class="seg-open" style="width:' + widths.open + '%"></span><span class="seg-doing" style="width:' + widths.doing + '%"></span><span class="seg-review" style="width:' + widths.review + '%"></span><span class="seg-blocked" style="width:' + widths.blocked + '%"></span></div>',
          taskHtml,
          '</div>'
        ].join('');
      }).join('');
      root.querySelectorAll('.stream h2').forEach((el, i) => { el.textContent = streams[i].objective; });
      root.querySelectorAll('.stream').forEach((streamEl, i) => {
        const tasks = streams[i].tasks.filter((task) => task.status !== 'done').slice(0, 3);
        streamEl.querySelectorAll('.streamtask strong').forEach((el, idx) => {
          el.textContent = tasks[idx].explanation && tasks[idx].explanation.what_changes || tasks[idx].title;
        });
      });
    }

    function card(task) {
      const btn = document.createElement('button');
      btn.className = 'card' + (selected === task.id ? ' active' : '');
      btn.onclick = () => { selected = task.id; render(); };
      const owner = task.claimed_by ? '@' + task.claimed_by : 'unowned';
      // Plain layer first: what changes, why it matters, what done looks like.
      // Ids, owner, and version stay below it as detail.
      btn.innerHTML = '<div class="title"></div><div class="plain"></div>'
        + '<div class="meta"><span class="pill"></span><span class="pill"></span><span class="pill"></span></div><div class="why"></div>';
      const plain = task.explanation || {};
      btn.querySelector('.title').textContent = plain.what_changes || task.title;
      const plainRows = [];
      plainRows.push('Why it matters: ' + (plain.why_it_matters || 'No reason recorded yet.'));
      plainRows.push('Done looks like: ' + (plain.done_looks_like || 'Proof of the work, then review.'));
      const plainBox = btn.querySelector('.plain');
      for (const row of plainRows) {
        const line = document.createElement('div');
        line.textContent = row;
        plainBox.appendChild(line);
      }
      const pills = btn.querySelectorAll('.pill');
      pills[0].textContent = task.display_id || task.id.slice(0, 8);
      pills[1].textContent = owner;
      pills[2].textContent = 'v' + task.current_version;
      btn.querySelector('.why').textContent = 'Technical details: ' + task.title;
      return btn;
    }

    function renderRoom() {
      const task = state.tasks.find((t) => t.id === selected);
      const room = $('room');
      if (!task) {
        room.innerHTML = '<div class="empty">Select a task to open its room.</div>';
        return;
      }
      const messages = task.messages.map((m) => '<div class="msg"><div class="who">' + (m.actor || 'unknown') + ' / v' + m.version + '</div><div></div></div>').join('');
      const parent = task.lineage && task.lineage.parent_title ? task.lineage.parent_title : 'none';
      const children = task.lineage && task.lineage.child_titles && task.lineage.child_titles.length ? task.lineage.child_titles.join(' | ') : (task.review && task.review.next_task || 'none yet');
      room.innerHTML = [
        '<h3></h3>',
        '<div class="meta"><span class="pill">' + task.status + '</span><span class="pill">' + (task.claimed_by || 'unowned') + '</span><span class="pill">v' + task.current_version + '</span></div>',
        '<div class="fact"><b>What changes</b><div id="taskWhatChanges"></div></div>',
        '<div class="fact"><b>Why it matters</b><div id="taskWhyItMatters"></div></div>',
        '<div class="fact"><b>Done looks like</b><div id="taskDoneLooksLike"></div></div>',
        '<div class="fact"><b>Approval</b><div id="taskApproval"></div></div>',
        '<div class="fact"><b>Technical details</b><div id="taskTechnicalDetails"></div></div>',
        '<div class="fact"><b>Goal</b><div id="taskGoal"></div></div>',
        '<div class="fact"><b>Lineage</b><div id="taskLineage"></div></div>',
        '<div class="fact"><b>Result</b><div id="taskHappened"></div></div>',
        '<div class="fact"><b>How I checked</b><div id="taskChecked"></div></div>',
        '<div class="fact"><b>What I tested</b><div id="taskTested"></div></div>',
        '<div class="fact"><b>Decision</b><div id="taskDecision"></div></div>',
        '<div class="fact"><b>Proof / lesson</b><div id="taskProof"></div></div>',
        '<div class="thread">' + (messages || '<div class="empty">No thread yet.</div>') + '</div>',
        '<label>Add context</label><textarea id="note" placeholder="Decision, blocker, context, update..."></textarea>',
        '<label>Proof</label><input id="proof" placeholder="npm test, PR link, screenshot, blocked reason...">',
        '<label>Lesson</label><textarea id="lesson" placeholder="What did this task teach us?"></textarea>',
        '<label>Next task</label><input id="nextTask" placeholder="Optional next sharper task">',
        '<div class="actions"><button id="claim">Claim</button><button id="saveNote">Say</button><button id="requestChange">Ask for a change</button><button id="finish" class="primary full"></button></div>'
      ].join('');
      const plain = task.explanation || {};
      const approval = task.approval || {};
      room.querySelector('h3').textContent = plain.what_changes || task.title;
      $('taskWhatChanges').textContent = plain.what_changes || task.title;
      $('taskWhyItMatters').textContent = plain.why_it_matters || 'No reason recorded yet.';
      $('taskDoneLooksLike').textContent = plain.done_looks_like || 'Proof of the work, then review.';
      $('taskApproval').textContent = approval.approve && approval.approve.enabled
        ? approval.question
        : (approval.approve && approval.approve.blocked_reason) || 'Nothing to approve yet.';
      $('taskTechnicalDetails').textContent = task.title;
      $('taskGoal').textContent = task.objective || 'No matching goal yet.';
      $('taskLineage').textContent = 'parent: ' + parent + ' / next: ' + children;
      const result = task.review && task.review.result || {};
      const landing = task.review && task.review.landing || {
        happened: result.changed,
        checked: result.checked,
        tested: task.review && task.review.proof ? 'Proof is attached below.' : '',
        decision: result.accept,
      };
      $('taskHappened').textContent = landing.happened || (task.review && task.review.summary) || 'No review result yet.';
      $('taskChecked').textContent = landing.checked || 'No check yet.';
      $('taskTested').textContent = landing.tested || 'No test recorded yet.';
      $('taskDecision').textContent = landing.decision || 'No accept action yet.';
      $('taskProof').textContent = task.review && (task.review.proof || task.review.lesson)
        ? ((task.review.proof || 'no proof') + ' / ' + (task.review.lesson || 'no lesson'))
        : 'No proof yet.';
      room.querySelectorAll('.msg div:last-child').forEach((el, i) => { el.textContent = task.messages[i].content; });
      const canApprove = Boolean(approval.approve && approval.approve.enabled);
      const planned = task.metadata && task.metadata.stage === 'plan';
      $('finish').textContent = canApprove
        ? approval.approve.label
        : task.status === 'claimed' ? 'Move to Review' : 'Approval not ready';
      $('finish').disabled = !canApprove && task.status !== 'claimed';
      $('claim').onclick = () => mutate('/api/tasks/' + task.id + '/claim', { owner: 'operator' });
      // Ask for a change runs the existing revise gate; it never lands work.
      $('requestChange').disabled = !(approval.request_change && approval.request_change.enabled);
      $('requestChange').textContent = approval.request_change && approval.request_change.label || 'Ask for a change';
      $('requestChange').onclick = () => {
        const note = $('note').value.trim();
        if (!note) { $('note').focus(); return; }
        const action = task.status === 'review' ? 'revise' : planned ? 'backlog' : 'message';
        const body = action === 'message' ? { actor: 'operator', content: note } : { actor: 'operator', note: note, reason: note };
        mutate('/api/tasks/' + task.id + '/' + action, body);
      };
      $('saveNote').onclick = () => mutate('/api/tasks/' + task.id + '/message', { actor: 'operator', content: $('note').value });
      $('finish').onclick = () => {
        const proof = $('proof').value.trim();
        const lesson = $('lesson').value.trim();
        const nextTask = $('nextTask').value.trim();
        const payload = { actor: 'operator' };
        if (proof) payload.proof = proof;
        if (lesson) payload.lesson = lesson;
        if (nextTask) payload.next = nextTask;
        if (task.status === 'review' && canApprove) {
          payload.createNext = Boolean(nextTask || (task.review && task.review.next_task));
          mutate('/api/tasks/' + task.id + '/accept', payload);
        } else if (planned && canApprove) {
          mutate('/api/tasks/' + task.id + '/do', { actor: task.metadata.assigned_to || task.claimed_by || 'operator', first_move: task.metadata.first_move });
        } else {
          mutate('/api/tasks/' + task.id + '/ready', payload);
        }
      };
    }

    async function mutate(path, body) {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      await load();
    }

    $('create').onsubmit = async (e) => {
      e.preventDefault();
      const title = $('title').value.trim();
      if (!title) return;
      const data = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, tag: $('tag').value || 'tasks' }) });
      selected = data.task_id;
      $('title').value = '';
      await load();
    };
    $('refresh').onclick = load;
    load();
    setInterval(load, 2500);
  </script>
</body>
</html>`;
}

function taskBoardHtml() {
  return taskBoardTemplate(taskBoardViewModel());
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': 'http://localhost',
    ...headers,
  });
  res.end(JSON.stringify(value, null, 2));
}

function sendHtml(res, value) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(value);
}

function taskApiQueueOptions(url) {
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : 8;
  return {
    owner: url.searchParams.get('owner') || url.searchParams.get('as') || DEFAULT_OWNER,
    reviewer: url.searchParams.get('reviewer') || url.searchParams.get('as_reviewer') || 'codex-review',
    all: url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true',
    everywhere: url.searchParams.get('everywhere') === '1' || url.searchParams.get('everywhere') === 'true',
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8,
    scope: taskQueueScopeFromSearchParams(url.searchParams),
  };
}

function serveTaskApiOptions({ res }) {
  return sendJson(res, 200, { ok: true });
}

function serveTaskBoardPage({ res }) {
  return sendHtml(res, taskBoardHtml());
}

function serveTaskList({ res, taskDb, db }) {
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, projection_path: outPath, projection });
}

function serveTaskActivityStream({ res, taskDb, db }) {
  // Time-ordered feed of what the agent actually did + heartbeat liveness.
  const { projection } = writeDefaultProjection(taskDb, db);
  const root = projection.workspace_root || process.cwd();
  const stateDir = path.join(root, '.atris', 'state');
  const activity = require('../lib/activity-stream');
  const { readJsonl } = require('../lib/pulse');
  const readStateRows = (file) => readJsonl(path.join(stateDir, file));
  const pulseReceipts = readStateRows('pulse_agi_loop_receipts.jsonl');
  const events = activity.buildActivityStream({
    pulseReceipts,
    scorecards: readStateRows('scorecards.jsonl'),
    taskEpisodes: readStateRows('task_episodes.jsonl').slice(-200),
    xpReceipts: readStateRows('career_xp_receipts.jsonl').slice(-200),
    missionEvents: readStateRows('mission_events.jsonl').slice(-200),
  }, { limit: 60 });
  return sendJson(res, 200, {
    ok: true,
    heartbeat: activity.buildHeartbeat(pulseReceipts),
    events,
  }, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function serveTaskCapabilities({ res }) {
  return sendJson(res, 200, {
    ok: true,
    action: 'capabilities',
    capabilities: taskCapabilitiesContract(),
    safety: {
      read_only: true,
      claims_work: false,
      human_accept: false,
      xp_after_human_accept: true,
    },
  });
}

function serveTaskCapabilitiesCheck({ res, taskDb, db, url }) {
  const report = taskCapabilitiesCheckReport(taskDb, db, [], taskApiQueueOptions(url));
  return sendJson(res, report.ok ? 200 : 409, report);
}

function serveTaskReviewLaneDrain({ res, taskDb, db, url }) {
  const report = taskReviewLaneDrainReport(taskDb, db, [], taskApiQueueOptions(url));
  return sendJson(res, report.ok ? 200 : 409, report);
}

async function postTaskReviewLaneAct({ req, res, taskDb, db, url }) {
  const body = await readJsonBody(req);
  const result = taskReviewLaneAct(taskDb, db, taskReviewLaneActOptionsFromBody(body, url.searchParams));
  return sendJson(res, result.ok ? 200 : result.status || 409, result);
}

async function postTaskReviewLaneLoop({ req, res, taskDb, db, url }) {
  const body = await readJsonBody(req);
  const result = taskReviewLaneLoop(taskDb, db, taskReviewLaneLoopOptionsFromBody(body, url.searchParams));
  return sendJson(res, result.ok ? 200 : result.status || 409, result);
}

async function postTaskReviewLaneRun({ req, res, taskDb, db, url }) {
  const body = await readJsonBody(req);
  const result = taskReviewLaneRun(taskDb, db, taskReviewLaneRunOptionsFromBody(body, url.searchParams));
  return sendJson(res, result.ok ? 200 : result.status || 409, result);
}

function serveTaskCurrent({ res, taskDb, db, url }) {
  const { outPath, current } = buildTaskCurrent(taskDb, db, [], taskApiQueueOptions(url));
  const action = url.pathname.endsWith('/queue') ? 'queue' : 'current';
  return sendJson(res, 200, {
    ok: true,
    action,
    projection_path: outPath,
    current,
    selected: current.selected,
    page: current.page,
    queue: current.queue,
  });
}

async function postCurrentTaskStep({ req, res, taskDb, db, url }) {
  const body = await readJsonBody(req);
  const options = taskCurrentStepOptionsFromBody(body, url.searchParams);
  try {
    const result = runCurrentTaskStep(taskDb, db, options);
    return sendJson(res, 200, result);
  } catch (error) {
    const errorCurrent = error.current || null;
    return sendJson(res, error.status || 409, {
      ok: false,
      action: 'current_step',
      reason: error.reason || 'step_failed',
      detail: error.message,
      selected_task_id: errorCurrent ? errorCurrent.selected_task_id : null,
      selected_ref: errorCurrent ? errorCurrent.selected_ref : null,
      selected_next_key: selectedNextKeyFromCurrent(errorCurrent),
      current: errorCurrent,
      page: error.page || null,
    });
  }
}

async function postTaskCreate({ req, res, taskDb, db }) {
  const body = await readJsonBody(req);
  const title = String(body.title || '').trim();
  if (!title) return sendJson(res, 400, { ok: false, reason: 'missing_title', detail: 'title required' });
  const operatorTitleWarning = warnIfTaskTitleNeedsOperatorWhy(title);
  const metadata = {
    ...(body.verify ? { verify: String(body.verify).trim() } : {}),
    ...explanationFieldsFromInput(body),
  };
  const result = taskDb.addTask(db, {
    title,
    tag: body.tag ? String(body.tag) : 'tasks',
    workspaceRoot: taskDb.workspaceRoot(),
    metadata: Object.keys(metadata).length ? metadata : null,
  });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, {
    ok: true,
    action: 'created',
    task_id: result.id,
    operator_title_warning: operatorTitleWarning,
    projection_path: outPath,
    task: taskFromProjection(projection, result.id),
  });
}

async function postTaskClearPlan({ req, res, taskDb, db }) {
  const body = await readJsonBody(req);
  if (!body.confirm && !body.yes) {
    return sendJson(res, 400, { ok: false, reason: 'confirm_required', detail: stageErrorDetail('task clear-plan', 'confirm_required') });
  }
  const result = taskDb.clearPlanTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
    actor: String(body.actor || DEFAULT_OWNER),
    reason: String(body.reason || body.note || 'clear_plan'),
    tag: String(body.tag || 'capture'),
  });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const taskById = new Map((projection.tasks || []).map(task => [task.id, task]));
  return sendJson(res, 200, {
    ok: true,
    action: 'clear_plan',
    cleared_count: result.cleared.length,
    skipped_count: result.skipped.length,
    skipped: result.skipped,
    projection_path: outPath,
    tasks: result.cleared.map(task => taskFromProjection(projection, task.id) || taskById.get(task.id)).filter(Boolean),
  });
}

const TASK_API_ROUTES = [
  { method: 'OPTIONS', pathname: null, serve: serveTaskApiOptions },
  { method: 'GET', pathname: '/', serve: serveTaskBoardPage },
  { method: 'GET', pathname: '/api/tasks', serve: serveTaskList },
  { method: 'GET', pathname: '/api/stream', serve: serveTaskActivityStream },
  { method: 'GET', pathname: '/api/tasks/capabilities', serve: serveTaskCapabilities },
  { method: 'GET', pathname: '/api/tasks/capabilities/check', serve: serveTaskCapabilitiesCheck },
  { method: 'GET', pathname: '/api/tasks/review-lane-drain', serve: serveTaskReviewLaneDrain },
  { method: 'POST', pathname: '/api/tasks/review-lane-act', serve: postTaskReviewLaneAct },
  { method: 'POST', pathname: '/api/tasks/review-lane-loop', serve: postTaskReviewLaneLoop },
  { method: 'POST', pathname: '/api/tasks/review-lane-run', serve: postTaskReviewLaneRun },
  { method: 'GET', pathname: '/api/tasks/current', serve: serveTaskCurrent },
  { method: 'GET', pathname: '/api/tasks/queue', serve: serveTaskCurrent },
  { method: 'POST', pathname: '/api/tasks/current/step', serve: postCurrentTaskStep },
  { method: 'POST', pathname: '/api/tasks', serve: postTaskCreate },
  { method: 'POST', pathname: '/api/tasks/clear-plan', serve: postTaskClearPlan },
  { pattern: /^\/api\/tasks\/([^/]+)$/, serve: serveTaskDetail },
  { pattern: /^\/api\/tasks\/([^/]+)\/page$/, serve: serveTaskPage },
  { pattern: /^\/api\/tasks\/([^/]+)\/(claim|message|chat|step|plan|do|backlog|ready|accept|revise|finish|review|review-chat|continue-work|events)$/, serve: serveTaskOperation },
];

function serveTaskDetail({ req, res, taskDb, db, match }) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  const resolved = resolveTaskRef(taskDb, db, match[1]);
  if (!resolved.ok) return sendJson(res, resolved.reason === 'ambiguous' ? 409 : 404, { ok: false, reason: resolved.reason });
  const task = taskDetail(taskDb, db, resolved.id);
  if (!task) return sendJson(res, 404, { ok: false, reason: 'not_found' });
  const { outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'detail', task_id: resolved.id, projection_path: outPath, task, page: taskPageContract(task) });
}

function serveTaskPage({ req, res, taskDb, db, match }) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  const resolved = resolveTaskRef(taskDb, db, match[1]);
  if (!resolved.ok) return sendJson(res, resolved.reason === 'ambiguous' ? 409 : 404, { ok: false, reason: resolved.reason });
  const task = taskDetail(taskDb, db, resolved.id);
  if (!task) return sendJson(res, 404, { ok: false, reason: 'not_found' });
  const { outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'page', task_id: resolved.id, projection_path: outPath, page: taskPageContract(task) });
}

function postTaskApiStep({ res, taskDb, db, taskId, body }) {
  try {
    const result = runTaskStep(taskDb, db, taskId, taskStepOptionsFromBody(body));
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, error.status || 409, {
      ok: false,
      action: 'step',
      task_id: taskId,
      reason: error.reason || 'step_failed',
      detail: error.message,
      page: error.page || null,
    });
  }
}

function postTaskApiContinueWork({ res, taskDb, db, taskId, body }) {
  try {
    const result = continueWorkForReviewTask(taskDb, db, taskId, { owner: body.owner || body.actor || DEFAULT_OWNER });
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, error.status || 409, {
      ok: false,
      action: 'continue_work',
      task_id: taskId,
      reason: error.reason || 'continue_work_failed',
      detail: error.message,
    });
  }
}

function postTaskApiClaim({ res, taskDb, db, taskId, body }) {
  const owner = String(body.owner || body.actor || DEFAULT_OWNER);
  const result = taskDb.claimTask(db, { id: taskId, claimedBy: owner });
  if (!result.claimed) return sendJson(res, 409, { ok: false, reason: result.reason, claimed_by: result.claimed_by || null });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'claimed', task_id: taskId, projection_path: outPath, task: taskFromProjection(projection, taskId) });
}

function postTaskApiMessage({ res, taskDb, db, taskId, body }) {
  const result = taskDb.noteTask(db, { id: taskId, actor: String(body.actor || DEFAULT_OWNER), content: String(body.content || '') });
  if (!result.noted) return sendJson(res, 404, { ok: false, reason: result.reason });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'noted', task_id: taskId, projection_path: outPath, task: taskFromProjection(projection, taskId) });
}

function postTaskApiChat({ res, taskDb, db, taskId, body }) {
  const result = taskDb.chatTask(db, {
    id: taskId,
    actor: String(body.actor || DEFAULT_OWNER),
    content: String(body.content || body.message || body.text || ''),
    goal: String(body.goal || body.objective || ''),
    summary: String(body.summary || ''),
  });
  if (!result.chatted) {
    const status = result.reason === 'content_required' ? 400 : result.reason === 'not_found' ? 404 : 409;
    return sendJson(res, status, { ok: false, reason: result.reason, detail: stageErrorDetail('task chat', result.reason, result) });
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, {
    ok: true,
    action: 'chatted',
    task_id: taskId,
    version: result.event.version,
    goal_changed: result.goal_changed,
    chat_packet: result.chat_packet,
    projection_path: outPath,
    task: taskFromProjection(projection, taskId),
  });
}

function postTaskApiPlan({ res, taskDb, db, taskId, body }) {
  const actor = String(body.actor || DEFAULT_OWNER);
  const goal = String(body.goal || body.objective || '');
  const summary = String(body.summary || body.plan || '');
  const owner = String(body.owner || body.assignee || '');
  const exit = String(body.exit || body.exit_condition || '');
  const firstMove = String(body.first_move || body.firstMove || body.first || '');
  const task = taskDetail(taskDb, db, taskId);
  const automaticPlan = buildAutomaticPlanTrace(taskDb, task, {
    actor,
    actorExplicit: Boolean(body.actor),
    owner,
    goal,
    summary,
    firstMove,
    exit,
  });
  const result = taskDb.stageTask(db, {
    id: taskId,
    actor,
    stage: 'plan',
    goal,
    summary,
    owner: automaticPlan.ownerForStage || owner,
    ownerExplicit: Boolean(owner),
    exit,
    proofNeeded: String(body.proof_needed || body.proofNeeded || body.proof || body.verify || ''),
    firstMove,
    nextButton: String(body.next_button || body.nextButton || ''),
    confidence: body.confidence,
    planTrace: automaticPlan.trace,
  });
  if (!result.staged) return sendJson(res, 409, { ok: false, reason: result.reason, detail: stageErrorDetail('task plan', result.reason, result) });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'planned', task_id: taskId, version: result.event.version, plan_trace: automaticPlan.trace, stage_packet: result.stage_packet, projection_path: outPath, task: taskFromProjection(projection, taskId) });
}

function postTaskApiDo({ res, taskDb, db, taskId, body }) {
  const firstMove = String(body.first_move || body.firstMove || body.first || '').trim();
  if (!firstMove) return sendJson(res, 400, { ok: false, reason: 'first_move_required', detail: 'task do: first_move required' });
  const result = taskDb.stageTask(db, {
    id: taskId,
    actor: String(body.actor || DEFAULT_OWNER),
    stage: 'do',
    goal: String(body.goal || body.objective || ''),
    summary: String(body.summary || ''),
    owner: String(body.actor || DEFAULT_OWNER),
    exit: String(body.exit || body.exit_condition || body.exitCondition || ''),
    proofNeeded: String(body.proof_needed || body.proofNeeded || body.proof || body.verify || ''),
    firstMove,
    nextButton: String(body.next_button || body.nextButton || ''),
    confidence: body.confidence,
  });
  if (!result.staged) return sendJson(res, 409, { ok: false, reason: result.reason, detail: stageErrorDetail('task do', result.reason, result) });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'doing', task_id: taskId, version: result.event.version, stage_packet: result.stage_packet, projection_path: outPath, task: taskFromProjection(projection, taskId) });
}

function postTaskApiBacklog({ res, taskDb, db, taskId, body }) {
  const result = taskDb.backlogTask(db, {
    id: taskId,
    actor: String(body.actor || DEFAULT_OWNER),
    reason: String(body.reason || body.note || 'clear_plan'),
    tag: String(body.tag || 'capture'),
  });
  if (!result.backlogged) return sendJson(res, 409, { ok: false, reason: result.reason, detail: stageErrorDetail('task backlog', result.reason, result) });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, {
    ok: true,
    action: 'backlogged',
    task_id: taskId,
    version: result.event.version,
    cleared_keys: result.cleared_keys,
    projection_path: outPath,
    task: taskFromProjection(projection, taskId),
  });
}

function postTaskApiReviewChat({ res, taskDb, db, taskId, body }) {
  try {
    const result = appendTaskReviewChat(taskDb, db, taskId, {
      reviewer: body.reviewer || body.actor || 'codex-review',
      dryRun: Boolean(body.dryRun || body.noNote),
    });
    const { event, compactProjection, outPath, ...payload } = result;
    return sendJson(res, 200, payload);
  } catch (error) {
    return sendJson(res, error.status || 409, {
      ok: false,
      reason: error.reason || 'review_chat_failed',
      detail: error.message,
    });
  }
}

function postTaskApiFinish({ res, taskDb, db, taskId, body }) {
  const currentTask = taskDb.getTask(db, taskId);
  const failed = Boolean(body.failed);
  const proof = String(body.proof || '').trim();
  const shouldReview = Boolean(body.proof || body.lesson || body.next || body.reward !== undefined);
  const proofIssue = meaningfulTaskProofIssue(proof, { required: !failed || shouldReview });
  if (proofIssue) return sendProofIssue(res, proof, proofIssue);
  const done = taskDb.doneTask(db, {
    id: taskId,
    status: failed ? 'failed' : 'done',
    actor: String(body.actor || DEFAULT_OWNER),
    action: failed ? 'failed' : 'finished',
    proof,
  });
  if (!done.updated) return sendJson(res, 409, { ok: false, reason: 'not_open_or_claimed' });
  let episode = null;
  let nextCreated = null;
  let xpProjection = null;
  if (shouldReview) {
    const reviewed = taskDb.reviewTask(db, {
      id: taskId,
      actor: String(body.actor || DEFAULT_OWNER),
      reward: body.reward === undefined ? 1 : body.reward,
      lesson: String(body.lesson || ''),
      nextTask: String(body.next || ''),
      proof: String(body.proof || ''),
      careerXpEligible: false,
    });
    episode = reviewed.episode;
    nextCreated = body.createNext ? createNextTaskIfRequested(taskDb, db, ['--create-next'], currentTask, episode.next_task_suggestion) : null;
    xpProjection = refreshCareerXpAfterReview(reviewed);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, {
    ok: true,
    action: 'finished',
    task_id: taskId,
    reviewed: Boolean(episode),
    episode,
    xp_projection: xpProjection,
    next_task_id: nextCreated ? nextCreated.id : null,
    projection_path: outPath,
    task: taskFromProjection(projection, taskId),
  });
}

function postTaskApiReady({ res, taskDb, db, taskId, body }) {
  const proof = String(body.proof || '').trim();
  const proofIssue = meaningfulTaskProofIssue(proof);
  if (proofIssue) return sendProofIssue(res, proof, proofIssue);
  const unrunIssue = unrunNamedProofCommandIssue(proof, '');
  if (unrunIssue) {
    return sendJson(res, 400, {
      ok: false,
      reason: unrunIssue.reason,
      detail: unrunIssue.detail,
    });
  }
  const nextTaskInput = normalizeReviewNextTaskInput(body.next);
  const actor = String(body.actor || DEFAULT_OWNER);
  const resultText = String(body.result || '').replace(/\s+/g, ' ').trim();
  if (resultText) {
    const resultIssue = resultSentenceIssue(resultText);
    if (resultIssue) return sendJson(res, 400, { ok: false, reason: 'weak_result', detail: resultIssue });
  }
  const resultTrace = buildAutomaticResultTrace(taskDb, db, taskId, {
    actor,
    proof,
    changed: body.changed || resultText || body.done,
    checked: body.checked || body.check || body.verified,
    passed: body.passed || body.pass,
    failed: body.failed || body.fail,
    cost: body.cost,
    saved: body.saved || body.savings,
    tryNext: body.try_next || body.tryNext || body.try || body.handoff,
    status: body.status,
    files: body.files,
    commands: body.commands || body.command,
  });
  const result = taskDb.readyTask(db, {
    id: taskId,
    actor,
    proof,
    lesson: String(body.lesson || ''),
    nextTask: nextTaskInput.nextTask,
    resultTrace: resultTrace && resultTrace.trace,
    result: resultText,
    landing: body.landing || {
      happened: body.happened,
      checked: body.checked,
      tested: body.tested,
      decision: body.decision,
    },
  });
  if (!result.ready) return sendJson(res, 409, { ok: false, reason: result.reason });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, {
    ok: true,
    action: 'ready',
    task_id: taskId,
    result_trace: resultTrace,
    ...(nextTaskInput.ignored ? { review_next_task_ignored: nextTaskInput.ignored } : {}),
    projection_path: outPath,
    task: taskFromProjection(projection, taskId),
  });
}

function postTaskApiAccept({ res, taskDb, db, taskId, body }) {
  const currentTask = enrichTaskProjection(taskDb.taskProjection(db, { taskId })).tasks[0] || null;
  const hasExplicitProof = Object.prototype.hasOwnProperty.call(body, 'proof');
  const proof = String(hasExplicitProof ? body.proof : currentTask?.metadata?.latest_agent_proof || '').trim();
  const proofIssue = meaningfulTaskProofIssue(proof);
  if (proofIssue) return sendProofIssue(res, proof, proofIssue);
  const hasExplicitLesson = Object.prototype.hasOwnProperty.call(body, 'lesson');
  const hasExplicitNext = Object.prototype.hasOwnProperty.call(body, 'next');
  const lesson = hasExplicitLesson ? String(body.lesson || '') : String(currentTask?.review?.lesson || currentTask?.metadata?.latest_agent_lesson || '');
  const nextTask = hasExplicitNext ? String(body.next || '') : String(currentTask?.review?.next_task || currentTask?.metadata?.latest_agent_next_task || '');
  const clearedFields = [];
  if (hasExplicitLesson && !lesson.trim()) clearedFields.push('lesson');
  if (hasExplicitNext && !nextTask.trim()) clearedFields.push('next_task');
  const parsedReward = parseAcceptReward(body.reward);
  if (!parsedReward.ok) return sendJson(res, 400, { ok: false, reason: 'invalid_reward', detail: 'reward must be a positive number' });
  const done = taskDb.doneTask(db, {
    id: taskId,
    status: 'done',
    actor: String(body.actor || DEFAULT_OWNER),
    allowReview: true,
    action: 'accepted',
    proof,
  });
  if (!done.updated) return sendJson(res, 409, { ok: false, reason: 'not_open_claimed_or_review' });
  const reviewed = taskDb.reviewTask(db, {
    id: taskId,
    actor: String(body.actor || DEFAULT_OWNER),
    reward: parsedReward.value,
    lesson,
    nextTask,
    proof,
    careerXpEligible: true,
    clearedFields,
  });
  const nextCreated = body.createNext ? createNextTaskIfRequested(taskDb, db, ['--create-next'], currentTask, reviewed.episode.next_task_suggestion) : null;
  const xpProjection = refreshCareerXpAfterReview(reviewed);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'accepted', task_id: taskId, episode: reviewed.episode, xp_projection: xpProjection, next_task_id: nextCreated ? nextCreated.id : null, projection_path: outPath, task: taskFromProjection(projection, taskId) });
}

function postTaskApiRevise({ res, taskDb, db, taskId, body }) {
  const result = taskDb.reviseTask(db, { id: taskId, actor: String(body.actor || DEFAULT_OWNER), note: String(body.note || body.reason || '') });
  if (!result.revised) return sendJson(res, 409, { ok: false, reason: result.reason });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'revise', task_id: taskId, projection_path: outPath, task: taskFromProjection(projection, taskId) });
}

function postTaskApiReview({ res, taskDb, db, taskId, body }) {
  const currentTask = taskDb.getTask(db, taskId);
  const rewardValue = body.reward === undefined ? 0 : body.reward;
  const proof = String(body.proof || '').trim();
  const hasExplicitLesson = Object.prototype.hasOwnProperty.call(body, 'lesson');
  const hasExplicitNext = Object.prototype.hasOwnProperty.call(body, 'next')
    || Object.prototype.hasOwnProperty.call(body, 'next_task')
    || Object.prototype.hasOwnProperty.call(body, 'nextTask');
  const lessonText = hasExplicitLesson ? String(body.lesson || '') : '';
  const rawNext = Object.prototype.hasOwnProperty.call(body, 'next')
    ? body.next
    : Object.prototype.hasOwnProperty.call(body, 'next_task')
    ? body.next_task
    : body.nextTask;
  const nextTaskInput = normalizeReviewNextTaskInput(hasExplicitNext ? rawNext : '');
  const clearedFields = [];
  if (hasExplicitLesson && !lessonText.trim()) clearedFields.push('lesson');
  if (hasExplicitNext && !String(rawNext || '').trim()) clearedFields.push('next_task');
  const proofIssue = Number(rewardValue) > 0 || proof
    ? meaningfulTaskProofIssue(proof)
    : null;
  if (proofIssue) return sendProofIssue(res, proof, proofIssue);
  const reviewed = taskDb.reviewTask(db, {
    id: taskId,
    actor: String(body.actor || DEFAULT_OWNER),
    reward: rewardValue,
    lesson: lessonText,
    nextTask: nextTaskInput.nextTask,
    proof,
    careerXpEligible: false,
    clearedFields,
  });
  const nextCreated = body.createNext ? createNextTaskIfRequested(taskDb, db, ['--create-next'], currentTask, reviewed.episode.next_task_suggestion) : null;
  const xpProjection = refreshCareerXpAfterReview(reviewed);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, {
    ok: true,
    action: 'reviewed',
    task_id: taskId,
    episode: reviewed.episode,
    xp_projection: xpProjection,
    next_task_id: nextCreated ? nextCreated.id : null,
    ...(nextTaskInput.ignored ? { review_next_task_ignored: nextTaskInput.ignored } : {}),
    projection_path: outPath,
    task: taskFromProjection(projection, taskId),
  });
}

const TASK_API_POST_OPERATIONS = {
  step: postTaskApiStep,
  'continue-work': postTaskApiContinueWork,
  claim: postTaskApiClaim,
  message: postTaskApiMessage,
  chat: postTaskApiChat,
  plan: postTaskApiPlan,
  do: postTaskApiDo,
  backlog: postTaskApiBacklog,
  'review-chat': postTaskApiReviewChat,
  finish: postTaskApiFinish,
  ready: postTaskApiReady,
  accept: postTaskApiAccept,
  revise: postTaskApiRevise,
  review: postTaskApiReview,
};

function serveTaskEvents({ res, taskDb, db, taskId }) {
  const events = taskDb.listTaskEvents(db, { taskId, limit: 500 });
  return sendJson(res, 200, { ok: true, events });
}

async function serveTaskOperation({ req, res, taskDb, db, match }) {
  const resolved = resolveTaskRef(taskDb, db, match[1]);
  if (!resolved.ok) return sendJson(res, resolved.reason === 'ambiguous' ? 409 : 404, { ok: false, reason: resolved.reason });
  const taskId = resolved.id;
  const operation = match[2];
  if (req.method === 'GET' && operation === 'events') {
    return serveTaskEvents({ res, taskDb, db, taskId });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  const body = await readJsonBody(req);
  const postTaskOperation = TASK_API_POST_OPERATIONS[operation];
  if (!postTaskOperation) return;
  return postTaskOperation({ res, taskDb, db, taskId, body });
}

function matchTaskApiRoute(req, url) {
  for (const route of TASK_API_ROUTES) {
    if (route.method && route.method !== req.method) continue;
    if (Object.prototype.hasOwnProperty.call(route, 'pathname')) {
      if (route.pathname === null || route.pathname === url.pathname) return { route, match: null };
      continue;
    }
    const match = url.pathname.match(route.pattern);
    if (match) return { route, match };
  }
  return null;
}

async function handleTaskApi(req, res, taskDb, db) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const matchedRoute = matchTaskApiRoute(req, url);
  if (!matchedRoute) return sendJson(res, 404, { ok: false, reason: 'not_found' });
  return matchedRoute.route.serve({
    req,
    res,
    taskDb,
    db,
    url,
    match: matchedRoute.match,
  });
}

function createTaskApiServer(taskApi = {}) {
  const taskDb = taskApi.taskDb || getTaskDb();
  const db = taskApi.db || taskDb.open();
  return http.createServer((req, res) => {
    handleTaskApi(req, res, taskDb, db).catch((error) => {
      sendJson(res, 500, { ok: false, reason: 'server_error', detail: String(error && error.message || error) });
    });
  });
}

function cmdServe(args) {
  const host = String(flag(args, '--host') || '127.0.0.1');
  const port = Number(flag(args, '--port') || process.env.PORT || 8787);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const server = createTaskApiServer({ taskDb, db });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = addr && addr.port || port;
      console.log(`Task board: http://${host}:${actualPort}`);
      console.log(`Workspace: ${taskDb.workspaceRoot()}`);
    });

    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}

async function runTaskCommand(args) {
  const raw = args || [];
  if (raw.includes('--help') || raw.includes('-h')) return help();
  const first = raw[0];
  if (!first) return cmdFirstMinute();
  const sub = first.startsWith('--') ? 'desk' : first;
  const rest = first.startsWith('--') ? raw : raw.slice(1);
  switch (sub) {
    case 'desk':   return cmdHome(rest);
    case 'today':  return cmdDay(rest);
    case 'day':    return cmdDay(rest);
    case 'add':    return cmdAdd(rest);
    case 'new':    return cmdAdd(rest);
    case 'delegate': return cmdDelegate(rest);
    case 'assign': return cmdDelegate(rest);
    case 'list':   return cmdList(rest);
    case 'ls':     return cmdList(rest);
    case 'plan':   return cmdPlan(rest);
    case 'do':     return cmdDo(rest);
    case 'backlog':
    case 'unplan':
      return cmdBacklog(rest);
    case 'clear-plan':
    case 'clearplan':
      return cmdClearPlan(rest);
    case 'claim':  return cmdClaim(rest);
    case 'start':  return cmdClaim(rest);
    case 'release':
    case 'unclaim':
      return cmdRelease(rest);
    case 'current':
    case 'select':
      return cmdCurrent(rest);
    case 'capabilities':
    case 'capability':
    case 'caps':
      return cmdCapabilities(rest);
    case 'capabilities-check':
    case 'capability-check':
    case 'caps-check':
      return cmdCapabilitiesCheck(rest);
    case 'review-lane-drain':
    case 'review-drain':
    case 'drain-review':
      return cmdReviewLaneDrain(rest);
    case 'review-lane-act':
    case 'review-act':
    case 'act-review':
      return cmdReviewLaneAct(rest);
    case 'review-lane-loop':
    case 'review-loop':
    case 'loop-review':
      return cmdReviewLaneLoop(rest);
    case 'review-lane-run':
    case 'review-run':
    case 'run-review':
      return cmdReviewLaneRun(rest);
    case 'current-step':
    case 'step-current':
    case 'advance-current':
      return cmdCurrentStep(rest);
    case 'queue':
      return cmdQueue(rest);
    case 'next':   return cmdNext(rest);
    case 'continue-work':
    case 'continue':
      return cmdContinueWork(rest);
    case 'chat':   return cmdChat(rest);
    case 'plan-preview':
    case 'preview-plan':
    case 'plan-card':
      return cmdPlanPreview(rest);
    case 'note':   return cmdNote(rest);
    case 'say':    return cmdNote(rest);
    case 'retitle': return cmdRetitle(rest);
    case 'tag':
    case 'tags':
      return cmdTag(rest);
    case 'show':   return cmdShow(rest);
    case 'inspect': return cmdInspect(rest);
    case 'page':   return cmdPage(rest);
    case 'step':   return cmdStep(rest);
    case 'review-chat':
    case 'chat-review':
      return cmdReviewChat(rest);
    case 'ready':  return cmdReady(rest);
    case 'receipt': return cmdTaskReceipt(rest);
    case 'result': return cmdResult(rest);
    case 'accept': return cmdAccept(rest);
    case 'landing':
    case 'land-review':
      return cmdLanding(rest);
    case 'auto-accept-certified':
    case 'auto-accept':
      return cmdAutoAcceptCertified(rest);
    case 'sweep':
      return cmdSweep(rest);
    case 'audit': return cmdAudit(rest);
    case 'certify-verified':
      return cmdCertifyVerified(rest);
    case 'accept-group':
      return cmdAcceptGroup(rest);
    case 'revise': return cmdRevise(rest);
    case 'done':   return cmdDone(rest);
    case 'finish': return cmdFinish(rest);
    case 'fail':   return cmdDone([...rest, '--failed']);
    case 'archive': return cmdArchive(rest);
    case 'clear-done': return cmdClearDone(rest);
    case 'reap-mission-blockers':
    case 'reap-blockers':
      return cmdReapMissionBlockers(rest);
    case 'relabel-archived': return cmdRelabelArchived(rest);
    case 'review': return cmdReview(rest);
    case 'reviews':
    case 'review-queue':
      return cmdReviews(rest);
    case 'status': return cmdStatus(rest);
    case 'setup':  return cmdSetup(rest);
    case 'serve':  return cmdServe(rest);
    case 'import': return cmdImport(rest);
    case 'lineage': return cmdLineage(rest);
    case 'events': return cmdEvents(rest);
    case 'export': return cmdExport(rest);
    case 'render': return cmdRender(rest);
    case 'sync':   return cmdSync(rest);
    case 'where':  return cmdWhere(rest);
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      if (wantsJson(raw)) {
        printJson({
          ok: false,
          error: `unknown task subcommand: ${sub}`,
          usage: taskUsageLines(),
        });
        process.exit(2);
      }
      console.error(`atris task: unknown subcommand "${sub}"`);
      help();
      process.exit(2);
  }
}

const MUTATING_TASK_COMMANDS = new Set([
  'add', 'new', 'delegate', 'assign', 'plan', 'do', 'backlog', 'unplan',
  'clear-plan', 'clearplan', 'claim', 'start', 'release', 'unclaim', 'next',
  'continue-work', 'continue', 'chat', 'note', 'say', 'retitle', 'tag', 'tags', 'step',
  'ready', 'result', 'accept', 'landing', 'land-review', 'auto-accept-certified',
  'auto-accept', 'sweep', 'audit', 'certify-verified', 'accept-group', 'revise',
  'done', 'finish', 'fail', 'archive', 'clear-done', 'reap-mission-blockers', 'reap-blockers', 'relabel-archived', 'review', 'import',
  'setup', 'review-lane-act', 'review-act', 'act-review', 'review-lane-loop',
  'review-loop', 'loop-review', 'review-lane-run', 'review-run', 'run-review',
]);

async function run(args) {
  const raw = args || [];
  const sub = !raw[0] || raw[0].startsWith('--') ? 'desk' : raw[0];
  // `task accept --help` is a help request, not a run. Accept mutates
  // review rows, so never list or accept just to show usage.
  if (sub === 'accept' && argsWantHelp(raw.slice(1))) {
    console.log('Usage: atris task accept <id> [--proof "..."] [--public]');
    return;
  }
  // `task claim --help` is a help request, not a run. Claim mutates
  // ownership, so never list or claim just to show usage.
  if (sub === 'claim' && argsWantHelp(raw.slice(1))) {
    console.log('Usage: atris task claim <id> --as <member>');
    return;
  }
  // `task ready --help` is a help request, not a run. Ready mutates
  // review state, so never list or ready just to show usage.
  if (sub === 'ready' && argsWantHelp(raw.slice(1))) {
    console.log('Usage: atris task ready <id> --proof "..." --result "<sentence>"');
    return;
  }
  // `task step --help` is a help request, not a run. Step mutates
  // Plan/Do/Review, so never list or step just to show usage.
  if (sub === 'step' && argsWantHelp(raw.slice(1))) {
    console.log('Usage: atris task step <id> [--json]');
    return;
  }
  // `task next --help` is a help request, not a run. Next can open
  // the task db or print the desk, so never list or claim just to show usage.
  if (sub === 'next' && argsWantHelp(raw.slice(1))) {
    console.log('Usage: atris task next [--tag <tag>] [--create-next]');
    return;
  }
  // `task show --help` is a help request, not a run. Show can dump
  // a task card or the encyclopedia, so never list or show just to show usage.
  if (sub === 'show' && argsWantHelp(raw.slice(1))) {
    console.log('Usage: atris task show <id> [--json]');
    return;
  }
  const result = await runTaskCommand(raw);
  const skipsRender = sub === 'clear-done' && hasFlag(raw, '--dry-run');
  if (MUTATING_TASK_COMMANDS.has(sub) && !skipsRender) autoRenderTodoFromDb();
  return result;
}

module.exports = {
  run,
  createTaskApiServer,
  taskDayGroups,
  taskDayTextGroups,
  taskDayTitle,
  taskReviewLanding,
  taskReviewLandingLines,
  delegateTask,
  AGENT_ENV_MARKERS,
  autoRenderTodoFromDb,
  projectionMissions,
  projectionWishes,
  taskBoardViewModel,
  taskBoardTemplate,
  enrichTaskProjection,
  taskApprovalFor,
  taskPageContract,
  taskDescriptionForCloud,
};
