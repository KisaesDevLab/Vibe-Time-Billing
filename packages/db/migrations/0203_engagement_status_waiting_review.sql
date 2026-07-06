-- 0203 — two additional engagement workflow statuses: "In Review" and
-- "Waiting on Client". Seeded for every firm (single-firm appliance) so they
-- are available in the status picker, the kanban board, and the list-view row
-- coloring. is_system = false, so a firm may recolor / rename / delete them in
-- Admin → Engagement Statuses. Colors are chosen distinct from the built-ins
-- (In Review = indigo, Waiting on Client = amber). ON CONFLICT keeps re-runs
-- and firms that already created a same-key status idempotent.
INSERT INTO vibetb.engagement_status_config
  (firm_id, workflow_state, label, color, sort_order, kanban_visible,
   triggers_client_comm, is_system, client_visible)
SELECT f.id, v.ws, v.label, v.color, v.sort_order, true, false, false, true
FROM vibetb.firm f
CROSS JOIN (VALUES
  ('IN_REVIEW',         'In Review',         '#6366f1', 55),
  ('WAITING_ON_CLIENT', 'Waiting on Client', '#eab308', 65)
) AS v(ws, label, color, sort_order)
ON CONFLICT (firm_id, workflow_state) DO NOTHING;
