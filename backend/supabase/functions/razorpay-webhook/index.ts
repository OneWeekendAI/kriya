// Razorpay webhook — updates the workspace's subscription row.
//
// Setup:
//   1. Deploy this function as `razorpay-webhook`. Turn "Verify JWT" OFF —
//      Razorpay does not send a Supabase JWT.
//   2. Razorpay Dashboard → Settings → Webhooks → Add:
//        URL:    https://<project>.functions.supabase.co/razorpay-webhook
//        Secret: <choose a random string>
//        Events: subscription.activated, subscription.charged,
//                subscription.pending, subscription.halted,
//                subscription.cancelled, subscription.completed
//   3. Add secret: RAZORPAY_WEBHOOK_SECRET = <same random string>
//   4. Email notifications via Brevo SMTP (optional — silently skipped when
//      BREVO_SMTP_KEY is missing). Secrets:
//        BREVO_SMTP_KEY       = xkeysib-... (Brevo → SMTP & API → SMTP keys)
//        BREVO_SMTP_LOGIN     = optional, defaults to b2513f001@smtp-brevo.com
//        BILLING_FROM_EMAIL   = optional, defaults to billing@meetdev.in
//        BILLING_ALERT_EMAIL  = operator copy — gets every event
//      Templates + SMTP sender are inlined below (single file so the
//      dashboard editor can deploy it); test locally with ./test-smtp.ts.
import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { createHmac } from "node:crypto";

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const SMTP = {
  hostname: "smtp-relay.brevo.com",
  // 465 = direct TLS. Port 587 (STARTTLS) hits denomailer's "Bad resource ID"
  // bug on current Deno, so we use 465 — Brevo supports both.
  port: 465,
  login: Deno.env.get("BREVO_SMTP_LOGIN") ?? "b2513f001@smtp-brevo.com",
  from: Deno.env.get("BILLING_FROM_EMAIL") ?? "billing@meetdev.in",
};

export interface BillingMail {
  subject: string;
  heading: string;
  body: string;
  /** Optional highlighted line (e.g. amount or deadline). */
  callout?: string;
  cta?: { label: string; hint: string };
}

// Subject + copy per Razorpay event. `amount` in ₹ for charged events.
export function emailFor(event: string, amount: number | null): BillingMail | null {
  switch (event) {
    case "subscription.activated":
      return {
        subject: "Kriya — your subscription is active",
        heading: "Subscription active",
        body: "Your Kriya subscription is now active. Thanks for subscribing!",
      };
    case "subscription.charged":
      return {
        subject: `Kriya — payment received${amount ? ` (₹${amount})` : ""}`,
        heading: "Payment received",
        body: "We received your payment for Kriya. No action needed — this is your confirmation. Razorpay emails you the detailed invoice separately.",
        callout: amount ? `₹${amount} paid successfully` : undefined,
      };
    case "subscription.pending":
      return {
        subject: "Kriya — payment failed, we'll retry",
        heading: "Payment failed",
        body: "Your latest Kriya payment failed. Razorpay will retry automatically over the next few days. If it keeps failing, your workspace becomes read-only 7 days after the first failure.",
        callout: "Action needed: check your payment method",
        cta: { label: "Fix billing", hint: "Open the Kriya app → Billing" },
      };
    case "subscription.halted":
      return {
        subject: "Kriya — subscription paused, workspace is read-only",
        heading: "Subscription paused",
        body: "Payments for your Kriya subscription failed repeatedly, so it has been paused and your workspace is now read-only. All your data is intact and readable.",
        callout: "Workspace is read-only until billing is fixed",
        cta: { label: "Fix billing", hint: "Open the Kriya app → Billing" },
      };
    case "subscription.cancelled":
      return {
        subject: "Kriya — subscription cancelled",
        heading: "Subscription cancelled",
        body: "Your Kriya subscription has been cancelled and the workspace is now read-only. Your data stays intact — resubscribe any time to pick up where you left off.",
        cta: { label: "Resubscribe", hint: "Open the Kriya app → Billing" },
      };
    case "subscription.completed":
      return {
        subject: "Kriya — subscription ended",
        heading: "Subscription ended",
        body: "Your Kriya subscription has ended and the workspace is now read-only. Resubscribe to continue.",
        cta: { label: "Resubscribe", hint: "Open the Kriya app → Billing" },
      };
    default:
      return null;
  }
}

