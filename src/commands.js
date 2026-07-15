// =============================================================================
//  commands.js — admin command interface handled over direct message. Parses
//  and executes /help, /policy, /allow, /associate, /remove, /confirmban,
//  /unban, /messages, /lookup, /notif, /logs, and the member onboarding reply.
// -----------------------------------------------------------------------------
//  Definitions:
//    SUPERS          set of operator phone numbers (act as admin everywhere)
//    DB              database handle, set on each incoming message
//    MASS_BAN_LIMIT  bans per admin per 24h before a typed CONFIRM is required
//    session         multi-step wizard state stored per user in dm_session
//    replyJid        address the current sender is answered on
//    scoped command  one that first asks which group(s) it applies to
// =============================================================================
import { removeMember, unbanMember, fetchArchive, logAction, isAdminLive, addrFor, lidForPhone, bansLast24hByActor } from './actions.js';
import { uniqnameAllowedInGroup } from './screening.js';
import { notifyAdmins } from './notify.js';
import { clean, tokens, validUniqname, validPhone, normalizePhone, oneOf, extractUniqnames } from './security.js';
import { resolvePeriod, aggregate, buildCharts, renderChart, memberCountAt } from './stats.js';

const MASS_BAN_LIMIT = 10; // bans per admin per 24h before typed approval is required

// Superadmins (bot operators) act as admin of every group. Set from cfg on each DM.
let SUPERS = new Set();
let DB = null; // db singleton, set per handleDM (constant object — no race)
const isSuper = (phone) => SUPERS.has(phone);

const now = () => Math.floor(Date.now() / 1000);
// Address by LID when known (WhatsApp rejects @s.whatsapp.net to LID-only users -> 463).
const send = (sock, phone, text) => sock.sendMessage(addrFor(DB, phone), { text }).catch(() => {});
// Timestamps shown to admins are in Detroit time (explicit — independent of server TZ).
const fmtTs = (ts) => new Date(ts * 1000).toLocaleString('sv-SE', { timeZone: 'America/Detroit' }).slice(0, 16) + ' ET';

const getSession = (db, phone) => {
  const r = db.prepare('SELECT state FROM dm_session WHERE phone=?').get(phone);
  try { return r ? JSON.parse(r.state) : null; } catch { return null; }
};
const setSession = (db, phone, state) =>
  db.prepare(`INSERT INTO dm_session (phone,state,ts) VALUES (?,?,?)
              ON CONFLICT(phone) DO UPDATE SET state=excluded.state, ts=excluded.ts`)
    .run(phone, JSON.stringify(state), now());
const clearSession = (db, phone) => db.prepare('DELETE FROM dm_session WHERE phone=?').run(phone);

// Candidate groups from cache; authz is RE-VERIFIED live before any action executes.
// Superadmins get EVERY group the bot knows about. Regular admins are matched by phone OR
// their LID (admin_group stores whatever id groupMetadata returned — now LIDs).
const adminGroups = (db, phone, lid) =>
  isSuper(phone)
    ? db.prepare('SELECT gid, name, policy, enforce_allowlist FROM groups ORDER BY name').all()
    : db.prepare(`SELECT ag.gid, g.name, g.policy, g.enforce_allowlist FROM admin_group ag
                  JOIN groups g ON g.gid=ag.gid WHERE ag.admin_phone IN (?,?)`).all(phone, lid || phone);

