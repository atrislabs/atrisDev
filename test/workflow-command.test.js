'use strict';

// Behavior tests for commands/workflow.js — the plan/do/review workflow engine.
//
// Note on scope: commands/workflow.js is not a workflow-definition parser; it is
// the plan -> do -> review command trio plus the cloud tool-relay helpers
// (makeCloudExecutor, postToolResult). Coverage here follows what the file
// actually does:
//   - missing-setup errors are plain sentences, not stack traces
//   - plan/do/review prompt-mode output shapes on a real initialized workspace
//   - workspace state feeding behavior (inbox uncertainty, MAP placeholder,
//     feature build plans, journal completions -> handoff hint)
//   - flag handling (--full, --help)
//   - cloud executor request translation + failure handling (a failing relayed
//     command surfaces status error with the reason, never a throw)
//   - postToolResult wire shape and non-200 rejection
// Every CLI spawn runs in its own temp cwd.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { spokenLineCount } = require('../lib/first-minute');
const { renderReviewMinute } = require('../commands/workflow');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-workflow-test-'));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args, { cwd, input, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input: input === undefined ? '' : input,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function nextLine(stdout) {
  const match = String(stdout || '').match(/^next: (.+)$/m);
  return match ? match[1] : '';
}

function spokenDoBody(stdout) {
  return String(stdout || '').replace(/^(PROMPT ONLY|ACTION TAKEN)\s*/m, '');
}

function writeClaimedWorkspace(dir, task = {
  id: 'task-1',
  display_id: 'CLI-9',
  title: 'Ship the landing page',
  status: 'claimed',
  claimed_by: 'keshav',
  updated_at: 20,
}) {
  fs.mkdirSync(path.join(dir, 'atris', 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO.md\n\n## Backlog\n\n(Empty)\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'PERSONA.md'), '# PERSONA\n\nTalk like a person.\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks: [task],
  }, null, 2), 'utf8');
}

function isolatedDoEnv(dir) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    HOME: home,
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_NONINTERACTIVE: '1',
    ATRIS_OPERATOR: 'keshav',
    USER: 'keshav',
    NODE_NO_WARNINGS: '1',
  };
}

// One initialized workspace, built once; tests clone it so mutations stay isolated.
let goldenDir = null;
function initializedWorkspace() {
  if (!goldenDir) {
    goldenDir = makeTempDir();
    const res = runCli(['init', '--yes'], { cwd: goldenDir, input: '\n' });
    assert.equal(res.status, 0, `init failed: ${res.stderr}\n${res.stdout}`);
  }
  const clone = makeTempDir();
  fs.cpSync(goldenDir, clone, { recursive: true });
  return clone;
}

function todayLogFile(dir) {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const yearDir = path.join(dir, 'atris', 'logs', year);
  fs.mkdirSync(yearDir, { recursive: true });
  return path.join(yearDir, `${year}-${month}-${day}.md`);
}

test('plan in an uninitialized folder talks like first-minute', () => {
  const dir = makeTempDir();
  const env = isolatedDoEnv(dir);
  const minute = runCli([], { cwd: dir, env });
  const planned = runCli(['plan'], { cwd: dir, env });
  assert.equal(minute.status, 0, minute.stderr || minute.stdout);
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);
  assert.match(planned.stdout, /this folder is empty/);
  assert.match(planned.stdout, /^next: atris "what do you want here\?"$/m);
  assert.equal(nextLine(planned.stdout), nextLine(minute.stdout));
  assert.equal(planned.stdout.trim(), minute.stdout.trim());
  assert.equal(spokenLineCount(spokenDoBody(planned.stdout)), 2);
  assert.doesNotMatch(planned.stdout, /navigator\.md|Run "atris init"/);
  assert.doesNotMatch(planned.stdout, /PROMPT ONLY|Atris Plan|What do you want to build/);
  const combined = planned.stdout + planned.stderr;
  assert.ok(!/at .*workflow\.js:\d+/.test(combined), `stack trace leaked:\n${combined}`);
  assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

  const jsonMinute = runCli(['--json'], { cwd: dir, env });
  const jsonPlan = runCli(['plan', '--json'], { cwd: dir, env });
  assert.equal(jsonPlan.status, jsonMinute.status);
  assert.deepEqual(JSON.parse(jsonPlan.stdout), JSON.parse(jsonMinute.stdout));
  assert.doesNotMatch(jsonPlan.stdout, /navigator\.md/);

  const help = runCli(['plan', '--help'], { cwd: dir, env });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /Usage: atris plan/);
  assert.match(help.stdout, /--prompt/);
  assert.doesNotMatch(help.stdout, /clean start|navigator\.md/);
  assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
});

