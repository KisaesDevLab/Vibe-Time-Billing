ALTER TABLE vibetb.signature_requests DROP CONSTRAINT IF EXISTS signature_requests_notify_channel_ck;
ALTER TABLE vibetb.signature_requests DROP COLUMN IF EXISTS notify_channel;
ALTER TABLE vibetb.signature_signers DROP COLUMN IF EXISTS phone;
