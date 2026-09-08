-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: grant_packages
-- @max_rows: 1024
SELECT
  gp.package_id,
  gp.subject_id,
  gp.client_id,
  gp.status,
  gp.package_json,
  gp.parent_package_id,
  gp.trace_id,
  gp.scenario_id,
  gp.created_at,
  gp.approved_at,
  gp.revoked_at,
  (SELECT COUNT(*)
     FROM grant_package_members gpm
     WHERE gpm.package_id = gp.package_id) AS member_count,
  -- Reported lifecycle needs the package's deadline, and a package has no
  -- `expires_at` column of its own: its deadline is the LAST one any member
  -- grant carries. Derivation happens in JS (server/grant-lifecycle.ts) so
  -- SQLite and Postgres judge against the same clock, not each engine's own.
  (SELECT COUNT(*)
     FROM grant_package_members gpm
     JOIN grants g ON gpm.grant_id = g.grant_id
     WHERE gpm.package_id = gp.package_id
       AND g.expires_at IS NULL) AS unbounded_member_count,
  (SELECT MAX(g.expires_at)
     FROM grant_package_members gpm
     JOIN grants g ON gpm.grant_id = g.grant_id
     WHERE gpm.package_id = gp.package_id) AS latest_member_expires_at
FROM grant_packages gp
ORDER BY gp.created_at DESC, gp.package_id DESC
