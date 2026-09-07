(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const peersGrid = $('#peersGrid');
  const emptyState = $('#emptyState');
  const peerCountEl = $('#peerCount');
  const youNameEl = $('#youName');
  const youDeviceEl = $('#youDevice');
  const youIdEl = $('#youId');
  const youAvatar = $('#youAvatar');
  const roomNameEl = $('#roomName');
  const roomHintEl = $('#roomHint');
  const roomBadgeEl = $('#roomBadge');
  const netBadgeEl = $('#netBadge');
  const connInfoEl = $('#connInfo');
  const legacyBannerEl = $('#legacyBanner');
  const footerHintEl = $('#footerHint');
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');
  const toasts = $('#toasts');
  const fileInput = $('#fileInput');
  const dropZone = $('#dropZone');
  const qrcodeEl = $('#qrcode');
  const qrLinkEl = $('#qrLink');
  const historySection = $('#historySection');
  const historyList = $('#historyList');
  const offerModalEl = $('#offerModal');
  const offerTitleEl = $('#offerTitle');
  const offerBodyEl = $('#offerBody');

  // ---------- State ----------
  let myId = null;
  let myName = localStorage.getItem('pd-name') || null;
  let myColor = '#3b82f6';
  let myDevice = 'Desktop';
  // requestedRoom: explicit ?room= in URL (private link). Empty => server assigns same-network room.
  function getRequestedRoom() {
    const r = new URLSearchParams(location.search).get('room') || '';
    return r.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 32);
  }
  let requestedRoom = getRequestedRoom();
  let roomId = requestedRoom || '…'; // actual room from server init
  let roomType = 'unknown';
  let sameNetwork = false;
  let isLegacyPublic = false;

  let ws = null;
  let wsConnected = false;
  const peers = new Map(); // peerId -> { info, pc, dc, connType, pendingReceives: Map, sendQueue, isInitiator, pendingCandidates }
  const relayFallbackPending = new Map(); // fileId -> {meta, buffers, received}
  const acceptedRelayIncoming = new Set(); // fileIds the user accepted via relay (header allowed)
  const outgoing = new Map(); // fileId -> {peerId, file, name, size, mime, status, timer, viaRelay}
  const incomingOffers = new Map(); // fileId -> {meta, senderId, senderName, viaRelay, entryOrNull}
  const incomingQueue = []; // ordered fileIds awaiting user decision
  let currentOfferId = null;
  const historyMeta = new Map(); // histId -> {name, mime}
  let targetPeerId = null;

  const CHUNK_SIZE = 64 * 1024;
  const OFFER_TIMEOUT_MS = 60000;
  const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  let ICE_SERVERS = [...DEFAULT_ICE_SERVERS];
  let HAS_TURN = false;

  async function fetchIceServers() {
    try {
      const r = await fetch('/ice-servers', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j) && j.length) {
          ICE_SERVERS = j;
          HAS_TURN = j.some(s => s.urls && String(s.urls).includes('turn'));
          console.log('[ICE] loaded', ICE_SERVERS, HAS_TURN ? '(TURN ready)' : '(STUN only)');
          updateConnInfo();
          return ICE_SERVERS;
        }
      }
    } catch (e) { console.warn('[ICE] fetch failed, using default STUN', e); }
    updateConnInfo();
    return ICE_SERVERS;
  }
  async function fetchConfig() {
    try {
      const r = await fetch('/config', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (typeof j.hasTurn === 'boolean') HAS_TURN = j.hasTurn;
        updateConnInfo();
      }
    } catch {}
  }
  function updateConnInfo() {
    if (!connInfoEl) return;
    if (HAS_TURN) {
      connInfoEl.textContent = 'P2P ready: STUN + TURN — direct LAN, internet P2P, and TURN relay available.';
    } else {
      connInfoEl.textContent = 'P2P: STUN only — same Wi-Fi is direct & fast; across networks it may use server relay. Admin: set TURN_URLS for better internet P2P.';
    }
    if (footerHintEl) {
      footerHintEl.textContent = HAS_TURN
        ? '🔒 Files go P2P when possible (direct LAN / internet / TURN). Server relay is only a fallback — the path is always labelled.'
        : '🔒 Files go directly via WebRTC when possible. Without TURN, cross-network transfers may use server relay (labelled). Same Wi-Fi stays direct.';
    }
  }

  const AVATARS = ["🦊","🐼","🦁","🐯","🐨","🦄","🐧","🐻","🐵","🐶","🐱","🐹","🦝","🦒","🦏","🦓","🐘","🦔","🐿️","🦫","🦡","🦦","🦥","🐝","🐙","🦑","🦀","🐬","🐳","🦈","🦭","🦧","🐊","🦎","🦘","🐆","🐅","🦌"];
  function avatarFor(peerId) {
    let h = 0; for (let c of String(peerId)) h += c.charCodeAt(0);
    return AVATARS[h % AVATARS.length];
  }

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    toasts.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(4px)'; el.style.transition = '.3s'; }, 2600);
    setTimeout(() => el.remove(), 3000);
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.08, ctx.currentTime);
      o.start();
      o.stop(ctx.currentTime + 0.18);
      setTimeout(() => ctx.close(), 400);
    } catch {}
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function formatSize(b) {
    b = Number(b) || 0;
    if (b === 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function newFileId() { return Math.random().toString(36).slice(2, 10); }
  function roomLink(id) { return location.origin + location.pathname + '?room=' + encodeURIComponent(id); }

  // ---------- Room UI ----------
  function updateRoomUI() {
    roomNameEl.textContent = roomId;
    if (qrLinkEl) qrLinkEl.textContent = roomType === 'network' || roomType === 'private' || roomType === 'public-legacy'
      ? roomLink(roomId) : location.href;
    if (!roomBadgeEl) return;
    roomBadgeEl.className = 'room-badge';
    if (roomType === 'network') {
      roomBadgeEl.textContent = 'Auto · Same network';
      roomHintEl.textContent = 'Only devices on the same Wi-Fi / internet connection can find you. Share a private link to connect across networks.';
    } else if (roomType === 'private') {
      roomBadgeEl.textContent = 'Private';
      roomBadgeEl.classList.add('priv');
      roomHintEl.textContent = 'Private room — only people with this link / QR can find you. Works across networks.';
    } else if (roomType === 'public-legacy') {
      roomBadgeEl.textContent = 'Public ⚠️';
      roomHintEl.textContent = 'Legacy public room — everyone on the internet can see you. Create a private room instead.';
    } else {
      roomBadgeEl.textContent = '…';
      roomHintEl.textContent = 'Connecting…';
    }
    if (netBadgeEl) netBadgeEl.style.display = sameNetwork ? '' : 'none';
    if (legacyBannerEl) legacyBannerEl.style.display = isLegacyPublic ? '' : 'none';
    const exitBtn = $('#btnExitRoom');
    if (exitBtn) exitBtn.style.display = (roomType === 'private' || roomType === 'public-legacy') ? '' : 'none';
    if (youIdEl && myId) youIdEl.textContent = `ID: ${myId} • Room: ${roomId}`;
  }

  function switchRoom(nextRequestedOrNull) {
    // nextRequestedOrNull: string room code, or null/'' for auto same-network room
    try { ws && ws.close(); } catch {}
    for (const [, p] of peers) { try { p.pc.close(); } catch {} }
    peers.clear();
    outgoing.clear();
    incomingOffers.clear();
    incomingQueue.length = 0;
    currentOfferId = null;
    relayFallbackPending.clear();
    updatePeerGrid();
    const url = new URL(location.href);
    if (nextRequestedOrNull) url.searchParams.set('room', nextRequestedOrNull);
    else url.searchParams.delete('room');
    history.replaceState(null, '', url.toString());
    requestedRoom = getRequestedRoom();
    roomId = requestedRoom || '…';
    roomType = 'unknown';
    updateRoomUI();
    connectWS();
  }

  function randomRoomCode() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    const buf = new Uint32Array(6);
    crypto.getRandomValues(buf);
    for (let i = 0; i < 6; i++) s += chars[buf[i] % chars.length];
    return s;
  }

  // ---------- Peer grid ----------
  function connLabel(t) {
    if (t === 'direct-lan') return ['⚡ Direct', 'direct'];
    if (t === 'p2p-internet') return ['🌐 P2P', 'internet'];
    if (t === 'relay-turn') return ['🔁 TURN relay', 'relay'];
    if (t === 'relay-server') return ['🔁 Server relay', 'relay'];
    return ['… Connecting', 'connecting'];
  }
  function updatePeerGrid() {
    const count = peers.size;
    peerCountEl.textContent = `${count} ${count === 1 ? 'device' : 'devices'} found`;
    if (count === 0) {
      emptyState.style.display = '';
      peersGrid.querySelectorAll('.peer-card').forEach(el => el.remove());
      return;
    }
    emptyState.style.display = 'none';
    peersGrid.querySelectorAll('.peer-card').forEach(el => el.remove());
    for (const [id, p] of peers) {
      const info = p.info;
      const connected = p.dc && p.dc.readyState === 'open';
      const [label, cls] = connLabel(p.connType || (connected ? 'p2p-internet' : 'connecting'));
      const card = document.createElement('div');
      card.className = 'peer-card';
      card.dataset.peerId = id;
      card.innerHTML = `
        <div class="peer-status" style="background:${connected ? '#10b981' : '#f59e0b'}"></div>
        <div class="peer-avatar" style="background:${escapeHtml(info.color)}">${avatarFor(id)}</div>
        <div class="peer-name">${escapeHtml(info.name)}</div>
        <div class="peer-device">${escapeHtml(info.device)}</div>
        <div class="peer-id">${escapeHtml(id)}</div>
        <div><span class="peer-conn ${cls}">${escapeHtml(label)}</span></div>
        <div class="peer-hint">${connected ? 'Tap to send' : 'Connecting…'}</div>
      `;
      card.addEventListener('click', () => openSendModal(id));
      peersGrid.appendChild(card);
    }
  }

  // ---------- WS signaling ----------
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    if (requestedRoom) return `${proto}://${location.host}/?room=${encodeURIComponent(requestedRoom)}`;
    return `${proto}://${location.host}/`; // no room => server assigns same-network room
  }
  function connectWS() {
    ws = new WebSocket(wsUrl());
    setStatus('connecting', 'Connecting to signaling server…');
    ws.onopen = () => {
      wsConnected = true;
      setStatus('on', 'Connected — discovering peers');
    };
    ws.onclose = () => {
      wsConnected = false;
      setStatus('off', 'Disconnected — reconnecting…');
      toast('Disconnected. Reconnecting…', 'error');
      for (const [, p] of peers) { try { p.pc.close(); } catch {} }
      peers.clear();
      updatePeerGrid();
      setTimeout(connectWS, 1500);
    };
    ws.onerror = () => { setStatus('off', 'Connection error'); };
    ws.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'init') {
        myId = msg.id;
        if (myName) {
          // restore saved name
          wsSend({ type: 'update-name', name: myName });
          youNameEl.textContent = myName;
        } else {
          myName = msg.name;
          youNameEl.textContent = myName;
        }
        myColor = msg.color;
        myDevice = msg.device;
        roomId = msg.roomId || requestedRoom || '…';
        roomType = msg.roomType || 'unknown';
        sameNetwork = !!msg.sameNetwork;
        isLegacyPublic = !!msg.isLegacyPublic;
        youDeviceEl.textContent = myDevice;
        youAvatar.style.background = myColor;
        youAvatar.textContent = avatarFor(myId);
        updateRoomUI();
        toast(roomType === 'network' ? 'Joined same-network room — nearby devices will appear' : 'Joined room: ' + roomId, 'success');
      } else if (msg.type === 'peers') {
        // full list sync — handled via peer-joined/left
      } else if (msg.type === 'peer-joined') {
        const peer = msg.peer;
        if (!peer || peer.id === myId) return;
        if (!myId) return;
        if (peers.has(peer.id)) {
          const existing = peers.get(peer.id);
          if (existing && ((existing.info.name && existing.info.name.startsWith('Peer ')) || existing.info.name === 'Unknown')) {
            existing.info.name = peer.name;
            existing.info.color = peer.color;
            existing.info.device = peer.device;
            updatePeerGrid();
          }
          return;
        }
        toast(`${peer.name} joined`, 'success');
        const isInitiator = myId < peer.id;
        await addPeer(peer, isInitiator);
      } else if (msg.type === 'peer-left') {
        const p = peers.get(msg.peerId);
        if (p) {
          toast(`${p.info.name} left`, '');
          try { p.pc.close(); } catch {}
          peers.delete(msg.peerId);
          updatePeerGrid();
        }
      } else if (msg.type === 'signal') {
        const sender = msg.sender;
        const signal = msg.signal;
        let p = peers.get(sender);
        if (!p) {
          const isOffer = signal.type === 'offer';
          const isInitiator = isOffer ? false : (myId ? myId < sender : false);
          const placeholder = { id: sender, name: 'Peer ' + String(sender).slice(0, 4), color: '#3b82f6', device: 'Device' };
          await addPeer(placeholder, isInitiator);
          p = peers.get(sender);
        }
        if (!p) return;
        await handleSignal(p, signal);
      } else if (msg.type === 'transfer-offer') {
        // consent request arriving via server relay (DC down or sender chose relay path)
        onIncomingOffer({ id: msg.id, name: msg.name, size: msg.size, mime: msg.mime }, msg.sender, msg.senderName || msg.sender, true, null);
      } else if (msg.type === 'transfer-accept') {
        onOutgoingAccepted(msg.id, true);
      } else if (msg.type === 'transfer-decline') {
        onOutgoingDeclined(msg.id, msg.senderName || 'Peer');
      } else if (msg.type === 'transfer-cancel') {
        onIncomingCancelled(msg.id);
      } else if (msg.type === 'fallback-text') {
        showReceivedText(msg.senderName || msg.sender, msg.text);
        addHistoryTextReceive(msg.senderName || msg.sender, msg.text);
      } else if (msg.type === 'fallback-file-header') {
        // Only honor if user accepted (new clients) OR legacy sender (no offer flow)
        const fileId = msg.id;
        if (!acceptedRelayIncoming.has(fileId)) {
          // Legacy sender that never sent an offer: fall back to old auto-receive
          // but ONLY if we never saw an offer for it. New senders always offer first.
          console.log('relay header without prior accept (legacy sender?) — auto-receiving', fileId);
        }
        const senderId = msg.sender || 'relay';
        const meta = { id: fileId, name: msg.name, size: msg.size, mime: msg.mime || 'application/octet-stream', sender: msg.senderName || msg.sender || 'Unknown', senderId };
        relayFallbackPending.set(fileId, { meta, buffers: [], received: 0, start: Date.now() });
        addHistoryReceiveStart(meta, 'relay');
        toast(`Receiving "${meta.name}" from ${meta.sender} via relay`, '');
      } else if (msg.type === 'fallback-file-chunk') {
        const pend = relayFallbackPending.get(msg.id);
        if (!pend) return;
        try {
          const binary = atob(msg.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          pend.buffers.push(bytes.buffer);
          pend.received += bytes.byteLength;
          updateHistoryProgress(msg.id, pend.received, pend.meta.size);
        } catch (e) { console.warn('relay chunk decode failed', e); }
      } else if (msg.type === 'fallback-file-complete') {
        const pend = relayFallbackPending.get(msg.id);
        if (!pend) return;
        const blob = new Blob(pend.buffers, { type: pend.meta.mime });
        const url = URL.createObjectURL(blob);
        finalizeHistoryReceive(pend.meta.id, url, blob, 'relay');
        showReceiveFile(pend.meta, url, blob, 'relay');
        relayFallbackPending.delete(msg.id);
        acceptedRelayIncoming.delete(msg.id);
      }
    };
  }

  function setStatus(state, text) {
    statusText.textContent = text;
    statusDot.className = 'status-dot ' + state;
  }

  // ---------- WebRTC ----------
  async function addPeer(peerInfo, isInitiator) {
    if (peers.has(peerInfo.id)) return peers.get(peerInfo.id);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { info: peerInfo, pc, dc: null, connType: 'connecting', pendingReceives: new Map(), sendQueue: [], isInitiator, pendingCandidates: [] };
    peers.set(peerInfo.id, entry);
    updatePeerGrid();

    pc.onicecandidate = (e) => {
      if (e.candidate) wsSend({ type: 'signal', target: peerInfo.id, signal: { type: 'candidate', candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      updatePeerGrid();
      if (pc.connectionState === 'failed' && entry.isInitiator && pc.signalingState === 'stable') {
        pc.restartIce?.();
        pc.createOffer({ iceRestart: true }).then(offer => pc.setLocalDescription(offer)).then(() => {
          wsSend({ type: 'signal', target: peerInfo.id, signal: { type: 'offer', sdp: pc.localDescription } });
        }).catch(e => console.error(e));
      }
      if (pc.connectionState === 'connected') {
        detectConnType(entry);
        toast(`Connected to ${entry.info.name}`, 'success');
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') detectConnType(entry);
    };
    pc.ondatachannel = (e) => setupDataChannel(entry, e.channel);

    if (isInitiator) {
      try {
        const dc = pc.createDataChannel('pairdrop', { ordered: true });
        setupDataChannel(entry, dc);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        wsSend({ type: 'signal', target: peerInfo.id, signal: { type: 'offer', sdp: pc.localDescription } });
      } catch (e) { console.error('offer create failed', e); }
    }
    return entry;
  }

  async function detectConnType(entry) {
    try {
      const stats = await entry.pc.getStats();
      let pair = null;
      stats.forEach(s => {
        if (s.type === 'candidate-pair' && (s.nominated || s.selected)) {
          if (!pair || (s.nominated && !pair.nominated)) pair = s;
        }
      });
      if (!pair) { // fallback: any succeeded pair
        stats.forEach(s => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && !pair) pair = s; });
      }
      if (!pair) return;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const t = (c) => c && c.candidateType;
      if (t(local) === 'relay' || t(remote) === 'relay') entry.connType = 'relay-turn';
      else if (t(local) === 'host' && t(remote) === 'host') entry.connType = 'direct-lan';
      else entry.connType = 'p2p-internet';
      console.log('[conn]', entry.info.id, entry.connType, local, remote);
      updatePeerGrid();
    } catch (e) { console.warn('getStats failed', e); }
  }

  function setupDataChannel(entry, dc) {
    entry.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onopen = () => {
      updatePeerGrid();
      detectConnType(entry);
      if (entry.sendQueue.length) {
        const q = [...entry.sendQueue];
        entry.sendQueue = [];
        q.forEach(fn => fn());
      }
    };
    dc.onclose = () => updatePeerGrid();
    dc.onerror = (e) => console.error('dc error', e);
    dc.onmessage = (e) => handleDataMessage(entry, e.data);
  }

  async function handleSignal(entry, signal) {
    const pc = entry.pc;
    try {
      if (signal.type === 'offer') {
        const offerCollision = pc.signalingState !== 'stable';
        const isPolite = !entry.isInitiator;
        if (offerCollision && !isPolite) return;
        if (offerCollision && isPolite) {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
          ]).catch(async () => { await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp)); });
        } else {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        }
        if (entry.pendingCandidates.length) {
          for (const c of entry.pendingCandidates) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          entry.pendingCandidates = [];
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        wsSend({ type: 'signal', target: entry.info.id, signal: { type: 'answer', sdp: pc.localDescription } });
      } else if (signal.type === 'answer') {
        try { await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp)); }
        catch (e) { console.warn('setRemote answer failed', e); }
        if (entry.pendingCandidates.length) {
          for (const c of entry.pendingCandidates) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          entry.pendingCandidates = [];
        }
      } else if (signal.type === 'candidate') {
        if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        else entry.pendingCandidates.push(signal.candidate);
      }
    } catch (err) { console.error('signal error', err); }
  }

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function dcSend(entry, obj) {
    if (entry.dc && entry.dc.readyState === 'open') {
      entry.dc.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  // ---------- Consent: incoming ----------
  function onIncomingOffer(meta, senderId, senderName, viaRelay, entry) {
    const fileId = String(meta.id || newFileId()).slice(0, 32);
    meta = { id: fileId, name: String(meta.name || 'file').slice(0, 255), size: Number(meta.size) || 0, mime: String(meta.mime || 'application/octet-stream').slice(0, 128), sender: senderName, senderId };
    if (incomingOffers.has(fileId)) return;
    incomingOffers.set(fileId, { meta, senderId, senderName, viaRelay, entry });
    incomingQueue.push(fileId);
    beep();
    renderOfferModal();
    // flash title
    const orig = document.title;
    document.title = `📥 File from ${senderName} — ${orig}`;
    setTimeout(() => { document.title = orig; }, 4000);
  }

  function renderOfferModal() {
    if (currentOfferId && incomingOffers.has(currentOfferId)) return; // already showing one
    const nextId = incomingQueue.find(id => incomingOffers.has(id));
    if (!nextId) {
      currentOfferId = null;
      if (offerModalEl) offerModalEl.classList.remove('open');
      return;
    }
    currentOfferId = nextId;
    const { meta, viaRelay } = incomingOffers.get(nextId);
    offerTitleEl.textContent = `Incoming file from ${meta.sender}`;
    const icon = meta.mime.startsWith('image/') ? '🖼️' : meta.mime.startsWith('video/') ? '🎬' : meta.mime.startsWith('audio/') ? '🎵' : '📄';
    offerBodyEl.innerHTML = `
      <div class="offer-file">
        <div class="receive-icon">${icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;word-break:break-word">${escapeHtml(meta.name)}</div>
          <div style="font-size:12px;color:var(--muted)">${formatSize(meta.size)} • ${escapeHtml(meta.mime)} • via ${viaRelay ? 'server relay' : 'direct P2P'}</div>
          ${incomingQueue.length > 1 ? `<div style="font-size:11px;color:#60a5fa;margin-top:4px">+${incomingQueue.length - 1} more waiting</div>` : ''}
        </div>
      </div>
      <div class="offer-actions">
        <button class="btn btn-primary" id="btnAcceptOffer" style="flex:1;justify-content:center">✓ Accept</button>
        <button class="btn btn-secondary" id="btnDeclineOffer" style="flex:1;justify-content:center">✕ Decline</button>
      </div>
      <p class="offer-note">Nothing is downloaded until you press Accept. Declining tells the sender immediately — no data is transferred.</p>
    `;
    offerBodyEl.querySelector('#btnAcceptOffer').addEventListener('click', () => acceptOffer(nextId));
    offerBodyEl.querySelector('#btnDeclineOffer').addEventListener('click', () => declineOffer(nextId));
    openModal('offerModal');
  }

  function acceptOffer(fileId) {
    const offer = incomingOffers.get(fileId);
    if (!offer) return;
    const { meta, senderId, viaRelay, entry } = offer;
    incomingOffers.delete(fileId);
    const qi = incomingQueue.indexOf(fileId);
    if (qi >= 0) incomingQueue.splice(qi, 1);
    if (currentOfferId === fileId) currentOfferId = null;
    // allow relay header now
    acceptedRelayIncoming.add(fileId);
    // tell sender
    if (entry && entry.dc && entry.dc.readyState === 'open') {
      try { entry.dc.send(JSON.stringify({ type: 'file-accept', id: fileId })); } catch {}
    } else {
      wsSend({ type: 'transfer-accept', target: senderId, id: fileId });
    }
    toast(`Accepted "${meta.name}" — receiving…`, 'success');
    // history placeholder (progress updates arrive via header/chunks)
    // actual history entry is created on header; create a lightweight one now if none
    renderOfferModal();
  }

  function declineOffer(fileId) {
    const offer = incomingOffers.get(fileId);
    if (!offer) return;
    const { meta, senderId, entry } = offer;
    incomingOffers.delete(fileId);
    const qi = incomingQueue.indexOf(fileId);
    if (qi >= 0) incomingQueue.splice(qi, 1);
    if (currentOfferId === fileId) currentOfferId = null;
    if (entry && entry.dc && entry.dc.readyState === 'open') {
      try { entry.dc.send(JSON.stringify({ type: 'file-decline', id: fileId })); } catch {}
    } else {
      wsSend({ type: 'transfer-decline', target: senderId, id: fileId });
    }
    toast(`Declined "${meta.name}"`, '');
    renderOfferModal();
  }

  function onIncomingCancelled(fileId) {
    // sender cancelled while we were deciding
    if (incomingOffers.has(fileId)) {
      const { meta } = incomingOffers.get(fileId);
      incomingOffers.delete(fileId);
      const qi = incomingQueue.indexOf(fileId);
      if (qi >= 0) incomingQueue.splice(qi, 1);
      if (currentOfferId === fileId) { currentOfferId = null; renderOfferModal(); }
      toast(`Sender cancelled "${meta.name}"`, 'error');
    }
    // also abort active receive if already accepted
    for (const [, p] of peers) {
      if (p.pendingReceives.has(fileId)) {
        p.pendingReceives.delete(fileId);
        const el = document.getElementById('hist-' + fileId);
        if (el) el.querySelector('.h-progress').textContent = '✕ Cancelled by sender';
      }
    }
    if (relayFallbackPending.has(fileId)) {
      relayFallbackPending.delete(fileId);
      const el = document.getElementById('hist-' + fileId);
      if (el) el.querySelector('.h-progress').textContent = '✕ Cancelled by sender';
    }
  }

  // ---------- Consent: outgoing ----------
  async function sendFiles(peerId, files) {
    const entry = peers.get(peerId);
    if (!entry) { toast('Peer not found', 'error'); return; }
    for (const file of files) {
      if (file.size > 1024 * 1024 * 1024) { toast(`"${file.name}" exceeds 1GB limit`, 'error'); continue; }
      const fileId = newFileId();
      const offer = { id: fileId, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' };
      outgoing.set(fileId, { peerId, file, name: file.name, size: file.size, mime: offer.mime, status: 'offered', timer: null, viaRelay: false });
      // send offer: prefer DataChannel, else WS relay
      const viaDC = dcSend(entry, { type: 'file-offer', ...offer });
      if (!viaDC) {
        outgoing.get(fileId).viaRelay = true; // may switch to P2P later at accept-time if DC opens
        wsSend({ type: 'transfer-offer', target: peerId, ...offer });
      }
      addHistorySendWaiting({ id: fileId, name: file.name, size: file.size, target: entry.info.name });
      toast(`Waiting for ${entry.info.name} to accept "${file.name}"…`, '');
      // timeout
      outgoing.get(fileId).timer = setTimeout(() => {
        const o = outgoing.get(fileId);
        if (o && o.status === 'offered') {
          o.status = 'cancelled';
          cancelOutgoing(fileId, true);
          toast(`No response for "${o.name}" — request timed out`, 'error');
        }
      }, OFFER_TIMEOUT_MS);
    }
  }

  function cancelOutgoing(fileId, silent) {
    const o = outgoing.get(fileId);
    if (!o) return;
    if (o.timer) clearTimeout(o.timer);
    o.status = 'cancelled';
    const entry = peers.get(o.peerId);
    if (entry && entry.dc && entry.dc.readyState === 'open') {
      try { entry.dc.send(JSON.stringify({ type: 'file-cancel', id: fileId })); } catch {}
      try { entry.dc.send(JSON.stringify({ type: 'transfer-cancel', id: fileId })); } catch {}
    }
    wsSend({ type: 'transfer-cancel', target: o.peerId, id: fileId });
    const el = document.getElementById('hist-' + fileId);
    if (el) {
      const t = el.querySelector('.h-progress');
      if (t) t.textContent = '✕ Cancelled';
      const btn = el.querySelector('.cancel-btn');
      if (btn) btn.remove();
    }
    outgoing.delete(fileId);
    if (!silent) toast(`Cancelled "${o.name}"`, '');
  }

  function onOutgoingAccepted(fileId, viaSignaling) {
    const o = outgoing.get(fileId);
    if (!o || o.status !== 'offered') return;
    if (o.timer) clearTimeout(o.timer);
    const entry = peers.get(o.peerId);
    if (!entry) { outgoing.delete(fileId); return; }
    // Decide best path NOW (DC may have opened since offer)
    const dcOpen = entry.dc && entry.dc.readyState === 'open';
    o.viaRelay = !dcOpen;
    if (dcOpen) {
      o.status = 'sending';
      updateHistoryToSending(o);
      streamFileP2P(entry, o);
    } else {
      o.status = 'sending';
      updateHistoryToSending(o);
      streamFileRelay(o);
    }
  }

  function onOutgoingDeclined(fileId, byName) {
    const o = outgoing.get(fileId);
    if (!o) return;
    if (o.timer) clearTimeout(o.timer);
    const el = document.getElementById('hist-' + fileId);
    if (el) {
      const t = el.querySelector('.h-progress');
      if (t) t.textContent = `✕ Declined by ${byName}`;
      el.style.borderColor = '#ef444455';
      const btn = el.querySelector('.cancel-btn');
      if (btn) btn.remove();
    }
    toast(`"${o.name}" declined by ${byName}`, 'error');
    outgoing.delete(fileId);
  }

  // ---------- Streaming ----------
  async function streamFileP2P(entry, o) {
    const dc = entry.dc;
    const fileId = o.id;
    try {
      dc.send(JSON.stringify({ type: 'header', id: fileId, name: o.name, size: o.size, mime: o.mime }));
    } catch (e) {
      console.error('dc header failed, falling back to relay', e);
      return streamFileRelay(o);
    }
    let offset = 0;
    try {
      while (offset < o.file.size) {
        if (!outgoing.has(fileId)) return; // cancelled
        const slice = o.file.slice(offset, offset + CHUNK_SIZE);
        const buf = await slice.arrayBuffer();
        while (dc.bufferedAmount > 512 * 1024) {
          await new Promise(r => {
            const onLow = () => { dc.removeEventListener('bufferedamountlow', onLow); r(); };
            dc.addEventListener('bufferedamountlow', onLow);
            setTimeout(() => { try { dc.removeEventListener('bufferedamountlow', onLow); } catch {} r(); }, 250);
          });
        }
        dc.send(buf);
        offset += buf.byteLength;
        updateHistoryProgress(fileId, offset, o.size);
        if (offset % (256 * 1024) === 0) await new Promise(r => setTimeout(r, 0));
      }
      dc.send(JSON.stringify({ type: 'file-complete', id: fileId }));
      finalizeHistorySend(fileId, 'P2P');
      toast(`Sent "${o.name}" to ${entry.info.name} (P2P)`, 'success');
    } catch (e) {
      console.error('P2P send failed', e);
      toast('P2P send failed, trying relay…', 'error');
      return streamFileRelay(o);
    }
    outgoing.delete(fileId);
  }

  async function streamFileRelay(o) {
    const fileId = o.id;
    const entry = peers.get(o.peerId);
    const peerName = entry ? entry.info.name : 'peer';
    wsSend({ type: 'fallback-file-header', target: o.peerId, id: fileId, name: o.name, size: o.size, mime: o.mime });
    let offset = 0;
    while (offset < o.file.size) {
      if (!outgoing.has(fileId)) return; // cancelled
      const slice = o.file.slice(offset, offset + 32 * 1024);
      const buf = await slice.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      wsSend({ type: 'fallback-file-chunk', target: o.peerId, id: fileId, data: btoa(binary) });
      offset += buf.byteLength;
      updateHistoryProgress(fileId, offset, o.size);
      await new Promise(r => setTimeout(r, 10));
    }
    wsSend({ type: 'fallback-file-complete', target: o.peerId, id: fileId });
    finalizeHistorySend(fileId, 'relay');
    toast(`Sent "${o.name}" to ${peerName} via relay`, 'success');
    outgoing.delete(fileId);
  }

  function sendText(peerId, text) {
    const entry = peers.get(peerId);
    if (!entry) { toast('Peer not found', 'error'); return; }
    const payload = JSON.stringify({ type: 'text', text, id: newFileId() });
    if (entry.dc && entry.dc.readyState === 'open') {
      entry.dc.send(payload);
      toast(`Text sent to ${entry.info.name}`, 'success');
      addHistoryTextSend(entry.info.name, text);
    } else {
      wsSend({ type: 'fallback-text', target: peerId, text });
      toast(`Text sent via relay to ${entry.info.name}`, 'success');
      addHistoryTextSend(entry.info.name, text + ' (relay)');
    }
  }

  // ---------- DataChannel inbound ----------
  function handleDataMessage(entry, data) {
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'file-offer') {
        onIncomingOffer(msg, entry.info.id, entry.info.name, false, entry);
      } else if (msg.type === 'file-accept') {
        onOutgoingAccepted(msg.id, false);
      } else if (msg.type === 'file-decline') {
        onOutgoingDeclined(msg.id, entry.info.name);
      } else if (msg.type === 'file-cancel' || msg.type === 'transfer-cancel') {
        onIncomingCancelled(msg.id);
      } else if (msg.type === 'header' || (msg.id && msg.name != null && msg.size != null && typeof msg.type === 'string' && msg.type.includes('/') && !['file-complete', 'text'].includes(msg.type))) {
        // header should only arrive AFTER accept (new clients). Legacy senders skip the offer —
        // accept those for backwards compat but log it.
        const fileId = msg.id;
        const mime = msg.mime || (msg.type !== 'header' ? msg.type : null) || 'application/octet-stream';
        const knownOffer = acceptedRelayIncoming.has(fileId) || true; // P2P path: offer came over same DC
        const meta = { id: fileId, name: msg.name, size: msg.size, mime, sender: entry.info.name, senderId: entry.info.id };
        if (!entry.pendingReceives.has(fileId)) {
          entry.pendingReceives.set(fileId, { meta, buffers: [], received: 0, start: Date.now() });
          // if there's a history "waiting" entry it was ours; for receives create progress entry
          if (!document.getElementById('hist-' + fileId)) addHistoryReceiveStart(meta, 'P2P');
          else updateHistoryMethod(fileId, 'P2P');
        }
      } else if (msg.type === 'file-complete') {
        const pend = entry.pendingReceives.get(msg.id);
        if (!pend) return;
        const blob = new Blob(pend.buffers, { type: pend.meta.mime });
        const url = URL.createObjectURL(blob);
        finalizeHistoryReceive(pend.meta.id, url, blob, 'P2P');
        showReceiveFile(pend.meta, url, blob, 'P2P');
        entry.pendingReceives.delete(msg.id);
      } else if (msg.type === 'text') {
        showReceivedText(entry.info.name, msg.text);
        addHistoryTextReceive(entry.info.name, msg.text);
      }
    } else {
      let active = null;
      for (const v of entry.pendingReceives.values()) {
        if (v.received < v.meta.size) { active = v; break; }
      }
      if (!active) return;
      active.buffers.push(data);
      active.received += data.byteLength;
      updateHistoryProgress(active.meta.id, active.received, active.meta.size);
    }
  }

  // ---------- History UI ----------
  function ensureHistoryVisible() { historySection.style.display = ''; }
  function addHistorySendWaiting(meta) {
    ensureHistoryVisible();
    historyMeta.set(meta.id, { name: meta.name, mime: '' });
    const el = document.createElement('div');
    el.className = 'history-item';
    el.id = 'hist-' + meta.id;
    el.innerHTML = `
      <div class="h-icon">⏳</div>
      <div style="flex:1">
        <div style="font-weight:600">${escapeHtml(meta.name)} <span style="color:var(--muted);font-weight:400">→ ${escapeHtml(meta.target)}</span></div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
          <span class="h-progress" style="font-size:11px;color:#f59e0b">Waiting for accept…</span>
          <button class="link-btn cancel-btn">Cancel</button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--muted)">${formatSize(meta.size)}</div>
    `;
    el.querySelector('.cancel-btn').addEventListener('click', () => cancelOutgoing(meta.id));
    historyList.prepend(el);
  }
  function updateHistoryToSending(o) {
    const el = document.getElementById('hist-' + o.id);
    if (!el) { addHistorySendStart({ id: o.id, name: o.name, size: o.size, target: (peers.get(o.peerId) || {}).info?.name || 'peer' }, o.viaRelay ? 'relay' : 'P2P'); return; }
    el.querySelector('.h-icon').textContent = '📤';
    const prog = el.querySelector('.h-progress');
    if (prog) {
      prog.outerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-top:6px"><div class="progress"><div class="progress-bar" style="width:0%"></div></div><span class="h-progress" style="font-size:11px;color:var(--muted)">0%</span></div>`;
    }
  }
  function addHistorySendStart(meta, method) {
    ensureHistoryVisible();
    if (document.getElementById('hist-' + meta.id)) { updateHistoryMethod(meta.id, method); return; }
    historyMeta.set(meta.id, { name: meta.name, mime: '' });
    const el = document.createElement('div');
    el.className = 'history-item';
    el.id = 'hist-' + meta.id;
    el.innerHTML = `
      <div class="h-icon">📤</div>
      <div style="flex:1">
        <div style="font-weight:600">${escapeHtml(meta.name)} <span style="color:var(--muted);font-weight:400">→ ${escapeHtml(meta.target)}${method ? ` <small style="opacity:.7">(${escapeHtml(method)})</small>` : ''}</span></div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
          <div class="progress"><div class="progress-bar" style="width:0%"></div></div>
          <span class="h-progress" style="font-size:11px;color:var(--muted)">0%</span>
        </div>
      </div>
      <div style="font-size:11px;color:var(--muted)">${formatSize(meta.size)}</div>
    `;
    historyList.prepend(el);
  }
  function addHistoryReceiveStart(meta, method) {
    ensureHistoryVisible();
    historyMeta.set(meta.id, { name: meta.name, mime: meta.mime });
    if (document.getElementById('hist-' + meta.id)) { updateHistoryMethod(meta.id, method); return; }
    const el = document.createElement('div');
    el.className = 'history-item';
    el.id = 'hist-' + meta.id;
    el.innerHTML = `
      <div class="h-icon">📥</div>
      <div style="flex:1">
        <div style="font-weight:600">${escapeHtml(meta.name)} <span style="color:var(--muted);font-weight:400">from ${escapeHtml(meta.sender)}${method ? ` <small style="opacity:.7">(${escapeHtml(method)})</small>` : ''}</span></div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
          <div class="progress"><div class="progress-bar" style="width:0%"></div></div>
          <span class="h-progress" style="font-size:11px;color:var(--muted)">0%</span>
        </div>
      </div>
      <div style="font-size:11px;color:var(--muted)">${formatSize(meta.size)}</div>
    `;
    historyList.prepend(el);
  }
  function updateHistoryMethod(id, method) {
    const el = document.getElementById('hist-' + id);
    if (!el || !method) return;
    const title = el.querySelector('div div');
    if (title && !title.textContent.includes('(' + method + ')')) title.innerHTML += ` <small style="opacity:.7">(${escapeHtml(method)})</small>`;
  }
  function updateHistoryProgress(id, received, total) {
    const el = document.getElementById('hist-' + id);
    if (!el) return;
    const pct = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
    const bar = el.querySelector('.progress-bar');
    if (bar) bar.style.width = pct + '%';
    const txt = el.querySelector('.h-progress');
    if (txt) txt.textContent = pct + '% • ' + formatSize(received) + '/' + formatSize(total);
  }
  function finalizeHistorySend(id, method) {
    updateHistoryProgress(id, 1, 1);
    const el = document.getElementById('hist-' + id);
    if (el) {
      const t = el.querySelector('.h-progress');
      if (t) t.textContent = `✓ Sent${method ? ' (' + method + ')' : ''}`;
      el.style.borderColor = '#10b98144';
      const btn = el.querySelector('.cancel-btn');
      if (btn) btn.remove();
    }
  }
  function finalizeHistoryReceive(id, url, blob, method) {
    const el = document.getElementById('hist-' + id);
    const stored = historyMeta.get(id) || {};
    const fname = stored.name || 'download';
    if (el) {
      const t = el.querySelector('.h-progress');
      if (t) t.textContent = `✓ Received${method ? ' (' + method + ')' : ''}`;
      el.style.borderColor = '#10b98144';
      if (!el.querySelector('.dl-btn')) {
        const btn = document.createElement('a');
        btn.href = url;
        btn.download = fname;
        btn.className = 'btn btn-primary dl-btn';
        btn.style.cssText = 'padding:6px 10px;font-size:12px';
        btn.textContent = '⬇ Download';
        btn.addEventListener('click', () => toast('Download started', 'success'));
        el.appendChild(btn);
      } else {
        el.querySelector('.dl-btn').download = fname;
      }
    }
  }
  function addHistoryTextSend(target, text) {
    ensureHistoryVisible();
    const el = document.createElement('div');
    el.className = 'history-item';
    el.innerHTML = `
      <div class="h-icon">💬</div>
      <div style="flex:1">
        <div style="font-weight:600">Text → ${escapeHtml(target)}</div>
        <div style="color:#cbd5e1;background:#1e293b;padding:8px;border-radius:8px;margin-top:6px;word-break:break-word;font-size:12px">${escapeHtml(text)}</div>
      </div>
      <button class="link-btn">Copy</button>
    `;
    el.querySelector('.link-btn').addEventListener('click', async (ev) => {
      try { await navigator.clipboard.writeText(text); ev.target.textContent = 'Copied!'; } catch {}
    });
    historyList.prepend(el);
  }
  function addHistoryTextReceive(sender, text) {
    ensureHistoryVisible();
    const el = document.createElement('div');
    el.className = 'history-item';
    el.style.borderColor = '#3b82f644';
    el.innerHTML = `
      <div class="h-icon">💬</div>
      <div style="flex:1">
        <div style="font-weight:600">Text from ${escapeHtml(sender)}</div>
        <div style="color:#cbd5e1;background:#1e293b;padding:8px;border-radius:8px;margin-top:6px;word-break:break-word;font-size:12px">${escapeHtml(text)}</div>
      </div>
      <button class="link-btn">Copy</button>
    `;
    el.querySelector('.link-btn').addEventListener('click', async (ev) => {
      try { await navigator.clipboard.writeText(text); ev.target.textContent = 'Copied!'; } catch {}
    });
    historyList.prepend(el);
  }

  // ---------- Modals ----------
  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }
  $$('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.close;
      // declining via X on offer modal = decline current offer
      if (id === 'offerModal' && currentOfferId) { declineOffer(currentOfferId); return; }
      closeModal(id);
    });
  });
  $$('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', (e) => {
      if (e.target === ov) {
        if (ov.id === 'offerModal' && currentOfferId) { declineOffer(currentOfferId); return; }
        ov.classList.remove('open');
      }
    });
  });

  function openSendModal(peerId) {
    // if user had dropped files and then taps a peer, send immediately
    if (window._pendingFilesToSend && window._pendingFilesToSend.length) {
      const files = window._pendingFilesToSend;
      window._pendingFilesToSend = null;
      closeModal('sendModal');
      sendFiles(peerId, files);
      return;
    }
    targetPeerId = peerId;
    const p = peers.get(peerId);
    if (!p) return;
    $('#sendModalTitle').textContent = `Send to ${p.info.name}`;
    $('#textSendArea').style.display = 'none';
    $('#filePreview').style.display = 'none';
    $('#filePreview').innerHTML = '';
    $('#textInput').value = '';
    openModal('sendModal');
  }

  $('#btnSendFiles').addEventListener('click', () => fileInput.click());
  $('#btnSendText').addEventListener('click', () => {
    const area = $('#textSendArea');
    area.style.display = area.style.display === 'none' ? 'flex' : 'none';
    if (area.style.display !== 'none') $('#textInput').focus();
  });
  $('#btnDoSendText').addEventListener('click', () => {
    const txt = $('#textInput').value.trim().slice(0, 65536);
    if (!txt) return toast('Enter some text', 'error');
    if (!targetPeerId) return;
    sendText(targetPeerId, txt);
    closeModal('sendModal');
  });

  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    if (!files.length) return;
    if (!targetPeerId) {
      if (peers.size === 1) {
        sendFiles([...peers.keys()][0], files);
      } else if (peers.size === 0) {
        toast('No peers found. Open this page on another device first.', 'error');
        return;
      } else {
        window._pendingFilesToSend = files;
        peersGrid.scrollIntoView({ behavior: 'smooth' });
        toast('Now tap a device to send ' + files.length + ' file(s)', '');
        return;
      }
    } else {
      sendFiles(targetPeerId, files);
      closeModal('sendModal');
    }
    fileInput.value = '';
  });

  ;['dragenter', 'dragover'].forEach(ev => {
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drag'); });
  });
  ;['dragleave', 'drop'].forEach(ev => {
    dropZone.addEventListener(ev, (e) => {
      if (ev === 'drop') {
        e.preventDefault();
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        if (peers.size === 0) { toast('No peers nearby', 'error'); return; }
        if (peers.size === 1) {
          sendFiles([...peers.keys()][0], files);
        } else {
          window._pendingFilesToSend = files;
          const preview = $('#filePreview');
          preview.style.display = '';
          preview.innerHTML = files.map(f => `<div class="preview-item"><span>📄</span><span style="flex:1">${escapeHtml(f.name)} <small style="color:var(--muted)">(${formatSize(f.size)})</small></span></div>`).join('') + '<p style="color:#60a5fa;font-size:12px;margin-top:8px">Now tap a device above to send</p>';
          openModal('sendModal');
          toast(`Ready to send ${files.length} file(s) — tap a device`, '');
        }
      }
      dropZone.classList.remove('drag');
    });
  });

  // ---------- QR / room buttons ----------
  function currentShareUrl() {
    return roomLink(roomId === '…' ? (requestedRoom || '') : roomId);
  }
  $('#btnQR').addEventListener('click', () => {
    const url = currentShareUrl();
    qrLinkEl.textContent = url;
    qrcodeEl.innerHTML = '';
    try {
      if (typeof QRCode === 'undefined') throw new Error('QR lib not loaded');
      new QRCode(qrcodeEl, { text: url, width: 180, height: 180, colorDark: '#0f172a', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    } catch {
      qrcodeEl.innerHTML = '<p style="color:#0f172a;font-size:12px;max-width:220px">QR library failed to load (offline?). Copy the link below instead.</p>';
    }
    openModal('qrModal');
  });
  $('#btnCopyLink').addEventListener('click', async () => {
    const url = currentShareUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied!', 'success');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Link copied!', 'success'); } catch { toast('Copy failed', 'error'); }
      ta.remove();
    }
  });
  $('#btnNewRoom').addEventListener('click', () => {
    const code = randomRoomCode();
    switchRoom(code);
    setTimeout(async () => {
      try { await navigator.clipboard.writeText(roomLink(code)); toast('Private room created — link copied!', 'success'); }
      catch { toast('Private room created: ' + code, 'success'); }
    }, 800);
  });
  $('#btnJoinRoom').addEventListener('click', () => {
    const v = $('#joinRoomInput').value.trim().replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 32);
    if (!v) return toast('Enter a room code', 'error');
    switchRoom(v);
  });
  $('#joinRoomInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoinRoom').click(); });
  $('#btnExitRoom').addEventListener('click', () => switchRoom(null));
  $('#btnLeavePublic')?.addEventListener('click', () => switchRoom(randomRoomCode()));

  // ---------- Misc ----------
  $('#btnAbout').addEventListener('click', () => openModal('aboutModal'));
  // proper light theme (persisted)
  function applyTheme() {
    const light = localStorage.getItem('pd-theme') === 'light';
    document.body.classList.toggle('light', light);
    const btn = $('#btnTheme');
    if (btn) btn.textContent = light ? '☀️' : '🌙';
  }
  applyTheme();
  $('#btnTheme').addEventListener('click', () => {
    const light = !(localStorage.getItem('pd-theme') === 'light');
    localStorage.setItem('pd-theme', light ? 'light' : 'dark');
    applyTheme();
    toast(light ? 'Light theme' : 'Dark theme');
  });
  $('#editNameBtn').addEventListener('click', () => {
    $('#nameInput').value = myName || '';
    openModal('nameModal');
  });
  youNameEl.addEventListener('click', () => {
    $('#nameInput').value = myName || '';
    openModal('nameModal');
  });
  $('#btnSaveName').addEventListener('click', () => {
    const v = $('#nameInput').value.trim().slice(0, 20);
    if (!v) return;
    myName = v;
    localStorage.setItem('pd-name', v);
    youNameEl.textContent = v;
    wsSend({ type: 'update-name', name: v });
    closeModal('nameModal');
    toast('Name updated to ' + v, 'success');
  });
  $('#clearHistory').addEventListener('click', () => {
    historyList.innerHTML = '';
    historySection.style.display = 'none';
  });

  // ---------- Receive UI (after accept, bytes flow) ----------
  function showReceiveFile(meta, url, blob, method) {
    const modal = $('#receiveModal');
    $('#receiveTitle').textContent = `Received from ${meta.sender}${method ? ' (' + method + ')' : ''}`;
    const body = $('#receiveBody');
    const isImage = meta.mime.startsWith('image/');
    const isVideo = meta.mime.startsWith('video/');
    const isAudio = meta.mime.startsWith('audio/');
    let preview = '';
    if (isImage) preview = `<img src="${url}" style="max-width:100%;max-height:240px;border-radius:12px;margin:10px 0">`;
    else if (isVideo) preview = `<video src="${url}" controls style="max-width:100%;border-radius:12px;margin:10px 0"></video>`;
    else if (isAudio) preview = `<audio src="${url}" controls style="width:100%;margin:10px 0"></audio>`;
    body.innerHTML = `
      <div class="receive-item">
        <div class="receive-head">
          <div class="receive-icon">${isImage ? '🖼️' : isVideo ? '🎬' : isAudio ? '🎵' : '📄'}</div>
          <div>
            <div style="font-weight:700">${escapeHtml(meta.name)}</div>
            <div style="font-size:12px;color:var(--muted)">${formatSize(meta.size)} • ${escapeHtml(meta.mime)}${method ? ' • ' + escapeHtml(method) : ''}</div>
          </div>
        </div>
        ${preview}
        <div class="receive-actions">
          <a href="${url}" download="${escapeHtml(meta.name)}" class="btn btn-primary" style="flex:1;justify-content:center">⬇ Download</a>
          <button class="btn btn-secondary" id="btnShareFile" style="flex:1">Share</button>
        </div>
        <p style="font-size:11px;color:var(--muted);margin-top:10px">File was only transferred after you pressed Accept. It is kept in memory until you download or refresh.</p>
      </div>
    `;
    const shareBtn = body.querySelector('#btnShareFile');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        try {
          const file = new File([blob], meta.name, { type: meta.mime });
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: meta.name });
            return;
          }
        } catch {}
        if (navigator.share) { try { await navigator.share({ title: meta.name, url }); } catch {} }
        else { toast('Sharing not supported, downloading instead'); const a = document.createElement('a'); a.href = url; a.download = meta.name; a.click(); }
      });
    }
    openModal('receiveModal');
  }

  function showReceivedText(sender, text) {
    const modal = $('#receiveModal');
    $('#receiveTitle').textContent = `Message from ${sender}`;
    const body = $('#receiveBody');
    const isUrl = /^https?:\/\//i.test(String(text).trim());
    const safeUrl = isUrl ? String(text).trim().replace(/"/g, '%22') : '';
    body.innerHTML = `
      <div class="receive-item">
        <div class="receive-head">
          <div class="receive-icon">💬</div>
          <div>
            <div style="font-weight:700">Text message</div>
            <div style="font-size:12px;color:var(--muted)">from ${escapeHtml(sender)}</div>
          </div>
        </div>
        <div style="background:#0b1228;border:1px solid var(--border);border-radius:12px;padding:12px;white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.5">${escapeHtml(text)}</div>
        <div class="receive-actions">
          <button class="btn btn-primary" id="btnCopyText" style="flex:1">📋 Copy</button>
          ${isUrl ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" class="btn btn-secondary" style="flex:1;justify-content:center">🔗 Open Link</a>` : ''}
        </div>
      </div>
    `;
    body.querySelector('#btnCopyText')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'success'); } catch {}
    });
    openModal('receiveModal');
    toast(`Message from ${sender}`, 'success');
  }

  // ---------- Init ----------
  updateRoomUI();
  updateConnInfo();
  Promise.all([fetchIceServers(), fetchConfig()]).finally(() => connectWS());
  setInterval(() => wsSend({ type: 'ping' }), 25000);

  window.addEventListener('beforeunload', (e) => {
    let active = false;
    for (const p of peers.values()) {
      for (const v of p.pendingReceives.values()) if (v.received < v.meta.size) active = true;
    }
    if (outgoing.size > 0 || incomingOffers.size > 0 || relayFallbackPending.size > 0) active = true;
    if (active) { e.preventDefault(); e.returnValue = ''; }
  });

  window._pairdrop = { peers, sendFiles, sendText, ws: () => ws, switchRoom };

})();
