# Docker Core OAuth fixture

`docker-core-smoke-cimd.json` and its paired PEM contain a generated, public
smoke-test RSA key. The client metadata document is fetched from the PR branch
at a fixed `raw.githubusercontent.com` URL, so the container exercises the
normal external CIMD fetch and `private_key_jwt` validation paths. The loopback
redirect is intercepted by the in-container Playwright test. The key has never
been used outside this fixture and is not a credential.

Refresh owner: DataConnect maintainers. Regenerate the pair if the fixture is
used outside automated smoke runs.
