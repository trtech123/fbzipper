// Drives a real, persistent browser profile logged in as the user. Selectors cover Hebrew + English UI.
import path from 'node:path';
import { chromium } from 'playwright';
import { DATA_DIR } from './store.js';

const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
let context = null;
let lock = Promise.resolve();

/** Serialize all browser work: one action at a time on one page. */
function exclusive(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

async function getContext(headless) {
  if (context) return context;
  const opts = { headless, viewport: { width: 1280, height: 900 }, locale: 'he-IL' };
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: 'chrome' });
  } catch {
    context = await chromium.launchPersistentContext(PROFILE_DIR, opts); // bundled Chromium fallback
  }
  context.on('close', () => { context = null; });
  return context;
}

async function getPage(headless) {
  const ctx = await getContext(headless);
  return ctx.pages()[0] || ctx.newPage();
}

const pause = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

export const browserOpen = () => !!context;

export async function closeBrowser() {
  if (context) await context.close().catch(() => {});
  context = null;
}

/** Opens facebook.com in a visible window so the user can log in by hand. */
export const openForLogin = () => exclusive(async () => {
  if (context) await closeBrowser(); // relaunch visibly even if it was headless
  const page = await getPage(false);
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
});

export async function isLoggedIn() {
  if (!context) return null; // unknown until the browser is open
  const cookies = await context.cookies('https://www.facebook.com');
  return cookies.some(c => c.name === 'c_user');
}

async function assertLoggedIn(page) {
  if (/checkpoint/.test(page.url())) throw new Error('פייסבוק מבקש אימות חשבון — פתח את הדפדפן והשלם את האימות');
  if (!(await isLoggedIn())) throw new Error('לא מחובר לפייסבוק — לחץ "פתח דפדפן להתחברות"');
}

const RESERVED =new Set(['feed', 'discover', 'joins', 'create', 'notifications', 'search', 'you', 'requests', 'learning_content']);

/** Scrapes the list of groups the logged-in user has joined. */
export const fetchJoinedGroups = (headless) => exclusive(async () => {
  const page = await getPage(headless);
  await page.goto('https://www.facebook.com/groups/joins/', { waitUntil: 'domcontentloaded' });
  if (!(await isLoggedIn())) {
    // Leave a visible window on the login page so the user can sign in right away.
    if (headless) { await closeBrowser(); await (await getPage(false)).goto('https://www.facebook.com/'); }
    else await page.goto('https://www.facebook.com/');
    throw new Error('לא מחובר לפייסבוק. נפתח חלון — התחבר בו, ואז לחץ שוב על "ייבא את הקבוצות שלי"');
  }
  await page.waitForTimeout(3000);
  const found = new Map();
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    const batch = await page.$$eval('a[href*="/groups/"]', as => as.map(a => ({ href: a.href, name: a.innerText.trim() })));
    const before = found.size;
    for (const { href, name } of batch) {
      const m = href.match(/facebook\.com\/groups\/([^/?#]+)/);
      if (!m || RESERVED.has(m[1]) || !name || name.length > 120) continue;
      const first = name.split('\n')[0].trim();
      if (!found.has(m[1]) || found.get(m[1]).name.length < first.length) found.set(m[1], { id: m[1], name: first });
    }
    stable = found.size === before ? stable + 1 : 0;
    await page.mouse.wheel(0, 4000);
    await pause(1200, 2000);
  }
  return [...found.values()];
});

const COMPOSER = /Write something|כתוב משהו|כאן כותבים|כתיבת פוסט|Create a public post|יצירת פוסט ציבורי/i;
const PHOTO_BTN = /Photo\/video|תמונה\/סרטון|תמונה\/וידאו/i;
const POST_BTN = /^(Post|פרסם|פרסום)$/;

/** Publishes one post into a group. Throws with a readable message on failure. */
export const postToGroup = ({ groupUrl, text, imagePaths = [], headless }) => exclusive(async () => {
  const page = await getPage(headless);
  await page.goto(groupUrl, { waitUntil: 'domcontentloaded' });
  await pause(2500, 4500);

  await assertLoggedIn(page);

  const composer = page.locator('[role="button"]').filter({ hasText: COMPOSER }).first();
  if (!(await composer.isVisible({ timeout: 10_000 }).catch(() => false))) {
    throw new Error('לא נמצא תיבת כתיבת פוסט בקבוצה (ייתכן שאינך חבר בקבוצה או שהפרסום חסום)');
  }
  await composer.click();

  const dialog = page.getByRole('dialog').filter({ has: page.locator('[contenteditable="true"]') }).last();
  const box = dialog.locator('[contenteditable="true"][role="textbox"]').first();
  await box.waitFor({ timeout: 15_000 });
  await box.click();
  await pause(500, 1000);

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
  }
  await pause(800, 1500);

  if (imagePaths.length) {
    let input = dialog.locator('input[type="file"]').first();
    if (!(await input.count())) {
      await dialog.getByRole('button', { name: PHOTO_BTN }).first().click().catch(() => {});
      await pause(800, 1200);
      input = dialog.locator('input[type="file"]').first();
    }
    await input.setInputFiles(imagePaths);
    await pause(3000 + 1500 * imagePaths.length, 5000 + 2000 * imagePaths.length); // let uploads finish
  }

  const postBtn = dialog.getByRole('button', { name: POST_BTN }).last();
  await postBtn.waitFor({ timeout: 10_000 });
  await page.waitForFunction(el => el.getAttribute('aria-disabled') !== 'true', await postBtn.elementHandle(), { timeout: 60_000 });
  await postBtn.click();

  await dialog.waitFor({ state: 'detached', timeout: 90_000 }).catch(async () => {
    if (await dialog.isVisible().catch(() => false)) throw new Error('חלון הפוסט לא נסגר אחרי הלחיצה על "פרסם" — ייתכן שפייסבוק חסם את הפרסום');
  });
  await pause(2000, 3500);
});