export function renderHtml(mail: BillingMail): string {
  // Collapsed to one line before returning: denomailer's quoted-printable
  // encoding mishandles multi-line HTML, leaking literal "=20" into the
  // rendered email (and spam filters penalize the malformed body).
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
          <tr>
            <td style="background:#0f172a;padding:20px 28px;">
              <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">Kriya</span>
              <span style="color:#94a3b8;font-size:13px;"> · Billing</span>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">${mail.heading}</h1>
              <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">${mail.body}</p>
              ${mail.callout ? `
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin:0 0 16px;font-size:14px;font-weight:600;color:#0f172a;">
                ${mail.callout}
              </div>` : ""}
              ${mail.cta ? `
              <div style="margin:20px 0 4px;">
                <span style="display:inline-block;background:#0f172a;color:#ffffff;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px;">${mail.cta.label}</span>
                <div style="font-size:12px;color:#6b7280;margin-top:8px;">${mail.cta.hint}</div>
              </div>` : ""}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;border-top:1px solid #f1f5f9;">
              <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5;">
                You're receiving this because you manage billing for a Kriya workspace.<br/>
                Questions? Just reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`.replace(/\s*\n\s*/g, " ").trim();
}

export async function sendBillingMail(to: string[], mail: BillingMail): Promise<void> {
  const password = Deno.env.get("BREVO_SMTP_KEY");
  if (!password) throw new Error("BREVO_SMTP_KEY is not set");

  const client = new SMTPClient({
    connection: {
      hostname: SMTP.hostname,
      port: SMTP.port,
      tls: true, // direct TLS on 465
      auth: { username: SMTP.login, password },
    },
  });
  try {
    await client.send({
      from: `Kriya Billing <${SMTP.from}>`,
      to,
      subject: mail.subject,
      content: `${mail.heading}\n\n${mail.body}${mail.callout ? `\n\n${mail.callout}` : ""}\n\n— Kriya`,
      html: renderHtml(mail),
    });
  } finally {
    // denomailer's close() can throw on an already-torn-down socket; a close
    // failure must not turn a delivered email into a reported error.
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
}

const EVENT_TO_STATUS: Record<string, string> = {
  "subscription.activated": "active",
  "subscription.charged": "active",
  "subscription.pending": "past_due",
  "subscription.halted": "halted",
  "subscription.cancelled": "cancelled",
  "subscription.completed": "expired",
};

// Fire-and-forget notification; never fails the webhook.
async function notify(event: string, amount: number | null, customerEmail: string | null) {
  if (!Deno.env.get("BREVO_SMTP_KEY")) return;

  const mail = emailFor(event, amount);
  if (!mail) return;

  const operator = Deno.env.get("BILLING_ALERT_EMAIL");
  const to = [customerEmail, operator].filter((x): x is string => !!x);
  if (to.length === 0) return;

  try {
    await sendBillingMail(to, mail);
  } catch (err) {
    console.error("notify: send failed", err);
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");
  const signature = req.headers.get("x-razorpay-signature");
  if (!secret || !signature) return json(400, { error: "missing signature" });

  const raw = await req.text();
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  if (expected !== signature) return json(401, { error: "invalid signature" });

  const payload = JSON.parse(raw);
  const event: string = payload.event;
  const eventId: string = payload.id ?? `${event}-${payload.created_at}`;
  const sub = payload.payload?.subscription?.entity;
  if (!sub?.id) return json(200, { ok: true, skipped: "no subscription entity" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Look up which workspace owns this subscription so we can scope writes.
  const { data: existingSub } = await supabase.from("subscription")
    .select("workspace_id, created_by")
    .eq("razorpay_subscription_id", sub.id)
    .maybeSingle();
  if (!existingSub) return json(404, { error: "unknown subscription id" });
  const wid = existingSub.workspace_id;

  // Idempotency: skip if we've already processed this event.
  const { error: dupErr } = await supabase.from("billing_event")
    .insert({ workspace_id: wid, id: eventId, event, payload });
  if (dupErr && !dupErr.message.includes("duplicate")) return json(500, { error: dupErr.message });
  if (dupErr) return json(200, { ok: true, duplicate: true });

  const status = EVENT_TO_STATUS[event];
  if (!status) return json(200, { ok: true, ignored: event });

  await supabase.from("subscription")
    .update({
      status,
      seats: sub.quantity,
      current_period_end: sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null,
      razorpay_customer_id: sub.customer_id,
      cancel_at_period_end: !!sub.cancel_at_cycle_end,
      updated_at: new Date().toISOString(),
    })
    .eq("razorpay_subscription_id", sub.id);

  // Email the person who set up billing (+ operator copy). The billing_event
  // insert above already de-duplicates, so retried webhooks never re-send.
  let customerEmail: string | null = null;
  if (existingSub.created_by) {
    const { data: member } = await supabase.from("workspace_members")
      .select("email")
      .eq("workspace_id", wid)
      .eq("user_id", existingSub.created_by)
      .maybeSingle();
    customerEmail = member?.email ?? null;
  }
  const paise = payload.payload?.payment?.entity?.amount;
  const amount = typeof paise === "number" ? Math.round(paise / 100) : null;
  await notify(event, amount, customerEmail);

  return json(200, { ok: true });
}

if (import.meta.main) Deno.serve(handler);
