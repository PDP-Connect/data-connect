# @pdpp/reference-contract — temporary vendored stand-in

This is **not** the real `@pdpp/reference-contract` package. The real package is
the neutral, publishable contract package that stays in the `pdpp` monorepo and
is slated for its own npm publication (decision D-22 in `pdpp`'s reorg decision
log). It is much larger than what's here — this directory holds only the two
small, self-contained subtrees that `@pdpp/collector-runtime` and
`@pdpp/local-collector` compile directly against as vendored source:

- `src/common/` (also vendored, unmodified, into `local-collector`'s published
  tarball by that package's own `tsconfig.build.json`/`postbuild.ts`)
- `src/evidence/collection-scope.ts` + `src/evidence/named-collection-scope.ts`
  (used by one `local-collector` test for cross-package equivalence)

**Why this package.json exists at all:** `collector-runtime/src/local-device-client.ts`
imports the bare specifier `@pdpp/reference-contract/common`, exactly as it does
in the pdpp monorepo, where a workspace-linked real `@pdpp/reference-contract`
package resolves it. This stand-in exists purely so that bare specifier keeps
resolving under npm workspaces here too, with **zero import-site changes**
required now or when the real package is adopted later.

**Do not add code here.** When the real `@pdpp/reference-contract` publishes
from the `pdpp` repo, delete this directory and change
`collector-runtime/package.json`'s dependency to the real published version —
no source file in this repo should need to change, since the import path
(`@pdpp/reference-contract/common`) is already the real package's own public
export path.
