-- @terminator: exec
INSERT INTO provider_app_config(identity_group, logical_key, sealed_value, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(identity_group, logical_key) DO NOTHING;
