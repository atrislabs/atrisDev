'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ephemeralApplyMessage,
  hintEphemeralApply,
  ensureApply,
  isFilledHumanApply,
  isLearnerKeepApply,
} = require('../lib/apply-gate');

test('ephemeralApplyMessage names the surface', () => {
  assert.equal(
    ephemeralApplyMessage('notes'),
    'next: write one apply (change + receipt) for this notes',
  );
  assert.equal(
    ephemeralApplyMessage('teach'),
    'next: write one apply (change + receipt) for this teach',
  );
  assert.equal(
    ephemeralApplyMessage('x-search'),
    'next: write one apply (change + receipt) for this x-search',
  );
});

test('hintEphemeralApply prints once and writes no files', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apply-hint-'));
  const output = [];
  const status = hintEphemeralApply((line) => output.push(line), 'notes');
  assert.equal(status, 0);
  assert.deepEqual(output, [ephemeralApplyMessage('notes')]);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('ensureApply still files a sidecar when asked', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apply-save-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki', 'briefs'), { recursive: true });
  const output = [];
  const rel = 'atris/wiki/briefs/youtube-hint01.apply.md';
  const status = ensureApply({
    cwd,
    source: 'https://youtu.be/hint01',
    rel,
    now: '2026-08-28',
    output: (line) => output.push(line),
    incompleteMessage: 'next: apply atris/experiments/notes-hint01',
    required: false,
    change: 'apply atris/experiments/notes-hint01',
    receipt: 'keep only if measure.py moves 0→1',
  });
  assert.equal(status, 0);
  assert.equal(fs.existsSync(path.join(cwd, rel)), true);
  assert.match(output.join('\n'), /next: apply atris\/experiments\/notes-hint01/);
  assert.equal(output.includes(ephemeralApplyMessage('notes')), false);
});

test('ensureApply human gate refuses a leftover notes keep-sidecar', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apply-human-'));
  const applyDir = path.join(cwd, 'atris', 'wiki', 'briefs');
  fs.mkdirSync(applyDir, { recursive: true });
  const rel = 'atris/wiki/briefs/youtube-oldnote1.apply.md';
  fs.writeFileSync(path.join(cwd, rel), [
    'source: https://youtu.be/oldnote1',
    'change: apply atris/experiments/notes-oldnote1',
    'receipt: keep only if measure.py moves 0→1. scores 1 only when the fixture contains the check tokens.',
    '',
  ].join('\n'));
  const output = [];
  const status = ensureApply({
    cwd,
    source: 'https://youtu.be/oldnote1',
    rel,
    now: '2026-08-26',
    output: (line) => output.push(line),
    incompleteMessage: 'write one apply (change + receipt) before process.',
    required: true,
    human: true,
  });
  assert.equal(status, 2);
  assert.deepEqual(output, ['write one apply (change + receipt) before process.']);
  const stub = fs.readFileSync(path.join(cwd, rel), 'utf8');
  assert.match(stub, /^change: fill this$/m);
  assert.match(stub, /^receipt: fill this$/m);
  assert.doesNotMatch(stub, /notes-oldnote1|keep only if measure\.py/);
});

test('ensureApply human gate still accepts a real change and receipt', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apply-human-ok-'));
  const applyDir = path.join(cwd, 'atris', 'wiki', 'briefs');
  fs.mkdirSync(applyDir, { recursive: true });
  const rel = 'atris/wiki/briefs/youtube-human01.apply.md';
  const text = [
    'source: https://youtu.be/human01',
    'change: commands/youtube.js',
    'receipt: node --test test/youtube.test.js',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(cwd, rel), text);
  const fields = { change: 'commands/youtube.js', receipt: 'node --test test/youtube.test.js' };
  assert.equal(isLearnerKeepApply(fields), false);
  assert.equal(isFilledHumanApply(fields), true);
  const output = [];
  const status = ensureApply({
    cwd,
    source: 'https://youtu.be/human01',
    rel,
    now: '2026-08-26',
    output: (line) => output.push(line),
    incompleteMessage: 'write one apply (change + receipt) before process.',
    required: true,
    human: true,
  });
  assert.equal(status, 0);
  assert.deepEqual(output, []);
  assert.equal(fs.readFileSync(path.join(cwd, rel), 'utf8'), text);
});
