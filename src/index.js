// =============================================================================
//  index.js — application entry point. Owns the WhatsApp connection lifecycle
//  (pairing, reconnect, dead-man watchdog), routes group and direct messages,
//  applies per-group policy, and drives onboarding / spam enforcement.
// -----------------------------------------------------------------------------
//  Definitions:
//    AUTO_BAN_CAP    max bot-initiated bans per group per 24h; beyond this, flag
//    JOIN_QUEUE      file path polled for invite links to accept
//    STAMP           file storing the last successful-connection timestamp
//    currentSock     the live socket; timers read this, never a stale closure
//    connected       true while the socket is open (watchdog gate)
//    trusted         a member is verified OR grandfathered (exempt from gating)
//    key / memberKey a member's per-group identity (LID when known, else phone)
//    strong          a high-confidence spam signal that warrants deletion
// =============================================================================
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import cfg from '../config.js';
import { openDb } from './db.js';
import { screen, uniqnameAllowedInGroup, tryAutoAdmit } from './screening.js';
import { inspect } from './behavior.js';
import { handleDM, setSession, clearSession, ADMIN_WELCOME } from './commands.js';
import { removeMember, logAction, isBanned, pruneArchive, autoBansLast24hInGroup, isAdminLive, recordLid, recordContact, isContacted, addrFor, addrForId, jid2phone } from './actions.js';
import { normalizePhone } from './security.js';
import { installOutbox } from './outbox.js';
import { bumpStat, snapshotMembers } from './stats.js';

const AUTO_BAN_CAP = 10; // max bot-initiated bans per group per 24h; beyond -> flag only
// Start of "today" in the process timezone (systemd sets TZ=America/Detroit) — DST-correct.
const startOfTodayLocal = () => { const d = new Date(); return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000); };
import { notifyAdmins } from './notify.js';
import { sendAlert } from './alert.js';
import { clean } from './security.js';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';

// Join queue: drop an invite link/code into ./join_queue (one per line) and the running
// bot joins within ~5s. Avoids a second process fighting the live WhatsApp session.
const JOIN_QUEUE = './join_queue';
async function processJoinQueue(sock) {
  if (!existsSync(JOIN_QUEUE)) return;
  let lines;
  try { lines = readFileSync(JOIN_QUEUE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean); } catch { return; }
  if (!lines.length) return;
  try { writeFileSync(JOIN_QUEUE, ''); } catch {} // clear first — never double-join
  for (const line of lines) {
    const m = line.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/) || line.match(/^([A-Za-z0-9_-]{15,40})$/);
    if (!m) { console.log('join: unrecognized invite:', line); continue; }
    try { const gid = await sock.groupAcceptInvite(m[1]); console.log('JOINED group:', gid || '(accepted)'); }
    catch (e) { console.log('join note:', m[1], e.message); } // "already-exists" is fine; resync below
  }
  const n = await syncAllGroups(sock); // capture the group even when accept returns undefined
  console.log('groups after join sync:', n);
}


// Fetch all participating groups, sync each into the DB, welcome admins of newly-seen ones.
async function syncAllGroups(sock) {
  const gs = await sock.groupFetchAllParticipating().catch(() => ({}));
  for (const gid of Object.keys(gs)) {
    const { isNew, newAdmins } = await syncGroup(sock, gid);
    if (isNew) await announceNewGroup(sock, gid, newAdmins);
  }
  return Object.keys(gs).length;
}

// Optional proxy agent (fixes datacenter-IP 405s). Lazy-built from cfg.proxyUrl.
async function buildAgent(url) {
  if (!url) return undefined;
  if (url.startsWith('socks')) { const { SocksProxyAgent } = await import('socks-proxy-agent'); return new SocksProxyAgent(url); }
  const { HttpsProxyAgent } = await import('https-proxy-agent'); return new HttpsProxyAgent(url);
}

const now = () => Math.floor(Date.now() / 1000);
const db = openDb(cfg.dbPath);
const log = pino({ level: 'warn' });

