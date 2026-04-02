import './style.css';

const CABINS = [
  { code: 2, label: 'Business', cls: 'business' },
  { code: 4, label: 'Prem Econ', cls: 'premium-economy' },
  { code: 5, label: 'Economy', cls: 'economy' },
];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SOLD_LF_TOOLTIP = 'Sold ÷ Physical Capacity × 100';
const MANAGED_LF_TOOLTIP = '(Sold + Held) ÷ Sellable Capacity × 100';
const AUTH_REDIRECT_SYMBOL = Symbol('auth-redirect');

const now = new Date();
const todayStr = isoDate(now);
const DEFAULT_RANGE_DAYS = 2;

let state = {
  authLoading: true,
  authenticated: false,
  authorized: false,
  authError: null,
  accessDeniedMessage: '',
  user: null,
  access: null,
  loading: false,
  error: null,
  data: null,
  sortKey: null,
  sortDir: 'asc',
  dateFrom: todayStr,
  dateTo: isoDate(new Date(now.getTime() + (DEFAULT_RANGE_DAYS - 1) * 86400000)),
  calendarOpen: false,
  calendarMonth: new Date(now.getFullYear(), now.getMonth(), 1),
  selectingEnd: false,
  selectedCabins: [],
  selectedEnv: 'rx-prd',
  environments: [],
  expandedGroups: new Set(),
  theme: localStorage.getItem('lf-theme') || 'dark',
  dashboardPeriod: 'last3',   // which drawer is open (null = all closed)
  dashboardPanels: {},         // { last3: { loading, data, error }, next7: ..., next30: ... }
};
let tooltipEl = null;
let activeTooltipTarget = null;
let activeSearchSeq = 0;

class AuthRedirectError extends Error {
  constructor() {
    super('Redirecting to login');
    this.name = 'AuthRedirectError';
    this[AUTH_REDIRECT_SYMBOL] = true;
  }
}

function isAuthRedirectError(error) {
  return Boolean(error?.[AUTH_REDIRECT_SYMBOL]);
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('lf-theme', state.theme);
}

function toggleTheme() {
  const inputs = getSearchInputs();
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  render();
  restoreSearchInputs(inputs);
}

const DASHBOARD_PERIODS = [
  { key: 'last3', label: 'Last 3 Days', description: 'Including today' },
  { key: 'next7', label: 'Next 7 Days', description: 'Including today' },
  { key: 'next30', label: 'Next 30 Days', description: 'Including today' },
];

function getDashPanel(period) {
  if (!state.dashboardPanels[period]) {
    state.dashboardPanels[period] = { loading: false, data: null, error: null };
  }
  return state.dashboardPanels[period];
}

async function loadDashboard(env, period) {
  period = period || state.dashboardPeriod || 'last3';
  const panel = getDashPanel(period);
  panel.loading = true;
  panel.error = null;
  if (!state.data && !state.loading) render();
  try {
    const data = await fetchJsonOrThrow(`/api/dashboard?env=${encodeURIComponent(env)}&period=${encodeURIComponent(period)}`);
    panel.data = data;
    panel.error = null;
  } catch (error) {
    if (!isAuthRedirectError(error)) {
      panel.error = error.message;
    }
  }
  panel.loading = false;
  if (!state.data && !state.loading) render();
}

function toggleDashboardPeriod(period) {
  if (state.dashboardPeriod === period) {
    state.dashboardPeriod = null;
    if (!state.data && !state.loading) render();
    return;
  }
  state.dashboardPeriod = period;
  const panel = getDashPanel(period);
  // Always fetch fresh data when opening a drawer
  loadDashboard(state.selectedEnv, period);
}

