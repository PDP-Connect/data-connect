# apps/console (Move B receiving dock — placeholder)

Empty on purpose. This directory exists so Move B's filter-repo import
(`git filter-repo --path apps/console/ ...` from pdpp, see
`EXECUTION-PLAN.md` Phase 1.4/2.2) lands as a clean import onto an
already-scoped location, not a simultaneous scaffolding-plus-content change.

This introduces an `apps/` top-level convention that does not otherwise
exist in this repo today (this repo's own frontend lives at the repo root:
`src/`, `index.html`). That is a deliberate, visible scope decision this
placeholder makes concrete — flag it for owner review alongside the other
Phase 1.3 verification-gate items, since it is new top-level repo structure,
not just an empty directory.

Do not add real code here before Move B executes. Remove this README when
Move B's content lands.