export const WELCOME = (name) =>
`🪿 I'm *Guardian Goose*, the anti-spam bot for *${name}*. You're an admin here. Each group is
handled separately — if you run several, I'll ask which one(s) each action is for.

*Policies* (per group, you set them):
• chill  — I ask each joiner for their uniqname but let them stay.
• hold   — new members can't send messages until they DM me a valid uniqname (deleted until then).
• strict — new members are removed after the grace period if they never verify.
• off    — I ignore this group entirely (no DMs, no actions).

*Commands* (DM me):
/policy               set a group's policy
/grace <hours>        strict-policy grace window before removal (per group)
/allow add|remove <uniqname> | list | enforce on|off   per-group approved uniqnames
/allow bulk           paste a whole roster of uniqnames to auto-approve
/associate <phone> <uniqname>   bind a uniqname to a number + verify them
/remove <phone>       ban a number (kick + delete + archive its messages; rejoin auto-removed)
/confirmban [n...]     approve queued bans (shown when the auto-ban cap is hit); no args = list
/unban <phone>        lift a ban
/messages <phone>     fetch a banned user's archived messages (last 45, 30 days)
/lookup <uniqname|phone|lid>   flexible; finds across all records
/stats [period]       charts: members, message volume, actions
                      period: all | ytd | week | month | year | YYYY | YYYY-MM
/membercount [date]   current member count, or the count on a YYYY-MM-DD
/notif                your alert level (all | kicks | none)
/logs [n]             recent actions
/help                 show this again

*Note:* WhatsApp blocks me from messaging members first. New members must DM me to verify —
I post a welcome in the group tagging them. You (admins) reach me by DMing me too.
I re-check you're still an admin of the target group before every action.`;

function pickGroups(input, groups) {
  const t = clean(input).toLowerCase();
  if (t === 'all') return groups.map((g) => g.gid);
  const idx = t.split(/[,\s]+/).map((x) => parseInt(x, 10) - 1).filter((i) => i >= 0 && i < groups.length);
  return [...new Set(idx)].map((i) => groups[i].gid);
}
const listGroups = (groups) => groups.map((g, i) => `${i + 1}. ${g.name} [${g.policy}${g.enforce_allowlist ? ',allowlist' : ''}]`).join('\n');
const nameOf = (db, gid) => db.prepare('SELECT name FROM groups WHERE gid=?').get(gid)?.name || gid;

async function liveFilter(sock, db, gids, phone) {
  if (isSuper(phone)) return gids; // superadmin authorized on every group, no live check needed
  const ok = [];
  for (const gid of gids) if (await isAdminLive(sock, db, gid, phone)) ok.push(gid);
  return ok;
}

