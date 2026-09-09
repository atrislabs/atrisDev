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
} = require('../commands/youtube');
const {
  xSearchCommand,
  xSearchApplyRel,
  xSearchBriefRel,
  xSearchExperimentSlug,
  xSearchExperimentRel,
  unsaveXSearch,
} = require('../commands/x-search');
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

const RICH_TEXT = '37signals has 80 people and uses the omakase model';
const THIN_TEXT = 'welcome back friends this is just a chat about feelings and vibes';

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

function saveWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-x-search-save-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  return cwd;
}

function mockSearch(content, citations = ['https://x.com/levelsio/status/1']) {
  return {
    ok: true,
    status: 200,
    data: {
      status: 'success',
      credits_used: 5,
      credits_remaining: 995,
      data: { content, citations },
    },
  };
}

function runSearch(query, { cwd, output, content = RICH_TEXT, extraArgs = [] } = {}) {
  return xSearchCommand([query, ...extraArgs], {
    cwd,
    applyNow: '2026-08-26',
    output,
    ensureValidCredentials: async () => ({ credentials: { token: 't', agent_token: 't', agent_token_scopes: ['x-search', 'youtube'], agent_token_expires_at: '2099-01-01T00:00:00Z' } }),
    apiRequestJson: async () => mockSearch(content),
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

function assertXSearchApplyClaimable(cwd, { source, tokens = [], date = '2026-08-26' } = {}) {
  const packRel = `atris/experiments/${xSearchExperimentSlug(source)}`;
  const applyRel = xSearchApplyRel(source);
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

test('xSearchExperimentSlug prefixes the query slug', () => {
  assert.equal(xSearchExperimentSlug('MCP agents'), 'x-search-mcp-agents');
  assert.equal(xSearchExperimentSlug('Leah Bonvissuto'), 'x-search-leah-bonvissuto');
});

test('x-search --save refuses a thin brief and writes no atris files', async () => {
  const numbers = extractTeachNumbers(THIN_TEXT);
  const mechanisms = extractTeachMechanisms(THIN_TEXT);
  assert.deepEqual(numbers, []);
  assert.deepEqual(mechanisms, []);
  assert.equal(isThinTeachLesson({ numbers, mechanisms }), true);

  const cwd = saveWorkspace();
  const out = collect();
  const status = await runSearch('quiet chat', {
    cwd,
    output: out.output,
    content: THIN_TEXT,
    extraArgs: ['--save'],
  });

  assert.equal(status, 2);
  assert.match(out.text(), new RegExp(escapeRe(TEACH_THIN_REFUSE)));
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('x-search')).length, 0);
  assert.doesNotMatch(out.text(), /next: atris youtube search/);
  assert.doesNotMatch(out.text(), /^check:/m);
  assert.doesNotMatch(out.text(), /score: 0/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'x-search-quiet-chat.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, xSearchApplyRel('quiet chat'))), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('x-search without --save stays stdout only', async () => {
  const cwd = saveWorkspace();
  const out = collect();
  const status = await runSearch('MCP agents', {
    cwd,
    output: out.output,
    content: RICH_TEXT,
  });

  assert.equal(status, 0);
  assert.match(out.text(), /omakase model/);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('x-search')).length, 1);
  assert.equal(out.lines.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.equal(out.lines.filter((line) => line === 'next: atris youtube search "MCP agents"').length, 1);
  assert.doesNotMatch(out.text(), /thin: no number or named mechanism/);
  assert.doesNotMatch(out.text(), /next: apply /);
  assert.doesNotMatch(out.text(), new RegExp(`check: ${LEARNER_CHECK_FILL}`));
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('x-search rich --save mints a measure.py that validate.py accepts', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = saveWorkspace();
  const out = collect();
  const status = await runSearch('MCP agents', {
    cwd,
    output: out.output,
    content: RICH_TEXT,
    extraArgs: ['--save'],
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('x-search')).length, 0);
  assert.doesNotMatch(out.text(), /next: atris youtube search/);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(out.text(), /next: atris experiments keep x-search-mcp-agents/);
  const packDir = path.join(cwd, 'atris', 'experiments', 'x-search-mcp-agents');
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

  const claim = assertXSearchApplyClaimable(cwd, {
    source: 'MCP agents',
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
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'x-search-mcp-agents.md')), true);
});

test('x-search --save without wiki is incomplete when apply is missing', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-x-search-nowiki-'));
  const out = collect();
  const status = await runSearch('MCP agents', {
    cwd,
    output: out.output,
    content: RICH_TEXT,
    extraArgs: ['--save'],
  });

  assert.equal(status, 2);
  assert.match(out.text(), /incomplete: apply missing/);
  assert.doesNotMatch(out.text(), /invented success|score: 0/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'x-search-mcp-agents', 'measure.py')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
});

test('x-search --save refuses when the apply fixture already passes', async () => {
  const cwd = saveWorkspace();
  const applyRel = xSearchApplyRel('MCP agents');
  fs.mkdirSync(path.dirname(path.join(cwd, applyRel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, applyRel), [
    'source: MCP agents',
    'change: commands/x-search.js',
    'receipt: node --test test/x-search-save.test.js',
    'keep the omakase model as the default stack',
    '',
  ].join('\n'));
  const out = collect();
  const status = await runSearch('MCP agents', {
    cwd,
    output: out.output,
    content: RICH_TEXT,
    extraArgs: ['--save'],
  });

  assert.equal(status, 2);
  assert.match(out.text(), /incomplete: check already passes/);
  assert.doesNotMatch(out.text(), /score: 0/);
});

test('experiments keep refuses a minted x-search pack at 0 and keeps after check tokens', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = saveWorkspace();
  const status = await runSearch('MCP agents', {
    cwd,
    output: () => {},
    content: RICH_TEXT,
    extraArgs: ['--save'],
  });

  assert.equal(status, 0);
  const packDir = path.join(cwd, 'atris', 'experiments', 'x-search-mcp-agents');
  const applyPath = path.join(cwd, xSearchApplyRel('MCP agents'));

  const refused = runExperimentsKeep(cwd, 'x-search-mcp-agents');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /revert x-search-mcp-agents: measure\.py stayed 0\. refuse keep\./);
  assert.doesNotMatch(`${refused.stdout}\n${refused.stderr}`, /next: atris youtube watch tick/);
  assert.equal(fs.existsSync(path.join(packDir, 'measure.py')), true);

  fs.appendFileSync(applyPath, '\nkeep the omakase model as the default stack\n');
  const kept = runExperimentsKeep(cwd, 'x-search-mcp-agents');
  assert.equal(kept.status, 0, kept.stderr || kept.stdout);
  assert.match(kept.stdout, /keep x-search-mcp-agents: measure\.py moved 0→1/);
  assert.deepEqual(
    kept.stdout.split('\n').filter((line) => line.startsWith('next: atris youtube watch tick')),
    ['next: atris youtube watch tick']
  );
});

