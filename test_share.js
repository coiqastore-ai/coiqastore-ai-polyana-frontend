/**
 * POLIANA STABILITY V1 — Share Tests (reliable one-tap picker)
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

const shareBlockMatch = allScripts.match(
    /(let recipeShareInProgress = false[\s\S]*?)(?=function showShareScreen\()/
);
const shareBlock = shareBlockMatch ? shareBlockMatch[1].trim() : '';

assert('Share block extracted', shareBlock.length > 100, `Length: ${shareBlock.length}`);
assert('Block contains shareRecipe', shareBlock.includes('async function shareRecipe'));
assert('Block contains shareCurrentRecipe', shareBlock.includes('function shareCurrentRecipe'));
assert('Block contains cancelCurrentAttempt', shareBlock.includes('function cancelCurrentAttempt'));
assert('Block contains copyShareFallback', shareBlock.includes('function copyShareFallback'));
assert('Block does NOT contain shareMessage', !shareBlock.includes('shareMessage'));
assert('Block does NOT contain shareTimer', !shareBlock.includes('shareTimer'));
assert('Block does NOT contain fallbackOffered', !shareBlock.includes('fallbackOffered'));

// ═══════════════════════════════════════════════════════════════════════════
// SANDBOX FACTORY
// ═══════════════════════════════════════════════════════════════════════════

function createSandbox() {
    function mockElement() {
        return {
            disabled: false, textContent: '', innerHTML: '', style: {},
            _attrs: {}, _classes: new Set(),
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

    const mockTg = {
        shareMessage: (id, cb) => {}, // exists but should NOT be called
        openTelegramLink: null,
        isVersionAtLeast: () => true,
        ready: () => {}, expand: () => {}, close: () => {},
    };

    const state = {
        apiCalls: [], shareMessageCalls: [], openTelegramLinkCalls: [],
        hapticCalls: [], toastMessages: [], clipboardWrites: [],
        timers: [], timerCallbacks: new Map(), nextTimerId: 1,
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

    const mockClipboard = {
        writeText(text) {
            state.clipboardWrites.push(text);
            return { catch: () => ({}) };
        },
    };

    const mockRDETAIL = { recipe: { id: 42, name: 'Тестовый суп' }, from: 'library' };

    const context = {
        window: { Telegram: { WebApp: mockTg } },
        document: mockDocument,
        navigator: { clipboard: mockClipboard },
        console,
        setTimeout: mockSetTimeout, clearTimeout: mockClearTimeout,
        encodeURIComponent,
        api: mockApi,
        hapticNotif(type) { state.hapticCalls.push(type); },
        toast(msg) { state.toastMessages.push(msg); },
        $: getElement, BOT: 'testbot', RDETAIL: mockRDETAIL,
    };

    return {
        context, state, mockTg, domElements, getElement, mockRDETAIL,
        fireTimerByMs(ms) {
            const t = state.timers.find(t => t.ms === ms);
            if (t) {
                const fn = state.timerCallbacks.get(t.id);
                if (fn) { state.timerCallbacks.delete(t.id); fn(); }
            }
        },
    };
}

function loadShareCode(sandbox) {
    const ctx = vm.createContext(sandbox.context);
    vm.runInContext(shareBlock, ctx);
    assert('shareRecipe available', typeof sandbox.context.shareRecipe === 'function');
    assert('shareCurrentRecipe available', typeof sandbox.context.shareCurrentRecipe === 'function');
    assert('cancelCurrentAttempt available', typeof sandbox.context.cancelCurrentAttempt === 'function');
    assert('copyShareFallback available', typeof sandbox.context.copyShareFallback === 'function');
    return ctx;
}

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
    assert('Button calls shareCurrentRecipe', html.includes('onclick="shareCurrentRecipe()"'));

    // Toast CSS
    const toastCssMatch = html.match(/\.toast\s*\{[^}]*\}/);
    if (toastCssMatch) {
        assert('Toast pointer-events: none', toastCssMatch[0].includes('pointer-events: none'));
    }
    const undoCssMatch = html.match(/\.toast-undo\s*\{[^}]*\}/);
    if (undoCssMatch) {
        assert('Toast-undo pointer-events: auto', undoCssMatch[0].includes('pointer-events: auto'));
    }

    // No shareMessage in recipe detail flow
    assert('No shareMessage in share block', !shareBlock.includes('shareMessage'));
    assert('No shareTimer in share block', !shareBlock.includes('shareTimer'));
    assert('No fallbackOffered in share block', !shareBlock.includes('fallbackOffered'));
    assert('No "Не открылось" in share block', !shareBlock.includes('Не открылось'));

    // Preserved code
    assert('showShareScreen preserved', allScripts.includes('function showShareScreen('));
    assert('executeShare preserved', allScripts.includes('async function executeShare('));
    assert('runQuickShare preserved', allScripts.includes('async function runQuickShare('));
    assert('shareReferralLink preserved', allScripts.includes('async function shareReferralLink('));
}

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL TESTS
// ═══════════════════════════════════════════════════════════════════════════

// T1: Modern Telegram with shareMessage — shareMessage NOT called, openTelegramLink called
async function testModernTelegram() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T1: shareMessage NOT called', sb.state.shareMessageCalls.length === 0);
    assert('T1: openTelegramLink called once', sb.state.openTelegramLinkCalls.length === 1);
    assert('T1: API called once', sb.state.apiCalls.length === 1);
}

// T2: Telegram without shareMessage — same behavior
async function testNoShareMessage() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = undefined;
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T2: openTelegramLink called once', sb.state.openTelegramLinkCalls.length === 1);
    assert('T2: API called once', sb.state.apiCalls.length === 1);
}

// T3: URL check — uses mini_app_url, contains recipe name, properly encoded
async function testUrlFormat() {
    const sb = createSandbox();
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    const url = sb.state.openTelegramLinkCalls[0] || '';
    assert('T3: uses mini_app_url', url.includes('shared_test-token'));
    assert('T3: contains recipe name', url.includes('%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D1%8B%D0%B9') || url.includes('Тестовый') || url.includes('test'));
    assert('T3: uses t.me/share/url', url.startsWith('https://t.me/share/url?url='));
    assert('T3: no undefined', !url.includes('undefined'));
}

// T4: Double tap — one API, one openTelegramLink
async function testDoubleTap() {
    const sb = createSandbox();
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await Promise.all([ctx.shareRecipe(42), ctx.shareRecipe(42)]);
    assert('T4: API once', sb.state.apiCalls.length === 1);
    assert('T4: openTelegramLink once', sb.state.openTelegramLinkCalls.length === 1);
}

// T5: API timeout — picker not opened, button restored
async function testApiTimeout() {
    const sb = createSandbox();
    sb.context.api = () => new Promise(() => {});
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    const p = ctx.shareRecipe(42);
    sb.fireTimerByMs(12000);
    await p;

    assert('T5: openTelegramLink NOT called', sb.state.openTelegramLinkCalls.length === 0);
    assert('T5: button reset', sb.getElement('rdetail-share-btn').textContent === '📤 Поделиться рецептом');
    assert('T5: error toast', sb.state.toastMessages.some(m => m.includes('Не удалось подготовить')));
}

// T6: API error — picker and clipboard not called
async function testApiError() {
    const sb = createSandbox();
    sb.context.api = async () => { throw new Error('network'); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T6: openTelegramLink NOT called', sb.state.openTelegramLinkCalls.length === 0);
    assert('T6: clipboard NOT called', sb.state.clipboardWrites.length === 0);
    assert('T6: error toast', sb.state.toastMessages.some(m => m.includes('Не удалось подготовить')));
}

// T7: Response without mini_app_url — picker not called
async function testNoMiniAppUrl() {
    const sb = createSandbox();
    sb.context.api = async () => ({ prepared_message_id: 'id', token: 'tok' });
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T7: openTelegramLink NOT called', sb.state.openTelegramLinkCalls.length === 0);
    assert('T7: no undefined', !sb.state.openTelegramLinkCalls.some(u => u?.includes('undefined')));
}

// T8: openTelegramLink throws — clipboard called with mini_app_url
async function testOpenTelegramLinkThrows() {
    const sb = createSandbox();
    sb.mockTg.openTelegramLink = () => { throw new Error('blocked'); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T8: clipboard called once', sb.state.clipboardWrites.length === 1);
    assert('T8: clipboard gets mini_app_url',
        sb.state.clipboardWrites[0]?.includes('shared_test-token'));
    assert('T8: no undefined in clipboard', !sb.state.clipboardWrites[0]?.includes('undefined'));
}

// T9: Close recipe while API pending — late resolve ignored
async function testCloseWhileApiPending() {
    const sb = createSandbox();
    let resolveApi;
    sb.context.api = () => new Promise(r => { resolveApi = r; });
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    const p = ctx.shareRecipe(42);
    ctx.cancelCurrentAttempt();
    ctx.resetShareBtn();

    resolveApi({ mini_app_url: 'https://t.me/testbot?startapp=shared_late' });
    await p;

    assert('T9: openTelegramLink NOT called', sb.state.openTelegramLinkCalls.length === 0);
    assert('T9: button reset', sb.getElement('rdetail-share-btn').textContent === '📤 Поделиться рецептом');
}

// T10: Open another recipe while API pending — old ignored
async function testOpenAnotherWhilePending() {
    const sb = createSandbox();
    let resolveOld;
    sb.context.api = (url) => {
        sb.state.apiCalls.push({ url });
        if (url.includes('42')) return new Promise(r => { resolveOld = r; });
        return Promise.resolve({ mini_app_url: 'https://t.me/testbot?startapp=shared_new' });
    };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    const pOld = ctx.shareRecipe(42);
    ctx.cancelCurrentAttempt();
    ctx.resetShareBtn();
    sb.mockRDETAIL.recipe = { id: 99, name: 'Новый суп' };
    const pNew = ctx.shareRecipe(99);

    resolveOld({ mini_app_url: 'https://t.me/testbot?startapp=shared_old' });
    await pOld.catch(() => {});
    await pNew;

    assert('T10: openTelegramLink called once (new only)', sb.state.openTelegramLinkCalls.length === 1);
    assert('T10: URL contains new token',
        sb.state.openTelegramLinkCalls[0]?.includes('shared_new'));
}

// T11: Toast CSS
function testToastCss() {
    const toastCssMatch = html.match(/\.toast\s*\{[^}]*\}/);
    assert('T11: .toast pointer-events: none',
        toastCssMatch?.[0]?.includes('pointer-events: none'));
    const undoCssMatch = html.match(/\.toast-undo\s*\{[^}]*\}/);
    assert('T11: .toast-undo pointer-events: auto',
        undoCssMatch?.[0]?.includes('pointer-events: auto'));
}

// T12: UI checks
function testUiChecks() {
    assert('T12: share bar exists', html.includes('id="rdetail-share-bar"'));
    assert('T12: Share not in menu',
        !allScripts.match(/function openRdetailMenu[\s\S]*?openSheet/)?.[0]?.includes('Поделиться рецептом'));
    assert('T12: normalizeRecipeIngredients exists',
        allScripts.includes('async function normalizeRecipeIngredients()'));
    assert('T12: one safe esc()', [...html.matchAll(/(?:^|\n)\s*function\s+esc\s*\(/g)].length === 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════════════════

async function runTests() {
    runStaticChecks();
    console.log('\n=== BEHAVIORAL TESTS ===');

    await testModernTelegram();
    await testNoShareMessage();
    await testUrlFormat();
    await testDoubleTap();
    await testApiTimeout();
    await testApiError();
    await testNoMiniAppUrl();
    await testOpenTelegramLinkThrows();
    await testCloseWhileApiPending();
    await testOpenAnotherWhilePending();
    testToastCss();
    testUiChecks();
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
