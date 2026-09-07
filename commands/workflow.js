const fs = require('fs');
const path = require('path');
const { getLogPath } = require('../lib/journal');
const {
  buildFirstMinute,
  folderName,
  freshMinuteJson,
  isCertifiedReview,
  listUserVisibleWork,
  isFreshWorkspace,
  personName,
  pickNext,
  renderWorkspace,
  speakFirstMinute,
  taskCommand,
  visibleWorkTitle,
} = require('../lib/first-minute');
const { startFirstTalk } = require('../lib/context-gatherer');
const { isNonInteractive } = require('../lib/noninteractive');
const { loadContext } = require('../lib/state-detection');
const { buildToolResultBody } = require('../lib/tool-result-encode');

function wrapWorkflowText(text, width = 76) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [''];

  const words = normalized.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if ((current + ' ' + word).length <= width) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function printWorkflowBrief(lines) {
  console.log('');
  for (const line of lines) {
    if (!line) {
      console.log('');
      continue;
    }
    for (const wrapped of wrapWorkflowText(line)) {
      console.log(wrapped);
    }
  }
  console.log('');
}

function reviewSoftTitle(title, maxWords = 5) {
  const words = String(title || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return '';
  const text = words.slice(0, maxWords).join(' ').replace(/[.,;:!?]+$/g, '');
  return `"${text.toLowerCase()}"`;
}

function isHumanDeskNext(command) {
  const text = String(command || '');
  return /^atris do\b/.test(text) || /^atris task (?:claim|show|ready|accept)\b/.test(text);
}

function loadReviewTasks(root = process.cwd()) {
  try {
    const taskDb = require('../lib/task-db');
    const db = taskDb.open();
    const workspaceRoot = taskDb.workspaceRoot(root);
    const rows = taskDb.listTasks(db, { workspaceRoot, limit: 200 });
    if (Array.isArray(rows) && rows.length) return taskDb.withTaskDisplayRefs(rows);
  } catch {
    // Fall through to the local projection. Tests and fresh folders often have no db.
  }
  const projectionPath = path.join(root, '.atris', 'state', 'tasks.projection.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

function wantsReviewQueue(args = []) {
  const list = Array.isArray(args) ? args : [];
  return list.includes('--json')
    || list.includes('--all')
    || list.includes('--limit')
    || list.includes('--group-by');
}

function renderReviewMinute({
  root = process.cwd(),
  person,
  tasks,
} = {}) {
  const who = person != null ? person : personName();
  const greet = who ? `hey ${who}, ` : '';
  const all = Array.isArray(tasks) ? tasks : loadReviewTasks(root);
  const reviews = all.filter((task) => task && task.status === 'review');
  const checking = reviews.filter((task) => !isCertifiedReview(task));
  const picked = pickNext({ tasks: reviews, person: who });
  const task = picked.task || null;
  const title = task ? reviewSoftTitle(task.title) : '';

  if (task && isCertifiedReview(task)) {
    const win = title
      ? `${greet}${title} is waiting for your ok.`
      : `${greet}one finished thing is waiting for your ok.`;
    const lines = [win];
    if (checking.length === 1) lines.push('1 still being checked.');
    if (checking.length > 1) lines.push(`${checking.length} still being checked.`);
    lines.push('');
    lines.push(`next: ${taskCommand(task, who)}`);
    return lines.join('\n');
  }

  if (checking.length === 1) {
    const named = title || reviewSoftTitle(checking[0] && checking[0].title);
    if (named) return `${greet}${named} is still being checked.`;
    return `${greet}1 finished thing is still being checked.`;
  }
  if (checking.length > 1) {
    return `${greet}${checking.length} finished things are still being checked.`;
  }

  // Review is the human desk. If first-minute next is claim, ready, or
  // accept, say that same next. "nothing is waiting" is only for an empty desk.
  if (tasks === undefined) {
    const screen = buildFirstMinute({ root, person: who });
    if (isHumanDeskNext(screen.nextCommand)) return screen.text;
  } else {
    const room = pickNext({ tasks: all, person: who });
    if (isHumanDeskNext(room.command)) {
      return renderWorkspace({
        person: who,
        folder: folderName(root),
        task: room.task || null,
        nextCommand: room.command,
      });
    }
  }
  return 'nothing is waiting on you.';
}

const CONFIDENCE_GATE_LINES = [
  'Confidence Gate:',
  '1) Ask: am I factually confident enough to move this forward?',
  '2) Find loopholes: stale sources, missing owner, weak proof, bad rollback, hidden risk.',
  '3) Patch every known loophole with proof, verifier, owner, rollback, or an explicit blocked note.',
  '4) Only advance when confidence is earned; never use 100% as a vibe.'
];

function printConfidenceGate(indent = '') {
  for (const line of CONFIDENCE_GATE_LINES) console.log(`${indent}${line}`);
}

function confidenceGatePrompt(stage) {
  return [
    `Confidence Gate (${stage}):`,
    `- Ask whether you are factually confident enough to advance this ${stage}.`,
    '- List every plausible loophole: stale source, missing owner, weak proof, bad rollback, hidden side effect, ambiguous done condition.',
    '- Patch each loophole with a source read, verifier, proof requirement, owner, rollback, or explicit blocked note.',
    '- Do not claim 100% confidence unless every known loophole is patched, verified, or named as residual risk.'
  ].join('\n');
}

// Translate one relayed local_file_op call into a single bash command that runs
// on the business cloud workspace, mirroring the backend handler's result shapes.
// Content for write/edit travels base64 so shell quoting can't corrupt it.
function cloudFileOpCommand(args) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
  const op = String(args.type || '').toLowerCase();
  const rawPath = String(args.path || '.');
  if (rawPath.split('/').includes('..')) return null;
  const p = q(rawPath);

  if (op === 'bash') return `cd /workspace && ( ${args.command || 'true'} )`;
  if (op === 'list') return `cd /workspace && find ${p} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' | head -200`;
  if (op === 'search') {
    const query = q(String(args.query || args.pattern || ''));
    return `cd /workspace && grep -rn -m 50 ${query} ${p} 2>/dev/null | head -50`;
  }
  if (op === 'read') return `cd /workspace && { [ -d ${p} ] && ls -p ${p} | head -200 || head -c 12000 ${p}; }`;
  if (op === 'write') {
    return `cd /workspace && mkdir -p "$(dirname ${p})" && echo ${q(b64(args.content || ''))} | base64 -d > ${p} && echo WROTE ${p}`;
  }
  if (op === 'edit') {
    const py = [
      'import base64,sys',
      `p=base64.b64decode('${b64(rawPath)}').decode()`,
      `f=base64.b64decode('${b64(args.find || '')}').decode()`,
      `r=base64.b64decode('${b64(args.replace || '')}').decode()`,
      's=open(p).read()',
      "sys.exit('find text not found') if f not in s else open(p,'w').write(s.replace(f,r,1))",
    ].join('; ');
    return `cd /workspace && python3 -c ${q(py)} && echo EDITED ${p}`;
  }
  return null;
}

function cloudFileOpResult(args, term) {
  const op = String(args.type || '').toLowerCase();
  const body = (term && term.data) || {};
  const stdout = body.stdout || '';
  const stderr = body.stderr || '';
  const exitCode = body.exit_code !== undefined ? body.exit_code : null;
  if (!term.ok) {
    return { status: 'error', error: term.errorMessage || term.error || `terminal HTTP ${term.status}` };
  }
  if (exitCode !== 0 && exitCode !== null) {
    return { status: 'error', error: (stderr || stdout || 'command failed').slice(0, 2000), exit_code: exitCode };
  }
  if (op === 'bash') return { status: 'ok', stdout, stderr, exit_code: exitCode };
  if (op === 'read') return { status: 'ok', path: args.path || '.', content: stdout.slice(0, 12000) };
  if (op === 'write' || op === 'edit') return { status: 'ok', path: args.path };
  return { status: 'ok', stdout: stdout.slice(0, 12000) };
}

function makeCloudExecutor({ token, businessId, workspaceId, slug }) {
  const { runTerminalCommand } = require('./terminal');
  return async function executeToolCall(name, args) {
    if (name !== 'local_file_op') {
      return { status: 'error', error: `unsupported relayed tool: ${name}` };
    }
    const command = cloudFileOpCommand(args || {});
    if (!command) {
      return { status: 'error', error: `unsupported op or unsafe path on cloud workspace ${slug}` };
    }
    try {
      const term = await runTerminalCommand(token, businessId, workspaceId, command, 60);
      return cloudFileOpResult(args || {}, term);
    } catch (err) {
      return { status: 'error', error: String(err.message || err).slice(0, 500) };
    }
  };
}

function postToolResult(callId, result, base = 'http://127.0.0.1:8000') {
  const url = new URL('/api/atris2/turn/tool-result', base);
  const transport = url.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(buildToolResultBody(callId, result));
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        Origin: 'http://localhost:8000'
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`tool-result HTTP ${res.statusCode}: ${data.slice(0, 200)}`)));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function atris2TurnRequest(payload, executeToolCall = null) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8000,
      path: '/api/atris2/turn',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        // Local-desktop auth: the backend treats localhost requests with a
        // localhost Origin as the free local-desktop user.
        Origin: 'http://localhost:8000'
      }
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          let detail = data;
          try { detail = JSON.parse(data).detail || data; } catch (e) { /* raw body */ }
          const err = new Error(`HTTP ${res.statusCode}: ${detail}`.slice(0, 400));
          err.statusCode = res.statusCode;
          reject(err);
        });
        return;
      }

      // SSE stream: print text deltas live, surface tool calls, capture result.
      let buffer = '';
      let finalResult = null;
      let streamError = null;
      let wroteText = false;
      let idleTimer = null;
      const IDLE_MS = 120000;
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          req.destroy();
          reject(new Error(`Stream stalled: no events for ${IDLE_MS / 1000}s`));
        }, IDLE_MS);
      };
      resetIdle();

      // Relayed tool calls run sequentially: the backend awaits each result
      // before continuing the loop, so a promise chain preserves order.
      let toolChain = Promise.resolve();
      const handleEvent = (event) => {
        if (!event || typeof event !== 'object') return;
        if (event.type === 'text_delta' && event.content) {
          process.stdout.write(event.content);
          wroteText = true;
        } else if (event.type === 'tool_call_request' && executeToolCall) {
          const { call_id: callId, name, args } = event;
          const label = (args && args.type) || name || 'tool';
          console.log(`\n⚙ cloud:${label}${args && args.command ? ` $ ${String(args.command).slice(0, 80)}` : ''}${args && args.path ? ` ${args.path}` : ''}`);
          toolChain = toolChain
            .then(() => executeToolCall(name, args))
            .catch((err) => ({ status: 'error', error: String(err.message || err).slice(0, 500) }))
            .then((result) => postToolResult(callId, result))
            .then(() => resetIdle())
            .catch((err) => console.error(`✗ tool relay failed: ${err.message}`));
        } else if (event.type === 'tool_call') {
          const name = event.tool || (event.input && event.input.tool) || 'tool';
          console.log(`\n⚙ ${name}...`);
        } else if (event.type === 'error') {
          streamError = event.error || 'Atris 2 returned an error.';
        } else if (event.type === 'result' && typeof event.result === 'string') {
          finalResult = event.result;
        }
      };

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        resetIdle();
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              handleEvent(JSON.parse(line.slice(6)));
            } catch (e) { /* ignore malformed frame */ }
          }
        }
      });
      res.on('end', () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (streamError) {
          reject(new Error(streamError));
          return;
        }
        resolve({ finalResult, wroteText });
      });
      res.on('error', (err) => {
        if (idleTimer) clearTimeout(idleTimer);
        reject(err);
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runAtris2Local(userInput, atris2Mode) {
  let actualCommand = String(userInput || '').trim().replace(/^2\s+(fast|pro)\b/i, '').trim();

  // --business <slug>: run the turn against that business's cloud workspace.
  // The model loop stays on the backend; every file/bash tool call is relayed
  // here and executed on the business EC2 via the /terminal endpoint.
  let businessSlug = null;
  const bizMatch = actualCommand.match(/(?:^|\s)--business[= ]([a-z0-9-]+)/i);
  if (bizMatch) {
    businessSlug = bizMatch[1].toLowerCase();
    actualCommand = actualCommand.replace(bizMatch[0], ' ').replace(/\s+/g, ' ').trim();
  }

  console.log(`🚀 EXECUTING VIA ATRIS 2 ${atris2Mode.toUpperCase()}${businessSlug ? ` → cloud workspace ${businessSlug}` : ''}`);
  console.log('');

  if (!actualCommand) {
    console.log(`⚠ No command provided after "2 ${atris2Mode}"`);
    console.log(`Usage: atris 2 ${atris2Mode} [--business <slug>] <your command>`);
    process.exit(1);
  }

  console.log(`Running: ${actualCommand}`);
  console.log('');

  let executeToolCall = null;
  const payload = {
    message: actualCommand,
    workspace_path: process.cwd(),
    model: `atris:${atris2Mode}`
  };

  if (businessSlug) {
    const { ensureValidCredentials } = require('../utils/auth');
    const { apiRequestJson } = require('../utils/api');
    const { resolveBusiness, ensureAwake } = require('./terminal');
    const ensured = await ensureValidCredentials(apiRequestJson);
    if (ensured.error === 'not_logged_in' || !ensured.credentials?.token) {
      console.error('Not logged in. Run: atris login');
      process.exit(1);
    }
    if (ensured.error) {
      console.error(`Authentication failed: ${ensured.detail || ensured.error}. Run: atris login`);
      console.error('Check with: atris whoami');
      process.exit(1);
    }
    const creds = ensured.credentials;
    const biz = await resolveBusiness(creds.token, businessSlug);
    if (!biz || !biz.workspaceId) {
      console.error(`Business "${businessSlug}" not found or has no workspace.`);
      process.exit(1);
    }
    const awake = await ensureAwake(creds.token, biz.businessId);
    if (!awake) {
      console.error('Cloud computer did not become ready in time.');
      process.exit(1);
    }
    executeToolCall = makeCloudExecutor({
      token: creds.token,
      businessId: biz.businessId,
      workspaceId: biz.workspaceId,
      slug: businessSlug,
    });
    payload.local_executor = true;
    payload.workspace_path = `/workspace/${businessSlug}`;
  }

  try {
    let outcome;
    try {
      outcome = await atris2TurnRequest(payload, executeToolCall);
    } catch (error) {
      // Backends without local workspace access (prod config) reject the path;
      // retry the same prompt as plain cloud chat. Never silently downgrade a
      // cloud-workspace run.
      if (!businessSlug && error.statusCode === 403 && /workspace/i.test(error.message)) {
        outcome = await atris2TurnRequest({ ...payload, workspace_path: null });
      } else {
        throw error;
      }
    }

    if (!outcome.wroteText && outcome.finalResult) {
      process.stdout.write(outcome.finalResult);
    }
    console.log('');
    console.log(`✅ Atris 2 ${atris2Mode} completed`);
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
    console.error(`Atris 2 ${atris2Mode} failed before completion.`);
    console.error(`Refusing to run the prompt as a shell command. Start the backend on port 8000 or retry without "2 ${atris2Mode}".`);
    process.exit(1);
  }
}

async function planAtris(userInput = null) {
  const { loadConfig } = require('../utils/config');
  const { loadCredentials, ensureValidCredentials } = require('../utils/auth');
  const { apiRequestJson } = require('../utils/api');
  const { executeCodeExecution } = require('../utils/claude_sdk');
  const args = process.argv.slice(3);
  const executeFlag = args.includes('--execute');
  const showFull = args.includes('--full') || args.includes('--verbose');
  const leftoverRequest = args
    .filter((token) => !['--execute', '--full', '--verbose', '--json', '--prompt'].includes(token))
    .join(' ')
    .trim();
  const showPrompt = showFull || args.includes('--prompt');

  const config = loadConfig();
  // Auto-enable local execution mode for "2 fast" / "2 pro" product aliases.
  const atris2ModeMatch = userInput && String(userInput).trim().match(/^2\s+(fast|pro)\b/i);
  const atris2Mode = atris2ModeMatch ? atris2ModeMatch[1].toLowerCase() : null;
  const configuredMode = config.execution_mode || 'prompt';
  const executionMode = executeFlag ? 'agent' : (atris2Mode ? 'local' : (configuredMode === 'agent' ? 'agent' : 'prompt'));

  if (executionMode === 'local') {
    await runAtris2Local(userInput, atris2Mode);
    return;
  }

  const cwd = process.cwd();
  const targetDir = path.join(cwd, 'atris');

  // Empty folder talks like bare atris. Missing navigator.md after
  // init --minimal is optional context, not a factory bounce.
  if (!fs.existsSync(targetDir)) {
    if (args.includes('--json')) {
      console.log(JSON.stringify(freshMinuteJson(folderName(cwd), listUserVisibleWork(cwd), { root: cwd }), null, 2));
      process.exit(2);
    }
    const screen = buildFirstMinute({ root: cwd, fresh: true });
    console.log('');
    console.log(screen.text);
    return;
  }

  const memberNavigator = path.join(targetDir, 'team', 'navigator', 'MEMBER.md');
  const legacyNavigator = path.join(targetDir, 'team', 'navigator.md');
  const navigatorFile = fs.existsSync(memberNavigator)
    ? memberNavigator
    : (fs.existsSync(legacyNavigator) ? legacyNavigator : null);
  const personaPath = path.join(targetDir, 'PERSONA.md');
  const mapFilePath = path.join(targetDir, 'MAP.md');
  const featuresReadmePath = path.join(targetDir, 'features', 'README.md');

  const navigatorSpec = navigatorFile ? fs.readFileSync(navigatorFile, 'utf8') : '';

  // Read journal Inbox for context
  const { logFile } = getLogPath();
  let inboxContext = '';

  if (fs.existsSync(logFile)) {
    const logContent = fs.readFileSync(logFile, 'utf8');
    const inboxMatch = logContent.match(/## Inbox\n([\s\S]*?)(?=\n##|$)/);
    if (inboxMatch && inboxMatch[1].trim()) {
      inboxContext = inboxMatch[1].trim();
    }
  }

  // Read TODO.md (or legacy TASK_CONTEXTS.md) for current state
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskContextsFile = path.join(targetDir, 'TASK_CONTEXTS.md');
  let taskContexts = '';
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextsFile) ? legacyTaskContextsFile : null);
  if (taskFilePath) {
    taskContexts = fs.readFileSync(taskFilePath, 'utf8');
  }

  // Detect uncertainty in inbox context (or direct user input)
  const uncertaintySignals = ['not sure', 'maybe', 'but ', 'thinking about', 'uncertain', 'unclear', 'unsure', 'don\'t know'];
  const requestText = String(userInput || leftoverRequest || '').trim();
  const combinedContext = [requestText, inboxContext].filter(Boolean).join('\n');
  const hasUncertainty = combinedContext && uncertaintySignals.some(signal =>
    combinedContext.toLowerCase().includes(signal)
  );

  const taskSourcePath = taskFilePath ? path.relative(process.cwd(), taskFilePath) : null;
  const journalPath = path.relative(process.cwd(), logFile);
  const navigatorPath = navigatorFile ? path.relative(process.cwd(), navigatorFile) : null;
  const personaFileRef = fs.existsSync(personaPath) ? path.relative(process.cwd(), personaPath) : null;
  const mapFileRef = fs.existsSync(mapFilePath) ? path.relative(process.cwd(), mapFilePath) : null;
  const featuresReadmeRef = fs.existsSync(featuresReadmePath) ? path.relative(process.cwd(), featuresReadmePath) : null;
  const mapIsPlaceholder = (() => {
    if (!fs.existsSync(mapFilePath)) return false;
    try {
      const content = fs.readFileSync(mapFilePath, 'utf8').toLowerCase();
      return content.includes('generated by your ai agent after reading atris.md')
        || content.includes('run your ai agent with atris.md to populate this file');
    } catch {
      return false;
    }
  })();
  const inboxCount = inboxContext
    ? inboxContext
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return t.startsWith('- ') && t.length > 2;
        })
        .length
    : 0;

  let firstMinute = null;
  try {
    firstMinute = buildFirstMinute({
      root: cwd,
      context: loadContext(cwd) || {},
    });
  } catch {
    firstMinute = null;
  }
  const showFactory = showPrompt || Boolean(requestText);

  if (showFactory || executionMode !== 'prompt') {
    console.log(executionMode === 'prompt' ? 'PROMPT ONLY' : 'ACTION TAKEN');
    console.log('');
    if (firstMinute && firstMinute.text) {
      console.log(firstMinute.text);
      console.log('');
    }
  } else if (firstMinute && firstMinute.text) {
    console.log('');
    console.log(firstMinute.text);
  }

  if (showFactory) {
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Atris Plan - Navigator Agent Activated                     │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  // Show suggestion if uncertainty detected
  if (hasUncertainty) {
    console.log('💡 Suggestion:');
    console.log('   Sounds like you\'re exploring options.');
    console.log('   Try `atris brainstorm` first for conversational exploration,');
    console.log('   then run `atris plan` when ready to commit.');
    console.log('');
    console.log('   Or continue with plan if you prefer. Your call.');
    console.log('');
    console.log('─────────────────────────────────────────────────────────────');
    console.log('');
  }

  if (requestText) {
    console.log('🎯 DIRECT REQUEST:');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(requestText);
    console.log('');
    console.log('─────────────────────────────────────────────────────────────');
    console.log('');
  }
  console.log('📁 CONTEXT FILES (agent should read):');
  console.log(`- Navigator spec: ${navigatorPath || 'atris/team/navigator/MEMBER.md (missing)'}`);
  console.log(`- Persona: ${personaFileRef || 'atris/PERSONA.md (missing)'}`);
  const mapDisplay = mapFileRef
    ? `${mapFileRef}${mapIsPlaceholder ? ' (placeholder, generate first)' : ''}`
    : 'atris/MAP.md (missing)';
  console.log(`- MAP: ${mapDisplay}`);
  console.log(`- TODO: ${taskSourcePath || 'atris/TODO.md (missing)'}`);
  console.log(`- Features index: ${featuresReadmeRef || 'atris/features/README.md (missing)'}`);
  const lessonsPath = path.join(targetDir, 'lessons.md');
  const lessonsRef = fs.existsSync(lessonsPath) ? path.relative(process.cwd(), lessonsPath) : null;
  console.log(`- Lessons: ${lessonsRef || 'atris/lessons.md (none yet)'}`);
  console.log(`- Journal (today): ${journalPath}`);

  // Show top learnings if available
  try {
    const { loadLearnings } = require('../lib/learnings');
    const learnings = loadLearnings().filter(e => e._effectiveConfidence >= 7 && e.insight !== '[REMOVED]').slice(0, 3);
    if (learnings.length > 0) {
      console.log('');
      console.log('🧠 Prior learnings (high confidence):');
      for (const l of learnings) {
        console.log(`  [${l._effectiveConfidence}/10] ${l.type}/${l.key}: ${l.insight}`);
      }
    }
  } catch {}

  console.log('');
  console.log(`📥 Inbox items: ${inboxCount}`);
  console.log('');

  if (showFull) {
    if (navigatorSpec) {
      console.log('📋 NAVIGATOR SPEC (full):');
      console.log('─────────────────────────────────────────────────────────────');
      console.log(navigatorSpec);
      console.log('');
    }
    console.log('📥 INBOX CONTEXT (full):');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(inboxContext || '(No items in Inbox)');
    console.log('');
    console.log('📝 TODO.md (full):');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(taskContexts || '(No TODO content)');
    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 COPY/PASTE PROMPT FOR YOUR CODING AGENT:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('You are the Navigator.');
  console.log('');
  console.log('Read these files:');
  if (navigatorPath) console.log(`- ${navigatorPath}`);
  if (personaFileRef) console.log(`- ${personaFileRef}`);
  if (mapFileRef) console.log(`- ${mapFileRef}`);
  if (taskSourcePath) console.log(`- ${taskSourcePath}`);
  if (featuresReadmeRef) console.log(`- ${featuresReadmeRef}`);
  if (lessonsRef) console.log(`- ${lessonsRef}`);
  console.log(`- ${journalPath}`);
  console.log('');
  if (!mapFileRef || mapIsPlaceholder) {
    console.log('Note: If `atris/MAP.md` is missing or placeholder, generate it from `atris/atris.md` before writing tasks.');
    console.log('');
  }
  if (requestText) {
    console.log('Direct request:');
    console.log(requestText);
    console.log('');
  }
  console.log('Workflow:');
  console.log('1) ASCII visualize; use existing approval for this scope, otherwise wait for approval');
  console.log('2) Run the Confidence Gate before writing tasks');
  printConfidenceGate('   ');
  console.log('3) Create each task in the live task plane: `atris task add "<title>" --tag <tag>`, then `atris task plan <id> --goal ... --exit ... --proof-needed ...`');
  console.log('   Keep a delegated owner: `atris task delegate "<title>" --to <member>`; plan keeps that owner unless you pass --owner');
  console.log('   atris/TODO.md is a generated view: never hand-edit it, regenerate with `atris task render --out atris/TODO.md`');
  console.log('4) Log to atris/team/navigator/logs/YYYY-MM-DD.md');
  console.log('   (Task, Delivered, User reaction, Pattern)');
  if (atris2Mode) {
    console.log('5) EXECUTE MODE ENABLED: Will execute tasks directly.');
  } else {
    console.log('5) Stop. Do NOT execute (run `atris do` to build).');
  }
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💡 After planning: Run "atris do" to execute the build');
  if (!showFull) {
    console.log('   Tip: `atris plan --full` prints full spec/context for copy/paste.');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  }

  // Check execution mode
  if (executionMode === 'agent') {
    // Agent mode: execute via backend API
    if (!config.agent_id) {
      throw new Error('No agent selected. Run "atris agent" first.');
    }
    const ensured = await ensureValidCredentials(apiRequestJson);
    if (ensured.error === 'not_logged_in' || !ensured.credentials?.token) {
      throw new Error('Not logged in. Run "atris login" first.');
    }
    if (ensured.error) {
      throw new Error(`Authentication failed: ${ensured.detail || ensured.error}. Run "atris login" to re-authenticate.`);
    }
    const credentials = ensured.credentials;

    // Build system prompt
    let systemPrompt = '';
    if (navigatorSpec) {
      systemPrompt += navigatorSpec + '\n\n';
    }

    // Reference MAP.md and PERSONA.md
    if (fs.existsSync(personaPath)) {
      systemPrompt += '## PERSONA.md\n' + fs.readFileSync(personaPath, 'utf8') + '\n\n';
    }

    if (mapFileRef) {
      systemPrompt += `## MAP.md\nRead this file for file:line references: ${mapFileRef}\n\n`;
    }

    // Build user prompt with context
    let userPrompt = `You are the Navigator. Take ideas from Inbox → break them down into perfect, manageable tasks.\n\n`;
    userPrompt += `⚠️ CRITICAL: You MUST create visualizations BEFORE writing tasks!\n\n`;

    if (requestText) {
      userPrompt += `## DIRECT REQUEST:\n${requestText}\n\n`;
    }

    if (inboxContext) {
      userPrompt += `## INBOX CONTEXT:\n${inboxContext}\n\n`;
    } else {
      userPrompt += `## INBOX CONTEXT:\n(No items in Inbox - check logs/YYYY/YYYY-MM-DD.md for inbox items)\n\n`;
    }

    if (taskContexts) {
      userPrompt += `## CURRENT TODO.md:\n${taskContexts}\n\n`;
    }

    userPrompt += `Your job (execute these steps):\n\n`;
    userPrompt += `STEP 1: Generate ASCII visualizations for user approval\n`;
    userPrompt += `   Create diagrams showing architecture, flows, schemas, UI/UX.\n`;
    userPrompt += `   SHOW these diagrams; use existing approval for this scope, otherwise wait for approval before proceeding.\n\n`;
    userPrompt += `STEP 2: Run the Confidence Gate before writing tasks\n`;
    userPrompt += confidenceGatePrompt('plan') + `\n\n`;
    userPrompt += `STEP 3: Break approved ideas into concrete tasks\n`;
    userPrompt += `   - Each task should be: Specific, Measurable, Actionable\n`;
    userPrompt += `   - Include file:line references from MAP.md\n`;
    userPrompt += `   - List dependencies between tasks\n`;
    userPrompt += `   - Add acceptance criteria for each task\n\n`;
    userPrompt += `STEP 4: Create tasks through the task database\n`;
    userPrompt += `   - Use bash to run 'atris task add' or the task database calls; do not hand-edit TODO.md\n`;
    userPrompt += `   - The CLI will re-render atris/TODO.md after this workflow step completes\n`;
    userPrompt += `   - Each task: one job, clear exit condition\n`;
    userPrompt += `   - Include file:line references from MAP.md\n\n`;
    userPrompt += `STEP 5: Log to your journal\n`;
    userPrompt += `   - Write to atris/team/navigator/logs/YYYY-MM-DD.md\n`;
    userPrompt += `   - Include: Task, Delivered, User reaction, Pattern\n`;
    userPrompt += `   - Your journal is how you learn, so record what worked\n\n`;
    userPrompt += `Start planning now. Read MAP.md for file references.`;

    console.log('');
    console.log('🤖 AGENT MODE: Executing via backend API...');
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // Execute via API
    try {
      await executeCodeExecution({
        prompt: userPrompt,
        allowedTools: ['Read', 'Bash'], // Task creation must go through atris task / the database
        permissionMode: 'default',
        maxTurns: 15,
        systemPrompt,
        workingDirectory: process.cwd(),
        agentId: config.agent_id,
        token: credentials.token,
        onMessage: (data) => {
          if (data.type === 'text' && data.content) {
            process.stdout.write(data.content);
          } else if (data.type === 'tool_use') {
            console.log(`\n🛠️  [${data.tool || data.tool_name}] ${JSON.stringify(data.input || data.tool_input || {}).substring(0, 100)}`);
          } else if (data.type === 'tool_result') {
            const result = data.result || data.content || '';
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            const preview = resultStr.substring(0, 200);
            console.log(`\n✅ [Result] ${preview}${resultStr.length > 200 ? '...' : ''}`);
          } else if (data.type === 'error') {
            console.error(`\n❌ Error: ${data.error}`);
          } else if (data.type === 'result') {
            if (data.result) {
              console.log(`\n🎯 [Final] ${data.result}`);
            }
            if (data.duration_ms) {
              console.log(`⏱️  Duration: ${(data.duration_ms / 1000).toFixed(2)}s`);
            }
            if (data.cost_usd) {
              console.log(`💰 Cost: $${data.cost_usd.toFixed(4)}`);
            }
          }
        },
        onError: (error) => {
          console.error(`\n❌ Execution error: ${error.message}`);
        },
      });
      try {
        require('./task').autoRenderTodoFromDb(process.cwd());
      } catch {
        // Rendering is best-effort; task-db state remains authoritative.
      }

      console.log('\n');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');
      console.log('💡 After planning: Run "atris do" to execute tasks');
      console.log('');
    } catch (error) {
      console.error(`\n✗ Agent execution failed: ${error.message}`);
      throw error;
    }
  }
  // Prompt mode continues with existing output (already logged above)
}

// Both executor surfaces require the exact live record before any work.
// The rendered list omits raw instructions and cannot select the mission.
function executorDispatchForTask(task) {
  const metadata = task && task.metadata || {};
  return {
    taskId: task && task.id || '',
    owner: metadata.assigned_to || task && task.claimed_by || metadata.stage_owner || '',
    goalId: metadata.goal_id || '',
    missionId: metadata.mission_id || '',
    objective: metadata.task_goal || metadata.goal_objective || metadata.stage_goal || '',
    workspaceRoot: task && task.workspace_root || '',
  };
}

function validateExecutorDispatch(expected = {}, task) {
  if (!expected.taskId || !expected.owner || (!expected.goalId && !expected.missionId && !expected.objective)) {
    return { ok: false, reason: 'missing task, owner, or mission in dispatch' };
  }
  const actual = executorDispatchForTask(task);
  if (!task || ['taskId', 'owner', 'goalId', 'missionId', 'objective', 'workspaceRoot']
    .some(key => (expected[key] || '') !== (actual[key] || ''))) {
    return { ok: false, reason: 'task, owner, or mission changed since dispatch' };
  }
  if (!['open', 'claimed'].includes(task.status)
    || (task.status === 'claimed' && task.claimed_by !== expected.owner)) {
    return { ok: false, reason: 'task is inactive or claimed by another owner' };
  }
  return { ok: true };
}

function executorTaskHandoff({ taskId = '', owner = '', goalId = '', missionId = '', objective = '' } = {}) {
  const ref = taskId || '<task-id>';
  const expected = JSON.stringify({ taskId: taskId || null, owner: owner || null, goalId: goalId || null, missionId: missionId || null, objective: objective || null });
  return `Expected dispatch: ${expected}. Before claiming or editing, run \`atris task show ${ref} --json\` for the exact current dispatched task. If the expected task ID, owner, or mission is missing, stop; no edits are allowed. Do not select another displayed row. Check the ID, current mission, active status (open or claimed by the same owner), and functional owner against these expected values. Refuse a stale or mismatched task. Read the raw metadata, requirements, events, and verify command for exact paths, flags, and engine/model instructions; the explanation and rendered TODO are summaries only. Then claim that same task with \`atris task claim ${ref} --as <task-owner>\`, using its recorded functional owner and keeping the engine separate.`;
}

// The executor prompt sent to a backend agent in --execute mode. Kept as a
// pure function so the emitted instructions can be tested without a network:
// the agent claims and finishes work through the live task plane, and treats
// atris/TODO.md as a generated view it never hand-edits.
function executorAgentPrompt({ filteredTasks = '', taskSource = 'atris/TODO.md', context = 'UNKNOWN', taskId = '', owner = '', goalId = '', missionId = '', objective = '' } = {}) {
  let userPrompt = `⚠️ CRITICAL: Execute tasks NOW. Use file tools to edit code, terminal to run commands.\n\n`;
  userPrompt += `You are the Executor. Get it done, precisely, following instructions perfectly.\n\n`;

  if (filteredTasks) {
    userPrompt += `## REFERENCE TASK SUMMARIES (generated view from ${taskSource}; live truth is \`atris task list\`):\n${filteredTasks}\n\n`;
  } else {
    userPrompt += `## TASKS TO EXECUTE:\n(No tasks found - run \`atris task list\` for the live task plane)\n\n`;
  }

  userPrompt += `Your process (EXECUTE these steps):\n`;
  userPrompt += `1. ${executorTaskHandoff({ taskId, owner, goalId, missionId, objective })}\n`;
  userPrompt += `2. For this task: Show ASCII visualization first (especially complex changes)\n`;
  userPrompt += `3. Run the Confidence Gate before editing\n`;
  userPrompt += confidenceGatePrompt('do') + `\n`;
  userPrompt += `4. Execute task: Use file edit tools, terminal commands, etc.\n`;
  userPrompt += `5. Before completion, rerun the gate against proof and residual risk\n`;
  userPrompt += `6. Send it to review: \`atris task ready <id> --proof "<commands run>"\`; a human accepts. Never hand-edit TODO.md; \`atris task render --out atris/TODO.md\` regenerates it\n`;
  userPrompt += `7. Log to atris/team/executor/logs/YYYY-MM-DD.md\n`;
  userPrompt += `   (Task, Delivered, Errors hit, Learned)\n`;
  userPrompt += `8. Use MAP.md to navigate codebase\n\n`;
  userPrompt += `DO NOT just describe what you would do - actually edit files and execute commands!\n`;
  userPrompt += `Context: ${context}\n`;
  userPrompt += `Start only the dispatched task after the raw-record check.`;
  return userPrompt;
}

async function doAtris() {
  const { loadConfig } = require('../utils/config');
  const { loadCredentials, ensureValidCredentials } = require('../utils/auth');
  const { apiRequestJson } = require('../utils/api');
  const { executeCodeExecution } = require('../utils/claude_sdk');
  const args = process.argv.slice(3);
  const executeFlag = args.includes('--execute');
  const showFull = args.includes('--full') || args.includes('--verbose') || args.includes('--prompt');

  const config = loadConfig();
  const executionMode = executeFlag ? 'agent' : (config.execution_mode || 'prompt');

  const cwd = process.cwd();
  const targetDir = path.join(cwd, 'atris');

  // Empty folder talks like bare atris. Files already here start
  // first-talk, then next is atris do. After that work is yours,
  // next is task ready so keep-working is not a do loop. Missing
  // executor.md after init --minimal is optional context, not a
  // factory bounce.
  if (!fs.existsSync(targetDir)) {
    const visible = listUserVisibleWork(cwd);
    if (visible.length) {
      const title = visibleWorkTitle(visible, folderName(cwd));
      const code = startFirstTalk(cwd, title, { asJson: args.includes('--json') });
      if (code !== 0) process.exit(code);
      return;
    }
    if (args.includes('--json')) {
      console.log(JSON.stringify(freshMinuteJson(folderName(cwd), visible, { root: cwd }), null, 2));
      process.exit(2);
    }
    const screen = buildFirstMinute({ root: cwd, fresh: true });
    console.log('');
    console.log(screen.text);
    return;
  }

  const memberExecutor = path.join(targetDir, 'team', 'executor', 'MEMBER.md');
  const legacyExecutor = path.join(targetDir, 'team', 'executor.md');
  const executorFile = fs.existsSync(memberExecutor)
    ? memberExecutor
    : (fs.existsSync(legacyExecutor) ? legacyExecutor : null);

  // Load project profile for context
  let context = 'ROOT';
  let profile = null;
  const profileFile = path.join(targetDir, '.project-profile.json');
  if (fs.existsSync(profileFile)) {
    try {
      profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
      // Use profile type as context (e.g., 'nodejs', 'python', 'knowledge-base')
      context = profile.type.toUpperCase();
      if (profile.framework !== 'none') {
        context += `/${profile.framework.toUpperCase()}`;
      }
    } catch (e) {
      // Fallback to ROOT if profile parse fails
      context = 'ROOT';
    }
  }

  const executorSpec = executorFile ? fs.readFileSync(executorFile, 'utf8') : '';

  // Load PERSONA.md
  const personaFile = path.join(targetDir, 'PERSONA.md');
  let persona = '';
  if (fs.existsSync(personaFile)) {
    persona = fs.readFileSync(personaFile, 'utf8');
  }

  // Reference MAP.md (agents read on-demand)
  const mapFile = path.join(targetDir, 'MAP.md');
  const mapPath = fs.existsSync(mapFile) ? path.relative(process.cwd(), mapFile) : null;
  const mapIsPlaceholder = (() => {
    if (!fs.existsSync(mapFile)) return false;
    try {
      const content = fs.readFileSync(mapFile, 'utf8').toLowerCase();
      return content.includes('generated by your ai agent after reading atris.md')
        || content.includes('run your ai agent with atris.md to populate this file');
    } catch {
      return false;
    }
  })();

  // Load tasks from TODO.md (generic - no hardcoded paths, legacy TASK_CONTEXTS.md supported)
  let tasksContent = '';
  let taskSource = '';
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskContextsFile = path.join(targetDir, 'TASK_CONTEXTS.md');
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextsFile) ? legacyTaskContextsFile : null);
  if (taskFilePath) {
    tasksContent = fs.readFileSync(taskFilePath, 'utf8');
    taskSource = fs.existsSync(todoFile) ? 'atris/TODO.md' : 'atris/TASK_CONTEXTS.md';
  }

  if (!taskSource) {
    taskSource = 'atris/TODO.md';
  }

  // All tasks available (no tag filtering)
  const filteredTasks = tasksContent;

  const executorPath = executorFile ? path.relative(process.cwd(), executorFile) : null;
  const personaFileRef = fs.existsSync(personaFile) ? path.relative(process.cwd(), personaFile) : null;
  const taskSourcePath = taskFilePath ? path.relative(process.cwd(), taskFilePath) : null;
  const featuresReadmePath = path.join(targetDir, 'features', 'README.md');
  const featuresReadmeRef = fs.existsSync(featuresReadmePath) ? path.relative(process.cwd(), featuresReadmePath) : null;

  let featureBuildPlanRefs = [];
  const featuresDir = path.join(targetDir, 'features');
  if (fs.existsSync(featuresDir)) {
    try {
      featureBuildPlanRefs = fs
        .readdirSync(featuresDir)
        .filter((name) => !name.startsWith('_'))
        .filter((name) => {
          const full = path.join(featuresDir, name);
          try {
            return fs.statSync(full).isDirectory();
          } catch {
            return false;
          }
        })
        .map((name) => path.join(featuresDir, name, 'build.md'))
        .filter((buildPath) => fs.existsSync(buildPath))
        .map((buildPath) => path.relative(process.cwd(), buildPath));
    } catch {
      featureBuildPlanRefs = [];
    }
  }

  let workspaceSummary = null;
  try {
    workspaceSummary = loadContext(cwd);
  } catch {
    workspaceSummary = null;
  }

  let firstMinute = null;
  try {
    firstMinute = buildFirstMinute({
      root: cwd,
      context: workspaceSummary || {},
    });
  } catch {
    firstMinute = null;
  }
  const liveStatus = firstMinute && firstMinute.task && firstMinute.task.status;
  const hasLiveTask = liveStatus === 'claimed' || liveStatus === 'review' || liveStatus === 'open';

  // Default stays the first-minute two lines. The factory paste stays on --prompt.
  if (showFull || executionMode !== 'prompt') {
    console.log(executionMode === 'prompt' ? 'PROMPT ONLY' : 'ACTION TAKEN');
    console.log('');
    if (firstMinute && firstMinute.text) {
      console.log(firstMinute.text);
      console.log('');
    }
  } else if (firstMinute && firstMinute.text) {
    console.log('');
    console.log(firstMinute.text);
  }

  const backlogCount = workspaceSummary && Array.isArray(workspaceSummary.backlogTasks)
    ? workspaceSummary.backlogTasks.length
    : 0;
  const inProgressCount = workspaceSummary && Array.isArray(workspaceSummary.inProgressFeatures)
    ? workspaceSummary.inProgressFeatures.length
    : 0;

  if (showFull) {
    console.log('📁 CONTEXT FILES (agent should read):');
    console.log(`- Executor spec: ${executorPath || 'atris/team/executor/MEMBER.md (missing)'}`);
    console.log(`- Persona: ${personaFileRef || 'atris/PERSONA.md (missing)'}`);
    const mapDisplay = mapPath
      ? `${mapPath}${mapIsPlaceholder ? ' (placeholder, generate first)' : ''}`
      : 'atris/MAP.md (missing)';
    console.log(`- MAP: ${mapDisplay}`);
    console.log(`- TODO: ${taskSourcePath || 'atris/TODO.md (missing)'}`);
    console.log(`- Features index: ${featuresReadmeRef || 'atris/features/README.md (missing)'}`);

    try {
      const { loadLearnings } = require('../lib/learnings');
      const learnings = loadLearnings().filter(e => e._effectiveConfidence >= 7 && e.insight !== '[REMOVED]').slice(0, 3);
      if (learnings.length > 0) {
        console.log('');
        console.log('🧠 Prior learnings (apply during build):');
        for (const l of learnings) {
          console.log(`  [${l._effectiveConfidence}/10] ${l.type}/${l.key}: ${l.insight}`);
        }
      }
    } catch {}

    console.log('');

    if (inProgressCount > 0) {
      console.log(`🔨 In-progress features: ${workspaceSummary.inProgressFeatures.join(', ')}`);
    }
    console.log(`🧱 Feature build plans found: ${featureBuildPlanRefs.length}`);
    if (featureBuildPlanRefs.length > 0) {
      featureBuildPlanRefs.slice(0, 3).forEach((ref) => console.log(`- ${ref}`));
      if (featureBuildPlanRefs.length > 3) {
        console.log(`- ... (+${featureBuildPlanRefs.length - 3} more)`);
      }
    }
    if (!(hasLiveTask && backlogCount === 0)) {
      console.log(`📋 Backlog tasks: ${backlogCount}`);
    }
    console.log('');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 COPY/PASTE PROMPT FOR YOUR CODING AGENT:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('You are the Executor.');
    console.log('');
    console.log('Read these files:');
    if (executorPath) console.log(`- ${executorPath}`);
    if (personaFileRef) console.log(`- ${personaFileRef}`);
    if (mapPath) console.log(`- ${mapPath}`);
    if (taskSourcePath) console.log(`- ${taskSourcePath}`);
    if (featuresReadmeRef) console.log(`- ${featuresReadmeRef}`);
    console.log('');
    if (!mapPath || mapIsPlaceholder) {
      console.log('Note: If `atris/MAP.md` is missing or placeholder, generate it from `atris/atris.md` before navigating the codebase.');
      console.log('');
    }
    console.log('Workflow:');
    console.log(`1) ${executorTaskHandoff(executorDispatchForTask(firstMinute && firstMinute.task))}`);
    console.log('   The live task plane is truth; never hand-edit TODO.md to claim or move work');
    console.log('2) Run the Confidence Gate against the task before editing');
    printConfidenceGate('   ');
    console.log('3) Execute step-by-step. Run tests as you go.');
    console.log('4) Before completion, rerun the gate against proof and residual risk');
    console.log('5) When done, send it to review: `atris task ready <id> --proof "<commands run>"`; a human accepts, then `atris task render --out atris/TODO.md` refreshes the view');
    console.log('6) Log to atris/team/executor/logs/YYYY-MM-DD.md');
    console.log('   (Task, Delivered, Errors hit, Learned)');
    console.log('');
    console.log('⛔ Do NOT plan, just execute what\'s written.');
    console.log('');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📎 APPENDIX (full context dumps):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    if (persona) {
      console.log('👤 PERSONA.md (full):');
      console.log('─────────────────────────────────────────────────────────────');
      console.log(persona);
      console.log('');
    }

    if (executorSpec) {
      console.log('🔧 EXECUTOR SPEC (full):');
      console.log('─────────────────────────────────────────────────────────────');
      console.log(executorSpec);
      console.log('');
    }

    if (filteredTasks) {
      console.log(`📋 TASKS TO EXECUTE (full, from ${taskSource}):`);
      console.log('─────────────────────────────────────────────────────────────');
      console.log(filteredTasks);
      console.log('');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (!hasLiveTask) {
      console.log('💡 Next: Run "atris review" after execution');
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
  }

  // Check execution mode
  if (executionMode === 'agent') {
    // Bind edit permission to the selected live task, not its rendered summary.
    const dispatch = executorDispatchForTask(firstMinute && firstMinute.task);
    const dispatchCheck = validateExecutorDispatch(dispatch, firstMinute && firstMinute.task);
    if (!dispatchCheck.ok) throw new Error(`executor dispatch refused: ${dispatchCheck.reason}`);
    // Agent mode: execute via backend API
    if (!config.agent_id) {
      throw new Error('No agent selected. Run "atris agent" first.');
    }
    const ensured = await ensureValidCredentials(apiRequestJson);
    if (ensured.error === 'not_logged_in' || !ensured.credentials?.token) {
      throw new Error('Not logged in. Run "atris login" first.');
    }
    if (ensured.error) {
      throw new Error(`Authentication failed: ${ensured.detail || ensured.error}. Run "atris login" to re-authenticate.`);
    }
    const credentials = ensured.credentials;

    // Build system prompt
    let systemPrompt = '';
    if (executorSpec) {
      systemPrompt += executorSpec + '\n\n';
    }
    if (persona) {
      systemPrompt += '## PERSONA.md\n' + persona + '\n\n';
    }
    if (mapPath) {
      systemPrompt += `## MAP.md\nRead this file for file:line references: ${mapPath}\n\n`;
    }
    if (profile) {
      systemPrompt += `## PROJECT CONTEXT\nType: ${context}\nProfile: ${JSON.stringify(profile, null, 2)}\n\n`;
    }

    // Build user prompt with context
    const taskDb = require('../lib/task-db');
    const liveTask = taskDb.getTask(taskDb.open(), dispatch.taskId);
    const currentDispatchCheck = validateExecutorDispatch(dispatch, liveTask);
    if (!currentDispatchCheck.ok) throw new Error(`executor dispatch refused: ${currentDispatchCheck.reason}`);
    const userPrompt = executorAgentPrompt({ filteredTasks, taskSource, context, ...dispatch });

    console.log('');
    console.log('🤖 AGENT MODE: Executing via backend API...');
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // Execute via API
    try {
      await executeCodeExecution({
        prompt: userPrompt,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash'], // Executor needs all tools
        permissionMode: 'default',
        maxTurns: 20,
        systemPrompt,
        workingDirectory: process.cwd(),
        agentId: config.agent_id,
        token: credentials.token,
        onMessage: (data) => {
          if (data.type === 'text' && data.content) {
            process.stdout.write(data.content);
          } else if (data.type === 'tool_use') {
            console.log(`\n🛠️  [${data.tool || data.tool_name}] ${JSON.stringify(data.input || data.tool_input || {}).substring(0, 100)}`);
          } else if (data.type === 'tool_result') {
            const result = data.result || data.content || '';
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            const preview = resultStr.substring(0, 200);
            console.log(`\n✅ [Result] ${preview}${resultStr.length > 200 ? '...' : ''}`);
          } else if (data.type === 'error') {
            console.error(`\n❌ Error: ${data.error}`);
          } else if (data.type === 'result') {
            if (data.result) {
              console.log(`\n🎯 [Final] ${data.result}`);
            }
            if (data.duration_ms) {
              console.log(`⏱️  Duration: ${(data.duration_ms / 1000).toFixed(2)}s`);
            }
            if (data.cost_usd) {
              console.log(`💰 Cost: $${data.cost_usd.toFixed(4)}`);
            }
          }
        },
        onError: (error) => {
          console.error(`\n❌ Execution error: ${error.message}`);
        },
      });

      console.log('\n');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');
    } catch (error) {
      console.error(`\n✗ Agent execution failed: ${error.message}`);
      throw error;
    }
  }
  // Prompt mode continues with existing output (already logged above)
}

async function reviewAtris() {
  const { loadConfig } = require('../utils/config');
  const { loadCredentials, ensureValidCredentials } = require('../utils/auth');
  const { apiRequestJson } = require('../utils/api');
  const { executeCodeExecution } = require('../utils/claude_sdk');
  const args = process.argv.slice(3);
  const executeFlag = args.includes('--execute');
  const showFull = args.includes('--full') || args.includes('--verbose');
  const wantsTaskJson = args.includes('--json');
  const root = process.cwd();
  const queueShape = args.some((arg) => arg === '--all' || arg === '--limit' || arg === '--group-by');

  // Empty folder talks like bare atris, including --verbose. After init, stay
  // in the room. A missing validator spec is optional context, not "run init".
  if (isFreshWorkspace(root) && !queueShape) {
    const code = speakFirstMinute({
      root,
      fresh: true,
      asJson: wantsTaskJson,
    });
    if (code !== 0) process.exit(code);
    return;
  }

  if (!executeFlag && !showFull) {
    const forwarded = ['reviews', ...args.filter(arg => !['--execute', '--full', '--verbose'].includes(arg))];
    const { run: runTaskCommand } = require('./task');
    if (wantsTaskJson || wantsReviewQueue(args)) {
      await runTaskCommand(forwarded);
      return;
    }
    console.log('');
    console.log(renderReviewMinute());
    return;
  }

  const config = loadConfig();
  const executionMode = executeFlag ? 'agent' : (config.execution_mode || 'prompt');

  const targetDir = path.join(root, 'atris');
  const memberValidator = path.join(targetDir, 'team', 'validator', 'MEMBER.md');
  const legacyValidator = path.join(targetDir, 'team', 'validator.md');
  const validatorFile = fs.existsSync(memberValidator)
    ? memberValidator
    : (fs.existsSync(legacyValidator) ? legacyValidator : null);

  const validatorSpec = validatorFile ? fs.readFileSync(validatorFile, 'utf8') : '';

  // Read project-specific testing guide if it exists (optional - projects can add their own)
  // Checks common locations: root, backend/, atris/ directories
  let testingGuide = '';
  let testingGuidePath = null;
  const possiblePaths = [
    path.join(process.cwd(), 'AGENT_TESTING_GUIDE.md'),
    path.join(process.cwd(), 'TESTING_GUIDE.md'),
    path.join(process.cwd(), 'atris', 'TESTING_GUIDE.md'),
  ];
  for (const guidePath of possiblePaths) {
    if (fs.existsSync(guidePath)) {
      testingGuide = fs.readFileSync(guidePath, 'utf8');
      testingGuidePath = guidePath;
      break;
    }
  }

  // Read TODO.md (or legacy TASK_CONTEXTS.md)
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskContextsFile = path.join(targetDir, 'TASK_CONTEXTS.md');
  let taskContexts = '';
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextsFile) ? legacyTaskContextsFile : null);
  if (taskFilePath) {
    taskContexts = fs.readFileSync(taskFilePath, 'utf8');
  }

  // Read journal for timestamp context (History)
  const { logFile, dateFormatted } = getLogPath();
  let journalHistory = '';

  // Load today's log
  if (fs.existsSync(logFile)) {
    journalHistory += `## TODAY (${dateFormatted}):\n` + fs.readFileSync(logFile, 'utf8') + '\n\n';
  }

  // Load previous 3 days of logs for Drift Detection
  // (We need to find them in the logs directory)
  const targetLogsDir = path.join(targetDir, 'logs');
  if (fs.existsSync(targetLogsDir)) {
    // Simple recursive search for last 3 .md files
    const allLogs = [];
    const yearDirs = fs.readdirSync(targetLogsDir).filter(d => /^\d{4}$/.test(d));
    for (const year of yearDirs) {
      const yearPath = path.join(targetLogsDir, year);
      if (fs.statSync(yearPath).isDirectory()) {
        const files = fs.readdirSync(yearPath).filter(f => f.endsWith('.md') && f !== path.basename(logFile));
        files.forEach(f => allLogs.push(path.join(yearPath, f)));
      }
    }
    // Sort desc, take top 3
    allLogs.sort().reverse();
    const recentLogs = allLogs.slice(0, 3);

    if (recentLogs.length > 0) {
      journalHistory += `## RECENT HISTORY (Drift Check):\n`;
      for (const log of recentLogs) {
        journalHistory += `--- ${path.basename(log)} ---\n`;
        journalHistory += fs.readFileSync(log, 'utf8').substring(0, 1000) + '\n... (truncated)\n\n'; // Read first 1kb
      }
    }
  }

  const mapFile = path.join(targetDir, 'MAP.md');
  const mapPath = fs.existsSync(mapFile) ? path.relative(process.cwd(), mapFile) : null;
  const mapIsPlaceholder = (() => {
    if (!fs.existsSync(mapFile)) return false;
    try {
      const content = fs.readFileSync(mapFile, 'utf8').toLowerCase();
      return content.includes('generated by your ai agent after reading atris.md')
        || content.includes('run your ai agent with atris.md to populate this file');
    } catch {
      return false;
    }
  })();

  const validatorPath = validatorFile
    ? path.relative(process.cwd(), validatorFile)
    : 'atris/team/validator/MEMBER.md (missing)';
  const todoPathRef = taskFilePath ? path.relative(process.cwd(), taskFilePath) : null;
  const journalPathRef = path.relative(process.cwd(), logFile);
  const personaPath = path.join(targetDir, 'PERSONA.md');
  const personaRef = fs.existsSync(personaPath) ? path.relative(process.cwd(), personaPath) : null;
  const testingGuideRef = testingGuidePath ? path.relative(process.cwd(), testingGuidePath) : null;

  const featuresReadmePath = path.join(targetDir, 'features', 'README.md');
  const featuresReadmeRef = fs.existsSync(featuresReadmePath) ? path.relative(process.cwd(), featuresReadmePath) : null;

  let featureValidateRefs = [];
  const featuresDir = path.join(targetDir, 'features');
  if (fs.existsSync(featuresDir)) {
    try {
      featureValidateRefs = fs
        .readdirSync(featuresDir)
        .filter((name) => !name.startsWith('_'))
        .filter((name) => {
          const full = path.join(featuresDir, name);
          try {
            return fs.statSync(full).isDirectory();
          } catch {
            return false;
          }
        })
        .map((name) => path.join(featuresDir, name, 'validate.md'))
        .filter((validatePath) => fs.existsSync(validatePath))
        .map((validatePath) => path.relative(process.cwd(), validatePath));
    } catch {
      featureValidateRefs = [];
    }
  }

  const mapDisplay = mapPath
    ? `${mapPath}${mapIsPlaceholder ? ' (placeholder, generate first)' : ''}`
    : 'atris/MAP.md (missing)';

  if (showFull) {
    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│ Atris Review - Validator Agent Activated                   │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');

    console.log('📁 CONTEXT FILES (agent should read):');
    console.log(`- Validator spec: ${validatorPath}`);
    console.log(`- Testing guide: ${testingGuideRef || '(none found)'}`);
    console.log(`- Persona: ${personaRef || 'atris/PERSONA.md (missing)'}`);
    console.log(`- MAP: ${mapDisplay}`);
    console.log(`- TODO: ${todoPathRef || 'atris/TODO.md (missing)'}`);
    console.log(`- Journal (today): ${journalPathRef}`);
    console.log(`- Features index: ${featuresReadmeRef || 'atris/features/README.md (missing)'}`);
    console.log('');

    console.log(`🧪 Feature validate scripts found: ${featureValidateRefs.length}`);
    if (featureValidateRefs.length > 0) {
      featureValidateRefs.slice(0, 3).forEach((ref) => console.log(`- ${ref}`));
      if (featureValidateRefs.length > 3) {
        console.log(`- ... (+${featureValidateRefs.length - 3} more)`);
      }
    }
    console.log('');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 COPY/PASTE PROMPT FOR YOUR CODING AGENT:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
  } else {
    const readinessBits = [
      `MAP is ${mapPath ? 'present' : 'missing'}`,
      `TODO is ${todoPathRef ? 'present' : 'missing'}`,
      `${featureValidateRefs.length} feature validate script${featureValidateRefs.length === 1 ? '' : 's'} ${featureValidateRefs.length === 1 ? 'is' : 'are'} queued`
    ];
    const decision = (mapPath && todoPathRef)
      ? 'Decision: hold final approval until the validator run finishes.'
      : 'Decision: hold. Review setup is incomplete and needs fixing first.';

    printWorkflowBrief([
      'I checked the review setup.',
      readinessBits.join(', ') + '.',
      '',
      'This step prepares the validator. It does not mean the change has passed review yet.',
      'Confidence Gate: review must find loopholes, patch or name each one, and state residual risk before completion.',
      'Next I will run tests, walk each validate.md, and refresh the task projection/TODO view if durable state changed.',
      '',
      decision,
      'Run `atris review --verbose` for the full prompt and appendix.'
    ]);
  }
  if (showFull) {
    console.log('You are the Validator.');
    console.log('');
    console.log('Read these files:');
    console.log(`- ${validatorPath}`);
    if (testingGuideRef) console.log(`- ${testingGuideRef}`);
    if (personaRef) console.log(`- ${personaRef}`);
    if (mapPath) console.log(`- ${mapPath}`);
    if (todoPathRef) console.log(`- ${todoPathRef}`);
    console.log(`- ${journalPathRef}`);
    if (featuresReadmeRef) console.log(`- ${featuresReadmeRef}`);
    console.log('');
    if (!mapPath || mapIsPlaceholder) {
      console.log('Note: If `atris/MAP.md` is missing or placeholder, generate it from `atris/atris.md` before validating file:line references.');
      console.log('');
    }
    console.log('Workflow:');
    console.log('1) Run the project test suite (follow TESTING_GUIDE if present).');
    console.log('2) Execute any `atris/features/*/validate.md` scripts; if a step fails, fix + rerun.');
    console.log('3) Run the Confidence Gate before approving completion.');
    printConfidenceGate('   ');
    console.log('4) Confirm active task state is clean: no unresolved Backlog/In Progress/Blocked rows for the reviewed work.');
    console.log('   If durable task state changed, regenerate the readable view with `atris task render --out atris/TODO.md`.');
    console.log('   Do not hand-delete rendered completed history; use `atris task list --status done` for the ledger.');
    console.log('5) Log to atris/team/validator/logs/YYYY-MM-DD.md');
    console.log('   (Task, Result, Issues found, Learned)');
    console.log('6) If anything surprised you, append to atris/lessons.md.');
    console.log('');
    console.log('Done when: ✅ All good. Active task state clean. Ready for human testing.');
    console.log('');
  }

  if (showFull) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📎 APPENDIX (full context dumps):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    console.log('📋 VALIDATOR SPEC (full):');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(validatorSpec);
    console.log('');

    if (testingGuide) {
      console.log('🧪 TESTING GUIDE (full):');
      console.log('─────────────────────────────────────────────────────────────');
      console.log(testingGuide);
      console.log('');
    }

    if (taskContexts) {
      console.log('📝 TODO.md (full):');
      console.log('─────────────────────────────────────────────────────────────');
      console.log(taskContexts);
      console.log('');
    }
  }

  if (showFull) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💡 Next: Run "atris do" to fix any issues, then "atris review" again');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
  }

  // Check execution mode
  if (executionMode === 'agent') {
    // Agent mode: execute via backend API
    if (!config.agent_id) {
      throw new Error('No agent selected. Run "atris agent" first.');
    }
    const ensured = await ensureValidCredentials(apiRequestJson);
    if (ensured.error === 'not_logged_in' || !ensured.credentials?.token) {
      throw new Error('Not logged in. Run "atris login" first.');
    }
    if (ensured.error) {
      throw new Error(`Authentication failed: ${ensured.detail || ensured.error}. Run "atris login" to re-authenticate.`);
    }
    const credentials = ensured.credentials;

    // Build system prompt
    let systemPrompt = '';
    if (validatorSpec) {
      systemPrompt += validatorSpec + '\n\n';
    }
    if (testingGuide) {
      systemPrompt += '## TESTING GUIDE\n' + testingGuide + '\n\n';
    }

    const personaFile = path.join(targetDir, 'PERSONA.md');
    if (fs.existsSync(personaFile)) {
      systemPrompt += '## PERSONA.md\n' + fs.readFileSync(personaFile, 'utf8') + '\n\n';
    }

    if (mapPath) {
      systemPrompt += `## MAP.md\nRead this file for file:line references: ${mapPath}\n\n`;
    }

    // Build user prompt with context
    let userPrompt = `You are the Validator. Auto-activated after "atris do" completes.\n\n`;
    userPrompt += `Validation Loop:\n`;
    userPrompt += `  1. Ultrathink (say "ultrathink", think 3 times)\n`;
    userPrompt += `  2. Check requirements → build → edge cases → errors → integration\n`;
    userPrompt += `  3. Run tests (unit, integration, linting, type checking)\n`;
    userPrompt += `  4. Run the Confidence Gate before approving completion\n`;
    userPrompt += confidenceGatePrompt('review') + `\n`;
    userPrompt += `  5. Detect Drift: Scan the Journal History below. Do you see the same friction 2x?\n`;
    userPrompt += `  6. If issues found: report → "atris do" fixes → "atris review" again\n`;
    userPrompt += `  7. Repeat until: "✅ All good. Ready for human testing."\n\n`;

    if (taskContexts) {
      userPrompt += `## TODO.md:\n${taskContexts}\n\n`;
    }

    if (journalHistory) {
      userPrompt += `## JOURNAL HISTORY (For Evolution/Drift Check):\n${journalHistory}\n\n`;
    }

    userPrompt += `Your job:\n`;
    userPrompt += `  • Verify everything works\n`;
    userPrompt += `  • Find all plausible loopholes; patch them or name residual risk\n`;
    userPrompt += `  • Test thoroughly (unless user says no)\n`;
    userPrompt += `  • Confirm active task state is clean, with no unresolved Backlog/In Progress/Blocked rows for reviewed work.\n`;
    userPrompt += `    If durable task state changed, regenerate the readable view with \`atris task render --out atris/TODO.md\`.\n`;
    userPrompt += `    Do not hand-delete rendered completed history; if a task fails, move or mark it blocked with a note.\n`;
    userPrompt += `  • Log to atris/team/validator/logs/YYYY-MM-DD.md\n`;
    userPrompt += `    (Task, Result, Issues found, Learned)\n`;
    userPrompt += `  • If anything surprised you, append to atris/lessons.md\n`;
    userPrompt += `  • EVOLUTION: If you see drift in the logs, propose a tool upgrade.\n\n`;
    userPrompt += `The cycle: do → review → [issues] → do → review → ✅ Ready\n`;
    userPrompt += `Start validating now. Read files, run tests, verify implementation.`;

    console.log('');
    console.log('🤖 AGENT MODE: Executing via backend API...');
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // Execute via API
    try {
      await executeCodeExecution({
        prompt: userPrompt,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash'], // Validator needs to read, test, update docs
        permissionMode: 'default',
        maxTurns: 15,
        systemPrompt,
        workingDirectory: process.cwd(),
        agentId: config.agent_id,
        token: credentials.token,
        onMessage: (data) => {
          if (data.type === 'text' && data.content) {
            process.stdout.write(data.content);
          } else if (data.type === 'tool_use') {
            console.log(`\n🛠️  [${data.tool || data.tool_name}] ${JSON.stringify(data.input || data.tool_input || {}).substring(0, 100)}`);
          } else if (data.type === 'tool_result') {
            const result = data.result || data.content || '';
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            const preview = resultStr.substring(0, 200);
            console.log(`\n✅ [Result] ${preview}${resultStr.length > 200 ? '...' : ''}`);
          } else if (data.type === 'error') {
            console.error(`\n❌ Error: ${data.error}`);
          } else if (data.type === 'result') {
            if (data.result) {
              console.log(`\n🎯 [Final] ${data.result}`);
            }
            if (data.duration_ms) {
              console.log(`⏱️  Duration: ${(data.duration_ms / 1000).toFixed(2)}s`);
            }
            if (data.cost_usd) {
              console.log(`💰 Cost: $${data.cost_usd.toFixed(4)}`);
            }
          }
        },
        onError: (error) => {
          console.error(`\n❌ Execution error: ${error.message}`);
        },
      });

      console.log('\n');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');
    } catch (error) {
      console.error(`\n✗ Agent execution failed: ${error.message}`);
      throw error;
    }
  }
  // Prompt mode continues with existing output (already logged above)

  // Handoff prompt: suggest writing handoff if completions exist today
  if (fs.existsSync(logFile)) {
    const journalContent = fs.readFileSync(logFile, 'utf8');
    const hasCompletions = /## Completed ✅[\s\S]*?- \*\*C\d+:/.test(journalContent);
    const hasHandoff = /## Handoff[\s\S]*?\*\*Context:\*\*/.test(journalContent);

    if (hasCompletions && !hasHandoff) {
      if (showFull) {
        console.log('');
        console.log('┌─────────────────────────────────────────────────────────────┐');
        console.log('│ 📝 SESSION HANDOFF                                          │');
        console.log('├─────────────────────────────────────────────────────────────┤');
        console.log('│ You have completions today. Write a handoff for next session│');
        console.log('│                                                             │');
        console.log('│ Add to ## Handoff section in today\'s journal:               │');
        console.log('│   **Context:** [2 lines - what was accomplished]            │');
        console.log('│   **Blockers:** [any issues hit, or "none"]                 │');
        console.log('│   **Next:** [1 clear action for next session]               │');
        console.log('│   **Learned:** [key insight or pattern discovered]          │');
        console.log('└─────────────────────────────────────────────────────────────┘');
        console.log('');
      } else {
        console.log('');
        console.log('you have completions today. add a ## Handoff block to the journal (context / blockers / next / learned).');
        console.log('');
      }
    }
  }

  // Prompt for learnings. Headless and forced non-interactive never ask.
  if (isNonInteractive()) return;

  console.log('');
  if (showFull) {
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│ 💡 Any learnings?                                           │');
    console.log('│ (Enter insight, or press Enter to skip)                     │');
    console.log('└─────────────────────────────────────────────────────────────┘');
  } else {
    console.log('any learnings? (enter to skip)');
  }

  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('> ', (answer) => {
      rl.close();

      if (answer && answer.trim()) {
        // Log to journal ## Notes section
        const { logFile } = getLogPath();
        if (fs.existsSync(logFile)) {
          let journalContent = fs.readFileSync(logFile, 'utf8');
          const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
          const learning = `- ${timestamp} \u2014 ${answer.trim()}`;

          // Find or create ## Notes section
          if (journalContent.includes('## Notes')) {
            journalContent = journalContent.replace(/## Notes\n/, `## Notes\n${learning}\n`);
          } else {
            journalContent += `\n## Notes\n${learning}\n`;
          }

          fs.writeFileSync(logFile, journalContent);
          console.log('');
          console.log(`✓ Logged to journal: ${learning}`);
        }

        // Also log to structured learnings (if learnings module exists)
        try {
          const { addLearning } = require('../lib/learnings');
          const insight = answer.trim();
          // Auto-classify: starts with "don't" or "never" or "avoid" → pitfall, else pattern
          const type = /^(don't|never|avoid|watch out|careful)/i.test(insight) ? 'pitfall' : 'pattern';
          const key = insight.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 4).join('-');
          addLearning({ type, key, insight, confidence: 7, source: 'review', files: [] });
          console.log(`✓ Saved to learnings: [7/10] ${type}/${key}`);
        } catch {
          // learnings module not available, so skip silently
        }
      }

      console.log('');
      resolve();
    });
  });
}

