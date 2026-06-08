-- 0136 — add a 'SHARED' value to the tax_access_event enum.
--
-- A client creating a 3rd-party share was being logged as 'RELEASED'
-- (the staff release event), which made the access history ambiguous —
-- a "RELEASED · client" row actually meant "client shared externally".
-- 'SHARED' gives client-initiated outbound shares their own event so the
-- firm's access-history view reads correctly.
--
-- Note: ALTER TYPE ... ADD VALUE is transaction-safe on PostgreSQL 12+
-- as long as the new value isn't *used* in the same transaction (the
-- migration runner only records the filename afterward — it doesn't use
-- the value). The type lives in vibetb after 0057's schema split.

ALTER TYPE vibetb.tax_access_event ADD VALUE IF NOT EXISTS 'SHARED';
