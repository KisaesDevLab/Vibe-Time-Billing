-- 0138 — store the OpenSign completion/audit certificate per signature
-- request (IP, signed date/time, signer trail), alongside the signed PDF.
--
-- The Signatures module previously kept only the signed document
-- (signed_file_url). The certificate is OpenSign's separate audit-trail
-- artifact; reconcile now fetches + stores it too so staff can download
-- the IP/date/time record.

ALTER TABLE vibetb.signature_requests
  ADD COLUMN certificate_file_url text;
