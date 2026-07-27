-- Tests for 0013 — the `find` search RPC + backing tsvector.
-- Runs after 0013 is applied; the DB already has the 'meetdev' workspace
-- from 0010 and residual data from 10/20/30/40 tests. We seed a fresh project
-- inside the 'meetdev' workspace and assert against it.
\set ON_ERROR_STOP on

set role postgres; -- service_role equivalent for seeding
select set_config('request.headers', '{}', false);

-- =============================================================
-- Seed: fresh project + issues covering title / description / comment / PR-title matches
-- =============================================================
do $$
declare
  ws uuid := (select id from workspaces where slug = 'meetdev');
  ritwik uuid := '00000000-0000-0000-0000-000000000001';
  p_id uuid;
  i1 uuid; i2 uuid; i3 uuid; i4 uuid; i5 uuid;
begin
  insert into projects (key, name, workspace_id, created_by)
    values ('FIND', 'Find tests', ws, ritwik)
    returning id into p_id;

  -- Match target #1: title has "invite modal"
  insert into issues (project_id, title, description, created_by)
    values (p_id, 'Invite modal shows raw UUID for assignee',
            'Steps to reproduce: open the panel and change assignee.', ritwik)
    returning id into i1;

  -- Match target #2: only the DESCRIPTION mentions "razorpay"
  insert into issues (project_id, title, description, created_by)
    values (p_id, 'Billing screen empty state', 'Razorpay callback returns 400 on retry.', ritwik)
    returning id into i2;

  -- Match target #3: only a COMMENT mentions "flaky"
  insert into issues (project_id, title, description, created_by)
    values (p_id, 'CI green run', 'Rebuild after infra bump.', ritwik)
    returning id into i3;
  insert into comments (issue_id, body, author_id)
    values (i3, 'The auth deno test is still flaky on cold starts.', ritwik);

  -- Match target #4: only a LINKED PR TITLE mentions "webhook"
  insert into issues (project_id, title, description, created_by)
    values (p_id, 'Ledger session grouping', 'Group activity by 30-min gaps.', ritwik)
    returning id into i4;
  insert into issue_links (issue_id, url, title)
    values (i4, 'https://github.com/OneWeekendAI/kriya/pull/99',
            'Fix webhook signature verification');

  -- Match target #5: near-duplicate of #1 with a typo variant to exercise
  -- ranking stability + trigram fallback.
  insert into issues (project_id, title, description, created_by)
    values (p_id, 'Invite modl copy tweak', 'Wording change only.', ritwik)
    returning id into i5;
end $$;

-- =============================================================
-- Assertions
-- =============================================================

-- Set the workspace header so RLS-through find_issues can see rows.
select set_config('request.headers',
  '{"x-workspace-slug": "meetdev"}', false);
set role authenticated;
select set_config('request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000001', false);

do $$
declare
  ws uuid := (select id from workspaces where slug = 'meetdev');
  top_id text;
  top_title text;
  hit_count int;
begin
  -- 1. Title match wins for "invite modal": FIND-1 (exact) should top FIND-5 (trigram-close).
  select id, title into top_id, top_title
    from find_issues('invite modal', ws, 10) limit 1;
  assert top_id like 'FIND-%', 'find returned a FIND-* hit';
  assert top_title = 'Invite modal shows raw UUID for assignee',
    'title match ranks first, got: ' || top_title;

  -- 2. Description-only match: "razorpay" surfaces the billing issue.
  select id into top_id from find_issues('razorpay', ws, 10) limit 1;
  assert top_id is not null, 'description-only match returned nothing';
  assert (select title from find_issues('razorpay', ws, 10) limit 1)
    = 'Billing screen empty state',
    'description-only match surfaces its parent issue';

  -- 3. Comment-only match: "flaky" surfaces the CI issue via its comment.
  select id into top_id from find_issues('flaky', ws, 10) limit 1;
  assert (select title from find_issues('flaky', ws, 10) limit 1)
    = 'CI green run',
    'comment-only match surfaces its parent issue';

  -- 4. PR-title-only match: "webhook signature" surfaces the ledger issue.
  select id into top_id from find_issues('webhook signature', ws, 10) limit 1;
  assert (select title from find_issues('webhook signature', ws, 10) limit 1)
    = 'Ledger session grouping',
    'linked PR title surfaces its parent issue';

  -- 5. Trigram fallback: "modl" (typo) does NOT match the FTS lexeme "modal",
  -- but the fuzzy RPC catches "Invite modl copy tweak" by title similarity.
  select count(*) into hit_count from find_issues('modl', ws, 10);
  -- FTS may return zero or one; the fuzzy fallback must find the typo issue.
  assert (select id from find_issues_fuzzy('modl', ws, 10) limit 1) like 'FIND-%',
    'trigram fallback catches typo';

  -- 6. Result cap.
  assert (select count(*) from find_issues('the', ws, 3)) <= 3, 'max_hits respected';

  -- 7. Snippet is non-empty.
  assert (select length(snippet) from find_issues('invite modal', ws, 1) limit 1) > 0,
    'snippet populated';
end $$;

-- =============================================================
-- Vector-freshness triggers
-- =============================================================
do $$
declare
  ws uuid := (select id from workspaces where slug = 'meetdev');
  target uuid;
  before_hits int;
  after_hits int;
begin
  select i.id into target from issues i
    join projects p on p.id = i.project_id
    where p.key = 'FIND' and i.number = 1;

  -- Insert a new comment with a unique lexeme; find must pick it up.
  select count(*) into before_hits from find_issues('cornucopia', ws, 10);
  insert into comments (issue_id, body, author_id)
    values (target, 'edge case: cornucopia of stale sessions.',
            '00000000-0000-0000-0000-000000000001');
  select count(*) into after_hits from find_issues('cornucopia', ws, 10);
  assert after_hits > before_hits, 'comment-insert trigger refreshed the vector';

  -- Update the issue title; find must reflect the new title.
  update issues set title = 'Invite modal — regression on ledger snapshot'
    where id = target;
  assert (select title from find_issues('regression ledger', ws, 5) limit 1)
    = 'Invite modal — regression on ledger snapshot',
    'issue-update trigger refreshed the vector';
end $$;

reset role;
select 'find tests OK' as result;
