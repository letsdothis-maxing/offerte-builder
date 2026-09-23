#!/usr/bin/env node
// One-time migration: adds per-user ownership + RLS to the `projects` table,
// enables RLS on `material_prices`. The two pseudo-rows __app_settings__ and
// __contacts__ (company-wide config, not personal data) stay readable/
// writable by any authenticated user; real proj_* rows become owner-scoped.
//
// Usage:
//   SUPABASE_DB_URL=postgresql://postgres:<password>@db.agkxbvusqrbjqzmzkgwh.supabase.co:5432/postgres \
//     node scripts/migrate-auth.mjs inspect                    # read-only, no writes
//   SUPABASE_DB_URL=... node scripts/migrate-auth.mjs prepare <admin-email>  # add column, enable RLS, add policies, backfill owner_id
//   SUPABASE_DB_URL=... node scripts/migrate-auth.mjs finalize # re-verify, smoke test via anon key (expects it to now see nothing)
//
// Every phase is idempotent - safe to re-run. Run scripts/create-user.mjs
// for <admin-email> BEFORE `prepare`, since the backfill looks the user up
// by email in auth.users.
import pg from 'pg';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL = 'https://agkxbvusqrbjqzmzkgwh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFna3hidnVzcXJianF6bXprZ3doIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2MzMyNjQsImV4cCI6MjEwNTIwOTI2NH0.21EBExYCHBDX8cCzn7mtusT5mVtshmVh8CV4JEKyHos';

const DB_URL = process.env.SUPABASE_DB_URL;
const phase = process.argv[2];
const adminEmail = process.argv[3];

if (!DB_URL) {
  console.error('Missing required env var: SUPABASE_DB_URL');
  process.exit(1);
}
if (!['inspect', 'prepare', 'finalize'].includes(phase)) {
  console.error('Usage: node scripts/migrate-auth.mjs <inspect|prepare|finalize> [admin-email]');
  process.exit(1);
}
if (phase === 'prepare' && !adminEmail) {
  console.error('Usage: node scripts/migrate-auth.mjs prepare <admin-email>');
  process.exit(1);
}

