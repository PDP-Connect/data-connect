-- @terminator: exec
INSERT INTO web_push_vapid_keys(singleton, public_key, sealed_private_key, created_at)
VALUES(1, ?, ?, ?)
ON CONFLICT(singleton) DO NOTHING
