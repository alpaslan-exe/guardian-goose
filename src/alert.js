// =============================================================================
//  alert.js — operator dead-man alerts by email, sent directly to the
//  recipient's mail server (no relay account or credentials required).
// -----------------------------------------------------------------------------
//  Definitions:
//    RETRIES      backoff schedule (ms) used to ride out greylisting
//    MX           recipient domain's mail exchanger, resolved via dig
//    senderDomain the VPS reverse-DNS name, used as the From: domain
// =============================================================================

// Dead-man alert: email via direct SMTP to the recipient's MX (no relay account needed).
// umich (and most MXes) greylist unknown senders with a 451 temp-fail, so we retry with
// backoff — greylisting is designed to pass senders that retry. Shells out to curl.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

// Retry schedule (ms). Greylist windows are typically 1–15 min.
const RETRIES = [0, 5 * 60_000, 15 * 60_000, 45 * 60_000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveMx(domain) {
  const { stdout } = await run('dig', ['+short', 'MX', domain]);
  const rows = stdout.trim().split('\n').filter(Boolean)
    .map((l) => { const [prio, host] = l.split(/\s+/); return { prio: +prio, host: host?.replace(/\.$/, '') }; })
    .filter((r) => r.host).sort((a, b) => a.prio - b.prio);
  if (!rows.length) throw new Error(`no MX for ${domain}`);
  return rows[0].host;
}

async function senderDomain() {
  try {
    const { stdout: ip } = await run('curl', ['-s', '--max-time', '10', 'https://api.ipify.org']);
    const { stdout } = await run('dig', ['+short', '-x', ip.trim()]);
    const r = stdout.trim().split('\n')[0]?.replace(/\.$/, '');
    if (r) return r;
  } catch {}
  return os.hostname();
}

// Send one attempt. Returns 'ok' | 'temp' (greylisted, retry later) | 'fail'.
async function attempt(mx, from, to, subject, body) {
  const file = path.join(os.tmpdir(), `alert-${process.pid}-${Date.now()}.eml`);
  const msg = `From: WhatsApp Antispam Bot <${from}>\r\nTo: <${to}>\r\nSubject: ${subject}\r\n` +
              `Date: ${new Date().toUTCString()}\r\nMessage-ID: <${Date.now()}.${Math.floor(Math.random() * 1e9)}@${from.split('@')[1]}>\r\n\r\n${body}\r\n`;
  await writeFile(file, msg);
  try {
    await run('curl', ['-s', '--max-time', '60', '--url', `smtp://${mx}:25`,
      '--mail-from', from, '--mail-rcpt', to, '-T', file]);
    return 'ok';
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    return /45\d/.test(out) || e.code === 8 ? 'temp' : 'fail'; // curl exit 8 = odd server reply (451 shows up here)
  } finally {
    await unlink(file).catch(() => {});
  }
}

// Fire-and-forget with greylist retries. Resolves true if some attempt was accepted.
export async function sendAlert(cfg, subject, body) {
  if (!cfg.alertEmail) return false;
  try {
    const to = cfg.alertEmail;
    const mx = await resolveMx(to.split('@')[1]);
    const from = `antispam@${await senderDomain()}`;
    for (const delay of RETRIES) {
      if (delay) await sleep(delay);
      const r = await attempt(mx, from, to, subject, body);
      if (r === 'ok') { console.log(`alert email accepted by ${mx}`); return true; }
      if (r === 'fail') console.error('alert email hard-failed, will still retry');
      else console.log('alert email greylisted (451), retrying later');
    }
    console.error('alert email: all retries exhausted');
    return false;
  } catch (e) {
    console.error('alert email error:', e.message);
    return false;
  }
}
