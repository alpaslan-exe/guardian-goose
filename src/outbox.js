// =============================================================================
//  outbox.js — outbound message governor for WhatsApp ToS safety. Wraps the
//  socket's sendMessage so EVERY outgoing message (replies, notifications,
//  welcomes, deletions) is serialized through a single paced queue: never more
//  than one send at a time, with a randomized gap between sends, and a hard
//  daily ceiling as a runaway backstop.
// -----------------------------------------------------------------------------
//  Definitions:
//    minGapMs   minimum delay enforced after each send
//    jitterMs   extra random 0..jitterMs added to each gap (avoids a fixed cadence)
//    dailyCap   max sends per rolling 24h; excess sends are rejected, not queued
//    queue      pending { jid, content, options, resolve, reject } jobs
// =============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Replace sock.sendMessage with a paced, serialized version. Returns the sock.
export function installOutbox(sock, { minGapMs = 2500, jitterMs = 2500, dailyCap = 500 } = {}) {
  const raw = sock.sendMessage.bind(sock);
  const queue = [];
  let running = false;
  let daySent = 0;
  let dayStart = Date.now();

  // Drain the queue one message at a time, pausing minGapMs+jitter between sends.
  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      if (Date.now() - dayStart > 86_400_000) { daySent = 0; dayStart = Date.now(); } // roll the 24h window
      const job = queue.shift();
      if (daySent >= dailyCap) { job.reject(new Error('daily send cap reached')); continue; }
      try { const res = await raw(job.jid, job.content, job.options); daySent++; job.resolve(res); }
      catch (e) { job.reject(e); }
      await sleep(minGapMs + Math.floor(Math.random() * jitterMs));
    }
    running = false;
  }

  // Enqueue a send; resolves with the send result once its turn comes up.
  sock.sendMessage = (jid, content, options) => new Promise((resolve, reject) => {
    queue.push({ jid, content, options, resolve, reject });
    pump();
  });
  return sock;
}
