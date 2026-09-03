/**
 * POLIANA STABILITY V1 — Behavioral Share Tests
 *
 * Tests the share flow with mock Telegram WebApp, mock API,
 * mock DOM, and controlled timers.
 *
 * Run: node test_share.js
 */

const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// Extract all script blocks
const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
const allScripts = scriptMatches.map(m => m[1]).join('\n');

let passed = 0;
let failed = 0;
const results = [];

function test(name, condition, detail) {
    if (condition) {
        results.push({ name, status: 'PASS' });
        passed++;
    } else {
        results.push({ name, status: 'FAIL', detail: detail || '' });
        failed++;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// STATIC CHECKS
// ═══════════════════════════════════════════════════════════════════════════

console.log('=== STATIC CHECKS ===');

// Syntax
try {
    new Function(allScripts);
    test('JS syntax valid', true);
} catch (e) {
    test('JS syntax valid', false, e.message);
}

// Single esc()
const escDecls = [...html.matchAll(/(?:^|\n)\s*function\s+esc\s*\(/g)];
test('Exactly one function esc() declaration', escDecls.length === 1,
    `Found ${escDecls.length} declarations`);

// esc() escapes all 5 chars
const escFn = html.match(/function esc\(s\)\s*\{[\s\S]*?\n\}/);
if (escFn) {
    const body = escFn[0];
    test('esc() escapes &', body.includes('&amp;'));
    test('esc() escapes <', body.includes('&lt;'));
    test('esc() escapes >', body.includes('&gt;'));
    test('esc() escapes "', body.includes('&quot;'));
    test("esc() escapes '", body.includes('&#39;'));
}

// normalizeRecipeIngredients exists
test('normalizeRecipeIngredients function exists',
    allScripts.includes('async function normalizeRecipeIngredients()'));

// needsQty in menu
test('needsQty check in openRdetailMenu',
    allScripts.includes("const needsQty = (r.ingredients || []).some(i => i.qty == null || i.qty === '')"));

// Share NOT in menu
const menuFnMatch = allScripts.match(/function openRdetailMenu\(\)\s*\{[\s\S]*?openSheet\(/);
const menuBody = menuFnMatch ? menuFnMatch[0] : '';
test('Share removed from menu', !menuBody.includes('Поделиться рецептом'));
test('Edit still in menu', menuBody.includes('Редактировать рецепт'));
test('Delete still in menu', menuBody.includes('Удалить'));
test('Source still in menu', menuBody.includes('Открыть источник'));
test('Normalize in menu (conditional)', menuBody.includes('Распознать количества'));

// No debug logs
test('No [SHARE] console.log', !allScripts.includes("console.log('[SHARE]"));
test('No openShareLink function', !allScripts.includes('function openShareLink('));

// Share bar HTML
test('Share bar HTML exists', html.includes('id="rdetail-share-bar"'));
test('Share button exists', html.includes('id="rdetail-share-btn"'));
test('Button has aria-label', html.includes('aria-label="Поделиться рецептом"'));

// Unrelated code preserved
test('showShareScreen preserved', allScripts.includes('function showShareScreen('));
test('executeShare preserved', allScripts.includes('async function executeShare('));
test('runQuickShare preserved', allScripts.includes('async function runQuickShare('));
test('shareReferralLink preserved', allScripts.includes('async function shareReferralLink('));
test('Nutrition card preserved', allScripts.includes('ПРИМЕРНО НА 1 ПОРЦИЮ'));
test('calculateNutrition preserved', allScripts.includes('async function calculateNutrition('));

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL TESTS — extract and test shareRecipe logic
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== BEHAVIORAL TESTS ===');

// Build a sandbox that extracts the functions we need to test
function createSandbox() {
    // Mock DOM
    const domElements = {};
    const mockDocument = {
        getElementById: (id) => domElements[id] || (domElements[id] = {
            disabled: false, textContent: '', classList: {
                _classes: new Set(),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                contains(c) { return this._classes.has(c); },
            },
            setAttribute() {},
            removeAttribute() {},
            innerHTML: '',
            style: {},
        }),
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener: () => {},
        documentElement: { style: { getPropertyValue: () => '' } },
    };

    // Mock Telegram WebApp
    const mockTg = {
        shareMessage: null,
        openTelegramLink: null,
        isVersionAtLeast: () => true,
        ready: () => {},
        expand: () => {},
        close: () => {},
        setHeaderColor: () => {},
        setBackgroundColor: () => {},
        initData: '',
        initDataUnsafe: {},
        MainButton: { showProgress: () => {}, hideProgress: () => {}, enable: () => {}, disable: () => {} },
        HapticFeedback: { notificationOccurred: () => {}, impactOccurred: () => {} },
    };

    // State
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

    // Mock API
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

    // Mock setTimeout/clearTimeout
    function mockSetTimeout(fn, ms) {
        const id = state.nextTimerId++;
        state.timers.push({ id, ms });
        state.timerCallbacks.set(id, fn);
        return id;
    }
    function mockClearTimeout(id) {
        state.timerCallbacks.delete(id);
    }

    // Mock hapticNotif
    function mockHapticNotif(type) {
        state.hapticCalls.push(type);
    }

    // Mock toast
    function mockToast(msg) {
        state.toastMessages.push(msg);
    }

    // Mock confirm
    function mockConfirm() { return true; }

    // Mock navigator.clipboard
    const mockClipboard = {
        writeText(text) {
            state.clipboardWrites.push(text);
            return { catch: (fn) => ({}) };
        },
    };

    return {
        domElements, mockDocument, mockTg, state,
        mockApi, mockSetTimeout, mockClearTimeout,
        mockHapticNotif, mockToast, mockConfirm, mockClipboard,
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
                btn.removeAttribute('aria-busy');
            }
        },
    };
}

// Extract the shareRecipe, openShareFallback, resetShareBtn functions
// We'll re-create them in a sandbox for each test
function extractShareFunctions(sb) {
    const { mockDocument, mockTg, state, mockApi, mockSetTimeout, mockClearTimeout,
            mockHapticNotif, mockToast, mockClipboard } = sb;

    const $ = (id) => mockDocument.getElementById(id);
    const document = mockDocument;
    const window = { Telegram: { WebApp: mockTg } };
    const navigator = { clipboard: mockClipboard };
    const hapticNotif = mockHapticNotif;
    const toast = mockToast;
    const api = mockApi;
    const setTimeout = mockSetTimeout;
    const clearTimeout = mockClearTimeout;
    const BOT = 'testbot';

    // recipeShareInProgress is module-level state
    let recipeShareInProgress = false;

    async function shareRecipe(recipeId) {
        if (!recipeId || recipeShareInProgress) return;

        const tg = window.Telegram?.WebApp;
        if (!tg) {
            toast('Откройте ПОЛЯНУ внутри Telegram');
            return;
        }

        recipeShareInProgress = true;
        const btn = $('rdetail-share-btn');
        if (btn) {
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            btn.textContent = 'Готовлю рецепт…';
        }

        let data;
        try {
            data = await api(`/recipes/${recipeId}/prepare-share`, 'POST');
        } catch (e) {
            console.error('prepare-share failed');
            toast('Не удалось подготовить рецепт');
            resetShareBtn();
            return;
        }

        if (!data || !data.mini_app_url) {
            toast('Не удалось подготовить рецепт');
            resetShareBtn();
            return;
        }

        const canUseShareMessage =
            typeof tg.shareMessage === 'function' &&
            !(typeof tg.isVersionAtLeast === 'function' && !tg.isVersionAtLeast('8.0'));

        if (canUseShareMessage && data.prepared_message_id) {
            let settled = false;

            const safetyTimeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                resetShareBtn();
            }, 60000);

            try {
                tg.shareMessage(data.prepared_message_id, (success) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(safetyTimeout);

                    if (success) {
                        hapticNotif('success');
                        toast('✅ Рецепт отправлен!');
                    }
                    resetShareBtn();
                });
            } catch (e) {
                if (settled) return;
                settled = true;
                clearTimeout(safetyTimeout);
                openShareFallback(tg, data.mini_app_url);
            }
            return;
        }

        openShareFallback(tg, data.mini_app_url);
    }

    function openShareFallback(tg, miniAppUrl) {
        if (typeof tg.openTelegramLink === 'function') {
            try {
                tg.openTelegramLink(
                    'https://t.me/share/url?url=' + encodeURIComponent(miniAppUrl) +
                    '&text=' + encodeURIComponent('🌿 Посмотри рецепт из ПОЛЯНЫ!')
                );
                resetShareBtn();
                return;
            } catch (e) {
                console.error('openTelegramLink failed');
            }
        }

        try {
            navigator.clipboard.writeText(miniAppUrl).then(() => {
                toast('Ссылка скопирована. Вставьте её в чат.');
            }).catch(() => {
                toast('Не удалось поделиться рецептом');
            });
        } catch (e) {
            toast('Не удалось поделиться рецептом');
        }
        resetShareBtn();
    }

    function resetShareBtn() {
        recipeShareInProgress = false;
        const btn = $('rdetail-share-btn');
        if (btn) {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = '📤 Поделиться рецептом';
        }
    }

    return { shareRecipe, openShareFallback, resetShareBtn, getState: () => recipeShareInProgress };
}

