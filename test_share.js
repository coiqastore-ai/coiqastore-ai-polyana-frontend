/**
 * POLIANA STABILITY V1 — Share Tests (silent failure fix)
 *
 * Executes the REAL share implementation extracted from index.html
 * inside a Node.js vm sandbox with mock dependencies.
 *
 * Deterministic sequential async runner.
 *
 * Run: node test_share.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

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
// EXTRACT REAL SHARE CODE FROM INDEX.HTML
// ═══════════════════════════════════════════════════════════════════════════

const htmlPath = path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
const allScripts = scriptMatches.map(m => m[1]).join('\n');

// Extract from first "let recipeShareInProgress" to just before "function showShareScreen"
const shareBlockMatch = allScripts.match(
    /(let recipeShareInProgress = false[\s\S]*?)(?=function showShareScreen\()/
);
const shareBlock = shareBlockMatch ? shareBlockMatch[1].trim() : '';

assert('Share block extracted (not empty)', shareBlock.length > 100,
    `Block length: ${shareBlock.length}`);
assert('Block contains shareRecipe', shareBlock.includes('async function shareRecipe'));
assert('Block contains openShareFallback', shareBlock.includes('function openShareFallback'));
assert('Block contains resetShareBtn', shareBlock.includes('function resetShareBtn'));
assert('Block contains shareCurrentRecipe', shareBlock.includes('function shareCurrentRecipe'));
assert('Block contains clearShareAttempt', shareBlock.includes('function clearShareAttempt'));
assert('Block contains recipeShareAttempt', shareBlock.includes('recipeShareAttempt'));

// ═══════════════════════════════════════════════════════════════════════════
// SANDBOX FACTORY
// ═══════════════════════════════════════════════════════════════════════════

function createSandbox() {
    function mockElement() {
        return {
            disabled: false,
            textContent: '',
            innerHTML: '',
            style: {},
            _attrs: {},
            _classes: new Set(),
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
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener: () => {},
        documentElement: { style: { getPropertyValue: () => '' } },
    };

    const mockTg = {
        shareMessage: null,
        openTelegramLink: null,
        isVersionAtLeast: () => true,
        ready: () => {},
        expand: () => {},
        close: () => {},
    };

    const state = {
        apiCalls: [],
        shareMessageCalls: [],
        openTelegramLinkCalls: [],
        hapticCalls: [],
        toastMessages: [],
        clipboardWrites: [],
        timers: [],
        timerCallbacks: new Map(),
        nextTimerId: 1,
    };

    async function mockApi(url, method, body) {
        state.apiCalls.push({ url, method, body });
        if (url.includes('/prepare-share')) {
            return {
                prepared_message_id: 'test-prepared-id-123',
                token: 'test-token-abc',
                mini_app_url: 'https://t.me/testbot?startapp=shared_test-token-abc',
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
    function mockClearTimeout(id) {
        state.timerCallbacks.delete(id);
    }

    const mockClipboard = {
        writeText(text) {
            state.clipboardWrites.push(text);
            return { catch: () => ({}) };
        },
    };

    // RDETAIL mock — needed by shareCurrentRecipe
    const mockRDETAIL = { recipe: { id: 42 }, from: 'library' };

    const context = {
        window: { Telegram: { WebApp: mockTg } },
        document: mockDocument,
        navigator: { clipboard: mockClipboard },
        console,
        setTimeout: mockSetTimeout,
        clearTimeout: mockClearTimeout,
        encodeURIComponent,
        api: mockApi,
        hapticNotif(type) { state.hapticCalls.push(type); },
        toast(msg) { state.toastMessages.push(msg); },
        $: getElement,
        BOT: 'testbot',
        RDETAIL: mockRDETAIL,
    };

    return {
        context, state, mockTg, domElements, getElement, mockRDETAIL,
        fireTimer(id) {
            const fn = state.timerCallbacks.get(id);
            if (fn) { state.timerCallbacks.delete(id); fn(); }
        },
        fireTimerByMs(ms) {
            const t = state.timers.find(t => t.ms === ms);
            if (t) this.fireTimer(t.id);
        },
    };
}

function loadShareCode(sandbox) {
    const ctx = vm.createContext(sandbox.context);
    vm.runInContext(shareBlock, ctx);
    assert('shareRecipe available in vm',
        typeof sandbox.context.shareRecipe === 'function');
    assert('openShareFallback available in vm',
        typeof sandbox.context.openShareFallback === 'function');
    assert('resetShareBtn available in vm',
        typeof sandbox.context.resetShareBtn === 'function');
    assert('shareCurrentRecipe available in vm',
        typeof sandbox.context.shareCurrentRecipe === 'function');
    assert('clearShareAttempt available in vm',
        typeof sandbox.context.clearShareAttempt === 'function');
    return ctx;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATIC CHECKS
// ═══════════════════════════════════════════════════════════════════════════

function runStaticChecks() {
    console.log('=== STATIC CHECKS ===');

    try {
        new Function(allScripts);
        assert('JS syntax valid', true);
    } catch (e) {
        assert('JS syntax valid', false, e.message);
    }

    const escDecls = [...html.matchAll(/(?:^|\n)\s*function\s+esc\s*\(/g)];
    assert('Exactly one function esc()', escDecls.length === 1,
        `Found ${escDecls.length}`);

    const escFn = html.match(/function esc\(s\)\s*\{[\s\S]*?\n\}/);
    if (escFn) {
        const body = escFn[0];
        assert('esc() escapes &', body.includes('&amp;'));
        assert('esc() escapes <', body.includes('&lt;'));
        assert('esc() escapes >', body.includes('&gt;'));
        assert('esc() escapes "', body.includes('&quot;'));
        assert("esc() escapes '", body.includes('&#39;'));
    }

    assert('normalizeRecipeIngredients exists',
        allScripts.includes('async function normalizeRecipeIngredients()'));
    assert('needsQty check in menu',
        allScripts.includes("const needsQty = (r.ingredients || []).some(i => i.qty == null || i.qty === '')"));

    const menuFnMatch = allScripts.match(/function openRdetailMenu\(\)\s*\{[\s\S]*?openSheet\(/);
    const menuBody = menuFnMatch ? menuFnMatch[0] : '';
    assert('Share removed from menu', !menuBody.includes('Поделиться рецептом'));
    assert('Edit still in menu', menuBody.includes('Редактировать рецепт'));
    assert('Delete still in menu', menuBody.includes('Удалить'));
    assert('Source still in menu', menuBody.includes('Открыть источник'));
    assert('Normalize in menu', menuBody.includes('Распознать количества'));

    assert('No [SHARE] console.log', !allScripts.includes("console.log('[SHARE]"));
    assert('No openShareLink function', !allScripts.includes('function openShareLink('));

    assert('Share bar HTML exists', html.includes('id="rdetail-share-bar"'));
    assert('Share button exists', html.includes('id="rdetail-share-btn"'));
    assert('Button calls shareCurrentRecipe', html.includes('onclick="shareCurrentRecipe()"'));
    assert('Button has aria-label', html.includes('aria-label="Поделиться рецептом"'));

    assert('showShareScreen preserved', allScripts.includes('function showShareScreen('));
    assert('executeShare preserved', allScripts.includes('async function executeShare('));
    assert('runQuickShare preserved', allScripts.includes('async function runQuickShare('));
    assert('shareReferralLink preserved', allScripts.includes('async function shareReferralLink('));
    assert('Nutrition card preserved', allScripts.includes('ПРИМЕРНО НА 1 ПОРЦИЮ'));
    assert('calculateNutrition preserved', allScripts.includes('async function calculateNutrition('));

    // No auto-fallback by 3s timer, no recipe_id fallback, no undefined
    assert('No auto-fallback by timer opens t.me/share',
        !shareBlock.match(/setTimeout[\s\S]{0,300}openShareFallback/)?.[0]?.match(/3000[\s\S]{0,200}openShareFallback/));
    assert('No recipe_id in fallback URLs',
        !shareBlock.includes('shared_${recipeId}') && !shareBlock.includes('shared_${data.token}'));
    assert('No undefined in URL construction',
        !shareBlock.match(/t\.me\/share\/url[^}]{0,100}undefined/));
}

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL TESTS
// ═══════════════════════════════════════════════════════════════════════════

// T1: API never resolves — 12s timeout fires, button resets
async function testApiNeverResolves() {
    const sb = createSandbox();
    sb.context.api = () => new Promise(() => {}); // never resolves
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    const ctx = loadShareCode(sb);

    const p = ctx.shareRecipe(42);
    // Fire the 12s API timeout
    sb.fireTimerByMs(12000);
    await p;

    assert('T1: shareMessage NOT called', sb.state.shareMessageCalls.length === 0);
    assert('T1: openTelegramLink NOT called', sb.state.openTelegramLinkCalls.length === 0);
    assert('T1: button unlocked', !sb.getElement('rdetail-share-btn').disabled);
    assert('T1: button text reset',
        sb.getElement('rdetail-share-btn').textContent === '📤 Поделиться рецептом');
    assert('T1: error toast shown',
        sb.state.toastMessages.some(m => m.includes('Не удалось подготовить')));
}

// T2: Silent shareMessage — callback never comes, 3s timeout offers fallback
async function testSilentShareMessage() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); /* no cb call */ };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T2: shareMessage called once', sb.state.shareMessageCalls.length === 1);

    // Fire 3s timeout
    sb.fireTimerByMs(3000);

    assert('T2: button enabled', !sb.getElement('rdetail-share-btn').disabled);
    assert('T2: button offers fallback',
        sb.getElement('rdetail-share-btn').textContent.includes('Отправить ссылкой'));
    assert('T2: openTelegramLink NOT auto-called', sb.state.openTelegramLinkCalls.length === 0);
    assert('T2: hint toast shown',
        sb.state.toastMessages.some(m => m.includes('отправьте ссылкой')));
}

