-- Detach contacts from the role first (role_id is ON DELETE SET NULL, so a
-- plain delete would also work; be explicit).
UPDATE vibetb.client_contact SET role_id = NULL
WHERE role_id IN (SELECT id FROM vibetb.contact_role WHERE key = 'taxpayer');
DELETE FROM vibetb.contact_role WHERE key = 'taxpayer';
