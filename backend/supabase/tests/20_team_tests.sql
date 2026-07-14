-- Team-onboarding test suite (migration 0002). Runs after 10_tests.sql, so
-- members 01 (Ritwik) and 03 (bob) and project KRI (3 issues) already exist.
\set ON_ERROR_STOP on

-- scratch table for passing the minted key between roles (test-only)
create table minted (k json);

-- =============================================================
-- 10. Members mint keys; plaintext returned once, only a hash stored
-- =============================================================
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
insert into minted select create_agent_key('Claude Code');

do $$
declare plain text;
begin
  select k ->> 'key' into plain from minted;
  assert plain like 'kriya\_%', 'key has the kriya_ prefix';
  assert length(plain) = 54, 'key is 6 + 48 hex chars';
  assert (select count(*) from agent_keys) = 1, 'owner sees own key';
  assert (select key_hash from agent_keys) <> plain, 'plaintext is not stored';
  assert (select key_prefix from agent_keys) = left(plain, 12), 'prefix matches';
end $$;

-- A non-member cannot mint a key
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);
do $$ begin
  begin
    perform create_agent_key('Evil');
    raise exception 'non-member minted a key';
  exception when insufficient_privilege then null; -- expected
  end;
end $$;

-- =============================================================
-- 11. resolve_agent_key is service-role only, and resolves correctly
-- =============================================================
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
do $$ begin
  begin
    perform resolve_agent_key('kriya_whatever');
    raise exception 'authenticated client could call resolve_agent_key';
  exception when insufficient_privilege then null; -- expected
  end;
end $$;

reset role;
set role service_role;
do $$
declare plain text; r json;
begin
  select k ->> 'key' into plain from minted;
  r := resolve_agent_key(plain);
  assert r ->> 'user_id' = '00000000-0000-0000-0000-000000000001', 'key resolves to its owner';
  assert r ->> 'agent_name' = 'Claude Code', 'key carries its agent name';
  assert resolve_agent_key('kriya_' || repeat('0', 48)) is null, 'unknown key resolves to null';
end $$;
reset role;

do $$ begin
  assert (select last_used_at from agent_keys) is not null, 'resolution touches last_used_at';
end $$;

-- =============================================================
-- 12. Service-role requests act AS the member via x-kriya-actor
-- =============================================================
set role service_role;
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{"role": "service_role"}', false);
select set_config('request.headers',
  '{"x-kriya-agent": "Claude Code", "x-kriya-actor": "00000000-0000-0000-0000-000000000001"}', false);

insert into issues (project_id, title) select id, 'Via agent key' from projects;
update issues set status = 'in_progress' where number = 4;
reset role;

do $$ begin
  assert (select created_by from issues where number = 4) = '00000000-0000-0000-0000-000000000001',
    'actor header stamps created_by on service-role requests';
  assert (select created_by_agent from issues where number = 4) = 'Claude Code',
    'agent attribution still flows on service-role requests';
  assert (select actor_id from activity where action = 'status' and new_value = 'in_progress'
          and issue_id = (select id from issues where number = 4)) = '00000000-0000-0000-0000-000000000001',
    'activity actor comes from the actor header';
end $$;

-- =============================================================
-- 13. Ordinary clients CANNOT spoof x-kriya-actor
-- =============================================================
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
select set_config('request.jwt.claims', '{"role": "authenticated"}', false);
select set_config('request.headers', '{"x-kriya-actor": "00000000-0000-0000-0000-000000000001"}', false);

insert into issues (project_id, title) select id, 'Spoof attempt' from projects;

do $$ begin
  assert (select created_by from issues where number = 5) = '00000000-0000-0000-0000-000000000003',
    'actor header is ignored unless the request role is service_role';
  assert (select created_by_agent from issues where number = 5) is null,
    'no agent attribution without x-kriya-agent';
end $$;

-- =============================================================
-- 14. Revocation: owner-only delete; a deleted key stops resolving
-- =============================================================
select set_config('request.headers', '{}', false);
delete from agent_keys; -- as bob: not his key, RLS makes this a no-op
do $$ begin
  assert (select count(*) from agent_keys where user_id = '00000000-0000-0000-0000-000000000001') = 0,
    'bob cannot even see the key';
end $$;
reset role;
do $$ begin
  assert (select count(*) from agent_keys) = 1, 'another member cannot revoke someone else''s key';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
delete from agent_keys; -- owner revokes
reset role;

set role service_role;
do $$
declare plain text;
begin
  select k ->> 'key' into plain from minted;
  assert resolve_agent_key(plain) is null, 'revoked key no longer resolves';
end $$;
reset role;

-- =============================================================
-- 15. projects.created_by is now trigger-owned (spoof ignored)
-- =============================================================
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
insert into projects (key, name, created_by)
  values ('SPF', 'Spoof project', '00000000-0000-0000-0000-000000000001');
reset role;

do $$ begin
  assert (select created_by from projects where key = 'SPF') = '00000000-0000-0000-0000-000000000003',
    'projects.created_by comes from current_actor(), spoof ignored';
end $$;

drop table minted;
select 'ALL TEAM TESTS PASSED' as result;