// T3: Second click after silent failure — opens fallback, no new API call
async function testSecondClickAfterSilent() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    sb.fireTimerByMs(3000); // offer fallback

    const apiCallsBefore = sb.state.apiCalls.length;
    const smCallsBefore = sb.state.shareMessageCalls.length;

    // Second click via shareCurrentRecipe
    ctx.shareCurrentRecipe();

    assert('T3: API still called once', sb.state.apiCalls.length === apiCallsBefore);
    assert('T3: shareMessage still called once', sb.state.shareMessageCalls.length === smCallsBefore);
    assert('T3: openTelegramLink called once', sb.state.openTelegramLinkCalls.length === 1);
    assert('T3: fallback uses mini_app_url',
        sb.state.openTelegramLinkCalls[0]?.includes('shared_test-token-abc'));
    assert('T3: button reset after fallback',
        sb.getElement('rdetail-share-btn').textContent === '📤 Поделиться рецептом');
}

// T4: Late callback after manual fallback — ignored
async function testLateCallbackAfterFallback() {
    const sb = createSandbox();
    let lateCb;
    sb.mockTg.shareMessage = (id, cb) => { lateCb = cb; };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    sb.fireTimerByMs(3000); // offer fallback
    ctx.shareCurrentRecipe(); // user clicks fallback

    const toastsBefore = sb.state.toastMessages.length;
    if (lateCb) lateCb(true); // late success callback

    assert('T4: no success toast',
        !sb.state.toastMessages.slice(toastsBefore).some(m => m.includes('Рецепт отправлен')));
    assert('T4: no extra haptic',
        sb.state.hapticCalls.filter(c => c === 'success').length === 0);
    assert('T4: no second fallback',
        sb.state.openTelegramLinkCalls.length === 1);
}

