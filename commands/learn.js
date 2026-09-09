const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  TYPES,
  SOURCES,
  loadLearnings,
  addLearning,
  searchLearnings,
  findPruneTargets,
  removeLearning,
  getStats,
  exportMarkdown,
} = require('../lib/learnings');
const applyGate = require('../lib/apply-gate');
const {
  fileTeachExperiment,
  extractTeachNumbers,
  extractTeachMechanisms,
  isThinTeachLesson,
  printLearnerCheckGate,
  proveSavedLearnerBaseline,
} = require('./youtube');

const KEEP_RULE = 'keep only if measure.py moves 0→1. scores 1 only when the fixture contains the check tokens.';

function showRecent(limit = 20) {
  const learnings = loadLearnings()
    .filter(e => e._effectiveConfidence > 0 && e.insight !== '[REMOVED]')
    .slice(0, limit);

  if (learnings.length === 0) {
    console.log('');
    console.log('  No learnings yet.');
    console.log('  As you work, use "atris learn add" to capture patterns and pitfalls.');
    console.log('  Or let your agents capture them during review cycles.');
    console.log('');
    return;
  }

  // Group by type
  const byType = {};
  for (const e of learnings) {
    if (!byType[e.type]) byType[e.type] = [];
    byType[e.type].push(e);
  }

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log(`│ Learnings: ${learnings.length} active${' '.repeat(Math.max(0, 44 - String(learnings.length).length))}│`);
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  for (const [type, entries] of Object.entries(byType)) {
    console.log(`  ${type.toUpperCase()}S`);
    for (const e of entries) {
      const conf = e._effectiveConfidence;
      const bar = conf >= 7 ? '●' : conf >= 4 ? '◐' : '○';
      const date = (e.ts || '').split('T')[0];
      console.log(`  ${bar} [${conf}/10] ${e.key}: ${e.insight}`);
      if (e.files && e.files.length > 0) {
        console.log(`         files: ${e.files.join(', ')}`);
      }
    }
    console.log('');
  }
}

function showSearch(query) {
  if (!query) {
    console.log('  Usage: atris learn search <query>');
    return;
  }

  const results = searchLearnings(query);
  if (results.length === 0) {
    console.log(`  No learnings matching "${query}"`);
    return;
  }

  console.log('');
  console.log(`  Search: "${query}", ${results.length} ${results.length === 1 ? 'result' : 'results'}`);
  console.log('');
  for (const e of results) {
    const conf = e._effectiveConfidence;
    const bar = conf >= 7 ? '●' : conf >= 4 ? '◐' : '○';
    console.log(`  ${bar} [${conf}/10] ${e.type}/${e.key}: ${e.insight}`);
  }
  console.log('');
}

function showStats() {
  const stats = getStats();

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Learning Stats                                              │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`  Total:           ${stats.total}`);
  console.log(`  Avg confidence:  ${stats.avgConfidence}/10`);
  console.log(`  High (7+):       ${stats.high}`);
  console.log(`  Medium (4-6):    ${stats.medium}`);
  console.log(`  Low (1-3):       ${stats.low}`);
  console.log('');

  if (Object.keys(stats.byType).length > 0) {
    console.log('  By type:');
    for (const [type, count] of Object.entries(stats.byType)) {
      console.log(`    ${type}: ${count}`);
    }
    console.log('');
  }

  if (Object.keys(stats.bySource).length > 0) {
    console.log('  By source:');
    for (const [source, count] of Object.entries(stats.bySource)) {
      console.log(`    ${source}: ${count}`);
    }
    console.log('');
  }
}

function showExport() {
  const md = exportMarkdown();
  console.log('');
  console.log(md);
  console.log('  Copy the above into CLAUDE.md or save to a file.');
  console.log('');
}

