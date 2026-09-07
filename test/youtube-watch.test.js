const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  normalizeWatchChannel,
  channelVideosUrl,
  parseFlatPlaylist,
  loadWatchState,
  watchExperimentSlug,
  firstRichWatchLesson,
  LEARNER_CHECK_FILL,
  LEARNER_SCORE_ZERO,
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

function tempCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-'));
}

function statePathFor(cwd) {
  return path.join(cwd, '.atris', 'state', 'youtube_watch.json');
}

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

function assertWatchApplyClaimable(cwd, { id = 'new1', date = '2026-08-15', tokens = [] } = {}) {
  const packRel = `atris/experiments/${watchExperimentSlug(id)}`;
  const applyRel = `atris/wiki/briefs/watch-${id}.apply.md`;
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

test('normalizeWatchChannel turns @handle and /videos urls into a channel key', () => {
  assert.equal(normalizeWatchChannel('@veritasium'), 'https://www.youtube.com/@veritasium');
  assert.equal(
    normalizeWatchChannel('https://www.youtube.com/@mkbhd/videos'),
    'https://www.youtube.com/@mkbhd',
  );
  assert.equal(
    channelVideosUrl('https://www.youtube.com/@veritasium'),
    'https://www.youtube.com/@veritasium/videos',
  );
});

test('parseFlatPlaylist reads id|title rows and skips junk', () => {
  const videos = parseFlatPlaylist([
    'aaa|Newest video',
    '',
    'NA|skip',
    'bbb|Older video',
  ].join('\n'));
  assert.deepEqual(videos, [
    { id: 'aaa', title: 'Newest video' },
    { id: 'bbb', title: 'Older video' },
  ]);
});

test('watch add/list/remove round-trip', async () => {
  const cwd = tempCwd();
  const added = collect();
  const now = '2026-08-15T19:00:00.000Z';

  const addStatus = await youtubeCommand(['watch', 'add', '@veritasium'], {
    cwd,
    now,
    output: added.output,
  });
  assert.equal(addStatus, 0);

  const urlStatus = await youtubeCommand(['watch', 'add', 'https://www.youtube.com/@mkbhd/videos'], {
    cwd,
    now,
    output: () => {},
  });
  assert.equal(urlStatus, 0);

  const state = JSON.parse(fs.readFileSync(statePathFor(cwd), 'utf8'));
  assert.deepEqual(state.channels, [
    { channel: 'https://www.youtube.com/@veritasium', added: now },
    { channel: 'https://www.youtube.com/@mkbhd', added: now },
  ]);
  assert.match(added.text(), /watching https:\/\/www\.youtube\.com\/@veritasium/);
  assert.deepEqual(
    added.text().split('\n').filter((line) => line.startsWith('next: atris youtube watch tick')),
    ['next: atris youtube watch tick'],
  );

  const listed = collect();
  const listStatus = await youtubeCommand(['watch', 'list'], { cwd, output: listed.output });
  assert.equal(listStatus, 0);
  assert.match(listed.text(), /1\. https:\/\/www\.youtube\.com\/@veritasium \(0 seen\)/);
  assert.match(listed.text(), /2\. https:\/\/www\.youtube\.com\/@mkbhd \(0 seen\)/);
  assert.deepEqual(
    listed.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube watch tick'],
  );
  assert.equal(
    listed.text().includes('next: atris youtube watch add <channel-url-or-@handle>'),
    false,
  );

  const removed = collect();
  const removeStatus = await youtubeCommand(['watch', 'remove', '1'], {
    cwd,
    output: removed.output,
  });
  assert.equal(removeStatus, 0);
  assert.match(removed.text(), /removed https:\/\/www\.youtube\.com\/@veritasium/);
  assert.deepEqual(
    removed.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube watch tick'],
  );
  assert.equal(
    removed.text().includes('next: atris youtube watch add <channel-url-or-@handle>'),
    false,
  );

  const after = loadWatchState(statePathFor(cwd));
  assert.equal(after.channels.length, 1);
  assert.equal(after.channels[0].channel, 'https://www.youtube.com/@mkbhd');
});

test('tick briefs only unseen videos', async () => {
  const cwd = tempCwd();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-notes-'));
  const now = '2026-08-15T19:10:00.000Z';
  await youtubeCommand(['watch', 'add', '@veritasium'], { cwd, now, output: () => {} });

  const ran = [];
  const briefed = [];
  const first = collect();
  const firstStatus = await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: first.output,
    fetcher: () => [
      { id: 'new1', title: 'Newest' },
      { id: 'old1', title: 'Older' },
      { id: 'old2', title: 'Oldest' },
    ],
    runner: (url) => {
      ran.push(url);
      return { status: 0 };
    },
    briefFiler: ({ url }) => briefed.push(url),
  });
  assert.equal(firstStatus, 0);
  assert.deepEqual(ran, ['https://www.youtube.com/watch?v=new1']);
  assert.equal(first.lines.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(first.lines.includes(LEARNER_SCORE_ZERO), false);
  assert.equal(first.lines.includes(ephemeralApplyMessage('watch')), false);
  assert.deepEqual(
    first.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube teach "https://www.youtube.com/watch?v=new1"'],
  );
  assert.equal(first.text().includes('next: atris youtube watch add'), false);
  assert.equal(first.text().includes('next: atris youtube search'), false);

  ran.length = 0;
  briefed.length = 0;
  const second = collect();
  const secondStatus = await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: second.output,
    fetcher: () => [
      { id: 'new2', title: 'Brand new' },
      { id: 'new1', title: 'Newest' },
      { id: 'old1', title: 'Older' },
    ],
    runner: (url) => {
      ran.push(url);
      return { status: 0 };
    },
    briefFiler: ({ url }) => briefed.push(url),
  });
  assert.equal(secondStatus, 0);
  assert.deepEqual(ran, ['https://www.youtube.com/watch?v=new2']);
  assert.deepEqual(briefed, ['https://www.youtube.com/watch?v=new2']);
  assert.match(second.text(), /channel https:\/\/www\.youtube\.com\/@veritasium: 1 new, 1 briefed/);
  assert.match(second.text(), /total: 1 new, 1 briefed/);
  assert.equal(second.lines.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(second.lines.includes(LEARNER_SCORE_ZERO), false);
  assert.equal(second.lines.includes(ephemeralApplyMessage('watch')), false);
  assert.deepEqual(
    second.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube teach "https://www.youtube.com/watch?v=new2"'],
  );
  assert.equal(second.text().includes('next: atris youtube watch add'), false);
  assert.equal(second.text().includes('next: atris youtube search'), false);

  const state = loadWatchState(statePathFor(cwd));
  assert.equal(state.seen.new1, now);
  assert.equal(state.seen.new2, now);
  assert.equal(state.seen.old1, now);
  assert.equal(state.seen.old2, now);
});

