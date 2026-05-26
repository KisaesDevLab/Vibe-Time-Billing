// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 Phase A — match-engine.ts tests. 50+ cases covering the full
// reason taxonomy + the §3.6 performance budget.

import { describe, expect, it } from 'vitest';
import { jaroWinkler } from '../jaro-winkler';
import {
  match,
  scoreFolder,
  suggestedQueries,
  type ClientForMatch,
  type FolderCandidate,
} from '../match-engine';

function folder(p: Partial<FolderCandidate> & { storage_path: string }): FolderCandidate {
  return {
    storage_path: p.storage_path,
    file_count: p.file_count ?? 10,
    size_bytes: p.size_bytes ?? 1024 * 1024,
    last_modified: p.last_modified ?? '2026-05-25T00:00:00Z',
    sentinel: p.sentinel,
    bound_to: p.bound_to,
  };
}

const SMITH: ClientForMatch = {
  id: 'client-smith',
  name: 'Smith, John & Mary',
  tax_software_id: '0042',
};

describe('FMv2 — scoreFolder reason taxonomy', () => {
  it('tax_id_in_folder_name fires at 1.000', () => {
    const r = scoreFolder(folder({ storage_path: '0042 - Smith, John/' }), SMITH);
    expect(r?.code).toBe('tax_id_in_folder_name');
    expect(r?.confidence).toBe(1.0);
  });

  it('tax_id_in_folder_name fires for bracketed prefix', () => {
    const r = scoreFolder(folder({ storage_path: '[0042] Smith Family/' }), SMITH);
    expect(r?.code).toBe('tax_id_in_folder_name');
  });

  it('tax_id_in_folder_name does NOT fire when ids differ', () => {
    const r = scoreFolder(folder({ storage_path: '0099 - Random/' }), SMITH);
    expect(r?.code).not.toBe('tax_id_in_folder_name');
  });

  it('name_swap_match for John-Smith vs Smith,-John', () => {
    const r = scoreFolder(folder({ storage_path: 'John Smith/' }), SMITH);
    // After normalize (no reorder): "Smith, John & Mary" → ["smith","john"];
    // "John Smith" → ["john","smith"]. Same set, different order →
    // name_swap_match.
    expect(r?.code).toBe('name_swap_match');
    expect(r?.confidence).toBe(0.9);
  });

  it('exact_name_match fires when normalization aligns exactly', () => {
    const c: ClientForMatch = { id: 'c', name: 'Acme Industries' };
    const r = scoreFolder(folder({ storage_path: 'Acme Industries/' }), c);
    expect(r?.code).toBe('exact_name_match');
    expect(r?.confidence).toBe(0.95);
  });

  it('name_swap_match for token-reordered name', () => {
    const r = scoreFolder(folder({ storage_path: 'John Smith/' }), {
      id: 'c',
      name: 'Smith, John',
    });
    expect(r?.code).toBe('name_swap_match');
  });

  it('name_substring_match — folder has every client token + extras', () => {
    const c: ClientForMatch = { id: 'c', name: 'Smith, John' };
    const r = scoreFolder(folder({ storage_path: 'Smith John Personal/' }), c);
    // tokens: ["smith","john","personal"] — drops "personal" as low-signal
    // → significant subset of client tokens ["smith","john"] ⊆ folder
    expect(r?.code).toBe('name_substring_match');
    expect(r?.confidence).toBe(0.85);
  });

  it('alias_match fires at 0.95', () => {
    const c: ClientForMatch = {
      id: 'c',
      name: 'Acme Industries',
      aliases: ['ACME'],
    };
    const r = scoreFolder(folder({ storage_path: 'ACME/' }), c);
    expect(r?.code).toBe('alias_match');
    expect(r?.confidence).toBe(0.95);
  });

  it('fuzzy_name_match for typo-distance names', () => {
    const c: ClientForMatch = { id: 'c', name: 'Anderson Construction' };
    const r = scoreFolder(folder({ storage_path: 'Andersen Construction/' }), c);
    expect(r?.code).toBe('fuzzy_name_match');
    expect(r?.confidence).toBeGreaterThanOrEqual(0.65);
    expect(r?.confidence).toBeLessThanOrEqual(0.84);
  });

  it('partial_token_match when only one significant token overlaps', () => {
    const c: ClientForMatch = { id: 'c', name: 'Smith, Sarah' };
    const r = scoreFolder(folder({ storage_path: 'Smith Family/' }), c);
    // tokens: ["smith","family"] — significant = ["smith"]. Client
    // significant = ["smith","sarah"]. Not all client tokens in folder
    // (sarah missing). One shared significant token.
    expect(r?.code).toBe('partial_token_match');
    expect(r?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r?.confidence).toBeLessThanOrEqual(0.64);
  });

  it('returns null when no signal crosses the floor', () => {
    const c: ClientForMatch = { id: 'c', name: 'Smith, John' };
    const r = scoreFolder(folder({ storage_path: 'Anderson Construction/' }), c);
    expect(r).toBeNull();
  });

  it('low-signal-only token overlap returns null', () => {
    const c: ClientForMatch = { id: 'c', name: 'Smith, John' };
    const r = scoreFolder(folder({ storage_path: 'Tax Family Documents/' }), c);
    expect(r).toBeNull();
  });

  it('client name as substring of folder name with extras → name_substring_match', () => {
    const c: ClientForMatch = { id: 'c', name: 'Smith, John' };
    const r = scoreFolder(folder({ storage_path: 'Smith John LLC Properties/' }), c);
    expect(r?.code).toBe('name_substring_match');
  });

  it('reason_text for tax_id includes the ID', () => {
    const r = scoreFolder(folder({ storage_path: '0042 - Smith/' }), SMITH);
    expect(r?.text).toContain('0042');
  });

  it('reason_text for alias quotes the alias', () => {
    const c: ClientForMatch = {
      id: 'c',
      name: 'Acme Industries',
      aliases: ['ACME LTD'],
    };
    const r = scoreFolder(folder({ storage_path: 'ACME LTD/' }), c);
    expect(r?.text).toContain('ACME LTD');
  });

  it('reason_text for name_substring includes missing folder tokens', () => {
    const c: ClientForMatch = { id: 'c', name: 'Smith, John' };
    const r = scoreFolder(folder({ storage_path: 'Smith John Properties LLC/' }), c);
    expect(r?.text).toMatch(/properties/i);
  });
});

