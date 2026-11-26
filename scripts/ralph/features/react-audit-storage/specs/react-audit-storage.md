# React Audit Fixes (Storage + Vercel Patterns)

## Source

- a source doc since removed from the tree (see git history)

## Goals

- Fix high-impact React correctness issues
- Make storage access deterministic, validated, and scalable
- Reduce avoidable render churn and async waterfalls

## Constraints

- React frontend only (`src/`)
- Preserve existing styles and classes
- Don’t overwrite existing comments
- No UX changes beyond fixes called out in the audit

## Acceptance criteria

- Rickroll data is deterministic per session/render (no per-render randomness)
- Connected apps storage avoids full key scans and uses explicit versioning
- Deep-link JSON parsing is guarded and validates scopes shape
- BrowserSetup interval/listener cleanup is robust on unmount
- `recentlyCompleted` derived state is memoized, not effect-stored
- Platform + Settings fetches are parallelized where independent
