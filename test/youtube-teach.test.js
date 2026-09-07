'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parseTeachArgs,
  parseCaptionCues,
  normalizeChapters,
  sliceCuesForChapter,
  formatTeachLesson,
  extractTeachNumbers,
  extractTeachMechanisms,
  extractTeachSource,
  parseYtDlpInfoJson,
  oneTeachCheck,
  learnerCheckFromLesson,
  scoreLearnerNeedles,
  proveSavedLearnerBaseline,
  LEARNER_CHECK_FILL,
  LEARNER_SCORE_ZERO,
  isThinTeachLesson,
  TEACH_THIN_REFUSE,
  TEACH_RESUME_NEXT,
  TEACH_WATCH_TICK_NEXT,
  teachExperimentSlug,
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

const TEACH_URL = 'https://www.youtube.com/watch?v=teach01';
const TEACH_VTT = [
  'WEBVTT',
  '',
  '00:00:02.000 --> 00:00:06.000',
  '37signals has 80 people and uses the omakase model',
  '',
  '00:00:20.000 --> 00:00:24.000',
  'Basecamp ships once a week',
  '',
  '00:10:00.000 --> 00:10:06.000',
  'Shape Up is a six-week cycle with a cooldown',
  '',
].join('\n');

const TEACH_CHAPTERS = [
  { start_time: 0, title: 'Omakase', end_time: 60 },
  { start_time: 600, title: 'Shape Up', end_time: 900 },
];

const LEX_URL = 'https://www.youtube.com/watch?v=NYFGCESmikA';
const LEX_VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:08.000',
  'Who would not get delirious if a genie says',
  '',
  '00:00:08.000 --> 00:00:16.000',
  'every feature you have ever dreamed of in an operating',
  'system I can deliver',
  '',
  '00:00:16.000 --> 00:00:22.000',
  'most of them in five minutes a few in 20',
  '',
  '00:00:22.000 --> 00:00:30.000',
  'I want the operating system that can install',
  'in less than 60 seconds',
  '',
  '00:00:30.000 --> 00:00:38.000',
  'I want the diver watch that can go down the Mariana Trench',
  '',
  '00:00:38.000 --> 00:00:46.000',
  'just think "holy fuck, i\'m alive."',
  '',
  '00:00:46.000 --> 00:00:54.000',
  'The Overton window does not open itself',
  '',
].join('\n');

const LEX_CHAPTERS = [
  { start_time: 0, title: 'Episode highlight', end_time: 87 },
  { start_time: 87, title: 'Introduction', end_time: 176 },
];

const THIN_URL = 'https://www.youtube.com/watch?v=thin01';
const THIN_VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:08.000',
  'welcome back friends this is just a chat',
  '',
  '00:00:08.000 --> 00:00:16.000',
  'today we talk about feelings and vibes',
].join('\n');
const THIN_CHAPTERS = [
  { start_time: 0, title: 'Welcome', end_time: 30 },
];
const THIN_MULTI_VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:08.000',
  'welcome back friends this is just a chat',
  '',
  '00:00:20.000 --> 00:00:28.000',
  'today we talk about feelings and vibes',
].join('\n');
const THIN_MULTI_CHAPTERS = [
  { start_time: 0, title: 'Welcome', end_time: 15 },
  { start_time: 15, title: 'More vibes', end_time: 30 },
];

function lessonBlock(text, name) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line) => line === name);
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) break;
    out.push(lines[i]);
  }
  return out;
}

function lexHighlightLesson() {
  const chapters = normalizeChapters(LEX_CHAPTERS, 176);
  const cues = sliceCuesForChapter(parseCaptionCues(LEX_VTT), chapters[0]);
  return {
    chapters,
    cues,
    body: cues.map((cue) => cue.text).join(' '),
    text: formatTeachLesson({
      url: LEX_URL,
      section: 1,
      chapters,
      chapter: chapters[0],
      cues,
      title: 'DHH: Future of Programming | Lex Fridman Podcast #501',
    }),
  };
}

function collect() {
  const lines = [];
  return {
    lines,
    output: (line = '') => lines.push(String(line)),
    text: () => lines.join('\n'),
  };
}