function showPrune() {
  const { stale, contradictions } = findPruneTargets();

  if (stale.length === 0 && contradictions.length === 0) {
    console.log('');
    console.log('  ✓ All learnings are healthy. No stale entries or contradictions.');
    console.log('');
    return;
  }

  console.log('');
  if (stale.length > 0) {
    console.log(`  STALE (${stale.length}, referenced files deleted):`);
    for (const { entry, missingFiles } of stale) {
      console.log(`  ⚠ ${entry.key}, missing: ${missingFiles.join(', ')}`);
    }
    console.log('');
  }

  if (contradictions.length > 0) {
    console.log(`  CONFLICTS (${contradictions.length}, same key, different insight):`);
    for (const { a, b } of contradictions) {
      console.log(`  ⚠ ${a.key}: "${a.insight}" vs "${b.insight}"`);
    }
    console.log('');
  }

  console.log('  Run "atris learn add" to update entries, or manually edit atris/learnings.jsonl');
  console.log('');
}

function commitAddedLearning({ type, key, insight, confidence, source, files } = {}, deps = {}) {
  const print = typeof deps.output === 'function' ? deps.output : (line = '') => console.log(line);
  const cwd = deps.cwd || process.cwd();
  const entry = addLearning({ type, key, insight, confidence, source, files });
  print('');
  print(`  ✓ Saved: [${entry.confidence}/10] ${entry.type}/${entry.key}`);
  print(`    "${entry.insight}"`);
  print('');
  const baseline = mintRichLearn({
    cwd,
    key: entry.key,
    insight: entry.insight,
    now: deps.now,
    output: print,
  });
  return { entry, baseline };
}

