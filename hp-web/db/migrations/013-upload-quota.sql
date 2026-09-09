-- User data: preserve both tables across corpus reloads and back them up.
CREATE TABLE IF NOT EXISTS upload_quota_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  initialized boolean NOT NULL DEFAULT false,
  store_identity text,
  limit_bytes bigint NOT NULL DEFAULT 10000000000000 CHECK (limit_bytes > 0)
);
INSERT INTO upload_quota_config(id) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS upload_quota (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  active integer NOT NULL DEFAULT 0 CHECK (active >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
