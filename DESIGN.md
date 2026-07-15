# WhatsApp Anti-Spam Group Bot — Design

## Reality check (read first)
- **Official WhatsApp Cloud API cannot touch groups** (no read, no kick). This bot uses
  **Baileys** (unofficial WhatsApp Web protocol). **Violates WhatsApp ToS.** The bot's number
  can be **banned**. Use a **dedicated burner number**, never a personal one.
- Bot must be **group admin** to kick members or delete others' messages.
- "Is VOIP?" is **not** exposed by WhatsApp. Looked up externally.
  Free default = `libphonenumber` (offline, partial). Paid = Twilio Lookup (accurate). Pluggable.
- **Foreign numbers are NEVER auto-kicked.** International students are legit. Foreign = recorded
  signal only. Kicks require real spam behavior, an admin `/remove`, or strict-policy grace expiry.

## Policies (per group, group-based, admin-settable)
Set with `/policy`. Stored on the group row — NOT per admin.
- **chill** — bot DMs each joiner for their uniqname, but lets them stay regardless.
- **hold** — unverified members **cannot speak**: their messages are auto-deleted (revoked) until
  they DM a valid uniqname. Re-prompts on each blocked message.
- **strict** — unverified joiners are **removed after `graceHours`** (default 24h). A background
  sweep (every 15 min) enforces this.

On join the bot records `membership(gid, phone, joined_ts)` and DMs the joiner for a uniqname under
every policy. Verified members are **whitelisted** — immune to all auto-actions and hold-deletion.

## Per-group separation (core model)
Every group is handled independently. **policy**, **allowlist + its enforce toggle**, and
**verification/trust** are all keyed by group:
- `groups.policy`, `groups.enforce_allowlist` — per group.
- `allowlist(gid, uniqname)` — per group.
- `membership(gid, phone, verified, uniqname)` — a member is verified **in a specific group**, not
  globally. Whitelisting in group A does not whitelist them in group B.
- `bans(gid, phone)` — per group.

uniqname *identity* (`members.uniqname`) is global — learned once. To avoid re-asking the same
person in every group, when we already know their uniqname and it's allowed in the group they're
acting in, they're **admitted silently** (still subject to that group's allowlist). This keeps trust
per-group while not nagging known users.

## Allowlist (approved uniqnames, per group)
`/allow enforce on|off` (per group), `/allow add|remove <uniqname>` (per group), `/allow list`.
When a group enforces **and** has entries, a joiner's uniqname must be on that group's list to be
admitted; otherwise they're told to contact an admin. Every `/allow` action goes through the
group-scope picker.

## Ban / unban + message archive
- `/remove <phone>` = **ban** (per group): kick + revoke messages + record a ban. A banned phone
  that rejoins is **auto re-kicked**. `/unban <phone>` lifts it.
- On ban (and on auto-ban for spam), the user's indexed messages are **archived** before revocation:
  kept **last 45 per (group, phone), max 30 days** (`msg_archive`). Admins fetch with
  `/messages <phone>` (group-scoped). A 15-min sweep prunes >30-day rows.
- Grace-kick (strict) and hold-kick are **not** bans — the person may return and verify.

## Auto-kick policy (conservative)
Auto-**ban** on a message happens **only** when: member **unverified in that group** + number
**VOIP** + **spam behavior** (`scam_keyword` or `cross_group` broadcast). Everything else = **flag +
notify admin**. Signals (`behavior.js`): `burst`, `cross_group`, `scam_keyword`. Tune in `config.js`.

## Safety rails (hard limits)
- **Admins are untouchable.** `removeMember` is the single choke point: before ANY kick/ban it does
  a LIVE metadata check — target is a group admin, superadmin, or the bot itself → action refused
  and logged (`action='refused'`). **Fail-closed**: metadata unavailable → refuse. Applies to admin
  `/remove`, auto-bans, grace kicks, and banned-rejoin kicks alike.
- **Mass-ban brake (admins):** more than **10 bans per admin per 24h** requires typed `CONFIRM`
  approval in the DM wizard; anything else cancels.
- **Auto-ban cap (bot):** at most **10 bot-initiated bans per group per 24h**; beyond that, spam
  hits are flagged to admins for manual action instead.
