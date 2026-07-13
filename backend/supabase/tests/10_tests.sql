-- Kriya schema test suite. Runs after 00_stub.sql + the migration.
-- Any failed assert aborts the script with a non-zero psql exit.
\set ON_ERROR_STOP on

-- =============================================================
-- 1. Bootstrap: the very first signup becomes a member, no invite needed
-- =============================================================
insert into auth.users (id, email, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000001', 'ritwik@x.com', '{"name": "Ritwik"}');

do $$ begin
  assert (select count(*) from members) = 1, 'first user auto-enrolled';
  assert (select display_name from members) = 'Ritwik', 'display name from metadata';
end $$;

-- =============================================================
-- 2. An uninvited signup is NOT enrolled
-- =============================================================
insert into auth.users (id, email)
  values ('00000000-0000-0000-0000-000000000002', 'rando@x.com');

do $$ begin
  assert (select count(*) from members) = 1, 'uninvited user not enrolled';
end $$;

-- =============================================================
-- 3. Invite + signup auto-enrolls, and consumes the invite
-- =============================================================
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
insert into invites (email) values ('bob@x.com');
reset role;

insert into auth.users (id, email)
  values ('00000000-0000-0000-0000-000000000003', 'bob@x.com');

do $$ begin
  assert (select count(*) from members) = 2, 'invited user enrolled';
  assert not exists (select 1 from invites), 'invite consumed';
  assert (select display_name from members where email = 'bob@x.com') = 'bob',
    'display name falls back to email local part';
end $$;

-- =============================================================
-- 4. Issue numbering + identity is server-derived (spoof attempt ignored)
-- =============================================================
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

insert into projects (key, name) values ('KRI', 'Kriya');
insert into issues (project_id, title, created_by)
  select id, 'First issue', '00000000-0000-0000-0000-000000000003' from projects; -- spoofed created_by
insert into issues (project_id, title) select id, 'Second issue' from projects;

do $$ begin
  assert (select array_agg(number order by number) from issues) = array[1, 2], 'sequential numbering';
  assert (select created_by from issues where number = 1) = '00000000-0000-0000-0000-000000000001',
    'created_by comes from auth.uid(), spoof ignored';
  assert (select count(*) from activity where action = 'created') = 2, 'created activity logged';
  assert (select count(*) from activity where action = 'created' and agent_name is not null) = 0,
    'human creation has no agent attribution';
end $$;

-- =============================================================
-- 5. Agent attribution flows from the x-kriya-agent header
-- =============================================================
select set_config('request.headers', '{"x-kriya-agent": "Claude Code"}', false);
insert into issues (project_id, title) select id, 'Agent-created issue' from projects;
update issues set status = 'in_progress' where number = 3;

do $$ begin
  assert (select created_by_agent from issues where number = 3) = 'Claude Code',
    'agent-created issue attributed';
  assert (select agent_name from activity where action = 'status') = 'Claude Code',
    'agent update attributed in activity';
end $$;

-- =============================================================
-- 6. No attribution leak: a later human edit carries NO agent name
-- =============================================================
select set_config('request.headers', '{}', false);
update issues set priority = 'high' where number = 3;

do $$ begin
  assert (select agent_name from activity where action = 'priority') is null,
    'human edit after agent edit is not attributed to the agent';
  assert (select created_by_agent from issues where number = 3) = 'Claude Code',
    'trigger-owned created_by_agent survives client updates';
end $$;

-- =============================================================
-- 7. RLS: a non-member sees nothing and can write nothing
-- =============================================================
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);

do $$ begin
  assert (select count(*) from issues) = 0, 'non-member sees no issues';
  assert (select count(*) from projects) = 0, 'non-member sees no projects';
  assert (select count(*) from members) = 0, 'non-member sees no members';
end $$;

do $$
declare project uuid;
begin
  select id into project from projects; -- null under RLS, but try a direct known insert
  begin
    insert into projects (key, name) values ('EVIL', 'Nope');
    raise exception 'non-member insert should have been rejected';
  exception when insufficient_privilege or check_violation then null; -- expected
  end;
end $$;

-- =============================================================
-- 8. Activity trail is client-immutable
-- =============================================================
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

do $$ begin
  begin
    insert into activity (issue_id, action) select id, 'forged' from issues limit 1;
    raise exception 'client insert into activity should have been rejected';
  exception when insufficient_privilege or check_violation then null; -- expected
  end;
end $$;

update activity set new_value = 'tampered' where action = 'status';
delete from activity where action = 'status';
do $$ begin
  assert (select new_value from activity where action = 'status') = 'in_progress',
    'activity rows cannot be updated or deleted by clients';
end $$;

-- =============================================================
-- 9. Comments: author is server-derived; only the author can edit/delete
-- =============================================================
insert into comments (issue_id, body)
  select id, 'Looks good' from issues where number = 1;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
update comments set body = 'hijacked';
delete from comments;

do $$ begin
  assert (select author_id from comments) = '00000000-0000-0000-0000-000000000001',
    'comment author is auth.uid()';
  assert (select body from comments) = 'Looks good',
    'another member cannot edit or delete someone else''s comment';
end $$;

reset role;
select 'ALL TESTS PASSED' as result;
