-- =====================================================================
-- Migration: 0058_firm_config_and_key_envelope.sql
--
-- Standalone groundwork for the absorbed Connect-style feature set.
-- Two tables, both keyed by firm_id (1:1 with firm):
--
--   firm_config
--     Tunables specific to the absorbed features. Defaults match the
--     addendum's locked decisions (Q1 sealed-on-disk, Q3 7-day
--     suggestion expiration, Q4 engagement-access escrow visibility,
--     I.8 $500 step-up threshold).
--
--   firm_key_envelope
--     Persists the firm's Master Firm Key wrapped by the KEK, plus
--     metadata about how the KEK is derived, plus a sentinel ciphertext
--     used at startup to verify the MFK is the right one. One row per
--     firm; populated by FirmKeyManager.bootstrap() on first run, not
--     by this migration.
--
-- search_path is `vibetb, public` (set in 0057). New tables go into
-- vibetb explicitly so a future schema-route change can't mis-route
-- them; existing-table refs stay unqualified and resolve via search_path.
-- =====================================================================

-- ---------------------------------------------------------------------
-- firm_config
-- ---------------------------------------------------------------------
CREATE TABLE vibetb.firm_config (
  firm_id uuid PRIMARY KEY REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  -- Q1 — sealed-on-disk by default; admin-passphrase is opt-in.
  unlock_mode text NOT NULL DEFAULT 'sealed-on-disk',
  -- Q3 — per-firm; default 7 days.
  suggestion_expiration_days integer NOT NULL DEFAULT 7,
  -- Q4 — escrow zone staff visibility; default = any staff with
  -- engagement access. Other valid value: 'partner-and-assigned-only'.
  escrow_visibility text NOT NULL DEFAULT 'engagement-access',
  -- I.8 — dollar thresholds for step-up gating; default $500 = 50000c.
  write_off_step_up_threshold_cents bigint NOT NULL DEFAULT 50000,
  credit_step_up_threshold_cents bigint NOT NULL DEFAULT 50000,
  -- J.7 — opt-in for Anthropic API egress; default off (local-LLM only).
  -- Until Vibe Shield is wired, true is rejected at startup.
  ai_egress_enabled boolean NOT NULL DEFAULT false,
  -- J.8 — Shield endpoint; populated by appliance manifest when Shield
  -- installs on the same host. NULL means egress is impossible even if
  -- ai_egress_enabled is flipped on.
  vibe_shield_endpoint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT firm_config_unlock_mode_ck
    CHECK (unlock_mode IN ('sealed-on-disk', 'admin-passphrase')),
  CONSTRAINT firm_config_escrow_visibility_ck
    CHECK (escrow_visibility IN ('engagement-access', 'partner-and-assigned-only')),
  CONSTRAINT firm_config_suggestion_window_ck
    CHECK (suggestion_expiration_days BETWEEN 1 AND 365),
  CONSTRAINT firm_config_write_off_threshold_ck
    CHECK (write_off_step_up_threshold_cents >= 0),
  CONSTRAINT firm_config_credit_threshold_ck
    CHECK (credit_step_up_threshold_cents >= 0)
);

-- Seed one row per existing firm. Future firm-creation paths must
-- insert a firm_config row in the same transaction.
INSERT INTO vibetb.firm_config (firm_id)
SELECT id FROM vibetb.firm
ON CONFLICT (firm_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- firm_key_envelope
-- ---------------------------------------------------------------------
-- Crypto persistence. The MFK never leaves the application's memory in
-- plaintext; only its wrapped form (encrypted by the KEK) is stored.
--
-- Empty until FirmKeyManager.bootstrap() runs on the next API boot —
-- detecting an absent row, generating an MFK, wrapping it, and writing
-- the row.
CREATE TABLE vibetb.firm_key_envelope (
  firm_id uuid PRIMARY KEY REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  -- The MFK encrypted by the KEK. XChaCha20-Poly1305 ciphertext.
  wrapped_mfk bytea NOT NULL,
  -- JSON describing how the KEK was derived. Shape varies by mode:
  --   sealed-on-disk: { "mode": "sealed-on-disk", "path": "/data/.firm-key.seal" }
  --   admin-passphrase: { "mode": "admin-passphrase",
  --                       "argon2_salt": "<base64>",
  --                       "argon2_opslimit": 4,
  --                       "argon2_memlimit_mib": 256 }
  kek_metadata jsonb NOT NULL,
  -- Sentinel: a fixed plaintext (e.g., "vibe-tb-firm-key-sentinel-v1")
  -- encrypted by the MFK. Startup decrypts this to confirm the MFK is
  -- the correct one for this firm; mismatch means data corruption or
  -- wrong unlock state. Not used for ongoing encryption.
  sentinel_ciphertext bytea NOT NULL,
  -- Rotation tracking: incremented each time rotateMFK() runs.
  rotation_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT firm_key_envelope_wrapped_mfk_size_ck
    CHECK (octet_length(wrapped_mfk) BETWEEN 32 AND 256),
  CONSTRAINT firm_key_envelope_sentinel_size_ck
    CHECK (octet_length(sentinel_ciphertext) BETWEEN 32 AND 256)
);
