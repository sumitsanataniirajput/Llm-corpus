-- =====================================================================
-- 0012_seed_reference.sql — REFERENCE data only (roles, permission matrix,
-- vehicle categories, default settings, templates). No demo data, no
-- accounts, no passwords. Safe to re-run.
-- =====================================================================

insert into public.permissions (code, module, description, is_sensitive) values
  ('dashboard.view', 'dashboard', 'View the main dashboard', false),
  ('tracking.view', 'tracking', 'View live vehicle tracking and tracking alerts', false),
  ('tracking.history', 'tracking', 'View driver location history and route playback', true),
  ('drivers.view', 'drivers', 'View the driver directory and profiles', false),
  ('drivers.create', 'drivers', 'Register drivers, edit profiles and upload documents', false),
  ('drivers.documents', 'drivers', 'Open uploaded identity documents', true),
  ('drivers.verify', 'drivers', 'Approve or reject documents and driver applications', true),
  ('drivers.manage', 'drivers', 'Suspend or deactivate drivers', true),
  ('drivers.blacklist', 'drivers', 'Blacklist a driver or lift a blacklist', true),
  ('drivers.notes', 'drivers', 'Read and add internal notes and disciplinary records', false),
  ('drivers.incentives', 'drivers', 'Create incentives and bonuses', true),
  ('vehicles.view', 'vehicles', 'View vehicles and their documents', false),
  ('vehicles.edit', 'vehicles', 'Register and edit vehicles, maintenance and documents', false),
  ('vehicles.verify', 'vehicles', 'Approve or reject vehicle documents', true),
  ('vehicles.manage', 'vehicles', 'Activate, suspend or retire vehicles', true),
  ('vehicles.assign', 'vehicles', 'Assign vehicles to drivers', false),
  ('customers.view', 'customers', 'View the customer directory (contact details masked)', false),
  ('customers.view_pii', 'customers', 'See full customer phone numbers and e-mail addresses', true),
  ('customers.manage', 'customers', 'Create, edit, block, unblock and flag customers', true),
  ('customers.delete', 'customers', 'Process account deletion requests', true),
  ('customers.notes', 'customers', 'Read and add internal customer notes', false),
  ('rides.view', 'rides', 'View bookings and rides', false),
  ('rides.create', 'rides', 'Create bookings on behalf of customers', false),
  ('rides.assign', 'rides', 'Assign and reassign drivers', false),
  ('rides.cancel', 'rides', 'Cancel bookings', true),
  ('rides.manage', 'rides', 'Force-complete rides in exceptional cases', true),
  ('rides.disputes', 'rides', 'Open and resolve ride disputes', false),
  ('rides.export', 'rides', 'Export ride data', false),
  ('otp.view', 'otp', 'View the OTP verification centre (never the OTP itself)', false),
  ('otp.deliver', 'otp', 'Resend an OTP or retry SMS delivery', false),
  ('otp.generate', 'otp', 'Manually generate a new OTP for a ride', true),
  ('otp.override', 'otp', 'Exceptional manual override of OTP verification', true),
  ('otp.correct_distance', 'otp', 'Correct a booked or billable distance', true),
  ('otp.reports', 'otp', 'Export OTP verification reports', false),
  ('finance.view', 'finance', 'View revenue, payments, refunds and payouts', false),
  ('finance.record_payment', 'finance', 'Record cash payments', true),
  ('finance.refund', 'finance', 'Issue refunds', true),
  ('finance.payouts', 'finance', 'Create driver payouts', true),
  ('finance.payouts.approve', 'finance', 'Approve payouts, mark them paid and credit incentives', true),
  ('finance.wallet_adjust', 'finance', 'Manually adjust customer wallets', true),
  ('finance.expenses', 'finance', 'Record operating expenses', false),
  ('finance.export', 'finance', 'Export financial data', false),
  ('pricing.view', 'pricing', 'View pricing rules', false),
  ('pricing.manage', 'pricing', 'Create and change pricing rules', true),
  ('services.view', 'services', 'View vehicle categories and services', false),
  ('services.manage', 'services', 'Manage vehicle categories and availability', false),
  ('marketing.view', 'marketing', 'View coupons, campaigns and referrals', false),
  ('marketing.manage', 'marketing', 'Manage coupons, campaigns, referrals and announcements', false),
  ('notifications.view', 'notifications', 'View the notification outbox and delivery logs', false),
  ('notifications.send', 'notifications', 'Send notifications and broadcasts', false),
  ('notifications.emergency', 'notifications', 'Send emergency notifications', true),
  ('notifications.templates', 'notifications', 'Manage notification and SMS templates', false),
  ('support.view', 'support', 'View tickets and complaints', false),
  ('support.manage', 'support', 'Create, assign and resolve tickets', false),
  ('safety.view', 'safety', 'View safety incidents and SOS alerts', false),
  ('safety.manage', 'safety', 'Handle safety incidents and raise SOS', true),
  ('staff.view', 'staff', 'View staff accounts and activity', false),
  ('staff.manage', 'staff', 'Create, suspend and modify staff accounts', true),
  ('staff.roles', 'staff', 'Edit role permissions', true),
  ('locations.view', 'locations', 'View cities, zones and demand maps', false),
  ('locations.manage', 'locations', 'Manage cities and zones', false),
  ('analytics.view', 'analytics', 'View reports and analytics', false),
  ('analytics.export', 'analytics', 'Export reports and generate daily reports', false),
  ('security.view', 'security', 'View sessions, login history, health and error logs', true),
  ('security.manage', 'security', 'Manage IP rules, API keys, retention and sessions', true),
  ('audit.view', 'security', 'View the audit log', true),
  ('ai.view', 'ai', 'Use forecasts, signals and the AI assistant', false),
  ('settings.view', 'settings', 'View settings and integration status', false),
  ('settings.manage', 'settings', 'Change global settings, branding and branches', true),
  ('settings.import', 'settings', 'Bulk import data', true),
  ('integrations.manage', 'settings', 'Enable or disable integrations', true)
