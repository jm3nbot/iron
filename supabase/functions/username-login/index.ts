import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function canAttempt(request: Request) {
  const address =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = Date.now();
  const current = attempts.get(address);
  if (!current || current.resetAt <= now) {
    attempts.set(address, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (current.count >= MAX_ATTEMPTS) return false;
  current.count += 1;
  return true;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!canAttempt(request)) {
    return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
  }

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const username =
      typeof payload.username === "string" ? payload.username.trim() : "";
    const password = typeof payload.password === "string" ? payload.password : "";
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username) || !password) {
      return json({ error: "Invalid username or password." }, 400);
    }

    const url = Deno.env.get("SUPABASE_URL");
    const publishableKeys = JSON.parse(
      Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}",
    ) as Record<string, string>;
    const secretKeys = JSON.parse(
      Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}",
    ) as Record<string, string>;
    if (!url || !publishableKeys.default || !secretKeys.default) {
      return json({ error: "Username login is temporarily unavailable." }, 503);
    }

    const admin = createClient(url, secretKeys.default, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("email, username")
      .ilike("username", username)
      .maybeSingle();
    if (profileError || !profile) {
      return json({ error: "Invalid username or password." }, 401);
    }

    const auth = createClient(url, publishableKeys.default, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await auth.auth.signInWithPassword({
      email: profile.email,
      password,
    });
    if (error || !data.session) {
      return json({ error: "Invalid username or password." }, 401);
    }

    return json({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      username: profile.username,
    });
  } catch {
    return json({ error: "Could not sign in." }, 400);
  }
});
