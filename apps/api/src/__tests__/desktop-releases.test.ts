// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-3 — desktop release channel: manifest + artefact serving from
// DESKTOP_RELEASES_DIR with a tight filename allow-list.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDesktopReleasesRouter, createDesktopReleaseStatusRouter } from '../desktop/releases';

let dir: string;
let app: express.Express;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-releases-'));
  await writeFile(
    path.join(dir, 'latest.json'),
    JSON.stringify({
      version: '0.2.0',
      notes: 'tray + notifications',
      pub_date: '2026-08-22T00:00:00Z',
      platforms: {
        'windows-x86_64': {
          signature: 'sig',
          url: '/desktop/dl/Vibe_0.2.0_x64-setup.exe',
        },
      },
    }),
  );
  await writeFile(path.join(dir, 'Vibe_0.2.0_x64-setup.exe'), Buffer.from('MZ-not-really'));
  app = express();
  app.use('/desktop', createDesktopReleasesRouter({ releasesDir: dir }));
  app.use(
    '/cfg',
    createDesktopReleasesRouter({ releasesDir: dir, baseUrl: 'https://app.firm.test/' }),
  );
  app.use('/api/staff/desktop/releases', createDesktopReleaseStatusRouter({ releasesDir: dir }));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('desktop releases', () => {
  it('serves the manifest with download URLs resolved against the request origin', async () => {
    const res = await request(app).get('/desktop/latest.json').set('Host', 'app.firm.test');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('0.2.0');
    expect(res.body.platforms['windows-x86_64'].url).toBe(
      'http://app.firm.test/desktop/dl/Vibe_0.2.0_x64-setup.exe',
    );
    expect(res.headers['cache-control']).toContain('no-cache');
    // With APP_BASE_URL configured, that wins over the request host/proto
    // (proxies here do not forward X-Forwarded-Proto).
    const cfg = await request(app).get('/cfg/latest.json').set('Host', 'internal:3001');
    expect(cfg.body.platforms['windows-x86_64'].url).toBe(
      'https://app.firm.test/desktop/dl/Vibe_0.2.0_x64-setup.exe',
    );
  });

  it('serves an installer with a binary content type', async () => {
    const res = await request(app).get('/desktop/dl/Vibe_0.2.0_x64-setup.exe');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['content-length']).toBe('13');
  });

  it('refuses traversal-looking and unknown names', async () => {
    expect((await request(app).get('/desktop/dl/..%2Flatest.json')).status).toBe(404);
    expect((await request(app).get('/desktop/dl/latest.json')).status).toBe(404);
    expect((await request(app).get('/desktop/dl/missing.exe')).status).toBe(404);
  });

  it('status reflects the manifest', async () => {
    const res = await request(app).get('/api/staff/desktop/releases/status');
    expect(res.body).toEqual({
      configured: true,
      version: '0.2.0',
      pubDate: '2026-08-22T00:00:00Z',
    });
  });

  it('answers 404 / unconfigured when no dir is set', async () => {
    const bare = express();
    bare.use('/desktop', createDesktopReleasesRouter({ releasesDir: null }));
    bare.use('/s', createDesktopReleaseStatusRouter({ releasesDir: null }));
    expect((await request(bare).get('/desktop/latest.json')).status).toBe(404);
    expect((await request(bare).get('/s/status')).body.configured).toBe(false);
  });
});
