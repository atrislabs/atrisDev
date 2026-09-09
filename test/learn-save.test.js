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
  LEARNER_SCORE_ZERO,
} = require('../commands/youtube');
const learnAtris = require('../commands/learn');
const {
  learnExperimentSlug,
  learnApplyRel,
  learnExperimentRel,
  saveRichLearn,
  mintRichLearn,
  commitAddedLearning,
  commitReviewLearning,
  reviewLearningKey,
  harvestFromJournals,
  logDirect,
} = learnAtris;

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

const RICH_INSIGHT = '37signals has 80 people and uses the omakase model';
const THIN_INSIGHT = 'check MAP.md before grep';
const RICH_KEY = 'attention window';

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

function learnWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-learn-save-'));
  fs.mkdirSync(path.join(cwd, 'atris'), { recursive: true });
  return cwd;
}

function runCliLearnLog(cwd, payload) {
  return spawnSync(process.execPath, [CLI_PATH, 'learn', 'log', JSON.stringify(payload)], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
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

function assertLearnApplyClaimable(cwd, { key, tokens = [], date = '2026-09-08' } = {}) {
  const packRel = learnExperimentRel(key);
  const applyRel = learnApplyRel(key);
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

test('learnExperimentSlug prefixes the key slug', () => {
  assert.equal(learnExperimentSlug('attention window'), 'learn-attention-window');
  assert.equal(learnExperimentSlug('omakase model'), 'learn-omakase-model');
});

test('thin learn log writes jsonl only', () => {
  const numbers = extractTeachNumbers(THIN_INSIGHT);
  const mechanisms = extractTeachMechanisms(THIN_INSIGHT);
  assert.deepEqual(numbers, []);
  assert.deepEqual(mechanisms, []);
  assert.equal(isThinTeachLesson({ numbers, mechanisms }), true);

  const cwd = learnWorkspace();
  const saved = saveRichLearn({ cwd, key: 'map-first', insight: THIN_INSIGHT });
  assert.equal(saved.thin, true);
  assert.equal(saved.packRel, null);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, learnApplyRel('map-first'))), false);
});

test('rich learn mint writes a failing apply and prints score 0', () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = learnWorkspace();
  const out = collect();
  const status = mintRichLearn({
    cwd,
    key: RICH_KEY,
    insight: RICH_INSIGHT,
    now: '2026-09-08',
    output: out.output,
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(out.text(), /next: atris experiments keep learn-attention-window/);
  assert.doesNotMatch(out.text(), /next: atris youtube/);

  const packDir = path.join(cwd, 'atris', 'experiments', 'learn-attention-window');
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

  const claim = assertLearnApplyClaimable(cwd, {
    key: RICH_KEY,
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

  const keep = runExperimentsKeep(cwd, 'learn-attention-window');
  assert.equal(keep.status, 1, keep.stderr || keep.stdout);
  assert.match(keep.stderr + keep.stdout, /revert|score 0|keep only if/i);
});

test('rich learn log through the live cli mints the pack', () => {
  const cwd = learnWorkspace();
  const result = runCliLearnLog(cwd, {
    type: 'pattern',
    key: RICH_KEY,
    insight: RICH_INSIGHT,
    confidence: 8,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /attention-window|attention window/);
  assert.match(result.stdout, /score: 0/);
  assert.match(result.stdout, /next: atris experiments keep learn-attention-window/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'learn-attention-window', 'measure.py')), true);
  assert.equal(fs.existsSync(path.join(cwd, learnApplyRel(RICH_KEY))), true);
  const jsonl = fs.readFileSync(path.join(cwd, 'atris', 'learnings.jsonl'), 'utf8');
  assert.match(jsonl, /omakase model/);
});

test('thin learn log through the live cli stays jsonl only', () => {
  const cwd = learnWorkspace();
  const result = runCliLearnLog(cwd, {
    type: 'pattern',
    title: 'map-first',
    detail: THIN_INSIGHT,
    confidence: 8,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /map-first/);
  assert.match(result.stdout, /check: fill this/);
  assert.doesNotMatch(result.stdout + result.stderr, /what is /);
  assert.doesNotMatch(result.stdout + result.stderr, /score: 0/);
  assert.doesNotMatch(result.stdout + result.stderr, /next: atris experiments keep/);
  assert.doesNotMatch(result.stdout + result.stderr, /next: atris youtube/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, learnApplyRel('map-first'))), false);
});

test('thin learn mint prints check fill this and does not invent a question', () => {
  const cwd = learnWorkspace();
  const out = collect();
  const status = mintRichLearn({
    cwd,
    key: 'map-first',
    insight: THIN_INSIGHT,
    now: '2026-09-08',
    output: out.output,
  });

  assert.equal(status, 0);
  assert.match(out.text(), /check: fill this/);
  assert.equal(out.lines.filter((line) => line === 'check: fill this').length, 1);
  assert.doesNotMatch(out.text(), /what is /);
  assert.doesNotMatch(out.text(), /score: 0/);
  assert.doesNotMatch(out.text(), /next: /);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, learnApplyRel('map-first'))), false);
});

