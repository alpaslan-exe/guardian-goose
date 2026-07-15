// =============================================================================
//  db.js — SQLite schema and connection factory.
// -----------------------------------------------------------------------------
//  Definitions:
//    gid         WhatsApp group id (e.g. "1203...@g.us")
//    phone       member key: E.164 digits, or a WhatsApp LID when the phone is
//                not exposed (see actions.js lidmap)
//    policy      per-group moderation mode: 'chill' | 'hold' | 'strict' | 'off'
//    verified    member has confirmed a uniqname in that group
//    pretrusted  member was already in the group when the bot joined (grandfathered)
//    uniqname    org identifier used to verify a member (e.g. a campus username)
// =============================================================================
import { DatabaseSync } from 'node:sqlite';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    -- GLOBAL identity/number facts. uniqname = person identity (known once, reused).
    -- Trust/admission is NOT here — it is per-group (see membership).
    CREATE TABLE IF NOT EXISTS members (
      phone       TEXT PRIMARY KEY,      -- E.164, no '+'
      uniqname    TEXT,                  -- last known uniqname (global identity), NULL until given
      is_voip     INTEGER,               -- 0/1/NULL(unknown)
      is_foreign  INTEGER,
      first_seen  INTEGER,
      updated_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS groups (
      gid              TEXT PRIMARY KEY,  -- WhatsApp group jid
      name             TEXT,
      policy           TEXT DEFAULT 'chill', -- 'chill' | 'hold' | 'strict' | 'off' (PER GROUP)
      enforce_allowlist INTEGER DEFAULT 0,   -- PER GROUP: require uniqname on this group's allowlist
      member_count     INTEGER DEFAULT 0,    -- current participant count, refreshed on each sync
      grace_hours      INTEGER               -- PER GROUP strict grace window; NULL = use config default
    );

    -- Daily snapshot of each group's total member count (baseline stats + /membercount at a point
    -- in time). First recorded when the bot joins the group.
    CREATE TABLE IF NOT EXISTS member_snapshots (
      gid   TEXT,
      day   TEXT,                          -- 'YYYY-MM-DD' in the display timezone
      count INTEGER,
      PRIMARY KEY (gid, day)
    );

    -- Pre-approved uniqnames, PER GROUP. If enforce_allowlist and this group has entries,
    -- a joiner's uniqname must be listed for this gid to be admitted.
    CREATE TABLE IF NOT EXISTS allowlist (
      gid      TEXT,
      uniqname TEXT,
      added_by TEXT,
      ts       INTEGER,
      PRIMARY KEY (gid, uniqname)
    );

    -- PER-GROUP membership: join time (grace kick) + per-group verification.
    CREATE TABLE IF NOT EXISTS membership (
      gid        TEXT,
      phone      TEXT,
      joined_ts  INTEGER,
      verified   INTEGER DEFAULT 0,      -- 1 = admitted IN THIS GROUP (whitelisted here only)
      uniqname   TEXT,                   -- uniqname used to verify in this group
      pretrusted INTEGER DEFAULT 0,      -- 1 = already in the group when the bot joined (grandfathered)
      PRIMARY KEY (gid, phone)
    );

    -- Ids (phone or LID) that have messaged the bot first, so it may safely reply. WhatsApp
    -- blocks messaging strangers who never contacted the bot (error 463) — notifications are
    -- only sent to ids listed here (plus configured superadmins).
    CREATE TABLE IF NOT EXISTS contacted (
      id TEXT PRIMARY KEY,
      ts INTEGER
    );

    -- WhatsApp LID <-> phone mapping (WhatsApp now addresses users by privacy LID).
    -- Learned from inbound message keys (remoteJidAlt/participantPn). Used to address
    -- outbound messages to the correct @lid so replies aren't rejected (error 463).
    CREATE TABLE IF NOT EXISTS lidmap (
      phone TEXT PRIMARY KEY,
      lid   TEXT
    );

    -- Ban candidates awaiting admin approval (auto-ban cap reached). Admin approves the
    -- numbered entries with /confirmban.
    CREATE TABLE IF NOT EXISTS pending_bans (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      gid     TEXT,
      phone   TEXT,
      lastmsg TEXT,
      reason  TEXT,
      ts      INTEGER,
      UNIQUE (gid, phone)
    );

    -- PER-GROUP bans. On rejoin, a banned phone is auto re-kicked. /unban clears it.
    CREATE TABLE IF NOT EXISTS bans (
      gid   TEXT,
      phone TEXT,
      by    TEXT,
      ts    INTEGER,
      PRIMARY KEY (gid, phone)
    );

    -- WhatsApp admins of groups the bot is in. One row per (admin, group).
    CREATE TABLE IF NOT EXISTS admin_group (
      admin_phone TEXT,
      gid         TEXT,
      notif_level TEXT DEFAULT 'all',    -- 'all' | 'kicks' | 'none'
      PRIMARY KEY (admin_phone, gid)
    );

    -- Archived copies of a BANNED user's messages (revoked from the group but kept
    -- for admin fetch). Retention: last 45 per (gid,phone), max 30 days.
    CREATE TABLE IF NOT EXISTS msg_archive (
      gid    TEXT,
      phone  TEXT,
      msg_id TEXT,
      body   TEXT,
      ts     INTEGER,
      PRIMARY KEY (gid, msg_id)
    );

    -- Recent message keys so /remove and auto-delete can revoke messages.
    CREATE TABLE IF NOT EXISTS msg_index (
      gid        TEXT,
      phone      TEXT,
      msg_id     TEXT,
      body       TEXT,
      ts         INTEGER,
      PRIMARY KEY (gid, msg_id)
    );

    -- Stateful DM conversations (onboarding + admin command wizards).
    CREATE TABLE IF NOT EXISTS dm_session (
      phone   TEXT PRIMARY KEY,
      state   TEXT,                      -- JSON: {step, cmd, payload...}
      ts      INTEGER
    );

    -- Per-group, per-day activity counters feeding the /stats charts. Actions are counted
    -- from action_log directly, so only membership and message volume are tracked here.
    CREATE TABLE IF NOT EXISTS daily_stats (
      gid      TEXT,
      day      TEXT,                      -- 'YYYY-MM-DD' in the display timezone
      joins    INTEGER DEFAULT 0,
      leaves   INTEGER DEFAULT 0,
      messages INTEGER DEFAULT 0,
      PRIMARY KEY (gid, day)
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER,
      gid    TEXT,
      actor  TEXT,                       -- 'bot' or admin phone
      action TEXT,                       -- kick | delete | verify | setting | remove
      target TEXT,                       -- phone affected
      reason TEXT
    );
  `);
  // Migrations for DBs created before a column existed (ALTER fails silently if present).
  try { db.exec('ALTER TABLE membership ADD COLUMN pretrusted INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE groups ADD COLUMN member_count INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE groups ADD COLUMN grace_hours INTEGER'); } catch {}
  return db;
}
