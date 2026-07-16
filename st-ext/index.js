/**
 * Detached Gen — client-side extension
 *
 * Intercepts ST's generation fetch and reroutes it through the detached-gen
 * server plugin, so the browser never holds a long socket open. See the plugin
 * (plugins/detached-gen/index.js) for why that matters on iOS.
 *
 * Two failure modes are handled:
 *   - suspend  (iOS freezes the page): the poll loop simply pauses and resumes.
 *   - kill     (iOS reclaims the memory, page reloads): the jobId is in
 *              localStorage, so on reload we fetch the result and insert it.
 *
 * The enable flag lives in localStorage rather than extension settings because
 * this is a per-device problem — you want it on the phone, not necessarily on
 * a desktop that never gets backgrounded.
 */

const API = '/api/plugins/detached-gen';
const TARGET = '/api/backends/chat-completions/generate';
const POLL_MS = 1500;
const PENDING_KEY = 'detachedGen_pending';
const ENABLED_KEY = 'detachedGen_enabled';
const PENDING_TTL_MS = 60 * 60 * 1000; // matches the plugin's DONE_TTL_MS
const MAX_POLL_FAILURES = 60;          // ~90 s of continuous awake failure

const origFetch = window.fetch.bind(window);

/** Returned by the poll loop when ST rejected our inner request's session. */
const AUTH_FAILED = Symbol('detached-gen:auth-failed');

function ctx() {
    return SillyTavern.getContext();
}

function headers() {
    return ctx().getRequestHeaders();
}

function isEnabled() {
    return localStorage.getItem(ENABLED_KEY) !== '0'; // on unless explicitly disabled
}

function setEnabled(on) {
    localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
}

/* --------------------------------------------------------------- gen type */

/**
 * ST routes every kind of generation through the same endpoint — summaries,
 * impersonate, swipes, continues. Detaching all of them is fine, but only a
 * plain reply may be auto-inserted into the chat after a reload; anything else
 * would put a summary where the character's line should be.
 */
let currentGen = null;

function watchGenType(c) {
    c.eventSource.on(c.eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
        if (dryRun) return;
        currentGen = { type: type || 'normal', quiet: !!options?.quiet_prompt };
    });
}

function isRecoverableGen() {
    return !!currentGen && !currentGen.quiet && currentGen.type === 'normal';
}

/* ------------------------------------------------------------------ pending */

function savePending(jobId) {
    try {
        const c = ctx();
        localStorage.setItem(PENDING_KEY, JSON.stringify({
            jobId,
            chatId: String(c.chatId ?? ''),
            chatLength: c.chat?.length ?? 0,
            ts: Date.now(),
        }));
    } catch { /* private mode / quota — recovery is best-effort */ }
}

function loadPending() {
    try {
        const raw = localStorage.getItem(PENDING_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function clearPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch { /* fine */ }
}

/**
 * Only clear an entry we own. A utility generation finishing must not wipe the
 * pending entry belonging to a real reply.
 */
function clearPendingIf(jobId) {
    if (loadPending()?.jobId === jobId) clearPending();
}

/* -------------------------------------------------------------------- utils */

/** Resolves on timeout, or early when the tab becomes visible again. */
function sleep(ms) {
    return new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            document.removeEventListener('visibilitychange', onVisible);
            resolve();
        };
        const onVisible = () => { if (!document.hidden) done(); };
        const timer = setTimeout(done, ms);
        document.addEventListener('visibilitychange', onVisible);
    });
}

/** Pull the assistant text out of a raw backend response body. */
function extractText(bodyText) {
    try {
        const d = JSON.parse(bodyText);
        return d?.choices?.[0]?.message?.content
            ?? d?.choices?.[0]?.text
            ?? d?.content?.find?.(c => c.type === 'text')?.text
            ?? d?.candidates?.[0]?.content?.parts?.[0]?.text
            ?? null;
    } catch {
        return null;
    }
}

async function pollOnce(jobId) {
    const r = await origFetch(`${API}/poll?jobId=${encodeURIComponent(jobId)}`, { headers: headers() });
    if (!r.ok) throw new Error(`poll → HTTP ${r.status}`);
    return r.json();
}

function cancelJob(jobId) {
    origFetch(`${API}/cancel`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ jobId }),
    }).catch(() => { /* best effort */ });
}

/* ------------------------------------------------------------- interception */

function targetUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input?.url ?? '';
}

function shouldIntercept(input, init) {
    if (!isEnabled()) return false;
    if (!targetUrl(input).includes(TARGET)) return false;
    const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
    return method === 'POST';
}

