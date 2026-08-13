-- Enable pgvector extension for embedding similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Table for tracking imported files/sources
CREATE TABLE IF NOT EXISTS sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    source_type VARCHAR(50) NOT NULL, -- 'drive_sheets' or 'local_upload'
    external_file_id VARCHAR(255),
    organization_id VARCHAR(100) NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table for raw source records (never deleted or overwritten)
CREATE TABLE IF NOT EXISTS raw_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    raw_data JSONB NOT NULL,
    event_name VARCHAR(255),
    event_date VARCHAR(100),
    full_name VARCHAR(255),
    organization VARCHAR(255),
    role_title VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(100),
    notes TEXT,
    normalized_text TEXT NOT NULL,
    embedding vector(768), -- Vertex AI textembedding-gecko / text-embedding-004
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS raw_records_embedding_idx ON raw_records 
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Table for canonical merged entities (people & organizations)
CREATE TABLE IF NOT EXISTS canonical_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL DEFAULT 'person', -- 'person' or 'organization'
    display_name VARCHAR(255) NOT NULL,
    primary_email VARCHAR(255),
    primary_phone VARCHAR(100),
    primary_organization VARCHAR(255),
    primary_role VARCHAR(255),
    event_count INT NOT NULL DEFAULT 1,
    source_file_count INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Mapping table linking raw records to canonical entities
CREATE TABLE IF NOT EXISTS raw_to_canonical (
    raw_record_id UUID NOT NULL REFERENCES raw_records(id) ON DELETE CASCADE,
    canonical_entity_id UUID NOT NULL REFERENCES canonical_entities(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (raw_record_id, canonical_entity_id)
);

-- Table for LLM-adjudicated merge suggestions
CREATE TABLE IF NOT EXISTS merge_suggestions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id VARCHAR(100) NOT NULL,
    canonical_entity_id UUID NOT NULL REFERENCES canonical_entities(id) ON DELETE CASCADE,
    candidate_raw_record_id UUID NOT NULL REFERENCES raw_records(id) ON DELETE CASCADE,
    confidence_score FLOAT NOT NULL,
    reasoning TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merge_suggestions_org_status ON merge_suggestions(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_canonical_entities_org ON canonical_entities(organization_id);
