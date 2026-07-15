// =============================================================================
//  stats.js — activity analytics for the /stats command. Aggregates the daily
//  membership / message counters and the action log into a chosen time window,
//  then renders line and bar charts as PNG images to send in chat.
// -----------------------------------------------------------------------------
//  Definitions:
//    dayKey       'YYYY-MM-DD' for a unix timestamp, in the display timezone
//    period       resolved window { from, to, bucket, label }
//    bucket       aggregation granularity: 'day' or 'month'
//    agg          aggregated series keyed by bucket label
//    QuickChart   external renderer turning a Chart.js config into a PNG
// =============================================================================

const TZ = 'America/Detroit';
// Detroit formatter: assigns an actual event timestamp to a calendar day.
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
// UTC formatter: pure calendar arithmetic on 'YYYY-MM-DD' strings (no timezone shift).
const utcFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });

// 'YYYY-MM-DD' (display timezone) for a unix-seconds timestamp.
export const dayKey = (tsSec) => dayFmt.format(new Date(tsSec * 1000));
// Today's day key.
const today = () => dayKey(Date.now() / 1000);
// Shift a 'YYYY-MM-DD' string by n days (UTC calendar math — no DST drift).
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return utcFmt.format(new Date(Date.UTC(y, m - 1, d) + n * 86_400_000));
}
// Last calendar day of a 'YYYY-MM' month.
function endOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return utcFmt.format(new Date(Date.UTC(y, m, 0)));
}

// Increment a daily counter (joins | leaves | messages) for a group.
export function bumpStat(db, gid, field, n = 1) {
  if (!['joins', 'leaves', 'messages'].includes(field)) return;
  db.prepare(`INSERT INTO daily_stats (gid,day,${field}) VALUES (?,?,?)
              ON CONFLICT(gid,day) DO UPDATE SET ${field}=${field}+excluded.${field}`).run(gid, dayKey(Date.now() / 1000), n);
}

// Record a group's current member count: update the group row and today's snapshot.
export function snapshotMembers(db, gid, count) {
  db.prepare('UPDATE groups SET member_count=? WHERE gid=?').run(count, gid);
  db.prepare(`INSERT INTO member_snapshots (gid,day,count) VALUES (?,?,?)
              ON CONFLICT(gid,day) DO UPDATE SET count=excluded.count`).run(gid, dayKey(Date.now() / 1000), count);
}
// Member count for a group as of a given day (most recent snapshot on/before it; 0 if none yet).
export function memberCountAt(db, gid, day) {
  return db.prepare('SELECT count FROM member_snapshots WHERE gid=? AND day<=? ORDER BY day DESC LIMIT 1').get(gid, day)?.count ?? 0;
}

// Turn a period token into a concrete window. Supports: all | ytd | week | month |
// year | YYYY | YYYY-MM (default: last 30 days).
export function resolvePeriod(token) {
  const t = (token || 'month').toLowerCase();
  const now = today();
  const year = now.slice(0, 4);
  if (t === 'all') return { from: '2000-01-01', to: now, bucket: 'month', label: 'all time' };
  if (t === 'ytd') return { from: `${year}-01-01`, to: now, bucket: 'month', label: `${year} YTD` };
  if (t === 'week') return { from: addDays(now, -6), to: now, bucket: 'day', label: 'last 7 days' };
  if (t === 'month') return { from: addDays(now, -29), to: now, bucket: 'day', label: 'last 30 days' };
  if (t === 'year') return { from: addDays(now, -364), to: now, bucket: 'month', label: 'last 12 months' };
  if (/^\d{4}$/.test(t)) return { from: `${t}-01-01`, to: `${t}-12-31`, bucket: 'month', label: t };
  if (/^\d{4}-\d{2}$/.test(t)) return { from: `${t}-01`, to: endOfMonth(t), bucket: 'day', label: t };
  return { from: addDays(now, -29), to: now, bucket: 'day', label: 'last 30 days' };
}

// The ordered list of bucket labels spanning [from, to].
function bucketsOf(period) {
  const out = [];
  if (period.bucket === 'day') {
    for (let d = period.from; d <= period.to; d = addDays(d, 1)) out.push(d);
  } else {
    let ym = period.from.slice(0, 7);
    const end = period.to.slice(0, 7);
    while (ym <= end) {
      out.push(ym);
      const [y, m] = ym.split('-').map(Number);
      ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    }
  }
  return out;
}
// Map a day key to its bucket label for the period.
const toBucket = (period, day) => (period.bucket === 'day' ? day : day.slice(0, 7));

