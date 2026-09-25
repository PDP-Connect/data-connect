# Docker Core OAuth fixture

`docker-core-smoke-cimd.json` and its paired PEM contain a generated, public
smoke-test RSA key. The smoke's TLS ingress serves the client metadata document from the checkout
under test at `https://cimd.pdpp-smoke.test/`, so the container exercises the
normal external CIMD fetch, SSRF guard and `private_key_jwt` validation paths
without depending on any branch or network service. The loopback
redirect is intercepted by the in-container Playwright test. The key has never
been used outside this fixture and is not a credential.

Refresh owner: DataConnect maintainers. Regenerate the pair if the fixture is
used outside automated smoke runs.
