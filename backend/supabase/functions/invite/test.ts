import { assertEquals } from "jsr:@std/assert";
import { handler, parseInvite } from "./index.ts";

Deno.test("parseInvite accepts a valid email and normalizes case", () => {
  assertEquals(parseInvite({ email: "Bob@X.com" }), { email: "bob@x.com", name: undefined });
  assertEquals(parseInvite({ email: "bob@x.com", name: "Bob" }), { email: "bob@x.com", name: "Bob" });
});

Deno.test("parseInvite rejects garbage", () => {
  assertEquals(parseInvite(null), null);
  assertEquals(parseInvite("bob@x.com"), null);
  assertEquals(parseInvite({}), null);
  assertEquals(parseInvite({ email: "not-an-email" }), null);
  assertEquals(parseInvite({ email: "bob@x.com", name: "x".repeat(101) }), null);
  assertEquals(parseInvite({ email: ["bob@x.com"] }), null);
});

Deno.test("handler answers CORS preflight", async () => {
  const res = await handler(new Request("http://x/invite", { method: "OPTIONS" }));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
});

Deno.test("handler rejects non-POST", async () => {
  const res = await handler(new Request("http://x/invite", { method: "GET" }));
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
});

Deno.test("handler rejects an invalid body before touching auth", async () => {
  const res = await handler(
    new Request("http://x/invite", { method: "POST", body: "not json" }),
  );
  assertEquals(res.status, 400);
  const res2 = await handler(
    new Request("http://x/invite", { method: "POST", body: JSON.stringify({ email: "nope" }) }),
  );
  assertEquals(res2.status, 400);
});
