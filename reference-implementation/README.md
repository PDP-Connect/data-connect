# reference-implementation (Move B receiving dock — placeholder)

Empty on purpose. This directory exists so Move B's filter-repo import
(`git filter-repo --path reference-implementation/ ...` from pdpp, see
`EXECUTION-PLAN.md` Phase 1.4/2.2) lands as a clean import onto an
already-scoped location, not a simultaneous scaffolding-plus-content change.

`.github/workflows/reference-implementation.yml` (drafted in this same PR)
already targets this path — until real content lands here, that workflow's
`classify` job always resolves `reference_impacting=false` and is a
structural no-op.

Do not add real code here before Move B executes. Remove this README when
Move B's content lands.