test('review in an uninitialized folder talks like first-minute', () => {
  const dir = makeTempDir();
  const env = isolatedDoEnv(dir);
  const minute = runCli([], { cwd: dir, env });
  const review = runCli(['review'], { cwd: dir, env });
  assert.equal(minute.status, 0, minute.stderr || minute.stdout);
  assert.equal(review.status, 0, review.stderr || review.stdout);
  assert.match(review.stdout, /this folder is empty/);
  assert.match(review.stdout, /^next: atris "what do you want here\?"$/m);
  assert.equal(nextLine(review.stdout), nextLine(minute.stdout));
  assert.equal(review.stdout.trim(), minute.stdout.trim());
  assert.equal(spokenLineCount(review.stdout), 2);
  assert.doesNotMatch(review.stdout, /^nothing is waiting on you\.$/m);
  assert.notEqual(review.stdout.trim(), 'nothing is waiting on you.');
  assert.doesNotMatch(review.stdout, /validator\.md|Run "atris init"/);
  assert.doesNotMatch(review.stdout, /PROMPT ONLY|Atris Review|Need the legacy Validator/);
  const combined = review.stdout + review.stderr;
  assert.ok(!/at .*workflow\.js:\d+/.test(combined), `stack trace leaked:\n${combined}`);
  assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

  const jsonMinute = runCli(['--json'], { cwd: dir, env });
  const jsonReview = runCli(['review', '--json'], { cwd: dir, env });
  assert.equal(jsonReview.status, jsonMinute.status);
  assert.deepEqual(JSON.parse(jsonReview.stdout), JSON.parse(jsonMinute.stdout));
  assert.doesNotMatch(jsonReview.stdout, /review_queue|validator\.md/);

  const help = runCli(['review', '--help'], { cwd: dir, env });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /Usage: atris review/);
  assert.doesNotMatch(help.stdout, /clean start|nothing is waiting on you|validator\.md/);
  assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

  const verbose = runCli(['review', '--verbose'], { cwd: dir, env });
  assert.equal(verbose.status, 0, verbose.stderr || verbose.stdout);
  assert.equal(verbose.stdout.trim(), minute.stdout.trim());
  assert.doesNotMatch(verbose.stdout + verbose.stderr, /validator\.md not found|Run "atris init"/);
  assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
});

test('do in an uninitialized folder talks like first-minute', () => {
  const dir = makeTempDir();
  const env = isolatedDoEnv(dir);
  const minute = runCli([], { cwd: dir, env });
  const doit = runCli(['do'], { cwd: dir, env });
  assert.equal(minute.status, 0, minute.stderr || minute.stdout);
  assert.equal(doit.status, 0, doit.stderr || doit.stdout);
  assert.match(doit.stdout, /this folder is empty/);
  assert.match(doit.stdout, /^next: atris "what do you want here\?"$/m);
  assert.equal(nextLine(doit.stdout), nextLine(minute.stdout));
  assert.equal(doit.stdout.trim(), minute.stdout.trim());
  assert.equal(spokenLineCount(spokenDoBody(doit.stdout)), 2);
  assert.doesNotMatch(doit.stdout, /executor\.md|Run "atris init"/);
  assert.doesNotMatch(doit.stdout, /PROMPT ONLY|Atris Do|What do you want to build/);
  const combined = doit.stdout + doit.stderr;
  assert.ok(!/at .*workflow\.js:\d+/.test(combined), `stack trace leaked:\n${combined}`);
  assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

  const jsonMinute = runCli(['--json'], { cwd: dir, env });
  const jsonDo = runCli(['do', '--json'], { cwd: dir, env });
  assert.equal(jsonDo.status, jsonMinute.status);
  assert.deepEqual(JSON.parse(jsonDo.stdout), JSON.parse(jsonMinute.stdout));
  assert.doesNotMatch(jsonDo.stdout, /executor\.md/);

  const help = runCli(['do', '--help'], { cwd: dir, env });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /Usage: atris do/);
  assert.match(help.stdout, /--prompt/);
  assert.doesNotMatch(help.stdout, /clean start|executor\.md/);
  assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
});

