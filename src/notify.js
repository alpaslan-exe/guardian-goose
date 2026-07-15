// =============================================================================
//  notify.js — deliver action notifications to a group's admins by DM,
//  respecting each admin's chosen notification level.
// -----------------------------------------------------------------------------
//  Definitions:
//    notif_level  per-admin, per-group: 'all' | 'kicks' | 'none'
//    kind         event type ('remove', 'flag', ...); 'kicks' level only gets
//                 kick/remove events
// =============================================================================
import { addrForId, isContacted } from './actions.js';

// Notify all admins of `gid` per their notif_level.
// level 'none' -> nothing. 'kicks' -> only kick/remove events. 'all' -> everything.
// admin_phone is whatever id groupMetadata returned (a LID under WhatsApp LID addressing).
// ToS safety: only DM admins who have contacted the bot first (recorded in `contacted`);
// messaging a stranger who never messaged the bot is blocked by WhatsApp (463) and risks a ban.
export async function notifyAdmins(sock, db, gid, kind, text) {
  const admins = db.prepare('SELECT admin_phone, notif_level FROM admin_group WHERE gid=?').all(gid);
  const gname = db.prepare('SELECT name FROM groups WHERE gid=?').get(gid)?.name || gid;
  for (const a of admins) {
    if (a.notif_level === 'none') continue;
    if (a.notif_level === 'kicks' && !['kick', 'remove'].includes(kind)) continue;
    if (!isContacted(db, a.admin_phone)) continue; // never cold-DM
    await sock.sendMessage(addrForId(db, a.admin_phone), { text: `[${gname}] ${text}` }).catch(() => {});
  }
}
