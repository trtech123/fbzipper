// Pure scheduling logic: no browser, no I/O. Everything takes `now` so it is testable.
import { HebrewCalendar, Location } from '@hebcal/core';
import { newId } from './store.js';

const TZ = 'Asia/Jerusalem';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Israel-local parts of a timestamp. */
export function israelParts(ts) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ts)).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export function inActiveHours(ts, settings) {
  const { minutes } = israelParts(ts);
  const start = toMinutes(settings.activeStart), end = toMinutes(settings.activeEnd);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

const location = Location.lookup('Tel Aviv');
const windowCache = new Map();

/** Shabbat / Yom Tov windows [candle lighting, havdalah] overlapping the given time (±10 days). */
export function holyWindows(ts) {
  const key = Math.floor(ts / (7 * DAY));
  if (windowCache.has(key)) return windowCache.get(key);
  const events = HebrewCalendar.calendar({
    start: new Date(ts - 10 * DAY), end: new Date(ts + 10 * DAY), location, candlelighting: true, il: true,
  }).filter(e => e.eventTime && /^(Candle lighting|Havdalah)$/.test(e.getDesc()))
    .map(e => ({ kind: e.getDesc(), at: e.eventTime.getTime() }))
    .sort((a, b) => a.at - b.at);
  const windows = [];
  let open = null;
  for (const e of events) {
    if (e.kind === 'Candle lighting') open ??= e.at;           // consecutive candle lightings = 2-day chag
    else if (open !== null) { windows.push({ start: open, end: e.at }); open = null; }
  }
  windowCache.set(key, windows);
  return windows;
}

/** Returns null when posting is allowed, otherwise a Hebrew reason string. */
export function quietReason(ts, settings) {
  if (settings.shabbatPause) {
    const buf = settings.shabbatBufferMin * MIN;
    const w = holyWindows(ts).find(w => ts >= w.start - buf && ts < w.end);
    if (w) return `שבת/חג — הפרסום יתחדש אחרי ${new Date(w.end).toLocaleString('he-IL', { timeZone: TZ })}`;
  }
  if (!inActiveHours(ts, settings)) return `מחוץ לשעות הפעילות (${settings.activeStart}–${settings.activeEnd})`;
  return null;
}

export function postsToday(db, ts) {
  const today = israelParts(ts).day;
  return db.queue.filter(q => q.status === 'done' && israelParts(q.doneAt).day === today).length;
}

function lastPostedToGroup(db, groupId) {
  return db.queue.reduce((max, q) => (q.groupId === groupId && q.status === 'done' && q.doneAt > max ? q.doneAt : max), 0);
}

/** Build one cycle of queue entries for a campaign. Posts rotate across groups and cycles. */
export function enqueueCycle(db, campaign, dueAt, cycle = 0) {
  if (!campaign.postIds.length) return [];
  const entries = campaign.groupIds.map((groupId, i) => ({
    id: newId(), campaignId: campaign.id, groupId, cycle,
    postId: campaign.postIds[(i + cycle) % campaign.postIds.length],
    dueAt, status: 'pending', attempts: 0, error: null, doneAt: null,
  }));
  db.queue.push(...entries);
  return entries;
}

/** Why the runner can't post right now, or the queue entry to post next. */
export function pickNext(db, now) {
  const s = db.settings;
  const quiet = quietReason(now, s);
  if (quiet) return { wait: quiet };
  if (postsToday(db, now) >= s.dailyCap) return { wait: `הגעת למכסה היומית (${s.dailyCap} פוסטים)` };
  if (now < db.runner.nextAllowedAt) return { wait: `המתנה בין פוסטים עד ${new Date(db.runner.nextAllowedAt).toLocaleTimeString('he-IL', { timeZone: TZ })}` };

  const enabledCampaigns = new Set(db.campaigns.filter(c => c.enabled).map(c => c.id));
  const groups = new Map(db.groups.map(g => [g.id, g]));
  const posts = new Set(db.posts.map(p => p.id));
  const cooldown = s.groupCooldownHours * HOUR;

  const candidates = db.queue
    .filter(q => q.status === 'pending' && q.dueAt <= now && enabledCampaigns.has(q.campaignId)
      && groups.get(q.groupId)?.enabled && posts.has(q.postId)
      && now - lastPostedToGroup(db, q.groupId) >= cooldown)
    .sort((a, b) => a.dueAt - b.dueAt);
  if (!candidates.length) return { wait: 'אין פוסטים ממתינים כרגע' };
  return { entry: candidates[0] };
}

export function randomGapMs(settings, rand = Math.random) {
  return (settings.minGapMin + rand() * (settings.maxGapMin - settings.minGapMin)) * MIN;
}

/** After an entry finishes: if its campaign repeats and the whole cycle is over, schedule the next one. */
export function maybeScheduleNextCycle(db, entry, now) {
  const c = db.campaigns.find(c => c.id === entry.campaignId);
  if (!c || !c.repeatDays) return null;
  const cycleEntries = db.queue.filter(q => q.campaignId === c.id && q.cycle === entry.cycle);
  if (cycleEntries.some(q => q.status === 'pending')) return null;
  if (db.queue.some(q => q.campaignId === c.id && q.cycle > entry.cycle)) return null;
  return enqueueCycle(db, c, now + c.repeatDays * DAY, entry.cycle + 1);
}