test('plan after init --yes --minimal does not send you back to init', () => {
  const dir = makeTempDir();
  const env = isolatedDoEnv(dir);
  const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));
  assert.ok(fs.existsSync(path.join(dir, 'atris', 'atris.md')));
  assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', 'navigator', 'MEMBER.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', 'navigator.md')), false);

  const minute = runCli([], { cwd: dir, env });
  const res = runCli(['plan'], { cwd: dir, env });
  const combined = res.stdout + res.stderr;
  assert.equal(minute.status, 0, minute.stderr || minute.stdout);
  assert.equal(res.status, 0, combined);
  assert.equal(res.stdout.trim(), minute.stdout.trim());
  assert.equal(spokenLineCount(spokenDoBody(res.stdout)), 2);
  assert.match(res.stdout, /^next: /m);
  assert.doesNotMatch(res.stdout, /PROMPT ONLY/);
  assert.doesNotMatch(res.stdout, /Atris Plan - Navigator Agent Activated/);
  assert.doesNotMatch(res.stdout, /Navigator spec: atris\/team\/navigator\/MEMBER\.md \(missing\)/);
  assert.doesNotMatch(combined, /navigator\.md not found|Run "atris init"/);
  assert.doesNotMatch(combined, /What do you want to build|Describe the desired outcome/);

  const prompted = runCli(['plan', '--prompt'], { cwd: dir, env });
  assert.equal(prompted.status, 0, prompted.stderr || prompted.stdout);
  assert.match(prompted.stdout, /^PROMPT ONLY/m);
  assert.match(prompted.stdout, /You are the Navigator\./);
  assert.match(prompted.stdout, /COPY\/PASTE PROMPT FOR YOUR CODING AGENT:/);

  const verbose = runCli(['plan', '--verbose'], { cwd: dir, env });
  assert.equal(verbose.status, 0, verbose.stderr || verbose.stdout);
  assert.match(verbose.stdout, /You are the Navigator\./);
  assert.match(verbose.stdout, /Navigator spec: atris\/team\/navigator\/MEMBER\.md \(missing\)/);

  const asked = runCli(['plan', 'ship', 'the', 'landing', 'page'], { cwd: dir, env });
  assert.equal(asked.status, 0, asked.stderr || asked.stdout);
  assert.match(asked.stdout, /DIRECT REQUEST/);
  assert.match(asked.stdout, /ship the landing page/);
  assert.doesNotMatch(asked.stdout + asked.stderr, /navigator\.md not found|Run "atris init"/);
});

test('do after init --yes --minimal does not send you back to init', () => {
  const dir = makeTempDir();
  const env = isolatedDoEnv(dir);
  const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));
  assert.ok(fs.existsSync(path.join(dir, 'atris', 'atris.md')));
  assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', 'executor', 'MEMBER.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', 'executor.md')), false);

  const minute = runCli([], { cwd: dir, env });
  const res = runCli(['do'], { cwd: dir, env });
  const combined = res.stdout + res.stderr;
  assert.equal(minute.status, 0, minute.stderr || minute.stdout);
  assert.equal(res.status, 0, combined);
  assert.equal(res.stdout.trim(), minute.stdout.trim());
  assert.equal(spokenLineCount(spokenDoBody(res.stdout)), 2);
  assert.match(res.stdout, /^next: /m);
  assert.doesNotMatch(res.stdout, /PROMPT ONLY/);
  assert.doesNotMatch(res.stdout, /Atris Do - Executor Agent Activated/);
  assert.doesNotMatch(res.stdout, /Context: UNKNOWN/);
  assert.doesNotMatch(res.stdout, /COPY\/PASTE PROMPT|You are the Executor\./);
  assert.doesNotMatch(res.stdout, /Executor spec: atris\/team\/executor\/MEMBER\.md \(missing\)/);
  assert.doesNotMatch(combined, /executor\.md not found|Run "atris init"/);
  assert.doesNotMatch(combined, /What do you want to build|Describe the desired outcome/);

  const prompted = runCli(['do', '--prompt'], { cwd: dir, env });
  assert.equal(prompted.status, 0, prompted.stderr || prompted.stdout);
  assert.match(prompted.stdout, /^PROMPT ONLY/m);
  assert.match(prompted.stdout, /You are the Executor\./);
  assert.match(prompted.stdout, /COPY\/PASTE PROMPT FOR YOUR CODING AGENT:/);

  const verbose = runCli(['do', '--verbose'], { cwd: dir, env });
  assert.equal(verbose.status, 0, verbose.stderr || verbose.stdout);
  assert.match(verbose.stdout, /You are the Executor\./);
  assert.match(verbose.stdout, /Executor spec: atris\/team\/executor\/MEMBER\.md \(missing\)/);
});

