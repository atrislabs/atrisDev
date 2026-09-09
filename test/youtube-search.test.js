'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const {
  parseSearchArgs,
  parseSearchStdout,
  formatSearchResults,
  youtubeCommand,
  APPLY_NEXT_MESSAGE,
  LEARNER_CHECK_FILL,
  LEARNER_SCORE_ZERO,
  searchExperimentSlug,
  searchApplyRel,
} = require('../commands/youtube');

const CACHE_HOME = '/tmp/atris-yt-search-cache-home';
const CACHE_PATH = path.join(CACHE_HOME, '.atris', 'youtube-search-cache.json');
const RATE_LIMIT_MESSAGE =
  'youtube rate-limited local search. do not use --paid as a fallback; retry later.';
const CACHE_NOTE = 'cached because youtube rate-limited local search.';
const PAID_CACHE_REFUSE =
  'free cache still has results for this query. drop --paid or wait until the cache expires.';
const SAMPLE_ROW = {
  title: 'MCP Agents in 2026',
  channel: 'Dev Channel',
  duration: '18:22',
  views: '42000',
  upload_date: '20260820',
  url: 'https://youtu.be/mcp2026a',
};
const SAMPLE_LINE =
  'MCP Agents in 2026 | Dev Channel | 18:22 | 42000 | 20260820 | https://youtu.be/mcp2026a';
const TEACH_NEXT_LINE = 'next: atris youtube teach "https://youtu.be/mcp2026a"';
const WATCH_TICK_NEXT = 'next: atris youtube watch tick';

function mockSearchFs(files = {}) {
  const store = { ...files };
  return {
    store,
    existsSync(filePath) {
      return Object.prototype.hasOwnProperty.call(store, filePath);
    },
    mkdirSync() {},
    readFileSync(filePath) {
      if (!Object.prototype.hasOwnProperty.call(store, filePath)) {
        const err = new Error(`ENOENT: ${filePath}`);
        err.code = 'ENOENT';
        throw err;
      }
      return store[filePath];
    },
    writeFileSync(filePath, data) {
      store[filePath] = String(data);
    },
  };
}

function cacheDeps(extra = {}) {
  return {
    fs: extra.fs || mockSearchFs(),
    homeDir: CACHE_HOME,
    ...extra,
  };
}

const REPO_ROOT = path.resolve(__dirname, '..');
const VALIDATE_PY = path.join(REPO_ROOT, 'atris', 'experiments', 'validate.py');
const RICH_SEARCH_LINE =
  '37signals uses the omakase model | Basecamp | 12:00 | 100 | 20260801 | https://youtu.be/omakase1';
const RICH_SEARCH_KEEP = 'next: atris experiments keep search-omakase';
const RICH_TEACH_NEXT = 'next: atris youtube teach "https://youtu.be/omakase1"';

function findPython() {
  for (const candidate of ['python3', 'python']) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

const pythonCmd = findPython();

function searchWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-search-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  return cwd;
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertSearchApplyClaimable(cwd, { query, tokens = [], date } = {}) {
  const slug = searchExperimentSlug(query);
  const packRel = `atris/experiments/${slug}`;
  const applyRel = searchApplyRel(query);
  const sidecar = fs.readFileSync(path.join(cwd, applyRel), 'utf8');
  assert.match(sidecar, new RegExp(escapeRe(packRel)));
  assert.match(sidecar, /keep only if measure\.py moves 0→1/);
  assert.match(sidecar, /scores 1 only when the fixture contains the check tokens/);
  for (const token of tokens) {
    assert.doesNotMatch(sidecar, new RegExp(escapeRe(token), 'i'));
  }
  const stamp = date || new Date().toISOString().slice(0, 10);
  const journal = fs.readFileSync(path.join(cwd, 'atris', 'logs', stamp.slice(0, 4), `${stamp}.md`), 'utf8');
  assert.match(journal, /\[claimable\] apply: /);
  assert.match(journal, new RegExp(escapeRe(packRel)));
  return { packRel, applyRel, sidecar, journal };
}

test('parseSearchArgs accepts query with limit and json', () => {
  const options = parseSearchArgs([
    'MCP agents',
    '--limit',
    '10',
    '--json',
  ]);
  assert.equal(options.query, 'MCP agents');
  assert.equal(options.limit, 10);
  assert.equal(options.json, true);
  assert.equal(options.paid, false);
  assert.equal(options.help, false);
});

test('parseSearchArgs accepts --paid before or after the query', () => {
  assert.equal(parseSearchArgs(['--paid', 'MCP agents']).paid, true);
  assert.equal(parseSearchArgs(['MCP agents', '--paid', '--limit', '3']).paid, true);
  assert.equal(parseSearchArgs(['MCP agents', '--paid', '--limit', '3']).limit, 3);
});

test('parseSearchArgs defaults limit to 5 and supports --help', () => {
  assert.equal(parseSearchArgs(['MCP agents']).limit, 5);
  assert.equal(parseSearchArgs(['--help']).help, true);
  assert.throws(() => parseSearchArgs(['--limit', '0']), /positive integer/);
  assert.throws(() => parseSearchArgs(['--limit', '3']), /Missing query/);
});

test('parseSearchStdout reads five-field and six-field pipe lines', () => {
  const rows = parseSearchStdout([
    'Alpha Talk | Channel A | 12:34 | 1000 | https://youtu.be/aaa111',
    'Beta Show | Channel B | 1:02:03 | 9999 | 20260801 | https://youtu.be/bbb222',
    'noise without pipes',
    'too | few',
  ].join('\n'));

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    title: 'Alpha Talk',
    channel: 'Channel A',
    duration: '12:34',
    views: '1000',
    url: 'https://youtu.be/aaa111',
  });
  assert.deepEqual(rows[1], {
    title: 'Beta Show',
    channel: 'Channel B',
    duration: '1:02:03',
    views: '9999',
    upload_date: '20260801',
    url: 'https://youtu.be/bbb222',
  });
  assert.match(formatSearchResults(rows), /https:\/\/youtu\.be\/aaa111/);
  assert.match(formatSearchResults(rows), /20260801 \| https:\/\/youtu\.be\/bbb222/);
});

