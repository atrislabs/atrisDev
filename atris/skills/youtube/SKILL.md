---
name: youtube
description: "YouTube discovery and learning. Get watch permalinks with atris youtube search QUERY (free, local ytsearch/yt-dlp). On 429 use printed rows if any; else the CLI retries once, then cached rows if printed, else STOP. Never run --paid after a 429. --paid only when the user explicitly asked to buy permalinks (5 credits). After a URL is picked, atris youtube notes URL (free, ephemeral unless --save). atris youtube process only to store knowledge (5 credits). Never paste tokens. Never /auth/cli. Mint with atris login --agent from a stored login. Never summarize a video from model memory. Triggers on: youtube search, find videos, paid youtube search, any youtube.com or youtu.be link, youtube, video, watch this, notes on this."
version: 2.18.17
tags:
  - youtube
  - research
  - video
  - learning
---

# YouTube Skill

## Feature map

Hard path. Follow in order. Soft memory does not override this.

```
search QUERY (free)
    |
   rows --> rich: one pack-named apply + failing measure.py (score 0), then next: experiments keep
        --> thin: check: fill this, then next: atris youtube teach <first-url>
        --> --json stays quiet
    |
   429 --> printed rows? use them (no retry)
        --> else CLI retries once
        --> cached rows printed? use them (same rich mint or thin check as live rows)
        --> rate-limit sentence printed? STOP
             do not run --paid
    |
   pick a URL --> notes URL (free, ephemeral unless --save)
    |                 rich ephemeral prints one apply next-step and one failing check (score 0), no files
    |                 thin ephemeral prints check: fill this instead of inventing a check
    |                 then next: atris youtube teach <same-url>
    |                 --json stays quiet
    |                 --save files brief + pack-named apply when notes have a number or named mechanism; a multi-url --save batch proves the first saved pack the same way single-url --save does; thin --save refuses
    |                 playlist expand keeps printed yt-dlp rows on 429
    |                 notes keep a written yt_<id>.md (and ytnotes keeps a written manual or auto en / en-orig / en-US / en-GB VTT) when yt-dlp exits 429 or --print is empty
    |                 watch, youtu.be, shorts, embed, live, /e/, and youtube-nocookie embed urls all resolve the same video id for that keep
    |                 a copied #t= timestamp still finds yt_<id>.en.vtt
    |                 a watch?v=&list= copy still finds yt_<video>.en.vtt when -J dumps playlist JSON
    |            or teach URL [--section N] (one chapter: claim numbers, named mechanisms, one check; free unless --save)
    |                 printed yt-dlp metadata is a hit even on 429
    |                 a written VTT or clean.txt is used when the caption URL fetch fails, `-J` stdout is empty, or `-J` dumps a playlist for a watch?v=&list= URL
    |                 a taught section that is not last prints next: recap TEXT or skip
    |                 last section: rich ephemeral apply, failing check, and score 0, then next: atris youtube watch tick; save pack keep stays; no recap next
    |                 next --section refuses until recap/skip
    |                 owed prints unpaid check; successful unlock prints next section command
    |                 bare teach resumes owed, or prints a start command if nothing is owed
    |
   persist a rich lesson? --> learn log '{"type":"pattern","key":"...","insight":"..."}'
                           --> rich: one pack-named apply + failing measure.py (score 0), then next: experiments keep
                           --> thin: jsonl only

   write one Apply (claimable) before process
    |
   store knowledge? --> process URL (5 credits)
                    --> rich: one pack-named apply + failing measure.py (score 0), then next: experiments keep
                    --> thin: check: fill this; --json stays quiet

watch add --> next: atris youtube watch tick
watch tick --> briefs new videos
           --> if briefed: first rich brief mints pack-named apply + failing measure.py (score 0), then next: experiments keep
           -->            all thin: check: fill this, then next: atris youtube teach <first-briefed-url>
           --> 0 briefed, no channels: next: atris youtube watch add <channel-url-or-@handle>
           --> 0 briefed, channels exist: next: atris youtube search " "

digest --> files brief + claimable journal
       --> rich: one pack-named apply + failing measure.py (score 0), then next: experiments keep
       --> thin: check: fill this, then next: atris youtube watch tick

--paid QUERY only if the user asked to buy permalinks
    |
   rows --> rich: one pack-named apply + failing measure.py (score 0), then next: experiments keep
        --> thin: check: fill this, then next: atris youtube teach <first-url>
        --> --json stays quiet and writes no pack
login: atris login --agent from a stored login
never paste tokens, never /auth/cli
```

