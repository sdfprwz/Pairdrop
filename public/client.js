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
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');
  const toasts = $('#toasts');
  const fileInput = $('#fileInput');
  const dropZone = $('#dropZone');
  const qrcodeEl = $('#qrcode');
  const qrLinkEl = $('#qrLink');
  const historySection = $('#historySection');
  const historyList = $('#historyList');

  // State
  let myId = null;
  let myName = null;
  let myColor = '#3b82f6';
  let myDevice = 'Desktop';
  let roomId = new URLSearchParams(location.search).get('room') || 'public';
  roomId = roomId.replace(/[^a-zA-Z0-9-_]/g,'').slice(0,32) || 'public';
  roomNameEl.textContent = roomId;
  qrLinkEl.textContent = location.origin + location.pathname + '?room=' + roomId;
  if(roomId !== 'public') roomHintEl.textContent = `Private room — only people with this link can find you`;

  let ws = null;
  let wsConnected = false;
  const peers = new Map(); // peerId -> { info, pc, dc, pendingFiles: Map<fileId, {meta, buffers, received, ...}>, fileQueue }
  const pendingFiles = new Map(); // fallback for receiver without peer map yet
  const relayFallbackPending = new Map(); // fileId -> {meta, buffers, received} for WS relay
  let targetPeerId = null; // currently selected peer to send to
  let fileQueue = []; // files waiting to send when datachannel opens

  const CHUNK_SIZE = 64 * 1024;
  const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  let ICE_SERVERS = [...DEFAULT_ICE_SERVERS];

  // Fetch ICE servers (STUN+TURN) from server - preserves LAN (STUN) when no TURN configured
  async function fetchIceServers(){
    try{
      const r = await fetch('/ice-servers', { cache: 'no-store' });
      if(r.ok){
        const j = await r.json();
        if(Array.isArray(j) && j.length){
          ICE_SERVERS = j;
          const hasTurn = j.some(s=> s.urls && String(s.urls).includes('turn'));
          console.log('[ICE] loaded', ICE_SERVERS, hasTurn ? '(TURN ready for internet P2P)' : '(STUN/LAN only)');
          if(hasTurn) toast('Internet P2P ready (TURN)', 'success');
          return ICE_SERVERS;
        }
      }
    }catch(e){ console.warn('[ICE] fetch failed, using default STUN', e); }
    console.log('[ICE] using default', ICE_SERVERS);
    return ICE_SERVERS;
  }
  const AVATARS = ["🦊","🐼","🦁","🐯","🐨","🦄","🐧","🦊","🐻","🐵","🐶","🐱","🐹","🦝","🦊","🦒","🦏","🦓","🐘","🦔","🐿️","🦫","🦡","🦦","🦥","🐝","🐙","🦑","🦀","🐬","🐳","🦈","🦭","🦧","🐊","🦎","🦘","🐆","🐅","🦌"];
  function avatarFor(peerId, name){
    // deterministic
    let h=0; for(let c of peerId) h+=c.charCodeAt(0);
    return AVATARS[h % AVATARS.length];
  }

  function toast(msg, type=''){
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    toasts.appendChild(el);
    setTimeout(()=> { el.style.opacity='0'; el.style.transform='translateY(4px)'; el.style.transition='.3s'; }, 2600);
    setTimeout(()=> el.remove(), 3000);
  }

  function updatePeerGrid(){
    const count = peers.size;
    peerCountEl.textContent = `${count} ${count===1?'device':'devices'} found`;
    if(count===0){
      emptyState.style.display = '';
      // remove old peer cards
      peersGrid.querySelectorAll('.peer-card').forEach(el=>el.remove());
      return;
    }
    emptyState.style.display = 'none';
    // rebuild
    peersGrid.querySelectorAll('.peer-card').forEach(el=>el.remove());
    for(const [id, p] of peers){
      const info = p.info;
      const card = document.createElement('div');
      card.className = 'peer-card';
      card.dataset.peerId = id;
      const connected = p.dc && p.dc.readyState === 'open';
      card.innerHTML = `
        <div class="peer-status" style="background:${connected? '#10b981':'#f59e0b'}"></div>
        <div class="peer-avatar" style="background:${info.color}">${avatarFor(id, info.name)}</div>
        <div class="peer-name">${escapeHtml(info.name)}</div>
        <div class="peer-device">${escapeHtml(info.device)}</div>
        <div class="peer-id">${id}</div>
        <div class="peer-hint">${connected? 'Tap to send' : 'Connecting...'}</div>
      `;
      card.addEventListener('click', ()=> openSendModal(id));
      peersGrid.appendChild(card);
    }
  }

  function escapeHtml(s){
    return s.replace(/[&<>"']/g, c=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // WS signaling
  function connectWS(){
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/?room=${encodeURIComponent(roomId)}`;
    ws = new WebSocket(url);
    setStatus('connecting', 'Connecting to signaling server...');
    ws.onopen = () => {
      wsConnected = true;
      setStatus('on', 'Connected — discovering peers');
      toast('Connected to room: ' + roomId, 'success');
    };
    ws.onclose = () => {
      wsConnected = false;
      setStatus('off', 'Disconnected — reconnecting...');
      toast('Disconnected. Reconnecting...', 'error');
      // clean peers pcs
      for(const [id,p] of peers){ try{ p.pc.close(); }catch{} }
      peers.clear();
      updatePeerGrid();
      setTimeout(connectWS, 1500);
    };
    ws.onerror = () => {
      setStatus('off', 'Connection error');
    };
    ws.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      // console.log('ws msg', msg);
      if(msg.type === 'init'){
        myId = msg.id;
        myName = msg.name;
        myColor = msg.color;
        myDevice = msg.device;
        youNameEl.textContent = myName;
        youDeviceEl.textContent = myDevice;
        youIdEl.textContent = `ID: ${myId} • Room: ${roomId}`;
        youAvatar.style.background = myColor;
        youAvatar.textContent = avatarFor(myId, myName);
      } else if(msg.type === 'peers'){
        // full list (we already handle peer-joined, but sync)
        // we handle diff via peer-joined/left, ignore full here except update count? Could ignore
      } else if(msg.type === 'peer-joined'){
        const peer = msg.peer;
        if(peer.id === myId) return;
        if(!myId) return; // not yet initialized
        if(peers.has(peer.id)){
          // update placeholder info if we had Unknown peer from early signal
          const existing = peers.get(peer.id);
          if(existing && existing.info.name.startsWith('Peer ') || existing.info.name === 'Unknown'){
            existing.info.name = peer.name;
            existing.info.color = peer.color;
            existing.info.device = peer.device;
            console.log('updated placeholder peer info', peer);
            updatePeerGrid();
          }
          return;
        }
        console.log('peer joined', peer);
        toast(`${peer.name} joined`, 'success');
        // Deterministic initiator: smaller ID initiates to avoid glare (both offering at same time)
        const isInitiator = myId < peer.id;
        console.log(` - initiator=${isInitiator} (myId=${myId} peer=${peer.id})`);
        await addPeer(peer, isInitiator);
      } else if(msg.type === 'peer-left'){
        const peerId = msg.peerId;
        const p = peers.get(peerId);
        if(p){
          toast(`${p.info.name} left`, '');
          try{ p.pc.close(); }catch{}
          peers.delete(peerId);
          updatePeerGrid();
        }
      } else if(msg.type === 'signal'){
        const sender = msg.sender;
        const signal = msg.signal;
        let p = peers.get(sender);
        if(!p){
          // peer not yet added via peer-joined? create placeholder as non-initiator
          // The sender is offering, so we must be answerer. Use deterministic initiator if we don't know signal type yet.
          const shouldInitiate = myId && myId < sender ? false : false; // always false when reacting to incoming offer
          // Actually if we receive offer, we are answerer. If we receive answer/candidate but no PC, we might be initiator who missed peer-joined.
          // Better: if signal type is offer -> we are answerer; otherwise infer via ID
          const isOffer = signal.type === 'offer';
          const isInitiator = isOffer ? false : (myId ? myId < sender : false);
          console.log('signal from unknown peer', sender, 'type', signal.type, 'creating placeholder initiator=', isInitiator);
          const placeholder = { id: sender, name: 'Peer ' + sender.slice(0,4), color: '#3b82f6', device: 'Device' };
          await addPeer(placeholder, isInitiator);
          p = peers.get(sender);
        }
        if(!p) return;
        await handleSignal(p, signal);
      } else if(msg.type === 'fallback-text'){
        // server relay fallback
        showReceivedText(msg.senderName || msg.sender, msg.text);
        addHistoryTextReceive(msg.senderName || msg.sender, msg.text);
      } else if(msg.type === 'fallback-file-header'){
        // relay file header via server
        const fileId = msg.id;
        const sender = msg.sender || msg.senderName || 'Unknown';
        const senderId = msg.sender || 'relay';
        const meta = { id: fileId, name: msg.name, size: msg.size, mime: msg.mime || 'application/octet-stream', sender: sender, senderId };
        // store in global relay map (use peers entry if exists, else global)
        let pendMap = relayFallbackPending;
        pendMap.set(fileId, { meta, buffers: [], received: 0 });
        console.log('relay header', meta);
        addHistoryReceiveStart(meta);
        toast(`Receiving "${meta.name}" from ${meta.sender} via relay`, '');
      } else if(msg.type === 'fallback-file-chunk'){
        const fileId = msg.id;
        const pend = relayFallbackPending.get(fileId);
        if(!pend){ console.warn('relay chunk no pend', fileId); return; }
        // msg.data is base64
        const binary = atob(msg.data);
        const bytes = new Uint8Array(binary.length);
        for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
        pend.buffers.push(bytes.buffer);
        pend.received += bytes.byteLength;
        updateHistoryProgress(fileId, pend.received, pend.meta.size);
      } else if(msg.type === 'fallback-file-complete'){
        const fileId = msg.id;
        const pend = relayFallbackPending.get(fileId);
        if(!pend) return;
        const blob = new Blob(pend.buffers, { type: pend.meta.mime });
        const url = URL.createObjectURL(blob);
        finalizeHistoryReceive(pend.meta.id, url, blob);
        showReceiveFile(pend.meta, url, blob);
        relayFallbackPending.delete(fileId);
      }
    };
  }

  function setStatus(state, text){
    statusText.textContent = text;
    statusDot.className = 'status-dot ' + state;
  }

  async function addPeer(peerInfo, isInitiator){
    if(peers.has(peerInfo.id)) return peers.get(peerInfo.id);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { info: peerInfo, pc, dc: null, pendingReceives: new Map(), sendQueue: [], isInitiator, pendingCandidates: [] };
    peers.set(peerInfo.id, entry);
    updatePeerGrid();

    pc.onicecandidate = (e) => {
      if(e.candidate){
        wsSend({ type:'signal', target: peerInfo.id, signal: { type:'candidate', candidate: e.candidate }});
      }
    };
    pc.onconnectionstatechange = () => {
      console.log(`pc ${peerInfo.id} state`, pc.connectionState, 'ice', pc.iceConnectionState, 'sig', pc.signalingState);
      updatePeerGrid();
      if(pc.connectionState === 'failed'){
        console.warn('pc failed, trying ICE restart for', peerInfo.id);
        // Simple restart: renegotiate if we are initiator
        if(entry.isInitiator && pc.signalingState === 'stable'){
          pc.restartIce?.();
          // create new offer with iceRestart
          pc.createOffer({ iceRestart: true }).then(offer=> pc.setLocalDescription(offer)).then(()=>{
            wsSend({ type:'signal', target: peerInfo.id, signal: { type:'offer', sdp: pc.localDescription }});
          }).catch(e=>console.error(e));
        }
      }
      if(pc.connectionState === 'connected'){
        toast(`Connected to ${peerInfo.name}`, 'success');
      }
    };
    pc.oniceconnectionstatechange = () => {
      console.log(`ice ${peerInfo.id}`, pc.iceConnectionState);
      if(pc.iceConnectionState === 'failed' && entry.isInitiator){
        // also toast
        toast(`Connection to ${peerInfo.name} failed, trying relay fallback`, 'error');
      }
    };
    pc.ondatachannel = (e) => {
      console.log('ondatachannel', peerInfo.id, 'label', e.channel.label);
      setupDataChannel(entry, e.channel);
    };
    pc.onnegotiationneeded = async () => {
      // Only initiator should handle negotiationneeded. This is fallback for when data channel created after connection.
      // We already create offer in isInitiator case, so ignore unless we are initiator and not yet have local offer.
      if(!entry.isInitiator) return;
      if(pc.signalingState !== 'stable') return;
      console.log('negotiationneeded for', peerInfo.id);
    };

    if(isInitiator){
      try{
        const dc = pc.createDataChannel('pairdrop', { ordered: true });
        setupDataChannel(entry, dc);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        wsSend({ type:'signal', target: peerInfo.id, signal: { type:'offer', sdp: pc.localDescription }});
        console.log('sent offer to', peerInfo.id);
      }catch(e){
        console.error('offer create failed', e);
      }
    } else {
      console.log('waiting for offer from', peerInfo.id);
    }
    return entry;
  }

  function setupDataChannel(entry, dc){
    entry.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onopen = () => {
      console.log('dc open', entry.info.id);
      updatePeerGrid();
      // flush send queue
      if(entry.sendQueue.length){
        const q = [...entry.sendQueue];
        entry.sendQueue = [];
        q.forEach(fn=> fn());
      }
    };
    dc.onclose = () => {
      console.log('dc close', entry.info.id);
      updatePeerGrid();
    };
    dc.onerror = (e) => console.error('dc error', e);
    dc.onmessage = (e) => handleDataMessage(entry, e.data);
  }

  async function handleSignal(entry, signal){
    const pc = entry.pc;
    try{
      if(signal.type === 'offer'){
        // Perfect negotiation: if we have pending local offer and we are not polite, ignore or handle collision.
        // Our deterministic initiator ensures only one offers, but handle glare gracefully.
        const offerCollision = pc.signalingState !== 'stable' || pc.signalingState === 'have-local-offer';
        const isPolite = !entry.isInitiator; // polite = answerer (larger ID)
        if(offerCollision && !isPolite){
          console.warn('offer collision, impolite peer ignoring offer from', entry.info.id);
          return;
        }
        if(offerCollision && isPolite){
          console.log('offer collision, polite peer rolling back for', entry.info.id);
          await Promise.all([
            pc.setLocalDescription({type: 'rollback'}),
            pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
          ]).catch(async ()=> {
            // fallback if rollback not supported
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          });
        } else {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        }
        // flush any pending candidates queued before remote description
        if(entry.pendingCandidates && entry.pendingCandidates.length){
          for(const c of entry.pendingCandidates) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
          entry.pendingCandidates = [];
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        wsSend({ type:'signal', target: entry.info.id, signal: { type:'answer', sdp: pc.localDescription }});
        console.log('sent answer to', entry.info.id);
      } else if(signal.type === 'answer'){
        if(pc.signalingState === 'have-local-offer'){
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          console.log('set remote answer from', entry.info.id);
        } else {
          console.warn('ignoring answer, state', pc.signalingState);
          // still try to set if stable? (might be after rollback)
          try{ await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp)); }catch(e){ console.warn(e); }
        }
        if(entry.pendingCandidates && entry.pendingCandidates.length){
          for(const c of entry.pendingCandidates) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
          entry.pendingCandidates = [];
        }
      } else if(signal.type === 'candidate'){
        if(pc.remoteDescription){
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } else {
          // queue until remoteDescription set
          console.log('queuing candidate, no remote desc yet', entry.info.id);
          entry.pendingCandidates = entry.pendingCandidates || [];
          entry.pendingCandidates.push(signal.candidate);
        }
      }
    }catch(err){
      console.error('signal error', err, signal);
    }
  }

  function wsSend(obj){
    if(ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // Data message handling
  function handleDataMessage(entry, data){
    if(typeof data === 'string'){
      let msg;
      try{ msg = JSON.parse(data); }catch{ return; }
      // Robust header detection: handles fixed 'header' type and legacy buggy header where type was mime (e.g. "image/png")
      const isLegacyHeader = msg.id && msg.name != null && msg.size != null && typeof msg.type === 'string' && msg.type.includes('/') && !['file-complete','text'].includes(msg.type);
      if(msg.type === 'header' || isLegacyHeader){
        // incoming file header
        const fileId = msg.id;
        const mime = msg.mime || (msg.type !== 'header' ? msg.type : null) || 'application/octet-stream';
        const meta = { id: fileId, name: msg.name, size: msg.size, mime, sender: entry.info.name, senderId: entry.info.id };
        entry.pendingReceives.set(fileId, { meta, buffers: [], received: 0, start: Date.now() });
        console.log('header', meta);
        // show history entry
        addHistoryReceiveStart(meta);
        toast(`Receiving "${meta.name}" from ${meta.sender}`, '');
      } else if(msg.type === 'file-complete'){
        const fileId = msg.id;
        const pend = entry.pendingReceives.get(fileId);
        if(!pend) return;
        const blob = new Blob(pend.buffers, { type: pend.meta.mime });
        const url = URL.createObjectURL(blob);
        // finalize history
        finalizeHistoryReceive(pend.meta.id, url, blob);
        showReceiveFile(pend.meta, url, blob);
        entry.pendingReceives.delete(fileId);
      } else if(msg.type === 'text'){
        showReceivedText(entry.info.name, msg.text);
        addHistoryTextReceive(entry.info.name, msg.text);
      }
    } else {
      // binary chunk - need to find which file we're receiving
      // There should be exactly one active pendingReceive that's not complete
      // For simplicity, find first with received < size
      let active = null;
      for(const v of entry.pendingReceives.values()){
        if(v.received < v.meta.size){ active = v; break; }
      }
      if(!active){
        console.warn('binary but no active file');
        return;
      }
      active.buffers.push(data);
      active.received += data.byteLength;
      // update progress
      updateHistoryProgress(active.meta.id, active.received, active.meta.size);
      // if received >= size, wait for file-complete msg to assemble (sender will send it)
      // but also auto-complete if size reached without explicit complete (robust)
      if(active.received >= active.meta.size){
        // we could auto finalize if complete not arrived within short time, but wait for file-complete
      }
    }
  }

  // Helpers: wait for data channel
  function waitForDataChannel(entry, timeout=8000){
    return new Promise((resolve)=>{
      if(entry.dc && entry.dc.readyState === 'open') return resolve(true);
      const start = Date.now();
      const check = () => {
        if(entry.dc && entry.dc.readyState === 'open'){ resolve(true); return; }
        if(Date.now() - start > timeout) { resolve(false); return; }
        setTimeout(check, 200);
      };
      // also listen for open
      if(entry.dc){
        const onOpen = () => { entry.dc.removeEventListener('open', onOpen); resolve(true); };
        entry.dc.addEventListener('open', onOpen);
        setTimeout(()=> { try{ entry.dc.removeEventListener('open', onOpen);}catch{} }, timeout);
      }
      check();
    });
  }

  // Fallback file via WebSocket relay (for when WebRTC fails). Slower, but works across any network.
  async function sendFilesViaRelay(peerId, files, peerName){
    for(const file of files){
      const fileId = Math.random().toString(36).slice(2,9);
      wsSend({ type:'fallback-file-header', target: peerId, id: fileId, name: file.name, size: file.size, mime: file.type });
      const meta = { id: fileId, name: file.name, size: file.size, sender: 'You (relay)', target: peerName };
      addHistorySendStart(meta);
      let offset = 0;
      while(offset < file.size){
        const slice = file.slice(offset, offset + 32*1024); // smaller chunks for WS
        const buf = await slice.arrayBuffer();
        // convert to base64
        let binary = '';
        const bytes = new Uint8Array(buf);
        for(let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]);
        const b64 = btoa(binary);
        wsSend({ type:'fallback-file-chunk', target: peerId, id: fileId, data: b64 });
        offset += buf.byteLength;
        updateHistoryProgress(fileId, offset, file.size);
        await new Promise(r=> setTimeout(r, 10)); // throttle a bit
      }
      wsSend({ type:'fallback-file-complete', target: peerId, id: fileId });
      finalizeHistorySend(fileId);
      toast(`Sent "${file.name}" to ${peerName} via relay (slower)`, 'success');
    }
  }

  // Sending - tries WebRTC first, falls back to relay after timeout
  async function sendFiles(peerId, files){
    const entry = peers.get(peerId);
    if(!entry){
      toast('Peer not found', 'error');
      return;
    }
    // Show progress immediately
    toast(`Preparing to send ${files.length} file(s) to ${entry.info.name}...`, '');
    // Wait up to 8s for DC to open
    const isOpen = await waitForDataChannel(entry, 8000);
    if(isOpen && entry.dc && entry.dc.readyState === 'open'){
      // WebRTC path - fast P2P
      console.log('Using WebRTC data channel for', peerId);
      const dc = entry.dc;
      for(const file of files){
        const fileId = Math.random().toString(36).slice(2,9);
        const header = JSON.stringify({ type:'header', id: fileId, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' });
        try{ dc.send(header); }catch(e){
          console.error('dc send header failed', e);
          // fallback
          return sendFilesViaRelay(peerId, [file], entry.info.name);
        }
        const meta = { id: fileId, name: file.name, size: file.size, sender: 'You', target: entry.info.name };
        addHistorySendStart(meta);
        let offset = 0;
        try{
          while(offset < file.size){
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            const buf = await slice.arrayBuffer();
            // backpressure wait
            while(dc.bufferedAmount > 512*1024){
              await new Promise(r=>{
                const onLow = () => { dc.removeEventListener('bufferedamountlow', onLow); r(); };
                dc.addEventListener('bufferedamountlow', onLow);
                setTimeout(()=> { try{dc.removeEventListener('bufferedamountlow', onLow);}catch{}; r(); }, 250);
              });
            }
            dc.send(buf);
            offset += buf.byteLength;
            updateHistoryProgress(fileId, offset, file.size);
            // yield to UI
            if(offset % (256*1024) === 0) await new Promise(r=> setTimeout(r, 0));
          }
          dc.send(JSON.stringify({ type:'file-complete', id: fileId }));
          finalizeHistorySend(fileId);
          toast(`Sent "${file.name}" to ${entry.info.name}`, 'success');
        }catch(e){
          console.error('WebRTC send failed, falling back', e);
          toast('WebRTC failed, trying relay...', 'error');
          await sendFilesViaRelay(peerId, [file], entry.info.name);
        }
      }
      return;
    } else {
      // No DC after timeout -> try relay
      console.warn('Data channel not open after timeout, using relay for', peerId, 'dc state', entry.dc?.readyState, 'pc state', entry.pc?.connectionState);
      toast('Direct P2P not available, sending via server relay (slower but reliable)...', '');
      // Check pc state for debugging
      if(entry.pc){
        console.log('pc states', { conn: entry.pc.connectionState, ice: entry.pc.iceConnectionState, sig: entry.pc.signalingState, iceGather: entry.pc.iceGatheringState });
      }
      // If file is huge (>50MB) warn
      const total = files.reduce((a,f)=>a+f.size,0);
      if(total > 50*1024*1024){
        toast('Large file via relay may be slow. Try again or use smaller files.', 'error');
      }
      await sendFilesViaRelay(peerId, files, entry.info.name);
    }
  }

  function sendText(peerId, text){
    const entry = peers.get(peerId);
    if(!entry){
      toast('Peer not found','error'); return;
    }
    const dc = entry.dc;
    const payload = JSON.stringify({ type:'text', text, id: Math.random().toString(36).slice(2,9) });
    if(dc && dc.readyState === 'open'){
      dc.send(payload);
      toast(`Text sent to ${entry.info.name}`, 'success');
      addHistoryTextSend(entry.info.name, text);
    } else {
      // fallback via server
      wsSend({ type:'fallback-text', target: peerId, text });
      toast(`Text sent via relay to ${entry.info.name}`, 'success');
      addHistoryTextSend(entry.info.name, text + ' (relay)');
    }
  }

  // History UI
  function ensureHistoryVisible(){
    historySection.style.display = '';
  }
  function addHistorySendStart(meta){
    ensureHistoryVisible();
    const el = document.createElement('div');
    el.className = 'history-item';
    el.id = 'hist-' + meta.id;
    el.innerHTML = `
      <div class="h-icon">📤</div>
      <div style="flex:1">
        <div style="font-weight:600">${escapeHtml(meta.name)} <span style="color:var(--muted);font-weight:400">→ ${escapeHtml(meta.target)}</span></div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
          <div class="progress"><div class="progress-bar" style="width:0%"></div></div>
          <span class="h-progress" style="font-size:11px;color:var(--muted)">0%</span>
        </div>
      </div>
      <div style="font-size:11px;color:var(--muted)">${formatSize(meta.size)}</div>
    `;
    historyList.prepend(el);
  }
  function addHistoryReceiveStart(meta){
    ensureHistoryVisible();
    const el = document.createElement('div');
    el.className = 'history-item';
    el.id = 'hist-' + meta.id;
    el.innerHTML = `
      <div class="h-icon">📥</div>
      <div style="flex:1">
        <div style="font-weight:600">${escapeHtml(meta.name)} <span style="color:var(--muted);font-weight:400">from ${escapeHtml(meta.sender)}</span></div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
          <div class="progress"><div class="progress-bar" style="width:0%"></div></div>
          <span class="h-progress" style="font-size:11px;color:var(--muted)">0%</span>
        </div>
      </div>
      <div style="font-size:11px;color:var(--muted)">${formatSize(meta.size)}</div>
    `;
    historyList.prepend(el);
  }
  function updateHistoryProgress(id, received, total){
    const el = document.getElementById('hist-' + id);
    if(!el) return;
    const pct = Math.round((received/total)*100);
    const bar = el.querySelector('.progress-bar');
    if(bar) bar.style.width = pct + '%';
    const txt = el.querySelector('.h-progress');
    if(txt) txt.textContent = pct + '% • ' + formatSize(received) + '/' + formatSize(total);
  }
  function finalizeHistorySend(id){
    updateHistoryProgress(id, 1,1); // 100%
    const el = document.getElementById('hist-'+id);
    if(el){
      el.querySelector('.h-progress').textContent = '✓ Sent';
      el.style.borderColor = '#10b98144';
    }
  }
  function finalizeHistoryReceive(id, url, blob){
    const el = document.getElementById('hist-'+id);
    if(el){
      el.querySelector('.h-progress').textContent = '✓ Received';
      el.style.borderColor = '#10b98144';
      // turn into clickable download
      const link = document.createElement('a');
      link.href = url;
      link.download = el.querySelector('div div')?.textContent?.split(' ')[0] || 'file';
      // we need actual file name from meta
      const metaEl = el;
      // add download button
      if(!el.querySelector('.dl-btn')){
        const btn = document.createElement('a');
        btn.href = url;
        btn.download = blob ? 'download' : '';
        btn.className = 'btn btn-primary dl-btn';
        btn.style.cssText = 'padding:6px 10px;font-size:12px';
        btn.textContent = '⬇ Download';
        // try to get filename from history meta
        const pendName = [...document.querySelectorAll('.history-item')].find(e=>e.id==='hist-'+id);
        // we stored meta name differently, recover from el inner? simpler use blob
        btn.addEventListener('click', ()=> toast('Download started','success'));
        // attach filename correctly
        // find meta: we can store in dataset
        el.appendChild(btn);
        // set download attr from earlier mapping
        // we need to look up actual name: we'll store mapping in DOM dataset
      }
    }
  }
  function addHistoryTextSend(target, text){
    ensureHistoryVisible();
    const el = document.createElement('div');
    el.className = 'history-item';
    el.innerHTML = `
      <div class="h-icon">💬</div>
      <div style="flex:1">
        <div style="font-weight:600">Text → ${escapeHtml(target)}</div>
        <div style="color:#cbd5e1;background:#1e293b;padding:8px;border-radius:8px;margin-top:6px;word-break:break-word;font-size:12px">${escapeHtml(text)}</div>
      </div>
      <button class="link-btn" onclick="navigator.clipboard.writeText(${JSON.stringify(text)});this.textContent='Copied!'">Copy</button>
    `;
    historyList.prepend(el);
  }
  function addHistoryTextReceive(sender, text){
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
      <button class="link-btn" onclick="navigator.clipboard.writeText(${JSON.stringify(text)});this.textContent='Copied!'">Copy</button>
    `;
    historyList.prepend(el);
  }

  function formatSize(b){
    if(b===0) return '0 B';
    const u=['B','KB','MB','GB'];
    const i=Math.floor(Math.log(b)/Math.log(1024));
    return (b/Math.pow(1024,i)).toFixed(i?1:0)+' '+u[i];
  }

  // Modals
  function openModal(id){
    document.getElementById(id).classList.add('open');
  }
  function closeModal(id){
    document.getElementById(id).classList.remove('open');
  }
  $$('[data-close]').forEach(btn=>{
    btn.addEventListener('click', ()=> closeModal(btn.dataset.close));
  });
  // click overlay to close
  $$('.modal-overlay').forEach(ov=>{
    ov.addEventListener('click', (e)=> { if(e.target===ov) ov.classList.remove('open'); });
  });

  function openSendModal(peerId){
    targetPeerId = peerId;
    const p = peers.get(peerId);
    if(!p) return;
    $('#sendModalTitle').textContent = `Send to ${p.info.name}`;
    $('#textSendArea').style.display='none';
    $('#filePreview').style.display='none';
    $('#filePreview').innerHTML='';
    $('#textInput').value='';
    openModal('sendModal');
  }

  $('#btnSendFiles').addEventListener('click', ()=>{
    fileInput.click();
  });
  $('#btnSendText').addEventListener('click', ()=>{
    const area = $('#textSendArea');
    area.style.display = area.style.display==='none' ? 'flex' : 'none';
    if(area.style.display!=='none') $('#textInput').focus();
  });
  $('#btnDoSendText').addEventListener('click', ()=>{
    const txt = $('#textInput').value.trim();
    if(!txt) return toast('Enter some text', 'error');
    if(!targetPeerId) return;
    sendText(targetPeerId, txt);
    closeModal('sendModal');
  });

  // file input
  fileInput.addEventListener('change', ()=>{
    const files = [...fileInput.files];
    if(!files.length) return;
    if(!targetPeerId){
      // if no target selected but files dropped, need to pick target
      if(peers.size===1){
        const onlyId = [...peers.keys()][0];
        targetPeerId = onlyId;
      } else if(peers.size===0){
        toast('No peers found. Open this page on another device first.', 'error');
        return;
      } else {
        // show selection? for now pick first and show modal
        toast('Choose a device first by tapping it', 'error');
        // show file preview and ask to select peer
        // store files for later
        fileQueue = files;
        // highlight peers
        peersGrid.scrollIntoView({behavior:'smooth'});
        toast('Now tap a device to send ' + files.length + ' file(s)', '');
        // keep files in temp
        window._pendingFilesToSend = files;
        return;
      }
    }
    // if we have pending files from drop without target, use them
    sendFiles(targetPeerId, files);
    closeModal('sendModal');
    fileInput.value='';
    window._pendingFilesToSend = null;
  });

  // drag & drop
  ;['dragenter','dragover'].forEach(ev=>{
    dropZone.addEventListener(ev, (e)=>{
      e.preventDefault();
      dropZone.classList.add('drag');
    });
  });
  ;['dragleave','drop'].forEach(ev=>{
    dropZone.addEventListener(ev, (e)=>{
      if(ev==='drop'){
        e.preventDefault();
        const files = [...e.dataTransfer.files];
        if(!files.length) return;
        if(peers.size===0){
          toast('No peers nearby','error');
          return;
        }
        if(peers.size===1){
          const onlyId = [...peers.keys()][0];
          sendFiles(onlyId, files);
        } else {
          // store and ask to select peer
          window._pendingFilesToSend = files;
          // show modal with file list and peer selection hint
          const preview = $('#filePreview');
          preview.style.display = '';
          preview.innerHTML = files.map(f=> `<div class="preview-item"><span>📄</span><span style="flex:1">${escapeHtml(f.name)} <small style="color:var(--muted)">(${formatSize(f.size)})</small></span></div>`).join('') + '<p style="color:#60a5fa;font-size:12px;margin-top:8px">Now tap a device above to send</p>';
          openModal('sendModal');
          // temporarily store
          // when peer selected, the sendFiles will be called via next click? we need to hook peer selection when pending files exist
          // override peer card click temporarily
          if(!window._dropListenerPatched){
            const origOpen = openSendModal;
            window._origOpen = origOpen;
            window._dropListenerPatched = true;
          }
          // patch: if pending files, send immediately on tap
          // we monkey patch openSendModal behavior via targetPeerId handling
          // Instead, just set a flag and on next openSendModal, auto send
          dropZone.classList.remove('drag');
          // show toast
          toast(`Ready to send ${files.length} file(s) — tap a device`, '');
          // add auto-send listener
          const handler = (e)=>{
            const card = e.target.closest('.peer-card');
            if(!card) return;
            const pid = card.dataset.peerId;
            if(window._pendingFilesToSend){
              e.stopImmediatePropagation();
              // prevent opening modal again? send directly
              setTimeout(()=> sendFiles(pid, window._pendingFilesToSend), 80);
              closeModal('sendModal');
              window._pendingFilesToSend = null;
              peersGrid.removeEventListener('click', handler, true);
            }
          };
          peersGrid.addEventListener('click', handler, true);
          setTimeout(()=> peersGrid.removeEventListener('click', handler, true), 15000);
        }
      }
      dropZone.classList.remove('drag');
    });
  });

  // QR
  $('#btnQR').addEventListener('click', ()=>{
    const url = location.origin + location.pathname + '?room=' + encodeURIComponent(roomId);
    qrLinkEl.textContent = url;
    qrcodeEl.innerHTML='';
    new QRCode(qrcodeEl, { text: url, width: 180, height:180, colorDark:"#0f172a", colorLight:"#ffffff", correctLevel: QRCode.CorrectLevel.M });
    openModal('qrModal');
  });
  $('#btnCopyLink').addEventListener('click', async ()=>{
    const url = location.origin + location.pathname + '?room=' + encodeURIComponent(roomId);
    try{
      await navigator.clipboard.writeText(url);
      toast('Link copied!', 'success');
    }catch{
      // fallback
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Link copied!', 'success');
    }
  });

  // About, theme, name edit
  $('#btnAbout').addEventListener('click', ()=> openModal('aboutModal'));
  let dark = true;
  $('#btnTheme').addEventListener('click', ()=>{
    dark = !dark;
    document.documentElement.style.filter = dark ? '' : 'invert(1) hue-rotate(180deg)';
    document.body.style.background = dark ? '' : '#f1f5f9';
    toast(dark ? 'Dark theme' : 'Light theme');
  });
  $('#editNameBtn').addEventListener('click', ()=>{
    $('#nameInput').value = myName || '';
    openModal('nameModal');
  });
  youNameEl.addEventListener('click', ()=>{
    $('#nameInput').value = myName || '';
    openModal('nameModal');
  });
  $('#btnSaveName').addEventListener('click', ()=>{
    const v = $('#nameInput').value.trim().slice(0,20);
    if(!v) return;
    myName = v;
    youNameEl.textContent = v;
    wsSend({ type:'update-name', name: v });
    closeModal('nameModal');
    toast('Name updated to ' + v, 'success');
  });
  $('#clearHistory').addEventListener('click', ()=>{
    historyList.innerHTML='';
    historySection.style.display='none';
  });

  // Receive UI
  function showReceiveFile(meta, url, blob){
    const modal = $('#receiveModal');
    $('#receiveTitle').textContent = `Received from ${meta.sender}`;
    const body = $('#receiveBody');
    const isImage = meta.mime.startsWith('image/');
    const isVideo = meta.mime.startsWith('video/');
    const isAudio = meta.mime.startsWith('audio/');
    let preview = '';
    if(isImage) preview = `<img src="${url}" style="max-width:100%;max-height:240px;border-radius:12px;margin:10px 0">`;
    else if(isVideo) preview = `<video src="${url}" controls style="max-width:100%;border-radius:12px;margin:10px 0"></video>`;
    else if(isAudio) preview = `<audio src="${url}" controls style="width:100%;margin:10px 0"></audio>`;
    body.innerHTML = `
      <div class="receive-item">
        <div class="receive-head">
          <div class="receive-icon">${isImage?'🖼️': isVideo?'🎬': isAudio?'🎵':'📄'}</div>
          <div>
            <div style="font-weight:700">${escapeHtml(meta.name)}</div>
            <div style="font-size:12px;color:var(--muted)">${formatSize(meta.size)} • ${escapeHtml(meta.mime)}</div>
          </div>
        </div>
        ${preview}
        <div class="receive-actions">
          <a href="${url}" download="${escapeHtml(meta.name)}" class="btn btn-primary" style="flex:1;justify-content:center">⬇ Download</a>
          <button class="btn btn-secondary" id="btnShareFile" style="flex:1">Share</button>
        </div>
        <p style="font-size:11px;color:var(--muted);margin-top:10px">File is kept in memory until you download or refresh. For large files, save immediately.</p>
      </div>
    `;
    // share button
    const shareBtn = body.querySelector('#btnShareFile');
    if(shareBtn){
      shareBtn.addEventListener('click', async ()=>{
        if(navigator.canShare && navigator.canShare({ files: [new File([blob], meta.name, {type: meta.mime})]})){
          try{
            await navigator.share({ files: [new File([blob], meta.name, {type: meta.mime})], title: meta.name });
          }catch{}
        } else if(navigator.share){
          try{ await navigator.share({ title: meta.name, url }); }catch{}
        } else {
          // fallback copy link? just download
          toast('Sharing not supported, downloading instead');
          const a=document.createElement('a'); a.href=url; a.download=meta.name; a.click();
        }
      });
    }
    openModal('receiveModal');
    // also add to history download button filename fix
    setTimeout(()=>{
      const histBtn = document.querySelector(`#hist-${meta.id} .dl-btn`);
      if(histBtn) histBtn.download = meta.name;
    },100);
  }

  function showReceivedText(sender, text){
    const modal = $('#receiveModal');
    $('#receiveTitle').textContent = `Message from ${sender}`;
    const body = $('#receiveBody');
    const isUrl = /^https?:\/\//i.test(text.trim());
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
          ${isUrl ? `<a href="${escapeHtml(text.trim())}" target="_blank" class="btn btn-secondary" style="flex:1;justify-content:center">🔗 Open Link</a>` : ''}
        </div>
      </div>
    `;
    body.querySelector('#btnCopyText')?.addEventListener('click', async()=>{
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard','success');
    });
    openModal('receiveModal');
    // also toast
    toast(`Message from ${sender}`, 'success');
  }

  // Handle paste to send text quickly? Ctrl+V
  // Init - fetch ICE (STUN for LAN, TURN when configured for internet P2P) then connect WS
  fetchIceServers().finally(()=> connectWS());

  // expose for debug
  window._pairdrop = { peers, sendFiles, sendText, ws: ()=>ws };

  // Handle room creation if user wants private room: press copy with public -> offer to create random
  // Check if room is public and user hasn't shared, hint to create private for security
  if(roomId==='public'){
    // optional: generate private room button? we keep public as default like PairDrop (same network)
  }

  // Keep alive ping every 25s
  setInterval(()=> wsSend({ type:'ping' }), 25000);

  // Service worker? not needed

  // Before unload warning if transfers active
  window.addEventListener('beforeunload', (e)=>{
    let active = false;
    for(const p of peers.values()){
      for(const v of p.pendingReceives.values()) if(v.received < v.meta.size) active=true;
    }
    if(active){
      e.preventDefault();
      e.returnValue = '';
    }
  });

})();
