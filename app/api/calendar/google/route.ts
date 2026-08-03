import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase-config";

export const dynamic = "force-dynamic";

const calendarScope = "https://www.googleapis.com/auth/calendar.events.readonly";

function googleConfig() {
  return {
    clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? "",
    tokenSecret: process.env.GOOGLE_CALENDAR_TOKEN_SECRET ?? "",
  };
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromBase64(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function encryptionKey(secret: string) {
  return crypto.subtle.importKey("raw", await sha256(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptToken(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await encryptionKey(secret),
      new TextEncoder().encode(value),
    ),
  );
  return `${base64Url(iv)}.${base64Url(encrypted)}`;
}

async function decryptToken(value: string, secret: string) {
  const [ivPart, tokenPart] = value.split(".");
  if (!ivPart || !tokenPart) throw new Error("Stored calendar credentials are invalid.");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesFromBase64(ivPart) },
    await encryptionKey(secret),
    bytesFromBase64(tokenPart),
  );
  return new TextDecoder().decode(decrypted);
}

async function requireUser(
  request: Request,
): Promise<
  | { supabase: SupabaseClient; user: User; response?: never }
  | { response: Response; supabase?: never; user?: never }
> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return { response: Response.json({ error: "Sign in to continue." }, { status: 401 }) };
  }
  const supabase = createClient(supabaseUrl, supabasePublishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return { response: Response.json({ error: "Your session has expired." }, { status: 401 }) };
  }
  return { supabase, user };
}

