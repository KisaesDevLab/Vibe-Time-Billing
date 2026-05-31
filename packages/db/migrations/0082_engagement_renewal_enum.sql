-- =====================================================================
-- Migration: 0082_engagement_renewal_enum.sql
--
-- Recurring engagements (Q23) — extend the approval entity-type enum so
-- the collision case (scheduled recurrence fires but previous engagement
-- is still ACTIVE) can queue a partner-decision approval through the
-- existing approval-requests machinery.
--
-- Split from 0083 (table DDL) because `ALTER TYPE ... ADD VALUE`
-- requires the new value to be committed before any subsequent DDL/DML
-- in the same transaction can reference it. Same pattern as 0040 split
-- from 0041.
-- =====================================================================

ALTER TYPE approval_entity_type ADD VALUE IF NOT EXISTS 'ENGAGEMENT_RENEWAL';
