-- Kriya multi-tenancy — hosted deployments only (this migration is never
-- shipped in the public repo, so self-hosted installs remain single-workspace,
-- which is the intended model for a team cloning the repo for themselves).
--
-- Multi-tenancy: one Supabase project now hosts many workspaces.
-- URL slug (`/w/:slug`) picks the active workspace; the client sends it as the
-- `x-workspace-slug` request header. `current_workspace_id()` resolves the
-- header AND verifies the caller is a member of that workspace, so RLS can
-- simply gate on `workspace_id = current_workspace_id()`.
--
-- All pre-existing rows are moved into a default workspace named "meetdev"
-- so the current install keeps working. The trigger no longer auto-enrolls;
-- new signups land in a "create or join" state and call create_workspace()
-- from the app.

begin;

-- ---------------------------------------------------------------------------
-- 1. workspaces table + default row
-- ---------------------------------------------------------------------------

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'),
  name text not null check (length(name) between 1 and 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table workspaces enable row level security;

-- Seed the default workspace that owns all pre-existing data.
insert into workspaces (slug, name)
  values ('meetdev', 'MeetDev');

-- ---------------------------------------------------------------------------
-- 2. workspace_members (replaces members)
-- ---------------------------------------------------------------------------

create table workspace_members (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  email text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  unique (workspace_id, email)
);
create index workspace_members_user_idx on workspace_members (user_id);
alter table workspace_members enable row level security;

-- Backfill: copy existing members into the default workspace.
insert into workspace_members (workspace_id, user_id, display_name, email, created_at)
select (select id from workspaces where slug = 'meetdev'),
       user_id, display_name, email, created_at
from members;

-- ---------------------------------------------------------------------------
-- 3. Add workspace_id to top-level tables + backfill
-- ---------------------------------------------------------------------------

alter table projects add column workspace_id uuid references workspaces (id) on delete cascade;
update projects set workspace_id = (select id from workspaces where slug = 'meetdev');
alter table projects alter column workspace_id set not null;
create index projects_workspace_idx on projects (workspace_id);
-- project keys are unique per workspace, not globally.
alter table projects drop constraint projects_key_key;
alter table projects add constraint projects_workspace_key_unique unique (workspace_id, key);

alter table invites add column workspace_id uuid references workspaces (id) on delete cascade;
update invites set workspace_id = (select id from workspaces where slug = 'meetdev');
alter table invites alter column workspace_id set not null;
-- one pending invite per email per workspace.
alter table invites drop constraint invites_pkey;
alter table invites add primary key (workspace_id, email);

alter table agent_keys add column workspace_id uuid references workspaces (id) on delete cascade;
update agent_keys set workspace_id = (select id from workspaces where slug = 'meetdev');
alter table agent_keys alter column workspace_id set not null;
create index agent_keys_workspace_idx on agent_keys (workspace_id);
-- Repoint FK: agent_keys.user_id → auth.users (was → members, which we drop).
alter table agent_keys drop constraint agent_keys_user_id_fkey;
alter table agent_keys add constraint agent_keys_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

alter table subscription add column workspace_id uuid references workspaces (id) on delete cascade;
update subscription set workspace_id = (select id from workspaces where slug = 'meetdev');
alter table subscription alter column workspace_id set not null;
-- Pre-existing rows: keep the newest per workspace, drop older duplicates.
-- Multi-tenancy requires one active subscription per workspace.
delete from subscription s
  using subscription s2
  where s.workspace_id = s2.workspace_id
    and s.created_at < s2.created_at;
alter table subscription add constraint subscription_workspace_unique unique (workspace_id);

alter table billing_event add column workspace_id uuid references workspaces (id) on delete cascade;
update billing_event set workspace_id = (select id from workspaces where slug = 'meetdev');
alter table billing_event alter column workspace_id set not null;
create index billing_event_workspace_idx on billing_event (workspace_id);

alter table github_settings add column workspace_id uuid references workspaces (id) on delete cascade;
update github_settings set workspace_id = (select id from workspaces where slug = 'meetdev');
alter table github_settings alter column workspace_id set not null;
delete from github_settings g
  using github_settings g2
  where g.workspace_id = g2.workspace_id
    and g.ctid < g2.ctid;  -- github_settings has no created_at; ctid is arbitrary but stable
alter table github_settings add constraint github_settings_workspace_unique unique (workspace_id);

-- ---------------------------------------------------------------------------
-- 4. Helpers: current_workspace_id() + is_member(workspace_id)
-- ---------------------------------------------------------------------------

-- Resolves the active workspace from the x-workspace-slug request header.
-- Returns null if the header is missing, the slug is unknown, OR the caller
-- isn't a member of it. Null gates every RLS policy shut, so a wrong header
-- cannot leak data.
create or replace function current_workspace_id() returns uuid
language sql stable security definer set search_path = public as $$
  select w.id
  from workspaces w
  join workspace_members m on m.workspace_id = w.id and m.user_id = auth.uid()
  where w.slug = nullif(
    current_setting('request.headers', true)::json ->> 'x-workspace-slug',
    ''
  );
$$;
grant execute on function current_workspace_id() to authenticated, anon;

create or replace function is_member(wid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from workspace_members
    where workspace_id = wid and user_id = auth.uid()
  );
$$;
grant execute on function is_member(uuid) to authenticated, anon;

-- Backwards-compat shim: legacy is_member() checks the header-active workspace.
create or replace function is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select current_workspace_id() is not null;
$$;

-- ---------------------------------------------------------------------------
-- 5. Rewrite RLS policies to scope by workspace
-- ---------------------------------------------------------------------------

-- workspaces: readable to any member; created via create_workspace() only.
create policy workspaces_read on workspaces for select
  using (exists (
    select 1 from workspace_members
    where workspace_id = workspaces.id and user_id = auth.uid()
  ));

-- workspace_members: read peers in your workspaces; update your own row.
create policy wm_read on workspace_members for select
  using (is_member(workspace_id));
create policy wm_update_self on workspace_members for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Any member can remove a teammate, but never themselves — guarantees a
-- workspace always keeps at least one member (matches 0005's guarantee).
create policy wm_delete on workspace_members for delete
  using (is_member(workspace_id) and user_id <> auth.uid());

-- Drop the old members policies + table (data already copied).
drop policy if exists members_read on members;
drop policy if exists members_update_self on members;
drop policy if exists members_delete on members;
drop trigger if exists members_after_delete on members;
drop table members cascade;

-- projects / invites / agent_keys / subscription / billing_event / github_settings
-- all scope on workspace_id = current_workspace_id().
drop policy if exists projects_all on projects;
create policy projects_all on projects for all
  using (workspace_id = current_workspace_id())
  with check (workspace_id = current_workspace_id());

drop policy if exists invites_all on invites;
create policy invites_all on invites for all
  using (workspace_id = current_workspace_id())
  with check (workspace_id = current_workspace_id());

drop policy if exists agent_keys_read_own on agent_keys;
drop policy if exists agent_keys_delete_own on agent_keys;
create policy agent_keys_read_own on agent_keys for select
  using (user_id = auth.uid() and workspace_id = current_workspace_id());
create policy agent_keys_delete_own on agent_keys for delete
  using (user_id = auth.uid() and workspace_id = current_workspace_id());

drop policy if exists "members read subscription" on subscription;
drop policy if exists "members write subscription" on subscription;
create policy subscription_read on subscription for select
  using (workspace_id = current_workspace_id());
create policy subscription_write on subscription for all
  using (workspace_id = current_workspace_id())
  with check (workspace_id = current_workspace_id());

drop policy if exists github_settings_read on github_settings;
create policy github_settings_read on github_settings for select
  using (workspace_id = current_workspace_id());

-- Nested tables (issues, labels, comments, activity, issue_labels, issue_links)
-- inherit via project_id → projects.workspace_id.
drop policy if exists issues_all on issues;
create policy issues_all on issues for all
  using (exists (
    select 1 from projects
    where projects.id = issues.project_id
      and projects.workspace_id = current_workspace_id()
  ))
  with check (exists (
    select 1 from projects
    where projects.id = issues.project_id
      and projects.workspace_id = current_workspace_id()
  ));

drop policy if exists labels_all on labels;
create policy labels_all on labels for all
  using (exists (
    select 1 from projects
    where projects.id = labels.project_id
      and projects.workspace_id = current_workspace_id()
  ))
  with check (exists (
    select 1 from projects
    where projects.id = labels.project_id
      and projects.workspace_id = current_workspace_id()
  ));

drop policy if exists issue_labels_all on issue_labels;
create policy issue_labels_all on issue_labels for all
  using (exists (
    select 1 from issues i
    join projects p on p.id = i.project_id
    where i.id = issue_labels.issue_id
      and p.workspace_id = current_workspace_id()
  ))
  with check (exists (
    select 1 from issues i
    join projects p on p.id = i.project_id
    where i.id = issue_labels.issue_id
      and p.workspace_id = current_workspace_id()
  ));

drop policy if exists comments_all on comments;
create policy comments_all on comments for all
  using (exists (
    select 1 from issues i
    join projects p on p.id = i.project_id
    where i.id = comments.issue_id
      and p.workspace_id = current_workspace_id()
  ))
  with check (exists (
    select 1 from issues i
    join projects p on p.id = i.project_id
    where i.id = comments.issue_id
      and p.workspace_id = current_workspace_id()
  ));

drop policy if exists activity_read on activity;
create policy activity_read on activity for select
  using (exists (
    select 1 from issues i
    join projects p on p.id = i.project_id
    where i.id = activity.issue_id
      and p.workspace_id = current_workspace_id()
  ));

-- issue_links (from 0007) may or may not exist depending on install order.
do $$ begin
  if to_regclass('public.issue_links') is not null then
    execute 'drop policy if exists issue_links_read on issue_links';
    execute $sql$
      create policy issue_links_read on issue_links for select
        using (exists (
          select 1 from issues i
          join projects p on p.id = i.project_id
          where i.id = issue_links.issue_id
            and p.workspace_id = current_workspace_id()
        ))
    $sql$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. billing_ok() / billing_state() are per-workspace now.
-- ---------------------------------------------------------------------------

create or replace function billing_ok() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  wid uuid := current_workspace_id();
  sub subscription%rowtype;
  first_member timestamptz;
begin
  if wid is null then return false; end if;

  select * into sub from subscription where workspace_id = wid limit 1;
  if not found then
    select min(created_at) into first_member
      from workspace_members where workspace_id = wid;
    return first_member is null or first_member > now() - interval '14 days';
  end if;

  if sub.status in ('trialing', 'active') then return true; end if;
  if sub.status = 'past_due' then
    return sub.updated_at > now() - interval '7 days';
  end if;
  return false;
end;
$$;

create or replace function billing_state() returns json
language plpgsql stable security definer set search_path = public as $$
declare
  wid uuid := current_workspace_id();
  sub subscription%rowtype;
  first_member timestamptz;
begin
  if wid is null then return json_build_object('status', 'no_workspace', 'writable', false); end if;

  select * into sub from subscription where workspace_id = wid limit 1;
  if not found then
    select min(created_at) into first_member
      from workspace_members where workspace_id = wid;
    return json_build_object(
      'status', 'unsubscribed',
      'writable', billing_ok(),
      'setup_deadline', case when first_member is null then null
                             else first_member + interval '14 days' end);
  end if;
  return json_build_object(
    'status', sub.status, 'plan', sub.plan, 'seats', sub.seats,
    'writable', billing_ok(),
    'trial_ends_at', sub.trial_ends_at,
    'current_period_end', sub.current_period_end,
    'grace_ends_at', case when sub.status = 'past_due'
                          then sub.updated_at + interval '7 days' end);
end;
$$;
grant execute on function billing_state() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Signup: no longer auto-enrolls. App calls create_workspace() after login.
-- ---------------------------------------------------------------------------

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Nothing to do at auth time. The app decides whether to create a new
  -- workspace or accept a pending invite.
  return new;
end $$;

-- create_workspace: called from the app after signup or from the switcher.
-- Enrolls the caller as the first member. Idempotent on slug.
create or replace function create_workspace(p_slug text, p_name text)
returns workspaces
language plpgsql security definer set search_path = public as $$
declare
  u_id uuid := auth.uid();
  u_email text;
  u_name text;
  w workspaces%rowtype;
begin
  if u_id is null then raise exception 'not authenticated'; end if;
  select email, coalesce(raw_user_meta_data->>'name', split_part(email,'@',1))
    into u_email, u_name
    from auth.users where id = u_id;

  insert into workspaces (slug, name, created_by)
    values (p_slug, p_name, u_id)
    returning * into w;

  insert into workspace_members (workspace_id, user_id, display_name, email)
    values (w.id, u_id, u_name, lower(u_email));

  return w;
end $$;
grant execute on function create_workspace(text, text) to authenticated;

-- accept_invite: called after signup if there's a pending invite for the
-- caller's email in the target workspace. Removes the invite atomically.
create or replace function accept_invite(p_workspace_slug text) returns workspaces
language plpgsql security definer set search_path = public as $$
declare
  u_id uuid := auth.uid();
  u_email text;
  u_name text;
  w workspaces%rowtype;
begin
  if u_id is null then raise exception 'not authenticated'; end if;
  select email, coalesce(raw_user_meta_data->>'name', split_part(email,'@',1))
    into u_email, u_name
    from auth.users where id = u_id;

  select * into w from workspaces where slug = p_workspace_slug;
  if not found then raise exception 'workspace not found'; end if;

  if not exists (
    select 1 from invites
    where workspace_id = w.id and email = lower(u_email)
  ) then
    raise exception 'no pending invite for % in %', u_email, p_workspace_slug;
  end if;

  insert into workspace_members (workspace_id, user_id, display_name, email)
    values (w.id, u_id, u_name, lower(u_email))
    on conflict do nothing;
  delete from invites where workspace_id = w.id and email = lower(u_email);
  return w;
end $$;
grant execute on function accept_invite(text) to authenticated;

-- Update resolve_agent_key to join workspace_members (members is gone).
create or replace function resolve_agent_key(key text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare r record;
begin
  select k.id, k.user_id, k.workspace_id, k.agent_name, m.display_name, m.email
    into r
    from agent_keys k
    join workspace_members m
      on m.user_id = k.user_id and m.workspace_id = k.workspace_id
    where k.key_hash = encode(digest(key, 'sha256'), 'hex');
  if not found then return null; end if;
  update agent_keys set last_used_at = now() where id = r.id;
  return json_build_object(
    'user_id', r.user_id,
    'workspace_id', r.workspace_id,
    'agent_name', r.agent_name,
    'display_name', r.display_name,
    'email', r.email
  );
end $$;
revoke execute on function resolve_agent_key(text) from public, anon, authenticated;
grant execute on function resolve_agent_key(text) to service_role;

-- create_agent_key: bind the key to the caller's active workspace.
create or replace function create_agent_key(agent_name text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  plain text;
  new_id uuid;
  wid uuid := current_workspace_id();
begin
  if wid is null then
    raise exception 'no active workspace or not a member'
      using errcode = '42501';
  end if;
  plain := 'kriya_' || encode(gen_random_bytes(24), 'hex');
  insert into agent_keys (user_id, workspace_id, agent_name, key_prefix, key_hash)
    values (auth.uid(), wid, agent_name, left(plain, 12),
            encode(digest(plain, 'sha256'), 'hex'))
    returning id into new_id;
  return json_build_object('id', new_id, 'agent_name', agent_name, 'key', plain);
end $$;

-- Port members_after_delete cleanup logic onto workspace_members.
create or replace function workspace_members_after_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from invites
    where workspace_id = old.workspace_id and email = old.email;
  delete from agent_keys
    where user_id = old.user_id and workspace_id = old.workspace_id;
  return old;
end $$;
create trigger workspace_members_after_delete after delete on workspace_members
  for each row execute function workspace_members_after_delete();

-- my_workspaces: list workspaces the caller belongs to (for the switcher).
create or replace function my_workspaces()
returns table (id uuid, slug text, name text)
language sql stable security definer set search_path = public as $$
  select w.id, w.slug, w.name
  from workspaces w
  join workspace_members m on m.workspace_id = w.id
  where m.user_id = auth.uid()
  order by w.name;
$$;
grant execute on function my_workspaces() to authenticated;

-- my_pending_invites: list workspaces the caller has an invite to.
create or replace function my_pending_invites()
returns table (workspace_id uuid, slug text, name text)
language sql stable security definer set search_path = public as $$
  select w.id, w.slug, w.name
  from invites i
  join workspaces w on w.id = i.workspace_id
  join auth.users u on u.id = auth.uid()
  where i.email = lower(u.email);
$$;
grant execute on function my_pending_invites() to authenticated;

-- Default workspace_id from the active workspace header on client inserts,
-- so api.ts doesn't need to plumb it through every call. RLS still validates
-- the resulting row's workspace_id against current_workspace_id(), so a wrong
-- or missing header still fails safely.
alter table projects alter column workspace_id set default current_workspace_id();
alter table invites  alter column workspace_id set default current_workspace_id();

commit;