on conflict (code) do update set module = excluded.module, description = excluded.description, is_sensitive = excluded.is_sensitive;

insert into public.roles (code, name, description, is_system, rank) values
  ('super_admin', 'Super Admin', 'Owner. Holds every permission, always.', true, 0),
  ('administrator', 'Administrator', 'Full administration except the exceptional OTP override.', true, 10),
  ('operations_manager', 'Operations Manager', 'Runs daily operations, including exceptional OTP override.', true, 20),
  ('regional_manager', 'Regional Manager', 'Operations for the cities in their scope.', true, 30),
  ('city_manager', 'City Manager', 'Operations for a single city.', true, 40),
  ('finance_manager', 'Finance Manager', 'Payments, refunds, payouts and financial reporting.', true, 40),
  ('safety_officer', 'Safety Officer', 'Emergencies, incidents and investigations.', true, 50),
  ('driver_verification_officer', 'Driver Verification Officer', 'Reviews driver and vehicle documents.', true, 50),
  ('customer_support_agent', 'Customer Support Agent', 'Tickets, complaints and disputes.', true, 60),
  ('readonly_analyst', 'Read-only Analyst', 'Read-only reporting. Customer contact details are masked.', true, 70)
on conflict (code) do update set name = excluded.name, description = excluded.description, rank = excluded.rank;

