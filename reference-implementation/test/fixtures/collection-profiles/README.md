# Collection Profile fixtures

Each file is the `profile/collection-profile.json` layer of a signed Collection
Profile artifact, copied byte-for-byte after the reference implementation's
verified installer (`server/connector-install/`, OCI + Sigstore) installed it
from `ghcr.io/pdp-connect/connector/<key>`:

| File | Version | OCI digest |
| --- | --- | --- |
| `github.json` | 0.5.1 | `sha256:7820fdc3099f75b5f9ef76527b433e69ad2cfc57e01daad9260b24f1f39e4311` |
| `gmail.json` | 0.2.0 | `sha256:46d8578ea0fa756326961210f2dac185eb2770807bea0bf9b18bbdcb69f08a0b` |
| `ical.json` | 0.1.0 | `sha256:37fd34b2aed46136955a340a080ba04e2706c2c92dd1590ff7e08e736c695047` |
| `ynab.json` | 0.3.0 | `sha256:9da6a382500368ef28a8c9f59351d1f3ab6871297bf27418c7c63e8d9e241fad` |
| `whatsapp-web.json` | 0.1.10 | `sha256:ea55503e3841793a4709beecd271619fe5f8c362d5caff8a26c0c93650dc011a` |

Tests install them with `test/helpers/installed-collection-profiles.ts`, which
writes an install root with a placeholder entrypoint. They prove how the
reference implementation discovers installed profiles by manifest. They do not
exercise connector code.

`whatsapp-web.json` is the profile layer of that artifact (layer digest
`sha256:dea0bf17cfc0322f26727faf01a92e9dfa394f3ee1853388e817f1281bfddbf9`),
fetched from the public registry. It is the version whose required `browser`
and `network` features the runtime refused before it advertised any feature.

`catalog-feature-bindings.json` is not a profile. It is the
`runtime_requirements.bindings` of every connector manifest on
`PDP-Connect/data-connectors` main that declares a binding feature, at the
commit named in its `source` member. `collection-profile-binding-features.test.ts`
places each one. Regenerate it when the catalog's declarations change.

`artifacts/ical-0.1.0.tgz` is the full installed layout of the ical 0.1.0
artifact above (profile, bundled `dist/collection-profile.mjs`, provenance,
licences, assets), archived after the verified installer installed it.
`test/installed-artifact-run.test.ts` installs it, checks its bytes against the
recorded signed digests, and runs the bundled connector end to end.
