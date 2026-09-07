'use strict';

// The plan/do prompts that atris emits for a coding agent must point at the
// live task plane (task add/plan/claim/ready) and treat atris/TODO.md as a
// generated view. Human acceptance stays a human step.
//
// Source task: 01M1X96ZZ6CD9NENF4DJCD9NEN (generated workflow cleanup).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { executorAgentPrompt } = require('../commands/workflow');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-workflow-delegation-'));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function isolatedEnv(dir) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_NONINTERACTIVE: '1',
    ATRIS_OPERATOR: 'keshav',
    USER: 'keshav',
    ATRIS_SKIP_UPDATE_CHECK: '1',
    NODE_NO_WARNINGS: '1',
  };
}

function runCli(args, { cwd, env }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input: '',
    encoding: 'utf8',
    timeout: 60000,
    env,
  });
  if (result.error) throw result.error;
  return result;
}

function initializedWorkspace() {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  return { dir, env };
}

const STALE_TODO_INSTRUCTIONS = [
  /Write tasks to atris\/TODO\.md/,
  /claim next unclaimed Backlog task/,
  /Move to ## In Progress/,
  /move task to ## Completed/i,
  /Read tasks from TODO\.md/,
];

test('plan prompt sends tasks through the live task plane, not a hand-edited TODO', () => {
  const { dir, env } = initializedWorkspace();
  const prompted = runCli(['plan', '--prompt'], { cwd: dir, env });
  assert.equal(prompted.status, 0, prompted.stderr || prompted.stdout);
  assert.match(prompted.stdout, /You are the Navigator\./);
  assert.match(prompted.stdout, /use existing approval for this scope, otherwise wait for approval/);
  assert.match(prompted.stdout, /atris task add "<title>" --tag <tag>/);
  assert.match(prompted.stdout, /atris task plan <id> --goal/);
  assert.match(prompted.stdout, /atris task delegate "<title>" --to <member>/);
  assert.match(prompted.stdout, /plan keeps that owner unless you pass --owner/);
  assert.match(prompted.stdout, /atris\/TODO\.md is a generated view: never hand-edit it/);
  assert.match(prompted.stdout, /atris task render --out atris\/TODO\.md/);
  for (const stale of STALE_TODO_INSTRUCTIONS) assert.doesNotMatch(prompted.stdout, stale);
});

test('do prompt claims and readies work through the live task plane and leaves acceptance human', () => {
  const { dir, env } = initializedWorkspace();
  const prompted = runCli(['do', '--prompt'], { cwd: dir, env });
  assert.equal(prompted.status, 0, prompted.stderr || prompted.stdout);
  assert.match(prompted.stdout, /You are the Executor\./);
  assert.match(prompted.stdout, /Before claiming or editing, run `atris task show .* --json` for the exact current dispatched task/);
  assert.match(prompted.stdout, /Refuse a stale or mismatched task/);
  assert.match(prompted.stdout, /Read the raw metadata, requirements, events, and verify command/);
  assert.match(prompted.stdout, /The live task plane is truth; never hand-edit TODO\.md/);
  assert.match(prompted.stdout, /atris task ready <id> --proof "<commands run>"`; a human accepts/);
  assert.match(prompted.stdout, /atris task render --out atris\/TODO\.md/);
  assert.doesNotMatch(prompted.stdout, /atris task accept/);
  for (const stale of STALE_TODO_INSTRUCTIONS) assert.doesNotMatch(prompted.stdout, stale);
});

test('executor agent prompt reads live truth, claims, readies, and never edits TODO by hand', () => {
  const tasks = '## Backlog\n- **[CLI-7]** Ship the delegation fix\n';
  const prompt = executorAgentPrompt({ filteredTasks: tasks, taskSource: 'atris/TODO.md', context: 'cli' });
  assert.match(prompt, /You are the Executor\./);
  assert.match(prompt, /generated view from atris\/TODO\.md; live truth is `atris task list`/);
  assert.ok(prompt.includes(tasks), 'the task text is passed through unchanged');
  assert.match(prompt, /1\. Before claiming or editing, run `atris task show <task-id> --json`/);
  assert.match(prompt, /using its recorded functional owner and keeping the engine separate/);
  assert.match(prompt, /6\. Send it to review: `atris task ready <id> --proof "<commands run>"`; a human accepts/);
  assert.match(prompt, /Never hand-edit TODO\.md; `atris task render --out atris\/TODO\.md` regenerates it/);
  assert.match(prompt, /Confidence Gate/);
  assert.match(prompt, /Context: cli/);
  assert.doesNotMatch(prompt, /atris task accept/);
  for (const stale of STALE_TODO_INSTRUCTIONS) assert.doesNotMatch(prompt, stale);

  const empty = executorAgentPrompt({ filteredTasks: '', taskSource: 'atris/TODO.md', context: 'cli' });
  assert.match(empty, /No tasks found - run `atris task list` for the live task plane/);
  assert.doesNotMatch(empty, /check TODO\.md/);
});


test('rendered summaries cannot replace the dispatched raw task handoff', () => {
  const { renderTodoMarkdown } = require('../lib/task-db');
  const row = {
    id: '01M1X95C2K51HKNTW7CC51HKNT', display_id: 'CLI-7',
    title: 'Keep the runner precise', status: 'open', tag: 'capture',
    metadata: { assigned_to: 'mission-lead', what_changes: 'Edit lib/runner-command.js with --check' },
  };
  const rendered = renderTodoMarkdown([row]);
  assert.doesNotMatch(rendered, /mission-lead|lib\/runner-command\.js/);
  const prompt = executorAgentPrompt({ filteredTasks: rendered, taskId: row.id });
  const load = `atris task show ${row.id} --json`;
  const claim = `atris task claim ${row.id} --as <task-owner>`;
  assert.ok(prompt.includes(load));
  assert.ok(prompt.indexOf(load) < prompt.indexOf(claim));
  assert.match(prompt, /raw metadata, requirements, events, and verify command/);
  assert.match(prompt, /Check the ID, current mission, active status \(open or claimed by the same owner\), and functional owner against the dispatch/);
  assert.match(prompt, /Refuse a stale or mismatched task/);
  assert.match(prompt, /do not select another displayed row/);
  assert.doesNotMatch(prompt, /claim (?:one|the next open task)/);
});
