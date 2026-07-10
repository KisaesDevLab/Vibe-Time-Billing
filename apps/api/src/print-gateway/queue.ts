// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Producers for auto-print jobs: signature-confirmation reports (on tax
// return signing) and terminal payment receipts (on card-present
// completion). Enqueued from the completion paths; consumed by the
// worker, which renders + forwards to the gateway. Injectable so the API
// is unit-testable without Redis.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const SIGNATURE_CONFIRMATION_PRINT_QUEUE = 'signature-confirmation-print';
export const TERMINAL_RECEIPT_PRINT_QUEUE = 'terminal-receipt-print';

export interface SignatureConfirmationPrintJob {
  requestId: string;
}
export interface TerminalReceiptPrintJob {
  receiptId: string;
  printerId: number;
}

export interface PrintQueue {
  signatureConfirmation(job: SignatureConfirmationPrintJob): Promise<void>;
  terminalReceipt(job: TerminalReceiptPrintJob): Promise<void>;
}

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const queues = new Map<string, Queue>();

function q(name: string): Queue {
  let queue = queues.get(name);
  if (!queue) {
    const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
    const connection = new IORedis(url, { maxRetriesPerRequest: null });
    queue = new Queue(name, { connection });
    queues.set(name, queue);
  }
  return queue;
}

/** Real BullMQ-backed producer (lazy Redis connection). Deterministic
 *  jobIds keep re-enqueues (webhook + poll re-delivery) idempotent. */
export const bullPrintQueue: PrintQueue = {
  async signatureConfirmation(job) {
    await q(SIGNATURE_CONFIRMATION_PRINT_QUEUE).add('print', job, {
      ...JOB_OPTS,
      jobId: `sigconf:${job.requestId}`,
    });
  },
  async terminalReceipt(job) {
    await q(TERMINAL_RECEIPT_PRINT_QUEUE).add('print', job, {
      ...JOB_OPTS,
      jobId: `termreceipt:${job.receiptId}`,
    });
  },
};

/** No-op producer for tests / API-without-worker. */
export const noopPrintQueue: PrintQueue = {
  async signatureConfirmation() {},
  async terminalReceipt() {},
};
