import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/store.js';
import { quietReason, pickNext, enqueueCycle, maybeScheduleNextCycle, postsToday, randomGapMs, holyWindows } from '../src/scheduler.js';
import { parseGroupUrl } from '../src/groupUrl.js';

const S = { ...DEFAULT_SETTINGS };
const at = iso => new Date(iso).getTime();
const TUE_NOON = at('2026-11-17T12:00:00+02:00');
const HOUR = 3_600_000;

function makeDb(groupCount = 3, postCount = 2) {
  const db = {
    settings: { ...S }, log: [], queue: [], runner: { running: true, nextAllowedAt: 0 },
    groups: Array.from({ length: groupCount }, (_, i) => ({ id: `g${i}`, name: `G${i}`, url: `u${i}`, enabled: true })),
    posts: Array.from({ length: postCount }, (_, i) => ({ id: `p${i}`, title: `P${i}`, text: 't', images: [] })),
  };
  db.campaigns = [{ id: 'c1', name: 'c', postIds: db.posts.map(p => p.id), groupIds: db.groups.map(g => g.id), repeatDays: 0, enabled: true }];
  return db;
}

test('active hours, Israel time', () => {
  assert.equal(quietReason(TUE_NOON, S), null);
  assert.match(quietReason(at('2026-11-17T23:30:00+02:00'), S), /שעות הפעילות/);
  assert.match(quietReason(at('2026-11-17T06:59:00+02:00'), S), /שעות הפעילות/);
  assert.equal(quietReason(at('2026-11-17T07:00:00+02:00'), S), null);
});

test('Shabbat pause incl. buffer before candle lighting', () => {
  assert.match(quietReason(at('2026-11-21T12:00:00+02:00'), S), /שבת/);        // Saturday noon
  assert.match(quietReason(at('2026-11-20T16:05:00+02:00'), S), /שבת/);        // Friday, inside 30-min buffer
  assert.equal(quietReason(at('2026-11-20T11:00:00+02:00'), S), null);         // Friday morning OK
  assert.equal(quietReason(at('2026-11-21T19:30:00+02:00'), S), null);         // after havdalah
  assert.equal(quietReason(at('2026-11-21T12:00:00+02:00'), { ...S, shabbatPause: false }), null);
});

test('two-day Rosh Hashana 2026 is one continuous window', () => {
  const ts = at('2026-09-12T20:00:00+03:00'); // between day 1 and day 2
  const w = holyWindows(ts).find(w => ts >= w.start && ts < w.end);
  assert.ok(w);
  assert.ok(w.end - w.start > 40 * HOUR);
});

test('enqueueCycle rotates posts across groups', () => {
  const db = makeDb(3, 2);
  const e = enqueueCycle(db, db.campaigns[0], TUE_NOON);
  assert.deepEqual(e.map(x => x.postId), ['p0', 'p1', 'p0']);
  assert.deepEqual(enqueueCycle(db, db.campaigns[0], TUE_NOON, 1).map(x => x.postId), ['p1', 'p0', 'p1']);
});

test('pickNext respects gap, daily cap, disabled groups and group cooldown', () => {
  const db = makeDb(3, 1);
  enqueueCycle(db, db.campaigns[0], TUE_NOON);
  assert.equal(pickNext(db, TUE_NOON).entry.groupId, 'g0');

  db.runner.nextAllowedAt = TUE_NOON + 60_000;
  assert.match(pickNext(db, TUE_NOON).wait, /המתנה/);
  db.runner.nextAllowedAt = 0;

  db.groups[0].enabled = false;
  assert.equal(pickNext(db, TUE_NOON).entry.groupId, 'g1');

  // g1 was posted 2h ago by another campaign entry -> cooldown blocks it
  db.queue.push({ id: 'x', campaignId: 'c1', groupId: 'g1', postId: 'p0', status: 'done', doneAt: TUE_NOON - 2 * HOUR });
  assert.equal(pickNext(db, TUE_NOON).entry.groupId, 'g2');

  db.settings.dailyCap = 1;
  assert.match(pickNext(db, TUE_NOON).wait, /מכסה/);
  assert.equal(postsToday(db, TUE_NOON), 1);
});

test('pickNext ignores future-due and disabled campaigns', () => {
  const db = makeDb(1, 1);
  enqueueCycle(db, db.campaigns[0], TUE_NOON + HOUR);
  assert.ok(pickNext(db, TUE_NOON).wait);
  assert.ok(pickNext(db, TUE_NOON + HOUR).entry);
  db.campaigns[0].enabled = false;
  assert.ok(pickNext(db, TUE_NOON + HOUR).wait);
});

test('repeating campaign schedules next cycle only after the whole cycle finishes', () => {
  const db = makeDb(2, 1);
  db.campaigns[0].repeatDays = 3;
  const [a, b] = enqueueCycle(db, db.campaigns[0], TUE_NOON);
  a.status = 'done'; a.doneAt = TUE_NOON;
  assert.equal(maybeScheduleNextCycle(db, a, TUE_NOON), null);
  b.status = 'failed';
  const next = maybeScheduleNextCycle(db, b, TUE_NOON);
  assert.equal(next.length, 2);
  assert.equal(next[0].dueAt, TUE_NOON + 3 * 24 * HOUR);
  assert.equal(maybeScheduleNextCycle(db, b, TUE_NOON), null); // no duplicate cycle
});

test('randomGapMs stays within bounds', () => {
  assert.equal(randomGapMs(S, () => 0), 8 * 60_000);
  assert.equal(randomGapMs(S, () => 1), 15 * 60_000);
});

test('parseGroupUrl', () => {
  assert.equal(parseGroupUrl('https://www.facebook.com/groups/123456/?ref=share').id, '123456');
  assert.equal(parseGroupUrl('https://m.facebook.com/groups/tlv.apartments').id, 'tlv.apartments');
  assert.equal(parseGroupUrl('my_group').url, 'https://www.facebook.com/groups/my_group/');
  assert.equal(parseGroupUrl('https://google.com/x'), null);
});
