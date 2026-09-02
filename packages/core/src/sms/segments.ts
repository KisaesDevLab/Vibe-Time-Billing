// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// SMS segment counting (GSM-7 vs UCS-2) for the composer counter and the
// send path. Twilio bills per segment: 160 GSM-7 chars in one segment
// (153 each when concatenated), 70 UCS-2 code units (67 concatenated).
// GSM-7 extension characters cost two units.

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENSION = '^{}\\[~]|€\f';

const BASIC = new Set(GSM7_BASIC);
const EXT = new Set(GSM7_EXTENSION);

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SmsSegmentInfo {
  encoding: SmsEncoding;
  /** encoded units (GSM-7 septets or UCS-2 code units) */
  units: number;
  segments: number;
  /** units available per segment at this length */
  perSegment: number;
  /** units left before the next segment starts */
  remaining: number;
}

export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!BASIC.has(ch) && !EXT.has(ch)) return false;
  }
  return true;
}

export function countSmsSegments(text: string): SmsSegmentInfo {
  if (text.length === 0) {
    return { encoding: 'GSM-7', units: 0, segments: 0, perSegment: 160, remaining: 160 };
  }
  if (isGsm7(text)) {
    let units = 0;
    for (const ch of text) units += EXT.has(ch) ? 2 : 1;
    const perSegment = units <= 160 ? 160 : 153;
    const segments = units <= 160 ? 1 : Math.ceil(units / 153);
    const capacity = segments === 1 ? 160 : segments * 153;
    return { encoding: 'GSM-7', units, segments, perSegment, remaining: capacity - units };
  }
  // UCS-2: UTF-16 code units (astral characters count twice).
  const units = text.length;
  const perSegment = units <= 70 ? 70 : 67;
  const segments = units <= 70 ? 1 : Math.ceil(units / 67);
  const capacity = segments === 1 ? 70 : segments * 67;
  return { encoding: 'UCS-2', units, segments, perSegment, remaining: capacity - units };
}
