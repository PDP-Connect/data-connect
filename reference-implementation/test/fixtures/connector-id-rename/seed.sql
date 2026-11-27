-- Rows applied to a store that DataConnect v0.9.9's initDb created.
-- Releases before the manifest-key rename wrote the four underscore ids
-- (apple_photos, claude_code, google_messages, google_takeout); v0.9.9 still
-- read them through aliases and wrote the current ids for new rows, so an
-- upgraded store can hold both spellings, including under the same key.
-- Values are synthetic.

-- connectors: old ids alone, and one old id that collides with its current id.
INSERT INTO connectors (connector_id, manifest, created_at) VALUES
  ('google_takeout', '{"connector_id":"google_takeout","display_name":"google_takeout","streams":[]}', '2026-07-01T00:00:00.000Z'),
  ('apple_photos', '{"connector_id":"apple_photos","display_name":"apple_photos","streams":[]}', '2026-07-01T00:00:00.000Z'),
  ('claude_code', '{"connector_id":"claude_code","display_name":"old manifest","streams":[]}', '2026-07-01T00:00:00.000Z'),
  ('claude-code', '{"connector_id":"claude-code","display_name":"current manifest","streams":[]}', '2026-11-01T00:00:00.000Z');

INSERT INTO connector_installs (connector_id, record_json, updated_at) VALUES
  ('apple_photos', '{"source":"old"}', '2026-07-01T00:00:00.000Z');

INSERT INTO connector_accepted_declarations (connector_id, declaration_version, content_digest) VALUES
  ('google_messages', '1', 'sha256:old-messages');

-- dataset_summary_stream_projection: a collision on (connector_id, stream) and a lone old row.
INSERT INTO dataset_summary_stream_projection (connector_id, stream, record_count, computed_at) VALUES
  ('claude_code', 'sessions', 7, '2026-07-01T00:00:00.000Z'),
  ('claude-code', 'sessions', 9, '2026-11-01T00:00:00.000Z'),
  ('claude_code', 'messages', 3, '2026-07-01T00:00:00.000Z');

-- A connection and its owner data under the old id.
INSERT INTO connector_instances
  (connector_instance_id, owner_subject_id, connector_id, display_name, source_kind, source_binding_key, created_at, updated_at)
VALUES
  ('cin_old_claude', 'owner_local', 'claude_code', 'claude_code', 'local_device', 'binding-claude', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
  ('cin_old_photos', 'owner_local', 'apple_photos', 'My photos', 'local_device', 'binding-photos', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');

INSERT INTO connector_state (connector_id, connector_instance_id, stream, state_json, updated_at) VALUES
  ('claude_code', 'cin_old_claude', 'sessions', '{"cursor":"c1"}', '2026-07-01T00:00:00.000Z');

INSERT INTO records (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, version) VALUES
  ('claude_code', 'cin_old_claude', 'sessions', 's1', '{"id":"s1"}', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1),
  ('claude_code', 'cin_old_claude', 'sessions', 's2', '{"id":"s2"}', '2026-07-01T00:00:01.000Z', '2026-07-01T00:00:01.000Z', 2),
  ('claude_code', 'cin_old_claude', 'messages', 'm1', '{"id":"m1"}', '2026-07-01T00:00:02.000Z', '2026-07-01T00:00:02.000Z', 1),
  ('apple_photos', 'cin_old_photos', 'photos', 'p1', '{"id":"p1"}', '2026-07-01T00:00:03.000Z', '2026-07-01T00:00:03.000Z', 1);

INSERT INTO record_changes (connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at) VALUES
  ('claude_code', 'cin_old_claude', 'sessions', 's1', 1, '{"id":"s1"}', '2026-07-01T00:00:00.000Z'),
  ('claude_code', 'cin_old_claude', 'sessions', 's2', 2, '{"id":"s2"}', '2026-07-01T00:00:01.000Z'),
  ('claude_code', 'cin_old_claude', 'messages', 'm1', 1, '{"id":"m1"}', '2026-07-01T00:00:02.000Z'),
  ('apple_photos', 'cin_old_photos', 'photos', 'p1', 1, '{"id":"p1"}', '2026-07-01T00:00:03.000Z');

INSERT INTO version_counter (connector_id, connector_instance_id, stream, max_version) VALUES
  ('claude_code', 'cin_old_claude', 'sessions', 2),
  ('claude_code', 'cin_old_claude', 'messages', 1),
  ('apple_photos', 'cin_old_photos', 'photos', 1);

INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, started_at) VALUES
  ('run_old_1', 'cin_old_claude', 'claude_code', '{}', 'succeeded', '2026-07-01T00:00:00.000Z');

INSERT INTO device_enrollment_codes (enrollment_code_id, code_hash, owner_subject_id, connector_id, local_binding_id, created_at, expires_at) VALUES
  ('enr_old_1', 'hash-old-1', 'owner_local', 'google_messages', 'binding-messages', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z');
