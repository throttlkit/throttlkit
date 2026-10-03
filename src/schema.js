export const initialMigration = `CREATE TABLE IF NOT EXISTS throttl_keys (
  namespace TEXT NOT NULL,
  key_hash CHAR(64) NOT NULL,
  config_hash CHAR(64) NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('sliding-window', 'token-bucket')),
  available_tokens DOUBLE PRECISION,
  last_refill_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (namespace, key_hash)
);
CREATE TABLE IF NOT EXISTS throttl_window_events (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  key_hash CHAR(64) NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (namespace, key_hash) REFERENCES throttl_keys(namespace, key_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS throttl_window_events_key_time_idx ON throttl_window_events (namespace, key_hash, requested_at);
CREATE INDEX IF NOT EXISTS throttl_keys_expires_at_idx ON throttl_keys (expires_at);
`;

export const weightedMigration = `ALTER TABLE throttl_keys DROP CONSTRAINT IF EXISTS throttl_keys_algorithm_check;
ALTER TABLE throttl_keys ADD CONSTRAINT throttl_keys_algorithm_check
  CHECK (algorithm IN ('sliding-window', 'token-bucket', 'gcra', 'sliding-window-counter'));
ALTER TABLE throttl_keys ADD COLUMN IF NOT EXISTS state JSONB NOT NULL DEFAULT '{}';
ALTER TABLE throttl_keys ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE throttl_keys ADD COLUMN IF NOT EXISTS window_ms BIGINT;
ALTER TABLE throttl_window_events ADD COLUMN IF NOT EXISTS cost BIGINT NOT NULL DEFAULT 1 CHECK (cost > 0);
`;
