-- Kriya schema v1 — one Supabase project = one team workspace.
--
-- Design principles:
--   * A row in `members` is the access gate; RLS on every table checks it.
--   * Identity and attribution are SERVER-derived, never client-supplied:
--     `created_by`/`author_id` come from auth.uid() via triggers, and agent
--     attribution comes from the `x-kriya-agent` request header (PostgREST
--     exposes headers to Postgres), so a client bug can neither spoof a user
--     nor leak an agent's name onto a human's edit.
--   * The activity trail is written only by triggers — an immutable audit log.

create extension if not exists pg_trgm;

create type issue_status as enum ('backlog', 'todo', 'in_progress', 'done', 'cancelled');
create type issue_priority as enum ('none', 'low', 'medium', 'high', 'urgent');

-- ---------------------------------------------------------------------------
-- Attribution helpers
-- ---------------------------------------------------------------------------

-- Agent name from the request header, e.g. 'Claude Code'. Null for humans:
-- the app never sends the header, the MCP server always does.
create or replace function current_agent() returns text
language sql stable as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-kriya-agent', '');
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Being listed here grants access to everything. Single role for v1.
create table members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  email text not null unique,
  created_at timestamptz not null default now()
);

-- Pre-authorized emails. On signup, a matching auth user is auto-enrolled
-- as a member (see handle_new_user). The first signup ever needs no invite.
create table invites (
  email text primary key check (email = lower(email)),
  invited_by uuid references members (user_id) on delete set null,
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[A-Z][A-Z0-9]{1,7}$'),
  name text not null check (length(name) between 1 and 100),
  color text not null default '#6366f1' check (color ~ '^#[0-9a-fA-F]{6}$'),
  next_issue_number int not null default 1,
  created_by uuid references members (user_id) on delete set null,
  created_at timestamptz not null default now()
);

create table issues (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  number int not null,
  title text not null check (length(title) between 1 and 500),
  description text not null default '' check (length(description) <= 65536),
  status issue_status not null default 'backlog',
  priority issue_priority not null default 'none',
  assignee_id uuid references members (user_id) on delete set null,
  due_date date,
  -- Trigger-owned: who created it and, if via an agent, which one.
  created_by uuid references members (user_id) on delete set null,
  created_by_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);
create index issues_project_status_idx on issues (project_id, status);
create index issues_assignee_idx on issues (assignee_id);
create index issues_title_trgm_idx on issues using gin (title gin_trgm_ops);
create index issues_description_trgm_idx on issues using gin (description gin_trgm_ops);

create table labels (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  name text not null check (length(name) between 1 and 50),
  color text not null default '#94a3b8' check (color ~ '^#[0-9a-fA-F]{6}$'),
  unique (project_id, name)
);

create table issue_labels (
  issue_id uuid not null references issues (id) on delete cascade,
  label_id uuid not null references labels (id) on delete cascade,
  primary key (issue_id, label_id)
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues (id) on delete cascade,
  author_id uuid references members (user_id) on delete set null,
  agent_name text, -- trigger-owned
  body text not null check (length(body) between 1 and 65536),
  created_at timestamptz not null default now()
);
create index comments_issue_idx on comments (issue_id);

-- Immutable audit trail. Rows are written by triggers, never by clients.
create table activity (
  id bigint generated always as identity primary key,
  issue_id uuid not null references issues (id) on delete cascade,
  actor_id uuid references members (user_id) on delete set null,
  agent_name text,
  action text not null, -- 'created' | 'status' | 'priority' | 'assignee' | 'title' | 'due_date'
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);
create index activity_issue_idx on activity (issue_id);
create index activity_agent_idx on activity (created_at desc) where agent_name is not null;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Auto-enroll on signup: the first user ever, or anyone holding an invite.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from members)
     or exists (select 1 from invites where email = lower(new.email)) then
    insert into members (user_id, display_name, email)
      values (
        new.id,
        coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
        lower(new.email)
      );
    delete from invites where email = lower(new.email);
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- On insert: assign PAY-1, PAY-2, ... atomically, and stamp server-derived
-- identity/attribution regardless of what the client sent.
create or replace function issues_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update projects set next_issue_number = next_issue_number + 1
    where id = new.project_id
    returning next_issue_number - 1 into new.number;
  new.created_by := auth.uid();
  new.created_by_agent := current_agent();
  new.created_at := now();
  new.updated_at := now();
  return new;
end $$;
create trigger issues_t_before_insert before insert on issues
  for each row execute function issues_before_insert();

-- On update: protect trigger-owned columns and diff into the activity trail.
create or replace function issues_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.number := old.number;
  new.project_id := old.project_id;
  new.created_by := old.created_by;
  new.created_by_agent := old.created_by_agent;
  new.created_at := old.created_at;
  new.updated_at := now();

  if new.status is distinct from old.status then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, auth.uid(), current_agent(), 'status', old.status::text, new.status::text);
  end if;
  if new.priority is distinct from old.priority then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, auth.uid(), current_agent(), 'priority', old.priority::text, new.priority::text);
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, auth.uid(), current_agent(), 'assignee', old.assignee_id::text, new.assignee_id::text);
  end if;
  if new.title is distinct from old.title then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, auth.uid(), current_agent(), 'title', old.title, new.title);
  end if;
  if new.due_date is distinct from old.due_date then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, auth.uid(), current_agent(), 'due_date', old.due_date::text, new.due_date::text);
  end if;
  return new;
end $$;
create trigger issues_t_before_update before update on issues
  for each row execute function issues_before_update();

create or replace function issues_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into activity (issue_id, actor_id, agent_name, action, new_value)
    values (new.id, new.created_by, new.created_by_agent, 'created', new.title);
  return new;
end $$;
create trigger issues_t_after_insert after insert on issues
  for each row execute function issues_after_insert();

-- Comments: server-derived author and attribution.
create or replace function comments_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.author_id := auth.uid();
  new.agent_name := current_agent();
  new.created_at := now();
  return new;
end $$;
create trigger comments_t_before_insert before insert on comments
  for each row execute function comments_before_insert();

-- ---------------------------------------------------------------------------
-- Row Level Security — membership is the only gate.
-- ---------------------------------------------------------------------------

create or replace function is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid());
$$;

alter table members enable row level security;
alter table invites enable row level security;
alter table projects enable row level security;
alter table issues enable row level security;
alter table labels enable row level security;
alter table issue_labels enable row level security;
alter table comments enable row level security;
alter table activity enable row level security;

-- Members are created only by handle_new_user (definer function bypasses RLS).
create policy members_read on members for select using (is_member());
create policy members_update_self on members for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy invites_all on invites for all using (is_member()) with check (is_member());
create policy projects_all on projects for all using (is_member()) with check (is_member());
create policy issues_all on issues for all using (is_member()) with check (is_member());
create policy labels_all on labels for all using (is_member()) with check (is_member());
create policy issue_labels_all on issue_labels for all using (is_member()) with check (is_member());
create policy comments_all on comments for all using (is_member()) with check (is_member());

-- Activity is read-only for clients; triggers (security definer) write it.
create policy activity_read on activity for select using (is_member());

-- Comments are append-only for everyone except their author.
create policy comments_no_edit on comments as restrictive for update
  using (author_id = auth.uid());
create policy comments_no_delete on comments as restrictive for delete
  using (author_id = auth.uid());

-- Realtime for live board updates.
alter publication supabase_realtime add table issues, comments, activity, projects;