test('learn log without a key still refuses invented success', () => {
  const cwd = learnWorkspace();
  const origCwd = process.cwd();
  const out = collect();
  const err = collect();
  let exitCode = 0;
  process.chdir(cwd);
  try {
    logDirect(JSON.stringify({
      type: 'pattern',
      insight: RICH_INSIGHT,
    }), {
      cwd,
      output: out.output,
      error: err.output,
      exit: (code) => {
        exitCode = code;
        return code;
      },
    });
  } finally {
    process.chdir(origCwd);
  }
  assert.notEqual(exitCode, 0);
  assert.match(err.text(), /Schema:/);
  assert.doesNotMatch(out.text(), /score: 0/);
});

function runCliLearnHarvest(cwd) {
  return spawnSync(process.execPath, [CLI_PATH, 'learn', 'harvest'], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
}

function writeHarvestNotes(cwd, notes, date = '2026-09-08') {
  const dir = path.join(cwd, 'atris', 'logs', date.slice(0, 4));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}.md`), [
    `# Log ${date}`,
    '',
    '## Notes',
    ...notes.map((note) => `- ${note}`),
    '',
    '## Inbox',
    '',
  ].join('\n'));
}

function harvestKey(insight) {
  return String(insight).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 4).join('-');
}

test('rich learn add mints a failing apply and prints score 0', () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = learnWorkspace();
  const origCwd = process.cwd();
  const out = collect();
  let saved;
  process.chdir(cwd);
  try {
    saved = commitAddedLearning({
      type: 'pattern',
      key: RICH_KEY,
      insight: RICH_INSIGHT,
      confidence: 8,
      source: 'observed',
      files: [],
    }, {
      cwd,
      now: '2026-09-08',
      output: out.output,
    });
  } finally {
    process.chdir(origCwd);
  }

  assert.equal(saved.baseline, 0);
  assert.equal(saved.entry.key, 'attention-window');
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(out.text(), /next: atris experiments keep learn-attention-window/);
  assert.doesNotMatch(out.text(), /check: fill this/);
  assert.doesNotMatch(out.text(), /what is the omakase model/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'learn-attention-window', 'measure.py')), true);
  assertLearnApplyClaimable(cwd, {
    key: saved.entry.key,
    tokens: ['omakase model', 'what is the omakase model?'],
  });
  const stub = spawnSync(pythonCmd, [path.join(cwd, 'atris', 'experiments', 'learn-attention-window', 'measure.py')], {
    cwd: path.join(cwd, 'atris', 'experiments', 'learn-attention-window'),
    encoding: 'utf8',
    env: { ...process.env, ATRIS_REPO_ROOT: cwd },
  });
  assert.equal(stub.status, 0, stub.stderr || stub.stdout);
  assert.equal(JSON.parse(stub.stdout.trim().split('\n').pop()).score, 0);
});

test('thin learn add prints check fill this and does not invent a question', () => {
  const cwd = learnWorkspace();
  const origCwd = process.cwd();
  const out = collect();
  let saved;
  process.chdir(cwd);
  try {
    saved = commitAddedLearning({
      type: 'pattern',
      key: 'map-first',
      insight: THIN_INSIGHT,
      confidence: 8,
      source: 'observed',
      files: [],
    }, {
      cwd,
      now: '2026-09-08',
      output: out.output,
    });
  } finally {
    process.chdir(origCwd);
  }

  assert.equal(saved.baseline, 0);
  assert.match(out.text(), /map-first/);
  assert.match(out.text(), /check: fill this/);
  assert.doesNotMatch(out.text(), /what is /);
  assert.doesNotMatch(out.text(), /score: 0/);
  assert.doesNotMatch(out.text(), /next: atris experiments keep/);
  assert.doesNotMatch(out.text(), /next: /);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, learnApplyRel('map-first'))), false);
});

test('rich learn harvest mints a failing apply and prints score 0', () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = learnWorkspace();
  writeHarvestNotes(cwd, [RICH_INSIGHT]);
  const origCwd = process.cwd();
  const out = collect();
  process.chdir(cwd);
  try {
    harvestFromJournals({
      cwd,
      now: '2026-09-08',
      output: out.output,
    });
  } finally {
    process.chdir(origCwd);
  }

  const key = harvestKey(RICH_INSIGHT);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(out.text(), new RegExp(`next: atris experiments keep learn-${key}`));
  assert.doesNotMatch(out.text(), /check: fill this/);
  assert.doesNotMatch(out.text(), /what is the omakase model/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', `learn-${key}`, 'measure.py')), true);
  assertLearnApplyClaimable(cwd, {
    key,
    tokens: ['omakase model', 'what is the omakase model?'],
  });
  const stub = spawnSync(pythonCmd, [path.join(cwd, 'atris', 'experiments', `learn-${key}`, 'measure.py')], {
    cwd: path.join(cwd, 'atris', 'experiments', `learn-${key}`),
    encoding: 'utf8',
    env: { ...process.env, ATRIS_REPO_ROOT: cwd },
  });
  assert.equal(stub.status, 0, stub.stderr || stub.stdout);
  assert.equal(JSON.parse(stub.stdout.trim().split('\n').pop()).score, 0);
});

