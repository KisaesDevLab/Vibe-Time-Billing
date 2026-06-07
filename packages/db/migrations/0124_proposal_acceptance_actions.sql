-- 0124_proposal_acceptance_actions.sql
-- Per-proposal "on acceptance" controls:
--   create_engagement_on_accept — gate the (previously always-on) engagement
--     freeze that runs when the last required signer signs.
--   request_template_id_on_accept — when set (and engagement creation is on),
--     spawn a request list from this template onto the new engagement.

ALTER TABLE vibetb.proposals
  ADD COLUMN IF NOT EXISTS create_engagement_on_accept boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS request_template_id_on_accept uuid;

-- FK added separately (request_template lives in core; keep this resilient if
-- the constraint already exists from a prior run).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'proposals_request_template_fk'
  ) THEN
    ALTER TABLE vibetb.proposals
      ADD CONSTRAINT proposals_request_template_fk
      FOREIGN KEY (request_template_id_on_accept)
      REFERENCES vibetb.request_template(id) ON DELETE SET NULL;
  END IF;
END $$;
