const { apiRequestJson } = require('../utils/api');
const { ensureBilledCommandAuth } = require('./auth');
const applyGate = require('../lib/apply-gate');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const YTNOTES_USAGE = 'usage: ytnotes <youtube-url> [youtube-url-or-playlist...] [haiku|atris-fast|gemini|grok|codex|cursor]';
const YTNOTES_HINT = 'zero credits, local captions + a fast engine';
const NOTES_PLAYLIST_CAP = 10;

const DEFAULT_QUERY = [
  'Create a timestamped YouTube brief for Atris.',
  'Include: metadata, timestamped outline, core claims with confidence, memorable examples, actionable takeaways, Atris/product implications, and next actions.',
  'Use transcript timestamps whenever possible.',
].join(' ');
const DEFAULT_TIMEOUT_MS = 300000;
const LOCAL_TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;
const LOCAL_TRANSCRIPT_MAX_CHARS = 250000;
const ALLOWED_CAPTION_HOST_SUFFIXES = [
  'youtube.com',
  'googlevideo.com',
  'youtubei.googleapis.com',
];

function showYoutubeHelp(output = console.log, commandName = 'atris youtube') {
  output('');
  output(`Usage: ${commandName} search "<query>" [--limit N] [--json]`);
  output(`       ${commandName} search --paid "<query>" [--limit N] [--json]`);
  output(`       ${commandName} notes <youtube-url> [youtube-url-or-playlist...] [engine] [--save]`);
  output(`       ${commandName} teach <youtube-url> [--section N] [--save] [--recap TEXT] [--skip]`);
  output(`       ${commandName} teach owed [--json]`);
  output(`       ${commandName} teach next [--json]`);
  output(`       ${commandName} unsave <url-or-id>`);
  output(`       ${commandName} process <youtube-url> [options]`);
  output(`       ${commandName} digest [--days N]`);
  output(`       ${commandName} watch add <channel-url-or-@handle>`);
  output(`       ${commandName} watch list`);
  output(`       ${commandName} watch remove <number>`);
  output(`       ${commandName} watch tick`);
  output(`       ${commandName} <youtube-url> [options]`);
  output('');
  output('search = free local discovery (ytsearch / yt-dlp), returns youtu.be links; rich free search prints one failing check; hands off to teach');
  output('search --paid = 5 credits, watch permalinks + titles from Atris; rich paid search prints one failing check; hands off to teach');
  output('notes = free local notes to stdout; ephemeral unless --save; hands off to teach');
  output('teach = one chapter from local captions; bare teach resumes unpaid checks, then the next chapter after recap or skip');
  output('rich ephemeral notes/teach print one apply next-step and one failing check (no files)');
  output('process = 5 credits cloud knowledge (needs a filled Apply); rich process prints one failing check');
  output('digest = one decision page from this week\'s video briefs; rich digest writes one apply and a failing keep/revert pack');
  output('watch = subscribed channels turn into briefs without a human; add hands off to tick; tick hands off to teach when it briefed');
  output('Process a YouTube video through Atris using timestamped transcript-first analysis.');
  output('Falls back to cloud video processing when local captions are unavailable.');
  output('');
  output('Options:');
  output('  --limit <n>         Max search results (default: 5)');
  output('  --paid              Bill 5 credits for watch permalinks (search only)');
  output('  --save              File brief, journal, apply; rich notes/teach mint a keep/revert experiment');
  output('  --section <n>       Chapter to teach, 1-based (teach only, default: 1)');
  output('  --recap <text>      Unlock the next teach section with the unpaid check');
  output('  --skip              Unlock the next teach section without answering');
  output('  owed                Print the unpaid teach check (no network)');
  output('  next                Next unlocked chapter (no url, no billing)');
  output('  --unsave            Delete filed brief, apply stub, and matching notes/teach experiment packs (no paid calls)');
  output('  --query, -q <text>  Focus question for the analysis');
  output('  --agent <id>        Agent id to store knowledge against');
  output('  --store             Save as agent knowledge (requires --agent)');
  output('  --timeout <sec>     Request timeout in seconds (default: 300)');
  output('  --json              Print the raw JSON response');
  output('  -h, --help          This help');
  output('');
  output('Default output contract:');
  output('  metadata -> timestamped outline -> claims -> examples -> takeaways -> Atris implications -> next actions');
  output('');
  output('Examples:');
  output(`  ${commandName} search "MCP agents 2026"`);
  output(`  ${commandName} search "MCP agents" --limit 10`);
  output(`  ${commandName} search --paid "MCP agents 2026"`);
  output(`  ${commandName} notes https://www.youtube.com/watch?v=VIDEO_ID`);
  output(`  ${commandName} notes https://www.youtube.com/watch?v=VIDEO_ID --save`);
  output(`  ${commandName} teach "https://www.youtube.com/watch?v=VIDEO_ID"`);
  output(`  ${commandName} teach "https://www.youtube.com/watch?v=VIDEO_ID" --section 2`);
  output(`  ${commandName} teach next`);
  output(`  ${commandName} notes --unsave VIDEO_ID`);
  output(`  ${commandName} unsave VIDEO_ID`);
  output(`  ${commandName} notes https://www.youtube.com/watch?v=VIDEO_ID https://youtu.be/OTHER_ID`);
  output(`  ${commandName} notes https://www.youtube.com/playlist?list=PLAYLIST_ID`);
  output(`  ${commandName} https://www.youtube.com/watch?v=VIDEO_ID`);
  output(`  ${commandName} process https://youtu.be/VIDEO_ID --query "Key takeaways"`);
  output(`  ${commandName} digest`);
  output(`  ${commandName} digest --days 14`);
  output(`  ${commandName} watch add @veritasium`);
  output(`  ${commandName} watch tick`);
  output('');
}

function readValue(args, index, name) {
  if (index >= args.length - 1 || String(args[index + 1]).startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

function parseTimeoutMs(raw) {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('--timeout must be a positive number of seconds');
  }
  return Math.round(seconds * 1000);
}

function parseYoutubeArgs(argv = []) {
  const args = [...argv];
  const options = {
    help: false,
    json: false,
    youtubeUrl: null,
    query: DEFAULT_QUERY,
    agentId: null,
    storeAsKnowledge: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  if (args.length === 0 || ['help', '--help', '-h'].includes(args[0])) {
    options.help = true;
    return options;
  }

  if (['process', 'analyze'].includes(args[0])) {
    args.shift();
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--store' || arg === '--store-as-knowledge') {
      options.storeAsKnowledge = true;
    } else if (arg === '--query' || arg === '-q') {
      options.query = readValue(args, i, arg);
      i++;
    } else if (arg.startsWith('--query=')) {
      options.query = arg.slice('--query='.length);
    } else if (arg === '--agent' || arg === '--agent-id') {
      options.agentId = readValue(args, i, arg);
      i++;
    } else if (arg.startsWith('--agent=')) {
      options.agentId = arg.slice('--agent='.length);
    } else if (arg === '--timeout') {
      options.timeoutMs = parseTimeoutMs(readValue(args, i, arg));
      i++;
    } else if (arg.startsWith('--timeout=')) {
      options.timeoutMs = parseTimeoutMs(arg.slice('--timeout='.length));
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.youtubeUrl) {
      options.youtubeUrl = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.youtubeUrl) throw new Error('Missing YouTube URL. Run "atris youtube --help".');
  if (options.storeAsKnowledge && !options.agentId) {
    throw new Error('--store requires --agent <id>');
  }
  return options;
}

function buildYoutubePayload(options) {
  const payload = {
    youtube_url: options.youtubeUrl,
    query: options.query || DEFAULT_QUERY,
  };
  if (options.agentId) payload.agent_id = options.agentId;
  if (options.storeAsKnowledge) payload.store_as_knowledge = true;
  if (options.localTranscript?.transcriptText) {
    payload.transcript_text = options.localTranscript.transcriptText;
    if (options.localTranscript.language) payload.transcript_language = options.localTranscript.language;
    if (options.localTranscript.durationSeconds) payload.duration_seconds = options.localTranscript.durationSeconds;
  }
  if (options.cacheTranscript !== undefined) {
    payload.cache_transcript = Boolean(options.cacheTranscript);
  }
  return payload;
}

function resultErrorText(result) {
  const raw = result?.error || result?.text || 'unknown error';
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function shouldRetryWithLocalTranscript(result) {
  if (!result || result.ok) return false;
  if (result.status === 502) return true;
  if (result.status !== 400) return false;
  return /YouTube video is not publicly accessible|oEmbed|metadata lookup failed/i.test(resultErrorText(result));
}

function youtubeFailureError(result) {
  const hint = result.status === 401
    ? ' Run "atris login --force".'
    : result.status === 402
      ? ' Check Atris credits.'
      : '';
  return new Error(`YouTube processing failed (${result.status}): ${resultErrorText(result)}.${hint}`);
}

function captionHostAllowed(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return ALLOWED_CAPTION_HOST_SUFFIXES.some((suffix) => (
      hostname === suffix || hostname.endsWith(`.${suffix}`)
    ));
  } catch {
    return false;
  }
}

function chooseCaptionTrack(info = {}) {
  const preferred = ['en', 'en-orig', 'en-US', 'en-GB'];
  const chooseFrom = (trackSets = {}) => {
    for (const language of preferred) {
      for (const track of trackSets[language] || []) {
        if (track?.url && ['json3', 'vtt', 'srv3', 'ttml'].includes(track.ext)) return { language, track };
      }
    }
    for (const [language, tracks] of Object.entries(trackSets)) {
      for (const track of tracks || []) {
        if (track?.url) return { language, track };
      }
    }
    return null;
  };

  return chooseFrom(info.subtitles) || chooseFrom(info.automatic_captions);
}

function formatTimestampFromMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const two = (value) => String(value).padStart(2, '0');
  return hours > 0
    ? `${two(hours)}:${two(minutes)}:${two(seconds)}`
    : `${two(minutes)}:${two(seconds)}`;
}

function timestampedCaptionLine(text, startMs) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (!Number.isFinite(Number(startMs))) return clean;
  return `[${formatTimestampFromMs(startMs)}] ${clean}`;
}

