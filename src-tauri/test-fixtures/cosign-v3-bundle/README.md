# cosign v3 bundle fixtures

Two independently sourced fixture sets, used for different parts of the
cosign v3-default Sigstore bundle path.

## Wire-shape fixtures: `tag-index.json`, `inner-manifest.json`, `bundle-blob.json`

Captured against a live `registry:3.1.1` container, from a real `oras push`
followed by a real `cosign sign --key ... --yes` run with cosign v3.1.3, on
2026-09-23, by the data-connectors publish-workflow migration
(PDP-Connect/data-connectors#148,
<https://github.com/PDP-Connect/data-connectors/pull/148>). Copied verbatim
from that PR's
`packages/connector-installer-core/test-fixtures/cosign-v3-bundle/`, where
the original README explains why they are captured bytes rather than
hand-written: an earlier revision of that PR's own fixture-building code
encoded the same misunderstanding the production code had (that the
`sha256-<hex>` fallback tag resolves directly to the bundle manifest), so a
hand-rolled fixture could not catch that bug — only bytes a real client
actually received could.

- `tag-index.json` — `GET /v2/<repo>/manifests/sha256-<hex>` (the fallback
  tag, no `.sig` suffix). An OCI image index, NOT the bundle manifest.
- `inner-manifest.json` — the manifest one of `tag-index.json`'s descriptors
  points at, fetched by digest. Carries `subject` (naming the signed
  artifact) and one layer (the bundle itself).
- `bundle-blob.json` — the layer blob, fetched by digest. A Sigstore
  protobuf bundle (`verificationMaterial` + `dsseEnvelope`), key-based
  (`publicKey.hint`, not a Fulcio certificate) since it was signed
  key-locally rather than through a real Actions OIDC token.

All digests inside these files are internally consistent with each other
(the index names the inner manifest's real digest; the inner manifest names
the blob's real digest; the inner manifest's `subject` names the real signed
artifact's digest) but do not correspond to any artifact that still exists.

These fixtures exercise OCI-side plumbing only (index parsing, subject-digest
cross-check, referrer selection): `bundle-blob.json` is **key-based**
(`verificationMaterial.publicKey`), and the `sigstore` crate 0.14.0's
`CheckedBundle::try_from(Bundle)` only accepts `X509CertificateChain` or
`Certificate` verification material — it returns
`BundleErrorKind::VerificationMaterialContentUnsupported` for `PublicKey`.
This is a real, currently-unclosed gap in the crate (see the module doc
comment on `oci_verify.rs` and the PR description this fixture set's tests
are attached to). This fixture cannot be run through
`sigstore::bundle::verify::Verifier` for that reason; the tests using it stop
at "the bundle is fetched, structurally parsed, and rejected as
unverifiable" rather than a full end-to-end Sigstore verification.

## Cryptographic fixture: `fulcio-real-bundle-v03.json`

Copied verbatim from the `sigstore` crate's own test suite
(`sigstore` 0.14.0, `tests/data/bundle_v03.json`,
<https://crates.io/crates/sigstore/0.14.0>, Apache-2.0). A real,
Fulcio-issued, Rekor-logged cosign v0.3 DSSE bundle: GitHub Actions OIDC
keyless signing over `kubewarden/kubewarden-controller` release v1.34.0,
publicly verifiable against the production Sigstore trust root. Used here to
prove the actual cryptographic path this feature depends on — DSSE PAE
verification, Fulcio chain + SCT, Rekor tlog consistency, and pinned-identity
policy enforcement — because no real Fulcio-signed v3 bundle exists yet for
any PDP-Connect connector (data-connectors#148 has so far only produced the
key-based fixture above).

The signing identity embedded in the leaf certificate is
`https://github.com/kubewarden/kubewarden-controller/.github/workflows/release.yml@refs/tags/v1.34.0`
issued by `https://token.actions.githubusercontent.com`; the in-toto
statement's subject digest is
`c811d58de79c92f03214e63aa339484e488d694ae8a6283b5f3f17a9faf50172`. Tests
using this fixture pin the identity policy to these real values (the same
pattern the legacy `.sig` tests use with the captured `ynab` signature),
not to `DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY`, and reuse the offline
Sigstore trust root already vendored at `../sigstore-trusted-root.json`
(the same public-good root that issued this certificate).

`fulcio-real-manifest-v134.json` is the preimage this bundle actually signed
— fetched 2026-09-23 from the still-public
`GET https://ghcr.io/v2/kubewarden/kubewarden-controller/manifests/sha256:c811d58de79c92f03214e63aa339484e488d694ae8a6283b5f3f17a9faf50172`
(anonymous pull, `Accept: application/vnd.oci.image.index.v1+json`) — an OCI
image index whose SHA-256 is exactly the DSSE statement's subject digest.
Verified locally with `sha256sum` before being committed. Having the real
preimage, rather than an arbitrary stand-in, is what lets a test drive the
full `sigstore::bundle::verify::Verifier::verify_digest` path (Fulcio chain,
SCT, DSSE PAE signature, Rekor tlog consistency, and the subject-digest
comparison) end-to-end against a genuine cosign v3 bundle, not just the
structural (`CheckedBundle::try_from`) layer the crate's own unit tests stop
at.
