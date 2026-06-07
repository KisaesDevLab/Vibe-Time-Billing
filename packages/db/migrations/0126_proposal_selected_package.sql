-- 0126_proposal_selected_package.sql
-- Record which package tier the client selected when accepting a proposal.
--
-- A "tier" is a row in vibetb.packages (rows sharing a name are the tiers of
-- one package, distinguished by tier_label). The package_selector block offers
-- those tiers; on acceptance the client's choice is captured here as the
-- authoritative selection that scope-freeze materializes into the engagement.
-- proposal_packages.selected is kept in sync as the per-proposal offer record.

ALTER TABLE vibetb.proposals
  ADD COLUMN IF NOT EXISTS selected_package_id uuid;

-- FK added separately so a re-run stays resilient if the constraint exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'proposals_selected_package_id_fk'
  ) THEN
    ALTER TABLE vibetb.proposals
      ADD CONSTRAINT proposals_selected_package_id_fk
      FOREIGN KEY (selected_package_id)
      REFERENCES vibetb.packages(id) ON DELETE SET NULL;
  END IF;
END $$;