test('fresh-channel seeding briefs only newest', async () => {
  const cwd = tempCwd();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-notes-'));
  const now = '2026-08-15T19:20:00.000Z';
  await youtubeCommand(['watch', 'add', 'https://www.youtube.com/@mkbhd'], {
    cwd,
    now,
    output: () => {},
  });

  const fetched = [];
  const ran = [];
  const briefed = [];
  const out = collect();
  const status = await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: out.output,
    fetcher: (url) => {
      fetched.push(url);
      return [
        { id: 'aaa', title: 'Newest' },
        { id: 'bbb', title: 'Middle' },
        { id: 'ccc', title: 'Oldest' },
      ];
    },
    runner: (url) => {
      ran.push(url);
      return { status: 0 };
    },
    briefFiler: ({ url }) => briefed.push(url),
  });

  assert.equal(status, 0);
  assert.deepEqual(fetched, ['https://www.youtube.com/@mkbhd/videos']);
  assert.deepEqual(ran, ['https://www.youtube.com/watch?v=aaa']);
  assert.deepEqual(briefed, ['https://www.youtube.com/watch?v=aaa']);
  assert.match(out.text(), /channel https:\/\/www\.youtube\.com\/@mkbhd: 1 new, 1 briefed/);
  assert.equal(out.lines.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(out.lines.includes(LEARNER_SCORE_ZERO), false);
  assert.equal(out.lines.includes(ephemeralApplyMessage('watch')), false);
  assert.deepEqual(
    out.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube teach "https://www.youtube.com/watch?v=aaa"'],
  );
  assert.equal(out.text().includes('next: atris youtube watch add'), false);
  assert.equal(out.text().includes('next: atris youtube search'), false);

  const state = loadWatchState(statePathFor(cwd));
  assert.equal(state.seen.aaa, now);
  assert.equal(state.seen.bbb, now);
  assert.equal(state.seen.ccc, now);
  assert.equal(state.seeded['https://www.youtube.com/@mkbhd'], true);

  const listed = collect();
  await youtubeCommand(['watch', 'list'], { cwd, output: listed.output });
  assert.match(listed.text(), /1\. https:\/\/www\.youtube\.com\/@mkbhd \(3 seen\)/);
});