1. Get watch permalinks: `atris youtube search QUERY` (free). A rich hit mints `atris/experiments/search-<query>/`, writes one pack-named Apply, and prints `score: 0` only when that Apply starts failing. A thin hit prints `check: fill this`, then one next teach command. `--json` stays quiet and writes no pack.
2. If 429: use any rows already printed. If none, wait/retry is already in the CLI. If it prints cached rows, use those. Cached rows mint or print the same rich or thin gate as a live hit. If it prints `youtube rate-limited local search. do not use --paid as a fallback; retry later.`, STOP. Do not run `--paid`.
3. `--paid` only when the user explicitly asked to buy permalinks. The CLI hard-refuses `--paid` when the free cache still has a fresh same-query hit.
4. `atris youtube notes URL` after a URL is picked (free). Notes is ephemeral unless `--save`. Rich ephemeral prints one apply next-step and one failing check (`score: 0`), then one `next: atris youtube teach <same-url>`, and writes no files. Thin ephemeral prints `check: fill this` instead of inventing a check. A playlist or multi-url batch does the same for the first successful item only. A playlist expand that prints video rows keeps them even when yt-dlp exits 429. A notes run that already wrote `yt_<id>.md` keeps that lesson even when the runner exits 429, so the learner gate and rich `--save` mint still run. Watch, youtu.be, shorts, embed, live, /e/, and youtube-nocookie embed urls all resolve the same video id, so empty-JSON teach/process and notes 429 keep still find that file. A copied watch?v=&list= URL still finds yt_<video>.en.vtt when -J dumps playlist JSON. A copied #t= timestamp still finds the same yt_<id> file. The bundled ytnotes script does the same for a written manual or auto en, en-orig, en-US, or en-GB VTT plus printed metadata. `--json` stays quiet on the check and the teach next-step. Rich `--save` files the brief, mints `atris/experiments/notes-<id>/`, writes one Apply, and prints `score: 0` only when that Apply starts failing. A rich multi-url `--save` batch proves that failing baseline for the first saved pack only; thin `--save` (no number-with-units and no named mechanism) refuses with no brief and exit 2. Do not auto `--paid`.
5. Write one Apply (change + receipt) before `atris youtube process`. Process still requires a filled Apply (so you `--save` a rich brief, fill Apply, then process). A rich analysis then mints `atris/experiments/process-<id>/`, writes one pack-named Apply, and prints `score: 0` only when that Apply starts failing. Thin analysis prints `check: fill this`. `--json` stays quiet. 401, 402, or 502 print Credits when present and say credits refunded only when the server marks a refund. A local-transcript 502 that then retries cloud prints those same credit lines from the first payload before the retry.
6. Never paste tokens. Never `/auth/cli`. Mint with `atris login --agent` from a stored login.

If the user says "find videos", "search youtube", or "get youtube links" → search. If they say "learn from", "notes on", "alpha", or "rabbit hole" → notes. If they say "process", "store", "add to knowledge" → process. "Buy permalinks" or "paid search" is the only ask that unlocks `--paid`.

Never summarize a video from model memory; that is fabrication.

## Bootstrap

Search and notes need no login. Paid search and process need a stored login, then `atris login --agent`. Never print credentials. Never `/auth/cli`.

```bash
#!/bin/bash
set -e

if ! command -v atris &> /dev/null; then
  echo "Installing atris CLI..."
  npm install -g atris
fi

echo "Ready. Feature map: free search, 429 printed-rows or cache-or-stop, notes, then process."
```

---

## Search videos (free)

```bash
atris youtube search "MCP agents 2026"
atris youtube search "MCP agents" --limit 10
atris youtube search "MCP agents" --json
```

Uses `ytsearch` on PATH when present, else bundled `scripts/det/ytsearch`, else `yt-dlp --flat-playlist --print` with `ytsearchN:`. No credits. No `/agent/process_youtube` call. A rich hit prints one inferred check plus `score: 0`. A thin hit prints `check: fill this`. Then one next: `atris youtube teach <first-url>`. `--json` stays quiet.

