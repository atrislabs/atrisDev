'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  extractTeachNumbers,
  extractTeachMechanisms,
  isThinTeachLesson,
  TEACH_THIN_REFUSE,
  LEARNER_CHECK_FILL,
  LEARNER_SCORE_ZERO,
  notesExperimentSlug,
  youtubeCommand,
} = require('../commands/youtube');
const { ephemeralApplyMessage } = require('../lib/apply-gate');

const REPO_ROOT = path.resolve(__dirname, '..');
const VALIDATE_PY = path.join(REPO_ROOT, 'atris', 'experiments', 'validate.py');
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'atris.js');

function findPython() {
  for (const candidate of ['python3', 'python']) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

const pythonCmd = findPython();

const RICH_NOTES = [
  '# Apply Gate Video',
  '',
  '37signals has 80 people and uses the omakase model',
  '',
].join('\n');
const THIN_NOTES = '# Chat\n\nwelcome back friends this is just a chat about feelings and vibes\n';
const RICH_URL = 'https://www.youtube.com/watch?v=notes01';
const THIN_URL = 'https://www.youtube.com/watch?v=thin01';

function collect() {
  const lines = [];
  return {
    lines,
    output: (line = '') => lines.push(String(line)),
    text: () => lines.join('\n'),
  };
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function notesWorkspace(id, notes) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-notes-save-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-notes-work-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(workDir, `yt_${id}.md`), notes);
  return { cwd, workDir };
}

function runExperimentsKeep(cwd, slug) {
  return spawnSync(process.execPath, [CLI_PATH, 'experiments', 'keep', slug], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(pythonCmd ? { ATRIS_EXPERIMENTS_PYTHON: pythonCmd } : {}),
    },
  });
}

function assertNotesApplyClaimable(cwd, { id, tokens = [], date = '2026-08-26' } = {}) {
  const packRel = `atris/experiments/${notesExperimentSlug(id)}`;
  const applyRel = `atris/wiki/briefs/youtube-${id}.apply.md`;
  const sidecar = fs.readFileSync(path.join(cwd, applyRel), 'utf8');
  assert.match(sidecar, new RegExp(escapeRe(packRel)));
  assert.match(sidecar, /keep only if measure\.py moves 0→1/);
  assert.match(sidecar, /scores 1 only when the fixture contains the check tokens/);
  for (const token of tokens) {
    assert.doesNotMatch(sidecar, new RegExp(escapeRe(token), 'i'));
  }
  const journal = fs.readFileSync(path.join(cwd, 'atris', 'logs', date.slice(0, 4), `${date}.md`), 'utf8');
  assert.match(journal, /\[claimable\] apply: /);
  assert.match(journal, new RegExp(escapeRe(packRel)));
  assert.match(journal, /keep only if measure\.py moves 0→1/);
  return { packRel, applyRel, sidecar, journal };
}

test('notesExperimentSlug lowercases the video id', () => {
  assert.equal(notesExperimentSlug('notes01'), 'notes-notes01');
  assert.equal(notesExperimentSlug('NYFGCESmikA'), 'notes-nyfgcesmika');
  assert.equal(notesExperimentSlug('abc_def'), 'notes-abc-def');
});

