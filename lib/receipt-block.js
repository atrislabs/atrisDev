'use strict';

const { historicalLandingText } = require('./autoland');

function compactLine(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function asciiLine(value) {
  return compactLine(value)
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\S\r\n]+/g, ' ');
}

function lowerLine(value) {
  return asciiLine(value).toLowerCase();
}

function trimPunctuation(value) {
  return asciiLine(value).replace(/[.!?:;,]+$/g, '').trim();
}

function truncateLine(value, max = 180) {
  const text = asciiLine(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function landing(receipt) {
  const value = receipt && receipt.result && receipt.result.landing;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function result(receipt) {
  const value = receipt && receipt.result;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function verifierResult(receipt) {
  const res = result(receipt);
  const value = res.verifier_result || res.tick?.verifier_result || null;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function changedText(receipt) {
  const land = landing(receipt);
  const res = result(receipt);
  const text = land.changed
    || land.happened
    || res.tick?.summary
    || res.tick?.claude?.summary
    || res.tick?.atris2?.receipt_text
    || res.summary
    || receipt?.objective
    || 'mission receipt recorded';
  return lowerLine(text);
}

function statusText(receipt) {
  const land = landing(receipt);
  const res = result(receipt);
  const status = land.status || res.status || res.tick?.status || (res.passed === true ? 'proof_ready' : '');
  return lowerLine(status || 'recorded');
}

function scaleText(receipt) {
  const res = result(receipt);
  const worktree = res.worktree || res.tick?.worktree || {};
  const changedCount = Number(
    worktree.new_since_baseline_count
    || worktree.new_dirty_count
    || worktree.dirty_count
    || 0,
  );
  if (Number.isFinite(changedCount) && changedCount > 0) {
    return changedCount === 1 ? '1 changed file' : `${changedCount} changed files`;
  }

  const tickCount = Number(res.tick_count || 0);
  if (Number.isFinite(tickCount) && tickCount > 0) {
    return tickCount === 1 ? '1 tick' : `${tickCount} ticks`;
  }

  const ranTicks = Number(res.ran_ticks || 0);
  if (Number.isFinite(ranTicks) && ranTicks > 0) {
    return ranTicks === 1 ? '1 ran tick' : `${ranTicks} ran ticks`;
  }

  if (res.tick || res.kind === 'mission_tick' || res.kind === 'mission_run_tick') return '1 tick';
  return '1 receipt';
}

function directProofText(value) {
  const text = lowerLine(value);
  const ran = trimPunctuation(text).match(/^i ran (.+)$/);
  return ran ? `${ran[1]} passed` : text;
}

// A receipt is a text from a good employee: one sentence a friend would send,
// plus one link a stranger can check. Ids, statuses, scores and verifier
// output stay underneath (they feed the rating); they never lead the surface.
// Standard: atris-labs atris/wiki/systems/receipt-standard.md

function sentence(value) {
  const text = trimPunctuation(value);
  if (!text) return '';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

const URL_RE = /https?:\/\/[^\s)>\]]+/i;

function firstUrl(...values) {
  for (const value of values) {
    if (!value) continue;
    const match = String(value).match(URL_RE);
    if (match) return match[0].replace(/[.,;:]+$/, '');
  }
  return '';
}

// The link a stranger can click. Read explicit link fields first, then any
// URL the landing text already mentions. Empty when the receipt has none.
function checkLink(receipt) {
  const land = landing(receipt);
  const res = result(receipt);
  return firstUrl(
    land.link, land.url, land.check_url, land.proof_url,
    res.link, res.url, res.pr_url, res.share_url, res.tick?.pr_url, res.tick?.share_url,
    land.checked, land.tested,
  );
}

// What a reader can check: the link when there is one, else the plain
// check that passed. Never "verifier passed" or "receipt is present".
function checkText(receipt) {
  const link = checkLink(receipt);
  if (link) return link;
  const land = landing(receipt);
  const verifier = verifierResult(receipt);
  if (land.checked) return directProofText(land.checked);
  if (land.tested) return directProofText(land.tested);
  if (verifier) {
    const command = lowerLine(verifier.command || receipt?.verifier || 'the checks');
    return `${command} ${verifier.passed ? 'passed' : 'failed'}`;
  }
  if (result(receipt).passed === true) return 'the checks passed';
  return '';
}

function nextText(receipt) {
  const text = landing(receipt).next || result(receipt).next || '';
  return lowerLine(text);
}

function whatText(receipt, max = 180) {
  return historicalLandingText(trimPunctuation(changedText(receipt)), max);
}

// One line: "What happened. Check it: <link or check>."
function checkLine(receipt, max = 160) {
  const check = trimPunctuation(checkText(receipt));
  if (!check) return '';
  // A link stays bare so it copies clean; a plain check reads as a sentence.
  return URL_RE.test(check) ? `Check it: ${check}` : `Check it: ${truncateLine(check, max)}.`;
}

function renderEmailLine(receipt) {
  const what = sentence(whatText(receipt));
  const check = checkLine(receipt);
  return check ? `${what} ${check}` : what;
}

function renderMorningCardRow(receipt) {
  return `- ${renderEmailLine(receipt).replace(/\.$/, '')}`;
}

// Three lines lead. The machinery (size, status, mission id) sits below as
// details, where a builder can find it and a customer never has to read it.
function renderPageSection(receipt) {
  const next = nextText(receipt);
  const check = checkLine(receipt);
  const lines = ['## mission receipt', '', sentence(whatText(receipt, 160))];
  if (check) lines.push(check);
  if (next) lines.push(`Next: ${sentence(truncateLine(next, 160))}`);
  const details = [scaleText(receipt), `status ${statusText(receipt)}`];
  if (receipt?.mission_id) details.push(`mission ${lowerLine(receipt.mission_id)}`);
  lines.push('', `details: ${details.join('; ')}`);
  return lines.join('\n');
}

function renderCard(receipt) {
  const what = sentence(whatText(receipt, 64));
  const check = trimPunctuation(checkText(receipt));
  return {
    kind: 'statement',
    headline: what,
    text: what,
    kicker: 'mission receipt',
    sub: check ? `Check it: ${truncateLine(check, 88)}` : '',
    brand: 'atris',
    size: 'og',
    theme: 'atris',
  };
}

module.exports = {
  renderCard,
  renderPageSection,
  renderEmailLine,
  renderMorningCardRow,
};
