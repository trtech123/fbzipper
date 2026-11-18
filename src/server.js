import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { loadDb, saveDb, addLog, newId, IMAGES_DIR, DEFAULT_SETTINGS } from './store.js';
import { enqueueCycle, postsToday, quietReason } from './scheduler.js';
import { createRunner } from './runner.js';
import * as fb from './facebook.js';
import { parseGroupUrl } from './groupUrl.js';

const PORT = Number(process.env.PORT || 3777);
const db = loadDb();
const runner = createRunner(db);
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.resolve('public')));
app.use('/images', express.static(IMAGES_DIR));

const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(err => res.status(400).json({ error: err.message }));
const find = (list, id) => { const x = list.find(i => i.id === id); if (!x) throw new Error('לא נמצא'); return x; };

app.get('/api/state', wrap(async (req, res) => {
  const now = Date.now();
  const counts = { pending: 0, done: 0, failed: 0, skipped: 0 };
  db.queue.forEach(q => counts[q.status]++);
  res.json({
    settings: db.settings, groups: db.groups, posts: db.posts, campaigns: db.campaigns,
    queue: [...db.queue].sort((a, b) => (b.doneAt || b.dueAt) - (a.doneAt || a.dueAt)).slice(0, 300),
    log: db.log.slice(-200).reverse(),
    status: {
      running: db.runner.running, waitReason: runner.status.waitReason, current: runner.status.current,
      quiet: quietReason(now, db.settings), postsToday: postsToday(db, now), counts,
      browserOpen: fb.browserOpen(), loggedIn: await fb.isLoggedIn(),
    },
  });
}));

app.put('/api/settings', wrap((req, res) => {
  const next = { ...db.settings };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (!(k in req.body)) continue;
    const v = req.body[k];
    next[k] = typeof DEFAULT_SETTINGS[k] === 'number' ? Number(v) : typeof DEFAULT_SETTINGS[k] === 'boolean' ? !!v : String(v);
  }
  if (next.minGapMin < 3) throw new Error('מרווח מינימלי בין פוסטים הוא 3 דקות');
  if (next.maxGapMin < next.minGapMin) throw new Error('המרווח המקסימלי קטן מהמינימלי');
  if (next.dailyCap < 1 || next.dailyCap > 60) throw new Error('מכסה יומית חייבת להיות בין 1 ל-60');
  if (!/^\d\d:\d\d$/.test(next.activeStart) || !/^\d\d:\d\d$/.test(next.activeEnd)) throw new Error('פורמט שעה לא תקין (HH:MM)');
  if (next.headless !== db.settings.headless) fb.closeBrowser();
  db.settings = next;
  saveDb(db);
  res.json(db.settings);
}));

// ---- groups
app.post('/api/groups', wrap((req, res) => {
  let added = 0;
  for (const line of String(req.body.text || '').split(/\s+/).filter(Boolean)) {
    const g = parseGroupUrl(line);
    if (!g || db.groups.some(x => x.id === g.id)) continue;
    db.groups.push({ ...g, name: g.id, enabled: true, tags: [] });
    added++;
  }
  saveDb(db);
  res.json({ added });
}));

app.post('/api/groups/import', wrap(async (req, res) => {
  const found = await fb.fetchJoinedGroups(db.settings.headless);
  let added = 0;
  for (const g of found) {
    const existing = db.groups.find(x => x.id === g.id);
    if (existing) { if (existing.name === existing.id) existing.name = g.name; continue; }
    db.groups.push({ id: g.id, name: g.name, url: `https://www.facebook.com/groups/${g.id}/`, enabled: true, tags: [] });
    added++;
  }
  addLog(db, 'info', `ייבוא קבוצות: נמצאו ${found.length}, נוספו ${added}`);
  saveDb(db);
  res.json({ found: found.length, added });
}));

app.patch('/api/groups/:id', wrap((req, res) => {
  const g = find(db.groups, req.params.id);
  if ('enabled' in req.body) g.enabled = !!req.body.enabled;
  if ('name' in req.body) g.name = String(req.body.name);
  if ('tags' in req.body) g.tags = String(req.body.tags).split(',').map(t => t.trim()).filter(Boolean);
  saveDb(db);
  res.json(g);
}));

app.delete('/api/groups/:id', wrap((req, res) => {
  db.groups = db.groups.filter(g => g.id !== req.params.id);
  db.campaigns.forEach(c => { c.groupIds = c.groupIds.filter(id => id !== req.params.id); });
  db.queue.forEach(q => { if (q.groupId === req.params.id && q.status === 'pending') q.status = 'skipped'; });
  saveDb(db);
  res.json({ ok: true });
}));

