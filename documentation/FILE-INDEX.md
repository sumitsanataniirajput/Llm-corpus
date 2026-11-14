# File index

Every file in the project: where it goes and what it is for. **Action** for all files on a new installation is *Create*; when updating, *Replace* the file with the same name. The complete code of each file is the file itself.

`web/js/config.js` and `android/local.properties` are not listed because **you** create them from their `.example` templates (they hold your own addresses and public keys and are deliberately not stored in Git).


## Web console (upload to the web host) — 59 files

| File | Goes to | Purpose |
|---|---|---|
| `web/assets/icons/favicon.svg` | Web host: `assets/icons/favicon.svg` | Image / icon |
| `web/css/components.css` | Web host: `css/components.css` | Styles for tables, forms, cards, modals, badges |
| `web/css/responsive.css` | Web host: `css/responsive.css` | Phone and tablet layout |
| `web/css/themes.css` | Web host: `css/themes.css` | Colours for light and dark theme |
| `web/firebase-messaging-sw.js` | Web host: `firebase-messaging-sw.js` | Browser push notifications in the background (optional) |
| `web/index.html` | Web host: `index.html` | The only HTML page: sign-in screen and application shell |
| `web/js/api.js` | Web host: `js/api.js` | All database and Edge Function calls with friendly errors |
| `web/js/auth.js` | Web host: `js/auth.js` | Sign-in, two-factor, sessions, inactivity sign-out |
| `web/js/charts.js` | Web host: `js/charts.js` | Chart.js wrappers |
| `web/js/components.js` | Web host: `js/components.js` | Tables, forms, modals, toasts, export, print |
| `web/js/config.example.js` | Web host: `js/config.example.js` | Template — copy to config.js and fill in |
| `web/js/maps.js` | Web host: `js/maps.js` | Google Maps loader, markers, zones, heat map |
| `web/js/notifications.js` | Web host: `js/notifications.js` | Notification bell, live alerts, browser push |
| `web/js/pages/analytics.js` | Web host: `js/pages/analytics.js` | Logic of the “Analytics” page |
| `web/js/pages/customers.js` | Web host: `js/pages/customers.js` | Logic of the “Customers” page |
| `web/js/pages/dashboard.js` | Web host: `js/pages/dashboard.js` | Logic of the “Dashboard” page |
| `web/js/pages/drivers.js` | Web host: `js/pages/drivers.js` | Logic of the “Drivers” page |
| `web/js/pages/finance.js` | Web host: `js/pages/finance.js` | Logic of the “Finance” page |
| `web/js/pages/live-tracking.js` | Web host: `js/pages/live-tracking.js` | Logic of the “Live Tracking” page |
| `web/js/pages/locations.js` | Web host: `js/pages/locations.js` | Logic of the “Locations” page |
| `web/js/pages/marketing.js` | Web host: `js/pages/marketing.js` | Logic of the “Marketing” page |
| `web/js/pages/notifications.js` | Web host: `js/pages/notifications.js` | Logic of the “Notifications” page |
| `web/js/pages/otp-verification.js` | Web host: `js/pages/otp-verification.js` | Logic of the “Otp Verification” page |
| `web/js/pages/pricing.js` | Web host: `js/pages/pricing.js` | Logic of the “Pricing” page |
| `web/js/pages/rides.js` | Web host: `js/pages/rides.js` | Logic of the “Rides” page |
| `web/js/pages/security.js` | Web host: `js/pages/security.js` | Logic of the “Security” page |
| `web/js/pages/services.js` | Web host: `js/pages/services.js` | Logic of the “Services” page |
| `web/js/pages/settings.js` | Web host: `js/pages/settings.js` | Logic of the “Settings” page |
| `web/js/pages/shared.js` | Web host: `js/pages/shared.js` | Helpers shared by pages (lookups, document viewer) |
| `web/js/pages/staff.js` | Web host: `js/pages/staff.js` | Logic of the “Staff” page |
| `web/js/pages/support.js` | Web host: `js/pages/support.js` | Logic of the “Support” page |
| `web/js/pages/vehicles.js` | Web host: `js/pages/vehicles.js` | Logic of the “Vehicles” page |
| `web/js/permissions.js` | Web host: `js/permissions.js` | Loads the signed-in person’s permissions; can() |
| `web/js/router.js` | Web host: `js/router.js` | Loads pages/<name>.html and js/pages/<name>.js for the address |
| `web/js/supabase-client.js` | Web host: `js/supabase-client.js` | Creates the Supabase connection; refuses secret keys |
| `web/js/theme-boot.js` | Web host: `js/theme-boot.js` | Applies the saved light/dark theme before the page paints |
| `web/js/tracking.js` | Web host: `js/tracking.js` | Live driver positions and trip replay |
| `web/js/utilities.js` | Web host: `js/utilities.js` | Formatting (money, dates), escaping, small helpers |
| `web/js/validation.js` | Web host: `js/validation.js` | Form and file validation rules |
| `web/pages/analytics.html` | Web host: `pages/analytics.html` | Layout of the “Analytics” page |
| `web/pages/customers.html` | Web host: `pages/customers.html` | Layout of the “Customers” page |
| `web/pages/dashboard.html` | Web host: `pages/dashboard.html` | Layout of the “Dashboard” page |
| `web/pages/drivers.html` | Web host: `pages/drivers.html` | Layout of the “Drivers” page |
| `web/pages/finance.html` | Web host: `pages/finance.html` | Layout of the “Finance” page |
| `web/pages/live-tracking.html` | Web host: `pages/live-tracking.html` | Layout of the “Live Tracking” page |
| `web/pages/locations.html` | Web host: `pages/locations.html` | Layout of the “Locations” page |
| `web/pages/marketing.html` | Web host: `pages/marketing.html` | Layout of the “Marketing” page |
| `web/pages/notifications.html` | Web host: `pages/notifications.html` | Layout of the “Notifications” page |
| `web/pages/otp-verification.html` | Web host: `pages/otp-verification.html` | Layout of the “Otp Verification” page |
| `web/pages/pricing.html` | Web host: `pages/pricing.html` | Layout of the “Pricing” page |
| `web/pages/rides.html` | Web host: `pages/rides.html` | Layout of the “Rides” page |
| `web/pages/security.html` | Web host: `pages/security.html` | Layout of the “Security” page |
| `web/pages/services.html` | Web host: `pages/services.html` | Layout of the “Services” page |
| `web/pages/settings.html` | Web host: `pages/settings.html` | Layout of the “Settings” page |
| `web/pages/staff.html` | Web host: `pages/staff.html` | Layout of the “Staff” page |
| `web/pages/support.html` | Web host: `pages/support.html` | Layout of the “Support” page |
| `web/pages/vehicles.html` | Web host: `pages/vehicles.html` | Layout of the “Vehicles” page |
| `web/script.js` | Web host: `script.js` | Start-up: config check, sign-in flow, starts the router |
| `web/style.css` | Web host: `style.css` | Main stylesheet (layout, sidebar, top bar) |

