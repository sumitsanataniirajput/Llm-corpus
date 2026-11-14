# Status — what is tested, what is not, what is not built

This page is deliberately blunt. Read it before relying on the system for real customers or real money.

## Summary

| Part | Written | Tested here | How |
|---|---|---|---|
| Database (12 migrations: 82 tables, 127 functions, security policies) | Yes | **Yes** | 73 automated tests on a real PostgreSQL engine (PGlite), all passing |
| Web console (18 pages, 82 tabs) | Yes | **Partly** | Every page and tab was opened by an automated browser simulator (jsdom) against that database with demo data; every database call the pages make was checked against the schema. **Not** seen in a real browser. Forms that save data were checked statically, not clicked. |
| Edge Functions (9) | Yes | **No** | The tool that runs them (Deno) was not available. Never executed. |
| Android Manager App | Yes | **No** | No Java / Android SDK was available. **Never compiled.** Expect to fix some compile errors on first build. |
| SMS, Razorpay, Google Maps, Firebase, e-mail, AI | Integration code written | **No** | No accounts or keys existed. No message was sent, no payment taken, no map loaded. |
| Hopeweb | Guide written generically | **No** | I had no access to Hopeweb and do not know its screens. |

Nothing has been deployed anywhere. No Supabase project was created or changed on your account.

## What “tested” covers for the database

Permissions for every role, two-factor enforcement, account lockout, session revocation, IP rules, the ride
status machine, fare calculation (night / peak / surge / minimum / coupon / GST), driver allocation, GPS
ingestion and distance, the whole OTP life-cycle (hashing, expiry, attempts, lock, resend limits, wrong driver,
distance mismatch, override), cash and online payments, webhook signature data handling and replay, refunds,
wallets, payouts with maker-checker, disputes, SOS, analytics functions, settings, imports, deletion requests,
audit immutability, and that every table has Row Level Security.

PGlite is real PostgreSQL but not Supabase itself: the `pg_cron` schedule, Supabase Auth, Storage policies and
Realtime are exercised only when you install on Supabase.

## Most likely places to find problems (check these first)

1. **Android first build** — compile errors (a wrong import or parameter name) are likely because the code was
   never compiled. Send me the red error text from Android Studio’s *Build* panel and I will fix it.
2. **Edge Functions first deploy** — a type or import error would show in `supabase functions deploy` output.
3. **Content-Security-Policy in `web/index.html`** — written from the list of addresses the console uses but not
   run in a real browser. If the browser console (F12) shows “Refused to load … Content Security Policy”, tell
   me the line; as a stop-gap you may delete the single `<meta http-equiv="Content-Security-Policy" …>` line.
4. **Forms** — saving and editing were verified against column lists, not by clicking. A wrong value in a
   drop-down would appear as a red message when you press Save.
5. **Lower roles** — pages were opened as Super Admin. Other roles are enforced by the (tested) database, but the
   pages may show a section that then says “permission denied” instead of hiding it.
6. **Screen layout** — never seen on a real screen or phone; spacing or overflow glitches are possible.

## Not built

| Item | State |
|---|---|
| **Driver App** | Not built. The server side it needs exists and is tested: location upload (`ingest_driver_location`), accept / decline (`driver_respond_assignment`), arrive / complete (`driver_update_ride`), OTP entry (`otp_verify`), going online (`set_driver_availability`). Until a Driver App exists, drivers cannot go online, share GPS or enter OTPs, so **live rides cannot actually run** — you can configure everything and create bookings, but not complete the OTP flow in the field. |
| **Customer App / customer website** | Not built. Booking creation, fare quote, payment order and deletion request endpoints exist for it. |
| Android Manager App scope | A companion, not a copy of the console: dashboard, rides + OTP status and resend, driver map, incidents, notifications, attendance. Two-factor set-up, and all configuration, are web-only. |
| WhatsApp and bulk (non-OTP) SMS | Not sent. Both need provider-approved templates (Meta / DLT) per message; the `notify` function records them as “not sent” with that reason. Only the ride-OTP SMS is implemented. |
| Play Store publishing, iOS app | Not included. |
| Automatic backups | Provided by Supabase’s paid plans, not by this code. |
| Legal documents (privacy policy, terms, DPDP consent wording) | Not included — need a lawyer. |
| Penetration test / independent security review | Not done. |

## Module completion (web console + backend)

| # | Module | Backend | Console page | Needs external service |
|---|---|---|---|---|
| 1 | Dashboard | Tested | Opens, shows live figures | — |
| 2 | Live tracking | Tested | Opens; map itself untested | Google Maps; Driver App for real positions |
| 3 | Rides | Tested | Opens; create/assign/cancel forms unclicked | Edge `bookings` for route distance |
| 4 | OTP verification | Tested | Opens | SMS provider + Edge `otp`; Driver App to enter the code |
| 5 | Drivers | Tested | Opens; document upload untested | Supabase Storage |
| 6 | Vehicles | Tested | Opens | Supabase Storage |
| 7 | Customers | Tested | Opens | — |
| 8 | Finance | Tested | Opens | Razorpay + Edge `payments`, `payment-webhook` for online payments; cash works without |
| 9 | Pricing | Tested | Opens, fare calculator | — |
| 10 | Services | Tested | Opens | — |
| 11 | Marketing | Tested | Opens | — |
| 12 | Analytics | Tested | Opens; forecasts are simple statistics, labelled as estimates | — |
| 13 | Support & safety | Tested | Opens | — |
| 14 | Notifications | Tested (records) | Opens | Firebase / SMS / e-mail + Edge `notify` to actually deliver |
| 15 | Staff & roles | Tested | Opens | Edge `staff-admin` to invite people |
| 16 | Locations | Tested | Opens; zone drawing untested | Google Maps |
| 17 | Security | Tested | Opens | — |
| 18 | Settings | Tested | Opens | Edge `integration-status` |

## Reproduce the tests yourself

```bash
cd tests && npm install && npm test
```