export async function handleDM(sock, db, cfg, senderPhone, rawText, senderLid = null) {
  SUPERS = new Set(cfg.superadmins || []); // refresh operator set each DM
  DB = db;
  const body = clean(rawText);
  const sess = getSession(db, senderPhone);
  if (sess) return stepSession(sock, db, cfg, senderPhone, body, sess, rawText);
  if (!body.startsWith('/')) return false;

  const tk = tokens(body);
  const cmd = tk[0].toLowerCase();
  const groups = adminGroups(db, senderPhone, senderLid);
  const isAdmin = groups.length > 0;
  const notAdmin = async () => (await send(sock, senderPhone, 'You are not an admin of any group I manage.'), true);

  switch (cmd) {
    case '/help':
      return isAdmin ? (await send(sock, senderPhone, WELCOME(groups[0].name)), true) : notAdmin();

    case '/remove': {
      if (!isAdmin) return notAdmin();
      const target = validPhone(tk[1]);
      if (!target) return (await send(sock, senderPhone, 'Usage: /remove <phone digits>'), true);
      return startScoped(sock, db, senderPhone, groups, { cmd: 'remove', target });
    }
    case '/unban': {
      if (!isAdmin) return notAdmin();
      const target = validPhone(tk[1]);
      if (!target) return (await send(sock, senderPhone, 'Usage: /unban <phone digits>'), true);
      return startScoped(sock, db, senderPhone, groups, { cmd: 'unban', target });
    }
    case '/messages': {
      if (!isAdmin) return notAdmin();
      const target = validPhone(tk[1]);
      if (!target) return (await send(sock, senderPhone, 'Usage: /messages <phone digits>'), true);
      return startScoped(sock, db, senderPhone, groups, { cmd: 'messages', target });
    }
    case '/associate': {
      if (!isAdmin) return notAdmin();
      // uniqname is the LAST token; the phone is everything between (may be space/format-split).
      const uq = validUniqname(tk[tk.length - 1], cfg.uniqnameRegex);
      const target = normalizePhone(tk.slice(1, -1).join(''), cfg.homeCountryCode);
      if (!target || !uq || tk.length < 3) return (await send(sock, senderPhone, 'Usage: /associate <phone> <uniqname>'), true);
      return startScoped(sock, db, senderPhone, groups, { cmd: 'associate', target, uniqname: uq });
    }
    case '/confirmban': {
      if (!isAdmin) return notAdmin();
      const gids = groups.map((g) => g.gid);
      const pend = db.prepare(`SELECT * FROM pending_bans WHERE gid IN (${gids.map(() => '?').join(',')}) ORDER BY id`).all(...gids);
      if (!pend.length) return (await send(sock, senderPhone, 'No pending bans.'), true);
      const nums = tk.slice(1).map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= pend.length);
      if (!nums.length) {
        const list = pend.map((p, i) => `${i + 1}. ${p.phone} in ${nameOf(db, p.gid)} — "${(p.lastmsg || '').slice(0, 50)}"`).join('\n');
        return (await send(sock, senderPhone, `Pending bans:\n${list}\nReply /confirmban 1 3 to ban those (by number).`), true);
      }
      const picked = [...new Set(nums)].map((n) => pend[n - 1]);
      let done = 0, refused = 0;
      for (const p of picked) {
        const ok = await liveFilter(sock, db, [p.gid], senderPhone); // LIVE authz on the entry's group
        if (!ok.length) { refused++; continue; }
        const d = await removeMember(sock, db, p.gid, p.phone, senderPhone, `admin /confirmban (${p.reason})`, { ban: true });
        db.prepare('DELETE FROM pending_bans WHERE gid=? AND phone=?').run(p.gid, p.phone);
        if (d === -1) { refused++; continue; }
        done++;
        await notifyAdmins(sock, db, p.gid, 'remove', `🪿 Honk! admin ${senderPhone} confirmed ban of ${p.phone}`);
      }
      return (await send(sock, senderPhone, `Confirmed ${done} ban(s).${refused ? ` ${refused} refused (not admin / protected).` : ''}`), true);
    }
    case '/stats': {
      if (!isAdmin) return notAdmin();
      // period: all | ytd | week | month | year | YYYY | YYYY-MM  (default: last 30 days)
      return startScoped(sock, db, senderPhone, groups, { cmd: 'stats', period: tk[1] || 'month' });
    }
    case '/membercount': {
      if (!isAdmin) return notAdmin();
      // optional YYYY-MM-DD -> count at that date; otherwise the current count
      return startScoped(sock, db, senderPhone, groups, { cmd: 'membercount', date: /^\d{4}-\d{2}-\d{2}$/.test(tk[1] || '') ? tk[1] : null });
    }
    case '/policy':
      return isAdmin ? startScoped(sock, db, senderPhone, groups, { cmd: 'policy' }) : notAdmin();
    case '/grace': {
      if (!isAdmin) return notAdmin();
      const h = parseInt(tk[1], 10);
      if (!Number.isInteger(h) || h < 1 || h > 720) return (await send(sock, senderPhone, 'Usage: /grace <hours 1-720> (strict-policy grace window)'), true);
      return startScoped(sock, db, senderPhone, groups, { cmd: 'grace', hours: h });
    }
    case '/notif':
      return isAdmin ? startScoped(sock, db, senderPhone, groups, { cmd: 'notif' }) : notAdmin();

    case '/allow': {
      if (!isAdmin) return notAdmin();
      const sub = oneOf(tk[1], ['add', 'remove', 'list', 'enforce', 'bulk']);
      if (!sub) return (await send(sock, senderPhone, 'Usage: /allow add|remove <uniqname> | bulk | list | enforce on|off'), true);
      if (sub === 'bulk') {
        if (groups.length === 1) {
          setSession(db, senderPhone, { cmd: 'allowbulk', step: 'collect', gids: [groups[0].gid] });
          return (await send(sock, senderPhone, 'Paste the uniqnames to auto-approve (space / comma / newline separated).'), true);
        }
        setSession(db, senderPhone, { cmd: 'allowbulk', step: 'pickGroups', groups });
        return (await send(sock, senderPhone, `Add a uniqname roster to which group(s)? 'all' or numbers:\n${listGroups(groups)}`), true);
      }
      if (sub === 'add' || sub === 'remove') {
        const uq = validUniqname(tk[2], cfg.uniqnameRegex);
        if (!uq) return (await send(sock, senderPhone, `Usage: /allow ${sub} <uniqname>`), true);
        return startScoped(sock, db, senderPhone, groups, { cmd: 'allow', sub, uniqname: uq });
      }
      if (sub === 'enforce') {
        const v = oneOf(tk[2], ['on', 'off']);
        if (!v) return (await send(sock, senderPhone, 'Usage: /allow enforce on|off'), true);
        return startScoped(sock, db, senderPhone, groups, { cmd: 'allow', sub, value: v });
      }
      return startScoped(sock, db, senderPhone, groups, { cmd: 'allow', sub: 'list' }); // list
    }

    case '/lookup': {
      if (!isAdmin) return notAdmin();
      const q = clean(tk.slice(1).join(' ')); // join tokens so "(313) 555-1234" survives
      if (!q) return (await send(sock, senderPhone, 'Usage: /lookup <uniqname | phone | lid>'), true);
      // Flexible input: uniqname (any case), phone (with/without country code / formatting), or a LID.
      const uq = validUniqname(q, cfg.uniqnameRegex);
      const ph = normalizePhone(q, cfg.homeCountryCode);
      const digits = q.replace(/\D/g, '');

      // All ids linked to a given id, across the phone<->lid map.
      const relatedIds = (id) => {
        const s = new Set([id]);
        const l = db.prepare('SELECT lid FROM lidmap WHERE phone=?').get(id); if (l) s.add(l.lid);
        const p = db.prepare('SELECT phone FROM lidmap WHERE lid=?').get(id); if (p) s.add(p.phone);
        return [...s];
      };

      // Seed candidate ids from every interpretation of the query.
      const seeds = new Set();
      if (ph) relatedIds(ph).forEach((x) => seeds.add(x));
      if (digits) relatedIds(digits).forEach((x) => seeds.add(x));

      // Collect distinct identities (members table + membership table) — MULTI-INDEX find.
      const ids = new Set();
      if (uq) {
        db.prepare('SELECT phone FROM members WHERE uniqname=?').all(uq).forEach((r) => ids.add(r.phone));
        db.prepare('SELECT DISTINCT phone FROM membership WHERE uniqname=?').all(uq).forEach((r) => ids.add(r.phone));
      }
      for (const s of seeds) {
        if (db.prepare('SELECT 1 FROM members WHERE phone=?').get(s)) ids.add(s);
        if (db.prepare('SELECT 1 FROM membership WHERE phone=? LIMIT 1').get(s)) ids.add(s);
      }
      if (!ids.size) return (await send(sock, senderPhone, 'No record.'), true);

      // Collapse ids that belong to the SAME person (linked via lidmap) into one canonical id
      // (prefer the real phone). Prevents duplicate rows for a member found by both phone & lid.
      const list = [], seen = new Set();
      for (const id of ids) {
        const rel = relatedIds(id);
        if (rel.some((r) => seen.has(r))) continue;
        rel.forEach((r) => seen.add(r));
        const m = db.prepare(`SELECT phone FROM members WHERE phone IN (${rel.map(() => '?').join(',')})`).all(...rel)[0];
        list.push(m?.phone || id);
      }

      const fmt = (id) => {
        const rel = relatedIds(id);
        const m = db.prepare(`SELECT * FROM members WHERE phone IN (${rel.map(() => '?').join(',')})`).all(...rel)[0];
        const lid = db.prepare('SELECT lid FROM lidmap WHERE phone=?').get(m?.phone || id)?.lid;
        const mem = db.prepare(`SELECT gid,verified FROM membership WHERE phone IN (${rel.map(() => '?').join(',')})`).all(...rel);
        const per = mem.map((r) => `${nameOf(db, r.gid)}:${r.verified ? 'verified' : 'unverified'}`).join(', ') || '—';
        const uqv = m?.uniqname || db.prepare(`SELECT uniqname FROM membership WHERE phone IN (${rel.map(() => '?').join(',')}) AND uniqname IS NOT NULL LIMIT 1`).get(...rel)?.uniqname;
        return `id ${m?.phone || id}${lid ? ` (lid ${lid})` : ''} | uniqname ${uqv || '—'} | voip ${m?.is_voip ?? '?'} | foreign ${m?.is_foreign === 1 ? 'yes' : m?.is_foreign === 0 ? 'no' : '?'}\n  groups: ${per}`;
      };

      if (list.length === 1) return (await send(sock, senderPhone, fmt(list[0])), true);
      await send(sock, senderPhone, `${list.length} matches:\n` + list.map((id, i) => `${i + 1}. ${fmt(id)}`).join('\n'));
      return true;
    }

    case '/logs': {
      if (!isAdmin) return notAdmin();
      const n = Math.min(Math.max(parseInt(tk[1], 10) || 15, 1), 50);
      const gids = groups.map((g) => g.gid);
      const rows = db.prepare(
        `SELECT * FROM action_log WHERE gid IN (${gids.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`).all(...gids, n);
      await send(sock, senderPhone, rows.length
        ? rows.map((r) => `${fmtTs(r.ts)} ${r.action} ${r.target} (${r.reason})`).join('\n')
        : 'No log entries.');
      return true;
    }

    default:
      await send(sock, senderPhone, isAdmin ? WELCOME(groups[0].name) : 'Unknown command. Send /help.');
      return true;
  }
}