test('watch tick keeps printed videos when yt-dlp exits 429', async () => {
  const cwd = tempCwd();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-notes-'));
  const now = '2026-08-15T19:30:00.000Z';
  await youtubeCommand(['watch', 'add', '@mkbhd'], { cwd, now, output: () => {} });

  const ran = [];
  const briefed = [];
  const out = collect();
  const status = await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: out.output,
    spawnSync: (cmd, args) => {
      assert.equal(cmd, 'yt-dlp');
      assert.equal(args.includes('--no-warnings'), true);
      assert.equal(args.includes('--flat-playlist'), true);
      return {
        status: 1,
        stdout: 'new1|Partial Upload\n',
        stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
      };
    },
    runner: (url) => {
      ran.push(url);
      return { status: 0 };
    },
    briefFiler: ({ url }) => briefed.push(url),
  });

  assert.equal(status, 0);
  assert.deepEqual(ran, ['https://www.youtube.com/watch?v=new1']);
  assert.deepEqual(briefed, ['https://www.youtube.com/watch?v=new1']);
  assert.match(out.text(), /channel https:\/\/www\.youtube\.com\/@mkbhd: 1 new, 1 briefed/);
  assert.match(out.text(), /total: 1 new, 1 briefed/);
  assert.doesNotMatch(out.text(), /fetch failed|429|Too Many Requests/);
});

test('failed fetch skips channel and continues', async () => {
  const cwd = tempCwd();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-notes-'));
  const now = '2026-08-15T19:30:00.000Z';
  await youtubeCommand(['watch', 'add', '@broken'], { cwd, now, output: () => {} });
  await youtubeCommand(['watch', 'add', '@ok'], { cwd, now, output: () => {} });

  const ran = [];
  const out = collect();
  const status = await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: out.output,
    fetcher: (url) => {
      if (url.includes('@broken')) throw new Error('network down');
      return [{ id: 'ok1', title: 'Fine' }];
    },
    runner: (url) => {
      ran.push(url);
      return { status: 0 };
    },
    briefFiler: () => {},
  });

  assert.equal(status, 0);
  assert.match(out.text(), /warning: channel https:\/\/www\.youtube\.com\/@broken fetch failed/);
  assert.match(out.text(), /channel https:\/\/www\.youtube\.com\/@ok: 1 new, 1 briefed/);
  assert.match(out.text(), /total: 1 new, 1 briefed/);
  assert.deepEqual(ran, ['https://www.youtube.com/watch?v=ok1']);
  assert.equal(out.lines.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(out.lines.includes(LEARNER_SCORE_ZERO), false);
  assert.equal(out.lines.includes(ephemeralApplyMessage('watch')), false);
  assert.deepEqual(
    out.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube teach "https://www.youtube.com/watch?v=ok1"'],
  );
  assert.equal(out.text().includes('next: atris youtube watch add'), false);
  assert.equal(out.text().includes('next: atris youtube search'), false);

  const state = loadWatchState(statePathFor(cwd));
  assert.equal(state.seeded['https://www.youtube.com/@broken'], undefined);
  assert.equal(state.seen.ok1, now);
});

