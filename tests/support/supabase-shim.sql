-- TEST STAND-IN, NOT SUPABASE. Creates just enough of Supabase's roles and auth.uid() on plain
-- Postgres for sql/supabase.sql to apply and for the permission tests to run with real roles.
-- auth.uid() mirrors Supabase's documented behaviour of reading the JWT "sub" claim from the
-- request.jwt.claims setting. A real Supabase project may differ; that is not tested here.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create function auth.uid() returns uuid
language sql stable
as $$
  -- Once set in a session the setting reads as '' outside the transaction, hence the nullif.
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
$$;

grant usage on schema public to anon, authenticated, service_role;