async function boot() {
  applyTheme();
  render();
  setupGlobal();

  const sessionReady = await loadSessionState();
  if (!sessionReady || !state.authorized) {
    render();
    return;
  }

  try {
    const environments = await fetchJsonOrThrow('/api/environments');
    state.environments = environments;
    if (!environments.some((env) => env.name === state.selectedEnv) && environments[0]) {
      state.selectedEnv = environments[0].name;
    }
  } catch (error) {
    if (!isAuthRedirectError(error)) {
      state.authError = error.message;
    }
  }

  render();
  if (state.authorized) {
    prewarmSeatMaps(state.selectedEnv);
    loadDashboard(state.selectedEnv);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

function setupGlobal() {
  ensureTooltip();
  document.addEventListener('click', () => { if (state.calendarOpen) closeCalendar(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.calendarOpen) closeCalendar(); });
  document.addEventListener('mouseover', handleTooltipMouseOver);
  document.addEventListener('mouseout', handleTooltipMouseOut);
  document.addEventListener('mousemove', handleTooltipMouseMove);
  window.addEventListener('scroll', () => updateTooltipPosition(activeTooltipTarget), true);
  window.addEventListener('resize', () => updateTooltipPosition(activeTooltipTarget));
}

function buildReturnTo() {
  if (window.location.pathname.startsWith('/auth/')) {
    return '/';
  }
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function redirectToLogin() {
  if (window.location.pathname.startsWith('/auth/')) {
    return;
  }
  window.location.assign(`/auth/login?returnTo=${encodeURIComponent(buildReturnTo())}`);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  let payload = null;

  if (contentType.includes('application/json')) payload = await response.json().catch(() => null);
  else payload = await response.text().catch(() => '');

  return { response, payload };
}

async function fetchJsonOrThrow(url, options = {}) {
  const { response, payload } = await requestJson(url, options);

  if (response.status === 401) {
    redirectToLogin();
    throw new AuthRedirectError();
  }

  if (response.status === 403) {
    state = {
      ...state,
      authLoading: false,
      authenticated: true,
      authorized: false,
      user: payload?.user || state.user,
      access: payload?.access || null,
      accessDeniedMessage: payload?.error || 'You are signed in, but you are not on the LoadFactor allowlist.',
      loading: false,
    };
    render();
    throw new Error(state.accessDeniedMessage);
  }

  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return payload;
}

async function loadSessionState() {
  try {
    const { response, payload } = await requestJson('/api/me');

    if (response.status === 401) {
      redirectToLogin();
      return false;
    }

    if (response.status === 403) {
      state = {
        ...state,
        authLoading: false,
        authenticated: true,
        authorized: false,
        user: payload?.user || null,
        access: payload?.access || null,
        accessDeniedMessage: payload?.error || 'You are signed in, but you are not on the LoadFactor allowlist.',
      };
      return true;
    }

    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);

    state = {
      ...state,
      authLoading: false,
      authenticated: Boolean(payload?.authenticated),
      authorized: Boolean(payload?.authorized),
      user: payload?.user || null,
      access: payload?.access || null,
      accessDeniedMessage: '',
      authError: null,
    };
    return true;
  } catch (error) {
    state = { ...state, authLoading: false, authError: isAuthRedirectError(error) ? null : error.message };
    return false;
  }
}

function getSearchInputs() {
  return {
    origin: (document.getElementById('origin')?.value || '').trim().toUpperCase(),
    dest: (document.getElementById('destination')?.value || '').trim().toUpperCase(),
    flights: (document.getElementById('flights')?.value || '').trim(),
  };
}

function restoreSearchInputs({ origin = '', dest = '', flights = '' } = {}) {
  if (document.getElementById('origin')) document.getElementById('origin').value = origin;
  if (document.getElementById('destination')) document.getElementById('destination').value = dest;
  if (document.getElementById('flights')) document.getElementById('flights').value = flights;
}

function prewarmSeatMaps(env) {
  fetch('/api/seatmaps/prewarm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env }),
  }).catch(() => {});
}

function render() {
  document.getElementById('app').innerHTML =
    renderHeader()
    + (state.authorized ? renderSearchPanel() : '')
    + renderContent()
    + renderFooter();
  bindEvents();
}

function renderHeader() {
  const isProd = state.selectedEnv === 'rx-prd';
  const badgeClass = isProd ? 'env-badge env-prod' : 'env-badge env-nonprod';
  const envList = state.environments.length ? state.environments : [{ name: 'rx-prd', isProd: true }];
  const options = envList.map((env) =>
    `<option value="${env.name}" ${env.name === state.selectedEnv ? 'selected' : ''}>${env.name}</option>`,
  ).join('');
  const themeIcon = state.theme === 'dark' ? '☀️' : '🌙';
  const role = state.access?.role || state.user?.role || 'viewer';
  const authBadge = state.authLoading
    ? '<div class="user-status pending">Checking access</div>'
    : state.authorized
      ? `<div class="user-status allowed">${escapeHtml(role)}</div>`
      : state.user
        ? '<div class="user-status denied">Not allowlisted</div>'
        : '<div class="user-status pending">Signing in</div>';
  const authControls = state.user
    ? `
      <div class="user-panel">
        <div class="user-meta">
          <div class="user-name">${escapeHtml(state.user.displayName || state.user.email)}</div>
          <div class="user-email">${escapeHtml(state.user.email)}</div>
        </div>
        ${authBadge}
        <button type="button" class="logout-btn" id="logout-btn">Sign out</button>
      </div>
    `
    : authBadge;

  return `
    <header class="header">
      <div class="header-left">
        <div class="header-icon">📊</div>
        <div class="header-title-wrap">
          <h1>LoadFactor Dashboard</h1>
          <div class="header-subtitle"></div>
        </div>
      </div>
      <div class="header-right">
        <button type="button" class="theme-toggle" id="theme-toggle" title="Switch to ${state.theme === 'dark' ? 'light' : 'dark'} mode">${themeIcon}</button>
        ${state.authorized ? `<div class="${badgeClass}"><select id="env-select" class="env-select">${options}</select></div>` : ''}
        ${authControls}
      </div>
    </header>
  `;
}

function renderSearchPanel() {
  return `
  <section class="search-panel" id="search-panel">
    <h2>Search Flights</h2>
    <div class="search-controls">
      <div class="search-row">
        <div class="date-range-wrapper" id="date-range-wrapper">
          <label>Travel Dates</label>
          <button type="button" class="date-range-trigger" id="date-range-trigger">
            <span class="trigger-icon">📅</span>
            <span class="trigger-text">${fmtRange(state.dateFrom, state.dateTo)}</span>
            <span class="trigger-chevron">${state.calendarOpen ? '▲' : '▼'}</span>
          </button>
          <div class="calendar-dropdown ${state.calendarOpen ? 'visible' : ''}" id="calendar-dropdown">${renderCalendarInner()}</div>
        </div>
        <div class="form-group"><label for="origin">Origin</label><input type="text" id="origin" class="iata-input" placeholder="e.g. RUH" maxlength="3" autocomplete="off"/></div>
        <div class="form-group"><label for="destination">Destination</label><input type="text" id="destination" class="iata-input" placeholder="e.g. JED" maxlength="3" autocomplete="off"/></div>
        <div class="form-group"><label for="flights">Flights</label><input type="text" id="flights" class="flight-filter-input" placeholder="e.g. 401,402,9991-9993" autocomplete="off"/></div>
        <button type="button" class="search-btn" id="search-btn" ${state.loading ? 'disabled' : ''}>${state.loading ? '<div class="spinner"></div> Querying…' : '🔍 Search'}</button>
      </div>
      <div class="search-row-secondary">
        <label class="filter-label">Cabin</label>
        <div class="cabin-filter" id="cabin-filter">
          <button type="button" class="cabin-pill ${state.selectedCabins.length === 0 ? 'active' : ''}" data-cabin="all">All</button>
          ${CABINS.map((cabin) => `<button type="button" class="cabin-pill ${cabin.cls} ${state.selectedCabins.includes(cabin.code) ? 'active' : ''}" data-cabin="${cabin.code}">${cabin.label}</button>`).join('')}
        </div>
      </div>
    </div>
  </section>`;
}

function renderCalendarInner() {
  const m1 = state.calendarMonth;
  const m2 = new Date(m1.getFullYear(), m1.getMonth() + 1, 1);
  const hint = state.selectingEnd ? 'Select end date' : 'Select start date';
  return `
    <div class="cal-header">
      <button type="button" class="cal-nav" data-dir="-1">‹</button>
      <span class="cal-title">${MONTHS[m1.getMonth()]} ${m1.getFullYear()}</span>
      <span class="cal-title">${MONTHS[m2.getMonth()]} ${m2.getFullYear()}</span>
      <button type="button" class="cal-nav" data-dir="1">›</button>
    </div>
    <div class="cal-hint">${hint}</div>
    <div class="cal-months">${renderMonthGrid(m1.getFullYear(), m1.getMonth())}${renderMonthGrid(m2.getFullYear(), m2.getMonth())}</div>`;
}

function renderMonthGrid(year, month) {
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  let html = `<div class="cal-month"><div class="cal-weekdays">${WEEKDAYS.map((day) => `<div class="cal-wd">${day}</div>`).join('')}</div><div class="cal-grid">`;
  for (let i = 0; i < first; i += 1) html += '<div class="day-cell empty"></div>';
  for (let day = 1; day <= days; day += 1) {
    const dateString = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    html += `<div class="${dayClasses(dateString)}" data-date="${dateString}">${day}</div>`;
  }
  const rem = (7 - (first + days) % 7) % 7;
  for (let i = 0; i < rem; i += 1) html += '<div class="day-cell empty"></div>';
  return `${html}</div></div>`;
}

function dayClasses(dateString) {
  const classes = ['day-cell'];
  if (dateString === todayStr) classes.push('today');
  if (dateString === state.dateFrom) classes.push('selected-start');
  if (dateString === state.dateTo) classes.push('selected-end');
  if (state.dateFrom && state.dateTo && dateString > state.dateFrom && dateString < state.dateTo) classes.push('in-range');
  return classes.join(' ');
}

function updateCalendar() {
  const dropdown = document.getElementById('calendar-dropdown');
  if (dropdown) {
    dropdown.innerHTML = renderCalendarInner();
    dropdown.classList.toggle('visible', state.calendarOpen);
  }
  const trigger = document.getElementById('date-range-trigger');
  if (trigger) trigger.querySelector('.trigger-text').textContent = fmtRange(state.dateFrom, state.dateTo);
}

function closeCalendar() {
  state.calendarOpen = false;
  if (state.selectingEnd && !state.dateTo) {
    state.dateTo = state.dateFrom;
    state.selectingEnd = false;
  }
  updateCalendar();
}

function renderContent() {
  if (state.authLoading) return renderState('loading', '🔐', 'Checking access…', 'Validating your Okta session and LoadFactor allowlist entry.');
  if (state.authError) return renderState('error', '⚠️', 'Access Check Failed', state.authError);
  if (!state.authorized) return renderAccessDenied();
  if (state.loading) return renderState('loading', '✈️', 'Querying Stock Keeper…', `Fetching live load factor data from ${state.selectedEnv} Spanner`);
  if (state.error) return renderState('error', '⚠️', 'Query Failed', state.error);
  if (!state.data) return renderDashboard();
  if (state.data.results.length === 0) return renderState('empty', '📭', 'No Flights Found', `No CAPACITY trackers matched for ${state.data.origin} → ${state.data.destination}, ${state.data.dateFrom} to ${state.data.dateTo}.`);
  return renderSummary() + renderTable();
}

function renderDashboard() {
  const drawers = DASHBOARD_PERIODS.map(p => {
    const isOpen = state.dashboardPeriod === p.key;
    const panel = getDashPanel(p.key);
    const chevron = isOpen ? '▾' : '▸';
    const headerClass = `dash-drawer-header${isOpen ? ' open' : ''}`;

    let body = '';
    if (isOpen) {
      if (panel.loading && !panel.data) {
        body = `<div class="dash-drawer-body"><div class="dashboard-loading"><div class="spinner"></div><span>Loading…</span></div></div>`;
      } else if (panel.error && !panel.data) {
        body = `<div class="dash-drawer-body"><div class="dashboard-error">
          <span>Failed to load: ${escapeHtml(panel.error)}</span>
          <button type="button" class="group-ctrl-btn dash-retry-btn" data-period="${p.key}">Retry</button>
        </div></div>`;
      } else if (panel.data) {
        body = `<div class="dash-drawer-body">${renderDashboardContent(panel.data, panel.loading, p)}</div>`;
      } else {
        body = `<div class="dash-drawer-body"><div class="dashboard-loading"><div class="spinner"></div><span>Loading…</span></div></div>`;
      }
    }

    // Show inline summary when closed and data exists
    const preview = (!isOpen && panel.data) ? (() => {
      const d = panel.data;
      const totalSold = d.dailyLoadFactor.reduce((s, day) => s + day.overall.sold, 0);
      const totalLidded = d.dailyLoadFactor.reduce((s, day) => s + day.overall.lidded, 0);
      const lf = totalLidded > 0 ? (totalSold / totalLidded) * 100 : null;
      return `<span class="dash-drawer-preview">${d.totalFlights} flights · ${lf != null ? lf.toFixed(1) + '% LF' : '—'}</span>`;
    })() : '';

    return `<div class="dash-drawer" data-period="${p.key}">
      <div class="${headerClass}" data-period="${p.key}">
        <span class="dash-drawer-chevron">${chevron}</span>
        <span class="dash-drawer-label">${p.label}</span>
        <span class="dash-drawer-desc">${p.description}</span>
        ${preview}
      </div>
      ${body}
    </div>`;
  }).join('');

  return `<div class="dashboard">${drawers}</div>`;
}

function renderDashboardContent(d, isRefreshing, periodInfo) {
  const cabinOrder = ['J', 'W', 'Y'];
  const cabinLabel = { J: 'Business', W: 'Prem Econ', Y: 'Economy' };
  const cabinClass = { J: 'business', W: 'premium-economy', Y: 'economy' };
  const periodLabel = periodInfo.label.toLowerCase();

  // Daily LF cards
  const dailyCards = d.dailyLoadFactor.map(day => {
    const dateLabel = day.isToday ? 'Today' : fmtDashDate(day.date);
    const overallLf = day.overall.lf;
    const cabinLines = cabinOrder
      .filter(c => day.cabins[c])
      .map(c => {
        const cb = day.cabins[c];
        const lfVal = cb.lf != null ? `${cb.lf.toFixed(1)}%` : '—';
        const color = cb.lf != null ? lfColor(cb.lf) : '';
        return `<div class="daily-lf-cabin">
          <span class="cabin-badge ${cabinClass[c]}">${cabinLabel[c]}</span>
          <span class="daily-lf-cabin-val ${color}">${lfVal}</span>
        </div>`;
      }).join('');

    return `<div class="daily-lf-card">
      <div class="daily-lf-date">${dateLabel}</div>
      <div class="daily-lf-overall">
        <span class="daily-lf-pct ${overallLf != null ? lfColor(overallLf) : ''}">${overallLf != null ? overallLf.toFixed(1) + '%' : '—'}</span>
        ${overallLf != null ? `<div class="lf-bar-track"><div class="lf-bar-fill ${lfColor(overallLf)}" style="width:${Math.min(overallLf, 100)}%"></div></div>` : ''}
      </div>
      <div class="daily-lf-cabins">${cabinLines}</div>
      <div class="daily-lf-meta">${day.overall.sold.toLocaleString()} sold / ${day.overall.lidded.toLocaleString()} seats</div>
    </div>`;
  }).join('');

  // Route lists
  const renderRouteList = (routes, emptyMsg) => {
    if (!routes.length) return `<div class="route-empty">${emptyMsg}</div>`;
    return routes.map(r => `
      <div class="route-item" data-origin="${escapeAttr(r.origin)}" data-destination="${escapeAttr(r.destination)}">
        <span class="route-item-pair">${r.origin} → ${r.destination}</span>
        <span class="route-item-lf ${lfColor(r.lf)}">${r.lf.toFixed(1)}%</span>
        <span class="route-item-flights">${r.flights} flights</span>
      </div>
    `).join('');
  };

  // Alerts
  const renderAlertGroup = (title, items, type, tip) => {
    const tipIcon = tip ? ` <span class="info-icon" ${tooltipAttrs(tip)}>ⓘ</span>` : '';
    if (!items.length) return `<div class="alert-group"><div class="alert-group-title">${title}${tipIcon}</div><div class="alert-empty">None</div></div>`;
    const rows = items.map(a => {
      const val = type === 'overbooking'
        ? `${a.soldHeld}/${a.sellable}`
        : type === 'overbooking-lidded'
        ? `${a.soldHeld}/${a.lidded}`
        : `${a.lf.toFixed(1)}%`;
      const CABIN_FULL = { J: 'Business', W: 'Premium Economy', Y: 'Economy' };
      const dateTag = a.date ? `<span class="alert-date">${fmtIataDate(a.date)}</span>` : '<span class="alert-date"></span>';
      const cabinTip = CABIN_FULL[a.cabin] ? tooltipAttrs(`${a.cabin} — ${CABIN_FULL[a.cabin]}`) : '';
      return `<div class="alert-item ${type}">
        <span class="alert-flight">${a.flight}</span>
        ${dateTag}
        <span class="alert-cabin cabin-badge ${cabinClass[a.cabin] || 'other'}" ${cabinTip}>${a.cabin}</span>
        <span class="alert-route">${a.route}</span>
        <span class="alert-val">${val}</span>
      </div>`;
    }).join('');
    return `<div class="alert-group"><div class="alert-group-title">${title}${tipIcon}</div>${rows}</div>`;
  };

  // Stats row
  const totalSold = d.dailyLoadFactor.reduce((s, day) => s + day.overall.sold, 0);
  const totalLidded = d.dailyLoadFactor.reduce((s, day) => s + day.overall.lidded, 0);
  const overallLf = totalLidded > 0 ? (totalSold / totalLidded) * 100 : null;
  const dayCount = d.dailyLoadFactor.length;

  return `
    <div class="dashboard-header">
      <div class="dashboard-title">${d.dateRange.from} → ${d.dateRange.to}</div>
      <button type="button" class="group-ctrl-btn dash-refresh-btn" data-period="${periodInfo.key}"${isRefreshing ? ' disabled' : ''}>${isRefreshing ? 'Refreshing…' : 'Refresh'}</button>
    </div>

    <div class="dashboard-stats">
      <div class="summary-stat"><span class="stat-label">Total Flights</span><span class="stat-value">${d.totalFlights.toLocaleString()}</span></div>
      <div class="summary-stat"><span class="stat-label">Overall LF (${dayCount}d)</span><span class="stat-value ${overallLf != null ? lfColor(overallLf) : ''}">${overallLf != null ? overallLf.toFixed(1) + '%' : '—'}</span></div>
      <div class="summary-stat"><span class="stat-label">Environment</span><span class="stat-value">${state.selectedEnv}</span></div>
    </div>

    <div class="dashboard-section">
      <div class="dashboard-section-title">Daily Load Factor</div>
      <div class="daily-lf-grid">${dailyCards}</div>
    </div>

    <div class="route-panels">
      <div class="dashboard-section">
        <div class="dashboard-section-title">Highest LF Routes <span class="info-icon" ${tooltipAttrs(`Routes ranked by load factor (sold ÷ lidded capacity) across all cabins, aggregated over the ${periodLabel}`)}>ⓘ</span></div>
        <div class="route-list">${renderRouteList(d.topRoutes, 'No route data')}</div>
      </div>
      <div class="dashboard-section">
        <div class="dashboard-section-title">Lowest LF Routes <span class="info-icon" ${tooltipAttrs(`Routes ranked by load factor (sold ÷ lidded capacity) across all cabins, aggregated over the ${periodLabel}`)}>ⓘ</span></div>
        <div class="route-list">${renderRouteList(d.bottomRoutes, 'No route data')}</div>
      </div>
    </div>

    <div class="alert-section">
      ${renderAlertGroup('High LF (>95%)', d.alerts.highLF, 'high-lf', `Individual cabin-flights where sold ÷ lidded capacity exceeds 95%, over the ${periodLabel}`)}
      ${renderAlertGroup('Low LF (<40%)', d.alerts.lowLF, 'low-lf', `Individual cabin-flights where sold ÷ lidded capacity is below 40%, over the ${periodLabel}`)}
      ${renderAlertGroup('Oversold (Sellable)', d.alerts.overbooking, 'overbooking', `Cabin-flights where sold + held exceeds sellable capacity, over the ${periodLabel}`)}
      ${renderAlertGroup('Oversold (Lidded)', d.alerts.overbookingLidded || [], 'overbooking-lidded', `Cabin-flights where sold + held exceeds lidded (physical max) capacity, over the ${periodLabel}`)}
    </div>
  `;
}

function fmtDashDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const IATA_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function fmtIataDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getDate()}${IATA_MONTHS[d.getMonth()]}`;
}

function renderAccessDenied() {
  const signedInAs = state.user?.email ? `Signed in as ${state.user.email}.` : 'You are signed in.';
  return `
    <div class="state-container auth-denied">
      <div class="state-icon">🛡️</div>
      <div class="state-title">Access Not Granted</div>
      <div class="state-subtitle">${escapeHtml(state.accessDeniedMessage || 'Your account is not on the LoadFactor allowlist yet. Contact alex.zuttre@flyr.com to request access.')}</div>
      <div class="state-detail">${escapeHtml(signedInAs)} Ask alex.zuttre@flyr.com to add your email to the Firestore allowlist.</div>
      <div class="state-actions">
        <button type="button" class="secondary-btn" id="logout-btn-inline">Sign out</button>
      </div>
    </div>
  `;
}

function renderState(type, icon, title, subtitle) {
  return `<div class="state-container ${type}"><div class="state-icon">${icon}</div><div class="state-title">${title}</div><div class="state-subtitle">${subtitle}</div></div>`;
}

function renderSummary() {
  const rows = state.data.results;
  const avgSold = calcAvgLF(rows, 'sold');
  const avgManaged = calcAvgLF(rows, 'managed');
  const uniqueFlights = new Set(rows.map((row) => flightGroupKey(row))).size;
  const countLabel = uniqueFlights < state.data.count ? `${state.data.count} rows (${uniqueFlights} flights)` : `${state.data.count}`;
  return `<div class="summary-bar">
    <div class="summary-stat"><span class="stat-label">Flights × Cabins</span><span class="stat-value">${countLabel}</span></div>
    <div class="summary-stat"><span class="stat-label">Route</span><span class="stat-value">${state.data.origin} → ${state.data.destination}</span></div>
    <div class="summary-stat"><span class="stat-label">Period</span><span class="stat-value">${state.data.dateFrom} → ${state.data.dateTo}</span></div>
    <div class="summary-stat" ${tooltipAttrs(SOLD_LF_TOOLTIP)}><span class="stat-label">Avg Sold LF</span><span class="stat-value ${lfColor(avgSold)}">${avgSold.toFixed(1)}%</span></div>
    <div class="summary-stat" ${tooltipAttrs(MANAGED_LF_TOOLTIP)}><span class="stat-label">Avg Managed LF</span><span class="stat-value ${lfColor(avgManaged)}">${avgManaged.toFixed(1)}%</span></div>
  </div>`;
}

function flightGroupKey(row) {
  return `${row.departure_date}|${row.origin}|${row.destination}|${row.operating_flight_number}|${row.operational_suffix || ''}`;
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = flightGroupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const result = [];
  for (const [key, children] of groups) {
    if (children.length === 1) {
      result.push(children[0]);
    } else {
      const first = children[0];
      const sumField = (field) => children.reduce((sum, row) => sum + (row[field] ?? 0), 0);
      const sources = [...new Set(children.map((row) => row.sellable_update_source).filter(Boolean))];
      const timestamps = children.map((row) => row.quota_last_updated_at).filter(Boolean);
      const latest = timestamps.length ? timestamps.sort().pop() : null;
      result.push({
        ...first,
        physical_capacity: sumField('physical_capacity'),
        lidded_capacity: sumField('lidded_capacity'),
        sellable_capacity: sumField('sellable_capacity'),
        sold: sumField('sold'),
        held: sumField('held'),
        available: sumField('available'),
        cabin_code: null,
        cabin_name: null,
        sellable_update_source: sources.length === 1 ? sources[0] : sources.length > 1 ? 'Mixed' : null,
        quota_last_updated_at: latest,
        _isGroup: true,
        _children: children,
        _groupKey: key,
        _cabinCount: children.length,
      });
    }
  }
  return result;
}

function getDisplayRows() {
  if (!state.data) return [];
  const grouped = groupRows(state.data.results);
  const sorted = sortRows(grouped);
  const flattened = [];
  for (const row of sorted) {
    flattened.push(row);
    if (row._isGroup && state.expandedGroups.has(row._groupKey)) {
      for (const child of row._children) {
        flattened.push({ ...child, _isChild: true, _groupKey: row._groupKey });
      }
    }
  }
  return flattened;
}

function sortRows(rows) {
  if (!state.sortKey) return rows;
  const direction = state.sortDir === 'asc' ? 1 : -1;
  const key = state.sortKey;
  return [...rows].sort((left, right) => {
    let leftValue;
    let rightValue;
    switch (key) {
      case 'route': leftValue = `${left.origin}-${left.destination}`; rightValue = `${right.origin}-${right.destination}`; break;
      case 'flight': leftValue = `${left.operating_carrier_code}${left.operating_flight_number}`; rightValue = `${right.operating_carrier_code}${right.operating_flight_number}`; break;
      case 'sold_lf': leftValue = calcLF(left.sold, left.physical_capacity) ?? -1; rightValue = calcLF(right.sold, right.physical_capacity) ?? -1; break;
      case 'managed_lf': leftValue = calcLF(left.sold + left.held, left.sellable_capacity) ?? -1; rightValue = calcLF(right.sold + right.held, right.sellable_capacity) ?? -1; break;
      default: leftValue = left[key] ?? ''; rightValue = right[key] ?? '';
    }
    return typeof leftValue === 'number' && typeof rightValue === 'number'
      ? (leftValue - rightValue) * direction
      : String(leftValue).localeCompare(String(rightValue)) * direction;
  });
}

function expandAll() {
  const inputs = getSearchInputs();
  groupRows(state.data.results).filter(r => r._isGroup).forEach(r => state.expandedGroups.add(r._groupKey));
  render();
  restoreSearchInputs(inputs);
}

function collapseAll() {
  const inputs = getSearchInputs();
  state.expandedGroups.clear();
  render();
  restoreSearchInputs(inputs);
}

function toggleGroup(groupKey) {
  if (state.expandedGroups.has(groupKey)) state.expandedGroups.delete(groupKey);
  else state.expandedGroups.add(groupKey);
  const inputs = getSearchInputs();
  render();
  restoreSearchInputs(inputs);
}

function renderTable() {
  const rows = getDisplayRows();
  const columns = [
    { key: 'departure_date', label: 'Date' },
    { key: 'route', label: 'Route' },
    { key: 'flight', label: 'Flight' },
    { key: 'aircraft_type', label: 'Aircraft Type' },
    { key: 'cabin_name', label: 'Cabin' },
    { key: 'physical_capacity', label: 'Physical' },
    { key: 'lidded_capacity', label: 'Lidded' },
    { key: 'sellable_capacity', label: 'Sellable' },
    { key: 'sold', label: 'Sold' },
    { key: 'held', label: 'Held' },
    { key: 'available', label: 'Available' },
    { key: 'sold_lf', label: 'Sold LF', tip: `${SOLD_LF_TOOLTIP} - How full the flight is based on confirmed sales only` },
    { key: 'managed_lf', label: 'Managed LF', tip: `${MANAGED_LF_TOOLTIP} - Includes held (unconfirmed) bookings in the load` },
    { key: 'sellable_update_source', label: 'SC Source', tip: 'Source of the latest Sellable Capacity' },
    { key: 'quota_last_updated_at', label: 'SC Updated', tip: 'Time when the Sellable Capacity was last updated' },
  ];
  const head = columns.map((column) => {
    const sorted = state.sortKey === column.key;
    const sortedClass = sorted ? (state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc') : '';
    const tip = column.tip ? ` ${tooltipAttrs(column.tip)}` : '';
    const icon = column.tip ? ' <span class="info-icon">ⓘ</span>' : '';
    return `<th class="${sortedClass}" data-sort="${column.key}"${tip}>${column.label}${icon}</th>`;
  }).join('');

  const body = rows.map((row) => {
    const soldLF = calcLF(row.sold, row.physical_capacity);
    const managedLF = calcLF(row.sold + row.held, row.sellable_capacity);
    const isGroup = row._isGroup;
    const isChild = row._isChild;
    const expanded = isGroup && state.expandedGroups.has(row._groupKey);
    const rowClass = isGroup ? 'group-parent' : isChild ? 'group-child' : '';
    const cabinCol = isGroup ? `<span class="cabin-count-badge">${row._cabinCount} cabins</span>` : cabinBadge(row.cabin_name, row.cabin_code);
    const chevron = isGroup
      ? `<button type="button" class="group-toggle ${expanded ? 'expanded' : ''}" data-group-key="${escapeAttr(row._groupKey)}">▶</button>`
      : isChild ? '<span class="child-indent"></span>' : '';

    return `<tr class="${rowClass}"${isGroup ? ` data-group-key="${escapeAttr(row._groupKey)}"` : ''}>
      <td class="date-cell">${chevron}${row.departure_date || '—'}</td>
      <td><div class="route-cell">${row.origin} <span class="route-arrow">→</span> ${row.destination}</div></td>
      <td><div class="flight-cell"><span class="flight-carrier">${row.operating_carrier_code}</span><span class="flight-number">${row.operating_flight_number}</span>${row.operational_suffix ? `<span class="flight-suffix">${row.operational_suffix}</span>` : ''}${trackerCopyButton(row.tracker_id)}</div></td>
      <td class="aircraft-td" data-tracker-id="${escapeAttr(row.tracker_id || '')}">${aircraftTypeCell(row.aircraft_type, row.seat_map_name, row.seat_map_id)}</td>
      <td>${cabinCol}</td>
      <td class="col-num">${fmtN(row.physical_capacity)}</td><td class="col-num">${fmtN(row.lidded_capacity)}</td><td class="col-num">${fmtN(row.sellable_capacity)}</td>
      <td class="col-num">${fmtN(row.sold)}</td><td class="col-num">${fmtN(row.held)}</td>
      <td class="col-num" style="color:${row.available != null && row.available < 0 ? 'var(--lf-red)' : 'var(--foreground)'}">${fmtN(row.available)}</td>
      <td>${lfBar(soldLF)}</td><td>${lfBar(managedLF)}</td>
      <td>${srcBadge(row.sellable_update_source)}</td><td class="ts-cell">${fmtTS(row.quota_last_updated_at)}</td>
    </tr>`;
  }).join('');

  const groups = getDisplayRows().filter(r => r._isGroup);
  const allExpanded = groups.length > 0 && groups.every(r => state.expandedGroups.has(r._groupKey));
  const anyExpanded = groups.some(r => state.expandedGroups.has(r._groupKey));
  const groupControls = groups.length > 0
    ? `<div class="table-group-controls">
        <button type="button" class="group-ctrl-btn" id="expand-all-btn" ${allExpanded ? 'disabled' : ''}>Expand all</button>
        <button type="button" class="group-ctrl-btn" id="collapse-all-btn" ${!anyExpanded ? 'disabled' : ''}>Collapse all</button>
       </div>`
    : '';

  return `<div class="table-toolbar">${groupControls}</div><div class="table-container"><div class="table-scroll"><table class="data-table" id="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}

