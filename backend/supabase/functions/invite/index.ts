// Team invites (Supabase Edge Function).
//
// A workspace member calls this from the app with a teammate's email; the
// invitee gets a real signup email (Supabase Auth invite). The database's
// handle_new_user trigger enrolls them as a member the moment their auth
// user is created, so all they do is set a password and sign in.
//
// Setup (dashboard only, no CLI needed):
//   1. Edge Functions → Deploy new function → name: invite → paste this file.
//      Leave "Verify JWT" ON — callers must be signed in.
//   2. (Recommended) Auth → SMTP Settings → enable Custom SMTP with a Gmail
//      app password (smtp.gmail.com:465) so invite emails actually deliver
//      beyond Supabase's tiny built-in quota (~2/hour).
//   3. Desktop-app invitees redeem a 6-digit code instead of a link: add
//      {{ .Token }} to the "Invite user" email template (Auth → Email
//      Templates) so the code appears in the email.
import { createClient } from "npm:@supabase/supabase-js@2";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseInvite(body: unknown): { email: string; name?: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const { email, name } = body as Record<string, unknown>;
  if (typeof email !== "string" || !EMAIL_RE.test(email)) return null;
  if (name !== undefined && (typeof name !== "string" || name.length > 100)) return null;
  return { email: email.toLowerCase(), name: name || undefined };
}

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  let invite: ReturnType<typeof parseInvite>;
  try {
    invite = parseInvite(await req.json());
  } catch {
    invite = null;
  }
  if (!invite) return json(400, { error: "body must be { email, name? } with a valid email" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Who is calling? Re-use their JWT; RLS on `members` means only a member
  // can see their own row — that's the authorization check.
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: userData } = await asCaller.auth.getUser();
  const caller = userData?.user;
  if (!caller) return json(401, { error: "not signed in" });
  const { data: me } = await asCaller
    .from("members").select("user_id").eq("user_id", caller.id).maybeSingle();
  if (!me) return json(403, { error: "only workspace members can invite" });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Record the invite (idempotent) so handle_new_user enrolls them at signup.
  const { error: inviteErr } = await admin
    .from("invites")
    .upsert({ email: invite.email, invited_by: caller.id });
  if (inviteErr) return json(500, { error: inviteErr.message });

  // Send the actual signup email.
  const { error: mailErr } = await admin.auth.admin.inviteUserByEmail(invite.email, {
    data: invite.name ? { name: invite.name } : undefined,
  });
  if (mailErr) {
    // Most common: they already have an auth account (signed up uninvited).
    // Enroll them directly instead of emailing.
    const { data: existing } = await admin
      .from("members").select("user_id").eq("email", invite.email).maybeSingle();
    if (existing) return json(200, { ok: true, emailed: false, note: "already a member" });
    const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const user = users?.users.find((u) => u.email?.toLowerCase() === invite.email);
    if (user) {
      const { error: enrollErr } = await admin.from("members").insert({
        user_id: user.id,
        display_name: invite.name ?? invite.email.split("@")[0],
        email: invite.email,
      });
      if (enrollErr) return json(500, { error: enrollErr.message });
      await admin.from("invites").delete().eq("email", invite.email);
      return json(200, { ok: true, emailed: false, note: "existing account enrolled directly" });
    }
    return json(502, { error: `invite email failed: ${mailErr.message}` });
  }

  return json(200, { ok: true, emailed: true });
}

if (import.meta.main) Deno.serve(handler);