test('youtube search --help prints usage without calling the runner', async () => {
  const output = [];
  let runnerCalls = 0;
  const status = await youtubeCommand(['search', '--help'], {
    output: (line) => output.push(line),
    runner: () => {
      runnerCalls += 1;
      return { status: 0, stdout: '' };
    },
  });

  assert.equal(status, 0);
  assert.equal(runnerCalls, 0);
  assert.match(output.join('\n'), /Usage: atris youtube search/);
  assert.match(output.join('\n'), /--limit/);
  assert.match(output.join('\n'), /--paid/);
  assert.match(output.join('\n'), /zero credits|Does not bill credits/i);
  assert.match(output.join('\n'), /5 credits/);
  assert.match(output.join('\n'), /next: atris youtube teach/);
  assert.match(output.join('\n'), /check: fill this/);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube watch tick/);
});

test('youtube --help lists paid search', async () => {
  const output = [];
  const status = await youtubeCommand(['--help'], {
    output: (line) => output.push(line),
  });
  assert.equal(status, 0);
  const text = output.join('\n');
  assert.match(text, /search --paid/);
  assert.match(text, /5 credits, watch permalinks/);
  assert.match(text, /rich free search writes one apply and a failing keep\/revert pack/);
  assert.match(text, /rich paid search writes one apply and a failing keep\/revert pack/);
  assert.match(text, /thin hands off to teach/);
});

test('youtube search prints youtu.be links from mocked runner', async () => {
  const output = [];
  const calls = [];
  const status = await youtubeCommand(['search', 'MCP agents 2026', '--limit', '5'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    runner: (query, limit) => {
      calls.push({ query, limit });
      return {
        status: 0,
        stdout: [
          'MCP Agents in 2026 | Dev Channel | 18:22 | 42000 | 20260820 | https://youtu.be/mcp2026a',
          'Agent Stack Tour | Build Lab | 9:01 | 1200 | 20260701 | https://youtu.be/mcp2026b',
        ].join('\n'),
      };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [{ query: 'MCP agents 2026', limit: 5 }]);
  const text = output.join('\n');
  assert.match(text, /https:\/\/youtu\.be\/mcp2026a/);
  assert.match(text, /https:\/\/youtu\.be\/mcp2026b/);
  assert.match(text, /MCP Agents in 2026/);
  assert.match(text, /Dev Channel/);
  assert.equal(output.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 0);
  assert.doesNotMatch(text, /what is the point of|invented/);
  assert.equal(output.includes(APPLY_NEXT_MESSAGE), false);
  assert.equal(output.filter((line) => String(line).startsWith('next:')).length, 1);
  assert.equal(output.includes(TEACH_NEXT_LINE), true);
  assert.ok(
    output.indexOf(`check: ${LEARNER_CHECK_FILL}`)
      < output.indexOf(TEACH_NEXT_LINE),
  );
  assert.equal(output.includes(WATCH_TICK_NEXT), false);
});

test('searchExperimentSlug prefixes the query slug', () => {
  assert.equal(searchExperimentSlug('omakase'), 'search-omakase');
  assert.equal(searchExperimentSlug('MCP agents 2026'), 'search-mcp-agents-2026');
});

test('youtube search prints keep next and score 0 after a rich title', async () => {
  const cwd = searchWorkspace();
  const output = [];
  const status = await youtubeCommand(['search', 'omakase'], {
    ...cacheDeps(),
    cwd,
    now: '2026-09-08',
    output: (line) => output.push(line),
    runner: () => ({
      status: 0,
      stdout: `${RICH_SEARCH_LINE}\n`,
    }),
  });

  assert.equal(status, 0);
  assert.match(output.join('\n'), /37signals uses the omakase model/);
  assert.equal(output.filter((line) => line === 'check: what is the omakase model?').length, 0);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(
    output.filter((line) => String(line).startsWith('next:')),
    [RICH_SEARCH_KEEP],
  );
  assert.ok(output.indexOf(RICH_SEARCH_KEEP) < output.indexOf(LEARNER_SCORE_ZERO));
  assert.equal(output.includes(RICH_TEACH_NEXT), false);
  assert.equal(output.includes(APPLY_NEXT_MESSAGE), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'search-omakase', 'measure.py')), true);
  assertSearchApplyClaimable(cwd, {
    query: 'omakase',
    tokens: ['omakase model', 'what is the omakase model?'],
    date: '2026-09-08',
  });
});

test('youtube search --json stays quiet and writes no pack after a rich title', async () => {
  const cwd = searchWorkspace();
  const output = [];
  const status = await youtubeCommand(['search', 'omakase', '--json'], {
    ...cacheDeps(),
    cwd,
    output: (line) => output.push(line),
    runner: () => ({
      status: 0,
      stdout: `${RICH_SEARCH_LINE}\n`,
    }),
  });

  assert.equal(status, 0);
  const parsed = JSON.parse(output.join('\n'));
  assert.equal(parsed[0].url, 'https://youtu.be/omakase1');
  assert.doesNotMatch(output.join('\n'), /^check:/m);
  assert.doesNotMatch(output.join('\n'), /score: 0/);
  assert.doesNotMatch(output.join('\n'), /next: atris experiments keep/);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube teach/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, searchApplyRel('omakase'))), false);
});

