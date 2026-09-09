const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  DEFAULT_QUERY,
  parseYoutubeArgs,
  buildYoutubePayload,
  extractLocalTranscript,
  readLocalCaptionText,
  shouldRetryWithLocalTranscript,
  formatYoutubeResult,
  fileBriefFromNotes,
  keptPrintedNotes,
  ensureNotesApply,
  unsaveYoutubeNotes,
  APPLY_NEXT_MESSAGE,
  PROCESS_APPLY_MESSAGE,
  TEACH_THIN_REFUSE,
  LEARNER_CHECK_FILL,
  LEARNER_SCORE_ZERO,
  learnerCheckFromLesson,
  scoreLearnerNeedles,
  processExperimentSlug,
  processApplyRel,
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
const THIN_NOTES = '# Apply Gate Video\n\nwelcome back friends this is just a chat\n';

function filledApplyWorkspace(id, url) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-process-'));
  const applyDir = path.join(cwd, 'atris', 'wiki', 'briefs');
  fs.mkdirSync(applyDir, { recursive: true });
  fs.writeFileSync(path.join(applyDir, `youtube-${id}.apply.md`), [
    `source: ${url}`,
    'change: commands/youtube.js',
    'receipt: node --test test/youtube.test.js',
    '',
  ].join('\n'));
  return cwd;
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stubRichProcess(data = {}) {
  return {
    ok: true,
    status: 200,
    data: {
      status: 'success',
      message: 'YouTube video processed successfully',
      video_analysis: RICH_NOTES,
      credits_used: 5,
      credits_remaining: 42,
      ...data,
    },
  };
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

function assertProcessApplyClaimable(cwd, { id, tokens = [], date = '2026-08-26' } = {}) {
  const packRel = `atris/experiments/${processExperimentSlug(id)}`;
  const applyRel = processApplyRel(id);
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

test('parseYoutubeArgs accepts process form with query, storage, json, and timeout', () => {
  const options = parseYoutubeArgs([
    'process',
    'https://youtu.be/abc123',
    '--query',
    'What changed?',
    '--agent',
    'agent-1',
    '--store',
    '--json',
    '--timeout',
    '12',
  ]);

  assert.equal(options.youtubeUrl, 'https://youtu.be/abc123');
  assert.equal(options.query, 'What changed?');
  assert.equal(options.agentId, 'agent-1');
  assert.equal(options.storeAsKnowledge, true);
  assert.equal(options.json, true);
  assert.equal(options.timeoutMs, 12000);
});

test('buildYoutubePayload defaults to the documented takeaway query', () => {
  const payload = buildYoutubePayload(parseYoutubeArgs(['https://youtube.com/watch?v=abc123']));
  assert.deepEqual(payload, {
    youtube_url: 'https://youtube.com/watch?v=abc123',
    query: DEFAULT_QUERY,
  });
  assert.match(DEFAULT_QUERY, /timestamped YouTube brief/);
  assert.match(DEFAULT_QUERY, /claims with confidence/);
});

test('buildYoutubePayload can include client transcript fields', () => {
  const options = parseYoutubeArgs(['https://youtube.com/watch?v=abc123']);
  options.localTranscript = {
    transcriptText: 'caption text',
    language: 'en',
    durationSeconds: 12,
  };

  assert.deepEqual(buildYoutubePayload(options), {
    youtube_url: 'https://youtube.com/watch?v=abc123',
    query: DEFAULT_QUERY,
    transcript_text: 'caption text',
    transcript_language: 'en',
    duration_seconds: 12,
  });
});

test('youtubeCommand calls the process_youtube endpoint without curl', async () => {
  const calls = [];
  const output = [];
  let extractorCalls = 0;
  const url = 'https://youtube.com/watch?v=abc123';
  const cwd = filledApplyWorkspace('abc123', url);

  const status = await youtubeCommand([
    url,
    '--query',
    'Extract lessons',
  ], {
    cwd,
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    extractLocalTranscript: async () => {
      extractorCalls += 1;
      return null;
    },
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          status: 'success',
          message: 'YouTube video processed successfully',
          video_analysis: 'Main insight.',
          credits_used: 5,
          credits_remaining: 42,
          metadata: { title: 'Video title', channel: 'Channel name' },
        },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/agent/process_youtube');
  assert.deepEqual(calls[0].options.body, {
    youtube_url: 'https://youtube.com/watch?v=abc123',
    query: 'Extract lessons',
  });
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.token, 'token-123');
  assert.equal(calls[0].options.timeoutMs, 300000);
  assert.equal(calls[0].options.retries, 0);
  assert.equal(extractorCalls, 1);
  assert.match(output.join('\n'), /Video title/);
  assert.match(output.join('\n'), /Main insight/);
  assert.equal(output.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 0);
  assert.equal(output.filter((line) => String(line).startsWith('next:')).length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, processApplyRel('abc123'))), false);
});