test('thin learn harvest prints check fill this and does not invent a question', () => {
  const cwd = learnWorkspace();
  writeHarvestNotes(cwd, [THIN_INSIGHT]);
  const origCwd = process.cwd();
  const out = collect();
  process.chdir(cwd);
  try {
    harvestFromJournals({
      cwd,
      now: '2026-09-08',
      output: out.output,
    });
  } finally {
    process.chdir(origCwd);
  }

  assert.match(out.text(), /saved/);
  assert.match(out.text(), /check: fill this/);
  assert.doesNotMatch(out.text(), /what is /);
  assert.doesNotMatch(out.text(), /score: 0/);
  assert.doesNotMatch(out.text(), /next: atris experiments keep/);
  assert.doesNotMatch(out.text(), /next: /);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, learnApplyRel(harvestKey(THIN_INSIGHT)))), false);
});

test('rich learn harvest through the live cli mints the pack', () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = learnWorkspace();
  writeHarvestNotes(cwd, [RICH_INSIGHT, THIN_INSIGHT]);
  const result = runCliLearnHarvest(cwd);
  const key = harvestKey(RICH_INSIGHT);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /score: 0/);
  assert.match(result.stdout, new RegExp(`next: atris experiments keep learn-${key}`));
  assert.match(result.stdout, /check: fill this/);
  assert.doesNotMatch(result.stdout + result.stderr, /what is the omakase model/);
  const measurePy = path.join(cwd, 'atris', 'experiments', `learn-${key}`, 'measure.py');
  assert.equal(fs.existsSync(measurePy), true);
  assert.equal(fs.existsSync(path.join(cwd, learnApplyRel(key))), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', `learn-${harvestKey(THIN_INSIGHT)}`)), false);
  const stub = spawnSync(pythonCmd, [measurePy], {
    cwd: path.dirname(measurePy),
    encoding: 'utf8',
    env: { ...process.env, ATRIS_REPO_ROOT: cwd },
  });
  assert.equal(stub.status, 0, stub.stderr || stub.stdout);
  assert.equal(JSON.parse(stub.stdout.trim().split('\n').pop()).score, 0);
});

test('rich review learning mints a failing apply and prints score 0', () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = learnWorkspace();
  const origCwd = process.cwd();
  const out = collect();
  let saved;
  process.chdir(cwd);
  try {
    saved = commitReviewLearning(RICH_INSIGHT, {
      cwd,
      now: '2026-09-08',
      output: out.output,
    });
  } finally {
    process.chdir(origCwd);
  }

  const key = reviewLearningKey(RICH_INSIGHT);
  assert.equal(saved.baseline, 0);
  assert.equal(saved.entry.key, key);
  assert.equal(saved.entry.source, 'review');
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(out.text(), new RegExp(`next: atris experiments keep learn-${key}`));
  assert.doesNotMatch(out.text(), /check: fill this/);
  assert.doesNotMatch(out.text(), /what is the omakase model/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', `learn-${key}`, 'measure.py')), true);
  assertLearnApplyClaimable(cwd, {
    key,
    tokens: ['omakase model', 'what is the omakase model?'],
  });
  const measured = spawnSync(pythonCmd, [path.join(cwd, 'atris', 'experiments', `learn-${key}`, 'measure.py')], {
    cwd: path.join(cwd, 'atris', 'experiments', `learn-${key}`),
    encoding: 'utf8',
    env: { ...process.env, ATRIS_REPO_ROOT: cwd },
  });
  assert.equal(measured.status, 0, measured.stderr || measured.stdout);
  assert.equal(JSON.parse(measured.stdout.trim().split('\n').pop()).score, 0);
});

test('thin review learning prints check fill this and does not invent a question', () => {
  const cwd = learnWorkspace();
  const origCwd = process.cwd();
  const out = collect();
  let saved;
  process.chdir(cwd);
  try {
    saved = commitReviewLearning(THIN_INSIGHT, {
      cwd,
      now: '2026-09-08',
      output: out.output,
    });
  } finally {
    process.chdir(origCwd);
  }

  assert.equal(saved.baseline, 0);
  assert.match(out.text(), /saved to learnings/i);
  assert.match(out.text(), /check: fill this/);
  assert.doesNotMatch(out.text(), /what is /);
  assert.doesNotMatch(out.text(), /score: 0/);
  assert.doesNotMatch(out.text(), /next: atris experiments keep/);
  assert.doesNotMatch(out.text(), /next: /);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, learnApplyRel(reviewLearningKey(THIN_INSIGHT)))), false);
});
