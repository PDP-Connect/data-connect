# devspecs feedback

## 2026-09-03 — DB bloat repair

`ds task "fix PostgreSQL storage bloat" --slice ...` waited at “Task index preflight: waiting for another index update” for more than 30 seconds and never produced a task slice. The command gave no owner, timeout, or recovery action, so I continued with the repository brief and targeted tests. A bounded wait plus a suggested retry/status command would make this easier to use during incident work.
