// =============================================================================
//  providers/index.js — pluggable phone-number line-type lookup providers.
//  Each provider exposes async lookup(phoneE164) -> { isVoip, lineType }.
// -----------------------------------------------------------------------------
//  Definitions:
//    isVoip    true / false / null(unknown); null must NOT trigger a kick
//    lineType  provider's raw classification (MOBILE, VOIP, FIXED_LINE, ...)
//    provider  selected via cfg.voipProvider ('libphonenumber' | 'twilio' | ...)
// =============================================================================
import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Provider interface: async lookup(phoneE164) -> { isVoip: bool|null, lineType: string|null }
// null isVoip = unknown (fail-open: do NOT kick on unknown).

const libphonenumber = {
  async lookup(phone) {
    const p = parsePhoneNumberFromString('+' + phone);
    if (!p) return { isVoip: null, lineType: null };
    const t = p.getType(); // 'MOBILE','FIXED_LINE','VOIP','FIXED_LINE_OR_MOBILE',...
    return { isVoip: t === 'VOIP' ? true : (t ? false : null), lineType: t || null };
  },
};

// Stubs — fill creds in config, then implement fetch calls. Kept offline-safe.
const twilio = {
  async lookup(phone) {
    // GET https://lookups.twilio.com/v2/PhoneNumbers/+<phone>?Fields=line_type_intelligence
    // Basic-auth accountSid:authToken. Parse line_type_intelligence.type === 'nonFixedVoip'|'fixedVoip'.
    throw new Error('twilio provider not wired: add fetch call + creds');
  },
};
const numverify = {
  async lookup(phone) {
    // GET http://apilayer.net/api/validate?access_key=KEY&number=<phone>
    // line_type field (free tier line_type often null -> returns unknown).
    throw new Error('numverify provider not wired: add fetch call + key');
  },
};

export function getProvider(name) {
  return { libphonenumber, twilio, numverify }[name] || libphonenumber;
}