test('review after init --yes --minimal does not send you back to init', () => {
  const dir = makeTempDir();
  const env = isolatedDoEnv(dir);
  const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));
  assert.ok(fs.existsSync(path.join(dir, 'atris', 'atris.md')));

  const minute = runCli([], { cwd: dir, env });
  const review = runCli(['review'], { cwd: dir, env });
  const combined = review.stdout + review.stderr;
  assert.equal(minute.status, 0, minute.stderr || minute.stdout);
  assert.equal(review.status, 0, combined);
  assert.equal(review.stdout.trim(), minute.stdout.trim());
  assert.match(review.stdout, /ready to claim/);
  assert.match(nextLine(review.stdout), /^atris task claim \S+ --as \S+$/);
  assert.equal(nextLine(review.stdout), nextLine(minute.stdout));
  assert.equal(spokenLineCount(review.stdout), spokenLineCount(minute.stdout));
  assert.equal(spokenLineCount(review.stdout), 2);
  assert.doesNotMatch(review.stdout, /^nothing is waiting on you\.$/m);
  assert.doesNotMatch(combined, /clean start|atris init --minimal/);
  assert.doesNotMatch(combined, /validator\.md not found|Run "atris init"/);
  assert.doesNotMatch(review.stdout, /Atris Review is the human checkpoint|Need the legacy Validator/);

  const jsonReview = runCli(['review', '--json'], { cwd: dir, env });
  assert.equal(jsonReview.status, 0, jsonReview.stderr || jsonReview.stdout);
  const payload = JSON.parse(jsonReview.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'review_queue');
  assert.ok(payload.queue);
  assert.doesNotMatch(jsonReview.stdout, /this workspace is not initialized|atris init --minimal/);

  const verbose = runCli(['review', '--verbose'], { cwd: dir, env });
  const verboseCombined = verbose.stdout + verbose.stderr;
  assert.equal(verbose.status, 0, verboseCombined);
  assert.doesNotMatch(verboseCombined, /validator\.md not found|Run "atris init"/);
  assert.doesNotMatch(verboseCombined, /clean start|atris init --minimal/);
  assert.match(verbose.stdout, /You are the Validator\./);
  assert.match(verbose.stdout, /Validator spec: atris\/team\/validator\/MEMBER\.md \(missing\)/);
});

test('plan on an initialized workspace prints the navigator prompt shape', () => {
  const dir = initializedWorkspace();
  const minute = runCli([], { cwd: dir });
  const brief = runCli(['plan'], { cwd: dir });
  assert.equal(brief.status, 0, brief.stderr);
  assert.equal(brief.stdout.trim(), minute.stdout.trim());
  assert.match(brief.stdout, /^next: /m);
  assert.doesNotMatch(brief.stdout, /PROMPT ONLY/);
  assert.doesNotMatch(brief.stdout, /Atris Plan - Navigator Agent Activated/);
  assert.doesNotMatch(brief.stdout, /COPY\/PASTE PROMPT|You are the Navigator\./);

  const res = runCli(['plan', '--verbose'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Atris Plan - Navigator Agent Activated/);
  assert.match(res.stdout, /CONTEXT FILES \(agent should read\):/);
  assert.match(res.stdout, /COPY\/PASTE PROMPT FOR YOUR CODING AGENT:/);
  assert.match(res.stdout, /You are the Navigator\./);
  // Step sequence: visualize -> confidence gate -> tasks -> log -> stop.
  assert.match(res.stdout, /1\) ASCII visualize; use existing approval for this scope, otherwise wait for approval/);
  assert.match(res.stdout, /Confidence Gate/);
  assert.match(res.stdout, /3\) Create each task in the live task plane: `atris task add "<title>" --tag <tag>`/);
  assert.match(res.stdout, /atris\/TODO\.md is a generated view: never hand-edit it/);
  assert.doesNotMatch(res.stdout, /Write tasks to atris\/TODO\.md/);
  assert.match(res.stdout, /5\) Stop\. Do NOT execute/);
  assert.match(res.stdout, /Inbox items: \d+/);
});

