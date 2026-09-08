---
name: design
description: Frontend aesthetics policy. Use when building UI, components, landing pages, dashboards, or any frontend work. Prevents generic ai-generated look.
version: 3.2.17
allowed-tools: Read, Write, Edit, Bash, Glob
tags:
  - design
  - frontend
---

# atris-design

The taste organ of the Atris system. Opinionated: these are Keshav's principles, not general best practices. Prevents ai-generated frontend from looking generic, and improves itself (see "self-improve" at the bottom, it is part of the job, not optional).

Canonical home: `atris-cli/atris/skills/design/SKILL.md` (this file, git-tracked). `atris sync` stamps it into every workspace's `atris/skills/` and `.claude/skills/`. Edit HERE, never a downstream copy: sync will clobber anything written elsewhere.

## Atris Integration

1. Check `atris/MAP.md` for existing patterns before building
2. **Read `atris/policies/design-seed.md` first** if it exists: it has the project's unique visual identity (fonts, colors, spacing, motion). This is the design DNA. Do not override it with defaults.
3. Read `.atris/theme.json` if it exists: brand colors and fonts are already decided, use them.
4. Reference `atris/policies/atris-design.md` for full anti-slop guidance
5. After building, run the workspace design gate (`npm run audit:design` in atrisos-web, `atris slop` elsewhere) before claiming done.

## Quick Reference

**Typography:** avoid inter/roboto/arial/system fonts. pick one distinctive font, use weight extremes (200 vs 800). size jumps should be dramatic (3x). use `clamp()` for fluid sizing. use `ch` units for measure (`max-width: 65ch`).

Font alternatives: instead of Inter: Instrument Sans, Plus Jakarta Sans, Outfit. Instead of Roboto: Onest, Figtree, Urbanist. Editorial: Fraunces, Newsreader, Lora.