function parseVttTimestampMs(value) {
  const match = String(value || '').match(/(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number(match[4] || 0);
  return ((hours * 3600) + (minutes * 60) + seconds) * 1000 + millis;
}

function fetchCaptionText(urlString, redirects = 0) {
  if (!captionHostAllowed(urlString)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const req = https.get(urlString, { timeout: 30000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume();
        const nextUrl = new URL(res.headers.location, urlString).toString();
        resolve(fetchCaptionText(nextUrl, redirects + 1));
        return;
      }

      if (res.statusCode !== 200 || !captionHostAllowed(res.responseUrl || urlString)) {
        res.resume();
        resolve(null);
        return;
      }

      const contentLength = Number(res.headers['content-length'] || 0);
      if (contentLength > LOCAL_TRANSCRIPT_MAX_BYTES) {
        res.resume();
        resolve(null);
        return;
      }

      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > LOCAL_TRANSCRIPT_MAX_BYTES) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function parseCaptionCues(raw) {
  const trimmed = String(raw || '').trimStart();
  if (!trimmed) return [];

  if (trimmed.startsWith('{')) {
    try {
      const payload = JSON.parse(trimmed);
      const cues = [];
      for (const event of payload.events || []) {
        const text = (event.segs || [])
          .map((piece) => piece.utf8 || '')
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        if (!text) continue;
        const startMs = Number(event.tStartMs);
        const cue = { startMs: Number.isFinite(startMs) ? startMs : 0, text };
        if (cues.length && cues[cues.length - 1].text === cue.text && cues[cues.length - 1].startMs === cue.startMs) {
          continue;
        }
        cues.push(cue);
      }
      return cues;
    } catch {
      return [];
    }
  }

  if (/^WEBVTT/i.test(trimmed) || trimmed.includes('-->')) {
    const cues = [];
    for (const block of String(raw).split(/\r?\n\r?\n+/)) {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const timeLine = lines.find((line) => line.includes('-->'));
      if (!timeLine) continue;
      const startMs = parseVttTimestampMs(timeLine.split('-->')[0]);
      const text = lines.slice(lines.indexOf(timeLine) + 1)
        .filter((line) => !/^(NOTE|STYLE|REGION|Kind:|Language:)/.test(line))
        .map((line) => line.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .filter((line, index, all) => index === 0 || line !== all[index - 1])
        .join(' ')
        .trim();
      if (!text) continue;
      const cue = { startMs: startMs == null ? 0 : startMs, text };
      if (cues.length && cues[cues.length - 1].text === cue.text && cues[cues.length - 1].startMs === cue.startMs) {
        continue;
      }
      cues.push(cue);
    }
    return cues;
  }

  return [];
}

function parseCaptionText(raw) {
  const trimmed = String(raw || '').trimStart();
  if (!trimmed) return '';

  const cues = parseCaptionCues(raw);
  if (cues.length) {
    const segments = [];
    for (const cue of cues) {
      const captionLine = timestampedCaptionLine(cue.text, cue.startMs);
      if (!captionLine || segments[segments.length - 1] === captionLine) continue;
      segments.push(captionLine);
    }
    if (segments.length) return segments.join('\n');
  }

  const segments = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped) continue;
    if (/^(WEBVTT|Kind:|Language:|NOTE|STYLE|REGION)/.test(stripped)) continue;
    if (stripped.includes('-->')) continue;
    if (/^\d+$/.test(stripped)) continue;
    if (stripped.includes('<c>') || stripped.includes('</c>')) continue;
    const text = stripped.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (segments[segments.length - 1] === text) continue;
    segments.push(text);
  }
  return segments.join(' ');
}

function parseYtDlpInfoJson(result) {
  const raw = String((result && result.stdout) || '').trim();
  if (!raw) return null;
  try {
    const info = JSON.parse(raw);
    return info && typeof info === 'object' && !Array.isArray(info) ? info : null;
  } catch {
    return null;
  }
}

async function extractLocalTranscript(youtubeUrl, deps = {}) {
  if (process.env.ATRIS_YOUTUBE_LOCAL_TRANSCRIPT === '0') return null;
  const runner = deps.spawnSync || spawnSync;
  const result = runner('yt-dlp', ['-J', '--skip-download', '--no-warnings', youtubeUrl], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const info = parseYtDlpInfoJson(result);
  if (!info) return null;

  const selected = chooseCaptionTrack(info);
  if (!selected?.track?.url) return null;
  const rawCaption = await (deps.fetchCaptionText || fetchCaptionText)(selected.track.url);
  const transcript = parseCaptionText(rawCaption);
  if (!transcript) return null;

  return {
    transcriptText: transcript.slice(0, LOCAL_TRANSCRIPT_MAX_CHARS),
    language: selected.language || 'unknown',
    durationSeconds: Number(info.duration || 0) || undefined,
  };
}

async function processYoutube(options, deps = {}) {
  const applyStatus = (deps.ensureProcessApply || ensureProcessApply)({
    cwd: deps.cwd || process.cwd(),
    url: options.youtubeUrl,
    now: deps.now,
    output: deps.output,
  });
  if (applyStatus !== 0) {
    const err = new Error(PROCESS_APPLY_MESSAGE);
    err.exitCode = applyStatus;
    err.applyRequired = true;
    throw err;
  }

  const apiFn = deps.apiRequestJson || apiRequestJson;
  const ensureBilled = deps.ensureBilledCommandAuth || ensureBilledCommandAuth;
  let auth = await ensureBilled('youtube', deps);
  if (!auth?.ok || !auth.token) {
    throw new Error(auth?.error || 'not signed in. run atris login first.');
  }

  const requestYoutube = async (body) => {
    let result = await apiFn('/agent/process_youtube', {
      method: 'POST',
      token: auth.token,
      timeoutMs: options.timeoutMs,
      retries: 0,
      body,
    });
    if (!result.ok && result.status === 401 && !auth.minted) {
      const remint = await ensureBilled('youtube', { ...deps, forceMint: true });
      if (remint?.ok && remint.token) {
        auth = remint;
        result = await apiFn('/agent/process_youtube', {
          method: 'POST',
          token: auth.token,
          timeoutMs: options.timeoutMs,
          retries: 0,
          body,
        });
      }
    }
    return result;
  };

  const localExtractor = deps.extractLocalTranscript || extractLocalTranscript;
  let localTranscript = null;
  try {
    localTranscript = await localExtractor(options.youtubeUrl, deps);
  } catch {
    localTranscript = null;
  }

  if (localTranscript?.transcriptText) {
    const transcriptResult = await requestYoutube(
      buildYoutubePayload({ ...options, localTranscript, cacheTranscript: false }),
    );

    if (transcriptResult.ok) {
      return transcriptResult.data;
    }

    if (transcriptResult.status === 401 || transcriptResult.status === 402 || transcriptResult.status === 400) {
      throw youtubeFailureError(transcriptResult);
    }
  }

  const result = await requestYoutube(buildYoutubePayload(options));

  if (!result.ok) {
    throw youtubeFailureError(result);
  }

  return result.data;
}

function processAnalysisText(data) {
  return data?.video_analysis || data?.analysis || data?.result || '';
}

function printProcessLearnerGate(data, { json = false } = {}, output) {
  printLearnerCheckGate(output, notesLessonFromText(processAnalysisText(data)), {
    includeCheck: true,
    json,
  });
}

function formatYoutubeResult(data) {
  const lines = [];
  const metadata = data?.metadata || {};
  lines.push(data?.message || 'YouTube video processed successfully');
  if (metadata.title) lines.push(`Title: ${metadata.title}`);
  if (metadata.channel) lines.push(`Channel: ${metadata.channel}`);
  if (metadata.duration_seconds) lines.push(`Duration: ${formatTimestampFromMs(Number(metadata.duration_seconds) * 1000)}`);
  if (metadata.processing_method || metadata.transcript_source) {
    const method = metadata.processing_method || metadata.transcript_source;
    const source = metadata.transcript_source && metadata.transcript_source !== method
      ? ` via ${metadata.transcript_source}`
      : '';
    lines.push(`Processing: ${method}${source}`);
  }
  if (data?.credits_used !== undefined || data?.credits_remaining !== undefined) {
    const used = data.credits_used !== undefined ? data.credits_used : '?';
    const remaining = data.credits_remaining !== undefined ? data.credits_remaining : '?';
    lines.push(`Credits: ${used} used, ${remaining} remaining`);
  }
  const analysis = processAnalysisText(data);
  if (analysis) {
    lines.push('');
    lines.push(String(analysis).trim());
  }
  return lines.join('\n');
}

function videoIdFromUrl(url) {
  const text = String(url || '');
  const watch = text.match(/[?&]v=([^&]+)/);
  if (watch) return watch[1];
  const short = text.match(/youtu\.be\/([^?&/]+)/);
  return short ? short[1] : null;
}

function videoIdFromArg(arg) {
  const fromUrl = videoIdFromUrl(arg);
  if (fromUrl) return fromUrl;
  const text = String(arg || '').trim();
  if (/^[A-Za-z0-9_-]{6,}$/.test(text)) return text;
  return null;
}

function looksLikeYoutubeUrl(arg) {
  const text = String(arg || '').trim();
  if (!text || text.startsWith('-')) return false;
  return /youtube\.com|youtu\.be/i.test(text);
}

function isPlaylistUrl(url) {
  const text = String(url || '');
  return /[?&]list=/.test(text) || /\/playlist(?:\?|$|\/)/i.test(text);
}

function parseNotesArgs(argv = []) {
  const urls = [];
  let engine = null;
  let help = false;
  let save = false;
  let unsave = false;
  let json = false;
  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '--help' || arg === '-h' || arg === 'help') help = true;
    else if (arg === '--save') save = true;
    else if (arg === '--unsave') unsave = true;
    else if (arg === '--json') json = true;
  }
  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '--help' || arg === '-h' || arg === 'help') continue;
    if (arg === '--save' || arg === '--unsave' || arg === '--json') continue;
    if (arg.startsWith('-')) continue;
    if (looksLikeYoutubeUrl(arg)) urls.push(arg);
    else if (unsave && videoIdFromArg(arg)) urls.push(arg);
    else engine = arg;
  }
  return { urls, engine, help, save, unsave, json };
}

function dateStamp(now) {
  if (typeof now === 'string' && /^\d{4}-\d{2}-\d{2}/.test(now)) {
    return now.slice(0, 10);
  }
  const value = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(value.getTime())) return new Date().toISOString().slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function firstHeading(notes) {
  const match = String(notes || '').replace(/\r\n/g, '\n').match(/^#{1,6}\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function fileBriefFromNotes({ cwd, url, workDir, now } = {}) {
  try {
    const id = videoIdFromUrl(url);
    if (!id) return;
    const notesPath = path.join(workDir, `yt_${id}.md`);
    if (!fs.existsSync(notesPath)) return;
    const notes = fs.readFileSync(notesPath, 'utf8');
    const wikiDir = path.join(cwd, 'atris', 'wiki');
    if (!fs.existsSync(wikiDir)) return;

    const heading = firstHeading(notes);
    const date = dateStamp(now);
    const header = [
      heading.toLowerCase(),
      '',
      `date: ${date}`,
      `source: ${url}`,
      'rail: atris youtube notes, quotes repaired against the transcript',
    ].join('\n');
    const briefsDir = path.join(wikiDir, 'briefs');
    fs.mkdirSync(briefsDir, { recursive: true });
    const relBrief = `atris/wiki/briefs/youtube-${id}.md`;
    fs.writeFileSync(path.join(cwd, relBrief), `${header}\n${notes}`);

    const year = date.slice(0, 4);
    const journalPath = path.join(cwd, 'atris', 'logs', year, `${date}.md`);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    let existing = '';
    if (fs.existsSync(journalPath)) existing = fs.readFileSync(journalPath, 'utf8');
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    const line = `- [claimable] watched: ${heading} -> ${relBrief}`;
    fs.writeFileSync(journalPath, `${existing}${prefix}${line}\n`);

    console.log(`brief filed: ${relBrief}`);
    return relBrief;
  } catch {
    // notes filing must never break the youtube command
  }
}

const APPLY_NEXT_MESSAGE =
  'next: write one apply (change + receipt) before process.';
const PROCESS_APPLY_MESSAGE =
  'write one apply (change + receipt) before process.';

function applySidecarRel(id) {
  return applyGate.applySidecarRel('youtube', id);
}

function notesExperimentSlug(id) {
  return `notes-${experimentIdToken(id)}`;
}

function notesExperimentRel(id) {
  return `atris/experiments/${notesExperimentSlug(id)}`;
}

function notesLessonFromText(text) {
  const body = String(text || '');
  return {
    numbers: extractTeachNumbers(body),
    mechanisms: extractTeachMechanisms(body),
  };
}

function readNotesText({ url, workDir } = {}) {
  const id = videoIdFromUrl(url);
  if (!id || !workDir) return '';
  const notesPath = path.join(workDir, `yt_${id}.md`);
  try {
    if (!fs.existsSync(notesPath)) return '';
    return fs.readFileSync(notesPath, 'utf8');
  } catch {
    return '';
  }
}

function notesWorkDir(deps = {}) {
  return deps.workDir || path.join(process.env.TMPDIR || '/tmp', 'ytnotes');
}

function notesRunnerDetail(result) {
  return String(
    (result && result.stderr) || (result && result.error && result.error.message) || '',
  ).trim();
}

function isNotesRateLimited(result) {
  return LOCAL_SEARCH_RATE_LIMIT_RE.test(notesRunnerDetail(result));
}

function keptPrintedNotes({ url, workDir, result } = {}) {
  if (result != null && !isNotesRateLimited(result)) return false;
  return Boolean(String(readNotesText({ url, workDir }) || '').trim());
}

function saveRichNotes(url, deps = {}) {
  const workDir = deps.workDir || path.join(process.env.TMPDIR || '/tmp', 'ytnotes');
  const lesson = notesLessonFromText(readNotesText({ url, workDir }));
  if (isThinTeachLesson(lesson)) {
    return { thin: true, brief: null, packRel: null, lesson };
  }
  const brief = fileNotesBrief(url, deps);
  const id = videoIdFromUrl(url);
  const packRel = fileTeachExperiment({
    cwd: deps.cwd || process.cwd(),
    url,
    lesson,
    slug: id ? notesExperimentSlug(id) : null,
    applyRel: id ? applySidecarRel(id) : null,
  });
  return { thin: false, brief, packRel, lesson };
}

function ensureNotesApply({ cwd, url, packRel, now, output } = {}) {
  const id = videoIdFromUrl(url);
  const pack = packRel || (id ? notesExperimentRel(id) : null);
  const slug = pack ? path.basename(pack) : null;
  return applyGate.ensureApply({
    cwd,
    source: url,
    rel: id ? applySidecarRel(id) : null,
    now,
    output,
    incompleteMessage: slug
      ? `next: atris experiments keep ${slug}`
      : APPLY_NEXT_MESSAGE,
    required: false,
    change: pack ? `apply ${pack}` : undefined,
    receipt: pack ? TEACH_KEEP_RULE : undefined,
    journalLine: pack ? `- [claimable] apply: ${pack}. ${TEACH_KEEP_RULE}` : undefined,
  });
}

function youtubeBriefRel(id) {
  return `atris/wiki/briefs/youtube-${id}.md`;
}

function removeUnsaveRel(cwd, rel, removed) {
  const abs = path.join(cwd, rel);
  try {
    if (!fs.existsSync(abs)) return;
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
    else fs.unlinkSync(abs);
    removed.push(rel);
  } catch {
    // already gone or unreadable: do not error
  }
}

function listTeachSectionNumbers(cwd, id) {
  const root = path.join(cwd, 'atris', 'experiments');
  const sections = [];
  try {
    if (!fs.existsSync(root)) return sections;
    for (const name of fs.readdirSync(root)) {
      const match = String(name).match(/^teach-.+-s(\d+)$/);
      if (!match) continue;
      const section = Number(match[1]);
      if (name === teachExperimentSlug(id, section)) sections.push(section);
    }
  } catch {
    // missing experiments dir is fine
  }
  return sections.sort((a, b) => a - b);
}

function listTeachSidecarRels(cwd, id) {
  const briefsDir = path.join(cwd, 'atris', 'wiki', 'briefs');
  const prefix = `youtube-${id}-s`;
  try {
    if (!fs.existsSync(briefsDir)) return [];
    return fs.readdirSync(briefsDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.md'))
      .sort((a, b) => a.localeCompare(b, 'en'))
      .map((name) => `atris/wiki/briefs/${name}`);
  } catch {
    return [];
  }
}

function unsaveYoutubeNotes(target, deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  const cwd = deps.cwd || process.cwd();
  const id = videoIdFromArg(target);
  if (!id) {
    output('usage: atris youtube unsave <url-or-id>');
    return 2;
  }
  const briefRel = youtubeBriefRel(id);
  const applyRel = applySidecarRel(id);
  const sections = listTeachSectionNumbers(cwd, id);
  const rels = [];
  const seen = new Set();
  const add = (rel) => {
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    rels.push(rel);
  };
  add(briefRel);
  add(applyRel);
  for (const section of sections) {
    add(teachBriefRel(id, section));
    add(applySidecarRel(`${id}-s${section}`));
  }
  for (const rel of listTeachSidecarRels(cwd, id)) add(rel);
  add(notesExperimentRel(id));
  for (const section of sections) add(teachExperimentRel(id, section));

  const removed = [];
  for (const rel of rels) removeUnsaveRel(cwd, rel, removed);
  if (!removed.length) {
    output(`already gone: ${briefRel} and ${applyRel}`);
    return 0;
  }
  output(`removed ${removed.join(' and ')}`);
  return 0;
}

function runYoutubeUnsave(args = [], deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  const parsed = parseNotesArgs(['--unsave', ...args]);
  if (parsed.help) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }
  if (!parsed.urls.length) {
    output('usage: atris youtube unsave <url-or-id>');
    return 2;
  }
  let code = 0;
  for (const target of parsed.urls) {
    const status = unsaveYoutubeNotes(target, deps);
    if (status !== 0) code = status;
  }
  if (code === 0 && parsed.json !== true && deps.json !== true) {
    printWatchSearchNext(output);
  }
  return code;
}

function ensureProcessApply({ cwd, url, now, output } = {}) {
  const id = videoIdFromUrl(url);
  return applyGate.ensureApply({
    cwd,
    source: url,
    rel: id ? applySidecarRel(id) : null,
    now,
    output,
    incompleteMessage: PROCESS_APPLY_MESSAGE,
    required: true,
  });
}

const DIGEST_ENGINE_TIMEOUT_MS = 240000;
const DEFAULT_DIGEST_DAYS = 7;

function addUtcDays(stamp, delta) {
  const [year, month, day] = String(stamp || '').split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + Number(delta || 0)));
  return value.toISOString().slice(0, 10);
}

