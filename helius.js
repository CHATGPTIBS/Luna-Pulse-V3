import { config } from './config.js';

export async function getRecentTransactions(address, limit = 10) {
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${config.heliusApiKey}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Helius ${res.status}: ${await res.text()}`);
  return res.json();
}