function textOf(msg) {
  const m = msg.message || {};
  return clean(m.conversation || m.extendedTextMessage?.text ||
               m.imageMessage?.caption || m.videoMessage?.caption || '');
}
const groupPolicy = (gid) => db.prepare('SELECT policy FROM groups WHERE gid=?').get(gid)?.policy || cfg.defaultPolicy;
// Per-group strict grace window (hours); falls back to the config default when unset.
const groupGrace = (gid) => db.prepare('SELECT grace_hours FROM groups WHERE gid=?').get(gid)?.grace_hours ?? cfg.graceHours;
const groupName = (gid) => db.prepare('SELECT name FROM groups WHERE gid=?').get(gid)?.name || gid;
const verifiedHere = (gid, phone) => !!db.prepare('SELECT 1 FROM membership WHERE gid=? AND phone=? AND verified=1').get(gid, phone);
// Trusted = verified OR grandfathered (already in the group when the bot arrived). Trusted
// members are exempt from hold-muting, strict grace-kick, and auto-ban (flagged only).
const trustedHere = (gid, phone) => !!db.prepare('SELECT 1 FROM membership WHERE gid=? AND phone=? AND (verified=1 OR pretrusted=1)').get(gid, phone);
const markVerified = (gid, phone, uq) =>
  db.prepare(`INSERT INTO membership (gid,phone,joined_ts,verified,uniqname) VALUES (?,?,?,1,?)
              ON CONFLICT(gid,phone) DO UPDATE SET verified=1, uniqname=excluded.uniqname`).run(gid, phone, now(), uq);

async function syncGroup(sock, gid) {
  const meta = await sock.groupMetadata(gid).catch(() => null);
  if (!meta) return { isNew: false, newAdmins: [] };
  const existed = db.prepare('SELECT 1 FROM groups WHERE gid=?').get(gid);
  db.prepare(`INSERT INTO groups (gid,name,policy) VALUES (?,?,?) ON CONFLICT(gid) DO UPDATE SET name=excluded.name`)
    .run(gid, meta.subject, cfg.defaultPolicy);
  snapshotMembers(db, gid, meta.participants.length); // refresh current count + today's snapshot (baseline at join)
  const liveAdmins = meta.participants.filter((p) => p.admin === 'admin' || p.admin === 'superadmin').map((p) => jid2phone(p.id));
  const known = db.prepare('SELECT admin_phone FROM admin_group WHERE gid=?').all(gid).map((r) => r.admin_phone);
  for (const k of known) if (!liveAdmins.includes(k)) db.prepare('DELETE FROM admin_group WHERE gid=? AND admin_phone=?').run(gid, k);
  const newAdmins = [];
  for (const a of liveAdmins) { if (!known.includes(a)) newAdmins.push(a); db.prepare(`INSERT INTO admin_group (admin_phone,gid) VALUES (?,?) ON CONFLICT(admin_phone,gid) DO NOTHING`).run(a, gid); }
  // First time we see this group: grandfather every current member as pre-trusted so hold/strict
  // only ever gate people who join AFTER the bot. New joiners get their own membership via onJoin.
  if (!existed) {
    const ins = db.prepare(`INSERT INTO membership (gid,phone,joined_ts,pretrusted) VALUES (?,?,?,1)
                            ON CONFLICT(gid,phone) DO UPDATE SET pretrusted=1`);
    for (const p of meta.participants) ins.run(gid, jid2phone(p.id), now());
    console.log('grandfathered %d existing members of %s as pre-trusted', meta.participants.length, meta.subject);
  }
  return { isNew: !existed, newAdmins };
}

// Only message an admin who has contacted the bot before (never cold-DM -> WhatsApp 463 / ban risk).
const welcomeAdmin = (sock, phone, gid) => isContacted(db, phone) ? sock.sendMessage(addrForId(db, phone), { text: ADMIN_WELCOME(groupName(gid)) }).catch(() => {}) : Promise.resolve();