test('rich youtube search mints a measure.py that validate.py accepts and scores 0 or 1 honestly', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = searchWorkspace();
  const output = [];
  const status = await youtubeCommand(['search', 'omakase'], {
    ...cacheDeps(),
    cwd,
    now: '2026-09-08',
    output: (line) => output.push(line),
    runner: () => ({
      status: 0,
      stdout: `${RICH_SEARCH_LINE}\n`,
    }),
  });

  assert.equal(status, 0);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(output.join('\n'), /next: atris experiments keep search-omakase/);
  const packDir = path.join(cwd, 'atris', 'experiments', 'search-omakase');
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

  const claim = assertSearchApplyClaimable(cwd, {
    query: 'omakase',
    tokens: ['omakase model', 'what is the omakase model?'],
    date: '2026-09-08',
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

test('youtube search --json prints parsed rows', async () => {
  const output = [];
  const status = await youtubeCommand(['search', 'agents', '--json'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    runner: () => ({
      status: 0,
      stdout: 'Title One | Chan | 1:00 | 10 | 20260101 | https://youtu.be/one123\n',
    }),
  });

  assert.equal(status, 0);
  const text = output.join('\n');
  assert.doesNotMatch(text, /next: atris youtube teach/);
  assert.doesNotMatch(text, /next: atris youtube watch tick/);
  assert.doesNotMatch(text, /^check:/m);
  assert.doesNotMatch(text, /score: 0/);
  const parsed = JSON.parse(text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].url, 'https://youtu.be/one123');
  assert.equal(parsed[0].upload_date, '20260101');
});

test('youtube search missing query exits 2 with usage', async () => {
  const output = [];
  const status = await youtubeCommand(['search', '--limit', '3'], {
    output: (line) => output.push(line),
    runner: () => ({ status: 0, stdout: '' }),
  });
  assert.equal(status, 2);
  assert.match(output.join('\n'), /Missing query/);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube watch tick/);
});

test('youtube search empty results exits 2', async () => {
  const output = [];
  const fsMock = mockSearchFs();
  const status = await youtubeCommand(['search', 'nothing here'], {
    ...cacheDeps({ fs: fsMock }),
    output: (line) => output.push(line),
    runner: () => ({ status: 0, stdout: '\n' }),
  });
  assert.equal(status, 2);
  assert.match(output.join('\n'), /no videos found/);
  assert.equal(output.includes(WATCH_TICK_NEXT), true);
  assert.equal(output.filter((line) => String(line).startsWith('next:')).length, 1);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube teach/);
  assert.doesNotMatch(output.join('\n'), /^check:/m);
  assert.doesNotMatch(output.join('\n'), /score: 0/);
  assert.equal(fsMock.store[CACHE_PATH], undefined);
});

test('youtube search --json empty results stays json-only', async () => {
  const output = [];
  const status = await youtubeCommand(['search', 'nothing here', '--json'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    runner: () => ({ status: 0, stdout: '\n' }),
  });
  assert.equal(status, 2);
  assert.match(output.join('\n'), /no videos found/);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube watch tick/);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube teach/);
});

test('youtube search missing binary exits 2 without a watch-tick next-step', async () => {
  const output = [];
  const status = await youtubeCommand(['search', 'agents'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    runner: () => {
      const err = new Error('spawn yt-dlp ENOENT');
      err.code = 'ENOENT';
      return { error: err };
    },
  });
  assert.equal(status, 2);
  assert.match(output.join('\n'), /ytsearch and yt-dlp not found/);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube watch tick/);
});

test('youtube search runner failure surfaces stderr', async () => {
  const output = [];
  const status = await youtubeCommand(['search', 'fail case'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    runner: () => ({ status: 1, stdout: '', stderr: 'yt-dlp exploded' }),
  });
  assert.equal(status, 1);
  assert.match(output.join('\n'), /yt-dlp exploded/);
});

