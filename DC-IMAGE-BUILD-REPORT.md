# DataConnect hosted-image build report

## Root cause

The failed build was caused by host disk exhaustion, not by vendored-package
lookup or `PATCHRIGHT_VERSION` extraction. The host had about 2 GB free when
the failure occurred. In `/tmp/build-dc-57d94999.log`, the extraction completed:
`npm install` added the selected Patchright package. The following
`npx patchright install --with-deps chromium` then failed while Debian `apt`
reported invalid repository signatures, a failure consistent with the constrained
disk available for its package-list and temporary-file writes.

No branch drift caused the failure. `git diff a72cb53a8..57d949997 -- deploy vendor`
is empty; the Dockerfile and
`reference-implementation/vendor/pdpp-polyfill-connectors-0.0.1.tgz` are
byte-identical to the proven main revision. The tarball exists and declares
the exact dependency `patchright: 1.61.1`.

## Fix

No Dockerfile, build-script, or vendored-tarball change was needed. After
`docker builder prune -f` reclaimed 10.06 GB of unused build cache (25 GB free
before the rerun), the original Dockerfile built successfully.

## Evidence

The required command completed successfully:

```sh
docker build --target core --build-arg PDPP_REFERENCE_REVISION=$(git rev-parse HEAD) --tag pdpp-banner-zero:data-connect-57d94999 --file deploy/docker/Dockerfile .
```

Final build-log tail from `/tmp/build-dc-57d94999-rerun.log`:

```text
#35 [reference-browser 1/1] COPY --from=source /app /app
#35 DONE 12.8s
#36 exporting to image
#36 exporting layers 5.6s done
#36 writing image sha256:449350fb1249d63c60031b33ee7b138698f2e82acaf86a8679296600194e0272 done
#36 naming to docker.io/library/pdpp-banner-zero:data-connect-57d94999 0.0s done
#36 DONE 5.7s
```

Image ID: `sha256:449350fb1249d63c60031b33ee7b138698f2e82acaf86a8679296600194e0272`.

Runtime check:

```text
$ docker run --rm pdpp-banner-zero:data-connect-57d94999 node -e "console.log(process.version)"
v24.19.0
```

Server boot proof used disposable local-only values for its required production
startup guards, then stopped and removed the proof container. It stayed running
and logged:

```text
authorization server listening (port 17662)
resource server listening (port 17663)
running=true status=running exit=0
```
