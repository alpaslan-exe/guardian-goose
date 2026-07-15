// =============================================================================
//  behavior.js — content and rate heuristics that flag likely spam. State is
//  kept in memory and resets on restart, which is acceptable for these signals.
// -----------------------------------------------------------------------------
//  Definitions:
//    rate         phone -> recent message timestamps (burst detection)
//    crossGroup   normalized text -> senders/groups that posted it (broadcast)
//    URL_RE       regex matching links, invite links, shorteners, payment links
//    DM_RE        regex matching "contact me / DM me" solicitations
//    signal       a named spam indicator returned by inspect()
// =============================================================================

// In-memory rolling counters for behavior detection. Reset on restart (fine).
const rate = new Map();          // phone -> [timestamps]
const crossGroup = new Map();    // normalizedText -> Map(phone -> Set(gid), ts)

const now = () => Date.now();
const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Links (URLs, invite links, shorteners, bare domains) and "DM me / contact me" solicitations.
const URL_RE = /(https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/|t\.me\/|bit\.ly\/|tinyurl|cash\.app|venmo\.com|paypal\.me|gofundme\.com|gofund\.me|\b[\w-]+\.(com|net|org|io|xyz|link|info|ru|cn|top|shop|vip|me)\b)/i;
const DM_RE = /\b(dm me|message me|inbox me|text me|hit me up|whatsapp me|contact me|reach out|reach me|hmu|slide in|check my bio|link in bio)\b/i;

// opts: { hasMedia:bool, isFirstMessage:bool }
// Returns triggered signals: burst | cross_group | scam_keyword | link | dm_solicit | media |
//   wall_of_text | first_msg_spam.
export function inspect(cfg, phone, gid, body, opts = {}) {
  const b = cfg.behavior;
  const signals = [];
  const t = now();

  // burst rate
  const arr = (rate.get(phone) || []).filter((x) => t - x < 60_000);
  arr.push(t);
  rate.set(phone, arr);
  if (arr.length > b.maxMsgPerMinute) signals.push('burst');

  // scam keywords
  const low = norm(body);
  if (b.scamKeywords.some((k) => low.includes(k))) signals.push('scam_keyword');

  // content-shape signals
  const hasLink = URL_RE.test(low);
  if (hasLink) signals.push('link');
  if (DM_RE.test(low)) signals.push('dm_solicit');
  if (opts.hasMedia) signals.push('media');
  if (low.length > (b.wallOfTextLen || 500)) signals.push('wall_of_text');

  // Classic drive-by scam: a member's VERY FIRST message in the group is a link / DM-solicit /
  // media / wall of text. High-confidence when they haven't verified.
  if (opts.isFirstMessage && (hasLink || DM_RE.test(low) || opts.hasMedia || low.length > (b.wallOfTextLen || 500)))
    signals.push('first_msg_spam');

  // cross-group broadcast: same text sent to >=threshold distinct groups in window
  if (low.length > 12) {
    const rec = crossGroup.get(low) || { by: new Map() };
    const gids = rec.by.get(phone) || new Set();
    gids.add(gid);
    rec.by.set(phone, gids);
    rec.ts = t;
    crossGroup.set(low, rec);
    if (gids.size >= b.crossGroupThreshold) signals.push('cross_group');
  }

  // opportunistic GC
  if (crossGroup.size > 5000) {
    for (const [k, v] of crossGroup)
      if (t - v.ts > b.crossGroupWindowMin * 60_000) crossGroup.delete(k);
  }
  return signals;
}
