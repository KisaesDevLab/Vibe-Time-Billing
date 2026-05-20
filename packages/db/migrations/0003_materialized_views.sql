-- =====================================================================
-- Migration: 0003_materialized_views.sql
--
-- Reporting cube (Phase 17). Three materialized views over the canonical
-- per-timekeeper allocation grain plus an ar_aging_snapshot table written
-- nightly by the worker.
--
-- The live realization endpoint (/api/staff/reports/realization) already
-- computes these on-demand for small firms; the materialized views are
-- needed once a firm crosses the 100k+ time-entry mark for sub-second
-- response (BUILD_PLAN.md performance target).
--
-- Refresh is scheduled in apps/worker/src/index.ts on the 'view-refresh'
-- queue (every 15 minutes by default).
-- =====================================================================

-- =====================================================================
-- realization_view — per-(firm, app_user, engagement) realization
-- rolled from adjustment_allocation joined back through billing_batch →
-- engagement → client → firm.
-- =====================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS realization_view AS
SELECT
  c.firm_id                                              AS firm_id,
  e.id                                                   AS engagement_id,
  e.client_id                                            AS client_id,
  aa.app_user_id                                         AS app_user_id,
  COUNT(*)                                               AS allocation_count,
  SUM(aa.original_value_cents)::BIGINT                   AS original_value_cents,
  SUM(aa.adjusted_value_cents)::BIGINT                   AS adjusted_value_cents,
  SUM(aa.adjustment_amount_cents)::BIGINT                AS adjustment_amount_cents,
  CASE
    WHEN SUM(aa.original_value_cents) = 0 THEN 0::NUMERIC
    ELSE (SUM(aa.adjusted_value_cents)::NUMERIC / SUM(aa.original_value_cents)::NUMERIC)
  END                                                    AS realization_pct
FROM adjustment_allocation aa
JOIN adjustment a       ON a.id = aa.adjustment_id
JOIN billing_batch bb   ON bb.id = a.billing_batch_id
JOIN engagement e       ON e.id = bb.engagement_id
JOIN client c           ON c.id = e.client_id
WHERE a.status = 'APPLIED'
GROUP BY c.firm_id, e.id, e.client_id, aa.app_user_id;

CREATE UNIQUE INDEX IF NOT EXISTS realization_view_uk
  ON realization_view (firm_id, engagement_id, app_user_id);

-- =====================================================================
-- utilization_view — billable hours / available hours per timekeeper
-- per fiscal period (calendar month for v1).
-- =====================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS utilization_view AS
SELECT
  au.firm_id                                                                 AS firm_id,
  au.id                                                                      AS app_user_id,
  date_trunc('month', te.entry_date::timestamp)::date                        AS period_month,
  SUM(CASE WHEN te.billable_flag  THEN te.hours::numeric ELSE 0 END)::NUMERIC AS billable_hours,
  SUM(CASE WHEN NOT te.billable_flag THEN te.hours::numeric ELSE 0 END)::NUMERIC AS non_billable_hours,
  SUM(te.hours::numeric)::NUMERIC                                            AS total_hours,
  au.standard_hours_per_week::NUMERIC * 4                                    AS available_hours_monthly
FROM time_entry te
JOIN app_user au ON au.id = te.app_user_id
GROUP BY au.firm_id, au.id, date_trunc('month', te.entry_date::timestamp);

CREATE UNIQUE INDEX IF NOT EXISTS utilization_view_uk
  ON utilization_view (firm_id, app_user_id, period_month);

-- =====================================================================
-- profitability_view — billed minus loaded cost per engagement.
-- =====================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS profitability_view AS
SELECT
  c.firm_id                                                AS firm_id,
  e.id                                                     AS engagement_id,
  e.client_id                                              AS client_id,
  COALESCE(SUM(inv.total_cents), 0)::BIGINT                AS billed_cents,
  COALESCE(SUM(te.hours::numeric * COALESCE(tk.cost_rate_cents, 0)), 0)::NUMERIC
                                                           AS loaded_cost_cents,
  COALESCE(SUM(inv.total_cents), 0)::NUMERIC
    - COALESCE(SUM(te.hours::numeric * COALESCE(tk.cost_rate_cents, 0)), 0)::NUMERIC
                                                           AS profit_cents
FROM engagement e
JOIN client c          ON c.id = e.client_id
LEFT JOIN invoice inv  ON inv.primary_engagement_id = e.id AND inv.status IN ('SENT','PARTIALLY_PAID','PAID')
LEFT JOIN time_entry te ON te.engagement_id = e.id
LEFT JOIN timekeeper_rate tk ON tk.app_user_id = te.app_user_id
GROUP BY c.firm_id, e.id, e.client_id;

CREATE UNIQUE INDEX IF NOT EXISTS profitability_view_uk
  ON profitability_view (firm_id, engagement_id);

-- =====================================================================
-- ar_aging_snapshot — daily per-(firm, client) AR aging snapshot.
-- Regular table, not MV — written by the ar-aging-snapshot worker job.
-- =====================================================================

CREATE TABLE IF NOT EXISTS ar_aging_snapshot (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  as_of_date      DATE NOT NULL,
  bucket_0_30_cents    BIGINT NOT NULL DEFAULT 0,
  bucket_31_60_cents   BIGINT NOT NULL DEFAULT 0,
  bucket_61_90_cents   BIGINT NOT NULL DEFAULT 0,
  bucket_90_plus_cents BIGINT NOT NULL DEFAULT 0,
  total_cents     BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ar_aging_snapshot_uk
  ON ar_aging_snapshot (firm_id, client_id, as_of_date);
CREATE INDEX IF NOT EXISTS ar_aging_snapshot_firm_date_idx
  ON ar_aging_snapshot (firm_id, as_of_date);

-- =====================================================================
-- Operators: refresh the MVs concurrently from the worker. Concurrent
-- refresh requires the unique indexes above.
--
--   REFRESH MATERIALIZED VIEW CONCURRENTLY realization_view;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY utilization_view;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY profitability_view;
-- =====================================================================
