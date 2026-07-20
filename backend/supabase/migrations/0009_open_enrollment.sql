-- Open enrollment: any signed-up user becomes a member. Access to features
-- and writes is still gated downstream by billing_guard, so a non-paying
-- workspace can log in and browse but cannot write.
--
-- Previously handle_new_user only enrolled the first user or invited emails.
-- That's the right model for a private team install; on the hosted service
-- we want anyone who signs up to at least reach the app.

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into members (user_id, display_name, email)
    values (
      new.id,
      coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
      lower(new.email)
    )
    on conflict (user_id) do nothing;
  delete from invites where email = lower(new.email);
  return new;
end $$;
