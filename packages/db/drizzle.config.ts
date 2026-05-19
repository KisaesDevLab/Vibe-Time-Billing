// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  driver: 'pg',
  dbCredentials: {
    connectionString:
      process.env['DATABASE_URL'] ?? 'postgresql://vibe:vibe@localhost:5432/vibe_tb',
  },
  strict: true,
  verbose: true,
} satisfies Config;
