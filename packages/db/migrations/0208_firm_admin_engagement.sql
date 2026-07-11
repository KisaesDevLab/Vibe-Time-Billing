-- 0208 — permanent firm-administrative engagement. Adds engagement.firm_admin
-- and seeds, per existing firm: an "Internal" service line, four admin work
-- codes (non-billable defaults, scoped to that line), an "Internal —
-- Administrative" engagement type, a visible internal client
-- ("⚙ Firm — Internal"), and one always-ACTIVE "Administrative time"
-- engagement flagged firm_admin. API guards keep the engagement ACTIVE
-- forever and force every time entry on it non-billable. Fresh installs get
-- the same seed from bootstrap-firm.ts (this migration runs before the firm
-- row exists there, so every INSERT..SELECT below no-ops on an empty DB).
-- Idempotent throughout.

ALTER TABLE vibetb.engagement
  ADD COLUMN IF NOT EXISTS firm_admin boolean NOT NULL DEFAULT false;

-- Internal service line.
INSERT INTO vibetb.service_line (firm_id, name, category)
SELECT f.id, 'Internal', 'internal'
FROM vibetb.firm f
WHERE NOT EXISTS (
  SELECT 1 FROM vibetb.service_line sl
  WHERE sl.firm_id = f.id AND sl.category = 'internal'
);

-- Admin work codes on the Internal line (non-billable by default).
INSERT INTO vibetb.work_code (firm_id, service_line_id, key, name, billable_default)
SELECT f.id, sl.id, wc.key, wc.name, false
FROM vibetb.firm f
JOIN vibetb.service_line sl ON sl.firm_id = f.id AND sl.category = 'internal'
CROSS JOIN (VALUES
  ('admin_general', 'Administration'),
  ('admin_cpe', 'CPE / Training'),
  ('admin_meeting', 'Internal meeting'),
  ('admin_marketing', 'Marketing / Business development')
) AS wc(key, name)
ON CONFLICT (firm_id, key) DO NOTHING;

-- Internal engagement type (gives the admin engagement a service line, so
-- its work-code picker shows the admin codes rather than client codes).
INSERT INTO vibetb.engagement_type (firm_id, service_line_id, key, name, default_fee_structure)
SELECT f.id, sl.id, 'internal_admin', 'Internal — Administrative', 'HOURLY'
FROM vibetb.firm f
JOIN vibetb.service_line sl ON sl.firm_id = f.id AND sl.category = 'internal'
ON CONFLICT (firm_id, key) DO NOTHING;

-- Visible internal client. Owner = the firm's earliest staff user; office =
-- the earliest office. Skipped when a firm_admin engagement (the durable
-- anchor) or a same-named client already exists, or the firm has no
-- users/offices yet.
INSERT INTO vibetb.client (firm_id, name, partner_in_charge_id, office_id, client_type)
SELECT
  f.id,
  '⚙ Firm — Internal',
  (SELECT au.id FROM vibetb.app_user au WHERE au.firm_id = f.id ORDER BY au.created_at LIMIT 1),
  (SELECT o.id FROM vibetb.office o WHERE o.firm_id = f.id ORDER BY o.created_at LIMIT 1),
  'BUSINESS'
FROM vibetb.firm f
WHERE NOT EXISTS (
    SELECT 1 FROM vibetb.engagement e
    JOIN vibetb.client c2 ON c2.id = e.client_id
    WHERE c2.firm_id = f.id AND e.firm_admin
  )
  AND NOT EXISTS (
    SELECT 1 FROM vibetb.client c3
    WHERE c3.firm_id = f.id AND c3.name = '⚙ Firm — Internal'
  )
  AND EXISTS (SELECT 1 FROM vibetb.app_user au WHERE au.firm_id = f.id)
  AND EXISTS (SELECT 1 FROM vibetb.office o WHERE o.firm_id = f.id);

-- The permanent engagement itself. status must be ACTIVE explicitly (the
-- column defaults to PROPOSED, which time pickers filter out).
INSERT INTO vibetb.engagement (client_id, name, fee_structure, status, engagement_type_id, firm_admin)
SELECT
  c.id,
  'Administrative time',
  'HOURLY',
  'ACTIVE',
  (SELECT et.id FROM vibetb.engagement_type et
   WHERE et.firm_id = c.firm_id AND et.key = 'internal_admin'),
  true
FROM vibetb.client c
WHERE c.name = '⚙ Firm — Internal'
  AND NOT EXISTS (
    SELECT 1 FROM vibetb.engagement e
    JOIN vibetb.client c2 ON c2.id = e.client_id
    WHERE c2.firm_id = c.firm_id AND e.firm_admin
  );
