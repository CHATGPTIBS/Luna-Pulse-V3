import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './config.js';

export const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`, 'confirmed');

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