// New-group announcement. NEVER blast every detected admin (Community admins bleed into
// linked-group admin lists → spam flag + wrong targets). Superadmin gets a short notice;
// detected admins get the full guide only if cfg.welcomeGroupAdmins is explicitly on.
async function announceNewGroup(sock, gid, detectedAdmins) {
  const supers = (cfg.superadmins || []).map(String);
  for (const s of supers)
    if (isContacted(db, s)) // only if the operator has DMed the bot (never cold-DM)
      await sock.sendMessage(addrFor(db, s), { text: `🪿 Guardian Goose joined *${groupName(gid)}* (${detectedAdmins.length} admins detected). Promote me to admin to enable moderation. DM /help to manage.` }).catch(() => {});
  if (cfg.welcomeGroupAdmins)
    for (const a of detectedAdmins) if (!supers.includes(a)) await welcomeAdmin(sock, a, gid);
}
const goodbyeAdmin = (sock, phone, gid) => isContacted(db, phone) ? sock.sendMessage(addrForId(db, phone), { text: `You were removed as admin of ${groupName(gid)}. I'll no longer accept admin commands from you for that group.` }).catch(() => {}) : Promise.resolve();

const welcomeTimes = new Map();   // gid -> timestamps (ms) of NEW welcome posts in the trailing hour
const welcomeBatch = new Map();   // gid -> { key, entries:[{tag,mentions}], ts } active editable batch
const WELCOME_EDIT_WINDOW = 14 * 60 * 1000; // WhatsApp allows message edits for ~15 min

// True while this group is under its per-hour cap for NEW welcome posts (edits don't count).
function newWelcomeAllowed(gid) {
  const t = Date.now();
  const arr = (welcomeTimes.get(gid) || []).filter((x) => t - x < 3600_000);
  if (arr.length >= (cfg.welcomeMaxPerHour || 6)) { welcomeTimes.set(gid, arr); return false; }
  arr.push(t); welcomeTimes.set(gid, arr); return true;
}

// Post ONE welcome per group and EDIT it to add later joiners within the edit window, instead of
// a message per joiner. A fresh message starts only when the window has passed (and the per-hour
// cap allows it). Keeps join traffic to a trickle of edits rather than a spammy blast.
async function postWelcome(sock, gid, tag, mentionJids, extra) {
  const t = Date.now();
  const b = welcomeBatch.get(gid);
  const render = (entries) =>
    `🪿 Welcome ${entries.map((e) => e.tag).join(' ')}! DM me your *uniqname* to verify.${extra}`;

  // Inside the edit window: fold the new joiner into the existing message.
  if (b && t - b.ts < WELCOME_EDIT_WINDOW && b.entries.length < 40) {
    b.entries.push({ tag, mentions: mentionJids });
    const mentions = [...new Set(b.entries.flatMap((e) => e.mentions))];
    const text = render(b.entries);
    await sock.sendMessage(gid, { text, edit: b.key, mentions }).catch(() => {});
    b.lastText = text;
    return;
  }

  // Past the edit window: REPLY to the previous welcome and @ the newcomer (don't let it pass).
  // That reply becomes the new batch, editable for its own window, so replies chain rather than
  // scattering standalone posts. Only the very first welcome is subject to the per-hour cap.
  const entries = [{ tag, mentions: mentionJids }];
  const text = render(entries);
  const opts = b ? { quoted: { key: b.key, message: { conversation: b.lastText || 'Welcome' } } } : {};
  if (!b && !newWelcomeAllowed(gid)) return;
  const sent = await sock.sendMessage(gid, { text, mentions: mentionJids }, opts).catch(() => null);
  if (sent?.key) welcomeBatch.set(gid, { key: sent.key, entries, ts: t, lastText: text });
}

