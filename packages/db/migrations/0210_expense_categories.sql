-- 0210 — managed expense categories (the Expenses tab's Category field was
-- free text; firms want a consistent picklist like time work codes). The
-- expense row keeps its text `category` column — the picklist governs entry,
-- not storage — so billing/invoicing readers are untouched and historical
-- free-text values still render. Per-firm seed of common CPA categories,
-- plus a backfill of any category names already in use.

CREATE TABLE IF NOT EXISTS vibetb.expense_category (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  name text NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, name)
);

CREATE INDEX IF NOT EXISTS expense_category_firm_idx
  ON vibetb.expense_category (firm_id) WHERE NOT archived;

INSERT INTO vibetb.expense_category (firm_id, name)
SELECT f.id, c.name
FROM vibetb.firm f
CROSS JOIN (VALUES
  ('Filing fees'),
  ('Postage & shipping'),
  ('Courier'),
  ('Software'),
  ('Travel'),
  ('Mileage'),
  ('Meals'),
  ('Printing & supplies'),
  ('Other')
) AS c(name)
ON CONFLICT (firm_id, name) DO NOTHING;

-- Backfill categories firms already typed in free text.
INSERT INTO vibetb.expense_category (firm_id, name)
SELECT DISTINCT e.firm_id, e.category
FROM vibetb.engagement_expense e
WHERE e.category IS NOT NULL AND e.category <> ''
ON CONFLICT (firm_id, name) DO NOTHING;
