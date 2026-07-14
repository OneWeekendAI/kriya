-- Test-only stand-in for the Supabase runtime, so the migration can be
-- exercised against a plain Postgres container. Mimics:
--   * the auth schema (auth.users, auth.uid() reading the JWT claim GUC)
--   * PostgREST's request.headers / request.jwt.claim.sub settings
--   * the authenticated role and Supabase's default grants
--   * the supabase_realtime publication
create schema auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create publication supabase_realtime;

create role authenticated nologin;
create role anon nologin;
create role service_role nologin bypassrls;
grant usage on schema public to authenticated, anon, service_role;
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant all on sequences to authenticated, service_role;
alter default privileges in schema public grant execute on functions to authenticated, service_role;