/**
 * Fast Agent SDK execution - for "atris go" command.
 * Direct execution without planning workflow, like "devin" or "cursor agent".
 */
async function executeAgentSDKFast(userInput) {
  const http = require('http');

  console.log(`⚡ Executing: ${userInput}`);
  console.log('');

  try {
    const postData = JSON.stringify({
      message: userInput,
      workspace_path: process.cwd(),
      model: 'claude-sonnet-4-6'
    });

    const options = {
      hostname: '127.0.0.1',
      port: 8000,
      path: '/api/agent-sdk/execute',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const response = await new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(parsed.detail || parsed.error || `HTTP ${res.statusCode}`));
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(120000, () => {
        req.destroy();
        reject(new Error('Request timeout after 120s'));
      });
      req.write(postData);
      req.end();
    });

    if (response.error) {
      throw new Error(response.error);
    }

    // Display results in a clean format
    if (response.result && Array.isArray(response.result)) {
      for (const event of response.result) {
        if (event.type === 'assistant' && event.content) {
          for (const block of event.content) {
            if (block.type === 'text') {
              console.log(block.text);
            } else if (block.type === 'tool_use') {
              console.log(`\n⚙️  ${block.tool_name}`);
            }
          }
        } else if (event.type === 'result') {
          console.log(`\n✅ Done in ${event.duration_ms}ms`);
          if (event.cost_usd) {
            console.log(`💰 Cost: $${event.cost_usd.toFixed(4)}`);
          }
        }
      }
    }

  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
    console.log('');
    console.log('💡 Hosted turns use https://api.atris.ai. For local development, set ATRIS_API_BASE to your own backend URL.');
    process.exit(1);
  }
}

module.exports = {
  planAtris,
  doAtris,
  reviewAtris,
  renderReviewMinute,
  executorAgentPrompt,
  executorDispatchForTask,
  validateExecutorDispatch,
  executeAgentSDKFast,
  makeCloudExecutor,
  postToolResult
};
