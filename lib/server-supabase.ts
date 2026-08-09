import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase-config";

export type AuthenticatedRequest = {
  supabase: SupabaseClient;
  user: User;
};

export async function requireUser(
  request: Request,
): Promise<AuthenticatedRequest | { response: Response }> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return {
      response: Response.json({ error: "Sign in to continue." }, { status: 401 }),
    };
  }

  const supabase = createClient(supabaseUrl, supabasePublishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return {
      response: Response.json({ error: "Your session has expired." }, { status: 401 }),
    };
  }

  return { supabase, user };
}

export function authFailed(
  auth: AuthenticatedRequest | { response: Response },
): auth is { response: Response } {
  return "response" in auth;
}
