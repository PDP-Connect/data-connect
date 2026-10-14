// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// EXPERIMENT ONLY - not a supported configuration knob.
//
// The reference server's interactive Postgres pool is a hard-coded constant
// (POSTGRES_INTERACTIVE_POOL_MAX = 8 in
// reference-implementation/server/postgres-storage.ts); no env var sets it.
// To measure what a larger pool would buy without editing server code, this
// preload wraps node-postgres' Pool so any pool created with max=8 gets
// VACUNA_PG_POOL_MAX instead. The bulk lane (max=3) is left alone.
//
//   VACUNA_PG_POOL_MAX=32 \
//   VACUNA_NODE_FLAGS="--import ./experiment-pool-override.ts" ./start-server.sh

import { createRequire } from "node:module";

const override = Number.parseInt(process.env.VACUNA_PG_POOL_MAX || "", 10);
const INTERACTIVE_DEFAULT = 8;

if (Number.isFinite(override) && override > 0) {
  // Resolve pg exactly as the server does, then patch the CommonJS export
  // before the server's ESM import builds its named-export facade.
  const require = createRequire(new URL("../../../reference-implementation/server/index.ts", import.meta.url));
  const pg = require("pg") as { Pool: new (config?: Record<string, unknown>) => unknown };
  const OriginalPool = pg.Pool;
  class OverriddenPool extends (OriginalPool as new (config?: Record<string, unknown>) => object) {
    constructor(config: Record<string, unknown> = {}) {
      const max = config.max === INTERACTIVE_DEFAULT ? override : config.max;
      super({ ...config, max });
    }
  }
  pg.Pool = OverriddenPool as typeof pg.Pool;
  console.log(`[experiment] interactive pg pool max ${INTERACTIVE_DEFAULT} -> ${override}`);
}