// commands that only PROMPT a value after group pick:
const NEEDS_VALUE = new Set(['policy', 'notif']);

async function startScoped(sock, db, phone, groups, payload) {
  if (groups.length === 1) {
    if (NEEDS_VALUE.has(payload.cmd)) {
      setSession(db, phone, { ...payload, step: 'value', gids: [groups[0].gid], groups });
      await askValue(sock, phone, payload.cmd);
    } else {
      await execute(sock, db, phone, payload, [groups[0].gid]);
    }
    return true;
  }
  setSession(db, phone, { ...payload, step: 'pickGroups', groups });
  await send(sock, phone, `${scopedVerb(payload)} which group(s)? Reply 'all' or numbers (e.g. 1,3):\n${listGroups(groups)}`);
  return true;
}

function scopedVerb(p) {
  if (p.cmd === 'remove') return `BAN ${p.target} from`;
  if (p.cmd === 'unban') return `Unban ${p.target} in`;
  if (p.cmd === 'messages') return `Fetch ${p.target}'s messages from`;
  if (p.cmd === 'stats') return `Show ${p.period} stats for`;
  if (p.cmd === 'membercount') return `Member count${p.date ? ` on ${p.date}` : ''} for`;
  if (p.cmd === 'grace') return `Set strict grace to ${p.hours}h for`;
  if (p.cmd === 'associate') return `Associate ${p.target} ↔ ${p.uniqname} (verify) in`;
  if (p.cmd === 'allow') return `Apply /allow ${p.sub}${p.uniqname ? ' ' + p.uniqname : p.value ? ' ' + p.value : ''} to`;
  return `Apply /${p.cmd} to`;
}
const askValue = (sock, phone, cmd) =>
  send(sock, phone, cmd === 'policy' ? 'Policy? reply: chill | hold | strict | off' : 'Notifications? reply: all | kicks | none');

