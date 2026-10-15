# Personal Quercus connection

Agenda can read your UofT Quercus assignments, submission metadata, and personal/course calendar events directly from Canvas. Google remains independent. This version is restricted to one configured Ink & Iron account. Canvas requires OAuth for applications used by multiple users; do not distribute the personal-token form to other students.

## Activate

1. Apply `supabase/migrations/20261015053212_quercus_agenda.sql` to the application's Supabase project. This adds only Quercus connections and completion tables, with owner-scoped RLS.
2. Set `QUERCUS_TOKEN_SECRET` on the server to a dedicated cryptographically random secret of at least 32 characters (for example, generate with `openssl rand -base64 48`). Keep it stable: changing it requires replacing the stored Quercus token.
3. Set `QUERCUS_ALLOWED_USER_ID` to your Ink & Iron Supabase Auth user UUID. Find it in Supabase Dashboard → Authentication → Users. These variables must never use a `NEXT_PUBLIC_` prefix. Deploy/restart the application with these values.
4. In Quercus → Account → Settings → Approved Integrations, generate a new access token with a clear purpose and an expiration date.
5. In Ink & Iron → Agenda → Calendars → Quercus → Connect Quercus, enter the token into the password field. Do not paste it into chat, source files, or logs. The server validates `/api/v1/users/self/profile` before storing an AES-GCM-encrypted token bound to your Ink & Iron account.

The Canvas host is fixed to `https://q.utoronto.ca`. Only API reads are sent to Canvas. Pagination cannot follow another host or a non-API path, and API redirects are rejected. Tokens are only sent as authorization headers; stored tokens are never included in Agenda API responses.

## Behavior

- The full six-week grid loads on open, month change, window focus, and manual refresh. There is no background job or push notification.
- Assignments use Canvas's student-specific due dates. Deadlines are grouped and shown in the Toronto timezone; all-day calendar dates remain calendar dates.
- The compact **Calendars** bar opens Google and Quercus settings in a dialog. Refresh, replace-token, disconnect, last-sync information, and connection errors live there. Switching between Now and Agenda preserves loaded entries and connection state while refreshing.
- Click a dated Quercus row or calendar chip to open its description, due time, submission state, local checkbox, and link back to Quercus. The selected-day panel scrolls independently. Assignments without a due date appear under **Without a date**.
- Submission state comes from Canvas, including unknown when unavailable; late, missing, and excused flags are separate. Grades, external-tool outcomes, unpublished content, and deadlines absent from Canvas are not inferred.
- Submitted, pending-review, excused, and locally completed assignments are crossed out and dimmed; unfinished assignments appear first. A graded assignment is treated as submitted only when Canvas also provides its submission timestamp.
- **Done in Ink & Iron** is independent of submission status. **Show completed & submitted** defaults on and can hide finished entries. No submission, grade, or Canvas planner-completion write occurs.
- Failed sources retain entries already loaded in the browser. An amber connection dot indicates an issue; settings show the error and stale warning without shifting the calendar. Successful sources refresh independently. A full refresh updates **Last synced**. A fresh browser cannot show entries it has never loaded if that source is unavailable.
- **Replace token** validates the new token before replacing the existing one. An expired or revoked token requires replacement.
- **Disconnect Quercus** deletes the encrypted credential and clears the browser's Quercus entries. It retains local checkoffs for reconnecting the same Canvas account. To revoke the original token too, remove it in Quercus Settings.
- Completion identity includes the Ink & Iron user, verified Canvas user, and assignment ID. Connecting another Canvas account does not inherit the previous account's checkoffs.

## Verification

Run `npm test`, `npm run lint`, and `npx tsc --noEmit`. The automated fixtures never contact Quercus or use a real token. The SQL isolation test in `supabase/tests/quercus_rls.sql` runs in a transaction and rolls back all fixture data; run it against a test Supabase database after applying the migration. For a live smoke test, connect through the new form, compare one dated/undated assignment and its submission state with Quercus, toggle local completion, refresh, then disconnect/reconnect and confirm the checkoff remains.

API: authenticated `GET /api/calendar/quercus?from=YYYY-MM-DD&to=YYYY-MM-DD` (maximum 93 days); `POST` with `{token}`; `DELETE` to disconnect. Completion: `POST /api/calendar/quercus/completion` with `{assignmentId, connectionId, completed}`. Responses exclude credentials and use `Cache-Control: no-store`.

References:
- https://canvas.instructure.com/doc/api/file.oauth.html
- https://developerdocs.instructure.com/services/canvas/resources/assignments
- https://developerdocs.instructure.com/services/canvas/resources/calendar_events
