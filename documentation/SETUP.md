# Setup guide (beginner friendly)

Follow the parts in order. Parts A–C give you a working console (about 45 minutes). Parts D–H add maps, SMS,
payments and push — each is optional, and until you add it the console clearly says “not configured” instead of
pretending to work.

You need: a computer, a web browser, and an e-mail address. No programming.

Words used here:
- **Supabase** — the service that hosts your database, sign-in and server code.
- **SQL editor** — a page in Supabase where you paste database scripts and press Run.
- **Secret** — a private key. Secrets go only into Supabase “Edge Function secrets”. Never into `web/` or `android/`.
- **anon key** — a *public* key, safe to put in the website and the app. The **service_role key is the opposite: never copy it anywhere.**

---

## Part A — Create the database (Supabase)

1. Go to https://supabase.com and create a free account.
2. Click **New project**. Name it (for example `ride-manager`), set a strong database password and **save that
   password in a password manager**, choose the region nearest your customers (for India: Mumbai), click **Create**.
   Wait about two minutes.
3. In the left menu open **SQL Editor** → **New query**.
4. On your computer open the folder `supabase/migrations/`. There are 12 files, `0001_…` to `0012_…`.
   For **each file, in number order**:
   1. open the file, select everything, copy;
   2. paste into the SQL editor;
   3. click **Run**;
   4. wait for “Success. No rows returned”. If you see a red error, stop and fix it before the next file
      (the most common cause is running the files out of order).
5. That is the whole database: tables, security rules (RLS), storage buckets, realtime and the starting
   reference data (roles, permissions, vehicle categories, settings). You do not need to configure RLS,
   Storage or Realtime by hand — the scripts did it.

### Create the first Super Admin (you)

6. Left menu → **Authentication** → **Users** → **Add user** → **Create new user**. Enter your e-mail and a strong
   password, tick **Auto Confirm User**, click **Create user**.
7. Back in the **SQL Editor**, run this (with your e-mail and name):

   ```sql
   select public.bootstrap_super_admin('you@example.com', 'Your Name');
   ```

   It answers “Super Admin created…”. This command works only once and only from the SQL editor. Every other
   staff account is created later inside the console (Staff → Add staff member).

### Turn on the scheduled jobs (recommended)

8. Left menu → **Database** → **Extensions** → search `pg_cron` → enable it.
9. SQL Editor → paste the contents of `supabase/policies/schedule_jobs.sql` → **Run**. This expires old OTPs,
   builds the nightly report, warns about expiring documents and deletes old logs.

### Sign-in settings

10. **Authentication** → **Sign In / Providers** → **Email**: turn **off** “Allow new users to sign up”
    (staff are invited, the public must not self-register).
11. **Authentication** → **URL Configuration**: set **Site URL** to the address where your console will live
    (Part C). Add the same address under **Redirect URLs**.
12. **Authentication** → **Multi-Factor** : make sure **TOTP (authenticator app)** is enabled.

---

## Part B — Connect the web console

1. In Supabase open **Project Settings** → **API** (or **API Keys**). Copy the **Project URL** and the
   **anon / publishable** key.
2. In the project folder open `web/js/`. Copy the file `config.example.js` and name the copy **`config.js`**
   (same folder).
3. Open `web/js/config.js` in a text editor and replace the two placeholders:

   ```js
   SUPABASE_URL: "https://abcdxyz.supabase.co",
   SUPABASE_ANON_KEY: "paste-the-anon-key-here",
   ```

   Save. Leave the other lines as they are for now.

> If you paste the service_role key by mistake, the console refuses to start and tells you. Go back and copy the anon key.

---

## Part C — Put the console online

The console is a folder of plain files. Any static web host works (Hopeweb, Netlify, Cloudflare Pages,
Hostinger, GitHub Pages…). The rule is the same everywhere: **upload the contents of the `web/` folder,
keeping its sub-folders, so that `index.html` is at the top of your site.** `documentation/HOPEWEB-GUIDE.md`
lists every file and where it goes.

