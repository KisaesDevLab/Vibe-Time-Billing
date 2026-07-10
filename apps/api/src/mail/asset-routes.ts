// SPDX-License-Identifier: Elastic-2.0
//
// Public (no-session) surface serving stashed mail attachments to
// EmailIt's fetcher — the URL side of MAIL_EMAILIT_ATTACHMENT_MODE=url.
// Mounted at /api/mail-assets, outside both auth chains like /api/pay:
// the 64-hex random token is the credential, entries expire on a short
// TTL, and unknown/expired tokens 404 without distinguishing the two.

import express, { type Request, type Response, type Router } from 'express';

import type { MailAssetStore } from './asset-store';

const TOKEN_RE = /^[a-f0-9]{64}$/;

export function createMailAssetRouter(store: MailAssetStore): Router {
  const router = express.Router();

  router.get('/:token', (req: Request, res: Response) => {
    const token = req.params['token']!;
    if (!TOKEN_RE.test(token)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const asset = store.get(token);
    if (!asset) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Filenames are firm-generated (client names sanitized upstream), but
    // strip quote/control chars anyway so the header can't be broken.
    const safeName = asset.filename.replace(/["\r\n]/g, '');
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(asset.content);
  });

  return router;
}