function nextLines(text, prefix) {
  return String(text || '').split('\n').filter((line) => line.startsWith(prefix));
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

function runExperimentsRevert(cwd, slug) {
  return spawnSync(process.execPath, [CLI_PATH, 'experiments', 'revert', slug], {
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

function assertTeachApplyClaimable(cwd, { id, section, tokens = [], date = '2026-08-27' } = {}) {
  const packRel = `atris/experiments/${teachExperimentSlug(id, section)}`;
  const applyRel = `atris/wiki/briefs/youtube-${id}-s${section}.apply.md`;
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
  assert.match(journal, /scores 1 only when the fixture contains the check tokens/);
  return { packRel, applyRel, sidecar, journal };
}

function fixtureSource() {
  return {
    id: 'teach01',
    title: 'DHH on Lex Fridman',
    url: TEACH_URL,
    durationSeconds: 900,
    language: 'en',
    chapters: TEACH_CHAPTERS,
    cues: parseCaptionCues(TEACH_VTT),
  };
}

function lexSource() {
  return {
    id: 'NYFGCESmikA',
    title: 'DHH: Future of Programming | Lex Fridman Podcast #501',
    url: LEX_URL,
    durationSeconds: 176,
    language: 'en',
    chapters: LEX_CHAPTERS,
    cues: parseCaptionCues(LEX_VTT),
  };
}

function oneChapterSource() {
  return {
    id: 'teach01',
    title: 'DHH on Lex Fridman',
    url: TEACH_URL,
    durationSeconds: 60,
    language: 'en',
    chapters: [TEACH_CHAPTERS[0]],
    cues: parseCaptionCues(TEACH_VTT),
  };
}

function thinSource() {
  return {
    id: 'thin01',
    title: 'a thin chat',
    url: THIN_URL,
    durationSeconds: 30,
    language: 'en',
    chapters: THIN_CHAPTERS,
    cues: parseCaptionCues(THIN_VTT),
  };
}

function thinMultiSource() {
  return {
    id: 'thin01',
    title: 'a thin chat',
    url: THIN_URL,
    durationSeconds: 30,
    language: 'en',
    chapters: THIN_MULTI_CHAPTERS,
    cues: parseCaptionCues(THIN_MULTI_VTT),
  };
}

test('oneTeachCheck uses a number or named mechanism and otherwise fill this', () => {
  assert.equal(oneTeachCheck(['omakase model'], []), 'what is the omakase model?');
  assert.equal(oneTeachCheck([], ['80 people']), 'what does 80 people measure in this chapter?');
  assert.equal(oneTeachCheck([], []), LEARNER_CHECK_FILL);
  assert.notEqual(oneTeachCheck([], [], 'a thin chat'), 'what is the point of a thin chat?');
  const thin = learnerCheckFromLesson({ numbers: [], mechanisms: [] });
  assert.equal(thin.inferred, false);
  assert.equal(thin.line, LEARNER_CHECK_FILL);
  assert.equal(scoreLearnerNeedles('keep the omakase model', ['omakase model']), 1);
  assert.equal(scoreLearnerNeedles('apply the pack only', ['omakase model']), 0);
});

test('proveSavedLearnerBaseline requires a failing apply fixture', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-baseline-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki', 'briefs'), { recursive: true });
  const applyRel = 'atris/wiki/briefs/youtube-base01.apply.md';
  const lesson = { numbers: [], mechanisms: ['omakase model'] };
  const out = collect();
  assert.equal(proveSavedLearnerBaseline({ cwd, applyRel, lesson, output: out.output }), 2);
  assert.match(out.text(), /apply missing/);

  fs.writeFileSync(path.join(cwd, applyRel), 'source: x\nchange: apply pack\nreceipt: keep only if measure.py moves 0→1.\n');
  const failOut = collect();
  assert.equal(proveSavedLearnerBaseline({ cwd, applyRel, lesson, output: failOut.output }), 0);
  assert.equal(failOut.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);

  fs.appendFileSync(path.join(cwd, applyRel), '\nkeep the omakase model\n');
  const passOut = collect();
  assert.equal(proveSavedLearnerBaseline({ cwd, applyRel, lesson, output: passOut.output }), 2);
  assert.match(passOut.text(), /check already passes/);

  const thinOut = collect();
  assert.equal(proveSavedLearnerBaseline({
    cwd,
    applyRel,
    lesson: { numbers: [], mechanisms: [] },
    output: thinOut.output,
  }), 2);
  assert.match(thinOut.text(), /no measurable check/);
});

test('teachExperimentSlug lowercases the video id for validate.py', () => {
  assert.equal(teachExperimentSlug('teach01', 1), 'teach-teach01-s1');
  assert.equal(teachExperimentSlug('NYFGCESmikA', 1), 'teach-nyfgcesmika-s1');
  assert.equal(teachExperimentSlug('abc_def', 2), 'teach-abc-def-s2');
});

test('parseTeachArgs defaults to section 1 and accepts --section and --save', () => {
  assert.deepEqual(parseTeachArgs([TEACH_URL]), {
    help: false,
    save: false,
    json: false,
    skip: false,
    owed: false,
    resume: false,
    next: false,
    recap: null,
    url: TEACH_URL,
    section: 1,
  });
  assert.equal(parseTeachArgs([TEACH_URL, '--section', '2']).section, 2);
  assert.equal(parseTeachArgs([TEACH_URL, '--section=3']).section, 3);
  assert.equal(parseTeachArgs([TEACH_URL, '--save']).save, true);
  assert.equal(parseTeachArgs([TEACH_URL, '--recap', 'omakase model']).recap, 'omakase model');
  assert.equal(parseTeachArgs([TEACH_URL, '--recap=omakase model']).recap, 'omakase model');
  assert.equal(parseTeachArgs(['recap', 'omakase model']).recap, 'omakase model');
  assert.equal(parseTeachArgs([TEACH_URL, '--skip']).skip, true);
  assert.equal(parseTeachArgs(['skip']).skip, true);
  assert.equal(parseTeachArgs(['owed']).owed, true);
  assert.equal(parseTeachArgs(['owed']).resume, false);
  assert.equal(parseTeachArgs(['--owed']).owed, true);
  assert.equal(parseTeachArgs(['next']).next, true);
  assert.equal(parseTeachArgs(['next']).owed, false);
  assert.equal(parseTeachArgs(['next']).resume, false);
  assert.equal(parseTeachArgs(['next']).url, null);
  assert.equal(parseTeachArgs([TEACH_URL, '--json']).json, true);
  assert.equal(parseTeachArgs(['--help']).help, true);
  assert.equal(parseTeachArgs([]).help, false);
  assert.equal(parseTeachArgs([]).owed, true);
  assert.equal(parseTeachArgs([]).resume, true);
  assert.equal(parseTeachArgs([]).next, false);
  assert.throws(() => parseTeachArgs([TEACH_URL, '--paid']), /drop --paid/);
  assert.throws(() => parseTeachArgs([TEACH_URL, '--section', '0']), /positive integer/);
  assert.throws(() => parseTeachArgs(['--section', '2']), /Missing YouTube URL/);
  assert.throws(() => parseTeachArgs(['recap']), /unpaid check/);
});

test('parseCaptionCues and sliceCuesForChapter keep one chapter from fixture VTT', () => {
  const cues = parseCaptionCues(TEACH_VTT);
  const chapters = normalizeChapters(TEACH_CHAPTERS, 900);
  assert.equal(cues.length, 3);
  assert.equal(chapters.length, 2);

  const first = sliceCuesForChapter(cues, chapters[0]);
  const second = sliceCuesForChapter(cues, chapters[1]);
  assert.equal(first.length, 2);
  assert.match(first.map((cue) => cue.text).join(' '), /80 people/);
  assert.match(first.map((cue) => cue.text).join(' '), /omakase/);
  assert.doesNotMatch(first.map((cue) => cue.text).join(' '), /Shape Up/);
  assert.equal(second.length, 1);
  assert.match(second[0].text, /six-week cycle/);
});

test('lex highlight fixture keeps claim-bearing numbers and named mechanisms', () => {
  const { body, text } = lexHighlightLesson();
  assert.match(body, /holy fuck/i);
  assert.match(body, /\b20\b/);
  assert.match(body, /60 seconds/i);
  assert.match(body, /overton window/i);

  const numbers = extractTeachNumbers(body);
  const mechanisms = extractTeachMechanisms(body);
  for (const line of numbers) {
    assert.match(line, /\d/);
    assert.match(line, /[a-z]/i);
    assert.doesNotMatch(line, /^\d[\d,]*$/);
  }
  for (const line of mechanisms) {
    assert.doesNotMatch(line, /holy|fuck|i'm alive/i);
    assert.doesNotMatch(line, /^(who|every|holy|the overton|mariana trench)$/);
    assert.match(line, /window|model|principle|pattern|loop|cycle|method|rule|doctrine|framework|heuristic|\d+[a-z]/i);
  }
  assert.ok(numbers.some((line) => /60 seconds to install/i.test(line)));
  assert.ok(mechanisms.some((line) => /overton window/i.test(line)));
  assert.equal(mechanisms.some((line) => /holy fuck/i.test(line)), false);

  const printedNumbers = lessonBlock(text, 'numbers');
  const printedMechanisms = lessonBlock(text, 'mechanisms');
  const check = lessonBlock(text, 'check')[0] || '';
  for (const line of printedNumbers) {
    if (line === 'none') continue;
    assert.match(line, /\d/);
    assert.match(line, /[a-z]/i);
    assert.doesNotMatch(line, /^\d[\d,]*$/);
  }
  for (const line of printedMechanisms) {
    if (line === 'none') continue;
    assert.doesNotMatch(line, /holy|fuck/i);
  }
  assert.match(text, /60 seconds to install/);
  assert.match(text, /overton window/);
  assert.match(check, /overton window|60 seconds to install/);
  assert.doesNotMatch(check, /holy|fuck/i);
  assert.match(text, /next: atris youtube teach recap TEXT or atris youtube teach skip/);
});

test('formatTeachLesson prints numbers, mechanisms, one check, and the recap next line', () => {
  const cues = parseCaptionCues(TEACH_VTT);
  const chapters = normalizeChapters(TEACH_CHAPTERS, 900);
  const text = formatTeachLesson({
    url: TEACH_URL,
    section: 1,
    chapters,
    chapter: chapters[0],
    cues: sliceCuesForChapter(cues, chapters[0]),
    title: 'DHH on Lex Fridman',
  });

  assert.match(text, /section 1\/2  omakase/);
  assert.match(text, /80 people/);
  assert.match(text, /omakase/);
  assert.match(text, /check\nwhat is /);
  assert.deepEqual(nextLines(text, TEACH_RESUME_NEXT), [TEACH_RESUME_NEXT]);
  assert.deepEqual(nextLines(text, TEACH_WATCH_TICK_NEXT), []);
  assert.doesNotMatch(text, /next: last section/);
  assert.doesNotMatch(text, /six-week|--section 2/);
});

test('formatTeachLesson last section omits the dead last-section next line', () => {
  const cues = parseCaptionCues(TEACH_VTT);
  const chapters = normalizeChapters(TEACH_CHAPTERS, 900);
  const text = formatTeachLesson({
    url: TEACH_URL,
    section: 2,
    chapters,
    chapter: chapters[1],
    cues: sliceCuesForChapter(cues, chapters[1]),
    title: 'DHH on Lex Fridman',
  });

  assert.match(text, /section 2\/2  shape up/);
  assert.match(text, /six-week/);
  assert.match(text, /check\nwhat is /);
  assert.doesNotMatch(text, /next: last section/);
  assert.deepEqual(nextLines(text, TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(text, TEACH_WATCH_TICK_NEXT), []);
  assert.doesNotMatch(text, /80 people/);
});

test('youtube help lists youtube teach', async () => {
  const out = collect();
  const status = await youtubeCommand(['--help'], { output: out.output });
  assert.equal(status, 0);
  assert.match(out.text(), /teach <youtube-url>/);
  assert.match(out.text(), /--section N/);
  assert.match(out.text(), /--recap TEXT/);
  assert.match(out.text(), /--skip/);
  assert.match(out.text(), /\bowed\b/);
  assert.match(out.text(), /teach next/);
  assert.match(out.text(), /unpaid teach check|unpaid check/);
  assert.match(out.text(), /one chapter from local captions/);
});

test('youtube teach prints one chapter from fixture captions and chapters', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-print-'));
  const out = collect();
  let apiCalls = 0;
  const status = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
    apiRequestJson: async () => {
      apiCalls += 1;
      return { ok: true, status: 200, data: {} };
    },
  });

  assert.equal(status, 0);
  assert.equal(apiCalls, 0);
  const text = out.text();
  assert.match(text, /section 1\/2  omakase/);
  assert.match(text, /80 people/);
  assert.match(text, /omakase/);
  assert.match(text, /check\nwhat is /);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(nextLines(text, TEACH_RESUME_NEXT), [TEACH_RESUME_NEXT]);
  assert.deepEqual(nextLines(text, TEACH_WATCH_TICK_NEXT), []);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 1);
  assert.doesNotMatch(text, /six-week/);
  assert.doesNotMatch(text, /process_youtube/);
});

test('youtube teach prints the lex highlight as 60s install, Overton, and a real check', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-lex-'));
  const out = collect();
  const status = await youtubeCommand(['teach', LEX_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => ({
      id: 'NYFGCESmikA',
      title: 'DHH: Future of Programming | Lex Fridman Podcast #501',
      url: LEX_URL,
      durationSeconds: 176,
      language: 'en',
      chapters: LEX_CHAPTERS,
      cues: parseCaptionCues(LEX_VTT),
    }),
  });

  assert.equal(status, 0);
  const text = out.text();
  assert.match(text, /60 seconds to install/);
  assert.match(text, /overton window/);
  assert.match(text, /check\nwhat is the overton window\?/);
  assert.doesNotMatch(text, /holy fuck/);
  assert.doesNotMatch(text, /^20$/m);
  assert.doesNotMatch(text, /^60$/m);
  assert.deepEqual(nextLines(text, TEACH_RESUME_NEXT), [TEACH_RESUME_NEXT]);
  assert.deepEqual(nextLines(text, TEACH_WATCH_TICK_NEXT), []);
});

