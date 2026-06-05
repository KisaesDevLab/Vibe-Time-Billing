// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-9 — v2 write-back STUB. Two-way sync (TB-originated events pushed to
// the provider) is gated behind FEATURE_CALENDAR_WRITE and NOT implemented
// in v1. The interfaces + service shell exist so the routes can compile and
// the feature can be filled in without reshaping callers. See
// docs/calendar-writeback-v2.md.

import type { CalendarProvider } from './oauth';

export function isCalendarWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['FEATURE_CALENDAR_WRITE'] === 'true';
}

export interface WriteEventInput {
  title: string;
  start: Date;
  end: Date;
  location?: string | null;
  attendees?: string[];
}

// Provider-specific writers — empty shells for v2 (Graph + Google create/
// update/delete). Implemented behind the feature flag in a later release.
export interface ProviderEventWriter {
  createEvent(accessToken: string, calendarId: string, input: WriteEventInput): Promise<string>;
  updateEvent(
    accessToken: string,
    calendarId: string,
    providerEventId: string,
    input: Partial<WriteEventInput>,
  ): Promise<void>;
  deleteEvent(accessToken: string, calendarId: string, providerEventId: string): Promise<void>;
}

const NOT_WIRED = (): never => {
  throw new Error('calendar_writeback_not_implemented');
};

export class GraphEventWriter implements ProviderEventWriter {
  createEvent = NOT_WIRED;
  updateEvent = NOT_WIRED;
  deleteEvent = NOT_WIRED;
}

export class GoogleEventWriter implements ProviderEventWriter {
  createEvent = NOT_WIRED;
  updateEvent = NOT_WIRED;
  deleteEvent = NOT_WIRED;
}

export function writerFor(provider: CalendarProvider): ProviderEventWriter {
  return provider === 'microsoft' ? new GraphEventWriter() : new GoogleEventWriter();
}

export class CalendarWriteService {
  ensureEnabled(): void {
    if (!isCalendarWriteEnabled()) throw new Error('calendar_write_disabled');
  }

  async createEvent(): Promise<never> {
    this.ensureEnabled();
    // Would: insert calendar_events (tb_origin=true), then writer.createEvent.
    return NOT_WIRED();
  }

  async updateEvent(): Promise<never> {
    this.ensureEnabled();
    return NOT_WIRED();
  }

  async deleteEvent(): Promise<never> {
    this.ensureEnabled();
    return NOT_WIRED();
  }
}