test('youtube search keeps printed rows when yt-dlp exits 429', async () => {
  const output = [];
  const sleeps = [];
  let runnerCalls = 0;
  const fsMock = mockSearchFs();
  const now = 1_700_000_000_000;
  const status = await youtubeCommand(['search', 'MCP agents 2026'], {
    ...cacheDeps({ fs: fsMock, now: () => now }),
    output: (line) => output.push(line),
    sleep: async (ms) => { sleeps.push(ms); },
    runner: () => {
      runnerCalls += 1;
      return {
        status: 1,
        stdout: `${SAMPLE_LINE}\n`,
        stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(runnerCalls, 1);
  assert.deepEqual(sleeps, []);
  const text = output.join('\n');
  assert.match(text, /https:\/\/youtu\.be\/mcp2026a/);
  assert.match(text, /MCP Agents in 2026/);
  assert.equal(output.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 0);
  assert.equal(output.includes(TEACH_NEXT_LINE), true);
  assert.doesNotMatch(text, /429|Too Many Requests|rate-limited|--paid|\/youtube\/search/);
  const cached = JSON.parse(fsMock.store[CACHE_PATH]);
  assert.equal(cached.query, 'MCP agents 2026');
  assert.deepEqual(cached.rows, [SAMPLE_ROW]);
});

test('youtube search retry keeps printed rows after a first empty 429', async () => {
  const cwd = searchWorkspace();
  const output = [];
  const sleeps = [];
  const calls = [];
  const status = await youtubeCommand(['search', 'omakase'], {
    ...cacheDeps(),
    cwd,
    now: '2026-09-08',
    output: (line) => output.push(line),
    sleep: async (ms) => { sleeps.push(ms); },
    runner: (query, limit) => {
      calls.push({ query, limit });
      if (calls.length === 1) {
        return {
          status: 1,
          stdout: '',
          stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
        };
      }
      return {
        status: 1,
        stdout: `${RICH_SEARCH_LINE}\n`,
        stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
      };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    { query: 'omakase', limit: 5 },
    { query: 'omakase', limit: 5 },
  ]);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(
    output.filter((line) => String(line).startsWith('next:')),
    [RICH_SEARCH_KEEP],
  );
  assert.equal(output.includes(RICH_TEACH_NEXT), false);
  assert.doesNotMatch(output.join('\n'), /429|Too Many Requests|rate-limited|--paid/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'search-omakase', 'measure.py')), true);
});

test('youtube search retries once after a 429 then prints videos', async () => {
  const output = [];
  const sleeps = [];
  let apiCalls = 0;
  const calls = [];
  const status = await youtubeCommand(['search', 'MCP agents 2026'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    sleep: async (ms) => { sleeps.push(ms); },
    apiRequestJson: async () => {
      apiCalls += 1;
      return { ok: false, status: 500, error: 'should not bill' };
    },
    runner: (query, limit) => {
      calls.push({ query, limit });
      if (calls.length === 1) {
        return {
          status: 1,
          stdout: '',
          stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
        };
      }
      return {
        status: 0,
        stdout: 'MCP Agents in 2026 | Dev Channel | 18:22 | 42000 | 20260820 | https://youtu.be/mcp2026a\n',
      };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    { query: 'MCP agents 2026', limit: 5 },
    { query: 'MCP agents 2026', limit: 5 },
  ]);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(apiCalls, 0);
  const text = output.join('\n');
  assert.match(text, /https:\/\/youtu\.be\/mcp2026a/);
  assert.match(text, /MCP Agents in 2026/);
  assert.equal(output.includes(TEACH_NEXT_LINE), true);
  assert.doesNotMatch(text, /429|Too Many Requests|\/youtube\/search|--paid/);
});

test('youtube search persistent 429 prints one sentence and stays off paid', async () => {
  const output = [];
  const sleeps = [];
  let apiCalls = 0;
  let runnerCalls = 0;
  const status = await youtubeCommand(['search', 'agents'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    sleep: async (ms) => { sleeps.push(ms); },
    apiRequestJson: async (pathname) => {
      apiCalls += 1;
      return { ok: false, status: 500, error: `unexpected ${pathname}` };
    },
    runner: () => {
      runnerCalls += 1;
      return {
        status: 1,
        stdout: '',
        stderr: 'ERROR: Sign in to confirm you’re not a bot',
      };
    },
  });

  assert.equal(status, 1);
  assert.equal(runnerCalls, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(apiCalls, 0);
  const text = output.join('\n');
  assert.equal(text.trim(), RATE_LIMIT_MESSAGE);
  assert.doesNotMatch(text, /\/youtube\/search/);
  assert.doesNotMatch(text, /Sign in to confirm|not a bot/);
  assert.doesNotMatch(text, /try --paid|run --paid|search --paid/);
  assert.doesNotMatch(text, /^check:/m);
  assert.doesNotMatch(text, /score: 0/);
  assert.equal(output.includes(WATCH_TICK_NEXT), false);
});

test('youtube search rate-limit retry still prints unrelated yt-dlp detail', async () => {
  const output = [];
  let runnerCalls = 0;
  const status = await youtubeCommand(['search', 'agents'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    sleep: async () => {},
    runner: () => {
      runnerCalls += 1;
      if (runnerCalls === 1) {
        return { status: 1, stdout: '', stderr: 'HTTP Error 429: Too Many Requests' };
      }
      return { status: 1, stdout: '', stderr: 'yt-dlp exploded' };
    },
  });
  assert.equal(status, 1);
  assert.equal(runnerCalls, 2);
  assert.match(output.join('\n'), /yt-dlp exploded/);
  assert.doesNotMatch(output.join('\n'), /rate-limited|--paid|\/youtube\/search/);
  assert.doesNotMatch(output.join('\n'), /^check:/m);
  assert.doesNotMatch(output.join('\n'), /score: 0/);
});

test('youtube search writes free local rows to cache', async () => {
  const output = [];
  const fsMock = mockSearchFs();
  const now = 1_700_000_000_000;
  const status = await youtubeCommand(['search', 'MCP agents 2026'], {
    ...cacheDeps({ fs: fsMock, now: () => now }),
    output: (line) => output.push(line),
    runner: () => ({ status: 0, stdout: `${SAMPLE_LINE}\n` }),
  });

  assert.equal(status, 0);
  assert.match(output.join('\n'), /https:\/\/youtu\.be\/mcp2026a/);
  const cached = JSON.parse(fsMock.store[CACHE_PATH]);
  assert.equal(cached.query, 'MCP agents 2026');
  assert.equal(cached.savedAt, now);
  assert.deepEqual(cached.rows, [SAMPLE_ROW]);
});

test('youtube search persistent 429 serves fresh same-query cache and stays off paid', async () => {
  const output = [];
  const sleeps = [];
  let apiCalls = 0;
  let runnerCalls = 0;
  const now = 1_700_000_000_000;
  const fsMock = mockSearchFs({
    [CACHE_PATH]: `${JSON.stringify({
      query: 'MCP agents 2026',
      savedAt: now - 10 * 60 * 1000,
      rows: [SAMPLE_ROW],
    })}\n`,
  });

  const status = await youtubeCommand(['search', 'mcp  agents 2026'], {
    ...cacheDeps({ fs: fsMock, now: () => now }),
    output: (line) => output.push(line),
    sleep: async (ms) => { sleeps.push(ms); },
    apiRequestJson: async (pathname) => {
      apiCalls += 1;
      return { ok: false, status: 500, error: `unexpected ${pathname}` };
    },
    runner: () => {
      runnerCalls += 1;
      return {
        status: 1,
        stdout: '',
        stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(runnerCalls, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(apiCalls, 0);
  const text = output.join('\n');
  assert.match(text, /MCP Agents in 2026 \| Dev Channel \| 18:22 \| 42000 \| 20260820 \| https:\/\/youtu\.be\/mcp2026a/);
  assert.match(text, new RegExp(CACHE_NOTE));
  assert.equal(output.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 0);
  assert.equal(output.filter((line) => String(line).startsWith('next:')).length, 1);
  assert.equal(output.includes(TEACH_NEXT_LINE), true);
  assert.ok(
    output.indexOf(`check: ${LEARNER_CHECK_FILL}`)
      < output.indexOf(TEACH_NEXT_LINE),
  );
  assert.ok(output.indexOf(TEACH_NEXT_LINE) < output.indexOf(CACHE_NOTE));
  assert.doesNotMatch(text, /\/youtube\/search|--paid|token/);
});

test('youtube search persistent 429 cache reprint mints a failing apply from a rich title', async () => {
  const cwd = searchWorkspace();
  const output = [];
  const now = 1_700_000_000_000;
  const richRow = {
    title: '37signals uses the omakase model',
    channel: 'Basecamp',
    duration: '12:00',
    views: '100',
    upload_date: '20260801',
    url: 'https://youtu.be/omakase1',
  };
  const fsMock = mockSearchFs({
    [CACHE_PATH]: `${JSON.stringify({
      query: 'omakase',
      savedAt: now - 10 * 60 * 1000,
      rows: [richRow],
    })}\n`,
  });

  const status = await youtubeCommand(['search', 'omakase'], {
    ...cacheDeps({ fs: fsMock, now: () => now }),
    cwd,
    output: (line) => output.push(line),
    sleep: async () => {},
    apiRequestJson: async (pathname) => {
      return { ok: false, status: 500, error: `unexpected ${pathname}` };
    },
    runner: () => ({
      status: 1,
      stdout: '',
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
  });

  assert.equal(status, 0);
  const text = output.join('\n');
  assert.match(text, /37signals uses the omakase model/);
  assert.match(text, new RegExp(CACHE_NOTE));
  assert.equal(output.filter((line) => line === 'check: what is the omakase model?').length, 0);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(
    output.filter((line) => String(line).startsWith('next:')),
    [RICH_SEARCH_KEEP],
  );
  assert.ok(output.indexOf(RICH_SEARCH_KEEP) < output.indexOf(LEARNER_SCORE_ZERO));
  assert.ok(output.indexOf(LEARNER_SCORE_ZERO) < output.indexOf(CACHE_NOTE));
  assert.equal(output.includes(RICH_TEACH_NEXT), false);
  assert.doesNotMatch(text, /\/youtube\/search|--paid|token|429|Too Many Requests/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'search-omakase', 'measure.py')), true);
});

test('youtube search persistent 429 cache reprint --json stays quiet on the learner check', async () => {
  const output = [];
  const now = 1_700_000_000_000;
  const fsMock = mockSearchFs({
    [CACHE_PATH]: `${JSON.stringify({
      query: 'omakase',
      savedAt: now - 10 * 60 * 1000,
      rows: [{
        title: '37signals uses the omakase model',
        channel: 'Basecamp',
        duration: '12:00',
        views: '100',
        upload_date: '20260801',
        url: 'https://youtu.be/omakase1',
      }],
    })}\n`,
  });

  const status = await youtubeCommand(['search', 'omakase', '--json'], {
    ...cacheDeps({ fs: fsMock, now: () => now }),
    output: (line) => output.push(line),
    sleep: async () => {},
    runner: () => ({
      status: 1,
      stdout: '',
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
  });

  assert.equal(status, 0);
  const text = output.join('\n');
  const parsed = JSON.parse(output[0]);
  assert.equal(parsed[0].title, '37signals uses the omakase model');
  assert.match(text, new RegExp(CACHE_NOTE));
  assert.doesNotMatch(text, /^check:/m);
  assert.doesNotMatch(text, /score: 0/);
  assert.doesNotMatch(text, /next: atris youtube teach/);
  assert.doesNotMatch(text, /\/youtube\/search|--paid/);
});

test('youtube search persistent 429 with expired cache keeps the rate-limit sentence', async () => {
  const output = [];
  let apiCalls = 0;
  const now = 1_700_000_000_000;
  const fsMock = mockSearchFs({
    [CACHE_PATH]: JSON.stringify({
      query: 'agents',
      savedAt: now - (60 * 60 * 1000) - 1,
      rows: [SAMPLE_ROW],
    }),
  });

  const status = await youtubeCommand(['search', 'agents'], {
    ...cacheDeps({ fs: fsMock, now: () => now }),
    output: (line) => output.push(line),
    sleep: async () => {},
    apiRequestJson: async (pathname) => {
      apiCalls += 1;
      return { ok: false, status: 500, error: `unexpected ${pathname}` };
    },
    runner: () => ({
      status: 1,
      stdout: '',
      stderr: 'ERROR: Sign in to confirm you’re not a bot',
    }),
  });

  assert.equal(status, 1);
  assert.equal(apiCalls, 0);
  assert.equal(output.join('\n').trim(), RATE_LIMIT_MESSAGE);
});

test('youtube search persistent 429 with a different cached query keeps the rate-limit sentence', async () => {
  const output = [];
  const fsMock = mockSearchFs({
    [CACHE_PATH]: JSON.stringify({
      query: 'other topic',
      savedAt: Date.now(),
      rows: [SAMPLE_ROW],
    }),
  });

  const status = await youtubeCommand(['search', 'agents'], {
    ...cacheDeps({ fs: fsMock }),
    output: (line) => output.push(line),
    sleep: async () => {},
    runner: () => ({
      status: 1,
      stdout: '',
      stderr: 'HTTP Error 429: Too Many Requests',
    }),
  });

  assert.equal(status, 1);
  assert.equal(output.join('\n').trim(), RATE_LIMIT_MESSAGE);
});

test('youtube search persistent 429 with corrupt cache keeps the rate-limit sentence', async () => {
  const output = [];
  const fsMock = mockSearchFs({
    [CACHE_PATH]: '{not-json',
  });

  const status = await youtubeCommand(['search', 'agents'], {
    ...cacheDeps({ fs: fsMock }),
    output: (line) => output.push(line),
    sleep: async () => {},
    runner: () => ({
      status: 1,
      stdout: '',
      stderr: 'HTTP Error 429: Too Many Requests',
    }),
  });

  assert.equal(status, 1);
  assert.equal(output.join('\n').trim(), RATE_LIMIT_MESSAGE);
});

test('youtube search --paid refuses on a fresh free-cache hit and does not bill', async () => {
  const now = 1_700_000_000_000;
  const fsMock = mockSearchFs({
    [CACHE_PATH]: `${JSON.stringify({
      query: 'MCP agents 2026',
      savedAt: now - 10 * 60 * 1000,
      rows: [SAMPLE_ROW],
    })}\n`,
  });
  const before = fsMock.store[CACHE_PATH];
  const output = [];
  let apiCalls = 0;
  let authCalls = 0;

  const status = await youtubeCommand(['search', '--paid', 'mcp  agents 2026', '--limit', '5'], {
    ...cacheDeps({ fs: fsMock, now: () => now }),
    output: (line) => output.push(line),
    runner: () => ({ status: 0, stdout: '' }),
    ensureBilledCommandAuth: async () => {
      authCalls += 1;
      return { ok: true, token: 'should-not-mint' };
    },
    ensureValidCredentials: async () => ({ credentials: { token: 'should-not-use' } }),
    apiRequestJson: async (pathname) => {
      apiCalls += 1;
      return { ok: false, status: 500, error: `unexpected ${pathname}` };
    },
  });

  assert.equal(status, 2);
  assert.equal(apiCalls, 0);
  assert.equal(authCalls, 0);
  assert.equal(fsMock.store[CACHE_PATH], before);
  assert.equal(output.join('\n').trim(), PAID_CACHE_REFUSE);
  assert.doesNotMatch(output.join('\n'), /credits|\/youtube\/search|token|burn|should-not/i);
  assert.equal(output.includes(WATCH_TICK_NEXT), false);
});

test('youtube search --paid proceeds when the free cache is absent', async () => {
  const output = [];
  const calls = [];
  const fsMock = mockSearchFs();

  const status = await youtubeCommand(['search', '--paid', 'MCP agents', '--limit', '5'], {
    ...cacheDeps({ fs: fsMock }),
    output: (line) => output.push(line),
    runner: () => ({ status: 0, stdout: '' }),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          status: 'success',
          credits_used: 5,
          credits_remaining: 995,
          data: {
            results: [
              { title: 'Paid Only', url: 'https://www.youtube.com/watch?v=paid111' },
            ],
          },
        },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/youtube/search');
  assert.equal(fsMock.store[CACHE_PATH], undefined);
  assert.match(output.join('\n'), /Paid Only \| https:\/\/www\.youtube\.com\/watch\?v=paid111/);
});

test('youtube search --paid proceeds when the free cache is stale', async () => {
  const now = 1_700_000_000_000;
  const fsMock = mockSearchFs({
    [CACHE_PATH]: JSON.stringify({
      query: 'MCP agents',
      savedAt: now - (60 * 60 * 1000) - 1,
      rows: [SAMPLE_ROW],
    }),
  });
  const before = fsMock.store[CACHE_PATH];
  const output = [];
  const calls = [];

  const status = await youtubeCommand(['search', '--paid', 'MCP agents'], {
    ...cacheDeps({ fs: fsMock, now: () => now }),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          status: 'success',
          credits_used: 5,
          credits_remaining: 990,
          data: {
            results: [
              { title: 'Stale Cache Paid', url: 'https://www.youtube.com/watch?v=stale01' },
            ],
          },
        },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/youtube/search');
  assert.equal(fsMock.store[CACHE_PATH], before);
  assert.match(output.join('\n'), /Stale Cache Paid \| https:\/\/www\.youtube\.com\/watch\?v=stale01/);
  assert.doesNotMatch(output.join('\n'), new RegExp(PAID_CACHE_REFUSE));
});

test('youtube search --paid posts /youtube/search and prints titles, permalinks, credits', async () => {
  const calls = [];
  const output = [];
  let runnerCalls = 0;

  const status = await youtubeCommand(['search', '--paid', 'MCP agents', '--limit', '5'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    runner: () => {
      runnerCalls += 1;
      return { status: 0, stdout: '' };
    },
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          status: 'success',
          credits_used: 5,
          credits_remaining: 995,
          data: {
            results: [
              { title: 'MCP Agents in 2026', url: 'https://www.youtube.com/watch?v=mcp2026a' },
              { title: 'Agent Stack Tour', permalink: 'https://www.youtube.com/watch?v=mcp2026b' },
            ],
          },
        },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(runnerCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/youtube/search');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.token, 'token-123');
  assert.equal(calls[0].options.retries, 0);
  assert.deepEqual(calls[0].options.body, { query: 'MCP agents', limit: 5 });

  const text = output.join('\n');
  assert.match(text, /MCP Agents in 2026 \| https:\/\/www\.youtube\.com\/watch\?v=mcp2026a/);
  assert.match(text, /Agent Stack Tour \| https:\/\/www\.youtube\.com\/watch\?v=mcp2026b/);
  assert.match(text, /Credits: 5 used, 995 remaining/);
  assert.doesNotMatch(text, /token-123/);
  assert.equal(output.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 0);
  assert.doesNotMatch(text, /what is the point of|invented/);
  assert.equal(output.includes(APPLY_NEXT_MESSAGE), false);
  assert.equal(output.filter((line) => String(line).startsWith('next:')).length, 1);
  assert.equal(output.includes('next: atris youtube teach "https://www.youtube.com/watch?v=mcp2026a"'), true);
  assert.ok(
    output.indexOf(`check: ${LEARNER_CHECK_FILL}`)
      < output.indexOf('next: atris youtube teach "https://www.youtube.com/watch?v=mcp2026a"'),
  );
  assert.equal(output.includes(WATCH_TICK_NEXT), false);
});

test('youtube search --paid prints keep next and score 0 after a rich title', async () => {
  const cwd = searchWorkspace();
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'omakase'], {
    ...cacheDeps(),
    cwd,
    now: '2026-09-08',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: {
        status: 'success',
        credits_used: 5,
        credits_remaining: 990,
        data: {
          results: [
            {
              title: '37signals uses the omakase model',
              url: 'https://www.youtube.com/watch?v=omakase1',
            },
          ],
        },
      },
    }),
  });

  assert.equal(status, 0);
  assert.match(output.join('\n'), /37signals uses the omakase model/);
  assert.equal(output.filter((line) => line === 'check: what is the omakase model?').length, 0);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(
    output.filter((line) => String(line).startsWith('next:')),
    [RICH_SEARCH_KEEP],
  );
  assert.ok(output.indexOf(RICH_SEARCH_KEEP) < output.indexOf(LEARNER_SCORE_ZERO));
  assert.equal(
    output.includes('next: atris youtube teach "https://www.youtube.com/watch?v=omakase1"'),
    false,
  );
  assert.equal(output.includes(APPLY_NEXT_MESSAGE), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'search-omakase', 'measure.py')), true);
  assertSearchApplyClaimable(cwd, {
    query: 'omakase',
    tokens: ['omakase model', 'what is the omakase model?'],
    date: '2026-09-08',
  });
});

test('rich paid youtube search mints a measure.py that validate.py accepts and scores 0 or 1 honestly', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = searchWorkspace();
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'omakase'], {
    ...cacheDeps(),
    cwd,
    now: '2026-09-08',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: {
        status: 'success',
        credits_used: 5,
        data: {
          results: [
            {
              title: '37signals uses the omakase model',
              url: 'https://www.youtube.com/watch?v=omakase1',
            },
          ],
        },
      },
    }),
  });

  assert.equal(status, 0);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(output.join('\n'), /next: atris experiments keep search-omakase/);
  const packDir = path.join(cwd, 'atris', 'experiments', 'search-omakase');
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

  const claim = assertSearchApplyClaimable(cwd, {
    query: 'omakase',
    tokens: ['omakase model', 'what is the omakase model?'],
    date: '2026-09-08',
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

test('youtube search --paid --json stays quiet and writes no pack after a rich title', async () => {
  const cwd = searchWorkspace();
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'omakase', '--json'], {
    ...cacheDeps(),
    cwd,
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: {
        status: 'success',
        credits_used: 5,
        data: {
          results: [
            {
              title: '37signals uses the omakase model',
              url: 'https://www.youtube.com/watch?v=omakase2',
            },
          ],
        },
      },
    }),
  });
  assert.equal(status, 0);
  const text = output.join('\n');
  const parsed = JSON.parse(text);
  assert.equal(parsed.data.results[0].title, '37signals uses the omakase model');
  assert.doesNotMatch(text, /^check:/m);
  assert.doesNotMatch(text, /score: 0/);
  assert.doesNotMatch(text, /next: atris experiments keep/);
  assert.doesNotMatch(text, /next: atris youtube teach/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, searchApplyRel('omakase'))), false);
});

test('youtube search --paid --json prints the raw payload', async () => {
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'hello', '--json'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: {
        status: 'success',
        credits_used: 5,
        data: { results: [{ title: 'Hi', url: 'https://www.youtube.com/watch?v=hi1234' }] },
      },
    }),
  });
  assert.equal(status, 0);
  const text = output.join('\n');
  assert.doesNotMatch(text, /next: atris youtube teach/);
  assert.doesNotMatch(text, /next: atris youtube watch tick/);
  assert.doesNotMatch(text, /^check:/m);
  assert.doesNotMatch(text, /score: 0/);
  const parsed = JSON.parse(text);
  assert.equal(parsed.credits_used, 5);
  assert.equal(parsed.data.results[0].title, 'Hi');
});