On 429, printed rows are a hit (no retry). If stdout is empty the CLI retries once, then serves `~/.atris/youtube-search-cache.json` if the same query is younger than one hour. A cache reprint prints the same rich or thin check as a live hit. If it prints the rate-limit sentence, stop. Do not run `--paid`.

## Paid search (5 credits, opt-in buy only)

Only when the user explicitly asked to buy permalinks. A 429 or a missing cache is not that ask.

```bash
atris youtube search --paid "MCP agents 2026"
atris youtube search --paid "MCP agents" --limit 10
```

Requires a stored login, then `atris login --agent`. The CLI mints a youtube-scope agent token from disk the same way as `atris youtube process` and `atris x-search`. Never `/auth/cli`. Never paste tokens. Prints `title | watch permalink` plus credits. A rich hit mints `atris/experiments/search-<query>/`, writes one pack-named Apply, and prints `score: 0` only when that Apply starts failing. A thin hit prints `check: fill this`, then one next teach command. `--json` stays quiet and writes no pack. Empty, 502, 401, or 402 with unused credits do not claim a refund unless credits_refunded is explicit.

Line contract:

```text
title | https://www.youtube.com/watch?v=ID
Credits: N used, M remaining
next: atris experiments keep search-<query>
score: 0
```

A thin paid hit prints `check: fill this` and `next: atris youtube teach "<first-url>"` instead of the keep next. `--json` stays machine-quiet. After the user picks a URL, run notes (free) or process (5 credits).

---

## API Reference

Base: `https://api.atris.ai/api`
Auth: `-H "Authorization: Bearer $TOKEN"`

Do not extract or paste tokens. The CLI reads the stored login. Agents mint with `atris login --agent`.

### Process a Video
```bash
atris youtube process "https://www.youtube.com/watch?v=VIDEO_ID" \
  --query "Create an outline, claims, examples, takeaways, and action items."
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `youtube_url` | string | yes | Any YouTube URL |
| `query` | string | no | Question to focus the analysis on |
| `agent_id` | string | no | Agent ID to store analysis in its knowledge base |
| `store_as_knowledge` | bool | no | Save to agent's knowledge (requires `agent_id`) |

**Response:**
```json
{
  "status": "success",
  "message": "YouTube video processed successfully",
  "youtube_url": "https://www.youtube.com/watch?v=...",
  "video_analysis": "This video covers...",
  "stored_as_knowledge": false,
  "credits_used": 5,
  "credits_remaining": 95,
  "metadata": {
    "title": "Video Title",
    "channel": "Channel Name",
    "duration_seconds": 4459,
    "processing_method": "client_transcript_atris_fast",
    "transcript_source": "client_transcript",
    "transcript_language": "en"
  }
}
```

### Process + Store as Knowledge
```bash
atris youtube process "https://www.youtube.com/watch?v=..." \
  --query "Extract the main arguments and evidence" \
  --agent "YOUR_AGENT_ID" \
  --store
```

---

## Workflows

### "Find YouTube videos about X"
1. Search: `atris youtube search "X" --limit 10`
2. Show title, channel, duration, views, upload_date, and the youtu.be link
3. Stop. Let the user pick. Do not auto-process.

### "Learn from this YouTube video"
1. Run bootstrap
2. Notes first: `atris youtube notes <url>`
3. Display the analysis as flowing prose: ideas and who said them, never timecodes. Timestamps stay in the stored notes file for verification, not in the reply.

### "What does this video say about X?"
1. Run bootstrap
2. Notes or process with focused query: `atris youtube process <url> --query "What does this say about X?"`
3. Show the focused analysis as prose; cite the speaker, not the clock

### "Process multiple videos on a topic"
1. Search to discover links (free), or use URLs the user already has
2. Process each sequentially (each = 5 credits):
```bash
VIDEOS=(
  "https://youtube.com/watch?v=AAA"
  "https://youtube.com/watch?v=BBB"
)

for url in "${VIDEOS[@]}"; do
  echo "Processing: $url"
  atris youtube process "$url" --query "Key insights and takeaways"
  echo ""
