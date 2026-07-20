-- Restore referential integrity after 0010. The old FKs pointed at
-- `members(user_id)`; dropping the `members` table cascaded them away.
-- Repoint every user-referring column at `auth.users(id)` with the same
-- on-delete behavior as before. This keeps cascades correct when an auth
-- user is deleted and gives PostgREST a real relationship name to target
-- for embedded selects (though MCP now fetches members separately since
-- auth.users isn't exposed via PostgREST).

alter table projects
  add constraint projects_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

alter table invites
  add constraint invites_invited_by_fkey
  foreign key (invited_by) references auth.users (id) on delete set null;

alter table issues
  add constraint issues_assignee_id_fkey
  foreign key (assignee_id) references auth.users (id) on delete set null;

alter table issues
  add constraint issues_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

alter table comments
  add constraint comments_author_id_fkey
  foreign key (author_id) references auth.users (id) on delete set null;

alter table activity
  add constraint activity_actor_id_fkey
  foreign key (actor_id) references auth.users (id) on delete set null;