test('youtubeCommand sends local transcript first without caching it', async () => {
  const calls = [];
  const url = 'https://youtube.com/watch?v=abc123';
  const cwd = filledApplyWorkspace('abc123', url);

  const status = await youtubeCommand([
    url,
  ], {
    cwd,
    output: () => {},
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    extractLocalTranscript: async () => ({
      transcriptText: 'local captions',
      language: 'en',
      durationSeconds: 33,
    }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: { status: 'success', message: 'ok', video_analysis: 'done' },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.body.transcript_text, 'local captions');
  assert.equal(calls[0].options.body.transcript_language, 'en');
  assert.equal(calls[0].options.body.duration_seconds, 33);
  assert.equal(calls[0].options.body.cache_transcript, false);
});

test('youtubeCommand falls back to cloud video after local transcript failure', async () => {
  const calls = [];
  const url = 'https://youtube.com/watch?v=abc123';
  const cwd = filledApplyWorkspace('abc123', url);

  const status = await youtubeCommand([
    url,
  ], {
    cwd,
    output: () => {},
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    extractLocalTranscript: async () => ({
      transcriptText: 'local captions',
      language: 'en',
      durationSeconds: 33,
    }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      if (calls.length === 1) {
        return {
          ok: false,
          status: 502,
          error: { error: 'Transcript summarization failed' },
        };
      }
      return {
        ok: true,
        status: 200,
        data: { status: 'success', message: 'ok', video_analysis: 'cloud done' },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body.transcript_text, 'local captions');
  assert.equal(calls[0].options.body.cache_transcript, false);
  assert.equal(calls[1].options.body.transcript_text, undefined);
  assert.equal(calls[1].options.body.cache_transcript, undefined);
});

test('shouldRetryWithLocalTranscript only retries YouTube extraction failures', () => {
  assert.equal(shouldRetryWithLocalTranscript({ ok: false, status: 502, error: 'failed' }), true);
  assert.equal(shouldRetryWithLocalTranscript({
    ok: false,
    status: 400,
    error: { error: 'YouTube video is not publicly accessible', reason: 'oEmbed blocked' },
  }), true);
  assert.equal(shouldRetryWithLocalTranscript({ ok: false, status: 400, error: 'Invalid YouTube URL' }), false);
  assert.equal(shouldRetryWithLocalTranscript({ ok: false, status: 402, error: 'Insufficient credits' }), false);
});

test('extractLocalTranscript parses yt-dlp json3 captions', async () => {
  const result = await extractLocalTranscript('https://youtube.com/watch?v=abc123', {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        duration: 44,
        automatic_captions: {
          en: [{ ext: 'json3', url: 'https://www.youtube.com/api/timedtext?v=abc123' }],
        },
      }),
    }),
    fetchCaptionText: async () => JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
        { tStartMs: 1200, segs: [{ utf8: 'Next idea' }] },
      ],
    }),
  });

  assert.equal(result.transcriptText, '[00:00] Hello world\n[00:01] Next idea');
  assert.equal(result.language, 'en');
  assert.equal(result.durationSeconds, 44);
});

test('extractLocalTranscript keeps parseable yt-dlp json when yt-dlp exits 429', async () => {
  const result = await extractLocalTranscript('https://youtube.com/watch?v=abc123', {
    spawnSync: () => ({
      status: 1,
      stdout: JSON.stringify({
        duration: 44,
        automatic_captions: {
          en: [{ ext: 'json3', url: 'https://www.youtube.com/api/timedtext?v=abc123' }],
        },
      }),
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
    fetchCaptionText: async () => JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
        { tStartMs: 1200, segs: [{ utf8: 'Next idea' }] },
      ],
    }),
  });

  assert.equal(result.transcriptText, '[00:00] Hello world\n[00:01] Next idea');
  assert.equal(result.language, 'en');
  assert.equal(result.durationSeconds, 44);
});

test('extractLocalTranscript still fails when 429 stdout is empty', async () => {
  const result = await extractLocalTranscript('https://youtube.com/watch?v=abc123', {
    spawnSync: () => ({
      status: 1,
      stdout: '',
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
    fetchCaptionText: async () => JSON.stringify({
      events: [{ tStartMs: 0, segs: [{ utf8: 'Hello' }] }],
    }),
  });

  assert.equal(result, null);
});

test('extractLocalTranscript keeps a written vtt when 429 stdout is empty', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-local-emptyjson-'));
  fs.writeFileSync(path.join(workDir, 'yt_abc123.en.vtt'), [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:02.000',
    'Hello world',
    '',
    '00:00:01.200 --> 00:00:03.000',
    'Next idea',
    '',
  ].join('\n'));

  const result = await extractLocalTranscript('https://youtube.com/watch?v=abc123', {
    workDir,
    spawnSync: () => ({
      status: 1,
      stdout: '',
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
    fetchCaptionText: async () => {
      throw new Error('empty json must not fetch a caption url');
    },
  });

  assert.equal(result.transcriptText, '[00:00] Hello world\n[00:01] Next idea');
  assert.equal(result.language, 'en');
  assert.match(readLocalCaptionText({ url: 'https://youtube.com/watch?v=abc123', workDir }), /Hello world/);
});

test('extractLocalTranscript keeps a written vtt for shorts embed live and /e/ urls when 429 stdout is empty', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-local-shorts-'));
  fs.writeFileSync(path.join(workDir, 'yt_abc123.en.vtt'), [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:02.000',
    'Hello world',
    '',
  ].join('\n'));
  const urls = [
    'https://www.youtube.com/shorts/abc123',
    'https://www.youtube.com/embed/abc123',
    'https://www.youtube.com/live/abc123',
    'https://www.youtube.com/e/abc123',
    'https://www.youtube-nocookie.com/embed/abc123',
    'https://www.youtube-nocookie.com/e/abc123',
    'https://m.youtube.com/e/abc123',
  ];

  for (const url of urls) {
    const result = await extractLocalTranscript(url, {
      workDir,
      spawnSync: () => ({
        status: 1,
        stdout: '',
        stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
      }),
      fetchCaptionText: async () => {
        throw new Error('empty json must not fetch a caption url');
      },
    });

    assert.equal(result && result.transcriptText, '[00:00] Hello world', url);
    assert.match(readLocalCaptionText({ url, workDir }), /Hello world/);
  }
});

test('extractLocalTranscript keeps a written vtt when 429 json is a playlist', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-local-playlist-'));
  fs.writeFileSync(path.join(workDir, 'yt_abc123.en.vtt'), [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:02.000',
    'Hello world',
    '',
  ].join('\n'));
  const url = 'https://www.youtube.com/watch?v=abc123&list=PLxyz';
  const args = [];

  const result = await extractLocalTranscript(url, {
    workDir,
    spawnSync: (...spawnArgs) => {
      args.push(spawnArgs[1] || []);
      return {
        status: 1,
        stdout: JSON.stringify({
          id: 'PLxyz',
          _type: 'playlist',
          entries: [{ id: 'abc123' }],
        }),
        stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
      };
    },
    fetchCaptionText: async () => null,
  });

  assert.equal(result && result.transcriptText, '[00:00] Hello world');
  assert.equal(result.language, 'en');
  assert.match(readLocalCaptionText({ url, id: 'PLxyz', workDir }), /Hello world/);
  assert.ok(args.some((list) => list.includes('--no-playlist')), args);
});

test('extractLocalTranscript keeps a written vtt when caption fetch fails after 429 json', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-local-vtt-'));
  fs.writeFileSync(path.join(workDir, 'yt_abc123.en.vtt'), [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:02.000',
    'Hello world',
    '',
    '00:00:01.200 --> 00:00:03.000',
    'Next idea',
    '',
  ].join('\n'));

  const result = await extractLocalTranscript('https://youtube.com/watch?v=abc123', {
    workDir,
    spawnSync: () => ({
      status: 1,
      stdout: JSON.stringify({
        id: 'abc123',
        duration: 44,
        automatic_captions: {
          en: [{ ext: 'json3', url: 'https://www.youtube.com/api/timedtext?v=abc123' }],
        },
      }),
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
    fetchCaptionText: async () => null,
  });

  assert.equal(result.transcriptText, '[00:00] Hello world\n[00:01] Next idea');
  assert.equal(result.language, 'en');
  assert.equal(result.durationSeconds, 44);
  assert.match(readLocalCaptionText({ url: 'https://youtube.com/watch?v=abc123', workDir }), /Hello world/);
});

test('extractLocalTranscript still fails when caption fetch fails and no vtt was written', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-local-novtt-'));
  const result = await extractLocalTranscript('https://youtube.com/watch?v=abc123', {
    workDir,
    spawnSync: () => ({
      status: 1,
      stdout: JSON.stringify({
        id: 'abc123',
        duration: 44,
        automatic_captions: {
          en: [{ ext: 'json3', url: 'https://www.youtube.com/api/timedtext?v=abc123' }],
        },
      }),
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
    fetchCaptionText: async () => null,
  });

  assert.equal(result, null);
  assert.equal(readLocalCaptionText({ url: 'https://youtube.com/watch?v=abc123', workDir }), '');
});

test('extractLocalTranscript preserves VTT timestamps', async () => {
  const result = await extractLocalTranscript('https://youtube.com/watch?v=abc123', {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        duration: 61,
        subtitles: {
          en: [{ ext: 'vtt', url: 'https://www.youtube.com/api/timedtext?v=abc123' }],
        },
      }),
    }),
    fetchCaptionText: async () => [
      'WEBVTT',
      '',
      '00:00:02.000 --> 00:00:04.000',
      'First idea',
      '',
      '00:01:00.000 --> 00:01:02.000',
      'Second idea',
      '',
    ].join('\n'),
  });

  assert.equal(result.transcriptText, '[00:02] First idea\n[01:00] Second idea');
  assert.equal(result.durationSeconds, 61);
});

