# Validation - Self-driving mission

> **Role:** Feature contract gate
> **Executor:** Validator Agent
> **Rule:** If any step fails, the feature packet is incomplete.

---

## 1. Static Contract Check

- [ ] Run the exact command from the repository root:

```bash
node -e "const fs=require('fs'); const d='atris/features/self-driving-mission'; const files=['idea.md','build.md','validate.md']; for (const f of files) { if (!fs.existsSync(d+'/'+f)) throw new Error('missing '+f); } const idea=fs.readFileSync(d+'/idea.md','utf8'); const build=fs.readFileSync(d+'/build.md','utf8'); for (const term of ['## Problem Statement','## ASCII Visualization','## Autonomy Ladder','## Driving Contract','## Success Criteria','## Nearest-neighbor Blend']) { if (!idea.includes(term)) throw new Error('idea missing '+term); } for (const term of ['## Files Touched','## Build Steps','## Testing Strategy','## Error Cases','## Rollback Plan']) { if (!build.includes(term)) throw new Error('build missing '+term); } console.log('self-driving mission contract: pass');"
```

- **Expect:** `self-driving mission contract: pass` and exit code 0.

---

## 2. Structure Search

- [ ] Run:

```bash
rg -n "destination|engine broker|replan|restaff|hard gate|arrival receipt|verified time-to-arrival" atris/features/self-driving-mission
```

- **Expect:** Matches in `idea.md` and `build.md` covering the destination, routing, recovery, human boundary, arrival proof, and optimization metric.

---

## 3. Build-phase Runtime Gate

When implementation begins, run this bare command with no pipe:

```bash
node --test test/self-driving-mission.test.js test/mission-status.test.js test/fleet.test.js test/radar.test.js test/engine.test.js
```

- **Expect:** Exit code 0.
- **Required simulation:** one destination reaches verified arrival after an injected primary-engine failure, with completed proof preserved and a different eligible engine recorded for recovery.

---

## 3b. Bounded repair gate: delegation owner and handoff fidelity

Source tasks `01M1X95C2K51HKNTW7CC51HKNT`, `01M1X96ZZ6CD9NENF4DJCD9NEN`; backend packet `01M1X8MVRS8W3PQ86SV68W3PQ8`. Run bare:

```bash
node --test test/task-plan-owner.test.js test/task-explanation.test.js test/workflow-delegation.test.js
git diff --check
```

- **Expect:** exit code 0 for both.
- [ ] `task delegate --to mission-lead` then `task plan` without `--owner` keeps `plan_trace.owner_choice.owner`, `metadata.stage_owner`, and `metadata.assigned_to` all `mission-lead`.
- [ ] `task plan --owner architect` on that task moves all three to `architect`.
- [ ] An unassigned task still gets automatic team choice (`owner_source: team`).
- [ ] A claimed task refuses `plan` from another actor or with another `--owner` (`claimed_by_other`).
- [ ] `delegate --what-changes ... --verify ...` -> `plan` -> `show --json` keeps exact paths, flags, engine/model, and merge/queue strings in `metadata` and the `created` event; `explanation.what_changes` has none of them.
- [ ] Expected owner and mission values appear in both executor prompts. Missing values, changed real task records, inactive rows, and foreign claims fail the pre-edit check; incomplete dispatch stops before credentials or edit tools.
- [ ] A rendered TODO row omitting the owner and path still yields a prompt that requires the exact dispatched task JSON before claim/edit; stale or mismatched tasks are refused.
- [ ] `atris plan --prompt`, `atris do --prompt`, and `executorAgentPrompt()` name `atris task add/plan/claim/ready`, call TODO.md a generated view, and never suggest `atris task accept`.

---

## 4. Safety Regression

- [ ] Destination changes require operator approval.
- [ ] Money, outbound communication, secrets, destructive actions, and irreversible changes park at a human hard gate.
- [ ] Overlapping-file or dependency-linked legs never run concurrently.
- [ ] A mission cannot claim arrival while any required leg lacks a passing verifier receipt.
- [ ] Emergency stop preserves worktrees, current position, receipts, and a resumable next maneuver.

---

## 5. Performance Benchmark

Run the same pinned destination, repository snapshot, budget, and acceptance bar twice:

1. A fixed single-engine baseline.
2. The self-driving broker with the installed engine roster.

Record verified time-to-arrival, accepted completion, estimated spend, bounces, recoveries, and human interventions. The first release passes only if it lowers verified time-to-arrival without reducing accepted quality or weakening a hard gate.

---

**Status:** Packet Verified; Runtime Pending