test('x-search person rich --save mints the same keep/revert pack', async () => {
  const cwd = saveWorkspace();
  const out = collect();
  const status = await xSearchCommand([
    'person',
    '--name',
    'Leah Bonvissuto',
    '--save',
  ], {
    cwd,
    applyNow: '2026-08-26',
    output: out.output,
    ensureValidCredentials: async () => ({ credentials: { token: 't', agent_token: 't', agent_token_scopes: ['x-search', 'youtube'], agent_token_expires_at: '2099-01-01T00:00:00Z' } }),
    apiRequestJson: async () => mockSearch(RICH_TEXT),
  });

  assert.equal(status, 0);
  assert.doesNotMatch(out.text(), /next: atris youtube search/);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(out.text(), /next: atris experiments keep x-search-leah-bonvissuto/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'x-search-leah-bonvissuto', 'measure.py')), true);
  assertXSearchApplyClaimable(cwd, {
    source: 'Leah Bonvissuto',
    tokens: ['omakase model', 'what is the omakase model?'],
  });
});

test('x-search unsave after rich --save removes brief apply and pack', async () => {
  const cwd = saveWorkspace();
  const saveStatus = await runSearch('MCP agents', {
    cwd,
    output: () => {},
    extraArgs: ['--save'],
  });
  assert.equal(saveStatus, 0);
  assert.equal(fs.existsSync(path.join(cwd, xSearchBriefRel('MCP agents'))), true);
  assert.equal(fs.existsSync(path.join(cwd, xSearchApplyRel('MCP agents'))), true);
  assert.equal(fs.existsSync(path.join(cwd, xSearchExperimentRel('MCP agents'), 'measure.py')), true);

  let apiCalls = 0;
  const out = collect();
  const status = await xSearchCommand(['unsave', 'MCP agents'], {
    cwd,
    output: out.output,
    apiRequestJson: async () => {
      apiCalls += 1;
      throw new Error('unsave must not call x-search');
    },
  });

  assert.equal(status, 0);
  assert.equal(apiCalls, 0);
  assert.match(out.text(), /removed atris\/wiki\/briefs\/x-search-mcp-agents\.md and atris\/wiki\/briefs\/x-search-mcp-agents\.apply\.md and atris\/experiments\/x-search-mcp-agents/);
  assert.deepEqual(
    out.lines.filter((line) => String(line).startsWith('next:')),
    ['next: atris youtube search " "'],
  );
  assert.equal(fs.existsSync(path.join(cwd, xSearchBriefRel('MCP agents'))), false);
  assert.equal(fs.existsSync(path.join(cwd, xSearchApplyRel('MCP agents'))), false);
  assert.equal(fs.existsSync(path.join(cwd, xSearchExperimentRel('MCP agents'))), false);
});

