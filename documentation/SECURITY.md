# Security

## The model in one paragraph

The website and the Android app are **untrusted**. They hold only the public anon key. Every rule is enforced
inside the database (Row Level Security + permission checks inside functions) or inside Edge Functions that hold
the secrets. Hiding a button in the console is a convenience, never the protection: if someone edits the
JavaScript, the server still refuses.

## Keys and where they live

| Key | Public? | Lives in | Never in |
|---|---|---|---|
| Supabase anon / publishable key | Yes | `web/js/config.js`, `android/local.properties` | — |
| Supabase **service_role** key | **No** | Provided automatically to Edge Functions | Website, app, Git, chat, screenshots |
| Razorpay secret, webhook secret, SMS keys, Firebase service account, AI key | **No** | Supabase Edge Function secrets | Website, app, Git |
| Google Maps website / Android keys | Yes, but **restricted** to your site / app | `config.js` / `local.properties` | — |
| Google Maps server key | No | Secret `GOOGLE_MAPS_SERVER_KEY` | Website, app |
| OTP pepper | No | Generated inside the database (`private.secrets`), not readable through the API | Anywhere else |

`.gitignore` already excludes `web/js/config.js`, `android/local.properties`, `google-services.json`, keystores
and `.env` files. The console refuses to start if it finds a service-role key in `config.js`.

If a secret ever leaks: rotate it at the provider first, then update the Supabase secret. For the service-role
key: Supabase → Project Settings → API → generate new keys.

## Staff sign-in

- Accounts are created by invitation only (public sign-up is switched off in Part A of the setup).
- Passwords are checked by Supabase Auth; this project never stores or sees a password.
- **Two-factor (TOTP)** can be required per account. When it is, every permission check fails until the session
  is verified with a code — enforced in `has_permission()`, not in the browser.
- Failed sign-ins are counted server-side; the account locks after `security.max_failed_logins` (default 5) for
  `security.lockout_minutes` (default 15). Requests are rate-limited per IP address.
- Each sign-in registers a **session** row. Ending a session (Security → Sessions, or suspending a staff member)
  makes every further request from that device fail immediately, even though its token has not expired.
- Inactivity sign-out: default 30 minutes, set per staff member.
- Optional **IP rules** (Security → IP rules). Deny rules always win; one active Allow rule turns on allow-listing.
  Locked out? SQL editor: `update ip_rules set is_active = false;`

## Roles and permissions

Ten roles are seeded (Super Admin … Read-only Analyst) with about 70 permissions. Staff → Roles & permissions
edits the matrix. A person can only change roles *below* their own, cannot change their own role or status, and
the last active Super Admin cannot be removed. Sensitive actions additionally require a typed reason, and all of
them are written to the audit trail.

Separation of duties: the person who creates a driver payout cannot approve it (setting
`finance.allow_self_approval`, off by default).

## Ride-start OTP

- Created only on the server, when the driver accepts (or by a permitted manager, with a reason).
- Digits come from a cryptographic random source. Only an HMAC-SHA256 of the code is stored, keyed with a
  per-OTP salt and a database-held pepper — the code cannot be read back from the database, by anyone.
- The code goes to the customer’s phone by SMS. It is never returned to the console, the Manager App or logs.
- The driver enters it; the server checks: correct ride, assigned driver, not expired (default 5 minutes), not
  locked, attempts left (default 5, then a 15-minute lock), and that the driver’s confirmed distance matches the
  booking. Only then does the ride move to *started*.
- Resends are limited and spaced; each new code invalidates the old one.
- A manager override needs its own permission, re-entry of the manager’s password, a written identity
  confirmation and a reason, and is capped per person per day.
- Everything — generation, delivery result, every attempt, lock, override — is in an append-only audit log.

## Money

- Amounts are whole paise (integers). No floating-point money anywhere.
- Money tables cannot be written directly by any signed-in user; only through functions that validate state,
  take an idempotency key (a repeated click or retry cannot pay twice) and write the audit trail.
- An online payment becomes “paid” only from a Razorpay webhook whose signature verifies. The browser’s
  “payment succeeded” message is never trusted.
- Refunds can never exceed what was captured; wallets can never go negative.

## Personal data (DPDP Act 2023, India)

- Phone numbers and e-mails of customers are masked for roles without `customers.view_pii`.
- Identity documents are stored in **private** storage buckets and opened through links that expire in two minutes.
  Only the last 4 digits of Aadhaar and masked PAN / licence numbers are kept as text.
- Customers’ deletion requests are tracked and processed with a function that anonymises the person while
  keeping the financial records the law requires.
- Retention periods (Security → Retention & backups) delete old GPS history and logs automatically.
- You remain responsible for your privacy notice, consent wording, a grievance contact, and a breach process.
  Have a lawyer review these; this software cannot do that for you.

## Audit trail

`audit_logs`, `otp_audit_logs` and the money ledgers are append-only: update and delete are rejected by
triggers for every user including Super Admins. (A person with the database password can still alter anything —
keep that password to one or two people and enable two-factor on the Supabase account itself.)

## Web application hardening

- All text from the database is HTML-escaped before display (protection against script injection).
- Content-Security-Policy in `index.html` limits where scripts can load from.
- Third-party scripts (Supabase SDK, Chart.js, SweetAlert2, Font Awesome) are loaded from public CDNs at pinned
  versions. For stricter control, download them and serve them from your own site.
- Uploads are checked for type and size in the browser **and** by the storage bucket’s own limits.

## Known limits — please read

1. The Edge Functions and the Android app were not executed where this code was written (see `STATUS.md`).
   Test OTP, payment and push end to end on a practice project before real customers use them.
2. No independent security review or penetration test has been done. Before handling real money or identity
   documents at scale, commission one.
3. Rate limits are per database; a determined attacker with many IP addresses needs a network-level shield
   (for example Cloudflare in front of your site).
4. Backups depend on your Supabase plan. The free plan has **no** automatic backups.
