'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskDb = require('../lib/task-db');
const { parseTodoFile } = require('../lib/todo-fallback');
const {
  EXPLANATION_FIELDS,
  EXPLANATION_LABELS,
  NO_REASON_RECORDED,
  plainText,
  taskExplanation,
  explanationMarkdownLines,
  approvalLines,
} = require('../lib/task-explanation');
const {
  enrichTaskProjection,
  taskApprovalFor,
  taskPageContract,
  taskDescriptionForCloud,
  taskBoardTemplate,
  taskBoardViewModel,
} = require('../commands/task');

const REPO_ROOT = path.resolve(__dirname, '..');

function tempWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-explanation-')));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  return root;
}

function cleanup(root) {
  taskDb.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function runTaskCli(root, dbPath, args) {
  taskDb.close();
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'atris.js'), 'task', ...args], {
    cwd: root,
    env: {
      ...process.env,
      ATRIS_TASKS_DB: dbPath,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
    },
    encoding: 'utf8',
  });
}

test('task explanation exports one stable public contract', () => {
  assert.deepEqual(EXPLANATION_FIELDS, ['what_changes', 'why_it_matters', 'done_looks_like']);
  assert.deepEqual(EXPLANATION_LABELS, {
    what_changes: 'What changes',
    why_it_matters: 'Why it matters',
    done_looks_like: 'Done looks like',
  });
  assert.equal(NO_REASON_RECORDED, 'No reason recorded yet.');
  assert.equal(plainText('canonical_schema CLI-88 uses --raw-mode'), 'main data format uses raw mode');
  assert.deepEqual(explanationMarkdownLines({
    what_changes: 'The plain summary leads.',
    why_it_matters: NO_REASON_RECORDED,
    done_looks_like: 'The exact record stays available.',
  }), [
    '  **What changes:** The plain summary leads.',
    '  **Why it matters:** No reason recorded yet.',
    '  **Done looks like:** The exact record stays available.',
  ]);
});