## Database (Supabase SQL Editor) — 12 files

| File | Goes to | Purpose |
|---|---|---|
| `supabase/migrations/0001_foundation.sql` | Paste into Supabase SQL Editor | Database migration — see DATABASE.md |
| `supabase/migrations/0002_fleet_people.sql` | Paste into Supabase SQL Editor | Database migration — see DATABASE.md |
| `supabase/migrations/0003_rides.sql` | Paste into Supabase SQL Editor | Database migration — see DATABASE.md |
| `supabase/migrations/0004_finance_marketing_support.sql` | Paste into Supabase SQL Editor | Database migration — see DATABASE.md |
| `supabase/migrations/0005_auth_functions.sql` | Paste into Supabase SQL Editor | Database migration — see DATABASE.md |
| `supabase/migrations/0006_ride_functions.sql` | Paste into Supabase SQL Editor | Database migration — see DATABASE.md |
| `supabase/migrations/0007_otp_functions.sql` | Paste into Supabase SQL Editor | Database migration — see DATABASE.md |
| `supabase/migrations/0008_finance_functions.sql` | Paste into Supabase SQL Editor | Database migration — see DATABASE.md |
| `supabase/migrations/0009_admin_functions.sql` | Paste into Supabase SQL Editor | Database migration — see DATABASE.md |
| `supabase/migrations/0010_analytics_functions.sql` | Paste into Supabase SQL Editor | Database migration — see DATABASE.md |
| `supabase/migrations/0011_rls_policies.sql` | Paste into Supabase SQL Editor | Database migration — see DATABASE.md |
| `supabase/migrations/0012_seed_reference.sql` | Paste into Supabase SQL Editor | Database migration — see DATABASE.md |