function cabinBadge(name, code) {
  const style = code === 2 ? 'business' : code === 4 ? 'premium-economy' : code === 5 ? 'economy' : 'other';
  return `<span class="cabin-badge ${style}">${name}</span>`;
}

function lfBar(percent) {
  if (percent == null) return '<span class="col-num" style="color:var(--muted-foreground)">—</span>';
  const width = Math.min(percent, 100);
  const color = lfColor(percent);
  return `<div class="lf-cell"><div class="lf-bar-track"><div class="lf-bar-fill ${color}" style="width:${width}%"></div></div><span class="lf-value ${color}">${percent.toFixed(1)}%</span></div>`;
}

function srcBadge(source) {
  if (!source) return '<span class="source-badge unknown">N/A</span>';
  if (source.includes('Sabre')) return `<span class="source-badge sabre">${source}</span>`;
  if (source.toLowerCase().includes('manual')) return `<span class="source-badge manual">${source}</span>`;
  return `<span class="source-badge unknown">${source}</span>`;
}

function trackerCopyButton(id) {
  if (!id) return '';
  return `<button type="button" class="tracker-copy-btn" data-tracker-id="${id}" ${tooltipAttrs(`Tracker ID: ${id} · Click to copy`)}>⧉</button>`;
}

function aircraftTypeCell(aircraftType, seatMapName, seatMapId) {
  if (!aircraftType) return '—';
  const tooltip = seatMapTooltip(seatMapName, seatMapId);
  const icon = tooltip ? `<button type="button" class="aircraft-copy-btn" data-seat-map-id="${escapeAttr(seatMapId || '')}" ${tooltipAttrs(tooltip)}>⧉</button>` : '';
  return `<span class="aircraft-type-cell"><span>${aircraftType}</span>${icon}</span>`;
}

