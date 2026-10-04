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
// mainButton: 'ok' (draws, isVisible follows show/hide), 'none' (no MainButton),
// 'silent' (show() does nothing: isVisible stays false).
const tgStub = ({ platform = 'ios', mainButton = 'ok' } = {}) => `
  window.__mb = { shown: false, text: '', clicks: [] };
  const mainButton = {
    isVisible: false,
    show(){ if (${JSON.stringify(mainButton)} === 'ok') { this.isVisible = true; window.__mb.shown = true; } },
    hide(){ this.isVisible = false; window.__mb.shown = false; },
    setText(t){ window.__mb.text = t; }, onClick(f){ window.__mb.clicks.push(f); },
    offClick(f){ window.__mb.clicks = window.__mb.clicks.filter(x => x !== f); },
    showProgress(){}, hideProgress(){}, enable(){}, disable(){}, setParams(){},
  };
  window.Telegram = { WebApp: {
    platform: ${JSON.stringify(platform)}, version: '8.0',
    initData: 'query_id=x&user=%7B%7D&hash=h', initDataUnsafe: { user: { id: 1, first_name: 'Нина' } },
    ready(){}, expand(){}, setHeaderColor(){}, setBackgroundColor(){}, isVersionAtLeast(){ return true; },
    onEvent(){}, offEvent(){}, shareMessage(id){ window.__shared = id; }, openTelegramLink(u){ window.__opened = u; },
    ${mainButton === 'none' ? '' : 'MainButton: mainButton,'}
    BackButton: { show(){}, hide(){}, onClick(){}, offClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
    close(){},
  } };`;
const stubTelegram = (page, opts) => page.route('**/telegram-web-app.js*',
  r => r.fulfill({ status: 200, contentType: 'text/javascript', body: tgStub(opts) }));

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