test('tick that briefed a rich lesson prints apply check then teach next', async () => {
  const cwd = tempCwd();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-notes-'));
  const now = '2026-08-15T19:32:00.000Z';
  await youtubeCommand(['watch', 'add', '@veritasium'], { cwd, now, output: () => {} });
  fs.writeFileSync(path.join(workDir, 'yt_new1.md'), 'TSMC prints at 2nm\n');

  const out = collect();
  const status = await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: out.output,
    fetcher: () => [{ id: 'new1', title: 'Newest' }],
    runner: () => ({ status: 0 }),
    briefFiler: () => {},
  });

  const keepNext = 'next: atris experiments keep watch-new1';
  assert.equal(status, 0);
  assert.match(out.text(), /total: 1 new, 1 briefed/);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('watch')).length, 0);
  assert.doesNotMatch(out.text(), /^check:/m);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(
    out.text().split('\n').filter((line) => line.startsWith('next:')),
    [keepNext],
  );
  assert.ok(out.lines.indexOf('total: 1 new, 1 briefed') < out.lines.indexOf(keepNext));
  assert.ok(out.lines.indexOf(keepNext) < out.lines.indexOf(LEARNER_SCORE_ZERO));
  assert.doesNotMatch(out.text(), /next: atris youtube teach/);
  const claim = assertWatchApplyClaimable(cwd, { tokens: ['2nm', 'what is 2nm?'] });
  assert.equal(fs.existsSync(path.join(cwd, claim.packRel, 'measure.py')), true);
});

test('tick that briefed a thin lesson prints fill-this then teach next', async () => {
  const cwd = tempCwd();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-notes-'));
  const now = '2026-08-15T19:33:00.000Z';
  await youtubeCommand(['watch', 'add', '@veritasium'], { cwd, now, output: () => {} });
  fs.writeFileSync(path.join(workDir, 'yt_thin1.md'), '# Chat\n\nwelcome back friends this is just a chat\n');

  const out = collect();
  const status = await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: out.output,
    fetcher: () => [{ id: 'thin1', title: 'Chat' }],
    runner: () => ({ status: 0 }),
    briefFiler: () => {},
  });

  const teachNext = 'next: atris youtube teach "https://www.youtube.com/watch?v=thin1"';
  assert.equal(status, 0);
  assert.match(out.text(), /total: 1 new, 1 briefed/);
  assert.equal(out.lines.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(out.lines.includes(LEARNER_SCORE_ZERO), false);
  assert.equal(out.lines.includes(ephemeralApplyMessage('watch')), false);
  assert.ok(
    out.lines.indexOf(`check: ${LEARNER_CHECK_FILL}`)
      < out.lines.indexOf(teachNext),
  );
  assert.deepEqual(
    out.text().split('\n').filter((line) => line.startsWith('next:')),
    [teachNext],
  );
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'watch-thin1.apply.md')), false);
});

test('firstRichWatchLesson skips a thin brief and keeps the first rich url', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-rich-pick-'));
  fs.writeFileSync(path.join(workDir, 'yt_thin1.md'), '# Chat\n\nwelcome back friends this is just a chat\n');
  fs.writeFileSync(path.join(workDir, 'yt_rich1.md'), 'TSMC prints at 2nm\n');
  fs.writeFileSync(path.join(workDir, 'yt_rich2.md'), 'The omakase model has 80 people.\n');

  const picked = firstRichWatchLesson([
    'https://www.youtube.com/watch?v=thin1',
    'https://www.youtube.com/watch?v=rich1',
    'https://www.youtube.com/watch?v=rich2',
  ], workDir);
  assert.equal(picked.url, 'https://www.youtube.com/watch?v=rich1');
  assert.equal(picked.lesson.mechanisms.includes('2nm'), true);

  assert.equal(firstRichWatchLesson([
    'https://www.youtube.com/watch?v=thin1',
  ], workDir), null);
});

