/**
 * POLIANA STABILITY V1 — Share Tests
 *
 * Executes the REAL share implementation extracted from index.html
 * inside a Node.js vm sandbox with mock dependencies.
 *
 * Deterministic sequential async runner — no parallel IIFEs,
 * no setTimeout-based waits.
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

// Extract all script blocks
const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
const allScripts = scriptMatches.map(m => m[1]).join('\n');

// Extract the real share block: from "let recipeShareInProgress"
// to just before "function showShareScreen"
const shareBlockMatch = allScripts.match(
    /(let recipeShareInProgress[\s\S]*?)(?=function showShareScreen\()/
);
const shareBlock = shareBlockMatch ? shareBlockMatch[1].trim() : '';

// Verify extraction
assert('Share block extracted (not empty)', shareBlock.length > 100,
    `Block length: ${shareBlock.length}`);
assert('Block contains shareRecipe', shareBlock.includes('async function shareRecipe'));
assert('Block contains openShareFallback', shareBlock.includes('function openShareFallback'));
assert('Block contains resetShareBtn', shareBlock.includes('function resetShareBtn'));

// ═══════════════════════════════════════════════════════════════════════════
// SANDBOX FACTORY — creates a fresh vm context per test
// ═══════════════════════════════════════════════════════════════════════════

function createSandbox() {
    // DOM element mock
    function mockElement() {
        return {
            disabled: false,
            textContent: '',
            innerHTML: '',
            style: {},
            _attrs: {},
            _classes: new Set(),
            classList: {
                _s: null, // set by mockElement
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

    // Telegram WebApp mock — configurable per test
    const mockTg = {
        shareMessage: null,
        openTelegramLink: null,
        isVersionAtLeast: () => true,
        ready: () => {},
        expand: () => {},
        close: () => {},
    };

    // Observable state
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

    // Default API mock
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

    // Controlled timers
    function mockSetTimeout(fn, ms) {
        const id = state.nextTimerId++;
        state.timers.push({ id, ms });
        state.timerCallbacks.set(id, fn);
        return id;
    }
    function mockClearTimeout(id) {
        state.timerCallbacks.delete(id);
    }

    // Mock clipboard
    const mockClipboard = {
        writeText(text) {
            state.clipboardWrites.push(text);
            return { catch: () => ({}) };
        },
    };

    // Build the vm context — these names must match what the real code references
    const context = {
        window: { Telegram: { WebApp: mockTg } },
        document: mockDocument,
        navigator: { clipboard: mockClipboard },
        console,
        setTimeout: mockSetTimeout,
        clearTimeout: mockClearTimeout,
        encodeURIComponent,
        // Functions the real code calls
        api: mockApi,
        hapticNotif(type) { state.hapticCalls.push(type); },
        toast(msg) { state.toastMessages.push(msg); },
        // The real code references $() for DOM
        $: getElement,
        // Constant used in fallback URL
        BOT: 'testbot',
    };

    return {
        context, state, mockTg, domElements, getElement,
        fireTimer(id) {
            const fn = state.timerCallbacks.get(id);
            if (fn) { state.timerCallbacks.delete(id); fn(); }
        },
        resetState() {
            state.apiCalls.length = 0;
            state.shareMessageCalls.length = 0;
            state.openTelegramLinkCalls.length = 0;
            state.hapticCalls.length = 0;
            state.toastMessages.length = 0;
            state.clipboardWrites.length = 0;
            state.timers.length = 0;
            state.timerCallbacks.clear();
            state.nextTimerId = 1;
            // Reset button
            const btn = domElements['rdetail-share-btn'];
            if (btn) {
                btn.disabled = false;
                btn.textContent = '📤 Поделиться рецептом';
                delete btn._attrs['aria-busy'];
            }
            // Reset recipeShareInProgress via re-exec
        },
    };
}

// Execute the real share block in a sandbox and return the context functions
function loadShareCode(sandbox) {
    const ctx = vm.createContext(sandbox.context);
    vm.runInContext(shareBlock, ctx);
    // Verify functions are available
    assert('shareRecipe available in vm',
        typeof sandbox.context.shareRecipe === 'function');
    assert('openShareFallback available in vm',
        typeof sandbox.context.openShareFallback === 'function');
    assert('resetShareBtn available in vm',
        typeof sandbox.context.resetShareBtn === 'function');
    return ctx;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATIC CHECKS (HTML/CSS, no vm needed)
// ═══════════════════════════════════════════════════════════════════════════

function runStaticChecks() {
    console.log('=== STATIC CHECKS ===');

    // Syntax
    try {
        new Function(allScripts);
        assert('JS syntax valid', true);
    } catch (e) {
        assert('JS syntax valid', false, e.message);
    }

    // Single esc()
    const escDecls = [...html.matchAll(/(?:^|\n)\s*function\s+esc\s*\(/g)];
    assert('Exactly one function esc()', escDecls.length === 1,
        `Found ${escDecls.length}`);

    // esc() escapes all 5 chars
    const escFn = html.match(/function esc\(s\)\s*\{[\s\S]*?\n\}/);
    if (escFn) {
        const body = escFn[0];
        assert('esc() escapes &', body.includes('&amp;'));
        assert('esc() escapes <', body.includes('&lt;'));
        assert('esc() escapes >', body.includes('&gt;'));
        assert('esc() escapes "', body.includes('&quot;'));
        assert("esc() escapes '", body.includes('&#39;'));
    }

    // normalizeRecipeIngredients
    assert('normalizeRecipeIngredients exists',
        allScripts.includes('async function normalizeRecipeIngredients()'));
    assert('needsQty check in menu',
        allScripts.includes("const needsQty = (r.ingredients || []).some(i => i.qty == null || i.qty === '')"));

    // Menu checks
    const menuFnMatch = allScripts.match(/function openRdetailMenu\(\)\s*\{[\s\S]*?openSheet\(/);
    const menuBody = menuFnMatch ? menuFnMatch[0] : '';
    assert('Share removed from menu', !menuBody.includes('Поделиться рецептом'));
    assert('Edit still in menu', menuBody.includes('Редактировать рецепт'));
    assert('Delete still in menu', menuBody.includes('Удалить'));
    assert('Source still in menu', menuBody.includes('Открыть источник'));
    assert('Normalize in menu', menuBody.includes('Распознать количества'));

    // No debug logs
    assert('No [SHARE] console.log', !allScripts.includes("console.log('[SHARE]"));
    assert('No openShareLink function', !allScripts.includes('function openShareLink('));

    // Share bar HTML
    assert('Share bar HTML exists', html.includes('id="rdetail-share-bar"'));
    assert('Share button exists', html.includes('id="rdetail-share-btn"'));
    assert('Button has aria-label', html.includes('aria-label="Поделиться рецептом"'));

    // Unrelated code preserved
    assert('showShareScreen preserved', allScripts.includes('function showShareScreen('));
    assert('executeShare preserved', allScripts.includes('async function executeShare('));
    assert('runQuickShare preserved', allScripts.includes('async function runQuickShare('));
    assert('shareReferralLink preserved', allScripts.includes('async function shareReferralLink('));
    assert('Nutrition card preserved', allScripts.includes('ПРИМЕРНО НА 1 ПОРЦИЮ'));
    assert('calculateNutrition preserved', allScripts.includes('async function calculateNutrition('));
}

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL TESTS — sequential async runner
// ═══════════════════════════════════════════════════════════════════════════

async function testModernTelegram() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T1: API called once', sb.state.apiCalls.length === 1);
    assert('T1: shareMessage called once', sb.state.shareMessageCalls.length === 1);
    assert('T1: passed prepared_message_id',
        sb.state.shareMessageCalls[0]?.id === 'test-prepared-id-123');
    assert('T1: openTelegramLink NOT called', sb.state.openTelegramLinkCalls.length === 0);
}

async function testCallbackTrue() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    const cb = sb.state.shareMessageCalls[0]?.cb;
    if (cb) cb(true);
    assert('T2: hapticNotif called once', sb.state.hapticCalls.length === 1);
    assert('T2: success haptic', sb.state.hapticCalls[0] === 'success');
    assert('T2: success toast shown',
        sb.state.toastMessages.some(m => m.includes('Рецепт отправлен')));
    assert('T2: button unlocked',
        !sb.getElement('rdetail-share-btn').disabled);
    assert('T2: fallback NOT called', sb.state.openTelegramLinkCalls.length === 0);
}

async function testCallbackFalse() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    const cb = sb.state.shareMessageCalls[0]?.cb;
    const toastsBefore = sb.state.toastMessages.length;
    if (cb) cb(false);
    assert('T3: no success toast',
        !sb.state.toastMessages.slice(toastsBefore).some(m => m.includes('Рецепт отправлен')));
    assert('T3: fallback NOT called', sb.state.openTelegramLinkCalls.length === 0);
    assert('T3: button unlocked',
        !sb.getElement('rdetail-share-btn').disabled);
}

async function testSafetyTimeout() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T4: button locked during wait',
        sb.getElement('rdetail-share-btn').disabled);

    // Fire the safety timeout
    const timer = sb.state.timers.find(t => t.ms === 60000);
    if (timer) sb.fireTimer(timer.id);

    assert('T4: button unlocked after timeout',
        !sb.getElement('rdetail-share-btn').disabled);
    assert('T4: openTelegramLink NOT called', sb.state.openTelegramLinkCalls.length === 0);
    assert('T4: no second picker', sb.state.shareMessageCalls.length === 1);
}

async function testShareMessageThrows() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = () => { throw new Error('not supported'); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T5: one fallback call', sb.state.openTelegramLinkCalls.length === 1);
    assert('T5: fallback uses mini_app_url',
        sb.state.openTelegramLinkCalls[0]?.includes('shared_test-token-abc'));
    assert('T5: button unlocked',
        !sb.getElement('rdetail-share-btn').disabled);
}

async function testPreparedIdNull() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    sb.context.api = async (url) => {
        sb.state.apiCalls.push({ url });
        return {
            prepared_message_id: null,
            token: 'test-token',
            mini_app_url: 'https://t.me/testbot?startapp=shared_test-token',
        };
    };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T6: shareMessage NOT called', sb.state.shareMessageCalls.length === 0);
    assert('T6: one fallback call', sb.state.openTelegramLinkCalls.length === 1);
    assert('T6: fallback uses mini_app_url',
        sb.state.openTelegramLinkCalls[0]?.includes('shared_test-token'));
}

async function testOldTelegram() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = undefined;
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T7: API called (fresh share)', sb.state.apiCalls.length === 1);
    assert('T7: shareMessage NOT called', sb.state.shareMessageCalls.length === 0);
    assert('T7: fallback uses mini_app_url',
        sb.state.openTelegramLinkCalls[0]?.includes('shared_test-token-abc'));
    assert('T7: no recipe_id in URL',
        !sb.state.openTelegramLinkCalls[0]?.includes('shared_42'));
}

async function testApiError() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    sb.context.api = async () => { throw new Error('network error'); };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T8: shareMessage NOT called', sb.state.shareMessageCalls.length === 0);
    assert('T8: openTelegramLink NOT called', sb.state.openTelegramLinkCalls.length === 0);
    assert('T8: error toast shown',
        sb.state.toastMessages.some(m => m.includes('Не удалось подготовить')));
    assert('T8: button unlocked',
        !sb.getElement('rdetail-share-btn').disabled);
    assert('T8: no undefined in URLs',
        !sb.state.openTelegramLinkCalls.some(u => u?.includes('undefined')));
}

async function testDoubleTap() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    const ctx = loadShareCode(sb);

    await Promise.all([ctx.shareRecipe(42), ctx.shareRecipe(42)]);
    assert('T9: API called once', sb.state.apiCalls.length === 1);
    assert('T9: picker opened once', sb.state.shareMessageCalls.length === 1);
}

async function testLateCallback() {
    const sb = createSandbox();
    let lateCallback;
    sb.mockTg.shareMessage = (id, cb) => { lateCallback = cb; };
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    const toastsBefore = sb.state.toastMessages.length;

    // Fire safety timeout
    const timer = sb.state.timers.find(t => t.ms === 60000);
    if (timer) sb.fireTimer(timer.id);

    // Late callback with success=true — must be ignored
    if (lateCallback) lateCallback(true);

    assert('T10: late callback ignored — no success toast',
        !sb.state.toastMessages.slice(toastsBefore).some(m => m.includes('Рецепт отправлен')));
    assert('T10: no extra haptic',
        sb.state.hapticCalls.filter(c => c === 'success').length === 0);
    assert('T10: button stays unlocked',
        !sb.getElement('rdetail-share-btn').disabled);
}

async function testClipboardFallback() {
    const sb = createSandbox();
    sb.mockTg.shareMessage = undefined;
    sb.mockTg.openTelegramLink = undefined;
    const ctx = loadShareCode(sb);

    await ctx.shareRecipe(42);
    assert('T11: clipboard called', sb.state.clipboardWrites.length === 1);
    assert('T11: clipboard gets mini_app_url',
        sb.state.clipboardWrites[0]?.includes('shared_test-token-abc'));
    assert('T11: no recipe_id in clipboard',
        !sb.state.clipboardWrites[0]?.includes('42'));
    assert('T11: no undefined in clipboard',
        !sb.state.clipboardWrites[0]?.includes('undefined'));
}

function testUiVisibility() {
    console.log('\n=== UI VISIBILITY ===');
    assert('T12: bar hidden during loading',
        allScripts.includes("bar.classList.remove('visible')") &&
        allScripts.includes("$('rdetail-share-bar')"));
    assert('T12: bar shown after render',
        allScripts.includes("bar.classList.add('visible')"));
    assert('T12: bar hidden on close',
        allScripts.includes('closeRdetail') &&
        allScripts.includes("bar.classList.remove('visible')"));
    assert('T12: Share not in menu',
        !allScripts.match(/function openRdetailMenu[\s\S]*?openSheet/)?.[0]
            ?.includes('Поделиться рецептом'));
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER — sequential, deterministic
// ═══════════════════════════════════════════════════════════════════════════

async function runTests() {
    runStaticChecks();

    console.log('\n=== BEHAVIORAL TESTS ===');

    await testModernTelegram();
    await testCallbackTrue();
    await testCallbackFalse();
    await testSafetyTimeout();
    await testShareMessageThrows();
    await testPreparedIdNull();
    await testOldTelegram();
    await testApiError();
    await testDoubleTap();
    await testLateCallback();
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
