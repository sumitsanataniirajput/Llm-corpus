# API reference

There are two kinds of server calls. Both need the signed-in user’s token; both check permissions on the server.

1. **Database functions (RPC)** — `POST https://<project>.supabase.co/rest/v1/rpc/<name>` with a JSON body of
   named arguments. In the console: `rpc('name', { p_arg: value })`.
2. **Edge Functions** — `POST https://<project>.supabase.co/functions/v1/<name>`. These hold the secrets.
   In the console: `fn('name', { ... })`.

Tables are also readable through Supabase’s standard REST interface, limited by Row Level Security.

## Edge Functions

All answer `{ "ok": true, ... }` or `{ "ok": false, "code": "CODE", "message": "…" }`.

| Function | Body | Who may call | Result |
|---|---|---|---|
| `otp` | `{action:"issue", booking_id}` | The assigned driver (Driver App) | `{ok, code:"ISSUED", otp_id, booking_code, expires_at, delivery:{status, provider, error}}` — never the code |
| `otp` | `{action:"resend", booking_id}` | Assigned driver, or staff with `otp.deliver` | same |
| `otp` | `{action:"generate", booking_id, reason}` | Staff with `otp.generate` | same |
| `otp` | `{action:"override", booking_id, reason (≥20), identity_confirmation (≥10), password}` | Staff with `otp.override` | `{ok}`; ride is authorised to start |
| `bookings` | `{action:"quote", …}` / `{action:"create", …}` | The customer themself, or staff with `rides.create` | `{ok, distance_km, duration_min, distance_source: "google_routes"\|"haversine_estimate", polyline, fare}` / `{ok, booking}` |
| `payments` | `{action:"create_order", booking_id}` | The ride’s customer, or staff with `finance.record_payment` | `{ok, order_id, amount_paise, currency, key_id}` |
| `payments` | `{action:"execute_refund", refund_id}` | Staff with `finance.refund` | `{ok, status, provider_refund_id}` |
| `payment-webhook` | Razorpay’s signed event | Razorpay (public URL, signature verified) | `{ok}` |
| `sms-webhook` | Provider delivery report, `?token=…&provider=…` | SMS provider (token verified) | `{ok}` |
| `notify` | `{notification_id}` | Staff with `notifications.send` | `{ok, dispatch_status, results}` |
| `staff-admin` | `{action:"create", email, full_name, role_code, phone?, city_scope?, branch_id?, mfa_required?, redirect_to}` | Staff with `staff.manage` | `{ok, staff_id, invited:true}` |
| `staff-admin` | `{action:"send_password_reset" \| "force_sign_out", staff_id}` | Staff with `staff.manage` | `{ok}` |
| `integration-status` | `{live_check: boolean}` | Staff with `settings.view` | `{ok, checked_at, integrations:[{kind, provider, status, missing[], error}]}` |
| `ai-assistant` | `{question}` | Staff with `ai.view`, feature switched on | `{ok, answer, model, generated_at}` |

## API keys for your own integrations

Security → API keys creates a key (shown once; only its hash is stored). A key does nothing by itself: an Edge
Function you write must look up its hash in `api_keys`, check `revoked_at`, `expires_at` and `scopes`, and then
act. No such public function is included yet — add one when you have a concrete integration to build.

## Database functions callable by signed-in users

Each one checks the caller’s permission itself; calling one you are not allowed to use returns `PERMISSION_DENIED`.

