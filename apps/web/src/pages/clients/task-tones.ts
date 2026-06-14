// SPDX-License-Identifier: Elastic-2.0
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

// Recurrence cadence. A recurring task opens its successor when completed.
export type TaskRecurrence =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'SEMIMONTHLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUAL'
  | 'ANNUAL';

// '' = does not repeat (form value); maps to null on the wire.
export const RECURRENCE_OPTIONS: ReadonlyArray<{ value: TaskRecurrence | ''; label: string }> = [
  { value: '', label: 'Does not repeat' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'BIWEEKLY', label: 'Bi-weekly' },
  { value: 'SEMIMONTHLY', label: 'Semi-monthly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'SEMIANNUAL', label: 'Semi-annual' },
  { value: 'ANNUAL', label: 'Annual' },
];

export const RECURRENCE_LABEL: Record<TaskRecurrence, string> = {
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Bi-weekly',
  SEMIMONTHLY: 'Semi-monthly',
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  SEMIANNUAL: 'Semi-annual',
  ANNUAL: 'Annual',
};
