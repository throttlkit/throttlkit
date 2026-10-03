CREATE TABLE IF NOT EXISTS throttl_keys (
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