// ---- posts
app.post('/api/posts', wrap((req, res) => {
  const { title, text, images = [] } = req.body;
  if (!String(text || '').trim()) throw new Error('טקסט הפוסט ריק');
  const files = images.slice(0, 10).map(({ dataUrl }) => {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(dataUrl || '');
    if (!m) throw new Error('קובץ תמונה לא נתמך');
    const file = `${newId()}.${m[1].replace('jpeg', 'jpg')}`;
    fs.writeFileSync(path.join(IMAGES_DIR, file), Buffer.from(m[2], 'base64'));
    return file;
  });
  const post = { id: newId(), title: String(title || '').trim() || String(text).trim().slice(0, 30), text: String(text), images: files, createdAt: Date.now() };
  db.posts.push(post);
  saveDb(db);
  res.json(post);
}));

app.delete('/api/posts/:id', wrap((req, res) => {
  const post = find(db.posts, req.params.id);
  if (db.campaigns.some(c => c.postIds.includes(post.id))) throw new Error('הפוסט משויך לקמפיין — מחק קודם את הקמפיין');
  post.images.forEach(f => fs.rmSync(path.join(IMAGES_DIR, f), { force: true }));
  db.posts = db.posts.filter(p => p.id !== post.id);
  db.queue.forEach(q => { if (q.postId === post.id && q.status === 'pending') q.status = 'skipped'; });
  saveDb(db);
  res.json({ ok: true });
}));

// ---- campaigns
app.post('/api/campaigns', wrap((req, res) => {
  const { name, postIds = [], groupIds = [], repeatDays = 0, startAt } = req.body;
  const pIds = postIds.filter(id => db.posts.some(p => p.id === id));
  const gIds = groupIds.filter(id => db.groups.some(g => g.id === id));
  if (!pIds.length) throw new Error('בחר לפחות פוסט אחד');
  if (!gIds.length) throw new Error('בחר לפחות קבוצה אחת');
  const repeat = Number(repeatDays) || 0;
  if (repeat && repeat < 1) throw new Error('מחזוריות מינימלית היא יום אחד');
  const campaign = { id: newId(), name: String(name || '').trim() || 'קמפיין', postIds: pIds, groupIds: gIds, repeatDays: repeat, enabled: true, createdAt: Date.now() };
  db.campaigns.push(campaign);
  enqueueCycle(db, campaign, startAt ? new Date(startAt).getTime() : Date.now());
  addLog(db, 'info', `נוצר קמפיין "${campaign.name}" — ${gIds.length} קבוצות`);
  saveDb(db);
  res.json(campaign);
}));

app.patch('/api/campaigns/:id', wrap((req, res) => {
  const c = find(db.campaigns, req.params.id);
  if ('enabled' in req.body) c.enabled = !!req.body.enabled;
  saveDb(db);
  res.json(c);
}));

app.delete('/api/campaigns/:id', wrap((req, res) => {
  db.campaigns = db.campaigns.filter(c => c.id !== req.params.id);
  db.queue.forEach(q => { if (q.campaignId === req.params.id && q.status === 'pending') q.status = 'skipped'; });
  saveDb(db);
  res.json({ ok: true });
}));

// ---- queue
app.post('/api/queue/:id/post-now', wrap(async (req, res) => {
  const entry = find(db.queue, req.params.id);
  if (entry.status !== 'pending' && entry.status !== 'failed') throw new Error('אפשר לפרסם רק פריט ממתין או שנכשל');
  entry.status = 'pending';
  entry.attempts = 0;
  await runner.postNow(entry);
  res.json(entry);
}));

app.post('/api/queue/:id/retry', wrap((req, res) => {
  const entry = find(db.queue, req.params.id);
  Object.assign(entry, { status: 'pending', attempts: 0, error: null, dueAt: Date.now() });
  saveDb(db);
  res.json(entry);
}));

// ---- browser / runner
app.post('/api/browser/login', wrap(async (req, res) => { await fb.openForLogin(); res.json({ ok: true }); }));
app.post('/api/browser/close', wrap(async (req, res) => { await fb.closeBrowser(); res.json({ ok: true }); }));
app.post('/api/runner/start', wrap((req, res) => { runner.start(); res.json({ ok: true }); }));
app.post('/api/runner/stop', wrap((req, res) => { runner.stop(); res.json({ ok: true }); }));

// Body-parser errors (bad JSON, too large) as JSON instead of an HTML page.
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

app.listen(PORT, '127.0.0.1', () => console.log(`fbzipper is running: http://localhost:${PORT}`))
  .on('error', err => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`Port ${PORT} is already in use — fbzipper is probably already running. Open http://localhost:${PORT} or close the other window first.`);
    process.exit(1);
  });
