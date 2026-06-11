// SPDX-License-Identifier: Elastic-2.0
//
// BK-4/BK-5/BK-6 — booking job producers. Creating/rescheduling/cancelling
// a multi-staff appointment fans out per-staff calendar writes and one
// confirmation/cancellation email job. The BookingQueue interface is
// injectable so the booking API is unit-testable without Redis; the
// default implementation enqueues onto BullMQ (consumed by the worker).

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const APPOINTMENT_PROVIDER_WRITE_QUEUE = 'appointment-provider-write';
export const APPOINTMENT_PROVIDER_UPDATE_QUEUE = 'appointment-provider-update';
export const APPOINTMENT_PROVIDER_DELETE_QUEUE = 'appointment-provider-delete';
export const APPOINTMENT_CONFIRMATION_QUEUE = 'appointment-confirmation-send';
export const APPOINTMENT_RESCHEDULE_CONFIRMATION_QUEUE = 'appointment-reschedule-confirmation-send';
export const APPOINTMENT_CANCELLATION_QUEUE = 'appointment-cancellation-send';
export const APPOINTMENT_DECLINE_QUEUE = 'appointment-decline-send';
export const APPOINTMENT_RESCHEDULE_REQUESTED_STAFF_QUEUE =
  'appointment-reschedule-requested-staff';

export interface ProviderJob {
  appointmentId: string;
  staffId: string;
}
export interface AppointmentJob {
  appointmentId: string;
}
export interface CancellationJob {
  appointmentId: string;
  cancelledBy: 'staff' | 'client';
  excludeContactId?: string | null;
}
export interface RescheduleRequestedStaffJob {
  appointmentId: string;
  message?: string | null;
}

/** The producer surface the booking API depends on (injectable for tests). */
export interface BookingQueue {
  providerWrite(job: ProviderJob): Promise<void>;
  providerUpdate(job: ProviderJob): Promise<void>;
  providerDelete(job: ProviderJob): Promise<void>;
  confirmationSend(job: AppointmentJob): Promise<void>;
  rescheduleConfirmationSend(job: AppointmentJob): Promise<void>;
  cancellationSend(job: CancellationJob): Promise<void>;
  declineSend(job: AppointmentJob): Promise<void>;
  rescheduleRequestedStaffSend(job: RescheduleRequestedStaffJob): Promise<void>;
}

const PROVIDER_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 120_000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};
const EMAIL_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

let queues: Map<string, Queue> | null = null;

function q(name: string): Queue {
  if (!queues) {
    const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
    const connection = new IORedis(url, { maxRetriesPerRequest: null });
    queues = new Map();
    for (const n of [
      APPOINTMENT_PROVIDER_WRITE_QUEUE,
      APPOINTMENT_PROVIDER_UPDATE_QUEUE,
      APPOINTMENT_PROVIDER_DELETE_QUEUE,
      APPOINTMENT_CONFIRMATION_QUEUE,
      APPOINTMENT_RESCHEDULE_CONFIRMATION_QUEUE,
      APPOINTMENT_CANCELLATION_QUEUE,
      APPOINTMENT_DECLINE_QUEUE,
      APPOINTMENT_RESCHEDULE_REQUESTED_STAFF_QUEUE,
    ]) {
      queues.set(n, new Queue(n, { connection }));
    }
  }
  return queues.get(name)!;
}

/** The real BullMQ-backed producer (lazy Redis connection). */
export const bullBookingQueue: BookingQueue = {
  async providerWrite(job) {
    await q(APPOINTMENT_PROVIDER_WRITE_QUEUE).add('write', job, PROVIDER_OPTS);
  },
  async providerUpdate(job) {
    await q(APPOINTMENT_PROVIDER_UPDATE_QUEUE).add('update', job, PROVIDER_OPTS);
  },
  async providerDelete(job) {
    await q(APPOINTMENT_PROVIDER_DELETE_QUEUE).add('delete', job, PROVIDER_OPTS);
  },
  async confirmationSend(job) {
    await q(APPOINTMENT_CONFIRMATION_QUEUE).add('send', job, EMAIL_OPTS);
  },
  async rescheduleConfirmationSend(job) {
    await q(APPOINTMENT_RESCHEDULE_CONFIRMATION_QUEUE).add('send', job, EMAIL_OPTS);
  },
  async cancellationSend(job) {
    await q(APPOINTMENT_CANCELLATION_QUEUE).add('send', job, EMAIL_OPTS);
  },
  async declineSend(job) {
    await q(APPOINTMENT_DECLINE_QUEUE).add('send', job, EMAIL_OPTS);
  },
  async rescheduleRequestedStaffSend(job) {
    await q(APPOINTMENT_RESCHEDULE_REQUESTED_STAFF_QUEUE).add('send', job, EMAIL_OPTS);
  },
};

/** A no-op queue (used when the API runs without a worker, e.g. tests that
 *  don't assert enqueue). */
export const noopBookingQueue: BookingQueue = {
  async providerWrite() {},
  async providerUpdate() {},
  async providerDelete() {},
  async confirmationSend() {},
  async rescheduleConfirmationSend() {},
  async cancellationSend() {},
  async declineSend() {},
  async rescheduleRequestedStaffSend() {},
};