test('youtube notes --save refuses a thin brief and writes no atris files', async () => {
  const numbers = extractTeachNumbers(THIN_NOTES);
  const mechanisms = extractTeachMechanisms(THIN_NOTES);
  assert.deepEqual(numbers, []);
  assert.deepEqual(mechanisms, []);
  assert.equal(isThinTeachLesson({ numbers, mechanisms }), true);

  const { cwd, workDir } = notesWorkspace('thin01', THIN_NOTES);
  const out = collect();
  const status = await youtubeCommand(['notes', THIN_URL, '--save'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: out.output,
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 2);
  assert.match(out.text(), new RegExp(escapeRe(TEACH_THIN_REFUSE)));
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('notes')).length, 0);
  assert.equal(out.lines.filter((line) => line === `next: atris youtube teach "${THIN_URL}"`).length, 1);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-thin01.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-thin01.apply.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes without --save stay stdout only', async () => {
  const { cwd, workDir } = notesWorkspace('notes01', RICH_NOTES);
  const out = collect();
  const status = await youtubeCommand(['notes', RICH_URL], {
    cwd,
    workDir,
    output: out.output,
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('notes')).length, 1);
  assert.equal(out.lines.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.equal(out.lines.filter((line) => line === `next: atris youtube teach "${RICH_URL}"`).length, 1);
  assert.doesNotMatch(out.text(), /thin: no number or named mechanism/);
  assert.doesNotMatch(out.text(), /next: apply /);
  assert.doesNotMatch(out.text(), new RegExp(`check: ${LEARNER_CHECK_FILL}`));
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes rich --save mints a measure.py that validate.py accepts', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const { cwd, workDir } = notesWorkspace('notes01', RICH_NOTES);
  const out = collect();
  const status = await youtubeCommand(['notes', RICH_URL, '--save'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: out.output,
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('notes')).length, 0);
  assert.doesNotMatch(out.text(), /next: atris youtube teach/);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(out.text(), /next: atris experiments keep notes-notes01/);
  const packDir = path.join(cwd, 'atris', 'experiments', 'notes-notes01');
  for (const name of ['program.md', 'measure.py', 'loop.py', 'reset.py', 'results.tsv']) {
    assert.equal(fs.existsSync(path.join(packDir, name)), true, name);
  }
  const program = fs.readFileSync(path.join(packDir, 'program.md'), 'utf8');
  assert.ok(program.length < 1200);
  assert.match(program, /omakase model/);
  const measureSrc = fs.readFileSync(path.join(packDir, 'measure.py'), 'utf8');
  assert.match(measureSrc, /omakase model/);

  const validated = spawnSync(pythonCmd, [VALIDATE_PY, packDir], { encoding: 'utf8' });
  assert.equal(validated.status, 0, validated.stderr || validated.stdout);
  assert.match(validated.stdout, /PASS/);

  function scoreFixture(text) {
    const fixture = path.join(cwd, 'fixture.md');
    fs.writeFileSync(fixture, text);
    const measured = spawnSync(pythonCmd, [path.join(packDir, 'measure.py')], {
      cwd: packDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ATRIS_REPO_ROOT: cwd,
        ATRIS_TEACH_MEASURE_FIXTURE: fixture,
      },
    });
    assert.equal(measured.status, 0, measured.stderr || measured.stdout);
    return JSON.parse(measured.stdout.trim().split('\n').pop());
  }

  const miss = scoreFixture('feelings and vibes and a chat about nothing');
  assert.equal(miss.score, 0);
  const hit = scoreFixture('keep the omakase model as the default stack');
  assert.equal(hit.score, 1);

  const claim = assertNotesApplyClaimable(cwd, {
    id: 'notes01',
    tokens: ['omakase model', 'what is the omakase model?'],
  });
  const stub = spawnSync(pythonCmd, [path.join(packDir, 'measure.py')], {
    cwd: packDir,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_REPO_ROOT: cwd },
  });
  assert.equal(stub.status, 0, stub.stderr || stub.stdout);
  const stubPayload = JSON.parse(stub.stdout.trim().split('\n').pop());
  assert.equal(stubPayload.score, 0);
  assert.doesNotMatch(claim.sidecar, /omakase model/i);
});

test('youtube notes rich --save keeps the pack when the runner exits 429', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const { cwd, workDir } = notesWorkspace('ntrate1', RICH_NOTES);
  const out = collect();
  const status = await youtubeCommand(['notes', 'https://www.youtube.com/watch?v=ntrate1', '--save'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: out.output,
    runner: () => ({
      status: 1,
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(out.text(), /next: atris experiments keep notes-ntrate1/);
  assert.doesNotMatch(out.text(), /429|Too Many Requests|FAILED/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'notes-ntrate1', 'measure.py')), true);
  const claim = assertNotesApplyClaimable(cwd, {
    id: 'ntrate1',
    tokens: ['omakase model', 'what is the omakase model?'],
  });
  assert.doesNotMatch(claim.sidecar, /omakase model/i);
});

test('youtube notes rich --save keeps the pack when the runner exits with a later error', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const { cwd, workDir } = notesWorkspace('ntlater1', RICH_NOTES);
  const out = collect();
  const status = await youtubeCommand(['notes', 'https://www.youtube.com/watch?v=ntlater1', '--save'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: out.output,
    runner: () => ({
      status: 1,
      stderr: 'ERROR: [youtube] HTTP Error 403: Forbidden',
    }),
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(out.text(), /next: atris experiments keep notes-ntlater1/);
  assert.doesNotMatch(out.text(), /403|Forbidden|FAILED/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'notes-ntlater1', 'measure.py')), true);
  const claim = assertNotesApplyClaimable(cwd, {
    id: 'ntlater1',
    tokens: ['omakase model', 'what is the omakase model?'],
  });
  assert.doesNotMatch(claim.sidecar, /omakase model/i);
});

