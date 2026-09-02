// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared composer styles for the messaging surfaces (engagement threads,
// team chat, SMS). There is no Textarea primitive in @vibe/ui; every
// composer uses a raw <textarea> with this token-driven style.

import { tokens } from '@vibe/ui';

export const composerTextareaStyle: React.CSSProperties = {
  flex: 1,
  width: '100%',
  boxSizing: 'border-box',
  padding: tokens.space.sm,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  background: tokens.color.surface,
  color: tokens.color.text,
  fontSize: 13,
  fontFamily: tokens.font.body,
  resize: 'vertical',
};