async function googleTokenRequest(parameters: Record<string, string>) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
  });
  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description ?? "Google did not return a calendar token.");
  }
  return data;
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const config = googleConfig();
  if (!config.clientId || !config.clientSecret || !config.tokenSecret) {
    return Response.json(
      { error: "Google Calendar is ready in Ink & Iron but still needs its OAuth credentials." },
      { status: 503 },
    );
  }
  const payload = (await request.json()) as Record<string, unknown>;

  if (payload.action === "begin") {
    const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = base64Url(await sha256(verifier));
    const stateHash = base64Url(await sha256(state));
    const redirectUri = `${new URL(request.url).origin}/calendar/google/callback`;
    await auth.supabase
      .from("google_calendar_oauth_states")
      .delete()
      .lt("expires_at", new Date().toISOString());
    const { error } = await auth.supabase.from("google_calendar_oauth_states").insert({
      state_hash: stateHash,
      user_id: auth.user.id,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    if (error) return Response.json({ error: error.message }, { status: 500 });

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: `openid email ${calendarScope}`,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return Response.json({ url: url.toString() });
  }

  if (payload.action === "exchange") {
    const code = typeof payload.code === "string" ? payload.code : "";
    const state = typeof payload.state === "string" ? payload.state : "";
    if (!code || !state) {
      return Response.json({ error: "Google returned an incomplete authorization." }, { status: 400 });
    }
    const stateHash = base64Url(await sha256(state));
    const { data: oauthState, error: stateError } = await auth.supabase
      .from("google_calendar_oauth_states")
      .select("state_hash, code_verifier, redirect_uri, expires_at")
      .eq("state_hash", stateHash)
      .maybeSingle();
    if (stateError || !oauthState || oauthState.expires_at < new Date().toISOString()) {
      return Response.json({ error: "This Google connection request expired. Please try again." }, { status: 400 });
    }
    try {
      const token = await googleTokenRequest({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        code_verifier: oauthState.code_verifier,
        redirect_uri: oauthState.redirect_uri,
        grant_type: "authorization_code",
      });
      const { data: existing } = await auth.supabase
        .from("google_calendar_connections")
        .select("refresh_token_encrypted")
        .maybeSingle();
      const accessToken = token.access_token!;
      const calendarResponse = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const calendar = calendarResponse.ok
        ? ((await calendarResponse.json()) as { id?: string })
        : null;
      const { error } = await auth.supabase.from("google_calendar_connections").upsert({
        user_id: auth.user.id,
        access_token_encrypted: await encryptToken(accessToken, config.tokenSecret),
        refresh_token_encrypted: token.refresh_token
          ? await encryptToken(token.refresh_token, config.tokenSecret)
          : existing?.refresh_token_encrypted ?? null,
        token_expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
        calendar_email: calendar?.id ?? auth.user.email ?? null,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      await auth.supabase
        .from("google_calendar_oauth_states")
        .delete()
        .eq("state_hash", stateHash);
      return Response.json({ connected: true });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Could not connect Google Calendar." },
        { status: 502 },
      );
    }
  }

  return Response.json({ error: "Unknown calendar action." }, { status: 400 });
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const config = googleConfig();
  const configured = Boolean(config.clientId && config.clientSecret && config.tokenSecret);
  if (!configured) return Response.json({ configured: false, connected: false, events: [] });

  const { data: connection, error } = await auth.supabase
    .from("google_calendar_connections")
    .select("access_token_encrypted, refresh_token_encrypted, token_expires_at, calendar_email")
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!connection) return Response.json({ configured: true, connected: false, events: [] });

  try {
    let accessToken = await decryptToken(connection.access_token_encrypted, config.tokenSecret);
    if (new Date(connection.token_expires_at).getTime() < Date.now() + 60_000) {
      if (!connection.refresh_token_encrypted) {
        return Response.json({ configured: true, connected: false, needsReconnect: true, events: [] });
      }
      const refreshToken = await decryptToken(connection.refresh_token_encrypted, config.tokenSecret);
      const token = await googleTokenRequest({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });
      accessToken = token.access_token!;
      await auth.supabase
        .from("google_calendar_connections")
        .update({
          access_token_encrypted: await encryptToken(accessToken, config.tokenSecret),
          token_expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", auth.user.id);
    }

    const incoming = new URL(request.url);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(incoming.searchParams.get("from") ?? "")
      ? incoming.searchParams.get("from")!
      : new Date().toISOString().slice(0, 10);
    const fallbackTo = new Date(`${from}T00:00:00`);
    fallbackTo.setDate(fallbackTo.getDate() + 42);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(incoming.searchParams.get("to") ?? "")
      ? incoming.searchParams.get("to")!
      : fallbackTo.toISOString().slice(0, 10);
    const endpoint = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    endpoint.search = new URLSearchParams({
      timeMin: new Date(`${from}T00:00:00`).toISOString(),
      timeMax: new Date(`${to}T23:59:59`).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "150",
    }).toString();
    const calendarResponse = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const calendarData = (await calendarResponse.json()) as {
      items?: Array<{
        id: string;
        summary?: string;
        description?: string;
        location?: string;
        htmlLink?: string;
        start?: { date?: string; dateTime?: string };
        end?: { date?: string; dateTime?: string };
      }>;
      error?: { message?: string };
    };
    if (!calendarResponse.ok) throw new Error(calendarData.error?.message ?? "Google Calendar could not be loaded.");
    return Response.json({
      configured: true,
      connected: true,
      calendarEmail: connection.calendar_email,
      events: (calendarData.items ?? []).map((event) => ({
        id: event.id,
        title: event.summary || "Untitled event",
        description: event.description ?? "",
        location: event.location ?? "",
        htmlLink: event.htmlLink ?? "",
        start: event.start?.dateTime ?? event.start?.date ?? "",
        end: event.end?.dateTime ?? event.end?.date ?? "",
        allDay: Boolean(event.start?.date),
      })),
    });
  } catch (calendarError) {
    return Response.json(
      {
        configured: true,
        connected: true,
        calendarEmail: connection.calendar_email,
        events: [],
        error: calendarError instanceof Error ? calendarError.message : "Google Calendar could not be loaded.",
      },
      { status: 502 },
    );
  }
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { error } = await auth.supabase
    .from("google_calendar_connections")
    .delete()
    .eq("user_id", auth.user.id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ connected: false });
}
