const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// --- ICE servers (STUN/TURN) for internet P2P, LAN preserved via STUN/host candidates ---
function getIceServers() {
    const ice = [];
    // STUN - configurable via STUN_URLS env (comma-separated), defaults to Google STUN
    const stunEnv = process.env.STUN_URLS;
    const stunUrls = stunEnv ? stunEnv.split(',').map(s=>s.trim()).filter(Boolean)
        : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
    for (const u of stunUrls) ice.push({ urls: u });

    // TURN - supports two modes:
    // 1) Static: TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
    // 2) Dynamic (coturn static-auth-secret): TURN_URLS + TURN_SECRET (+ TURN_USER, TURN_TTL)
    const turnUrlsEnv = process.env.TURN_URLS || process.env.TURN_URL;
    if (turnUrlsEnv) {
        const turnUrls = turnUrlsEnv.split(',').map(s=>s.trim()).filter(Boolean);
        const secret = process.env.TURN_SECRET;
        const ttl = parseInt(process.env.TURN_TTL || '86400', 10); // 24h
        if (secret) {
            const user = process.env.TURN_USER || 'pairdrop';
            const expiry = Math.floor(Date.now()/1000) + ttl;
            const username = `${expiry}:${user}`;
            const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
            for (const u of turnUrls) ice.push({ urls: u, username, credential });
        } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
            const username = process.env.TURN_USERNAME;
            const credential = process.env.TURN_CREDENTIAL;
            for (const u of turnUrls) ice.push({ urls: u, username, credential });
        }
    }
    return ice;
}

// Render-ready: trust proxy (Render terminates TLS at its edge proxy)
app.set('trust proxy', 1);

// Serve static files (long cache for assets, index.html never cached so
// clients always get the latest client.js after a Render redeploy)
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
    index: 'index.html',
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        }
    }
}));
app.use(express.json({ limit: '1mb' }));

// Health check (Render uses this path)
app.get('/health', (req, res) => res.json({ status: 'ok', peers: totalPeers(), rooms: rooms.size, uptime: Math.round(process.uptime()) }));

// Public client config: lets the UI honestly show P2P vs relay capability
app.get('/config', (req, res) => {
    const ice = getIceServers();
    const hasTurn = ice.some(s => s.urls && String(s.urls).includes('turn'));
    res.json({
        hasTurn,
        iceCount: ice.length,
        maxRoomSize: 50,
        relayChunkKB: 32,
        version: require('./package.json').version || '1.0.0'
    });
});

// ICE servers for WebRTC (LAN via STUN/host, internet via TURN when configured)
// Preserves LAN: returns STUN only when no TURN env set
app.get('/ice-servers', (req, res) => {
    res.json(getIceServers());
});
app.get('/turn-credentials', (req, res) => res.json(getIceServers())); // alias

// Fallback to index.html for SPA-like behavior (room handling via query params)
// NOTE: regex route works on both Express 4 and Express 5 (Render may install latest).
// `app.get('*')` crashes on Express 5 (path-to-regexp v8), so don't use it.
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
// Render sits behind a proxy that drops idle sockets — raise payload slightly
// for the WS relay fallback and enable keepalive below.
const wss = new WebSocket.Server({ server, maxPayload: 5 * 1024 * 1024 });

// --- Peer management ---
// rooms: Map<roomId, Map<peerId, peerInfo>>
const rooms = new Map();

