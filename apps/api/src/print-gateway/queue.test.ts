// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { noopPrintQueue, type PrintQueue } from './queue';

describe('PrintQueue', () => {
  it('noop producer resolves for both job types', async () => {
    await expect(
      noopPrintQueue.signatureConfirmation({ requestId: 'r1' }),
    ).resolves.toBeUndefined();
    await expect(
      noopPrintQueue.terminalReceipt({ receiptId: 'rc1', printerId: 3 }),
    ).resolves.toBeUndefined();
  });

  it('a custom producer receives the terminal receipt payload', async () => {
    const calls: Array<{ receiptId: string; printerId: number }> = [];
    const q: PrintQueue = {
      async signatureConfirmation() {},
      async terminalReceipt(job) {
        calls.push(job);
      },
    };
    await q.terminalReceipt({ receiptId: 'rc9', printerId: 7 });
    expect(calls).toEqual([{ receiptId: 'rc9', printerId: 7 }]);
  });
});
