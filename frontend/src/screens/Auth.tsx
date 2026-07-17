import { useState } from "react";
import { supabase } from "../lib/supabase";
import { Mark } from "../components/Mark";

export function Auth() {
  const [mode, setMode] = useState<"signin" | "signup" | "invite">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const auth = supabase().auth;
    if (mode === "invite") {
      // Redeem the one-time code from the invite email, then set a password.
      const { error: otpErr } = await auth.verifyOtp({ email, token: code.trim(), type: "invite" });
      if (otpErr) return setError(otpErr.message);
      const { error: pwErr } = await auth.updateUser({ password });
      if (pwErr) return setError(pwErr.message);
      return;
    }
    const { error } =
      mode === "signin"
        ? await auth.signInWithPassword({ email, password })
        : await auth.signUp({ email, password, options: { data: { name } } });
    if (error) setError(error.message);
  }

  return (
    <main className="centered">
      <div className="auth-mark">
        <span className="auth-face"><Mark size={52} /></span>
        <h1>Kriya<em>.</em></h1>
        <span className="auth-tagline">a ledger of actions — yours, and your agents'</span>
      </div>
      <form onSubmit={submit}>
        {mode === "signup" && (
          <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required />
        )}
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        {mode === "invite" && (
          <input
            placeholder="Code from your invite email"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            minLength={6}
          />
        )}
        <input
          type="password"
          placeholder={mode === "invite" ? "Choose a password" : "Password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        <button type="submit" className="btn-primary">
          {mode === "signin" ? "Sign in" : mode === "signup" ? "Sign up" : "Join workspace"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
      <div className="auth-switch">
        <button className="link" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
          {mode === "signin" ? "New here? Sign up" : "Have an account? Sign in"}
        </button>
        {mode !== "invite" && (
          <button className="link" onClick={() => setMode("invite")}>
            Invited? Join with your email code
          </button>
        )}
      </div>
    </main>
  );
}
