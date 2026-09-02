// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Account → Notifications: per-user desktop/browser notifications for
// inbound texts (0234, D13a). The preference lives in localStorage on this
// device; the permission grant is requested from the toggle (browsers
// require a user gesture).

import { useState } from 'react';

import { Card, tokens } from '@vibe/ui';

import { notificationsSupported, requestNotifyPermission } from '../../lib/desktop';
import { useSmsStream } from '../../lib/sms-stream';

export function SmsNotificationsCard(): JSX.Element | null {
  const stream = useSmsStream();
  const [status, setStatus] = useState<string | null>(null);
  if (!notificationsSupported()) return null;
  return (
    <Card title="Notifications">
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <input
          type="checkbox"
          checked={stream.notifyEnabled}
          onChange={(e) => {
            const on = e.target.checked;
            if (!on) {
              stream.setNotifyEnabled(false);
              setStatus(null);
              return;
            }
            void requestNotifyPermission().then((r) => {
              if (r === 'granted') {
                stream.setNotifyEnabled(true);
                setStatus('Enabled on this device.');
              } else {
                stream.setNotifyEnabled(false);
                setStatus(
                  r === 'denied'
                    ? 'Blocked by the browser or OS — allow notifications for this site/app and try again.'
                    : 'Not supported here.',
                );
              }
            });
          }}
        />
        Desktop notifications for new texts assigned to me (or unassigned)
      </label>
      {status && (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 0 }} role="status">
          {status}
        </p>
      )}
    </Card>
  );
}
