# Disable ParallelLimit Evolution Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure FlowPilot never writes `parallelLimit` through automatic history analysis, `finish`-time evolution, or manual `evolve`.

**Architecture:** Remove `parallelLimit` from evolution generation and application. Runtime scheduling still honors the key when present, but only manual config edits may set it.

**Tech Stack:** TypeScript, Vitest, FlowPilot history/evolution pipeline

---

### Task 1: Add failing tests

**Files:**
- Modify: `src/infrastructure/history.test.ts`
- Modify: `src/application/workflow-service.test.ts`

**Step 1: Write the failing tests**

- Add a test asserting `experiment()` ignores `parallelLimit` config actions.
- Update the finish observability test so automatic evolution no longer reports `parallelLimit` config changes.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/infrastructure/history.test.ts src/application/workflow-service.test.ts`

### Task 2: Remove automatic proposal/application

**Files:**
- Modify: `src/infrastructure/history.ts`

**Step 1: Write minimal implementation**

- Remove automatic `parallelLimit` proposal from reflection logic.
- Remove `parallelLimit` from parsed/applicable evolution config keys.

**Step 2: Run targeted tests**

Run: `npx vitest run src/infrastructure/history.test.ts src/application/workflow-service.test.ts`

### Task 3: Update docs/protocol wording

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/usage-guide.md`
- Modify: `docs/usage-guide.en.md`
- Modify: `src/infrastructure/protocol-template.ts`

**Step 1: Write minimal documentation**

- Mark `parallelLimit` as manual tuning, not evolution-managed.
- Remove evolution examples that write `parallelLimit`.

**Step 2: Verify**

Run: `npm run test:smoke`