test('tick that briefs thin then rich mints apply from the rich video', async () => {
  const cwd = tempCwd();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-notes-'));
  const now = '2026-08-15T19:40:00.000Z';
  await youtubeCommand(['watch', 'add', '@veritasium'], { cwd, now, output: () => {} });
  await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: () => {},
    fetcher: () => [{ id: 'seed1', title: 'Seed' }],
    runner: () => ({ status: 0 }),
    briefFiler: () => {},
  });
  fs.writeFileSync(path.join(workDir, 'yt_thin1.md'), '# Chat\n\nwelcome back friends this is just a chat\n');
  fs.writeFileSync(path.join(workDir, 'yt_rich1.md'), 'TSMC prints at 2nm\n');

  const out = collect();
  const status = await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: out.output,
    fetcher: () => [
      { id: 'thin1', title: 'Chat' },
      { id: 'rich1', title: 'Process' },
      { id: 'seed1', title: 'Seed' },
    ],
    runner: () => ({ status: 0 }),
    briefFiler: () => {},
  });

  const keepNext = 'next: atris experiments keep watch-rich1';
  assert.equal(status, 0);
  assert.match(out.text(), /total: 2 new, 2 briefed/);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.doesNotMatch(out.text(), /^check:/m);
  assert.deepEqual(
    out.text().split('\n').filter((line) => line.startsWith('next:')),
    [keepNext],
  );
  assert.doesNotMatch(out.text(), /next: atris youtube teach/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'watch-thin1')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'watch-thin1.apply.md')), false);
  const claim = assertWatchApplyClaimable(cwd, { id: 'rich1', tokens: ['2nm', 'what is 2nm?'] });
  assert.equal(fs.existsSync(path.join(cwd, claim.packRel, 'measure.py')), true);
});

test('tick that briefs two thin videos stays on the first teach next', async () => {
  const cwd = tempCwd();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-notes-'));
  const now = '2026-08-15T19:41:00.000Z';
  await youtubeCommand(['watch', 'add', '@veritasium'], { cwd, now, output: () => {} });
  await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: () => {},
    fetcher: () => [{ id: 'seed1', title: 'Seed' }],
    runner: () => ({ status: 0 }),
    briefFiler: () => {},
  });
  fs.writeFileSync(path.join(workDir, 'yt_thin1.md'), '# Chat\n\nwelcome back friends this is just a chat\n');
  fs.writeFileSync(path.join(workDir, 'yt_thin2.md'), '# Hello\n\njust vibes and feelings today\n');

  const out = collect();
  const status = await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: out.output,
    fetcher: () => [
      { id: 'thin1', title: 'Chat' },
      { id: 'thin2', title: 'Hello' },
      { id: 'seed1', title: 'Seed' },
    ],
    runner: () => ({ status: 0 }),
    briefFiler: () => {},
  });

  const teachNext = 'next: atris youtube teach "https://www.youtube.com/watch?v=thin1"';
  assert.equal(status, 0);
  assert.match(out.text(), /total: 2 new, 2 briefed/);
  assert.equal(out.lines.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(out.lines.includes(LEARNER_SCORE_ZERO), false);
  assert.deepEqual(
    out.text().split('\n').filter((line) => line.startsWith('next:')),
    [teachNext],
  );
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'watch-thin1.apply.md')), false);
});

test('watchExperimentSlug uses the first briefed video id', () => {
  assert.equal(watchExperimentSlug('new1'), 'watch-new1');
  assert.equal(watchExperimentSlug('NyfgCesmika'), 'watch-nyfgcesmika');
});