function seatMapTooltip(seatMapName, seatMapId) {
  if (!seatMapName && !seatMapId) return '';
  if (seatMapName && seatMapId) return `Seat map: ${seatMapName}\nID: ${seatMapId}\nClick to copy ID`;
  if (seatMapName) return `Seat map: ${seatMapName}`;
  return `Seat map ID: ${seatMapId}`;
}

function renderFooter() {
  const env = state.environments.find((entry) => entry.name === state.selectedEnv);
  const project = env ? env.project : 'prj-rx-prd-ooms-6f6c';
  const identity = state.user?.email ? ` · ${state.user.email}` : '';
  return `<footer class="footer">Stock Keeper Spanner · ${project} · ${state.selectedEnv}${identity} · Read-only queries · Data is not stored</footer>`;
}

function bindEvents() {
  const searchPanel = document.getElementById('search-panel');
  if (searchPanel) {
    searchPanel.addEventListener('click', onPanelClick);
    searchPanel.addEventListener('mouseover', onPanelHover);
    searchPanel.addEventListener('mouseout', onPanelOut);
  }
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
  const expandAllBtn = document.getElementById('expand-all-btn');
  if (expandAllBtn) expandAllBtn.addEventListener('click', expandAll);
  const collapseAllBtn = document.getElementById('collapse-all-btn');
  if (collapseAllBtn) collapseAllBtn.addEventListener('click', collapseAll);
  const envSelect = document.getElementById('env-select');
  if (envSelect) envSelect.addEventListener('change', (event) => {
    const inputs = getSearchInputs();
    const shouldRepeatSearch = Boolean(state.data || state.error || state.loading);
    state.selectedEnv = event.target.value;
    render();
    prewarmSeatMaps(state.selectedEnv);
    if (shouldRepeatSearch) handleSearch(inputs);
    else { restoreSearchInputs(inputs); state.dashboardPanels = {}; loadDashboard(state.selectedEnv); }
  });
  const logoutButton = document.getElementById('logout-btn');
  if (logoutButton) logoutButton.addEventListener('click', handleLogout);
  const inlineLogoutButton = document.getElementById('logout-btn-inline');
  if (inlineLogoutButton) inlineLogoutButton.addEventListener('click', handleLogout);
  // Dashboard drawer events
  document.querySelectorAll('.dash-drawer-header').forEach(el => {
    el.addEventListener('click', () => toggleDashboardPeriod(el.dataset.period));
  });
  document.querySelectorAll('.dash-refresh-btn').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); loadDashboard(state.selectedEnv, el.dataset.period); });
  });
  document.querySelectorAll('.dash-retry-btn').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); loadDashboard(state.selectedEnv, el.dataset.period); });
  });
  document.querySelectorAll('.route-item[data-origin]').forEach(el => {
    el.addEventListener('click', () => {
      const originInput = document.getElementById('origin');
      const destInput = document.getElementById('destination');
      if (originInput) originInput.value = el.dataset.origin;
      if (destInput) destInput.value = el.dataset.destination;
    });
  });
  document.querySelectorAll('.iata-input').forEach((input) => input.addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z]/g, ''); }));
  document.querySelectorAll('.flight-filter-input').forEach((input) => input.addEventListener('input', (event) => { event.target.value = event.target.value.replace(/[^\d,\-\s]/g, ''); }));
  document.querySelectorAll('.data-table th[data-sort]').forEach((th) => th.addEventListener('click', () => handleSort(th.dataset.sort)));
  document.querySelectorAll('.tracker-copy-btn').forEach((button) => button.addEventListener('click', handleTrackerCopy));
  document.querySelectorAll('.aircraft-copy-btn').forEach((button) => button.addEventListener('click', handleSeatMapCopy));
  document.querySelectorAll('.group-toggle').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); toggleGroup(button.dataset.groupKey); }));
  document.querySelectorAll('tr.group-parent').forEach((row) => row.addEventListener('click', () => { toggleGroup(row.dataset.groupKey); }));
}