// A joiner is keyed by their LID (matches grandfather snapshot + message handler). `phone`
// (from the event's phoneNumber) is learned for VOIP screening, uniqname record, and DM reply.
async function onJoin(sock, gid, lid, phone) {
  if (groupPolicy(gid) === 'off') return; // bot disabled for this group
  const key = lid || phone;
  if (phone && lid) recordLid(db, phone, lid);

  if (isBanned(db, gid, key)) {
    const d = await removeMember(sock, db, gid, key, 'bot', 'rejoin while banned', { ban: true });
    if (d !== -1) { await notifyAdmins(sock, db, gid, 'remove', `🪿 Honk! re-kicked ${key} (banned) on rejoin`); return; }
    await notifyAdmins(sock, db, gid, 'flag', `banned ${key} rejoined but is protected (admin) — ban NOT enforced`);
  }
  db.prepare(`INSERT INTO membership (gid,phone,joined_ts) VALUES (?,?,?)
              ON CONFLICT(gid,phone) DO UPDATE SET joined_ts=excluded.joined_ts`).run(gid, key, now());
  if (phone) await screen(db, cfg, phone); // VOIP/foreign facts, keyed by real phone
  if (trustedHere(gid, key)) return;        // grandfathered or already verified

  // Known uniqname allowed here -> admit silently.
  const known = phone ? db.prepare('SELECT uniqname FROM members WHERE phone=?').get(phone)?.uniqname : null;
  if (known && uniqnameAllowedInGroup(db, gid, known)) { markVerified(gid, key, known); return; }

  // Onboard: session keyed by PHONE so the joiner's DM reply matches; store the membership key.
  setSession(db, phone || key, { cmd: 'onboard', gid, memberKey: key });
  const policy = groupPolicy(gid);
  await notifyAdmins(sock, db, gid, 'flag', `verify requested from ${phone || key} (policy=${policy})`);

  // Auto-welcome is OPT-IN. When on, joiners are BATCHED into one editable message per group
  // (no per-joiner posts, no per-joiner DMs) so a busy group can't trigger a spam-flag.
  if (!cfg.welcomeOnJoin) return;
  const extra = policy === 'hold' ? ' Until you do, your messages here are removed.'
              : policy === 'strict' ? ` You have ${groupGrace(gid)}h or you'll be removed.` : '';
  const mentions = [...new Set([phone ? `${phone}@s.whatsapp.net` : null, `${key}@lid`].filter(Boolean))];
  const tag = phone ? `@${phone}` : `@${key}`;
  await postWelcome(sock, gid, tag, mentions, extra);
}

// strict-policy grace kick: remove members unverified IN THAT GROUP past graceHours. NOT a ban.
// Never touches admins (cached skip here + live fail-closed guard inside removeMember).
async function graceSweep(sock) {
  // Each strict group uses its own grace window (per-group grace_hours, else the config default).
  for (const g of db.prepare(`SELECT gid, COALESCE(grace_hours,?) gh FROM groups WHERE policy='strict'`).all(cfg.graceHours)) {
    const cutoff = now() - g.gh * 3600;
    const rows = db.prepare(`SELECT phone FROM membership WHERE gid=? AND joined_ts<? AND verified=0 AND pretrusted=0`).all(g.gid, cutoff);
    for (const r of rows) {
      if (db.prepare('SELECT 1 FROM admin_group WHERE gid=? AND admin_phone=?').get(g.gid, r.phone)) continue;
      const deleted = await removeMember(sock, db, g.gid, r.phone, 'bot', 'strict: unverified past grace');
      if (deleted === -1) continue; // protected — refused
      clearSession(db, r.phone);
      await notifyAdmins(sock, db, g.gid, 'remove', `auto-removed ${r.phone} — unverified after ${g.gh}h (strict); deleted ${deleted} msg(s)`);
    }
  }
}