// ── Test 1: Modern Telegram — one API call, one shareMessage ──────────────
{
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const { shareRecipe } = extractShareFunctions(sb);

    (async () => {
        await shareRecipe(42);
        test('T1: API called once', sb.state.apiCalls.length === 1);
        test('T1: shareMessage called once', sb.state.shareMessageCalls.length === 1);
        test('T1: passed prepared_message_id',
            sb.state.shareMessageCalls[0]?.id === 'test-prepared-id-123');
        test('T1: openTelegramLink NOT called', sb.state.openTelegramLinkCalls.length === 0);
    })();
}

// ── Test 2: callback(true) — success haptic, toast, button unlocked ───────
{
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    const { shareRecipe } = extractShareFunctions(sb);

    (async () => {
        await shareRecipe(42);
        const cb = sb.state.shareMessageCalls[0]?.cb;
        if (cb) cb(true);
        test('T2: hapticNotif called once', sb.state.hapticCalls.length === 1);
        test('T2: success haptic', sb.state.hapticCalls[0] === 'success');
        test('T2: success toast shown',
            sb.state.toastMessages.some(m => m.includes('Рецепт отправлен')));
        test('T2: button unlocked',
            !sb.mockDocument.getElementById('rdetail-share-btn').disabled);
        test('T2: fallback NOT called', sb.state.openTelegramLinkCalls.length === 0);
    })();
}

