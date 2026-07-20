// Keep the Razorpay subscription's seat count equal to the member count.
//
// Called by the app (fire-and-forget) after a teammate is invited, and safe
// to run any time — it PATCHes Razorpay only when the counts differ. The
// change applies from the next billing cycle (Razorpay schedule_change_at =
// cycle_end), so mid-cycle joins are not charged retroactively.
//
// Deploy as `razorpay-sync-seats`, Verify JWT: ON. Uses the same secrets as
// razorpay-subscribe.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-workspace-slug",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "missing auth" });
  const slug = req.headers.get("x-workspace-slug") ?? "";
  if (!slug) return json(400, { error: "missing x-workspace-slug header" });

  const keyId = Deno.env.get("RAZORPAY_KEY_ID");
  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
  if (!keyId || !keySecret) return json(500, { error: "razorpay not configured" });

  const asCaller = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth, "x-workspace-slug": slug } } },
  );
  const { data: user } = await asCaller.auth.getUser();
  if (!user?.user) return json(401, { error: "not signed in" });
  const { data: wid } = await asCaller.rpc("current_workspace_id");
  if (!wid) return json(403, { error: "not a member of this workspace" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const [{ count: seats }, { data: sub }] = await Promise.all([
    supabase.from("workspace_members")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", wid),
    supabase.from("subscription").select("razorpay_subscription_id,seats,status")
      .eq("workspace_id", wid)
      .maybeSingle(),
  ]);
  if (!sub?.razorpay_subscription_id) return json(200, { ok: true, skipped: "no subscription" });
  // Only grow: members may have deliberately purchased more seats than they
  // currently use, so never shrink the paid quantity automatically.
  if (!seats || seats <= sub.seats) return json(200, { ok: true, seats, unchanged: true });

  const rzpRes = await fetch(
    `https://api.razorpay.com/v1/subscriptions/${sub.razorpay_subscription_id}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: "Basic " + btoa(`${keyId}:${keySecret}`),
      },
      body: JSON.stringify({ quantity: seats, schedule_change_at: "cycle_end" }),
    },
  );
  if (!rzpRes.ok) return json(502, { error: "razorpay error", detail: await rzpRes.json() });

  await supabase.from("subscription")
    .update({ seats, updated_at: new Date().toISOString() })
    .eq("razorpay_subscription_id", sub.razorpay_subscription_id);

  return json(200, { ok: true, seats, updated: true });
}

Deno.serve(handler);