// In-chat "/ban <number>" typed in the group by an admin (or superadmin). Bans + deletes
// TODAY's messages for everyone, and confirms IN the chat. Non-admins: silently ignored.
async function handleInChatBan(sock, gid, actorPhone, body) {
  const reply = (t) => sock.sendMessage(gid, { text: t }).catch(() => {});
  const isSuper = (cfg.superadmins || []).includes(actorPhone);
  if (!isSuper && !(await isAdminLive(sock, db, gid, actorPhone))) return; // authz: live admin only

  const target = normalizePhone(body.replace(/^\/ban\b/i, ''), cfg.homeCountryCode);
  if (!target) return reply('Usage: /ban <phone number> (with or without country code)');
  if (target === actorPhone) return reply("You can't ban yourself.");

  const deleted = await removeMember(sock, db, gid, target, actorPhone, 'in-chat /ban', { ban: true, since: startOfTodayLocal() });
  if (deleted === -1) return reply(`⚠️ ${target} is a group admin — not banned.`);
  await reply(`🪿 Honk! Banned ${target}. Deleted ${deleted} of today's message(s) for everyone. Rejoins will be auto-removed.`);
  await notifyAdmins(sock, db, gid, 'remove', `🪿 Honk! admin ${actorPhone} used /ban on ${target} in chat; archived + deleted ${deleted} of today's msg(s)`);
}

// Single-flight reconnect: NEVER recurse/stack sockets. One pending reconnect at a time,
// with backoff so a failing connect can't hammer WhatsApp into a 405 rate-limit.
let reconnectTimer = null;
let reconnectAttempts = 0;
let sweepTimer = null;
let joinTimer = null;
let watchdogTimer = null;
let downAlerted = false;
let connected = false;  // live connection state — watchdog must never alert while true
let currentSock = null; // always the live socket; timers use this, never a stale closure

