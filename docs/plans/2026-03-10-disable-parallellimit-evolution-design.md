# Disable ParallelLimit Evolution Design

## Goal

Prevent FlowPilot's automatic evolution pipeline from ever generating, applying, or reintroducing `parallelLimit`.

## Why

The user wants throughput-first execution with no automatic concurrency cap. Today, `.flowpilot/config.json` can be created or rewritten by history analysis and evolution, and the evolution layer can propose or apply `parallelLimit` changes. That can silently reintroduce a cap even after the user removes it.

## Chosen Approach

- Treat `parallelLimit` as a manual operator setting only.
- Automatic history analysis may still suggest other parameters such as `maxRetries`.
- `reflect` / `experiment` / manual `evolve` must ignore `parallelLimit`.
- Keep reading `parallelLimit` in runtime config if the operator sets it manually.

## Scope

- Remove automatic proposal of `parallelLimit` from reflect/rule analysis.
- Remove `parallelLimit` from config actions the experiment engine can parse/apply.
- Update tests and docs to reflect that `parallelLimit` is no longer evolution-managed.
