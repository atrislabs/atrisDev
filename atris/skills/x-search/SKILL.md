---
name: x-search
description: "X/Twitter search via xAI Grok API. Use when user wants to search tweets, monitor topics, find viral posts, or run social listening. Costs 5 credits per search. Triggers on x search, tweet search, twitter search, social listening, revenue intel, viral tweets."
version: 2.4.1
tags:
  - x-search
  - social
  - research
---

# X Search

> Drop this in `~/.claude/skills/x-search/SKILL.md` and Claude Code becomes your X/Twitter intelligence tool.

## Feature map

Hard path. Follow in order. Soft memory does not override this.

```
login
    |
   x-search QUERY (5 credits)
    |
   stdout only unless --save
        |
       rich ephemeral --> one apply next-step, one inferred check + score: 0, then one youtube-search next-step, no files
       thin ephemeral --> check: fill this, then one youtube-search next-step, no files
       empty successful pull --> one next: atris youtube search " "
       --save + rich --> brief + pack + one Apply, prove baseline score 0
       --save + thin --> refuse, no files, exit 2
    |
   stop
```

1. Login: stored login, then `atris login --agent` if needed. Never paste tokens. Never `/auth/cli`.
2. Search: `atris x-search "QUERY"`. Always billed (5 credits). Prints to stdout. Rich ephemeral prints one apply next-step, one inferred check plus `score: 0`, then one `next: atris youtube search "<query>"` (person mode uses `--name`), and writes nothing. Thin ephemeral prints `check: fill this` then that youtube-search next, and writes nothing. Empty successful pull (no tweets) prints one `next: atris youtube search " "`. Explicit refund or failed search writes nothing extra. Empty, 502, 401, or 402 with unused credits print Credits when present and do not say refunded unless credits_refunded is explicit. A 401 that remints and retries prints those same credit lines from the first payload before the retry. `--json` stays quiet.
3. `--save` only when you want a brief. Rich results (a number-with-units or a named mechanism) file the brief, mint `atris/experiments/x-search-<slug>/`, write one Apply that names that pack and the keep rule, and prove that fixture starts at score 0. Thin `--save` prints `thin: no number or named mechanism. no brief.` and writes nothing. `--save` does not print a youtube-search next-step.
4. Stop. `--json`, explicit refund, or failed search does not print apply, check, score, or youtube-search next-step.

## Customer path (preferred)

Logged-in customers should use the CLI. Same auth and billing as `atris youtube process` (5 credits).

```bash
atris x-search "MCP agents"
atris x-search "MCP agents" --limit 5 --days 2
atris x-search "MCP agents" --save
atris x-search person --name "Leah Bonvissuto" --handle leahbon
atris x-search --help
```

Add `--json` for the raw API payload. Curl below is the raw API for debugging only.

## Bootstrap (ALWAYS Run First)

Before any X search operation, run this bootstrap to ensure everything is set up:

```bash
#!/bin/bash
set -e

# 1. Check if atris CLI is installed
if ! command -v atris &> /dev/null; then
  echo "Installing atris CLI..."
  npm install -g atris
fi

# 2. Check if logged in to AtrisOS
if [ ! -f ~/.atris/credentials.json ]; then
  echo "Not logged in to AtrisOS."
  echo ""
  echo "Option 1 (interactive): Run 'atris login' and follow prompts"
  echo "Option 2 (non-interactive): Get token from https://atris.ai/auth/cli"
  echo "                           Then run: atris login --token YOUR_TOKEN"
  echo ""
  exit 1
fi

# 3. Extract token
if command -v node &> /dev/null; then
  TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
elif command -v python3 &> /dev/null; then
  TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.atris/credentials.json')))['token'])")
elif command -v jq &> /dev/null; then
  TOKEN=$(jq -r '.token' ~/.atris/credentials.json)
else
  echo "Error: Need node, python3, or jq to read credentials"
  exit 1
fi

# 4. Quick auth check
STATUS=$(curl -s "https://api.atris.ai/api/me" \
  -H "Authorization: Bearer $TOKEN")

if echo "$STATUS" | grep -q "Token expired\|Not authenticated\|Unauthorized"; then
  echo "Token expired. Please re-authenticate:"
  echo "  Run: atris login --force"
  exit 1
fi

echo "Ready. X Search is available (5 credits per search)."
export ATRIS_TOKEN="$TOKEN"
```

