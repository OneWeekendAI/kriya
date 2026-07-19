-- Kriya schema v6 — agent task queue + human approval gate.
--
-- Issues can now be assigned to an agent BY NAME (assignee_agent), separate
-- from the human assignee: assignee_id stays the accountable human, while
-- assignee_agent names the worker pulling it via the MCP `next_task` tool.
-- Agents finish by flagging needs_review; a human approves by moving the
-- issue to done, which clears the flag server-side.

alter table issues
  add column assignee_agent text check (length(assignee_agent) between 1 and 50),
  add column needs_review boolean not null default false;

create index issues_agent_queue_idx on issues (assignee_agent, status)
  where assignee_agent is not null;

-- Same body as v2, plus: diff assignee_agent and needs_review into the
-- activity trail, and auto-clear needs_review whenever status lands on done
-- (approving is just "move it to done" — no separate client write needed).
create or replace function issues_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.number := old.number;
  new.project_id := old.project_id;
  new.created_by := old.created_by;
  new.created_by_agent := old.created_by_agent;
  new.created_at := old.created_at;
  new.updated_at := now();

  if new.status = 'done' and new.status is distinct from old.status then
    new.needs_review := false;
  end if;

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
  if new.assignee_agent is distinct from old.assignee_agent then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, current_actor(), current_agent(), 'agent_assignee', old.assignee_agent, new.assignee_agent);
  end if;
  if new.needs_review is distinct from old.needs_review then
    insert into activity (issue_id, actor_id, agent_name, action, old_value, new_value)
      values (new.id, current_actor(), current_agent(), 'review',
              case when old.needs_review then 'requested' else null end,
              case when new.needs_review then 'requested' else 'cleared' end);
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

-- Names every member can assign work to: agents that hold a key or have
-- already acted in the workspace. agent_keys RLS only shows a member their
-- own keys, so this is a definer function gated on membership.
create or replace function known_agents() returns setof text
language sql stable security definer set search_path = public as $$
  select distinct name from (
    select agent_name as name from agent_keys
    union
    select agent_name from activity where agent_name is not null
    union
    select assignee_agent from issues where assignee_agent is not null
  ) t
  where is_member()
  order by name;
$$;
