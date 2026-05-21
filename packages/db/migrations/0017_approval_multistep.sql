-- =====================================================================
-- Migration: 0017_approval_multistep.sql
--
-- Multi-step approval routing (Phase 18 #5). An approval request can
-- have a chain of approvers (e.g. manager → partner). When the current
-- approver acts at step N:
--   - APPROVE + more steps remain → advance to step N+1, reassign
--     approver_id from steps_json[N+1], keep status PENDING
--   - APPROVE + last step          → mark APPROVED
--   - REJECT                       → terminal regardless of step
--
-- steps_json shape: [{ approverId | approverRoleSlug, slaHours? }, ...]
-- The first step's approver lives in approver_id at creation time and
-- corresponds to steps_json[0].
-- =====================================================================

ALTER TABLE approval_request
  ADD COLUMN IF NOT EXISTS current_step INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS total_steps INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS steps_json JSONB;