function onPanelClick(event) {
  if (event.target.closest('#date-range-trigger')) {
    event.stopPropagation();
    state.calendarOpen = !state.calendarOpen;
    if (state.calendarOpen && state.dateFrom) {
      const date = new Date(`${state.dateFrom}T00:00:00`);
      state.calendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      state.selectingEnd = false;
    }
    updateCalendar();
    return;
  }
  if (event.target.closest('.calendar-dropdown')) event.stopPropagation();
  const day = event.target.closest('.day-cell[data-date]');
  if (day) { event.stopPropagation(); handleDayClick(day.dataset.date); return; }
  const nav = event.target.closest('.cal-nav');
  if (nav) { event.stopPropagation(); state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + Number.parseInt(nav.dataset.dir, 10), 1); updateCalendar(); return; }
  const pill = event.target.closest('.cabin-pill');
  if (pill) { handleCabinClick(pill.dataset.cabin); return; }
  if (event.target.closest('#search-btn')) handleSearch();
}

function onPanelHover(event) {
  if (!state.selectingEnd || !state.dateFrom) return;
  const day = event.target.closest('.day-cell[data-date]');
  if (!day) return;
  const hoverDate = day.dataset.date;
  document.querySelectorAll('.day-cell.hover-range,.day-cell.hover-end').forEach((element) => element.classList.remove('hover-range', 'hover-end'));
  if (hoverDate >= state.dateFrom) {
    document.querySelectorAll('.day-cell[data-date]').forEach((element) => {
      const date = element.dataset.date;
      if (date > state.dateFrom && date < hoverDate) element.classList.add('hover-range');
      else if (date === hoverDate) element.classList.add('hover-end');
    });
  }
}