// Persistent "last successfully connected" stamp — survives process restarts so the dead-man
// watchdog can't be reset by systemd churn. Alerts once if truly down >15 min.
const STAMP = './.last_connected';
const stampConnected = () => { try { writeFileSync(STAMP, String(Date.now())); } catch {} };
function watchdog() {
  if (connected) { downAlerted = false; return; } // currently online -> never alert
  let last = 0;
  try { last = parseInt(readFileSync(STAMP, 'utf8'), 10) || 0; } catch { return; } // no stamp yet (pairing) -> skip
  if (last && Date.now() - last > 15 * 60 * 1000 && !downAlerted) {
    downAlerted = true;
    sendAlert(cfg, 'Guardian Goose is DOWN (>15 min offline)',
      `No WhatsApp connection since ${new Date(last).toISOString()} (~${Math.round((Date.now() - last) / 60000)} min).\n` +
      `Likely logged out, banned, or crashed. On the VPS:\n` +
      `  systemctl status antispam && tail -50 /var/log/antispam.log\n` +
      `If logged out: clear auth_state, set pairNumber, restart, re-enter the pairing code.`).catch(() => {});
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(cfg.authDir);
  const agent = await buildAgent(cfg.proxyUrl).catch((e) => { console.error('proxy agent failed:', e.message); return undefined; });
  if (agent) console.log('using proxy for WhatsApp connection');
  const sock = makeWASocket({ auth: state, logger: log, printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), agent, fetchAgent: agent });
  installOutbox(sock, { minGapMs: cfg.sendMinGapMs, jitterMs: cfg.sendJitterMs, dailyCap: cfg.sendDailyCap }); // pace ALL sends
  currentSock = sock;
  sock.ev.on('creds.update', saveCreds);

  // QR-less pairing: request the code PROACTIVELY when unregistered (don't wait for a qr
  // event — with pairing the socket may 405-close before qr ever fires). Fires once per start.
  if (cfg.pairNumber && !state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(String(cfg.pairNumber).replace(/\D/g, ''));
        console.log(`\n==== WHATSAPP PAIRING CODE: ${code} ====`);
        console.log('Enter in WhatsApp > Settings > Linked Devices > Link a device > "Link with phone number instead".\n');
      } catch (e) { console.error('pairing code request failed:', e.message); }
    }, 3000);
    sendAlert(cfg, 'WhatsApp anti-spam bot NOT PAIRED',
      `The bot is running but has no WhatsApp session (${new Date().toISOString()}).\n` +
      `A pairing code is printed to /var/log/antispam.log on the VPS — enter it in\n` +
      `WhatsApp > Linked Devices > Link with phone number. Until then the bot is inactive.`).catch(() => {});
  }

  sock.ev.on('connection.update', async (u) => {
    if (u.qr && !cfg.pairNumber) qrcode.generate(u.qr, { small: true });

    if (u.connection === 'open') {
      reconnectAttempts = 0;
      downAlerted = false;
      connected = true;
      stampConnected();
      sock.sendPresenceUpdate('available').catch(() => {}); // online presence so typing indicators show
      const n = await syncAllGroups(sock);
      console.log('connected. groups:', n);
      if (!watchdogTimer) watchdogTimer = setInterval(watchdog, 5 * 60 * 1000);
      if (!joinTimer) joinTimer = setInterval(() => { processJoinQueue(currentSock).catch(() => {}); }, 5000);
      if (!sweepTimer) sweepTimer = setInterval(() => {
        graceSweep(currentSock).catch(() => {});
        try { pruneArchive(db); } catch {}
        try { db.prepare('DELETE FROM msg_index WHERE ts<?').run(now() - 7 * 86400); } catch {} // 7-day index retention
        try { db.prepare('DELETE FROM pending_bans WHERE ts<?').run(now() - 2 * 86400); } catch {} // 48h pending expiry
      }, 15 * 60 * 1000);
    }

    if (u.connection === 'close') {
      connected = false;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      if (reconnectTimer) return;
      reconnectAttempts++;
      // A single 401 can be transient (auto-recovers on reconnect). But a PERSISTENT logout
      // (device actually unlinked / banned) means the creds are dead — reconnecting with them
      // just 401-loops forever. After 2 consecutive logouts with no successful 'open', clear
      // auth_state so the next start() requests a FRESH pairing code (auto re-pair path).
      // Only clear a PREVIOUSLY-REGISTERED session. During initial pairing (never registered)
      // clearing just rotates the pairing code and prevents linking, so leave it alone.
      if (loggedOut && reconnectAttempts >= 2 && cfg.pairNumber && state.creds.registered) {
        console.log('persistent logout — clearing auth_state to force re-pair.');
        try { rmSync(cfg.authDir, { recursive: true, force: true }); } catch {}
        sendAlert(cfg, 'Guardian Goose LOGGED OUT — re-pair needed',
          `The WhatsApp session was terminated (device unlinked/banned) at ${new Date().toISOString()}.\n` +
          `Auth cleared; a NEW pairing code is being printed to /var/log/antispam.log.\n` +
          `Enter it in WhatsApp > Linked Devices > Link with phone number.`).catch(() => {});
      }
      const delay = Math.min(60_000, 5_000 * reconnectAttempts);    // 5s,10s,... capped 60s
      console.log(`closed (code ${code ?? '?'}${loggedOut ? ' loggedOut' : ''}). reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}).`);
      reconnectTimer = setTimeout(() => { reconnectTimer = null; start(); }, delay);
    }
  });

  // Bot added to / discovering a group (e.g. via invite accept) -> register + welcome admins.
  sock.ev.on('groups.upsert', async (groups) => {
    for (const g of groups) { const { isNew, newAdmins } = await syncGroup(sock, g.id); if (isNew) await announceNewGroup(sock, g.id, newAdmins); }
  });

  // Baileys 7 delivers participants as objects {id:"…@lid", phoneNumber:"…@s.whatsapp.net"}
  // (older versions: plain jid strings). These helpers handle both.
  const partLid = (p) => jid2phone(typeof p === 'string' ? p : p?.id);
  const partPn = (p) => (p && typeof p === 'object' && p.phoneNumber) ? jid2phone(p.phoneNumber) : null;

  sock.ev.on('group-participants.update', async ({ id: gid, participants, action }) => {
    const botLid = jid2phone(sock.user?.lid || '');
    const botPhone = jid2phone(sock.user?.id || '');
    if (action === 'add') {
      // Only genuine new arrivals get an auto-DM. Skip the bot's own join event so joining a
      // group never DMs the existing members (they're grandfathered by syncGroup instead).
      await syncGroup(sock, gid);
      for (const part of participants) {
        const lid = partLid(part), phone = partPn(part);
        if (!lid || lid === botLid || lid === botPhone || phone === botPhone) continue;
        bumpStat(db, gid, 'joins');
        await onJoin(sock, gid, lid, phone);
      }
    } else if (action === 'promote') {
      await syncGroup(sock, gid);
      for (const part of participants) { if (partPn(part)) recordLid(db, partPn(part), partLid(part)); await welcomeAdmin(sock, partLid(part), gid); }
    } else if (action === 'demote') {
      for (const part of participants) {
        const lid = partLid(part);
        db.prepare('DELETE FROM admin_group WHERE gid=? AND admin_phone=?').run(gid, lid);
        clearSession(db, partPn(part) || lid);
        await goodbyeAdmin(sock, lid, gid);
      }
      await syncGroup(sock, gid);
    } else if (action === 'remove') {
      for (const part of participants) { db.prepare('DELETE FROM membership WHERE gid=? AND phone=?').run(gid, partLid(part)); bumpStat(db, gid, 'leaves'); }
      await syncGroup(sock, gid);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const isGroup = jid.endsWith('@g.us');
      const body = textOf(msg);

      // WhatsApp addresses users by LID; the real phone rides in remoteJidAlt (DM) /
      // participantPn (group). Learn phone<->lid; key DMs by phone (superadmin/admin match),
      // key group members by LID (consistent with join events which only expose LIDs).
      const senderId = isGroup ? msg.key.participant : jid;          // usually a @lid
      const senderAlt = isGroup ? msg.key.participantPn : msg.key.remoteJidAlt;
      const altPhone = senderAlt ? jid2phone(senderAlt) : null;
      const senderLid = String(senderId).endsWith('@lid') ? jid2phone(senderId) : null;
      if (altPhone && senderLid) recordLid(db, altPhone, senderLid);
      const phone = isGroup ? (senderLid || jid2phone(senderId)) : (altPhone || jid2phone(senderId));

      if (!isGroup) {
        await sock.readMessages([msg.key]).catch(() => {}); // send a read receipt, then reply
        // A DM to the bot establishes contact, so it may reply / notify this id later.
        recordContact(db, phone); recordContact(db, senderLid);
        await handleDM(sock, db, cfg, phone, body, senderLid);
        continue;
      }

      // Group disabled -> bot ignores it entirely (no /ban, no indexing, no screening).
      if (groupPolicy(jid) === 'off') continue;

      // In-chat admin command: "/ban <number>" typed IN the group.
      if (/^\/ban\b/i.test(body)) { await handleInChatBan(sock, jid, phone, body); continue; }

      const hasMedia = !!(msg.message.imageMessage || msg.message.videoMessage || msg.message.documentMessage || msg.message.stickerMessage || msg.message.audioMessage);
      const isFirstMessage = !db.prepare('SELECT 1 FROM msg_index WHERE gid=? AND phone=? LIMIT 1').get(jid, phone);

      db.prepare(`INSERT OR IGNORE INTO msg_index (gid,phone,msg_id,body,ts) VALUES (?,?,?,?,?)`).run(jid, phone, msg.key.id, body, now());
      bumpStat(db, jid, 'messages'); // message-volume counter for /stats

      // Per-group verification. Known uniqname allowed here -> silent admit.
      let verified = verifiedHere(jid, phone);
      if (!verified) {
        const known = db.prepare('SELECT uniqname FROM members WHERE phone=?').get(phone)?.uniqname;
        if (known && uniqnameAllowedInGroup(db, jid, known)) { markVerified(jid, phone, known); verified = true; }
      }

      // Revoke THIS message for everyone (sender addressed by their exact in-group id).
      const revoke = async () => {
        await sock.sendMessage(jid, { delete: { remoteJid: jid, id: msg.key.id, participant: senderId, fromMe: false } }).catch(() => {});
        db.prepare('DELETE FROM msg_index WHERE gid=? AND msg_id=?').run(jid, msg.key.id);
      };

      // Trusted = verified OR grandfathered (in the group before the bot). Only NEW,
      // untrusted members are gated by hold/strict and eligible for auto-ban.
      const trusted = verified || trustedHere(jid, phone);

      // hold policy: untrusted members can't speak — delete every message until they register.
      if (!trusted && groupPolicy(jid) === 'hold') await revoke();

      // Spam signals ALWAYS inspected (self-attested verification grants no immunity).
      const signals = inspect(cfg, phone, jid, body, { hasMedia, isFirstMessage });
      if (!signals.length) continue;
      const member = db.prepare('SELECT is_voip,is_foreign FROM members WHERE phone=?').get(phone);
      const voip = member?.is_voip === 1;
      // STRONG = high-confidence spam: drive-by first-message spam, cross-group broadcast,
      // scam keywords. (link/dm_solicit/media/wall/burst alone -> flag, not auto-delete.)
      const strong = signals.includes('first_msg_spam') || signals.includes('cross_group') || signals.includes('scam_keyword');

      if (trusted) {
        if (strong) {
          logAction(db, { gid: jid, actor: 'bot', action: 'flag', target: phone, reason: `trusted-member: ${signals.join(',')}` });
          await notifyAdmins(sock, db, jid, 'flag', `⚠️ Trusted member ${phone} showing spam signals (${signals.join(',')}). /remove ${phone} if warranted.`);
        }
        continue;
      }

      // Unverified + strong signal: pull the message immediately (needs bot=admin to revoke).
      if (strong) await revoke();

      if (strong && voip && autoBansLast24hInGroup(db, jid) < AUTO_BAN_CAP) {
        const deleted = await removeMember(sock, db, jid, phone, 'bot', `auto: voip+${signals.join(',')}`, { ban: true });
        if (deleted === -1) continue; // protected target — refused
        await notifyAdmins(sock, db, jid, 'remove', `🪿 Honk! auto-BANNED ${phone} — VOIP + ${signals.join(',')}; archived+deleted ${deleted} msg(s)`);
      } else if (strong && voip) {
        // Auto-ban cap reached — queue for admin approval instead of banning automatically.
        db.prepare(`INSERT INTO pending_bans (gid,phone,lastmsg,reason,ts) VALUES (?,?,?,?,?)
                    ON CONFLICT(gid,phone) DO UPDATE SET lastmsg=excluded.lastmsg, reason=excluded.reason, ts=excluded.ts`)
          .run(jid, phone, body.slice(0, 120), signals.join(','), now());
        const pend = db.prepare('SELECT phone,lastmsg FROM pending_bans WHERE gid=? ORDER BY id').all(jid);
        const list = pend.map((p, i) => `${i + 1}. ${p.phone} — "${(p.lastmsg || '').slice(0, 50)}"`).join('\n');
        await notifyAdmins(sock, db, jid, 'flag',
          `🛑 Auto-ban cap (${AUTO_BAN_CAP}/24h) reached. ${phone} needs your OK.\nPending bans:\n${list}\nReply */confirmban 1 2* to ban those (by number).`);
      } else if (strong || signals.includes('link') || signals.includes('dm_solicit')) {
        logAction(db, { gid: jid, actor: 'bot', action: 'flag', target: phone, reason: signals.join(',') });
        await notifyAdmins(sock, db, jid, 'flag',
          `⚠️ ${phone} flagged (${signals.join(',')}). voip=${member?.is_voip ?? '?'} foreign=${member?.is_foreign ? 'yes' : 'no'}. /remove ${phone}`);
      }
    }
  });
}

start().catch((e) => { console.error(e); process.exit(1); });
