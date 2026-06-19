-- =====================================================================
-- Migration: 0176_alert_dismissal.sql
--
-- Lets staff dismiss a worker alert so it drops off the Alerts inbox and the
-- dashboard "Alerts" callout. Worker alerts are audit_log rows (append-only),
-- so dismissals live in their own table. Per-firm: one staff dismissal hides
-- the alert firm-wide. Deleting the audit row (never happens — append-only)
-- or the firm cascades the dismissal away.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.alert_dismissal (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                  uuid NOT NULL REFERENCES vibetb.firm (id) ON DELETE CASCADE,
  audit_log_id             uuid NOT NULL REFERENCES vibetb.audit_log (id) ON DELETE CASCADE,
  dismissed_by_app_user_id uuid REFERENCES vibetb.app_user (id) ON DELETE SET NULL,
  dismissed_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS alert_dismissal_uk
  ON vibetb.alert_dismissal (firm_id, audit_log_id);