---

## API Reference

Base: `https://api.atris.ai/api/x-search`

All requests require: `-H "Authorization: Bearer $TOKEN"`

### Get Token (after bootstrap)
```bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
```

### Search X/Twitter
```bash
curl -s -X POST "https://api.atris.ai/api/x-search/search" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "\"CRM is dead\" OR \"Salesforce alternative\"",
    "limit": 10
  }'
```

**With date filter** (last N days only):
```bash
curl -s -X POST "https://api.atris.ai/api/x-search/search" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "AI agents replacing SaaS",
    "limit": 10,
    "days_back": 7
  }'
```

**Response:**
```json
{
  "status": "success",
  "credits_used": 5,
  "credits_remaining": 995,
  "data": {
    "content": "1. @levelsio: AI agents are replacing...",
    "citations": ["https://x.com/levelsio/status/..."],
    "usage": {"prompt_tokens": 200, "completion_tokens": 800}
  }
}
```

### Research a Person
```bash
curl -s -X POST "https://api.atris.ai/api/x-search/research-person" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Leah Bonvissuto",
    "handle": "leahbon",
    "company": "Presentr",
    "context": "Interested in revenue intelligence and AI for GTM"
  }'
```

**Response:**
```json
{
  "status": "success",
  "credits_used": 5,
  "credits_remaining": 990,
  "data": {
    "content": "### 1. Profile\n**Name:** Leah Bonvissuto\n...",
    "citations": ["https://x.com/..."],
    "usage": {"prompt_tokens": 300, "completion_tokens": 1200}
  }
}
```

---

## Workflows

### "Search X for tweets about a topic"
1. Prefer `atris x-search "<query>"` (or bootstrap + curl if debugging the API)
2. Display results: tweet text, citations (x.com links), credits used/remaining

### "Find tweets from the last week about X"
1. Prefer `atris x-search "<query>" --days 7 --limit 10`
2. Display results and citations

### "Research a person before a meeting"
1. Prefer `atris x-search person --name "..." --handle ... --company ... --context "..."`
2. Display profile, background, talking points

### "Monitor keyword clusters for revenue intel"
1. Run bootstrap
2. Run multiple searches across keyword clusters:
   - `"CRM is dead" OR "Salesforce is dead" OR "HubSpot sucks"`
   - `"revenue operations" (broken OR frustrated OR replacing)`
   - `(founder OR CEO) "tech stack" (consolidating OR ripping out)`
3. Each search costs 5 credits
4. Combine results, rank by engagement, draft replies

### "Find viral tweets in my industry"
1. Run bootstrap
2. Search with engagement filter: `POST /x-search/search` with query including `min_faves:50`
3. Display top tweets sorted by likes/retweets

---

## Query Tips

| Goal | Query Example |
|------|--------------|
| Specific phrase | `"revenue operations"` |
| OR logic | `"CRM is dead" OR "Salesforce alternative"` |
| From a user | `from:levelsio` |
| High engagement | `"AI agents" min_faves:50` |
| Exclude retweets | `"your query" -is:retweet` |
| Multiple keywords | `(founder OR CEO) ("AI adoption" OR "AI native")` |

---

## Billing

- Every search costs **5 credits** (flat)
- 1 credit = $0.01, so 1 search = $0.05
- Research person also costs 5 credits
- Credits are deducted server-side before the search runs
- If insufficient credits, returns `402 Insufficient credits`

---

## Error Handling

| Error | Meaning | Solution |
|-------|---------|----------|
| `401 Not authenticated` | Invalid/expired token | Run `atris login` |
| `402 Insufficient credits` | Not enough credits | Purchase credits at atris.ai |
| `502 Search failed` | xAI API issue | Retry in a few seconds |

---

## Quick Reference

```bash
# Setup (one time)
npm install -g atris && atris login

# Preferred: CLI
atris x-search "AI agents" --limit 10 --days 7
atris x-search "AI agents" --save
atris x-search person --name "John Doe" --handle johndoe --company Acme

# Raw API (debug)
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
curl -s -X POST "https://api.atris.ai/api/x-search/search" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "AI agents", "limit": 10, "days_back": 7}'
```
