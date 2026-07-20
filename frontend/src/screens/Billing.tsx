import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

// Razorpay Checkout is loaded from CDN on demand.
declare global {
  interface Window { Razorpay?: new (opts: unknown) => { open: () => void } }
}

type Plan = "monthly" | "yearly";

// Mirrors billing_state() in the database (migration 0004).
export type BillingState = {
  status: "unsubscribed" | "trialing" | "active" | "past_due" | "halted" | "cancelled" | "expired";
  writable: boolean;
  setup_deadline?: string | null;
  grace_ends_at?: string | null;
  trial_ends_at?: string | null;
  current_period_end?: string | null;
  plan?: Plan;
  seats?: number;
};

export async function fetchBillingState(): Promise<BillingState | null> {
  const { data, error } = await supabase().rpc("billing_state");
  return error ? null : (data as BillingState);
}

const day = (iso: string) => new Date(iso).toLocaleDateString();

/** Sidebar-wide warning shown whenever the workspace's payment needs attention. */
export function BillingBanner({ state, onOpenBilling }: {
  state: BillingState;
  onOpenBilling: () => void;
}) {
  let text: string | null = null;
  switch (state.status) {
    case "unsubscribed":
      text = state.setup_deadline
        ? `This workspace has no subscription. Pick a plan before ${day(state.setup_deadline)} — after that, the workspace becomes read-only. Your first month is free.`
        : null;
      break;
    case "past_due":
      text = `Your last payment failed. We'll retry automatically${state.grace_ends_at ? `, but if it isn't resolved by ${day(state.grace_ends_at)} the workspace becomes read-only` : ""}. Please update your payment method.`;
      break;
    case "halted":
      text = "Payments have failed repeatedly and your subscription is paused. The workspace is read-only until billing is fixed. All your data is intact.";
      break;
    case "cancelled":
      text = "Your subscription was cancelled. The workspace is read-only — resubscribe any time to pick up where you left off.";
      break;
    case "expired":
      text = "Your subscription has ended. The workspace is read-only — resubscribe to continue.";
      break;
  }
  if (!text) return null;
  const hard = !state.writable;
  return (
    <div className={`billing-banner${hard ? " hard" : ""}`}>
      <span>{text}</span>
      <button onClick={onOpenBilling} style={{ whiteSpace: "nowrap" }}>
        Fix billing
      </button>
    </div>
  );
}

/** Rewrites the raw Postgres trigger error into a human sentence. */
export function friendlyBillingError(message: string): string | null {
  return message.includes("KRIYA_BILLING_LOCKED")
    ? "This workspace is read-only because its subscription is inactive. Open Billing to fix payment — your data is safe."
    : null;
}
type Sub = {
  plan: Plan;
  status: string;
  seats: number;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

const PRICE = { monthly: 99, yearly: 59 };

async function loadCheckout(): Promise<void> {
  if (window.Razorpay) return;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("failed to load Razorpay"));
    document.head.appendChild(s);
  });
}

export function Billing() {
  const [sub, setSub] = useState<Sub | null>(null);
  const [busy, setBusy] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memberCount, setMemberCount] = useState(1);
  const [seats, setSeats] = useState(1);

  const refresh = async () => {
    const [{ data }, { count }] = await Promise.all([
      supabase().from("subscription")
        .select("plan,status,seats,trial_ends_at,current_period_end,cancel_at_period_end")
        .maybeSingle(),
      supabase().from("workspace_members").select("*", { count: "exact", head: true }),
    ]);
    setSub(data as Sub | null);
    const members = count ?? 1;
    setMemberCount(members);
    setSeats((s) => Math.max(s, members));
  };
  useEffect(() => { refresh(); }, []);

  async function subscribe(plan: Plan) {
    setError(null);
    setBusy(plan);
    try {
      await loadCheckout();
      const { data, error } = await supabase().functions.invoke("razorpay-subscribe", { body: { plan, seats } });
      if (error) {
        // FunctionsHttpError carries the response; surface the function's
        // own error body (e.g. Razorpay's rejection reason) instead of the
        // generic "non-2xx status code" message.
        const res = (error as { context?: Response }).context;
        const body = res ? await res.json().catch(() => null) : null;
        throw new Error(body?.detail?.error?.description ?? body?.error ?? error.message);
      }
      const rzp = new window.Razorpay!({
        key: data.key_id,
        subscription_id: data.subscription_id,
        name: "Kriya",
        description: `${plan === "monthly" ? "Monthly" : "Yearly"} plan × ${data.seats} seat(s)`,
        theme: { color: "#d85a30" },
        handler: () => { refresh(); },
      });
      rzp.open();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const activePlan = sub && ["trialing", "active", "past_due"].includes(sub.status) ? sub.plan : null;

  return (
    <div className="billing">
      {sub && (
        <p className="sub-line">
          status: {sub.status} · seats: {sub.seats}
          {sub.trial_ends_at && sub.status === "trialing" &&
            <> · free until {new Date(sub.trial_ends_at).toLocaleDateString()}</>}
          {sub.current_period_end &&
            <> · renews {new Date(sub.current_period_end).toLocaleDateString()}</>}
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {!activePlan && (
        <div className="seat-picker">
          <span className="overline">Seats</span>
          <button
            onClick={() => setSeats((s) => Math.max(memberCount, s - 1))}
            disabled={seats <= memberCount}
            aria-label="Fewer seats"
          >−</button>
          <b>{seats}</b>
          <button
            onClick={() => setSeats((s) => Math.min(500, s + 1))}
            aria-label="More seats"
          >+</button>
          <span className="hint">
            {memberCount} member{memberCount === 1 ? "" : "s"} in this workspace (minimum) — remove members in Team to pay for fewer
          </span>
        </div>
      )}

      <div className="plans">
        {(["monthly", "yearly"] as Plan[]).map((p) => (
          <div key={p} className={`plan${activePlan === p ? " current" : ""}`}>
            {activePlan === p && <span className="stamp">Current</span>}
            <h3 style={{ textTransform: "capitalize" }}>{p}</h3>
            <p className="price">
              ₹{PRICE[p]}<small> /user/month</small>
            </p>
            <p className="fine">
              {p === "monthly" ? "First month free." : "Billed annually. Save 40%."}
            </p>
            <p className="fine">
              {seats} seat{seats === 1 ? "" : "s"} × ₹{PRICE[p]} × {p === "monthly" ? "1 month" : "12 months"} ={" "}
              <b>₹{(seats * PRICE[p] * (p === "monthly" ? 1 : 12)).toLocaleString("en-IN")}</b>
              {p === "monthly" ? "/month" : "/year"}
              <span className="muted"> after the free first month</span>
            </p>
            <button
              className={activePlan === p ? "" : "btn-primary"}
              disabled={busy !== null || activePlan === p}
              onClick={() => subscribe(p)}
            >
              {activePlan === p ? "Current plan" : busy === p ? "Opening…" : "Subscribe"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
