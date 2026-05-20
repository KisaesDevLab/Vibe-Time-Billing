-- =====================================================================
-- Migration: 0005_holiday_calendar.sql
--
-- Holiday + PTO calendar (Phase 4 #9-#10). Per-firm table holding
-- observed firm-wide holidays plus per-user PTO ranges. The time-entry
-- write path can later consult this to warn (not block) when an entry
-- falls on a holiday or during the assignee's PTO.
-- =====================================================================

CREATE TABLE IF NOT EXISTS holiday_calendar (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id          UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  app_user_id      UUID REFERENCES app_user(id) ON DELETE CASCADE, -- null = firm-wide
  name             TEXT NOT NULL,
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'HOLIDAY', -- 'HOLIDAY' | 'PTO'
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS holiday_calendar_firm_range_idx
  ON holiday_calendar (firm_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS holiday_calendar_user_range_idx
  ON holiday_calendar (app_user_id, start_date, end_date)
  WHERE app_user_id IS NOT NULL;
