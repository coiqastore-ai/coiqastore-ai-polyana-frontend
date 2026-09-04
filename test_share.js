/**
 * Share tests execute the real Recipe Detail implementation from index.html.
 * Run: node test_share.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
const results = [];

function assert(name, condition, detail = '') {
    results.push({ name, status: condition ? 'PASS' : 'FAIL', detail });
    condition ? passed++ : failed++;
}

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .join('\n');
const blockMatch = scripts.match(
    /(const POLYANA_APP_SHORT_NAME = 'polyana';[\s\S]*?)(?=function showShareScreen\()/
);
const shareBlock = blockMatch ? blockMatch[1].trim() : '';
const primaryBlock = shareBlock.match(/async function shareCurrentRecipe\(\)[\s\S]*$/)?.[0] || '';

function mockElement() {
    return {
        disabled: false,
        textContent: '',
        style: {},
        href: undefined,
        attrs: {},
        classes: new Set(),
        setAttribute(name, value) { this.attrs[name] = value; },
        removeAttribute(name) { delete this.attrs[name]; },
        classList: {
            owner: null,
            add(name) { this.owner.classes.add(name); },
            remove(name) { this.owner.classes.delete(name); },
            contains(name) { return this.owner.classes.has(name); },
        },
    };
}

function createSandbox(options = {}) {
    const elements = {};
    const getElement = id => {
        if (!elements[id]) {
            elements[id] = mockElement();
            elements[id].classList.owner = elements[id];
        }
        return elements[id];
    };

    const state = {
        apiCalls: [],
        shareCalls: [],
        openLinks: [],
        toasts: [],
        haptics: [],
        handlers: new Map(),
        timers: new Map(),
        nextTimerId: 1,
    };

    const tg = {
        isVersionAtLeast: () => options.supported !== false,
        onEvent(name, callback) { state.handlers.set(name, callback); },
        offEvent(name, callback) {
            if (state.handlers.get(name) === callback) state.handlers.delete(name);
        },
        shareMessage(id) {
            state.shareCalls.push(id);
            if (options.shareThrows) throw new Error('bridge failed');
        },
        openTelegramLink(url) { state.openLinks.push(url); },
    };

    const apiResponse = options.apiResponse || {
        prepared_message_id: 'prepared-123',
        token: 'token-123',
        mini_app_url: 'https://t.me/reciptesbot/polyana?startapp=shared_token-123',
    };
    const api = options.api || ((url, method) => {
        state.apiCalls.push({ url, method });
        if (options.apiRejects) return Promise.reject(new Error('api failed'));
        return Promise.resolve(apiResponse);
    });

    const setTimeoutMock = (callback, ms) => {
        const id = state.nextTimerId++;
        state.timers.set(id, { callback, ms });
        return id;
    };
    const clearTimeoutMock = id => state.timers.delete(id);
    const context = {
        window: { Telegram: { WebApp: tg } },
        S: { tg },
        RDETAIL: { recipe: { id: 42, name: 'Тестовый суп' }, from: 'library' },
        BOT: 'reciptesbot',
        api,
        $: getElement,
        toast: message => state.toasts.push(message),
        hapticNotif: type => state.haptics.push(type),
        setTimeout: setTimeoutMock,
        clearTimeout: clearTimeoutMock,
        encodeURIComponent,
        console: { log: console.log, error() {}, warn() {} },
    };
    vm.createContext(context);
    vm.runInContext(shareBlock, context);
    return { context, state, elements, getElement, tg };
}

function runStaticChecks() {
    assert('Share block extracted', shareBlock.length > 100);
    assert('Real shareCurrentRecipe extracted', shareBlock.includes('async function shareCurrentRecipe'));
    assert('Primary flow uses shareMessage', shareBlock.includes('tg.shareMessage(data.prepared_message_id)'));
    assert('Sent event is handled', shareBlock.includes("shareMessageSent"));
    assert('Failed event is handled', shareBlock.includes("shareMessageFailed"));
    assert('Primary flow does not call openTelegramLink', !primaryBlock.includes('openTelegramLink'));
    assert('Fallback uses openTelegramLink on a direct tap', shareBlock.includes('tg.openTelegramLink(url)'));
    assert('Registered short name is polyana', shareBlock.includes("POLYANA_APP_SHORT_NAME = 'polyana'"));

    try {
        new Function(scripts);
        assert('All inline JavaScript parses', true);
    } catch (error) {
        assert('All inline JavaScript parses', false, error.message);
    }

    assert(
        'Visible Recipe Detail action is a button',
        html.includes('<button class="btn-share" id="rdetail-share-btn"')
    );
    assert(
        'Manual fallback is a separate link',
        html.includes('<a class="btn-share" id="rdetail-share-fallback"')
    );
    assert('Share button is not a prefetched href', !html.includes('<a class="btn-share" id="rdetail-share-btn"'));
    assert('Prefetch implementation removed', !shareBlock.includes('prefetchShareLink'));
    assert('Disabled button CSS exists', html.includes('.rdetail-share-bar .btn-share:disabled'));

    const menu = scripts.match(/function openRdetailMenu\(\)[\s\S]*?openSheet\(/)?.[0] || '';
    assert('Share is absent from overflow menu', !menu.includes('Поделиться рецептом'));
    assert('Edit remains in overflow menu', menu.includes('Редактировать рецепт'));
    assert('Normalize remains in overflow menu', menu.includes('Распознать количества'));
    assert('Opening a recipe cancels stale share', /openRecipeDetail[\s\S]{0,180}cancelRecipeShareAttempt/.test(scripts));
    assert('Closing a recipe cancels stale share', /closeRdetail[\s\S]{0,120}cancelRecipeShareAttempt/.test(scripts));

    const escDecls = [...html.matchAll(/(?:^|\n)\s*function\s+esc\s*\(/g)];
    assert('Exactly one esc function remains', escDecls.length === 1, `found ${escDecls.length}`);
}

async function testModernTelegramStartsNativeShare() {
    const sb = createSandbox();
    await sb.context.shareCurrentRecipe();
    assert('Modern: prepare API called once', sb.state.apiCalls.length === 1);
    assert('Modern: correct endpoint', sb.state.apiCalls[0].url === '/recipes/42/prepare-share');
    assert('Modern: POST used', sb.state.apiCalls[0].method === 'POST');
    assert('Modern: shareMessage called once', sb.state.shareCalls.length === 1);
    assert('Modern: prepared id forwarded', sb.state.shareCalls[0] === 'prepared-123');
    assert('Modern: sent handler registered', sb.state.handlers.has('shareMessageSent'));
    assert('Modern: failed handler registered', sb.state.handlers.has('shareMessageFailed'));
    assert('Modern: button stays locked pending event', sb.getElement('rdetail-share-btn').disabled === true);
}

async function testSentEventFinishesSuccessfully() {
    const sb = createSandbox();
    await sb.context.shareCurrentRecipe();
    const sent = sb.state.handlers.get('shareMessageSent');
    sent();
    assert('Sent: success toast', sb.state.toasts.includes('✅ Рецепт отправлен!'));
    assert('Sent: success haptic', sb.state.haptics.includes('success'));
    assert('Sent: button unlocked', sb.getElement('rdetail-share-btn').disabled === false);
    assert('Sent: events detached', sb.state.handlers.size === 0);
    assert('Sent: fallback stays hidden', sb.getElement('rdetail-share-fallback').style.display === 'none');
}

async function testUserDeclinedIsNeutral() {
    const sb = createSandbox();
    await sb.context.shareCurrentRecipe();
    sb.state.handlers.get('shareMessageFailed')({ error: 'USER_DECLINED' });
    assert('Declined: button unlocked', sb.getElement('rdetail-share-btn').disabled === false);
    assert('Declined: no success toast', !sb.state.toasts.includes('✅ Рецепт отправлен!'));
    assert('Declined: no fallback', sb.getElement('rdetail-share-fallback').style.display === 'none');
    assert('Declined: events detached', sb.state.handlers.size === 0);
}

async function testTelegramFailureOffersManualFallback() {
    const sb = createSandbox();
    await sb.context.shareCurrentRecipe();
    sb.state.handlers.get('shareMessageFailed')({ error: 'MESSAGE_SEND_FAILED' });
    const fallback = sb.getElement('rdetail-share-fallback');
    assert('Failure: fallback shown', fallback.style.display === 'flex');
    assert('Failure: standard Telegram share URL', fallback.href.startsWith('https://t.me/share/url?'));
    assert('Failure: registered Direct Mini App nested', decodeURIComponent(fallback.href).includes('/polyana?startapp=shared_token-123'));
    assert('Failure: no automatic second picker', sb.state.shareCalls.length === 1);
    assert('Failure: fallback is not opened automatically', sb.state.openLinks.length === 0);
    assert('Failure: error toast shown', sb.state.toasts.includes('Telegram не смог отправить сообщение'));

    let prevented = false;
    const result = sb.context.openRecipeShareFallback({ preventDefault() { prevented = true; } });
    assert('Failure: manual tap prevents browser navigation', prevented === true && result === false);
    assert('Failure: manual tap uses Telegram bridge', sb.state.openLinks[0] === fallback.href);
}

async function testSilentBridgeOffersFallback() {
    const sb = createSandbox();
    await sb.context.shareCurrentRecipe();
    const eventTimeout = [...sb.state.timers.values()].find(timer => timer.ms === 15000);
    assert('Silent: safety timer created', Boolean(eventTimeout));
    eventTimeout.callback();
    assert('Silent: fallback shown', sb.getElement('rdetail-share-fallback').style.display === 'flex');
    assert('Silent: primary button unlocked', sb.getElement('rdetail-share-btn').disabled === false);
    assert('Silent: no automatic second picker', sb.state.shareCalls.length === 1);
    assert('Silent: event handlers removed', sb.state.handlers.size === 0);
}

async function testUnsupportedTelegramSkipsPreparedMessage() {
    const sb = createSandbox({ supported: false });
    await sb.context.shareCurrentRecipe();
    const fallback = sb.getElement('rdetail-share-fallback');
    assert('Unsupported: API not called', sb.state.apiCalls.length === 0);
    assert('Unsupported: shareMessage not called', sb.state.shareCalls.length === 0);
    assert('Unsupported: fallback shown', fallback.style.display === 'flex');
    assert('Unsupported: bot save link used', decodeURIComponent(fallback.href).includes('start=save_recipe_42'));
}

async function testApiAndBridgeErrorsOfferFallback() {
    const apiFailure = createSandbox({ apiRejects: true });
    await apiFailure.context.shareCurrentRecipe();
    assert('API error: fallback shown', apiFailure.getElement('rdetail-share-fallback').style.display === 'flex');
    assert('API error: shareMessage not called', apiFailure.state.shareCalls.length === 0);

    const bridgeFailure = createSandbox({ shareThrows: true });
    await bridgeFailure.context.shareCurrentRecipe();
    assert('Bridge error: fallback shown', bridgeFailure.getElement('rdetail-share-fallback').style.display === 'flex');
    assert('Bridge error: one share attempt', bridgeFailure.state.shareCalls.length === 1);
}

async function testDoubleTapAndStaleAttemptGuards() {
    let resolveApi;
    const sb = createSandbox({
        api: (url, method) => {
            sb.state.apiCalls.push({ url, method });
            return new Promise(resolve => { resolveApi = resolve; });
        },
    });
    const first = sb.context.shareCurrentRecipe();
    const second = sb.context.shareCurrentRecipe();
    assert('Double tap: API called once', sb.state.apiCalls.length === 1);
    resolveApi({ prepared_message_id: 'once', token: 'once' });
    await Promise.all([first, second]);
    assert('Double tap: shareMessage called once', sb.state.shareCalls.length === 1);

    let resolveStale;
    const stale = createSandbox({
        api: (url, method) => {
            stale.state.apiCalls.push({ url, method });
            return new Promise(resolve => { resolveStale = resolve; });
        },
    });
    const pending = stale.context.shareCurrentRecipe();
    stale.context.cancelRecipeShareAttempt();
    resolveStale({ prepared_message_id: 'late', token: 'late' });
    await pending;
    assert('Cancelled: late API does not share', stale.state.shareCalls.length === 0);
    assert('Cancelled: button is unlocked', stale.getElement('rdetail-share-btn').disabled === false);
    assert('Cancelled: fallback hidden', stale.getElement('rdetail-share-fallback').style.display === 'none');
}

async function testContractFallbacks() {
    const tokenOnly = createSandbox({
        apiResponse: { prepared_message_id: 'prepared', token: 'server-token' },
    });
    await tokenOnly.context.shareCurrentRecipe();
    tokenOnly.state.handlers.get('shareMessageFailed')({ error: 'MESSAGE_EXPIRED' });
    const tokenHref = decodeURIComponent(tokenOnly.getElement('rdetail-share-fallback').href);
    assert('Token contract: builds /polyana deep link', tokenHref.includes('t.me/reciptesbot/polyana?startapp=shared_server-token'));

    const backendUrl = createSandbox({
        apiResponse: {
            prepared_message_id: null,
            token: 'ignored',
            mini_app_url: 'https://t.me/otherbot/polyana?startapp=shared_backend',
        },
    });
    await backendUrl.context.shareCurrentRecipe();
    const backendHref = decodeURIComponent(backendUrl.getElement('rdetail-share-fallback').href);
    assert('Backend contract: mini_app_url wins', backendHref.includes('t.me/otherbot/polyana?startapp=shared_backend'));
    assert('Backend contract: no prepared share call', backendUrl.state.shareCalls.length === 0);
}

async function run() {
    runStaticChecks();
    await testModernTelegramStartsNativeShare();
    await testSentEventFinishesSuccessfully();
    await testUserDeclinedIsNeutral();
    await testTelegramFailureOffersManualFallback();
    await testSilentBridgeOffersFallback();
    await testUnsupportedTelegramSkipsPreparedMessage();
    await testApiAndBridgeErrorsOfferFallback();
    await testDoubleTapAndStaleAttemptGuards();
    await testContractFallbacks();

    for (const result of results) {
        console.log(`${result.status}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
    }
    console.log(`\nTOTAL: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    process.exitCode = failed ? 1 : 0;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