test('youtube search --paid --json empty results stays json-only', async () => {
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'nothing here', '--json'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { status: 'success', credits_used: 0, credits_remaining: 1000, data: { results: [] } },
    }),
  });
  assert.equal(status, 0);
  const text = output.join('\n');
  assert.doesNotMatch(text, /next: atris youtube watch tick/);
  assert.doesNotMatch(text, /next: atris youtube teach/);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.data.results, []);
});

test('youtube search --paid empty results prints credits and exits 2', async () => {
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'nothing here'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { status: 'success', credits_used: 0, credits_remaining: 1000, data: { results: [] } },
    }),
  });
  assert.equal(status, 2);
  assert.match(output.join('\n'), /no videos found/);
  assert.match(output.join('\n'), /Credits: 0 used, 1000 remaining/);
  assert.doesNotMatch(output.join('\n'), /credits refunded/);
  assert.equal(output.includes(WATCH_TICK_NEXT), true);
  assert.equal(output.filter((line) => String(line).startsWith('next:')).length, 1);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube teach/);
  assert.doesNotMatch(output.join('\n'), /^check:/m);
  assert.doesNotMatch(output.join('\n'), /score: 0/);
  assert.equal(output.includes(APPLY_NEXT_MESSAGE), false);
});

test('empty paid youtube search surfaces a server-side refund and does not invent a refund call', async () => {
  const calls = [];
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'quiet topic'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          status: 'success',
          credits_used: 0,
          credits_remaining: 1000,
          credits_refunded: 5,
          data: { results: [] },
        },
      };
    },
  });

  assert.equal(status, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/youtube/search');
  assert.equal(output.includes(APPLY_NEXT_MESSAGE), false);
  const text = output.join('\n');
  assert.match(text, /no videos found/);
  assert.match(text, /Credits: 0 used, 1000 remaining/);
  assert.match(text, /credits refunded/);
  assert.equal(output.includes(WATCH_TICK_NEXT), true);
  assert.doesNotMatch(text, /next: atris youtube teach/);
});

