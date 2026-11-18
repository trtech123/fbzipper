// Tiny JSON-file database. Whole state lives in memory and is flushed on every save().
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.FBZ_DATA_DIR || path.resolve('data');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
const DB_FILE = path.join(DATA_DIR, 'db.json');

export const DEFAULT_SETTINGS = {
  activeStart: '07:00',   // Israel time
  activeEnd: '23:00',
  minGapMin: 8,           // random gap between two posts, minutes
  maxGapMin: 15,
  dailyCap: 25,           // max posts per Israel calendar day
  groupCooldownHours: 24, // never post to the same group more often than this
  shabbatPause: true,
  shabbatBufferMin: 30,   // stop this many minutes before candle lighting
  headless: false,
};

const EMPTY = () => ({ settings: { ...DEFAULT_SETTINGS }, groups: [], posts: [], campaigns: [], queue: [], log: [], runner: { running: false, nextAllowedAt: 0 } });

export const newId = () => crypto.randomBytes(6).toString('hex');

export function loadDb() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return EMPTY();
  const db = { ...EMPTY(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  db.settings = { ...DEFAULT_SETTINGS, ...db.settings };
  return db;
}

export function saveDb(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export function addLog(db, level, msg) {
  db.log.push({ at: Date.now(), level, msg });
  if (db.log.length > 1000) db.log.splice(0, db.log.length - 1000);
  console.log(`[${level}] ${msg}`);
}
