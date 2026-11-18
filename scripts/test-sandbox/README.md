# test-sandbox (vendored)

`test-sandbox` runs one test command inside a transient systemd scope under the
shared `agent-tests.slice`, so every test run on a host shares one kernel-enforced
CPU, memory and task budget. With bubblewrap it also gets a loopback-only network,
a private PID namespace and a private `/tmp`. `--pg 16|18` starts a disposable
PostgreSQL cluster that dies with the run. Run it with no arguments for usage.

This file is a verbatim copy. The canonical source is
`ai/skills/local/test-architecture/scripts/test-sandbox` in Tim Nunamaker's
dotfiles, where its own test suite lives. Do not edit the copy here: change the
canonical file, run its tests, then copy it and refresh the digest:

```sh
cp <dotfiles>/ai/skills/local/test-architecture/scripts/test-sandbox scripts/test-sandbox/test-sandbox
(cd scripts/test-sandbox && sha256sum test-sandbox > test-sandbox.sha256)
```

`reference-implementation/scripts/test-sandbox-vendored.test.ts` fails when the
copy and `test-sandbox.sha256` disagree, so a local edit cannot pass CI unnoticed.

Without a systemd user manager or bubblewrap (macOS, most CI runners) the tool
runs the command with whatever enforcement is available and says so in its JSON
receipt (`"enforcement"`). `TEST_SANDBOX_REQUIRE=1` turns missing enforcement into
a failure; `TEST_SANDBOX_DISABLE=1` runs the command directly.
