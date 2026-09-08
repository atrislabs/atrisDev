'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseNotesArgs,
  isPlaylistUrl,
  expandNotesTargets,
  runYoutubeNotesBatch,
  LEARNER_SCORE_ZERO,
  TEACH_THIN_REFUSE,
  youtubeCommand,
} = require('../commands/youtube');
const { ephemeralApplyMessage } = require('../lib/apply-gate');

const RICH_NOTES = '# Clip\n\nThe omakase model has 80 people.\n';
const THIN_NOTES = '# Chat\n\nwelcome back friends this is just a chat about feelings and vibes\n';
const LEARNER_BASELINE_INCOMPLETE = 'incomplete: check already passes. refuse invented success.';

function richNotesWorkspace(ids) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-batch-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-batch-notes-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  for (const id of ids) {
    fs.writeFileSync(path.join(workDir, `yt_${id}.md`), RICH_NOTES);
  }
  return { cwd, workDir };
}

function collect() {
  const lines = [];
  return {
    lines,
    output: (line = '') => lines.push(String(line)),
    text: () => lines.join('\n'),
  };
}

function briefFor(url) {
  const id = String(url).match(/[?&]v=([^&]+)/)?.[1] || String(url).match(/youtu\.be\/([^?&/]+)/)?.[1];
  return `atris/wiki/briefs/youtube-${id}.md`;
}

test('parseNotesArgs keeps the engine as the one non-url trailing word', () => {
  assert.deepEqual(
    parseNotesArgs([
      'https://www.youtube.com/watch?v=aaa',
      'https://youtu.be/bbb',
      'haiku',
    ]),
    {
      urls: [
        'https://www.youtube.com/watch?v=aaa',
        'https://youtu.be/bbb',
      ],
      engine: 'haiku',
      help: false,
      save: false,
      unsave: false,
      json: false,
    },
  );
  assert.equal(isPlaylistUrl('https://www.youtube.com/playlist?list=PLxx'), true);
  assert.equal(isPlaylistUrl('https://www.youtube.com/watch?v=aaa&list=PLxx'), true);
  assert.equal(isPlaylistUrl('https://www.youtube.com/watch?v=aaa'), false);
  assert.deepEqual(
    parseNotesArgs(['https://youtu.be/ccc', '--save']),
    {
      urls: ['https://youtu.be/ccc'],
      engine: null,
      help: false,
      save: true,
      unsave: false,
      json: false,
    },
  );
  assert.deepEqual(
    parseNotesArgs(['--unsave', 'ccc123xyz']),
    {
      urls: ['ccc123xyz'],
      engine: null,
      help: false,
      save: false,
      unsave: true,
      json: false,
    },
  );
  assert.deepEqual(
    parseNotesArgs(['https://youtu.be/ddd', '--json']),
    {
      urls: ['https://youtu.be/ddd'],
      engine: null,
      help: false,
      save: false,
      unsave: false,
      json: true,
    },
  );
});

