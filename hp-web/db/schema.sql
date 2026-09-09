-- Prism web database schema (Postgres).
--
-- Fed by the desktop export bundle (JSONL of canonical BuildRecords) and the
-- submissions API. Implements the search + similarity tiers:
--   content identity         -> equality on content_hash
--   identical-file overlap   -> smlar/GIN Jaccard over file-hash sets
--   chunk similarity          -> LSH-banded MinHash over chunk sets
--   byte-shingle resemblance -> LSH-banded OPH over byte shingles
--   perceptual media         -> pHash Hamming / Chromaprint
--   exe binary similarity    -> imphash equality + TLSH
--   + filename FTS/fuzzy, exact hash lookup, text embedding (pgvector)

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy filename search
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector: text embedding ANN
-- CREATE EXTENSION IF NOT EXISTS smlar;  -- exact set similarity (identical-file overlap); build/install separately
CREATE EXTENSION IF NOT EXISTS intarray;  -- fallback array overlap if smlar unavailable

-- ── games ────────────────────────────────────────────────────────────────────
-- Shared classification: which game each build is a build of. Seeded from the
-- wiki {{Prototype}} infobox by scripts/import-wiki-games.ts, extended by
-- moderator edits (upsert by name+system). The same title on two systems is
-- two games, so identity is (name, system), '' system when unknown. slug is
-- the /games/<slug> segment (lib/slug.ts gameSlug, "-<id>" on collision).
-- ids are PER-DATABASE — cross-DB copies of builds rows must remap game_id
-- through (name, system), never raw ids.
CREATE TABLE games (
    id     BIGSERIAL PRIMARY KEY,
    name   TEXT NOT NULL,
    system TEXT NOT NULL DEFAULT '',
    slug   TEXT,
    UNIQUE (name, system)
);
CREATE UNIQUE INDEX games_slug_key ON games(slug);

-- ── builds ───────────────────────────────────────────────────────────────────
CREATE TABLE builds (
    sha256                TEXT PRIMARY KEY,         -- image identity / lookup key
    name                  TEXT NOT NULL,
    system                TEXT NOT NULL,
    size                  BIGINT NOT NULL,
    md5                   TEXT NOT NULL,
    sha1                  TEXT NOT NULL,
    content_hash          TEXT,                     -- content identity (NULL when no file hashes)
    filtered_content_hash TEXT,                     -- content identity (NULL when no file hashes)
    file_count            BIGINT NOT NULL,
    total_size            BIGINT NOT NULL,
    max_depth             INT NOT NULL DEFAULT 0,
    ext_histogram         JSONB NOT NULL DEFAULT '{}',
    text_doc              TEXT NOT NULL DEFAULT '',
    text_embedding        vector(384),              -- all-MiniLM-L6-v2, computed at ingest
    fingerprint_profile   TEXT NOT NULL,
    record                JSONB NOT NULL,           -- full canonical record
    ingested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    build_date            TEXT,                     -- volume creation date, else header release date (sortable copy)
    lot                   TEXT,                     -- moderator-assigned display group, e.g. "Sonic Month 2026"
    private               BOOLEAN NOT NULL DEFAULT FALSE, -- hidden from public list/search/similar (direct URL stays reachable)
    game_id               BIGINT REFERENCES games(id) -- which game this is a build of (wiki import / moderator)
);
CREATE INDEX idx_builds_content      ON builds(content_hash);
CREATE INDEX idx_builds_filtered     ON builds(filtered_content_hash);
CREATE INDEX idx_builds_system       ON builds(system);
CREATE INDEX idx_builds_name_lower   ON builds (lower(name));
CREATE INDEX idx_builds_name_trgm    ON builds USING gin (name gin_trgm_ops);
CREATE INDEX idx_builds_textdoc_fts  ON builds USING gin (to_tsvector('simple', text_doc));
CREATE INDEX idx_builds_embedding    ON builds USING hnsw (text_embedding vector_cosine_ops);
CREATE INDEX idx_builds_lot          ON builds(lot) WHERE lot IS NOT NULL;
CREATE INDEX idx_builds_game         ON builds(game_id) WHERE game_id IS NOT NULL;

