// Headless smoke test for the Mini App (index.html) in Chromium.
// The API (polyana.coiqa.ru/api) is mocked; no network, no backend needed.
//
//   cd tests && npm ci && npx playwright install chromium
//   node smoke.mjs            # serves the repo root on 127.0.0.1:8765
//   CHROMIUM_PATH=/path/to/chrome node smoke.mjs   # use a preinstalled browser
//
// Exit code 1 if any check fails. Runs in CI on every PR (.github/workflows/smoke.yml).
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { chromium } from 'playwright';

const ROOT = resolve(process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = process.env.SMOKE_PORT || '8765';
const BASE = `http://127.0.0.1:${PORT}/index.html`;

const results = [];
const check = (name, ok, extra = '') => { results.push([ok, name, extra]); };

// ── 0: the inline script parses ─────────────────────────────────────────────
{
  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  let err = '';
  try { blocks.forEach(b => new vm.Script(b)); } catch (e) { err = String(e); }
  check('inline <script> parses', blocks.length > 0 && !err, err);
}

const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));

const RECIPE = {
  id: 5, user_id: 1, name: 'Суп "Мамин" <b>', emoji: '🍲', servings: 2, cook_time_minutes: 30,
  source_type: 'manual', category: 'обед', tags: [], times_cooked: 0, nutrition: null,
  ingredients: [{ id: 1, name: 'Соль "морская"', qty: null, unit: '', category: 'специи' },
                { id: 2, name: 'Вода', qty: 0, unit: 'л', category: 'прочее' }],
  steps: [{ step_number: 1, text: 'Сварить' }],
};
const EDITORIAL = { id: 7, name: 'Борщ "Классика" <i>', emoji: '🍲', servings: 4, cook_time_minutes: 90,
  description: 'Описание', nutrition: { calories_kcal: 420, protein_g: 20, fat_g: 15, carbs_g: 45, source: 'ai_estimated' },
  ingredients: [{ name: 'Свёкла', qty: 2, unit: 'шт' }], steps: [{ step_number: 1, text: 'Варить' }] };

async function mockApi(page, calls) {
  await page.route('https://polyana.coiqa.ru/api/**', async route => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/api', '');
    calls.push(route.request().method() + ' ' + p);
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/public/recipes/id7') return json(EDITORIAL);
    if (p.startsWith('/public/recipes/')) return route.fulfill({ status: 404, body: '{}' });
    if (p === '/onboarding/status') return json({ status: 'completed' });
    if (p === '/recipes/5') return json(RECIPE);
    if (p === '/recipes/5/prepare-share') return json({ prepared_message_id: 'pm1', token: 't1',
      mini_app_url: 'https://t.me/reciptesbot/polyana?startapp=shared_t1',
      expiration_date: Math.floor(Date.now() / 1000) + 3600 });
    if (p === '/recipes/5/normalize-ingredients') return json({ updated: 2 });
    return json(p.endsWith('s') ? [] : {});
  });
  await page.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
}

// Minimal Telegram.WebApp for the "inside Telegram" scenarios.
const TG_STUB = `
  window.Telegram = { WebApp: {
    initData: 'query_id=x&user=%7B%7D&hash=h', initDataUnsafe: { user: { id: 1, first_name: 'Нина' } },
    ready(){}, expand(){}, setHeaderColor(){}, setBackgroundColor(){}, isVersionAtLeast(){ return true; },
    onEvent(){}, offEvent(){}, shareMessage(id){ window.__shared = id; }, openTelegramLink(u){ window.__opened = u; },
    MainButton: { show(){}, hide(){}, setText(){}, onClick(){}, offClick(){}, showProgress(){}, hideProgress(){}, enable(){}, disable(){}, setParams(){} },
    BackButton: { show(){}, hide(){}, onClick(){}, offClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
    close(){},
  } };`;