test('502 paid youtube search with refunded credits surfaces them and does not invent a refund call', async () => {
  const calls = [];
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'agents'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: false,
        status: 502,
        error: 'Search failed',
        data: {
          error: 'Search failed',
          credits_used: 0,
          credits_remaining: 1000,
          credits_refunded: 5,
        },
      };
    },
  });

  assert.equal(status, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/youtube/search');
  assert.equal(output.includes(APPLY_NEXT_MESSAGE), false);
  const text = output.join('\n');
  assert.match(text, /502/);
  assert.match(text, /credits refunded/);
  assert.match(text, /Credits: 0 used, 1000 remaining/);
  assert.doesNotMatch(text, /next: atris youtube watch tick/);
});

test('502 paid youtube search with unused credits does not claim a refund', async () => {
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'agents'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: false,
      status: 502,
      error: 'Search failed',
      data: {
        error: 'Search failed',
        credits_used: 0,
        credits_remaining: 1000,
      },
    }),
  });
  assert.equal(status, 1);
  const text = output.join('\n');
  assert.match(text, /502/);
  assert.match(text, /unavailable|retry/i);
  assert.match(text, /Credits: 0 used, 1000 remaining/);
  assert.doesNotMatch(text, /credits refunded/);
  assert.doesNotMatch(text, /next: atris youtube watch tick/);
  assert.doesNotMatch(text, /^check:/m);
  assert.doesNotMatch(text, /score: 0/);
});

