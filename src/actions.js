// =============================================================================
//  actions.js — moderation primitives shared across the bot: message deletion,
//  member removal / banning, LID<->phone address resolution, and ban-rate
//  accounting.
// -----------------------------------------------------------------------------
//  Definitions:
//    jid          full WhatsApp address ("<id>@s.whatsapp.net" or "<id>@lid")
//    lid          WhatsApp privacy identifier that stands in for a phone number
//    ARCHIVE_MAX  max messages kept per banned user per group
//    ARCHIVE_DAYS retention window (days) for archived messages
//    opts.ban     when true, removeMember records a ban and archives messages
//    opts.since   only delete messages at/after this unix timestamp
// =============================================================================

const now = () => Math.floor(Date.now() / 1000);            // current unix time (seconds)
export const jid2phone = (jid) => (jid || '').split('@')[0].split(':')[0]; // extract the numeric id from a jid
export const phone2jid = (p) => `${p}@s.whatsapp.net`;      // build a classic phone jid

// LID mapping. WhatsApp addresses users by a privacy LID; we learn phone<->lid from inbound
// message keys and address outbound to the @lid so sends aren't rejected (463).
export const recordLid = (db, phone, lid) => {
  if (!phone || !lid || phone === lid) return;
  db.prepare('INSERT INTO lidmap (phone,lid) VALUES (?,?) ON CONFLICT(phone) DO UPDATE SET lid=excluded.lid').run(phone, lid);
};
export const lidForPhone = (db, phone) => db.prepare('SELECT lid FROM lidmap WHERE phone=?').get(phone)?.lid || null;
// Best address for a PHONE: the @lid if known, else the classic phone jid.
export const addrFor = (db, phone) => { const l = lidForPhone(db, phone); return l ? `${l}@lid` : `${phone}@s.whatsapp.net`; };
// Best address for an ID that is already a LID (group participant/admin ids under WhatsApp
// LID addressing). Maps a phone->lid if given a phone; otherwise treats the id as a LID.
export const addrForId = (db, id) => { if (!id) return ''; const l = lidForPhone(db, id); return `${l || id}@lid`; };

// LIVE admin check — always hit group metadata, never trust the DB cache for authz.
// Also refreshes admin_group so promote/demote can't leave a stale grant.
export async function isAdminLive(sock, db, gid, phone) {
  const meta = await sock.groupMetadata(gid).catch(() => null);
  if (!meta) return false;
  const admins = meta.participants
    .filter((p) => p.admin === 'admin' || p.admin === 'superadmin')
    .map((p) => jid2phone(p.id));
  // Remove grants for anyone no longer admin (preserve notif_level of those who stay).
  const known = db.prepare('SELECT admin_phone FROM admin_group WHERE gid=?').all(gid).map((r) => r.admin_phone);
  for (const k of known)
    if (!admins.includes(k)) db.prepare('DELETE FROM admin_group WHERE gid=? AND admin_phone=?').run(gid, k);
  for (const a of admins)
    db.prepare(`INSERT INTO admin_group (admin_phone,gid) VALUES (?,?)
                ON CONFLICT(admin_phone,gid) DO NOTHING`).run(a, gid);
  // Match by phone OR its LID (metadata ids are LIDs under WhatsApp's LID addressing).
  return admins.includes(phone) || admins.includes(lidForPhone(db, phone));
}

export function logAction(db, { gid, actor, action, target, reason }) {
  db.prepare(`INSERT INTO action_log (ts,gid,actor,action,target,reason)
              VALUES (?,?,?,?,?,?)`).run(now(), gid, actor, action, target, reason);
}

// Revoke (delete-for-everyone) indexed messages by `phone` in `gid`.
// since=0 -> all indexed; since=<unix ts> -> only messages at/after that time.
export async function deleteMessages(sock, db, gid, phone, since = 0) {
  const rows = db.prepare('SELECT msg_id FROM msg_index WHERE gid=? AND phone=? AND ts>=?').all(gid, phone, since);
  const del = db.prepare('DELETE FROM msg_index WHERE gid=? AND msg_id=?');
  for (const r of rows) {
    const key = { remoteJid: gid, id: r.msg_id, participant: phone2jid(phone), fromMe: false };
    await sock.sendMessage(gid, { delete: key }).catch(() => {});
    del.run(gid, r.msg_id);
  }
  return rows.length;
}

