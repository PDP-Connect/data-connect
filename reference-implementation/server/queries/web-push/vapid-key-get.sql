-- @terminator: one
SELECT public_key, sealed_private_key
FROM web_push_vapid_keys
WHERE singleton = 1
LIMIT 1