-- Lots hidden from non-moderators; a build in a listed lot is hidden with it.
CREATE TABLE private_lots (
    lot TEXT PRIMARY KEY
);

-- ── files (per-build) — filename FTS/fuzzy + exact hash lookup ────────────────
CREATE TABLE files (
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    path         TEXT NOT NULL,
    name         TEXT NOT NULL,
    size         BIGINT,
    md5          TEXT,
    sha1         TEXT,
    sha256       TEXT
);
CREATE INDEX idx_files_build     ON files(build_sha256);
CREATE INDEX idx_files_name_trgm ON files USING gin (name gin_trgm_ops);
CREATE INDEX idx_files_sha1      ON files(sha1);
CREATE INDEX idx_files_md5       ON files(md5);
CREATE INDEX idx_files_sha256    ON files(sha256);

-- ── per-build extracted assets ────────────────────────────────────────────────
-- Metadata for the build page's inline asset viewer; the bytes live in the
-- content-addressed blob store on disk (ASSET_STORE_DIR), filled at ingest.
-- Browser-viewable files (images/audio/text ≤ 20MB) are stored whole; every
-- other file's first 2KB is stored raw (kind 'binary') for the hex view.
CREATE TABLE build_asset (
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    path         TEXT NOT NULL,           -- full path within the build (matches files.path)
    sha256       TEXT NOT NULL,           -- content hash = key into the blob store
    size         BIGINT NOT NULL,         -- stored blob size (a head snippet's, not the file's)
    mime         TEXT NOT NULL,           -- as served; text is always text/plain
    kind         TEXT NOT NULL,           -- image|audio|video|source|text|binary
    file_date    TEXT,                    -- the file's own timestamp from the record contents (month timeline)
    PRIMARY KEY (build_sha256, path)
);
CREATE INDEX idx_build_asset_sha256 ON build_asset(sha256);

-- ── attached source repositories ──────────────────────────────────────────────
-- VSS->git conversions attached manually by scripts/attach-repo.ts. The bytes
-- live in the asset store: every git blob content-addressed by sha256, plus a
-- JSON manifest blob (commits/trees/blobs — see src/lib/repo-manifest.ts)
-- named by manifest_sha256. Re-ingest never touches this table (ingestRecord
-- rewrites build_asset from the record; attached repos must survive).
CREATE TABLE build_repo (
    build_sha256    TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    name            TEXT NOT NULL,             -- URL segment; [A-Za-z0-9][A-Za-z0-9._-]{0,63}
    manifest_sha256 TEXT NOT NULL,             -- manifest blob in the asset store
    head_oid        TEXT NOT NULL,             -- denormalized for the build page card
    head_ref        TEXT,                      -- symbolic HEAD name, e.g. "master"
    commit_count    INT  NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (build_sha256, name)
);
CREATE INDEX idx_build_repo_manifest ON build_repo(manifest_sha256);

-- ── identical-file overlap (set of truncated file-content hashes) ─────
-- bigint[] of file sha1s truncated to 63 bits; smlar (or intarray &&) for Jaccard.
CREATE TABLE build_fileset (
    build_sha256 TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    hashes       BIGINT[] NOT NULL
);
CREATE INDEX idx_fileset_gin ON build_fileset USING gin (hashes);

