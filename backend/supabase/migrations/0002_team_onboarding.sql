-- Kriya schema v2 — team onboarding: per-user agent keys.
--
-- Problem this solves: one remote MCP deployment must serve the whole team,
-- with every agent action attributed to the member it acts for. Each member
-- mints personal keys ("kriya_..."); the MCP server (holding the service-role
-- key) resolves a key to a member and forwards that identity on the
-- x-kriya-actor request header. current_actor() only honors that header when
-- the request's JWT role is service_role, so ordinary clients cannot spoof it
-- — the same trust model as current_agent(), one step stronger.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Actor identity
-- ---------------------------------------------------------------------------

-- auth.uid() for normal clients; for trusted servers (service-role requests
-- only), the member they act for via the x-kriya-actor header.
create or replace function current_actor() returns uuid
language sql stable as $$
  select coalesce(
    auth.uid(),
    case
      when current_setting('request.jwt.claims', true)::json ->> 'role' = 'service_role'
        then nullif(current_setting('request.headers', true)::json ->> 'x-kriya-actor', '')::uuid
    end
  );
$$;

-- ---------------------------------------------------------------------------
-- Agent keys
-- ---------------------------------------------------------------------------

create table agent_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references members (user_id) on delete cascade,
  agent_name text not null check (length(agent_name) between 1 and 50),
  key_prefix text not null,   -- first chars of the key, for display only
  key_hash text not null unique, -- sha256 hex; the key itself is never stored
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

alter table agent_keys enable row level security;

-- Owners see and revoke (delete) their own keys. There is no insert/update
-- policy: keys are minted only by create_agent_key (definer), and
-- last_used_at is touched only by resolve_agent_key (definer).
create policy agent_keys_read_own on agent_keys for select using (user_id = auth.uid());
create policy agent_keys_delete_own on agent_keys for delete using (user_id = auth.uid());

-- Mint a key for the signed-in member. The plaintext key is returned exactly
-- once; only its hash is stored.
-- search_path includes extensions: hosted Supabase installs pgcrypto there,
-- local/docker installs it in public.
create or replace function create_agent_key(agent_name text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  plain text;
  new_id uuid;
begin
  if auth.uid() is null or not is_member() then
    raise exception 'only workspace members can create agent keys'
      using errcode = '42501'; -- insufficient_privilege
  end if;
  plain := 'kriya_' || encode(gen_random_bytes(24), 'hex');
  insert into agent_keys (user_id, agent_name, key_prefix, key_hash)
    values (auth.uid(), agent_name, left(plain, 12), encode(digest(plain, 'sha256'), 'hex'))
    returning id into new_id;
  return json_build_object('id', new_id, 'agent_name', agent_name, 'key', plain);
end $$;

-- Resolve a plaintext key to the member it belongs to. Callable ONLY with the
-- service-role key (the MCP server); returns null for unknown/revoked keys.
create or replace function resolve_agent_key(key text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  r record;
begin
  select k.id, k.user_id, k.agent_name, m.display_name, m.email
    into r
    from agent_keys k join members m on m.user_id = k.user_id
    where k.key_hash = encode(digest(key, 'sha256'), 'hex');
  if not found then
    return null;
  end if;
  update agent_keys set last_used_at = now() where id = r.id;
  return json_build_object(
    'user_id', r.user_id,
    'agent_name', r.agent_name,
    'display_name', r.display_name,
    'email', r.email
  );
end $$;

revoke execute on function resolve_agent_key(text) from public, anon, authenticated;
grant execute on function resolve_agent_key(text) to service_role;

-- ---------------------------------------------------------------------------
-- Triggers: auth.uid() -> current_actor() everywhere identity is stamped
-- ---------------------------------------------------------------------------

create or replace function issues_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update projects set next_issue_number = next_issue_number + 1
    where id = new.project_id
    returning next_issue_number - 1 into new.number;
  new.created_by := current_actor();
  new.created_by_agent := current_agent();
  new.created_at := now();
  new.updated_at := now();
  return new;
end $$;

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
      values (new.id, current_actor(), current_agent(), 'status', old.status::text, new.status::text);
  end if;
  if new.priority is distinct from old.priority then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, current_actor(), current_agent(), 'priority', old.priority::text, new.priority::text);
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, current_actor(), current_agent(), 'assignee', old.assignee_id::text, new.assignee_id::text);
  end if;
  if new.title is distinct from old.title then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, current_actor(), current_agent(), 'title', old.title, new.title);
  end if;
  if new.due_date is distinct from old.due_date then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, current_actor(), current_agent(), 'due_date', old.due_date::text, new.due_date::text);
  end if;
  return new;
end $$;

create or replace function comments_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.author_id := current_actor();
  new.agent_name := current_agent();
  new.created_at := now();
  return new;
end $$;

-- projects.created_by was client-supplied in v1; make it trigger-owned like
-- everything else (the app and MCP server no longer send it).
create or replace function projects_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by := current_actor();
  new.created_at := now();
  return new;
end $$;
create trigger projects_t_before_insert before insert on projects
  for each row execute function projects_before_insert();