| Function | Arguments (`?` = optional) | Returns |
|---|---|---|
| `acknowledge_tracking_alert` | `p_alert_id bigint` | `void` |
| `adjust_customer_wallet` | `p_customer_id uuid, p_direction text, p_amount_paise bigint, p_reason text, p_idempotency_key text` | `void` |
| `ai_context` | — | `jsonb` |
| `allocation_candidates` | `p_booking_id uuid, p_limit integer?` | `jsonb` |
| `analytics_breakdowns` | `p_from timestamptz, p_to timestamptz, p_city_id uuid?` | `jsonb` |
| `analytics_timeseries` | `p_from timestamptz, p_to timestamptz, p_bucket text?, p_city_id uuid?` | `jsonb` |
| `apply_retention` | — | `jsonb` |
| `assign_driver` | `p_booking_id uuid, p_driver_id uuid, p_reason text?, p_actor_staff_id uuid?` | `jsonb` |
| `assign_vehicle` | `p_vehicle_id uuid, p_driver_id uuid, p_reason text?` | `void` |
| `auto_assign_driver` | `p_booking_id uuid` | `jsonb` |
| `begin_session` | `p_device text?` | `jsonb` |
| `booking_transition_allowed` | `p_from booking_status, p_to booking_status` | `boolean` |
| `calculate_fare` | `p_category_id uuid, p_city_id uuid, p_distance_km numeric, p_duration_min integer?, p_at timestamptz?, p_waiting_min integer?, p_pickup_lat numeric?, p_pickup_lng numeric?` | `jsonb` |
| `campaign_analytics` | — | `jsonb` |
| `cancel_booking` | `p_booking_id uuid, p_reason text` | `jsonb` |
| `city_stats` | — | `jsonb` |
| `complete_ride` | `p_booking_id uuid, p_reason text?` | `jsonb` |
| `create_api_key` | `p_name text, p_scopes text[], p_expires_at timestamptz?` | `jsonb` |
| `create_booking` | `p_customer_id uuid, p_category_id uuid, p_city_id uuid, p_pickup_address text, p_pickup_lat numeric, p_pickup_lng numeric, p_drop_address text, p_drop_lat numeric, p_drop_lng numeric, p_payment_method text?, p_coupon_code text?, p_scheduled_for timestamptz?, p_route_distance_km numeric?, p_route_duration_min integer?, p_encoded_polyline text?, p_actor_staff_id uuid?` | `jsonb` |
| `create_payout` | `p_driver_id uuid, p_amount_paise bigint, p_method text, p_idempotency_key text` | `jsonb` |
| `credit_incentive` | `p_incentive_id uuid` | `void` |
| `current_customer_id` | — | `uuid` |
| `current_driver_id` | — | `uuid` |
| `current_staff_id` | — | `uuid` |
| `dashboard_stats` | `p_from timestamptz, p_to timestamptz, p_city_id uuid?` | `jsonb` |
| `demand_heatmap` | `p_city_id uuid, p_from timestamptz, p_to timestamptz, p_cell_deg numeric?` | `jsonb` |
| `detect_suspicious_customers` | — | `integer` |
| `driver_location_trail` | `p_driver_id uuid?, p_booking_id uuid?, p_from timestamptz?, p_to timestamptz?` | `jsonb` |
| `driver_otp_context` | `p_booking_id uuid` | `jsonb` |
| `driver_performance` | `p_from timestamptz, p_to timestamptz, p_city_id uuid?, p_limit integer?` | `jsonb` |
| `driver_respond_assignment` | `p_booking_id uuid, p_accept boolean, p_reason text?` | `jsonb` |
| `driver_update_ride` | `p_booking_id uuid, p_action text` | `jsonb` |
| `end_session` | — | `void` |
| `fare_from_rule` | `p_rule jsonb, p_distance_km numeric, p_duration_min integer, p_waiting_min integer, p_at timestamptz, p_timezone text, p_zone_surge_bp integer, p_discount_paise bigint` | `jsonb` |
| `finance_summary` | `p_from timestamptz, p_to timestamptz, p_city_id uuid?` | `jsonb` |
| `flag_customer` | `p_customer_id uuid, p_suspicious boolean, p_reason text` | `void` |
| `forecast_demand` | `p_city_id uuid?, p_weeks integer?` | `jsonb` |
| `forecast_revenue` | `p_history_days integer?, p_forecast_days integer?` | `jsonb` |
| `fraud_signals` | — | `jsonb` |
| `generate_daily_report` | `p_date date?` | `jsonb` |
| `global_search` | `p_query text` | `jsonb` |
| `gst_report` | `p_month date, p_city_id uuid?` | `jsonb` |
| `has_permission` | `p_code text` | `boolean` |
| `haversine_km` | `lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric` | `numeric` |
| `import_rows` | `p_entity text, p_rows jsonb, p_file_name text?` | `jsonb` |
| `ingest_driver_location` | `p_lat numeric, p_lng numeric, p_recorded_at timestamptz, p_speed_kmh numeric?, p_heading numeric?, p_accuracy_m numeric?, p_battery_pct integer?, p_gps_status text?` | `jsonb` |
| `ingest_driver_locations_batch` | `p_points jsonb` | `jsonb` |
| `ip_allowed` | — | `boolean` |
| `is_direct_db` | — | `boolean` |
| `is_privileged` | — | `boolean` |
| `jwt_claims` | — | `jsonb` |
| `log_auth_event` | `p_event text` | `void` |
| `log_client_error` | `p_source text, p_level text, p_message text, p_context jsonb?` | `void` |
| `login_precheck` *(also before sign-in)* | `p_email text` | `jsonb` |
| `maintenance_predictions` | — | `jsonb` |
| `mark_notifications_read` | `p_ids uuid[]?` | `integer` |
| `mask_phone` | `p text` | `text` |
| `my_access` | — | `jsonb` |
| `next_code` | `p_prefix text, p_seq regclass` | `text` |
| `open_dispute` | `p_booking_id uuid, p_category text, p_description text` | `uuid` |
| `operational_alerts` | — | `jsonb` |
| `otp_dashboard` | `p_from timestamptz?, p_to timestamptz?` | `jsonb` |
| `otp_verify` | `p_booking_id uuid, p_otp text, p_confirmed_distance_km numeric` | `jsonb` |
| `point_in_polygon` | `p_lat numeric, p_lng numeric, p_polygon jsonb` | `boolean` |
| `process_deletion_request` | `p_customer_id uuid, p_approve boolean, p_reason text` | `void` |
| `raise_sos` | `p_booking_id uuid, p_lat numeric?, p_lng numeric?, p_description text?, p_incident_type text?` | `uuid` |
| `recent_activity` | `p_limit integer?` | `jsonb` |
| `record_cash_payment` | `p_booking_id uuid, p_reason text?` | `jsonb` |
| `record_login_failure` *(also before sign-in)* | `p_email text` | `void` |
| `request_account_deletion` | — | `void` |
| `request_header` | `p_name text` | `text` |
| `request_ip` | — | `text` |
| `request_refund` | `p_payment_id uuid, p_amount_paise bigint, p_reason text, p_idempotency_key text` | `jsonb` |
| `require_permission` | `p_code text` | `void` |
| `resolve_dispute` | `p_dispute_id uuid, p_outcome text, p_resolution text` | `void` |
| `resolve_distance_discrepancy` | `p_discrepancy_id uuid, p_action text, p_corrected_km numeric, p_reason text` | `jsonb` |
| `review_driver_document` | `p_document_id uuid, p_approve boolean, p_reason text?, p_notes text?` | `void` |
| `review_vehicle_document` | `p_document_id uuid, p_approve boolean, p_reason text?` | `void` |
| `revoke_api_key` | `p_id uuid` | `void` |
| `revoke_session` | `p_session_id uuid, p_reason text` | `void` |
| `send_notification` | `p_audience text, p_title text, p_body text, p_category text?, p_priority text?, p_channels text[]?, 'push'::text], p_recipient_id uuid?, p_city_id uuid?` | `uuid` |
| `set_customer_status` | `p_customer_id uuid, p_status text, p_reason text` | `void` |
| `set_driver_availability` | `p_online boolean` | `jsonb` |
| `set_driver_status` | `p_driver_id uuid, p_status text, p_reason text?, p_notes text?` | `void` |
| `set_role_permission` | `p_role_code text, p_permission text, p_grant boolean` | `void` |
| `set_vehicle_status` | `p_vehicle_id uuid, p_status text, p_reason text?` | `void` |
| `staff_attendance` | `p_action text` | `void` |
| `staff_city_ok` | `p_city_id uuid` | `boolean` |
| `system_health` | — | `jsonb` |
| `tracking_snapshot` | `p_city_id uuid?, p_search text?, p_include_offline boolean?` | `jsonb` |
| `update_payout` | `p_payout_id uuid, p_action text, p_reference text?, p_reason text?` | `jsonb` |
| `update_setting` | `p_key text, p_value jsonb, p_reason text?` | `void` |
| `update_staff` | `p_staff_id uuid, p_role_code text?, p_status text?, p_reason text?, p_city_scope uuid[]?, p_clear_city_scope boolean?, p_branch_id uuid?, p_mfa_required boolean?, p_session_timeout_min integer?, p_unlock boolean?` | `void` |
| `validate_coupon` | `p_code text, p_customer_id uuid, p_city_id uuid, p_category_id uuid, p_gross_paise bigint` | `jsonb` |
| `zone_at` | `p_city_id uuid, p_lat numeric, p_lng numeric, p_types text[]` | `uuid` |

## Server-only functions

Not callable from the website or apps (only by Edge Functions holding the service key, or from the SQL editor):

`apply_payment_webhook`, `bootstrap_super_admin`, `check_rate_limit`, `coupon_discount`, `create_staff_record`, `document_expiry_scan`, `find_pricing_rule`, `finish_refund`, `get_setting`, `invalidate_ride_otp`, `log_integration_event`, `notification_dispatch_result`, `notify_staff`, `otp_expire_sweep`, `otp_hash`, `otp_issue`, `otp_override`, `otp_random_digits`, `otp_record_delivery`, `otp_update_delivery_status`, `payment_attach_order`, `refund_gateway_result`, `report_integration_status`, `run_scheduled_jobs`, `scan_tracking_health`, `set_actor`, `setting_bool`, `setting_int`, `settle_booking_payment`, `staff_has_permission`, `wallet_post`, `write_audit`