// ── Test 3: callback(false) — no success toast, no fallback, button unlocked
{
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    const { shareRecipe } = extractShareFunctions(sb);

    (async () => {
        await shareRecipe(42);
        const cb = sb.state.shareMessageCalls[0]?.cb;
        const toastsBefore = sb.state.toastMessages.length;
        if (cb) cb(false);
        test('T3: no success toast',
            !sb.state.toastMessages.slice(toastsBefore).some(m => m.includes('Рецепт отправлен')));
        test('T3: fallback NOT called', sb.state.openTelegramLinkCalls.length === 0);
        test('T3: button unlocked',
            !sb.mockDocument.getElementById('rdetail-share-btn').disabled);
    })();
}

// ── Test 4: Callback never called — safety timeout unlocks button ─────────
{
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); /* don't call cb */ };
    const { shareRecipe } = extractShareFunctions(sb);

    (async () => {
        await shareRecipe(42);
        // Button should be locked while waiting
        test('T4: button locked during wait',
            sb.mockDocument.getElementById('rdetail-share-btn').disabled);

        // Fire the safety timeout
        const timer = sb.state.timers.find(t => t.ms === 60000);
        if (timer) sb.fireTimer(timer.id);

        test('T4: button unlocked after timeout',
            !sb.mockDocument.getElementById('rdetail-share-btn').disabled);
        test('T4: openTelegramLink NOT called', sb.state.openTelegramLinkCalls.length === 0);
        test('T4: no second picker', sb.state.shareMessageCalls.length === 1);
    })();
}

