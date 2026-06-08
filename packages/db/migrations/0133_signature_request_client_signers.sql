-- 0133_signature_request_client_signers.sql
-- New signature-request flow: associate a request with one of the client's
-- engagements, and record provenance when a signer was pulled from the
-- client's people list (contact / person / portal identity). All additions
-- are nullable + backward-compatible — manually-typed signers leave them null.

ALTER TABLE vibetb.signature_requests
  ADD COLUMN IF NOT EXISTS engagement_id uuid
    REFERENCES vibetb.engagement (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS signature_requests_firm_engagement_idx
  ON vibetb.signature_requests (firm_id, engagement_id);

ALTER TABLE vibetb.signature_signers
  ADD COLUMN IF NOT EXISTS person_id uuid
    REFERENCES vibetb.person (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS client_contact_id uuid
    REFERENCES vibetb.client_contact (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS portal_identity_id uuid
    REFERENCES vibetb.portal_identity (id) ON DELETE SET NULL;
