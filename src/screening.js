// =============================================================================
//  screening.js — number classification (VOIP / foreign) and per-group
//  admission decisions (allowlist checks, auto-admit of known members).
// -----------------------------------------------------------------------------
//  Definitions:
//    is_voip      1 = number is a VOIP line, 0 = not, null = unknown
//    is_foreign   1 = number's country code differs from cfg.homeCountryCode
//    allowlist    per-group set of approved uniqnames
//    auto-admit    silently verify a member whose known uniqname is allowed here
// =============================================================================
import { getProvider } from './providers/index.js';

const now = () => Math.floor(Date.now() / 1000);           // current unix time (seconds)

// Classify a joiner. Records/updates member row. Returns member object.
export async function screen(db, cfg, phone) {
  const provider = getProvider(cfg.voipProvider);
  const { isVoip } = await provider.lookup(phone).catch(() => ({ isVoip: null }));
  const isForeign = !phone.startsWith(cfg.homeCountryCode) ? 1 : 0;

  const existing = db.prepare('SELECT * FROM members WHERE phone=?').get(phone);
  db.prepare(`INSERT INTO members (phone,is_voip,is_foreign,first_seen,updated_at)
              VALUES (?,?,?,?,?)
              ON CONFLICT(phone) DO UPDATE SET is_voip=excluded.is_voip,
                is_foreign=excluded.is_foreign, updated_at=excluded.updated_at`)
    .run(phone, isVoip === null ? null : (isVoip ? 1 : 0), isForeign,
         existing?.first_seen || now(), now());

  return db.prepare('SELECT * FROM members WHERE phone=?').get(phone);
}

// Is this uniqname allowed in THIS group? Enforcement + list are per-group.
// Allowed when: group doesn't enforce, OR group's allowlist is empty, OR uniqname is listed for gid.
export function uniqnameAllowedInGroup(db, gid, uniqname) {
  const g = db.prepare('SELECT enforce_allowlist FROM groups WHERE gid=?').get(gid);
  if (!g || !g.enforce_allowlist) return true;
  const hasList = db.prepare('SELECT 1 FROM allowlist WHERE gid=? LIMIT 1').get(gid);
  if (!hasList) return true;
  return !!db.prepare('SELECT 1 FROM allowlist WHERE gid=? AND uniqname=?').get(gid, uniqname);
}

// Per-group admission on join. uniqname identity is global; trust is per-group.
// Returns { admit, reason } — admit=true means silently verify in this group (no DM needed).
export function tryAutoAdmit(db, gid, phone) {
  const known = db.prepare('SELECT uniqname FROM members WHERE phone=?').get(phone)?.uniqname;
  if (known && uniqnameAllowedInGroup(db, gid, known))
    return { admit: true, uniqname: known, reason: `known uniqname ${known} allowed here` };
  return { admit: false, reason: known ? 'known uniqname not on this group allowlist' : 'uniqname unknown' };
}
