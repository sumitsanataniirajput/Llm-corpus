-- =====================================================================
-- 0009_admin_functions.sql — verification, fleet, customers, staff,
-- settings, notifications, scheduled jobs, system management
-- =====================================================================

-- ---------------------------------------------------------------------
-- Driver verification (manual review is the operating model)
-- ---------------------------------------------------------------------
create or replace function public.review_driver_document(p_document_id uuid, p_approve boolean, p_reason text default null, p_notes text default null) returns void
language plpgsql security definer set search_path = public as $$
declare doc driver_documents; v_staff uuid := public.current_staff_id();
begin
  perform public.require_permission('drivers.verify');
  select * into doc from driver_documents where id = p_document_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND'; end if;
  if not p_approve and coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'REASON_REQUIRED: a rejection reason is mandatory'; end if;
  if p_approve and doc.expiry_date is not null and doc.expiry_date < current_date then raise exception 'DOCUMENT_EXPIRED: an expired document cannot be approved'; end if;
  update driver_documents set status = case when p_approve then 'approved' else 'rejected' end,
    rejection_reason = case when p_approve then null else trim(p_reason) end, notes = coalesce(p_notes, notes),
    reviewed_by = v_staff, reviewed_at = now(), updated_at = now() where id = p_document_id;
  insert into driver_verifications(driver_id, document_id, action, from_status, to_status, reason, notes, staff_id)
  values (doc.driver_id, doc.id, 'document_' || doc.doc_type || case when p_approve then '_approved' else '_rejected' end,
          doc.status, case when p_approve then 'approved' else 'rejected' end, p_reason, p_notes, v_staff);
  update drivers set status = 'under_review' where id = doc.driver_id and status = 'pending';
  insert into notifications(audience, recipient_driver_id, category, priority, title, body, data, channels)
  values ('driver', doc.driver_id, 'approval', 'normal',
    case when p_approve then 'Document approved' else 'Document rejected' end,
    replace(doc.doc_type, '_', ' ') || case when p_approve then ' was approved.' else ' was rejected: ' || trim(p_reason) end,
    jsonb_build_object('document_id', doc.id), array['in_app','push']);
end $$;

