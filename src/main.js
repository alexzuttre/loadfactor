import './style.css';

// ── Constants ──────────────────────────────────────────────────────────────
const CABINS = [
  { code: 2, label: 'Business', cls: 'business' },
  { code: 4, label: 'Prem Econ', cls: 'premium-economy' },
  { code: 5, label: 'Economy', cls: 'economy' },
];
const WEEKDAYS = ['Su','Mo','Tu','We','Th','Fr','Sa'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const SOLD_LF_TOOLTIP = 'Sold ÷ Physical Capacity × 100';
const MANAGED_LF_TOOLTIP = '(Sold + Held) ÷ Sellable Capacity × 100';

// ── State ──────────────────────────────────────────────────────────────────
const now = new Date();
const todayStr = isoDate(now);
const DEFAULT_RANGE_DAYS = 2;

let state = {
  loading: false, error: null, data: null,
  sortKey: null, sortDir: 'asc',
  dateFrom: todayStr,
  dateTo: isoDate(new Date(now.getTime() + (DEFAULT_RANGE_DAYS - 1) * 86400000)),
  calendarOpen: false,
  calendarMonth: new Date(now.getFullYear(), now.getMonth(), 1),
  selectingEnd: false,
  selectedCabins: [],
  selectedEnv: 'rx-prd',
  environments: [],
  expandedGroups: new Set(),
};
let tooltipEl = null;
let activeTooltipTarget = null;
let activeSearchSeq = 0;

// ── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  render(); setupGlobal();
  try {
    const res = await fetch('/api/environments');
    if (res.ok) { state.environments = await res.json(); render(); }
  } catch { /* use default env list */ }
  prewarmSeatMaps(state.selectedEnv);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

function setupGlobal() {
  ensureTooltip();
  document.addEventListener('click', () => { if (state.calendarOpen) closeCalendar(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.calendarOpen) closeCalendar(); });
  document.addEventListener('mouseover', handleTooltipMouseOver);
  document.addEventListener('mouseout', handleTooltipMouseOut);
  document.addEventListener('mousemove', handleTooltipMouseMove);
  window.addEventListener('scroll', () => updateTooltipPosition(activeTooltipTarget), true);
  window.addEventListener('resize', () => updateTooltipPosition(activeTooltipTarget));
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

// ── Full Render ────────────────────────────────────────────────────────────
function render() {
  document.getElementById('app').innerHTML =
    renderHeader() + renderSearchPanel() + renderContent() + renderFooter();
  bindEvents();
}

function renderHeader() {
  const isProd = state.selectedEnv === 'rx-prd';
  const badgeClass = isProd ? 'env-badge env-prod' : 'env-badge env-nonprod';
  const envList = state.environments.length
    ? state.environments
    : [{ name: 'rx-prd', isProd: true }];
  const options = envList.map(e =>
    `<option value="${e.name}" ${e.name === state.selectedEnv ? 'selected' : ''}>${e.name}</option>`
  ).join('');
  return `<header class="header"><div class="header-left"><div class="header-icon">📊</div><h1>LoadFactor Dashboard</h1></div><div class="${badgeClass}"><select id="env-select" class="env-select">${options}</select></div></header>`;
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
        <button type="button" class="search-btn" id="search-btn" ${state.loading?'disabled':''}>${state.loading?'<div class="spinner"></div> Querying…':'🔍 Search'}</button>
      </div>
      <div class="search-row-secondary">
        <label class="filter-label">Cabin</label>
        <div class="cabin-filter" id="cabin-filter">
          <button type="button" class="cabin-pill ${state.selectedCabins.length===0?'active':''}" data-cabin="all">All</button>
          ${CABINS.map(c=>`<button type="button" class="cabin-pill ${c.cls} ${state.selectedCabins.includes(c.code)?'active':''}" data-cabin="${c.code}">${c.label}</button>`).join('')}
        </div>
      </div>
    </div>
  </section>`;
}

// ── Calendar ───────────────────────────────────────────────────────────────
function renderCalendarInner() {
  const m1 = state.calendarMonth;
  const m2 = new Date(m1.getFullYear(), m1.getMonth()+1, 1);
  const hint = state.selectingEnd ? 'Select end date' : 'Select start date';
  return `
    <div class="cal-header">
      <button type="button" class="cal-nav" data-dir="-1">‹</button>
      <span class="cal-title">${MONTHS[m1.getMonth()]} ${m1.getFullYear()}</span>
      <span class="cal-title">${MONTHS[m2.getMonth()]} ${m2.getFullYear()}</span>
      <button type="button" class="cal-nav" data-dir="1">›</button>
    </div>
    <div class="cal-hint">${hint}</div>
    <div class="cal-months">${renderMonthGrid(m1.getFullYear(),m1.getMonth())}${renderMonthGrid(m2.getFullYear(),m2.getMonth())}</div>`;
}

function renderMonthGrid(y, m) {
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m+1, 0).getDate();
  let h = '<div class="cal-month"><div class="cal-weekdays">' + WEEKDAYS.map(d=>`<div class="cal-wd">${d}</div>`).join('') + '</div><div class="cal-grid">';
  for (let i=0;i<first;i++) h+='<div class="day-cell empty"></div>';
  for (let d=1;d<=days;d++) {
    const ds = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    h += `<div class="${dayClasses(ds)}" data-date="${ds}">${d}</div>`;
  }
  const rem = (7-(first+days)%7)%7;
  for (let i=0;i<rem;i++) h+='<div class="day-cell empty"></div>';
  return h + '</div></div>';
}

function dayClasses(ds) {
  const c = ['day-cell'];
  if (ds === todayStr) c.push('today');
  if (ds === state.dateFrom) c.push('selected-start');
  if (ds === state.dateTo) c.push('selected-end');
  if (state.dateFrom && state.dateTo && ds > state.dateFrom && ds < state.dateTo) c.push('in-range');
  return c.join(' ');
}

function updateCalendar() {
  const dd = document.getElementById('calendar-dropdown');
  if (dd) { dd.innerHTML = renderCalendarInner(); dd.classList.toggle('visible', state.calendarOpen); }
  const tr = document.getElementById('date-range-trigger');
  if (tr) tr.querySelector('.trigger-text').textContent = fmtRange(state.dateFrom, state.dateTo);
}

function closeCalendar() {
  state.calendarOpen = false;
  if (state.selectingEnd && !state.dateTo) { state.dateTo = state.dateFrom; state.selectingEnd = false; }
  updateCalendar();
}

// ── Content Rendering ──────────────────────────────────────────────────────
function renderContent() {
  if (state.loading) return renderState('loading','✈️','Querying Stock Keeper…',`Fetching live load factor data from ${state.selectedEnv} Spanner`);
  if (state.error) return renderState('error','⚠️','Query Failed',state.error);
  if (!state.data) return renderState('idle','🛫','Ready to Search','Select a date range and optionally filter by origin and destination, then hit Search.');
  if (state.data.results.length === 0) return renderState('empty','📭','No Flights Found',`No CAPACITY trackers matched for ${state.data.origin} → ${state.data.destination}, ${state.data.dateFrom} to ${state.data.dateTo}.`);
  return renderSummary() + renderTable();
}

function renderState(type,icon,title,sub) {
  return `<div class="state-container ${type}"><div class="state-icon">${icon}</div><div class="state-title">${title}</div><div class="state-subtitle">${sub}</div></div>`;
}

function renderSummary() {
  const d = state.data, rows = d.results;
  const avgS = calcAvgLF(rows,'sold'), avgM = calcAvgLF(rows,'managed');
  const uniqueFlights = new Set(rows.map(r => flightGroupKey(r))).size;
  const countLabel = uniqueFlights < d.count ? `${d.count} rows (${uniqueFlights} flights)` : `${d.count}`;
  return `<div class="summary-bar">
    <div class="summary-stat"><span class="stat-label">Flights × Cabins</span><span class="stat-value">${countLabel}</span></div>
    <div class="summary-stat"><span class="stat-label">Route</span><span class="stat-value">${d.origin} → ${d.destination}</span></div>
    <div class="summary-stat"><span class="stat-label">Period</span><span class="stat-value">${d.dateFrom} → ${d.dateTo}</span></div>
    <div class="summary-stat" ${tooltipAttrs(SOLD_LF_TOOLTIP)}><span class="stat-label">Avg Sold LF</span><span class="stat-value ${lfColor(avgS)}">${avgS.toFixed(1)}%</span></div>
    <div class="summary-stat" ${tooltipAttrs(MANAGED_LF_TOOLTIP)}><span class="stat-label">Avg Managed LF</span><span class="stat-value ${lfColor(avgM)}">${avgM.toFixed(1)}%</span></div>
  </div>`;
}

// ── Flight Row Grouping ───────────────────────────────────────────────────
function flightGroupKey(r) {
  return `${r.departure_date}|${r.origin}|${r.destination}|${r.operating_flight_number}|${r.operational_suffix || ''}`;
}

function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = flightGroupKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const result = [];
  for (const [key, children] of groups) {
    if (children.length === 1) {
      result.push(children[0]);
    } else {
      const first = children[0];
      const sumField = (f) => children.reduce((s, r) => s + (r[f] ?? 0), 0);
      const sources = [...new Set(children.map(r => r.sellable_update_source).filter(Boolean))];
      const timestamps = children.map(r => r.quota_last_updated_at).filter(Boolean);
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
  // Flatten: insert children after their expanded parent
  const flat = [];
  for (const row of sorted) {
    flat.push(row);
    if (row._isGroup && state.expandedGroups.has(row._groupKey)) {
      for (const child of row._children) {
        flat.push({ ...child, _isChild: true, _groupKey: row._groupKey });
      }
    }
  }
  return flat;
}

function sortRows(rows) {
  if (!state.sortKey) return rows;
  const dir = state.sortDir === 'asc' ? 1 : -1, k = state.sortKey;
  return [...rows].sort((a, b) => {
    let va, vb;
    switch (k) {
      case 'route': va=`${a.origin}-${a.destination}`; vb=`${b.origin}-${b.destination}`; break;
      case 'flight': va=`${a.operating_carrier_code}${a.operating_flight_number}`; vb=`${b.operating_carrier_code}${b.operating_flight_number}`; break;
      case 'sold_lf': va=calcLF(a.sold,a.physical_capacity)??-1; vb=calcLF(b.sold,b.physical_capacity)??-1; break;
      case 'managed_lf': va=calcLF(a.sold+a.held,a.sellable_capacity)??-1; vb=calcLF(b.sold+b.held,b.sellable_capacity)??-1; break;
      default: va=a[k]??''; vb=b[k]??'';
    }
    return typeof va==='number'&&typeof vb==='number' ? (va-vb)*dir : String(va).localeCompare(String(vb))*dir;
  });
}

function toggleGroup(groupKey) {
  if (state.expandedGroups.has(groupKey)) state.expandedGroups.delete(groupKey);
  else state.expandedGroups.add(groupKey);
  const o = document.getElementById('origin')?.value || '';
  const d = document.getElementById('destination')?.value || '';
  const f = document.getElementById('flights')?.value || '';
  render();
  if (document.getElementById('origin')) document.getElementById('origin').value = o;
  if (document.getElementById('destination')) document.getElementById('destination').value = d;
  if (document.getElementById('flights')) document.getElementById('flights').value = f;
}

// ── Table Rendering ───────────────────────────────────────────────────────
function renderTable() {
  const rows = getDisplayRows();
  const cols = [
    {key:'departure_date',label:'Date'},{key:'route',label:'Route'},{key:'flight',label:'Flight'},
    {key:'aircraft_type',label:'Aircraft Type'},{key:'cabin_name',label:'Cabin'},{key:'physical_capacity',label:'Physical',num:1},
    {key:'lidded_capacity',label:'Lidded',num:1},{key:'sellable_capacity',label:'Sellable',num:1},
    {key:'sold',label:'Sold',num:1},{key:'held',label:'Held',num:1},{key:'available',label:'Available',num:1},
    {key:'sold_lf',label:'Sold LF',tip:`${SOLD_LF_TOOLTIP} - How full the flight is based on confirmed sales only`},
    {key:'managed_lf',label:'Managed LF',tip:`${MANAGED_LF_TOOLTIP} - Includes held (unconfirmed) bookings in the load`},
    {key:'sellable_update_source',label:'Source'},{key:'quota_last_updated_at',label:'Last Updated'},
  ];
  const th = cols.map(c => {
    const s = state.sortKey===c.key;
    const sc = s ? (state.sortDir==='asc'?'sorted-asc':'sorted-desc') : '';
    const tip = c.tip ? ` ${tooltipAttrs(c.tip)}` : '';
    const icon = c.tip ? ' <span class="info-icon">ⓘ</span>' : '';
    return `<th class="${sc}" data-sort="${c.key}"${tip}>${c.label}${icon}</th>`;
  }).join('');

  const tb = rows.map(r => {
    const sLF = calcLF(r.sold, r.physical_capacity);
    const mLF = calcLF(r.sold+r.held, r.sellable_capacity);
    const isGroup = r._isGroup;
    const isChild = r._isChild;
    const expanded = isGroup && state.expandedGroups.has(r._groupKey);
    const trClass = isGroup ? 'group-parent' : isChild ? 'group-child' : '';

    // Cabin column content
    const cabinCol = isGroup
      ? `<span class="cabin-count-badge">${r._cabinCount} cabins</span>`
      : cabinBadge(r.cabin_name, r.cabin_code);

    // Date cell: add toggle chevron for group parents
    const chevron = isGroup
      ? `<button type="button" class="group-toggle ${expanded?'expanded':''}" data-group-key="${escapeAttr(r._groupKey)}">▶</button>`
      : isChild ? '<span class="child-indent"></span>' : '';

    return `<tr class="${trClass}"${isGroup ? ` data-group-key="${escapeAttr(r._groupKey)}"` : ''}>
      <td class="date-cell">${chevron}${r.departure_date||'—'}</td>
      <td><div class="route-cell">${r.origin} <span class="route-arrow">→</span> ${r.destination}</div></td>
      <td><div class="flight-cell"><span class="flight-carrier">${r.operating_carrier_code}</span><span class="flight-number">${r.operating_flight_number}</span>${r.operational_suffix?`<span class="flight-suffix">${r.operational_suffix}</span>`:''}${trackerCopyButton(r.tracker_id)}</div></td>
      <td class="aircraft-td" data-tracker-id="${escapeAttr(r.tracker_id||'')}">${aircraftTypeCell(r.aircraft_type, r.seat_map_name, r.seat_map_id)}</td>
      <td>${cabinCol}</td>
      <td class="col-num">${fmtN(r.physical_capacity)}</td><td class="col-num">${fmtN(r.lidded_capacity)}</td><td class="col-num">${fmtN(r.sellable_capacity)}</td>
      <td class="col-num">${fmtN(r.sold)}</td><td class="col-num">${fmtN(r.held)}</td>
      <td class="col-num" style="color:${r.available!=null&&r.available<0?'var(--lf-red)':'var(--text-primary)'}">${fmtN(r.available)}</td>
      <td>${lfBar(sLF)}</td><td>${lfBar(mLF)}</td>
      <td>${srcBadge(r.sellable_update_source)}</td><td class="ts-cell">${fmtTS(r.quota_last_updated_at)}</td>
    </tr>`;
  }).join('');

  return `<div class="table-container"><div class="table-scroll"><table class="data-table" id="data-table"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div></div>`;
}

function cabinBadge(n,c) { const s=c===2?'business':c===4?'premium-economy':c===5?'economy':'other'; return `<span class="cabin-badge ${s}">${n}</span>`; }
function lfBar(p) {
  if (p==null) return '<span class="col-num" style="color:var(--text-muted)">—</span>';
  const w=Math.min(p,100), c=lfColor(p);
  return `<div class="lf-cell"><div class="lf-bar-track"><div class="lf-bar-fill ${c}" style="width:${w}%"></div></div><span class="lf-value ${c}">${p.toFixed(1)}%</span></div>`;
}
function srcBadge(s) {
  if (!s) return '<span class="source-badge unknown">N/A</span>';
  if (s.includes('Sabre')) return `<span class="source-badge sabre">${s}</span>`;
  if (s.toLowerCase().includes('manual')) return `<span class="source-badge manual">${s}</span>`;
  return `<span class="source-badge unknown">${s}</span>`;
}
function trackerCopyButton(id) {
  if (!id) return '';
  return `<button type="button" class="tracker-copy-btn" data-tracker-id="${id}" ${tooltipAttrs(`Tracker ID: ${id} · Click to copy`)}>⧉</button>`;
}
function aircraftTypeCell(aircraftType, seatMapName, seatMapId) {
  if (!aircraftType) return '—';
  const tooltip = seatMapTooltip(seatMapName, seatMapId);
  const icon = tooltip
    ? `<button type="button" class="aircraft-copy-btn" data-seat-map-id="${escapeAttr(seatMapId || '')}" ${tooltipAttrs(tooltip)}>⧉</button>`
    : '';
  return `<span class="aircraft-type-cell"><span>${aircraftType}</span>${icon}</span>`;
}
function seatMapTooltip(seatMapName, seatMapId) {
  if (!seatMapName && !seatMapId) return '';
  if (seatMapName && seatMapId) return `Seat map: ${seatMapName}\nID: ${seatMapId}\nClick to copy ID`;
  if (seatMapName) return `Seat map: ${seatMapName}`;
  return `Seat map ID: ${seatMapId}`;
}
function renderFooter() {
  const env = state.environments.find(e => e.name === state.selectedEnv);
  const project = env ? env.project : 'prj-rx-prd-ooms-6f6c';
  return `<footer class="footer">Stock Keeper Spanner · ${project} · ${state.selectedEnv} · Read-only queries · Data is not stored</footer>`;
}

// ── Events ─────────────────────────────────────────────────────────────────
function bindEvents() {
  const sp = document.getElementById('search-panel');
  if (sp) {
    sp.addEventListener('click', onPanelClick);
    sp.addEventListener('mouseover', onPanelHover);
    sp.addEventListener('mouseout', onPanelOut);
  }
  const envSelect = document.getElementById('env-select');
  if (envSelect) envSelect.addEventListener('change', e => {
    const searchInputs = getSearchInputs();
    const shouldRepeatSearch = Boolean(state.data || state.error || state.loading);
    state.selectedEnv = e.target.value;
    render();
    prewarmSeatMaps(state.selectedEnv);
    if (shouldRepeatSearch) handleSearch(searchInputs);
    else restoreSearchInputs(searchInputs);
  });
  document.querySelectorAll('.iata-input').forEach(i => i.addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g,''); }));
  document.querySelectorAll('.flight-filter-input').forEach(i => i.addEventListener('input', e => { e.target.value = e.target.value.replace(/[^\d,\-\s]/g,''); }));
  document.querySelectorAll('.data-table th[data-sort]').forEach(th => th.addEventListener('click', () => handleSort(th.dataset.sort)));
  document.querySelectorAll('.tracker-copy-btn').forEach(btn => btn.addEventListener('click', handleTrackerCopy));
  document.querySelectorAll('.aircraft-copy-btn').forEach(btn => btn.addEventListener('click', handleSeatMapCopy));
  document.querySelectorAll('.group-toggle').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); toggleGroup(btn.dataset.groupKey); }));
  document.querySelectorAll('tr.group-parent').forEach(tr => tr.addEventListener('click', () => { toggleGroup(tr.dataset.groupKey); }));
}

function onPanelClick(e) {
  if (e.target.closest('#date-range-trigger')) {
    e.stopPropagation();
    state.calendarOpen = !state.calendarOpen;
    if (state.calendarOpen && state.dateFrom) {
      const d = new Date(state.dateFrom+'T00:00:00');
      state.calendarMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      state.selectingEnd = false;
    }
    updateCalendar(); return;
  }
  if (e.target.closest('.calendar-dropdown')) { e.stopPropagation(); }
  const day = e.target.closest('.day-cell[data-date]');
  if (day) { e.stopPropagation(); handleDayClick(day.dataset.date); return; }
  const nav = e.target.closest('.cal-nav');
  if (nav) { e.stopPropagation(); const dir = parseInt(nav.dataset.dir); state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth()+dir, 1); updateCalendar(); return; }
  const pill = e.target.closest('.cabin-pill');
  if (pill) { handleCabinClick(pill.dataset.cabin); return; }
  if (e.target.closest('#search-btn')) { handleSearch(); return; }
}

function onPanelHover(e) {
  if (!state.selectingEnd || !state.dateFrom) return;
  const day = e.target.closest('.day-cell[data-date]');
  if (!day) return;
  const hd = day.dataset.date;
  document.querySelectorAll('.day-cell.hover-range,.day-cell.hover-end').forEach(el => el.classList.remove('hover-range','hover-end'));
  if (hd >= state.dateFrom) {
    document.querySelectorAll('.day-cell[data-date]').forEach(el => {
      const d = el.dataset.date;
      if (d > state.dateFrom && d < hd) el.classList.add('hover-range');
      else if (d === hd) el.classList.add('hover-end');
    });
  }
}

function onPanelOut(e) {
  if (!e.target.closest('.calendar-dropdown')) return;
  document.querySelectorAll('.day-cell.hover-range,.day-cell.hover-end').forEach(el => el.classList.remove('hover-range','hover-end'));
}

function handleDayClick(ds) {
  if (!state.selectingEnd) {
    state.dateFrom = ds; state.dateTo = null; state.selectingEnd = true;
  } else {
    if (ds < state.dateFrom) { state.dateTo = state.dateFrom; state.dateFrom = ds; }
    else { state.dateTo = ds; }
    state.selectingEnd = false; state.calendarOpen = false;
  }
  updateCalendar();
}

function handleCabinClick(cabin) {
  if (cabin === 'all') { state.selectedCabins = []; }
  else {
    const c = parseInt(cabin), i = state.selectedCabins.indexOf(c);
    if (i >= 0) state.selectedCabins.splice(i, 1); else state.selectedCabins.push(c);
    if (state.selectedCabins.length === 3) state.selectedCabins = [];
  }
  document.querySelectorAll('.cabin-pill').forEach(p => {
    const v = p.dataset.cabin;
    p.classList.toggle('active', v === 'all' ? state.selectedCabins.length === 0 : state.selectedCabins.includes(parseInt(v)));
  });
}

// ── Search ─────────────────────────────────────────────────────────────────
async function handleSearch(searchInputs = null) {
  if (!state.dateFrom || !state.dateTo) return;
  const { origin, dest, flights } = searchInputs ?? getSearchInputs();
  const searchSeq = ++activeSearchSeq;
  state = { ...state, loading: true, error: null, data: null, sortKey: null, sortDir: 'asc', calendarOpen: false, expandedGroups: new Set() };
  render();
  restoreSearchInputs({ origin, dest, flights });

  try {
    const p = new URLSearchParams({ dateFrom: state.dateFrom, dateTo: state.dateTo });
    if (origin) p.set('origin', origin);
    if (dest) p.set('destination', dest);
    if (flights) p.set('flights', flights);
    if (state.selectedCabins.length) p.set('cabins', state.selectedCabins.join(','));
    p.set('env', state.selectedEnv);
    const res = await fetch(`/api/loadfactor?${p}`);
    if (!res.ok) { const b = await res.json().catch(()=>({})); throw new Error(b.error || `HTTP ${res.status}`); }
    if (searchSeq !== activeSearchSeq) return;
    state = { ...state, loading: false, data: await res.json() };
  } catch (err) {
    if (searchSeq !== activeSearchSeq) return;
    state = { ...state, loading: false, error: err.message };
  }
  if (searchSeq !== activeSearchSeq) return;
  render();
  restoreSearchInputs({ origin, dest, flights });

  // Async: fetch aircraft details after first paint
  if (state.data?.results?.length) fetchAircraftAsync(searchSeq, state.selectedEnv);
}

async function fetchAircraftAsync(searchSeq, searchEnv) {
  const results = state.data?.results;
  if (!results) return;
  const trackerIds = [...new Set(results.map(r => r.tracker_id).filter(Boolean))];
  if (!trackerIds.length) return;
  try {
    const res = await fetch('/api/aircraft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: searchEnv, trackerIds }),
    });
    if (!res.ok) return;
    const details = await res.json();
    if (searchSeq !== activeSearchSeq || searchEnv !== state.selectedEnv || state.data?.results !== results) return;
    // Enrich results in-place
    let changed = false;
    for (const r of results) {
      const d = details[r.tracker_id];
      if (d) {
        r.aircraft_type = d.aircraft_type ?? r.aircraft_type;
        r.seat_map_id = d.seat_map_id ?? r.seat_map_id;
        r.seat_map_name = d.seat_map_name ?? r.seat_map_name;
        changed = true;
      }
    }
    if (changed) {
      // Targeted DOM update — only patch aircraft cells instead of full re-render
      document.querySelectorAll('td.aircraft-td[data-tracker-id]').forEach(td => {
        const tid = td.dataset.trackerId;
        if (!tid) return;
        const d = details[tid];
        if (!d) return;
        const html = aircraftTypeCell(d.aircraft_type, d.seat_map_name, d.seat_map_id);
        if (td.innerHTML !== html) td.innerHTML = html;
      });
    }
  } catch { /* aircraft enrichment is best-effort */ }
}

async function handleTrackerCopy(e) {
  e.stopPropagation();
  const btn = e.currentTarget;
  const id = btn.dataset.trackerId;
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    const prev = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = prev; }, 900);
  } catch {
    // Keep the UI quiet on clipboard failures; hover still exposes the value.
  }
}

async function handleSeatMapCopy(e) {
  e.stopPropagation();
  const btn = e.currentTarget;
  const seatMapId = btn.dataset.seatMapId;
  if (!seatMapId) return;
  try {
    await navigator.clipboard.writeText(seatMapId);
    const prev = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = prev; }, 900);
  } catch {
    // Keep the UI quiet on clipboard failures; hover still exposes the value.
  }
}

function ensureTooltip() {
  if (tooltipEl) return;
  tooltipEl = document.createElement('div');
  tooltipEl.id = 'app-tooltip';
  tooltipEl.className = 'app-tooltip';
  document.body.appendChild(tooltipEl);
}

function handleTooltipMouseOver(e) {
  const target = e.target.closest('[data-tooltip]');
  if (!target) return;
  activeTooltipTarget = target;
  showTooltip(target);
}

function handleTooltipMouseOut(e) {
  const target = e.target.closest('[data-tooltip]');
  if (!target) return;
  const related = e.relatedTarget;
  if (related instanceof Node && target.contains(related)) return;
  if (activeTooltipTarget === target) {
    activeTooltipTarget = null;
    hideTooltip();
  }
}

function handleTooltipMouseMove(e) {
  if (!activeTooltipTarget) return;
  updateTooltipPosition(activeTooltipTarget, e);
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
  if (mouseEvent && tooltipRect.width < 220) {
    left = mouseEvent.clientX - tooltipRect.width / 2;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - tooltipRect.width - 8));

  tooltipEl.style.top = `${top}px`;
  tooltipEl.style.left = `${left}px`;
}

function handleSort(key) {
  if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  else { state.sortKey = key; state.sortDir = 'asc'; }
  const o = document.getElementById('origin')?.value || '';
  const d = document.getElementById('destination')?.value || '';
  const f = document.getElementById('flights')?.value || '';
  render();
  if (document.getElementById('origin')) document.getElementById('origin').value = o;
  if (document.getElementById('destination')) document.getElementById('destination').value = d;
  if (document.getElementById('flights')) document.getElementById('flights').value = f;
}

// getSortedRows removed — replaced by sortRows() + getDisplayRows() above

// ── Utils ──────────────────────────────────────────────────────────────────
function isoDate(d) { return d.toISOString().split('T')[0]; }
function calcLF(n, d) { return d>0&&n!=null ? (n/d)*100 : null; }
function calcAvgLF(rows, type) {
  const v = rows.filter(r => type==='sold' ? r.physical_capacity>0 : r.sellable_capacity>0);
  if (!v.length) return 0;
  return v.reduce((a,r) => a + (type==='sold' ? calcLF(r.sold,r.physical_capacity) : calcLF(r.sold+r.held,r.sellable_capacity)), 0) / v.length;
}
function lfColor(p) { return p==null?'':p<70?'lf-green':p<90?'lf-amber':'lf-red'; }
function fmtN(v) { return v==null?'—':v.toLocaleString('en-US'); }
function fmtTS(v) {
  if (!v) return '—';
  try { return new Date(v).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}); } catch { return v; }
}
function fmtRange(f, t) {
  if (!f) return 'Select dates';
  const fd = new Date(f+'T00:00:00'), td = t ? new Date(t+'T00:00:00') : null;
  const fs = `${fd.getDate()} ${MONTHS_SHORT[fd.getMonth()]}`;
  if (!td || f === t) return `${fs} ${fd.getFullYear()}`;
  const ts = `${td.getDate()} ${MONTHS_SHORT[td.getMonth()]}`;
  const yr = fd.getFullYear() === td.getFullYear() ? ` ${td.getFullYear()}` : ` ${fd.getFullYear()} – ${ts} ${td.getFullYear()}`;
  return fd.getFullYear() === td.getFullYear() ? `${fs} – ${ts}${yr}` : `${fs} ${fd.getFullYear()} – ${ts} ${td.getFullYear()}`;
}

function tooltipAttrs(text) {
  const safe = escapeAttr(text);
  return `data-tooltip="${safe}"`;
}

function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