// T5: callback(true) before 3s — success, no fallback offered
async function testCallbackTrueBeforeTimeout() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    const cb = sb.state.shareMessageCalls[0]?.cb;
    if (cb) cb(true);

    assert('T5: success haptic', sb.state.hapticCalls.includes('success'));
    assert('T5: success toast',
        sb.state.toastMessages.some(m => m.includes('Рецепт отправлен')));
    assert('T5: button reset',
        sb.getElement('rdetail-share-btn').textContent === '📤 Поделиться рецептом');
    assert('T5: no fallback text',
        !sb.getElement('rdetail-share-btn').textContent.includes('Отправить ссылкой'));
}

// T6: callback(false) — offers manual fallback, no auto-open
async function testCallbackFalse() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    const cb = sb.state.shareMessageCalls[0]?.cb;
    if (cb) cb(false);

    assert('T6: no auto-fallback', sb.state.openTelegramLinkCalls.length === 0);
    assert('T6: button offers fallback',
        sb.getElement('rdetail-share-btn').textContent.includes('Отправить ссылкой'));
    assert('T6: button enabled', !sb.getElement('rdetail-share-btn').disabled);
}

// T7: shareMessage throws — immediate fallback
async function testShareMessageThrows() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = () => { throw new Error('not supported'); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T7: one fallback call', sb.state.openTelegramLinkCalls.length === 1);
    assert('T7: fallback uses mini_app_url',
        sb.state.openTelegramLinkCalls[0]?.includes('shared_test-token-abc'));
    assert('T7: button reset',
        sb.getElement('rdetail-share-btn').textContent === '📤 Поделиться рецептом');
}

// T8: prepared_message_id = null — immediate fallback
async function testPreparedIdNull() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    sb.context.api = async (url) => {
        sb.state.apiCalls.push({ url });
        return { prepared_message_id: null, token: 'tok', mini_app_url: 'https://t.me/testbot?startapp=shared_tok' };
    };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T8: shareMessage NOT called', sb.state.shareMessageCalls.length === 0);
    assert('T8: one fallback call', sb.state.openTelegramLinkCalls.length === 1);
    assert('T8: fallback uses mini_app_url',
        sb.state.openTelegramLinkCalls[0]?.includes('shared_tok'));
}