function onPanelOut(event) {
  if (!event.target.closest('.calendar-dropdown')) return;
  document.querySelectorAll('.day-cell.hover-range,.day-cell.hover-end').forEach((element) => element.classList.remove('hover-range', 'hover-end'));
}

function handleDayClick(dateString) {
  if (!state.selectingEnd) {
    state.dateFrom = dateString;
    state.dateTo = null;
    state.selectingEnd = true;
  } else {
    if (dateString < state.dateFrom) { state.dateTo = state.dateFrom; state.dateFrom = dateString; }
    else state.dateTo = dateString;
    state.selectingEnd = false;
    state.calendarOpen = false;
  }
  updateCalendar();
}

function handleCabinClick(cabin) {
  if (cabin === 'all') state.selectedCabins = [];
  else {
    const code = Number.parseInt(cabin, 10);
    const index = state.selectedCabins.indexOf(code);
    if (index >= 0) state.selectedCabins.splice(index, 1);
    else state.selectedCabins.push(code);
    if (state.selectedCabins.length === 3) state.selectedCabins = [];
  }
  document.querySelectorAll('.cabin-pill').forEach((pill) => {
    const value = pill.dataset.cabin;
    pill.classList.toggle('active', value === 'all' ? state.selectedCabins.length === 0 : state.selectedCabins.includes(Number.parseInt(value, 10)));
  });
}

