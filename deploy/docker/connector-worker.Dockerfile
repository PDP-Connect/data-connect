# Input context is staged by worker-image-builder.ts, never a connector directory.
ARG NODE_BASE
FROM ${NODE_BASE} AS runtime
FROM scratch
# Preserve the proven runtime rootfs, but deliberately discard all image config.
# This includes Debian, npm, yarn and shell executables; it is not a minimal rootfs.
COPY --from=runtime / /
COPY bootstrap.mjs /worker/bootstrap.mjs
COPY code/ /worker/code/
USER 65532:65532
WORKDIR /worker/code
ENTRYPOINT ["/usr/local/bin/node", "/worker/bootstrap.mjs"]
