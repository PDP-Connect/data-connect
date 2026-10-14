-- @terminator: exec_one
-- A database-lifetime semantic provenance token. Do not delete this table's
-- rows during a records reset: reuse would permit an ABA publisher race.
INSERT INTO semantic_generation_clock DEFAULT VALUES
RETURNING generation