-- Default permission matrix. Only applied to roles that have no permissions yet,
-- so changes made later in the console are never overwritten.
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r, unnest(array['dashboard.view', 'tracking.view', 'tracking.history', 'drivers.view', 'drivers.create', 'drivers.documents', 'drivers.verify', 'drivers.manage', 'drivers.blacklist', 'drivers.notes', 'drivers.incentives', 'vehicles.view', 'vehicles.edit', 'vehicles.verify', 'vehicles.manage', 'vehicles.assign', 'customers.view', 'customers.view_pii', 'customers.manage', 'customers.delete', 'customers.notes', 'rides.view', 'rides.create', 'rides.assign', 'rides.cancel', 'rides.manage', 'rides.disputes', 'rides.export', 'otp.view', 'otp.deliver', 'otp.generate', 'otp.correct_distance', 'otp.reports', 'finance.view', 'finance.record_payment', 'finance.refund', 'finance.payouts', 'finance.payouts.approve', 'finance.wallet_adjust', 'finance.expenses', 'finance.export', 'pricing.view', 'pricing.manage', 'services.view', 'services.manage', 'marketing.view', 'marketing.manage', 'notifications.view', 'notifications.send', 'notifications.emergency', 'notifications.templates', 'support.view', 'support.manage', 'safety.view', 'safety.manage', 'staff.view', 'staff.manage', 'staff.roles', 'locations.view', 'locations.manage', 'analytics.view', 'analytics.export', 'security.view', 'security.manage', 'audit.view', 'ai.view', 'settings.view', 'settings.manage', 'settings.import', 'integrations.manage']) as p(code)
where r.code = 'administrator' and not exists (select 1 from public.role_permissions x where x.role_id = r.id)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r, unnest(array['ai.view', 'analytics.export', 'analytics.view', 'customers.manage', 'customers.notes', 'customers.view', 'customers.view_pii', 'dashboard.view', 'drivers.blacklist', 'drivers.create', 'drivers.documents', 'drivers.incentives', 'drivers.manage', 'drivers.notes', 'drivers.verify', 'drivers.view', 'locations.view', 'marketing.view', 'notifications.emergency', 'notifications.send', 'notifications.view', 'otp.correct_distance', 'otp.deliver', 'otp.generate', 'otp.override', 'otp.reports', 'otp.view', 'pricing.view', 'rides.assign', 'rides.cancel', 'rides.create', 'rides.disputes', 'rides.export', 'rides.manage', 'rides.view', 'safety.manage', 'safety.view', 'services.view', 'settings.view', 'staff.view', 'support.manage', 'support.view', 'tracking.history', 'tracking.view', 'vehicles.assign', 'vehicles.edit', 'vehicles.manage', 'vehicles.verify', 'vehicles.view']) as p(code)
where r.code = 'operations_manager' and not exists (select 1 from public.role_permissions x where x.role_id = r.id)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r, unnest(array['ai.view', 'analytics.export', 'analytics.view', 'customers.notes', 'customers.view', 'dashboard.view', 'drivers.create', 'drivers.manage', 'drivers.notes', 'drivers.view', 'locations.view', 'notifications.send', 'notifications.view', 'otp.correct_distance', 'otp.deliver', 'otp.view', 'pricing.view', 'rides.assign', 'rides.cancel', 'rides.create', 'rides.disputes', 'rides.export', 'rides.manage', 'rides.view', 'safety.view', 'services.view', 'support.manage', 'support.view', 'tracking.history', 'tracking.view', 'vehicles.assign', 'vehicles.edit', 'vehicles.manage', 'vehicles.view']) as p(code)
where r.code = 'regional_manager' and not exists (select 1 from public.role_permissions x where x.role_id = r.id)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r, unnest(array['analytics.view', 'customers.notes', 'customers.view', 'dashboard.view', 'drivers.create', 'drivers.manage', 'drivers.notes', 'drivers.view', 'locations.view', 'notifications.send', 'notifications.view', 'otp.deliver', 'otp.view', 'rides.assign', 'rides.cancel', 'rides.create', 'rides.disputes', 'rides.view', 'safety.view', 'services.view', 'support.manage', 'support.view', 'tracking.history', 'tracking.view', 'vehicles.assign', 'vehicles.edit', 'vehicles.view']) as p(code)
where r.code = 'city_manager' and not exists (select 1 from public.role_permissions x where x.role_id = r.id)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r, unnest(array['ai.view', 'analytics.export', 'analytics.view', 'customers.view', 'dashboard.view', 'drivers.incentives', 'drivers.view', 'finance.expenses', 'finance.export', 'finance.payouts', 'finance.payouts.approve', 'finance.record_payment', 'finance.refund', 'finance.view', 'finance.wallet_adjust', 'marketing.view', 'pricing.view', 'rides.export', 'rides.view']) as p(code)
where r.code = 'finance_manager' and not exists (select 1 from public.role_permissions x where x.role_id = r.id)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r, unnest(array['customers.view', 'customers.view_pii', 'dashboard.view', 'drivers.notes', 'drivers.view', 'notifications.emergency', 'notifications.send', 'notifications.view', 'rides.view', 'safety.manage', 'safety.view', 'support.manage', 'support.view', 'tracking.history', 'tracking.view', 'vehicles.view']) as p(code)
where r.code = 'safety_officer' and not exists (select 1 from public.role_permissions x where x.role_id = r.id)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r, unnest(array['dashboard.view', 'drivers.create', 'drivers.documents', 'drivers.notes', 'drivers.verify', 'drivers.view', 'vehicles.edit', 'vehicles.verify', 'vehicles.view']) as p(code)
where r.code = 'driver_verification_officer' and not exists (select 1 from public.role_permissions x where x.role_id = r.id)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r, unnest(array['customers.notes', 'customers.view', 'dashboard.view', 'drivers.view', 'notifications.view', 'otp.view', 'rides.disputes', 'rides.view', 'support.manage', 'support.view']) as p(code)
where r.code = 'customer_support_agent' and not exists (select 1 from public.role_permissions x where x.role_id = r.id)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r, unnest(array['ai.view', 'analytics.view', 'customers.view', 'dashboard.view', 'drivers.view', 'finance.view', 'locations.view', 'marketing.view', 'pricing.view', 'rides.view', 'services.view', 'vehicles.view']) as p(code)
where r.code = 'readonly_analyst' and not exists (select 1 from public.role_permissions x where x.role_id = r.id)
on conflict do nothing;

