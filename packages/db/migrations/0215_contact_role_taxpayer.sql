-- =====================================================================
-- Migration: 0215_contact_role_taxpayer.sql
--
-- Client import (CSV / UltraTax XLSX) + the People card tag a 1040
-- client's people as Taxpayer / Spouse. 0034 seeded `spouse` but no
-- counterpart for the taxpayer; add it for every existing firm (the
-- importer tolerates its absence — role_id just stays NULL).
-- =====================================================================

INSERT INTO vibetb.contact_role (firm_id, key, name)
SELECT f.id, 'taxpayer', 'Taxpayer'
FROM vibetb.firm f
ON CONFLICT DO NOTHING;