function parseBriefDate(text) {
  const match = String(text || '').match(/^date:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
  return match ? match[1] : null;
}

function isVideoBriefText(text) {
  return /^source:\s*http/m.test(String(text || ''));
}

function briefTitleLine(text) {
  const heading = firstHeading(text);
  if (heading) return heading;
  const first = String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first || '';
}

function dateInDigestWindow(dateStr, now, days) {
  if (!dateStr) return false;
  const today = dateStamp(now);
  const start = addUtcDays(today, -(Number(days) - 1));
  return dateStr >= start && dateStr <= today;
}

function parseDigestArgs(argv = []) {
  const args = [...argv];
  const options = { help: false, days: DEFAULT_DIGEST_DAYS };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
    } else if (arg === '--days') {
      const raw = args[i + 1];
      const value = Number(raw);
      if (raw == null || String(raw).startsWith('--') || !Number.isInteger(value) || value <= 0) {
        throw new Error('--days must be a positive integer');
      }
      options.days = value;
      i += 1;
    } else if (arg.startsWith('--days=')) {
      const value = Number(arg.slice('--days='.length));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('--days must be a positive integer');
      }
      options.days = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return options;
}

function collectVideoBriefs({ cwd, now, days } = {}) {
  const root = cwd || process.cwd();
  const briefsDir = path.join(root, 'atris', 'wiki', 'briefs');
  if (!fs.existsSync(briefsDir)) return [];

  const rows = [];
  for (const name of fs.readdirSync(briefsDir).sort()) {
    if (!name.endsWith('.md') || name.startsWith('digest-')) continue;
    const abs = path.join(briefsDir, name);
    let body = '';
    try {
      if (!fs.statSync(abs).isFile()) continue;
      body = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!isVideoBriefText(body)) continue;
    const date = parseBriefDate(body);
    if (!dateInDigestWindow(date, now, days)) continue;
    rows.push({
      name,
      relPath: `atris/wiki/briefs/${name}`,
      title: briefTitleLine(body),
      date,
      body,
    });
  }
  rows.sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date.localeCompare(b.date)));
  return rows;
}

function buildDigestPrompt(briefs = []) {
  const blocks = briefs.map((row) => [
    `filename: ${row.name}`,
    `title: ${row.title}`,
    `path: ${row.relPath}`,
    '',
    row.body,
  ].join('\n'));
  return [
    'Turn these video briefs into one decision-focused page.',
    'Write a heading exactly: # what this week\'s videos changed',
    'Then 3-6 decision-shaped findings. Each finding must name the brief it came from as a path.',
    'Then one contradictions or tensions paragraph if any exist.',
    'Then a 3-item do next list.',
    'Use plain prose. Do not use em dashes.',
    '',
    'Briefs:',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

function defaultDigestRunner(prompt, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  return spawn('claude', ['-p', prompt, '--model', 'claude-haiku-4-5'], {
    encoding: 'utf8',
    timeout: DIGEST_ENGINE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function invokeDigestEngine(prompt, deps = {}) {
  const runner = deps.runner || ((nextPrompt) => defaultDigestRunner(nextPrompt, deps));
  const result = runner(prompt, deps);
  if (typeof result === 'string') return result.trim();
  if (!result || result.error || (result.status != null && result.status !== 0)) {
    const detail = String(result?.stderr || result?.error?.message || 'digest engine failed').trim();
    throw new Error(detail || 'digest engine failed');
  }
  return String(result.stdout || '').trim();
}

function appendDigestJournal({ cwd, date, relDigest }) {
  const year = date.slice(0, 4);
  const journalPath = path.join(cwd, 'atris', 'logs', year, `${date}.md`);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  let existing = '';
  if (fs.existsSync(journalPath)) existing = fs.readFileSync(journalPath, 'utf8');
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const line = `- [claimable] digest: what this week's videos changed -> ${relDigest}`;
  fs.writeFileSync(journalPath, `${existing}${prefix}${line}\n`);
}

function digestExperimentSlug(date) {
  return `digest-${String(date || '').slice(0, 10)}`;
}

function digestExperimentRel(date) {
  return `atris/experiments/${digestExperimentSlug(date)}`;
}

function digestApplyRel(date) {
  return applyGate.applySidecarRel('digest', String(date || '').slice(0, 10));
}

function ensureDigestApply({ cwd, date, packRel, now, output, source } = {}) {
  const stamp = String(date || '').slice(0, 10);
  const pack = packRel || (stamp ? digestExperimentRel(stamp) : null);
  const slug = pack ? path.basename(pack) : null;
  return applyGate.ensureApply({
    cwd,
    source: source || (stamp ? `digest:${stamp}` : 'digest'),
    rel: stamp ? digestApplyRel(stamp) : null,
    now,
    output,
    incompleteMessage: slug
      ? `next: atris experiments keep ${slug}`
      : applyGate.ephemeralApplyMessage('digest'),
    required: false,
    change: pack ? `apply ${pack}` : undefined,
    receipt: pack ? TEACH_KEEP_RULE : undefined,
    journalLine: pack ? `- [claimable] apply: ${pack}. ${TEACH_KEEP_RULE}` : undefined,
  });
}

function saveRichDigest({ cwd, date, lesson, source } = {}) {
  if (isThinTeachLesson(lesson)) {
    return { thin: true, packRel: null, lesson };
  }
  const packRel = fileTeachExperiment({
    cwd,
    lesson,
    slug: date ? digestExperimentSlug(date) : null,
    applyRel: date ? digestApplyRel(date) : null,
  });
  return { thin: false, packRel, lesson, source };
}

function watchExperimentSlug(id) {
  return `watch-${experimentIdToken(id)}`;
}

function watchExperimentRel(id) {
  return `atris/experiments/${watchExperimentSlug(id)}`;
}

function watchApplyRel(id) {
  return applyGate.applySidecarRel('watch', experimentIdToken(id));
}

function ensureWatchWiki(cwd) {
  if (!cwd) return;
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
}

function ensureWatchApply({ cwd, url, packRel, now, output, source } = {}) {
  const id = videoIdFromUrl(url);
  const pack = packRel || (id ? watchExperimentRel(id) : null);
  const slug = pack ? path.basename(pack) : null;
  ensureWatchWiki(cwd);
  return applyGate.ensureApply({
    cwd,
    source: source || url || (id ? `watch:${id}` : 'watch'),
    rel: id ? watchApplyRel(id) : null,
    now,
    output,
    incompleteMessage: slug
      ? `next: atris experiments keep ${slug}`
      : applyGate.ephemeralApplyMessage('watch'),
    required: false,
    change: pack ? `apply ${pack}` : undefined,
    receipt: pack ? TEACH_KEEP_RULE : undefined,
    journalLine: pack ? `- [claimable] apply: ${pack}. ${TEACH_KEEP_RULE}` : undefined,
  });
}

function firstRichWatchLesson(urls, workDir) {
  for (const url of Array.isArray(urls) ? urls : []) {
    if (!url) continue;
    const lesson = notesLessonFromText(readNotesText({ url, workDir }));
    if (!isThinTeachLesson(lesson)) return { url, lesson };
  }
  return null;
}

function saveRichWatch({ cwd, url, lesson } = {}) {
  if (isThinTeachLesson(lesson)) {
    return { thin: true, packRel: null, lesson };
  }
  const id = videoIdFromUrl(url);
  const packRel = fileTeachExperiment({
    cwd,
    url,
    lesson,
    slug: id ? watchExperimentSlug(id) : null,
    applyRel: id ? watchApplyRel(id) : null,
  });
  return { thin: false, packRel, lesson, source: url };
}

function runYoutubeDigest(args = [], deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  let options;
  try {
    options = parseDigestArgs(args);
  } catch (err) {
    output(err.message);
    return 2;
  }
  if (options.help) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }

  const cwd = deps.cwd || process.cwd();
  const now = deps.now || new Date();
  const briefs = collectVideoBriefs({ cwd, now, days: options.days });
  if (!briefs.length) {
    output(`no video briefs in the last ${options.days} days`);
    printWatchSearchNext(output);
    return 0;
  }

  const prompt = buildDigestPrompt(briefs);
  let text;
  try {
    text = invokeDigestEngine(prompt, deps);
  } catch (err) {
    output(err.message || 'digest engine failed');
    return 1;
  }
  if (!text) {
    output('digest engine returned no text');
    return 1;
  }

  const date = dateStamp(now);
  const relDigest = `atris/wiki/briefs/digest-${date}.md`;
  const header = [
    `date: ${date}`,
    `window: ${options.days} days`,
    `sources: ${briefs.map((row) => row.relPath).join(', ')}`,
  ].join('\n');
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki', 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(cwd, relDigest), `${header}\n\n${text}\n`);
  appendDigestJournal({ cwd, date, relDigest });
  output(`digest filed: ${relDigest} (${briefs.length} briefs)`);
  const lesson = notesLessonFromText(text);
  if (isThinTeachLesson(lesson)) {
    printLearnerCheckGate(output, lesson, { includeCheck: true });
    printWatchTickNext(output);
    return 0;
  }

  const saved = saveRichDigest({ cwd, date, lesson, source: relDigest });
  const ensureApply = deps.ensureApply || ensureDigestApply;
  const applyCode = ensureApply({
    cwd,
    date,
    packRel: saved.packRel,
    now,
    output,
    source: relDigest,
  });
  if (deps.ensureApply) return applyCode;
  const baseline = proveSavedLearnerBaseline({
    cwd,
    applyRel: digestApplyRel(date),
    lesson,
    output,
  });
  if (baseline !== 0) return baseline;
  return applyCode;
}

function watchStatePath(cwd = process.cwd()) {
  return path.join(cwd, '.atris', 'state', 'youtube_watch.json');
}

function emptyWatchState() {
  return { channels: [], seen: {}, seeded: {}, seenByChannel: {} };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function loadWatchState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const channels = Array.isArray(parsed?.channels) ? parsed.channels : [];
    return {
      channels,
      seen: asObject(parsed?.seen),
      seeded: asObject(parsed?.seeded),
      seenByChannel: asObject(parsed?.seenByChannel),
    };
  } catch {
    return emptyWatchState();
  }
}

function saveWatchState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const payload = {
    channels: (state.channels || []).map((row) => ({
      channel: row.channel,
      added: row.added,
    })),
    seen: asObject(state.seen),
    seeded: asObject(state.seeded),
    seenByChannel: asObject(state.seenByChannel),
  };
  fs.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function stampNow(now) {
  if (typeof now === 'function') now = now();
  if (typeof now === 'string' && now) return now;
  const value = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(value.getTime())) return new Date().toISOString();
  return value.toISOString();
}

function normalizeWatchChannel(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Missing channel url or @handle. Run "atris youtube watch --help".');

  let text = raw;
  if (text.startsWith('@')) {
    text = `https://www.youtube.com/${text}`;
  } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) {
    if (/^(www\.)?youtube\.com\//i.test(text) || /^youtu\.be\//i.test(text)) {
      text = `https://${text}`;
    } else if (/^@?[\w.-]+$/.test(text)) {
      text = `https://www.youtube.com/@${text.replace(/^@/, '')}`;
    } else {
      throw new Error(`Invalid channel: ${raw}`);
    }
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Invalid channel: ${raw}`);
  }

  parsed.hash = '';
  parsed.search = '';
  let href = parsed.toString().replace(/\/+$/, '');
  href = href.replace(/\/(videos|featured|streams|shorts)$/i, '');
  return href;
}

function channelVideosUrl(channel) {
  const base = String(channel || '').replace(/\/+$/, '');
  if (/\/videos$/i.test(base)) return base;
  return `${base}/videos`;
}

function parseFlatPlaylist(stdout) {
  const videos = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('|')) continue;
    const idx = trimmed.indexOf('|');
    const id = trimmed.slice(0, idx).trim();
    const title = trimmed.slice(idx + 1).trim();
    if (id && id !== 'NA') videos.push({ id, title });
  }
  return videos;
}

function defaultChannelFetcher(videosUrl, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const result = spawn('yt-dlp', [
    '--no-update',
    '--flat-playlist',
    '--no-warnings',
    '--playlist-end',
    '3',
    '--print',
    '%(id)s|%(title)s',
    videosUrl,
  ], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const videos = parseFlatPlaylist(result && result.stdout);
  if (videos.length) return videos;
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || 'fetch failed').trim();
    throw new Error(detail || 'fetch failed');
  }
  return videos;
}

function defaultNotesRunner(url, deps = {}) {
  const script = path.join(__dirname, '..', 'scripts', 'det', 'ytnotes');
  const spawn = deps.spawnSync || spawnSync;
  return spawn(script, [url], { stdio: 'inherit' });
}

function resolveWatchStatePath(deps = {}) {
  if (deps.statePath) return deps.statePath;
  return watchStatePath(deps.cwd || process.cwd());
}

function channelSeenMap(state, channel) {
  return asObject(asObject(state.seenByChannel)[channel]);
}

function markSeen(state, channel, id, timestamp) {
  if (!state.seen || typeof state.seen !== 'object') state.seen = {};
  if (!state.seenByChannel || typeof state.seenByChannel !== 'object') state.seenByChannel = {};
  if (!state.seenByChannel[channel] || typeof state.seenByChannel[channel] !== 'object') {
    state.seenByChannel[channel] = {};
  }
  state.seen[id] = timestamp;
  state.seenByChannel[channel][id] = timestamp;
}

const WATCH_TICK_NEXT = 'next: atris youtube watch tick';
const WATCH_ADD_NEXT = 'next: atris youtube watch add <channel-url-or-@handle>';
const WATCH_SEARCH_NEXT = 'next: atris youtube search " "';

function printWatchTickNext(output) {
  output(WATCH_TICK_NEXT);
}

function printWatchAddNext(output) {
  output(WATCH_ADD_NEXT);
}

function printWatchSearchNext(output) {
  output(WATCH_SEARCH_NEXT);
}

function addWatchChannel(channelInput, deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  if (!channelInput) {
    output('usage: atris youtube watch add <channel-url-or-@handle>');
    return 2;
  }

  let channel;
  try {
    channel = normalizeWatchChannel(channelInput);
  } catch (err) {
    output(err.message);
    return 2;
  }

  const statePath = resolveWatchStatePath(deps);
  const state = loadWatchState(statePath);
  if (state.channels.some((row) => row.channel === channel)) {
    output(`already watching ${channel}`);
    printWatchTickNext(output);
    return 0;
  }

  state.channels.push({
    channel,
    added: stampNow(deps.now),
  });
  saveWatchState(statePath, state);
  output(`watching ${channel}`);
  printWatchTickNext(output);
  return 0;
}

function listWatchChannels(deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  const state = loadWatchState(resolveWatchStatePath(deps));
  if (!state.channels.length) {
    output('no channels watched');
    printWatchAddNext(output);
    return 0;
  }

  state.channels.forEach((row, index) => {
    const count = Object.keys(channelSeenMap(state, row.channel)).length;
    output(`${index + 1}. ${row.channel} (${count} seen)`);
  });
  printWatchTickNext(output);
  return 0;
}

function removeWatchChannel(rawNumber, deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  const index = Number(rawNumber);
  const statePath = resolveWatchStatePath(deps);
  const state = loadWatchState(statePath);
  if (!Number.isInteger(index) || index < 1 || index > state.channels.length) {
    output('usage: atris youtube watch remove <number>');
    return 2;
  }

  const [removed] = state.channels.splice(index - 1, 1);
  saveWatchState(statePath, state);
  output(`removed ${removed.channel}`);
  if (!state.channels.length) {
    printWatchAddNext(output);
  } else {
    printWatchTickNext(output);
  }
  return 0;
}

async function tickWatch(deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  const statePath = resolveWatchStatePath(deps);
  const fetcher = deps.fetcher || ((videosUrl) => defaultChannelFetcher(videosUrl, deps));
  const runner = deps.runner || ((url) => defaultNotesRunner(url, deps));
  const briefFiler = deps.briefFiler || fileBriefFromNotes;
  const cwd = deps.cwd || process.cwd();
  const workDir = deps.workDir || path.join(process.env.TMPDIR || '/tmp', 'ytnotes');
  const timestamp = stampNow(deps.now);
  const now = deps.now || timestamp;

  const state = loadWatchState(statePath);
  let totalNew = 0;
  let totalBriefed = 0;
  let firstBriefedUrl = null;
  const briefedUrls = [];

  for (const row of state.channels) {
    const videosUrl = channelVideosUrl(row.channel);
    let videos;
    try {
      videos = await Promise.resolve(fetcher(videosUrl, row));
    } catch {
      output(`warning: channel ${row.channel} fetch failed`);
      continue;
    }
    if (!Array.isArray(videos)) {
      output(`warning: channel ${row.channel} fetch failed`);
      continue;
    }

    const localSeen = channelSeenMap(state, row.channel);
    const isFresh = !state.seeded[row.channel];
    const unseen = videos.filter((video) => video?.id && !localSeen[video.id] && !state.seen[video.id]);
    const newest = videos[0];
    const toBrief = isFresh
      ? (newest?.id ? [newest] : [])
      : unseen;

    if (isFresh) {
      state.seeded[row.channel] = true;
      for (const video of videos) {
        if (video?.id) markSeen(state, row.channel, video.id, timestamp);
      }
    }

    let briefed = 0;
    for (const video of toBrief) {
      if (!video?.id) continue;
      const url = `https://www.youtube.com/watch?v=${video.id}`;
      try {
        runner(url, deps);
      } catch {
        // notes failure must not stop the rest of the tick
      }
      try {
        briefFiler({ cwd, url, workDir, now });
      } catch {
        // brief filing must never break the watch tick
      }
      markSeen(state, row.channel, video.id, timestamp);
      briefed += 1;
      briefedUrls.push(url);
      if (!firstBriefedUrl) firstBriefedUrl = url;
    }

    if (!isFresh) {
      for (const video of unseen) {
        if (video?.id) markSeen(state, row.channel, video.id, timestamp);
      }
    }

    const newCount = isFresh ? (newest?.id ? 1 : 0) : unseen.length;
    output(`channel ${row.channel}: ${newCount} new, ${briefed} briefed`);
    totalNew += newCount;
    totalBriefed += briefed;
    saveWatchState(statePath, state);
  }

  output(`total: ${totalNew} new, ${totalBriefed} briefed`);
  saveWatchState(statePath, state);
  if (totalBriefed > 0) {
    const rich = firstRichWatchLesson(briefedUrls, workDir);
    if (rich) {
      const saved = saveRichWatch({ cwd, url: rich.url, lesson: rich.lesson });
      const ensureApply = deps.ensureApply || ensureWatchApply;
      const applyCode = ensureApply({
        cwd,
        url: rich.url,
        packRel: saved.packRel,
        now,
        output,
        source: rich.url,
      });
      if (deps.ensureApply) return applyCode;
      const id = videoIdFromUrl(rich.url);
      const baseline = proveSavedLearnerBaseline({
        cwd,
        applyRel: id ? watchApplyRel(id) : null,
        lesson: rich.lesson,
        output,
      });
      if (baseline !== 0) return baseline;
      return applyCode;
    }
    if (firstBriefedUrl) {
      const lesson = notesLessonFromText(readNotesText({ url: firstBriefedUrl, workDir }));
      printLearnerCheckGate(output, lesson, { includeCheck: true });
      printYoutubeTeachNext(firstBriefedUrl, {}, output);
      return 0;
    }
    printYoutubeTeachNext(firstBriefedUrl, {}, output);
    return 0;
  }
  if (!state.channels.length) printWatchAddNext(output);
  else printWatchSearchNext(output);
  return 0;
}

