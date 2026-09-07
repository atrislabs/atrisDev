# Self-driving mission - Build Plan

> **For Executor Agent** - Build one vertical L4 slice before expanding the autonomy ladder.

---

## Overview

Add a destination-to-route control plane to the existing mission runtime. The first slice proves that one destination can be decomposed, staffed across installed engines, recovered, verified, and summarized without operator task management.

---

## Files Touched

**Expected modifications:**
- `commands/mission.js` - destination input, route persistence, leg transitions, replanning, and arrival receipt.
- `lib/fleet.js` - accept route legs and broker decisions while preserving safe-lane dispatch.
- `lib/runner-command.js` - expose engine capabilities and health signals through the existing roster.
- `commands/radar.js` - render trip position, next maneuver, engine rationale, blocker, and stop action.
- `test/mission-status.test.js` - route schema and status coverage.
- `test/fleet.test.js` - broker, parallel-safety, and restaff coverage.
- `test/radar.test.js` - instrument-panel projection coverage.
- `atris/MAP.md` - update touched navigation routes.

**Created:**
- `test/self-driving-mission.test.js` - destination-to-arrival integration contract.

No dependency changes are allowed.

---

## Build Steps

### Step 1: Persist the trip contract

**Files:** `commands/mission.js`, `test/mission-status.test.js`

Add a versioned `drive` object to mission state with `destination`, `destination_hash`, `autonomy_level`, `route_version`, `position`, `legs`, `hard_gates`, `budget`, and `stop_reason`. Each leg must name its objective, dependencies, files or surface, verifier, engine requirements, risk lane, fallback, and terminal state.

**Validation:** A mission created from one destination round-trips through `mission status --json`, and changing the destination creates an explicit operator-gated proposal rather than silently mutating it.

### Step 2: Compile a falsifiable route

**Files:** `commands/mission.js`, `test/self-driving-mission.test.js`

Compile the destination into the smallest route whose legs each have a verifier and stop condition. Reject routes with missing checks, cycles, unsupported hard gates, or legs too broad to assign safely; preserve the rejected proposal and reason in the receipt.

**Validation:** Fixtures cover a valid linear route, safe independent legs, a dependency cycle, a missing verifier, and a proposed destination change.

### Step 3: Broker engines by evidence

**Files:** `lib/runner-command.js`, `lib/fleet.js`, `test/fleet.test.js`

Score installed engines using capability fit, recent verified latency, bounce rate, cost class, health, and availability. Save the selected engine, alternatives, score inputs, and reason code; use the smallest useful convoy and exclude unhealthy or incapable engines.

**Validation:** Deterministic fixtures select different engines for frontend, backend, research, and recovery legs, and a single capable engine wins when parallelism has no route benefit.

### Step 4: Drive, validate, and recover

**Files:** `commands/mission.js`, `lib/fleet.js`, `test/self-driving-mission.test.js`

Dispatch ready independent legs through existing isolated worktrees. After each leg, run its verifier fresh; on timeout, failure, conflict, or low-confidence review, retain proof and replan, reframe, or restaff within the mission budget. Halt after the existing no-progress threshold or any hard gate.

**Validation:** A fake engine failure causes another eligible engine to finish the same leg, completed sibling proof remains intact, overlapping-file legs serialize, and no-progress halts with an actionable receipt.

### Step 5: Show position and prove arrival

**Files:** `commands/radar.js`, `commands/mission.js`, `test/radar.test.js`, `test/self-driving-mission.test.js`

Render destination, route position, next maneuver, active engine and rationale, confidence, spend, blockers, and stop command. Arrival requires all terminal legs verified and emits one receipt linking every leg, engine decision, verifier result, recovery, intervention, elapsed time, and cost estimate.

**Validation:** Radar remains compact during motion; arrival is impossible with an unverified leg; the receipt is replayable from saved state.

---

## Bounded repair: delegation owner and handoff fidelity

Landed ahead of Steps 3-5 because every later leg depends on it. Cross-links: backend packet `01M1X8MVRS8W3PQ86SV68W3PQ8`, CLI tasks `01M1X95C2K51HKNTW7CC51HKNT` and `01M1X96ZZ6CD9NENF4DJCD9NEN`.