async function stepSession(sock, db, cfg, phone, body, sess, rawText = '') {
  // ---- onboarding: capture a joiner's uniqname, verify PER GROUP ----
  if (sess.cmd === 'onboard') {
    const uq = validUniqname(body, cfg.uniqnameRegex);
    if (!uq) return (await send(sock, phone, 'Please reply with just your uniqname (e.g. jdoe).'), true);
    if (!uniqnameAllowedInGroup(db, sess.gid, uq))
      return (await send(sock, phone, `${uq} is not on the approved list for ${nameOf(db, sess.gid)}. Contact a group admin.`), true);
    // Anti-impersonation: a uniqname belongs to ONE phone. Clash -> reject + alert admins.
    const clash = db.prepare('SELECT phone FROM members WHERE uniqname=? AND phone<>?').get(uq, phone);
    if (clash) {
      await notifyAdmins(sock, db, sess.gid, 'flag',
        `⚠️ ${phone} tried to claim uniqname "${uq}" already registered to ${clash.phone}. Possible impersonation.`);
      return (await send(sock, phone, `That uniqname is already registered to another number. Contact a group admin.`), true);
    }
    db.prepare(`INSERT INTO members (phone,uniqname,updated_at) VALUES (?,?,?)
                ON CONFLICT(phone) DO UPDATE SET uniqname=excluded.uniqname, updated_at=excluded.updated_at`).run(phone, uq, now()); // global identity
    // Membership is keyed by the member's LID (set at join); fall back to phone.
    const mkey = sess.memberKey || phone;
    db.prepare(`INSERT INTO membership (gid,phone,joined_ts,verified,uniqname) VALUES (?,?,?,1,?)
                ON CONFLICT(gid,phone) DO UPDATE SET verified=1, uniqname=excluded.uniqname`)
      .run(sess.gid, mkey, now(), uq);
    logAction(db, { gid: sess.gid, actor: 'bot', action: 'verify', target: phone, reason: `uniqname ${uq}` });
    clearSession(db, phone);
    await send(sock, phone, `🪿 Thanks — recorded as ${uq}. You're verified in ${nameOf(db, sess.gid)}.`);
    return true;
  }

  // ---- bulk allowlist import (paste a uniqname roster) ----
  if (sess.cmd === 'allowbulk') {
    if (sess.step === 'pickGroups') {
      const gids = pickGroups(body, sess.groups);
      if (!gids.length) return (await send(sock, phone, `Reply 'all' or numbers like 1,3.`), true);
      setSession(db, phone, { cmd: 'allowbulk', step: 'collect', gids });
      return (await send(sock, phone, 'Paste the uniqnames to auto-approve (space / comma / newline separated).'), true);
    }
    const ok = await liveFilter(sock, db, sess.gids, phone);
    clearSession(db, phone);
    if (!ok.length) return (await send(sock, phone, 'You are no longer an admin of those group(s).'), true);
    const names = extractUniqnames(rawText, cfg.uniqnameRegex);
    if (!names.length) return (await send(sock, phone, 'No valid uniqnames found in that paste.'), true);
    const ins = db.prepare(`INSERT INTO allowlist (gid,uniqname,added_by,ts) VALUES (?,?,?,?) ON CONFLICT(gid,uniqname) DO NOTHING`);
    for (const gid of ok) for (const u of names) ins.run(gid, u, phone, now());
    for (const gid of ok) logAction(db, { gid, actor: phone, action: 'setting', target: '', reason: `allowlist +${names.length}` });
    return (await send(sock, phone, `Added ${names.length} uniqname(s) to the allowlist of ${ok.length} group(s).`), true);
  }

  // ---- mass-ban approval gate ----
  if (sess.step === 'confirmMass') {
    clearSession(db, phone);
    if (clean(body).toUpperCase() !== 'CONFIRM')
      return (await send(sock, phone, 'Cancelled — no bans executed.'), true);
    await execute(sock, db, phone, { cmd: 'remove', target: sess.target, approved: true }, sess.gids);
    return true;
  }

  if (sess.step === 'pickGroups') {
    const gids = pickGroups(body, sess.groups);
    if (!gids.length) return (await send(sock, phone, `Didn't parse that. Reply 'all' or numbers like 1,3.`), true);
    if (NEEDS_VALUE.has(sess.cmd)) { setSession(db, phone, { ...sess, step: 'value', gids }); await askValue(sock, phone, sess.cmd); return true; }
    clearSession(db, phone);
    await execute(sock, db, phone, sess, gids);
    return true;
  }

  if (sess.step === 'value') {
    const ok = await liveFilter(sock, db, sess.gids, phone);
    if (!ok.length) { clearSession(db, phone); return (await send(sock, phone, 'You are no longer an admin of those group(s).'), true); }
    if (sess.cmd === 'policy') {
      const lvl = oneOf(body, ['chill', 'hold', 'strict', 'off']);
      if (!lvl) return (await send(sock, phone, 'reply: chill | hold | strict | off'), true);
      for (const gid of ok) { db.prepare('UPDATE groups SET policy=? WHERE gid=?').run(lvl, gid); logAction(db, { gid, actor: phone, action: 'setting', target: '', reason: `policy=${lvl}` }); }
      clearSession(db, phone);
      await send(sock, phone, `Policy set to ${lvl} for ${ok.length} group(s).`);
    } else if (sess.cmd === 'notif') {
      const lvl = oneOf(body, ['all', 'kicks', 'none']);
      if (!lvl) return (await send(sock, phone, 'reply: all | kicks | none'), true);
      for (const gid of ok) db.prepare('UPDATE admin_group SET notif_level=? WHERE gid=? AND admin_phone=?').run(lvl, gid, phone);
      clearSession(db, phone);
      await send(sock, phone, `Notifications set to ${lvl} for ${ok.length} group(s).`);
    }
    return true;
  }
  clearSession(db, phone);
  return false;
}

