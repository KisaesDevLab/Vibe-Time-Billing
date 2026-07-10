// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Free-text search box for table views, wired to a ColumnView (see
// apps/web/src/lib/column-view.ts). Filters rows client-side as the user
// types via the view's `search` value + the `searchText` accessor passed
// to selectRows. Drop it above any converted table.

import { Input } from '@vibe/ui';

import type { ColumnView } from '../lib/column-view';

export function TableSearch({
  view,
  placeholder = 'Search…',
  width = 280,
}: {
  view: ColumnView;
  placeholder?: string;
  width?: number;
}): JSX.Element {
  return (
    <div style={{ maxWidth: width, width: '100%' }}>
      <Input
        type="search"
        value={view.search}
        onChange={(e) => view.setSearch(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  );
}