test('two-url notes batch prints teach next for the first ok url', async () => {
  const first = 'https://www.youtube.com/watch?v=okfirst';
  const second = 'https://www.youtube.com/watch?v=oksecond';
  const { cwd, workDir } = notesWorkspace('okfirst', RICH_NOTES);
  fs.writeFileSync(path.join(workDir, 'yt_oksecond.md'), THIN_NOTES);
  const out = collect();
  const status = await youtubeCommand(['notes', first, second], {
    cwd,
    workDir,
    output: out.output,
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('notes')).length, 1);
  assert.equal(out.lines.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(
    out.text().split('\n').filter((line) => line.startsWith('next: atris youtube teach')),
    [`next: atris youtube teach "${first}"`],
  );
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('failed-then-ok notes batch uses the first ok lesson only', async () => {
  const failed = 'https://www.youtube.com/watch?v=badfirst';
  const firstOk = 'https://www.youtube.com/watch?v=oklater';
  const { cwd, workDir } = notesWorkspace('oklater', RICH_NOTES);
  const out = collect();
  const status = await youtubeCommand(['notes', failed, firstOk], {
    cwd,
    workDir,
    output: out.output,
    runner: (url) => ({ status: url === failed ? 1 : 0 }),
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('notes')).length, 1);
  assert.equal(out.lines.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(
    out.text().split('\n').filter((line) => line.startsWith('next: atris youtube teach')),
    [`next: atris youtube teach "${firstOk}"`],
  );
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('notes --save batch prints keep next and no teach next', async () => {
  const first = 'https://www.youtube.com/watch?v=notes01';
  const second = 'https://www.youtube.com/watch?v=notes02';
  const { cwd, workDir } = notesWorkspace('notes01', RICH_NOTES);
  fs.writeFileSync(path.join(workDir, 'yt_notes02.md'), RICH_NOTES);
  const out = collect();
  const status = await youtubeCommand(['notes', first, second, '--save'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: out.output,
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.match(out.text(), /next: atris experiments keep notes-notes01/);
  assert.doesNotMatch(out.text(), /next: atris youtube teach/);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('notes')).length, 0);
  assert.doesNotMatch(out.text(), /^check:/m);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
});

test('all-failed notes batch prints no teach next', async () => {
  const out = collect();
  const status = await youtubeCommand([
    'notes',
    'https://www.youtube.com/watch?v=bad01',
    'https://www.youtube.com/watch?v=bad02',
  ], {
    output: out.output,
    runner: () => ({ status: 1 }),
  });

  assert.equal(status, 2);
  assert.doesNotMatch(out.text(), /next: atris youtube teach/);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('notes')).length, 0);
  assert.doesNotMatch(out.text(), /^check:/m);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 0);
});

test('experiments keep refuses a minted notes pack at 0 and keeps after check tokens', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const { cwd, workDir } = notesWorkspace('notes01', RICH_NOTES);
  const status = await youtubeCommand(['notes', RICH_URL, '--save'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: () => {},
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  const packDir = path.join(cwd, 'atris', 'experiments', 'notes-notes01');
  const applyPath = path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-notes01.apply.md');

  const refused = runExperimentsKeep(cwd, 'notes-notes01');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /revert notes-notes01: measure\.py stayed 0\. refuse keep\./);
  assert.doesNotMatch(`${refused.stdout}\n${refused.stderr}`, /next: atris youtube watch tick/);
  assert.equal(fs.existsSync(path.join(packDir, 'measure.py')), true);

  fs.appendFileSync(applyPath, '\nkeep the omakase model as the default stack\n');
  const kept = runExperimentsKeep(cwd, 'notes-notes01');
  assert.equal(kept.status, 0, kept.stderr || kept.stdout);
  assert.match(kept.stdout, /keep notes-notes01: measure\.py moved 0→1/);
  assert.deepEqual(
    kept.stdout.split('\n').filter((line) => line.startsWith('next: atris youtube watch tick')),
    ['next: atris youtube watch tick']
  );
});
