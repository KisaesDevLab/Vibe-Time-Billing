// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import * as schema from './schema';

export * as schema from './schema';
export { schema as schemaTables };

export type Database = PostgresJsDatabase<typeof schema>;

export interface CreateDbOptions {
  connectionString: string;
  max?: number;
}

export function createDb(opts: CreateDbOptions): { db: Database; close: () => Promise<void> } {
  const client = postgres(opts.connectionString, { max: opts.max ?? 10 });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end({ timeout: 5 }) };
}