test('youtube teach --section 2 prints the second chapter after skip', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-s2-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);
  const skipped = await youtubeCommand(['teach', '--skip'], {
    cwd,
    output: () => {},
    extractTeachSource: async () => {
      throw new Error('skip must not fetch captions');
    },
  });
  assert.equal(skipped, 0);

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  const text = out.text();
  assert.match(text, /section 2\/2  shape up/);
  assert.match(text, /six-week/);
  assert.doesNotMatch(text, /80 people/);
  assert.doesNotMatch(text, /next: last section/);
  assert.deepEqual(nextLines(text, TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(text, TEACH_WATCH_TICK_NEXT), [TEACH_WATCH_TICK_NEXT]);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 1);
});

test('youtube teach last section of a one-chapter video prints watch-tick next', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-one-'));
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => oneChapterSource(),
  });

  assert.equal(status, 0);
  const text = out.text();
  assert.match(text, /section 1\/1  omakase/);
  assert.deepEqual(nextLines(text, TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(text, TEACH_WATCH_TICK_NEXT), [TEACH_WATCH_TICK_NEXT]);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 1);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
});

test('youtube teach section past the end prints no watch-tick next', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-past-'));
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '3'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 2);
  assert.match(out.text(), /section 3 is past 2 chapters/);
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
});

test('youtube teach without --save writes no atris files', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-nosave-'));
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 1);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.doesNotMatch(out.text(), /next: apply /);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
});

test('youtube teach without --save prints a failing learner check', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-ephemeral-check-'));
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === 'check: what is the omakase model?').length, 1);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 1);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.ok(
    out.lines.indexOf(ephemeralApplyMessage('teach'))
      < out.lines.indexOf('check: what is the omakase model?'),
  );
  assert.ok(
    out.lines.indexOf('check: what is the omakase model?')
      < out.lines.indexOf(LEARNER_SCORE_ZERO),
  );
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), [TEACH_RESUME_NEXT]);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('youtube teach --save writes one pack-named apply claimable', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-save-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.equal(out.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(out.text(), /next: atris experiments keep teach-teach01-s1/);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1', 'measure.py')), true);
  const claim = assertTeachApplyClaimable(cwd, {
    id: 'teach01',
    section: 1,
    tokens: ['omakase model', 'what is the omakase model?'],
  });
  assert.doesNotMatch(claim.sidecar, /fill this/i);
  assert.doesNotMatch(claim.journal, /apply: fill this/);
});

