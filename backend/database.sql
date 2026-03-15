CREATE TABLE IF NOT EXISTS signals (
  id SERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL,
  token_address TEXT,
  base_token TEXT,
  ticker TEXT,
  name TEXT,
  price NUMERIC,
  liquidity NUMERIC,
  volume_5m NUMERIC,
  volume_1h NUMERIC,
  price_change_5m NUMERIC,
  price_change_1h NUMERIC,
  buys_5m INTEGER,
  sells_5m INTEGER,
  age_minutes NUMERIC,
  dex_url TEXT,
  source TEXT DEFAULT 'dexscreener',
  score INTEGER,
  analysis JSONB,
  entered BOOLEAN DEFAULT FALSE,
  skip_reason TEXT,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  signal_id INTEGER REFERENCES signals(id),
  pool_address TEXT NOT NULL,
  token_address TEXT,
  ticker TEXT,
  name TEXT,
  entry_price NUMERIC,
  position_size NUMERIC,
  score INTEGER,
  analysis JSONB,
  highest_mult NUMERIC DEFAULT 1.0,
  tier1_hit BOOLEAN DEFAULT FALSE,
  tier2_hit BOOLEAN DEFAULT FALSE,
  tier3_hit BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'OPEN',
  exit_price NUMERIC,
  exit_reason TEXT,
  pnl NUMERIC,
  pnl_percent NUMERIC,
  entered_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_detected ON signals(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_pool ON signals(pool_address);
CREATE INDEX IF NOT EXISTS idx_signals_entered ON signals(entered);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_entered ON trades(entered_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_address);
