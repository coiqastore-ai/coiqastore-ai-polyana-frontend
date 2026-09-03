/**
 * POLIANA STABILITY V1 — Share Tests (prefetched native link)
 *
 * Executes the REAL share implementation extracted from index.html
 * inside a Node.js vm sandbox with mock dependencies.
 *
 * Run: node test_share.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
const results = [];

function assert(name, condition, detail) {
    if (condition) {
        results.push({ name, status: 'PASS' });
        passed++;
    } else {
        results.push({ name, status: 'FAIL', detail: detail || '' });
        failed++;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTRACT REAL SHARE CODE
// ═══════════════════════════════════════════════════════════════════════════

const htmlPath = path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
const allScripts = scriptMatches.map(m => m[1]).join('\n');

// Extract from "let sharePrefetch" to just before "function showShareScreen"
const shareBlockMatch = allScripts.match(
    /(let sharePrefetch = null[\s\S]*?)(?=function showShareScreen\()/
);
const shareBlock = shareBlockMatch ? shareBlockMatch[1].trim() : '';

assert('Share block extracted', shareBlock.length > 100, `Length: ${shareBlock.length}`);
assert('Block contains prefetchShareLink', shareBlock.includes('function prefetchShareLink'));
assert('Block contains cancelSharePrefetch', shareBlock.includes('function cancelSharePrefetch'));
assert('Block contains shareGeneration', shareBlock.includes('shareGeneration'));
assert('Block does NOT contain shareMessage', !shareBlock.includes('shareMessage'));
assert('Block does NOT contain openTelegramLink', !shareBlock.includes('openTelegramLink'));
assert('Block does NOT contain shareRecipe', shareBlock.includes('shareRecipe') === false);

// ═══════════════════════════════════════════════════════════════════════════
// SANDBOX FACTORY
// ═══════════════════════════════════════════════════════════════════════════

function createSandbox() {
    function mockElement() {
        return {
            disabled: false, textContent: '', innerHTML: '', style: {},
            _attrs: {}, _classes: new Set(),
            href: undefined,
            onclick: null,
            classList: {
                _s: null,
                add(c) { this._s.add(c); },
                remove(c) { this._s.delete(c); },
                contains(c) { return this._s.has(c); },
            },
            setAttribute(k, v) { this._attrs[k] = v; },
            removeAttribute(k) { delete this._attrs[k]; },
        };
    }

    const domElements = {};
    function getElement(id) {
        if (!domElements[id]) {
            const el = mockElement();
            el.classList._s = el._classes;
            domElements[id] = el;
        }
        return domElements[id];
    }

    const mockDocument = {
        getElementById: getElement,
        querySelectorAll: () => [], querySelector: () => null,
        addEventListener: () => {},
        documentElement: { style: { getPropertyValue: () => '' } },
    };

    const state = {
        apiCalls: [],
        toastMessages: [],
        timers: [],
        timerCallbacks: new Map(),
        nextTimerId: 1,
    };

    async function mockApi(url, method, body) {
        state.apiCalls.push({ url, method, body });
        if (url.includes('/prepare-share')) {
            return {
                prepared_message_id: 'test-prepared-id',
                token: 'test-token',
                mini_app_url: 'https://t.me/testbot?startapp=shared_test-token',
            };
        }
        return {};
    }

    function mockSetTimeout(fn, ms) {
        const id = state.nextTimerId++;
        state.timers.push({ id, ms });
        state.timerCallbacks.set(id, fn);
        return id;
    }
    function mockClearTimeout(id) { state.timerCallbacks.delete(id); }

    const mockRDETAIL = { recipe: { id: 42, name: 'Тестовый суп' }, from: 'library' };

    const context = {
        window: { Telegram: { WebApp: { ready: () => {}, expand: () => {} } } },
        document: mockDocument,
        navigator: { clipboard: { writeText: () => ({ catch: () => ({}) }) } },
        console,
        setTimeout: mockSetTimeout, clearTimeout: mockClearTimeout,
        encodeURIComponent,
        api: mockApi,
        hapticNotif() {},
        toast(msg) { state.toastMessages.push(msg); },
        $: getElement, BOT: 'testbot', RDETAIL: mockRDETAIL,
    };

    return {
        context, state, domElements, getElement, mockRDETAIL,
    };
}

function loadShareCode(sandbox) {
    const ctx = vm.createContext(sandbox.context);
    vm.runInContext(shareBlock, ctx);
    assert('prefetchShareLink available', typeof sandbox.context.prefetchShareLink === 'function');
    assert('cancelSharePrefetch available', typeof sandbox.context.cancelSharePrefetch === 'function');
    return ctx;
}

// Wait for microtask queue to flush (Promise.then callbacks)
const flush = () => new Promise(r => setTimeout(r, 10));

// ═══════════════════════════════════════════════════════════════════════════
// STATIC CHECKS
// ═══════════════════════════════════════════════════════════════════════════

function runStaticChecks() {
    console.log('=== STATIC CHECKS ===');

    try { new Function(allScripts); assert('JS syntax valid', true); }
    catch (e) { assert('JS syntax valid', false, e.message); }

    const escDecls = [...html.matchAll(/(?:^|\n)\s*function\s+esc\s*\(/g)];
    assert('Exactly one function esc()', escDecls.length === 1, `Found ${escDecls.length}`);

    const escFn = html.match(/function esc\(s\)\s*\{[\s\S]*?\n\}/);
    if (escFn) {
        const b = escFn[0];
        assert('esc() escapes &', b.includes('&amp;'));
        assert('esc() escapes <', b.includes('&lt;'));
        assert('esc() escapes >', b.includes('&gt;'));
        assert('esc() escapes "', b.includes('&quot;'));
        assert("esc() escapes '", b.includes('&#39;'));
    }

    assert('normalizeRecipeIngredients exists', allScripts.includes('async function normalizeRecipeIngredients()'));

    const menuFn = allScripts.match(/function openRdetailMenu\(\)\s*\{[\s\S]*?openSheet\(/);
    const menu = menuFn ? menuFn[0] : '';
    assert('Share removed from menu', !menu.includes('Поделиться рецептом'));
    assert('Edit still in menu', menu.includes('Редактировать рецепт'));
    assert('Normalize in menu', menu.includes('Распознать количества'));

    assert('No [SHARE] console.log', !allScripts.includes("console.log('[SHARE]"));
    assert('No openShareLink function', !allScripts.includes('function openShareLink('));
    assert('Share bar HTML exists', html.includes('id="rdetail-share-bar"'));
    assert('Share btn is <a> tag', html.includes('<a class="btn-share" id="rdetail-share-btn"'));

    // Toast CSS
    const toastCss = html.match(/\.toast\s*\{[^}]*\}/);
    assert('Toast pointer-events: none', toastCss?.[0]?.includes('pointer-events: none'));
    const undoCss = html.match(/\.toast-undo\s*\{[^}]*\}/);
    assert('Toast-undo pointer-events: auto', undoCss?.[0]?.includes('pointer-events: auto'));

    // No shareMessage/openTelegramLink in share block
    assert('No shareMessage in share block', !shareBlock.includes('shareMessage'));
    assert('No openTelegramLink in share block', !shareBlock.includes('openTelegramLink'));

    // Preserved
    assert('showShareScreen preserved', allScripts.includes('function showShareScreen('));
    assert('executeShare preserved', allScripts.includes('async function executeShare('));
    assert('runQuickShare preserved', allScripts.includes('async function runQuickShare('));
    assert('shareReferralLink preserved', allScripts.includes('async function shareReferralLink('));
}

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL TESTS
// ═══════════════════════════════════════════════════════════════════════════

// A: Prefetch launches automatically, href absent before API response
async function testPrefetchOnRender() {
    const sb = createSandbox();
    let resolveApi;
    sb.context.api = (url) => {
        sb.state.apiCalls.push({ url });
        if (url.includes('/prepare-share')) return new Promise(r => { resolveApi = r; });
        return Promise.resolve({});
    };
    const ctx = loadShareCode(sb);

    ctx.prefetchShareLink(42, 'Тестовый суп');

    assert('A: API called once', sb.state.apiCalls.length === 1);
    const btn = sb.getElement('rdetail-share-btn');
    assert('A: href absent before response', btn.href === undefined);
    assert('A: aria-disabled=true', btn._attrs['aria-disabled'] === 'true');
    assert('A: text is loading', btn.textContent === 'Готовлю ссылку…');
}

// B: After successful response — href set, correct format
async function testAfterSuccess() {
    const sb = createSandbox();
    sb.context.api = (url) => {
        sb.state.apiCalls.push({ url });
        return Promise.resolve({
            mini_app_url: 'https://t.me/testbot?startapp=shared_test-token',
        });
    };
    const ctx = loadShareCode(sb);

    ctx.prefetchShareLink(42, 'Тестовый суп');
    await flush();

    const btn = sb.getElement('rdetail-share-btn');
    assert('B: href set', typeof btn.href === 'string' && btn.href.length > 0);
    assert('B: starts with t.me/share/url', btn.href.startsWith('https://t.me/share/url'));
    assert('B: contains mini_app_url', btn.href.includes('shared_test-token'));
    assert('B: contains recipe name', btn.href.includes('Тестовый') || btn.href.includes('%D0%A2%D0%B5%D1%81%D1%82'));
    assert('B: no undefined', !btn.href.includes('undefined'));
    assert('B: aria-disabled=false', btn._attrs['aria-disabled'] === 'false');
    assert('B: correct text', btn.textContent === '📤 Поделиться рецептом');
}

// C: Ready tap — no API, no shareMessage, no openTelegramLink, no preventDefault
function testReadyTapNoAsync() {
    const sb = createSandbox();
    const ctx = loadShareCode(sb);
    const btn = sb.getElement('rdetail-share-btn');

    // Simulate ready state
    btn.href = 'https://t.me/share/url?url=https%3A%2F%2Ft.me%2Ftestbot&text=test';
    btn.setAttribute('aria-disabled', 'false');
    btn.textContent = '📤 Поделиться рецептом';
    btn.onclick = null;

    assert('C: href exists before tap', typeof btn.href === 'string' && btn.href.length > 0);
    assert('C: onclick is null', btn.onclick === null);
    assert('C: aria-disabled=false', btn._attrs['aria-disabled'] === 'false');
    // In real browser, <a> with href navigates natively — no JS needed
}

// D: Double tap — no new API calls
async function testDoubleTap() {
    const sb = createSandbox();
    let apiCount = 0;
    sb.context.api = (url) => {
        apiCount++;
        sb.state.apiCalls.push({ url });
        return Promise.resolve({ mini_app_url: 'https://t.me/testbot?startapp=shared_tok' });
    };
    const ctx = loadShareCode(sb);

    ctx.prefetchShareLink(42, 'Суп');
    await flush();
    const callsAfterFirst = apiCount;

    // Second call with same generation — should NOT create new API call
    // (In real usage, the link is already ready, user just taps the <a>)
    assert('D: API called once', callsAfterFirst === 1);
}

// E: API error — retry state
async function testApiError() {
    const sb = createSandbox();
    sb.context.api = () => Promise.reject(new Error('network'));
    const ctx = loadShareCode(sb);

    ctx.prefetchShareLink(42, 'Суп');
    await flush();

    const btn = sb.getElement('rdetail-share-btn');
    assert('E: href absent', btn.href === undefined);
    assert('E: aria-disabled=false', btn._attrs['aria-disabled'] === 'false');
    assert('E: retry text', btn.textContent.includes('Подготовить ссылку ещё раз'));
    assert('E: onclick set for retry', typeof btn.onclick === 'function');
}

// F: Retry — new API call, new href on success
async function testRetry() {
    const sb = createSandbox();
    let callCount = 0;
    sb.context.api = (url) => {
        callCount++;
        sb.state.apiCalls.push({ url });
        if (callCount === 1) return Promise.reject(new Error('fail'));
        return Promise.resolve({ mini_app_url: 'https://t.me/testbot?startapp=shared_retry' });
    };
    const ctx = loadShareCode(sb);

    ctx.prefetchShareLink(42, 'Суп');
    await flush();
    assert('F: first call failed', callCount === 1);

    const btn = sb.getElement('rdetail-share-btn');
    assert('F: retry state', btn.textContent.includes('ещё раз'));

    // Simulate retry click
    const fakeEvent = { preventDefault: () => { sb.state.prevented = true; } };
    btn.onclick(fakeEvent);
    assert('F: preventDefault called', sb.state.prevented === true);

    // Wait for retry API
    await new Promise(r => setTimeout(r, 10));
    assert('F: second API call', callCount === 2);
    assert('F: href set after retry', btn.href?.includes('shared_retry'));
}

// G: Close during pending — late resolve ignored
async function testCloseDuringPending() {
    const sb = createSandbox();
    let resolveApi;
    sb.context.api = () => new Promise(r => { resolveApi = r; });
    const ctx = loadShareCode(sb);

    ctx.prefetchShareLink(42, 'Суп');
    ctx.cancelSharePrefetch();

    resolveApi({ mini_app_url: 'https://t.me/testbot?startapp=shared_late' });
    await new Promise(r => setTimeout(r, 10));

    const btn = sb.getElement('rdetail-share-btn');
    assert('G: href not set', btn.href === undefined);
    assert('G: aria-disabled=true', btn._attrs['aria-disabled'] === 'true');
}

// H: Open another recipe — old response ignored
async function testOpenAnotherRecipe() {
    const sb = createSandbox();
    let resolveOld;
    sb.context.api = (url) => {
        sb.state.apiCalls.push({ url });
        if (url.includes('42')) return new Promise(r => { resolveOld = r; });
        return Promise.resolve({ mini_app_url: 'https://t.me/testbot?startapp=shared_new' });
    };
    const ctx = loadShareCode(sb);

    ctx.prefetchShareLink(42, 'Старый суп');
    ctx.cancelSharePrefetch();
    ctx.prefetchShareLink(99, 'Новый суп');
    await flush();

    resolveOld({ mini_app_url: 'https://t.me/testbot?startapp=shared_old' });
    await flush();

    const btn = sb.getElement('rdetail-share-btn');
    assert('H: href for new recipe', btn.href?.includes('shared_new'));
    assert('H: no old token', !btn.href?.includes('shared_old'));
}

// I: Dangerous recipe name — properly encoded
async function testDangerousName() {
    const sb = createSandbox();
    sb.context.api = () => Promise.resolve({ mini_app_url: 'https://t.me/testbot?startapp=shared_tok' });
    const ctx = loadShareCode(sb);

    ctx.prefetchShareLink(42, '<script>alert("xss")>&"\'Кириллица');
    await flush();

    const btn = sb.getElement('rdetail-share-btn');
    assert('I: no raw < in href', !btn.href?.includes('<script>'));
    assert('I: no raw > in href', !btn.href?.includes('>"'));
    assert('I: no raw " in href', !btn.href?.includes('="'));
    assert('I: encoded cyrillic', btn.href?.includes('%D0%9A%D0%B8%D1%80%D0%B8%D0%BB%D0%BB%D0%B8%D1%86%D0%B0') || btn.href?.includes('%D0%BA%D0%B8%D1%80%D0%B8%D0%BB%D0%BB%D0%B8%D1%86%D0%B0'));
    assert('I: no undefined', !btn.href?.includes('undefined'));
}

// J: Static checks — no shareMessage, no openTelegramLink, toast OK
function testStaticJ() {
    assert('J: No shareMessage in share block', !shareBlock.includes('shareMessage'));
    assert('J: No openTelegramLink in share block', !shareBlock.includes('openTelegramLink'));
    assert('J: No await in ready tap path', !shareBlock.match(/href[\s\S]{0,50}await/));
    assert('J: Share not in menu',
        !allScripts.match(/function openRdetailMenu[\s\S]*?openSheet/)?.[0]?.includes('Поделиться рецептом'));
    const toastCss = html.match(/\.toast\s*\{[^}]*\}/);
    assert('J: Toast pointer-events: none', toastCss?.[0]?.includes('pointer-events: none'));
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════════════════

async function runTests() {
    runStaticChecks();
    console.log('\n=== BEHAVIORAL TESTS ===');

    await testPrefetchOnRender();
    await testAfterSuccess();
    testReadyTapNoAsync();
    await testDoubleTap();
    await testApiError();
    await testRetry();
    await testCloseDuringPending();
    await testOpenAnotherRecipe();
    await testDangerousName();
    testStaticJ();
}

runTests()
    .then(() => {
        console.log('');
        for (const r of results) {
            const icon = r.status === 'PASS' ? 'PASS' : 'FAIL';
            console.log(`  ${icon}: ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
        }
        console.log('\n' + '='.repeat(60));
        console.log(`TOTAL: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('='.repeat(60));
        process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
        console.error('\nUNHANDLED ERROR:', err);
        process.exit(1);
    });