function reviewLearningType(insight) {
  return /^(don't|never|avoid|watch out|careful)/i.test(String(insight || '')) ? 'pitfall' : 'pattern';
}

function reviewLearningKey(insight) {
  return String(insight || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 4).join('-');
}

function commitReviewLearning(insight, deps = {}) {
  const print = typeof deps.output === 'function' ? deps.output : (line = '') => console.log(line);
  const cwd = deps.cwd || process.cwd();
  const text = String(insight || '').trim();
  if (!text) return { entry: null, baseline: 0 };
  const type = reviewLearningType(text);
  const key = reviewLearningKey(text);
  const entry = addLearning({ type, key, insight: text, confidence: 7, source: 'review', files: [] });
  print(`✓ Saved to learnings: [7/10] ${entry.type}/${entry.key}`);
  const baseline = mintRichLearn({
    cwd,
    key: entry.key,
    insight: entry.insight,
    now: deps.now,
    output: print,
  });
  return { entry, baseline };
}

function interactiveAdd(deps = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Add Learning                                                │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`  Types: ${TYPES.join(', ')}`);
  console.log('');

  (async () => {
    try {
      const type = (await ask('  Type: ')).trim().toLowerCase();
      if (!TYPES.includes(type)) {
        console.log(`  ✗ Invalid type. Must be one of: ${TYPES.join(', ')}`);
        rl.close();
        return;
      }

      const key = (await ask('  Key (2-5 words, kebab-case): ')).trim();
      if (!key) {
        console.log('  ✗ Key required.');
        rl.close();
        return;
      }

      const insight = (await ask('  Insight (one sentence): ')).trim();
      if (!insight) {
        console.log('  ✗ Insight required.');
        rl.close();
        return;
      }

      const confStr = (await ask('  Confidence (1-10): ')).trim();
      const confidence = parseInt(confStr, 10);
      if (isNaN(confidence) || confidence < 1 || confidence > 10) {
        console.log('  ✗ Confidence must be 1-10.');
        rl.close();
        return;
      }

      const source = (await ask(`  Source (${SOURCES.join('/')}): `)).trim().toLowerCase();
      if (!SOURCES.includes(source)) {
        console.log(`  ✗ Invalid source. Must be one of: ${SOURCES.join(', ')}`);
        rl.close();
        return;
      }

      const filesStr = (await ask('  Related files (comma-separated, or empty): ')).trim();
      const files = filesStr ? filesStr.split(',').map(f => f.trim()).filter(Boolean) : [];

      // Quality gate
      const worth = (await ask('\n  Would this save time in a future session? (y/n): ')).trim().toLowerCase();
      if (worth !== 'y' && worth !== 'yes') {
        console.log('  Skipped, only save learnings that compound.');
        rl.close();
        return;
      }

      commitAddedLearning({ type, key, insight, confidence, source, files }, {
        cwd: deps.cwd || process.cwd(),
        now: deps.now,
        output: deps.output,
      });
      rl.close();
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}`);
      rl.close();
    }
  })();
}

function learnLogSchemaLines() {
  return [
    'Schema: {"type":"pattern|pitfall|preference|architecture|tool","key":"...","insight":"...","confidence":1-10,"source":"observed|user-stated|inferred|review"}',
    'Required: type, key, insight. Aliases: title→key, detail→insight. Optional: confidence (default 5), source (default observed), files[].',
    'Example: atris learn log \'{"type":"pattern","title":"map-first","detail":"check MAP.md before grep","confidence":8}\'',
  ];
}

function printLearnLogSchema(stream = console.error) {
  for (const line of learnLogSchemaLines()) stream(`  ${line}`);
}

function learnExperimentSlug(key) {
  return `learn-${applyGate.applySlug(key)}`;
}

function learnExperimentRel(key) {
  return `atris/experiments/${learnExperimentSlug(key)}`;
}

function learnApplyRel(key) {
  return applyGate.applySidecarRel('learn', applyGate.applySlug(key));
}

function learnLessonFromText(text) {
  const body = String(text || '');
  return {
    numbers: extractTeachNumbers(body),
    mechanisms: extractTeachMechanisms(body),
  };
}

function saveRichLearn({ cwd, key, insight } = {}) {
  const lesson = learnLessonFromText(insight);
  if (isThinTeachLesson(lesson)) {
    return { thin: true, packRel: null, lesson };
  }
  if (cwd) fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const packRel = fileTeachExperiment({
    cwd,
    lesson,
    slug: key ? learnExperimentSlug(key) : null,
    applyRel: key ? learnApplyRel(key) : null,
  });
  return { thin: false, packRel, lesson };
}

function ensureLearnApply({ cwd, key, packRel, now, output } = {}) {
  const pack = packRel || (key ? learnExperimentRel(key) : null);
  const slug = pack ? path.basename(pack) : null;
  return applyGate.ensureApply({
    cwd,
    source: key ? `learn:${key}` : 'learn',
    rel: key ? learnApplyRel(key) : null,
    now,
    output,
    incompleteMessage: slug
      ? `next: atris experiments keep ${slug}`
      : applyGate.ephemeralApplyMessage('learning'),
    required: false,
    change: pack ? `apply ${pack}` : undefined,
    receipt: pack ? KEEP_RULE : undefined,
    journalLine: pack ? `- [claimable] apply: ${pack}. ${KEEP_RULE}` : undefined,
  });
}

function mintRichLearn({ cwd, key, insight, now, output } = {}) {
  const print = typeof output === 'function' ? output : (line = '') => console.log(line);
  const saved = saveRichLearn({ cwd, key, insight });
  if (saved.thin) {
    printLearnerCheckGate(print, saved.lesson, { includeCheck: true });
    return 0;
  }
  ensureLearnApply({
    cwd,
    key,
    packRel: saved.packRel,
    now,
    output: print,
  });
  return proveSavedLearnerBaseline({
    cwd,
    applyRel: key ? learnApplyRel(key) : null,
    lesson: saved.lesson,
    output: print,
  });
}

/**
 * Non-interactive log: `atris learn log '{"type":"pattern","key":"...","insight":"...","confidence":8,"source":"observed"}'`
 * For agents and scripts, no prompts, no quality gate.
 * Aliases: title→key, detail→insight.
 */
function logDirect(jsonStr, deps = {}) {
  const error = typeof deps.error === 'function' ? deps.error : (line = '') => console.error(line);
  const print = typeof deps.output === 'function' ? deps.output : (line = '') => console.log(line);
  const exit = typeof deps.exit === 'function' ? deps.exit : (code) => process.exit(code);
  const cwd = deps.cwd || process.cwd();
  if (!jsonStr) {
    error('  ✗ Usage: atris learn log \'<json>\'');
    printLearnLogSchema(error);
    return exit(1);
  }
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (err) {
    error(`  ✗ Invalid JSON: ${err.message}`);
    printLearnLogSchema(error);
    return exit(1);
  }
  try {
    const entry = addLearning({
      type: data.type,
      key: data.key || data.title,
      insight: data.insight || data.detail,
      confidence: data.confidence || 5,
      source: data.source || 'observed',
      files: data.files || [],
    });
    print(`  ✓ [${entry.confidence}/10] ${entry.type}/${entry.key}`);
    const baseline = mintRichLearn({
      cwd,
      key: entry.key,
      insight: entry.insight,
      now: deps.now,
      output: print,
    });
    if (baseline !== 0) return exit(baseline);
    return 0;
  } catch (err) {
    error(`  ✗ ${err.message}`);
    printLearnLogSchema(error);
    return exit(1);
  }
}

/**
 * Harvest learnings from journal Notes sections.
 * Scans recent journals for lines that look like insights.
 */
function harvestFromJournals(deps = {}) {
  const print = typeof deps.output === 'function' ? deps.output : (line = '') => console.log(line);
  const cwd = deps.cwd || process.cwd();
  const atrisDir = path.join(cwd, 'atris');
  const logsDir = path.join(atrisDir, 'logs');

  if (!fs.existsSync(logsDir)) {
    print('  No journals found.');
    return;
  }

  // Find all journal files, newest first
  const allLogs = [];
  const yearDirs = fs.readdirSync(logsDir).filter(d => /^\d{4}$/.test(d));
  for (const year of yearDirs) {
    const yearPath = path.join(logsDir, year);
    if (fs.statSync(yearPath).isDirectory()) {
      const files = fs.readdirSync(yearPath).filter(f => f.endsWith('.md'));
      files.forEach(f => allLogs.push(path.join(yearPath, f)));
    }
  }
  allLogs.sort().reverse();

  // Scan last 7 journals for Notes section entries
  const candidates = [];
  for (const logPath of allLogs.slice(0, 7)) {
    const content = fs.readFileSync(logPath, 'utf8');
    const notesMatch = content.match(/## Notes\n([\s\S]*?)(?=\n## |$)/);
    if (notesMatch && notesMatch[1].trim()) {
      const lines = notesMatch[1].trim().split('\n').filter(l => l.startsWith('- '));
      for (const line of lines) {
        // Strip bullet and optional timestamp prefix
        const insight = line.replace(/^- (\d{2}:\d{2} \u2014 )?/, '').trim();
        if (insight.length > 10) {
          candidates.push({ insight, source: path.basename(logPath) });
        }
      }
    }
  }

  if (candidates.length === 0) {
    print('');
    print('  No harvestable notes found in recent journals.');
    print('  Add notes during "atris review" or write to ## Notes in your journal.');
    print('');
    return;
  }

  // Check which are already in learnings
  const existing = loadLearnings();
  const existingInsights = new Set(existing.map(e => e.insight.toLowerCase()));
  const fresh = candidates.filter(c => !existingInsights.has(c.insight.toLowerCase()));

  if (fresh.length === 0) {
    print('');
    print(`  Scanned ${candidates.length} journal notes, all already captured.`);
    print('');
    return;
  }

  print('');
  print(`  Found ${fresh.length} new ${fresh.length === 1 ? 'note' : 'notes'} to harvest:`);
  print('');
  for (let i = 0; i < fresh.length; i++) {
    const c = fresh[i];
    const isPitfall = /^(don't|never|avoid|watch out|careful)/i.test(c.insight);
    const type = isPitfall ? 'pitfall' : 'pattern';
    const key = c.insight.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 4).join('-');
    print(`  ${i + 1}. [${type}] ${c.insight}`);
    print(`     from: ${c.source}`);

    try {
      const entry = addLearning({ type, key, insight: c.insight, confidence: 6, source: 'review', files: [] });
      print(`     ✓ saved [6/10]`);
      mintRichLearn({
        cwd,
        key: entry.key,
        insight: entry.insight,
        now: deps.now,
        output: print,
      });
    } catch (err) {
      print(`     ✗ ${err.message}`);
    }
  }
  print('');
}

/**
 * Get learning count for integration with atris activate.
 */
function getLearningCount() {
  const all = loadLearnings().filter(e => e._effectiveConfidence > 0 && e.insight !== '[REMOVED]');
  return all.length;
}

/**
 * Main entry point for `atris learn [subcommand] [args]`
 */
function showLearnHelp() {
  console.log('');
  console.log('  Usage: atris learn [command]');
  console.log('');
  console.log('  Commands:');
  console.log('    (none)     Show recent learnings');
  console.log('    add        Add a learning interactively. A rich insight mints one apply plus a failing measure.py. A thin insight prints check: fill this.');
  console.log('    log <json> Add programmatically (for agents). A rich insight (number or named mechanism) mints one apply plus a failing measure.py. A thin insight prints check: fill this.');
  console.log('    search <q> Search learnings by keyword');
  console.log('    harvest    Extract learnings from journal Notes. A rich insight mints one apply plus a failing measure.py. A thin insight prints check: fill this.');
  console.log('    prune      Check for stale/contradictory entries');
  console.log('    stats      Show learning statistics');
  console.log('    export     Export as markdown');
  console.log('    count      Print learning count (for integrations)');
  console.log('');
  console.log('  learn log schema:');
  for (const line of learnLogSchemaLines()) console.log(`    ${line}`);
  console.log('');
}

function learnAtris(subcommand, ...args) {
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h' || args.includes('--help') || args.includes('-h')) {
    showLearnHelp();
    return;
  }

  const atrisDir = path.join(process.cwd(), 'atris');
  if (!fs.existsSync(atrisDir)) {
    console.error('  ✗ atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  switch (subcommand) {
    case undefined:
    case '':
      showRecent();
      break;
    case 'add':
      interactiveAdd();
      break;
    case 'log':
      logDirect(args[0]);
      break;
    case 'search':
      showSearch(args.join(' '));
      break;
    case 'prune':
      showPrune();
      break;
    case 'stats':
      showStats();
      break;
    case 'export':
      showExport();
      break;
    case 'count':
      console.log(getLearningCount());
      break;
    case 'harvest':
      harvestFromJournals();
      break;
    default:
      showLearnHelp();
      break;
  }
}

learnAtris.getLearningCount = getLearningCount;
learnAtris.learnExperimentSlug = learnExperimentSlug;
learnAtris.learnExperimentRel = learnExperimentRel;
learnAtris.learnApplyRel = learnApplyRel;
learnAtris.learnLessonFromText = learnLessonFromText;
learnAtris.saveRichLearn = saveRichLearn;
learnAtris.ensureLearnApply = ensureLearnApply;
learnAtris.mintRichLearn = mintRichLearn;
learnAtris.commitAddedLearning = commitAddedLearning;
learnAtris.commitReviewLearning = commitReviewLearning;
learnAtris.reviewLearningKey = reviewLearningKey;
learnAtris.harvestFromJournals = harvestFromJournals;
learnAtris.logDirect = logDirect;

module.exports = learnAtris;