async function watchCommand(args = [], deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  const sub = args[0];
  if (!sub || ['help', '--help', '-h'].includes(sub)) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return sub ? 0 : 2;
  }
  if (sub === 'add') return addWatchChannel(args[1], deps);
  if (sub === 'list') return listWatchChannels(deps);
  if (sub === 'remove') return removeWatchChannel(args[1], deps);
  if (sub === 'tick') return tickWatch(deps);
  output(`unknown watch command: ${sub}`);
  return 2;
}

function defaultPlaylistExpander(playlistUrl, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const result = spawn('yt-dlp', [
    '--no-update',
    '--flat-playlist',
    '--print',
    '%(id)s|%(title)s',
    playlistUrl,
  ], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const videos = parseFlatPlaylist(result && result.stdout);
  if (videos.length) return videos;
  if (result.error || (result.status != null && result.status !== 0)) {
    const detail = String(result.stderr || result.error?.message || 'playlist expand failed').trim();
    throw new Error(detail || 'playlist expand failed');
  }
  return videos;
}

function defaultNotesItemRunner(url, engine, deps = {}) {
  const script = path.join(__dirname, '..', 'scripts', 'det', 'ytnotes');
  const spawn = deps.spawnSync || spawnSync;
  const childArgs = engine ? [url, engine] : [url];
  return spawn(script, childArgs, { stdio: 'inherit' });
}

function readNowMs(deps = {}) {
  if (typeof deps.nowMs === 'function') return Number(deps.nowMs()) || 0;
  if (Number.isFinite(deps.nowMs)) return Number(deps.nowMs);
  return Date.now();
}

function notesItemLabel(item = {}) {
  return item.id || item.url || '';
}

function expandNotesTargets(urls = [], deps = {}) {
  const output = deps.output || ((line = '') => console.error(line));
  const expander = deps.expander || ((playlistUrl) => defaultPlaylistExpander(playlistUrl, deps));
  const items = [];
  for (const url of urls) {
    if (!isPlaylistUrl(url)) {
      items.push({ url, id: videoIdFromUrl(url) });
      continue;
    }
    let videos = [];
    try {
      videos = expander(url, deps);
    } catch {
      items.push({ url, id: videoIdFromUrl(url), failed: true });
      continue;
    }
    if (!Array.isArray(videos) || videos.length === 0) {
      items.push({ url, id: videoIdFromUrl(url), failed: true });
      continue;
    }
    if (videos.length > NOTES_PLAYLIST_CAP) {
      output(`playlist capped at ${NOTES_PLAYLIST_CAP} videos (${videos.length} found)`);
      videos = videos.slice(0, NOTES_PLAYLIST_CAP);
    }
    for (const video of videos) {
      if (!video?.id) continue;
      items.push({
        url: `https://www.youtube.com/watch?v=${video.id}`,
        id: video.id,
        title: video.title,
      });
    }
  }
  return items;
}

function invokeNotesRunner(url, engine, deps = {}) {
  const runner = deps.runner;
  if (runner) return runner(url, engine, deps);
  return defaultNotesItemRunner(url, engine, deps);
}

function readRunnerStatus(result) {
  if (typeof result === 'number') return result;
  if (result && typeof result === 'object') {
    return result.status == null ? 1 : result.status;
  }
  return 1;
}

function fileNotesBrief(url, deps = {}) {
  const briefFiler = deps.briefFiler || fileBriefFromNotes;
  try {
    const filed = briefFiler({
      cwd: deps.cwd || process.cwd(),
      url,
      workDir: deps.workDir || path.join(process.env.TMPDIR || '/tmp', 'ytnotes'),
      now: deps.now || new Date(),
    });
    return typeof filed === 'string' && filed ? filed : null;
  } catch {
    return null;
  }
}

function runOneNotesItem(item, engine, deps = {}) {
  const output = deps.output || ((line = '') => console.error(line));
  const label = notesItemLabel(item);
  if (item.failed) {
    output(`${label}  0s  FAILED`);
    return { url: item.url, id: item.id, seconds: 0, ok: false, brief: null };
  }

  const started = readNowMs(deps);
  let result = { status: 1 };
  try {
    result = invokeNotesRunner(item.url, engine, deps);
  } catch (err) {
    result = { status: 1, stderr: String((err && err.message) || err || '') };
  }
  const status = readRunnerStatus(result);
  let brief = null;
  let lesson = null;
  let ok = status === 0 || keptPrintedNotes({
    url: item.url,
    workDir: notesWorkDir(deps),
    result,
  });
  if (ok && deps.save) {
    const saved = saveRichNotes(item.url, deps);
    if (saved.thin) {
      output(TEACH_THIN_REFUSE);
      ok = false;
    } else {
      brief = saved.brief;
      lesson = saved.lesson;
      const ensureApply = deps.ensureApply || ensureNotesApply;
      try {
        ensureApply({
          cwd: deps.cwd || process.cwd(),
          url: item.url,
          packRel: saved.packRel,
          now: deps.now,
          output,
        });
      } catch {
        // apply filing must never break the batch
      }
    }
  }
  const seconds = Math.max(0, Math.round((readNowMs(deps) - started) / 1000));
  output(`${label}  ${seconds}s  ${ok ? (brief || 'ok') : 'FAILED'}`);
  return { url: item.url, id: item.id, seconds, ok, brief, lesson };
}

function formatNotesSummary(rows = []) {
  const lines = ['url or id  seconds  result'];
  for (const row of rows) {
    const result = row.ok ? (row.brief || 'ok') : 'FAILED';
    lines.push(`${notesItemLabel(row)}  ${row.seconds}s  ${result}`);
  }
  return lines.join('\n');
}

function printEphemeralNotesLearnerGate(url, { json = false, workDir } = {}, output) {
  const dir = workDir || path.join(process.env.TMPDIR || '/tmp', 'ytnotes');
  const lesson = notesLessonFromText(readNotesText({ url, workDir: dir }));
  if (!isThinTeachLesson(lesson)) applyGate.hintEphemeralApply(output, 'notes');
  printLearnerCheckGate(output, lesson, { includeCheck: true, json });
}

function runYoutubeNotesBatch({ urls, engine, save, json } = {}, deps = {}) {
  deps = { ...deps, save: save === true || deps.save === true };
  const output = deps.output || ((line = '') => console.error(line));
  const items = expandNotesTargets(urls || [], deps);
  const rows = [];
  for (const item of items) {
    rows.push(runOneNotesItem(item, engine, deps));
  }
  if (rows.length) {
    output('');
    output(formatNotesSummary(rows));
  }
  if (!rows.length) return 2;
  const firstOk = rows.find((row) => row.ok);
  const asJson = json === true || deps.json === true;
  if (firstOk && !deps.save) {
    if (!asJson) printEphemeralNotesLearnerGate(firstOk.url, { workDir: deps.workDir }, output);
    printYoutubeTeachNext(firstOk.url, { json: asJson }, output);
  }
  if (firstOk && deps.save) {
    if (deps.ensureApply) return 0;
    const id = firstOk.id || videoIdFromUrl(firstOk.url);
    const workDir = deps.workDir || path.join(process.env.TMPDIR || '/tmp', 'ytnotes');
    const lesson = firstOk.lesson || notesLessonFromText(readNotesText({
      url: firstOk.url,
      workDir,
    }));
    const baseline = proveSavedLearnerBaseline({
      cwd: deps.cwd || process.cwd(),
      applyRel: id ? applySidecarRel(id) : null,
      lesson,
      output,
      json: asJson,
    });
    if (baseline !== 0) return baseline;
  }
  return firstOk ? 0 : 2;
}

function runSingleYoutubeNotes(url, engine, deps = {}) {
  let result;
  try {
    result = invokeNotesRunner(url, engine, deps);
  } catch {
    result = { status: 1 };
  }
  const status = readRunnerStatus(result);
  if (status !== 0 && !keptPrintedNotes({
    url,
    workDir: notesWorkDir(deps),
    result,
  })) {
    return status == null ? 1 : status;
  }
  const output = deps.output || ((line = '') => console.error(line));
  if (!deps.save) {
    const json = deps.json === true;
    printEphemeralNotesLearnerGate(url, { json, workDir: deps.workDir }, output);
    printYoutubeTeachNext(url, { json }, output);
    return 0;
  }
  const saved = saveRichNotes(url, deps);
  if (saved.thin) {
    output(TEACH_THIN_REFUSE);
    printYoutubeTeachNext(url, { json: deps.json }, output);
    return 2;
  }
  const ensureApply = deps.ensureApply || ensureNotesApply;
  const cwd = deps.cwd || process.cwd();
  const applyCode = ensureApply({
    cwd,
    url,
    packRel: saved.packRel,
    now: deps.now,
    output: deps.output,
  });
  if (deps.ensureApply) return applyCode;
  const id = videoIdFromUrl(url);
  const baseline = proveSavedLearnerBaseline({
    cwd,
    applyRel: id ? applySidecarRel(id) : null,
    lesson: saved.lesson,
    output,
    json: deps.json === true,
  });
  if (baseline !== 0) return baseline;
  return applyCode;
}

function runYoutubeNotes(args = [], deps = {}) {
  const output = deps.output || ((line = '') => console.error(line));
  const parsed = parseNotesArgs(args);
  if (parsed.help) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }
  if (parsed.unsave) {
    return runYoutubeUnsave(args, deps);
  }
  if (!parsed.urls.length) {
    output(YTNOTES_USAGE);
    output(YTNOTES_HINT);
    return 2;
  }
  const nextDeps = { ...deps, save: parsed.save, json: parsed.json };
  if (parsed.urls.length === 1 && !isPlaylistUrl(parsed.urls[0])) {
    return runSingleYoutubeNotes(parsed.urls[0], parsed.engine, nextDeps);
  }
  return runYoutubeNotesBatch(parsed, nextDeps);
}

const DEFAULT_SEARCH_LIMIT = 5;
const PAID_SEARCH_TIMEOUT_MS = 120000;
const PAID_SEARCH_COST_HINT = '5 credits per search';
const YTSEARCH_USAGE = 'usage: atris youtube search "<query>" [--limit N] [--json]';
const SEARCH_PRINT_FORMAT = '%(title)s | %(channel)s | %(duration_string)s | %(view_count)s | %(upload_date)s | https://youtu.be/%(id)s';
const LOCAL_SEARCH_RATE_LIMIT_BACKOFF_MS = 1000;
const LOCAL_SEARCH_RATE_LIMIT_MESSAGE =
  'youtube rate-limited local search. do not use --paid as a fallback; retry later.';