test('youtube notes with no url exits 2 and prints usage', async () => {
  const output = [];
  const status = await youtubeCommand(['notes'], {
    output: (line) => output.push(line),
  });

  assert.equal(status, 2);
  assert.match(output.join('\n'), /usage: ytnotes <youtube-url>/);
  assert.match(output.join('\n'), /zero credits, local captions \+ a fast engine/);
});

test('youtube notes with a non-youtube arg exits 2', async () => {
  const status = await youtubeCommand(['notes', 'not-a-url'], {
    output: () => {},
  });

  assert.equal(status, 2);
});

test('fileBriefFromNotes writes a wiki brief and a claimable journal line', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-brief-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-notes-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const notes = '# Some Video Title\n\nBody paragraph.\n';
  fs.writeFileSync(path.join(workDir, 'yt_abc123xyz.md'), notes);
  const url = 'https://www.youtube.com/watch?v=abc123xyz';

  fileBriefFromNotes({
    cwd,
    url,
    workDir,
    now: new Date('2026-08-15T15:00:00.000Z'),
  });

  const brief = fs.readFileSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-abc123xyz.md'), 'utf8');
  assert.equal(brief, [
    'some video title',
    '',
    'date: 2026-08-15',
    `source: ${url}`,
    'rail: atris youtube notes, quotes repaired against the transcript',
    notes,
  ].join('\n'));

  const journal = fs.readFileSync(path.join(cwd, 'atris', 'logs', '2026', '2026-08-15.md'), 'utf8');
  assert.equal(journal, '- [claimable] watched: Some Video Title -> atris/wiki/briefs/youtube-abc123xyz.md\n');
});

test('fileBriefFromNotes files youtu.be notes and stays silent without a wiki', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-notes-be-'));
  fs.writeFileSync(path.join(workDir, 'yt_shortid99.md'), '# Short Form\n\nClip notes.\n');

  const withWiki = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-be-'));
  fs.mkdirSync(path.join(withWiki, 'atris', 'wiki'), { recursive: true });
  fileBriefFromNotes({
    cwd: withWiki,
    url: 'https://youtu.be/shortid99?si=abc',
    workDir,
    now: '2026-08-15',
  });
  assert.match(
    fs.readFileSync(path.join(withWiki, 'atris', 'wiki', 'briefs', 'youtube-shortid99.md'), 'utf8'),
    /source: https:\/\/youtu\.be\/shortid99\?si=abc/,
  );

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-nowiki-'));
  fileBriefFromNotes({
    cwd: bare,
    url: 'https://youtu.be/shortid99',
    workDir,
    now: new Date('2026-08-15T15:00:00.000Z'),
  });
  assert.equal(fs.existsSync(path.join(bare, 'atris', 'wiki')), false);
  assert.equal(fs.existsSync(path.join(bare, 'atris', 'logs')), false);
});

test('learner check is inferred from a number or named mechanism and otherwise fill this', () => {
  const rich = learnerCheckFromLesson({
    numbers: ['80 people'],
    mechanisms: ['omakase model'],
  });
  assert.equal(rich.inferred, true);
  assert.equal(rich.line, 'what is the omakase model?');
  assert.deepEqual(rich.needles, ['omakase model']);
  assert.equal(scoreLearnerNeedles('apply the pack. keep only if measure.py moves.', rich.needles), 0);
  assert.equal(scoreLearnerNeedles('keep the omakase model as the default stack', rich.needles), 1);

  const thin = learnerCheckFromLesson({ numbers: [], mechanisms: [] });
  assert.equal(thin.inferred, false);
  assert.equal(thin.line, LEARNER_CHECK_FILL);
  assert.deepEqual(thin.needles, []);
  assert.equal(scoreLearnerNeedles('anything at all', thin.needles), 0);
});