test('rich watch tick mints a measure.py that validate.py accepts and scores 0 or 1 honestly', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = tempCwd();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-notes-'));
  const now = '2026-08-15T19:32:00.000Z';
  await youtubeCommand(['watch', 'add', '@veritasium'], { cwd, now, output: () => {} });
  fs.writeFileSync(path.join(workDir, 'yt_new1.md'), 'TSMC prints at 2nm\n');
  const printed = collect();
  const status = await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: printed.output,
    fetcher: () => [{ id: 'new1', title: 'Newest' }],
    runner: () => ({ status: 0 }),
    briefFiler: () => {},
  });

  assert.equal(status, 0);
  assert.equal(printed.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(printed.text(), /next: atris experiments keep watch-new1/);
  const packDir = path.join(cwd, 'atris', 'experiments', 'watch-new1');
  for (const name of ['program.md', 'measure.py', 'loop.py', 'reset.py', 'results.tsv']) {
    assert.equal(fs.existsSync(path.join(packDir, name)), true, name);
  }
  const program = fs.readFileSync(path.join(packDir, 'program.md'), 'utf8');
  assert.ok(program.length < 1200);
  assert.match(program, /2nm/);
  const measureSrc = fs.readFileSync(path.join(packDir, 'measure.py'), 'utf8');
  assert.match(measureSrc, /2nm/);

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
  const hit = scoreFixture('keep the 2nm node as the default print');
  assert.equal(hit.score, 1);

  const claim = assertWatchApplyClaimable(cwd, { tokens: ['2nm', 'what is 2nm?'] });
  const stub = spawnSync(pythonCmd, [path.join(packDir, 'measure.py')], {
    cwd: packDir,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_REPO_ROOT: cwd },
  });
  assert.equal(stub.status, 0, stub.stderr || stub.stdout);
  const stubPayload = JSON.parse(stub.stdout.trim().split('\n').pop());
  assert.equal(stubPayload.score, 0);
  assert.doesNotMatch(claim.sidecar, /2nm/i);
});

test('experiments keep refuses a minted watch pack at 0 and keeps after check tokens', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = tempCwd();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-notes-'));
  const now = '2026-08-15T19:32:00.000Z';
  await youtubeCommand(['watch', 'add', '@veritasium'], { cwd, now, output: () => {} });
  fs.writeFileSync(path.join(workDir, 'yt_new1.md'), 'TSMC prints at 2nm\n');
  const status = await youtubeCommand(['watch', 'tick'], {
    cwd,
    workDir,
    now,
    output: () => {},
    fetcher: () => [{ id: 'new1', title: 'Newest' }],
    runner: () => ({ status: 0 }),
    briefFiler: () => {},
  });

  assert.equal(status, 0);
  const packDir = path.join(cwd, 'atris', 'experiments', 'watch-new1');
  const applyPath = path.join(cwd, 'atris', 'wiki', 'briefs', 'watch-new1.apply.md');

  const refused = runExperimentsKeep(cwd, 'watch-new1');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /revert watch-new1: measure\.py stayed 0\. refuse keep\./);
  assert.doesNotMatch(`${refused.stdout}\n${refused.stderr}`, /next: atris youtube watch tick/);
  assert.equal(fs.existsSync(path.join(packDir, 'measure.py')), true);

  fs.appendFileSync(applyPath, '\nkeep the 2nm node as the default print\n');
  const kept = runExperimentsKeep(cwd, 'watch-new1');
  assert.equal(kept.status, 0, kept.stderr || kept.stdout);
  assert.match(kept.stdout, /keep watch-new1: measure\.py moved 0→1/);
  assert.deepEqual(
    kept.stdout.split('\n').filter((line) => line.startsWith('next: atris youtube watch tick')),
    ['next: atris youtube watch tick']
  );
});

test('tick with no channels prints one watch add next-step', async () => {
  const cwd = tempCwd();
  const now = '2026-08-15T19:40:00.000Z';

  const empty = collect();
  const emptyStatus = await youtubeCommand(['watch', 'tick'], {
    cwd,
    now,
    output: empty.output,
    fetcher: () => {
      throw new Error('empty watch list should not fetch');
    },
    runner: () => {
      throw new Error('empty watch list should not run notes');
    },
    briefFiler: () => {
      throw new Error('empty watch list should not file a brief');
    },
  });
  assert.equal(emptyStatus, 0);
  assert.match(empty.text(), /total: 0 new, 0 briefed/);
  assert.deepEqual(
    empty.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube watch add <channel-url-or-@handle>'],
  );
  assert.equal(empty.text().includes('next: atris youtube teach'), false);
  assert.doesNotMatch(empty.text(), /^check:/m);
  assert.equal(empty.lines.includes(LEARNER_SCORE_ZERO), false);
  assert.equal(empty.lines.includes(ephemeralApplyMessage('watch')), false);
});

