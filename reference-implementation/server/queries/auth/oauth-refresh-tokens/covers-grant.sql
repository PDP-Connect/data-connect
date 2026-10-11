-- @terminator: one
SELECT 1
FROM oauth_refresh_tokens
WHERE grant_id = ?
   OR package_id IN (
     SELECT package_id FROM grant_package_members WHERE grant_id = ?
   )
LIMIT 1
