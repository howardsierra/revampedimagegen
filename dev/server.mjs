// Dev harness server: serves a fake SillyTavern page, the extension, ST's image
// endpoints and a mock OpenAI-compatible image provider. No dependencies.
//
//   node dev/server.mjs            → http://localhost:8123
//   FA_DIR=/path/to/@fortawesome/fontawesome-free node dev/server.mjs   (optional icons)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'dev', '.tmp');
const PORT = Number(process.env.PORT) || 8123;
const FA_DIR = process.env.FA_DIR || '';
const EXT_PREFIX = '/scripts/extensions/third-party/revampedimagegen/';

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
    '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4',
};

// ---------------------------------------------------------------- tiny PNG encoder

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

function hsl(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
}

/** Gradient "artwork" seeded by the prompt so different prompts look different. */
function makePng(w, h, seedText) {
    let seed = 0;
    for (const ch of seedText) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const h1 = seed % 360;
    const h2 = (h1 + 60 + (seed >> 8) % 120) % 360;
    const cx = 0.3 + ((seed >> 4) % 40) / 100;
    const cy = 0.3 + ((seed >> 12) % 40) / 100;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 3 + 1)] = 0;
        for (let x = 0; x < w; x++) {
            const t = (x / w + y / h) / 2;
            const d = Math.hypot(x / w - cx, y / h - cy);
            const [r1, g1, b1] = hsl(h1, 0.65, 0.35 + 0.25 * (1 - d));
            const [r2, g2, b2] = hsl(h2, 0.7, 0.5);
            const ring = Math.sin(d * 28) > 0.92 ? 40 : 0;
            const o = y * (w * 3 + 1) + 1 + x * 3;
            raw[o] = Math.min(255, r1 * (1 - t) + r2 * t + ring);
            raw[o + 1] = Math.min(255, g1 * (1 - t) + g2 * t + ring);
            raw[o + 2] = Math.min(255, b1 * (1 - t) + b2 * t + ring);
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ---------------------------------------------------------------- helpers

function readBody(req) {
    return new Promise((resolve) => {
        const parts = [];
        req.on('data', d => parts.push(d));
        req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    });
}

function send(res, status, body, type = 'application/json') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveFile(res, file) {
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
}

const sanitize = s => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '_').slice(0, 120);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let rateLimitedOnce = false;
let lastRequest = null;

// ---------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = decodeURIComponent(url.pathname);

    if (p === '/' || p === '/index.html') return serveFile(res, path.join(ROOT, 'dev', 'harness.html'));
    if (p === '/harness.js') return serveFile(res, path.join(ROOT, 'dev', 'harness.js'));
    if (p.startsWith(EXT_PREFIX)) return serveFile(res, path.join(ROOT, p.slice(EXT_PREFIX.length)));
    if (p.startsWith('/fa/') && FA_DIR) return serveFile(res, path.join(FA_DIR, p.slice(4)));
    if (p.startsWith('/user/images/')) return serveFile(res, path.join(TMP, p));
    if (p.startsWith('/characters/')) return send(res, 200, makePng(256, 320, p), 'image/png');

    if (p === '/api/images/upload' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const rel = path.join('/user/images', sanitize(body.ch_name || ''), `${sanitize(body.filename || Date.now())}.${sanitize(body.format)}`);
        fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true });
        fs.writeFileSync(path.join(TMP, rel), Buffer.from(body.image, 'base64'));
        return send(res, 200, { path: rel.split(path.sep).join('/') });
    }
    if (p === '/api/images/delete' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const file = path.join(TMP, `/${body.path}`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return send(res, 200, 'OK', 'text/plain');
    }

    if (p === '/mock/_last') return send(res, 200, lastRequest || {});

    // Mock Gemini generateContent: answers with a small "thought" draft image, then the real one.
    const gem = /^\/mockgem\/v1beta\/models\/([^/:]+):generateContent$/.exec(p);
    if (gem && req.method === 'POST') {
        if (req.headers.authorization !== 'Bearer test-key') return send(res, 401, { error: { message: 'API key not valid' } });
        const body = JSON.parse(await readBody(req));
        const parts = body.contents?.[0]?.parts || [];
        lastRequest = {
            model: gem[1],
            generationConfig: body.generationConfig,
            texts: parts.filter(x => x.text).map(x => x.text),
            images: parts.filter(x => x.inlineData).length,
        };
        await sleep(600);
        const prompt = lastRequest.texts.join(' ');
        return send(res, 200, {
            candidates: [{
                content: {
                    parts: [
                        { text: 'Planning the composition…', thought: true },
                        { inlineData: { mimeType: 'image/png', data: makePng(32, 32, 'thought').toString('base64') }, thought: true },
                        { inlineData: { mimeType: 'image/png', data: makePng(300, 400, prompt).toString('base64') } },
                    ],
                },
                finishReason: 'STOP',
            }],
        });
    }

    // Mock OpenAI-compatible provider.
    if (p === '/mock/v1/models') {
        if (req.headers.authorization !== 'Bearer test-key') return send(res, 401, { error: { message: 'Invalid API key' } });
        return send(res, 200, { data: [{ id: 'mock-image-1' }, { id: 'gpt-image-1' }, { id: 'flux-dev' }, { id: 'some-chat-model' }] });
    }
    if (p === '/mock/v1/images/generations' && req.method === 'POST') {
        if (req.headers.authorization !== 'Bearer test-key') return send(res, 401, { error: { message: 'Invalid API key' } });
        const body = JSON.parse(await readBody(req));
        lastRequest = { ...body, image: Array.isArray(body.image) ? body.image.length : body.image ? 1 : 0 };
        const prompt = String(body.prompt || '');
        await sleep(Number(process.env.MOCK_DELAY) || 1200 + Math.random() * 1500);
        if (/\bfail\b/i.test(prompt)) return send(res, 400, { error: { message: 'Mock provider refused this prompt (contains "fail")' } });
        if (/\bratelimit\b/i.test(prompt) && !rateLimitedOnce) {
            rateLimitedOnce = true;
            res.setHeader('Retry-After', '1');
            return send(res, 429, { error: { message: 'Slow down' } });
        }
        const [w, h] = String(body.size || '1024x1024').split('x').map(n => Math.max(64, Math.round(Number(n) / 4)));
        return send(res, 200, { data: [{ b64_json: makePng(w, h, prompt).toString('base64') }] });
    }

    send(res, 404, { error: `no route ${p}` });
});

fs.mkdirSync(TMP, { recursive: true });
server.listen(PORT, () => console.log(`harness on http://localhost:${PORT}`));