// ── E: КБЖУ card: calculate (1 point), errors, manual edit via PATCH ───────
{
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const calls = []; await mockApi(page, calls);
  const AI = { calories_kcal: 519.6, protein_g: 32, fat_g: 0, carbs_g: 41, basis: 'per_serving', source: 'ai_estimate' };
  const state = { nutrition: null, calc: [], patches: [] };
  await page.route('https://polyana.coiqa.ru/api/recipes/5**', async route => {
    const req = route.request(); const p = new URL(req.url()).pathname.replace('/api', '');
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    const handled = (p === '/recipes/5' && ['GET', 'PATCH'].includes(req.method())) || p === '/recipes/5/calculate-nutrition';
    if (!handled) return route.fallback();
    calls.push(req.method() + ' ' + p);
    if (p === '/recipes/5' && req.method() === 'GET') return json({ ...RECIPE, nutrition: state.nutrition });
    if (p === '/recipes/5' && req.method() === 'PATCH') {
      const body = JSON.parse(req.postData()); state.patches.push(body);
      state.nutrition = body.nutrition ? { ...body.nutrition, basis: 'per_serving', source: 'manual' } : null;
      return json({ id: 5, ok: true });
    }
    if (p === '/recipes/5/calculate-nutrition') {
      const next = state.calc.shift();
      if (next === 'ok') { state.nutrition = AI; return json({ ...RECIPE, nutrition: AI }); }
      return json({ detail: next }, 422);
    }
    return route.fallback();
  });
  await stubTelegram(page);
  await page.goto(BASE);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { Telegram.WebApp.showConfirm = (m, cb) => { window.__confirm = m; cb(true); }; });
  await page.evaluate(() => openRecipeDetail(5, 'library'));
  await page.waitForFunction(() => { const b = document.getElementById('rdetail-share-btn'); return b && !b.disabled; }, null, { timeout: 5000 }).catch(() => {});
  const card = () => page.$eval('#rdetail-nutrition', e => e.innerText).catch(() => '');
  const toastText = () => page.$eval('#toast', e => e.textContent).catch(() => '');

  check('E empty card offers calculate / manual', /не указано/.test(await card()) && /Рассчитать — 1 балл/.test(await card()) && /Ввести вручную/.test(await card()), await card());

  state.calc.push('ok');
  await page.evaluate(() => calculateNutrition());
  await page.waitForTimeout(300);
  let c = await card();
  check('E calculate → POST calculate-nutrition, card ≈ 520 ккал, ОЦЕНКА AI, Ж 0 г',
    calls.includes('POST /recipes/5/calculate-nutrition') && c.includes('≈ 520') && /ОЦЕНКА AI/.test(c) && c.includes('Ж 0 г') && /Оценка AI\./.test(c), c);
  check('E confirm asked via Telegram showConfirm', await page.evaluate(() => window.__confirm) === 'Рассчитать КБЖУ за 1 балл?');
  check('E share button kept ready, no second prepare-share',
    calls.filter(x => x === 'POST /recipes/5/prepare-share').length === 1 && await page.$eval('#rdetail-share-btn', b => !b.disabled));
  await page.evaluate(() => openRdetailMenu());
  check('E menu shows «Пересчитать КБЖУ — 1 балл»', (await page.evaluate(() => document.body.innerText)).includes('Пересчитать КБЖУ — 1 балл'));
  await page.evaluate(() => closeSheet());

  state.calc.push('insufficient_balance:1:0');
  await page.evaluate(() => calculateNutrition());
  await page.waitForTimeout(300);
  const noPoints = await page.$eval('#bottom-sheet', e => e.innerText).catch(() => '');
  check('E no points → «Не хватает баллов» dialog with top-up', noPoints.includes('Не хватает баллов: нужно 1, на балансе 0')
    && noPoints.includes('Получить баллы бесплатно'), noPoints);
  await page.evaluate(() => closeSheet());
  state.calc.push('nutrition_not_estimated');
  await page.evaluate(() => calculateNutrition());
  await page.waitForTimeout(300);
  check('E low confidence → toast «баллы возвращены», card unchanged', (await toastText()).includes('Баллы возвращены') && (await card()).includes('≈ 520'), await toastText());

  await page.evaluate(() => openNutritionEdit());
  const vals = await page.$$eval('#rdetail-nutrition input', els => els.map(e => e.value));
  check('E edit form prefilled (fat 0 kept)', JSON.stringify(vals) === JSON.stringify(['519.6', '32', '0', '41']), JSON.stringify(vals));
  await page.fill('#nut-calories_kcal', '-5');
  await page.evaluate(() => saveNutritionEdit());
  check('E negative value rejected without PATCH', state.patches.length === 0 && (await toastText()).includes('не меньше 0'));
  await page.fill('#nut-calories_kcal', '480,5');
  await page.evaluate(() => saveNutritionEdit());
  await page.waitForTimeout(300);
  check('E save → PATCH {nutrition:{…}} with comma decimal',
    JSON.stringify(state.patches[0]) === JSON.stringify({ nutrition: { calories_kcal: 480.5, protein_g: 32, fat_g: 0, carbs_g: 41 } }), JSON.stringify(state.patches));
  c = await card();
  check('E manual values shown as «Указано вручную», no AI mark', c.includes('≈ 481') && c.includes('Указано вручную') && !/ОЦЕНКА AI/.test(c), c);

  await page.evaluate(() => openNutritionEdit());
  for (const k of ['calories_kcal', 'protein_g', 'fat_g', 'carbs_g']) await page.fill(`#nut-${k}`, '');
  await page.evaluate(() => saveNutritionEdit());
  await page.waitForTimeout(300);
  check('E all cleared → PATCH {nutrition:null}, card back to empty',
    JSON.stringify(state.patches[1]) === JSON.stringify({ nutrition: null }) && /не указано/.test(await card()), JSON.stringify(state.patches));
  check('E no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ── F: «Создать событие» when Telegram's MainButton is missing / not drawn ──
for (const [label, opts, expectFallback] of [
  ['no MainButton', { mainButton: 'none' }, true],
  ['tdesktop', { platform: 'tdesktop' }, true],
  ['show() not taken (isVisible false)', { mainButton: 'silent' }, true],
  ['ios with MainButton', {}, false],
]) {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const calls = []; await mockApi(page, calls);
  const posted = [];
  await page.route('https://polyana.coiqa.ru/api/events', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(JSON.parse(route.request().postData()));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 42 }) });
  });
  await stubTelegram(page, opts);
  await page.goto(BASE);
  await page.waitForTimeout(1200);
  await page.evaluate(() => goCreate());
  await page.waitForTimeout(200);
  const fb = await page.$eval('#mb-fallback', e => !e.hidden && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0).catch(() => false);
  const fbText = await page.$eval('#mb-fallback-btn', e => e.textContent).catch(() => '');
  const mb = await page.evaluate(() => window.__mb);
  if (expectFallback) {
    check(`F ${label}: in-page «Создать событие» visible`, fb && fbText === 'Создать событие', JSON.stringify({ fb, fbText }));
    check(`F ${label}: MainButton not left on / no handler`, !mb.shown && mb.clicks.length === 0, JSON.stringify(mb));
    await page.fill('#ev-name', 'Шашлыки у Нины');
    await page.click('#mb-fallback-btn');
    await page.waitForTimeout(400);
    check(`F ${label}: click → POST /events once`, posted.length === 1 && posted[0].name === 'Шашлыки у Нины', JSON.stringify(posted));
    check(`F ${label}: back home, in-page button hidden`,
      await page.$eval('#s-home', e => e.classList.contains('active')).catch(() => false)
      && await page.$eval('#mb-fallback', e => e.hidden).catch(() => false));
  } else {
    check(`F ${label}: MainButton used, no in-page duplicate`, !fb && mb.shown && mb.text === 'Создать событие' && mb.clicks.length === 1, JSON.stringify({ fb, mb }));
  }
  check(`F ${label}: no page errors`, errors.length === 0, errors.join(' | '));
  await page.close();
}

