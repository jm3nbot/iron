# Ink & Iron

Ink & Iron is a personal workspace for organizing projects, tasks, reference material, and daily routines. Its focused interface brings current work, long-term plans, and a calendar into one place.

## Features

- **Now and Projects:** organize work with nested items, priorities, notes, links, and deadlines.
- **Library and Archive:** keep reference material accessible and retain completed work.
- **Agenda:** view workspace deadlines alongside Google Calendar events and scheduled Google Tasks.
- **Daily:** plan recurring routines with weekday schedules, weekly targets, and historical completion tracking.
- **Collaboration:** share workspace items and projects with other users.
- **Synchronization:** preserve pending edits locally and surface conflicts when devices change the same work.

## Stack

React 19, TypeScript, Vinext/Vite, Tailwind CSS, and Supabase. The repository also includes Cloudflare D1 and Neon Postgres adapters, Drizzle migration tooling, and a Vercel build configuration.

## Local development

Requires Node.js 24.x and npm.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to your own Supabase project. Apply the migrations in `supabase/migrations/` in order and configure authentication. The `username-login` Edge Function source is in `supabase/functions/username-login/`.

The active workspace API routes use Supabase authentication and data storage. The example environment and configuration fallbacks point to an existing hosted project; override both values for an independent installation. Browser caches preserve local work and pending changes, but do not replace backend setup for shared features.

## Configuration

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe Supabase publishable key |
| `GOOGLE_CALENDAR_CLIENT_ID` | Google OAuth client ID for Agenda |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | Server-side Google OAuth client secret |
| `GOOGLE_CALENDAR_TOKEN_SECRET` | Secret used to protect stored Google credentials |
| `SITE_URL` | Public application origin for OAuth redirects |
| `DATABASE_URL` | Optional Postgres connection for the database adapter |

For Google integration, enable Calendar and Tasks APIs and follow [the Agenda setup notes](docs/google-agenda.md). Keep server credentials outside version control. Publishable keys rely on database access controls; never substitute a privileged secret key in a `NEXT_PUBLIC_` variable. See [Supabase API key documentation](https://supabase.com/docs/guides/getting-started/api-keys).

## Commands

```bash
npm run build          # Build the application
npm start              # Serve the production build
npm run build:vercel   # Build using the Vercel preset
npm run lint           # Run ESLint
npm test               # Build and run the repository's test suite
npm run db:generate    # Generate Drizzle migrations for the adapter schema
```

`vercel.json` selects the Vercel build command. Configure environment variables on the deployment platform before deploying. Email reminder runtime is currently disabled; its notes are retained in `vaulted-features/email-reminders/`.

## Repository layout

- `app/`: interface and API routes.
- `lib/`: authentication, Google integration, synchronization, and conflict handling.
- `supabase/`: backend migrations and Edge Function source.
- `db/` and `drizzle/`: database adapters and adapter migration history.
- `tests/`: rendering, API, synchronization, and Agenda checks.
- `public/`: application icons, branding, and static assets.
