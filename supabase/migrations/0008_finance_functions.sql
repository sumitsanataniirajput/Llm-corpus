-- =====================================================================
-- 0008_finance_functions.sql — wallets, payments, webhooks, refunds, payouts
-- All amounts are integer paise. Every money movement is idempotent.
-- =====================================================================

-- Internal ledger posting. Idempotent on p_idempotency_key.
create or replace function public.wallet_post(
  p_owner_type text, p_owner_id uuid, p_direction text, p_amount_paise bigint, p_reason text,
  p_booking_id uuid, p_reference text, p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_balance bigint; v_delta bigint;
begin
  if p_amount_paise <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  select id into v_id from wallet_transactions where idempotency_key = p_idempotency_key;
  if v_id is not null then return v_id; end if;
  v_delta := case when p_direction = 'credit' then p_amount_paise else -p_amount_paise end;
  if p_owner_type = 'driver' then
    insert into driver_wallets(driver_id) values (p_owner_id) on conflict do nothing;
    select balance_paise into v_balance from driver_wallets where driver_id = p_owner_id for update;
    v_balance := v_balance + v_delta;
    update driver_wallets set balance_paise = v_balance, updated_at = now() where driver_id = p_owner_id;
  else
    insert into customer_wallets(customer_id) values (p_owner_id) on conflict do nothing;
    select balance_paise into v_balance from customer_wallets where customer_id = p_owner_id for update;
    v_balance := v_balance + v_delta;
    if v_balance < 0 then raise exception 'INSUFFICIENT_WALLET_BALANCE'; end if;
    update customer_wallets set balance_paise = v_balance, updated_at = now() where customer_id = p_owner_id;
  end if;
  insert into wallet_transactions(owner_type, driver_id, customer_id, direction, amount_paise, balance_after_paise, reason, booking_id, reference, idempotency_key, created_by)
  values (p_owner_type, case when p_owner_type = 'driver' then p_owner_id end, case when p_owner_type = 'customer' then p_owner_id end,
          p_direction, p_amount_paise, v_balance, p_reason, p_booking_id, p_reference, p_idempotency_key, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Internal: a booking's fare has been captured. Moves the booking to
-- PAYMENT_COMPLETED and settles the driver's wallet exactly once.
create or replace function public.settle_booking_payment(p_booking_id uuid, p_payment_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b bookings; p payments; v_cash bigint; v_delta bigint;
begin
  select * into b from bookings where id = p_booking_id for update;
  select * into p from payments where id = p_payment_id;
  if b.status = 'PAYMENT_PENDING' then
    perform set_config('app.booking_write', '1', true);
    perform set_config('app.actor_type', 'system', true);
    perform set_config('app.actor_id', '', true);
    perform set_config('app.reason', 'payment captured (' || p.method || ')', true);
    update bookings set status = 'PAYMENT_COMPLETED', payment_status = 'paid', payment_method = p.method, paid_at = now() where id = p_booking_id;
  elsif b.status = 'DISPUTED' then
    perform set_config('app.booking_write', '1', true);
    update bookings set payment_status = 'paid', payment_method = p.method, paid_at = now(), status_before_dispute = 'PAYMENT_COMPLETED' where id = p_booking_id;
  end if;
  if b.driver_id is not null then
    -- Cash: the driver already holds the full fare and owes the company its share.
    v_cash := case when p.method = 'cash' then p.amount_paise else 0 end;
    v_delta := b.driver_earning_paise - v_cash;
    if v_delta > 0 then
      perform public.wallet_post('driver', b.driver_id, 'credit', v_delta, 'ride_earning', p_booking_id, p.txn_code, 'settle:' || p_booking_id);
    elsif v_delta < 0 then
      perform public.wallet_post('driver', b.driver_id, 'debit', -v_delta, 'cash_commission', p_booking_id, p.txn_code, 'settle:' || p_booking_id);
    end if;
  end if;
  update customers set loyalty_points = loyalty_points + (p.amount_paise / 10000)::integer where id = b.customer_id;
end $$;

-- Cash collected by the driver (driver app) or recorded by finance staff.
create or replace function public.record_cash_payment(p_booking_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b bookings; p payments; v_driver uuid := public.current_driver_id(); v_staff boolean := false;
begin
  select * into b from bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_driver is not null and b.driver_id = v_driver then null;
  elsif public.has_permission('finance.record_payment') then v_staff := true;
  else raise exception 'PERMISSION_DENIED: finance.record_payment' using errcode = '42501'; end if;
  select * into p from payments where booking_id = p_booking_id and idempotency_key = 'booking:' || p_booking_id || ':fare' for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND: the ride has not been completed yet'; end if;
  if p.status in ('captured','refunded','partially_refunded') then
    return jsonb_build_object('ok', true, 'duplicate', true, 'txn_code', p.txn_code);   -- duplicate-processing guard
  end if;
  if b.status not in ('PAYMENT_PENDING','DISPUTED') then raise exception 'INVALID_STATE: booking is %', b.status; end if;
  if p.method <> 'cash' then
    if not v_staff then raise exception 'NOT_A_CASH_BOOKING: only finance staff can convert an online payment to cash'; end if;
    if coalesce(length(trim(p_reason)), 0) < 10 then raise exception 'REASON_REQUIRED: explain why the payment method is being changed to cash'; end if;
  end if;
  update payments set status = 'captured', method = 'cash', provider = 'cash', captured_at = now(), recorded_by = auth.uid(), updated_at = now()
  where id = p.id returning * into p;
  perform public.settle_booking_payment(p_booking_id, p.id);
  perform public.write_audit('payment.cash_recorded', 'payments', p.id::text, null, jsonb_build_object('amount_paise', p.amount_paise, 'booking_id', p_booking_id), p_reason);
  return jsonb_build_object('ok', true, 'duplicate', false, 'txn_code', p.txn_code);
end $$;

-- Gateway order created by the "payments" Edge Function. SERVICE ROLE ONLY.
create or replace function public.payment_attach_order(p_booking_id uuid, p_provider text, p_order_id text, p_method text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p payments;
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED: service role only' using errcode = '42501'; end if;
  select * into p from payments where booking_id = p_booking_id and idempotency_key = 'booking:' || p_booking_id || ':fare' for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  if p.status in ('captured','refunded','partially_refunded') then raise exception 'ALREADY_PAID'; end if;
  if p_order_id is not null then
    update payments set provider = p_provider, provider_order_id = p_order_id, status = 'pending', failure_reason = null,
      method = coalesce(p_method, case when method = 'cash' then 'upi' else method end), updated_at = now()
    where id = p.id returning * into p;
  end if;
  return jsonb_build_object('payment_id', p.id, 'txn_code', p.txn_code, 'amount_paise', p.amount_paise, 'currency', p.currency,
    'provider_order_id', p.provider_order_id, 'status', p.status);
end $$;

-- Verified gateway webhook. SERVICE ROLE ONLY. Replay-safe: (provider, event_id) is unique.
create or replace function public.apply_payment_webhook(
  p_provider text, p_event_id text, p_event_type text, p_signature_valid boolean, p_payload jsonb,
  p_kind text, p_order_id text default null, p_payment_id text default null, p_amount_paise bigint default null,
  p_method text default null, p_refund_id text default null, p_failure_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_event uuid; p payments; r refunds; v_note text; v_status text := 'processed';
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED: service role only' using errcode = '42501'; end if;
  insert into payment_webhook_events(provider, event_id, event_type, signature_valid, payload)
  values (p_provider, p_event_id, p_event_type, p_signature_valid, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, event_id) do nothing returning id into v_event;
  if v_event is null then return jsonb_build_object('ok', true, 'duplicate', true); end if;
  if not p_signature_valid then
    update payment_webhook_events set processing_status = 'ignored', processing_note = 'invalid signature', processed_at = now() where id = v_event;
    perform public.notify_staff('finance.view', 'payment', 'high', 'Payment webhook rejected', 'A ' || p_provider || ' webhook failed signature verification and was ignored.', '{}'::jsonb);
    return jsonb_build_object('ok', false, 'code', 'INVALID_SIGNATURE');
  end if;

  if p_kind in ('payment_captured','payment_failed') then
    select * into p from payments where provider_order_id = p_order_id for update;
    if not found then v_status := 'failed'; v_note := 'no payment for order ' || coalesce(p_order_id, '?');
    elsif p_kind = 'payment_captured' then
      if p.status in ('captured','refunded','partially_refunded') then v_status := 'ignored'; v_note := 'already captured';
      elsif p_amount_paise is distinct from p.amount_paise then
        v_status := 'failed'; v_note := 'amount mismatch: expected ' || p.amount_paise || ' got ' || coalesce(p_amount_paise::text, 'null');
        perform public.notify_staff('finance.view', 'payment', 'high', 'Payment amount mismatch', p.txn_code || ': ' || v_note, jsonb_build_object('payment_id', p.id));
      else
        update payments set status = 'captured', provider_payment_id = p_payment_id, captured_at = now(), failure_reason = null,
          method = case when p_method in ('upi','card','netbanking','wallet') then p_method else method end, updated_at = now()
        where id = p.id returning * into p;
        perform public.settle_booking_payment(p.booking_id, p.id);
        v_note := 'captured ' || p.txn_code;
      end if;
    else
      if p.status in ('created','pending') then
        update payments set status = 'failed', failure_reason = left(p_failure_reason, 300), updated_at = now() where id = p.id;
        perform set_config('app.booking_write', '1', true);
        update bookings set payment_status = 'failed' where id = p.booking_id and status in ('PAYMENT_PENDING','DISPUTED');
        v_note := 'marked failed';
      else v_status := 'ignored'; v_note := 'payment is ' || p.status; end if;
    end if;
  elsif p_kind in ('refund_processed','refund_failed') then
    select * into r from refunds where provider_refund_id = p_refund_id for update;
    if not found then v_status := 'failed'; v_note := 'unknown refund ' || coalesce(p_refund_id, '?');
    else
      perform public.finish_refund(r.id, p_kind = 'refund_processed', p_refund_id, p_failure_reason);
      v_note := p_kind;
    end if;
  else
    v_status := 'ignored'; v_note := 'unhandled event type';
  end if;
  update payment_webhook_events set processing_status = v_status, processing_note = v_note, processed_at = now() where id = v_event;
  return jsonb_build_object('ok', v_status <> 'failed', 'status', v_status, 'note', v_note);
end $$;

-- Internal: finalise a refund exactly once.
create or replace function public.finish_refund(p_refund_id uuid, p_success boolean, p_provider_refund_id text, p_failure_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r refunds; p payments; v_total bigint;
begin
  select * into r from refunds where id = p_refund_id for update;
  if not found then raise exception 'REFUND_NOT_FOUND'; end if;
  if r.status in ('completed','failed') then return; end if;
  if not p_success then
    update refunds set status = 'failed', failure_reason = left(p_failure_reason, 300), updated_at = now() where id = p_refund_id;
    perform public.notify_staff('finance.view', 'payment', 'high', 'Refund failed', r.txn_code || ': ' || coalesce(left(p_failure_reason, 120), 'provider reported failure'), jsonb_build_object('refund_id', r.id));
    return;
  end if;
  select * into p from payments where id = r.payment_id for update;
  v_total := p.refunded_paise + r.amount_paise;
  if v_total > p.amount_paise then raise exception 'REFUND_EXCEEDS_PAYMENT'; end if;
  update refunds set status = 'completed', provider_refund_id = coalesce(p_provider_refund_id, provider_refund_id), completed_at = now(), updated_at = now() where id = p_refund_id;
  update payments set refunded_paise = v_total, status = case when v_total = p.amount_paise then 'refunded' else 'partially_refunded' end, updated_at = now() where id = p.id;
  perform set_config('app.booking_write', '1', true);
  update bookings set payment_status = case when v_total = p.amount_paise then 'refunded' else 'partially_refunded' end where id = r.booking_id;
end $$;

create or replace function public.request_refund(p_payment_id uuid, p_amount_paise bigint, p_reason text, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p payments; r refunds; v_reserved bigint; v_id uuid;
begin
  perform public.require_permission('finance.refund');
  if coalesce(length(trim(p_idempotency_key)), 0) < 8 then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  select * into r from refunds where idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('ok', true, 'duplicate', true, 'refund_id', r.id, 'status', r.status, 'txn_code', r.txn_code); end if;
  if coalesce(length(trim(p_reason)), 0) < 10 then raise exception 'REASON_REQUIRED: give a refund reason (min 10 characters)'; end if;
  if p_amount_paise is null or p_amount_paise <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  select * into p from payments where id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  if p.status not in ('captured','partially_refunded') then raise exception 'NOT_REFUNDABLE: payment status is %', p.status; end if;
  select coalesce(sum(amount_paise), 0) into v_reserved from refunds where payment_id = p_payment_id and status in ('pending','processing');
  if p.refunded_paise + v_reserved + p_amount_paise > p.amount_paise then
    raise exception 'REFUND_EXCEEDS_PAYMENT: at most % paise can still be refunded', p.amount_paise - p.refunded_paise - v_reserved;
  end if;
  insert into refunds(payment_id, booking_id, amount_paise, reason, idempotency_key, requested_by, status)
  values (p_payment_id, p.booking_id, p_amount_paise, trim(p_reason), p_idempotency_key, public.current_staff_id(), 'pending')
  returning id into v_id;
  perform public.write_audit('refund.request', 'refunds', v_id::text, null, jsonb_build_object('payment_id', p_payment_id, 'amount_paise', p_amount_paise), p_reason);
  -- Cash was handed over in person: finance confirms the hand-back, no gateway involved.
  if p.method = 'cash' then
    perform public.finish_refund(v_id, true, 'CASH-' || left(v_id::text, 8), null);
    return jsonb_build_object('ok', true, 'duplicate', false, 'refund_id', v_id, 'status', 'completed', 'needs_gateway', false);
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'refund_id', v_id, 'status', 'pending', 'needs_gateway', true,
    'provider', p.provider, 'provider_payment_id', p.provider_payment_id, 'amount_paise', p_amount_paise);
end $$;

-- Gateway response for a refund. SERVICE ROLE ONLY.
create or replace function public.refund_gateway_result(p_refund_id uuid, p_state text, p_provider_refund_id text default null, p_failure_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED: service role only' using errcode = '42501'; end if;
  if p_state = 'processing' then
    update refunds set status = 'processing', provider_refund_id = p_provider_refund_id, updated_at = now() where id = p_refund_id and status = 'pending';
  elsif p_state = 'completed' then perform public.finish_refund(p_refund_id, true, p_provider_refund_id, null);
  elsif p_state = 'failed' then perform public.finish_refund(p_refund_id, false, p_provider_refund_id, p_failure_reason);
  else raise exception 'INVALID_STATE'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Driver payouts (maker / checker)
-- ---------------------------------------------------------------------
create or replace function public.create_payout(p_driver_id uuid, p_amount_paise bigint, p_method text, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x driver_payouts; v_balance bigint; v_reserved bigint; v_id uuid;
begin
  perform public.require_permission('finance.payouts');
  if coalesce(length(trim(p_idempotency_key)), 0) < 8 then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  select * into x from driver_payouts where idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('ok', true, 'duplicate', true, 'payout_id', x.id, 'status', x.status); end if;
  if p_amount_paise is null or p_amount_paise <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  insert into driver_wallets(driver_id) values (p_driver_id) on conflict do nothing;
  select balance_paise into v_balance from driver_wallets where driver_id = p_driver_id for update;
  select coalesce(sum(amount_paise), 0) into v_reserved from driver_payouts where driver_id = p_driver_id and status in ('pending','approved');
  if v_balance - v_reserved < p_amount_paise then
    raise exception 'INSUFFICIENT_BALANCE: available for payout is % paise', greatest(v_balance - v_reserved, 0);
  end if;
  insert into driver_payouts(driver_id, amount_paise, method, idempotency_key, requested_by)
  values (p_driver_id, p_amount_paise, coalesce(p_method, 'bank_transfer'), p_idempotency_key, public.current_staff_id()) returning id into v_id;
  perform public.write_audit('payout.create', 'driver_payouts', v_id::text, null, jsonb_build_object('driver_id', p_driver_id, 'amount_paise', p_amount_paise), null);
  return jsonb_build_object('ok', true, 'duplicate', false, 'payout_id', v_id, 'status', 'pending');
end $$;

create or replace function public.update_payout(p_payout_id uuid, p_action text, p_reference text default null, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x driver_payouts; v_staff uuid := public.current_staff_id();
begin
  select * into x from driver_payouts where id = p_payout_id for update;
  if not found then raise exception 'PAYOUT_NOT_FOUND'; end if;
  if p_action = 'approve' then
    perform public.require_permission('finance.payouts.approve');
    if x.status <> 'pending' then raise exception 'INVALID_STATE: payout is %', x.status; end if;
    if x.requested_by = v_staff and not public.setting_bool('finance.allow_self_approval', false) then
      raise exception 'SELF_APPROVAL_FORBIDDEN: a different staff member must approve this payout';
    end if;
    update driver_payouts set status = 'approved', approved_by = v_staff, updated_at = now() where id = p_payout_id;
  elsif p_action = 'paid' then
    perform public.require_permission('finance.payouts.approve');
    if x.status = 'paid' then return jsonb_build_object('ok', true, 'duplicate', true); end if;   -- duplicate payout guard
    if x.status <> 'approved' then raise exception 'INVALID_STATE: payout must be approved first (currently %)', x.status; end if;
    if coalesce(length(trim(p_reference)), 0) < 4 then raise exception 'REFERENCE_REQUIRED: enter the bank / UPI reference'; end if;
    perform public.wallet_post('driver', x.driver_id, 'debit', x.amount_paise, 'payout', null, x.txn_code, 'payout:' || x.id);
    update driver_payouts set status = 'paid', provider_reference = trim(p_reference), paid_at = now(), updated_at = now() where id = p_payout_id;
    insert into notifications(audience, recipient_driver_id, category, priority, title, body, data, channels)
    values ('driver', x.driver_id, 'payment', 'normal', 'Payout sent', 'A payout has been transferred to you. Ref: ' || trim(p_reference), jsonb_build_object('payout_id', x.id), array['in_app','push']);
  elsif p_action in ('failed','cancelled') then
    perform public.require_permission('finance.payouts');
    if x.status not in ('pending','approved') then raise exception 'INVALID_STATE: payout is %', x.status; end if;
    if coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'REASON_REQUIRED'; end if;
    update driver_payouts set status = p_action, failure_reason = trim(p_reason), updated_at = now() where id = p_payout_id;
  else raise exception 'INVALID_ACTION';
  end if;
  perform public.write_audit('payout.' || p_action, 'driver_payouts', p_payout_id::text, jsonb_build_object('status', x.status), jsonb_build_object('reference', p_reference), p_reason);
  return jsonb_build_object('ok', true, 'duplicate', false);
end $$;

create or replace function public.credit_incentive(p_incentive_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare i driver_incentives;
begin
  perform public.require_permission('finance.payouts.approve');
  select * into i from driver_incentives where id = p_incentive_id for update;
  if not found then raise exception 'INCENTIVE_NOT_FOUND'; end if;
  if i.status <> 'pending' then raise exception 'INVALID_STATE: incentive is %', i.status; end if;
  perform public.wallet_post('driver', i.driver_id, 'credit', i.amount_paise, 'incentive', null, i.reason, 'incentive:' || i.id);
  update driver_incentives set status = 'credited', credited_at = now() where id = p_incentive_id;
  perform public.write_audit('incentive.credit', 'driver_incentives', p_incentive_id::text, null, jsonb_build_object('amount_paise', i.amount_paise), i.reason);
end $$;

create or replace function public.adjust_customer_wallet(p_customer_id uuid, p_direction text, p_amount_paise bigint, p_reason text, p_idempotency_key text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_permission('finance.wallet_adjust');
  if coalesce(length(trim(p_reason)), 0) < 10 then raise exception 'REASON_REQUIRED'; end if;
  if p_direction not in ('credit','debit') then raise exception 'INVALID_DIRECTION'; end if;
  perform public.wallet_post('customer', p_customer_id, p_direction, p_amount_paise, 'adjustment', null, trim(p_reason), 'adj:' || p_idempotency_key);
  perform public.write_audit('wallet.adjust', 'customers', p_customer_id::text, null, jsonb_build_object('direction', p_direction, 'amount_paise', p_amount_paise), p_reason);
end $$;

-- ---------------------------------------------------------------------
-- Finance reporting (deterministic SQL — never produced by AI)
-- ---------------------------------------------------------------------
create or replace function public.finance_summary(p_from timestamptz, p_to timestamptz, p_city_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.require_permission('finance.view');
  with paid as (
    select b.* from bookings b
    where b.paid_at >= p_from and b.paid_at < p_to and b.payment_status in ('paid','partially_refunded','refunded')
      and (p_city_id is null or b.city_id = p_city_id) and public.staff_city_ok(b.city_id)
  ), pay as (
    select p.* from payments p join bookings b on b.id = p.booking_id
    where p.captured_at >= p_from and p.captured_at < p_to and (p_city_id is null or b.city_id = p_city_id) and public.staff_city_ok(b.city_id)
  ), rf as (
    select r.* from refunds r join bookings b on b.id = r.booking_id
    where r.status = 'completed' and r.completed_at >= p_from and r.completed_at < p_to and (p_city_id is null or b.city_id = p_city_id)
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'paid_rides', (select count(*) from paid),
    'revenue_paise', (select coalesce(sum(total_fare_paise), 0) from paid),
    'commission_paise', (select coalesce(sum(commission_paise), 0) from paid),
    'driver_earnings_paise', (select coalesce(sum(driver_earning_paise), 0) from paid),
    'tax_paise', (select coalesce(sum(tax_paise), 0) from paid),
    'discounts_paise', (select coalesce(sum(discount_paise), 0) from paid),
    'refunds_paise', (select coalesce(sum(amount_paise), 0) from rf),
    'refund_count', (select count(*) from rf),
    'by_method', (select coalesce(jsonb_object_agg(method, amt), '{}'::jsonb) from (select method, sum(amount_paise) amt from pay group by method) m),
    'cash_paise', (select coalesce(sum(amount_paise), 0) from pay where method = 'cash'),
    'online_paise', (select coalesce(sum(amount_paise), 0) from pay where method <> 'cash'),
    'pending_payments_paise', (select coalesce(sum(p.amount_paise), 0) from payments p join bookings b on b.id = p.booking_id
        where p.status in ('created','pending') and (p_city_id is null or b.city_id = p_city_id)),
    'pending_payments_count', (select count(*) from payments p join bookings b on b.id = p.booking_id
        where p.status in ('created','pending') and (p_city_id is null or b.city_id = p_city_id)),
    'payouts_paid_paise', (select coalesce(sum(amount_paise), 0) from driver_payouts where status = 'paid' and paid_at >= p_from and paid_at < p_to),
    'payouts_pending_paise', (select coalesce(sum(amount_paise), 0) from driver_payouts where status in ('pending','approved')),
    'driver_wallet_liability_paise', (select coalesce(sum(balance_paise), 0) from driver_wallets where balance_paise > 0),
    'driver_dues_paise', (select coalesce(-sum(balance_paise), 0) from driver_wallets where balance_paise < 0),
    'incentives_paise', (select coalesce(sum(amount_paise), 0) from driver_incentives where status = 'credited' and credited_at >= p_from and credited_at < p_to),
    'expenses_paise', (select coalesce(sum(amount_paise), 0) from expenses where incurred_on >= p_from::date and incurred_on < p_to::date + 1
        and (p_city_id is null or city_id = p_city_id)),
    'expenses_by_category', (select coalesce(jsonb_object_agg(category, amt), '{}'::jsonb) from
        (select category, sum(amount_paise) amt from expenses where incurred_on >= p_from::date and incurred_on < p_to::date + 1
           and (p_city_id is null or city_id = p_city_id) group by category) e)
  ) into v;
  -- Profit & loss: company income is commission; discounts, refunds, incentives and expenses reduce it.
  return v || jsonb_build_object('net_profit_paise',
    (v->>'commission_paise')::bigint - (v->>'discounts_paise')::bigint - (v->>'refunds_paise')::bigint
    - (v->>'incentives_paise')::bigint - (v->>'expenses_paise')::bigint,
    'profit_formula', 'commission - discounts - refunds - incentives - expenses');
end $$;

-- GST support report: day-wise taxable value and tax collected for a month.
create or replace function public.gst_report(p_month date, p_city_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := date_trunc('month', p_month::timestamp) at time zone 'Asia/Kolkata'; v_to timestamptz; v jsonb;
begin
  perform public.require_permission('finance.view');
  v_to := (date_trunc('month', p_month::timestamp) + interval '1 month') at time zone 'Asia/Kolkata';
  select coalesce(jsonb_agg(x order by x.day), '[]'::jsonb) into v from (
    select (b.paid_at at time zone 'Asia/Kolkata')::date as day, count(*) as rides,
      sum(b.total_fare_paise - b.tax_paise) as taxable_paise, sum(b.tax_paise) as gst_paise, sum(b.total_fare_paise) as total_paise,
      sum(b.commission_paise) as commission_paise
    from bookings b
    where b.paid_at >= v_from and b.paid_at < v_to and b.payment_status in ('paid','partially_refunded')
      and (p_city_id is null or b.city_id = p_city_id) and public.staff_city_ok(b.city_id)
    group by 1
  ) x;
  return jsonb_build_object('month', to_char(p_month, 'YYYY-MM'), 'rows', v,
    'note', 'Supporting figures only. Have a chartered accountant confirm the GST treatment before filing.');
end $$;
