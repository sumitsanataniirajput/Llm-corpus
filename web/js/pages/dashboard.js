// Module 0 — Main dashboard. Every number comes from dashboard_stats() and friends.
import { rpc, cities, subscribe } from '../api.js';
import { statCards, loadingState, errorState, emptyState, timeline, showError, notice } from '../components.js';
import { lineChart, barChart, doughnutChart, bucketLabel } from '../charts.js';
import { money, number, rangeFor, bucketFor, esc, ago, titleCase, isoDate, debounce, dateTime } from '../utilities.js';
import { can } from '../permissions.js';

const LEVEL = { emergency: ['danger', 'fa-triangle-exclamation'], high: ['warning', 'fa-circle-exclamation'], normal: ['info', 'fa-circle-info'] };

export async function init(root) {
  const $ = (s) => root.querySelector(s);
  let preset = 'today', metric = 'bookings', series = [], bucket = 'hour', alive = true;
  const cityList = await cities().catch(() => []);
  $('#dash-city').insertAdjacentHTML('beforeend', cityList.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(''));
  $('#dash-from').value = isoDate(new Date(Date.now() - 6 * 86400000)); $('#dash-to').value = isoDate();

  const range = () => rangeFor(preset, $('#dash-from').value, $('#dash-to').value);

  function drawChart() {
    const labels = series.map((p) => bucketLabel(p.bucket, bucket));
    if (metric === 'revenue') lineChart($('#dash-chart'), { labels, format: 'money', datasets: [{ label: 'Revenue', data: series.map((p) => p.revenue_paise) }, { label: 'Company commission', data: series.map((p) => p.commission_paise) }] });
    else barChart($('#dash-chart'), { labels, stacked: true, datasets: [{ label: 'Completed', data: series.map((p) => p.completed) }, { label: 'Cancelled', data: series.map((p) => p.cancelled), color: getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() },
      { label: 'Other', data: series.map((p) => Math.max(0, p.bookings - p.completed - p.cancelled)), color: getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim() }] });
  }

  async function load(silent = false) {
    const { from, to } = range(); const city = $('#dash-city').value || null;
    if (!silent) { $('#dash-live').innerHTML = loadingState(); $('#dash-period').innerHTML = ''; }
    try {
      bucket = bucketFor(from, to);
      const [s, ts, bd, alerts, activity] = await Promise.all([
        rpc('dashboard_stats', { p_from: from, p_to: to, p_city_id: city }),
        rpc('analytics_timeseries', { p_from: from, p_to: to, p_bucket: bucket, p_city_id: city }),
        can('analytics.view') ? rpc('analytics_breakdowns', { p_from: from, p_to: to, p_city_id: city }) : Promise.resolve(null),
        rpc('operational_alerts').catch(() => []),
        rpc('recent_activity', { p_limit: 25 }).catch(() => null),
      ]);
      if (!alive) return;
      series = ts ?? [];
      $('#dash-updated').textContent = `Updated ${dateTime(s.generated_at)}`;
      $('#dash-period-title').textContent = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', year: 'Last 12 months', custom: 'Custom period' }[preset];
      statCards($('#dash-live'), [
        { label: 'Online drivers', value: number(s.online_drivers), icon: 'fa-signal', tone: 'success', href: '#/live-tracking' },
        { label: 'Drivers on rides', value: number(s.drivers_on_ride), icon: 'fa-car-side', tone: 'info', href: '#/live-tracking' },
        { label: 'Offline drivers', value: number(s.offline_drivers), icon: 'fa-power-off', tone: 'neutral' },
        { label: 'Ongoing rides', value: number(s.ongoing_rides), icon: 'fa-route', href: '#/rides?tab=ongoing', hint: s.searching_rides ? `${s.searching_rides} waiting for a driver` : '' },
        { label: 'Total drivers', value: number(s.total_drivers), icon: 'fa-id-card', hint: `${number(s.approved_drivers)} approved · ${number(s.pending_driver_applications)} pending`, href: '#/drivers' },
        { label: 'Total vehicles', value: number(s.total_vehicles), icon: 'fa-car', href: '#/vehicles' },
        { label: 'Total customers', value: number(s.total_customers), icon: 'fa-users', href: '#/customers' },
        { label: 'Pending payments', value: money(s.pending_payments_paise), icon: 'fa-hourglass-half', tone: 'warning', hint: `${number(s.pending_payments_count)} ride(s)`, href: '#/finance?tab=payments' },
      ]);
      statCards($('#dash-period'), [
        { label: 'Bookings', value: number(s.bookings), icon: 'fa-calendar-check', href: '#/rides' },
        { label: 'Completed rides', value: number(s.completed_rides), icon: 'fa-circle-check', tone: 'success' },
        { label: 'Cancelled rides', value: number(s.cancelled_rides), icon: 'fa-ban', tone: 'danger', hint: s.bookings ? `${((s.cancelled_rides / s.bookings) * 100).toFixed(1)}% of bookings` : '' },
        { label: 'Revenue (paid rides)', value: money(s.revenue_paise), icon: 'fa-indian-rupee-sign', tone: 'success' },
        { label: 'Company commission', value: money(s.commission_paise), icon: 'fa-percent', tone: 'violet' },
        { label: 'Company profit', value: money(s.company_profit_paise), icon: 'fa-sack-dollar', tone: 'success', hint: 'Commission − discounts' },
        { label: 'Driver earnings', value: money(s.driver_earnings_paise), icon: 'fa-wallet', tone: 'info' },
        { label: 'Driver payouts paid', value: money(s.driver_payouts_paise), icon: 'fa-money-bill-transfer', hint: s.payouts_awaiting_paise ? `${money(s.payouts_awaiting_paise)} awaiting` : '' },
      ]);
      drawChart();
      if (bd) doughnutChart($('#dash-categories'), { labels: (bd.categories ?? []).map((c) => c.name), data: (bd.categories ?? []).map((c) => c.rides) });
      else $('#dash-categories').parentElement.innerHTML = emptyState({ icon: 'fa-lock', title: 'Analytics permission needed', text: 'Category breakdown requires the analytics.view permission.' });

      const list = alerts ?? [];
      $('#dash-alerts').innerHTML = list.filter((a) => a.level === 'emergency').map((a) => `<a href="#/${esc(a.page)}" style="text-decoration:none">${notice('danger', a.message, '', 'fa-triangle-exclamation')}</a>`).join('');
      $('#dash-attention').innerHTML = list.length ? list.map((a) => { const [tone, icon] = LEVEL[a.level] ?? LEVEL.normal; return `<a class="list-item" href="#/${esc(a.page)}" style="color:inherit;text-decoration:none"><span class="stat-ico ${tone}" style="width:32px;height:32px"><i class="fa-solid ${icon}"></i></span><div><div class="cell-main">${esc(a.message)}</div><div class="cell-sub">${esc(titleCase(a.code))}</div></div><span class="badge ${tone}">${esc(a.count)}</span></a>`; }).join('')
        : emptyState({ icon: 'fa-circle-check', title: 'All clear', text: 'No open alerts from the operational checks.' });
      $('#dash-activity').innerHTML = activity === null ? emptyState({ icon: 'fa-lock', title: 'Not available for your role' })
        : timeline(activity.map((a) => ({ title: `${esc(titleCase(a.action.replace(/\./g, ' ')))}`, text: `${esc(a.staff_name ?? titleCase(a.actor_type))}${a.reason ? ` — ${esc(a.reason)}` : ''}`, time: ago(a.created_at), tone: /cancel|reject|suspend|blacklist|override|sos/.test(a.action) ? 'danger' : '' })), 'No recorded activity yet.');
    } catch (e) {
      if (!alive) return;
      if (silent) return;                         // keep the last good numbers on a background refresh
      $('#dash-live').innerHTML = errorState(e, true); $('#dash-live').querySelector('[data-retry]')?.addEventListener('click', () => load());
    }
  }

  $('#dash-range').addEventListener('click', (e) => { const b = e.target.closest('[data-range]'); if (!b) return; preset = b.dataset.range; root.querySelectorAll('#dash-range button').forEach((x) => x.classList.toggle('active', x === b)); $('#dash-custom').hidden = preset !== 'custom'; if (preset !== 'custom') load(); });
  $('#dash-apply').onclick = () => { if ($('#dash-from').value > $('#dash-to').value) { showError(new Error('The "from" date must be before the "to" date.')); return; } load(); };
  $('#dash-metric').addEventListener('click', (e) => { const b = e.target.closest('[data-metric]'); if (!b) return; metric = b.dataset.metric; root.querySelectorAll('#dash-metric button').forEach((x) => x.classList.toggle('active', x === b)); drawChart(); });
  $('#dash-city').onchange = () => load(); $('#dash-refresh').onclick = () => load();

  await load();
  // Live operational statistics: refresh shortly after any booking / driver / incident change.
  const soft = debounce(() => { if (alive && !document.hidden) load(true); }, 2500);
  const unsub = subscribe('dashboard', ['bookings', { table: 'drivers', event: 'UPDATE' }, 'safety_incidents', 'payments'], soft);
  const timer = setInterval(() => { if (!document.hidden) load(true); }, 60000);
  return () => { alive = false; unsub(); clearInterval(timer); };
}