-- Inverted copy of build_fileset (one row per (hash, build)). The shared-files
-- similarity tier probes this by hash: Postgres never uses the GIN index for
-- `hashes && $big_array` (its cost model prices arrayoverlap near zero and
-- seq-scans), which made the tier O(|query| x |candidate|) per row — minutes
-- for 40k-file builds. Probing (hash, build) pairs + counting is the same
-- Jaccard (c / (|A|+|B|-c)) at index speed.
CREATE TABLE fileset_entry (
    hash         BIGINT NOT NULL,
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_fileset_entry_hash  ON fileset_entry(hash, build_sha256);
CREATE INDEX idx_fileset_entry_build ON fileset_entry(build_sha256);

-- ── chunk similarity (MinHash + LSH bands) ──────────────────────────────────
CREATE TABLE build_chunk_signature (
    build_sha256 TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    minhash      BIGINT[] NOT NULL,   -- k-slot weighted-MinHash signature
    lsh_bands    BIGINT[] NOT NULL    -- b band hashes (candidate generation)
);
CREATE INDEX idx_chunk_signature_bands ON build_chunk_signature USING gin (lsh_bands);

-- ── byte-shingle resemblance (OPH MinHash + LSH bands) ─────────────────────────
-- Robust where chunk hashes collapse: many small *scattered* edits across a big file.
CREATE TABLE build_resemblance (
    build_sha256 TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    minhash      BIGINT[] NOT NULL,   -- k-slot OPH byte-shingle signature
    lsh_bands    BIGINT[] NOT NULL    -- b band hashes (candidate generation)
);
CREATE INDEX idx_resemblance_bands ON build_resemblance USING gin (lsh_bands);

-- raw chunk sets retained server-side (IDF re-weighting + media diff)
CREATE TABLE build_chunks (
    build_sha256 TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    chunks       BIGINT[] NOT NULL    -- per build (multiset); per-file in JSONB sidecar if needed
);
-- corpus chunk frequency for IDF / stop-chunk weighting (chunk similarity)
CREATE TABLE chunk_idf (
    chunk      BIGINT PRIMARY KEY,
    doc_count  BIGINT NOT NULL
);

-- ── perceptual media ───────────────────────────────────────────────────────────
CREATE TABLE media_fp (
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    path         TEXT NOT NULL,
    kind         TEXT NOT NULL,       -- image|audio
    phash        BIGINT,              -- 64-bit perceptual hash (images), Hamming distance
    chromaprint  TEXT                 -- compact audio fingerprint
);
CREATE INDEX idx_media_build ON media_fp(build_sha256);
CREATE INDEX idx_media_phash ON media_fp(phash);

-- audio acoustic fingerprint: a chroma sub-fingerprint set per CDDA track,
-- compared by Jaccard (GIN), same machinery as identical-file overlap.
CREATE TABLE audio_fp (
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    track        TEXT NOT NULL,
    subfp        BIGINT[] NOT NULL
);
CREATE INDEX idx_audio_build ON audio_fp(build_sha256);
CREATE INDEX idx_audio_gin   ON audio_fp USING gin (subfp);

-- corpus audio-hash frequency for IDF / stop-hash weighting (audio similarity).
-- doc_count = number of distinct builds whose audio contains the hash; a hash in
-- nearly every build (CDDA bass, adjacent-frame peaks) gets idf≈0 and washes out.
CREATE TABLE audio_idf (
    hash       BIGINT PRIMARY KEY,
    doc_count  BIGINT NOT NULL
);

-- ── exe binary similarity ──────────────────────────────────────────────────────
CREATE TABLE exe_fp (
    build_sha256 TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    tlsh         TEXT,
    imphash      TEXT
);
CREATE INDEX idx_exe_imphash ON exe_fp(imphash);

-- ── community metadata: media, notes, skip flags ─────────────────────────────
-- PROD-ONLY USER DATA. On the production server these tables hold wiki-user
-- contributions that exist nowhere else. Never drop, truncate, or reload them
-- from a local dump; schema changes must stay additive (the deploy tooling
-- preserves and restores them around any full DB reload). build_skip is its
-- own table, not columns on builds, so library reloads can never carry it.

-- Uploaded media, one row per (build, kind, file). The bytes live in the
-- blob store under the media/ namespace, content-addressed by sha256.
CREATE TABLE build_media (
    id            BIGSERIAL PRIMARY KEY,
    build_sha256  TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('screenshot','video','physical')),
    sha256        TEXT NOT NULL,          -- content hash = key under media/ in the blob store
    poster_sha256 TEXT,                   -- video poster still, also under media/
    filename      TEXT NOT NULL,
    content_type  TEXT NOT NULL,          -- sniffed server-side, not the client's claim
    size          BIGINT NOT NULL,
    author        TEXT NOT NULL,          -- wiki username
    label         TEXT CHECK (label IN ('front','back','other')),  -- physical photos only; NULL elsewhere
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (build_sha256, kind, sha256)
);
CREATE INDEX idx_build_media_build ON build_media(build_sha256);
CREATE INDEX idx_build_media_sha256 ON build_media(sha256);