test('plan reads inbox state: uncertainty in the journal triggers the brainstorm suggestion', () => {
  const dir = initializedWorkspace();
  fs.writeFileSync(
    todayLogFile(dir),
    '# Journal\n\n## Inbox\n- not sure if we should rewrite the parser\n- maybe split the module\n\n## Notes\n'
  );
  const res = runCli(['plan', '--verbose'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /atris brainstorm/);
  assert.match(res.stdout, /Inbox items: 2/);
});

test('plan flags a placeholder MAP.md so agents generate it before writing tasks', () => {
  const dir = initializedWorkspace();
  fs.writeFileSync(
    path.join(dir, 'atris', 'MAP.md'),
    '# MAP\n\nGenerated by your AI agent after reading atris.md\n'
  );
  const res = runCli(['plan', '--verbose'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /placeholder, generate first/);
  assert.match(res.stdout, /missing or placeholder, generate it/);
});

test('plan --full dumps the actual navigator spec content', () => {
  const dir = initializedWorkspace();
  const marker = 'WORKFLOW-TEST-NAVIGATOR-MARKER-9271';
  const navigatorFile = fs.existsSync(path.join(dir, 'atris', 'team', 'navigator', 'MEMBER.md'))
    ? path.join(dir, 'atris', 'team', 'navigator', 'MEMBER.md')
    : path.join(dir, 'atris', 'team', 'navigator.md');
  fs.appendFileSync(navigatorFile, `\n${marker}\n`);

  const brief = runCli(['plan'], { cwd: dir });
  assert.equal(brief.status, 0, brief.stderr);
  assert.ok(!brief.stdout.includes(marker), 'default plan should not dump the full spec');

  const full = runCli(['plan', '--full'], { cwd: dir });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /NAVIGATOR SPEC \(full\):/);
  assert.ok(full.stdout.includes(marker), '--full should include the spec content');
});

test('do prints the first-minute head; executor paste stays on --verbose', () => {
  const dir = initializedWorkspace();
  const featureDir = path.join(dir, 'atris', 'features', 'sample-feature');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'build.md'), '# build plan\n');

  const minute = runCli([], { cwd: dir });
  const res = runCli(['do'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), minute.stdout.trim());
  assert.match(res.stdout, /^next: /m);
  assert.doesNotMatch(res.stdout, /PROMPT ONLY/);
  assert.doesNotMatch(res.stdout, /Atris Do - Executor Agent Activated/);
  assert.doesNotMatch(res.stdout, /Context: UNKNOWN/);
  assert.doesNotMatch(res.stdout, /COPY\/PASTE PROMPT|You are the Executor\./);
  assert.doesNotMatch(res.stdout, /claim next unclaimed Backlog task/);
  assert.doesNotMatch(res.stdout, /Do NOT plan — just execute/);
  assert.doesNotMatch(res.stdout, /Feature build plans found/);

  const full = runCli(['do', '--full'], { cwd: dir });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /COPY\/PASTE PROMPT FOR YOUR CODING AGENT:/);
  assert.match(full.stdout, /You are the Executor\./);
  assert.match(full.stdout, /Feature build plans found: 1/);
  assert.match(full.stdout, /sample-feature[\/\\]build\.md/);
});

test('plan names a claimed task the same way first-minute does', () => {
  const dir = makeTempDir();
  writeClaimedWorkspace(dir);
  const env = isolatedDoEnv(dir);

  const minute = runCli([], { cwd: dir, env });
  const plan = runCli(['plan'], { cwd: dir, env });
  assert.equal(minute.status, 0, minute.stderr || minute.stdout);
  assert.equal(plan.status, 0, plan.stderr || plan.stdout);
  assert.equal(plan.stdout.trim(), minute.stdout.trim());
  assert.match(plan.stdout, /"ship the landing page" is already yours\./);
  assert.equal(nextLine(plan.stdout), nextLine(minute.stdout));
  assert.equal(nextLine(plan.stdout), 'atris task ready CLI-9 --verify "git diff --check"');
  assert.doesNotMatch(plan.stdout, /PROMPT ONLY/);
  assert.doesNotMatch(plan.stdout, /Atris Plan - Navigator Agent Activated/);
  assert.doesNotMatch(plan.stdout, /CONTEXT FILES \(agent should read\)/);
  assert.doesNotMatch(plan.stdout, /COPY\/PASTE PROMPT|You are the Navigator\./);
  assert.doesNotMatch(plan.stdout, /navigator\.md not found|Run "atris init"/);
  assert.doesNotMatch(plan.stdout, /What do you want to build|Describe the desired outcome/);

  const verbose = runCli(['plan', '--verbose'], { cwd: dir, env });
  assert.equal(verbose.status, 0, verbose.stderr || verbose.stdout);
  assert.match(verbose.stdout, /"ship the landing page" is already yours\./);
  assert.equal(nextLine(verbose.stdout), 'atris task ready CLI-9 --verify "git diff --check"');
  assert.match(verbose.stdout, /CONTEXT FILES \(agent should read\)/);
  assert.match(verbose.stdout, /COPY\/PASTE PROMPT FOR YOUR CODING AGENT:/);
  assert.match(verbose.stdout, /You are the Navigator\./);
});

