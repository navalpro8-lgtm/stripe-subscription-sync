// Starts a real Postgres for the test run and applies the shipped SQL to a fresh schema.
// DATABASE_URL set: use that server. Otherwise: start a throwaway embedded-postgres cluster.
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

async function resetDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('drop schema if exists public cascade; drop schema if exists auth cascade; create schema public;');
    for (const file of ['tests/support/supabase-shim.sql', 'sql/schema.sql', 'sql/supabase.sql']) {
      await client.query(await readFile(file, 'utf8'));
    }
  } finally {
    await client.end();
  }
}

export default async function setup(project: TestProject) {
  let url = process.env.DATABASE_URL;
  let embedded: EmbeddedPostgres | undefined;

  if (!url) {
    const port = await freePort();
    embedded = new EmbeddedPostgres({
      databaseDir: await mkdtemp(join(tmpdir(), 'sss-pg-')),
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      onLog: () => {},
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase('sss_test');
    url = `postgres://postgres:postgres@127.0.0.1:${port}/sss_test`;
  }

  // The reset drops the public schema. Refuse anything that does not look like a test database.
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!dbName.includes('test')) {
    await embedded?.stop();
    throw new Error(`Refusing to reset database "${dbName}": its name must contain "test".`);
  }

  await resetDatabase(url);
  project.provide('databaseUrl', url);

  return async () => {
    await embedded?.stop();
  };
}