CREATE TABLE build_note (
    id           BIGSERIAL PRIMARY KEY,
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    body         TEXT NOT NULL,
    author       TEXT NOT NULL,           -- wiki username
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at    TIMESTAMPTZ
);
CREATE INDEX idx_build_note_build ON build_note(build_sha256);

-- Per-build "this category does not apply" flags for the completeness
-- columns on /builds (0 in a category shows orange unless skipped here).
CREATE TABLE build_skip (
    build_sha256     TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    skip_notes       BOOLEAN NOT NULL DEFAULT FALSE,
    skip_screenshots BOOLEAN NOT NULL DEFAULT FALSE,
    skip_video       BOOLEAN NOT NULL DEFAULT FALSE,
    skip_physical    BOOLEAN NOT NULL DEFAULT FALSE
);

-- ── ops: similarity-check log + submission queue ─────────────────────────────
-- submission_queue is PROD-ONLY USER DATA on the production server (pending
-- and accepted user submissions): same never-wipe rules as above.
CREATE TABLE similarity_log (
    id          BIGSERIAL PRIMARY KEY,
    sha256      TEXT NOT NULL,         -- queried build identity (may be unknown to corpus)
    checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_simlog_sha ON similarity_log(sha256);

CREATE TABLE submission_queue (
    sha256       TEXT PRIMARY KEY,
    nickname     TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued',  -- queued|accepted|rejected
    -- 'duplicate': the image is already a build under a different name;
    -- accepting records the name in build_duplicate instead of re-ingesting.
    kind         TEXT NOT NULL DEFAULT 'build' CHECK (kind IN ('build','duplicate')),
    record       JSONB NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at  TIMESTAMPTZ
);
CREATE INDEX idx_subq_status ON submission_queue(status);

-- Names a build's image has circulated under besides its own — accepted
-- duplicate submissions. PROD-ONLY USER DATA: same never-wipe rules as above.
CREATE TABLE build_duplicate (
    id           BIGSERIAL PRIMARY KEY,
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    name         TEXT NOT NULL,           -- the name the duplicate was submitted under
    nickname     TEXT NOT NULL,           -- who submitted it
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (build_sha256, name)
);

-- ── gaming magazine metadata ─────────────────────────────────────────────────
-- Normalized magazines/issues, page renders, per-section extracts with
-- bounding boxes, entity links, and a moderation audit trail (migration 012).
-- Ingested through the moderator API and then moderated in place: PROD-ONLY
-- DATA on the production server, same never-wipe rules as build_media.
-- extract.kind is app-validated (src/lib/mag/kinds.ts); extract.status is
-- auto|amended|rejected — re-ingest may only replace 'auto' rows. Region
-- coordinates are normalized 0-1 over the rendered page, origin top-left.
-- Blob keys (page renders, crops, source PDFs) live under the mag/ namespace;
-- source PDFs are moderator-only, never public.

CREATE TABLE magazines (
    id           BIGSERIAL PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    aliases      TEXT[] NOT NULL DEFAULT '{}',
    country      TEXT NOT NULL DEFAULT '',
    language     TEXT NOT NULL DEFAULT '',       -- dominant content language, bcp47
    publisher    TEXT NOT NULL DEFAULT '',
    pages_public BOOLEAN NOT NULL DEFAULT TRUE,  -- full page renders public (crops are always public)
    notes        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE magazine_issue (
    id            BIGSERIAL PRIMARY KEY,
    magazine_id   BIGINT NOT NULL REFERENCES magazines(id),
    slug          TEXT NOT NULL,                 -- per-magazine token: "022", "1991-08", "01"
    label         TEXT NOT NULL,                 -- display: "Issue 22", "1991年8月号", "Ano 1 Nº 1"
    volume        TEXT,
    number        TEXT,
    whole_number  TEXT,                          -- JP 通巻 etc.
    cover_date    DATE,
    cover_date_precision TEXT CHECK (cover_date_precision IN ('day','month','year')),
    price_raw     TEXT,                          -- verbatim, all currencies
    publisher_raw TEXT,                          -- as printed in this issue
    page_count    INT,
    binding       TEXT NOT NULL DEFAULT 'ltr' CHECK (binding IN ('ltr','rtl')),
    pdf_sha256    TEXT,                          -- source PDF blob (mag/ ns); moderator-only
    pdf_size      BIGINT,
    source_url    TEXT,                          -- provenance (manifest.tsv)
    supplements   JSONB NOT NULL DEFAULT '[]',   -- advertised furoku: [{title, present}]
    status        TEXT NOT NULL DEFAULT 'new',   -- new|rendering|extracted|reviewed (convention)
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (magazine_id, slug)
);

CREATE TABLE magazine_page (
    id            BIGSERIAL PRIMARY KEY,
    issue_id      BIGINT NOT NULL REFERENCES magazine_issue(id) ON DELETE CASCADE,
    pdf_index     INT NOT NULL,                  -- 1-based page in the source PDF
    printed_label TEXT,                          -- "4", "supp:6"; NULL = unnumbered
    width         INT,                           -- render pixels
    height        INT,
    image_sha256  TEXT,                          -- page render (mag/ ns); NULL until rendered
    rendered_at   TIMESTAMPTZ,
    UNIQUE (issue_id, pdf_index)
);

-- One extract = one addressable unit: a capsule review, a tip, a letter, an
-- ad. Verbatim transcription (printed errors preserved) lives here; canonical
-- identity lives in the link tables. Kind-specific structure (score grids,
-- chart entries, ad products...) is app-validated JSONB in data.
CREATE TABLE magazine_extract (
    id              BIGSERIAL PRIMARY KEY,
    issue_id        BIGINT NOT NULL REFERENCES magazine_issue(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,               -- src/lib/mag/kinds.ts
    section         TEXT,                        -- branded recurring section as printed ("Review Crew")
    seq             INT NOT NULL DEFAULT 0,      -- reading order within the issue
    title           TEXT,
    language        TEXT NOT NULL DEFAULT '',    -- bcp47 of the original text
    text_original   TEXT NOT NULL DEFAULT '',
    text_en         TEXT,                        -- NULL for English originals (UI falls back)
    translation     TEXT CHECK (translation IN ('machine','human')),
    summary_en      TEXT,                        -- 1-2 English sentences for cards/snippets
    data            JSONB NOT NULL DEFAULT '{}',
    is_fictional    BOOLEAN NOT NULL DEFAULT FALSE,
    sponsored       BOOLEAN NOT NULL DEFAULT FALSE,
    content_warning TEXT,
    client_key      TEXT,                        -- ingest idempotency key (skill-chosen)
    status          TEXT NOT NULL DEFAULT 'auto', -- auto|amended|rejected (convention)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_mag_extract_client_key
    ON magazine_extract(issue_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX idx_mag_extract_issue   ON magazine_extract(issue_id);
CREATE INDEX idx_mag_extract_kind    ON magazine_extract(kind);
CREATE INDEX idx_mag_extract_status  ON magazine_extract(status) WHERE status <> 'auto';
-- FTS over the original ('simple') and English sides; trigram carries
-- substring/exact matching and is the only effective path for CJK.
CREATE INDEX idx_mag_extract_fts_orig ON magazine_extract
    USING gin (to_tsvector('simple', coalesce(title,'') || ' ' || text_original));
CREATE INDEX idx_mag_extract_fts_en ON magazine_extract
    USING gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(text_en,'') || ' ' || coalesce(summary_en,'')));
CREATE INDEX idx_mag_extract_trgm_orig ON magazine_extract
    USING gin (text_original gin_trgm_ops);
CREATE INDEX idx_mag_extract_trgm_en ON magazine_extract
    USING gin (text_en gin_trgm_ops);

-- Where an extract sits on the page(s): 1..N ordered rectangles (spread ads,
-- articles continuing across pages, interleaved campaigns).
CREATE TABLE extract_region (
    id          BIGSERIAL PRIMARY KEY,
    extract_id  BIGINT NOT NULL REFERENCES magazine_extract(id) ON DELETE CASCADE,
    page_id     BIGINT NOT NULL REFERENCES magazine_page(id) ON DELETE CASCADE,
    seq         INT NOT NULL DEFAULT 0,
    x           REAL NOT NULL,
    y           REAL NOT NULL,
    w           REAL NOT NULL,
    h           REAL NOT NULL,
    crop_sha256 TEXT,                            -- png crop (mag/ ns); NULL until cropped
    UNIQUE (extract_id, seq)
);
CREATE INDEX idx_extract_region_page ON extract_region(page_id);

-- People, pseudonymous personas (Sushi-X, Quartermann), and organizations-as-
-- author. Printed reader names are NOT entity-ized (text/data only).
CREATE TABLE people (
    id            BIGSERIAL PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    name_original TEXT,                          -- native-script form
    kind          TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person','persona','organization')),
    aliases       TEXT[] NOT NULL DEFAULT '{}',
    notes         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE extract_person (
    extract_id BIGINT NOT NULL REFERENCES magazine_extract(id) ON DELETE CASCADE,
    person_id  BIGINT NOT NULL REFERENCES people(id),
    role       TEXT NOT NULL DEFAULT 'mentioned', -- interviewee|interviewer|author|artist|subject|mentioned|reviewer
    PRIMARY KEY (extract_id, person_id, role)
);
CREATE INDEX idx_extract_person_person ON extract_person(person_id);

-- Links into the SHARED games table (upsert by (name, system) like builds):
-- a game page shows its builds and its magazine coverage. title_printed keeps
-- the as-printed variant ("PSYCHIC WORLDS") next to the canonical link.
CREATE TABLE extract_game (
    extract_id    BIGINT NOT NULL REFERENCES magazine_extract(id) ON DELETE CASCADE,
    game_id       BIGINT NOT NULL REFERENCES games(id),
    role          TEXT NOT NULL DEFAULT 'subject', -- subject|mentioned|listed
    title_printed TEXT,
    PRIMARY KEY (extract_id, game_id)
);
CREATE INDEX idx_extract_game_game ON extract_game(game_id);

CREATE TABLE extract_system (
    extract_id BIGINT NOT NULL REFERENCES magazine_extract(id) ON DELETE CASCADE,
    system     TEXT NOT NULL,                    -- canonical prism system string
    PRIMARY KEY (extract_id, system)
);
CREATE INDEX idx_extract_system_system ON extract_system(system);

-- Companies, events, hardware, series, topics — searchable non-game,
-- non-person, non-system entities.
CREATE TABLE mag_tag (
    id   BIGSERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'topic' CHECK (kind IN ('company','event','hardware','series','topic')),
    name TEXT NOT NULL
);

CREATE TABLE extract_tag (
    extract_id BIGINT NOT NULL REFERENCES magazine_extract(id) ON DELETE CASCADE,
    tag_id     BIGINT NOT NULL REFERENCES mag_tag(id),
    PRIMARY KEY (extract_id, tag_id)
);
CREATE INDEX idx_extract_tag_tag ON extract_tag(tag_id);

-- Moderation audit trail: one row per amend/reject/restore, field patches as
-- {field: [old, new]}. The extract row carries the current state; this table
-- carries who changed what, when.
CREATE TABLE extract_revision (
    id         BIGSERIAL PRIMARY KEY,
    extract_id BIGINT NOT NULL REFERENCES magazine_extract(id) ON DELETE CASCADE,
    editor     TEXT NOT NULL,                    -- wiki username, or "token"
    change     JSONB NOT NULL,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_extract_revision_extract ON extract_revision(extract_id, id DESC);

-- Pending-upload accounting is user data, preserved across corpus reloads.
CREATE TABLE upload_quota_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  initialized boolean NOT NULL DEFAULT false,
  store_identity text,
  limit_bytes bigint NOT NULL DEFAULT 10000000000000 CHECK (limit_bytes > 0)
);
INSERT INTO upload_quota_config(id) VALUES (true);
CREATE TABLE upload_quota (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  active integer NOT NULL DEFAULT 0 CHECK (active >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
