# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Frontend (Next.js)
```bash
npm run dev          # Start development server (http://localhost:3000)
npm run build        # Build production application
npm run start        # Start production server
npm run lint         # Run ESLint
```

### K-line Server (Rust)
```bash
cd kline-server
cargo build --release                                              # Build release binary
RUST_LOG=info ./target/release/kline-server                        # Run (direct connection)
SOCKS5_PROXY=127.0.0.1:7890 RUST_LOG=info ./target/release/kline-server  # Run with proxy
```

### Rolling Service (Rust)
```bash
cd rolling-service
cargo build --release
./target/release/rolling-service --config config.toml
```

### Analysis Service (Node.js)
```bash
cd analysis-service
npm run build
npm start
```

## Architecture Overview

**Professional trading terminal** with ICT (Inner Circle Trader) indicator system.

### Technology Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14 + React 18 + TypeScript + Tailwind CSS + Zustand + lightweight-charts |
| Backend API | Next.js API Routes + SQLite (better-sqlite3) + JWT (jose) + bcrypt |
| K-line Server | Rust + Axum + Tokio + WebSocket + SQLx |
| Analysis Service | Node.js + TypeScript (AI trading, tower strategies) |
| Rolling Service | Rust (grid-based rolling position strategy) |

### Frontend Structure

**State Management** (`src/stores/`)
- `indicatorStore.ts` - ICT indicators state (OTE, FVG, OB, BOS/CHoCH, Engulfing/Pinbar, etc.)
- `chartStore.ts` - Chart settings and timeframe state
- `userStore.ts` - User authentication state
- `positionStore.ts` / `orderStore.ts` - Trading state
- `agentStore.ts` - AI agent state
- `chatStore.ts` - Chat messages

**ICT Indicators** (`src/lib/chart/indicators/`)
- `ote.ts`, `fvg.ts`, `orderBlocks.ts`, `structure.ts`, `liquidity.ts`, `swingPoints.ts`
- `breakerBlocks.ts`, `killzones.ts`, `engulfingPinbar.ts`, `inducement.ts`, `pivotDetector.ts`

**Chart Primitives** (`src/lib/chart/primitives/`)
- Custom lightweight-charts v4 plugins for rendering indicators on canvas
- OrderBlockPrimitive, FVGPrimitive, OTEPrimitive, BreakerBlockPrimitive, etc.

### K-line Server Architecture (`kline-server/`)

Exchange abstraction layer with pluggable exchange adapters:
```
exchanges/
├── traits.rs      # Exchange trait interface
├── factory.rs     # Exchange factory
├── mod.rs
└── binance/       # Binance implementation
    ├── rest.rs    # REST API client
    └── websocket.rs # WebSocket client
```

Multi-timeframe K-line aggregation, WebSocket streaming, SQLite persistence.

### Analysis Service (`analysis-service/`)

AI-powered trading analysis and automation:
- `ai/` - AI auto-trader and management
- `analysis/` - ICT analysis, multi-timeframe analysis, order analysis
- `tower/` - Tower strategy blocks and scheduling
- `liqGrid/` - Liquidity grid strategy
- `order/` - Exchange order adapters (Binance, Aster)
- `signals/` - Signal tracking and performance calculation
- `notification/` - DingTalk notifications

### Rolling Service (`rolling-service/`)

Rust-based grid rolling strategy for Binance Futures:
- Price-following grid with automatic order replenishment
- Floating profit rolling
- Target price take-profit, percentage stop-loss

### API Routes

| Path | Purpose |
|------|---------|
| `/api/auth/` | JWT authentication |
| `/api/user/` | User settings, API configs, positions, orders |
| `/api/admin/` | Invite code management |
| `/api/analysis/` | Tower/liq-grid/AI management and performance stats |
| `/api/klines/` | K-line data proxy |
| `/api/rolling/` | Rolling service control |
| `/api/coinglass/` | Liquidation map data |

### Database Schema

SQLite (`/data/`): `users`, `invite_codes`, `api_configs` (AES-256-GCM encrypted), `notification_configs`

### Environment Variables

```env
JWT_SECRET=<jwt-signing-key>
API_ENCRYPTION_KEY=<32-byte-hex-key>
```

### Path Alias
`@/*` → `./src/*`

## 注意事项

1. 用中文交互
2. 尽量用 agent 模式
3. 尽可能不删除现有逻辑
4. 所有数据保证真实
