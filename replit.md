# TradeSniper AI PRO Workspace

## Overview

Full-stack scalping platform for crypto assets. Dark mode industrial UI with live Binance WebSocket ticker, TradingView chart widgets, AI vision analysis (Claude), Sniper Calculator, AI Copilot chat, and Trade History with daily PNL tracking.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite (artifacts/tradesniper)
- **API framework**: Express 5 (artifacts/api-server)
- **Database**: PostgreSQL + Drizzle ORM
- **AI**: Anthropic Claude (via Replit AI Integrations proxy) - claude-sonnet-4-6
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server
│   └── tradesniper/        # React + Vite frontend (previewPath: /)
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   ├── db/                 # Drizzle ORM schema + DB connection
│   └── integrations-anthropic-ai/  # Anthropic AI client
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## V7 Decision Engine (Latest)

### BacktestHub (Hub Estatísticas tab)
- Replaced "Calculadora & Metas" tab with the new V7 Backtest Hub
- 7 strategy performance cards: Muralha 200, Surfe 200, Fênix Reversão, Fibonacci 50%, Sniper RSI, Onda SAR, Break-Even
- Each card shows: Win Rate (Alvo 1), Signals/year, Status (🔥 EM ALTA / 🧊 RESFRIANDO), Long/Short breakdown
- Equity Curve: recharts AreaChart with 52-week simulation from $2,000 bankroll + optional drawdown overlay
- Direction filter: ALL / LONGS only / SHORTS only

### Scanner V7 Enhancements
- **M5 Proximity Radar**: Detects acceleration of approach to EMA200 on M5 + volume surge → fires pre-breakout "Muralha Buffer" signal
- **Breakout Filter**: Body>70% of range AND Volume≥1.5× avg AND Body>(Wicks×2) → upgrades to "⚡ ROMPIMENTO CONFIRMADO" with 35x leverage
- **SAR+EMA9 Sync**: Onda SAR strategy now requires EMA9 inclination >0.02%/candle in the same direction; unsync'd SAR flips get reduced 15x leverage
- **BTC Thermometer V7**: Also blocks altcoin LONGs when BTC trend is BEAR (previously only blocked SHORTs when BTC BULL)
- **Inversion Alerts**: In-UI panel (orange) fires when EMA200 support/resistance breaks, showing FROM→TO direction with reason
- **Mentor Sniper**: Anti-anxiety UI panel (blue) shows dismissible mentoring messages during drawdown when SAR holds the position

## Features

### 1. Live Price Ticker (Header Marquee)
- Binance WebSocket streaming for BTC, ETH, SOL, XRP, DOGE, QTUM, AVAX
- Green for gains, red for losses
- Current prices used for sync validation

### 2. TradingView Chart Widgets
- Embedded Advanced Charts for all 7 pairs
- M15 default timeframe
- Tab navigation

### 3. Multi-Image Upload (Vision Analysis)
- Up to 5 screenshots with timeframe labels (D1, H4, H1, M15, M5)
- AI analysis via Claude claude-sonnet-4-6 with vision
- Extracts: price, EMA 9/21, RSI, candle patterns, trend
- Sync validation: >0.5% divergence shows "ERRO DE SINCRONIA"
- POST /api/analysis/analyze-charts

### 4. Sniper Calculator
- Balance (default 187.50 USDT), Daily Goal (default 175 USD)
- Auto-calculates: position size, fees (0.1%), leverage, liquidation distance
- Warning if liquidation < 2% of entry: "ALAVANCAGEM SUICIDA - REDUZA O SIZE"
- LONG/SHORT direction buttons with trend filter blocks

### 5. AI Copilot Chat Sidebar
- Claude-powered trading copilot in Portuguese
- Quick-reply buttons for common trading questions
- SSE streaming responses
- Conversation history persisted in PostgreSQL

### 6. Trade History & Daily PNL
- PostgreSQL trade log
- Daily PNL progress bar (totalPnl / dailyGoal)
- Win/loss count display

## API Routes

All routes at `/api` prefix:

- `GET /api/healthz` - Health check
- `GET /api/trades?date=YYYY-MM-DD` - List trades
- `POST /api/trades` - Record a trade
- `GET /api/trades/daily-pnl?date=YYYY-MM-DD` - Daily PNL summary
- `POST /api/analysis/analyze-charts` - AI chart vision analysis
- `GET/POST /api/anthropic/conversations` - Conversation CRUD
- `GET /api/anthropic/conversations/:id` - Get conversation with messages
- `DELETE /api/anthropic/conversations/:id` - Delete conversation
- `GET /api/anthropic/conversations/:id/messages` - List messages
- `POST /api/anthropic/conversations/:id/messages` - Send message (SSE stream)

## Database Schema

- `conversations` - Anthropic chat conversations
- `messages` - Anthropic chat messages
- `trades` - Trade history with PNL tracking

## Development Commands

- `pnpm --filter @workspace/tradesniper run dev` - Start frontend
- `pnpm --filter @workspace/api-server run dev` - Start API server
- `pnpm --filter @workspace/api-spec run codegen` - Regenerate API types
- `pnpm --filter @workspace/db run push` - Push DB schema

## Important Notes

- Binance WebSocket may be geo-blocked in Replit's server environment (error 451). Works fine in deployed/user browser environments.
- AI integration uses Replit AI Integrations proxy (no user API key needed, billed to credits)
- DB migrations use `drizzle-kit push` (dev) - production handled by Replit on deploy