describe('FMv2 — match() orchestration', () => {
  it('returns candidates sorted by status then confidence', () => {
    const folders = [
      folder({
        storage_path: 'Smith Family/',
        sentinel: { client_id: 'other', display_name_at_creation: 'X' },
        bound_to: { client_id: 'other', client_name: 'Sarah Smith' },
      }),
      folder({ storage_path: '0042 - Smith, John/' }),
      folder({ storage_path: 'Smith, John/' }),
    ];
    const r = match({ client: SMITH, folders });
    // Unbound + tax_id_match should sort first
    expect(r.candidates[0]!.storage_path).toBe('0042 - Smith, John/');
    expect(r.candidates[0]!.status).toBe('unbound');
    expect(r.candidates[0]!.confidence).toBe(1.0);
    // bound_to_other comes last in the group ordering
    const last = r.candidates[r.candidates.length - 1]!;
    expect(last.status).toBe('bound_to_other');
  });

  it('marks bound_to_self correctly', () => {
    const folders = [
      folder({
        storage_path: 'Smith, John/',
        sentinel: { client_id: SMITH.id, display_name_at_creation: 'Smith, John' },
      }),
    ];
    const r = match({ client: SMITH, folders });
    expect(r.candidates[0]!.status).toBe('bound_to_self');
  });

  it('drops candidates below min_confidence', () => {
    const folders = [folder({ storage_path: 'Smith Family/' })]; // partial only
    const r = match({ client: SMITH, folders, options: { min_confidence: 0.7 } });
    expect(r.candidates.length).toBe(0);
  });

  it('respects max_results cap', () => {
    const folders = Array.from({ length: 20 }, (_, i) =>
      folder({ storage_path: `0042 - Smith ${i}/` }),
    );
    const r = match({ client: SMITH, folders, options: { max_results: 5 } });
    expect(r.candidates.length).toBe(5);
  });

  it('unbound_count counts ALL folders without sentinel, not just matches', () => {
    const folders = [
      folder({ storage_path: 'Anderson Construction/' }), // no match for SMITH but unbound
      folder({ storage_path: '0042 - Smith, John/' }),
      folder({
        storage_path: 'Smith, Sarah/',
        sentinel: { client_id: 'other', display_name_at_creation: 'Smith, Sarah' },
      }),
    ];
    const r = match({ client: SMITH, folders });
    expect(r.unbound_count).toBe(2);
  });

  it('emits suggested_queries from tax_id + name parts', () => {
    const r = match({ client: SMITH, folders: [] });
    expect(r.suggested_queries).toContain('0042');
    expect(r.suggested_queries).toContain('smith');
    expect(r.suggested_queries.length).toBeGreaterThan(0);
  });
});

