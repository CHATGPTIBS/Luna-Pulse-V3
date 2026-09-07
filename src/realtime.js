import WebSocket from 'ws';
import { config } from './config.js';

const stats = {
  enabled: false,
  connected: false,
  subscriptions: 0,
  notifications: 0,
  reconnects: 0,
  lastEventAt: 0,
  lastError: null,
  lastConnectedAt: 0,
};

function desiredLeaders(store) {
  return store.data.leaders.filter(l => l.enabled !== false).map(l => l.address).sort();
}
function sameList(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
function wsUrl() {
  if (config.solanaWsUrl) return config.solanaWsUrl;
  return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(config.heliusApiKey)}`;
}

export function getRealtimeStats() { return { ...stats }; }

export function startRealtimeWalletWake(store, onWake) {
  stats.enabled = Boolean(config.realtimeEnabled);
  if (!config.realtimeEnabled) return { stop() {}, getStats: getRealtimeStats };

  let socket = null;
  let stopped = false;
  let requestId = 1000;
  let reconnectTimer = null;
  let pingTimer = null;
  let refreshTimer = null;
  let reconnectDelay = 1000;
  let subscribedAddresses = [];
  const pendingByRequest = new Map();
  const addressBySubscription = new Map();

  const clearSocketTimers = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    stats.connected = false;
    const delay = reconnectDelay + Math.floor(Math.random() * 500);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(30000, reconnectDelay * 2);
      connect();
    }, delay);
  };

  const subscribeAll = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    pendingByRequest.clear();
    addressBySubscription.clear();
    subscribedAddresses = desiredLeaders(store);
    stats.subscriptions = 0;
    for (const address of subscribedAddresses) {
      const id = requestId++;
      pendingByRequest.set(id, address);
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        params: [{ mentions: [address] }, { commitment: 'processed' }],
      }));
    }
  };

  const connect = () => {
    if (stopped) return;
    try {
      socket = new WebSocket(wsUrl(), { handshakeTimeout: 10000 });
    } catch (e) {
      stats.lastError = String(e.message || e);
      scheduleReconnect();
      return;
    }

    socket.on('open', () => {
      stats.connected = true;
      stats.lastConnectedAt = Date.now();
      stats.lastError = null;
      reconnectDelay = 1000;
      subscribeAll();
      clearSocketTimers();
      pingTimer = setInterval(() => {
        try { if (socket?.readyState === WebSocket.OPEN) socket.ping(); } catch {}
      }, 20000);
    });

    socket.on('message', raw => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.id && pendingByRequest.has(msg.id) && Number.isFinite(Number(msg.result))) {
        const address = pendingByRequest.get(msg.id);
        pendingByRequest.delete(msg.id);
        addressBySubscription.set(Number(msg.result), address);
        stats.subscriptions = addressBySubscription.size;
        return;
      }
      if (msg?.method !== 'logsNotification') return;
      const subscription = Number(msg?.params?.subscription);
      const address = addressBySubscription.get(subscription);
      const value = msg?.params?.result?.value;
      const signature = value?.signature;
      if (!address || !signature || value?.err) return;
      stats.notifications++;
      stats.lastEventAt = Date.now();
      try { onWake?.({ address, signature, slot: msg?.params?.result?.context?.slot || null }); } catch {}
    });

    socket.on('error', e => { stats.lastError = String(e.message || e); });
    socket.on('close', () => {
      clearSocketTimers();
      stats.connected = false;
      if (!stopped) { stats.reconnects++; scheduleReconnect(); }
    });
  };

  connect();
  refreshTimer = setInterval(() => {
    if (stopped || !socket || socket.readyState !== WebSocket.OPEN) return;
    const wanted = desiredLeaders(store);
    if (!sameList(wanted, subscribedAddresses)) {
      try { socket.close(1000, 'leader set changed'); } catch {}
    }
  }, 5000);

  return {
    getStats: getRealtimeStats,
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refreshTimer) clearInterval(refreshTimer);
      clearSocketTimers();
      try { socket?.close(); } catch {}
      stats.connected = false;
    },
  };
}
