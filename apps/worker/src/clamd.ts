// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Minimal clamd (ClamAV daemon) TCP client for the intake virus-scan gate.
// Uses the INSTREAM command so we never write the candidate to clamd's
// filesystem: bytes are chunked over the socket (4-byte big-endian length
// prefix per chunk, terminated by a zero-length chunk) and clamd replies
// "stream: OK" or "stream: <signature> FOUND".
//
// clamd is an opt-in sidecar (compose `intake` profile). When CLAMD_HOST is
// unset the scanner is "not configured" — callers decide the policy
// (the intake job logs loudly and treats unconfigured as a skip so the
// pipeline still works on appliances that haven't enabled the sidecar).

import net from 'node:net';

const CHUNK = 64 * 1024;

export interface ClamScanResult {
  status: 'clean' | 'infected' | 'skipped';
  signature?: string;
}

export function isClamdConfigured(): boolean {
  return Boolean(process.env['CLAMD_HOST']);
}

/** Parse a clamd INSTREAM reply (may carry a trailing NUL from the 'z'
 *  command prefix). Returns null when the reply is unrecognized. */
export function parseClamdReply(raw: string): ClamScanResult | null {
  const text = raw.replace(/\0+$/, '').trim();
  const found = /:\s*(.+)\s+FOUND$/.exec(text);
  if (found) return { status: 'infected', signature: found[1] };
  if (/\bOK$/.test(text)) return { status: 'clean' };
  return null;
}

function clamdHostPort(): { host: string; port: number } {
  return {
    host: process.env['CLAMD_HOST'] ?? '127.0.0.1',
    port: Number(process.env['CLAMD_PORT'] ?? '3310'),
  };
}

/** Scan a buffer through clamd INSTREAM. Rejects on connection/timeout
 *  errors so the caller can fail closed (leave the file unscanned). */
export function clamdScan(buf: Buffer, timeoutMs = 60_000): Promise<ClamScanResult> {
  if (!isClamdConfigured()) {
    return Promise.resolve({ status: 'skipped' });
  }
  const { host, port } = clamdHostPort();
  return new Promise<ClamScanResult>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const reply: Buffer[] = [];
    let settled = false;

    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => done(() => reject(new Error('clamd timeout'))));
    socket.on('error', (err) => done(() => reject(err)));
    socket.on('data', (d) => reply.push(d));
    socket.on('end', () => {
      const raw = Buffer.concat(reply).toString('utf8');
      const parsed = parseClamdReply(raw);
      if (parsed) {
        done(() => resolve(parsed));
        return;
      }
      done(() =>
        reject(new Error(`clamd unexpected reply: ${raw.replace(/\0+$/, '') || '(empty)'}`)),
      );
    });

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let off = 0; off < buf.byteLength; off += CHUNK) {
        const slice = buf.subarray(off, Math.min(off + CHUNK, buf.byteLength));
        const len = Buffer.allocUnsafe(4);
        len.writeUInt32BE(slice.byteLength, 0);
        socket.write(len);
        socket.write(slice);
      }
      // Zero-length chunk signals end of stream.
      const term = Buffer.allocUnsafe(4);
      term.writeUInt32BE(0, 0);
      socket.write(term);
    });
  });
}
