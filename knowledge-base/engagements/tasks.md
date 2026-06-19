---
title: 'Tasks and the client Tasks card'
slug: tasks
category: engagements
audience: staff
tags: ['tasks', 'kanban', 'recurrence', 'assignee', 'todo']
---

# Tasks

Tasks are lightweight to-dos attached to a client. Manage them firm-wide on the **Tasks** page (`/tasks`) or inline on a client's **Tasks** card.

## Who can do this

Viewing tasks needs **client:read**; creating, editing, completing, or removing tasks needs **client:write**. Both endpoints live under the client, so a task always belongs to one client.

## Steps

1. Open **Tasks** from the left navigation.
2. Switch the view with the **Table** / **Kanban** tabs, and the scope with **My tasks** / **All tasks**.
3. Narrow the list: type in **Search title…** and press **Search**, tick **Show done / canceled**, or pick a due window (**All due dates**, **Due this week / month / quarter / year**). **Clear filters** resets everything.
4. Click **+ New task**. In the **New task** dialog set **Client \***, **Title \***, optional **Description**, **Priority**, **Due date**, **Assignee**, and **Repeats**. **Status** appears only when editing an existing task.
5. Save with **Create task** (new) or **Save changes** (edit). **Cancel** discards.
6. On a Table row use **Edit**, **Done** (hidden once a task is done/canceled), or **Remove**. In **Kanban**, drag a card between status columns; empty columns read **Drop here**.

## Field reference

- **Priority** — **Low**, **Medium**, **High**, **Urgent**.
- **Status** — **Open**, **In progress**, **Blocked**, **Done**, **Canceled** (stored as OPEN / IN_PROGRESS / BLOCKED / DONE / CANCELED).
- **Repeats** — **Does not repeat**, **Weekly**, **Bi-weekly**, **Semi-monthly**, **Monthly**, **Quarterly**, **Semi-annual**, **Annual**. When a recurrence is set the dialog notes: _"When this task is completed, the next one opens automatically."_ Completing the task auto-spawns the next occurrence.
- **Assignee** — clearable; blank shows **Unassigned**.

## Per-client Tasks card

On the client detail page the **Tasks** card shows an **{n} active** pill. **+ Add task** opens an inline form (**Task title \***, **Description (optional)**, **Priority**, **Assignee…**, **Repeats** with help text _"When completed, the next task opens automatically."_). Rows offer **Done**, **Start** (while OPEN), **Edit**, and **Remove**. Empty states read **No active tasks.** / **No tasks yet.**

## Common errors

**Client** and **Title** are required (marked **\***). The Table empty state — **No tasks** / _"Create a task or adjust the scope / filters above."_ — usually means your scope or filters hid everything, not that creation failed.

Related: [[engagements-list]], [[creating-engagements]], [[dashboard-overview]], [[client-detail]]
