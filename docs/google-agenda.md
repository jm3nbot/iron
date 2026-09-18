# Google agenda connection

The Agenda reads primary-calendar events and scheduled, unfinished tasks from
every Google task list, including tasks assigned to the user. Both APIs are
paginated. Reading one source can fail without hiding the other source.

## Setup

1. Enable both Google Calendar API and Google Tasks API in the Google Cloud
   project that owns `GOOGLE_CALENDAR_CLIENT_ID`.
2. Include `https://www.googleapis.com/auth/tasks.readonly` in the OAuth consent
   screen's data access scopes alongside the existing Calendar read scope.
3. Existing users select **Reconnect Google** in Agenda and approve task access.
   Existing Calendar-only grants cannot access Tasks until consent is granted.
4. The existing OAuth client, redirect URLs and encrypted credential storage
   are reused. No new environment variables or database migration are needed.

Tasks appear on their scheduled calendar day as all-day entries, with notes,
list name and a link back to Google Tasks. Refresh Google or return to the
window to fetch updates. Completing a task in Google removes it on refresh.
Tasks without a scheduled date cannot be positioned on the calendar.

## Google API limits

Despite its name, the Tasks API's `due` field is the **scheduled date**, not
Google Tasks' separate **deadline**. The current public API exposes neither
that separate deadline nor scheduled time. Do not present the scheduled date
as a deadline or manufacture a midnight time. I&I's own item deadlines continue
to display independently in Agenda.

References:
- https://developers.google.com/workspace/tasks/reference/rest/v1/tasks
- https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list
- https://developers.google.com/workspace/tasks/reference/rest/v1/tasklists/list
