// =============================================================================
//  security.js — input hardening. Every piece of external text (group messages,
//  DMs, uniqnames, phone numbers) is sanitised and validated here.
// -----------------------------------------------------------------------------
//  Definitions:
//    MAX_INPUT   max characters kept from any single message
//    MAX_TOKENS  max whitespace-separated tokens parsed from a command
//    CTRL        regex of control characters to strip
//    ZW          regex of zero-width / bidirectional / line-separator characters
//    uniqname    lowercase-letter identifier validated against the org regex
// =============================================================================

// Input hardening. All external text (group msgs, DMs, uniqnames, phones) passes here.
export const MAX_INPUT = 400;      // hard cap; anything longer is truncated
export const MAX_TOKENS = 8;       // max whitespace-split tokens accepted in a command

// ASCII-only source (invisible chars matched via escapes, never embedded literally).
const CTRL = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');            // control chars
const ZW = new RegExp('[\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\uFEFF]', 'g'); // zero-width/bidi/line-sep

// Strip control chars, zero-width, collapse whitespace, cap length. Never throws.
// maxLen overridable for bulk pastes (e.g. an allowlist roster).
export function clean(text, maxLen = MAX_INPUT) {
  if (typeof text !== 'string') return '';
  let t = text.replace(CTRL, ' ').replace(ZW, '').replace(/\s+/g, ' ').trim();
  if (t.length > maxLen) t = t.slice(0, maxLen);
  return t;
}

// Extract all valid uniqnames from a free-form paste (space/comma/newline separated).
export function extractUniqnames(text, regexStr, max = 300) {
  const re = new RegExp(regexStr);
  const out = [];
  for (const tok of clean(text, 8000).toLowerCase().split(/[^a-z]+/)) {
    if (tok && re.test(tok) && !out.includes(tok)) out.push(tok);
    if (out.length >= max) break;
  }
  return out;
}

// Tokenize a command safely: cap token count, cap each token length.
export function tokens(text) {
  return clean(text).split(' ').slice(0, MAX_TOKENS).map((t) => t.slice(0, 64));
}

// uniqname: lowercase letters only, validated against org regex. null if invalid.
export function validUniqname(s, regexStr) {
  const uq = String(s || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 32);
  return new RegExp(regexStr).test(uq) ? uq : null;
}

// phone: digits only, E.164 length. null if invalid.
export function validPhone(s) {
  const p = String(s || '').replace(/\D/g, '');
  return p.length >= 7 && p.length <= 15 ? p : null;
}

// Flexible phone parse for chat commands: accepts "+1 555-867-5309", "5558675309",
// "15558675309", "(555) 867 5309". A bare 10-digit number gets homeCode prepended.
// Returns E.164 digits (no +) or null.
export function normalizePhone(raw, homeCode = '1') {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) d = String(homeCode) + d; // local number -> add country code
  return validPhone(d);
}

// One of an allowed set (case-insensitive). null if not.
export function oneOf(s, allowed) {
  const v = String(s || '').toLowerCase().trim();
  return allowed.includes(v) ? v : null;
}