insert into public.vehicle_categories (code, name, description, capacity, icon, sort_order) values
  ('bike', 'Bike', 'Bike taxi for one rider', 1, 'fa-motorcycle', 10),
  ('auto', 'Auto', 'Auto rickshaw', 3, 'fa-van-shuttle', 20),
  ('mini', 'Mini', 'Compact hatchback', 4, 'fa-car-side', 30),
  ('sedan', 'Sedan', 'Comfortable sedan', 4, 'fa-car', 40),
  ('suv', 'SUV', 'Spacious SUV', 6, 'fa-truck-pickup', 50),
  ('premium', 'Premium', 'Premium vehicles', 4, 'fa-gem', 60)
on conflict (code) do nothing;

insert into public.system_settings (key, value, category, description, is_public) values
  ('brand.app_name', '"Ride Manager"', 'branding', 'Application name shown in the console and apps', true),
  ('brand.logo_url', '""', 'branding', 'Public URL of the logo (upload to the branding bucket)', true),
  ('brand.primary_color', '"#2563eb"', 'branding', 'Primary brand colour', true),
  ('brand.support_phone', '""', 'branding', 'Support phone number shown to users', true),
  ('system.maintenance_mode', 'false', 'system', 'When on, the Driver and Customer apps show a maintenance notice', true),
  ('system.maintenance_message', '"We are upgrading the service. Please try again shortly."', 'system', 'Maintenance notice text', true),
  ('system.global_announcement', '""', 'system', 'Banner text shown at the top of the console (empty = none)', true),
  ('otp.length', '6', 'otp', 'Number of digits in the ride OTP (4-8)', false),
  ('otp.expiry_seconds', '300', 'otp', 'OTP validity in seconds', false),
  ('otp.max_attempts', '5', 'otp', 'Incorrect attempts allowed before lockout', false),
  ('otp.lockout_minutes', '15', 'otp', 'Lockout duration after too many incorrect attempts', false),
  ('otp.max_resends', '3', 'otp', 'Maximum OTP resends per ride', false),
  ('otp.resend_gap_seconds', '30', 'otp', 'Minimum gap between OTP resends', false),
  ('otp.distance_tolerance_km', '0.05', 'otp', 'Allowed difference when the driver confirms the booked distance', false),
  ('otp.block_on_distance_mismatch', 'true', 'otp', 'Block OTP verification when the confirmed distance does not match', false),
  ('otp.max_overrides_per_staff_per_day', '5', 'otp', 'Daily cap on manager OTP overrides per staff member', false),
  ('rides.road_distance_factor', '1.3', 'rides', 'Multiplier applied to straight-line distance when Google Routes is unavailable', false),
  ('rides.max_distance_km', '300', 'rides', 'Longest bookable trip', false),
  ('rides.billing_distance_policy', '"actual"', 'rides', 'Distance billed at completion: actual, booked or max', false),
  ('rides.distance_discrepancy_pct', '20', 'rides', 'Raise a discrepancy when travelled and booked distance differ by more than this percentage', false),
  ('tracking.live_seconds', '45', 'tracking', 'A position newer than this is shown as live', false),
  ('tracking.stale_seconds', '180', 'tracking', 'A position older than this is shown as stale', false),
  ('tracking.interval_on_ride_seconds', '5', 'tracking', 'Requested GPS interval during a ride', false),
  ('tracking.interval_idle_seconds', '15', 'tracking', 'Requested GPS interval while online without a ride', false),
  ('tracking.overspeed_kmh', '90', 'tracking', 'Speed that raises an overspeed alert', false),
  ('security.max_failed_logins', '5', 'security', 'Failed console logins before the account is locked', false),
  ('security.lockout_minutes', '15', 'security', 'Console lockout duration', false),
  ('finance.allow_self_approval', 'false', 'finance', 'Allow the same person to create and approve a payout', false),
  ('fraud.customer_cancellations_7d', '5', 'fraud', 'Customer cancellations in 7 days that flag the account', false),
  ('fraud.customer_failed_payments_7d', '3', 'fraud', 'Failed payments in 7 days that flag the account', false),
  ('fraud.driver_cash_dues_alert_paise', '500000', 'fraud', 'Cash commission owed by a driver that raises a signal (paise)', false),
  ('drivers.required_documents', '["aadhaar","pan","driving_licence","photo"]', 'drivers', 'Documents that must be approved before a driver can be approved', false),
  ('feature.ai_assistant', 'false', 'feature', 'Enable the optional AI assistant (needs an AI provider key)', true),
  ('feature.auto_assignment', 'false', 'feature', 'Allow one-click automatic driver allocation', true),
  ('feature.wallet_payments', 'false', 'feature', 'Allow customer wallet payments', true),
  ('feature.scheduled_rides', 'true', 'feature', 'Allow rides to be booked for later', true),
  ('privacy.policy_version', '"1.0"', 'privacy', 'Current privacy policy / consent version', true)