test('do names a claimed task the same way first-minute does', () => {
  const dir = makeTempDir();
  writeClaimedWorkspace(dir);
  const env = isolatedDoEnv(dir);

  const minute = runCli([], { cwd: dir, env });
  const doit = runCli(['do'], { cwd: dir, env });
  assert.equal(minute.status, 0, minute.stderr || minute.stdout);
  assert.equal(doit.status, 0, doit.stderr || doit.stdout);
  assert.equal(doit.stdout.trim(), minute.stdout.trim());
  assert.match(doit.stdout, /"ship the landing page" is already yours\./);
  assert.equal(nextLine(doit.stdout), nextLine(minute.stdout));
  assert.equal(nextLine(doit.stdout), 'atris task ready CLI-9 --verify "git diff --check"');
  assert.equal(spokenLineCount(spokenDoBody(doit.stdout)), 2);
  assert.doesNotMatch(doit.stdout, /PROMPT ONLY/);
  assert.doesNotMatch(doit.stdout, /Atris Do - Executor Agent Activated/);
  assert.doesNotMatch(doit.stdout, /Context: UNKNOWN/);
  assert.doesNotMatch(doit.stdout, /Backlog tasks: 0/);
  assert.doesNotMatch(doit.stdout, /CONTEXT FILES \(agent should read\)/);
  assert.doesNotMatch(doit.stdout, /COPY\/PASTE PROMPT|You are the Executor\./);
  assert.doesNotMatch(doit.stdout, /What do you want to build|Describe the desired outcome/);

  const verbose = runCli(['do', '--verbose'], { cwd: dir, env });
  assert.equal(verbose.status, 0, verbose.stderr || verbose.stdout);
  assert.match(verbose.stdout, /"ship the landing page" is already yours\./);
  assert.equal(nextLine(verbose.stdout), 'atris task ready CLI-9 --verify "git diff --check"');
  assert.doesNotMatch(verbose.stdout, /Context: UNKNOWN/);
  assert.doesNotMatch(verbose.stdout, /Backlog tasks: 0/);
  assert.match(verbose.stdout, /CONTEXT FILES \(agent should read\)/);
  assert.match(verbose.stdout, /COPY\/PASTE PROMPT FOR YOUR CODING AGENT:/);
  assert.match(verbose.stdout, /You are the Executor\./);
});

test('review talks like first-minute when a certified task is waiting', () => {
  const dir = makeTempDir();
  writeClaimedWorkspace(dir, {
    id: 'task-2',
    display_id: 'UNW-2',
    title: 'Print a human line like 4 words so the count is easy to read.',
    status: 'review',
    updated_at: 20,
    review: { agent_certified: true, agent_review_pass_count: 2 },
  });
  const env = isolatedDoEnv(dir);

  const minute = runCli([], { cwd: dir, env });
  const review = runCli(['review'], { cwd: dir, env });
  assert.equal(minute.status, 0, minute.stderr || minute.stdout);
  assert.equal(review.status, 0, review.stderr || review.stdout);
  assert.match(review.stdout, /"print a human line like" is waiting for your ok\./);
  assert.equal(nextLine(review.stdout), 'atris task accept UNW-2');
  assert.equal(nextLine(review.stdout), nextLine(minute.stdout));
  assert.ok(spokenLineCount(review.stdout) >= 2 && spokenLineCount(review.stdout) <= 4);
  assert.doesNotMatch(review.stdout, /Atris Review is the human checkpoint/);
  assert.doesNotMatch(review.stdout, /Need the legacy Validator prompt/);
  assert.doesNotMatch(review.stdout, /needs you|say yes:/);
  assert.doesNotMatch(review.stdout, /any learnings\?/);
  assert.doesNotMatch(review.stdout, /┌|└|│|Validator Agent Activated/);
});

test('review keeps uncertified work still being checked, not needs-you', () => {
  const dir = makeTempDir();
  writeClaimedWorkspace(dir, {
    id: 'task-3',
    display_id: 'UNW-3',
    title: 'Second check still open',
    status: 'review',
    updated_at: 30,
    review: { agent_review_pass_count: 1 },
  });
  const env = isolatedDoEnv(dir);
  const review = runCli(['review'], { cwd: dir, env });
  assert.equal(review.status, 0, review.stderr || review.stdout);
  assert.match(review.stdout, /"second check still open" is still being checked\./);
  assert.doesNotMatch(review.stdout, /waiting for your ok|needs you|atris task accept/);
  assert.doesNotMatch(review.stdout, /Atris Review is the human checkpoint/);
  assert.ok(spokenLineCount(review.stdout) <= 4);
});

test('review --json still emits the certified queue', () => {
  const dir = makeTempDir();
  writeClaimedWorkspace(dir, {
    id: 'task-2',
    display_id: 'UNW-2',
    title: 'Print a human line like 4 words so the count is easy to read.',
    status: 'review',
    updated_at: 20,
    review: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      proof: 'context '.repeat(35) + 'Verifiers: node --test test/workflow-command.test.js passed',
    },
  });
  const env = isolatedDoEnv(dir);
  const res = runCli(['review', '--json'], { cwd: dir, env });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'review_queue');
  assert.ok(payload.queue);
});