/** Wait out a running job and hand back a Response ST can't tell from the real one. */
async function pollToResponse(jobId, signal) {
    const onAbort = () => cancelJob(jobId);
    signal?.addEventListener('abort', onAbort, { once: true });
    let failures = 0;
    try {
        for (;;) {
            if (signal?.aborted) {
                clearPendingIf(jobId);
                throw new DOMException('Aborted', 'AbortError');
            }

            let j;
            try {
                j = await pollOnce(jobId);
                failures = 0;
            } catch (err) {
                // A phone waking up will fail a poll or two. Only give up if we
                // keep failing while actually awake — a frozen page runs no
                // timers, so these can't accumulate during a suspend.
                if (++failures > MAX_POLL_FAILURES) {
                    clearPendingIf(jobId);
                    throw err;
                }
                await sleep(POLL_MS);
                continue;
            }

            if (j.status === 'running') {
                await sleep(POLL_MS);
                continue;
            }

            clearPendingIf(jobId);

            if (j.status === 'cancelled') {
                throw new DOMException('Aborted', 'AbortError');
            }
            if (j.authFailed) return AUTH_FAILED;
            if (j.body) {
                // Includes upstream errors: replay them verbatim so ST's own
                // error handling shows what it normally would.
                return new Response(j.body, {
                    status: j.httpStatus || 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(
                JSON.stringify({ error: { message: `detached-gen: ${j.error || j.status}` } }),
                { status: j.httpStatus || 500, headers: { 'Content-Type': 'application/json' } },
            );
        }
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}

async function detachedGenerate(input, init) {
    // ST always passes a stringified body here; anything else (a Request
    // object, a stream) isn't ours to reinterpret.
    if (typeof init?.body !== 'string') return origFetch(input, init);

    let payload;
    try {
        payload = JSON.parse(init.body);
    } catch {
        return origFetch(input, init); // not a body we understand
    }
    // Streaming would mean faking an SSE stream; out of scope, and the setups
    // that need this run non-streaming anyway.
    if (payload?.stream) return origFetch(input, init);

    let jobId;
    try {
        const r = await origFetch(`${API}/start`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ targetPath: TARGET, payload }),
        });
        if (!r.ok) throw new Error(`start → HTTP ${r.status}`);
        jobId = (await r.json())?.jobId;
        if (!jobId) throw new Error('no jobId in response');
    } catch (err) {
        // Nothing has been started yet, so falling back is safe. Past this
        // point it is not: the job is running and a retry would double-bill.
        console.warn('[detached-gen] start failed, using direct fetch:', err.message);
        return origFetch(input, init);
    }

    // Everything gets detached (that's what stops the abort); only a plain
    // reply gets armed for post-reload recovery.
    if (isRecoverableGen()) savePending(jobId);
    const result = await pollToResponse(jobId, init?.signal);

    if (result === AUTH_FAILED) {
        // ST bounced our inner request, so the model was never called and a
        // direct retry costs nothing but a round trip. The user loses the
        // background protection for this message, not the message itself.
        console.warn('[detached-gen] session forwarding rejected — retrying directly');
        toastr.warning('서버 인증 전달에 실패해 이번 요청은 일반 방식으로 보냅니다. (백그라운드 보호 없음)', 'Detached Gen');
        return origFetch(input, init);
    }
    return result;
}

function installPatch() {
    if (window.fetch.__detachedGen) return;
    const patched = async function (input, init) {
        if (!shouldIntercept(input, init)) return origFetch(input, init);
        return detachedGenerate(input, init);
    };
    patched.__detachedGen = true;
    window.fetch = patched;
    console.log('[detached-gen] fetch patch installed');
}

/* ---------------------------------------------------------------- recovery */

let recovering = false;

/**
 * Runs after a reload. If a job was in flight when the page died, the server
 * finished it anyway — collect it and put it in the chat.
 */
async function tryRecover() {
    if (recovering) return;
    const p = loadPending();
    if (!p?.jobId) return;

    if (Date.now() - p.ts > PENDING_TTL_MS) { clearPending(); return; }

    const c = ctx();
    // Wrong chat open — leave the pending entry alone; we'll catch it when the
    // user switches back.
    if (String(c.chatId ?? '') !== String(p.chatId ?? '')) return;

    // A reply is only owed if the chat is exactly where we left it, with the
    // user's message last. Anything else (reply already landed, chat edited)
    // means inserting would duplicate or misplace.
    const last = c.chat?.[c.chat.length - 1];
    if (!last?.is_user || c.chat.length !== p.chatLength) { clearPending(); return; }

    recovering = true;
    try {
        let j = await pollOnce(p.jobId);
        if (j.status === 'running') {
            toastr.info('백그라운드에서 생성 중이던 답장을 기다리는 중…', 'Detached Gen');
            let failures = 0;
            while (j.status === 'running') {
                await sleep(POLL_MS);
                try {
                    j = await pollOnce(p.jobId);
                    failures = 0;
                } catch (err) {
                    if (++failures > MAX_POLL_FAILURES) throw err;
                }
            }
        }

        // authFailed means the request never reached the model, so the normal
        // flow already errored out visibly. Nothing to recover.
        if (j.status === 'unknown' || j.authFailed) { clearPending(); return; }
        if (j.status !== 'done') {
            clearPending();
            toastr.warning(`백그라운드 생성 실패: ${j.error || j.status}`, 'Detached Gen');
            return;
        }

        const text = extractText(j.body);
        if (!text) {
            clearPending();
            toastr.warning('결과를 읽지 못했습니다.', 'Detached Gen');
            return;
        }

        clearPending();
        await c.saveReply({ type: 'normal', getMessage: text });
        toastr.success('백그라운드에서 생성된 답장을 가져왔습니다.', 'Detached Gen');
    } catch (err) {
        console.error('[detached-gen] recovery failed:', err);
    } finally {
        recovering = false;
    }
}

/* -------------------------------------------------------------------- panel */

const HTML = `
<div class="detached-gen-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>📵 백그라운드 생성 (Detached Gen)</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="dgen_note">
        화면을 벗어나도 생성이 끊기지 않게, 서버가 대신 답장을 만들고 폰은 결과만 받아옵니다.
        이 설정은 <b>이 기기에만</b> 적용됩니다.
      </div>
      <label class="checkbox_label" for="dgen_enabled">
        <input id="dgen_enabled" type="checkbox">
        <span>이 기기에서 켜기</span>
      </label>
      <div class="dgen_statusrow">
        <span id="dgen_status" class="dgen_status">…</span>
        <div id="dgen_refresh" class="menu_button">새로고침</div>
        <div id="dgen_selftest" class="menu_button">연결 테스트</div>
      </div>
      <div id="dgen_testresult" class="dgen_status" style="display:none"></div>
    </div>
  </div>
</div>`;

async function refreshStatus() {
    const el = document.getElementById('dgen_status');
    if (!el) return;
    try {
        const r = await origFetch(`${API}/status`, { headers: headers() });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const s = await r.json();
        el.textContent = `플러그인 v${s.version} · 진행 중 ${s.running}건`;
        el.classList.remove('dgen_bad');
    } catch (err) {
        el.textContent = `플러그인 응답 없음 (${err.message}) — 설치/재시작 확인`;
        el.classList.add('dgen_bad');
    }
}

/** Costs nothing but a round trip, so it's the first thing to try if replies break. */
async function runSelfTest() {
    const el = document.getElementById('dgen_testresult');
    el.style.display = '';
    el.textContent = '테스트 중…';
    el.classList.remove('dgen_bad', 'dgen_good');
    try {
        const r = await origFetch(`${API}/selftest`, { method: 'POST', headers: headers() });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const s = await r.json();
        el.textContent = (s.ok ? '✅ ' : '❌ ') + s.detail;
        el.classList.add(s.ok ? 'dgen_good' : 'dgen_bad');
    } catch (err) {
        el.textContent = `❌ 테스트 실패: ${err.message}`;
        el.classList.add('dgen_bad');
    }
}

export async function onActivate() {
    if (document.getElementById('dgen_enabled')) return; // already mounted
    const $c = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    $c.append(HTML);

    const box = document.getElementById('dgen_enabled');
    box.checked = isEnabled();
    box.addEventListener('change', () => {
        setEnabled(box.checked);
        toastr.info(box.checked ? '이 기기에서 켰습니다.' : '이 기기에서 껐습니다.', 'Detached Gen');
    });
    document.getElementById('dgen_refresh').addEventListener('click', refreshStatus);
    document.getElementById('dgen_selftest').addEventListener('click', runSelfTest);
    await refreshStatus();
}

/* --------------------------------------------------------------------- boot */

installPatch();

jQuery(async () => {
    const c = ctx();
    watchGenType(c);
    c.eventSource.on(c.eventTypes.CHAT_CHANGED, tryRecover);
    if (c.eventTypes.APP_READY) c.eventSource.on(c.eventTypes.APP_READY, tryRecover);
    // A page killed mid-generation reloads straight into its chat, and
    // CHAT_CHANGED may already have fired by the time we get here.
    setTimeout(tryRecover, 2000);
});