test('youtube search --paid surfaces 401 login hint', async () => {
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'agents'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    loadCredentials: () => ({ token: 't' }),
    apiRequestJson: async () => ({
      ok: false,
      status: 401,
      error: 'Not authenticated',
    }),
  });
  assert.equal(status, 1);
  assert.match(output.join('\n'), /401/);
  assert.match(output.join('\n'), /atris login --force/);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube watch tick/);
});

test('youtube search --paid surfaces 402 credits hint', async () => {
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'agents'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: false,
      status: 402,
      error: 'Insufficient credits',
    }),
  });
  assert.equal(status, 1);
  assert.match(output.join('\n'), /402/);
  assert.match(output.join('\n'), /Check Atris credits/);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube watch tick/);
});

test('402 paid youtube search with unused credits does not claim a refund', async () => {
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'agents'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: false,
      status: 402,
      error: 'Insufficient credits',
      data: {
        error: 'Insufficient credits',
        credits_used: 0,
        credits_remaining: 0,
      },
    }),
  });
  assert.equal(status, 1);
  const text = output.join('\n');
  assert.match(text, /402/);
  assert.match(text, /Check Atris credits/);
  assert.match(text, /Credits: 0 used, 0 remaining/);
  assert.doesNotMatch(text, /credits refunded/);
  assert.doesNotMatch(text, /next: atris youtube watch tick/);
});

