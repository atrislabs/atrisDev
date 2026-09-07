'use strict';

// Delegated ownership must survive planning. The plan trace, the stage owner,
// and the task assignee have to agree, and only an explicit caller
// reassignment or an existing claim may move the owner.
//
// Every case runs the real CLI against a real SQLite task db in a temp
// workspace, so the checks cover the same path operators use.
//
// Source tasks: 01M1X95C2K51HKNTW7CC51HKNT (owner/instruction fidelity),
// backend packet 01M1X8MVRS8W3PQ86SV68W3PQ8.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'atris.js');

function hasNodeSqlite() {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function makeWorkspace() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-plan-owner-')));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  return dir;
}

function writeMember(dir, slug, { role, description }) {
  const memberDir = path.join(dir, 'atris', 'team', slug);
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), [
    '---',
    `name: ${slug}`,
    `role: ${role}`,
    `description: ${description}`,
    '---',
    '',
    `# ${slug}`,
    '',
  ].join('\n'));
}

function runTask(dir, args, { agent = 'codex' } = {}) {
  return spawnSync(process.execPath, [CLI, 'task', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      ATRIS_AGENT_ID: agent,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
    },
  });
}

function json(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function showTask(dir, ref) {
  return json(runTask(dir, ['show', ref, '--json']));
}

const PLAN_FIELDS = [
  '--goal', 'Keep the delegated owner through planning',
  '--exit', 'plan trace, stage owner, and assignee name the same member',
  '--proof-needed', 'node --test test/task-plan-owner.test.js',
];

test('delegated owner survives plan without --owner', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeWorkspace();
  try {
    writeMember(dir, 'mission-lead', {
      role: 'Mission lead',
      description: 'Coordinates bounded tasks from durable state to checked proof',
    });
    writeMember(dir, 'engine-manager', {
      role: 'Engine manager',
      description: 'Keeps delegated engine planning and owner handoffs honest',
    });

    const delegated = json(runTask(dir, ['delegate', 'Keep delegated engine planning honest', '--to', 'mission-lead', '--tag', 'capture', '--json']));
    assert.equal(delegated.owner, 'mission-lead');
    const ref = delegated.task.display_id;

    const planned = json(runTask(dir, ['plan', ref, ...PLAN_FIELDS, '--json']));
    assert.equal(planned.plan_trace.owner_choice.owner, 'mission-lead', 'plan trace must keep the delegated owner');
    assert.equal(planned.plan_trace.trace.owner, 'mission-lead');
    assert.match(planned.stage_packet, /owner: mission-lead/);

    const task = showTask(dir, ref);
    assert.equal(task.metadata.assigned_to, 'mission-lead');
    assert.equal(task.metadata.stage_owner, 'mission-lead');
    assert.equal(task.metadata.assigned_to, planned.plan_trace.owner_choice.owner);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit --owner reassigns a delegated task and every surface agrees', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeWorkspace();
  try {
    writeMember(dir, 'mission-lead', { role: 'Mission lead', description: 'Coordinates bounded tasks' });
    writeMember(dir, 'architect', { role: 'Architect', description: 'Owns structure decisions' });

    const ref = json(runTask(dir, ['delegate', 'Move the structure decision', '--to', 'mission-lead', '--tag', 'capture', '--json'])).task.display_id;
    const planned = json(runTask(dir, ['plan', ref, '--owner', 'architect', ...PLAN_FIELDS, '--json']));
    assert.equal(planned.plan_trace.owner_choice.owner, 'architect');
    assert.equal(planned.plan_trace.owner_choice.source, 'requested');
    assert.match(planned.stage_packet, /owner: architect/);

    const task = showTask(dir, ref);
    assert.equal(task.metadata.stage_owner, 'architect');
    assert.equal(task.metadata.assigned_to, 'architect', 'explicit reassignment must move the assignee too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unassigned task still picks the best team member automatically', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeWorkspace();
  try {
    writeMember(dir, 'mission-lead', { role: 'Mission lead', description: 'Coordinates bounded tasks' });
    writeMember(dir, 'engine-manager', { role: 'Engine manager', description: 'Keeps engine routing and engine health honest' });

    const ref = json(runTask(dir, ['add', 'Tighten engine routing', '--tag', 'capture', '--json'])).task.display_id;
    const planned = json(runTask(dir, ['plan', ref, ...PLAN_FIELDS, '--json']));
    assert.equal(planned.plan_trace.owner_choice.owner, 'engine-manager');
    assert.equal(planned.plan_trace.owner_choice.source, 'team');

    const task = showTask(dir, ref);
    assert.equal(task.metadata.stage_owner, 'engine-manager');
    assert.equal(task.metadata.assigned_to, 'engine-manager');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claimed owner wins the plan trace and other actors are still refused', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeWorkspace();
  try {
    writeMember(dir, 'mission-lead', { role: 'Mission lead', description: 'Coordinates bounded tasks' });
    writeMember(dir, 'engine-manager', { role: 'Engine manager', description: 'Keeps engine routing honest' });

    const delegated = json(runTask(dir, ['delegate', 'Tighten engine routing', '--to', 'mission-lead', '--claim', '--tag', 'capture', '--json']));
    assert.equal(delegated.task.claimed_by, 'mission-lead');
    const ref = delegated.task.display_id;

    const otherActor = runTask(dir, ['plan', ref, '--as', 'codex', ...PLAN_FIELDS, '--json']);
    assert.equal(otherActor.status, 1, 'another actor must not plan a claimed task');
    assert.equal(JSON.parse(otherActor.stdout).reason, 'claimed_by_other');

    const otherOwner = runTask(dir, ['plan', ref, '--as', 'mission-lead', '--owner', 'engine-manager', ...PLAN_FIELDS, '--json']);
    assert.equal(otherOwner.status, 1, 'a claimed task cannot be handed to another owner by plan');
    assert.equal(JSON.parse(otherOwner.stdout).reason, 'claimed_by_other');

    const planned = json(runTask(dir, ['plan', ref, '--as', 'mission-lead', ...PLAN_FIELDS, '--json'], { agent: 'mission-lead' }));
    assert.equal(planned.plan_trace.owner_choice.owner, 'mission-lead');
    assert.match(planned.stage_packet, /owner: mission-lead/);

    const task = showTask(dir, ref);
    assert.equal(task.claimed_by, 'mission-lead');
    assert.equal(task.metadata.stage_owner, 'mission-lead');
    assert.equal(task.metadata.assigned_to, 'mission-lead');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
