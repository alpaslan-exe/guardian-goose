// Copy to config.js and edit. config.js is gitignored.
export default {
  // Country code considered "home" (US = 1). Numbers NOT starting with this
  // are FOREIGN = soft-flagged (raise scrutiny / require uniqname verify).
  // Foreign is NEVER an auto-kick reason on its own.
  homeCountryCode: '1',

  // VOIP detection provider: 'libphonenumber' (free, offline) | 'twilio' | 'numverify'
  voipProvider: 'libphonenumber',

  // Only used when voipProvider === 'twilio'
  twilio: { accountSid: '', authToken: '' },
  // Only used when voipProvider === 'numverify'
  numverify: { apiKey: '' },

  // Default per-group POLICY (group-based; admins change per group via DM).
  //   'chill'   DM joiner for uniqname, but allow them regardless.
  //   'hold'    joiner CANNOT speak until verified — their messages are auto-deleted
  //             until they DM a valid uniqname.
  //   'strict'  joiner is KICKED after graceHours if still unverified.
  defaultPolicy: 'chill',

  // strict policy: hours a new joiner has to verify (DM uniqname) before kick
  graceHours: 24,

  // On join, post a welcome in the group and try to DM the new member. OFF by default:
  // on a busy group this mass-messages and looks like spam. When off, joiners are tracked
  // and (under hold) muted, admins are flagged, and verification happens member-initiated
  // (they DM the bot) or via /allow bulk rosters and /associate.
  welcomeOnJoin: false,
  // Even when welcomeOnJoin is on, never post more than this many welcomes per group per hour.
  welcomeMaxPerHour: 6,

  // Allowlist enforcement is PER GROUP (not global): an admin turns it on for a
  // specific group with `/allow enforce on` and adds uniqnames with `/allow add`.

  // Behavior heuristics
  behavior: {
    maxMsgPerMinute: 8,            // burst threshold
    crossGroupWindowMin: 10,       // same text to N groups within window = broadcast spam
    crossGroupThreshold: 3,
    wallOfTextLen: 500,            // message longer than this = 'wall_of_text' signal
    scamKeywords: ['gofundme', 'invest', 'investment', 'crypto', 'forex',
                   'guaranteed return', 'double your', 'binary option', 'cash app flip'],
  },

  // On joining a NEW group, DM every detected group admin the welcome+command guide.
  // Default false: WhatsApp Communities make community admins appear as admins of every
  // linked group, so blasting them all = spam flag + wrong people. When false, only the
  // superadmin gets a short join notice; real admins self-serve via /help (or the promote
  // event welcomes a newly-promoted admin).
  welcomeGroupAdmins: false,

  // Superadmins (bot operators). Treated as admin of EVERY group the bot is in —
  // all logs, all settings, all groups — regardless of WhatsApp admin status.
  // Digits only, country code included. Still bound by the safety rails
  // (mass-ban CONFIRM gate; never bans a group's admins).
  superadmins: [],

  // Uniqname validation (UMich = 3-8 lowercase letters). Adjust to your org.
  uniqnameRegex: '^[a-z]{3,8}$',

  // Bot's phone number for QR-less pairing (digits, with country code, e.g. '13135551234').
  // When set and the bot is unregistered, it prints an 8-char PAIRING CODE to the log;
  // enter that code in WhatsApp > Linked Devices > "Link with phone number instead".
  // Leave '' to use QR pairing.
  pairNumber: '',

  // WhatsApp blocks many datacenter/VPS IPs with HTTP 405 on connect. Route the WhatsApp
  // socket through a residential/mobile proxy to fix it. Supports socks5://, http://, https://.
  // e.g. 'socks5://user:pass@host:1080'. Leave '' for a direct connection.
  proxyUrl: '',

  // Dead-man alert: emailed via ntfy.sh when the WhatsApp session dies (logged out).
  // Leave alertEmail '' to disable. alertTopic should be unique-ish (any string).
  alertEmail: '',
  alertTopic: 'antispam-bot-alert',

  dbPath: './antispam.db',
  authDir: './auth_state',
};