export const isBanned = (db, gid, phone) => !!db.prepare('SELECT 1 FROM bans WHERE gid=? AND phone=?').get(gid, phone);

// LIVE protected-target check: the bot must NEVER remove/ban a group admin or itself.
// Fail-closed: if metadata can't be fetched, treat as protected (refuse the action).
export async function isProtectedTarget(sock, db, gid, phone) {
  if (phone === jid2phone(sock.user?.id || '')) return true;         // bot itself
  const meta = await sock.groupMetadata(gid).catch(() => null);
  if (!meta) return true;                                            // can't verify -> refuse
  const p = meta.participants.find((x) => jid2phone(x.id) === phone);
  return !!(p && (p.admin === 'admin' || p.admin === 'superadmin'));
}

// Ban-rate accounting for the mass-ban brake.
export const bansLast24hByActor = (db, actor) =>
  db.prepare(`SELECT count(*) c FROM action_log WHERE actor=? AND action='ban' AND ts>?`)
    .get(actor, now() - 86400).c;
export const autoBansLast24hInGroup = (db, gid) =>
  db.prepare(`SELECT count(*) c FROM action_log WHERE gid=? AND actor='bot' AND action='ban' AND ts>?`)
    .get(gid, now() - 86400).c;

export const ARCHIVE_MAX = 45;    // keep last N messages per (gid,phone)
export const ARCHIVE_DAYS = 30;   // drop archived messages older than this

// Copy a user's indexed messages into the archive, then trim to last ARCHIVE_MAX.
function archiveUserMessages(db, gid, phone) {
  db.prepare(`INSERT OR IGNORE INTO msg_archive (gid,phone,msg_id,body,ts)
              SELECT gid,phone,msg_id,body,ts FROM msg_index WHERE gid=? AND phone=?`).run(gid, phone);
  db.prepare(`DELETE FROM msg_archive WHERE gid=? AND phone=? AND msg_id NOT IN
              (SELECT msg_id FROM msg_archive WHERE gid=? AND phone=? ORDER BY ts DESC LIMIT ?)`)
    .run(gid, phone, gid, phone, ARCHIVE_MAX);
}
export const fetchArchive = (db, gid, phone, limit = ARCHIVE_MAX) =>
  db.prepare('SELECT body,ts FROM msg_archive WHERE gid=? AND phone=? ORDER BY ts DESC LIMIT ?')
    .all(gid, phone, Math.min(limit, ARCHIVE_MAX));
export const pruneArchive = (db) =>
  db.prepare('DELETE FROM msg_archive WHERE ts < ?').run(now() - ARCHIVE_DAYS * 86400);

// Kick + delete + log, all scoped to ONE group. Bot must be that group's admin.
// opts.ban=true records a per-group ban (rejoin auto re-kicked) AND archives the
// user's messages (last 45 / 30 days) before revoking them.
// Returns -1 (and does NOTHING) if the target is protected (group admin / the bot).
export async function removeMember(sock, db, gid, phone, actor, reason, opts = {}) {
  if (await isProtectedTarget(sock, db, gid, phone)) {
    logAction(db, { gid, actor, action: 'refused', target: phone, reason: `protected target (${reason})` });
    return -1;
  }
  if (opts.ban) archiveUserMessages(db, gid, phone); // archive BEFORE deleteMessages clears msg_index
  const deleted = await deleteMessages(sock, db, gid, phone, opts.since || 0);
  await sock.groupParticipantsUpdate(gid, [phone2jid(phone)], 'remove').catch(() => {});
  db.prepare('DELETE FROM membership WHERE gid=? AND phone=?').run(gid, phone);
  if (opts.ban) db.prepare(`INSERT INTO bans (gid,phone,by,ts) VALUES (?,?,?,?)
                            ON CONFLICT(gid,phone) DO NOTHING`).run(gid, phone, actor, now());
  logAction(db, { gid, actor, action: opts.ban ? 'ban' : 'remove', target: phone, reason });
  return deleted;
}

export function unbanMember(db, gid, phone, actor) {
  const had = isBanned(db, gid, phone);
  db.prepare('DELETE FROM bans WHERE gid=? AND phone=?').run(gid, phone);
  if (had) logAction(db, { gid, actor, action: 'unban', target: phone, reason: 'admin /unban' });
  return had;
}
