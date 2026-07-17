-- Member removal. Any member can remove a teammate, but never themselves —
-- that guarantees a workspace always keeps at least one member and nobody
-- locks everyone (including themselves) out by accident.
--
-- Removal revokes access immediately (is_member() fails), but keeps the
-- auth user and all their issues/comments/activity attribution intact.
create policy members_delete on members for delete
  using (is_member() and user_id <> auth.uid());

-- A removed member must not slip back in through a stale invite, and their
-- agent keys must stop working the moment they're removed.
create or replace function members_after_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from invites where email = old.email;
  delete from agent_keys where user_id = old.user_id;
  return old;
end;
$$;

create trigger members_after_delete after delete on members
  for each row execute function members_after_delete();