test('review headless never prompts', () => {
  const dir = initializedWorkspace();
  const env = isolatedDoEnv(dir);
  const review = runCli(['review'], { cwd: dir, env, input: '' });
  assert.equal(review.status, 0, review.stderr || review.stdout);
  assert.doesNotMatch(review.stdout + review.stderr, /any learnings\?/);
  const verbose = runCli(['review', '--verbose'], { cwd: dir, env, input: '' });
  assert.equal(verbose.status, 0, verbose.stderr || verbose.stdout);
  assert.doesNotMatch(verbose.stdout + verbose.stderr, /any learnings\?/);
});

test('renderReviewMinute leads with certified accept and keeps uncertified checking', () => {
  const text = renderReviewMinute({
    person: 'keshav',
    tasks: [
      {
        title: 'Print a human line like 4 words so the count is easy to read.',
        status: 'review',
        display_id: 'UNW-2',
        updated_at: 20,
        review: { agent_certified: true, agent_review_pass_count: 2 },
      },
      {
        title: 'Second check still open',
        status: 'review',
        display_id: 'UNW-3',
        updated_at: 30,
        review: { agent_review_pass_count: 1 },
      },
    ],
  });
  assert.match(text, /hey keshav, "print a human line like" is waiting for your ok\./);
  assert.match(text, /1 still being checked\./);
  assert.match(text, /^next: atris task accept UNW-2$/m);
  assert.doesNotMatch(text, /needs you|ready to look at|human checkpoint/);
  assert.equal(spokenLineCount(text), 3);
});

test('renderReviewMinute names an open claim the same way first-minute does', () => {
  const text = renderReviewMinute({
    person: 'keshav',
    tasks: [{
      title: 'Generate MAP.md scan codebase',
      status: 'open',
      display_id: 'LYG-1',
      updated_at: 20,
    }],
  });
  assert.match(text, /hey keshav, "generate map.md scan codebase" is ready to claim\./);
  assert.match(text, /^next: atris task claim LYG-1 --as keshav$/m);
  assert.doesNotMatch(text, /nothing is waiting on you/);
  assert.equal(spokenLineCount(text), 2);
});

test('renderReviewMinute names a claimed ready next instead of an empty desk', () => {
  const text = renderReviewMinute({
    person: 'keshav',
    tasks: [{
      title: 'Ship the landing page',
      status: 'claimed',
      display_id: 'CLI-9',
      claimed_by: 'keshav',
      updated_at: 20,
    }],
  });
  assert.match(text, /hey keshav, "ship the landing page" is already yours\./);
  assert.match(text, /^next: atris task ready CLI-9 --verify "git diff --check"$/m);
  assert.doesNotMatch(text, /nothing is waiting on you/);
  assert.equal(spokenLineCount(text), 2);
});

test('renderReviewMinute empty queue is one spoken line', () => {
  const text = renderReviewMinute({ person: 'keshav', tasks: [] });
  assert.equal(text, 'nothing is waiting on you.');
  assert.equal(spokenLineCount(text), 1);
});

test('review --verbose keeps the old validator explainer', () => {
  const dir = initializedWorkspace();
  fs.writeFileSync(
    todayLogFile(dir),
    '# Journal\n\n## Completed ✅\n- **C1:** shipped the fixture\n\n## Notes\n'
  );
  const res = runCli(['review', '--verbose'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Atris Review - Validator Agent Activated/);
  assert.match(res.stdout, /You are the Validator\./);
  assert.match(res.stdout, /Run the project test suite/);
  assert.match(res.stdout, /atris task render --out atris\/TODO\.md/);
  // Journal has completions but no handoff yet -> handoff nudge.
  assert.match(res.stdout, /SESSION HANDOFF/);
});

test('help smokes: plan --help exits clean and top-level help lists the workflow trio', () => {
  const dir = makeTempDir();
  const planHelp = runCli(['plan', '--help'], { cwd: dir });
  assert.equal(planHelp.status, 0, planHelp.stderr);
  assert.match(planHelp.stdout, /plan/i);
  assert.match(planHelp.stdout, /--prompt/);
  const doHelp = runCli(['do', '--help'], { cwd: dir });
  assert.equal(doHelp.status, 0, doHelp.stderr);
  assert.match(doHelp.stdout, /--prompt/);

  const help = runCli(['help'], { cwd: dir });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /already won\. one next step/);
  assert.match(help.stdout, /atris do\b/);

  const allHelp = runCli(['help', '--all'], { cwd: dir });
  assert.equal(allHelp.status, 0, allHelp.stderr);
  assert.match(allHelp.stdout, /plan\s+- /);
  assert.match(allHelp.stdout, /do\s+- /);
  assert.match(allHelp.stdout, /review\s+- /);
});