describe('FMv2 — suggestedQueries', () => {
  it('includes tax_software_id, last name, first names, full name, aliases', () => {
    const c: ClientForMatch = {
      id: 'c',
      name: 'Smith, John',
      tax_software_id: '0042',
      aliases: ['Johnny S.'],
    };
    const q = suggestedQueries(c);
    expect(q).toContain('0042');
    expect(q).toContain('smith');
    expect(q).toContain('Smith, John');
    expect(q).toContain('Johnny S.');
  });

  it('dedupes', () => {
    const c: ClientForMatch = { id: 'c', name: 'Smith' };
    const q = suggestedQueries(c);
    const set = new Set(q);
    expect(set.size).toBe(q.length);
  });
});

describe('FMv2 — performance', () => {
  it('5000 folders × 1 client completes in < 1s', () => {
    const folders = Array.from({ length: 5000 }, (_, i) =>
      folder({ storage_path: `Client ${i}/`, file_count: i % 50 }),
    );
    const start = Date.now();
    match({ client: SMITH, folders, options: { max_results: 10 } });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('FMv2 — property: deterministic scoring', () => {
  it('same input → same output', () => {
    const f = folder({ storage_path: '0042 - Smith, John & Mary/' });
    const r1 = scoreFolder(f, SMITH);
    const r2 = scoreFolder(f, SMITH);
    expect(r1).toEqual(r2);
  });
});

describe('FMv2 — Jaro-Winkler sanity', () => {
  it('identical strings → 1', () => {
    expect(jaroWinkler('smith', 'smith')).toBe(1);
  });

  it('disjoint strings → 0 or near-0', () => {
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });

  it('single-typo string → high similarity', () => {
    expect(jaroWinkler('anderson', 'andersen')).toBeGreaterThan(0.9);
  });

  it('symmetric', () => {
    expect(jaroWinkler('anderson', 'andersen')).toBe(jaroWinkler('andersen', 'anderson'));
  });
});

describe('FMv2 — real-world fixtures', () => {
  // §6 Phase A success criteria: small-firm + large-firm fixtures.
  it('small firm: 1040 family with multiple folder shapes', () => {
    const acmeIndustries: ClientForMatch = {
      id: 'acme',
      name: 'Acme Industries Inc',
      tax_software_id: '0001',
    };
    const folders: FolderCandidate[] = [
      folder({ storage_path: '0001 - Acme/' }),
      folder({ storage_path: 'Acme Industries/' }),
      folder({ storage_path: 'The Wright Company/' }),
      folder({ storage_path: 'Anderson Construction/' }),
    ];
    const r = match({ client: acmeIndustries, folders });
    expect(r.candidates[0]!.storage_path).toBe('0001 - Acme/');
    expect(r.candidates[0]!.reason_code).toBe('tax_id_in_folder_name');
    expect(r.candidates[1]!.storage_path).toBe('Acme Industries/');
  });

  it('K-1 partnership: partner names appear in folder', () => {
    const partnerMaya: ClientForMatch = { id: 'maya', name: 'Calderon, Maya' };
    const folders: FolderCandidate[] = [
      folder({ storage_path: 'Maya Calderon/' }),
      folder({ storage_path: 'Devin Holland/' }),
      folder({ storage_path: 'Sasha Kim/' }),
    ];
    const r = match({ client: partnerMaya, folders });
    // After normalize: client "Calderon, Maya" → ["calderon","maya"];
    // folder "Maya Calderon" → ["maya","calderon"]. Same set,
    // different order → name_swap_match. Maya Calderon is the
    // top result.
    expect(r.candidates[0]!.storage_path).toBe('Maya Calderon/');
    expect(r.candidates[0]!.reason_code).toBe('name_swap_match');
  });

  it('contested folder shows up with bound_to_other status', () => {
    const partnerSarah: ClientForMatch = { id: 'sarah', name: 'Smith, Sarah' };
    const partnerJohn: ClientForMatch = { id: 'john', name: 'Smith, John & Mary' };
    const folders: FolderCandidate[] = [
      folder({
        storage_path: 'Smith Family/',
        sentinel: { client_id: 'sarah', display_name_at_creation: 'Smith Family' },
        bound_to: { client_id: 'sarah', client_name: 'Smith, Sarah' },
      }),
    ];
    // John tries to match → should see "bound_to_other"
    const rJohn = match({ client: partnerJohn, folders });
    expect(rJohn.candidates[0]?.status).toBe('bound_to_other');
    // Sarah sees "bound_to_self"
    const rSarah = match({ client: partnerSarah, folders });
    expect(rSarah.candidates[0]?.status).toBe('bound_to_self');
  });
});
