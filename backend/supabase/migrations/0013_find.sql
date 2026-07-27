-- 0013 — Spotlight-style text search for agents.
--
-- Adds `issues.search_vector` (weighted tsvector over title, description,
-- comments, linked PR titles), a GIN index, triggers to keep it fresh, and
-- two RPCs the MCP `find` tool calls. Fallback path uses pg_trgm on titles
-- for typo tolerance. See landingpage/docs/kriya/find.md for the design.

-- pg_trgm already installed by 0001; belt-and-braces:
create extension if not exists pg_trgm;

alter table issues
  add column search_vector tsvector;

-- Rebuild one issue's vector from scratch. Called from every source-table
-- trigger with the affected issue_id. Weight tiers match the spec:
--   A = title, B = description, C = comments, D = linked PR titles.
create or replace function issues_rebuild_search_vector(target_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_title text;
  v_description text;
  v_comments text;
  v_pr_titles text;
begin
  select i.title, i.description
    into v_title, v_description
    from issues i where i.id = target_id;

  -- Comments joined into one blob per issue.
  select string_agg(c.body, E'\n')
    into v_comments
    from comments c where c.issue_id = target_id;

  -- Linked PR titles from issue_links (0007).
  select string_agg(l.title, E'\n')
    into v_pr_titles
    from issue_links l where l.issue_id = target_id;

  update issues set search_vector =
      setweight(to_tsvector('english', coalesce(v_title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(v_description, '')), 'B')
    || setweight(to_tsvector('english', coalesce(v_comments, '')), 'C')
    || setweight(to_tsvector('english', coalesce(v_pr_titles, '')), 'D')
    where id = target_id;
end $$;

-- GIN index for FTS lookups.
create index issues_search_vector_idx on issues using gin (search_vector);

-- ---------------------------------------------------------------------------
-- Triggers to keep the vector fresh.
-- ---------------------------------------------------------------------------

create or replace function issues_search_touch_self() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform issues_rebuild_search_vector(new.id);
  return null; -- AFTER trigger
end $$;

-- Rebuild when title or description changes (or on insert).
create trigger issues_t_search_after_insert
  after insert on issues
  for each row execute function issues_search_touch_self();

create trigger issues_t_search_after_update
  after update of title, description on issues
  for each row execute function issues_search_touch_self();

create or replace function comments_search_touch_parent() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  parent uuid := coalesce(new.issue_id, old.issue_id);
begin
  if parent is not null then
    perform issues_rebuild_search_vector(parent);
  end if;
  return null;
end $$;

create trigger comments_t_search_after_iud
  after insert or update or delete on comments
  for each row execute function comments_search_touch_parent();

create or replace function issue_links_search_touch_parent() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  parent uuid := coalesce(new.issue_id, old.issue_id);
begin
  if parent is not null then
    perform issues_rebuild_search_vector(parent);
  end if;
  return null;
end $$;

create trigger issue_links_t_search_after_iud
  after insert or update or delete on issue_links
  for each row execute function issue_links_search_touch_parent();

-- ---------------------------------------------------------------------------
-- Backfill for existing rows.
-- ---------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in select id from issues loop
    perform issues_rebuild_search_vector(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RPCs — the `find` MCP tool calls these. security invoker: RLS applies.
-- ---------------------------------------------------------------------------

-- Primary FTS pass. Recency tiebreaker is a small log-decay on updated_at.
create or replace function find_issues(q text, ws uuid, max_hits int default 10)
  returns table(id text, title text, snippet text, score real)
  language sql
  stable
as $$
  with parsed as (
    select websearch_to_tsquery('english', q) as tsq
  )
  select
    p.key || '-' || i.number as id,
    i.title,
    regexp_replace(
      ts_headline(
        'english',
        i.title || E'\n' || i.description,
        (select tsq from parsed),
        'MaxWords=20, MinWords=8, ShortWord=3, HighlightAll=false'
      ),
      '</?b>', '', 'g'
    ) as snippet,
    (ts_rank_cd(i.search_vector, (select tsq from parsed), 32)
      + 0.1 * exp(-greatest(extract(epoch from now() - i.updated_at), 0) / 86400.0 / 30.0)
    )::real as score
  from issues i
  join projects p on p.id = i.project_id
  where p.workspace_id = ws
    and i.search_vector @@ (select tsq from parsed)
  order by score desc
  limit greatest(max_hits, 1);
$$;

-- Trigram fallback for typos / phrasing misses. Matches on title only.
-- Called by the MCP tool only when the primary pass returns < 3 rows.
create or replace function find_issues_fuzzy(q text, ws uuid, max_hits int default 10)
  returns table(id text, title text, snippet text, score real)
  language sql
  stable
as $$
  select
    p.key || '-' || i.number as id,
    i.title,
    left(i.title || case when i.description = '' then '' else ' — ' || i.description end, 140) as snippet,
    word_similarity(q, i.title)::real as score
  from issues i
  join projects p on p.id = i.project_id
  where p.workspace_id = ws
    and q <% i.title           -- pg_trgm word-similarity match
  order by score desc
  limit greatest(max_hits, 1);
$$;

grant execute on function find_issues(text, uuid, int) to authenticated, anon, service_role;
grant execute on function find_issues_fuzzy(text, uuid, int) to authenticated, anon, service_role;
