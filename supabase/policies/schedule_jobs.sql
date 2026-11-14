-- Run this in the Supabase SQL editor AFTER enabling the pg_cron extension
-- (Dashboard > Database > Extensions > pg_cron). Safe to run again.
select cron.schedule('rms-minute-jobs', '* * * * *', 'select public.run_scheduled_jobs()');
select cron.schedule('rms-daily-report', '35 19 * * *', 'select public.generate_daily_report()');
select cron.schedule('rms-document-expiry', '30 2 * * *', 'select public.document_expiry_scan()');
select cron.schedule('rms-retention', '0 21 * * *', 'select public.apply_retention()');
select cron.schedule('rms-suspicious-customers', '15 * * * *', 'select public.detect_suspicious_customers()');
-- Check:  select jobname, schedule, active from cron.job;