1. Upload the `web/` contents (including the `config.js` you just made).
2. Make sure the site is served over **https** (required for sign-in security and push notifications).
3. Open the site. You should see the sign-in page. Sign in with the e-mail and password from Part A step 6.
4. **Protect your own account with two-factor authentication now.** Open **Staff** → click your own row →
   **Session settings** → tick *Require two-factor authentication* → Save. Sign out and sign in again: the console
   shows a QR code. Scan it with Google Authenticator / Microsoft Authenticator / Authy on your phone and type the
   6-digit code. From then on your password alone is not enough to sign in. (New staff you invite have this
   requirement ticked by default and see the same QR screen on their first sign-in.)
5. First things to do inside the console:
   1. **Locations** → add your city (with the centre latitude/longitude).
   2. **Pricing** → add a pricing rule for each vehicle category you offer in that city.
   3. **Staff** → add your team and give each person the right role.

To try it on your own computer first: open a terminal in the `web/` folder and run `python3 -m http.server 8080`,
then visit http://localhost:8080. (Opening `index.html` by double-click does not work; browsers block modules on `file://`.)

---

## Part D — Server functions (needed for OTP SMS, payments, push, staff invitations)

Edge Functions are small server programs in `supabase/functions/`. They hold your secrets, so they are the only
place provider keys are used.

1. Install the Supabase CLI: https://supabase.com/docs/guides/cli (on Windows: `scoop install supabase`; on Mac:
   `brew install supabase/tap/supabase`).
2. Open a terminal in the project’s top folder and run:

   ```bash
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF      # the part before .supabase.co
   supabase functions deploy
   ```

   This deploys all nine functions. `supabase/config.toml` already marks the two webhook functions as public
   (they verify signatures themselves).
3. Set the one secret every installation needs — the address of your console, so that only your site may call the functions:

   ```bash
   supabase secrets set ALLOWED_ORIGINS=https://your-console-address.example
   ```

4. Add the other secrets as you set up each provider below. The full list with explanations is in
   `supabase/functions/.env.example`. You can also add secrets in the dashboard: **Edge Functions** → **Secrets**.
5. In the console open **Settings → Integrations** and press **Check secrets**. Each service shows
   *Not configured*, *Configured* or *Healthy*, and names any missing secret.

Without this part the console still works for everything that is pure database work; buttons that need a
function say “server function is not deployed yet”. **Staff → Add staff member needs the `staff-admin` function.**

---

## Part E — Google Maps (live tracking, zones, distances)

1. Go to https://console.cloud.google.com, create a project, and attach a billing account (Google requires a
   card; there is a monthly free allowance — check the current pricing page).
2. **APIs & Services → Library**: enable **Maps JavaScript API**, **Places API (New)**, **Routes API**,
   **Geocoding API**, and for the Android app **Maps SDK for Android**.
3. **APIs & Services → Credentials → Create credentials → API key** — create **three** keys:

   | Key | Restriction | Where it goes |
   |---|---|---|
   | Website key | *Websites* (HTTP referrers): `https://your-console-address.example/*`. API restriction: Maps JavaScript API, Places API. | `web/js/config.js` → `GOOGLE_MAPS_API_KEY` |
   | Server key | No application restriction; API restriction: Routes API, Geocoding API. | Secret `GOOGLE_MAPS_SERVER_KEY` |
   | Android key | *Android apps*: package `com.ridemanager.app` + your signing SHA-1. API restriction: Maps SDK for Android. | `android/local.properties` → `MAPS_API_KEY` |

4. Re-upload `web/js/config.js`. Open **Live Tracking**: the map appears. Without the server key, trip distance
   falls back to a straight-line estimate × a road factor, and the booking shows that it is an estimate.

---

## Part F — SMS for the ride OTP

The OTP is created and sent only by the `otp` Edge Function; staff never see the code.

1. Choose a provider: **MSG91** or **Fast2SMS** (India) or **Twilio** (international).
2. In India you must complete **DLT registration** (entity, sender ID and an OTP template) with your provider
   before any SMS is delivered. This takes days; start early. Use this template text (it must match exactly what
   you register): `Your {{app}} ride OTP is {{otp}}. Share it with your driver only after you board. Valid for {{minutes}} minutes.`
