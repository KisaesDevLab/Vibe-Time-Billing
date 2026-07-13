// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Appliance system health for Admin → Operations → System: disk size/used
// for the filesystem the appliance lives on, RAM total/used, and processor
// model/core count. Read-only, admin-gated. Numbers come from the container,
// which on the standard single-box install reflect the host: the root
// overlay sits on the host's docker partition and os.totalmem()/cpus() read
// host hardware. Container memory limits (if the operator sets them) are
// intentionally NOT resolved here — the drive question is about the box.

import { statfs } from 'node:fs/promises';
import os from 'node:os';

import express, { type Request, type Response, type Router } from 'express';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export type SystemInfoDeps = RbacDeps;

export function createSystemInfoRouter(deps: SystemInfoDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'admin:backup:manage'),
    async (_req: Request, res: Response) => {
      let disk: { totalBytes: number; usedBytes: number; availableBytes: number } | null = null;
      try {
        const s = await statfs('/');
        const total = s.blocks * s.bsize;
        // Used = blocks minus free-for-root; available = free for us
        // (ext4 reserves ~5% for root, hence used + available < total).
        disk = {
          totalBytes: total,
          usedBytes: (s.blocks - s.bfree) * s.bsize,
          availableBytes: s.bavail * s.bsize,
        };
      } catch (err) {
        logger.warn({ err }, 'system-info: statfs failed');
      }

      const cpus = os.cpus();
      res.json({
        disk,
        memory: {
          totalBytes: os.totalmem(),
          usedBytes: os.totalmem() - os.freemem(),
        },
        cpu: {
          model: cpus[0]?.model?.trim() ?? 'unknown',
          cores: cpus.length,
          // 1/5/15-minute load averages, host-wide.
          loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
        },
        uptimeSeconds: Math.round(os.uptime()),
        serverTime: new Date().toISOString(),
      });
    },
  );

  return router;
}