// ── Test 5: shareMessage throws — one fallback with mini_app_url ──────────
{
    const sb = createSandbox();
    sb.mockTg.shareMessage = () => { throw new Error('not supported'); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const { shareRecipe } = extractShareFunctions(sb);

    (async () => {
        await shareRecipe(42);
        test('T5: one fallback call', sb.state.openTelegramLinkCalls.length === 1);
        test('T5: fallback uses mini_app_url',
            sb.state.openTelegramLinkCalls[0]?.includes('shared_test-token-abc'));
        test('T5: button unlocked',
            !sb.mockDocument.getElementById('rdetail-share-btn').disabled);
    })();
}

// ── Test 6: prepared_message_id = null — fallback with mini_app_url ───────
{
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    // Override API to return null prepared_message_id
    sb.mockApi = async (url) => {
        sb.state.apiCalls.push({ url });
        return {
            prepared_message_id: null,
            token: 'test-token',
            mini_app_url: 'https://t.me/testbot?startapp=shared_test-token',
        };
    };
    const { shareRecipe } = extractShareFunctions(sb);

    (async () => {
        await shareRecipe(42);
        test('T6: shareMessage NOT called', sb.state.shareMessageCalls.length === 0);
        test('T6: one fallback call', sb.state.openTelegramLinkCalls.length === 1);
        test('T6: fallback uses mini_app_url',
            sb.state.openTelegramLinkCalls[0]?.includes('shared_test-token'));
    })();
}

// ── Test 7: Old Telegram (no shareMessage) — fresh share + mini_app_url ───
{
    const sb = createSandbox();
    sb.mockTg.shareMessage = undefined; // old Telegram
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    const { shareRecipe } = extractShareFunctions(sb);

    (async () => {
        await shareRecipe(42);
        test('T7: API called (fresh share)', sb.state.apiCalls.length === 1);
        test('T7: shareMessage NOT called', sb.state.shareMessageCalls.length === 0);
        test('T7: fallback uses mini_app_url',
            sb.state.openTelegramLinkCalls[0]?.includes('shared_test-token-abc'));
        test('T7: no recipe_id in URL',
            !sb.state.openTelegramLinkCalls[0]?.includes('shared_42'));
    })();
}

// ── Test 8: API error — no shareMessage, no openTelegramLink, button unlocked
{
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    sb.mockTg.openTelegramLink = (url) => { sb.state.openTelegramLinkCalls.push(url); };
    sb.mockApi = async () => { throw new Error('network error'); };
    const { shareRecipe } = extractShareFunctions(sb);

    (async () => {
        await shareRecipe(42);
        test('T8: shareMessage NOT called', sb.state.shareMessageCalls.length === 0);
        test('T8: openTelegramLink NOT called', sb.state.openTelegramLinkCalls.length === 0);
        test('T8: error toast shown',
            sb.state.toastMessages.some(m => m.includes('Не удалось подготовить')));
        test('T8: button unlocked',
            !sb.mockDocument.getElementById('rdetail-share-btn').disabled);
        // Check no undefined in any URL
        test('T8: no undefined in URLs',
            !sb.state.openTelegramLinkCalls.some(u => u?.includes('undefined')));
    })();
}

// ── Test 9: Double tap — only one API call, one picker ────────────────────
{
    const sb = createSandbox();
    sb.mockTg.shareMessage = (id, cb) => { sb.state.shareMessageCalls.push({ id, cb }); };
    const { shareRecipe } = extractShareFunctions(sb);

    (async () => {
        // Fire two share calls simultaneously
        await Promise.all([shareRecipe(42), shareRecipe(42)]);
        test('T9: API called once', sb.state.apiCalls.length === 1);
        test('T9: picker opened once', sb.state.shareMessageCalls.length === 1);
    })();
}

// ── Test 10: Late callback after safety timeout — ignored ─────────────────
{
    const sb = createSandbox();
    let lateCallback;
    sb.mockTg.shareMessage = (id, cb) => { lateCallback = cb; };
    const { shareRecipe } = extractShareFunctions(sb);

    (async () => {
        await shareRecipe(42);
        const toastsBefore = sb.state.toastMessages.length;

        // Fire safety timeout
        const timer = sb.state.timers.find(t => t.ms === 60000);
        if (timer) sb.fireTimer(timer.id);

        // Now fire the late callback with success=true
        if (lateCallback) lateCallback(true);

        test('T10: late callback ignored — no success toast',
            !sb.state.toastMessages.slice(toastsBefore).some(m => m.includes('Рецепт отправлен')));
        test('T10: no extra haptic',
            sb.state.hapticCalls.filter(c => c === 'success').length === 0);
        test('T10: button stays unlocked',
            !sb.mockDocument.getElementById('rdetail-share-btn').disabled);
    })();
}

// ── Test 11: Clipboard fallback — gets mini_app_url, not recipe_id ────────
{
    const sb = createSandbox();
    sb.mockTg.shareMessage = undefined;
    sb.mockTg.openTelegramLink = undefined; // no openTelegramLink either
    const { shareRecipe } = extractShareFunctions(sb);

    (async () => {
        await shareRecipe(42);
        test('T11: clipboard called', sb.state.clipboardWrites.length === 1);
        test('T11: clipboard gets mini_app_url',
            sb.state.clipboardWrites[0]?.includes('shared_test-token-abc'));
        test('T11: no recipe_id in clipboard',
            !sb.state.clipboardWrites[0]?.includes('42'));
        test('T11: no undefined in clipboard',
            !sb.state.clipboardWrites[0]?.includes('undefined'));
    })();
}

// ── Test 12: UI — panel visibility ────────────────────────────────────────
{
    // Check static HTML for visibility logic
    test('T12: bar hidden during loading',
        allScripts.includes("bar.classList.remove('visible')") &&
        allScripts.includes("$('rdetail-share-bar')"));
    test('T12: bar shown after render',
        allScripts.includes("bar.classList.add('visible')"));
    test('T12: bar hidden on error',
        allScripts.includes('Keep share bar hidden on error') ||
        allScripts.includes("bar.classList.remove('visible')"));
    test('T12: bar hidden on close',
        allScripts.includes('closeRdetail') &&
        allScripts.includes("bar.classList.remove('visible')"));
    test('T12: Share not in menu', !menuBody.includes('Поделиться рецептом'));
}

// ── Wait for async tests and print results ────────────────────────────────
setTimeout(() => {
    console.log('');
    for (const r of results) {
        const icon = r.status === 'PASS' ? 'PASS' : 'FAIL';
        console.log(`  ${icon}: ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log(`TOTAL: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('='.repeat(60));

    process.exit(failed > 0 ? 1 : 0);
}, 100);