// ---- cloud relay helpers (in-process unit tests) ----

function stubTerminal(impl) {
  const terminalPath = require.resolve('../commands/terminal');
  const previous = require.cache[terminalPath];
  require.cache[terminalPath] = {
    id: terminalPath,
    filename: terminalPath,
    loaded: true,
    exports: { runTerminalCommand: impl },
  };
  return () => {
    if (previous) require.cache[terminalPath] = previous;
    else delete require.cache[terminalPath];
  };
}

test('cloud executor rejects unsupported tools and path traversal without throwing', async () => {
  const calls = [];
  const restore = stubTerminal(async (...args) => {
    calls.push(args);
    return { ok: true, data: { stdout: '', stderr: '', exit_code: 0 } };
  });
  try {
    const { makeCloudExecutor } = require('../commands/workflow');
    const exec = makeCloudExecutor({ token: 't', businessId: 'b', workspaceId: 'w', slug: 'acme' });

    const wrongTool = await exec('some_other_tool', { type: 'read', path: 'a.txt' });
    assert.equal(wrongTool.status, 'error');
    assert.match(wrongTool.error, /unsupported relayed tool/);

    const traversal = await exec('local_file_op', { type: 'read', path: '../secrets' });
    assert.equal(traversal.status, 'error');
    assert.match(traversal.error, /unsupported op or unsafe path/);

    const unknownOp = await exec('local_file_op', { type: 'teleport', path: 'a.txt' });
    assert.equal(unknownOp.status, 'error');

    assert.equal(calls.length, 0, 'refused ops must never reach the cloud terminal');
  } finally {
    restore();
  }
});

test('cloud executor translates a write into base64-safe shell and maps results by op', async () => {
  const commands = [];
  let nextResult = { ok: true, data: { stdout: 'file body', stderr: '', exit_code: 0 } };
  const restore = stubTerminal(async (token, businessId, workspaceId, command) => {
    commands.push(command);
    return nextResult;
  });
  try {
    const { makeCloudExecutor } = require('../commands/workflow');
    const exec = makeCloudExecutor({ token: 't', businessId: 'b', workspaceId: 'w', slug: 'acme' });

    const content = "it's got 'quotes' and\nnewlines";
    const write = await exec('local_file_op', { type: 'write', path: 'notes.md', content });
    assert.deepEqual(write, { status: 'ok', path: 'notes.md' });
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    assert.ok(commands[0].includes(b64), 'content must travel base64, not raw shell text');
    assert.match(commands[0], /base64 -d > 'notes\.md'/);

    const read = await exec('local_file_op', { type: 'read', path: 'notes.md' });
    assert.equal(read.status, 'ok');
    assert.equal(read.content, 'file body');
  } finally {
    restore();
  }
});

test('cloud executor failure handling: nonzero exit halts with the reason recorded', async () => {
  const restore = stubTerminal(async () => ({
    ok: true,
    data: { stdout: '', stderr: 'grep: bad pattern', exit_code: 2 },
  }));
  try {
    const { makeCloudExecutor } = require('../commands/workflow');
    const exec = makeCloudExecutor({ token: 't', businessId: 'b', workspaceId: 'w', slug: 'acme' });
    const result = await exec('local_file_op', { type: 'bash', command: 'grep [ file' });
    assert.equal(result.status, 'error');
    assert.equal(result.exit_code, 2);
    assert.match(result.error, /bad pattern/);
  } finally {
    restore();
  }
});

test('postToolResult posts the base64 tool-result body and rejects on non-200', async () => {
  process.env.ATRIS_TOOL_RESULT_B64 = '1';
  const { postToolResult } = require('../commands/workflow');
  const bodies = [];
  let respondWith = 200;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      bodies.push({ url: req.url, body: JSON.parse(data) });
      res.statusCode = respondWith;
      res.end(respondWith === 200 ? '' : 'boom');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await postToolResult('call-1', { status: 'ok', stdout: 'hi' }, base);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].url, '/api/atris2/turn/tool-result');
    assert.equal(bodies[0].body.call_id, 'call-1');
    assert.equal(bodies[0].body.output_encoding, 'base64');
    const decoded = JSON.parse(Buffer.from(bodies[0].body.result, 'base64').toString('utf8'));
    assert.deepEqual(decoded, { status: 'ok', stdout: 'hi' });

    respondWith = 500;
    await assert.rejects(
      () => postToolResult('call-2', { status: 'ok' }, base),
      /tool-result HTTP 500/
    );
  } finally {
    server.close();
  }
});
