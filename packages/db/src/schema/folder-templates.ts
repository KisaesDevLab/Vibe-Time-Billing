// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0142 — client folder structure templates. A firm defines named folder
// skeletons applied as a *virtual* structure under each client's root (the
// Explorer unions the template folders with the file-derived ones). A client
// may point at a specific template via client.folder_template_id; otherwise
// the firm's default template applies. Mirrors migration 0142.

import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { firms } from './core';

export const clientFolderTemplates = pgTable(
  'client_folder_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmDefaultUk: uniqueIndex('client_folder_templates_firm_default_uk')
      .on(t.firmId)
      .where(sql`${t.isDefault}`),
    firmIdx: index('client_folder_templates_firm_idx').on(t.firmId),
  }),
);

export const clientFolderTemplateItems = pgTable(
  'client_folder_template_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => clientFolderTemplates.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    visibility: text('visibility'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    templateIdx: index('client_folder_template_items_template_idx').on(t.templateId, t.sortOrder),
    visibilityCk: check(
      'client_folder_template_items_visibility_ck',
      sql`${t.visibility} IS NULL OR ${t.visibility} IN ('private','client_visible')`,
    ),
  }),
);
