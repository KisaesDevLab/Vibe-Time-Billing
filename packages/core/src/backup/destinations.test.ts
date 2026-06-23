// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from 'vitest';

import {
  backupDestinationsFromMounts,
  isBackupCandidate,
  parseProcMounts,
  DEFAULT_DESTINATION,
} from './destinations';

const SAMPLE = [
  'overlay / overlay rw,relatime 0 0',
  'proc /proc proc rw,nosuid 0 0',
  'tmpfs /dev/shm tmpfs rw,nosuid 0 0',
  '/dev/sda1 /backups ext4 rw,relatime 0 0',
  '/dev/sdb1 /mnt/backup-drive exfat rw,relatime 0 0',
  '/dev/sdc1 /media/usb-stick vfat rw,relatime 0 0',
  'tmpfs /mnt/ramdisk tmpfs rw 0 0',
  '/dev/sdd1 /data/files ext4 rw 0 0',
].join('\n');

describe('parseProcMounts', () => {
  it('parses device/path/fstype/options', () => {
    const entries = parseProcMounts('/dev/sda1 /backups ext4 rw,relatime 0 0\n');
    expect(entries).toEqual([
      { device: '/dev/sda1', path: '/backups', fstype: 'ext4', options: 'rw,relatime' },
    ]);
  });

  it('decodes octal-escaped spaces in paths', () => {
    const entries = parseProcMounts('/dev/sdb1 /media/My\\040Drive exfat rw 0 0\n');
    expect(entries[0]?.path).toBe('/media/My Drive');
  });

  it('skips blank and malformed lines', () => {
    expect(parseProcMounts('\n  \nbad line\n')).toEqual([]);
  });
});

describe('isBackupCandidate', () => {
  it('accepts /backups and external-root mounts', () => {
    expect(isBackupCandidate({ device: 'x', path: '/backups', fstype: 'ext4', options: '' })).toBe(
      true,
    );
    expect(
      isBackupCandidate({ device: 'x', path: '/mnt/drive', fstype: 'exfat', options: '' }),
    ).toBe(true);
    expect(
      isBackupCandidate({ device: 'x', path: '/media/usb', fstype: 'vfat', options: '' }),
    ).toBe(true);
  });

  it('rejects pseudo filesystems even under an external root', () => {
    expect(
      isBackupCandidate({ device: 'tmpfs', path: '/mnt/ramdisk', fstype: 'tmpfs', options: '' }),
    ).toBe(false);
  });

  it('rejects non-destination paths like / and /data', () => {
    expect(isBackupCandidate({ device: 'o', path: '/', fstype: 'overlay', options: '' })).toBe(
      false,
    );
    expect(
      isBackupCandidate({ device: 'x', path: '/data/files', fstype: 'ext4', options: '' }),
    ).toBe(false);
  });

  it('rejects the bare external roots (bind mounts, not drives)', () => {
    expect(isBackupCandidate({ device: 'x', path: '/mnt', fstype: 'ext4', options: '' })).toBe(
      false,
    );
    expect(isBackupCandidate({ device: 'x', path: '/media', fstype: 'ext4', options: '' })).toBe(
      false,
    );
  });
});

describe('backupDestinationsFromMounts', () => {
  it('returns only real backup targets, default first', () => {
    const paths = backupDestinationsFromMounts(SAMPLE).map((m) => m.path);
    expect(paths[0]).toBe(DEFAULT_DESTINATION);
    expect(paths).toContain('/mnt/backup-drive');
    expect(paths).toContain('/media/usb-stick');
    expect(paths).not.toContain('/mnt/ramdisk'); // tmpfs filtered
    expect(paths).not.toContain('/data/files'); // not a destination root
    expect(paths).not.toContain('/'); // overlay root
  });

  it('dedupes repeated mount paths', () => {
    const dup = '/dev/sda1 /backups ext4 rw 0 0\n/dev/sda1 /backups ext4 rw 0 0\n';
    expect(backupDestinationsFromMounts(dup)).toHaveLength(1);
  });
});
