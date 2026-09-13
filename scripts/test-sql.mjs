import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const db = new PGlite({ extensions: { pgcrypto } });
try {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to service_role;
    alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
  `);
  const root = process.cwd();
  for (const name of (await readdir(resolve(root, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
    await db.exec(await readFile(resolve(root, 'supabase/migrations', name), 'utf8'));
    console.log('Migration passed:', name);
  }
  for (const file of (await readdir(resolve(root, 'test/sql'))).filter(n => n.endsWith('.sql')).sort().map(n => resolve(root, 'test/sql', n))) {
    await db.exec(await readFile(resolve(file), 'utf8'));
    console.log('Assertions passed:', file);
  }
} catch (error) {
  console.error('SQL validation failed:', error.message, error.code ?? '', error.detail ?? '');
  process.exitCode = 1;
} finally { await db.close(); }