async function handleSearch(searchInputs = null) {
  if (!state.authorized || !state.dateFrom || !state.dateTo) return;
  const { origin, dest, flights } = searchInputs ?? getSearchInputs();
  const searchSeq = ++activeSearchSeq;
  state = { ...state, loading: true, error: null, data: null, sortKey: null, sortDir: 'asc', calendarOpen: false, expandedGroups: new Set() };
  render();
  restoreSearchInputs({ origin, dest, flights });

  try {
    const params = new URLSearchParams({ dateFrom: state.dateFrom, dateTo: state.dateTo });
    if (origin) params.set('origin', origin);
    if (dest) params.set('destination', dest);
    if (flights) params.set('flights', flights);
    if (state.selectedCabins.length) params.set('cabins', state.selectedCabins.join(','));
    params.set('env', state.selectedEnv);
    const data = await fetchJsonOrThrow(`/api/loadfactor?${params}`);
    if (searchSeq !== activeSearchSeq) return;
    state = { ...state, loading: false, data };
  } catch (error) {
    if (searchSeq !== activeSearchSeq || isAuthRedirectError(error)) return;
    state = { ...state, loading: false, error: error.message };
  }

  if (searchSeq !== activeSearchSeq) return;
  render();
  restoreSearchInputs({ origin, dest, flights });
  if (state.data?.results?.length) fetchAircraftAsync(searchSeq, state.selectedEnv);
}