test('401 paid youtube search with unused credits does not claim a refund', async () => {
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'agents'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    loadCredentials: () => ({ token: 't' }),
    apiRequestJson: async () => ({
      ok: false,
      status: 401,
      error: 'Not authenticated',
      data: {
        error: 'Not authenticated',
        credits_used: 0,
        credits_remaining: 50,
      },
    }),
  });
  assert.equal(status, 1);
  const text = output.join('\n');
  assert.match(text, /401/);
  assert.match(text, /atris login --force/);
  assert.match(text, /Credits: 0 used, 50 remaining/);
  assert.doesNotMatch(text, /credits refunded/);
});

test('402 paid youtube search still prints an explicit refund', async () => {
  const output = [];
  const status = await youtubeCommand(['search', '--paid', 'agents'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: false,
      status: 402,
      error: 'Insufficient credits',
      data: {
        error: 'Insufficient credits',
        credits_used: 0,
        credits_remaining: 5,
        credits_refunded: 5,
      },
    }),
  });
  assert.equal(status, 1);
  const text = output.join('\n');
  assert.match(text, /Credits: 0 used, 5 remaining/);
  assert.match(text, /credits refunded/);
});

test('youtube search --paid mints only the youtube scope after an expired user wall and retries', async () => {
  const calls = [];
  const persisted = [];
  const output = [];
  const secret = 'minted-youtube-search-secret';

  const status = await youtubeCommand(['search', '--paid', 'MCP agents'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ error: 'token_invalid', detail: 'Token expired' }),
    loadCredentials: () => ({
      token: 'user-jwt',
      refresh_token: 'refresh-jwt',
      email: 'owner@example.com',
    }),
    persistMintedAgentToken: (_credentials, token) => {
      persisted.push(token);
    },
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      if (pathname === '/auth/agent-token') {
        return {
          ok: true,
          status: 200,
          data: { access_token: secret, scopes: ['youtube'], daily_credit_cap: 50 },
        };
      }
      return {
        ok: true,
        status: 200,
        data: {
          credits_used: 5,
          data: { results: [{ title: 'ok from mint', url: 'https://www.youtube.com/watch?v=minted1' }] },
        },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls[0].pathname, '/auth/agent-token');
  assert.equal(calls[0].options.token, 'user-jwt');
  assert.deepEqual(calls[0].options.body.scopes, ['youtube']);
  assert.equal(calls[0].options.body.scopes.includes('x-search'), false);
  assert.equal(calls[1].pathname, '/youtube/search');
  assert.equal(calls[1].options.token, secret);
  assert.deepEqual(persisted, [secret]);
  assert.match(output.join('\n'), /ok from mint/);
  assert.match(output.join('\n'), /https:\/\/www\.youtube\.com\/watch\?v=minted1/);
  assert.doesNotMatch(output.join('\n'), new RegExp(secret));
  assert.doesNotMatch(output.join('\n'), /\/auth\/cli|Choose login method|Opening browser/);
});

test('youtube search --paid remints after a billed 401 and retries once', async () => {
  const calls = [];
  const secret = 'minted-after-401-yt-search';
  const status = await youtubeCommand(['search', '--paid', 'agents'], {
    ...cacheDeps(),
    output: () => {},
    ensureValidCredentials: async () => ({ credentials: { token: 'user-jwt' } }),
    loadCredentials: () => ({ token: 'user-jwt', refresh_token: 'refresh-jwt' }),
    persistMintedAgentToken: () => {},
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, token: options.token, body: options.body });
      if (pathname === '/youtube/search' && options.token === 'user-jwt') {
        return { ok: false, status: 401, error: 'agent token required' };
      }
      if (pathname === '/auth/agent-token') {
        assert.deepEqual(options.body.scopes, ['youtube']);
        return { ok: true, status: 200, data: { access_token: secret, scopes: ['youtube'] } };
      }
      return {
        ok: true,
        status: 200,
        data: { data: { results: [{ title: 'retried', url: 'https://www.youtube.com/watch?v=retry1' }] } },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls[0].pathname, '/youtube/search');
  assert.equal(calls[0].token, 'user-jwt');
  assert.equal(calls[1].pathname, '/auth/agent-token');
  assert.equal(calls[2].pathname, '/youtube/search');
  assert.equal(calls[2].token, secret);
});

test('youtube search --paid with no stored JWT fails in one sentence and stays off the login wall', async () => {
  const output = [];
  let apiCalls = 0;
  let runnerCalls = 0;
  const status = await youtubeCommand(['search', '--paid', 'agents'], {
    ...cacheDeps(),
    output: (line) => output.push(line),
    runner: () => {
      runnerCalls += 1;
      return { status: 0, stdout: '' };
    },
    ensureValidCredentials: async () => ({ error: 'not_logged_in' }),
    loadCredentials: () => null,
    apiRequestJson: async () => {
      apiCalls += 1;
      return { ok: true, status: 200, data: {} };
    },
  });
  assert.equal(status, 1);
  assert.equal(apiCalls, 0);
  assert.equal(runnerCalls, 0);
  assert.equal(output.join('\n').trim(), 'not signed in. run atris login first.');
  assert.doesNotMatch(output.join('\n'), /\/auth\/cli|Choose login method|Opening browser|https:\/\//);
});