const stubTelegram = page => page.route('**/telegram-web-app.js*',
  r => r.fulfill({ status: 200, contentType: 'text/javascript', body: TG_STUB }));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// ── A: outside Telegram (real bundled SDK), editorial deep link ─────────────
{
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const calls = []; await mockApi(page, calls);
  await page.goto(BASE + '?startapp=editorial_id7');
  await page.waitForFunction(() => document.querySelector('#ed-content h1'), null, { timeout: 8000 }).catch(() => {});
  const h1 = await page.$eval('#ed-content h1', e => e.textContent).catch(() => null);
  check('A editorial_id7 → GET /public/recipes/id7', calls.includes('GET /public/recipes/id7'), calls.join(','));
  check('A editorial title rendered as text (escaped)', h1 === EDITORIAL.name, String(h1));
  check('A editorial screen active', await page.$eval('#s-editorial', e => e.classList.contains('active')).catch(() => false));
  check('A no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ── B: inside Telegram (stub SDK), recipe detail + menu + edit form ─────────
{
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const calls = []; await mockApi(page, calls);
  await stubTelegram(page);
  await page.goto(BASE);
  await page.waitForTimeout(1200);
  await page.evaluate(() => openRecipeDetail(5, 'library'));
  await page.waitForFunction(() => { const b = document.getElementById('rdetail-share-btn'); return b && !b.disabled; }, null, { timeout: 5000 }).catch(() => {});
  check('B share button primed via prepare-share (prod Share code)', calls.includes('POST /recipes/5/prepare-share'));
  check('B share button enabled', await page.$eval('#rdetail-share-btn', b => !b.disabled).catch(() => false));
  await page.evaluate(() => openRdetailMenu());
  const sheet = await page.evaluate(() => document.body.innerText);
  check('B menu: «Распознать количества» (from main)', sheet.includes('Распознать количества'));
  check('B menu: «Рассчитать КБЖУ — 1 балл» (from prod)', sheet.includes('Рассчитать КБЖУ — 1 балл'));
  await page.evaluate(() => { closeSheet(); return typeof normalizeRecipeIngredients === 'function' && normalizeRecipeIngredients(); });
  check('B normalize → POST /recipes/5/normalize-ingredients', calls.includes('POST /recipes/5/normalize-ingredients'));
  await page.evaluate(() => openRecipeEdit());
  await page.waitForTimeout(300);
  const names = await page.$$eval('input.ing-name', els => els.map(e => e.value));
  check('B edit form keeps quotes in ingredient name (esc)', names[0] === 'Соль "морская"', JSON.stringify(names));
  await page.evaluate(() => { openRecipeDetail(5, 'library'); });
  await page.waitForFunction(() => { const b = document.getElementById('rdetail-share-btn'); return b && !b.disabled; }, null, { timeout: 5000 }).catch(() => {});
  await page.click('#rdetail-share-btn').catch(() => {});
  check('B share click → tg.shareMessage(prepared id)', await page.evaluate(() => window.__shared) === 'pm1');
  check('B no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ── C: inside Telegram, editorial deep link, then ✕ → home with events ─────
{
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const calls = []; await mockApi(page, calls);
  await stubTelegram(page);
  await page.goto(BASE + '?startapp=editorial_id7');
  await page.waitForFunction(() => document.querySelector('#ed-content h1'), null, { timeout: 8000 }).catch(() => {});
  check('C authed editorial link opens editorial screen', await page.$eval('#s-editorial', e => e.classList.contains('active')).catch(() => false));
  const before = calls.filter(c => c === 'GET /events').length;
  await page.evaluate(() => closeEditorial());
  await page.waitForTimeout(500);
  check('C ✕ loads home events (GET /events)', calls.filter(c => c === 'GET /events').length > before, calls.join(','));
  check('C home screen active', await page.$eval('#s-home', e => e.classList.contains('active')).catch(() => false));
  check('C no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ── D: «Выбрать чат другим способом»: inline → t.me/share/url → clipboard ───
{
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const calls = []; await mockApi(page, calls);
  await stubTelegram(page);
  await page.goto(BASE);
  await page.waitForTimeout(1200);
  await page.evaluate(() => openRecipeDetail(5, 'library'));
  await page.waitForFunction(() => { const b = document.getElementById('rdetail-share-btn'); return b && !b.disabled; }, null, { timeout: 5000 }).catch(() => {});
  const LINK = 'https://t.me/reciptesbot/polyana?startapp=shared_t1';
  const fallback = setup => page.evaluate(({ setup }) => {
    const tg = window.Telegram.WebApp;
    window.__inline = window.__opened = window.__copied = undefined;
    delete tg.switchInlineQuery;
    tg.openTelegramLink = u => { window.__opened = u; };
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: t => { window.__copied = t; return Promise.resolve(); } } });
    if (setup === 'inline') tg.switchInlineQuery = (q, types) => { window.__inline = [q, types]; };
    if (setup === 'inline-throws' || setup === 'all-fail')
      tg.switchInlineQuery = () => { throw Error('WebAppMethodUnsupported'); };
    if (setup === 'all-fail') tg.openTelegramLink = () => { throw Error('WebAppTgUrlInvalid'); };
    shareRecipeFallback(5);
    return new Promise(r => setTimeout(() => r({
      inline: window.__inline, opened: window.__opened, copied: window.__copied,
      toast: document.getElementById('toast')?.textContent || '' }), 100));
  }, { setup });

  let r = await fallback('inline');
  check('D inline picker used when available', JSON.stringify(r.inline) === JSON.stringify(['share:t1', ['users', 'groups', 'channels']]) && !r.opened, JSON.stringify(r));
  r = await fallback('inline-throws');
  const expected = 'https://t.me/share/url?url=' + encodeURIComponent(LINK);
  check('D switchInlineQuery throws → t.me/share/url with mini_app_url', (r.opened || '').startsWith(expected), JSON.stringify(r));
  r = await fallback('no-inline');
  check('D no switchInlineQuery (Telegram < 6.6) → t.me/share/url', (r.opened || '').startsWith(expected), JSON.stringify(r));
  r = await fallback('all-fail');
  check('D openTelegramLink fails → link copied + toast', r.copied === LINK && r.toast.includes('Ссылка скопирована'), JSON.stringify(r));
  // the main Share button is unchanged: still shareMessage from the click
  await page.evaluate(() => { window.__shared = undefined; });
  await page.click('#rdetail-share-btn').catch(() => {});
  check('D main Share button still calls shareMessage', await page.evaluate(() => window.__shared) === 'pm1');
  check('D no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
srv.kill();
let fail = 0;
for (const [ok, name, extra] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : '  → ' + extra}`); }
console.log(fail ? `${fail} FAILED` : 'ALL PASSED');
process.exit(fail ? 1 : 0);
