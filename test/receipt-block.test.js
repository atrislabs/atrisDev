const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  renderCard,
  renderPageSection,
  renderEmailLine,
  renderMorningCardRow,
} = require('../lib/receipt-block');
const { renderDefaultNow } = require('../commands/now');

function fixtureReceipt(overrides = {}) {
  return {
    schema: 'atris.mission_receipt.v1',
    mission_id: 'mission-receipt-block',
    objective: 'Receipt block proof',
    owner: 'codex',
    at: '2026-07-09T15:30:00.000Z',
    verifier: 'node --test test/receipt-block.test.js',
    result: {
      kind: 'mission_tick',
      tick_count: 1,
      tick: {
        status: 'ran',
        tick_index: 3,
        summary: 'Receipt block renders the proof once.',
      },
      verifier_result: {
        passed: true,
        command: 'node --test test/receipt-block.test.js',
      },
      worktree: {
        new_since_baseline_count: 4,
      },
      landing: {
        schema: 'atris.result_landing.v1',
        status: 'proof_ready',
        changed: 'Receipt block renders the proof once.',
        checked: 'Behavior checks passed.',
        next: 'Ship the receipt block.',
      },
    },
    ...overrides,
  };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-receipt-block-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('receipt block renders all four surfaces deterministically', () => {
  const receipt = fixtureReceipt();

  assert.deepEqual(renderCard(receipt), {
    kind: 'statement',
    headline: 'Receipt block renders the proof once.',
    text: 'Receipt block renders the proof once.',
    kicker: 'mission receipt',
    sub: 'Check it: behavior checks passed',
    brand: 'atris',
    size: 'og',
    theme: 'atris',
  });
  assert.equal(renderPageSection(receipt), [
    '## mission receipt',
    '',
    'Receipt block renders the proof once.',
    'Check it: behavior checks passed.',
    'Next: Ship the receipt block.',
    '',
    'details: 4 changed files; status proof_ready; mission mission-receipt-block',
  ].join('\n'));
  assert.equal(
    renderEmailLine(receipt),
    'Receipt block renders the proof once. Check it: behavior checks passed.',
  );
  assert.equal(
    renderMorningCardRow(receipt),
    '- Receipt block renders the proof once. Check it: behavior checks passed',
  );
});

test('morning row closes long mission text without ellipsis fragments', () => {
  const receipt = fixtureReceipt();
  receipt.result.landing.changed = 'Ready-mission proof, historical digest landings, stale-work actions, and freshness counts now agree in plain language, so live operator surfaces no longer contradict themselves.';
  const row = renderMorningCardRow(receipt);
  assert.doesNotMatch(row, /\.\.\.|…/);
  assert.doesNotMatch(row, /\b(?:and|or|but|with|to|for|from|by|the|a|an)$/);
  assert.match(row, /so live operator surfaces no longer contradict themselves/);

  receipt.result.landing.changed = 'Task landing validation now rejects dangling as-exists grammar while recognizing reduced risk as a real consequence, so clear actions pass.';
  const adjectiveBoundary = renderMorningCardRow(receipt);
  assert.match(adjectiveBoundary, /real consequence/);
  assert.doesNotMatch(adjectiveBoundary, /as a real;/);
});

test('mission proof renders as a direct passed fact instead of first-person process', () => {
  const receipt = fixtureReceipt();
  receipt.result.landing.checked = 'I ran the behavior checks.';

  assert.equal(
    renderEmailLine(receipt),
    'Receipt block renders the proof once. Check it: the behavior checks passed.',
  );
  assert.doesNotMatch(renderMorningCardRow(receipt), /\bi ran\b/i);
});

test('a link wins the check line and stays bare so it copies clean', () => {
  const receipt = fixtureReceipt();
  receipt.result.landing.checked = 'Live at https://github.com/atris/atrisos-web/pull/412 now.';
  assert.equal(
    renderEmailLine(receipt),
    'Receipt block renders the proof once. Check it: https://github.com/atris/atrisos-web/pull/412',
  );

  const explicit = fixtureReceipt();
  explicit.result.landing.link = 'https://snowpine.atris.ai/book';
  assert.match(renderPageSection(explicit), /^Check it: https:\/\/snowpine\.atris\.ai\/book$/m);
  assert.equal(renderCard(explicit).sub, 'Check it: https://snowpine.atris.ai/book');
});

test('receipt surface never leads with machinery words', () => {
  const receipt = fixtureReceipt();
  delete receipt.result.landing.checked;
  delete receipt.result.landing.tested;
  const surfaces = [renderEmailLine(receipt), renderMorningCardRow(receipt), renderCard(receipt).sub];
  for (const line of surfaces) {
    assert.doesNotMatch(line, /verifier|receipt says|receipt is present|we know because|task_id|tick\b/i);
  }
  // With only a verifier result, the check names the command that passed, in plain words.
  assert.equal(
    renderEmailLine(receipt),
    'Receipt block renders the proof once. Check it: node --test test/receipt-block.test.js passed.',
  );

  const bare = { objective: 'Login now blocks anyone without an invite', result: { passed: true } };
  assert.equal(renderEmailLine(bare), 'Login now blocks anyone without an invite. Check it: the checks passed.');
  assert.equal(renderEmailLine({ objective: 'Nothing checked', result: {} }), 'Nothing checked.');
});

test('morning card shows mission receipt rows through the receipt block renderer', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# demo map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# todo\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'atris', 'runs', 'mission-receipt-block.json'),
      JSON.stringify(fixtureReceipt({ at: new Date().toISOString() }), null, 2),
      'utf8',
    );

    const content = renderDefaultNow(dir);

    assert.match(
      content,
      /- Receipt block renders the proof once\. Check it: behavior checks passed/,
    );
    assert.match(content, /Completed receipts today: 1/);
  } finally {
    cleanup(dir);
  }
});