const LOCAL_SEARCH_RATE_LIMIT_RE = /429|too many requests|confirm you['\u2019]re not a bot/i;
const LOCAL_SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;
const LOCAL_SEARCH_CACHE_FILE = 'youtube-search-cache.json';
const LOCAL_SEARCH_CACHE_NOTE =
  'cached because youtube rate-limited local search.';
const PAID_SEARCH_FRESH_CACHE_REFUSE =
  'free cache still has results for this query. drop --paid or wait until the cache expires.';

function showYoutubeSearchHelp(output = console.log, commandName = 'atris youtube') {
  output('');
  output(`Usage: ${commandName} search "<query>" [--limit N] [--json]`);
  output(`       ${commandName} search --paid "<query>" [--limit N] [--json]`);
  output('');
  output('Free local discovery. Uses ytsearch on PATH when present, else the');
  output('bundled scripts/det/ytsearch, else yt-dlp ytsearchN with the same print contract.');
  output('Does not bill credits. A hit prints one next: atris youtube teach <first-url>.');
  output('A rich hit prints one failing check (score 0). A thin hit prints check: fill this.');
  output('');
  output(`--paid buys watch permalinks from Atris (${PAID_SEARCH_COST_HINT}).`);
  output('Requires login. Same auth path as atris youtube process.');
  output('A hit also prints one next: atris youtube teach <first-url>.');
  output('A rich hit prints one failing check (score 0). A thin hit prints check: fill this.');
  output('Empty or failed paid search refunds the credits.');
  output('');
  output('Options:');
  output(`  --limit <n>         Max results (default: ${DEFAULT_SEARCH_LIMIT})`);
  output('  --paid              Bill credits for watch permalinks + titles');
  output('  --json              Print JSON rows instead of pipe lines');
  output('  -h, --help          This help');
  output('');
  output('Each free line:');
  output('  title | channel | duration | views | upload_date | https://youtu.be/ID');
  output('');
  output('Each paid line:');
  output('  title | https://www.youtube.com/watch?v=ID');
  output('');
  output('Examples:');
  output(`  ${commandName} search "MCP agents 2026"`);
  output(`  ${commandName} search "MCP agents" --limit 10`);
  output(`  ${commandName} search "MCP agents" --json`);
  output(`  ${commandName} search --paid "MCP agents 2026"`);
  output(`  ${commandName} search --paid "MCP agents" --limit 10`);
  output('');
}

function parseSearchArgs(argv = []) {
  const args = [...argv];
  const options = {
    help: false,
    json: false,
    paid: false,
    query: null,
    limit: DEFAULT_SEARCH_LIMIT,
    timeoutMs: PAID_SEARCH_TIMEOUT_MS,
  };

  if (args.length === 0 || ['help', '--help', '-h'].includes(args[0])) {
    options.help = true;
    return options;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--paid') {
      options.paid = true;
    } else if (arg === '--limit') {
      options.limit = parsePositiveSearchInt(readValue(args, i, arg), '--limit');
      i++;
    } else if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveSearchInt(arg.slice('--limit='.length), '--limit');
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.query) {
      options.query = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.query) throw new Error('Missing query. Run "atris youtube search --help".');
  return options;
}

function parsePositiveSearchInt(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseSearchStdout(stdout = '') {
  const rows = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('|')) continue;
    const parts = trimmed.split(/\s*\|\s*/).map((part) => part.trim());
    if (parts.length < 5) continue;
    const url = parts[parts.length - 1];
    if (!/^https?:\/\/(?:www\.)?(?:youtube\.com\/|youtu\.be\/)/i.test(url)) continue;
    const row = {
      title: parts[0] || '',
      channel: parts[1] || '',
      duration: parts[2] || '',
      views: parts[3] || '',
      url,
    };
    if (parts.length >= 6) {
      const maybeDate = parts[parts.length - 2];
      if (/^\d{8}$/.test(maybeDate) || maybeDate === 'NA' || maybeDate === 'None') {
        row.upload_date = maybeDate === 'None' ? 'NA' : maybeDate;
      }
    }
    rows.push(row);
  }
  return rows;
}

function formatSearchResults(rows = []) {
  return rows.map((row) => {
    const parts = [row.title, row.channel, row.duration, row.views];
    if (row.upload_date) parts.push(row.upload_date);
    parts.push(row.url);
    return parts.join(' | ');
  }).join('\n');
}

