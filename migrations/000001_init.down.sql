DROP TABLE IF EXISTS merge_suggestions;
DROP TABLE IF EXISTS raw_to_canonical;
DROP TABLE IF EXISTS canonical_entities;
DROP TABLE IF EXISTS raw_records;
DROP TABLE IF EXISTS sources;
-- The vector extension is intentionally left installed: other schemas in the
-- same database may depend on it.