test('youtube unsave after rich teach --save removes briefs apply and every section pack', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-unsave-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const save1 = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  const skipped = await youtubeCommand(['teach', '--skip'], {
    cwd,
    output: () => {},
    extractTeachSource: async () => {
      throw new Error('skip must not fetch captions');
    },
  });
  assert.equal(skipped, 0);
  const save2 = await youtubeCommand(['teach', TEACH_URL, '--section', '2', '--save'], {
    cwd,
    now: '2026-08-27',
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(save1, 0);
  assert.equal(save2, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.apply.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1', 'measure.py')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-teach01-s2', 'measure.py')), true);

  const keepDir = path.join(cwd, 'atris', 'experiments', 'teach-thin-save');
  fs.mkdirSync(keepDir, { recursive: true });
  fs.writeFileSync(path.join(keepDir, 'keep.txt'), 'stay\n');

  const out = collect();
  const status = await youtubeCommand(['unsave', 'teach01'], {
    cwd,
    output: out.output,
    runner: () => {
      throw new Error('unsave must not run notes');
    },
  });

  assert.equal(status, 0);
  assert.match(out.text(), /removed /);
  assert.match(out.text(), /atris\/wiki\/briefs\/youtube-teach01-s1\.md/);
  assert.match(out.text(), /atris\/wiki\/briefs\/youtube-teach01-s1\.apply\.md/);
  assert.match(out.text(), /atris\/experiments\/teach-teach01-s1/);
  assert.match(out.text(), /atris\/experiments\/teach-teach01-s2/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.apply.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s2.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s2.apply.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-teach01-s2')), false);
  assert.equal(fs.existsSync(path.join(keepDir, 'keep.txt')), true);
});

test('youtube teach --save on lex highlight files the brief and a pack-named apply', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-lex-save-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const out = collect();
  const status = await youtubeCommand(['teach', LEX_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => lexSource(),
  });

  assert.equal(status, 0);
  assert.match(out.text(), /60 seconds to install/);
  assert.match(out.text(), /overton window/);
  assert.match(out.text(), /next: atris experiments keep teach-nyfgcesmika-s1/);
  assert.doesNotMatch(out.text(), /thin: no number or named mechanism/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-NYFGCESmikA-s1.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-nyfgcesmika-s1', 'measure.py')), true);
  assertTeachApplyClaimable(cwd, {
    id: 'NYFGCESmikA',
    section: 1,
    tokens: ['overton window', '60 seconds to install', 'what is the overton window?'],
  });
});

test('youtube teach --save refuses a thin chapter and writes no brief', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-thin-save-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const source = thinSource();
  const body = source.cues.map((cue) => cue.text).join(' ');
  const numbers = extractTeachNumbers(body);
  const mechanisms = extractTeachMechanisms(body);
  assert.deepEqual(numbers, []);
  assert.deepEqual(mechanisms, []);
  assert.equal(isThinTeachLesson({ numbers, mechanisms }), true);

  const out = collect();
  const status = await youtubeCommand(['teach', THIN_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => source,
  });

  const text = out.text();
  assert.equal(status, 2);
  assert.match(text, /numbers\nnone/);
  assert.match(text, /mechanisms\nnone/);
  assert.match(text, new RegExp(TEACH_THIN_REFUSE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(nextLines(text, TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(text, TEACH_WATCH_TICK_NEXT), [TEACH_WATCH_TICK_NEXT]);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-thin01-s1.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-thin01-s1.apply.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube teach rich --save mints a measure.py that validate.py accepts and scores 0 or 1 honestly', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-mint-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  const packDir = path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1');
  for (const name of ['program.md', 'measure.py', 'loop.py', 'reset.py', 'results.tsv']) {
    assert.equal(fs.existsSync(path.join(packDir, name)), true, name);
  }
  const program = fs.readFileSync(path.join(packDir, 'program.md'), 'utf8');
  assert.ok(program.length < 1200);
  assert.match(program, /omakase model/);
  const measureSrc = fs.readFileSync(path.join(packDir, 'measure.py'), 'utf8');
  assert.match(measureSrc, /what is the omakase model\?/);
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
  assert.equal(miss.passed, 0);
  assert.equal(miss.total, 1);
  assert.equal(miss.status, 'fail');

  const hit = scoreFixture('keep the omakase model as the default stack');
  assert.equal(hit.score, 1);
  assert.equal(hit.passed, 1);
  assert.equal(hit.total, 1);
  assert.equal(hit.status, 'pass');

  const claim = assertTeachApplyClaimable(cwd, {
    id: 'teach01',
    section: 1,
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

test('youtube teach rich --save apply sidecar omits check tokens so measure.py scores 0', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-apply-claim-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  const claim = assertTeachApplyClaimable(cwd, {
    id: 'teach01',
    section: 1,
    tokens: ['omakase model', 'what is the omakase model?'],
  });
  assert.match(claim.sidecar, /^change: apply atris\/experiments\/teach-teach01-s1$/m);
  assert.match(claim.sidecar, /^receipt: keep only if measure\.py moves 0→1\. scores 1 only when the fixture contains the check tokens\.$/m);
  assert.match(
    claim.journal,
    /\[claimable\] apply: atris\/experiments\/teach-teach01-s1\. keep only if measure\.py moves 0→1\. scores 1 only when the fixture contains the check tokens\./,
  );

  const measured = spawnSync(pythonCmd, [path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1', 'measure.py')], {
    cwd: path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1'),
    encoding: 'utf8',
    env: { ...process.env, ATRIS_REPO_ROOT: cwd },
  });
  assert.equal(measured.status, 0, measured.stderr || measured.stdout);
  const payload = JSON.parse(measured.stdout.trim().split('\n').pop());
  assert.equal(payload.score, 0);
  assert.equal(payload.status, 'fail');
});

test('experiments keep refuses a minted teach pack at 0 and keeps after check tokens', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-keep-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  const packDir = path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1');
  const applyPath = path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.apply.md');
  assert.equal(fs.existsSync(path.join(packDir, 'measure.py')), true);

  const refused = runExperimentsKeep(cwd, 'teach-teach01-s1');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /revert teach-teach01-s1: measure\.py stayed 0\. refuse keep\./);
  assert.doesNotMatch(`${refused.stdout}\n${refused.stderr}`, /next: atris youtube watch tick/);
  assert.equal(fs.existsSync(path.join(packDir, 'measure.py')), true);

  fs.appendFileSync(applyPath, '\nkeep the omakase model as the default stack\n');
  const kept = runExperimentsKeep(cwd, 'teach-teach01-s1');
  assert.equal(kept.status, 0, kept.stderr || kept.stdout);
  assert.match(kept.stdout, /keep teach-teach01-s1: measure\.py moved 0→1/);
  assert.deepEqual(
    kept.stdout.split('\n').filter((line) => line.startsWith('next: atris youtube watch tick')),
    ['next: atris youtube watch tick']
  );
});

test('experiments revert runs minted reset.py after a refused keep', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-revert-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  const packDir = path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1');
  assert.equal(fs.existsSync(path.join(packDir, 'reset.py')), true);

  const refused = runExperimentsKeep(cwd, 'teach-teach01-s1');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /revert teach-teach01-s1: measure\.py stayed 0\. refuse keep\./);

  const reverted = runExperimentsRevert(cwd, 'teach-teach01-s1');
  assert.equal(reverted.status, 0, reverted.stderr || reverted.stdout);
  assert.match(reverted.stdout, /revert teach-teach01-s1: reset\.py ran/);
  assert.match(reverted.stdout, /^next: atris experiments keep teach-teach01-s1$/m);
  assert.equal(fs.existsSync(path.join(packDir, 'reset.py')), true);
});

