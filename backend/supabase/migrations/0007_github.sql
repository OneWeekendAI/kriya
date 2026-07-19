-- Kriya schema v7 — self-serve GitHub connection + structured PR links.
--
-- Before this, the GitHub webhook secret lived only in a server env var, so
-- users of a hosted workspace had no way to connect a repo themselves. Now
-- the secret lives in the database: any member can read it from the app
-- ("Connect GitHub"), paste it into their repo's webhook settings, and the
-- Edge Function verifies against it. It's a shared workspace secret by
-- design — same trust level as membership itself.
--
-- PRs also become first-class: issue_links rows track each referenced PR's
-- state (open/merged/closed), written only by the webhook (service role),
-- so the issue panel can show live PR status instead of archaeology through
-- comments.

create table github_settings (
  singleton boolean primary key default true check (singleton),
  secret text not null,
  created_at timestamptz not null default now()
);

alter table github_settings enable row level security;
create policy github_settings_read on github_settings for select using (is_member());
-- No client write policies: the secret is minted/rotated via definer RPCs.

-- Returns the workspace webhook secret, creating it on first call.
create or replace function ensure_github_secret() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare s text;
begin
  if auth.uid() is null or not is_member() then
    raise exception 'only workspace members can read the GitHub webhook secret'
      using errcode = '42501';
  end if;
  select secret into s from github_settings;
  if s is null then
    s := 'ghs_' || encode(gen_random_bytes(24), 'hex');
    insert into github_settings (secret) values (s)
      on conflict (singleton) do nothing;
    select secret into s from github_settings;
  end if;
  return s;
end $$;

-- New secret; every repo webhook must be updated with it.
create or replace function rotate_github_secret() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare s text;
begin
  if auth.uid() is null or not is_member() then
    raise exception 'only workspace members can rotate the GitHub webhook secret'
      using errcode = '42501';
  end if;
  s := 'ghs_' || encode(gen_random_bytes(24), 'hex');
  insert into github_settings (secret) values (s)
    on conflict (singleton) do update set secret = excluded.secret, created_at = now();
  return s;
end $$;

create table issue_links (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues (id) on delete cascade,
  url text not null check (length(url) between 1 and 2048),
  title text not null default '' check (length(title) <= 500),
  state text not null default 'open' check (state in ('open', 'merged', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (issue_id, url)
);
create index issue_links_issue_idx on issue_links (issue_id);

alter table issue_links enable row level security;
create policy issue_links_read on issue_links for select using (is_member());
-- No client write policies: links are written by the webhook (service role).

alter publication supabase_realtime add table issue_links;
