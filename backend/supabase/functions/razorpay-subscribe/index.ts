// Create a Razorpay subscription for this workspace.
//
// Setup:
//   1. Razorpay Dashboard → Subscriptions → Plans → create two plans:
//        - Monthly: ₹99 / period=monthly / interval=1
//        - Yearly:  ₹59 * 12 = ₹708 / period=yearly  / interval=1
//      (Amounts are per seat — we multiply by seats when creating the sub.)
//      Copy each plan_id.
//   2. Edge Functions → Deploy → name: razorpay-subscribe → paste this file.
//      Verify JWT: ON.
//   3. Secrets (Project Settings → Edge Functions → Secrets):
//        RAZORPAY_KEY_ID        = rzp_live_xxx or rzp_test_xxx
//        RAZORPAY_KEY_SECRET    = <from Razorpay dashboard>
//        RAZORPAY_PLAN_MONTHLY  = plan_xxx
//        RAZORPAY_PLAN_YEARLY   = plan_xxx
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-workspace-slug",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });

// First month free ⇒ trial by starting billing 30 days in the future.
const TRIAL_DAYS = 30;

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "missing auth" });
  const slug = req.headers.get("x-workspace-slug") ?? "";
  if (!slug) return json(400, { error: "missing x-workspace-slug header" });

  const body = await req.json().catch(() => null) as { plan?: string; seats?: number } | null;
  const plan = body?.plan;
  if (plan !== "monthly" && plan !== "yearly") return json(400, { error: "invalid plan" });
  const requestedSeats = body?.seats;
  if (requestedSeats !== undefined
    && (!Number.isInteger(requestedSeats) || requestedSeats < 1 || requestedSeats > 500)) {
    return json(400, { error: "invalid seats" });
  }

  const keyId = Deno.env.get("RAZORPAY_KEY_ID");
  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
  const planId = Deno.env.get(plan === "monthly" ? "RAZORPAY_PLAN_MONTHLY" : "RAZORPAY_PLAN_YEARLY");
  if (!keyId || !keySecret || !planId) return json(500, { error: "razorpay not configured" });

  // Caller-scoped client, forwards the workspace slug so RLS/RPCs resolve
  // the caller's active workspace.
  const asCaller = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth, "x-workspace-slug": slug } } },
    );

  const { data: user } = await asCaller.auth.getUser();
  if (!user?.user) return json(401, { error: "not signed in" });

  const { data: wid } = await asCaller.rpc("current_workspace_id");
  if (!wid) return json(403, { error: "not a member of this workspace" });

  // Admin client for writes that must ignore RLS (subscription upsert).
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { count: memberCount } = await supabase
    .from("workspace_members")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", wid);
  if (!memberCount || memberCount < 1) return json(400, { error: "no members" });

  // Seats are user-chosen but never below the people who already have access.
  if (requestedSeats !== undefined && requestedSeats < memberCount) {
    return json(400, { error: `seats below member count (${memberCount})` });
  }
  const seats = requestedSeats ?? memberCount;

  // Razorpay requires a finite cycle count; run ~10 years so a paying
  // customer is never auto-expired mid-life.
  const totalCount = plan === "monthly" ? 120 : 10;
  const startAt = Math.floor(Date.now() / 1000) + TRIAL_DAYS * 86400;

  const rzpRes = await fetch("https://api.razorpay.com/v1/subscriptions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic " + btoa(`${keyId}:${keySecret}`),
    },
    body: JSON.stringify({
      plan_id: planId,
      total_count: totalCount,
      quantity: seats,
      start_at: startAt,
      customer_notify: 1,
      notes: { workspace_user: user.user.id, plan },
    }),
  });
  const rzp = await rzpRes.json();
  if (!rzpRes.ok) {
    console.error("razorpay rejected subscription create:", rzpRes.status, JSON.stringify(rzp));
    return json(502, { error: "razorpay error", detail: rzp });
  }

  await supabase.from("subscription").upsert({
    workspace_id: wid,
    plan,
    status: "trialing",
    razorpay_subscription_id: rzp.id,
    seats,
    trial_ends_at: new Date(startAt * 1000).toISOString(),
    created_by: user.user.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: "workspace_id" });

  return json(200, {
    subscription_id: rzp.id,
    key_id: keyId,
    short_url: rzp.short_url,
    seats,
    plan,
    trial_ends_at: new Date(startAt * 1000).toISOString(),
  });
}

Deno.serve(handler);