function notesApplyWorkspace(id, notes = '# Apply Gate Video\n\nBody.\n') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-apply-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-notes-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(workDir, `yt_${id}.md`), notes);
  return { cwd, workDir };
}

test('youtube notes without --save writes no brief or apply', async () => {
  const url = 'https://www.youtube.com/watch?v=nosave1';
  const { cwd, workDir } = notesApplyWorkspace('nosave1');
  const output = [];

  const status = await youtubeCommand(['notes', url], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.equal(output.includes(APPLY_NEXT_MESSAGE), false);
  assert.equal(output.includes(ephemeralApplyMessage('notes')), false);
  assert.equal(output.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(output.includes(LEARNER_SCORE_ZERO), false);
  assert.equal(output.filter((line) => line === `next: atris youtube teach "${url}"`).length, 1);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-nosave1.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-nosave1.apply.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes keeps written notes for a nocookie embed url when the runner exits 429', async () => {
  const url = 'https://www.youtube-nocookie.com/embed/ntrate1';
  const { cwd, workDir } = notesApplyWorkspace('ntrate1', RICH_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', url], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({
      status: 1,
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
  });

  assert.equal(status, 0);
  assert.equal(keptPrintedNotes({ url, workDir }), true);
  assert.equal(output.filter((line) => line === ephemeralApplyMessage('notes')).length, 1);
  assert.equal(output.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.doesNotMatch(output.join('\n'), /429|Too Many Requests|FAILED/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes keeps written notes for an /e/ url when the runner exits 429', async () => {
  const url = 'https://www.youtube.com/e/ntrate1';
  const { cwd, workDir } = notesApplyWorkspace('ntrate1', RICH_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', url], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({
      status: 1,
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
  });

  assert.equal(status, 0);
  assert.equal(keptPrintedNotes({ url, workDir }), true);
  assert.equal(output.filter((line) => line === ephemeralApplyMessage('notes')).length, 1);
  assert.equal(output.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.doesNotMatch(output.join('\n'), /429|Too Many Requests|FAILED/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes keeps written notes for a shorts url when the runner exits 429', async () => {
  const url = 'https://www.youtube.com/shorts/ntrate1';
  const { cwd, workDir } = notesApplyWorkspace('ntrate1', RICH_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', url], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({
      status: 1,
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
  });

  assert.equal(status, 0);
  assert.equal(keptPrintedNotes({ url, workDir }), true);
  assert.equal(output.filter((line) => line === ephemeralApplyMessage('notes')).length, 1);
  assert.equal(output.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.doesNotMatch(output.join('\n'), /429|Too Many Requests|FAILED/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes keeps written notes when the runner exits 429', async () => {
  const url = 'https://www.youtube.com/watch?v=ntrate1';
  const { cwd, workDir } = notesApplyWorkspace('ntrate1', RICH_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', url], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({
      status: 1,
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
  });

  assert.equal(status, 0);
  assert.equal(keptPrintedNotes({ url, workDir }), true);
  assert.equal(output.filter((line) => line === ephemeralApplyMessage('notes')).length, 1);
  assert.equal(output.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.equal(output.filter((line) => line === `next: atris youtube teach "${url}"`).length, 1);
  assert.doesNotMatch(output.join('\n'), /429|Too Many Requests|FAILED/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes still fails a 429 when no notes file was written', async () => {
  const url = 'https://www.youtube.com/watch?v=empty429';
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-empty429-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-empty429-notes-'));
  const output = [];

  const status = await youtubeCommand(['notes', url], {
    cwd,
    workDir,
    output: (line) => output.push(line),
    runner: () => ({
      status: 1,
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
  });

  assert.equal(status, 1);
  assert.equal(keptPrintedNotes({ url, workDir }), false);
  assert.equal(output.includes(ephemeralApplyMessage('notes')), false);
  assert.doesNotMatch(output.join('\n'), /score: 0|next: atris youtube teach/);
});

test('youtube notes without --save prints one apply next-step when notes are rich', async () => {
  const url = 'https://www.youtube.com/watch?v=rich01';
  const { cwd, workDir } = notesApplyWorkspace('rich01', RICH_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', url], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.equal(output.filter((line) => line === ephemeralApplyMessage('notes')).length, 1);
  assert.equal(output.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.equal(output.filter((line) => line === `next: atris youtube teach "${url}"`).length, 1);
  assert.equal(output.includes(APPLY_NEXT_MESSAGE), false);
  assert.doesNotMatch(output.join('\n'), /next: apply /);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-rich01.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-rich01.apply.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes without --save stay ephemeral even when thin', async () => {
  const url = 'https://www.youtube.com/watch?v=thin00';
  const { cwd, workDir } = notesApplyWorkspace('thin00', THIN_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', url], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.equal(output.includes(TEACH_THIN_REFUSE), false);
  assert.equal(output.includes(ephemeralApplyMessage('notes')), false);
  assert.equal(output.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(output.includes(LEARNER_SCORE_ZERO), false);
  assert.doesNotMatch(output.join('\n'), /what is the point of/);
  assert.equal(output.filter((line) => line === `next: atris youtube teach "${url}"`).length, 1);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes failed runner prints no apply next-step', async () => {
  const url = 'https://www.youtube.com/watch?v=fail01';
  const { cwd, workDir } = notesApplyWorkspace('fail01', RICH_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', url], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 1 }),
  });

  assert.equal(status, 1);
  assert.equal(output.includes(ephemeralApplyMessage('notes')), false);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube teach/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-fail01.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes --json stays quiet on the teach next-step', async () => {
  const url = 'https://www.youtube.com/watch?v=json01';
  const { cwd, workDir } = notesApplyWorkspace('json01', RICH_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', url, '--json'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube teach/);
  assert.doesNotMatch(output.join('\n'), /^check:/m);
  assert.equal(output.includes(LEARNER_SCORE_ZERO), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes --json thin notes stay quiet on the teach next-step', async () => {
  const url = 'https://www.youtube.com/watch?v=json02';
  const { cwd, workDir } = notesApplyWorkspace('json02', THIN_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', url, '--json'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube teach/);
  assert.equal(output.includes(TEACH_THIN_REFUSE), false);
  assert.equal(output.includes(ephemeralApplyMessage('notes')), false);
  assert.doesNotMatch(output.join('\n'), /^check:/m);
  assert.equal(output.includes(LEARNER_SCORE_ZERO), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes --save --json thin notes stay quiet on the teach next-step', async () => {
  const url = 'https://www.youtube.com/watch?v=json03';
  const { cwd, workDir } = notesApplyWorkspace('json03', THIN_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', url, '--save', '--json'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 2);
  assert.equal(output.includes(TEACH_THIN_REFUSE), true);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube teach/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes batch without --save prints apply and check for the first ok url', async () => {
  const first = 'https://www.youtube.com/watch?v=richb1';
  const second = 'https://www.youtube.com/watch?v=richb2';
  const { cwd, workDir } = notesApplyWorkspace('richb1', RICH_NOTES);
  fs.writeFileSync(path.join(workDir, 'yt_richb2.md'), THIN_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', first, second], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.match(output.join('\n'), /url or id  seconds  result/);
  assert.equal(output.filter((line) => line === ephemeralApplyMessage('notes')).length, 1);
  assert.equal(output.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.equal(output.filter((line) => line === `next: atris youtube teach "${first}"`).length, 1);
  assert.equal(output.filter((line) => line === `next: atris youtube teach "${second}"`).length, 0);
  assert.equal(output.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes batch without --save prints fill-this when the first ok notes are thin', async () => {
  const first = 'https://www.youtube.com/watch?v=thinb1';
  const second = 'https://www.youtube.com/watch?v=richb3';
  const { cwd, workDir } = notesApplyWorkspace('thinb1', THIN_NOTES);
  fs.writeFileSync(path.join(workDir, 'yt_richb3.md'), RICH_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', first, second], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.equal(output.includes(TEACH_THIN_REFUSE), false);
  assert.equal(output.includes(ephemeralApplyMessage('notes')), false);
  assert.equal(output.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(output.includes(LEARNER_SCORE_ZERO), false);
  assert.doesNotMatch(output.join('\n'), /what is the omakase model/);
  assert.equal(output.filter((line) => line === `next: atris youtube teach "${first}"`).length, 1);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes batch --json stays quiet on apply check and teach', async () => {
  const first = 'https://www.youtube.com/watch?v=jsonb1';
  const second = 'https://www.youtube.com/watch?v=jsonb2';
  const { cwd, workDir } = notesApplyWorkspace('jsonb1', RICH_NOTES);
  fs.writeFileSync(path.join(workDir, 'yt_jsonb2.md'), RICH_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', first, second, '--json'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.match(output.join('\n'), /url or id  seconds  result/);
  assert.equal(output.includes(ephemeralApplyMessage('notes')), false);
  assert.doesNotMatch(output.join('\n'), /^check:/m);
  assert.equal(output.includes(LEARNER_SCORE_ZERO), false);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube teach/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube notes empty notes print one teach next-step', async () => {
  const url = 'https://www.youtube.com/watch?v=empty1';
  const { cwd, workDir } = notesApplyWorkspace('empty1', '');
  const output = [];

  const status = await youtubeCommand(['notes', url], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.equal(output.includes(ephemeralApplyMessage('notes')), false);
  assert.equal(output.filter((line) => line === `next: atris youtube teach "${url}"`).length, 1);
});

test('youtube notes --save writes a pack-named apply and a next-line', async () => {
  const url = 'https://www.youtube.com/watch?v=apply01';
  const { cwd, workDir } = notesApplyWorkspace('apply01', RICH_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', url, '--save'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.equal(output.includes(ephemeralApplyMessage('notes')), false);
  assert.doesNotMatch(output.join('\n'), /next: atris youtube teach/);
  assert.match(output.join('\n'), /next: atris experiments keep notes-apply01/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-apply01.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'notes-apply01', 'measure.py')), true);
  const stub = fs.readFileSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-apply01.apply.md'), 'utf8');
  assert.match(stub, /source: https:\/\/www\.youtube\.com\/watch\?v=apply01/);
  assert.match(stub, /^change: apply atris\/experiments\/notes-apply01$/m);
  assert.match(stub, /^receipt: keep only if measure\.py moves 0→1/m);
  assert.doesNotMatch(stub, /omakase model/i);
  assert.doesNotMatch(stub, /fill this/i);
  const journal = fs.readFileSync(path.join(cwd, 'atris', 'logs', '2026', '2026-08-26.md'), 'utf8');
  assert.match(journal, /\[claimable\] apply: atris\/experiments\/notes-apply01\. keep only if measure\.py moves 0→1/);
});

test('youtube notes with an apply receipt is complete', async () => {
  const url = 'https://youtu.be/apply02';
  const { cwd, workDir } = notesApplyWorkspace('apply02', RICH_NOTES);
  const applyDir = path.join(cwd, 'atris', 'wiki', 'briefs');
  fs.mkdirSync(applyDir, { recursive: true });
  const applyPath = path.join(applyDir, 'youtube-apply02.apply.md');
  const filled = [
    `source: ${url}`,
    'change: commands/youtube.js',
    'receipt: node --test test/youtube.test.js',
    '',
  ].join('\n');
  fs.writeFileSync(applyPath, filled);
  const output = [];

  const status = await youtubeCommand(['notes', url, '--save'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.equal(output.includes(APPLY_NEXT_MESSAGE), false);
  assert.equal(fs.readFileSync(applyPath, 'utf8'), filled);
  assert.equal(ensureNotesApply({ cwd, url, now: '2026-08-26', output: () => {} }), 0);
});

test('youtube notes --save without wiki is incomplete when apply is missing', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-apply-nowiki-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-notes-nowiki-'));
  fs.writeFileSync(path.join(workDir, 'yt_apply03.md'), RICH_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', 'https://youtu.be/apply03', '--save'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 2);
  assert.match(output.join('\n'), /incomplete: apply missing/);
  assert.doesNotMatch(output.join('\n'), /invented success|score: 0/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'notes-apply03', 'measure.py')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
});

test('youtube notes --save refuses thin notes and writes no brief', async () => {
  const url = 'https://www.youtube.com/watch?v=thin01';
  const { cwd, workDir } = notesApplyWorkspace('thin01', THIN_NOTES);
  const output = [];

  const status = await youtubeCommand(['notes', url, '--save'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: (line) => output.push(line),
    runner: () => ({ status: 0 }),
  });

  assert.equal(status, 2);
  assert.equal(output.includes(TEACH_THIN_REFUSE), true);
  assert.equal(output.filter((line) => line === `next: atris youtube teach "${url}"`).length, 1);
  assert.equal(output.includes(APPLY_NEXT_MESSAGE), false);
  assert.equal(output.includes(ephemeralApplyMessage('notes')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-thin01.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-thin01.apply.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube unsave removes filed brief apply and notes pack', async () => {
  const url = 'https://www.youtube.com/watch?v=gone01';
  const { cwd, workDir } = notesApplyWorkspace('gone01', RICH_NOTES);
  const saveStatus = await youtubeCommand(['notes', url, '--save'], {
    cwd,
    workDir,
    now: '2026-08-26',
    output: () => {},
    runner: () => ({ status: 0 }),
  });
  assert.equal(saveStatus, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-gone01.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-gone01.apply.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'notes-gone01', 'measure.py')), true);

  const output = [];
  const status = await youtubeCommand(['unsave', url], {
    cwd,
    output: (line) => output.push(line),
    runner: () => {
      throw new Error('unsave must not run notes');
    },
  });

  assert.equal(status, 0);
  assert.match(output.join('\n'), /removed atris\/wiki\/briefs\/youtube-gone01\.md and atris\/wiki\/briefs\/youtube-gone01\.apply\.md and atris\/experiments\/notes-gone01/);
  assert.deepEqual(
    output.filter((line) => String(line).startsWith('next:')),
    ['next: atris youtube search " "'],
  );
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-gone01.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-gone01.apply.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'notes-gone01')), false);
});

test('youtube unsave removes leftover packs when brief and apply are already gone', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-unsave-packs-'));
  const notesPack = path.join(cwd, 'atris', 'experiments', 'notes-gone03');
  const teachPack = path.join(cwd, 'atris', 'experiments', 'teach-gone03-s2');
  const otherPack = path.join(cwd, 'atris', 'experiments', 'notes-other99');
  fs.mkdirSync(notesPack, { recursive: true });
  fs.mkdirSync(teachPack, { recursive: true });
  fs.mkdirSync(otherPack, { recursive: true });
  fs.writeFileSync(path.join(notesPack, 'measure.py'), 'print(0)\n');
  fs.writeFileSync(path.join(teachPack, 'measure.py'), 'print(0)\n');
  fs.writeFileSync(path.join(otherPack, 'stay.txt'), 'ok\n');

  const output = [];
  const status = await youtubeCommand(['unsave', 'gone03'], {
    cwd,
    output: (line) => output.push(line),
    runner: () => {
      throw new Error('unsave must not run notes');
    },
  });

  assert.equal(status, 0);
  assert.match(output.join('\n'), /removed atris\/experiments\/notes-gone03 and atris\/experiments\/teach-gone03-s2/);
  assert.deepEqual(
    output.filter((line) => String(line).startsWith('next:')),
    ['next: atris youtube search " "'],
  );
  assert.equal(fs.existsSync(notesPack), false);
  assert.equal(fs.existsSync(teachPack), false);
  assert.equal(fs.existsSync(path.join(otherPack, 'stay.txt')), true);
});

test('youtube notes --unsave and a missing id stay quiet', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-unsave-'));
  const output = [];
  const status = await youtubeCommand(['notes', '--unsave', 'gone02'], {
    cwd,
    output: (line) => output.push(line),
    runner: () => {
      throw new Error('unsave must not run notes');
    },
  });

  assert.equal(status, 0);
  assert.match(output.join('\n'), /already gone: atris\/wiki\/briefs\/youtube-gone02\.md and atris\/wiki\/briefs\/youtube-gone02\.apply\.md/);
  assert.deepEqual(
    output.filter((line) => String(line).startsWith('next:')),
    ['next: atris youtube search " "'],
  );
  assert.equal(unsaveYoutubeNotes('gone02', { cwd, output: () => {} }), 0);
});

test('youtube unsave without a target prints usage and no next line', async () => {
  const output = [];
  const status = await youtubeCommand(['unsave'], {
    output: (line) => output.push(line),
    runner: () => {
      throw new Error('unsave must not run notes');
    },
  });

  assert.equal(status, 2);
  assert.match(output.join('\n'), /usage: atris youtube unsave <url-or-id>/);
  assert.equal(output.join('\n').includes('next:'), false);

  const notesOut = [];
  const notesStatus = await youtubeCommand(['notes', '--unsave'], {
    output: (line) => notesOut.push(line),
    runner: () => {
      throw new Error('unsave must not run notes');
    },
  });
  assert.equal(notesStatus, 2);
  assert.match(notesOut.join('\n'), /usage: atris youtube unsave <url-or-id>/);
  assert.equal(notesOut.join('\n').includes('next:'), false);
});

test('youtube unsave --json and multi-target print the search next-step once or not at all', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-unsave-json-'));
  const jsonOut = [];
  const jsonStatus = await youtubeCommand(['unsave', '--json', 'gone04'], {
    cwd,
    output: (line) => jsonOut.push(line),
    runner: () => {
      throw new Error('unsave must not run notes');
    },
  });
  assert.equal(jsonStatus, 0);
  assert.match(jsonOut.join('\n'), /already gone: atris\/wiki\/briefs\/youtube-gone04\.md/);
  assert.equal(jsonOut.join('\n').includes('next:'), false);

  const multiOut = [];
  const multiStatus = await youtubeCommand(['unsave', 'gone05', 'gone06'], {
    cwd,
    output: (line) => multiOut.push(line),
    runner: () => {
      throw new Error('unsave must not run notes');
    },
  });
  assert.equal(multiStatus, 0);
  assert.match(multiOut.join('\n'), /already gone: atris\/wiki\/briefs\/youtube-gone05\.md/);
  assert.match(multiOut.join('\n'), /already gone: atris\/wiki\/briefs\/youtube-gone06\.md/);
  assert.deepEqual(
    multiOut.filter((line) => String(line).startsWith('next:')),
    ['next: atris youtube search " "'],
  );
});

test('youtube help says notes stay ephemeral unless --save', async () => {
  const output = [];
  const status = await youtubeCommand(['--help'], {
    output: (line) => output.push(line),
  });
  const text = output.join('\n');
  assert.equal(status, 0);
  assert.match(text, /ephemeral unless --save; hands off to teach/);
  assert.match(text, /rich ephemeral notes\/teach print one apply next-step/);
  assert.match(text, /rich notes\/teach mint a keep\/revert experiment/);
  assert.match(text, /teach <youtube-url>/);
  assert.match(text, /one chapter from local captions/);
  assert.match(text, /unsave <url-or-id>/);
  assert.match(text, /matching notes\/teach experiment packs/);
  assert.match(text, /needs a filled Apply/);
  assert.match(text, /rich process writes one apply and a failing keep\/revert pack/);
});

test('youtube process without apply exits 2 and never calls the api', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-process-noapply-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const output = [];
  let apiCalls = 0;
  let extractCalls = 0;
  let authCalls = 0;

  const status = await youtubeCommand(['process', 'https://youtu.be/proc01'], {
    cwd,
    now: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => {
      authCalls += 1;
      return { credentials: { token: 'token-123' } };
    },
    extractLocalTranscript: async () => {
      extractCalls += 1;
      return null;
    },
    apiRequestJson: async () => {
      apiCalls += 1;
      return { ok: true, status: 200, data: {} };
    },
  });

  assert.equal(status, 2);
  assert.equal(apiCalls, 0);
  assert.equal(extractCalls, 0);
  assert.equal(authCalls, 0);
  assert.equal(output.includes(PROCESS_APPLY_MESSAGE), true);
  const stub = fs.readFileSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-proc01.apply.md'), 'utf8');
  assert.match(stub, /^change: fill this$/m);
  assert.match(stub, /^receipt: fill this$/m);
});

test('youtube process with a stub-only apply refuses without rewriting it', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-process-stub-'));
  const applyDir = path.join(cwd, 'atris', 'wiki', 'briefs');
  fs.mkdirSync(applyDir, { recursive: true });
  const applyPath = path.join(applyDir, 'youtube-proc02.apply.md');
  const stub = [
    'source: https://youtu.be/proc02',
    'change: fill this',
    'receipt: fill this',
    '',
  ].join('\n');
  fs.writeFileSync(applyPath, stub);
  const output = [];
  let apiCalls = 0;

  const status = await youtubeCommand(['https://youtu.be/proc02'], {
    cwd,
    now: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    extractLocalTranscript: async () => null,
    apiRequestJson: async () => {
      apiCalls += 1;
      return { ok: true, status: 200, data: {} };
    },
  });

  assert.equal(status, 2);
  assert.equal(apiCalls, 0);
  assert.equal(output.includes(PROCESS_APPLY_MESSAGE), true);
  assert.equal(fs.readFileSync(applyPath, 'utf8'), stub);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
});

test('youtube process mints only the youtube scope after an expired user wall and retries', async () => {
  const calls = [];
  const persisted = [];
  const output = [];
  const secret = 'minted-youtube-secret';
  const url = 'https://youtube.com/watch?v=abc123';
  const cwd = filledApplyWorkspace('abc123', url);

  const status = await youtubeCommand([
    url,
    '--query',
    'Extract lessons',
  ], {
    cwd,
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
    extractLocalTranscript: async () => null,
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
          status: 'success',
          message: 'YouTube video processed successfully',
          video_analysis: 'Main insight.',
          credits_used: 5,
          credits_remaining: 42,
        },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls[0].pathname, '/auth/agent-token');
  assert.equal(calls[0].options.token, 'user-jwt');
  assert.deepEqual(calls[0].options.body.scopes, ['youtube']);
  assert.equal(calls[0].options.body.scopes.includes('x-search'), false);
  assert.equal(calls[1].pathname, '/agent/process_youtube');
  assert.equal(calls[1].options.token, secret);
  assert.deepEqual(persisted, [secret]);
  assert.match(output.join('\n'), /Main insight/);
  assert.doesNotMatch(output.join('\n'), new RegExp(secret));
  assert.doesNotMatch(output.join('\n'), /\/auth\/cli|Choose login method|Opening browser/);
});

test('youtube process remints after a billed 401 and retries once', async () => {
  const calls = [];
  const secret = 'minted-youtube-after-401';
  const url = 'https://youtube.com/watch?v=abc123';
  const cwd = filledApplyWorkspace('abc123', url);
  const status = await youtubeCommand([url], {
    cwd,
    output: () => {},
    ensureValidCredentials: async () => ({ credentials: { token: 'user-jwt' } }),
    loadCredentials: () => ({ token: 'user-jwt', refresh_token: 'refresh-jwt' }),
    persistMintedAgentToken: () => {},
    extractLocalTranscript: async () => null,
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, token: options.token, body: options.body });
      if (pathname === '/agent/process_youtube' && options.token === 'user-jwt') {
        return { ok: false, status: 401, error: 'agent token required' };
      }
      if (pathname === '/auth/agent-token') {
        assert.deepEqual(options.body.scopes, ['youtube']);
        return { ok: true, status: 200, data: { access_token: secret, scopes: ['youtube'] } };
      }
      return {
        ok: true,
        status: 200,
        data: { status: 'success', message: 'ok', video_analysis: 'retried' },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls[0].pathname, '/agent/process_youtube');
  assert.equal(calls[0].token, 'user-jwt');
  assert.equal(calls[1].pathname, '/auth/agent-token');
  assert.equal(calls[2].pathname, '/agent/process_youtube');
  assert.equal(calls[2].token, secret);
});

test('youtube process with no stored JWT fails in one sentence and stays off the login wall', async () => {
  const output = [];
  let apiCalls = 0;
  const url = 'https://youtube.com/watch?v=abc123';
  const cwd = filledApplyWorkspace('abc123', url);
  const status = await youtubeCommand([url], {
    cwd,
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ error: 'not_logged_in' }),
    loadCredentials: () => null,
    extractLocalTranscript: async () => {
      throw new Error('should not extract');
    },
    apiRequestJson: async () => {
      apiCalls += 1;
      return { ok: true, status: 200, data: {} };
    },
  });
  assert.equal(status, 1);
  assert.equal(apiCalls, 0);
  assert.equal(output.join('\n').trim(), 'not signed in. run atris login first.');
  assert.doesNotMatch(output.join('\n'), /\/auth\/cli|Choose login method|Opening browser|https:\/\//);
});

test('processExperimentSlug prefixes the video id', () => {
  assert.equal(processExperimentSlug('procrich'), 'process-procrich');
  assert.equal(processExperimentSlug('ABC_123'), 'process-abc-123');
});

test('youtube process prints keep next and score 0 after a rich analysis', async () => {
  const url = 'https://youtu.be/procrich';
  const cwd = filledApplyWorkspace('procrich', url);
  const output = [];

  const status = await youtubeCommand(['process', url], {
    cwd,
    now: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    extractLocalTranscript: async () => null,
    apiRequestJson: async () => stubRichProcess(),
  });

  assert.equal(status, 0);
  assert.match(output.join('\n'), /YouTube video processed successfully/);
  assert.equal(output.filter((line) => line === 'check: what is the omakase model?').length, 0);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(
    output.filter((line) => String(line).startsWith('next:')),
    ['next: atris experiments keep process-procrich'],
  );
  assert.ok(
    output.indexOf('next: atris experiments keep process-procrich')
      < output.indexOf(LEARNER_SCORE_ZERO),
  );
  assert.equal(output.includes(PROCESS_APPLY_MESSAGE), false);
  assert.equal(output.includes(ephemeralApplyMessage('process')), false);
  const claim = assertProcessApplyClaimable(cwd, {
    id: 'procrich',
    tokens: ['omakase model', 'what is the omakase model?'],
  });
  assert.equal(fs.existsSync(path.join(cwd, claim.packRel, 'measure.py')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-procrich.apply.md')), true);
});

test('youtube process --json stays quiet on the learner check', async () => {
  const url = 'https://youtu.be/procjson';
  const cwd = filledApplyWorkspace('procjson', url);
  const output = [];

  const status = await youtubeCommand(['process', url, '--json'], {
    cwd,
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    extractLocalTranscript: async () => null,
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: {
        status: 'success',
        video_analysis: RICH_NOTES,
        credits_used: 5,
      },
    }),
  });

  assert.equal(status, 0);
  const parsed = JSON.parse(output.join('\n'));
  assert.equal(parsed.video_analysis, RICH_NOTES);
  assert.doesNotMatch(output.join('\n'), /^check:/m);
  assert.doesNotMatch(output.join('\n'), /score: 0/);
  assert.equal(output.filter((line) => String(line).startsWith('next:')).length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, processApplyRel('procjson'))), false);
});

test('youtube process without apply prints no learner check', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-process-nocheck-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const output = [];

  const status = await youtubeCommand(['process', 'https://youtu.be/procnone'], {
    cwd,
    now: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    extractLocalTranscript: async () => null,
    apiRequestJson: async () => ({ ok: true, status: 200, data: {} }),
  });

  assert.equal(status, 2);
  assert.equal(output.includes(PROCESS_APPLY_MESSAGE), true);
  assert.doesNotMatch(output.join('\n'), /^check:/m);
  assert.doesNotMatch(output.join('\n'), /score: 0/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, processApplyRel('procnone'))), false);
});

test('rich youtube process mints a measure.py that validate.py accepts and scores 0 or 1 honestly', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const url = 'https://youtu.be/procpack';
  const cwd = filledApplyWorkspace('procpack', url);
  const output = [];
  const status = await youtubeCommand(['process', url], {
    cwd,
    now: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    extractLocalTranscript: async () => null,
    apiRequestJson: async () => stubRichProcess(),
  });

  assert.equal(status, 0);
  assert.equal(output.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(output.join('\n'), /next: atris experiments keep process-procpack/);
  const packDir = path.join(cwd, 'atris', 'experiments', 'process-procpack');
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

  const claim = assertProcessApplyClaimable(cwd, {
    id: 'procpack',
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

  const keep = runExperimentsKeep(cwd, 'process-procpack');
  assert.equal(keep.status, 1, keep.stderr || keep.stdout);
  assert.match(keep.stderr + keep.stdout, /revert|score 0|keep only if/i);
});

test('youtube unsave after rich process removes the minted pack', async () => {
  const url = 'https://youtu.be/procgone';
  const cwd = filledApplyWorkspace('procgone', url);
  const save = await youtubeCommand(['process', url], {
    cwd,
    now: '2026-08-26',
    output: () => {},
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    extractLocalTranscript: async () => null,
    apiRequestJson: async () => stubRichProcess(),
  });
  assert.equal(save, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'process-procgone', 'measure.py')), true);
  assert.equal(fs.existsSync(path.join(cwd, processApplyRel('procgone'))), true);

  const output = [];
  const status = await youtubeCommand(['unsave', 'procgone'], {
    cwd,
    output: (line) => output.push(line),
    runner: () => {
      throw new Error('unsave must not run notes');
    },
  });
  assert.equal(status, 0);
  assert.match(output.join('\n'), /atris\/experiments\/process-procgone/);
  assert.match(output.join('\n'), /atris\/wiki\/briefs\/process-procgone\.apply\.md/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'process-procgone')), false);
  assert.equal(fs.existsSync(path.join(cwd, processApplyRel('procgone'))), false);
});

test('formatYoutubeResult includes metadata, credits, and analysis', () => {
  const text = formatYoutubeResult({
    message: 'done',
    video_analysis: 'Analysis text.',
    credits_used: 5,
    credits_remaining: 10,
    metadata: {
      title: 'T',
      channel: 'C',
      duration_seconds: 4459,
      processing_method: 'client_transcript_atris_fast',
      transcript_source: 'client_transcript',
    },
  });

  assert.match(text, /Title: T/);
  assert.match(text, /Channel: C/);
  assert.match(text, /Duration: 01:14:19/);
  assert.match(text, /Processing: client_transcript_atris_fast via client_transcript/);
  assert.match(text, /Credits: 5 used, 10 remaining/);
  assert.match(text, /Analysis text/);
});
