// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Shared pill tones + types for client tasks, used by both the per-client
// TasksCard and the top-level Tasks list page.

export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELED';

export const PRIORITY_TONE: Record<TaskPriority, 'neutral' | 'accent' | 'warning' | 'danger'> = {
  LOW: 'neutral',
  MEDIUM: 'accent',
  HIGH: 'warning',
  URGENT: 'danger',
};

export const STATUS_TONE: Record<TaskStatus, 'neutral' | 'accent' | 'success' | 'warning'> = {
  OPEN: 'neutral',
  IN_PROGRESS: 'accent',
  BLOCKED: 'warning',
  DONE: 'success',
  CANCELED: 'neutral',
};