const DISPLAY_NAMES_ADJ = ["Amber","Autumn","Azure","Banana","Berry","Blue","Brass","Bronze","Cedar","Cherry","Cobalt","Coral","Crimson","Crystal","Denim","Ebony","Emerald","Frost","Garnet","Golden","Graphite","Indigo","Ivory","Jade","Lavender","Lemon","Lime","Mango","Midnight","Mint","Ocean","Olive","Orange","Peach","Pearl","Plum","Ruby","Saffron","Sapphire","Scarlet","Silver","Snow","Sunset","Teal","Topaz","Turquoise","Violet"];
const DISPLAY_NAMES_NOUN = ["Alpaca","Badger","Bear","Beaver","Bison","Canary","Capybara","Cardinal","Cobra","Cougar","Coyote","Crow","Dingo","Dolphin","Dragon","Eagle","Elephant","Falcon","Ferret","Finch","Fox","Gecko","Giraffe","Gorilla","Hawk","Hedgehog","Hippo","Husky","Ibex","Iguana","Jaguar","Jay","Koala","Lemur","Leopard","Lynx","Macaw","Mantis","Moose","Narwhal","Ocelot","Otter","Owl","Panda","Panther","Parrot","Penguin","Puma","Raven","Seal","Shark","Tiger","Toucan","Turtle","Wolf","Zebra"];

function randomDisplayName() {
    const adj = DISPLAY_NAMES_ADJ[Math.floor(Math.random()*DISPLAY_NAMES_ADJ.length)];
    const noun = DISPLAY_NAMES_NOUN[Math.floor(Math.random()*DISPLAY_NAMES_NOUN.length)];
    return `${adj} ${noun}`;
}

function randomColor() {
    const colors = ["#3b82f6","#ef4444","#10b981","#f59e0b","#8b5cf6","#ec4899","#06b6d4","#f97316","#84cc16","#14b8a6"];
    return colors[Math.floor(Math.random()*colors.length)];
}

function getClientIp(req) {
    // Behind Render: X-Forwarded-For[0] is the real client IP.
    // Also respect Cloudflare headers if present.
    const cf = req.headers['cf-connecting-ip'];
    if (cf && typeof cf === 'string') return cf.trim();
    const tci = req.headers['true-client-ip'];
    if (tci && typeof tci === 'string') return tci.trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff && typeof xff === 'string') {
        const first = xff.split(',')[0].trim();
        if (first) return first;
    }
    const remote = (req.socket && req.socket.remoteAddress) || '';
    return remote.replace(/^::ffff:/, '').trim() || 'unknown';
}

function networkRoomForIp(ip) {
    const salt = process.env.NET_SALT || 'pairdrop-net-v1';
    const hash = crypto.createHash('sha256').update(salt + '|' + ip).digest('hex').slice(0, 10);
    return 'net-' + hash;
}

function sanitizeRoom(raw) {
    return (raw || '').replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 32);
}

function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    return rooms.get(roomId);
}

function totalPeers() {
    let c=0;
    for(const r of rooms.values()) c+= r.size;
    return c;
}

function getPeerInfo(peerId, roomId) {
    const room = rooms.get(roomId);
    if (!room) return null;
    return room.get(peerId);
}

function broadcastPeerList(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const peers = [];
    for (const [id, info] of room.entries()) {
        peers.push({ id: info.id, name: info.name, color: info.color, device: info.device });
    }
    const msg = JSON.stringify({ type: 'peers', peers });
    for (const [, info] of room.entries()) {
        if (info.ws.readyState === WebSocket.OPEN) info.ws.send(msg);
    }
}

function sendToPeer(roomId, targetId, data) {
    const room = rooms.get(roomId);
    if (!room) return false;
    const target = room.get(targetId);
    if (!target || target.ws.readyState !== WebSocket.OPEN) return false;
    target.ws.send(JSON.stringify(data));
    return true;
}

wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Room resolution (fixes "one global room" problem):
    // - If client passes ?room=xxx (private link/QR), join that private room.
    // - Otherwise auto-assign a same-network room derived from client public IP
    //   (hashed, never exposed). Devices on the same WiFi / same internet
    //   connection land in the same room; everyone else is isolated.
    // - Legacy ?room=public still works but is flagged so the UI can warn.
    let requestedRaw = '';
    try {
        const host = req.headers.host || 'localhost';
        const url = new URL(req.url || '/', `http://${host}`);
        requestedRaw = url.searchParams.get('room') || '';
    } catch { requestedRaw = ''; }
    const requested = sanitizeRoom(requestedRaw);
    let roomId, roomType, isLegacyPublic = false;
    if (requested) {
        roomId = requested;
        if (requested === 'public') {
            roomType = 'public-legacy';
            isLegacyPublic = true;
        } else {
            roomType = 'private';
        }
    } else {
        const ip = getClientIp(req);
        roomId = networkRoomForIp(ip);
        roomType = 'network';
    }

    const peerId = uuidv4().slice(0,8);
    let displayName = randomDisplayName();
    const color = randomColor();
    const ua = req.headers['user-agent'] || '';
    let device = 'Desktop';
    if (/mobile|android|iphone|ipad/i.test(ua)) device = 'Phone';
    else if (/tablet|ipad/i.test(ua)) device = 'Tablet';

    const room = getOrCreateRoom(roomId);
    if (room.size >= 50) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full (50 peers max)' }));
        ws.close(1013, 'Room full');
        return;
    }
    const peerInfo = { id: peerId, name: displayName, color, device, ws, roomId };
    room.set(peerId, peerInfo);

    console.log(`[+] ${displayName} (${peerId}) joined room "${roomId}" [${roomType}] | total in room: ${room.size}`);

    // Send init to this peer
    ws.send(JSON.stringify({
        type: 'init',
        id: peerId,
        name: displayName,
        color,
        device,
        roomId,
        roomType,
        sameNetwork: roomType === 'network',
        isLegacyPublic
    }));

    // Notify existing peers about new peer, and send peer list to all
    // Tell existing peers
    for (const [otherId, otherInfo] of room.entries()) {
        if (otherId === peerId) continue;
        if (otherInfo.ws.readyState === WebSocket.OPEN) {
            otherInfo.ws.send(JSON.stringify({
                type: 'peer-joined',
                peer: { id: peerId, name: displayName, color, device }
            }));
            // also tell new peer about existing
            ws.send(JSON.stringify({
                type: 'peer-joined',
                peer: { id: otherId, name: otherInfo.name, color: otherInfo.color, device: otherInfo.device }
            }));
        }
    }
    broadcastPeerList(roomId);

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        // Relay signals: { type: 'signal', target, signal: { type: offer/answer/candidate, sdp/candidate } }
        if (msg.type === 'signal' && msg.target && msg.signal) {
            const sent = sendToPeer(roomId, msg.target, {
                type: 'signal',
                sender: peerId,
                signal: msg.signal
            });
            if (!sent) {
                ws.send(JSON.stringify({ type: 'error', message: 'Peer not found' }));
            }
            return;
        }

        // Optional ping
        if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
        }

        // --- Consent handshake (relayed even when WebRTC DataChannel is down) ---
        // Sender asks first; receiver must Accept before any bytes flow.
        // This fixes "file got downloaded without consent".
        if (msg.type === 'transfer-offer' && msg.target && msg.id) {
            const name = String(msg.name || 'file').slice(0, 255);
            const size = Number(msg.size) || 0;
            if (size < 0 || size > 1024 * 1024 * 1024) return; // 1GB cap
            sendToPeer(roomId, msg.target, {
                type: 'transfer-offer',
                sender: peerId,
                senderName: peerInfo.name,
                id: String(msg.id).slice(0, 32),
                name,
                size,
                mime: String(msg.mime || 'application/octet-stream').slice(0, 128)
            });
            return;
        }
        if (msg.type === 'transfer-accept' && msg.target && msg.id) {
            sendToPeer(roomId, msg.target, {
                type: 'transfer-accept',
                sender: peerId,
                senderName: peerInfo.name,
                id: String(msg.id).slice(0, 32)
            });
            return;
        }
        if (msg.type === 'transfer-decline' && msg.target && msg.id) {
            sendToPeer(roomId, msg.target, {
                type: 'transfer-decline',
                sender: peerId,
                senderName: peerInfo.name,
                id: String(msg.id).slice(0, 32)
            });
            return;
        }
        if (msg.type === 'transfer-cancel' && msg.target && msg.id) {
            sendToPeer(roomId, msg.target, {
                type: 'transfer-cancel',
                sender: peerId,
                senderName: peerInfo.name,
                id: String(msg.id).slice(0, 32)
            });
            return;
        }

        // Text fallback via server relay (if WebRTC fails, can fallback to server)
        // Capped to 64KB to prevent abuse.
        if (msg.type === 'fallback-text' && msg.target && msg.text) {
            const text = String(msg.text).slice(0, 65536);
            if (!text) return;
            sendToPeer(roomId, msg.target, {
                type: 'fallback-text',
                sender: peerId,
                senderName: peerInfo.name,
                text
            });
            return;
        }
        // File fallback via server relay (when WebRTC DataChannel not available) - slower but reliable
        // NOTE: clients only send these AFTER the receiver accepts a transfer-offer.
        if (msg.type === 'fallback-file-header' && msg.target && msg.id) {
            const size = Number(msg.size) || 0;
            if (size < 0 || size > 1024 * 1024 * 1024) return;
            sendToPeer(roomId, msg.target, {
                type: 'fallback-file-header',
                sender: peerId,
                senderName: peerInfo.name,
                id: String(msg.id).slice(0, 32),
                name: String(msg.name || 'file').slice(0, 255),
                size,
                mime: String(msg.mime || 'application/octet-stream').slice(0, 128)
            });
            return;
        }
        if (msg.type === 'fallback-file-chunk' && msg.target && msg.id && msg.data) {
            sendToPeer(roomId, msg.target, {
                type: 'fallback-file-chunk',
                sender: peerId,
                id: msg.id,
                data: msg.data
            });
            return;
        }
        if (msg.type === 'fallback-file-complete' && msg.target && msg.id) {
            sendToPeer(roomId, msg.target, {
                type: 'fallback-file-complete',
                sender: peerId,
                id: msg.id
            });
            return;
        }

        // Update display name request
        if (msg.type === 'update-name' && msg.name) {
            const clean = String(msg.name).slice(0,20).replace(/[^a-zA-Z0-9 _-]/g,'');
            if (clean) {
                peerInfo.name = clean;
                displayName = clean;
                for (const [, otherInfo] of (rooms.get(roomId) || new Map()).entries()) {
                    if (otherInfo.ws.readyState === WebSocket.OPEN) {
                        otherInfo.ws.send(JSON.stringify({
                            type: 'peer-joined',
                            peer: { id: peerId, name: clean, color: peerInfo.color, device: peerInfo.device }
                        }));
                    }
                }
                broadcastPeerList(roomId);
            }
        }
    });

    ws.on('close', () => {
        const room = rooms.get(roomId);
        if (!room) return;
        room.delete(peerId);
        console.log(`[-] ${peerInfo.name} (${peerId}) left room "${roomId}" | remaining: ${room.size}`);
        if (room.size === 0) {
            rooms.delete(roomId);
        } else {
            for (const [, otherInfo] of room.entries()) {
                if (otherInfo.ws.readyState === WebSocket.OPEN) {
                    otherInfo.ws.send(JSON.stringify({ type: 'peer-left', peerId }));
                }
            }
            broadcastPeerList(roomId);
        }
    });

    ws.on('error', (e) => {
        console.error('ws error', e.message);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`PairDrop Clone listening on 0.0.0.0:${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
    const ice = getIceServers();
    const hasTurn = ice.some(s => s.urls && String(s.urls).includes('turn'));
    console.log(`ICE: ${ice.map(s=>s.urls).join(', ')}${hasTurn ? ' (+TURN ready for internet P2P)' : ' (STUN only - set TURN_URLS for reliable internet P2P)'}`);
});

// --- Render keepalive: proxy drops idle WS after ~60s. Ping every 30s. ---
const wsKeepAlive = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        try { ws.ping(); } catch {}
    });
}, 30000);
wss.on('close', () => clearInterval(wsKeepAlive));

// --- Render graceful shutdown: SIGTERM on deploy/scale ---
function shutdown(signal) {
    console.log(`Received ${signal}, shutting down...`);
    clearInterval(wsKeepAlive);
    wss.clients.forEach((ws) => { try { ws.close(1001, 'Server restarting'); } catch {} });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