// ── G: AI-balance top-up for Telegram Stars (paid / cancelled / failed) ─────
{
  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  check('G no YooKassa / card / receipt email in the Mini App',
    !/ЮК|yookassa|\/balance\/topup|email-sheet|topup-email/i.test(html));

  for (const [status, expectToast, credited, noBaseline = false] of [
    ['paid', '✅ Начислено +110 баллов. Баланс: 135 баллов', true],
    ['pending', 'Платёж ещё обрабатывается', false],
    ['cancelled', 'Оплата отменена', false],
    ['failed', 'Оплата не прошла', false],
    // /wallet/me failed before the invoice: no «+N» may be claimed from the old balance
    ['paid', 'Оплата прошла. Баллы появятся в течение пары минут', false, true],
  ]) {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    // Chromium logs failed HTTP responses itself (the no-baseline case answers 500 on purpose).
    page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
      errors.push('console: ' + m.text()); });
    const calls = []; await mockApi(page, calls);
    const st = { points: 25, invoices: [] };
    await page.route('https://polyana.coiqa.ru/api/{wallet/me,payments/**}', async route => {
      const req = route.request(); const p = new URL(req.url()).pathname.replace('/api', '');
      const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      calls.push(req.method() + ' ' + p);
      if (p === '/wallet/me') {
        if (st.failWallet) { st.failWallet = false; return route.fulfill({ status: 500, body: '{}' }); }
        return json({ total_available_points: st.points });
      }
      if (p === '/payments/packages') return json({ enabled: true, packages: [
        { code: 'points_300', title: 'Оптимальный', total_points: 110, stars: 50 }] });
      if (p === '/payments/stars/invoice') {
        st.invoices.push(JSON.parse(req.postData()));
        return json({ ok: true, invoice_link: 'https://t.me/$inv', order_id: 'o1', total_points: 110 });
      }
      return route.fallback();
    });
    await stubTelegram(page);
    await page.goto(BASE);
    await page.waitForTimeout(1200);
    await page.evaluate(({ status, credited }) => {
      Telegram.WebApp.openInvoice = (link, cb) => {
        window.__invoice = link;
        // the bot credits a moment after Telegram reports «paid»
        setTimeout(() => cb(status), 50);
      };
      window.__credit = credited;
    }, { status, credited });
    if (credited) setTimeout(() => { st.points = 135; }, 1600);
    const label = noBaseline ? `${status} (no baseline)` : status;

    await page.evaluate(() => openTopup());
    await page.waitForTimeout(400);
    const sheet = await page.$eval('#bottom-sheet', e => e.innerText).catch(() => '');
    check(`G ${label}: sheet shows balance and Stars package`,
      sheet.includes('AI-баланс: 25 баллов') && sheet.includes('110 баллов — 50 ⭐') && sheet.includes('Получить баллы бесплатно'), sheet);
    if (noBaseline) st.failWallet = true;
    await page.evaluate(() => buyStars('points_300'));
    await page.waitForFunction(t => (document.getElementById('toast')?.textContent || '').includes(t),
      expectToast, { timeout: 14000 }).catch(() => {});
    const t = await page.$eval('#toast', e => e.textContent).catch(() => '');
    check(`G ${label}: invoice for the package opened`,
      JSON.stringify(st.invoices) === JSON.stringify([{ package_code: 'points_300' }]) && await page.evaluate(() => window.__invoice) === 'https://t.me/$inv',
      JSON.stringify(st.invoices));
    check(`G ${label}: toast «${expectToast}»`, t.includes(expectToast), t);
    const polls = calls.filter(c => c === 'GET /wallet/me').length;
    check(`G ${label}: wallet polled only after «paid»/«pending» with a baseline`,
      (status === 'paid' || status === 'pending') && !noBaseline ? polls >= 3 : polls <= 3, String(polls));
    check(`G ${label}: no «Начислено» without a confirmed credit`, credited || !t.includes('Начислено'), t);
    check(`G ${label}: no page or console errors`, errors.length === 0, errors.join(' | '));
    await page.close();
  }

  // Stars off for this user (flag / allowlist) and «not enough points» from КБЖУ.
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const calls = []; await mockApi(page, calls);
  await page.route('https://polyana.coiqa.ru/api/{wallet/me,payments/**,recipes/5/calculate-nutrition}', route => {
    const p = new URL(route.request().url()).pathname.replace('/api', '');
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/wallet/me') return json({ total_available_points: 0 });
    if (p === '/payments/packages') return json({ enabled: false, packages: [] });
    return json({ detail: 'insufficient_balance:1:0' }, 402);
  });
  await stubTelegram(page);
  await page.goto(BASE);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { Telegram.WebApp.showConfirm = (m, cb) => cb(true); Telegram.WebApp.openInvoice = () => {}; });
  await page.evaluate(() => openRecipeDetail(5, 'library'));
  await page.waitForTimeout(600);
  await page.evaluate(() => calculateNutrition());
  await page.waitForTimeout(600);
  const sheet = await page.$eval('#bottom-sheet', e => e.innerText).catch(() => '');
  check('G not enough points → dialog with top-up and free points',
    sheet.includes('Не хватает баллов: нужно 1, на балансе 0') && sheet.includes('Пополнение звёздами скоро появится')
    && sheet.includes('Получить баллы бесплатно'), sheet);
  check('G Stars off → no invoice requested', !calls.some(c => c.includes('stars/invoice')));
  check('G settings menu has «AI-баланс и пополнение»',
    await page.evaluate(() => { closeSheet(); openSettings(); return document.getElementById('bottom-sheet').innerText; })
      .then(t => t.includes('AI-баланс и пополнение')));
  check('G no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ── H: invitation screen opens and closes (closeInvite) ────────────────────
{
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const calls = []; await mockApi(page, calls);
  await stubTelegram(page);
  await page.goto(BASE);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { S.currentEvent = { id: 42, name: 'Шашлыки' }; return openInviteScreen(); })
    .catch(e => errors.push(String(e)));
  await page.waitForTimeout(300);
  check('H invite screen opens', await page.$eval('#s-invite', e => e.classList.contains('active')).catch(() => false));
  await page.click('#s-invite .detail-back').catch(e => errors.push(String(e)));
  await page.waitForTimeout(200);
  check('H ← closes it back to the event', await page.$eval('#s-detail', e => e.classList.contains('active')).catch(() => false));
  check('H no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
srv.kill();
let fail = 0;
for (const [ok, name, extra] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : '  → ' + extra}`); }
console.log(fail ? `${fail} FAILED` : 'ALL PASSED');
process.exit(fail ? 1 : 0);