3. Set the secrets, for example for MSG91:

   ```bash
   supabase secrets set SMS_PROVIDER=msg91 MSG91_AUTH_KEY=... MSG91_OTP_TEMPLATE_ID=...
   supabase secrets set SMS_WEBHOOK_TOKEN=$(openssl rand -hex 24)
   ```

4. Delivery reports (optional but recommended): in the provider’s dashboard set the delivery-report webhook to
   `https://YOUR-PROJECT-REF.supabase.co/functions/v1/sms-webhook?token=THE_SMS_WEBHOOK_TOKEN&provider=msg91`
5. Test: create a ride, assign a driver, and on **OTP Verification** press **Generate OTP** for it. The delivery
   log shows the provider’s real answer. Until an SMS provider is set the log says **Not configured** — the OTP
   exists but nobody received it.

---

## Part G — Payments (Razorpay)

1. Create an account at https://razorpay.com. You can use **Test mode** immediately; live mode needs KYC.
2. **Account & Settings → API Keys → Generate Test Key**. Then:

   ```bash
   supabase secrets set RAZORPAY_KEY_ID=rzp_test_... RAZORPAY_KEY_SECRET=...
   ```

3. **Webhooks → Add new webhook**: URL `https://YOUR-PROJECT-REF.supabase.co/functions/v1/payment-webhook`,
   choose a long random **secret**, tick `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`,
   `refund.failed`. Then `supabase secrets set RAZORPAY_WEBHOOK_SECRET=the-same-secret`.
4. A payment is marked paid **only** when a correctly signed webhook arrives. **Finance → Webhooks** lists every
   event received and whether its signature was valid.
5. Going live: finish KYC, generate **Live** keys, repeat steps 2–3 with the live values, and switch the mode
   label in **Settings → Integrations**. Cash payments need no gateway (Finance → Record cash payment).

---

## Part H — Push notifications (Firebase, optional)

1. https://console.firebase.google.com → **Add project**.
2. **Server:** Project settings → **Service accounts** → **Generate new private key**. Put the whole JSON on one
   line into the secret `FIREBASE_SERVICE_ACCOUNT`.
3. **Web console:** Project settings → General → **Add app → Web**. Copy the config values into `FIREBASE` in
   `web/js/config.js`. Cloud Messaging tab → **Web Push certificates** → generate a key pair → put it in
   `FIREBASE_VAPID_KEY`. Nothing else to edit: `web/firebase-messaging-sw.js` must simply be uploaded next to `index.html`.
4. **Android app:** Add app → Android, package `com.ridemanager.app`, download `google-services.json` into
   `android/app/`.
5. Without Firebase, notifications still appear inside the console (bell icon) — only phone/browser pop-ups are missing.

---

## Part I — Optional extras

- **AI assistant:** set `AI_API_KEY` (any OpenAI-compatible service; also `AI_BASE_URL`, `AI_MODEL`), then switch
  on **Settings → Features → AI assistant**. It only summarises figures your role may already see.
- **E-mail (Resend)** for invitations: by default Supabase sends auth e-mails itself, with a low hourly limit.
  For real use add your own SMTP in **Authentication → Emails → SMTP Settings**.
- **Redis (Upstash):** not needed until you have thousands of drivers online at once.
- **Practice data:** on a *separate practice project only*, run `supabase/seed/demo_seed.sql` in the SQL editor to
  get invented drivers, customers and rides to explore.

## If something goes wrong

| What you see | Cause and fix |
|---|---|
| “Configuration missing” page | `web/js/config.js` does not exist or was not uploaded. Part B. |
| “This looks like a service-role key” | Wrong key pasted. Use the anon key. Then **rotate** the service key in Supabase, since it was exposed. |
| Sign-in says “not a staff account” | You created the user but did not run `bootstrap_super_admin` (Part A step 7). |
| “server function is not deployed yet” | Part D. |
| Map says “unavailable” | Part E; check the website key’s referrer restriction matches your address exactly. |
| OTP delivery “Not configured” | Part F. |
| Everything says “permission denied” after adding an IP rule | You locked yourself out. SQL editor: `update ip_rules set is_active = false;` |
