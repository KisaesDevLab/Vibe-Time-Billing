-- 0137 — Vibe Filer: document inbox & routing.
--
-- Staff review queue that parses an exported PDF's filename, matches it
-- to a client (clients.external_id, then name-fuzzy), proposes a folder
-- via ordered rules, and on commit relocates the object in B2 into the
-- client's folder tree (server-side copy → log → delete), optionally
-- handing it to the Tax Return pipeline.
--
-- Tables live in vibetb (qualified like 0134/0135/0136). Soft enums via
-- text + CHECK (matches client_request.kind). All FKs scoped to the
-- single firm.

-- Workqueue cache — rebuilt/upserted on each inbox scan; rows removed
-- once routed. UNIQUE(firm_id, object_key).
CREATE TABLE vibetb.inbox_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  object_key      text NOT NULL,
  original_name   text NOT NULL,
  size_bytes      bigint NOT NULL DEFAULT 0,
  etag            text,
  discovered_at   timestamptz NOT NULL DEFAULT now(),
  -- parse + match (recomputed on scan)
  parsed_name     text,
  parsed_id       text,
  parsed_year     int,
  match_status    text NOT NULL DEFAULT 'unparseable',
  matched_client  uuid REFERENCES vibetb.client(id) ON DELETE SET NULL,
  suggested_rule  uuid,
  suggested_path  text,
  -- review state (persists across reloads)
  review_action   text,
  override_folder text,
  override_year   int,
  flag_form_code  text,
  flag_tax_year   int,
  included        boolean NOT NULL DEFAULT true,
  reviewed_by     uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_items_object_key_uk UNIQUE (firm_id, object_key),
  CONSTRAINT inbox_items_match_status_ck CHECK (match_status IN
    ('matched','fuzzy','inactive','name_mismatch','year_needed','folder_unbound','unparseable')),
  CONSTRAINT inbox_items_review_action_ck CHECK (review_action IS NULL OR review_action IN
    ('file','flag_tax','skip'))
);
CREATE INDEX inbox_items_firm_idx ON vibetb.inbox_items (firm_id, match_status);

CREATE TABLE vibetb.inbox_routing_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbox_routing_profiles_firm_idx ON vibetb.inbox_routing_profiles (firm_id);

CREATE TABLE vibetb.inbox_routing_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL REFERENCES vibetb.inbox_routing_profiles(id) ON DELETE CASCADE,
  sort_order      int NOT NULL DEFAULT 0,
  name            text NOT NULL,
  identifier      text NOT NULL DEFAULT '',
  match_mode      text NOT NULL DEFAULT 'contains',
  case_sensitive  boolean NOT NULL DEFAULT false,
  target_path     text NOT NULL DEFAULT '',
  year_behavior   text NOT NULL DEFAULT 'none',
  is_tax_return   boolean NOT NULL DEFAULT false,
  enabled         boolean NOT NULL DEFAULT true,
  notes           text,
  CONSTRAINT inbox_routing_rules_match_mode_ck CHECK (match_mode IN
    ('contains','starts_with','regex')),
  CONSTRAINT inbox_routing_rules_year_behavior_ck CHECK (year_behavior IN
    ('none','current_only','current_and_next','previous'))
);
CREATE INDEX inbox_routing_rules_profile_idx
  ON vibetb.inbox_routing_rules (profile_id, sort_order);

-- Immutable history / undo source. Append-only except the status flip
-- to 'reversed' on undo.
CREATE TABLE vibetb.inbox_routing_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid NOT NULL,
  firm_id           uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  object_key_from   text NOT NULL,
  object_key_to     text,
  client_id         uuid REFERENCES vibetb.client(id) ON DELETE SET NULL,
  folder_path       text,
  action            text NOT NULL,
  rule_id           uuid,
  routed_file_id    uuid,
  tax_job_id        uuid,
  tax_return_id     uuid,
  user_id           uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'success',
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_routing_log_action_ck CHECK (action IN
    ('filed','tax_flagged','skipped','failed')),
  CONSTRAINT inbox_routing_log_status_ck CHECK (status IN
    ('success','reversed','error'))
);
CREATE INDEX inbox_routing_log_batch_idx ON vibetb.inbox_routing_log (batch_id);
CREATE INDEX inbox_routing_log_firm_at_idx ON vibetb.inbox_routing_log (firm_id, created_at DESC);
CREATE INDEX inbox_routing_log_from_idx ON vibetb.inbox_routing_log (firm_id, object_key_from);