test('central task creation stores a plain face without changing full-fidelity task data', () => {
  const root = tempWorkspace();
  const dbPath = path.join(root, '.atris', 'state', 'tasks.db');
  const db = taskDb.open(dbPath);
  const title = 'canonical_schema CLI-88 keeps --raw-mode in src/task/runtime.js';
  const verify = 'node --test test/task-explanation.test.js --test-name-pattern="full fidelity"';
  const requirements = {
    exact_flag: '--raw-mode',
    exact_path: 'src/task/runtime.js',
    nested: ['canonical_schema', { keep: true }],
  };
  const explicit = {
    what_changes: 'People get a clear task summary before the technical notes',
    why_it_matters: 'This makes approval easier because nobody has to decode internal names',
    done_looks_like: 'The summary appears first and every original detail is still available',
  };

  try {
    const created = taskDb.addTask(db, {
      title,
      tag: 'tasks',
      workspaceRoot: root,
      metadata: { ...explicit, verify, requirements, opaque: 'leave_thisExactlyAsWritten' },
    });
    taskDb.noteTask(db, {
      id: created.id,
      actor: 'linguist',
      content: 'Keep `--raw-mode` and src/task/runtime.js available to engineers.',
    });

    const stored = taskDb.getTask(db, created.id);
    assert.equal(stored.title, title);
    assert.equal(stored.metadata.verify, verify);
    assert.deepEqual(stored.metadata.requirements, requirements);
    assert.equal(stored.metadata.opaque, 'leave_thisExactlyAsWritten');
    assert.equal(stored.metadata.what_changes, explicit.what_changes);
    assert.equal(stored.metadata.why_it_matters, explicit.why_it_matters);
    assert.equal(stored.metadata.done_looks_like, explicit.done_looks_like);

    const events = taskDb.listTaskEvents(db, { taskId: created.id, limit: 20 });
    assert.equal(events.length, 2);
    assert.deepEqual(events[0].payload.metadata.requirements, requirements);
    assert.equal(events[1].payload.content, 'Keep `--raw-mode` and src/task/runtime.js available to engineers.');

    const rawProjection = taskDb.taskProjection(db, { taskId: created.id });
    const task = rawProjection.tasks[0];
    assert.equal(task.explanation.what_changes, `${explicit.what_changes}.`);
    assert.equal(task.explanation.why_it_matters, `${explicit.why_it_matters}.`);
    assert.equal(task.explanation.done_looks_like, `${explicit.done_looks_like}.`);
    assert.equal(task.metadata.verify, verify);
    assert.deepEqual(task.metadata.requirements, requirements);
    assert.equal(task.events[0].payload.metadata.opaque, 'leave_thisExactlyAsWritten');

    const enriched = enrichTaskProjection(rawProjection).tasks[0];
    assert.equal(enriched.title, title);
    assert.equal(enriched.metadata.verify, verify);
    assert.deepEqual(enriched.metadata.requirements, requirements);
    assert.equal(enriched.approval.approve.enabled, false);
    assert.equal(enriched.approval.request_change.enabled, true);

    const cloud = taskDescriptionForCloud(enriched);
    assert.ok(cloud.indexOf('What changes:') < cloud.indexOf('Technical details:'));
    assert.ok(cloud.indexOf('Technical details:') < cloud.indexOf('Local task:'));
    assert.match(cloud, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const markdown = taskDb.renderTodoMarkdown([stored], { refRows: [stored] });
    const todoPath = path.join(root, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, markdown);
    assert.ok(markdown.indexOf('People get a clear task summary') < markdown.indexOf('Technical details:'));
    assert.match(markdown, /\*\*Approve or change:\*\* `atris task show [A-Z0-9]+-1` shows the actions allowed by the current plan and proof checks\./);
    assert.match(markdown, /\*\*Technical details:\*\* canonical_schema CLI-88 keeps --raw-mode in src\/task\/runtime\.js/);
    assert.match(markdown, new RegExp(verify.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(parseTodoFile(todoPath).backlog[0].title, title);
    assert.equal(parseTodoFile(todoPath).backlog[0].verify, verify);
  } finally {
    cleanup(root);
  }
});

// Delegate -> plan -> show through the real CLI. The plain explanation may
// drop paths, flags, and engine names for people, but the stored metadata and
// event payloads must keep every exact machine instruction byte for byte.
// Source task: 01M1X95C2K51HKNTW7CC51HKNT.
test('delegated handoff instructions survive plan exactly while the explanation stays plain', () => {
  const root = tempWorkspace();
  const dbPath = path.join(root, '.atris', 'state', 'tasks.db');
  const title = 'Route the pilot through atris/skills/engines/SKILL.md';
  const whatChanges = 'Edit atris/skills/engines/SKILL.md and lib/runner-command.js; dispatch engine=agy model=gemini-3.8-flash-high with --owner mission-lead; merge only after the queued review passes';
  const doneLooksLike = 'node --test test/task-explanation.test.js passes and the merge queue shows the branch as merged, not draft';
  const verify = 'node --test test/task-explanation.test.js';

  try {
    const delegated = runTaskCli(root, dbPath, [
      'delegate', title,
      '--to', 'mission-lead',
      '--tag', 'capture',
      '--what-changes', whatChanges,
      '--why-it-matters', 'Delegated coding needs one exact handoff',
      '--done-looks-like', doneLooksLike,
      '--verify', verify,
      '--json',
    ]);
    assert.equal(delegated.status, 0, delegated.stderr || delegated.stdout);
    const ref = JSON.parse(delegated.stdout).task.display_id;

    const planned = runTaskCli(root, dbPath, [
      'plan', ref,
      '--goal', 'Keep the exact handoff through planning',
      '--exit', 'metadata and events keep the exact strings',
      '--json',
    ]);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    assert.equal(JSON.parse(planned.stdout).plan_trace.owner_choice.owner, 'mission-lead');

    const shown = runTaskCli(root, dbPath, ['show', ref, '--json']);
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    const task = JSON.parse(shown.stdout);

    // Raw machine instructions: exact.
    assert.equal(task.title, title);
    assert.equal(task.metadata.what_changes, whatChanges);
    assert.equal(task.metadata.done_looks_like, doneLooksLike);
    assert.equal(task.metadata.verify, verify);
    assert.equal(task.metadata.proof_needed, verify);
    assert.equal(task.metadata.assigned_to, 'mission-lead');
    assert.equal(task.metadata.stage_owner, 'mission-lead');
    const created = task.events.find(event => event.event_type === 'created');
    assert.equal(created.payload.metadata.what_changes, whatChanges);
    assert.equal(created.payload.metadata.done_looks_like, doneLooksLike);
    assert.equal(created.payload.metadata.assigned_to, 'mission-lead');

    // Human explanation: plain, separate, and never the machine source.
    assert.equal(task.explanation.sources.what_changes, 'explicit');
    assert.doesNotMatch(task.explanation.what_changes, /atris\/skills\/engines\/SKILL\.md|lib\/runner-command\.js|--owner/);
    assert.match(task.explanation.what_changes, /the named file/);
    assert.doesNotMatch(task.explanation.done_looks_like, /node --test|test\/task-explanation/);
    assert.match(task.explanation.done_looks_like, /merged, not draft/);

    // The plain text view shows the plain face first and the exact record under it.
    const text = runTaskCli(root, dbPath, ['show', ref]);
    assert.equal(text.status, 0, text.stderr || text.stdout);
    assert.ok(text.stdout.indexOf('What changes:') < text.stdout.indexOf('Technical details:'));
    assert.match(text.stdout, /atris\/skills\/engines\/SKILL\.md/);
  } finally {
    cleanup(root);
  }
});

test('legacy tasks receive honest plain defaults at presentation time', () => {
  const root = tempWorkspace();
  const dbPath = path.join(root, '.atris', 'state', 'tasks.db');
  const db = taskDb.open(dbPath);
  const title = 'CLI-77 canonical_schema renderer uses --unsafe-mode in lib/raw_task.js';
  const verify = 'node --test test/legacy-task.test.js';

  try {
    const created = taskDb.addTask(db, {
      title,
      tag: 'tasks',
      workspaceRoot: root,
      metadata: {
        goal_objective: 'Operators can understand each task without learning internal names',
        verify,
        preserved_requirement: 'do_not_change_this',
      },
    });
    const stored = taskDb.getTask(db, created.id);
    const legacyMetadata = { ...stored.metadata };
    delete legacyMetadata.explanation;
    db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(legacyMetadata), created.id);

    const legacy = taskDb.getTask(db, created.id);
    const explanation = taskExplanation(legacy);
    assert.doesNotMatch(explanation.what_changes, /CLI-77|canonical_schema|--unsafe-mode/);
    assert.match(explanation.what_changes, /main data format renderer uses unsafe mode/);
    assert.equal(explanation.why_it_matters, 'Operators can understand each task without learning internal names.');
    assert.equal(explanation.done_looks_like, 'The required check passes, the proof is attached, and review clears the work.');
    assert.doesNotMatch(explanation.done_looks_like, /node --test|legacy-task/);
    assert.equal(legacy.title, title);
    assert.equal(legacy.metadata.verify, verify);
    assert.equal(legacy.metadata.preserved_requirement, 'do_not_change_this');

    const listRun = runTaskCli(root, dbPath, ['list', '--json']);
    assert.equal(listRun.status, 0, listRun.stderr);
    const listJson = JSON.parse(listRun.stdout);
    const listed = listJson.tasks.find(task => task.id === created.id);
    assert.deepEqual(listed.explanation, explanation);
    assert.equal(listed.title, title);
    assert.equal(listed.metadata.verify, verify);

    const listTextRun = runTaskCli(root, dbPath, ['list']);
    assert.equal(listTextRun.status, 0, listTextRun.stderr);
    assert.ok(listTextRun.stdout.indexOf('What changes:') < listTextRun.stdout.indexOf('Technical details:'));
    assert.match(listTextRun.stdout, /Ask for a change: atris task backlog /);

    const showRun = runTaskCli(root, dbPath, ['show', created.id]);
    assert.equal(showRun.status, 0, showRun.stderr);
    const show = showRun.stdout;
    const firstLine = show.split(/\r?\n/).find(Boolean);
    assert.match(firstLine, /^What changes:/);
    assert.ok(show.indexOf('What changes:') < show.indexOf('Technical details:'));
    assert.match(show, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    cleanup(root);
  }
});

test('landed accepted tasks stop asking for approval', () => {
  const root = tempWorkspace();
  const dbPath = path.join(root, '.atris', 'state', 'tasks.db');
  const db = taskDb.open(dbPath);

  try {
    const acceptedId = taskDb.addTask(db, {
      title: 'Ship the plain-language approval fix',
      tag: 'tasks',
      workspaceRoot: root,
      status: 'done',
      metadata: { approval_status: 'accepted' },
    }).id;
    const awaitingId = taskDb.addTask(db, {
      title: 'Finish proof before human sign-off',
      tag: 'tasks',
      workspaceRoot: root,
      status: 'done',
      metadata: { approval_status: 'pending' },
    }).id;
    const reviewId = taskDb.addTask(db, {
      title: 'Fix proof before this can clear review',
      tag: 'tasks',
      workspaceRoot: root,
      status: 'review',
      claimedBy: 'linguist',
      metadata: {
        approval_status: 'revise',
        latest_agent_proof: 'node --test test/task-explanation.test.js passed',
        verify: 'node --test test/task-explanation.test.js',
        agent_review_pass_count: 1,
        agent_certified: false,
      },
    }).id;

    const projection = enrichTaskProjection(taskDb.taskProjection(db, { workspaceRoot: root, includeHistory: true }));
    const accepted = projection.tasks.find(task => task.id === acceptedId);
    const awaiting = projection.tasks.find(task => task.id === awaitingId);
    const review = projection.tasks.find(task => task.id === reviewId);

    assert.deepEqual(approvalLines(accepted.approval), ['Landed and accepted. Nothing to do.']);
    assert.match(awaiting.approval.question, /Approve the completed work, or ask for a change\?/);
    assert.match(awaiting.approval.approve.blocked_reason, /proof still needs its required checks/);
    assert.deepEqual(approvalLines(awaiting.approval), [
      'Approve the completed work, or ask for a change?',
      'Cannot approve yet: The proof still needs its required checks before a person can approve it.',
    ]);
    assert.equal(review.approval.question, 'Approve the completed work, or ask for a change?');
    assert.equal(review.approval.approve.enabled, false);
    assert.match(review.approval.approve.blocked_reason, /proof still needs its required checks/);
    assert.equal(approvalLines(review.approval)[0], 'Approve the completed work, or ask for a change?');
    assert.equal(approvalLines(review.approval)[1], 'Cannot approve yet: The proof still needs its required checks before a person can approve it.');
    assert.match(approvalLines(review.approval)[2], /^Ask for a change: atris task revise /);

    const listRun = runTaskCli(root, dbPath, ['list', '--status', 'done']);
    assert.equal(listRun.status, 0, listRun.stderr);
    const acceptedBlock = listRun.stdout.split(/(?=What changes:)/).find(block => block.includes(acceptedId) || block.includes('Ship the plain-language approval fix'));
    assert.match(acceptedBlock, /Landed and accepted\. Nothing to do\./);
    assert.doesNotMatch(acceptedBlock, /Approve the completed work, or ask for a change\?/);
    assert.doesNotMatch(acceptedBlock, /Cannot approve yet:/);

    const showAccepted = runTaskCli(root, dbPath, ['show', acceptedId]);
    assert.equal(showAccepted.status, 0, showAccepted.stderr);
    assert.match(showAccepted.stdout, /Landed and accepted\. Nothing to do\./);
    assert.doesNotMatch(showAccepted.stdout, /Approve the completed work, or ask for a change\?/);
    assert.doesNotMatch(showAccepted.stdout, /Cannot approve yet:/);

    const showAwaiting = runTaskCli(root, dbPath, ['show', awaitingId]);
    assert.equal(showAwaiting.status, 0, showAwaiting.stderr);
    assert.match(showAwaiting.stdout, /Approve the completed work, or ask for a change\?/);
    assert.match(showAwaiting.stdout, /Cannot approve yet: The proof still needs its required checks before a person can approve it\./);
  } finally {
    cleanup(root);
  }
});

test('approve and change actions reuse existing plan and review gates', () => {
  const root = tempWorkspace();
  const dbPath = path.join(root, '.atris', 'state', 'tasks.db');
  const db = taskDb.open(dbPath);

  try {
    const planId = taskDb.addTask(db, {
      title: 'Give task proposals a clear decision',
      tag: 'plan',
      workspaceRoot: root,
      metadata: {
        stage: 'plan',
        task_goal: 'People can approve or redirect work without guessing',
        goal_objective: 'People can approve or redirect work without guessing',
        exit_condition: 'The proposed task shows approve and change actions',
        verify: 'node --test test/task-explanation.test.js',
        proof_needed: 'node --test test/task-explanation.test.js',
        first_move: 'add the shared explanation contract',
        assigned_to: 'linguist',
      },
    }).id;
    const reviewId = taskDb.addTask(db, {
      title: 'Keep unfinished proof from being approved',
      tag: 'tasks',
      workspaceRoot: root,
      status: 'review',
      claimedBy: 'linguist',
      metadata: {
        approval_status: 'pending',
        latest_agent_proof: 'node --test test/task-explanation.test.js passed',
        verify: 'node --test test/task-explanation.test.js',
        agent_review_pass_count: 1,
        agent_certified: false,
      },
    }).id;

    const projection = enrichTaskProjection(taskDb.taskProjection(db, { workspaceRoot: root, includeHistory: true }));
    const planned = projection.tasks.find(task => task.id === planId);
    const review = projection.tasks.find(task => task.id === reviewId);

    assert.equal(planned.approval.question, 'Approve this plan, or ask for a change?');
    assert.equal(planned.approval.approve.enabled, true);
    assert.match(planned.approval.approve.command, /^atris task do /);
    assert.equal(planned.approval.request_change.enabled, true);
    assert.match(planned.approval.request_change.command, /^atris task backlog /);

    assert.equal(review.approval.approve.enabled, true);
    assert.match(review.approval.approve.command, /^atris task accept /);
    assert.equal(review.approval.approve.human_only, true);
    assert.equal(review.approval.request_change.enabled, true);
    assert.match(review.approval.request_change.command, /^atris task revise /);

    const page = taskPageContract(review);
    assert.equal(page.review.human_accept.enabled, review.approval.approve.enabled);
    assert.equal(page.review.human_accept.command, review.approval.approve.command);
    assert.equal(page.review.human_accept.human_only, true);
    assert.equal(page.approval.approve.enabled, true);
    assert.equal(page.actions.revise_command.startsWith('atris task revise '), true);

    const html = taskBoardTemplate(taskBoardViewModel(projection));
    assert.match(html, /What changes/);
    assert.match(html, /Why it matters/);
    assert.match(html, /Done looks like/);
    assert.match(html, /Technical details/);
    assert.match(html, /Approval not ready/);
    assert.match(html, /approval\.approve\.enabled/);
    assert.match(html, /task\.status === 'review' \? 'revise'/);
  } finally {
    cleanup(root);
  }
});