test('tick with channels and zero briefed prints one search next-step', async () => {
  const cwd = tempCwd();
  const now = '2026-08-15T19:41:00.000Z';
  await youtubeCommand(['watch', 'add', '@broken'], { cwd, now, output: () => {} });
  const failed = collect();
  const failStatus = await youtubeCommand(['watch', 'tick'], {
    cwd,
    now,
    output: failed.output,
    fetcher: () => {
      throw new Error('network down');
    },
    runner: () => {
      throw new Error('fetch-fail should not run notes');
    },
    briefFiler: () => {
      throw new Error('fetch-fail should not file a brief');
    },
  });
  assert.equal(failStatus, 0);
  assert.match(failed.text(), /warning: channel https:\/\/www\.youtube\.com\/@broken fetch failed/);
  assert.match(failed.text(), /total: 0 new, 0 briefed/);
  assert.deepEqual(
    failed.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube search " "'],
  );
  assert.equal(failed.text().includes('next: atris youtube teach'), false);
  assert.doesNotMatch(failed.text(), /^check:/m);
  assert.equal(failed.lines.includes(LEARNER_SCORE_ZERO), false);
  assert.equal(failed.lines.includes(ephemeralApplyMessage('watch')), false);

  await youtubeCommand(['watch', 'add', '@ok'], { cwd, now, output: () => {} });
  await youtubeCommand(['watch', 'tick'], {
    cwd,
    now,
    output: () => {},
    fetcher: (url) => {
      if (url.includes('@broken')) throw new Error('network down');
      return [{ id: 'old1', title: 'Newest' }];
    },
    runner: () => {},
    briefFiler: () => {},
  });
  const nonew = collect();
  const nonewStatus = await youtubeCommand(['watch', 'tick'], {
    cwd,
    now,
    output: nonew.output,
    fetcher: (url) => {
      if (url.includes('@broken')) throw new Error('network down');
      return [{ id: 'old1', title: 'Newest' }];
    },
    runner: () => {
      throw new Error('zero-new tick should not run notes');
    },
    briefFiler: () => {
      throw new Error('zero-new tick should not file a brief');
    },
  });
  assert.equal(nonewStatus, 0);
  assert.match(nonew.text(), /total: 0 new, 0 briefed/);
  assert.deepEqual(
    nonew.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube search " "'],
  );
  assert.equal(nonew.text().includes('next: atris youtube teach'), false);
  assert.doesNotMatch(nonew.text(), /^check:/m);
  assert.equal(nonew.lines.includes(LEARNER_SCORE_ZERO), false);
  assert.equal(nonew.lines.includes(ephemeralApplyMessage('watch')), false);
});

test('already watching still prints one tick next-step', async () => {
  const cwd = tempCwd();
  const now = '2026-08-15T19:50:00.000Z';
  await youtubeCommand(['watch', 'add', '@veritasium'], { cwd, now, output: () => {} });

  const again = collect();
  const status = await youtubeCommand(['watch', 'add', '@veritasium'], {
    cwd,
    now,
    output: again.output,
  });
  assert.equal(status, 0);
  assert.match(again.text(), /already watching https:\/\/www\.youtube\.com\/@veritasium/);
  assert.deepEqual(
    again.text().split('\n').filter((line) => line.startsWith('next: atris youtube watch tick')),
    ['next: atris youtube watch tick'],
  );
});

test('empty watch list prints one add next-step', async () => {
  const cwd = tempCwd();
  const empty = collect();
  const status = await youtubeCommand(['watch', 'list'], { cwd, output: empty.output });
  assert.equal(status, 0);
  assert.match(empty.text(), /no channels watched/);
  assert.deepEqual(
    empty.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube watch add <channel-url-or-@handle>'],
  );
  assert.equal(empty.text().includes('next: atris youtube watch tick'), false);
});

