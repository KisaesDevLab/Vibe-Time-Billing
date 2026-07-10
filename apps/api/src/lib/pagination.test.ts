// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { parsePageParams, pageEnvelope, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './pagination';

describe('parsePageParams', () => {
  it('defaults page=1 and pageSize=DEFAULT when absent', () => {
    const p = parsePageParams({});
    expect(p.page).toBe(1);
    expect(p.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(p.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(p.offset).toBe(0);
  });

  it('parses string query values and computes offset', () => {
    const p = parsePageParams({ page: '3', pageSize: '100' });
    expect(p.page).toBe(3);
    expect(p.pageSize).toBe(100);
    expect(p.offset).toBe(200); // (3-1)*100
  });

  it('clamps pageSize to MAX (does not reject an oversized request)', () => {
    expect(parsePageParams({ pageSize: '1000' }).pageSize).toBe(MAX_PAGE_SIZE);
    expect(parsePageParams({ pageSize: '0' }).pageSize).toBe(1);
  });

  it('floors page at 1 and ignores junk', () => {
    expect(parsePageParams({ page: '0' }).page).toBe(1);
    expect(parsePageParams({ page: '-5' }).page).toBe(1);
    expect(parsePageParams({ page: 'abc', pageSize: 'xyz' }).page).toBe(1);
    expect(parsePageParams({ page: 'abc', pageSize: 'xyz' }).pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('honors per-call overrides', () => {
    const p = parsePageParams({ pageSize: '400' }, { maxPageSize: 500, defaultPageSize: 25 });
    expect(p.pageSize).toBe(400);
    expect(parsePageParams({}, { defaultPageSize: 25 }).pageSize).toBe(25);
  });
});

describe('pageEnvelope', () => {
  it('wraps rows with items alias + meta', () => {
    const env = pageEnvelope([{ id: 'a' }], 42, 2, 50);
    expect(env.rows).toEqual([{ id: 'a' }]);
    expect(env.items).toBe(env.rows);
    expect(env).toMatchObject({ total: 42, page: 2, pageSize: 50 });
  });
});
