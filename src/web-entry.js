import { StateStore } from './state.js';
import { startMonitors } from './monitor.js';
import { startV4Strategies } from './strategy.js';
import { startWebTerminal } from './web.js';

// The engine historically accepted a Discord Client so it could post alerts.
// The web runtime does not log into Discord; this lightweight notification shim
// preserves the wallet/strategy engine while simply dropping Discord alerts.
const notificationClient = {
  __lunaV5DiscordStarted: false,
  channels: {
    fetch: async () => null,
  },
  on: () => {},
};

const store = new StateStore();
await store.whenReady();

startWebTerminal(store);
startMonitors(notificationClient, store);
startV4Strategies(notificationClient, store);

console.log('Luna Terminal runtime started: web UI + wallet monitors + strategy engine.');