**Color:** commit to a palette. use OKLCH for perceptually uniform colors. tint your neutrals toward your brand hue (never pure gray). never put gray text on colored backgrounds. never use pure black (#000) or pure white (#fff). avoid the AI palette: cyan-on-dark, purple-to-blue gradients, neon accents on dark.

```css
--brand: oklch(65% 0.2 250);
--gray-100: oklch(95% 0.01 250); /* tinted, not pure gray */
```

**Layout:** break the hero + 3 cards + footer template. no card-in-card nesting. no identical card grids. asymmetry is interesting. dramatic whitespace. use container queries for component-level responsiveness. fluid spacing with `clamp()`.

**Motion:** one well-timed animation beats ten scattered ones. use exponential easing (`cubic-bezier(0.25, 1, 0.5, 1)`), never bounce/elastic. 150-300ms duration. only animate transform and opacity. always respect `prefers-reduced-motion`. no cursor-following lines, no meteor effects, no buttons that chase the cursor. no pulsing or glowing live-status dots, no looping ambient animations.

**Interaction:** progressive disclosure: start simple, reveal complexity. optimistic UI: update immediately, sync later. every interactive element needs ALL states: default, hover, focus, active, disabled, loading, error, success. don't make every button primary.

**Hover:** make elements feel inviting on hover (brighten, subtle scale 1.02-1.05). never fade out, shift, or hide content behind hover. hover doesn't exist on mobile. no hover lift: a translate-y shift or a scale past 1.05 on every card is the generated-card reflex; the shift breaks the never-move-content rule and the big grow reads as a template.

**Scroll:** never override native scroll. use "peeking" (show a few px of next section) instead of full-screen hero + scroll arrow.

**Responsive:** mobile-first. touch targets 44x44px minimum. no text under 14px on mobile. no horizontal scroll. container queries over media queries for components. adapt, don't amputate. compact overlays clear the full measured header stack; never anchor them from a guessed single header height.

**Accessibility:** 4.5:1 contrast for text, 3:1 for UI (WCAG AA). visible focus indicators always. semantic HTML. never use color alone as an indicator. keyboard nav with logical tab order.

**Hero (H1 test):** must answer in 5 seconds: what is it, who is it for, why care, what's the CTA.

**Assets:** high-res screenshots only. no fake dashboards with primary colors. no decorative non-system emojis.

**Backgrounds:** add depth. gradients, patterns, mesh effects. flat = boring. but no glassmorphism everywhere, that's AI slop.

**Hierarchy:** 2-3 text levels max. don't mix 5 competing styles.

**No all-caps. ever.** never use the `uppercase` tailwind class, `text-transform: uppercase`, or shout-cased copy on labels, section headers, buttons, badges, or anywhere else. random capitalized text mid-page reads as average ai-generated slop. write labels in sentence case ("Active tasks", not "ACTIVE TASKS") and let copy render as authored.

**No eyebrow metadata.** Do not place tiny index, category, status, or implementation-type strips above real content. If the name changes the next action, make it a readable heading. If it does not, remove it. Generator metadata belongs in machine contracts and inspectors, never on the product canvas.

**Copy:** no em dashes (the character, U+2014) anywhere in UI copy. no hedge words, no hype adverbs (the "-lessly" family). plain sentences a human would type.

**Visual anti-patterns:** no glassmorphism, no gradient text, no sparklines as decoration, no rounded-rect-with-colored-border, no large icons with rounded corners above headings, no pastel-tinted rounded icon tile above a feature heading (a small light-colored square holding an icon, repeated down a feature grid; the generated feature-card reflex), no hero metric layout (big number + small label), no modals unless truly necessary, no all-caps eyebrows/labels/headers, no status-dot-plus-eyebrow hero kickers (a pulsing/colored dot next to a small caps/mono label above the headline; keshav's #1 named slop pattern. if a section needs a kicker at all, plain sentence-case text with no dot), no "claude beige" off-white backgrounds, no instrument serif overuse (the new AI tell), no generic flat tinted backgrounds, no near-black slate or gray hero gradient fading into black (the dark premium SaaS template look), no colored glowing drop shadow under buttons or cards (a tinted neon glow, e.g. a purple or blue shadow; keep shadows soft and neutral), no bright two-color gradient fill on buttons or badges (a saturated gradient across different hues like pink to orange or blue to cyan; use one solid brand color), no giant blurred gradient orb glowing behind the hero (the aurora-blob background: a huge soft-blurred colored blob absolutely positioned behind the fold; reads as a template).

## Vocabulary is the Lever

Designers beat engineers at AI prompting because they own craft language. Name the move precisely: "tighten vertical rhythm," "increase negative space," "make hierarchy bolder here, quieter there." Vague prompts = vague output. Core terms: vertical rhythm, negative space, bolder/quieter, affordances, meta-design, conviction. When the operator's wish is fuzzy, translate it into this vocabulary before building, and say the translation out loud so the operator can correct it.

## Raising Floor vs Ceiling

Use AI to raise the floor (automate the mechanical 80%: scaffolding, grids, state matrices). Spend human attention on the ceiling (last 10-20%: taste, instinct, the unexpected choice). Cognitive delegation, not surrender. AI routes you there; you make the final call.

## AX: Agentic Experience

Design for AI agents as users, not just humans. Agents can't see your buttons. They need: speed, clarity, structured output, verbose errors with next steps, edge case coverage, agentic affordances (`llms.txt`, clear `--help`, stable exit codes).

## Conviction Over Local Maxima

Iterating toward "slightly better" = local maximum (safe, forgettable). Great design is a bet on a global maximum. AI makes the local-max trap worse: you converge on average faster. Subtraction over addition: the strongest move is often deleting something.

## Anti-Attractors

Models have gravity wells (purple gradients, instrument serif, claude beige). Escape them deliberately: name what you don't want, seed with a specific reference, inject a constraint (monochrome, one font weight), rotate your defaults between projects.

## The Scarcity Principle

Taste emerges from constraints. Pick constraints before starting: one font, two colors, three spacing values. Infinite options produce the distribution center.

## The AI Slop Test

> "if you showed this to someone and said 'AI made this,' would they believe you immediately? if yes, that's the problem."

Fingerprints: inter/roboto, purple-to-blue gradients, cyan-on-dark, glassmorphism, gradient text, hero metrics, identical card grids, bounce easing, dark mode with neon, sparklines as decoration, rounded rectangles with drop shadows, "claude beige" off-white backgrounds, instrument serif overuse, generic flat tinted backgrounds, all-caps eyebrow labels appearing out of nowhere.

## Lessons (typed, compounding)

Every entry: id, rule, detector, status. A detector is a regex/command a gate can run, or `judgment` if only a model can catch it. `graduated` means a deterministic gate now enforces it (design-gate.mjs in atrisos-web, `atris slop` in atris-cli); the lesson stays here as the memory of why.

| id | rule | detector | status |
|----|------|----------|--------|
| D1 | no purple/violet/fuchsia/lavender palettes | banned-palette class scan | graduated (design-gate) |
| D2 | no hardcoded neutral tailwind classes, tint toward brand | zinc/gray/neutral/slate class scan | graduated (design-gate) |
| D3 | no all-caps labels anywhere | uppercase class scan | graduated (design-gate) |
| D4 | custom components only, no shadcn/radix primitives | radix import scan | graduated (design-gate) |
| D5 | no pulsing status dots outside loading skeletons | pulse class scan outside loading/skeleton files | graduated (design-gate) |
| D6 | no arbitrary hex in color utilities, use brand vars | hex-in-color-utility scan | graduated (design-gate) |
| D7 | no em dashes in UI copy or prose | U+2014 scan | graduated (atris slop) |
| D8 | no claude-beige backgrounds, no instrument serif as default | judgment | promoted |
| D9 | fuzzy wish gets translated to craft vocabulary and echoed back before building | judgment | active |
| D10 | measured tokens over vibes: new components start from a measured recipe (exact colors, spacing, radii, type from a proven source), never from scratch | judgment | active |
| D11 | layout contracts, not dioramas: min-height over fixed height, fluid max-width over fixed px, every overflow reachable (scroll or +N more), stress-test with hostile content before shipping | judgment | active |
| D12 | one accent moment per card: brand accent for the primary action only, gold for confidence/progress fills, green only for completed; everything else tonal | judgment | active |
| D13 | motion is calm and eased: 120-300ms ease-out on opacity/transform only, loops match a measured source cadence, prefers-reduced-motion always freezes them | judgment | active |
| D14 | compact selectors lead with the chosen name and a discriminating icon; remove redundant field labels and visible type explanations when icon, title, and accessible label carry them | judgment | active |
| D15 | copy density on landing pages: hero lede one sentence, one sentence per feature card, one line per FAQ answer, legal in one short footer paragraph; a section paragraph past ~40 words gets cut or moved one click deep (Keshav 2026-09-01: "SO much blabber yap text. keep it clean") | `<p>` in landing html over 60 words flags; otherwise judgment | active |
| D16 | verify mobile with real device emulation (Playwright iPhone profile, WebKit for iOS), never headless Chrome --window-size: Chrome floors the window at 500px wide and renders a fake layout (caught 2026-09-01: two "passing" screenshots hid a broken phone nav) | command scan for `--window-size=3` or `--window-size=4` in verify scripts | active |
| D15 | first viewport restraint: one dominant idea, at most one secondary live region, and everything else behind progressive disclosure; reject permanent three-column cockpit density as default SaaS structure | judgment | active |
| D16 | one alignment contract per component: wrapper, metadata, controls, and rendered content share the same width and inset source at every viewport | judgment | active |
| D17 | responsive corrections must test every disclosed state immediately below, at, and above each breakpoint; a fixed bug cannot reappear when a panel opens or the container narrows | judgment | promoted |
| D18 | no eyebrow metadata or tiny titles: important names become readable headings; indices, platform type names, and generator metadata stay off product surfaces | judgment | promoted |
| D19 | bubbly flat UI means one generous rounded parent, flat content-rail rows, and circular controls with a real action or stable identity; never round every nested child | judgment | active |
| D20 | compound controls own one visible focus shape on the outer geometry; a borderless child field may suppress its ring only when the parent provides `:focus-within` proof | judgment | active |
| D21 | the reusable web component layer must match the product runtime: React and Next.js are canonical for Atris web; custom elements are compatibility code, never the source of truth | React field and function scan | graduated (component contract) |
| D22 | every documented component prop must be proven with the standalone package stylesheet; demo-only CSS cannot be the hidden implementation of a public layout contract | standalone prop selector scan | graduated (component contract) |
| D23 | an owner dashboard should begin as a project save state: current story, one resume action, active missions, and the responsible team; spatial world maps are earned later by real geography or dependency data | judgment | active |
| D24 | `Since you left` is a learning and cleanup receipt, not a feature changelog: show what the system learned, removed, and carried forward so the human can stay present | judgment | active |
| D25 | game-like dashboards use plain outcomes, visible stakes, and one obvious next action; invented quest names and internal loop language hide the work instead of clarifying it | judgment | active |
| D26 | execution receipts read in causal order: inspect inputs, reason, change, then verify; never reverse the activity list or lead with the outcome | judgment | active |
| D27 | in a compact composer, the send action must visibly dominate adjacent attachment and voice controls through size and accent while secondary controls remain full touch targets | judgment | active |
| D28 | sibling icon controls on one composer rail share a single explicit frame and alignment anchor; glyph size alone must never determine their centers | judgment | active |
| D29 | hide voice playback until its voice clears the product quality bar; a weak fallback control is worse than no control | judgment | active |
| D30 | a floating rounded composer inherits the page canvas; never paint a full-width contrast band behind it unless that band is intentional chrome | judgment | active |
| D31 | developer-only overlays stay off the product surface by default; any temporary visible launcher must have an immediate dismiss control | judgment | active |
| D32 | before changing repeated UI copy, verify the operator's exact executable and surface; matching labels do not prove the installed app, dev app, header, and composer share one live path | judgment | active |
| D33 | first run is a proactive, scripted conversation, not an empty composer: the product speaks first, asks at most three things with tappable answers, folds sign in into the last step naming the work it will start, and does a real first pass immediately (Keshav 2026-09-01: "onboarding should feel sooo magical, almost like a video game onboarding or a chat that's proactive and sets it up") | judgment | active |

Measured recipes live in the mimic studies: `~/arena/mimic-beautiful-ui/LESSONS.md` (18 AI-interface components with exact tokens) and its `remix.css` :root block (the portable Atris token sheet, coffee + paper themes). Start there before designing an agent surface.

## Self-Improve (part of the job)

This skill compounds or it dies. The contract, every frontend session:

1. **Capture in the same tick.** When the operator corrects a design choice (a "no", a revert, a fix after landing, a reaction like "that looks AI"), append a typed lesson row above before the session ends. Quote the trigger in the commit/journal, keep the rule one line, propose a detector.
2. **Graduate detectors.** A lesson with a deterministic detector does not stay prose: add it to the nearest gate (`scripts/design-gate.mjs` CATEGORIES in atrisos-web, `atris slop` rules in atris-cli), then mark the row graduated. The gate is the enforcement; the row is the memory.
3. **Promote repeat offenders.** A judgment lesson that fires 3+ times gets rewritten into the Quick Reference prose above and its row marked promoted.
4. **Edit the canonical only.** This file, in atris-cli, committed to git. Then run `atris sync` in each workspace (or wait for the pulse tick) to propagate. Writing to a downstream copy is a lost write.
5. **Prune.** Fold subsumed lessons, keep this file readable in one sitting. If the lessons table passes ~25 rows, graduate or promote before adding.
6. **Bump the version** on every content change (progressive: patch for a lesson row, minor for a new principle).

## Before Shipping Checklist

- can you name the aesthetic in 2-3 words?
- distinctive font, not default?
- at least one intentional animation? zero pulsing/looping ones?
- background has depth? not claude beige?
- hover states feel inviting, not confusing?
- scrolling feels native?
- hero passes H1 test (what/who/why/CTA)?
- all assets crisp?
- all interactive elements have all states (hover/focus/active/disabled/loading/error)?
- WCAG AA contrast (4.5:1 text, 3:1 UI)?
- works on mobile (44px touch targets, no horizontal scroll, readable text)?
- respects `prefers-reduced-motion`?
- zero shout-cased copy?
- did you name the moves in craft vocabulary (vertical rhythm, negative space, bolder/quieter)?
- did you use anti-attractors (named what to avoid, seeded a reference, set a constraint)?
- if agent-facing: does it have agentic affordances (clear errors, structured output, stable exit codes)?
- ran the design gate? (`npm run audit:design` / `atris slop`)
- new operator correction this session? then a new lesson row exists in the canonical and it is committed.
- would a designer clock this as ai-generated?

## Learn More

- Full policy: `atris/policies/atris-design.md`
- Navigation: `atris/MAP.md`
- Workflow: `atris/PERSONA.md`
| D15 | marketing front pages: headline + one 2-line paragraph + buttons per section, card copy max 2 sentences, long artifacts live one click deep (Keshav 2026-08-31 "aggressive amounts of texts still", inspiration Oscar/Headway) | judgment | active |
