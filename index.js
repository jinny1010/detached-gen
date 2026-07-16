/**
 * Detached Gen — SillyTavern server plugin
 *
 * Why this exists
 * ---------------
 * ST's chat-completion endpoint aborts the upstream API call as soon as the
 * client socket closes (src/endpoints/backends/chat-completions.js):
 *
 *     request.socket.removeAllListeners('close');
 *     request.socket.on('close', () => controller.abort());
 *
 * iOS suspends a home-screen web app within seconds of backgrounding, which
 * drops its socket — so any in-flight generation is destroyed server-side.
 *
 * This plugin removes the client from the critical path. The browser POSTs the
 * generation payload here, gets a jobId back immediately (socket closes at
 * once), and this plugin re-issues the request to ST's own endpoint from
 * inside the server process. That inner request's socket belongs to us and
 * never closes, so the abort-on-disconnect rule never fires. The browser then
 * polls for the result with short requests that are safe to interrupt.
 *
 * Routes are mounted at /api/plugins/detached-gen and sit behind ST's global
 * body parser, session, CSRF and login middleware (see src/server-main.js), so
 * the incoming request is already authenticated; we forward its cookie and CSRF
 * token on the inner call to inherit the same session.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PLUGIN_ID = 'detached-gen';
const VERSION = '1.0.0';
const JOBS_DIR = path.join(__dirname, 'jobs');

/** Only these may be targeted, so /start can't be used as a generic SSRF proxy. */
const ALLOWED_PATHS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
]);

const DONE_TTL_MS = 60 * 60 * 1000;      // keep a finished result available for an hour
const RUNNING_TIMEOUT_MS = 15 * 60 * 1000; // give up on a job that never returns
const GC_INTERVAL_MS = 5 * 60 * 1000;
const JOB_ID_RE = /^[0-9a-f-]{36}$/;

/** @type {Map<string, object>} jobId -> job */
const jobs = new Map();
let gcTimer = null;

function jobFile(id) {
    return path.join(JOBS_DIR, `${id}.json`);
}

/** Finished jobs go to disk so a server restart doesn't lose a completed reply. */
function persist(job) {
    try {
        fs.mkdirSync(JOBS_DIR, { recursive: true });
        const { controller, ...rest } = job;
        fs.writeFileSync(jobFile(job.id), JSON.stringify(rest));
    } catch (err) {
        console.error(`[${PLUGIN_ID}] persist ${job.id} failed:`, err.message);
    }
}

function loadFromDisk(id) {
    if (!JOB_ID_RE.test(id)) return null;
    try {
        if (!fs.existsSync(jobFile(id))) return null;
        return JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
    } catch {
        return null;
    }
}

function finish(job, status, patch) {
    if (job.finishedAt) return; // already settled (e.g. cancel raced the response)
    Object.assign(job, patch, { status, finishedAt: Date.now(), controller: null });
    persist(job);
    const ms = job.finishedAt - job.startedAt;
    console.log(`[${PLUGIN_ID}] job ${job.id} ${status} (${ms} ms)`);
}

/**
 * Re-issue the client's request from inside the server. Deliberately not
 * awaited by the route handler: the whole point is that nothing about this
 * call depends on the browser still being connected.
 */