test('youtube teach thin chapter without --save still writes no atris files', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-thin-nosave-'));
  const out = collect();
  const status = await youtubeCommand(['teach', THIN_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => thinSource(),
  });

  assert.equal(status, 0);
  assert.match(out.text(), /numbers\nnone/);
  assert.match(out.text(), new RegExp(`check\\n${LEARNER_CHECK_FILL}`));
  assert.doesNotMatch(out.text(), /what is the point of/);
  assert.doesNotMatch(out.text(), /thin: no number or named mechanism/);
  assert.doesNotMatch(out.text(), /next: last section/);
  assert.equal(out.lines.includes(LEARNER_SCORE_ZERO), false);
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), [TEACH_WATCH_TICK_NEXT]);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('youtube teach ephemeral mid-section thin prints recap next only', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-thin-mid-'));
  const out = collect();
  const status = await youtubeCommand(['teach', THIN_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => thinMultiSource(),
  });

  assert.equal(status, 0);
  assert.match(out.text(), /section 1\/2/);
  assert.match(out.text(), /numbers\nnone/);
  assert.match(out.text(), /mechanisms\nnone/);
  assert.match(out.text(), new RegExp(`check\\n${LEARNER_CHECK_FILL}`));
  assert.doesNotMatch(out.text(), /what is the point of/);
  assert.equal(out.lines.includes(LEARNER_SCORE_ZERO), false);
  assert.doesNotMatch(out.text(), /thin: no number or named mechanism/);
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), [TEACH_RESUME_NEXT]);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('youtube teach --save last-section thin refuses and prints watch-tick next', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-thin-save-last-'));
  const out = collect();
  const status = await youtubeCommand(['teach', THIN_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => thinSource(),
  });

  const text = out.text();
  assert.equal(status, 2);
  assert.match(text, /section 1\/1/);
  assert.match(text, new RegExp(escapeRe(TEACH_THIN_REFUSE)));
  assert.deepEqual(nextLines(text, TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(text, TEACH_WATCH_TICK_NEXT), [TEACH_WATCH_TICK_NEXT]);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-thin01-s1.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube teach --save mid-section thin refuses without watch-tick', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-thin-save-mid-'));
  const out = collect();
  const status = await youtubeCommand(['teach', THIN_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => thinMultiSource(),
  });

  const text = out.text();
  assert.equal(status, 2);
  assert.match(text, /section 1\/2/);
  assert.match(text, new RegExp(escapeRe(TEACH_THIN_REFUSE)));
  assert.deepEqual(nextLines(text, TEACH_RESUME_NEXT), [TEACH_RESUME_NEXT]);
  assert.deepEqual(nextLines(text, TEACH_WATCH_TICK_NEXT), []);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube teach --json last-section thin prints no watch-tick next', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-thin-json-'));
  const out = collect();
  const status = await youtubeCommand(['teach', THIN_URL, '--json'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => thinSource(),
  });

  assert.equal(status, 0);
  assert.match(out.text(), /section 1\/1/);
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
  assert.equal(out.lines.includes(LEARNER_SCORE_ZERO), false);
});

test('extractTeachSource reads fixture yt-dlp chapters and VTT without network', async () => {
  const source = await extractTeachSource(TEACH_URL, {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        id: 'teach01',
        title: 'DHH on Lex Fridman',
        duration: 900,
        chapters: TEACH_CHAPTERS,
        automatic_captions: {
          en: [{ ext: 'vtt', url: 'https://www.youtube.com/api/timedtext?v=teach01' }],
        },
      }),
    }),
    fetchCaptionText: async () => TEACH_VTT,
  });

  assert.equal(source.id, 'teach01');
  assert.equal(source.chapters.length, 2);
  assert.equal(source.chapters[0].title, 'Omakase');
  assert.equal(source.cues.length, 3);
  assert.match(source.cues[0].text, /80 people/);
});

test('extractTeachSource keeps parseable yt-dlp json when yt-dlp exits 429', async () => {
  const source = await extractTeachSource(TEACH_URL, {
    spawnSync: () => ({
      status: 1,
      stdout: JSON.stringify({
        id: 'teach01',
        title: 'DHH on Lex Fridman',
        duration: 900,
        chapters: TEACH_CHAPTERS,
        automatic_captions: {
          en: [{ ext: 'vtt', url: 'https://www.youtube.com/api/timedtext?v=teach01' }],
        },
      }),
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
    fetchCaptionText: async () => TEACH_VTT,
  });

  assert.equal(source.id, 'teach01');
  assert.equal(source.chapters.length, 2);
  assert.equal(source.cues.length, 3);
  assert.match(source.cues[0].text, /80 people/);
});

test('extractTeachSource still fails when 429 stdout is empty or broken', async () => {
  const empty = await extractTeachSource(TEACH_URL, {
    spawnSync: () => ({
      status: 1,
      stdout: '',
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
    fetchCaptionText: async () => TEACH_VTT,
  });
  const broken = await extractTeachSource(TEACH_URL, {
    spawnSync: () => ({
      status: 1,
      stdout: '{"id":"teach01"',
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
    fetchCaptionText: async () => TEACH_VTT,
  });

  assert.equal(empty, null);
  assert.equal(broken, null);
  assert.equal(parseYtDlpInfoJson({ status: 1, stdout: '' }), null);
  assert.equal(parseYtDlpInfoJson({ status: 1, stdout: '{"id":"teach01"' }), null);
});

test('youtube teach keeps the lesson when yt-dlp exits 429 with json', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-429-'));
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: out.output,
    spawnSync: () => ({
      status: 1,
      stdout: JSON.stringify({
        id: 'teach01',
        title: 'DHH on Lex Fridman',
        duration: 900,
        chapters: TEACH_CHAPTERS,
        automatic_captions: {
          en: [{ ext: 'vtt', url: 'https://www.youtube.com/api/timedtext?v=teach01' }],
        },
      }),
      stderr: 'ERROR: [youtube] HTTP Error 429: Too Many Requests',
    }),
    fetchCaptionText: async () => TEACH_VTT,
  });

  assert.equal(status, 0);
  assert.match(out.text(), /section 1\/2  omakase/);
  assert.match(out.text(), /check\nwhat is the omakase model\?/);
  assert.doesNotMatch(out.text(), /no english captions|429|Too Many Requests/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('youtube teach without captions prints no apply next-step', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-nocap-'));
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => null,
  });

  assert.equal(status, 2);
  assert.match(out.text(), /no english captions/);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('youtube teach empty tmp section 1 still prints the check and writes no atris tree', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-empty-'));
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  assert.match(out.text(), /section 1\/2  omakase/);
  assert.match(out.text(), /check\nwhat is the omakase model\?/);
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), [TEACH_RESUME_NEXT]);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki')), false);
});

test('youtube teach --section 2 without recap exits 2 and prints the unpaid check', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-unpaid-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const out = collect();
  let extractCalls = 0;
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      return fixtureSource();
    },
  });

  assert.equal(status, 2);
  assert.equal(extractCalls, 0);
  assert.equal(out.text().trim(), 'what is the omakase model?');
  assert.doesNotMatch(out.text(), /section 2\/2/);
  assert.doesNotMatch(out.text(), /shape up/);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
});

