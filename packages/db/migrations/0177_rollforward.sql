-- =====================================================================
-- Migration: 0177_rollforward.sql
--
-- Tax-season rollforward. A batch generates next-year engagements (the
-- spine), their drop-off dates, and dependent appointments from a prior-year
-- window, reviewed as candidate rows and committed together. Net-new tables;
-- no backfill. Header + two candidate tables (engagement, appointment); the
-- appointment candidate hangs off an engagement candidate (the cascade link).
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.rollforward_batch (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                  uuid NOT NULL REFERENCES vibetb.firm (id) ON DELETE CASCADE,
  staff_id                 uuid NOT NULL REFERENCES vibetb.app_user (id) ON DELETE CASCADE,
  source_start             date NOT NULL,
  source_end               date NOT NULL,
  target_year              integer NOT NULL,
  mapping_mode             text NOT NULL DEFAULT 'DEADLINE',  -- DEADLINE | ISO_WEEK
  status                   text NOT NULL DEFAULT 'DRAFT',     -- DRAFT | COMMITTED | CANCELLED
  idempotency_key          text,
  created_by_app_user_id   uuid REFERENCES vibetb.app_user (id) ON DELETE SET NULL,
  committed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rollforward_batch_firm_idx
  ON vibetb.rollforward_batch (firm_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS rollforward_batch_idempotency_uk
  ON vibetb.rollforward_batch (idempotency_key);

CREATE TABLE IF NOT EXISTS vibetb.rollforward_engagement_candidate (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                 uuid NOT NULL REFERENCES vibetb.rollforward_batch (id) ON DELETE CASCADE,
  firm_id                  uuid NOT NULL REFERENCES vibetb.firm (id) ON DELETE CASCADE,
  source_engagement_id     uuid NOT NULL REFERENCES vibetb.engagement (id) ON DELETE CASCADE,
  client_id                uuid NOT NULL REFERENCES vibetb.client (id) ON DELETE CASCADE,
  client_name              text NOT NULL,
  return_type              text,
  engagement_type_id       uuid REFERENCES vibetb.engagement_type (id) ON DELETE SET NULL,
  source_due_date          date,
  suggested_due_date       date,
  source_dropoff_date      date,
  suggested_dropoff_date   date,
  source_fee_cents         bigint,
  suggested_fee_cents      bigint,
  status                   text NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | SKIPPED | COMMITTED
  target_engagement_id     uuid REFERENCES vibetb.engagement (id) ON DELETE SET NULL,
  detail                   text,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rollforward_eng_cand_batch_idx
  ON vibetb.rollforward_engagement_candidate (batch_id, status);
CREATE INDEX IF NOT EXISTS rollforward_eng_cand_source_idx
  ON vibetb.rollforward_engagement_candidate (source_engagement_id);

CREATE TABLE IF NOT EXISTS vibetb.rollforward_appointment_candidate (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                 uuid NOT NULL REFERENCES vibetb.rollforward_batch (id) ON DELETE CASCADE,
  firm_id                  uuid NOT NULL REFERENCES vibetb.firm (id) ON DELETE CASCADE,
  engagement_candidate_id  uuid NOT NULL REFERENCES vibetb.rollforward_engagement_candidate (id) ON DELETE CASCADE,
  source_appointment_id    uuid REFERENCES vibetb.appointment (id) ON DELETE SET NULL,
  client_id                uuid REFERENCES vibetb.client (id) ON DELETE SET NULL,
  title                    text NOT NULL,
  staff_ids                jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_starts_at         timestamptz,
  suggested_starts_at      timestamptz,
  duration_minutes         integer NOT NULL,
  location                 text,
  location_option_id       uuid REFERENCES vibetb.appointment_location_option (id) ON DELETE SET NULL,
  status                   text NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | SKIPPED | COMMITTED
  conflict                 boolean NOT NULL DEFAULT false,
  target_appointment_id    uuid REFERENCES vibetb.appointment (id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rollforward_appt_cand_batch_idx
  ON vibetb.rollforward_appointment_candidate (batch_id, status);
CREATE INDEX IF NOT EXISTS rollforward_appt_cand_eng_idx
  ON vibetb.rollforward_appointment_candidate (engagement_candidate_id);
