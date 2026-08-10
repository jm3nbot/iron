# Email reminders — vaulted

This feature was retired on 2026-08-10: the client control, API route, database
tables, realtime subscription, and five-minute Supabase Cron dispatcher were
removed from the active product.

The complete working implementation remains recoverable in Git commit
`b6be0c1` (`Add shared lines and email reminders`):

- `app/api/reminders/route.ts`
- `supabase/functions/send-reminders/`
- `supabase/functions/reminder-action/`
- `supabase/migrations/20260809004857_reminders_and_shared_items.sql`
- the email-reminder sections of `app/page.tsx` and `app/globals.css`

To restore it on a future branch, inspect those paths from that commit with
`git show b6be0c1:<path>`. Do not re-enable its scheduler without configuring a
real delivery provider and sender identity.
