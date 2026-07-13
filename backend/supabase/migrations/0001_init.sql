-- Kriya schema v1 — one Supabase project = one team workspace.
-- Access model: a row in `members` is the gate; RLS on every table checks it.

create type issue_status as enum ('backlog', 'todo', 'in_progress', 'done', 'cancelled');
create type issue_priority as enum ('none', 'low', 'medium', 'high', 'urgent');

-- Being listed here grants access to everything. Single role for v1.
create table members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[A-Z][A-Z0-9]{1,7}$'),
  name text not null,
  color text not null default '#6366f1',
  next_issue_number int not null default 1,
  created_by uuid references members (user_id),
  created_at timestamptz not null default now()
);

create table issues (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  number int not null,
  title text not null check (length(title) between 1 and 500),
  description text not null default '',
  status issue_status not null default 'backlog',
  priority issue_priority not null default 'none',
  assignee_id uuid references members (user_id) on delete set null,
  due_date date,
  created_by uuid references members (user_id),
  -- Agent attribution: null = a human in the app; otherwise the agent's name,
  -- e.g. 'Claude Code'. created_by still points at the human it acted for.
  agent_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);
create index issues_project_status_idx on issues (project_id, status);
create index issues_assignee_idx on issues (assignee_id);

create table labels (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  name text not null,
  color text not null default '#94a3b8',
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
  author_id uuid references members (user_id),
  agent_name text,
  body text not null check (length(body) > 0),
  created_at timestamptz not null default now()
);
create index comments_issue_idx on comments (issue_id);

-- Immutable audit trail. Rows are written by triggers, never by clients.
create table activity (
  id bigint generated always as identity primary key,
  issue_id uuid not null references issues (id) on delete cascade,
  actor_id uuid references members (user_id),
  agent_name text,
  action text not null, -- 'created' | 'status' | 'priority' | 'assignee' | 'title' | 'due_date'
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);
create index activity_issue_idx on activity (issue_id);
create index activity_agent_idx on activity (created_at) where agent_name is not null;

-- Assign PAY-1, PAY-2, ... atomically per project.
create or replace function assign_issue_number() returns trigger
language plpgsql security definer as $$
begin
  update projects set next_issue_number = next_issue_number + 1
    where id = new.project_id
    returning next_issue_number - 1 into new.number;
  return new;
end $$;
create trigger issues_number before insert on issues
  for each row execute function assign_issue_number();

create or replace function log_issue_activity() returns trigger
language plpgsql security definer as $$
begin
  if tg_op = 'INSERT' then
    insert into activity (issue_id, actor_id, agent_name, action, new_value)
      values (new.id, new.created_by, new.agent_name, 'created', new.title);
    return new;
  end if;
  new.updated_at := now();
  if new.status is distinct from old.status then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, auth.uid(), new.agent_name, 'status', old.status::text, new.status::text);
  end if;
  if new.priority is distinct from old.priority then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, auth.uid(), new.agent_name, 'priority', old.priority::text, new.priority::text);
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, auth.uid(), new.agent_name, 'assignee', old.assignee_id::text, new.assignee_id::text);
  end if;
  if new.title is distinct from old.title then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, auth.uid(), new.agent_name, 'title', old.title, new.title);
  end if;
  if new.due_date is distinct from old.due_date then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, auth.uid(), new.agent_name, 'due_date', old.due_date::text, new.due_date::text);
  end if;
  return new;
end $$;
create trigger issues_activity_insert after insert on issues
  for each row execute function log_issue_activity();
create trigger issues_activity_update before update on issues
  for each row execute function log_issue_activity();

-- RLS: membership is the only gate; every member can read/write everything.
create or replace function is_member() returns boolean
language sql stable security definer as $$
  select exists (select 1 from members where user_id = auth.uid());
$$;

alter table members enable row level security;
alter table projects enable row level security;
alter table issues enable row level security;
alter table labels enable row level security;
alter table issue_labels enable row level security;
alter table comments enable row level security;
alter table activity enable row level security;

create policy members_read on members for select using (is_member());
-- Bootstrap: the very first authenticated user may add themself; after that,
-- existing members add teammates (invite = create their member row).
create policy members_insert on members for insert
  with check (is_member() or not exists (select 1 from members));
create policy members_update_self on members for update using (user_id = auth.uid());

create policy projects_all on projects for all using (is_member()) with check (is_member());
create policy issues_all on issues for all using (is_member()) with check (is_member());
create policy labels_all on labels for all using (is_member()) with check (is_member());
create policy issue_labels_all on issue_labels for all using (is_member()) with check (is_member());
create policy comments_all on comments for all using (is_member()) with check (is_member());
create policy activity_read on activity for select using (is_member());

-- Realtime for live board updates.
alter publication supabase_realtime add table issues, comments, activity, projects;
