-- Agent-queue + approval-gate test suite (migration 0006). Runs after
-- 20_team_tests.sql: members 01 (Ritwik) and 03 (bob), project KRI with
-- issues 1..5 already exist.
\set ON_ERROR_STOP on

-- =============================================================
-- 20. A human assigns an issue to an agent by name; the trail logs it
-- =============================================================
set role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated"}', false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select set_config('request.headers', '{}', false);

update issues set assignee_agent = 'Claude Code' where number = 1;

do $$ begin
  assert (select assignee_agent from issues where number = 1) = 'Claude Code', 'agent assigned';
  assert (select needs_review from issues where number = 1) = false, 'fresh assignment needs no review';
  assert exists (select 1 from activity a join issues i on i.id = a.issue_id
                 where i.number = 1 and a.action = 'agent_assignee'
                   and a.new_value = 'Claude Code' and a.agent_name is null),
    'agent assignment logged, attributed to the human';
end $$;
reset role;

-- =============================================================
-- 21. The agent finishes and submits for review
-- =============================================================
set role service_role;
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{"role": "service_role"}', false);
select set_config('request.headers',
  '{"x-kriya-agent": "Claude Code", "x-kriya-actor": "00000000-0000-0000-0000-000000000001"}', false);

update issues set needs_review = true where number = 1;

do $$ begin
  assert (select needs_review from issues where number = 1) = true, 'review requested';
  assert exists (select 1 from activity a join issues i on i.id = a.issue_id
                 where i.number = 1 and a.action = 'review' and a.new_value = 'requested'
                   and a.agent_name = 'Claude Code'),
    'review request logged, attributed to the agent';
end $$;
reset role;

-- =============================================================
-- 22. Human approval: moving to done auto-clears needs_review
-- =============================================================
set role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated"}', false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select set_config('request.headers', '{}', false);

update issues set status = 'done' where number = 1;

do $$ begin
  assert (select needs_review from issues where number = 1) = false,
    'done clears needs_review server-side';
  assert exists (select 1 from activity a join issues i on i.id = a.issue_id
                 where i.number = 1 and a.action = 'review' and a.new_value = 'cleared'
                   and a.agent_name is null),
    'the clear is logged, attributed to the human';
end $$;

-- =============================================================
-- 23. Send back: clearing the flag without done reopens the work
-- =============================================================
update issues set needs_review = true, status = 'in_progress' where number = 2;
update issues set needs_review = false, status = 'in_progress' where number = 2;

do $$ begin
  assert (select needs_review from issues where number = 2) = false, 'sent back';
  assert (select status from issues where number = 2) = 'in_progress', 'status untouched by send-back';
end $$;

-- =============================================================
-- 24. known_agents(): keys + trail + assignments, members only
-- =============================================================
select create_agent_key('Codex');

do $$ begin
  assert 'Claude Code' in (select known_agents()), 'agents from the trail are known';
  assert 'Codex' in (select known_agents()), 'agents from keys are known';
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);
do $$ begin
  assert (select count(*) from known_agents()) = 0, 'non-members see no agent names';
end $$;
reset role;

select 'ALL QUEUE TESTS PASSED' as result;