// Terminal (no-value) scoped commands. LIVE authz re-check on the chosen groups first.
async function execute(sock, db, phone, p, gids) {
  const ok = await liveFilter(sock, db, gids, phone);
  if (!ok.length) return send(sock, phone, 'You are no longer an admin of those group(s).');

  if (p.cmd === 'remove') {
    // Mass-ban brake: more than MASS_BAN_LIMIT bans per admin per 24h needs typed approval.
    const recent = bansLast24hByActor(db, phone);
    if (!p.approved && recent + ok.length > MASS_BAN_LIMIT) {
      setSession(db, phone, { cmd: 'remove', target: p.target, step: 'confirmMass', gids: ok });
      return send(sock, phone,
        `⚠️ This would put you at ${recent + ok.length} bans in 24h (limit ${MASS_BAN_LIMIT} without approval).\nReply CONFIRM to proceed, anything else to cancel.`);
    }
    let total = 0, banned = 0; const skipped = [];
    for (const gid of ok) {
      const d = await removeMember(sock, db, gid, p.target, phone, 'admin /remove', { ban: true });
      if (d === -1) { skipped.push(nameOf(db, gid)); continue; }   // protected: admin/bot — never banned
      banned++; total += d;
      await notifyAdmins(sock, db, gid, 'remove', `🪿 Honk! admin ${phone} banned ${p.target}; archived+deleted ${d} msg(s)`);
    }
    let msg = `🪿 Honk! Banned ${p.target} in ${banned} group(s); archived + deleted ${total} message(s).`;
    if (skipped.length) msg += `\nRefused (target is an admin there): ${skipped.join(', ')}.`;
    return send(sock, phone, msg);
  }
  if (p.cmd === 'unban') {
    let n = 0;
    for (const gid of ok) if (unbanMember(db, gid, p.target, phone)) {
      n++;
      await notifyAdmins(sock, db, gid, 'remove', `admin ${phone} unbanned ${p.target}`);
    }
    return send(sock, phone, `Unbanned ${p.target} in ${n} of ${ok.length} group(s).`);
  }
  if (p.cmd === 'associate') {
    // Bind uniqname to phone globally, and mark verified in the chosen group(s).
    db.prepare(`INSERT INTO members (phone,uniqname,updated_at) VALUES (?,?,?)
                ON CONFLICT(phone) DO UPDATE SET uniqname=excluded.uniqname, updated_at=excluded.updated_at`).run(p.target, p.uniqname, now());
    const mkey = lidForPhone(db, p.target) || p.target; // membership is keyed by LID when known
    for (const gid of ok) {
      db.prepare(`INSERT INTO membership (gid,phone,joined_ts,verified,uniqname) VALUES (?,?,?,1,?)
                  ON CONFLICT(gid,phone) DO UPDATE SET verified=1, uniqname=excluded.uniqname`).run(gid, mkey, now(), p.uniqname);
      logAction(db, { gid, actor: phone, action: 'verify', target: p.target, reason: `associated ${p.uniqname}` });
    }
    return send(sock, phone, `Associated ${p.target} ↔ ${p.uniqname}; verified in ${ok.length} group(s).`);
  }
  if (p.cmd === 'grace') {
    for (const gid of ok) { db.prepare('UPDATE groups SET grace_hours=? WHERE gid=?').run(p.hours, gid); logAction(db, { gid, actor: phone, action: 'setting', target: '', reason: `grace=${p.hours}h` }); }
    return send(sock, phone, `Strict grace period set to ${p.hours}h for ${ok.length} group(s).`);
  }
  if (p.cmd === 'membercount') {
    const countFor = (g) => p.date ? memberCountAt(db, g, p.date)
      : (db.prepare('SELECT member_count FROM groups WHERE gid=?').get(g)?.member_count ?? 0);
    const lines = ok.map((g) => `${nameOf(db, g)}: ${countFor(g)}`);
    const total = ok.reduce((s, g) => s + countFor(g), 0);
    return send(sock, phone, `👥 Members${p.date ? ` as of ${p.date}` : ' (now)'}:\n${lines.join('\n')}${ok.length > 1 ? `\n*Total: ${total}*` : ''}`);
  }
  if (p.cmd === 'stats') {
    const period = resolvePeriod(p.period);
    const agg = aggregate(db, ok, period);
    const title = ok.length === 1 ? nameOf(db, ok[0]) : `${ok.length} groups`;
    await send(sock, phone, `📊 *${title}* — ${period.label}\njoins ${agg.totals.joins} · leaves ${agg.totals.leaves} · net ${agg.totals.joins - agg.totals.leaves} · messages ${agg.totals.messages} · goose actions ${agg.totals.actions}\nRendering charts…`);
    for (const chart of buildCharts(agg, title)) {
      try { const img = await renderChart(chart); await sock.sendMessage(addrFor(DB, phone), { image: img, caption: chart.options.title.text }); }
      catch (e) { await send(sock, phone, `Chart render failed: ${e.message}`); }
    }
    return;
  }
  if (p.cmd === 'messages') {
    const out = [];
    for (const gid of ok) {
      const rows = fetchArchive(db, gid, p.target);
      out.push(`*${nameOf(db, gid)}* (${rows.length}):`);
      out.push(rows.length ? rows.map((r) => `• ${fmtTs(r.ts)} ${r.body || '(no text)'}`).join('\n') : '  (none archived)');
    }
    return send(sock, phone, out.join('\n').slice(0, 3500));
  }
  if (p.cmd === 'allow') {
    if (p.sub === 'add') { for (const gid of ok) db.prepare(`INSERT INTO allowlist (gid,uniqname,added_by,ts) VALUES (?,?,?,?) ON CONFLICT(gid,uniqname) DO NOTHING`).run(gid, p.uniqname, phone, now()); return send(sock, phone, `Added ${p.uniqname} to allowlist of ${ok.length} group(s).`); }
    if (p.sub === 'remove') { for (const gid of ok) db.prepare('DELETE FROM allowlist WHERE gid=? AND uniqname=?').run(gid, p.uniqname); return send(sock, phone, `Removed ${p.uniqname} from ${ok.length} group(s).`); }
    if (p.sub === 'enforce') { const on = p.value === 'on' ? 1 : 0; for (const gid of ok) { db.prepare('UPDATE groups SET enforce_allowlist=? WHERE gid=?').run(on, gid); logAction(db, { gid, actor: phone, action: 'setting', target: '', reason: `enforce_allowlist=${on}` }); } return send(sock, phone, `Allowlist enforcement ${p.value} for ${ok.length} group(s).`); }
    // list
    const out = ok.map((gid) => { const rows = db.prepare('SELECT uniqname FROM allowlist WHERE gid=? ORDER BY uniqname').all(gid); return `*${nameOf(db, gid)}*: ${rows.length ? rows.map((r) => r.uniqname).join(', ') : '(empty)'}`; });
    return send(sock, phone, out.join('\n'));
  }
}

export { getSession, setSession, clearSession, adminGroups, WELCOME as ADMIN_WELCOME };
