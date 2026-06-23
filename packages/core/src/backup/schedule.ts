// SPDX-License-Identifier: Elastic-2.0
//
// Pure scheduling + retention logic for the configurable appliance backup
// (Q12 revision — see QUESTIONS.md). The executor lives in
// ops/scripts/backup.sh (the only container with pg_dump + the /backups
// volume); this module is the single source of truth the API/UI use to
// compute the next run, validate config, and surface the recommended
// retention policy. The executor mirrors only the trivial "is it due"
// interval check in SQL — all richer logic stays here, unit-tested.

/** How often a scheduled backup runs. */
export type BackupFrequency = 'daily' | 'every_2_days' | 'weekly';

export const BACKUP_FREQUENCIES: readonly BackupFrequency[] = [
  'daily',
  'every_2_days',
  'weekly',
] as const;

/**
 * Recommended defaults, surfaced in the Backup tab.
 *
 * Cadence: DAILY. A practice's working set (time entries, invoices,
 * payments) changes every business day; a day-grained dump bounds worst-case
 * data loss to a single day.
 *
 * Retention: 30 days of daily DB dumps. At a typical single-firm DB size this
 * is a few hundred MB compressed — cheap insurance that comfortably spans a
 * monthly close cycle and a long holiday gap before anyone notices a problem.
 *
 * Key bundle: keep the last 14 encrypted bundles. App keys (KMS_KEY, the JWT
 * signing secrets, the DB password) change rarely, so a shallow history is
 * enough to recover across a key rotation without hoarding secrets.
 */
export const RECOMMENDED_FREQUENCY: BackupFrequency = 'daily';
export const RECOMMENDED_RETENTION_DAYS = 30;
export const RECOMMENDED_KEY_BUNDLE_KEEP = 14;

/** Allowed retention window, in days. */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650; // 10y ceiling guards against typos.

export interface BackupSchedule {
  enabled: boolean;
  frequency: BackupFrequency;
  /** Wall-clock time of day to run, "HH:MM" in UTC (the appliance runs UTC). */
  timeOfDayUtc: string;
  retentionDays: number;
}

/** Days between scheduled runs for a given frequency. */
export function frequencyToIntervalDays(frequency: BackupFrequency): number {
  switch (frequency) {
    case 'daily':
      return 1;
    case 'every_2_days':
      return 2;
    case 'weekly':
      return 7;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Validate a "HH:MM" 24h time string and return [hours, minutes]. */
export function parseTimeOfDay(timeOfDayUtc: string): { hours: number; minutes: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeOfDayUtc);
  if (!m) {
    throw new Error(`invalid timeOfDayUtc "${timeOfDayUtc}" (want "HH:MM" 24h UTC)`);
  }
  return { hours: Number(m[1]), minutes: Number(m[2]) };
}

/**
 * The instant a scheduled backup is next eligible to fire. Calendar-based and
 * anchored on the configured time-of-day: a backup runs at most once per
 * `intervalDays` calendar days, at `timeOfDayUtc`.
 *
 *   - Never run: today's time-of-day. (Becomes due the moment that passes; a
 *     fresh appliance backs up the same day rather than waiting.)
 *   - Otherwise: the time-of-day on (lastSuccess's UTC date + intervalDays).
 *
 * The returned instant may be in the past when a run is overdue — `isBackupDue`
 * treats that as due, and the UI reads it as "scheduled (will run on the next
 * executor tick)". This matches the executor's SQL day-difference check so the
 * two never disagree.
 */
export function computeNextRunAt(
  schedule: Pick<BackupSchedule, 'frequency' | 'timeOfDayUtc'>,
  lastSuccessAt: Date | null,
  now: Date,
): Date {
  const { hours, minutes } = parseTimeOfDay(schedule.timeOfDayUtc);
  const slotOn = (base: Date): Date => {
    const d = new Date(base);
    d.setUTCHours(hours, minutes, 0, 0);
    return d;
  };

  if (lastSuccessAt === null) {
    return slotOn(now);
  }

  const targetDate = new Date(lastSuccessAt);
  targetDate.setUTCDate(targetDate.getUTCDate() + frequencyToIntervalDays(schedule.frequency));
  return slotOn(targetDate);
}

/**
 * Whether a scheduled backup is due now. A manual trigger is handled
 * separately by the executor (it bypasses the schedule entirely).
 */
export function isBackupDue(
  schedule: Pick<BackupSchedule, 'enabled' | 'frequency' | 'timeOfDayUtc'>,
  lastSuccessAt: Date | null,
  now: Date,
): boolean {
  if (!schedule.enabled) {
    return false;
  }
  return now.getTime() >= computeNextRunAt(schedule, lastSuccessAt, now).getTime();
}

/** A backup artifact on disk, for retention pruning. */
export interface BackupArtifact {
  name: string;
  mtimeMs: number;
}

/**
 * Names of artifacts older than the retention window (mirrors the executor's
 * `find -mtime` prune). Anything strictly older than `retentionDays` from
 * `now` is prunable.
 */
export function prunableBackups(
  artifacts: readonly BackupArtifact[],
  retentionDays: number,
  now: Date,
): string[] {
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  return artifacts.filter((a) => a.mtimeMs < cutoff).map((a) => a.name);
}

export interface RetentionValidation {
  ok: boolean;
  retentionDays: number;
  reason?: string;
}

/** Clamp + validate an operator-supplied retention value. */
export function validateRetentionDays(input: number): RetentionValidation {
  if (!Number.isFinite(input) || !Number.isInteger(input)) {
    return { ok: false, retentionDays: RECOMMENDED_RETENTION_DAYS, reason: 'not_an_integer' };
  }
  if (input < MIN_RETENTION_DAYS) {
    return { ok: false, retentionDays: MIN_RETENTION_DAYS, reason: 'below_minimum' };
  }
  if (input > MAX_RETENTION_DAYS) {
    return { ok: false, retentionDays: MAX_RETENTION_DAYS, reason: 'above_maximum' };
  }
  return { ok: true, retentionDays: input };
}

/**
 * Human-readable recommendation text for the Backup tab. Kept here so the
 * suggested policy lives next to the constants it describes.
 */
export function retentionRecommendation(): string {
  return (
    `Recommended: ${RECOMMENDED_FREQUENCY} backups, retained ${RECOMMENDED_RETENTION_DAYS} days. ` +
    `Keep the last ${RECOMMENDED_KEY_BUNDLE_KEEP} encrypted app-key bundles. ` +
    'For an off-site copy, point the destination at an external drive and rotate ' +
    'drives weekly (grandfather-father-son): one daily on-appliance, one weekly off-site.'
  );
}
