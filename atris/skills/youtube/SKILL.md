---
name: youtube
description: "YouTube discovery and learning. Get watch permalinks with atris youtube search QUERY (free, local ytsearch/yt-dlp). On 429 the CLI already retries; use cached rows if printed, else STOP. Never run --paid after a 429. --paid only when the user explicitly asked to buy permalinks (5 credits). After a URL is picked, atris youtube notes URL (free, ephemeral unless --save). atris youtube process only to store knowledge (5 credits). Never paste tokens. Never /auth/cli. Mint with atris login --agent from a stored login. Never summarize a video from model memory. Triggers on: youtube search, find videos, paid youtube search, any youtube.com or youtu.be link, youtube, video, watch this, notes on this."
version: 2.17.0
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
   rows --> rich: one failing check (score 0); thin: check: fill this
        --> next: atris youtube teach <first-url>
        --> --json stays quiet
    |
   429 --> CLI already retried once
        --> cached rows printed? use them
        --> rate-limit sentence printed? STOP
             do not run --paid
    |
   pick a URL --> notes URL (free, ephemeral unless --save)
    |                 rich ephemeral prints one apply next-step and one failing check (score 0), no files
    |                 thin ephemeral prints check: fill this instead of inventing a check
    |                 then next: atris youtube teach <same-url>
    |                 --json stays quiet
    |                 --save files brief + pack-named apply when notes have a number or named mechanism; a multi-url --save batch proves the first saved pack the same way single-url --save does; thin --save refuses
    |            or teach URL [--section N] (one chapter: claim numbers, named mechanisms, one check; free unless --save)
    |                 a taught section that is not last prints next: recap TEXT or skip
    |                 last section: rich ephemeral apply, failing check, and score 0, then next: atris youtube watch tick; save pack keep stays; no recap next
    |                 next --section refuses until recap/skip
    |                 owed prints unpaid check; successful unlock prints next section command
    |                 bare teach resumes owed, or prints a start command if nothing is owed
    |
   write one Apply (claimable) before process
    |
   store knowledge? --> process URL (5 credits)
                    --> rich: one failing check (score 0); thin: check: fill this; --json stays quiet

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
   rows --> rich: one failing check (score 0); thin: check: fill this
        --> next: atris youtube teach <first-url>
        --> --json stays quiet
login: atris login --agent from a stored login
never paste tokens, never /auth/cli
```

1. Get watch permalinks: `atris youtube search QUERY` (free). A rich hit prints one inferred check plus `score: 0`. A thin hit prints `check: fill this`. Then one next teach command.
2. If 429: wait/retry is already in the CLI. If it prints cached rows, use those. If it prints `youtube rate-limited local search. do not use --paid as a fallback; retry later.`, STOP. Do not run `--paid`.
3. `--paid` only when the user explicitly asked to buy permalinks. The CLI hard-refuses `--paid` when the free cache still has a fresh same-query hit.
4. `atris youtube notes URL` after a URL is picked (free). Notes is ephemeral unless `--save`. Rich ephemeral prints one apply next-step and one failing check (`score: 0`), then one `next: atris youtube teach <same-url>`, and writes no files. Thin ephemeral prints `check: fill this` instead of inventing a check. A playlist or multi-url batch does the same for the first successful item only. `--json` stays quiet on the check and the teach next-step. Rich `--save` files the brief, mints `atris/experiments/notes-<id>/`, writes one Apply, and prints `score: 0` only when that Apply starts failing. A rich multi-url `--save` batch proves that failing baseline for the first saved pack only; thin `--save` (no number-with-units and no named mechanism) refuses with no brief and exit 2. Do not auto `--paid`.
5. Write one Apply (change + receipt) before `atris youtube process`. Process still requires a filled Apply (so you `--save` a rich brief, fill Apply, then process).
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

echo "Ready. Feature map: free search, 429 cache-or-stop, notes, then process."
```

---

## Search videos (free)

```bash
atris youtube search "MCP agents 2026"
atris youtube search "MCP agents" --limit 10
atris youtube search "MCP agents" --json
```

Uses `ytsearch` on PATH when present, else bundled `scripts/det/ytsearch`, else `yt-dlp --flat-playlist --print` with `ytsearchN:`. No credits. No `/agent/process_youtube` call. A rich hit prints one inferred check plus `score: 0`. A thin hit prints `check: fill this`. Then one next: `atris youtube teach <first-url>`. `--json` stays quiet.

On 429 the CLI retries once, then serves `~/.atris/youtube-search-cache.json` if the same query is younger than one hour. If it prints the rate-limit sentence, stop. Do not run `--paid`.

## Paid search (5 credits, opt-in buy only)

Only when the user explicitly asked to buy permalinks. A 429 or a missing cache is not that ask.

```bash
atris youtube search --paid "MCP agents 2026"
atris youtube search --paid "MCP agents" --limit 10
```

Requires a stored login, then `atris login --agent`. The CLI mints a youtube-scope agent token from disk the same way as `atris youtube process` and `atris x-search`. Never `/auth/cli`. Never paste tokens. Prints `title | watch permalink` plus credits. A rich hit prints one inferred check plus `score: 0`. A thin hit prints `check: fill this`. Then one next: `atris youtube teach <first-url>`. `--json` stays quiet. Empty or failed searches refund.

Line contract:

```text
title | channel | duration | views | upload_date | https://youtu.be/ID
check: <inferred or fill this>
next: atris youtube teach "<first-url>"
```

`upload_date` is `YYYYMMDD` (or `NA`) so callers can apply a freshness gate (for example last 6 weeks). `--json` stays machine-quiet. After the user picks a URL, run notes (free) or process (5 credits).

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

`atris youtube` process first tries local transcript extraction with `yt-dlp`. It sends timestamped `transcript_text` to `/agent/process_youtube` with `cache_transcript=false`. If local transcript processing fails with a retryable error, it falls back to cloud video processing. Use `--json` to inspect `metadata.processing_method` and `metadata.transcript_source`.

---

## Billing

- **Search: 0 credits** (local discovery)
- **Paid search: 5 credits** (`--paid`; refund on empty or fail)
- **Notes: 0 credits** (local captions + engine)
- **Process: 5 credits per video** (flat rate, any length)
- Credits deducted before processing
- **Full refund** if Gemini fails or returns an error
- Insufficient credits returns 402 with your current balance

---

## Error Handling

| Error | Meaning | Fix |
|-------|---------|-----|
| `401` | Token expired/invalid | `atris login --agent` from a stored login |
| `402` | Not enough credits | Check balance, purchase at atris.ai |
| `400` | Invalid YouTube URL | Check URL format |
| `502` | Transcript or cloud processing failed | Retry; credits auto-refunded when backend fails |
| search exit 2 | ytsearch/yt-dlp missing or no results | Install yt-dlp, or put ytsearch on PATH |
| search 429 | YouTube rate-limited local search | CLI already retried; use cached rows if printed; if the rate-limit sentence prints, STOP; do not use --paid |

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
