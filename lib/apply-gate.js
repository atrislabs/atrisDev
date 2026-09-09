'use strict';

const fs = require('fs');
const path = require('path');

function dateStamp(now) {
  if (typeof now === 'string' && /^\d{4}-\d{2}-\d{2}/.test(now)) {
    return now.slice(0, 10);
  }
  const value = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(value.getTime())) return new Date().toISOString().slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function parseApplyFields(text) {
  const change = String(text || '').match(/^change:\s*(.+)$/im);
  const receipt = String(text || '').match(/^receipt:\s*(.+)$/im);
  return {
    change: change ? change[1].trim() : '',
    receipt: receipt ? receipt[1].trim() : '',
  };
}

function isFilledApply(fields) {
  const empty = (value) => !value || /^fill this$/i.test(value);
  return !empty(fields.change) && !empty(fields.receipt);
}

function isLearnerKeepApply(fields) {
  const change = String((fields && fields.change) || '');
  const receipt = String((fields && fields.receipt) || '');
  return /^apply\s+atris\/experiments\//i.test(change)
    || /keep only if measure\.py moves 0/.test(receipt);
}

function isFilledHumanApply(fields) {
  return isFilledApply(fields) && !isLearnerKeepApply(fields);
}

function applySlug(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'query';
}

function applySidecarRel(kind, id) {
  return `atris/wiki/briefs/${kind}-${id}.apply.md`;
}

function readApplyReceipt({ cwd, rel } = {}) {
  if (!rel || !cwd) return null;
  const abs = path.join(cwd, rel);
  if (!fs.existsSync(abs)) return null;
  return { rel, text: fs.readFileSync(abs, 'utf8') };
}

function writeApplyStub({ cwd, source, rel, now, change, receipt, journalLine, force } = {}) {
  try {
    if (!rel || !cwd) return null;
    const wikiDir = path.join(cwd, 'atris', 'wiki');
    if (!fs.existsSync(wikiDir)) return null;

    const abs = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const changeText = change || 'fill this';
    const receiptText = receipt || 'fill this';
    let shouldWrite = force === true || !fs.existsSync(abs);
    if (!shouldWrite && change && receipt) {
      shouldWrite = !isFilledApply(parseApplyFields(fs.readFileSync(abs, 'utf8')));
    }
    if (shouldWrite) {
      fs.writeFileSync(abs, [
        `source: ${source}`,
        `change: ${changeText}`,
        `receipt: ${receiptText}`,
      ].join('\n') + '\n');
    }

    const date = dateStamp(now);
    const journalPath = path.join(cwd, 'atris', 'logs', date.slice(0, 4), `${date}.md`);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    let existing = '';
    if (fs.existsSync(journalPath)) existing = fs.readFileSync(journalPath, 'utf8');
    const line = journalLine || `- [claimable] apply: fill this -> ${rel}`;
    if (!existing.includes(line)) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(journalPath, `${existing}${prefix}${line}\n`);
    }
    return rel;
  } catch {
    return null;
  }
}

function ensureApply({
  cwd, source, rel, now, output, incompleteMessage, required = true, change, receipt, journalLine,
  human = false,
} = {}) {
  const print = typeof output === 'function' ? output : (line = '') => console.error(line);
  const existing = readApplyReceipt({ cwd, rel });
  const fields = existing ? parseApplyFields(existing.text) : null;
  const keepSidecar = Boolean(human && fields && isLearnerKeepApply(fields));
  if (existing && isFilledApply(fields) && !keepSidecar) return 0;
  if (!(required && existing) || keepSidecar) {
    writeApplyStub({ cwd, source, rel, now, change, receipt, journalLine, force: keepSidecar });
  }
  print(incompleteMessage);
  return required ? 2 : 0;
}

function ephemeralApplyMessage(kind) {
  const label = String(kind || '').trim() || 'result';
  return `next: write one apply (change + receipt) for this ${label}`;
}

function hintEphemeralApply(output, kind) {
  const print = typeof output === 'function' ? output : (line = '') => console.error(line);
  print(ephemeralApplyMessage(kind));
  return 0;
}

module.exports = {
  applySlug,
  applySidecarRel,
  ensureApply,
  ephemeralApplyMessage,
  hintEphemeralApply,
  isFilledApply,
  isFilledHumanApply,
  isLearnerKeepApply,
};
