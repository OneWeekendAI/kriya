#!/usr/bin/env bash
# Dev-only eval harness for `find`. Spins up a throwaway Postgres, applies
# migrations, seeds ~50 synthetic issues that mirror realistic Kriya shape
# (mix of statuses, comments of varying length, PR links, near-duplicate
# titles, deliberate typos), then runs a fixed set of prose queries and
# prints top-10 hits with scores. Useful for eyeballing ranking regressions
# while tuning the migration.
set -euo pipefail
cd "$(dirname "$0")"

CONTAINER=kriya-find-eval
docker rm -f $CONTAINER >/dev/null 2>&1 || true
docker run -d --name $CONTAINER -e POSTGRES_PASSWORD=test postgres:16 >/dev/null
trap "docker rm -f $CONTAINER >/dev/null" EXIT

echo "waiting for postgres..."
for i in $(seq 1 30); do
  docker exec $CONTAINER pg_isready -U postgres -q && break
  sleep 1
done

run_sql() {
  docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -q -f - < "$1" > /dev/null
}

run_sql 00_stub.sql
for m in ../migrations/0001_init.sql ../migrations/0002_team_onboarding.sql \
         ../migrations/0003_billing.sql ../migrations/0004_billing_enforcement.sql \
         ../migrations/0005_member_removal.sql ../migrations/0006_agent_queue.sql \
         ../migrations/0007_github.sql ../migrations/0008_signup_billing_fix.sql \
         ../migrations/0009_open_enrollment.sql ../migrations/0010_workspaces.sql \
         ../migrations/0011_restore_user_fks.sql ../migrations/0012_billing_workspace.sql \
         ../migrations/0013_find.sql; do
  run_sql "$m"
done

docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -q > /dev/null <<'SQL'
insert into auth.users (id, email, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000001', 'ritwik@x.com', '{"name": "Ritwik"}');

do $$
declare
  ws uuid := (select id from workspaces where slug = 'meetdev');
  ritwik uuid := '00000000-0000-0000-0000-000000000001';
  p_id uuid;
  seed_id uuid;
  n int;
begin
  insert into projects (key, name, workspace_id, created_by)
    values ('IP', 'Instilplay', ws, ritwik) returning id into p_id;

  -- 50 synthetic issues touching realistic Kriya surface area.
  for n in 1..50 loop
    insert into issues (project_id, title, description, status, created_by)
      values (p_id,
        case (n % 10)
          when 0 then 'Invite modal shows raw UUID for assignee'
          when 1 then 'Razorpay webhook 400 on retried notify_url'
          when 2 then 'Ledger session grouping breaks under 30-min gap'
          when 3 then 'Agent queue skips high-priority backlog item'
          when 4 then 'Bento agent-ledger tile empty copy misleading'
          when 5 then 'Auth deno test flaky on cold start'
          when 6 then 'Tauri build fails without codesigning identity'
          when 7 then 'Kanban drag reorders wrong column at 1440px'
          when 8 then 'GitHub PR chip missing when title has emoji'
          else 'Ink & ledger dark mode contrast on vermillion accent'
        end
        || case when n > 10 then ' (' || n || ')' else '' end,
        'Reported by team; needs triage. Context: ' ||
          case (n % 4)
            when 0 then 'repro on staging cluster, region asia-east1.'
            when 1 then 'flow: connect agent, mint key, list_issues.'
            when 2 then 'affects only workspaces created before 2026-07-15.'
            else 'blocking v0.2 shipping.'
          end,
        (array['backlog','todo','in_progress','done','cancelled'])[1 + (n % 5)]::issue_status,
        ritwik)
      returning id into seed_id;

    -- Comments on every 3rd issue, with search-relevant text.
    if n % 3 = 0 then
      insert into comments (issue_id, body, author_id) values
        (seed_id,
         case (n % 6)
           when 0 then 'The invite modal thing came back — same modal, different code path.'
           when 3 then 'Razorpay does not retry with the same idempotency key; check the webhook signature.'
           else 'Confirmed on prod. Rolled back to previous kriya-mcp version.'
         end,
         ritwik);
    end if;

    -- PR links on every 5th issue.
    if n % 5 = 0 then
      insert into issue_links (issue_id, url, title) values
        (seed_id,
         'https://github.com/OneWeekendAI/kriya/pull/' || (100 + n),
         case (n % 10)
           when 0 then 'Fix invite modal assignee resolution'
           else 'Add signature verification to GitHub webhook'
         end);
    end if;
  end loop;
end $$;
SQL

echo
echo "=== find queries ==="
for q in "invite modal" "razorpay webhook" "flaky test" "dark mode contrast" \
         "the thing about agent queue" "modl" "webhook signature" \
         "vermillon accent"; do
  echo
  echo "--- $q ---"
  docker exec -i $CONTAINER psql -U postgres -q -c \
    "select id, round(score::numeric, 3) as score, left(title, 60) as title from find_issues('$q',
      (select id from workspaces where slug='meetdev'), 10);"
  docker exec -i $CONTAINER psql -U postgres -q -c \
    "select id, round(score::numeric, 3) as score, left(title, 60) as title from find_issues_fuzzy('$q',
      (select id from workspaces where slug='meetdev'), 10);"
done
