-- GitHub-connection test suite (migration 0007). Runs after 30_queue_tests:
-- members 01 (Ritwik) and 03 (bob), project KRI with issues, exist.
\set ON_ERROR_STOP on

-- =============================================================
-- 30. Members mint the workspace secret; it's stable and shared
-- =============================================================
set role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated"}', false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select set_config('request.headers', '{}', false);

do $$
declare a text; b text; c text;
begin
  a := ensure_github_secret();
  b := ensure_github_secret();
  assert a like 'ghs\_%', 'secret has the ghs_ prefix';
  assert a = b, 'ensure is idempotent';
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
  c := ensure_github_secret();
  assert a = c, 'the secret is workspace-shared: every member sees the same one';
  assert (select secret from github_settings) = a, 'members can read it via RLS';
end $$;

-- A non-member can neither mint nor read
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);
do $$ begin
  begin
    perform ensure_github_secret();
    raise exception 'non-member minted the webhook secret';
  exception when insufficient_privilege then null; -- expected
  end;
  assert (select count(*) from github_settings) = 0, 'non-member cannot read the secret';
end $$;

-- =============================================================
-- 31. Rotation replaces the secret for everyone
-- =============================================================
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
do $$
declare old_s text; new_s text;
begin
  old_s := ensure_github_secret();
  new_s := rotate_github_secret();
  assert new_s <> old_s, 'rotation mints a fresh secret';
  assert ensure_github_secret() = new_s, 'ensure returns the rotated secret';
  assert (select count(*) from github_settings) = 1, 'still a single row';
end $$;

-- =============================================================
-- 32. issue_links: members read, clients cannot write, webhook can
-- =============================================================
do $$ begin
  begin
    insert into issue_links (issue_id, url)
      select id, 'https://github.com/x/y/pull/1' from issues where number = 1;
    raise exception 'client wrote issue_links directly';
  exception when insufficient_privilege then null; -- expected (no insert policy)
  end;
end $$;
reset role;

set role service_role;
insert into issue_links (issue_id, url, title, state)
  select id, 'https://github.com/x/y/pull/1', 'Fix KRI-1', 'open' from issues where number = 1;
update issue_links set state = 'merged' where url = 'https://github.com/x/y/pull/1';
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
do $$ begin
  assert (select state from issue_links) = 'merged', 'member sees the webhook-written link';
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);
do $$ begin
  assert (select count(*) from issue_links) = 0, 'non-member sees no links';
end $$;
reset role;

select 'ALL GITHUB TESTS PASSED' as result;
