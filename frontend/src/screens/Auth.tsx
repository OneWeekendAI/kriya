import { useState } from "react";
import { clearConfig, supabase } from "../lib/supabase";

export function Auth() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const auth = supabase().auth;
    const { error } =
      mode === "signin"
        ? await auth.signInWithPassword({ email, password })
        : await auth.signUp({ email, password, options: { data: { name } } });
    if (error) setError(error.message);
  }

  return (
    <main className="centered">
      <h1>Kriya</h1>
      <form onSubmit={submit}>
        {mode === "signup" && (
          <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required />
        )}
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        <button type="submit">{mode === "signin" ? "Sign in" : "Sign up"}</button>
        {error && <p className="error">{error}</p>}
      </form>
      <button className="link" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
        {mode === "signin" ? "New here? Sign up" : "Have an account? Sign in"}
      </button>
      <button className="link" onClick={() => { clearConfig(); location.reload(); }}>
        Use a different Supabase project
      </button>
    </main>
  );
}