// T9: Old Telegram — immediate fallback after fresh prepare-share
async function testOldTelegram() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = undefined;
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T9: API called', sb.state.apiCalls.length === 1);
    assert('T9: one fallback call', sb.state.openTelegramLinkCalls.length === 1);
    assert('T9: fallback uses mini_app_url',
        sb.state.openTelegramLinkCalls[0]?.includes('shared_test-token-abc'));
}

// T10: Double first tap — one API call, one shareMessage
async function testDoubleTap() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    const ctx = loadShareCode(sb);

    await Promise.all([ctx.shareRecipe(42), ctx.shareRecipe(42)]);
    assert('T10: API called once', sb.state.apiCalls.length === 1);
    assert('T10: picker opened once', sb.state.shareMessageCalls.length === 1);
}

// T11: Close recipe during wait — state cleaned, late callback ignored
async function testCloseRecipeDuringWait() {
    const sb = createSandbox();
    let lateCb;
    sb.mockTg.shareMessage = (id, cb) => { lateCb = cb; };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    // Simulate closeRdetail — clearShareAttempt + resetShareBtn
    ctx.clearShareAttempt();
    ctx.resetShareBtn();

    const toastsBefore = sb.state.toastMessages.length;
    if (lateCb) lateCb(true);

    assert('T11: no success toast after close',
        !sb.state.toastMessages.slice(toastsBefore).some(m => m.includes('Рецепт отправлен')));
    assert('T11: no extra haptic',
        sb.state.hapticCalls.filter(c => c === 'success').length === 0);
}

// T12: Open another recipe — old attempt cleared, new prepare-share
async function testOpenAnotherRecipe() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    // Simulate opening another recipe — clearShareAttempt + resetShareBtn
    ctx.clearShareAttempt();
    ctx.resetShareBtn();

    // New share for different recipe
    sb.mockRDETAIL.recipe = { id: 99 };
    await ctx.shareRecipe(99);

    assert('T12: two API calls total', sb.state.apiCalls.length === 2);
    assert('T12: second call for recipe 99',
        sb.state.apiCalls[1]?.url?.includes('99'));
}

// T13: API error — normal state restored, no undefined URL
async function testApiError() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    sb.context.api = async () => { throw new Error('network'); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T13: shareMessage NOT called', sb.state.shareMessageCalls.length === 0);
    assert('T13: openTelegramLink NOT called', sb.state.openTelegramLinkCalls.length === 0);
    assert('T13: error toast',
        sb.state.toastMessages.some(m => m.includes('Не удалось подготовить')));
    assert('T13: button reset',
        sb.getElement('rdetail-share-btn').textContent === '📤 Поделиться рецептом');
    assert('T13: no undefined in URLs',
        !sb.state.openTelegramLinkCalls.some(u => u?.includes('undefined')));
}

// T14: Clipboard fallback — gets mini_app_url only
async function testClipboardFallback() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = undefined;
    sb.mockTg.openTelegramLink = undefined;
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T14: clipboard called', sb.state.clipboardWrites.length === 1);
    assert('T14: clipboard gets mini_app_url',
        sb.state.clipboardWrites[0]?.includes('shared_test-token-abc'));
    assert('T14: no undefined in clipboard',
        !sb.state.clipboardWrites[0]?.includes('undefined'));
}

// T15: UI visibility
function testUiVisibility() {
    console.log('\n=== UI VISIBILITY ===');
    assert('T15: bar hidden during loading',
        allScripts.includes("bar.classList.remove('visible')") &&
        allScripts.includes("$('rdetail-share-bar')"));
    assert('T15: bar shown after render',
        allScripts.includes("bar.classList.add('visible')"));
    assert('T15: bar hidden on close',
        allScripts.includes('closeRdetail') &&
        allScripts.includes("bar.classList.remove('visible')"));
    assert('T15: Share not in menu',
        !allScripts.match(/function openRdetailMenu[\s\S]*?openSheet/)?.[0]
            ?.includes('Поделиться рецептом'));
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════════════════

async function runTests() {
    runStaticChecks();

    console.log('\n=== BEHAVIORAL TESTS ===');

    await testApiNeverResolves();
    await testSilentShareMessage();
    await testSecondClickAfterSilent();
    await testLateCallbackAfterFallback();
    await testCallbackTrueBeforeTimeout();
    await testCallbackFalse();
    await testShareMessageThrows();
    await testPreparedIdNull();
    await testOldTelegram();
    await testDoubleTap();
    await testCloseRecipeDuringWait();
    await testOpenAnotherRecipe();
    await testApiError();
    await testClipboardFallback();
    testUiVisibility();
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
