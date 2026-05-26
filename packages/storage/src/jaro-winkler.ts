// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 §3.3 fuzzy_name_match — Jaro-Winkler similarity.
//
// Pure implementation; avoids the `natural` npm dependency (which is
// AGPL-compatible but pulls in a multi-megabyte tree we don't need).
// Algorithm follows the Winkler 1990 paper:
//   1. Compute Jaro similarity.
//   2. Apply Winkler boost based on common prefix up to 4 characters.
//
// Used by the match engine on normalized token-joined strings.

const WINKLER_PREFIX_SCALING = 0.1;
const WINKLER_PREFIX_MAX = 4;

export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);

  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(b.length - 1, i + matchWindow);
    for (let j = start; j <= end; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  // Count transpositions
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  transpositions = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

export function jaroWinkler(a: string, b: string): number {
  const j = jaroSimilarity(a, b);
  if (j === 1 || j === 0) return j;
  // Common prefix up to WINKLER_PREFIX_MAX characters.
  let prefix = 0;
  const max = Math.min(WINKLER_PREFIX_MAX, Math.min(a.length, b.length));
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) prefix += 1;
    else break;
  }
  return j + prefix * WINKLER_PREFIX_SCALING * (1 - j);
}