- **Verification grants no immunity from detection.** Verified members skip hold-muting and
  auto-bans, but their messages are still inspected — hard spam signals from a verified member are
  flagged to admins.
- **Uniqname uniqueness.** A uniqname binds to ONE phone. A second phone claiming it is rejected
  and admins are alerted (anti-impersonation).
- Message deletion is bounded per user per group (indexed msgs only, 7-day index retention) — no
  mass-delete surface.

## Admin authorization — never trust stale knowledge
- Admin identity is **re-verified LIVE against group metadata** (`isAdminLive`) immediately before
  any settings change or `/remove` executes. The DB `admin_group` cache is only a candidate list.
- **Promote** → bot DMs the new admin the welcome + command guide (`ADMIN_WELCOME`).
- **Demote** → bot revokes the grant immediately, kills any in-flight admin wizard, and DMs a
  goodbye; further admin input from them is refused.
- Welcome is also sent to admins of a newly-seen group on first sync.

## Admin DM commands
`/help` (welcome + settings explanation, loops back) · `/policy` · `/allow add|remove|list|enforce
on|off` · `/remove <phone>` (ban) · `/unban <phone>` · `/messages <phone>` (fetch archive) ·
`/lookup <uniqname|phone>` (shows per-group status) · `/notif` · `/logs [n]`. All group-acting
commands run through the cross-admin group-scope picker with a live authz re-check.

## Cross-admin handling
An admin may run several groups. Any scoped command lists the admin's groups (numbered) and waits;
admin answers `all` or `1,3`. Applies to `/policy`, `/notif`, `/remove` (which groups to act on).
Single-group admins skip the prompt. Live authz re-check runs on the chosen groups before executing.

## Input hardening (`security.js`)
Every inbound text (group messages AND DMs) passes `clean()`: strips control + zero-width/bidi
chars, collapses whitespace, caps length (400). Commands are tokenized with a token-count + per-token
length cap. `validUniqname` (org regex, letters only), `validPhone` (digits, E.164 length), `oneOf`
(enum whitelist) reject non-standard input. No raw user string ever reaches SQL except as a bound
parameter (parameterized statements throughout).

## Notifications (`notify.js`)
Per-admin, per-group `notif_level`: `all` | `kicks` | `none`. Set via `/notif`. Bot DMs admins on
actions it takes, respecting each admin's level.

## Data model (`db.js`, node:sqlite)
`members` (global identity/facts) · `groups(policy, enforce_allowlist)` · `admin_group(notif_level)` ·
`allowlist(gid,uniqname)` · `membership(gid,phone,joined_ts,verified,uniqname)` · `bans(gid,phone)` ·
`msg_archive(gid,phone,...)` (banned users, 45/30d) · `msg_index` (recent keys for deletion) ·
`dm_session` (wizard state) · `action_log`.

## Still open (stubs / TODO)
1. **Twilio / Numverify providers** — `src/providers/index.js` has interface + URL comments; add
   `fetch` + creds to upgrade VOIP accuracy.
2. `msg_index` retention GC — prune rows older than N days.

## Pairing (no QR needed)
WhatsApp cannot register a brand-new **account** headlessly (the mobile-registration API is dead;
attempts get numbers banned). One-time: install WhatsApp with the bot's number on any spare
phone/emulator. After that the phone is never needed again:
1. Set `pairNumber: '<countrycode+number>'` in `config.js` on the VPS.
2. Start the bot. It prints `==== WHATSAPP PAIRING CODE: XXXX-XXXX ====` to the log.
3. On the WhatsApp app: Settings → Linked Devices → Link a device → **Link with phone number
   instead** → type the code. Done — session persists in `auth_state/` on the VPS.
Leave `pairNumber` empty to fall back to QR.

## Setup (local)
```
cp config.example.js config.js   # edit
npm install
npm start
```
Add the bot number to your group(s) and **make it admin**.

## Deploy (VPS, systemd persistence)
See `deploy/`. Runs under a dedicated Node 22 (nvm) so the host's stock node18 is untouched.
`deploy/deploy.sh` pushes via `sshkit` to `personal_vps` and installs the systemd unit
(`deploy/antispam.service`) with auto-restart + boot-start.

## Legal / ethics
Unofficial automation risks the bot number. uniqname↔phone is PII — store securely, tell members
why, honor deletion requests. Get community/admin consent before deploying.