async function fetchAircraftAsync(searchSeq, searchEnv) {
  const results = state.data?.results;
  if (!results) return;
  const trackerIds = [...new Set(results.map((row) => row.tracker_id).filter(Boolean))];
  if (!trackerIds.length) return;
  try {
    const details = await fetchJsonOrThrow('/api/aircraft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: searchEnv, trackerIds }),
    });
    if (searchSeq !== activeSearchSeq || searchEnv !== state.selectedEnv || state.data?.results !== results) return;
    let changed = false;
    for (const row of results) {
      const detail = details[row.tracker_id];
      if (!detail) continue;
      row.aircraft_type = detail.aircraft_type ?? row.aircraft_type;
      row.seat_map_id = detail.seat_map_id ?? row.seat_map_id;
      row.seat_map_name = detail.seat_map_name ?? row.seat_map_name;
      changed = true;
    }
    if (changed) {
      document.querySelectorAll('td.aircraft-td[data-tracker-id]').forEach((cell) => {
        const trackerId = cell.dataset.trackerId;
        const detail = details[trackerId];
        if (!detail) return;
        const html = aircraftTypeCell(detail.aircraft_type, detail.seat_map_name, detail.seat_map_id);
        if (cell.innerHTML !== html) cell.innerHTML = html;
      });
    }
  } catch {
    // Aircraft enrichment is best-effort.
  }
}

async function handleLogout() {
  try {
    await fetch('/auth/logout', { method: 'POST' });
  } catch {
    // Ignore logout failures and continue.
  }

  if (state.user?.isDevBypass) {
    window.location.reload();
    return;
  }
  redirectToLogin();
}

async function handleTrackerCopy(event) {
  event.stopPropagation();
  const button = event.currentTarget;
  const id = button.dataset.trackerId;
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    const previous = button.textContent;
    button.textContent = '✓';
    setTimeout(() => { button.textContent = previous; }, 900);
  } catch {
    // Keep the UI quiet on clipboard failures.
  }
}

async function handleSeatMapCopy(event) {
  event.stopPropagation();
  const button = event.currentTarget;
  const seatMapId = button.dataset.seatMapId;
  if (!seatMapId) return;
  try {
    await navigator.clipboard.writeText(seatMapId);
    const previous = button.textContent;
    button.textContent = '✓';
    setTimeout(() => { button.textContent = previous; }, 900);
  } catch {
    // Keep the UI quiet on clipboard failures.
  }
}

function ensureTooltip() {
  if (tooltipEl) return;
  tooltipEl = document.createElement('div');
  tooltipEl.id = 'app-tooltip';
  tooltipEl.className = 'app-tooltip';
  document.body.appendChild(tooltipEl);
}

function handleTooltipMouseOver(event) {
  const target = event.target.closest('[data-tooltip]');
  if (!target) return;
  activeTooltipTarget = target;
  showTooltip(target);
}

function handleTooltipMouseOut(event) {
  const target = event.target.closest('[data-tooltip]');
  if (!target) return;
  const related = event.relatedTarget;
  if (related instanceof Node && target.contains(related)) return;
  if (activeTooltipTarget === target) {
    activeTooltipTarget = null;
    hideTooltip();
  }
}

function handleTooltipMouseMove(event) {
  if (!activeTooltipTarget) return;
  updateTooltipPosition(activeTooltipTarget, event);
}

function showTooltip(target) {
  ensureTooltip();
  const text = target.getAttribute('data-tooltip');
  if (!text) return;
  tooltipEl.textContent = text;
  tooltipEl.classList.add('visible');
  updateTooltipPosition(target);
}

function hideTooltip() {
  if (!tooltipEl) return;
  tooltipEl.classList.remove('visible');
}

function updateTooltipPosition(target, mouseEvent) {
  if (!tooltipEl || !target || !tooltipEl.classList.contains('visible')) return;
  const rect = target.getBoundingClientRect();
  const preferBelow = Boolean(target.closest('.data-table tbody'));
  const margin = 10;
  const tooltipRect = tooltipEl.getBoundingClientRect();
  let top = preferBelow ? rect.bottom + margin : rect.top - tooltipRect.height - margin;
  if (top < 8) top = rect.bottom + margin;
  if (top + tooltipRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - tooltipRect.height - margin);

  let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
  if (mouseEvent && tooltipRect.width < 220) left = mouseEvent.clientX - tooltipRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tooltipRect.width - 8));

  tooltipEl.style.top = `${top}px`;
  tooltipEl.style.left = `${left}px`;
}

function handleSort(key) {
  if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  else { state.sortKey = key; state.sortDir = 'asc'; }
  const inputs = getSearchInputs();
  render();
  restoreSearchInputs(inputs);
}

function isoDate(date) { return date.toISOString().split('T')[0]; }
function calcLF(numerator, denominator) { return denominator > 0 && numerator != null ? (numerator / denominator) * 100 : null; }
function calcAvgLF(rows, type) {
  const validRows = rows.filter((row) => type === 'sold' ? row.physical_capacity > 0 : row.sellable_capacity > 0);
  if (!validRows.length) return 0;
  return validRows.reduce((sum, row) => sum + (type === 'sold' ? calcLF(row.sold, row.physical_capacity) : calcLF(row.sold + row.held, row.sellable_capacity)), 0) / validRows.length;
}
function lfColor(percent) { return percent == null ? '' : percent < 70 ? 'lf-green' : percent < 90 ? 'lf-amber' : 'lf-red'; }
function fmtN(value) { return value == null ? '—' : value.toLocaleString('en-US'); }
function fmtTS(value) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }); } catch { return value; }
}
function fmtRange(from, to) {
  if (!from) return 'Select dates';
  const fromDate = new Date(`${from}T00:00:00`);
  const toDate = to ? new Date(`${to}T00:00:00`) : null;
  const fromString = `${fromDate.getDate()} ${MONTHS_SHORT[fromDate.getMonth()]}`;
  if (!toDate || from === to) return `${fromString} ${fromDate.getFullYear()}`;
  const toString = `${toDate.getDate()} ${MONTHS_SHORT[toDate.getMonth()]}`;
  const year = fromDate.getFullYear() === toDate.getFullYear() ? ` ${toDate.getFullYear()}` : ` ${fromDate.getFullYear()} – ${toString} ${toDate.getFullYear()}`;
  return fromDate.getFullYear() === toDate.getFullYear() ? `${fromString} – ${toString}${year}` : `${fromString} ${fromDate.getFullYear()} – ${toString} ${toDate.getFullYear()}`;
}
function tooltipAttrs(text) { return `data-tooltip="${escapeAttr(text)}"`; }
function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escapeHtml(text) { return escapeAttr(text); }
