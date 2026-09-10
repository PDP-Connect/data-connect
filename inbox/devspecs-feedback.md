# devspecs feedback

## 2026-09-03 — DB bloat repair

`ds task "fix PostgreSQL storage bloat" --slice ...` waited at “Task index preflight: waiting for another index update” for more than 30 seconds and never produced a task slice. The command gave no owner, timeout, or recovery action, so I continued with the repository brief and targeted tests. A bounded wait plus a suggested retry/status command would make this easier to use during incident work.

## 2026-09-09 — Concurrent blob cleanup repair

`ds recent` completed in about six seconds and identified the existing reconciliation-bloat change and its files. `ds task "preserve shared PostgreSQL blobs during concurrent connector deletion" --quick` discovered 3,537 files, then stayed at “extracting and indexing artifacts” for over four minutes without producing a task. I stopped that invocation and continued from the lane brief and PostgreSQL regression tests. A quick task still needs a bounded path that can use known file paths without a full index.