## Database extras — 1 files

| File | Goes to | Purpose |
|---|---|---|
| `supabase/policies/schedule_jobs.sql` | Paste into Supabase SQL Editor | Schedules the background jobs (pg_cron) |

## Demo data — 1 files

| File | Goes to | Purpose |
|---|---|---|
| `supabase/seed/demo_seed.sql` | SQL Editor of a practice project only | DEMO DATA — practice projects only |

## Edge Functions (Supabase CLI) — 14 files

| File | Goes to | Purpose |
|---|---|---|
| `supabase/config.toml` | Your computer → `supabase functions deploy` | Function settings (which functions are public webhooks) |
| `supabase/functions/.env.example` | Your computer → `supabase functions deploy` | List of every secret name |
| `supabase/functions/_shared/common.ts` | Your computer → `supabase functions deploy` | Shared: auth check, CORS, errors, database client |
| `supabase/functions/_shared/fcm.ts` | Your computer → `supabase functions deploy` | Firebase push sender |
| `supabase/functions/_shared/sms.ts` | Your computer → `supabase functions deploy` | SMS providers (MSG91, Twilio, Fast2SMS) |
| `supabase/functions/ai-assistant/index.ts` | Your computer → `supabase functions deploy` | Optional AI questions over aggregated figures |
| `supabase/functions/bookings/index.ts` | Your computer → `supabase functions deploy` | Fare quote and booking creation with Google route distance |
| `supabase/functions/integration-status/index.ts` | Your computer → `supabase functions deploy` | Checks which secrets are set and whether providers answer |
| `supabase/functions/notify/index.ts` | Your computer → `supabase functions deploy` | Sends a notification by push / SMS / e-mail |
| `supabase/functions/otp/index.ts` | Your computer → `supabase functions deploy` | Ride-start OTP: issue, resend, manual generate, override |
| `supabase/functions/payment-webhook/index.ts` | Your computer → `supabase functions deploy` | Receives signed Razorpay events |
| `supabase/functions/payments/index.ts` | Your computer → `supabase functions deploy` | Creates Razorpay orders, executes refunds |
| `supabase/functions/sms-webhook/index.ts` | Your computer → `supabase functions deploy` | Receives SMS delivery reports |
| `supabase/functions/staff-admin/index.ts` | Your computer → `supabase functions deploy` | Invites staff, password reset, force sign-out |

## Android Manager App — 29 files

