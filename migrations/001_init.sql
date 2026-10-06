-- Demand baseline per region and SKU, refreshed by the feature pipeline.
CREATE TABLE demand_baselines (
  region_id    text        NOT NULL,
  sku          text        NOT NULL,
  median_units numeric     NOT NULL CHECK (median_units > 0),
  mad_units    numeric     NOT NULL CHECK (mad_units >= 0),
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (region_id, sku)
);

CREATE TABLE procurement_requests (
  id              uuid        PRIMARY KEY,
  region_id       text        NOT NULL,
  sku             text        NOT NULL,
  requester_id    text        NOT NULL,
  quantity        integer     NOT NULL CHECK (quantity > 0),
  status          text        NOT NULL CHECK (status IN ('APPROVED', 'APPROVED_TAGGED', 'ON_HOLD', 'RELEASED', 'REJECTED')),
  risk_score      integer     NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  risk_level      text        NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  reasons         jsonb       NOT NULL,
  idempotency_key text        NOT NULL,
  payload_hash    text        NOT NULL,
  decided_by      text,
  created_at      timestamptz NOT NULL,
  UNIQUE (requester_id, idempotency_key)
);

-- Serves the scoring query: equality on (region_id, sku), then a range on created_at.
-- The lookup is O(log n + k), where k is the rows inside the look-back window,
-- instead of a full scan of the table.
CREATE INDEX idx_requests_region_sku_created
  ON procurement_requests (region_id, sku, created_at);

CREATE TABLE audit_log (
  id         bigserial   PRIMARY KEY,
  request_id uuid        NOT NULL REFERENCES procurement_requests (id),
  actor      text        NOT NULL,
  action     text        NOT NULL,
  detail     jsonb       NOT NULL,
  created_at timestamptz NOT NULL
);

-- Transactional outbox: rows are written in the same transaction as the decision
-- and published by a separate relay, so a report is never sent for a rolled-back order.
CREATE TABLE outbox (
  id           bigserial   PRIMARY KEY,
  topic        text        NOT NULL,
  payload      jsonb       NOT NULL,
  created_at   timestamptz NOT NULL,
  published_at timestamptz
);
