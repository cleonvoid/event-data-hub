-- Event Data Hub — initial schema
--
-- Design notes:
--  * Raw records are append-only. Canonical entities are a DERIVED view on top of
--    them, linked through raw_to_canonical. Nothing here ever mutates raw data.
--  * Counts (events / source files) are NOT stored as columns. Stored counters
--    drift the moment a merge is approved or undone, so they are computed from
--    raw_to_canonical at query time.
--  * Both raw records and canonical entities carry an embedding. Stage 1 of
--    entity resolution searches canonical_entities directly (one row per real
--    entity) rather than fanning out over every linked raw record.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Sources: one row per imported spreadsheet (Drive/Sheets file or local upload)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  TEXT NOT NULL,
    name             TEXT NOT NULL,
    -- 'google_sheets' | 'google_drive_xlsx' | 'local_upload'
    source_type      TEXT NOT NULL,
    external_file_id TEXT,
    imported_by      TEXT,
    imported_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The confirmed column mapping actually used for this import, kept for audit
    field_mapping    JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_sources_org ON sources (organization_id, imported_at DESC);

-- ---------------------------------------------------------------------------
-- Raw records: append-only, one row per spreadsheet data row
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       UUID NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
    -- Denormalised from sources so every scoping query can filter without a join
    organization_id TEXT NOT NULL,
    row_number      INT  NOT NULL,
    -- The untouched original row, keyed by its original column headers
    raw_data        JSONB NOT NULL,
    full_name       TEXT,
    organization    TEXT,
    role_title      TEXT,
    email           TEXT,
    phone           TEXT,
    event_name      TEXT,
    -- event_date_raw preserves whatever the spreadsheet actually said;
    -- event_date is the parsed value, NULL when the source format was unusable.
    event_date      DATE,
    event_date_raw  TEXT,
    notes           TEXT,
    -- "name | organization | role" normalised string that gets embedded
    normalized_text TEXT NOT NULL,
    embedding       VECTOR(768),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raw_records_org    ON raw_records (organization_id);
CREATE INDEX IF NOT EXISTS idx_raw_records_source ON raw_records (source_id);
CREATE INDEX IF NOT EXISTS idx_raw_records_email  ON raw_records (organization_id, LOWER(email))
    WHERE email IS NOT NULL AND email <> '';

-- ---------------------------------------------------------------------------
-- Canonical entities: the deduplicated view of people / organizations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_entities (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      TEXT NOT NULL,
    entity_type          TEXT NOT NULL DEFAULT 'person',  -- 'person' | 'organization'
    display_name         TEXT NOT NULL,
    primary_email        TEXT,
    primary_phone        TEXT,
    primary_organization TEXT,
    primary_role         TEXT,
    -- Centroid of every linked raw record's embedding. Recomputed on merge so
    -- Stage 1 retrieval keeps improving as an entity accumulates name variants.
    embedding            VECTOR(768),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canonical_org ON canonical_entities (organization_id);

-- HNSW rather than IVFFlat: IVFFlat needs a populated table to train its lists,
-- so an index built at migration time on an empty table degrades to a scan.
-- HNSW builds incrementally and is correct from the first insert.
CREATE INDEX IF NOT EXISTS idx_canonical_embedding
    ON canonical_entities USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_raw_records_embedding
    ON raw_records USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Link table: which raw records make up which canonical entity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_to_canonical (
    raw_record_id       UUID NOT NULL REFERENCES raw_records (id) ON DELETE CASCADE,
    canonical_entity_id UUID NOT NULL REFERENCES canonical_entities (id) ON DELETE CASCADE,
    organization_id     TEXT NOT NULL,
    -- 'seed' when the record created the entity, 'approved_merge' when a human
    -- approved an LLM suggestion. Lets us audit how an entity was assembled.
    link_method         TEXT NOT NULL DEFAULT 'seed',
    linked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (raw_record_id, canonical_entity_id)
);

-- A raw record belongs to exactly one canonical entity at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_to_canonical_one_entity
    ON raw_to_canonical (raw_record_id);
CREATE INDEX IF NOT EXISTS idx_raw_to_canonical_entity
    ON raw_to_canonical (canonical_entity_id);

-- ---------------------------------------------------------------------------
-- Merge suggestions + the negative signal
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merge_suggestions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         TEXT NOT NULL,
    canonical_entity_id     UUID NOT NULL REFERENCES canonical_entities (id) ON DELETE CASCADE,
    candidate_raw_record_id UUID NOT NULL REFERENCES raw_records (id) ON DELETE CASCADE,
    -- Stage 1 output: cosine similarity in [0,1]
    vector_similarity       REAL NOT NULL,
    -- Stage 2 output: the model's own confidence in [0,1]
    llm_confidence          REAL NOT NULL,
    -- Blend of the two; see combineConfidence() for the weighting rationale
    combined_confidence     REAL NOT NULL,
    llm_verdict             BOOLEAN NOT NULL,
    reasoning               TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
    decided_at              TIMESTAMPTZ,
    decided_by              TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- THE NEGATIVE SIGNAL. One row per (entity, record) pair, ever. Once a human
-- rejects a pair the row survives with status='rejected', and re-suggesting it
-- is an ON CONFLICT DO NOTHING no-op — the same bad pair can never come back.
CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_suggestions_pair
    ON merge_suggestions (canonical_entity_id, candidate_raw_record_id);

CREATE INDEX IF NOT EXISTS idx_merge_suggestions_pending
    ON merge_suggestions (organization_id, status, combined_confidence DESC);