function normalizeSearchQuery(query) {
  return String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function searchCacheNow(deps = {}) {
  if (typeof deps.now === 'function') return Number(deps.now());
  return Date.now();
}

function searchCacheTtlMs(deps = {}) {
  const ttl = Number(deps.searchCacheTtlMs);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : LOCAL_SEARCH_CACHE_TTL_MS;
}

function resolveSearchCachePath(deps = {}) {
  if (deps.searchCachePath) return deps.searchCachePath;
  const homeDir = deps.homeDir || os.homedir();
  return path.join(homeDir, '.atris', LOCAL_SEARCH_CACHE_FILE);
}

function printYoutubeTeachNext(url, options, output) {
  if (options && options.json) return;
  if (!url) return;
  output(`next: atris youtube teach ${quoteYoutubeUrl(url)}`);
}

function printSearchTeachNext(rows, options, output) {
  const firstUrl = Array.isArray(rows) && rows[0] && rows[0].url;
  printYoutubeTeachNext(firstUrl, options, output);
}

function printSearchRows(rows, options, output) {
  if (options.json) {
    output(JSON.stringify(rows, null, 2));
    return;
  }
  output(formatSearchResults(rows));
}

function writeLocalSearchCache(query, rows, deps = {}) {
  if (!Array.isArray(rows) || !rows.length) return;
  const fsMod = deps.fs || fs;
  const filePath = resolveSearchCachePath(deps);
  try {
    if (typeof fsMod.mkdirSync === 'function') {
      fsMod.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    const payload = {
      query: String(query || ''),
      savedAt: searchCacheNow(deps),
      rows,
    };
    fsMod.writeFileSync(filePath, `${JSON.stringify(payload)}\n`);
  } catch {
    // cache write is best-effort; a live search already succeeded
  }
}

function readFreshLocalSearchCache(query, deps = {}) {
  const fsMod = deps.fs || fs;
  const filePath = resolveSearchCachePath(deps);
  try {
    const parsed = JSON.parse(fsMod.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (normalizeSearchQuery(parsed.query) !== normalizeSearchQuery(query)) return null;
    const savedAt = Number(parsed.savedAt);
    if (!Number.isFinite(savedAt)) return null;
    if (searchCacheNow(deps) - savedAt >= searchCacheTtlMs(deps)) return null;
    if (!Array.isArray(parsed.rows) || !parsed.rows.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function paidSearchPayload(options) {
  const payload = { query: options.query };
  if (options.limit != null) payload.limit = options.limit;
  return payload;
}

function unwrapSearchPayload(data) {
  if (data?.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
    return data.data;
  }
  return data && typeof data === 'object' ? data : {};
}

function watchPermalink(item = {}) {
  const raw = item.url || item.permalink || item.watch_url || item.link || '';
  if (typeof raw === 'string' && /^https?:\/\//i.test(raw)) return raw;
  const id = item.video_id || item.videoId || (typeof item.id === 'string' ? item.id : '');
  if (id && /^[A-Za-z0-9_-]{6,}$/.test(id)) {
    return `https://www.youtube.com/watch?v=${id}`;
  }
  return '';
}

function paidSearchVideos(data) {
  const payload = unwrapSearchPayload(data);
  const raw = payload.results || payload.videos || payload.items
    || (Array.isArray(data?.data) ? data.data : null)
    || (Array.isArray(data) ? data : []);
  if (!Array.isArray(raw)) return [];
  const rows = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const url = watchPermalink(item);
    if (!url) continue;
    rows.push({
      title: String(item.title || item.name || '').trim(),
      url,
    });
  }
  return rows;
}

function paidSearchCredits(data) {
  if (!data || typeof data !== 'object') {
    return { used: undefined, remaining: undefined, refunded: undefined };
  }
  const payload = unwrapSearchPayload(data) || {};
  const used = data.credits_used !== undefined ? data.credits_used : payload.credits_used;
  const remaining = data.credits_remaining !== undefined
    ? data.credits_remaining
    : payload.credits_remaining;
  let refunded = data.credits_refunded !== undefined
    ? data.credits_refunded
    : payload.credits_refunded;
  if (refunded === undefined && (data.refunded === true || payload.refunded === true)) {
    refunded = true;
  }
  return { used, remaining, refunded };
}

function creditsWereRefunded(credits) {
  if (!credits) return false;
  if (credits.used === 0) return true;
  if (credits.refunded === true) return true;
  return typeof credits.refunded === 'number' && credits.refunded > 0;
}

function formatCreditsLines(credits) {
  const lines = [];
  if (credits.used !== undefined || credits.remaining !== undefined) {
    lines.push(`Credits: ${credits.used !== undefined ? credits.used : '?'} used, ${credits.remaining !== undefined ? credits.remaining : '?'} remaining`);
  }
  if (creditsWereRefunded(credits)) {
    lines.push('credits refunded');
  }
  return lines;
}

function formatPaidSearchResults(data) {
  const lines = paidSearchVideos(data).map((row) => (
    row.title ? `${row.title} | ${row.url}` : row.url
  ));
  const creditLines = formatCreditsLines(paidSearchCredits(data));
  if (creditLines.length) {
    if (lines.length) lines.push('');
    lines.push(...creditLines);
  }
  return lines.join('\n');
}

function youtubeSearchFailureError(result) {
  const hint = result.status === 401
    ? ' Run "atris login --force".'
    : result.status === 402
      ? ' Check Atris credits.'
      : result.status === 502
        ? ' YouTube search is unavailable; retry in a few seconds.'
        : '';
  const credits = paidSearchCredits(result.data);
  const refundHint = result.status === 502 && creditsWereRefunded(credits)
    ? ' credits refunded.'
    : '';
  const lines = [`YouTube search failed (${result.status}): ${resultErrorText(result)}.${hint}${refundHint}`];
  lines.push(...formatCreditsLines(credits));
  return new Error(lines.join('\n'));
}

async function requestPaidYoutubeSearch(options, deps = {}) {
  const apiFn = deps.apiRequestJson || apiRequestJson;
  const ensureBilled = deps.ensureBilledCommandAuth || ensureBilledCommandAuth;
  let auth = await ensureBilled('youtube', deps);
  if (!auth?.ok || !auth.token) {
    throw new Error(auth?.error || 'not signed in. run atris login first.');
  }

  const body = paidSearchPayload(options);
  const call = (token) => apiFn('/youtube/search', {
    method: 'POST',
    token,
    timeoutMs: options.timeoutMs || PAID_SEARCH_TIMEOUT_MS,
    retries: 0,
    body,
  });

  let result = await call(auth.token);
  if (!result.ok && result.status === 401 && !auth.minted) {
    const remint = await ensureBilled('youtube', { ...deps, forceMint: true });
    if (remint?.ok && remint.token) {
      auth = remint;
      result = await call(auth.token);
    }
  }

  if (!result.ok) {
    throw youtubeSearchFailureError(result);
  }
  return result.data;
}

async function runPaidYoutubeSearch(options, deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  if (readFreshLocalSearchCache(options.query, deps)) {
    output(PAID_SEARCH_FRESH_CACHE_REFUSE);
    return 2;
  }
  const data = await requestPaidYoutubeSearch(options, deps);
  if (options.json) {
    output(JSON.stringify(data, null, 2));
    return 0;
  }

  const videos = paidSearchVideos(data);
  const rendered = formatPaidSearchResults(data);
  if (!videos.length) {
    output(rendered ? `no videos found\n${rendered}` : 'no videos found');
    printWatchTickNext(output);
    return 2;
  }
  output(rendered);
  printSearchLearnerGate(videos, options, output);
  printSearchTeachNext(videos, options, output);
  return 0;
}

function searchLessonText(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => String(row && row.title ? row.title : '').trim())
    .filter(Boolean)
    .join('\n');
}

function printSearchLearnerGate(rows, options, output) {
  printLearnerCheckGate(output, notesLessonFromText(searchLessonText(rows)), {
    includeCheck: true,
    json: Boolean(options && options.json),
  });
}

function resultStdout(result) {
  if (typeof result === 'string') return result;
  return String((result && result.stdout) || '');
}

function searchRowsFromResult(result) {
  return parseSearchStdout(resultStdout(result));
}

function finishSuccessfulSearch(rows, options, output, deps) {
  writeLocalSearchCache(options.query, rows, deps);
  printSearchRows(rows, options, output);
  printSearchLearnerGate(rows, options, output);
  printSearchTeachNext(rows, options, output);
  return 0;
}

function commandOnPath(name, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const result = spawn('sh', ['-c', `command -v ${shellSingleQuote(name)}`], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return null;
  const found = String(result.stdout || '').trim();
  return found || null;
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function bundledYtsearchPath() {
  return path.join(__dirname, '..', 'scripts', 'det', 'ytsearch');
}

function defaultSearchRunner(query, limit, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const options = {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
  };

  const pathBin = deps.ytsearchBin || commandOnPath('ytsearch', deps);
  if (pathBin) {
    const result = spawn(pathBin, [query, String(limit)], options);
    if (!(result.error && result.error.code === 'ENOENT')) return result;
  }

  const bundled = deps.bundledYtsearch || bundledYtsearchPath();
  if (fs.existsSync(bundled)) {
    const result = spawn(bundled, [query, String(limit)], options);
    if (!(result.error && result.error.code === 'ENOENT')) return result;
  }

  return spawn('yt-dlp', [
    '--no-update',
    '--flat-playlist',
    '--no-warnings',
    '--print',
    SEARCH_PRINT_FORMAT,
    `ytsearch${limit}:${query}`,
  ], options);
}

function searchRunnerDetail(result) {
  return String(
    (result && result.stderr) || (result && result.error && result.error.message) || 'search failed',
  ).trim();
}

function isLocalSearchRateLimited(result) {
  return LOCAL_SEARCH_RATE_LIMIT_RE.test(searchRunnerDetail(result));
}

function searchRunnerStatus(result) {
  if (result && typeof result === 'object' && 'status' in result) return result.status;
  return typeof result === 'number' ? result : 0;
}

async function waitLocalSearchBackoff(deps = {}) {
  const ms = Number.isFinite(Number(deps.rateLimitBackoffMs))
    ? Number(deps.rateLimitBackoffMs)
    : LOCAL_SEARCH_RATE_LIMIT_BACKOFF_MS;
  if (!(ms > 0)) return;
  if (typeof deps.sleep === 'function') return deps.sleep(ms);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingSearchBinary(result) {
  return Boolean(result && typeof result === 'object' && result.error && result.error.code === 'ENOENT');
}

async function runYoutubeSearch(args = [], deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  let options;
  try {
    options = parseSearchArgs(args);
  } catch (err) {
    output(err.message);
    output(YTSEARCH_USAGE);
    return 2;
  }

  if (options.help) {
    showYoutubeSearchHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }

  if (options.paid) {
    try {
      return await runPaidYoutubeSearch(options, deps);
    } catch (err) {
      output(err.message);
      return 1;
    }
  }

  const runner = deps.runner || ((query, limit) => defaultSearchRunner(query, limit, deps));
  let result;
  try {
    result = await Promise.resolve(runner(options.query, options.limit, deps));
  } catch (err) {
    output(String(err.message || err));
    return 1;
  }

  if (isMissingSearchBinary(result)) {
    output('ytsearch and yt-dlp not found. Install yt-dlp or put ytsearch on PATH.');
    return 2;
  }

  let rows = searchRowsFromResult(result);
  if (rows.length) return finishSuccessfulSearch(rows, options, output, deps);

  let status = searchRunnerStatus(result);
  if (status != null && status !== 0 && isLocalSearchRateLimited(result)) {
    await waitLocalSearchBackoff(deps);
    try {
      result = await Promise.resolve(runner(options.query, options.limit, deps));
    } catch (err) {
      output(String(err.message || err));
      return 1;
    }
    if (isMissingSearchBinary(result)) {
      output('ytsearch and yt-dlp not found. Install yt-dlp or put ytsearch on PATH.');
      return 2;
    }
    rows = searchRowsFromResult(result);
    if (rows.length) return finishSuccessfulSearch(rows, options, output, deps);
    status = searchRunnerStatus(result);
    if (status != null && status !== 0 && isLocalSearchRateLimited(result)) {
      const cached = readFreshLocalSearchCache(options.query, deps);
      if (cached) {
        const cachedRows = cached.rows.slice(0, options.limit);
        printSearchRows(cachedRows, options, output);
        printSearchLearnerGate(cachedRows, options, output);
        printSearchTeachNext(cachedRows, options, output);
        output(LOCAL_SEARCH_CACHE_NOTE);
        return 0;
      }
      output(LOCAL_SEARCH_RATE_LIMIT_MESSAGE);
      return status == null ? 1 : status;
    }
  }

  if (status != null && status !== 0) {
    const detail = searchRunnerDetail(result);
    output(detail || 'search failed');
    return status == null ? 1 : status;
  }

  output('no videos found');
  if (!options.json) printWatchTickNext(output);
  return 2;
}

const YTTEACH_USAGE = 'usage: atris youtube teach <youtube-url> [--section N] [--save] [--recap TEXT] [--skip] | owed | next';
const TEACH_PAID_REFUSE = 'teach is free local captions. drop --paid.';
const TEACH_THIN_REFUSE = 'thin: no number or named mechanism. no brief.';
const TEACH_OWED_FILE = 'youtube-teach-owed.json';
const TEACH_RECAP_MISSING = '--recap needs the unpaid check';
const TEACH_RESUME_START = 'atris youtube teach <url>';
const TEACH_RESUME_NEXT = 'next: atris youtube teach recap TEXT or atris youtube teach skip';
const TEACH_WATCH_TICK_NEXT = WATCH_TICK_NEXT;
const TEACH_CONTINUE_NEXT = 'next: atris youtube teach next';
const TEACH_APPLY_NEXT_MESSAGE = APPLY_NEXT_MESSAGE;
const TEACH_KEEP_RULE = 'keep only if measure.py moves 0→1. scores 1 only when the fixture contains the check tokens.';
const MECHANISM_STOP = new Set([
  'the', 'this', 'that', 'and', 'but', 'for', 'with', 'from', 'you', 'we', 'they',
  'what', 'when', 'how', 'why', 'there', 'here', 'then', 'just', 'also', 'very',
  'really', 'about', 'into', 'over', 'after', 'before', 'because', 'while', 'where',
  'which', 'their', 'your', 'our', 'its', 'not', 'all', 'any', 'some', 'more', 'most',
  'other', 'first', 'second', 'next', 'last', 'new', 'old', 'good', 'bad', 'big',
  'small', 'long', 'short', 'video', 'chapter', 'section', 'youtube', 'transcript',
  'yeah', 'okay', 'ok', 'so', 'well', 'like', 'right', 'now', 'one', 'two',
  'who', 'every', 'holy', 'want', 'operating',
]);
const NUMBER_UNITS = 'percent|million|billion|thousand|people|hours?|minutes?|seconds?|years?|months?|weeks?|days?|cycles?';
const NUMBER_CLAIM_VERBS = 'install|ship|hire|raise|cut|save|cost|last|weigh|span|spend';
const MECHANISM_HEADS = 'window|model|principle|pattern|loop|cycle|method|rule|doctrine|framework|heuristic';
const TEACH_SWEAR_RE = /\b(fuck(?:ing)?|shit|damn|ass|bitch|crap)\b/i;
const GENERIC_MECHANISM_LEFT = new Set([
  ...MECHANISM_STOP,
  'a', 'an', 'in', 'of', 'to', 'my', 'i', 'im', "i'm",
]);

function parseTeachArgs(argv = []) {
  const args = [...argv];
  const options = {
    help: false,
    save: false,
    json: false,
    skip: false,
    owed: false,
    resume: false,
    next: false,
    recap: null,
    url: null,
    section: 1,
  };
  let sectionSet = false;

  if (args.length > 0 && ['help', '--help', '-h'].includes(args[0])) {
    options.help = true;
    return options;
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
    } else if (arg === '--save') {
      options.save = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--skip') {
      options.skip = true;
    } else if (arg === '--owed') {
      options.owed = true;
    } else if (arg === '--paid') {
      throw new Error(TEACH_PAID_REFUSE);
    } else if (arg === '--recap') {
      const raw = args[i + 1];
      if (raw == null || String(raw).startsWith('--')) {
        throw new Error(TEACH_RECAP_MISSING);
      }
      options.recap = String(raw);
      i += 1;
    } else if (arg.startsWith('--recap=')) {
      const value = arg.slice('--recap='.length);
      if (!value) throw new Error(TEACH_RECAP_MISSING);
      options.recap = value;
    } else if (arg === '--section') {
      const raw = args[i + 1];
      const value = Number.parseInt(raw, 10);
      if (raw == null || String(raw).startsWith('--') || !Number.isInteger(value) || value < 1) {
        throw new Error('--section must be a positive integer');
      }
      options.section = value;
      sectionSet = true;
      i += 1;
    } else if (arg.startsWith('--section=')) {
      const value = Number.parseInt(arg.slice('--section='.length), 10);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--section must be a positive integer');
      }
      options.section = value;
      sectionSet = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (arg === 'recap' && options.recap == null && !options.url) {
      const parts = [];
      i += 1;
      while (i < args.length && !String(args[i]).startsWith('--')) {
        parts.push(String(args[i]));
        i += 1;
      }
      i -= 1;
      options.recap = parts.join(' ').trim();
      if (!options.recap) throw new Error(TEACH_RECAP_MISSING);
    } else if (arg === 'skip' && !options.url) {
      options.skip = true;
    } else if (arg === 'owed' && !options.url) {
      options.owed = true;
    } else if (arg === 'next' && !options.url) {
      options.next = true;
    } else if (!options.url && looksLikeYoutubeUrl(arg)) {
      options.url = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.url && options.recap == null && !options.skip && !options.owed && !options.next) {
    if (!sectionSet && !options.save) {
      options.owed = true;
      options.resume = true;
      return options;
    }
    throw new Error('Missing YouTube URL. Run "atris youtube teach --help".');
  }
  return options;
}

function chapterStartSeconds(chapter) {
  if (!chapter) return NaN;
  if (chapter.startSeconds != null) return Number(chapter.startSeconds);
  return Number(chapter.start_time);
}

function chapterEndSeconds(chapter) {
  if (!chapter) return NaN;
  if (chapter.endSeconds != null) return Number(chapter.endSeconds);
  return Number(chapter.end_time);
}

function normalizeChapters(rawChapters, durationSeconds) {
  const duration = Number(durationSeconds) || 0;
  const list = Array.isArray(rawChapters) ? rawChapters.filter(Boolean) : [];
  if (!list.length) {
    return [{
      index: 1,
      title: 'full video',
      startSeconds: 0,
      endSeconds: duration || Infinity,
    }];
  }
  return list.map((chapter, index) => {
    const start = chapterStartSeconds(chapter);
    const startSeconds = Number.isFinite(start) ? start : 0;
    const nextStart = chapterStartSeconds(list[index + 1]);
    const explicitEnd = chapterEndSeconds(chapter);
    const endSeconds = Number.isFinite(explicitEnd)
      ? explicitEnd
      : (Number.isFinite(nextStart) ? nextStart : (duration || Infinity));
    const title = String(chapter.title || `section ${index + 1}`).trim() || `section ${index + 1}`;
    return { index: index + 1, title, startSeconds, endSeconds };
  });
}

function sliceCuesForChapter(cues = [], chapter) {
  if (!chapter) return [];
  const startMs = Number(chapter.startSeconds) * 1000;
  const endMs = Number(chapter.endSeconds) * 1000;
  return (cues || []).filter((cue) => {
    const at = Number(cue.startMs);
    if (!Number.isFinite(at)) return false;
    if (!Number.isFinite(startMs)) return true;
    if (at < startMs) return false;
    if (Number.isFinite(endMs) && at >= endMs) return false;
    return true;
  });
}

function teachCaptionWords(text) {
  return String(text || '')
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, ' ')
    .replace(/[“”]/g, '"')
    .split(/\s+/)
    .map((word) => word.replace(/^[^A-Za-z0-9$%]+|[^A-Za-z0-9%]+$/g, ''))
    .filter(Boolean);
}

function extractTeachNumbers(text) {
  // Keep a number only with its unit or a nearby claim. Bare 20/60 are crumbs.
  const words = teachCaptionWords(text);
  const found = [];
  const seen = new Set();
  const numberRe = /^(?:\$)?(\d[\d,]*(?:\.\d+)?)(%?)$/;
  const unitRe = new RegExp(`^(?:${NUMBER_UNITS})$`, 'i');
  const verbRe = new RegExp(`\\b(?:${NUMBER_CLAIM_VERBS})\\b`, 'i');

  for (let i = 0; i < words.length; i += 1) {
    const match = words[i].match(numberRe);
    if (!match) continue;
    const nearby = words.slice(i + 1, i + 3);
    const unit = nearby.find((word) => unitRe.test(word));
    const hasPercent = match[2] === '%' || /%/.test(words[i]);
    if (!unit && !hasPercent) continue;

    const windowText = words.slice(Math.max(0, i - 6), Math.min(words.length, i + 7)).join(' ');
    const verbMatch = windowText.match(verbRe);
    const number = match[1];
    let claim = hasPercent ? `${number}%` : `${number} ${String(unit).toLowerCase()}`;
    if (verbMatch) claim += ` to ${verbMatch[0].toLowerCase()}`;
    const key = claim.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(claim);
  }
  return found.slice(0, 8);
}

function extractTeachMechanisms(text) {
  // Named only: "Overton window", "omakase model". Drop quotes, swears, crumbs.
  const found = [];
  const seen = new Set();
  const add = (value) => {
    const token = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!token || TEACH_SWEAR_RE.test(token)) return;
    if (seen.has(token) || MECHANISM_STOP.has(token) || GENERIC_MECHANISM_LEFT.has(token)) return;
    if (token.length < 4 && !/\d/.test(token)) return;
    seen.add(token);
    found.push(token);
  };

  const raw = String(text || '');
  const namedRe = new RegExp(`\\b([A-Za-z][A-Za-z0-9+-]{2,})\\s+(${MECHANISM_HEADS})\\b`, 'gi');
  for (const match of raw.matchAll(namedRe)) {
    const left = String(match[1] || '').toLowerCase();
    if (GENERIC_MECHANISM_LEFT.has(left) || MECHANISM_STOP.has(left)) continue;
    add(`${match[1]} ${match[2]}`);
  }
  for (const match of raw.matchAll(/\b(\d+[A-Za-z][A-Za-z0-9]+)\b/g)) add(match[1]);
  return found.slice(0, 8);
}

const LEARNER_CHECK_FILL = 'fill this';
const LEARNER_SCORE_ZERO = 'score: 0';
const LEARNER_CHECK_INCOMPLETE = 'incomplete: no measurable check. check: fill this';
const LEARNER_BASELINE_INCOMPLETE = 'incomplete: check already passes. refuse invented success.';
const LEARNER_APPLY_MISSING = 'incomplete: apply missing. check cannot score.';

function oneTeachCheck(mechanisms, numbers) {
  if (mechanisms[0]) {
    const name = mechanisms[0];
    const named = new RegExp(`\\b(?:${MECHANISM_HEADS})\\b`, 'i').test(name);
    if (named && !/^(the|a|an)\s/i.test(name)) return `what is the ${name}?`;
    return `what is ${name}?`;
  }
  if (numbers[0]) return `what does ${numbers[0]} measure in this chapter?`;
  return LEARNER_CHECK_FILL;
}

function learnerCheckFromLesson(lesson = {}) {
  const mechanisms = Array.isArray(lesson.mechanisms) ? lesson.mechanisms : [];
  const numbers = Array.isArray(lesson.numbers) ? lesson.numbers : [];
  const inferred = mechanisms.length > 0 || numbers.length > 0;
  return {
    inferred,
    line: inferred ? oneTeachCheck(mechanisms, numbers) : LEARNER_CHECK_FILL,
    needles: teachCheckNeedles({ mechanisms, numbers }),
  };
}

function scoreLearnerNeedles(text, needles) {
  const list = Array.isArray(needles) ? needles : [];
  if (!list.length) return 0;
  const blob = String(text || '').toLowerCase();
  return list.every((needle) => blob.includes(String(needle || '').toLowerCase())) ? 1 : 0;
}

function printLearnerCheckGate(output, lesson, { includeCheck = false, json = false } = {}) {
  if (json || typeof output !== 'function') return;
  const check = learnerCheckFromLesson(lesson);
  if (includeCheck) output(`check: ${check.line}`);
  if (check.inferred) output(LEARNER_SCORE_ZERO);
}

function proveSavedLearnerBaseline({ cwd, applyRel, lesson, output, json } = {}) {
  const print = typeof output === 'function' ? output : () => {};
  const check = learnerCheckFromLesson(lesson);
  if (!check.inferred) {
    if (!json) print(LEARNER_CHECK_INCOMPLETE);
    return 2;
  }
  if (!cwd || !applyRel) {
    if (!json) print(LEARNER_APPLY_MISSING);
    return 2;
  }
  const abs = path.join(cwd, applyRel);
  let text = '';
  try {
    if (!fs.existsSync(abs)) {
      if (!json) print(LEARNER_APPLY_MISSING);
      return 2;
    }
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    if (!json) print(LEARNER_APPLY_MISSING);
    return 2;
  }
  if (scoreLearnerNeedles(text, check.needles) !== 0) {
    if (!json) print(LEARNER_BASELINE_INCOMPLETE);
    return 2;
  }
  if (!json) print(LEARNER_SCORE_ZERO);
  return 0;
}

function quoteYoutubeUrl(url) {
  return `"${String(url || '').replace(/"/g, '')}"`;
}

function teachLessonFromCues({ url, section, chapters, chapter, cues, title } = {}) {
  const total = Array.isArray(chapters) && chapters.length ? chapters.length : 1;
  const heading = String(chapter?.title || 'full video').trim().toLowerCase();
  const videoTitle = String(title || '').trim().toLowerCase();
  const body = (cues || []).map((cue) => cue.text).join(' ');
  const numbers = extractTeachNumbers(body);
  const mechanisms = extractTeachMechanisms(body);
  const lines = [
    `section ${section}/${total}  ${heading}`,
  ];
  if (videoTitle) lines.push(videoTitle);
  lines.push('');
  lines.push('numbers');
  if (numbers.length) lines.push(...numbers);
  else lines.push('none');
  lines.push('');
  lines.push('mechanisms');
  if (mechanisms.length) lines.push(...mechanisms);
  else lines.push('none');
  lines.push('');
  lines.push('check');
  lines.push(oneTeachCheck(mechanisms, numbers, heading));
  if (section < total) {
    lines.push('');
    lines.push(TEACH_RESUME_NEXT);
  }
  return { text: lines.join('\n'), numbers, mechanisms };
}

function formatTeachLesson(opts) {
  return teachLessonFromCues(opts).text;
}

function isThinTeachLesson(lesson = {}) {
  const numbers = Array.isArray(lesson.numbers) ? lesson.numbers : [];
  const mechanisms = Array.isArray(lesson.mechanisms) ? lesson.mechanisms : [];
  return numbers.length === 0 && mechanisms.length === 0;
}

function teachBriefRel(id, section) {
  return `atris/wiki/briefs/youtube-${id}-s${section}.md`;
}

function experimentIdToken(id) {
  return String(id || 'video')
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'video';
}

function teachExperimentSlug(id, section) {
  return `teach-${experimentIdToken(id)}-s${Number(section) || 1}`;
}

function teachExperimentRel(id, section) {
  return `atris/experiments/${teachExperimentSlug(id, section)}`;
}

function teachCheckNeedles(lesson = {}) {
  const mechanisms = Array.isArray(lesson.mechanisms) ? lesson.mechanisms : [];
  const numbers = Array.isArray(lesson.numbers) ? lesson.numbers : [];
  if (mechanisms[0]) return [String(mechanisms[0]).toLowerCase()];
  if (numbers[0]) return [String(numbers[0]).toLowerCase()];
  return [];
}

function teachRecapTokens(lesson = {}) {
  const tokens = [];
  const seen = new Set();
  for (const value of [...(lesson.mechanisms || []), ...(lesson.numbers || [])]) {
    const token = String(value || '').trim().toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function recapHitsTokens(text, tokens) {
  const hay = String(text || '').toLowerCase();
  return (tokens || []).some((token) => {
    const needle = String(token || '').trim().toLowerCase();
    return needle.length > 0 && hay.includes(needle);
  });
}

function teachOwedPath(deps = {}) {
  if (deps.teachOwedPath) return deps.teachOwedPath;
  const cwd = deps.cwd || process.cwd();
  return path.join(cwd, '.atris', TEACH_OWED_FILE);
}

function readTeachOwedStore(deps = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(teachOwedPath(deps), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeTeachOwedStore(deps, store) {
  try {
    const filePath = teachOwedPath(deps);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(store || {})}\n`);
  } catch {
    // owed recap is ephemeral; a failed write must not break teach
  }
}

function rememberTeachOwed(deps, { url, section, lesson, total } = {}) {
  const id = videoIdFromUrl(url);
  if (!id) return;
  const store = readTeachOwedStore(deps);
  const row = {
    section: Number(section) || 1,
    check: teachCheckLine(lesson),
    tokens: teachRecapTokens(lesson),
    url: url || undefined,
  };
  const totalChapters = Number(total);
  if (Number.isInteger(totalChapters) && totalChapters > 0) row.total = totalChapters;
  store[id] = row;
  writeTeachOwedStore(deps, store);
}

function writeTeachContinue(store, id, entry) {
  const nextSection = (Number(entry && entry.section) || 1) + 1;
  const total = Number(entry && entry.total);
  if (Number.isInteger(total) && total > 0 && nextSection > total) {
    delete store[id];
    return null;
  }
  const cursor = {
    section: nextSection,
    url: (entry && entry.url) || undefined,
  };
  if (Number.isInteger(total) && total > 0) cursor.total = total;
  store[id] = cursor;
  return cursor;
}

function lastTeachContinueEntry(store) {
  const ids = Object.keys(store || {});
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const entry = store[ids[i]];
    if (!entry || typeof entry !== 'object') continue;
    if (String(entry.check || '').trim()) continue;
    const url = String(entry.url || '').trim();
    if (!url) continue;
    return {
      id: ids[i],
      url,
      section: Number(entry.section) || 1,
    };
  }
  return null;
}

function lastTeachUnpaidEntry(store) {
  const ids = Object.keys(store || {});
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const entry = store[ids[i]];
    if (!entry || typeof entry !== 'object') continue;
    const check = String(entry.check || '').trim();
    if (!check) continue;
    return {
      id: ids[i],
      check,
      url: entry.url || null,
      section: Number(entry.section) || 1,
    };
  }
  return null;
}

function previousTeachUnlocked(owed, section) {
  if (!owed) return true;
  return Number(owed.section) >= Number(section);
}

function printTeachUnlockNext(parsed, entry, output) {
  if (!parsed || parsed.json) return;
  const url = parsed.url || (entry && entry.url) || '';
  if (!url) return;
  output(TEACH_CONTINUE_NEXT);
}

function printTeachWatchTickNext(parsed, lesson, total, output) {
  if (!parsed || parsed.json) return;
  if (parsed.save && !isThinTeachLesson(lesson)) return;
  const section = Number(parsed.section) || 0;
  if (section < Number(total)) return;
  printWatchTickNext(output);
}

function listTeachOwedEntries(store) {
  return Object.keys(store || {}).map((id) => {
    const entry = store[id] && typeof store[id] === 'object' ? store[id] : {};
    return {
      id,
      url: entry.url || null,
      section: Number(entry.section) || 1,
      check: String(entry.check || '').trim(),
    };
  }).filter((row) => row.check);
}

function printTeachOwed(parsed, deps, output) {
  const rows = listTeachOwedEntries(readTeachOwedStore(deps));
  if (parsed.json) {
    output(JSON.stringify(rows));
    return 0;
  }
  if (!rows.length) {
    output('nothing owed');
    if (parsed.resume) output(TEACH_RESUME_START);
    return 0;
  }
  rows.forEach((row, index) => {
    if (index) output('');
    output(row.url || row.id);
    output(`section ${row.section}`);
    if (row.check) output(row.check);
  });
  if (parsed.resume) output(TEACH_RESUME_NEXT);
  return 0;
}

function applyTeachRecap(parsed, deps, output) {
  const store = readTeachOwedStore(deps);
  let id = parsed.url ? videoIdFromUrl(parsed.url) : null;
  let entry = id ? store[id] : null;
  if (!entry && !id) {
    const ids = Object.keys(store);
    const unpaidIds = ids.filter((key) => store[key] && String(store[key].check || '').trim());
    if (parsed.recap) {
      id = unpaidIds.find((key) => recapHitsTokens(parsed.recap, store[key] && store[key].tokens));
    }
    if (!id && unpaidIds.length === 1) id = unpaidIds[0];
    if (!id && ids.length === 1) id = ids[0];
    entry = id ? store[id] : null;
  }
  if (!entry) {
    if (parsed.skip) return 0;
    if (!parsed.json) output('recap the previous section first');
    return 2;
  }
  if (!String(entry.check || '').trim()) {
    printTeachUnlockNext(parsed, entry, output);
    return 0;
  }
  if (parsed.skip) {
    printTeachUnlockNext(parsed, entry, output);
    writeTeachContinue(store, id, entry);
    writeTeachOwedStore(deps, store);
    return 0;
  }
  if (!recapHitsTokens(parsed.recap, entry.tokens)) {
    if (!parsed.json) output(entry.check);
    return 2;
  }
  printTeachUnlockNext(parsed, entry, output);
  writeTeachContinue(store, id, entry);
  writeTeachOwedStore(deps, store);
  return 0;
}

function applyTeachNext(parsed, deps, output) {
  const store = readTeachOwedStore(deps);
  const cont = lastTeachContinueEntry(store);
  if (cont) {
    parsed.url = cont.url;
    parsed.section = cont.section;
    return 0;
  }
  const unpaid = lastTeachUnpaidEntry(store);
  if (unpaid) {
    if (!parsed.json) output(unpaid.check);
    return 2;
  }
  if (parsed.json) {
    output('[]');
    return 0;
  }
  output('nothing owed');
  output(TEACH_RESUME_START);
  return 0;
}

function applyTeachResume(parsed, deps, output) {
  const store = readTeachOwedStore(deps);
  if (lastTeachUnpaidEntry(store)) return printTeachOwed(parsed, deps, output);
  return applyTeachNext(parsed, deps, output);
}

function teachCheckLine(lesson = {}) {
  return oneTeachCheck(lesson.mechanisms || [], lesson.numbers || [], '');
}

function fileTeachExperiment({ cwd, url, section, lesson, slug, applyRel } = {}) {
  try {
    const id = url ? videoIdFromUrl(url) : null;
    if (!cwd) return null;
    const packSlug = slug || (id ? teachExperimentSlug(id, section) : null);
    if (!packSlug) return null;
    const rel = `atris/experiments/${packSlug}`;
    const dir = path.join(cwd, rel);
    fs.mkdirSync(dir, { recursive: true });

    const check = teachCheckLine(lesson);
    const needles = teachCheckNeedles(lesson);
    const sidecarRel = applyRel || (id ? applySidecarRel(`${id}-s${section}`) : null);
    if (!sidecarRel) return null;
    const program = [
      '# Program',
      '',
      `Target: the taught fail-able check ${JSON.stringify(check)}. measure.py scores 1 only when the fixture contains ${needles.map((n) => JSON.stringify(n)).join(' and ') || 'the check tokens'}. The default fixture is the teach apply sidecar. Score is 0 if that file is missing or omits the token. Keep a candidate only when the score moves from 0 to 1.`,
      '',
    ].join('\n');

    const measurePy = [
      '"""Score whether the taught check is present in the product fixture."""',
      '',
      'from __future__ import annotations',
      '',
      'import json',
      'import os',
      'from pathlib import Path',
      '',
      '',
      'EXPERIMENT_DIR = Path(__file__).resolve().parent',
      `CHECK = ${JSON.stringify(check)}`,
      `NEEDLES = ${JSON.stringify(needles)}`,
      `DEFAULT_TARGET = ${JSON.stringify(sidecarRel)}`,
      '',
      '',
      'def repo_root() -> Path:',
      '    env = os.environ.get("ATRIS_REPO_ROOT")',
      '    if env:',
      '        return Path(env).resolve()',
      '    return EXPERIMENT_DIR.parents[2]',
      '',
      '',
      'def fixture_path():',
      '    env = os.environ.get("ATRIS_TEACH_MEASURE_FIXTURE")',
      '    if env:',
      '        return Path(env).resolve()',
      '    target = repo_root() / DEFAULT_TARGET',
      '    return target if target.is_file() else None',
      '',
      '',
      'def fail_payload(reason: str) -> dict:',
      '    return {',
      '        "score": 0,',
      '        "passed": 0,',
      '        "total": 1,',
      '        "status": "fail",',
      '        "reason": reason,',
      '        "check": CHECK,',
      '    }',
      '',
      '',
      'def score_text(text: str) -> dict:',
      '    blob = text.lower()',
      '    found = bool(NEEDLES) and all(needle.lower() in blob for needle in NEEDLES)',
      '    score = 1 if found else 0',
      '    return {',
      '        "score": score,',
      '        "passed": score,',
      '        "total": 1,',
      '        "status": "pass" if score == 1 else "fail",',
      '        "check": CHECK,',
      '    }',
      '',
      '',
      'def main() -> int:',
      '    path = fixture_path()',
      '    if path is None or not path.is_file():',
      '        payload = fail_payload("fixture missing")',
      '    else:',
      '        payload = score_text(path.read_text(encoding="utf-8"))',
      '    print(json.dumps(payload))',
      '    return 0',
      '',
      '',
      'if __name__ == "__main__":',
      '    raise SystemExit(main())',
      '',
    ].join('\n');

    const loopPy = [
      '"""Keep a candidate only when the taught-check score moves from 0 to 1."""',
      '',
      'from __future__ import annotations',
      '',
      'import argparse',
      'import csv',
      'import json',
      'import os',
      'from pathlib import Path',
      'import subprocess',
      'import sys',
      'from datetime import datetime, timezone',
      '',
      '',
      'EXPERIMENT_DIR = Path(__file__).resolve().parent',
      'DEFAULT_MEASURE = EXPERIMENT_DIR / "measure.py"',
      'DEFAULT_RESULTS = EXPERIMENT_DIR / "results.tsv"',
      '',
      '',
      'def run_measure(measure_path: Path) -> dict:',
      '    proc = subprocess.run(',
      '        [sys.executable, str(measure_path)],',
      '        cwd=str(EXPERIMENT_DIR),',
      '        capture_output=True,',
      '        text=True,',
      '        check=True,',
      '    )',
      '    return json.loads(proc.stdout.strip().splitlines()[-1])',
      '',
      '',
      'def append_result(results_path: Path, row: dict) -> None:',
      '    write_header = not results_path.exists() or results_path.stat().st_size == 0',
      '    with results_path.open("a", newline="", encoding="utf-8") as handle:',
      '        writer = csv.DictWriter(',
      '            handle,',
      '            fieldnames=[',
      '                "timestamp",',
      '                "trial",',
      '                "status",',
      '                "old_score",',
      '                "new_score",',
      '                "proposal",',
      '                "description",',
      '            ],',
      '            delimiter="\\t",',
      '        )',
      '        if write_header:',
      '            writer.writeheader()',
      '        writer.writerow(row)',
      '',
      '',
      'def main() -> int:',
      '    parser = argparse.ArgumentParser(description="Run the taught-check keep/revert loop.")',
      '    parser.add_argument("--proposal", action="append", default=[])',
      '    args = parser.parse_args()',
      '',
      '    measure_path = DEFAULT_MEASURE.resolve()',
      '    results_path = DEFAULT_RESULTS.resolve()',
      '',
      '    baseline = run_measure(measure_path)',
      '    current_score = float(baseline["score"])',
      '    print(f"BASELINE {current_score:.4f}")',
      '',
      '    if not args.proposal:',
      '        append_result(',
      '            results_path,',
      '            {',
      '                "timestamp": datetime.now(timezone.utc).isoformat(),',
      '                "trial": 0,',
      '                "status": "baseline",',
      '                "old_score": f"{current_score:.4f}",',
      '                "new_score": f"{current_score:.4f}",',
      '                "proposal": "measure.py",',
      '                "description": "current taught-check fixture score",',
      '            },',
      '        )',
      '',
      '    for trial_index, proposal in enumerate(args.proposal, start=1):',
      '        proposal_path = Path(proposal).resolve()',
      '        status = "error"',
      '        old_score = current_score',
      '        new_score = current_score',
      '        description = ""',
      '',
      '        try:',
      '            proc = subprocess.run(',
      '                [sys.executable, str(proposal_path)],',
      '                cwd=str(EXPERIMENT_DIR),',
      '                capture_output=True,',
      '                text=True,',
      '                check=True,',
      '                env={**os.environ, "EXPERIMENT_DIR": str(EXPERIMENT_DIR)},',
      '            )',
      '            if proc.stdout.strip():',
      '                description = proc.stdout.strip().splitlines()[-1][:200]',
      '',
      '            measured = run_measure(measure_path)',
      '            new_score = float(measured["score"])',
      '            if old_score < 1 and new_score > old_score:',
      '                status = "kept"',
      '                current_score = new_score',
      '            else:',
      '                status = "reverted"',
      '        except subprocess.CalledProcessError as exc:',
      '            stderr = (exc.stderr or exc.stdout or "").strip()',
      '            description = (stderr.splitlines()[-1] if stderr else "proposal failed")[:200]',
      '            status = "error"',
      '',
      '        append_result(',
      '            results_path,',
      '            {',
      '                "timestamp": datetime.now(timezone.utc).isoformat(),',
      '                "trial": trial_index,',
      '                "status": status,',
      '                "old_score": f"{old_score:.4f}",',
      '                "new_score": f"{new_score:.4f}",',
      '                "proposal": proposal_path.name,',
      '                "description": description,',
      '            },',
      '        )',
      '        print(f"TRIAL {trial_index} {status.upper()} score={new_score:.4f} proposal={proposal_path.name}")',
      '',
      '    final_measure = run_measure(measure_path)',
      '    print(f"FINAL {final_measure[\'score\']:.4f}")',
      '    return 0',
      '',
      '',
      'if __name__ == "__main__":',
      '    raise SystemExit(main())',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(dir, 'program.md'), program);
    fs.writeFileSync(path.join(dir, 'measure.py'), measurePy);
    fs.writeFileSync(path.join(dir, 'loop.py'), loopPy);
    fs.writeFileSync(
      path.join(dir, 'reset.py'),
      [
        '"""The target is the product fixture, not a local candidate file."""',
        '',
        'print("teach experiment target is the apply sidecar or ATRIS_TEACH_MEASURE_FIXTURE; nothing local to restore")',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'results.tsv'),
      'timestamp\ttrial\tstatus\told_score\tnew_score\tproposal\tdescription\n',
    );
    return rel;
  } catch {
    return null;
  }
}

function fileTeachBrief({ cwd, url, section, lesson, now } = {}) {
  try {
    const id = videoIdFromUrl(url);
    if (!id || !cwd) return null;
    const wikiDir = path.join(cwd, 'atris', 'wiki');
    if (!fs.existsSync(wikiDir)) return null;
    const rel = teachBriefRel(id, section);
    const briefsDir = path.join(cwd, 'atris', 'wiki', 'briefs');
    fs.mkdirSync(briefsDir, { recursive: true });
    const date = dateStamp(now);
    const header = [
      String(lesson || '').split('\n')[0] || `teach section ${section}`,
      '',
      `date: ${date}`,
      `source: ${url}`,
      `section: ${section}`,
      'rail: atris youtube teach, one chapter from local captions',
    ].join('\n');
    fs.writeFileSync(path.join(cwd, rel), `${header}\n\n${lesson}\n`);

    const journalPath = path.join(cwd, 'atris', 'logs', date.slice(0, 4), `${date}.md`);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    let existing = '';
    if (fs.existsSync(journalPath)) existing = fs.readFileSync(journalPath, 'utf8');
    const line = `- [claimable] taught: section ${section} -> ${rel}`;
    if (!existing.includes(line)) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(journalPath, `${existing}${prefix}${line}\n`);
    }
    return rel;
  } catch {
    return null;
  }
}

function ensureTeachApply({ cwd, url, section, packRel, now, output } = {}) {
  const id = videoIdFromUrl(url);
  const pack = packRel || (id ? teachExperimentRel(id, section) : null);
  const slug = pack ? path.basename(pack) : null;
  return applyGate.ensureApply({
    cwd,
    source: url,
    rel: id ? applySidecarRel(`${id}-s${section}`) : null,
    now,
    output,
    incompleteMessage: slug
      ? `next: atris experiments keep ${slug}`
      : TEACH_APPLY_NEXT_MESSAGE,
    required: false,
    change: pack ? `apply ${pack}` : undefined,
    receipt: pack ? TEACH_KEEP_RULE : undefined,
    journalLine: pack ? `- [claimable] apply: ${pack}. ${TEACH_KEEP_RULE}` : undefined,
  });
}

async function extractTeachSource(youtubeUrl, deps = {}) {
  if (typeof deps.extractTeachSource === 'function') {
    return deps.extractTeachSource(youtubeUrl, deps);
  }
  const runner = deps.spawnSync || spawnSync;
  const result = runner('yt-dlp', ['-J', '--skip-download', '--no-warnings', youtubeUrl], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const info = parseYtDlpInfoJson(result);
  if (!info) return null;

  const selected = chooseCaptionTrack(info);
  if (!selected?.track?.url) return null;
  const rawCaption = await (deps.fetchCaptionText || fetchCaptionText)(selected.track.url);
  const cues = parseCaptionCues(rawCaption);
  if (!cues.length) return null;

  return {
    id: info.id || videoIdFromUrl(youtubeUrl),
    title: info.title || '',
    url: youtubeUrl,
    durationSeconds: Number(info.duration || 0) || undefined,
    language: selected.language || 'unknown',
    chapters: normalizeChapters(info.chapters, info.duration),
    cues,
  };
}

async function runYoutubeTeach(args = [], deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  let parsed;
  try {
    parsed = parseTeachArgs(args);
  } catch (err) {
    output(err.message || YTTEACH_USAGE);
    return 2;
  }
  if (parsed.help) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }

  const owedDeps = { ...deps, cwd: deps.cwd || process.cwd() };
  if (parsed.owed) {
    if (!parsed.resume) return printTeachOwed(parsed, owedDeps, output);
    const resumeCode = applyTeachResume(parsed, owedDeps, output);
    if (resumeCode !== 0) return resumeCode;
    if (!parsed.url) return 0;
  }
  if (parsed.recap != null || parsed.skip) {
    const recapCode = applyTeachRecap(parsed, owedDeps, output);
    if (recapCode !== 0) return recapCode;
    if (!parsed.url || parsed.section <= 1) return 0;
  }
  if (parsed.next) {
    const nextCode = applyTeachNext(parsed, owedDeps, output);
    if (nextCode !== 0) return nextCode;
    if (!parsed.url) return 0;
  }

  if (!parsed.url) {
    output('Missing YouTube URL. Run "atris youtube teach --help".');
    return 2;
  }

  if (parsed.section > 1) {
    const owed = readTeachOwedStore(owedDeps)[videoIdFromUrl(parsed.url) || ''];
    if (!previousTeachUnlocked(owed, parsed.section)) {
      if (!parsed.json && owed && owed.check) output(owed.check);
      return 2;
    }
  }

  const source = await (deps.extractTeachSource || extractTeachSource)(parsed.url, deps);
  if (!source || !Array.isArray(source.cues) || !source.cues.length) {
    output('no english captions for this url. teach stays local and will not call process.');
    return 2;
  }

  const chapters = normalizeChapters(source.chapters, source.durationSeconds);
  if (parsed.section > chapters.length) {
    output(`section ${parsed.section} is past ${chapters.length} chapters. try --section ${chapters.length}`);
    return 2;
  }

  const chapter = chapters[parsed.section - 1];
  const cues = sliceCuesForChapter(source.cues, chapter);
  const lesson = teachLessonFromCues({
    url: parsed.url,
    section: parsed.section,
    chapters,
    chapter,
    cues,
    title: source.title,
  });
  output(lesson.text);
  rememberTeachOwed(owedDeps, {
    url: parsed.url,
    section: parsed.section,
    lesson,
    total: chapters.length,
  });

  if (!parsed.save) {
    if (!isThinTeachLesson(lesson)) applyGate.hintEphemeralApply(output, 'teach');
    printLearnerCheckGate(output, lesson, { includeCheck: true, json: parsed.json === true });
    printTeachWatchTickNext(parsed, lesson, chapters.length, output);
    return 0;
  }
  if (isThinTeachLesson(lesson)) {
    output(TEACH_THIN_REFUSE);
    printTeachWatchTickNext(parsed, lesson, chapters.length, output);
    return 2;
  }

  const cwd = deps.cwd || process.cwd();
  fileTeachBrief({
    cwd,
    url: parsed.url,
    section: parsed.section,
    lesson: lesson.text,
    now: deps.now,
  });
  const packRel = fileTeachExperiment({
    cwd,
    url: parsed.url,
    section: parsed.section,
    lesson,
  });
  const ensureApply = deps.ensureApply || ensureTeachApply;
  const applyCode = ensureApply({
    cwd,
    url: parsed.url,
    section: parsed.section,
    packRel,
    now: deps.now,
    output,
  });
  if (deps.ensureApply) return applyCode;
  const id = videoIdFromUrl(parsed.url);
  const baseline = proveSavedLearnerBaseline({
    cwd,
    applyRel: id ? applySidecarRel(`${id}-s${parsed.section}`) : null,
    lesson,
    output,
    json: parsed.json === true,
  });
  if (baseline !== 0) return baseline;
  return applyCode;
}

async function youtubeCommand(argv = process.argv.slice(3), deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  if (argv[0] === 'search') {
    const code = await runYoutubeSearch(argv.slice(1), { ...deps, output });
    if (!deps.output && !deps.spawnSync && !deps.runner && !deps.apiRequestJson && !deps.ensureValidCredentials && !deps.ensureBilledCommandAuth) {
      process.exit(code);
    }
    return code;
  }
  if (argv[0] === 'unsave') {
    const code = runYoutubeUnsave(argv.slice(1), deps);
    if (!deps.output && !deps.spawnSync && !deps.runner && !deps.expander) process.exit(code);
    return code;
  }
  if (argv[0] === 'notes') {
    const code = runYoutubeNotes(argv.slice(1), deps);
    if (!deps.output && !deps.spawnSync && !deps.runner && !deps.expander) process.exit(code);
    return code;
  }
  if (argv[0] === 'teach') {
    const code = await runYoutubeTeach(argv.slice(1), { ...deps, output });
    if (!deps.output && !deps.extractTeachSource && !deps.spawnSync && !deps.runner) process.exit(code);
    return code;
  }
  if (argv[0] === 'digest') {
    const code = runYoutubeDigest(argv.slice(1), { ...deps, output });
    if (!deps.output && !deps.runner) process.exit(code);
    return code;
  }
  if (argv[0] === 'watch') {
    const code = await watchCommand(argv.slice(1), { ...deps, output });
    if (!deps.output && !deps.fetcher && !deps.runner && !deps.briefFiler) process.exit(code);
    return code;
  }
  const options = parseYoutubeArgs(argv);
  if (options.help) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }
  let status = 0;
  try {
    const data = await processYoutube(options, deps);
    if (options.json) {
      output(JSON.stringify(data, null, 2));
    } else {
      output(formatYoutubeResult(data));
      printProcessLearnerGate(data, {}, output);
    }
  } catch (err) {
    if (!err.applyRequired) output(err.message);
    status = Number.isInteger(err.exitCode) ? err.exitCode : 1;
  }
  if (!deps.output && !deps.apiRequestJson && !deps.ensureValidCredentials && !deps.ensureBilledCommandAuth && !deps.extractLocalTranscript) {
    process.exit(status);
  }
  return status;
}

module.exports = {
  DEFAULT_QUERY,
  DEFAULT_TIMEOUT_MS,
  parseYoutubeArgs,
  buildYoutubePayload,
  extractLocalTranscript,
  parseYtDlpInfoJson,
  processYoutube,
  shouldRetryWithLocalTranscript,
  formatYoutubeResult,
  fileBriefFromNotes,
  keptPrintedNotes,
  ensureNotesApply,
  unsaveYoutubeNotes,
  APPLY_NEXT_MESSAGE,
  PROCESS_APPLY_MESSAGE,
  isPlaylistUrl,
  parseNotesArgs,
  expandNotesTargets,
  runYoutubeNotesBatch,
  parseDigestArgs,
  collectVideoBriefs,
  buildDigestPrompt,
  normalizeWatchChannel,
  channelVideosUrl,
  parseFlatPlaylist,
  loadWatchState,
  watchCommand,
  parseSearchArgs,
  parseSearchStdout,
  formatSearchResults,
  parseTeachArgs,
  parseCaptionCues,
  normalizeChapters,
  sliceCuesForChapter,
  formatTeachLesson,
  extractTeachNumbers,
  extractTeachMechanisms,
  extractTeachSource,
  oneTeachCheck,
  learnerCheckFromLesson,
  scoreLearnerNeedles,
  LEARNER_CHECK_FILL,
  LEARNER_SCORE_ZERO,
  printLearnerCheckGate,
  proveSavedLearnerBaseline,
  isThinTeachLesson,
  TEACH_THIN_REFUSE,
  TEACH_RESUME_NEXT,
  TEACH_WATCH_TICK_NEXT,
  teachExperimentSlug,
  notesExperimentSlug,
  digestExperimentSlug,
  watchExperimentSlug,
  firstRichWatchLesson,
  fileTeachExperiment,
  youtubeCommand,
};