test('single-url notes still run the existing path with an optional engine', async () => {
  const calls = [];
  const briefs = [];
  let expanded = 0;
  const status = await youtubeCommand([
    'notes',
    'https://www.youtube.com/watch?v=abc123',
    'grok',
  ], {
    output: () => {},
    runner: (url, engine) => {
      calls.push({ url, engine });
      return { status: 0 };
    },
    briefFiler: ({ url }) => {
      briefs.push(url);
      return briefFor(url);
    },
    ensureApply: () => 0,
    expander: () => {
      expanded += 1;
      return [];
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [{
    url: 'https://www.youtube.com/watch?v=abc123',
    engine: 'grok',
  }]);
  assert.deepEqual(briefs, []);
  assert.equal(expanded, 0);
});

test('single-url notes --save files the brief', async () => {
  const calls = [];
  const briefs = [];
  const { cwd, workDir } = richNotesWorkspace(['abc123']);
  const status = await youtubeCommand([
    'notes',
    'https://www.youtube.com/watch?v=abc123',
    '--save',
    'grok',
  ], {
    cwd,
    workDir,
    output: () => {},
    runner: (url, engine) => {
      calls.push({ url, engine });
      return { status: 0 };
    },
    briefFiler: ({ url }) => {
      briefs.push(url);
      return briefFor(url);
    },
    ensureApply: () => 0,
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [{
    url: 'https://www.youtube.com/watch?v=abc123',
    engine: 'grok',
  }]);
  assert.deepEqual(briefs, ['https://www.youtube.com/watch?v=abc123']);
});

test('multi-url notes run sequentially and keep the shared engine', async () => {
  const calls = [];
  const log = collect();
  const status = await youtubeCommand([
    'notes',
    'https://www.youtube.com/watch?v=aaa111',
    'https://youtu.be/bbb222',
    'haiku',
  ], {
    output: log.output,
    runner: (url, engine) => {
      calls.push({ url, engine });
      return { status: 0 };
    },
    briefFiler: ({ url }) => briefFor(url),
    nowMs: (() => {
      let n = 0;
      return () => {
        n += 1000;
        return n;
      };
    })(),
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    { url: 'https://www.youtube.com/watch?v=aaa111', engine: 'haiku' },
    { url: 'https://youtu.be/bbb222', engine: 'haiku' },
  ]);
  assert.match(log.text(), /aaa111  1s  ok/);
  assert.match(log.text(), /bbb222  1s  ok/);
  assert.match(log.text(), /url or id  seconds  result/);
});

test('multi-url notes --save files briefs', async () => {
  const log = collect();
  const { cwd, workDir } = richNotesWorkspace(['aaa111', 'bbb222']);
  const status = await youtubeCommand([
    'notes',
    '--save',
    'https://www.youtube.com/watch?v=aaa111',
    'https://youtu.be/bbb222',
    'haiku',
  ], {
    cwd,
    workDir,
    output: log.output,
    runner: () => ({ status: 0 }),
    briefFiler: ({ url }) => briefFor(url),
    ensureApply: () => 0,
    nowMs: (() => {
      let n = 0;
      return () => {
        n += 1000;
        return n;
      };
    })(),
  });

  assert.equal(status, 0);
  assert.match(log.text(), /aaa111  1s  atris\/wiki\/briefs\/youtube-aaa111.md/);
  assert.match(log.text(), /bbb222  1s  atris\/wiki\/briefs\/youtube-bbb222.md/);
  assert.equal(log.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 0);
});

test('rich multi-url notes --save proves failing learner baseline for the first saved item', async () => {
  const first = 'https://www.youtube.com/watch?v=aaa111';
  const second = 'https://www.youtube.com/watch?v=bbb222';
  const { cwd, workDir } = richNotesWorkspace(['aaa111', 'bbb222']);
  const log = collect();
  const status = await youtubeCommand([
    'notes',
    '--save',
    first,
    second,
  ], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: log.output,
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.match(log.text(), /aaa111  \d+s  atris\/wiki\/briefs\/youtube-aaa111.md/);
  assert.match(log.text(), /bbb222  \d+s  atris\/wiki\/briefs\/youtube-bbb222.md/);
  assert.match(log.text(), /next: atris experiments keep notes-aaa111/);
  assert.equal(log.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.ok(log.text().indexOf('next: atris experiments keep notes-aaa111') < log.text().indexOf(LEARNER_SCORE_ZERO));
  assert.doesNotMatch(log.text(), /^check:/m);
  assert.equal(log.lines.filter((line) => line === ephemeralApplyMessage('notes')).length, 0);
  assert.doesNotMatch(log.text(), /next: atris youtube teach/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'notes-aaa111')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'notes-bbb222')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-aaa111.apply.md')), true);
});

test('rich notes --save batch --json stays quiet on the learner score', async () => {
  const { cwd, workDir } = richNotesWorkspace(['jsons1', 'jsons2']);
  const log = collect();
  const status = await youtubeCommand([
    'notes',
    '--save',
    '--json',
    'https://www.youtube.com/watch?v=jsons1',
    'https://www.youtube.com/watch?v=jsons2',
  ], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: log.output,
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.match(log.text(), /url or id  seconds  result/);
  assert.equal(log.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 0);
  assert.doesNotMatch(log.text(), /^check:/m);
  assert.doesNotMatch(log.text(), /next: atris youtube teach/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'notes-jsons1')), true);
});

test('rich notes --save batch returns nonzero when the first apply already passes', async () => {
  const first = 'https://www.youtube.com/watch?v=pass01';
  const { cwd, workDir } = richNotesWorkspace(['pass01', 'pass02']);
  const applyRel = path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-pass01.apply.md');
  fs.mkdirSync(path.dirname(applyRel), { recursive: true });
  fs.writeFileSync(applyRel, [
    'source: https://www.youtube.com/watch?v=pass01',
    'change: keep the omakase model as the default stack',
    'receipt: measure already contains the check tokens',
  ].join('\n') + '\n');
  const log = collect();
  const status = await youtubeCommand([
    'notes',
    '--save',
    first,
    'https://www.youtube.com/watch?v=pass02',
  ], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: log.output,
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 2);
  assert.equal(log.lines.filter((line) => line === LEARNER_BASELINE_INCOMPLETE).length, 1);
  assert.equal(log.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 0);
});

test('thin notes --save batch stays a refuse and does not prove a learner baseline', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-batch-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-batch-notes-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'yt_thin01.md'), THIN_NOTES);
  fs.writeFileSync(path.join(workDir, 'yt_thin02.md'), THIN_NOTES);
  const log = collect();
  const status = await youtubeCommand([
    'notes',
    '--save',
    'https://www.youtube.com/watch?v=thin01',
    'https://www.youtube.com/watch?v=thin02',
  ], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: log.output,
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 2);
  assert.equal(log.lines.filter((line) => line === TEACH_THIN_REFUSE).length, 2);
  assert.equal(log.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 0);
  assert.doesNotMatch(log.text(), /^check:/m);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('playlist expansion caps at 10 and prints a cap note', async () => {
  const playlist = 'https://www.youtube.com/playlist?list=PLbatch';
  const videos = Array.from({ length: 12 }, (_, i) => ({
    id: `vid${String(i + 1).padStart(2, '0')}`,
    title: `Video ${i + 1}`,
  }));
  const calls = [];
  const log = collect();
  let expandCalls = 0;

  const status = runYoutubeNotesBatch({ urls: [playlist], engine: null }, {
    output: log.output,
    expander: (url) => {
      expandCalls += 1;
      assert.equal(url, playlist);
      return videos;
    },
    runner: (url) => {
      calls.push(url);
      return { status: 0 };
    },
    briefFiler: ({ url }) => briefFor(url),
  });

  assert.equal(status, 0);
  assert.equal(expandCalls, 1);
  assert.equal(calls.length, 10);
  assert.deepEqual(calls, videos.slice(0, 10).map((video) => `https://www.youtube.com/watch?v=${video.id}`));
  assert.match(log.text(), /playlist capped at 10 videos \(12 found\)/);
  assert.doesNotMatch(log.text(), /vid11/);
  assert.doesNotMatch(log.text(), /vid12/);
});

test('playlist notes batch prints apply and check for the first ok video', async () => {
  const playlist = 'https://www.youtube.com/playlist?list=PLlearn';
  const firstUrl = 'https://www.youtube.com/watch?v=vid01';
  const { cwd, workDir } = richNotesWorkspace(['vid01', 'vid02']);
  const log = collect();
  const status = runYoutubeNotesBatch({ urls: [playlist], engine: null }, {
    cwd,
    workDir,
    output: log.output,
    expander: () => ([
      { id: 'vid01', title: 'First' },
      { id: 'vid02', title: 'Second' },
    ]),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.match(log.text(), /url or id  seconds  result/);
  assert.equal(log.lines.filter((line) => line === ephemeralApplyMessage('notes')).length, 1);
  assert.equal(log.lines.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(log.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(
    log.text().split('\n').filter((line) => line.startsWith('next: atris youtube teach')),
    [`next: atris youtube teach "${firstUrl}"`],
  );
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('one failed video records FAILED and the batch continues', async () => {
  const log = collect();
  const calls = [];
  const status = await youtubeCommand([
    'notes',
    'https://www.youtube.com/watch?v=fail01',
    'https://www.youtube.com/watch?v=pass02',
  ], {
    output: log.output,
    runner: (url) => {
      calls.push(url);
      return { status: url.includes('fail01') ? 2 : 0 };
    },
    briefFiler: ({ url }) => briefFor(url),
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    'https://www.youtube.com/watch?v=fail01',
    'https://www.youtube.com/watch?v=pass02',
  ]);
  assert.match(log.text(), /fail01  \d+s  FAILED/);
  assert.match(log.text(), /pass02  \d+s  ok/);
});

test('all-fail notes batch exits 2', async () => {
  const log = collect();
  const status = runYoutubeNotesBatch({
    urls: [
      'https://www.youtube.com/watch?v=bad01',
      'https://www.youtube.com/watch?v=bad02',
    ],
  }, {
    output: log.output,
    runner: () => ({ status: 1 }),
    briefFiler: () => {
      throw new Error('brief should not file on failure');
    },
  });

  assert.equal(status, 2);
  assert.match(log.text(), /bad01  \d+s  FAILED/);
  assert.match(log.text(), /bad02  \d+s  FAILED/);
  assert.match(log.text(), /url or id  seconds  result/);
});

test('playlist notes batch keeps printed videos when yt-dlp exits 429', async () => {
  const playlist = 'https://www.youtube.com/playlist?list=PLrate';
  const firstUrl = 'https://www.youtube.com/watch?v=plrate1';
  const { cwd, workDir } = richNotesWorkspace(['plrate1']);
  const log = collect();
  const ran = [];
  const status = await youtubeCommand(['notes', playlist], {
    cwd,
    workDir,
    output: log.output,
    spawnSync: (cmd, args) => {
      assert.equal(cmd, 'yt-dlp');
      assert.equal(args.includes('--flat-playlist'), true);
      assert.equal(args.includes(playlist), true);
      return {
        status: 1,
        stdout: 'plrate1|Partial Playlist Hit\n',
        stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
      };
    },
    runner: (url) => {
      ran.push(url);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(ran, [firstUrl]);
  assert.match(log.text(), /plrate1  \d+s  ok/);
  assert.equal(log.lines.filter((line) => line === ephemeralApplyMessage('notes')).length, 1);
  assert.equal(log.lines.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(log.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(
    log.text().split('\n').filter((line) => line.startsWith('next: atris youtube teach')),
    [`next: atris youtube teach "${firstUrl}"`],
  );
  assert.doesNotMatch(log.text(), /FAILED|429|Too Many Requests|playlist expand failed/);
});

test('notes batch keeps written notes when the runner exits 429', async () => {
  const firstUrl = 'https://www.youtube.com/watch?v=ntrate1';
  const secondUrl = 'https://www.youtube.com/watch?v=ntrate2';
  const { cwd, workDir } = richNotesWorkspace(['ntrate1', 'ntrate2']);
  const log = collect();
  const status = await youtubeCommand(['notes', firstUrl, secondUrl], {
    cwd,
    workDir,
    output: log.output,
    runner: () => ({
      status: 1,
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
  });

  assert.equal(status, 0);
  assert.match(log.text(), /ntrate1  \d+s  ok/);
  assert.match(log.text(), /ntrate2  \d+s  ok/);
  assert.equal(log.lines.filter((line) => line === ephemeralApplyMessage('notes')).length, 1);
  assert.equal(log.lines.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(log.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(
    log.text().split('\n').filter((line) => line.startsWith('next: atris youtube teach')),
    [`next: atris youtube teach "${firstUrl}"`],
  );
  assert.doesNotMatch(log.text(), /FAILED|429|Too Many Requests/);
});

test('notes batch still marks FAILED when 429 wrote no notes', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-batch-empty429-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-batch-empty429-notes-'));
  const log = collect();
  const status = await youtubeCommand([
    'notes',
    'https://www.youtube.com/watch?v=empty429',
    'https://www.youtube.com/watch?v=empty430',
  ], {
    cwd,
    workDir,
    output: log.output,
    runner: () => ({
      status: 1,
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
  });

  assert.equal(status, 2);
  assert.match(log.text(), /empty429  \d+s  FAILED/);
  assert.match(log.text(), /empty430  \d+s  FAILED/);
  assert.doesNotMatch(log.text(), /score: 0|next: atris youtube teach/);
});

test('expandNotesTargets leaves a plain watch url untouched', () => {
  const items = expandNotesTargets(['https://www.youtube.com/watch?v=plain1'], {
    expander: () => {
      throw new Error('expander should not run for a watch url');
    },
  });
  assert.deepEqual(items, [
    { url: 'https://www.youtube.com/watch?v=plain1', id: 'plain1' },
  ]);
});
