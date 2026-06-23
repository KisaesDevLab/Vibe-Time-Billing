// SPDX-License-Identifier: Elastic-2.0
//
// Pure helpers for discovering backup destinations from the contents of
// /proc/mounts. The API does the I/O (read the file, statfs each candidate);
// these functions are the testable filtering logic that decides which mounts
// are plausible backup targets.

/** The appliance's durable on-box backup volume — always offered. */
export const DEFAULT_DESTINATION = '/backups';

/**
 * Roots under which external/removable drives are mounted. A mount is a
 * candidate when it is /backups or lives under one of these (or is one of
 * them). The api binds the host's /mnt + /media into its own namespace so
 * these surface; the executor binds them read-write so a chosen path is
 * actually writable.
 */
export const EXTERNAL_ROOTS = ['/mnt', '/media', '/run/media'] as const;

/** Pseudo / virtual filesystems that are never backup targets. */
const EXCLUDED_FSTYPES = new Set([
  'proc',
  'sysfs',
  'tmpfs',
  'devtmpfs',
  'devpts',
  'cgroup',
  'cgroup2',
  'mqueue',
  'overlay',
  'shm',
  'securityfs',
  'pstore',
  'bpf',
  'tracefs',
  'debugfs',
  'configfs',
  'fusectl',
  'hugetlbfs',
  'autofs',
  'binfmt_misc',
  'rpc_pipefs',
  'nsfs',
  'fuse.lxcfs',
  'ramfs',
  'efivarfs',
]);

export interface MountEntry {
  device: string;
  path: string;
  fstype: string;
  options: string;
}

/**
 * Parse the contents of /proc/mounts into structured entries. Octal escapes
 * (\040 for space, etc.) in the device/path fields are decoded the way the
 * kernel emits them.
 */
export function parseProcMounts(content: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    out.push({
      device: unescapeMount(parts[0]!),
      path: unescapeMount(parts[1]!),
      fstype: parts[2]!,
      options: parts[3] ?? '',
    });
  }
  return out;
}

function unescapeMount(s: string): string {
  return s.replace(/\\(\d{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Whether a mount entry is a plausible backup destination. The bare external
 * roots (/mnt, /media) are the appliance's bind mounts, not drives, so only
 * entries strictly *under* a root (an actual mounted drive) qualify — plus the
 * durable /backups volume.
 */
export function isBackupCandidate(mount: MountEntry): boolean {
  if (EXCLUDED_FSTYPES.has(mount.fstype)) return false;
  if (mount.path === DEFAULT_DESTINATION) return true;
  return EXTERNAL_ROOTS.some((root) => mount.path.startsWith(`${root}/`));
}

/**
 * Candidate destination paths from raw /proc/mounts contents — deduped and
 * sorted, with the durable default first. The api enriches each with free
 * space / fstype before returning to the UI.
 */
export function backupDestinationsFromMounts(content: string): MountEntry[] {
  const seen = new Set<string>();
  const candidates = parseProcMounts(content)
    .filter(isBackupCandidate)
    .filter((m) => (seen.has(m.path) ? false : (seen.add(m.path), true)));
  candidates.sort((a, b) => {
    if (a.path === DEFAULT_DESTINATION) return -1;
    if (b.path === DEFAULT_DESTINATION) return 1;
    return a.path.localeCompare(b.path);
  });
  return candidates;
}
