// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/*.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://vibe:vibe@localhost:5432/vibe_tb',
  },
  strict: true,
  verbose: true,
} satisfies Config;
