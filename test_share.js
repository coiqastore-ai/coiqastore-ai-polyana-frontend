/**
 * Behavioral tests for the exact Recipe Detail share code in index.html.
 * Run: node test_share.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
const results = [];

function assert(name, condition, detail = '') {
    results.push({ name, condition: Boolean(condition), detail });
    condition ? passed++ : failed++;
}

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]);
const scripts = inlineScripts.join('\n');
const shareMatch = scripts.match(
    /(const RECIPE_SHARE_EVENT_TIMEOUT_MS = 8000;[\s\S]*?)(?=function showShareScreen\()/
);
const shareBlock = shareMatch ? shareMatch[1].trim() : '';
const shareFunction = shareBlock.match(
    /function shareCurrentRecipe\(\) \{[\s\S]*?\n\}(?=\n\nfunction shareRecipeFallback)/
)?.[0] || '';
const executableShareFunction = shareFunction.replace(/\/\/.*$/gm, '');

function mockElement() {
    return {
        disabled: false,
        textContent: '',
        style: { display: 'none' },
        attrs: {},
        setAttribute(name, value) { this.attrs[name] = value; },
        removeAttribute(name) { delete this.attrs[name]; },
        classList: { add() {}, remove() {} },
    };
}

function createSandbox(options = {}) {
    const elements = new Map();
    const getElement = id => {
        if (!elements.has(id)) elements.set(id, mockElement());
        return elements.get(id);
    };
    getElement('rdetail-share-btn').disabled = true;

    const state = {
        apiCalls: [],
        shareCalls: [],
        switchCalls: [],
        toasts: [],
        haptics: [],
        handlers: new Map(),
        timers: new Map(),
        nextTimer: 1,
        callOrder: [],
    };

    const tg = {
        isVersionAtLeast: () => options.supported !== false,
        onEvent(name, callback) {
            state.handlers.set(name, callback);
        },
        offEvent(name, callback) {
            if (state.handlers.get(name) === callback) state.handlers.delete(name);
        },
        shareMessage(id) {
            state.callOrder.push('shareMessage');
            state.shareCalls.push(id);
            if (options.shareThrows) throw new Error(options.shareThrows);
        },
        switchInlineQuery(query, chatTypes) {
            state.switchCalls.push({ query, chatTypes });
            if (options.switchThrows) throw new Error('switch failed');
        },
    };
    if (options.noShareMethod) delete tg.shareMessage;
    if (options.noSwitchMethod) delete tg.switchInlineQuery;

    const defaultResponse = {
        prepared_message_id: 'prepared-42',
        expiration_date: Math.floor(Date.now() / 1000) + 3600,
        token: 'token-42',
        mini_app_url: 'https://t.me/reciptesbot/polyana?startapp=shared_token-42',
    };
    const api = options.api || ((url, method) => {
        state.callOrder.push('api');
        state.apiCalls.push({ url, method });
        if (options.apiRejects) return Promise.reject(new Error('api failed'));
        return Promise.resolve(options.apiResponse || defaultResponse);
    });

    const context = {
        window: { Telegram: { WebApp: tg } },
        S: { tg },
        RDETAIL: { recipe: { id: 42, name: 'Тестовый рецепт' }, from: 'library' },
        api,
        $: getElement,
        toast(message) { state.toasts.push(message); },
        hideToast() { state.callOrder.push('hideToast'); },
        hapticNotif(type) { state.haptics.push(type); },
        setTimeout(callback, ms) {
            const id = state.nextTimer++;
            state.timers.set(id, { callback, ms });
            return id;
        },
        clearTimeout(id) { state.timers.delete(id); },
        Date,
        console: { log() {}, warn() {}, error() {} },
    };
    vm.createContext(context);
    vm.runInContext(`${shareBlock}\n;globalThis.__shareState = RECIPE_SHARE;`, context);
    return { context, state, tg, getElement };
}

function runStaticChecks() {
    assert('Exact production Share block extracted', shareBlock.length > 1000);
    assert('Primary handler is deliberately synchronous', shareFunction.startsWith('function shareCurrentRecipe('));
    assert('Primary handler contains no await', !/\bawait\b/.test(executableShareFunction));
    assert('Primary handler contains no API request', !/\bapi\s*\(/.test(executableShareFunction));
    assert('Primary handler calls native shareMessage', shareFunction.includes('tg.shareMessage(data.prepared_message_id)'));
    assert('Primary handler passes no callback', !/shareMessage\([^\n]+,/.test(shareFunction));
    assert('Primary handler handles sent event', shareFunction.includes("shareMessageSent"));
    assert('Primary handler handles failed event', shareFunction.includes("shareMessageFailed"));
    assert('Primary handler never auto-opens inline fallback', !shareFunction.includes('switchInlineQuery'));
    assert('Manual fallback owns switchInlineQuery', /function shareRecipeFallback[\s\S]*switchInlineQuery/.test(shareBlock));
    assert('Recipe open primes Share after render', /renderRdetail\(r\);\s*void primeRecipeShare\(r\.id\)/.test(scripts));
    assert('Recipe close clears Share state', /function closeRdetail\(\) \{\s*cancelRecipeShareAttempt\(\)/.test(scripts));
    assert('Recipe switch clears stale Share state', /async function openRecipeDetail[\s\S]{0,100}cancelRecipeShareAttempt\(\)/.test(scripts));
    assert('Visible primary action is a button', html.includes('id="rdetail-share-btn"'));
    assert('Visible manual fallback is a button', html.includes('id="rdetail-share-fallback"'));
    assert('Primary button begins disabled', /id="rdetail-share-btn"[^>]*\bdisabled\b/.test(html));
    const menu = scripts.match(/function openRdetailMenu\(\)[\s\S]*?\n\}/)?.[0] || '';
    assert('Share is absent from overflow menu', !menu.includes('Поделиться рецептом'));
    assert('Edit remains in overflow menu', menu.includes('Редактировать рецепт'));
    assert('Toast cannot cover recipe buttons', /\.toast \{[\s\S]*?pointer-events: none;/.test(html));
    assert('Toast undo remains clickable', /\.toast-undo \{[\s\S]*?pointer-events: auto;/.test(html));
    assert('No Share debug alert remains', !scripts.includes('SHARE DEBUG'));
    assert('Official Telegram SDK URL is cache-versioned',
        html.includes('https://telegram.org/js/telegram-web-app.js?63'));

    inlineScripts.forEach((script, index) => {
        try {
            new Function(script);
            assert(`Inline script ${index + 1} parses`, true);
        } catch (error) {
            assert(`Inline script ${index + 1} parses`, false, error.message);
        }
    });
}

async function primeReadyShare(sb) {
    const data = await sb.context.primeRecipeShare(42);
    assert('Prime: correct API path', sb.state.apiCalls[0]?.url === '/recipes/42/prepare-share');
    assert('Prime: POST used', sb.state.apiCalls[0]?.method === 'POST');
    assert('Prime: prepared data retained', data?.prepared_message_id === 'prepared-42');
    assert('Prime: primary button enabled', sb.getElement('rdetail-share-btn').disabled === false);
    assert('Prime: normal button label restored', sb.getElement('rdetail-share-btn').textContent === '📤 Поделиться рецептом');
}

async function testSynchronousNativeCall() {
    const sb = createSandbox();
    await primeReadyShare(sb);
    sb.state.apiCalls.length = 0;
    sb.state.callOrder.length = 0;
    sb.context.shareCurrentRecipe();
    assert('Click: no network call in handler', sb.state.apiCalls.length === 0);
    assert('Click: native bridge called immediately', sb.state.callOrder.includes('shareMessage'));
    assert('Click: correct prepared id used', sb.state.shareCalls[0] === 'prepared-42');
    assert('Click: primary locked while Telegram owns flow', sb.getElement('rdetail-share-btn').disabled === true);
    assert('Click: sent handler registered', sb.state.handlers.has('shareMessageSent'));
    assert('Click: failed handler registered', sb.state.handlers.has('shareMessageFailed'));
    assert('Click: no inline fallback launched', sb.state.switchCalls.length === 0);
}

async function testDoubleTapGuard() {
    const sb = createSandbox();
    await sb.context.primeRecipeShare(42);
    sb.context.shareCurrentRecipe();
    sb.context.shareCurrentRecipe();
    assert('Double tap: native bridge called once', sb.state.shareCalls.length === 1);
}

async function testSuccessfulSend() {
    const sb = createSandbox();
    await sb.context.primeRecipeShare(42);
    sb.context.shareCurrentRecipe();
    sb.state.handlers.get('shareMessageSent')();
    assert('Sent: success toast shown', sb.state.toasts.includes('✅ Рецепт отправлен!'));
    assert('Sent: success haptic fired', sb.state.haptics.includes('success'));
    assert('Sent: handlers removed', sb.state.handlers.size === 0);
    assert('Sent: fresh prepared message requested', sb.state.apiCalls.length === 2);
}

async function testUserDeclined() {
    const sb = createSandbox();
    await sb.context.primeRecipeShare(42);
    sb.context.shareCurrentRecipe();
    sb.state.handlers.get('shareMessageFailed')({ error: 'USER_DECLINED' });
    assert('Declined: no success toast', !sb.state.toasts.includes('✅ Рецепт отправлен!'));
    assert('Declined: fallback remains hidden', sb.getElement('rdetail-share-fallback').style.display === 'none');
    assert('Declined: primary becomes reusable', sb.getElement('rdetail-share-btn').disabled === false);
}

async function testNativeFailureAndManualFallback() {
    const sb = createSandbox();
    await sb.context.primeRecipeShare(42);
    sb.context.shareCurrentRecipe();
    sb.state.handlers.get('shareMessageFailed')({ error: 'MESSAGE_SEND_FAILED' });
    assert('Failure: fallback button shown', sb.getElement('rdetail-share-fallback').style.display === 'flex');
    assert('Failure: fallback not automatic', sb.state.switchCalls.length === 0);
    sb.context.shareRecipeFallback();
    assert('Fallback tap: switchInlineQuery called once', sb.state.switchCalls.length === 1);
    assert('Fallback tap: exact token query used', sb.state.switchCalls[0].query === 'share:token-42');
    assert('Fallback tap: user, group and channel choices allowed',
        JSON.stringify(sb.state.switchCalls[0].chatTypes) === JSON.stringify(['users', 'groups', 'channels']));
}

async function testSilentBridgeDoesNotSabotageNativeFlow() {
    const sb = createSandbox();
    await sb.context.primeRecipeShare(42);
    sb.context.shareCurrentRecipe();
    const timer = [...sb.state.timers.values()].find(item => item.ms === 8000);
    assert('Silent: safety timer exists', Boolean(timer));
    timer.callback();
    assert('Silent: manual fallback becomes visible', sb.getElement('rdetail-share-fallback').style.display === 'flex');
    assert('Silent: no automatic inline picker', sb.state.switchCalls.length === 0);
    assert('Silent: primary stays locked against SDK re-entry', sb.getElement('rdetail-share-btn').disabled === true);
    sb.context.shareRecipeFallback();
    assert('Silent: fallback opens only after its own click', sb.state.switchCalls.length === 1);
}

async function testBridgeException() {
    const sb = createSandbox({ shareThrows: 'WebAppShareMessageOpened' });
    await sb.context.primeRecipeShare(42);
    sb.context.shareCurrentRecipe();
    assert('Exception: fallback shown', sb.getElement('rdetail-share-fallback').style.display === 'flex');
    assert('Exception: bridge attempted once', sb.state.shareCalls.length === 1);
    assert('Exception: no automatic fallback', sb.state.switchCalls.length === 0);
    assert('Busy exception: primary remains locked', sb.getElement('rdetail-share-btn').disabled === true);
}

async function testUnsupportedClient() {
    const sb = createSandbox({ supported: false });
    await sb.context.primeRecipeShare(42);
    sb.context.shareCurrentRecipe();
    assert('Unsupported: shareMessage not called', sb.state.shareCalls.length === 0);
    assert('Unsupported: manual fallback shown', sb.getElement('rdetail-share-fallback').style.display === 'flex');
    assert('Unsupported: fallback still waits for click', sb.state.switchCalls.length === 0);
}

async function testPrefetchFailureAndRetry() {
    const sb = createSandbox({ apiRejects: true });
    const data = await sb.context.primeRecipeShare(42);
    assert('API failure: no data returned', data === null);
    assert('API failure: retry button enabled', sb.getElement('rdetail-share-btn').disabled === false);
    assert('API failure: retry label shown', sb.getElement('rdetail-share-btn').textContent === 'Повторить подготовку');
    sb.context.shareCurrentRecipe();
    assert('Retry click: no invalid native call', sb.state.shareCalls.length === 0);
    assert('Retry click: starts another prepare request', sb.state.apiCalls.length === 2);
}

async function testTokenOnlyBackendFallback() {
    const sb = createSandbox({
        apiResponse: { prepared_message_id: null, expiration_date: null, token: 'manual-token', fallback: true },
    });
    await sb.context.primeRecipeShare(42);
    assert('Token only: primary remains disabled', sb.getElement('rdetail-share-btn').disabled === true);
    assert('Token only: manual fallback is visible', sb.getElement('rdetail-share-fallback').style.display === 'flex');
    sb.context.shareRecipeFallback();
    assert('Token only: fallback uses returned token', sb.state.switchCalls[0]?.query === 'share:manual-token');
}

async function testStalePrepareIgnored() {
    let resolveRequest;
    const sb = createSandbox({
        api(url, method) {
            sb.state.apiCalls.push({ url, method });
            return new Promise(resolve => { resolveRequest = resolve; });
        },
    });
    const pending = sb.context.primeRecipeShare(42);
    sb.context.cancelRecipeShareAttempt();
    sb.context.RDETAIL.recipe = { id: 99 };
    resolveRequest({
        prepared_message_id: 'stale',
        expiration_date: Math.floor(Date.now() / 1000) + 3600,
        token: 'stale',
    });
    const result = await pending;
    assert('Stale: late response ignored', result === null);
    assert('Stale: late prepared id not stored', sb.context.__shareState.data === null);
}

async function run() {
    runStaticChecks();
    await testSynchronousNativeCall();
    await testDoubleTapGuard();
    await testSuccessfulSend();
    await testUserDeclined();
    await testNativeFailureAndManualFallback();
    await testSilentBridgeDoesNotSabotageNativeFlow();
    await testBridgeException();
    await testUnsupportedClient();
    await testPrefetchFailureAndRetry();
    await testTokenOnlyBackendFallback();
    await testStalePrepareIgnored();

    for (const result of results) {
        const status = result.condition ? 'PASS' : 'FAIL';
        console.log(`${status}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
    }
    console.log(`\nTOTAL: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    process.exitCode = failed ? 1 : 0;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
