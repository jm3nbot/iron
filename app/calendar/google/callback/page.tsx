"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@supabase/supabase-js";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase-config";

const callbackSupabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

export default function GoogleCalendarCallback() {
  const [message, setMessage] = useState("Finishing your Google Calendar connection…");

  useEffect(() => {
    let active = true;
    async function finish() {
      const query = new URLSearchParams(window.location.search);
      const code = query.get("code");
      const state = query.get("state");
      const providerError = query.get("error_description") ?? query.get("error");
      if (providerError || !code || !state) {
        setMessage(providerError || "Google returned an incomplete connection.");
        return;
      }
      const { data: { session } } = await callbackSupabase.auth.getSession();
      if (!session) {
        setMessage("Your Ink & Iron session expired. Sign in and connect again.");
        return;
      }
      const response = await fetch("/api/calendar/google", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ action: "exchange", code, state }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        if (active) setMessage(result.error ?? "Google Calendar could not be connected.");
        return;
      }
      window.location.replace("/?calendar=connected");
    }
    void finish();
    return () => { active = false; };
  }, []);

  return (
    <main className="calendar-callback" aria-live="polite">
      <span className="auth-forge-mark" aria-hidden="true" />
      <p>{message}</p>
      {!message.startsWith("Finishing") && <Link href="/?calendar=retry">Return to Ink &amp; Iron</Link>}
    </main>
  );
}