on conflict (key) do nothing;

insert into public.notification_templates (code, channel, title, body, dlt_template_id) values
  ('ride_otp', 'sms', null, 'Your {{app}} ride OTP is {{otp}}. Share it with your driver only after you board. Valid for {{minutes}} minutes.', null),
  ('driver_approved', 'push', 'Account approved', 'Your driver account has been approved. You can now go online.', null),
  ('document_expiring', 'push', 'Document expiring soon', 'Your {{document}} expires in {{days}} day(s). Please upload a renewed copy.', null),
  ('payment_received', 'push', 'Payment received', 'We received your payment of {{amount}} for ride {{booking}}.', null),
  ('emergency_broadcast', 'push', 'Emergency alert', '{{message}}', null)
on conflict (code, channel) do nothing;

insert into public.data_retention_policies (entity, retain_days) values
  ('driver_location_history', 90), ('error_logs', 90), ('integration_events', 90), ('rate_limits', 2),
  ('admin_activity_logs', 365), ('notification_delivery_logs', 180), ('otp_delivery_logs', 180), ('audit_logs', 2555)
on conflict (entity) do nothing;

-- Integration registry. Status is "not_configured" until credentials are set
-- as Edge Function secrets and the integration-status function confirms them.
insert into public.integration_settings (kind, provider, public_config) values
  ('sms', 'msg91', '{"note":"OTP SMS. Needs DLT-approved template."}'),
  ('payment', 'razorpay', '{"note":"UPI, cards, net banking, wallets."}'),
  ('maps', 'google_maps', '{"note":"Maps JavaScript, Places, Routes, Geocoding."}'),
  ('push', 'fcm', '{"note":"Firebase Cloud Messaging HTTP v1."}'),
  ('email', 'resend', '{"note":"Transactional e-mail."}'),
  ('whatsapp', 'whatsapp_cloud', '{"note":"WhatsApp Cloud API. Needs approved templates."}'),
  ('ai', 'openai_compatible', '{"note":"Optional assistant. Any OpenAI-compatible endpoint."}'),
  ('cache', 'upstash_redis', '{"note":"Optional. Only needed for very high GPS volume."}')
on conflict (kind, provider) do nothing;