test('youtube teach --json stays quiet when a recap is still owed', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-json-owed-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2', '--json'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 2);
  assert.equal(out.text().trim(), '');
  assert.doesNotMatch(out.text(), /omakase|section 2|\{/);
});

test('youtube teach recap with check tokens unlocks the next section', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-recap-ok-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const recapOut = collect();
  const recapped = await youtubeCommand(['teach', 'recap', 'the omakase model is the default stack'], {
    cwd,
    output: recapOut.output,
    extractTeachSource: async () => {
      throw new Error('recap must not fetch captions');
    },
  });
  assert.equal(recapped, 0);
  assert.doesNotMatch(recapOut.text(), /section 2\/2/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 0);
  assert.match(out.text(), /section 2\/2  shape up/);
  assert.match(out.text(), /six-week/);
  assert.doesNotMatch(out.text(), /next: last section/);
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), [TEACH_WATCH_TICK_NEXT]);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 1);
});

test('youtube teach wrong recap still refuses the next section', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-recap-wrong-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const recapOut = collect();
  const recapped = await youtubeCommand(['teach', '--recap', 'feelings and vibes'], {
    cwd,
    output: recapOut.output,
    extractTeachSource: async () => {
      throw new Error('wrong recap must not fetch captions');
    },
  });
  assert.equal(recapped, 2);
  assert.equal(recapOut.text().trim(), 'what is the omakase model?');

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 2);
  assert.equal(out.text().trim(), 'what is the omakase model?');
  assert.doesNotMatch(out.text(), /section 2\/2/);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
});

test('youtube teach --skip unlocks the next section without claiming an answer', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-skip-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const skipOut = collect();
  const skipped = await youtubeCommand(['teach', TEACH_URL, '--skip'], {
    cwd,
    output: skipOut.output,
    extractTeachSource: async () => {
      throw new Error('skip must not fetch captions');
    },
  });
  assert.equal(skipped, 0);
  assert.doesNotMatch(skipOut.text(), /answered|correct|got it/i);
  assert.doesNotMatch(skipOut.text(), /section 2\/2/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 0);
  assert.match(out.text(), /section 2\/2  shape up/);
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), [TEACH_WATCH_TICK_NEXT]);
});

test('youtube teach recap writes no wiki brief apply or experiment pack', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-recap-nowiki-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const recapped = await youtubeCommand(['teach', TEACH_URL, '--recap', '80 people'], {
    cwd,
    now: '2026-08-27',
    output: () => {},
    extractTeachSource: async () => {
      throw new Error('recap must not fetch captions');
    },
  });
  assert.equal(recapped, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube teach --save path stays unchanged after a recap unlock', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-save-recap-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const first = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);
  const recapped = await youtubeCommand(['teach', 'recap', 'omakase model'], {
    cwd,
    output: () => {},
  });
  assert.equal(recapped, 0);

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2', '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.doesNotMatch(out.text(), /next: last section/);
  assert.match(out.text(), /next: atris experiments keep teach-teach01-s2/);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s2.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-teach01-s2', 'measure.py')), true);
});

test('youtube teach owed prints the unpaid check after section 1', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-owed-print-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const out = collect();
  let extractCalls = 0;
  const status = await youtubeCommand(['teach', 'owed'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      throw new Error('owed must not fetch captions');
    },
  });
  assert.equal(status, 0);
  assert.equal(extractCalls, 0);
  assert.match(out.text(), /teach01|watch\?v=teach01/);
  assert.match(out.text(), /section 1/);
  assert.match(out.text(), /what is the omakase model\?/);
  assert.doesNotMatch(out.text(), /section 2\/2|shape up/i);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('youtube teach owed on a fresh cwd prints nothing owed', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-owed-empty-'));
  const out = collect();
  const status = await youtubeCommand(['teach', '--owed'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => {
      throw new Error('owed must not fetch captions');
    },
  });
  assert.equal(status, 0);
  assert.equal(out.text().trim(), 'nothing owed');
  assert.equal(fs.existsSync(path.join(cwd, '.atris', 'youtube-teach-owed.json')), false);
});

test('bare youtube teach with unpaid owed prints the check and one next line', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-bare-owed-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const owedOut = collect();
  const owedStatus = await youtubeCommand(['teach', 'owed'], {
    cwd,
    output: owedOut.output,
    extractTeachSource: async () => {
      throw new Error('owed must not fetch captions');
    },
  });
  assert.equal(owedStatus, 0);

  const out = collect();
  let extractCalls = 0;
  const status = await youtubeCommand(['teach'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      throw new Error('bare teach must not fetch captions');
    },
  });
  assert.equal(status, 0);
  assert.equal(extractCalls, 0);
  assert.match(out.text(), /teach01|watch\?v=teach01/);
  assert.match(out.text(), /section 1/);
  assert.match(out.text(), /what is the omakase model\?/);
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), [TEACH_RESUME_NEXT]);
  assert.equal(out.text().includes(owedOut.text().trim()), true);
  assert.doesNotMatch(out.text(), /Usage:|section 2\/2|shape up/i);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
});

test('bare youtube teach with empty owed prints nothing owed and one start command', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-bare-empty-'));
  const out = collect();
  let extractCalls = 0;
  const status = await youtubeCommand(['teach'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      throw new Error('bare teach must not fetch captions');
    },
  });
  assert.equal(status, 0);
  assert.equal(extractCalls, 0);
  assert.match(out.text(), /nothing owed/);
  assert.match(out.text(), /atris youtube teach <url>/);
  assert.doesNotMatch(out.text(), /Usage:|next: atris youtube teach recap/);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
  assert.equal(fs.existsSync(path.join(cwd, '.atris', 'youtube-teach-owed.json')), false);
});