done
```
3. Synthesize findings across all videos; attribute ideas to speakers and videos, keep timecodes out of the reply

### "Save video insights to my agent's memory"
1. Run bootstrap
2. Get your agent ID: `atris agent`
3. Process with storage: `atris youtube process <url> --agent "..." --store`
4. Agent can now reference these insights in future conversations

---

## Output Contract

Default output should be useful for retrieval and action:

```text
metadata
outline (flowing, idea-first)
core claims with confidence
memorable examples
actionable takeaways
Atris/product implications
next actions
```

Two layers, never mixed. The reply the person reads is flowing prose: ideas, speakers, quotes, no timecodes, nothing that reads like a stopwatch. The stored notes file keeps timestamps beside each claim so verification stays possible; that receipt layer never leaks into the reply. Treat native-video/cloud fallback output as less auditable unless the stored file includes equivalent time anchors.

## How It Works

`atris youtube search` shells to local ytsearch/yt-dlp and never hits the Atris API.

`atris youtube search --paid` posts `{query, limit}` to `/youtube/search` with bearer auth. Agent tokens need the youtube scope. This is an opt-in buy, not a 429 fallback.

`atris youtube` process first tries local transcript extraction with `yt-dlp`. It sends timestamped `transcript_text` to `/agent/process_youtube` with `cache_transcript=false`. A written VTT or clean.txt in the notes work dir is a local hit even when `-J` stdout is empty or the caption URL fetch fails, so process does not jump to paid cloud video for that case. If local transcript processing fails with a retryable error, it falls back to cloud video processing. Use `--json` to inspect `metadata.processing_method` and `metadata.transcript_source`.

---

## Billing

- **Search: 0 credits** (local discovery)
- **Paid search: 5 credits** (`--paid`; print credits refunded only when the server marks a refund)
- **Notes: 0 credits** (local captions + engine)
- **Process: 5 credits per video** (flat rate, any length)
- Credits deducted before processing
- Process 401/402/502 print Credits when present and say credits refunded only when `credits_refunded` is explicit. A local-transcript 502 that then retries cloud prints the same lines from the first payload.
- Insufficient credits returns 402 with your current balance

---

## Error Handling

| Error | Meaning | Fix |
|-------|---------|-----|
| `401` | Token expired/invalid | `atris login --agent` from a stored login |
| `402` | Not enough credits | Check balance, purchase at atris.ai |
| `400` | Invalid YouTube URL | Check URL format |
| `502` | Transcript or cloud processing failed | Retry; print credits refunded only when the server marks a refund |
| search exit 2 | ytsearch/yt-dlp missing or no results | Install yt-dlp, or put ytsearch on PATH |
| search 429 | YouTube rate-limited local search | use printed rows if any; else CLI already retried; use cached rows if printed (same rich/thin check as a live hit); if the rate-limit sentence prints, STOP; do not use --paid |
| teach 429 | YouTube rate-limited local metadata | use printed yt-dlp JSON if it parses; if the caption URL fetch fails or `-J` stdout is empty or broken, use a written VTT or clean.txt from the notes work dir; no written caption still fails; do not use process as a fallback |
| notes 429 | YouTube rate-limited local captions | use a written yt_<id>.md if it exists; ytnotes keeps a written manual or auto en / en-orig / en-US / en-GB VTT plus printed metadata, or a VTT written in the same run when print is empty, including /e/ and youtube-nocookie embed urls; a copied #t= timestamp still finds that leftover file; empty 429 with no captions still fails; do not use --paid |

---

## Quick Reference

```bash
# Setup: human stores a login, then agents mint. never /auth/cli
npm install -g atris && atris login
atris login --agent

# Free: discover videos
atris youtube search "MCP agents 2026"
atris youtube search "MCP agents" --limit 10

# Paid: only if the user asked to buy permalinks (5 credits). never a 429 fallback
atris youtube search --paid "MCP agents 2026"

# Free: notes on a URL you already have
atris youtube notes "https://youtu.be/VIDEO_ID"

# Process a video (5 credits). different store from paid search
atris youtube process "https://youtube.com/watch?v=..." --query "Create a outline (flowing, idea-first) and action brief"

# Process + store to agent knowledge
atris youtube process "https://youtube.com/watch?v=..." --agent "YOUR_ID" --store
```
