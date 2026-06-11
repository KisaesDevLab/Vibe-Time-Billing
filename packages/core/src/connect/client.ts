// SPDX-License-Identifier: Elastic-2.0
//
// Vibe Connect integration client. Optional secondary notification
// channel + engagement-letter e-sign relay. The actual HTTP client lives
// in apps/api/src/connect/; this module is the typed interface.

export interface ConnectClient {
  isConfigured(): boolean;
  health(): Promise<{ ok: boolean; reason?: string }>;
  sendNotification(args: {
    portalIdentityId: string;
    event: 'invoice_sent' | 'payment_received' | 'payment_failed' | 'document_ready';
    payload: Record<string, unknown>;
  }): Promise<{ delivered: boolean; reason?: string }>;
}

/** No-op client for firms that haven't configured Connect. */
export const noopConnectClient: ConnectClient = {
  isConfigured: () => false,
  async health() {
    return { ok: false, reason: 'not_configured' };
  },
  async sendNotification() {
    return { delivered: false, reason: 'not_configured' };
  },
};