test('bare youtube teach after skip continues the next chapter without a url', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-bare-skip-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);
  const skipped = await youtubeCommand(['teach', '--skip'], {
    cwd,
    output: () => {},
    extractTeachSource: async () => {
      throw new Error('skip must not fetch captions');
    },
  });
  assert.equal(skipped, 0);

  const owedOut = collect();
  const owedStatus = await youtubeCommand(['teach', 'owed'], {
    cwd,
    output: owedOut.output,
    extractTeachSource: async () => {
      throw new Error('owed must not fetch captions');
    },
  });
  assert.equal(owedStatus, 0);
  assert.equal(owedOut.text().trim(), 'nothing owed');

  const out = collect();
  let extractCalls = 0;
  let extractedUrl = null;
  const status = await youtubeCommand(['teach'], {
    cwd,
    output: out.output,
    extractTeachSource: async (url) => {
      extractCalls += 1;
      extractedUrl = url;
      return fixtureSource();
    },
  });
  assert.equal(status, 0);
  assert.equal(extractCalls, 1);
  assert.equal(extractedUrl, TEACH_URL);
  assert.match(out.text(), /section 2\/2  shape up/);
  assert.match(out.text(), /six-week/);
  assert.doesNotMatch(out.text(), /nothing owed|80 people/);
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), [TEACH_WATCH_TICK_NEXT]);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('bare youtube teach after recap continues the next chapter without a url', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-bare-recap-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);
  const recapped = await youtubeCommand(['teach', 'recap', 'omakase model'], {
    cwd,
    output: () => {},
    extractTeachSource: async () => {
      throw new Error('recap must not fetch captions');
    },
  });
  assert.equal(recapped, 0);

  const out = collect();
  const status = await youtubeCommand(['teach'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 0);
  assert.match(out.text(), /section 2\/2  shape up/);
  assert.match(out.text(), /six-week/);
  assert.doesNotMatch(out.text(), /nothing owed/);
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), [TEACH_WATCH_TICK_NEXT]);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('bare youtube teach --json after skip stays without human next lines', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-bare-json-skip-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);
  const skipped = await youtubeCommand(['teach', '--skip', '--json'], {
    cwd,
    output: () => {},
    extractTeachSource: async () => {
      throw new Error('skip must not fetch captions');
    },
  });
  assert.equal(skipped, 0);

  const out = collect();
  const status = await youtubeCommand(['teach', '--json'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 0);
  assert.match(out.text(), /section 2\/2  shape up/);
  assert.doesNotMatch(out.text(), /nothing owed|next: atris youtube teach/);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
});

