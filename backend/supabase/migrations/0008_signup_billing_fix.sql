-- Signup was failing with a 500 from /auth/v1/signup because handle_new_user
-- runs `delete from invites` unconditionally after enrolling a member. The
-- billing_guard trigger on `invites` is statement-level, so it fires even
-- when zero rows are deleted -- blocking signup for any workspace past the
-- 14-day setup window with no subscription row.
--
-- Fix: keep billing_guard blocking new invite sends (insert/update), but
-- allow deletes so signup/invite redemption always completes. Reads and
-- onboarding must never be blocked by billing state.

drop trigger if exists billing_guard on invites;
create trigger billing_guard before insert or update on invites
  for each statement execute function billing_guard();
