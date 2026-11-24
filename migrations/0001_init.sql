CREATE TABLE IF NOT EXISTS theses (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  title TEXT NOT NULL,
  regime TEXT NOT NULL,
  confidence REAL NOT NULL,
  conviction REAL NOT NULL,
  target_asset TEXT NOT NULL,
  direction TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  allocation_json TEXT NOT NULL,
  firewall_verdict TEXT NOT NULL,
  sha256_digest TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'Meridian Autonomous Desk'
);

CREATE TABLE IF NOT EXISTS baskets (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  thesis TEXT NOT NULL,
  weights_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  sha256_digest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS firewall_audits (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  market_type TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  notional_usd REAL NOT NULL,
  verdict TEXT NOT NULL,
  slippage_bps REAL NOT NULL,
  spread_bps REAL NOT NULL,
  risk_score REAL NOT NULL,
  reasons_json TEXT NOT NULL,
  eip712_payload_hash TEXT,
  sha256_digest TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_theses_created ON theses(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_baskets_created ON baskets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audits_created ON firewall_audits(created_at DESC);
