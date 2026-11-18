// Background loop: every tick, ask the scheduler what to do and execute at most one post.
import path from 'node:path';
import { IMAGES_DIR, addLog, saveDb } from './store.js';
import { pickNext, randomGapMs, maybeScheduleNextCycle } from './scheduler.js';
import * as fb from './facebook.js';

const TICK_MS = 30_000;
const MAX_ATTEMPTS = 2;

export function createRunner(db) {
  let busy = false;
  const status = { waitReason: '', current: null };

  async function execute(entry) {
    const group = db.groups.find(g => g.id === entry.groupId);
    const post = db.posts.find(p => p.id === entry.postId);
    status.current = `${post.title} ← ${group.name}`;
    entry.attempts++;
    try {
      await fb.postToGroup({
        groupUrl: group.url, text: post.text, headless: db.settings.headless,
        imagePaths: post.images.map(f => path.join(IMAGES_DIR, f)),
      });
      entry.status = 'done';
      entry.doneAt = Date.now();
      entry.error = null;
      addLog(db, 'info', `פורסם "${post.title}" בקבוצה "${group.name}"`);
    } catch (err) {
      entry.error = err.message.split('\n')[0];
      if (entry.attempts >= MAX_ATTEMPTS) entry.status = 'failed';
      else entry.dueAt = Date.now() + 30 * 60_000; // retry in 30 min
      addLog(db, 'error', `נכשל "${post.title}" בקבוצה "${group.name}": ${entry.error}`);
    } finally {
      status.current = null;
    }
    // A post attempt counts toward pacing whether it succeeded or failed.
    db.runner.nextAllowedAt = Date.now() + randomGapMs(db.settings);
    if (entry.status !== 'pending') maybeScheduleNextCycle(db, entry, Date.now());
    saveDb(db);
  }

  async function tick() {
    if (busy || !db.runner.running) return;
    busy = true;
    try {
      const next = pickNext(db, Date.now());
      status.waitReason = next.wait || '';
      if (next.entry) await execute(next.entry);
    } catch (err) {
      addLog(db, 'error', `שגיאה בלולאת הפרסום: ${err.message}`);
      saveDb(db);
    } finally {
      busy = false;
    }
  }

  setInterval(tick, TICK_MS);

  return {
    status,
    tick,
    start() { db.runner.running = true; addLog(db, 'info', 'הפרסום האוטומטי הופעל'); saveDb(db); tick(); },
    stop() { db.runner.running = false; status.waitReason = ''; addLog(db, 'info', 'הפרסום האוטומטי נעצר'); saveDb(db); },
    /** Post a queue entry right now, ignoring hours/caps (manual test). */
    async postNow(entry) {
      if (busy) throw new Error('פרסום אחר מתבצע כרגע');
      busy = true;
      try { await execute(entry); } finally { busy = false; }
    },
  };
}