test('watch add usage and bad input print no tick next-step', async () => {
  const cwd = tempCwd();
  const missing = collect();
  const missingStatus = await youtubeCommand(['watch', 'add'], {
    cwd,
    output: missing.output,
  });
  assert.equal(missingStatus, 2);
  assert.match(missing.text(), /usage: atris youtube watch add/);
  assert.equal(missing.text().includes('next: atris youtube watch tick'), false);

  const bad = collect();
  const badStatus = await youtubeCommand(['watch', 'add', '!!!'], {
    cwd,
    output: bad.output,
  });
  assert.equal(badStatus, 2);
  assert.match(bad.text(), /Invalid channel: !!!/);
  assert.equal(bad.text().includes('next: atris youtube watch tick'), false);
});

test('watch help says add hands off to tick', async () => {
  const out = collect();
  const status = await youtubeCommand(['watch', 'help'], { output: out.output });
  assert.equal(status, 0);
  assert.match(out.text(), /add hands off to tick/);
  assert.match(out.text(), /tick hands off to teach when it briefed/);
  assert.equal(out.text().includes('next: atris youtube watch tick'), false);
});

test('unknown watch command prints no tick next-step', async () => {
  const out = collect();
  const status = await youtubeCommand(['watch', 'nope'], { output: out.output });
  assert.equal(status, 2);
  assert.match(out.text(), /unknown watch command: nope/);
  assert.equal(out.text().includes('next: atris youtube watch tick'), false);
});

test('remove last remaining channel prints one add next-step', async () => {
  const cwd = tempCwd();
  const now = '2026-08-15T20:00:00.000Z';
  await youtubeCommand(['watch', 'add', '@veritasium'], { cwd, now, output: () => {} });

  const removed = collect();
  const status = await youtubeCommand(['watch', 'remove', '1'], {
    cwd,
    output: removed.output,
  });
  assert.equal(status, 0);
  assert.match(removed.text(), /removed https:\/\/www\.youtube\.com\/@veritasium/);
  assert.deepEqual(
    removed.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube watch add <channel-url-or-@handle>'],
  );
  assert.equal(removed.text().includes('next: atris youtube watch tick'), false);

  const after = loadWatchState(statePathFor(cwd));
  assert.equal(after.channels.length, 0);
});

test('remove when others remain prints one tick next-step', async () => {
  const cwd = tempCwd();
  const now = '2026-08-15T20:10:00.000Z';
  await youtubeCommand(['watch', 'add', '@veritasium'], { cwd, now, output: () => {} });
  await youtubeCommand(['watch', 'add', '@mkbhd'], { cwd, now, output: () => {} });

  const removed = collect();
  const status = await youtubeCommand(['watch', 'remove', '2'], {
    cwd,
    output: removed.output,
  });
  assert.equal(status, 0);
  assert.match(removed.text(), /removed https:\/\/www\.youtube\.com\/@mkbhd/);
  assert.deepEqual(
    removed.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube watch tick'],
  );
  assert.equal(
    removed.text().includes('next: atris youtube watch add <channel-url-or-@handle>'),
    false,
  );

  const after = loadWatchState(statePathFor(cwd));
  assert.equal(after.channels.length, 1);
  assert.equal(after.channels[0].channel, 'https://www.youtube.com/@veritasium');
});

test('invalid watch remove prints usage only', async () => {
  const cwd = tempCwd();
  const now = '2026-08-15T20:20:00.000Z';
  await youtubeCommand(['watch', 'add', '@veritasium'], { cwd, now, output: () => {} });

  const missing = collect();
  const missingStatus = await youtubeCommand(['watch', 'remove'], {
    cwd,
    output: missing.output,
  });
  assert.equal(missingStatus, 2);
  assert.match(missing.text(), /usage: atris youtube watch remove <number>/);
  assert.equal(missing.text().includes('next:'), false);

  const bad = collect();
  const badStatus = await youtubeCommand(['watch', 'remove', '9'], {
    cwd,
    output: bad.output,
  });
  assert.equal(badStatus, 2);
  assert.match(bad.text(), /usage: atris youtube watch remove <number>/);
  assert.equal(bad.text().includes('next:'), false);

  const after = loadWatchState(statePathFor(cwd));
  assert.equal(after.channels.length, 1);
});
