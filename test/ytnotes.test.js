'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const YTNOTES = path.resolve(__dirname, '..', 'scripts', 'det', 'ytnotes');

function writeExec(file, body) {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

test('ytnotes keeps a written vtt when yt-dlp exits 429', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-429-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    'printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntrate1.en.vtt',
    'printf "%s\\n" "ntrate1|Omakase Clip|37signals|0:02"',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntrate1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_ntrate1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes keeps a written manual English vtt when auto captions are absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-manual-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    'has_write_subs=0',
    'for arg in "$@"; do',
    '  [ "$arg" = "--write-subs" ] && has_write_subs=1',
    'done',
    'if [ "$has_write_subs" -eq 1 ]; then',
    '  printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntman1.en.vtt',
    'fi',
    'printf "%s\\n" "ntman1|Omakase Clip|37signals|0:02"',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntman1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_ntman1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes keeps a written auto English vtt when manual captions are absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-auto-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    'has_write_auto=0',
    'for arg in "$@"; do',
    '  [ "$arg" = "--write-auto-subs" ] && has_write_auto=1',
    'done',
    'if [ "$has_write_auto" -eq 1 ]; then',
    '  printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntauto1.en-orig.vtt',
    'fi',
    'printf "%s\\n" "ntauto1|Omakase Clip|37signals|0:02"',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntauto1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_ntauto1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes keeps a written en-orig vtt when yt-dlp skips .en.vtt', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-enorig-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    'printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntrate2.en-orig.vtt',
    'printf "%s\\n" "ntrate2|Omakase Clip|37signals|0:02"',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntrate2'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_ntrate2.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes still fails a 429 when no captions were written', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-empty429-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'echo "claude should not run" >&2',
    'exit 1',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=empty429'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr || '', /No English captions/);
  assert.equal(fs.existsSync(path.join(work, 'ytnotes', 'yt_empty429.md')), false);
});