async function backupProjects() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/projects?select=*`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!res.ok) throw new Error(`Backup fetch failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  const dir = fileURLToPath(new URL('../backups/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = dir + `projects-pre-auth-migration-${stamp}.json`;
  writeFileSync(path, JSON.stringify(rows, null, 2));
  console.log(`Backed up ${rows.length} rows to ${path}`);
  return rows.length;
}

async function inspect(client) {
  console.log('=== owner_id column exists? ===');
  const col = await client.query(`
    select 1 from information_schema.columns
    where table_schema='public' and table_name='projects' and column_name='owner_id'
  `);
  console.log(`  ${col.rows.length ? 'yes' : 'no'}`);

  console.log('\n=== RLS enabled? ===');
  const rls = await client.query(`
    select relname, relrowsecurity from pg_class
    where relname in ('projects','material_prices') and relnamespace = 'public'::regnamespace
  `);
  console.log(rls.rows);

  console.log('\n=== existing policies ===');
  const policies = await client.query(`select tablename, policyname, cmd, roles from pg_policies where tablename in ('projects','material_prices')`);
  console.log(policies.rows);

  console.log('\n=== projects rows ===');
  const rows = col.rows.length
    ? await client.query(`select id, name, owner_id from projects order by created_at`)
    : await client.query(`select id, name from projects order by created_at`);
  console.log(rows.rows);

  console.log('\n=== auth.users ===');
  const users = await client.query(`select id, email from auth.users order by created_at`);
  console.log(users.rows);
}

async function prepare(client, email) {
  const preCount = await backupProjects();

  console.log(`\n=== Step 0: look up admin user by email (${email}) ===`);
  const user = await client.query(`select id from auth.users where email = $1`, [email]);
  if (!user.rows.length) {
    throw new Error(`ABORT: no auth.users row for ${email} - run scripts/create-user.mjs first`);
  }
  const adminId = user.rows[0].id;
  console.log(`  found ${email} -> ${adminId}`);

  console.log('\n=== Step 1: add owner_id column ===');
  await client.query(`
    alter table public.projects
      add column if not exists owner_id uuid references auth.users(id) default auth.uid();
  `);

  console.log('=== Step 2: enable RLS ===');
  await client.query(`alter table public.projects enable row level security;`);
  await client.query(`alter table public.material_prices enable row level security;`);

  console.log('=== Step 3: policies (drop-and-recreate, idempotent) ===');
  await client.query(`drop policy if exists "projects_select_own_or_shared" on public.projects;`);
  await client.query(`drop policy if exists "projects_insert_own_or_shared" on public.projects;`);
  await client.query(`drop policy if exists "projects_update_own_or_shared" on public.projects;`);
  await client.query(`drop policy if exists "projects_delete_own_or_shared" on public.projects;`);
  await client.query(`drop policy if exists "material_prices_all_authenticated" on public.material_prices;`);

  await client.query(`
    create policy "projects_select_own_or_shared" on public.projects
      for select to authenticated
      using (id in ('__app_settings__', '__contacts__') or owner_id = auth.uid());
  `);
  await client.query(`
    create policy "projects_insert_own_or_shared" on public.projects
      for insert to authenticated
      with check (id in ('__app_settings__', '__contacts__') or owner_id = auth.uid());
  `);
  await client.query(`
    create policy "projects_update_own_or_shared" on public.projects
      for update to authenticated
      using (id in ('__app_settings__', '__contacts__') or owner_id = auth.uid())
      with check (id in ('__app_settings__', '__contacts__') or owner_id = auth.uid());
  `);
  await client.query(`
    create policy "projects_delete_own_or_shared" on public.projects
      for delete to authenticated
      using (id in ('__app_settings__', '__contacts__') or owner_id = auth.uid());
  `);
  await client.query(`
    create policy "material_prices_all_authenticated" on public.material_prices
      for all to authenticated using (true) with check (true);
  `);

  console.log(`\n=== Step 4: backfill owner_id on real projects (id like 'proj_%') ===`);
  const result = await client.query(
    `update public.projects set owner_id = $1 where id like 'proj_%' and owner_id is null`,
    [adminId]
  );
  console.log(`  updated ${result.rowCount} row(s)`);

  console.log('\n=== Step 5: verify ===');
  const postCount = await client.query(`select count(*)::int as n from projects`);
  console.log(`  total rows now: ${postCount.rows[0].n} (backup captured ${preCount})`);
  if (postCount.rows[0].n !== preCount) {
    throw new Error(`ABORT: row count changed during migration (backup=${preCount}, now=${postCount.rows[0].n})`);
  }
  const orphans = await client.query(`select id from projects where id like 'proj_%' and owner_id is null`);
  console.log(`  real projects still missing an owner: ${orphans.rows.length}`);
  if (orphans.rows.length) {
    console.log(orphans.rows);
    throw new Error(`ABORT: ${orphans.rows.length} project(s) have no owner_id - do not run finalize yet`);
  }

  console.log('\nprepare phase complete.');
  console.log('Review the backup file and the counts above, then run: node scripts/migrate-auth.mjs finalize');
}

async function finalize(client) {
  console.log('=== Re-verifying before finishing ===');
  const orphans = await client.query(`select count(*)::int as n from projects where id like 'proj_%' and owner_id is null`);
  console.log(`  real projects without an owner: ${orphans.rows[0].n}`);
  if (orphans.rows[0].n !== 0) {
    throw new Error(`ABORT: ${orphans.rows[0].n} project(s) still have no owner - run prepare again first`);
  }

  console.log('\n=== Final smoke test via the anon key (should now see/write nothing) ===');
  const readRes = await fetch(`${SUPABASE_URL}/rest/v1/projects?select=id`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  const rows = await readRes.json();
  console.log(`  anon key sees ${rows.length} project row(s) (expected 0)`);
  if (rows.length !== 0) {
    throw new Error(`ABORT: anon key can still read ${rows.length} project row(s) - RLS is not actually blocking it`);
  }

  const writeRes = await fetch(`${SUPABASE_URL}/rest/v1/projects`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ id: 'rls_smoke_test_' + Date.now(), name: 'smoke test' })
  });
  console.log(`  anon key insert attempt -> HTTP ${writeRes.status} (expected 401/403)`);
  if (writeRes.ok) {
    throw new Error('ABORT: anon key was able to insert a row - RLS is not actually blocking writes');
  }

  console.log('Done.');
}

async function main() {
  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    if (phase === 'inspect') await inspect(client);
    else if (phase === 'prepare') await prepare(client, adminEmail);
    else if (phase === 'finalize') await finalize(client);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('MIGRATION FAILED:', e.message);
  process.exit(1);
});
