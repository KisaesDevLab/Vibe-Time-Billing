-- =====================================================================
-- Migration: 0108_signatures_module.sql  (OpenSign Integration Addendum)
--
-- Arbitrary-PDF e-signature requests with drag-to-place fields + reusable
-- role-based placement profiles. Reuses the existing esign provider /
-- webhook / poll; owns its own request lifecycle. Field positions are
-- normalized [0,1]; per-page point geometry is captured from the PDF
-- MediaBox at upload. Distinct from the proposal `signatures` table.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.signature_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid REFERENCES vibetb.client(id) ON DELETE SET NULL,
  opensign_document_id text,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','partially_signed','completed','declined','expired','voided')),
  signer_count integer NOT NULL DEFAULT 0,
  signed_count integer NOT NULL DEFAULT 0,
  source_file_key text,
  signed_file_url text,
  page_geometry jsonb,
  form_type text,
  send_in_order boolean NOT NULL DEFAULT false,
  sent_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  created_by uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signature_requests_firm_status_idx
  ON vibetb.signature_requests (firm_id, status);
CREATE INDEX IF NOT EXISTS signature_requests_opensign_idx
  ON vibetb.signature_requests (opensign_document_id);

CREATE TABLE IF NOT EXISTS vibetb.signature_signers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES vibetb.signature_requests(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  role text,
  "order" integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','viewed','signed','declined')),
  signed_at timestamptz,
  opensign_signer_id text
);
CREATE INDEX IF NOT EXISTS signature_signers_request_idx
  ON vibetb.signature_signers (request_id);

CREATE TABLE IF NOT EXISTS vibetb.signature_field_placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES vibetb.signature_requests(id) ON DELETE CASCADE,
  signer_id uuid NOT NULL REFERENCES vibetb.signature_signers(id) ON DELETE CASCADE,
  field_type text NOT NULL
    CHECK (field_type IN ('signature','initials','date','text','checkbox')),
  page_number integer NOT NULL,
  nx double precision NOT NULL,
  ny double precision NOT NULL,
  nw double precision NOT NULL,
  nh double precision NOT NULL,
  required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signature_field_placements_request_idx
  ON vibetb.signature_field_placements (request_id);
CREATE INDEX IF NOT EXISTS signature_field_placements_signer_idx
  ON vibetb.signature_field_placements (signer_id);

CREATE TABLE IF NOT EXISTS vibetb.signature_placement_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  form_type text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  fields jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signature_placement_profiles_firm_form_idx
  ON vibetb.signature_placement_profiles (firm_id, form_type, version);

CREATE TABLE IF NOT EXISTS vibetb.signature_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES vibetb.signature_requests(id) ON DELETE CASCADE,
  actor text NOT NULL,
  event text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signature_events_request_idx
  ON vibetb.signature_events (request_id);
