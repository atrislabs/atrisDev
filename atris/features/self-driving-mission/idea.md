# Self-driving mission

> **Status:** planning
> **Created:** 2026-07-10
> **Last Updated:** 2026-07-10
> **Owner:** Orb
> **Driver:** Mission Lead
> **Source wish:** `wish-2026-07-10-give-atris-a-destination-once-then-l-65067379`

---

## Problem Statement

Atris has missions, engines, fleet worktrees, validators, autoland, and radar, but the operator still has to assemble the route. The product should feel like a self-driving car: Keshav states the destination once, then Atris owns the route, engine choice, recovery, verification, and arrival receipt.

The performance job is not maximizing agent count. It is minimizing verified time-to-arrival while preserving quality, cost discipline, and operator control.

---

## Solution Design

A self-driving mission compiles one destination into a live route graph of bounded, falsifiable legs. An engine broker assigns each leg to the best installed `/engine` using capability fit, expected latency, cost, current health, and historical verified reward; it runs legs in parallel only when their files and dependencies are independent. Every leg crosses a fresh validator gate, and a failed, stalled, or low-confidence leg is replanned or restaffed without losing mission state. Orb protects the destination and briefs only route-changing decisions, while Mission Lead drives the bounded legs to a final arrival receipt.

This is a thin control plane over existing primitives: `mission` is the trip, `fleet` is the convoy, `/engine` is the powertrain roster, task/worktrees are route legs, validator and autoland are safety gates, and radar is the instrument panel.

---

## ASCII Visualization

```text
                         HUMAN CONTROL
                 destination | taste | stop
                              v
[destination] -> [route graph] -> [engine broker] -> [bounded worktrees]
                       ^                 |                    |
                       |        best engine per leg           v
                       |        codex / claude /       [fresh validator]
                       |        cursor / devin /               |
                       |        hermes / atris-fast             +-- pass -> [autoland]
                       |                                        |
                       +---------- replan / restaff <--- fail --+
                                                                |
                                                                v
                                                       [arrival receipt]
```

---

## Autonomy Ladder

| Level | Operator supplies | Atris owns |
|---|---|---|
| L0 manual | destination, route, engine, checks | execution only |
| L1 assisted | destination and route | suggested engine and checks |
| L2 bounded | destination and approved legs | execution, validation, local recovery |
| L3 supervised | destination and approval at route changes | route, staffing, recovery, proof |
| L4 self-driving | destination only | route through verified arrival, with hard human gates |
| L5 company | portfolio direction | multiple missions, capital, staffing, and strategy |

The first product target is L4 inside one repository. L5 stays out of scope until L4 produces trustworthy arrival data.

---

## Driving Contract

1. **Destination is immutable by default.** The driver may change the route, staffing, or order, but changing the outcome requires operator judgment.
2. **Smallest useful convoy wins.** One strong engine is preferred until independent work or specialization proves parallelism will shorten arrival.
3. **Proof is the road boundary.** A leg is not traversed until its declared verifier passes and its receipt names the evidence.
4. **Recovery preserves state.** Timeouts, rate limits, weak output, and conflicts trigger replan or engine replacement, not mission amnesia.
5. **Hard stops stay human.** Money movement, outbound communication, destructive or irreversible changes, secrets, and destination changes wait.
6. **The dashboard answers five questions.** Where are we, what is the next maneuver, why this engine, what could stop us, and what proves arrival?
7. **Learning changes routing.** Verified duration, bounce rate, cost, and intervention count update future engine selection; model reputation alone does not.

---

## Success Criteria

- [ ] One command accepts a plain-language destination and starts a durable mission without requiring the operator to choose tasks or engines.
- [ ] The saved route exposes ordered legs, dependencies, verifier, engine decision, fallback, risk, and stop condition.
- [ ] The broker can select any installed engine profile and records why it was chosen over available alternatives.
- [ ] Independent legs may run concurrently, but overlapping files, dependencies, or protected lanes serialize automatically.
- [ ] A failed or stalled leg is retried, reframed, or moved to another engine without losing completed proof.
- [ ] Every landed leg has a rerunnable verifier receipt; the final result has one arrival receipt linking the full route.
- [ ] Radar shows position, next maneuver, confidence, blockers, spend, and an immediate stop control.
- [ ] The operator is interrupted only for hard gates or a proposed destination change.
- [ ] A benchmark shows lower verified time-to-arrival than one fixed engine on the same destination, with no loss in accepted quality.

---

## User Impact

Keshav gives Atris the outcome instead of managing a queue of agents. He can watch the trip, change the destination, or take over, but ordinary routing and recovery disappear behind one trustworthy arrival contract.

---

## Nearest-neighbor Blend

- **40% mission runtime:** durable objective, route state, stop conditions, receipts, and continuation.
- **25% fleet plus engine roster:** capability-aware staffing, isolated worktrees, parallel safe lanes, and serial landing.
- **20% Orb plus Mission Lead:** one destination keeper above a proof-first bounded driver.
- **15% validator, autoland, and radar:** fresh checks, reversible landing policy, and live operator visibility.

---

## Non-goals

- Spawning every engine for every mission.
- Letting engines vote without a measurable route objective.
- Removing the human from money, outbound, secrets, destructive work, or destination changes.
- Building a new task store, worktree manager, validator, or engine protocol.
- Claiming full company autonomy before a single-repo L4 benchmark passes.

---

## Bounded repair: delegation owner and handoff fidelity (2026-09-07)

Before any route graph exists, one leg has to hold: when a person or member delegates a task, the owner and the exact instructions must survive planning, and generated agent prompts must send agents through the live task plane. This repair is scoped to that leg and does not build the broker or route compiler.

- Source: backend packet `01M1X8MVRS8W3PQ86SV68W3PQ8` (owned by the parent, not edited here); CLI tasks `01M1X95C2K51HKNTW7CC51HKNT` (owner and instruction fidelity) and `01M1X96ZZ6CD9NENF4DJCD9NEN` (generated workflow cleanup).
- Contract: a delegated owner outranks automatic team choice; only an explicit `--owner` or an existing claim moves it, and plan trace, stage owner, and assignee always agree.
- Contract: the plain explanation is for people; metadata and events keep every path, flag, engine, and model string exactly.
- Contract: `atris plan` / `atris do` prompts and the `--execute` executor prompt use `atris task add/plan/delegate/claim/ready`; `atris/TODO.md` is a generated view and human accept stays human.
- Engine pilot: scout agy gemini-3.8-flash-low, coder fable claude-fable-5-1, reviewer agy gemini-3.8-flash-high; the coder ran no further engine dispatch.

---

## Technical Notes

- Extend `commands/mission.js` route state instead of creating a parallel mission database.
- Reuse profiles from `lib/runner-command.js`; engine choice must remain portable across installed CLIs.
- Reuse `lib/fleet.js` for safe parallel worktree dispatch and conflict-preserving landing.
- Keep routing policy deterministic at the safety boundary; model judgment may propose routes, but schemas, gates, leases, and verifier results are code-enforced.
- Every automatic decision needs a compact reason code so routing can be scored and replayed.
