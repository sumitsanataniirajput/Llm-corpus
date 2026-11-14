# Ride Manager — Manager Application

A control room for a ride-hailing business: a web console, a native Android companion app, and a Supabase
(PostgreSQL) backend with a secure ride-start OTP system.

| Folder | What it is |
|---|---|
| `web/` | Manager web console. Plain HTML, CSS and JavaScript (no build step). Start file: `web/index.html`. |
| `android/` | Native Android app (Kotlin, Jetpack Compose, Material 3). Open this folder in Android Studio. |
| `supabase/migrations/` | The database: 12 SQL files, run in order. Tables, security rules, server functions. |
| `supabase/functions/` | Edge Functions (server code that holds the secrets): OTP SMS, payments, push, staff invitations. |
| `supabase/seed/demo_seed.sql` | Invented demo data for a **practice** project only. Never run it on the live project. |
| `tests/` | Automated tests. `cd tests && npm install && npm test`. |
| `documentation/` | Guides. **Start with `documentation/SETUP.md`.** |

## Read these in order

1. `documentation/SETUP.md` — create the accounts and get the console running, step by step.
2. `documentation/HOPEWEB-GUIDE.md` — where every file goes when you copy the project into your web host.
3. `documentation/DEPLOYMENT.md` — going live, Android APK, backups.
4. `documentation/SECURITY.md`, `documentation/DATABASE.md`, `documentation/API.md` — reference.
5. `documentation/STATUS.md` — honest list of what has been tested, what has not, and what is not built.

## What is verified and what is not

The database, its security rules and every screen of the web console are covered by automated tests that run
against a real PostgreSQL engine. The Edge Functions and the Android app have **not** been compiled or run in the
environment where this code was written (no Deno, Java or Android SDK was available there), and nothing has been
tested against live SMS, payment, push or Google Maps accounts. See `documentation/STATUS.md` before relying on them.
