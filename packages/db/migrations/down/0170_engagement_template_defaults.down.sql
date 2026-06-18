-- Down: 0170_engagement_template_defaults.sql
ALTER TABLE vibetb.engagement_template
  DROP COLUMN IF EXISTS default_mixed_mode_enabled,
  DROP COLUMN IF EXISTS default_fee_passthrough_enabled,
  DROP COLUMN IF EXISTS default_tax_enabled,
  DROP COLUMN IF EXISTS default_tax_rate_bps,
  DROP COLUMN IF EXISTS default_tax_label,
  DROP COLUMN IF EXISTS default_surcharge_enabled,
  DROP COLUMN IF EXISTS default_surcharge_type,
  DROP COLUMN IF EXISTS default_surcharge_value_bps,
  DROP COLUMN IF EXISTS default_surcharge_amount_cents,
  DROP COLUMN IF EXISTS default_surcharge_label,
  DROP COLUMN IF EXISTS default_recurrence_frequency;