**Files:** `commands/task.js` (`buildAutomaticPlanTrace`, `cmdPlan`, `postTaskApiPlan`), `lib/task-db.js` (`stageTask` `ownerExplicit`), `commands/workflow.js` (plan/do prompt text, `executorAgentPrompt`), `test/task-plan-owner.test.js`, `test/task-explanation.test.js`, `test/workflow-delegation.test.js`, `test/workflow-command.test.js` (one navigator-prompt assertion updated to the new step 3 text), `atris/MAP.md`, `atris/skills/engines/SKILL.md` (bounded handoff and delivery contract).

- Owner precedence in plan: explicit `--owner` > existing claim > `metadata.assigned_to` (delegated) > explicit non-generic actor > team score > default. Explicit `--owner` also moves `assigned_to`; automatic choice never overwrites a delegated owner. Claim guards are unchanged: another actor or another owner on a claimed task still gets `claimed_by_other`.
- Exact instructions: runtime unchanged. The roundtrip test proves `delegate --what-changes/--done-looks-like/--verify` -> `plan` -> `show --json` keeps paths, flags, engine and model names, and merge/queue wording byte for byte in `metadata` and the `created` event while `explanation` stays plain. No machine consumer of the sanitized explanation was found in scoped code.
- Generated prompts: navigator step 3 and executor steps 1 and 5, plus the `--execute` executor prompt, now name `atris task add/plan/delegate/claim/ready` and call `atris/TODO.md` a generated view. `atris task accept` is never suggested to an agent. Handoffs load `atris task show <exact-task-id> --json` before claim/edit, retain raw instructions and the task owner, carry the expected owner plus separate goal and mission references, reload and validate the live assignment before enabling backend edits, refuse missing or mismatched dispatches, and recognize existing user authorization without changing approval gates.

**Validation (bare, no pipe):**

```bash
node --test test/task-plan-owner.test.js test/task-explanation.test.js test/workflow-delegation.test.js
git diff --check
```

Expect exit 0. Before the fix, `test/task-plan-owner.test.js` failed two cases: the delegated owner was replaced by automatic team choice, and explicit `--owner` left `assigned_to` unchanged.

**Out of scope, still pending:** `atris task step` still passes the actor as the plan owner (unchanged behavior); a claim by a different member than the delegated owner leaves `assigned_to` on the delegate (existing `claimTask` behavior); the broader self-driving runtime in Steps 3-5.

---

## Testing Strategy

- Unit: route validation, dependency readiness, broker scoring, hard-gate classification, destination hash, and no-progress policy.
- Integration: one destination reaches verified arrival after an injected engine failure and restaff.
- Regression: mission status, fleet safe lanes, engine profiles, autoland protections, and radar remain green.
- Benchmark: compare the broker against a pinned single engine on the same destination and budget; measure verified time-to-arrival, accepted completion, spend, bounces, and human interventions.

Recommended focused verifier:

```bash
node --test test/self-driving-mission.test.js test/mission-status.test.js test/fleet.test.js test/radar.test.js test/engine.test.js
```

---

## Error Cases

- No engine fits: halt with missing capabilities and the closest available profiles.
- Engine exits or rate-limits: preserve the worktree and receipt, then restaff the leg.
- Conflicting worktrees: pause one leg and serialize; never auto-resolve code conflicts.
- Budget expires: stop safely with verified position and the shortest credible continuation.
- Validator rejects: return the leg to planning with the exact failing check.
- Human hard gate: park the mission with one plain sentence and one approval action.
- Destination becomes infeasible: propose a destination change; do not rewrite it automatically.

---

## Dependencies

This slice composes existing mission, task, fleet, engine, worktree, validator, autoland, radar, and receipt systems. It depends on their current schemas and safety rules, not on new packages or a new orchestration service.

---

## Rollback Plan

1. Keep `drive` state versioned and optional so legacy missions remain unchanged.
2. Disable the self-driving entry flag while retaining route receipts for diagnosis.
3. Revert only the route and broker adapters; existing mission and fleet commands continue to operate independently.
4. Run the existing focused mission, fleet, engine, and radar tests to prove rollback.

---

## Notes for Executor

- Build the one-repo L4 vertical slice before dashboards, cross-repo travel, or multi-mission L5 policy.
- Use deterministic code for leases, safety gates, route readiness, proof checks, and scoring arithmetic.
- Treat engine death as restaffing, not task failure.
- Optimize verified time-to-arrival, not engine utilization or number of agents spawned.