create or replace function public.set_driver_status(p_driver_id uuid, p_status text, p_reason text default null, p_notes text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d drivers; v_staff uuid := public.current_staff_id(); v_missing text; v_required text[];
begin
  if p_status in ('approved','rejected','under_review') then perform public.require_permission('drivers.verify');
  elsif p_status = 'blacklisted' then perform public.require_permission('drivers.blacklist');
  elsif p_status in ('suspended','deactivated') then perform public.require_permission('drivers.manage');
  else raise exception 'INVALID_STATUS'; end if;
  select * into d from drivers where id = p_driver_id for update;
  if not found then raise exception 'DRIVER_NOT_FOUND'; end if;
  if not public.staff_city_ok(d.city_id) then raise exception 'PERMISSION_DENIED: city scope' using errcode = '42501'; end if;
  if d.status = p_status then raise exception 'NO_CHANGE: driver is already %', p_status; end if;
  if d.status = 'blacklisted' and not public.has_permission('drivers.blacklist') then raise exception 'PERMISSION_DENIED: drivers.blacklist' using errcode = '42501'; end if;
  if p_status <> 'approved' and p_status <> 'under_review' and coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'REASON_REQUIRED: a reason is mandatory for %', p_status;
  end if;
  if p_status = 'approved' then
    select array_agg(x) into v_required from jsonb_array_elements_text(
      public.get_setting('drivers.required_documents', '["aadhaar","pan","driving_licence","photo"]'::jsonb)) x;
    select string_agg(t, ', ') into v_missing from unnest(v_required) t
    where not exists (select 1 from driver_documents dd where dd.driver_id = p_driver_id and dd.doc_type = t and dd.status = 'approved'
                        and (dd.expiry_date is null or dd.expiry_date >= current_date));
    if v_missing is not null then raise exception 'DOCUMENTS_INCOMPLETE: approved, unexpired documents are still required for: %', v_missing; end if;
  end if;
  if d.availability = 'on_ride' and p_status <> 'approved' then
    raise exception 'RIDE_IN_PROGRESS: reassign or finish the current ride before changing this driver''s status';
  end if;
  update drivers set status = p_status, status_reason = case when p_status = 'approved' then null else trim(p_reason) end,
    availability = case when p_status = 'approved' then availability else 'offline' end,
    approved_at = case when p_status = 'approved' then now() else approved_at end,
    approved_by = case when p_status = 'approved' then v_staff else approved_by end
  where id = p_driver_id;
  insert into driver_verifications(driver_id, action, from_status, to_status, reason, notes, staff_id)
  values (p_driver_id, 'status_change', d.status, p_status, p_reason, p_notes, v_staff);
  insert into notifications(audience, recipient_driver_id, category, priority, title, body, data, channels)
  values ('driver', p_driver_id, 'approval', 'high', 'Account ' || replace(p_status, '_', ' '),
    case when p_status = 'approved' then 'Your driver account has been approved. You can now go online.'
         else 'Your account status is now ' || replace(p_status, '_', ' ') || coalesce(': ' || trim(p_reason), '.') end,
    '{}'::jsonb, array['in_app','push']);
end $$;

-- ---------------------------------------------------------------------
-- Vehicles
-- ---------------------------------------------------------------------
create or replace function public.review_vehicle_document(p_document_id uuid, p_approve boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare doc vehicle_documents;
begin
  perform public.require_permission('vehicles.verify');
  select * into doc from vehicle_documents where id = p_document_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND'; end if;
  if not p_approve and coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'REASON_REQUIRED: a rejection reason is mandatory'; end if;
  if p_approve and doc.expiry_date is not null and doc.expiry_date < current_date then raise exception 'DOCUMENT_EXPIRED: an expired document cannot be approved'; end if;
  update vehicle_documents set status = case when p_approve then 'approved' else 'rejected' end,
    rejection_reason = case when p_approve then null else trim(p_reason) end, reviewed_by = public.current_staff_id(), reviewed_at = now(), updated_at = now()
  where id = p_document_id;
  perform public.write_audit('vehicle_document.' || case when p_approve then 'approve' else 'reject' end, 'vehicles', doc.vehicle_id::text,
    jsonb_build_object('status', doc.status), jsonb_build_object('doc_type', doc.doc_type, 'document_id', doc.id), p_reason);
end $$;

create or replace function public.set_vehicle_status(p_vehicle_id uuid, p_status text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v vehicles; v_missing text;
begin
  perform public.require_permission('vehicles.manage');
  if p_status not in ('active','maintenance','suspended','retired') then raise exception 'INVALID_STATUS'; end if;
  select * into v from vehicles where id = p_vehicle_id for update;
  if not found then raise exception 'VEHICLE_NOT_FOUND'; end if;
  if v.status = p_status then raise exception 'NO_CHANGE: vehicle is already %', p_status; end if;
  if p_status <> 'active' and coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'REASON_REQUIRED'; end if;
  if p_status = 'active' then
    select string_agg(t, ', ') into v_missing from unnest(array['rc','insurance']) t
    where not exists (select 1 from vehicle_documents vd where vd.vehicle_id = p_vehicle_id and vd.doc_type = t and vd.status = 'approved'
                        and (vd.expiry_date is null or vd.expiry_date >= current_date));
    if v_missing is not null then raise exception 'DOCUMENTS_INCOMPLETE: approved, unexpired documents are required for: %', v_missing; end if;
  elsif exists (select 1 from bookings where vehicle_id = p_vehicle_id and status in
      ('DRIVER_ASSIGNED','DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING','OTP_VERIFIED','RIDE_STARTED')) then
    raise exception 'RIDE_IN_PROGRESS: this vehicle is on an active ride';
  end if;
  update vehicles set status = p_status, status_reason = case when p_status = 'active' then null else trim(p_reason) end where id = p_vehicle_id;
end $$;

create or replace function public.assign_vehicle(p_vehicle_id uuid, p_driver_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v vehicles; d drivers; v_staff uuid := public.current_staff_id();
begin
  perform public.require_permission('vehicles.assign');
  select * into v from vehicles where id = p_vehicle_id for update;
  if not found then raise exception 'VEHICLE_NOT_FOUND'; end if;
  if v.status in ('retired','suspended') then raise exception 'VEHICLE_NOT_ASSIGNABLE: vehicle is %', v.status; end if;
  if exists (select 1 from bookings where (vehicle_id = p_vehicle_id or (p_driver_id is not null and driver_id = p_driver_id)) and status in
      ('DRIVER_ASSIGNED','DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING','OTP_VERIFIED','RIDE_STARTED')) then
    raise exception 'RIDE_IN_PROGRESS: the vehicle or driver is on an active ride';
  end if;
  update vehicle_assignments set is_active = false, unassigned_at = now(), unassigned_reason = coalesce(p_reason, 'reassigned')
  where is_active and (vehicle_id = p_vehicle_id or (p_driver_id is not null and driver_id = p_driver_id));
  if p_driver_id is not null then
    select * into d from drivers where id = p_driver_id;
    if not found then raise exception 'DRIVER_NOT_FOUND'; end if;
    if d.status in ('rejected','blacklisted','deactivated') then raise exception 'DRIVER_NOT_ELIGIBLE: driver is %', d.status; end if;
    insert into vehicle_assignments(vehicle_id, driver_id, assigned_by) values (p_vehicle_id, p_driver_id, v_staff);
  end if;
  perform public.write_audit(case when p_driver_id is null then 'vehicle.unassign' else 'vehicle.assign' end, 'vehicles', p_vehicle_id::text,
    null, jsonb_build_object('driver_id', p_driver_id), p_reason);
end $$;

-- ---------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------
-- Masked directory. Phone / email are only shown in full to staff holding
-- customers.view_pii. The base table itself requires that permission.
create or replace view public.customer_directory as
select c.id, c.customer_code, c.full_name, c.city_id, c.status, c.status_reason, c.is_suspicious, c.suspicious_reason,
       c.loyalty_tier, c.loyalty_points, c.rating_avg, c.rating_count, c.phone_verified, c.email_verified,
       c.deletion_requested_at, c.created_at,
       case when public.has_permission('customers.view_pii') then c.phone else public.mask_phone(c.phone) end as phone,
       case when public.has_permission('customers.view_pii') then c.email
            when c.email is null then null else left(c.email, 2) || '***@' || split_part(c.email, '@', 2) end as email,
       coalesce(w.balance_paise, 0) as wallet_balance_paise,
       (select count(*) from public.bookings b where b.customer_id = c.id) as total_bookings,
       (select coalesce(sum(b.total_fare_paise), 0) from public.bookings b where b.customer_id = c.id and b.payment_status = 'paid') as total_spent_paise
from public.customers c
left join public.customer_wallets w on w.customer_id = c.id
where public.has_permission('customers.view') and public.staff_city_ok(c.city_id);

create or replace function public.set_customer_status(p_customer_id uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare c customers;
begin
  perform public.require_permission('customers.manage');
  if p_status not in ('active','blocked') then raise exception 'INVALID_STATUS'; end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'REASON_REQUIRED'; end if;
  select * into c from customers where id = p_customer_id for update;
  if not found then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  if c.status = 'deleted' then raise exception 'CUSTOMER_DELETED'; end if;
  update customers set status = p_status, status_reason = trim(p_reason) where id = p_customer_id;
end $$;

create or replace function public.flag_customer(p_customer_id uuid, p_suspicious boolean, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_permission('customers.manage');
  if coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'REASON_REQUIRED'; end if;
  update customers set is_suspicious = p_suspicious, suspicious_reason = case when p_suspicious then trim(p_reason) else null end where id = p_customer_id;
  if not found then raise exception 'CUSTOMER_NOT_FOUND'; end if;
end $$;

-- Customer asks for deletion from the Customer App.
create or replace function public.request_account_deletion() returns void
language plpgsql security definer set search_path = public as $$
declare v_id uuid := public.current_customer_id();
begin
  if v_id is null then raise exception 'NOT_A_CUSTOMER' using errcode = '42501'; end if;
  update customers set status = 'deletion_requested', deletion_requested_at = now() where id = v_id and status = 'active';
  perform public.notify_staff('customers.delete', 'system', 'normal', 'Account deletion requested', 'A customer asked for their account to be deleted.', jsonb_build_object('customer_id', v_id));
end $$;

-- Approve: personal data is anonymised; ride and payment records are kept
-- because tax law requires them.  Reject: account returns to active.
create or replace function public.process_deletion_request(p_customer_id uuid, p_approve boolean, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare c customers;
begin
  perform public.require_permission('customers.delete');
  if coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'REASON_REQUIRED'; end if;
  select * into c from customers where id = p_customer_id for update;
  if not found then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  if c.status <> 'deletion_requested' then raise exception 'NO_PENDING_REQUEST'; end if;
  if p_approve then
    if exists (select 1 from bookings where customer_id = p_customer_id and status not in ('PAYMENT_COMPLETED','CANCELLED')) then
      raise exception 'OPEN_BOOKINGS: the customer still has unfinished or unpaid rides';
    end if;
    update customers set status = 'deleted', deleted_at = now(), full_name = 'Deleted customer', phone = 'deleted-' || id::text,
      email = null, user_id = null, referral_code = null, status_reason = trim(p_reason) where id = p_customer_id;
    delete from customer_addresses where customer_id = p_customer_id;
    delete from customer_notes where customer_id = p_customer_id;
    delete from device_tokens where user_id = c.user_id;
  else
    update customers set status = 'active', deletion_requested_at = null, status_reason = trim(p_reason) where id = p_customer_id;
  end if;
  perform public.write_audit('customer.deletion_' || case when p_approve then 'approved' else 'rejected' end, 'customers', p_customer_id::text, null, null, p_reason);
end $$;

-- Rule-based suspicious account detection (deterministic).
create or replace function public.detect_suspicious_customers() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; v_count integer := 0;
begin
  if not (public.is_privileged() or public.has_permission('customers.manage')) then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  for r in
    select c.id,
      (select count(*) from bookings b where b.customer_id = c.id and b.status = 'CANCELLED' and b.cancelled_by = 'customer' and b.cancelled_at > now() - interval '7 days') as cancels,
      (select count(*) from payments p where p.customer_id = c.id and p.status = 'failed' and p.created_at > now() - interval '7 days') as failed
    from customers c where c.status = 'active' and not c.is_suspicious
  loop
    if r.cancels >= public.setting_int('fraud.customer_cancellations_7d', 5) or r.failed >= public.setting_int('fraud.customer_failed_payments_7d', 3) then
      update customers set is_suspicious = true,
        suspicious_reason = 'Automatic rule: ' || r.cancels || ' customer cancellations and ' || r.failed || ' failed payments in 7 days'
      where id = r.id;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- Staff administration
-- ---------------------------------------------------------------------
-- Called by the "staff-admin" Edge Function after it created the auth user.
create or replace function public.create_staff_record(
  p_actor_staff_id uuid, p_user_id uuid, p_full_name text, p_email text, p_phone text, p_role_code text,
  p_city_scope uuid[] default null, p_branch_id uuid default null, p_mfa_required boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_role roles; v_actor_rank integer; v_id uuid;
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED: service role only' using errcode = '42501'; end if;
  if not public.staff_has_permission(p_actor_staff_id, 'staff.manage') then raise exception 'PERMISSION_DENIED: staff.manage' using errcode = '42501'; end if;
  select * into v_role from roles where code = p_role_code;
  if not found then raise exception 'ROLE_NOT_FOUND'; end if;
  select r.rank into v_actor_rank from staff_accounts s join roles r on r.id = s.role_id where s.id = p_actor_staff_id;
  -- Nobody can create an account more powerful than their own.
  if v_role.rank < v_actor_rank then raise exception 'ROLE_ABOVE_YOUR_LEVEL: you cannot create a % account', v_role.name using errcode = '42501'; end if;
  insert into profiles(id, user_type, full_name, phone) values (p_user_id, 'staff', p_full_name, p_phone)
  on conflict (id) do update set user_type = 'staff', full_name = excluded.full_name, phone = excluded.phone;
  insert into staff_accounts(user_id, full_name, email, phone, role_id, city_scope, branch_id, created_by)
  values (p_user_id, trim(p_full_name), lower(trim(p_email)), p_phone, v_role.id, p_city_scope, p_branch_id, p_actor_staff_id)
  returning id into v_id;
  insert into admin_users(staff_id, mfa_required) values (v_id, coalesce(p_mfa_required, false));
  perform public.write_audit('staff.create', 'staff_accounts', v_id::text, null, jsonb_build_object('email', p_email, 'role', p_role_code), null, p_actor_staff_id);
  return v_id;
end $$;

create or replace function public.update_staff(
  p_staff_id uuid, p_role_code text default null, p_status text default null, p_reason text default null,
  p_city_scope uuid[] default null, p_clear_city_scope boolean default false, p_branch_id uuid default null,
  p_mfa_required boolean default null, p_session_timeout_min integer default null, p_unlock boolean default false
) returns void
language plpgsql security definer set search_path = public as $$
declare s staff_accounts; v_me uuid := public.current_staff_id(); v_my_rank integer; v_target_rank integer; v_new_role roles; v_super uuid;
begin
  perform public.require_permission('staff.manage');
  select * into s from staff_accounts where id = p_staff_id for update;
  if not found then raise exception 'STAFF_NOT_FOUND'; end if;
  select r.rank into v_my_rank from staff_accounts x join roles r on r.id = x.role_id where x.id = v_me;
  select r.rank into v_target_rank from roles r where r.id = s.role_id;
  select id into v_super from roles where code = 'super_admin';
  if p_staff_id = v_me and (p_role_code is not null or p_status is not null) then raise exception 'SELF_CHANGE_FORBIDDEN: you cannot change your own role or status'; end if;
  if v_target_rank < v_my_rank then raise exception 'ROLE_ABOVE_YOUR_LEVEL: you cannot modify this account' using errcode = '42501'; end if;
  if p_role_code is not null then
    select * into v_new_role from roles where code = p_role_code;
    if not found then raise exception 'ROLE_NOT_FOUND'; end if;
    if v_new_role.rank < v_my_rank then raise exception 'ROLE_ABOVE_YOUR_LEVEL' using errcode = '42501'; end if;
    if s.role_id = v_super and v_new_role.id <> v_super and (select count(*) from staff_accounts where role_id = v_super and status = 'active') <= 1 then
      raise exception 'LAST_SUPER_ADMIN: at least one active Super Admin must remain';
    end if;
    update staff_accounts set role_id = v_new_role.id where id = p_staff_id;
  end if;
  if p_status is not null then
    if p_status not in ('active','suspended','deactivated') then raise exception 'INVALID_STATUS'; end if;
    if p_status <> 'active' and coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'REASON_REQUIRED'; end if;
    if p_status <> 'active' and s.role_id = v_super and (select count(*) from staff_accounts where role_id = v_super and status = 'active') <= 1 then
      raise exception 'LAST_SUPER_ADMIN: at least one active Super Admin must remain';
    end if;
    update staff_accounts set status = p_status, suspended_reason = case when p_status = 'active' then null else trim(p_reason) end where id = p_staff_id;
    if p_status <> 'active' then
      update admin_sessions set revoked_at = now(), revoked_by = v_me, revoked_reason = 'account ' || p_status where staff_id = p_staff_id and revoked_at is null;
    end if;
  end if;
  if p_clear_city_scope then update staff_accounts set city_scope = null where id = p_staff_id;
  elsif p_city_scope is not null then update staff_accounts set city_scope = p_city_scope where id = p_staff_id; end if;
  if p_branch_id is not null then update staff_accounts set branch_id = p_branch_id where id = p_staff_id; end if;
  insert into admin_users(staff_id) values (p_staff_id) on conflict do nothing;
  update admin_users set mfa_required = coalesce(p_mfa_required, mfa_required),
    session_timeout_min = coalesce(p_session_timeout_min, session_timeout_min),
    locked_until = case when p_unlock then null else locked_until end,
    failed_login_count = case when p_unlock then 0 else failed_login_count end, updated_at = now()
  where staff_id = p_staff_id;
end $$;

create or replace function public.set_role_permission(p_role_code text, p_permission text, p_grant boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_role roles; v_my_rank integer; v_perm permissions;
begin
  perform public.require_permission('staff.roles');
  select * into v_role from roles where code = p_role_code;
  if not found then raise exception 'ROLE_NOT_FOUND'; end if;
  if v_role.code = 'super_admin' then raise exception 'SUPER_ADMIN_FIXED: the Super Admin role always holds every permission'; end if;
  select r.rank into v_my_rank from staff_accounts s join roles r on r.id = s.role_id where s.id = public.current_staff_id();
  if v_role.rank <= v_my_rank then raise exception 'ROLE_ABOVE_YOUR_LEVEL: you can only edit roles below your own' using errcode = '42501'; end if;
  select * into v_perm from permissions where code = p_permission;
  if not found then raise exception 'PERMISSION_NOT_FOUND'; end if;
  if p_grant then
    insert into role_permissions(role_id, permission_code, granted_by) values (v_role.id, p_permission, public.current_staff_id()) on conflict do nothing;
  else
    delete from role_permissions where role_id = v_role.id and permission_code = p_permission;
  end if;
end $$;

create or replace function public.staff_attendance(p_action text) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := public.current_staff_id(); v_last text;
begin
  if v_me is null then raise exception 'NOT_STAFF' using errcode = '42501'; end if;
  if p_action not in ('check_in','check_out') then raise exception 'INVALID_ACTION'; end if;
  select activity_type into v_last from staff_activity where staff_id = v_me and activity_type in ('check_in','check_out') order by created_at desc limit 1;
  if v_last is not distinct from p_action then raise exception 'ALREADY_%', upper(p_action); end if;
  if p_action = 'check_out' and v_last is null then raise exception 'NOT_CHECKED_IN'; end if;
  insert into staff_activity(staff_id, activity_type, summary) values (v_me, p_action, replace(p_action, '_', ' '));
end $$;

-- ---------------------------------------------------------------------
-- Settings (with configuration history)
-- ---------------------------------------------------------------------
create or replace function public.update_setting(p_key text, p_value jsonb, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_old system_settings;
begin
  perform public.require_permission('settings.manage');
  select * into v_old from system_settings where key = p_key for update;
  if not found then raise exception 'UNKNOWN_SETTING: %', p_key; end if;
  if jsonb_typeof(v_old.value) <> jsonb_typeof(p_value) then raise exception 'INVALID_VALUE_TYPE: expected %', jsonb_typeof(v_old.value); end if;
  if v_old.category = 'security' then perform public.require_permission('security.manage'); end if;
  if v_old.value = p_value then return; end if;
  update system_settings set value = p_value, updated_by = public.current_staff_id() where key = p_key;
  insert into settings_history(key, old_value, new_value, changed_by, reason) values (p_key, v_old.value, p_value, public.current_staff_id(), p_reason);
end $$;

create or replace function public.tg_pricing_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into pricing_history(pricing_rule_id, change_type, old_data, new_data, changed_by)
  values (coalesce(new.id, old.id),
    case when tg_op = 'INSERT' then 'created' when tg_op = 'DELETE' then 'deleted'
         when old.is_active and not new.is_active then 'deactivated' else 'updated' end,
    case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end, public.current_staff_id());
  return coalesce(new, old);
end $$;
create trigger pricing_rules_history after insert or update or delete on public.pricing_rules
for each row execute function public.tg_pricing_history();

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
create or replace function public.send_notification(
  p_audience text, p_title text, p_body text, p_category text default 'announcement', p_priority text default 'normal',
  p_channels text[] default array['in_app','push'], p_recipient_id uuid default null, p_city_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.require_permission(case when p_priority = 'emergency' then 'notifications.emergency' else 'notifications.send' end);
  if coalesce(length(trim(p_title)), 0) < 3 or coalesce(length(trim(p_body)), 0) < 3 then raise exception 'TITLE_AND_BODY_REQUIRED'; end if;
  if p_audience in ('driver','customer','staff') and p_recipient_id is null then raise exception 'RECIPIENT_REQUIRED'; end if;
  if not (p_channels <@ array['in_app','push','sms','email','whatsapp']) or cardinality(p_channels) = 0 then raise exception 'INVALID_CHANNELS'; end if;
  insert into notifications(audience, recipient_staff_id, recipient_driver_id, recipient_customer_id, city_id, category, priority, title, body, channels, created_by,
    dispatch_status)
  values (p_audience, case when p_audience = 'staff' then p_recipient_id end, case when p_audience = 'driver' then p_recipient_id end,
    case when p_audience = 'customer' then p_recipient_id end, p_city_id, p_category, p_priority, trim(p_title), trim(p_body), p_channels, public.current_staff_id(),
    case when p_channels = array['in_app'] then 'in_app_only' else 'pending' end)
  returning id into v_id;
  perform public.write_audit('notification.send', 'notifications', v_id::text, null, jsonb_build_object('audience', p_audience, 'priority', p_priority, 'channels', p_channels), null);
  return v_id;
end $$;

-- Dispatch result recorded by the "notify" Edge Function. SERVICE ROLE ONLY.
create or replace function public.notification_dispatch_result(p_notification_id uuid, p_logs jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare l jsonb; v_ok integer := 0; v_bad integer := 0;
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED: service role only' using errcode = '42501'; end if;
  for l in select * from jsonb_array_elements(coalesce(p_logs, '[]'::jsonb)) loop
    insert into notification_delivery_logs(notification_id, channel, provider, status, recipients_count, provider_message_id, error)
    values (p_notification_id, l->>'channel', coalesce(l->>'provider', 'none'), l->>'status', coalesce((l->>'recipients_count')::integer, 0),
            l->>'provider_message_id', left(l->>'error', 500));
    if l->>'status' in ('sent','delivered') then v_ok := v_ok + 1; elsif l->>'status' <> 'skipped' then v_bad := v_bad + 1; end if;
  end loop;
  update notifications set dispatch_status = case when v_bad = 0 and v_ok > 0 then 'dispatched' when v_ok > 0 then 'partial' else 'failed' end
  where id = p_notification_id;
end $$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns integer
language plpgsql security definer set search_path = public as $$
declare v_me uuid := public.current_staff_id(); v_count integer;
begin
  if v_me is null then raise exception 'NOT_STAFF' using errcode = '42501'; end if;
  update notifications set read_at = now() where recipient_staff_id = v_me and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- Scheduled jobs (pg_cron). All are safe to run repeatedly.
-- ---------------------------------------------------------------------
create or replace function public.document_expiry_scan() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; v_count integer := 0; v_days integer;
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  update driver_documents set status = 'expired', updated_at = now() where status = 'approved' and expiry_date < current_date;
  update vehicle_documents set status = 'expired', updated_at = now() where status = 'approved' and expiry_date < current_date;
  for r in
    select 'driver' as kind, dd.id, dd.driver_id as owner_id, d.full_name as label, dd.doc_type, dd.expiry_date
    from driver_documents dd join drivers d on d.id = dd.driver_id
    where dd.status = 'approved' and dd.expiry_date - current_date in (30, 15, 7, 3, 1)
    union all
    select 'vehicle', vd.id, null, v.registration_number, vd.doc_type, vd.expiry_date
    from vehicle_documents vd join vehicles v on v.id = vd.vehicle_id
    where vd.status = 'approved' and vd.expiry_date - current_date in (30, 15, 7, 3, 1)
  loop
    v_days := r.expiry_date - current_date;
    if exists (select 1 from notifications where category = 'document' and data->>'document_id' = r.id::text and (data->>'days')::integer = v_days) then continue; end if;
    perform public.notify_staff(case when r.kind = 'driver' then 'drivers.view' else 'vehicles.view' end, 'document', case when v_days <= 3 then 'high' else 'normal' end,
      'Document expiring in ' || v_days || ' day(s)', replace(r.doc_type, '_', ' ') || ' of ' || r.label || ' expires on ' || to_char(r.expiry_date, 'DD Mon YYYY') || '.',
      jsonb_build_object('document_id', r.id, 'days', v_days, 'kind', r.kind));
    if r.kind = 'driver' then
      insert into notifications(audience, recipient_driver_id, category, priority, title, body, data, channels)
      values ('driver', r.owner_id, 'document', 'high', 'Document expiring soon',
        'Your ' || replace(r.doc_type, '_', ' ') || ' expires in ' || v_days || ' day(s). Please upload a renewed copy.',
        jsonb_build_object('document_id', r.id, 'days', v_days), array['in_app','push']);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

create or replace function public.apply_retention() returns jsonb
language plpgsql security definer set search_path = public as $$
declare p record; v_n bigint; v_out jsonb := '{}'::jsonb; v_col text;
begin
  if not (public.is_privileged() or public.has_permission('security.manage')) then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  perform set_config('app.retention_job', '1', true);
  for p in select * from data_retention_policies where is_active loop
    v_col := case p.entity when 'driver_location_history' then 'received_at' when 'rate_limits' then 'window_start' else 'created_at' end;
    execute format('delete from public.%I where %I < now() - make_interval(days => $1)', p.entity, v_col) using p.retain_days;
    get diagnostics v_n = row_count;
    update data_retention_policies set last_run_at = now(), last_deleted_count = v_n where id = p.id;
    v_out := v_out || jsonb_build_object(p.entity, v_n);
  end loop;
  perform set_config('app.retention_job', '', true);
  return v_out;
end $$;

-- Minute-level housekeeping: end finished campaigns, retire expired coupons, expire OTPs, scan GPS health.
create or replace function public.run_scheduled_jobs() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  update campaigns set status = 'ended' where status = 'active' and ends_at is not null and ends_at <= now();
  update coupons set is_active = false where is_active and valid_until is not null and valid_until <= now();
  v := jsonb_build_object(
    'otp_expired', public.otp_expire_sweep(),
    'tracking_alerts', public.scan_tracking_health(),
    'ran_at', now());
  return v;
end $$;

-- ---------------------------------------------------------------------
-- System management
-- ---------------------------------------------------------------------
create or replace function public.create_api_key(p_name text, p_scopes text[], p_expires_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_key text; v_id uuid;
begin
  perform public.require_permission('security.manage');
  if coalesce(length(trim(p_name)), 0) < 3 then raise exception 'NAME_REQUIRED'; end if;
  v_key := 'rms_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into api_keys(name, key_prefix, key_hash, scopes, expires_at, created_by)
  values (trim(p_name), left(v_key, 10), encode(extensions.digest(v_key, 'sha256'), 'hex'), coalesce(p_scopes, '{}'), p_expires_at, public.current_staff_id())
  returning id into v_id;
  perform public.write_audit('api_key.create', 'api_keys', v_id::text, null, jsonb_build_object('name', p_name, 'scopes', p_scopes), null);
  -- The key is shown ONCE. Only its SHA-256 hash is stored.
  return jsonb_build_object('id', v_id, 'api_key', v_key);
end $$;

create or replace function public.revoke_api_key(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_permission('security.manage');
  update api_keys set revoked_at = now() where id = p_id and revoked_at is null;
  perform public.write_audit('api_key.revoke', 'api_keys', p_id::text, null, null, null);
end $$;

create or replace function public.system_health() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.require_permission('security.view');
  select jsonb_build_object(
    'checked_at', now(),
    'database_size_bytes', pg_database_size(current_database()),
    'bookings_total', (select count(*) from bookings),
    'location_history_rows', (select count(*) from driver_location_history),
    'drivers_on_duty', (select count(*) from drivers where availability <> 'offline'),
    'on_duty_stale_location', (select count(*) from drivers d join driver_locations l on l.driver_id = d.id
        where d.availability <> 'offline' and l.received_at < now() - make_interval(secs => public.setting_int('tracking.stale_seconds', 180))),
    'notifications_pending_dispatch', (select count(*) from notifications where dispatch_status = 'pending'),
    'oldest_pending_notification', (select min(created_at) from notifications where dispatch_status = 'pending'),
    'webhooks_24h', (select count(*) from payment_webhook_events where received_at > now() - interval '24 hours'),
    'webhook_failures_24h', (select count(*) from payment_webhook_events where received_at > now() - interval '24 hours' and (processing_status = 'failed' or not signature_valid)),
    'integration_failures_24h', (select count(*) from integration_events where created_at > now() - interval '24 hours' and status = 'failure'),
    'errors_24h', (select count(*) from error_logs where created_at > now() - interval '24 hours' and level in ('error','fatal')),
    'otp_delivery_failures_24h', (select count(*) from otp_delivery_logs where created_at > now() - interval '24 hours' and status in ('failed','not_configured')),
    'accepted_rides_without_otp', (select count(*) from bookings b where b.status in ('DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING')
        and not exists (select 1 from ride_otps o where o.booking_id = b.id)),
    'open_emergencies', (select count(*) from safety_incidents where status in ('open','acknowledged','investigating') and severity = 'critical'),
    'locked_staff_accounts', (select count(*) from admin_users where locked_until > now()),
    'active_console_sessions', (select count(*) from admin_sessions where revoked_at is null and last_seen_at > now() - interval '12 hours'),
    'last_backup_record', (select jsonb_build_object('type', backup_type, 'status', status, 'at', created_at) from backup_records order by created_at desc limit 1),
    'integrations', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'provider', provider, 'enabled', is_enabled, 'mode', mode, 'status', status,
        'last_checked_at', last_checked_at, 'last_error', last_error) order by kind), '[]'::jsonb) from integration_settings),
    'maintenance_mode', public.setting_bool('system.maintenance_mode', false)
  ) into v;
  return v;
end $$;

-- Edge Functions report which integrations have credentials. SERVICE ROLE ONLY.
create or replace function public.report_integration_status(p_kind text, p_provider text, p_status text, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED: service role only' using errcode = '42501'; end if;
  insert into integration_settings(kind, provider, status, last_checked_at, last_error)
  values (p_kind, p_provider, p_status, now(), left(p_error, 500))
  on conflict (kind, provider) do update set status = excluded.status, last_checked_at = now(), last_error = excluded.last_error;
end $$;

create or replace function public.log_integration_event(p_kind text, p_provider text, p_direction text, p_operation text, p_status text,
  p_http_status integer default null, p_duration_ms integer default null, p_error text default null, p_reference text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED: service role only' using errcode = '42501'; end if;
  insert into integration_events(kind, provider, direction, operation, status, http_status, duration_ms, error, reference)
  values (p_kind, p_provider, p_direction, p_operation, p_status, p_http_status, p_duration_ms, left(p_error, 500), p_reference);
end $$;

-- Bulk import with per-row error capture.
create or replace function public.import_rows(p_entity text, p_rows jsonb, p_file_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; v_ok integer := 0; v_bad integer := 0; v_errors jsonb := '[]'::jsonb; v_i integer := 0; v_job uuid; v_city uuid; v_cat uuid;
begin
  perform public.require_permission('settings.import');
  if p_entity not in ('drivers','vehicles','customers') then raise exception 'INVALID_ENTITY'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'INVALID_ROWS: provide at most 2000 rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    begin
      select id into v_city from cities where lower(name) = lower(trim(r->>'city')) limit 1;
      if p_entity = 'drivers' then
        if coalesce(r->>'full_name', '') = '' or coalesce(r->>'phone', '') !~ '^[6-9][0-9]{9}$' then raise exception 'full_name and a valid 10-digit phone are required'; end if;
        insert into drivers(full_name, phone, email, city_id, created_by) values (trim(r->>'full_name'), r->>'phone', nullif(r->>'email', ''), v_city, auth.uid());
      elsif p_entity = 'customers' then
        if coalesce(r->>'full_name', '') = '' or coalesce(r->>'phone', '') !~ '^[6-9][0-9]{9}$' then raise exception 'full_name and a valid 10-digit phone are required'; end if;
        insert into customers(full_name, phone, email, city_id) values (trim(r->>'full_name'), r->>'phone', nullif(r->>'email', ''), v_city);
      else
        select id into v_cat from vehicle_categories where lower(code) = lower(trim(r->>'category')) limit 1;
        if v_cat is null then raise exception 'unknown category "%"', r->>'category'; end if;
        insert into vehicles(registration_number, category_id, ownership_type, owner_name, manufacturer, model, city_id, created_by)
        values (upper(replace(trim(r->>'registration_number'), ' ', '')), v_cat, 'company', coalesce(nullif(r->>'owner_name', ''), 'Company'),
                trim(r->>'manufacturer'), trim(r->>'model'), v_city, auth.uid());
      end if;
      v_ok := v_ok + 1;
    exception when others then
      v_bad := v_bad + 1;
      if jsonb_array_length(v_errors) < 100 then v_errors := v_errors || jsonb_build_object('row', v_i, 'error', sqlerrm); end if;
    end;
  end loop;
  insert into data_import_jobs(entity, file_name, total_rows, imported_rows, failed_rows, errors, created_by)
  values (p_entity, p_file_name, v_i, v_ok, v_bad, v_errors, auth.uid()) returning id into v_job;
  perform public.write_audit('data.import', p_entity, v_job::text, null, jsonb_build_object('imported', v_ok, 'failed', v_bad), p_file_name);
  return jsonb_build_object('job_id', v_job, 'total', v_i, 'imported', v_ok, 'failed', v_bad, 'errors', v_errors);
end $$;

-- Global search across the entities the caller may see.
create or replace function public.global_search(p_query text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare q text := trim(coalesce(p_query, '')); v jsonb := '[]'::jsonb; v_part jsonb;
begin
  if public.current_staff_id() is null then raise exception 'NOT_STAFF' using errcode = '42501'; end if;
  if length(q) < 2 then return v; end if;
  if public.has_permission('rides.view') then
    select coalesce(jsonb_agg(jsonb_build_object('type', 'booking', 'id', id, 'title', booking_code, 'subtitle', status::text || ' · ' || left(pickup_address, 40))), '[]'::jsonb)
    into v_part from (select * from bookings where booking_code ilike '%' || q || '%' and public.staff_city_ok(city_id) order by created_at desc limit 5) t;
    v := v || v_part;
  end if;
  if public.has_permission('drivers.view') then
    select coalesce(jsonb_agg(jsonb_build_object('type', 'driver', 'id', id, 'title', full_name, 'subtitle', driver_code || ' · ' || status)), '[]'::jsonb)
    into v_part from (select * from drivers where (full_name ilike '%' || q || '%' or driver_code ilike '%' || q || '%' or phone like '%' || q || '%')
      and public.staff_city_ok(city_id) limit 5) t;
    v := v || v_part;
  end if;
  if public.has_permission('customers.view') then
    select coalesce(jsonb_agg(jsonb_build_object('type', 'customer', 'id', id, 'title', full_name, 'subtitle', customer_code || ' · ' || status)), '[]'::jsonb)
    into v_part from (select * from customers where (full_name ilike '%' || q || '%' or customer_code ilike '%' || q || '%'
      or (public.has_permission('customers.view_pii') and phone like '%' || q || '%')) and public.staff_city_ok(city_id) limit 5) t;
    v := v || v_part;
  end if;
  if public.has_permission('vehicles.view') then
    select coalesce(jsonb_agg(jsonb_build_object('type', 'vehicle', 'id', id, 'title', registration_number, 'subtitle', vehicle_code || ' · ' || manufacturer || ' ' || model)), '[]'::jsonb)
    into v_part from (select * from vehicles where (registration_number ilike '%' || q || '%' or vehicle_code ilike '%' || q || '%') and public.staff_city_ok(city_id) limit 5) t;
    v := v || v_part;
  end if;
  return v;
end $$;
