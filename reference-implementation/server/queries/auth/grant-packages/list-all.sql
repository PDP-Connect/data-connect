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
     WHERE gpm.package_id = gp.package_id) AS member_count
-- The package's reported lifecycle needs its member deadlines, but they are
-- deliberately NOT reduced here. `grants.expires_at` is TEXT, so a SQL
-- MAX() over it is a LEXICOGRAPHIC max, not a chronological one: a member
-- stored as '2026-09-08T02:00:00+05:00' sorts after '2026-09-08T01:00:00Z'
-- while being the EARLIER instant. Reducing in SQL therefore disagreed with
-- the detail route, which parses every member deadline. The rows are fetched
-- separately (authGrantPackageMemberExpiriesByPackage) and reduced by the
-- same shared function both routes use. See server/grant-lifecycle.ts.
FROM grant_packages gp
ORDER BY gp.created_at DESC, gp.package_id DESC
