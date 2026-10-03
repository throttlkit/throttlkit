ALTER TABLE throttl_keys DROP CONSTRAINT IF EXISTS throttl_keys_algorithm_check;
ALTER TABLE throttl_keys ADD CONSTRAINT throttl_keys_algorithm_check
  CHECK (algorithm IN ('sliding-window', 'token-bucket', 'gcra', 'sliding-window-counter'));
ALTER TABLE throttl_keys ADD COLUMN IF NOT EXISTS state JSONB NOT NULL DEFAULT '{}';
ALTER TABLE throttl_keys ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE throttl_keys ADD COLUMN IF NOT EXISTS window_ms BIGINT;
ALTER TABLE throttl_window_events ADD COLUMN IF NOT EXISTS cost BIGINT NOT NULL DEFAULT 1 CHECK (cost > 0);