test('bare youtube teach unpaid owed still wins over a continue-cursor', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-bare-unpaid-wins-'));
  fs.mkdirSync(path.join(cwd, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.atris', 'youtube-teach-owed.json'), `${JSON.stringify({
    other99: {
      section: 2,
      url: 'https://www.youtube.com/watch?v=other99',
    },
    teach01: {
      section: 1,
      check: 'what is the omakase model?',
      url: TEACH_URL,
    },
  })}\n`);

  const out = collect();
  let extractCalls = 0;
  const status = await youtubeCommand(['teach'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      throw new Error('unpaid owed must not fetch captions');
    },
  });
  assert.equal(status, 0);
  assert.equal(extractCalls, 0);
  assert.match(out.text(), /teach01|watch\?v=teach01/);
  assert.match(out.text(), /section 1/);
  assert.match(out.text(), /what is the omakase model\?/);
  assert.match(out.text(), /next: atris youtube teach recap TEXT or atris youtube teach skip/);
  assert.doesNotMatch(out.text(), /nothing owed|section 2\/2|shape up|other99/i);
});

test('bare youtube teach does not steal a url or --section invocation', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-bare-steal-'));
  let extractCalls = 0;
  const firstOut = collect();
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: firstOut.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      return fixtureSource();
    },
  });
  assert.equal(first, 0);
  assert.equal(extractCalls, 1);
  assert.match(firstOut.text(), /section 1\/2  omakase/);
  assert.match(firstOut.text(), /next: atris youtube teach recap TEXT or atris youtube teach skip/);
  assert.doesNotMatch(firstOut.text(), /nothing owed/);

  const lockedOut = collect();
  const locked = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: lockedOut.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      return fixtureSource();
    },
  });
  assert.equal(locked, 2);
  assert.equal(extractCalls, 1);
  assert.match(lockedOut.text(), /what is the omakase model\?/);
  assert.doesNotMatch(lockedOut.text(), /next: atris youtube teach recap|nothing owed|section 2\/2/);

  const missing = collect();
  const missingStatus = await youtubeCommand(['teach', '--section', '2'], {
    cwd,
    output: missing.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      throw new Error('--section without a url must not fetch captions');
    },
  });
  assert.equal(missingStatus, 2);
  assert.equal(extractCalls, 1);
  assert.match(missing.text(), /Missing YouTube URL/);
  assert.doesNotMatch(missing.text(), /nothing owed|what is the omakase model/);
});

test('youtube teach --help still prints real help', async () => {
  const out = collect();
  const status = await youtubeCommand(['teach', '--help'], { output: out.output });
  assert.equal(status, 0);
  assert.match(out.text(), /Usage:/);
  assert.match(out.text(), /teach <youtube-url>/);
  assert.doesNotMatch(out.text(), /nothing owed/);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), []);
});

test('youtube teach --skip prints the next section command', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-skip-next-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const skipOut = collect();
  const skipped = await youtubeCommand(['teach', TEACH_URL, '--skip'], {
    cwd,
    output: skipOut.output,
    extractTeachSource: async () => {
      throw new Error('skip must not fetch captions');
    },
  });
  assert.equal(skipped, 0);
  assert.match(skipOut.text(), /next: atris youtube teach next/);
  assert.doesNotMatch(skipOut.text(), /--section 2|section 2\/2/);
  assert.deepEqual(nextLines(skipOut.text(), TEACH_WATCH_TICK_NEXT), []);

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 0);
  assert.match(out.text(), /section 2\/2  shape up/);
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), [TEACH_WATCH_TICK_NEXT]);
});

test('youtube teach matching --recap prints the next section command', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-recap-next-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const recapOut = collect();
  const recapped = await youtubeCommand(['teach', TEACH_URL, '--recap', 'omakase model'], {
    cwd,
    output: recapOut.output,
    extractTeachSource: async () => {
      throw new Error('recap must not fetch captions');
    },
  });
  assert.equal(recapped, 0);
  assert.match(recapOut.text(), /next: atris youtube teach next/);
  assert.doesNotMatch(recapOut.text(), /--section 2|section 2\/2/);
  assert.deepEqual(nextLines(recapOut.text(), TEACH_WATCH_TICK_NEXT), []);

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 0);
  assert.match(out.text(), /section 2\/2  shape up/);
  assert.deepEqual(nextLines(out.text(), TEACH_RESUME_NEXT), []);
  assert.deepEqual(nextLines(out.text(), TEACH_WATCH_TICK_NEXT), [TEACH_WATCH_TICK_NEXT]);
});

test('youtube teach --json owed and unlock stay without the human next line', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-json-owed-next-'));
  const empty = collect();
  const emptyStatus = await youtubeCommand(['teach', 'owed', '--json'], {
    cwd,
    output: empty.output,
    extractTeachSource: async () => {
      throw new Error('owed must not fetch captions');
    },
  });
  assert.equal(emptyStatus, 0);
  assert.equal(empty.text().trim(), '[]');
  assert.doesNotMatch(empty.text(), /nothing owed|next:/);

  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const owedOut = collect();
  const owedStatus = await youtubeCommand(['teach', 'owed', '--json'], {
    cwd,
    output: owedOut.output,
    extractTeachSource: async () => {
      throw new Error('owed must not fetch captions');
    },
  });
  assert.equal(owedStatus, 0);
  const owedJson = JSON.parse(owedOut.text().trim());
  assert.equal(Array.isArray(owedJson), true);
  assert.equal(owedJson[0].check, 'what is the omakase model?');
  assert.equal(owedJson[0].section, 1);
  assert.doesNotMatch(owedOut.text(), /next: atris youtube teach|nothing owed/);

  const skipOut = collect();
  const skipped = await youtubeCommand(['teach', TEACH_URL, '--skip', '--json'], {
    cwd,
    output: skipOut.output,
    extractTeachSource: async () => {
      throw new Error('skip must not fetch captions');
    },
  });
  assert.equal(skipped, 0);
  assert.doesNotMatch(skipOut.text(), /next: atris youtube teach/);
});

test('youtube teach next after skip prints section 2 without a url', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-next-skip-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);
  const skipped = await youtubeCommand(['teach', '--skip'], {
    cwd,
    output: () => {},
    extractTeachSource: async () => {
      throw new Error('skip must not fetch captions');
    },
  });
  assert.equal(skipped, 0);

  const out = collect();
  let extractCalls = 0;
  let extractedUrl = null;
  const status = await youtubeCommand(['teach', 'next'], {
    cwd,
    output: out.output,
    extractTeachSource: async (url) => {
      extractCalls += 1;
      extractedUrl = url;
      return fixtureSource();
    },
  });
  assert.equal(status, 0);
  assert.equal(extractCalls, 1);
  assert.equal(extractedUrl, TEACH_URL);
  assert.match(out.text(), /section 2\/2  shape up/);
  assert.match(out.text(), /six-week/);
  assert.doesNotMatch(out.text(), /80 people/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('youtube teach next after recap prints section 2 without a url', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-next-recap-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);
  const recapped = await youtubeCommand(['teach', 'recap', 'omakase model'], {
    cwd,
    output: () => {},
    extractTeachSource: async () => {
      throw new Error('recap must not fetch captions');
    },
  });
  assert.equal(recapped, 0);

  const out = collect();
  const status = await youtubeCommand(['teach', 'next'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 0);
  assert.match(out.text(), /section 2\/2  shape up/);
  assert.match(out.text(), /six-week/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('youtube teach next with an unpaid check reprints it and does not fetch captions', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-next-unpaid-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const out = collect();
  let extractCalls = 0;
  const status = await youtubeCommand(['teach', 'next'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      throw new Error('unpaid next must not fetch captions');
    },
  });
  assert.equal(status, 2);
  assert.equal(extractCalls, 0);
  assert.equal(out.text().trim(), 'what is the omakase model?');
  assert.doesNotMatch(out.text(), /section 2\/2|shape up|nothing owed/i);
});

test('youtube teach next on an empty cwd prints nothing owed and the start command', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-next-empty-'));
  const out = collect();
  let extractCalls = 0;
  const status = await youtubeCommand(['teach', 'next'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      throw new Error('empty next must not fetch captions');
    },
  });
  assert.equal(status, 0);
  assert.equal(extractCalls, 0);
  assert.match(out.text(), /nothing owed/);
  assert.match(out.text(), /atris youtube teach <url>/);
  assert.doesNotMatch(out.text(), /Usage:|section 2\/2|what is the omakase/);
  assert.equal(fs.existsSync(path.join(cwd, '.atris', 'youtube-teach-owed.json')), false);
});

test('youtube teach next --json stays quiet on unpaid and empty continue', async () => {
  const empty = collect();
  const emptyStatus = await youtubeCommand(['teach', 'next', '--json'], {
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-next-json-empty-')),
    output: empty.output,
    extractTeachSource: async () => {
      throw new Error('empty next must not fetch captions');
    },
  });
  assert.equal(emptyStatus, 0);
  assert.equal(empty.text().trim(), '[]');
  assert.doesNotMatch(empty.text(), /nothing owed|next:|Usage:/);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-next-json-unpaid-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const unpaid = collect();
  let extractCalls = 0;
  const unpaidStatus = await youtubeCommand(['teach', 'next', '--json'], {
    cwd,
    output: unpaid.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      throw new Error('unpaid next must not fetch captions');
    },
  });
  assert.equal(unpaidStatus, 2);
  assert.equal(extractCalls, 0);
  assert.equal(unpaid.text().trim(), '');
  assert.doesNotMatch(unpaid.text(), /omakase|next:|section 2/);
});

test('youtube teach next does not steal a url or --section invocation', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-next-steal-'));
  let extractCalls = 0;
  const firstOut = collect();
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: firstOut.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      return fixtureSource();
    },
  });
  assert.equal(first, 0);
  assert.equal(extractCalls, 1);
  assert.match(firstOut.text(), /section 1\/2  omakase/);
  assert.doesNotMatch(firstOut.text(), /nothing owed|teach next/);

  const lockedOut = collect();
  const locked = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: lockedOut.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      return fixtureSource();
    },
  });
  assert.equal(locked, 2);
  assert.equal(extractCalls, 1);
  assert.equal(lockedOut.text().trim(), 'what is the omakase model?');
  assert.doesNotMatch(lockedOut.text(), /section 2\/2|nothing owed/);

  const missing = collect();
  const missingStatus = await youtubeCommand(['teach', '--section', '2'], {
    cwd,
    output: missing.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      throw new Error('--section without a url must not fetch captions');
    },
  });
  assert.equal(missingStatus, 2);
  assert.equal(extractCalls, 1);
  assert.match(missing.text(), /Missing YouTube URL/);
  assert.doesNotMatch(missing.text(), /nothing owed|what is the omakase model|section 2\/2/);
});

test('youtube teach --paid is refused and never bills', async () => {
  const out = collect();
  let extractCalls = 0;
  const status = await youtubeCommand(['teach', TEACH_URL, '--paid'], {
    output: out.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      return fixtureSource();
    },
  });

  assert.equal(status, 2);
  assert.equal(extractCalls, 0);
  assert.match(out.text(), /drop --paid/);
});
