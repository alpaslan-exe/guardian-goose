<div align="center">

<img src="assets/logo.png" alt="Guardian Goose" width="180" />

# Guardian Goose

**A WhatsApp group anti-spam and member-verification bot.**

Screens joiners, verifies members by org identifier, mutes or removes spam, and gives group
admins full control from a direct-message console — one keeper watching every pond.

<br/>

![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=node.js&logoColor=white)
![SQLite](https://img.shields.io/badge/storage-SQLite-003B57?logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![Status](https://img.shields.io/badge/status-active-success)

</div>

---

## What it does

- **Member verification** — new members register an org identifier (a *uniqname*); the bot keeps a
  phone ↔ uniqname table of legitimate members.
- **Per-group policies** — every group is moderated independently: `chill`, `hold`, `strict`, or `off`.
- **Spam detection** — flags and removes drive-by scams: first-message links, "DM me" solicitations,
  media dumps, walls of text, cross-group broadcasts, scam keywords, and message bursts.
- **Number screening** — classifies VOIP and foreign numbers (foreign is a signal, never an auto-kick).
- **Admin console over DM** — set policy, manage the approved-uniqname list, ban/unban, fetch a
  banned user's archived messages, look up members, and pull action logs.
- **Bans with recall** — a ban kicks the member, deletes their messages, and archives them (last 45,
  30 days) so admins can review after the fact. Re-joins are auto-removed.
- **Safety rails** — never removes a group's admins, requires typed approval past a ban threshold,
  and caps automatic bans per group per day.
- **Operator alerts** — emails the operator if the bot loses its session for more than a few minutes.

---

## Policies

Set per group with `/policy`. Members already present when the bot joins are **grandfathered**
(pre-trusted) and are never gated — only people who join afterward are.

| Policy   | New-member behaviour |
|----------|----------------------|
| `chill`  | Ask for a uniqname, but let them stay regardless. |
| `hold`   | Cannot post until verified — their messages are deleted until they register. |
| `strict` | Removed after a grace period if they never verify. |
| `off`    | The bot ignores the group entirely (no actions, no messages). |

---

## Requirements

- **Node.js ≥ 22** (uses the built-in `node:sqlite` module).
- A dedicated WhatsApp number for the bot (not a personal line).
- The bot must be a **group admin** to remove members or delete messages.

---

## Setup

```bash
git clone <this-repo>
cd guardian-goose
npm install
cp config.example.js config.js   # then edit config.js
npm start
```

On first run the bot prints a **pairing code**. In WhatsApp on the bot's number:
**Settings → Linked Devices → Link a device → "Link with phone number instead"** and enter the code.
The session is saved under `auth_state/` and persists across restarts.

Then add the bot to a group and promote it to **admin**.

### Configuration (`config.js`)

| Key | Meaning |
|-----|---------|
| `homeCountryCode` | Country code treated as domestic; others are flagged foreign. |
| `voipProvider` | Line-type lookup: `libphonenumber` (offline, free) or a paid provider. |
| `defaultPolicy` | Policy assigned to a newly-seen group. |
| `graceHours` | Hours a `strict` joiner has to verify before removal. |
| `welcomeOnJoin` | Post a welcome to new members on join (off by default; batched + edited). |
| `welcomeMaxPerHour` | Per-group cap on new welcome posts when the above is on. |
| `sendMinGapMs` / `sendJitterMs` | Pacing between outbound messages (all sends are serialized). |
| `sendDailyCap` | Hard ceiling on sends per rolling 24h. |
| `uniqnameRegex` | Validation pattern for a member identifier. |
| `superadmins` | Operator numbers; act as admin of every group. |
| `pairNumber` | Bot number for code pairing (leave empty for QR). |
| `proxyUrl` | Optional SOCKS/HTTP proxy for the WhatsApp connection. |
| `alertEmail` | Address for dead-man alerts. |

---

## Running in production

A `systemd` unit is provided under `deploy/`:

```bash
# on the server (Node 22 on PATH)
sudo cp deploy/antispam.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now antispam
journalctl -u antispam -f
```

The unit restarts on failure and starts on boot. Timestamps are rendered in the timezone set by
the unit's `TZ` environment variable.

---

## Admin commands

Sent as a direct message to the bot. All group-acting commands re-verify the sender is still an
admin, and ask which group(s) to act on when the admin runs several.

| Command | Description |
|---------|-------------|
| `/help` | Show the command guide. |
| `/policy` | Set a group's policy. |
| `/allow add\|remove <uniqname>` | Manage a group's approved-uniqname list. |
| `/allow bulk` | Paste a roster of uniqnames to auto-approve. |
| `/allow list \| enforce on\|off` | List the allowlist / require it for verification. |
| `/associate <phone> <uniqname>` | Bind a uniqname to a number and verify them. |
| `/remove <phone>` | Ban a number (kick + delete + archive its messages). |
| `/confirmban [n…]` | Approve queued bans (shown when the auto-ban cap is reached). |
| `/unban <phone>` | Lift a ban. |
| `/messages <phone>` | Fetch a banned user's archived messages. |
| `/lookup <uniqname\|phone\|lid>` | Find a member across all records. |
| `/notif` | Set your alert level: `all`, `kicks`, or `none`. |
| `/logs [n]` | Recent actions in your groups. |

Admins can also type **`/ban <number>`** directly in a group to ban + delete that number's messages
from the current day, with an in-chat confirmation.

---

## Project structure

```
guardian-goose/
├─ assets/logo.png          Project logo
├─ config.example.js        Configuration template (copy to config.js)
├─ deploy/
│  ├─ antispam.service      systemd unit
│  └─ deploy.sh             push + install helper
└─ src/
   ├─ index.js              Entry point: connection lifecycle, message routing, enforcement
   ├─ db.js                 SQLite schema and connection factory
   ├─ commands.js           Admin DM command interface and member onboarding
   ├─ actions.js            Moderation primitives: delete, ban, address resolution, rate accounting
   ├─ screening.js          Number classification and per-group admission decisions
   ├─ behavior.js           Content and rate heuristics that flag spam
   ├─ security.js           Input sanitisation and validation
   ├─ notify.js             Admin notifications by DM, per notification level
   ├─ alert.js              Operator dead-man alerts by email
   └─ providers/index.js    Pluggable phone line-type lookup providers
```

### How the pieces fit

- **`index.js`** owns the socket: pairing, reconnect with backoff, and a dead-man watchdog. It
  receives every message, resolves the sender's identity, applies the group's policy, runs spam
  checks, and dispatches to the other modules.
- **`db.js`** defines the tables — members, groups, memberships, allowlist, bans, message archive,
  admin grants, notifications, sessions, and an action log — and returns a ready connection.
- **`commands.js`** parses and runs the admin console. Multi-step commands use a stored session so a
  wizard can span several messages; group-acting commands re-check admin status live.
- **`actions.js`** holds the shared moderation operations and the address resolver that maps between
  a member's phone number and their WhatsApp identifier.
- **`screening.js`**, **`behavior.js`**, and **`providers/`** produce the signals; `index.js` decides
  what to do with them. **`security.js`** hardens every input first.
- **`notify.js`** and **`alert.js`** handle outbound communication to admins and the operator.

---

## Data & privacy

The bot stores members' phone numbers alongside the identifier they register. Treat this as personal
data: store it securely, tell members why it's collected, and honour deletion requests. Get consent
from group admins before deploying.

---

## License

[MIT](LICENSE)
