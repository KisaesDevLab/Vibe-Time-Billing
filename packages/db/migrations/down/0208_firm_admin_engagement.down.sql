-- Removes the flag column only. Seeded rows (internal client/engagement/
-- work codes/service line) are ordinary data — leave them; time entries may
-- already reference them.
ALTER TABLE vibetb.engagement DROP COLUMN IF EXISTS firm_admin;
