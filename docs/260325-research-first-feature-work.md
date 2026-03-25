# Research-First Feature Work

This is a lightweight process for unfamiliar or high-risk work.

The goal is simple: define what must be true before implementation starts.

## When to use this

Use this approach when:

- the domain is new
- the feature touches release, signing, native runtime, or secrets
- the work spans multiple layers
- failure will be expensive to debug later

Examples:

- adding auto-update to a Tauri app
- changing auth/session handoff
- introducing a new release or packaging path

## Core rule

Before writing code, answer:

`How will we know this is correct?`

If that answer is still vague, implementation is too early.

## Recommended order

1. Research the external contract.
2. Write down the non-negotiables.
3. Turn them into a small contract/eval pack.
4. Split the work into buckets.
5. List unknowns explicitly.
6. Implement against the eval pack.
7. Finish with a proof run.

## Step 1: Research the external contract

Start with the source-of-truth inputs only.

Capture:

- required files and artifacts
- runtime and platform constraints
- secret and signing requirements
- user-visible behavior
- release-path behavior
- proof requirements

Do not mix in prior implementation history unless the task explicitly allows it.

## Step 2: Write down the non-negotiables

Write facts, not ideas.

Good:

- `latest.json` must publish both macOS updater targets
- updater runtime is macOS-only
- local native verification must bootstrap generated sidecar resources first

Bad:

- create a helper script for packaging
- maybe keep updater state in the seam

## Step 3: Turn the facts into a contract/eval pack

For each contract, define:

- contract
- invariant
- eval type
- fixture
- oracle
- why this exists

This forces correctness to become concrete.

## Step 4: Split the work into buckets

Use buckets so the problem stays legible.

Default buckets:

- pure transform
- runtime seam
- hook/state machine
- workflow/config
- proof run

These buckets often imply the code structure.

## Step 5: Keep an explicit unknowns list

Any missing decision should be written down before coding.

If the docs do not decide something important:

- stop
- surface the contradiction or gap
- get a decision

Do not silently invent behavior.

## Step 6: Implement against the eval pack

Use the eval pack as the implementation plan.

That usually means:

- build the pure transforms first
- wire config and workflow next
- isolate the runtime seam
- implement the state machine after the seam contract is clear
- keep tests aligned to the contract, not to incidental implementation details

## Step 7: End with a proof run

A proof run should validate the actual scary path, not just unit tests.

Examples:

- a real release publishes the expected artifacts
- a real older build upgrades to the new one
- local native verification works from a cold checkout with required bootstrap steps

## Practical checklist

Before coding, confirm:

- I know the source-of-truth docs
- I know the external contract
- I know the failure conditions
- I know the proof path
- I know which unknowns still need decisions

Before merging, confirm:

- each important contract has an eval
- workflow behavior is tested, not assumed
- native/runtime branches are covered
- proof steps are documented

## Why this helps

This reduces:

- improvisation
- accidental scope growth
- hidden design decisions
- release-path surprises
- code written just to discover the problem shape

In practice, it makes the work feel smoother because the design pressure is handled before implementation.
