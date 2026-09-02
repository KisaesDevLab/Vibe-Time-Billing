// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Test helper: load a Twilio request fixture and sign it the way Twilio
// does for the given public URL. Twilio historically normalizes ports
// inconsistently, so `variants` yields the with/without-default-port forms.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { signTwilioRequest } from '../sms/twilio-signature';

export function loadTwilioFixture(name: string): Record<string, string> {
  const raw = readFileSync(join(__dirname, 'fixtures/twilio', `${name}.json`), 'utf8');
  return JSON.parse(raw) as Record<string, string>;
}

export function loadTwilioJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures/twilio', `${name}.json`), 'utf8')) as T;
}

export function signFixture(token: string, url: string, params: Record<string, string>): string {
  return signTwilioRequest(token, url, params);
}

export function urlVariants(base: string, path: string): string[] {
  const u = new URL(base);
  const defaultPort = u.protocol === 'https:' ? '443' : '80';
  const bare = `${u.protocol}//${u.hostname}${path}`;
  const withPort = `${u.protocol}//${u.hostname}:${u.port || defaultPort}${path}`;
  return [...new Set([base.replace(/\/$/, '') + path, bare, withPort])];
}
