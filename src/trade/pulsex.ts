import { ethers } from 'ethers';
import { prisma } from '../db';
import { env } from '../env';

const UNIV2_ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable'
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

function nowSec() { return Math.floor(Date.now() / 1000); }

export async function tradeForChannelSlug(slug: string, token: string) {
  const channel = await prisma.channel.findFirst({
    where: { slug: slug.toLowerCase(), mode: 'MTPROTO', active: true },
    include: { buyProfile: { include: { wallet: true, user: true } } }
  });
  if (!channel?.buyProfile) return `Skip: channel not configured or no profile`;

  const p = channel.buyProfile;

  // Throttle
  const recent = await prisma.tradeLog.findFirst({
    where: {
      channelId: channel.id,
      createdAt: { gte: new Date(Date.now() - p.minSecondsBetweenBuys * 1000) }
    },
    orderBy: { createdAt: 'desc' }
  });
  if (recent) return `Skip: throttle window (${p.minSecondsBetweenBuys}s)`;

  const provider = new ethers.JsonRpcProvider(env.EVM_RPC_URL, { chainId: env.CHAIN_ID, name: `chain-${env.CHAIN_ID}` });
  const pk = process.env.PRIVATE_KEY || '';
  if (!pk) return `Skip: PRIVATE_KEY not set`;

  const wallet = new ethers.Wallet(pk, provider);
  const signerAddress = await wallet.getAddress();

  if (!p.dryRun && signerAddress.toLowerCase() !== p.wallet.address.toLowerCase()) {
    return `Skip: signer ${signerAddress} != profile.wallet ${p.wallet.address}`;
  }

  const code = await provider.getCode(token);
  if (!code || code === '0x') return `Skip: no contract at ${token}`;

  const amountInWei = ethers.parseUnits(String(p.amountNative), 18);
  const router = new ethers.Contract(p.router, UNIV2_ROUTER_ABI, wallet);
  const path = [p.wrappedNative, token];

  let amounts: bigint[];
  try {
    amounts = await router.getAmountsOut(amountInWei, path);
  } catch {
    return `Skip: getAmountsOut reverted (no liquidity / bad path)`;
  }

  const out = amounts[amounts.length - 1];
  const minOut = (out * BigInt(10_000 - p.slippageBps)) / BigInt(10_000);

  // Fee on-top (1% default -> feeBps)
  const feeBps = p.feeBps ?? 100;
  const feeWei = (amountInWei * BigInt(feeBps)) / BigInt(10_000);
  const treasury = p.treasury || env.TREASURY_ADDRESS;
  const swapValue = amountInWei - feeWei;

  let symbol = 'TOKEN';
  try { symbol = await new ethers.Contract(token, ERC20_ABI, provider).symbol(); } catch {}

  if (p.dryRun) {
    await prisma.tradeLog.create({
      data: {
        userId: p.userId,
        channelId: channel.id,
        token,
        status: 'DRY',
        reason: `Would buy ~${out.toString()} (minOut=${minOut.toString()}) of ${symbol} for ${p.amountNative} PLS; fee=${feeWei} wei`
      }
    });
    return `DRY: ${symbol} (${token}) out≈${out} minOut=${minOut} feeWei=${feeWei}`;
  }

  if (feeWei > 0n && !treasury) {
    return `Skip: treasury not set for fee ${feeBps} bps`;
  }

  if (feeWei > 0n) {
    await wallet.sendTransaction({ to: treasury, value: feeWei });
  }

  const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
    minOut,
    path,
    signerAddress,
    nowSec() + 180,
    { value: swapValue }
  );
  const receipt = await tx.wait();

  await prisma.tradeLog.create({
    data: {
      userId: p.userId,
      channelId: channel.id,
      token,
      txHash: tx.hash,
      status: receipt?.status === 1 ? 'SUCCESS' : 'FAIL',
      reason: `Bought ${symbol}`
    }
  });
  return `Bought ${symbol} (${token}) tx=${tx.hash}`;
}
