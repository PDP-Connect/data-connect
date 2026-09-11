-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: grant_package_members
-- @max_rows: 256
-- The ACTIVE members of ONE grant package, ONE PAGE AT A TIME.
--
-- KEYSET-PAGED for the same reason as list-all-by-package.sql: membership has
-- no enforced ceiling, so a declared 256 was an assumption rather than an
-- invariant. This read backs the MCP token fan-out and package revocation
-- cascade, so an oversized package previously broke token access and left a
-- revocation unable to enumerate what it had to revoke.
--
-- The keyset is the COMPOSITE (added_at, grant_id), matching ORDER BY: members
-- issued in one transaction share an added_at, so grant_id breaks the tie and
-- makes the ordering total.
SELECT gm.package_id, gm.grant_id, gm.token_id, gm.source_json, gm.status, gm.added_at, gm.revoked_at,
       g.status AS grant_status, g.grant_json, g.storage_binding_json,
       g.grant_id AS persisted_grant_id, g.subject_id AS grant_subject_id,
       g.client_id AS grant_client_id, g.access_mode AS grant_access_mode,
       g.expires_at AS grant_expires_at,
       t.grant_id AS token_grant_id, t.subject_id AS token_subject_id,
       t.client_id AS token_client_id, t.revoked AS token_revoked,
       t.expires_at AS token_expires_at
FROM grant_package_members gm
JOIN grants g ON gm.grant_id = g.grant_id
JOIN tokens t ON gm.token_id = t.token_id
WHERE gm.package_id = ?
  AND gm.status = 'active'
  AND (gm.added_at > ? OR (gm.added_at = ? AND gm.grant_id > ?))
ORDER BY gm.added_at, gm.grant_id
LIMIT 256