// Aggregate counters + actions for the given groups over the period.
export function aggregate(db, gids, period) {
  const labels = bucketsOf(period);
  const idx = new Map(labels.map((l, i) => [l, i]));
  const joins = labels.map(() => 0), leaves = labels.map(() => 0), messages = labels.map(() => 0);

  const ph = gids.map(() => '?').join(',');
  for (const r of db.prepare(`SELECT day,joins,leaves,messages FROM daily_stats
                              WHERE gid IN (${ph}) AND day BETWEEN ? AND ?`).all(...gids, period.from, period.to)) {
    const b = idx.get(toBucket(period, r.day)); if (b == null) continue;
    joins[b] += r.joins; leaves[b] += r.leaves; messages[b] += r.messages;
  }

  // Actions come straight from action_log, bucketed by their timestamp and grouped by type.
  const actionTypes = ['ban', 'remove', 'flag', 'verify', 'setting', 'unban'];
  const actions = Object.fromEntries(actionTypes.map((a) => [a, labels.map(() => 0)]));
  for (const r of db.prepare(`SELECT ts,action FROM action_log WHERE gid IN (${ph})`).all(...gids)) {
    const day = dayKey(r.ts);
    if (day < period.from || day > period.to) continue;
    const b = idx.get(toBucket(period, day)); if (b == null) continue;
    if (actions[r.action]) actions[r.action][b] += 1;
  }

  // Actual member count per bucket = summed group snapshot as of the bucket's end (baseline
  // captured at bot-join carries forward), so the line reflects real size, not net-from-zero.
  const members = labels.map((lab) => {
    const day = period.bucket === 'day' ? lab : endOfMonth(lab);
    return gids.reduce((s, g) => s + memberCountAt(db, g, day), 0);
  });

  return { labels, joins, leaves, messages, actions, members,
    totals: {
      joins: joins.reduce((a, b) => a + b, 0),
      leaves: leaves.reduce((a, b) => a + b, 0),
      messages: messages.reduce((a, b) => a + b, 0),
      actions: Object.values(actions).reduce((s, arr) => s + arr.reduce((a, b) => a + b, 0), 0),
      members: members.length ? members[members.length - 1] : 0,
    } };
}

// Build Chart.js configs (rendered by QuickChart) for the aggregated data.
export function buildCharts(agg, title) {
  const base = { plugins: {}, scales: { x: { ticks: { autoSkip: true, maxTicksLimit: 12 } } } };
  const members = {
    type: 'bar',
    data: {
      labels: agg.labels,
      datasets: [
        { label: 'Joins', backgroundColor: '#34a853', data: agg.joins },
        { label: 'Leaves', backgroundColor: '#ea4335', data: agg.leaves.map((v) => -v) },
        { label: 'Members', type: 'line', borderColor: '#1a3d7c', backgroundColor: '#1a3d7c', fill: false, yAxisID: 'y2', data: agg.members },
      ],
    },
    options: { ...base, title: { display: true, text: `${title} — Membership (${agg.totals.members} members; +${agg.totals.joins}/-${agg.totals.leaves})` },
      scales: { ...base.scales, y2: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } } } },
  };
  const messages = {
    type: 'line',
    data: { labels: agg.labels, datasets: [{ label: 'Messages', borderColor: '#4285f4', backgroundColor: 'rgba(66,133,244,0.2)', fill: true, data: agg.messages }] },
    options: { ...base, title: { display: true, text: `${title} — Message volume (${agg.totals.messages} total)` } },
  };
  const palette = { ban: '#b31412', remove: '#ea4335', flag: '#fbbc04', verify: '#34a853', setting: '#9aa0a6', unban: '#4285f4' };
  const actions = {
    type: 'bar',
    data: { labels: agg.labels, datasets: Object.entries(agg.actions).filter(([, arr]) => arr.some((v) => v))
      .map(([k, arr]) => ({ label: k, backgroundColor: palette[k] || '#666', data: arr, stack: 's' })) },
    options: { ...base, title: { display: true, text: `${title} — Goose actions (${agg.totals.actions} total)` }, scales: { ...base.scales, x: { ...base.scales.x, stacked: true }, y: { stacked: true } } },
  };
  return [members, messages, actions];
}

// Render a Chart.js config to a PNG buffer via QuickChart.
export async function renderChart(config) {
  const res = await fetch('https://quickchart.io/chart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ width: 760, height: 420, format: 'png', backgroundColor: 'white', chart: config }),
  });
  if (!res.ok) throw new Error(`quickchart ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