test('x-search unsave removes leftover pack when brief and apply are already gone', async () => {
  const cwd = saveWorkspace();
  const packRel = xSearchExperimentRel('MCP agents');
  const packDir = path.join(cwd, packRel);
  const otherDir = path.join(cwd, xSearchExperimentRel('other query'));
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'measure.py'), 'print(0)\n');
  fs.writeFileSync(path.join(otherDir, 'stay.txt'), 'ok\n');

  let apiCalls = 0;
  const out = collect();
  const status = await xSearchCommand(['--unsave', 'MCP agents'], {
    cwd,
    output: out.output,
    apiRequestJson: async () => {
      apiCalls += 1;
      throw new Error('unsave must not call x-search');
    },
  });

  assert.equal(status, 0);
  assert.equal(apiCalls, 0);
  assert.match(out.text(), /removed atris\/experiments\/x-search-mcp-agents/);
  assert.deepEqual(
    out.lines.filter((line) => String(line).startsWith('next:')),
    ['next: atris youtube search " "'],
  );
  assert.equal(fs.existsSync(packDir), false);
  assert.equal(fs.existsSync(path.join(otherDir, 'stay.txt')), true);
});

test('x-search unsave of a missing source stays quiet', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-x-search-unsave-'));
  let apiCalls = 0;
  const out = collect();
  const status = await xSearchCommand(['unsave', 'gone query'], {
    cwd,
    output: out.output,
    apiRequestJson: async () => {
      apiCalls += 1;
      throw new Error('unsave must not call x-search');
    },
  });

  assert.equal(status, 0);
  assert.equal(apiCalls, 0);
  assert.match(out.text(), /already gone: atris\/wiki\/briefs\/x-search-gone-query\.md and atris\/wiki\/briefs\/x-search-gone-query\.apply\.md/);
  assert.deepEqual(
    out.lines.filter((line) => String(line).startsWith('next:')),
    ['next: atris youtube search " "'],
  );
  assert.equal(unsaveXSearch('gone query', { cwd, output: () => {} }), 0);
});

test('x-search person rich --save then unsave removes the minted pack', async () => {
  const cwd = saveWorkspace();
  const saveStatus = await xSearchCommand([
    'person',
    '--name',
    'Leah Bonvissuto',
    '--save',
  ], {
    cwd,
    applyNow: '2026-08-26',
    output: () => {},
    ensureValidCredentials: async () => ({ credentials: { token: 't', agent_token: 't', agent_token_scopes: ['x-search', 'youtube'], agent_token_expires_at: '2099-01-01T00:00:00Z' } }),
    apiRequestJson: async () => mockSearch(RICH_TEXT),
  });
  assert.equal(saveStatus, 0);
  assert.equal(fs.existsSync(path.join(cwd, xSearchBriefRel('Leah Bonvissuto'))), true);
  assert.equal(fs.existsSync(path.join(cwd, xSearchExperimentRel('Leah Bonvissuto'), 'measure.py')), true);

  let apiCalls = 0;
  const out = collect();
  const status = await xSearchCommand(['unsave', 'Leah Bonvissuto'], {
    cwd,
    output: out.output,
    apiRequestJson: async () => {
      apiCalls += 1;
      throw new Error('unsave must not call x-search');
    },
  });

  assert.equal(status, 0);
  assert.equal(apiCalls, 0);
  assert.match(out.text(), /removed atris\/wiki\/briefs\/x-search-leah-bonvissuto\.md and atris\/wiki\/briefs\/x-search-leah-bonvissuto\.apply\.md and atris\/experiments\/x-search-leah-bonvissuto/);
  assert.deepEqual(
    out.lines.filter((line) => String(line).startsWith('next:')),
    ['next: atris youtube search " "'],
  );
  assert.equal(fs.existsSync(path.join(cwd, xSearchBriefRel('Leah Bonvissuto'))), false);
  assert.equal(fs.existsSync(path.join(cwd, xSearchApplyRel('Leah Bonvissuto'))), false);
  assert.equal(fs.existsSync(path.join(cwd, xSearchExperimentRel('Leah Bonvissuto'))), false);
});