function runJob(job, targetPath, payload, port, cookie, csrfToken) {
    const controller = new AbortController();
    job.controller = controller;

    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

    fetch(`http://127.0.0.1:${port}${targetPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
    }).then(async (res) => {
        const body = await res.text();
        if (res.status === 401 || res.status === 403) {
            // ST itself rejected us, so the forwarded session/CSRF headers
            // didn't take. Nothing reached the model, which makes it safe for
            // the client to retry the request directly.
            finish(job, 'error', {
                httpStatus: res.status,
                authFailed: true,
                error: `inner request rejected by ST (HTTP ${res.status}) — session/CSRF forwarding failed`,
            });
            return;
        }
        finish(job, res.ok ? 'done' : 'error', { httpStatus: res.status, body });
    }).catch((err) => {
        if (job.status === 'cancelled') return; // we aborted it on purpose
        finish(job, 'error', { httpStatus: 0, error: String(err?.message || err) });
    });
}

function gc() {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.status === 'running' && now - job.startedAt > RUNNING_TIMEOUT_MS) {
            try { job.controller?.abort(); } catch { /* already gone */ }
            finish(job, 'error', { error: `timed out after ${RUNNING_TIMEOUT_MS / 60000} min` });
        }
        if (job.finishedAt && now - job.finishedAt > DONE_TTL_MS) {
            jobs.delete(id);
            try { fs.unlinkSync(jobFile(id)); } catch { /* fine */ }
        }
    }
    // Sweep files left behind by a restart.
    try {
        for (const name of fs.readdirSync(JOBS_DIR)) {
            const fp = path.join(JOBS_DIR, name);
            if (now - fs.statSync(fp).mtimeMs > DONE_TTL_MS) fs.unlinkSync(fp);
        }
    } catch { /* dir may not exist yet */ }
}

async function init(router) {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    gcTimer = setInterval(gc, GC_INTERVAL_MS);
    if (gcTimer.unref) gcTimer.unref();

    router.get('/status', (_req, res) => {
        const running = [...jobs.values()].filter(j => j.status === 'running').length;
        res.json({ ok: true, id: PLUGIN_ID, version: VERSION, running, tracked: jobs.size });
    });

    router.post('/start', (req, res) => {
        const targetPath = String(req.body?.targetPath || '/api/backends/chat-completions/generate');
        if (!ALLOWED_PATHS.has(targetPath)) {
            return res.status(400).json({ error: `targetPath not allowed: ${targetPath}` });
        }
        const payload = req.body?.payload;
        if (!payload || typeof payload !== 'object') {
            return res.status(400).json({ error: 'payload required' });
        }
        if (payload.stream) {
            return res.status(400).json({ error: 'streaming is not supported by detached-gen' });
        }

        const id = crypto.randomUUID();
        const job = {
            id,
            status: 'running',
            startedAt: Date.now(),
            finishedAt: null,
            httpStatus: 0,
            body: null,
            error: null,
            authFailed: false,
            controller: null,
        };
        jobs.set(id, job);

        // Capture what the inner call needs before the socket goes away.
        runJob(job, targetPath, payload, req.socket.localPort || 8000,
            req.headers.cookie, req.headers['x-csrf-token']);

        res.json({ jobId: id });
    });

    router.get('/poll', (req, res) => {
        const id = String(req.query?.jobId || '');
        const job = jobs.get(id) || loadFromDisk(id);
        if (!job) return res.json({ status: 'unknown' });
        res.json({
            status: job.status,
            httpStatus: job.httpStatus,
            body: job.body,
            error: job.error,
            authFailed: !!job.authFailed,
            startedAt: job.startedAt,
        });
    });

    /**
     * Proves the inner-call mechanism end to end without spending a
     * generation: same header forwarding, aimed at a read-only endpoint that
     * is equally protected by session + CSRF. If this passes, /start will too.
     */
    router.post('/selftest', async (req, res) => {
        const port = req.socket.localPort || 8000;
        const headers = { 'Content-Type': 'application/json' };
        if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;
        if (req.headers['x-csrf-token']) headers['X-CSRF-Token'] = req.headers['x-csrf-token'];

        try {
            const r = await fetch(`http://127.0.0.1:${port}/api/settings/get`, {
                method: 'POST',
                headers,
                body: JSON.stringify({}),
                signal: AbortSignal.timeout(10000),
            });
            try { await r.body?.cancel(); } catch { /* only the status matters */ }
            res.json({
                ok: r.ok,
                httpStatus: r.status,
                detail: r.ok
                    ? '내부 호출이 세션·CSRF를 통과했습니다. 백그라운드 생성이 작동합니다.'
                    : `ST가 내부 호출을 거부했습니다 (HTTP ${r.status}).`,
            });
        } catch (err) {
            res.json({ ok: false, httpStatus: 0, detail: String(err?.message || err) });
        }
    });

    router.post('/cancel', (req, res) => {
        const job = jobs.get(String(req.body?.jobId || ''));
        if (!job) return res.status(404).json({ error: 'unknown job' });
        if (job.status === 'running') {
            job.status = 'cancelled';
            job.finishedAt = Date.now();
            try { job.controller?.abort(); } catch { /* already gone */ }
            job.controller = null;
            persist(job);
        }
        res.json({ ok: true, status: job.status });
    });

    console.log(`[${PLUGIN_ID}] plugin loaded (v${VERSION})`);
}

async function exit() {
    if (gcTimer) clearInterval(gcTimer);
    for (const job of jobs.values()) {
        try { job.controller?.abort(); } catch { /* shutting down */ }
    }
}

module.exports = {
    init,
    exit,
    info: {
        id: PLUGIN_ID,
        name: 'Detached Gen',
        description: 'Runs generation server-side so a suspended mobile client cannot abort it.',
    },
};
