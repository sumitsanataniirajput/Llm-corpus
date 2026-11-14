# Deployment and operations

## Use two projects

Create two Supabase projects: **practice** (test keys, demo data allowed) and **live** (real keys, never demo
data). Set `ENVIRONMENT: "production"` in the live `config.js`; anything else shows a coloured badge in the
sidebar so nobody mistakes one for the other.

## Go-live check list

1. All 12 migrations ran without error on the live project; `bootstrap_super_admin` done.
2. Public sign-up is off; Site URL and Redirect URLs point at the live console address (https).
3. Your own account requires two-factor; the Supabase dashboard account also has two-factor.
4. `supabase functions deploy` done; `ALLOWED_ORIGINS` set to the live console address.
5. Settings → Integrations → **Check now**: SMS, payment and maps show *Healthy*; anything you do not use is disabled.
6. One real end-to-end test: booking → driver assigned → OTP SMS arrives on a real phone → ride completes →
   ₹1 test payment captured by webhook → refund → shows correctly in Finance.
7. `pg_cron` jobs scheduled (`select jobname, active from cron.job;`).
8. Google Maps keys are restricted (website key by referrer, Android key by package + SHA-1).
9. A paid Supabase plan with daily backups (and point-in-time recovery if you can) is active.
10. Privacy policy and terms are published and their version is set in Settings → General.

## Web console

Upload the contents of `web/` to any https static host (`HOPEWEB-GUIDE.md`). There is no build step.
To update: replace changed files; ask staff to reload with Ctrl+F5.

## Database changes later

Never edit a migration file that has already run. Add a new file (`0013_…sql`) with the change and run it —
on practice first, then on live.

## Edge Functions

```bash
supabase functions deploy                 # all
supabase functions deploy otp             # one
supabase secrets list                     # names only, values are hidden
supabase functions logs otp               # recent logs (or Dashboard → Edge Functions → Logs)
```

## Android app

What it is: a native companion (Kotlin, Jetpack Compose, Material 3) for managers on the move — today’s
figures, rides and their OTP status (with “send a new OTP”), the live driver map, safety incidents with
acknowledge, notifications, attendance. Configuration work (prices, payouts, staff, settings) stays on the web console.

### Project structure

```
android/
├── settings.gradle.kts, build.gradle.kts, gradle.properties   project-level Gradle files (plugin versions)
├── gradle/wrapper/gradle-wrapper.properties                   which Gradle version to download
├── local.properties.example                                   template for your addresses and PUBLIC keys
└── app/
    ├── build.gradle.kts                                       app settings, SDK versions, libraries
    ├── proguard-rules.pro                                     rules for the shrunk release build
    └── src/main/
        ├── AndroidManifest.xml                                permissions, the one screen (activity), push service
        ├── java/com/ridemanager/app/
        │   ├── MainActivity.kt        chooses sign-in or main screen; blocks screenshots
        │   ├── AppViewModel.kt        sign-in, two-factor, inactivity sign-out, permissions
        │   ├── data/                  SessionStore (encrypted tokens), SupabaseApi (network), Format
        │   ├── push/PushService.kt    Firebase messages → phone notifications
        │   └── ui/                    Login, Main (tabs), Dashboard, Rides, Map, Alerts, Account, Theme
        └── res/                       name, icon, theme, backup rules
```

### Build and install

1. Install **Android Studio** (https://developer.android.com/studio) — it brings Java and the Android SDK.
2. **File → Open** → choose the `android` folder. Wait for “Gradle sync” to finish (first time: several minutes,
   it downloads Gradle and the libraries). If Android Studio offers to upgrade the Gradle plugin, you may accept.
3. In the `android` folder copy `local.properties.example` to `local.properties` and fill in `SUPABASE_URL`,
   `SUPABASE_ANON_KEY` and (optional) `MAPS_API_KEY`. Keep the `sdk.dir` line Android Studio wrote.
4. Optional push: put Firebase’s `google-services.json` in `android/app/`.
5. Connect a phone with USB debugging on (Settings → About phone → tap *Build number* 7 times → Developer
   options → USB debugging), or create an emulator (Device Manager). Press the green **Run** button.
6. To make an APK file to share: **Build → Build App Bundle(s) / APK(s) → Build APK(s)**. The file appears in
   `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to a phone and open it (allow “install unknown apps”).
7. For the Play Store or long-term use create a signed release: **Build → Generate Signed App Bundle / APK** →
   create a keystore. **Back up the keystore file and its passwords** — without them you can never update the app.

### Permissions the app asks for

| Permission | Why | When asked |
|---|---|---|
| Internet | Talk to your server | Never asked (automatic) |
| Notifications | Emergency and operational alerts | When you tap “Turn on alerts” (Android 13+) |
| Location (while using the app) | Show your own blue dot on the driver map | Only if you tap the pin icon on the Map tab |

The Manager App does **not** use background location and never uploads the manager’s position. Continuous
background GPS with a foreground-service notification belongs in the Driver App; the database side for it
(`ingest_driver_location`) is already built and tested. See `STATUS.md`.

## Backups and recovery

- Supabase Pro: daily backups (7 days). Point-in-time recovery is an add-on. Free plan: none.
- Monthly: Dashboard → Database → Backups → download one, or run `supabase db dump -f backup.sql`; store it
  encrypted, off the platform; note it in Security → Retention & backups → *Record a backup*.
- Twice a year: restore a backup into a fresh practice project and sign in, to prove it works.
- Storage (document files) is not included in database backups; copy the buckets separately if you need them.

## Monitoring

- **Security → System health** in the console: errors, failed webhooks, failed OTP deliveries, stale GPS,
  rides that were accepted without an OTP.
- Supabase Dashboard → Reports and Logs: database load, API errors, function logs.
- Set a billing alert in Google Cloud, and usage alerts with your SMS provider.

## Running the tests (optional, on your computer)

Install Node.js 20 or newer, then:

```bash
cd tests
npm install
npm test
```

It builds the whole database inside a local PostgreSQL engine, runs 73 backend tests (permissions, OTP, fares,
payments, refunds, payouts…), three static checks of the console’s code against the database, and opens all
18 pages and 82 tabs of the console against that database. It needs no internet account and touches nothing live.
