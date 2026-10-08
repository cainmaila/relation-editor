# CLAUDE.md

## 0. Project: tpkc-fe-relation-editor

Node editor POC for the TPKC relation chain: 2D swimlane graph (one lane per system), CRUD on nodes/edges, "find customers" along edge direction. Static mock only, no persistence.
Spec (source of truth): `/Users/cain/01_fet/tpkc/tpkc-pd-docs/docs/需求與設計/節點編輯器/PRD.md`. Its §6 scenarios are the acceptance criteria; re-read it when work starts, it may have changed.

Stack: SvelteKit + Svelte 5 + TypeScript + Tailwind v4, pnpm. Tests: Vitest (unit/component) + Playwright (e2e).
Checks: `pnpm check`, `pnpm lint`, `pnpm test:unit --run`, `pnpm build`.

## 1. Work as a manager

- Main agent = task manager: plan, dispatch, verify. Execution goes to subagents (parallel when independent). Only a quick task you're sure of may be done directly.
- Verify every subagent result yourself (read the diff, run the check) before marking it done.
- Anything not quick → track it in `PROGRESS.md` (repo root), which persists across sessions:
  - Read it at session start; resume unfinished work from it.
  - Update after every step, so an interrupted session can hand off from the file alone.
  - Version-controlled: commit `PROGRESS.md` updates along with the related work.
  - Purpose is tracking, not history: per task, list goal, done (verified only), todo, next step, blockers/notes. Delete a task once delivered.
- Time matters: don't stall. Unclear requirement → ask immediately, don't guess.

## 2. Code rules

- Think first: state assumptions; multiple interpretations → present them, don't pick silently; simpler approach exists → say so.
- Minimum code for the request. No speculative features, abstractions, config, or impossible-case error handling.
- Touch only what's needed; match existing style. Unrelated dead code: mention, don't delete. Remove only orphans you created.
- Define a verifiable success check before starting (test, build, or run); loop until it passes.
