import { Connection, PublicKey } from '@solana/web3.js';
import { config, LAMPORTS_PER_SOL } from './config.js';

// Helius RPC remains available for occasional balance/token-account reads.
export const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`, 'confirmed');

// Wallet monitoring uses a lightweight signature preflight before requesting
// Helius enhanced transactions. The default public Solana RPC can be replaced
// with SOLANA_SIGNATURE_RPC_URL for a more reliable dedicated endpoint.
export const signatureConnection = new Connection(config.signatureRpcUrl, 'confirmed');

export async function getLatestSignature(owner) {
  const rows = await signatureConnection.getSignaturesForAddress(new PublicKey(owner), { limit: 1 }, 'confirmed');
  const row = rows[0];
  if (!row) return null;
  return {
    signature: row.signature,
    blockTime: Number(row.blockTime || 0),
    slot: Number(row.slot || 0),
  };
}

export async function getSolBalance(owner) {
  return (await connection.getBalance(new PublicKey(owner), 'confirmed')) / LAMPORTS_PER_SOL;
}

export async function getTokenBalanceRaw(owner, mint) {
  const ownerPk = new PublicKey(owner);
  const mintPk = new PublicKey(mint);
  const res = await connection.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk });
  let raw = 0n;
  let decimals = 0;
  for (const a of res.value) {
    const t = a.account.data.parsed.info.tokenAmount;
    raw += BigInt(t.amount);
    decimals = t.decimals;
  }
  return { raw, decimals, ui: Number(raw) / 10 ** decimals };
}