| File | Goes to | Purpose |
|---|---|---|
| `android/app/build.gradle.kts` | Your computer → Android Studio | Gradle build settings |
| `android/app/proguard-rules.pro` | Your computer → Android Studio | Release shrinking rules |
| `android/app/src/main/AndroidManifest.xml` | Your computer → Android Studio | Permissions and components |
| `android/app/src/main/java/com/ridemanager/app/AppViewModel.kt` | Your computer → Android Studio | Sign-in state, two-factor, permissions, timeout |
| `android/app/src/main/java/com/ridemanager/app/MainActivity.kt` | Your computer → Android Studio | Entry screen; picks sign-in or main screen |
| `android/app/src/main/java/com/ridemanager/app/data/Format.kt` | Your computer → Android Studio | Money/date formatting |
| `android/app/src/main/java/com/ridemanager/app/data/SessionStore.kt` | Your computer → Android Studio | Encrypted storage of the session |
| `android/app/src/main/java/com/ridemanager/app/data/SupabaseApi.kt` | Your computer → Android Studio | Network calls to Supabase |
| `android/app/src/main/java/com/ridemanager/app/push/PushService.kt` | Your computer → Android Studio | Push notifications |
| `android/app/src/main/java/com/ridemanager/app/ui/AccountScreen.kt` | Your computer → Android Studio | Attendance, push, sign out |
| `android/app/src/main/java/com/ridemanager/app/ui/AlertsScreen.kt` | Your computer → Android Studio | Incidents and notifications |
| `android/app/src/main/java/com/ridemanager/app/ui/DashboardScreen.kt` | Your computer → Android Studio | Today’s figures |
| `android/app/src/main/java/com/ridemanager/app/ui/LoginScreen.kt` | Your computer → Android Studio | Sign-in and code screens |
| `android/app/src/main/java/com/ridemanager/app/ui/MainScreen.kt` | Your computer → Android Studio | Bottom tabs |
| `android/app/src/main/java/com/ridemanager/app/ui/MapScreen.kt` | Your computer → Android Studio | Live driver map |
| `android/app/src/main/java/com/ridemanager/app/ui/RidesScreen.kt` | Your computer → Android Studio | Ride list, detail, OTP status |
| `android/app/src/main/java/com/ridemanager/app/ui/Theme.kt` | Your computer → Android Studio | Colours and shared UI pieces |
| `android/app/src/main/res/drawable/ic_launcher_foreground.xml` | Your computer → Android Studio | App resource (text, colour, icon, theme) |
| `android/app/src/main/res/drawable/ic_notification.xml` | Your computer → Android Studio | App resource (text, colour, icon, theme) |
| `android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml` | Your computer → Android Studio | App resource (text, colour, icon, theme) |
| `android/app/src/main/res/values/colors.xml` | Your computer → Android Studio | App resource (text, colour, icon, theme) |
| `android/app/src/main/res/values/strings.xml` | Your computer → Android Studio | App resource (text, colour, icon, theme) |
| `android/app/src/main/res/values/themes.xml` | Your computer → Android Studio | App resource (text, colour, icon, theme) |
| `android/app/src/main/res/xml/data_extraction_rules.xml` | Your computer → Android Studio | App resource (text, colour, icon, theme) |
| `android/build.gradle.kts` | Your computer → Android Studio | Gradle build settings |
| `android/gradle.properties` | Your computer → Android Studio | Gradle options |
| `android/gradle/wrapper/gradle-wrapper.properties` | Your computer → Android Studio | Gradle version |
| `android/local.properties.example` | Your computer → Android Studio | Template — copy to local.properties |
| `android/settings.gradle.kts` | Your computer → Android Studio | Gradle modules and repositories |

## Tests — 8 files

| File | Goes to | Purpose |
|---|---|---|
| `tests/check-imports.mjs` | Stays in the repository | Automated test / check |
| `tests/check-rpc-usage.mjs` | Stays in the repository | Automated test / check |
| `tests/check-writes.mjs` | Stays in the repository | Automated test / check |
| `tests/lib/db.mjs` | Stays in the repository | Automated test / check |
| `tests/package-lock.json` | Stays in the repository | Automated test / check |
| `tests/package.json` | Stays in the repository | Automated test / check |
| `tests/run-db-tests.mjs` | Stays in the repository | Automated test / check |
| `tests/run-web-smoke.mjs` | Stays in the repository | Automated test / check |

## Documentation — 8 files

| File | Goes to | Purpose |
|---|---|---|
| `documentation/API.md` | Stays in the repository | Guide |
| `documentation/DATABASE.md` | Stays in the repository | Guide |
| `documentation/DEPLOYMENT.md` | Stays in the repository | Guide |
| `documentation/HOPEWEB-GUIDE.md` | Stays in the repository | Guide |
| `documentation/MASTER-PROMPT.txt` | Stays in the repository | The original specification |
| `documentation/SECURITY.md` | Stays in the repository | Guide |
| `documentation/SETUP.md` | Stays in the repository | Guide |
| `documentation/schema-reference.txt` | Stays in the repository | Generated list of every table, column and function |

## Repository root — 2 files

| File | Goes to | Purpose |
|---|---|---|
| `.gitignore` | Stays in the repository | Keeps secrets and build output out of Git |
| `README.md` | Stays in the repository | Project overview |
