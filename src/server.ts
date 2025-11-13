import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import { ensureDefaultUser, prisma } from './db';
import { env } from './env';
import { ethers } from 'ethers';
import { tradeForChannelSlug } from './trade/pulsex';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Buffer } from 'buffer';

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// --------- holder gate (optional) ----------
async function holderGateByWallet(addressToCheck: string) {
  if (!env.HOLDER_TOKEN_ADDRESS) return true;
  const provider = new ethers.JsonRpcProvider(env.EVM_RPC_URL, { chainId: env.CHAIN_ID, name: `chain-${env.CHAIN_ID}` });
  const token = new ethers.Contract(env.HOLDER_TOKEN_ADDRESS, ERC20_ABI, provider);
  const bal: bigint = await token.balanceOf(addressToCheck);
  return bal >= env.HOLDER_MIN_UNITS;
}

(async function main() {
  await ensureDefaultUser();

  const app = express();
  app.use(bodyParser.json());

  // --- open endpoints (no api key) only for TG session helpers
  const OPEN_PATHS = new Set<string>([
    '/tg-session', '/api/tg/sendCode', '/api/tg/signIn',
    '/tg-session-qr', '/api/tg/qr/start', '/api/tg/qr/poll'
  ]);

  // --- auth middleware
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (OPEN_PATHS.has(req.path)) return next();
    const key = String((req.headers['x-api-key'] as string) || (req.query.api_key as string) || '');
    if (!key || key !== env.API_KEY) return res.status(401).json({ error: 'unauthorized' });
    const user = await prisma.user.findUnique({ where: { apiKey: env.API_KEY } });
    (req as any).user = user;
    next();
  });

  // --------- wallets / profiles / channels ----------
  app.post('/wallets', async (req, res) => {
    const user = (req as any).user;
    const { address, chainId = env.CHAIN_ID, label } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });
    if (!(await holderGateByWallet(address))) return res.status(402).json({ error: 'holder requirement not met' });
    const w = await prisma.wallet.create({ data: { userId: user.id, address, chainId, label } });
    res.json(w);
  });

  app.post('/profiles', async (req, res) => {
    const user = (req as any).user;
    const { walletId, amountNative, slippageBps, denyWords, keywords, router, wrappedNative, feeBps, treasury, dryRun } = req.body || {};
    if (!walletId || amountNative == null || !slippageBps || !router || !wrappedNative) {
      return res.status(400).json({ error: 'walletId, amountNative, slippageBps, router, wrappedNative required' });
    }
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet || wallet.userId !== user.id) return res.status(404).json({ error: 'wallet not found' });
    if (!(await holderGateByWallet(wallet.address))) return res.status(402).json({ error: 'holder requirement not met' });
    const p = await prisma.buyProfile.create({
      data: {
        userId: user.id,
        walletId,
        amountNative: Number(amountNative),
        slippageBps: Number(slippageBps),
        minSecondsBetweenBuys: 900,
        denyWords: denyWords || 'presale,airdrop,testnet,faucet',
        keywords: keywords || 'buy,ca,contract,token,launch,shill,coin',
        router,
        wrappedNative,
        feeBps: feeBps ?? 100,
        treasury: treasury || process.env.TREASURY_ADDRESS || null,
        dryRun: dryRun ?? true
      }
    });
    res.json(p);
  });

  app.post('/channels', async (req, res) => {
    const user = (req as any).user;
    const { slug, mode, buyProfileId } = req.body || {};
    if (!slug || !buyProfileId) return res.status(400).json({ error: 'slug and buyProfileId required' });
    if (String(mode).toUpperCase() !== 'MTPROTO') return res.status(400).json({ error: 'only MTPROTO supported' });

    const p = await prisma.buyProfile.findUnique({ where: { id: buyProfileId }, include: { wallet: true } });
    if (!p || p.userId !== user.id) return res.status(404).json({ error: 'profile not found' });
    if (!(await holderGateByWallet(p.wallet.address))) return res.status(402).json({ error: 'holder requirement not met' });

    const existing = await prisma.channel.findFirst({ where: { userId: user.id, slug: slug.toLowerCase() } });
    const ch = existing
      ? await prisma.channel.update({ where: { id: existing.id }, data: { buyProfileId: p.id, active: true } })
      : await prisma.channel.create({ data: { userId: user.id, slug: slug.toLowerCase(), mode: 'MTPROTO', buyProfileId: p.id } });
    res.json(ch);
  });

  app.get('/channels/list', async (req, res) => {
    const user = (req as any).user;
    const list = await prisma.channel.findMany({ where: { userId: user.id } });
    res.json(list);
  });

  app.post('/channels/toggleBySlug', async (req, res) => {
    const user = (req as any).user;
    const { slug, active } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const ch = await prisma.channel.findFirst({ where: { userId: user.id, slug: slug.toLowerCase() } });
    if (!ch) return res.status(404).json({ error: 'not found' });
    const updated = await prisma.channel.update({ where: { id: ch.id }, data: { active: !!active } });
    res.json(updated);
  });

  app.post('/profiles/:id/dryrun', async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { toggle, dryRun } = req.body || {};
    const p = await prisma.buyProfile.findUnique({ where: { id }, include: { wallet: true } });
    if (!p || p.userId !== user.id) return res.status(404).json({ error: 'profile not found' });
    const next = toggle ? !p.dryRun : !!dryRun;
    const up = await prisma.buyProfile.update({ where: { id }, data: { dryRun: next } });
    res.json({ dryRun: up.dryRun });
  });

  app.get('/profiles/:id/status', async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const p = await prisma.buyProfile.findUnique({ where: { id }, include: { wallet: true } });
    if (!p || p.userId !== user.id) return res.status(404).json({ error: 'profile not found' });
    res.json({
      walletAddress: p.wallet.address,
      amountNative: p.amountNative,
      slippageBps: p.slippageBps,
      dryRun: p.dryRun,
      feeBps: p.feeBps,
      treasury: p.treasury
    });
  });

  app.post('/trade/execute', async (req, res) => {
    const user = (req as any).user;
    const { slug, token } = req.body || {};
    if (!slug || !token) return res.status(400).json({ error: 'slug and token required' });
    const ch = await prisma.channel.findFirst({ where: { userId: user.id, slug: slug.toLowerCase(), active: true } });
    if (!ch) return res.status(404).json({ error: 'channel not found or inactive' });
    const result = await tradeForChannelSlug(slug, token);
    res.json({ result });
  });

  // --------- CODE LOGIN (fallback) ----------
  app.get('/tg-session', (_req, res) => {
    res.type('html').send(`
<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>TG Session</title>
<style>body{font-family:system-ui,Arial;margin:20px;max-width:760px}label{display:block;margin:.6rem 0 .2rem}input{width:100%;padding:.5rem}button{margin-top:.8rem;padding:.6rem 1rem}pre{white-space:pre-wrap;background:#f5f5f7;padding:10px;border-radius:8px}</style>
<h2>Generate Telegram TG_SESSION</h2>
<label>Phone (e.g. +447...)</label><input id=phone placeholder="+447..." />
<button id=send>Send Code</button>
<div id=codeArea style="display:none">
  <label>Code (5 digits)</label><input id=code placeholder="12345" />
  <label>2FA Password (if enabled)</label><input id=pw placeholder="••••••" type=password />
  <button id=signin>Sign In</button>
</div>
<h3>Session</h3><pre id=out>(will appear here)</pre>
<script>
let phoneCodeHash = '';
const $ = (id)=>document.getElementById(id);
$('send').onclick = async ()=>{
  const r = await fetch('/api/tg/sendCode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:$('phone').value})});
  const d = await r.json(); if(d.error){$('out').textContent='Error: '+d.error;return;}
  phoneCodeHash = d.phoneCodeHash; $('codeArea').style.display='block'; $('out').textContent='Code sent. Check Telegram.';
};
$('signin').onclick = async ()=>{
  const r = await fetch('/api/tg/signIn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:$('phone').value,code:$('code').value,phoneCodeHash,password:$('pw').value})});
  const d = await r.json(); if(d.error){$('out').textContent='Error: '+d.error;return;}
  $('out').textContent=d.session || '(no session returned)';
};
</script>`);
  });

  app.post('/api/tg/sendCode', async (req, res) => {
    try {
      const { phone } = req.body || {};
      if (!phone) return res.status(400).json({ error: 'phone required' });
      const apiId = Number(process.env.TG_API_ID || 0);
      const apiHash = String(process.env.TG_API_HASH || '');
      if (!apiId || !apiHash) return res.status(500).json({ error: 'TG_API_ID/HASH not set on Core' });

      const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
      await client.connect();
      const result = await client.invoke(new Api.auth.SendCode({ phoneNumber: phone, apiId, apiHash, settings: new Api.CodeSettings({}) }));
      await client.disconnect();
      res.json({ phoneCodeHash: (result as any).phoneCodeHash });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post('/api/tg/signIn', async (req, res) => {
    try {
      const { phone, code, phoneCodeHash, password } = req.body || {};
      const apiId = Number(process.env.TG_API_ID || 0);
      const apiHash = String(process.env.TG_API_HASH || '');
      if (!apiId || !apiHash) return res.status(500).json({ error: 'TG_API_ID/HASH not set on Core' });

      const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
      await client.connect();
      try {
        await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
      } catch (err: any) {
        if (String(err?.message || '').includes('SESSION_PASSWORD_NEEDED')) {
          if (!password) throw new Error('2FA enabled: supply password');
          // @ts-ignore gramJS helper not in d.ts
          await (client as any).checkPassword(password);
        } else {
          throw err;
        }
      }
      const sessionStr = String(client.session.save()); // <- ensure string (no union/void)
      await client.disconnect();
      res.json({ session: sessionStr });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // --------- QR LOGIN (stateless; Buffer everywhere) ----------
  const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function importTokenOnce(tokenBuf: Buffer): Promise<{ status: 'OK'|'WAITING'|'EXPIRED', session?: string }> {
    const apiId = Number(process.env.TG_API_ID || 0);
    const apiHash = String(process.env.TG_API_HASH || '');
    if (!apiId || !apiHash) throw new Error('TG_API_ID/HASH not set');

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
    await client.connect();
    try {
      let result: any;
      try {
        result = await client.invoke(new Api.auth.ImportLoginToken({ token: tokenBuf as any }));
      } catch (e: any) {
        const msg = String(e?.message || '');
        if (msg.includes('AUTH_TOKEN_EXPIRED')) return { status: 'EXPIRED' };
        if (msg.includes('AUTH_TOKEN_INVALID')) return { status: 'WAITING' };
        throw e;
      }

      if (result && result.className === 'auth.loginTokenMigrateTo') {
        const dcId = (result as any).dcId;
        if (typeof (client as any)._switchDC === 'function') {
          await (client as any)._switchDC(dcId);
        }
        result = await client.invoke(new Api.auth.ImportLoginToken({ token: tokenBuf as any }));
      }

      if (result && result.className === 'auth.loginTokenSuccess') {
        const sessionStr = String(client.session.save()); // <- force string (fixes TS2322 paths)
        return { status: 'OK', session: sessionStr };
      }
      return { status: 'WAITING' };
    } finally {
      try { await client.disconnect(); } catch {}
    }
  }

  app.get('/tg-session-qr', (_req, res) => {
    res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>TG Session (QR)</title>
<style>
  body{font-family:system-ui,Arial;margin:20px;max-width:760px}
  button{padding:.6rem 1rem;margin-right:.6rem}
  #qrbox{margin-top:12px;display:none}
  #qrbox img{width:240px;height:240px;border:1px solid #ddd;border-radius:8px}
  pre{white-space:pre-wrap;background:#f5f5f7;padding:10px;border-radius:8px}
</style>
<h2>Generate Telegram TG_SESSION (QR login)</h2>
<ol>
  <li>Click <b>Start QR</b>.</li>
  <li>On phone: <b>Telegram → Settings → Devices → Link Desktop Device</b> (or tap <i>Open in Telegram</i>).</li>
  <li>When linked, your <b>TG_SESSION</b> prints below.</li>
</ol>
<button id=start>Start QR</button><button id=refresh style="display:none">Refresh QR</button>
<div id=qrbox>
  <p>Scan with Telegram → Devices:</p>
  <img id=qr src="">
  <p><a id=deeplink href="#" target="_blank">Open in Telegram</a></p>
</div>
<h3>Session</h3>
<pre id=out>(waiting…)</pre>
<script>
let tokenB64 = '';
let stopped = false;
const $ = (id)=>document.getElementById(id);
const drawQR = (url)=> $('qr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data='+encodeURIComponent(url);

async function startQR(){
  $('out').textContent='(waiting…)';
  stopped = false;
  const r = await fetch('/api/tg/qr/start'); const d = await r.json();
  if(d.error){ $('out').textContent='Error: '+d.error; return; }
  tokenB64 = d.tokenB64;
  const url = 'tg://login?token='+tokenB64;
  $('deeplink').href = url;
  drawQR(url);
  $('qrbox').style.display='block';
  $('refresh').style.display='inline-block';
  poll();
}

async function poll(){
  if (stopped || !tokenB64) return;
  const r = await fetch('/api/tg/qr/poll', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tokenB64 }) });
  const d = await r.json();
  if (d.error){ $('out').textContent='Error: '+d.error; return; }
  if (d.status === 'OK' && d.session){ $('out').textContent = d.session; stopped = true; return; }
  if (d.status === 'EXPIRED'){ $('out').textContent = 'QR expired. Click "Refresh QR".'; return; }
  setTimeout(poll, 2000);
}

$('start').onclick = startQR;
$('refresh').onclick = startQR;
</script>`);
  });

  app.get('/api/tg/qr/start', async (_req, res) => {
    try {
      const apiId = Number(process.env.TG_API_ID || 0);
      const apiHash = String(process.env.TG_API_HASH || '');
      if (!apiId || !apiHash) return res.status(500).json({ error: 'TG_API_ID/HASH not set' });

      const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
      await client.connect();
      const exported: any = await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }));
      try { await client.disconnect(); } catch {}

      const raw: any = exported?.token;
      if (!raw) return res.status(500).json({ error: 'Failed to export login token' });
      const tokBuf: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);

      return res.json({ tokenB64: b64url(tokBuf) });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post('/api/tg/qr/poll', async (req, res) => {
    try {
      const { tokenB64 } = req.body || {};
      if (!tokenB64) return res.status(400).json({ error: 'tokenB64 required' });
      const tokBuf = Buffer.from(String(tokenB64).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const out = await importTokenOnce(tokBuf);
      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---- boot
  app.listen(env.PORT, () => console.log(`API up on :${env.PORT}`));
})();
