# Pulse Shill Bot (PulseChain, Userbot + Control Bot)

## Quickstart (GitHub Codespaces)

```bash
npm i
npm run prisma:generate
npm run prisma:migrate
```

Create `.env` from `.env.example` (do not commit `.env`).

Run services:

```bash
# 1) API
npm run dev:api

# 2) Userbot (first run will prompt for phone/code and print TG_SESSION)
npm run dev:userbot

# 3) Control bot (BotFather bot you DM)
npm run dev:bot
```

API endpoints:
- `POST /wallets` { address, chainId }
- `POST /profiles` { walletId, amountNative, slippageBps, router, wrappedNative, ... }
- `POST /channels` { slug, mode:"MTPROTO", buyProfileId }
- `GET /channels/list`
- `POST /channels/toggleBySlug` { slug, active }
- `POST /profiles/:id/dryrun` { toggle:true } or { dryRun:true/false }
- `GET /profiles/:id/status`

Control bot commands (DM only):
- `/add <t.me/slug|@slug> userbot <profileId>`
- `/list`
- `/remove <slug>`
- `/status <profileId>` (shows buttons to toggle Auto-Buy and refresh)
```

**Notes**
- Uses **1% fee-on-top** (configurable via `feeBps`) sent to `treasury` before swap.
- On-chain holder gate: set `HOLDER_TOKEN_ADDRESS` and `HOLDER_MIN_UNITS`.
- Start with `dryRun=true` (default) and a burner wallet.
