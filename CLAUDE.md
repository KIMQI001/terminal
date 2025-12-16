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

## Architecture Overview

This is a **professional trading terminal** with ICT (Inner Circle Trader) indicator system, built with Next.js 14 frontend and Rust WebSocket server for real-time K-line data.

### Technology Stack

**Frontend**: Next.js 14 + React 18 + TypeScript + Tailwind CSS + Zustand + lightweight-charts
**Backend**: Next.js API Routes + SQLite (better-sqlite3) + JWT (jose) + bcrypt
**K-line Server**: Rust + Axum + Tokio + WebSocket + SQLx

### Key Architecture Components

1. **State Management** (`/src/stores/`)
   - `indicatorStore.ts` - ICT indicators state (OTE, FVG, OB, BOS/CHoCH, etc.)
   - `chartStore.ts` - Chart settings and timeframe state
   - `userStore.ts` - User authentication state
   - `positionStore.ts` / `orderStore.ts` - Trading state

2. **ICT Indicators** (`/src/lib/chart/indicators/`)
   - `ote.ts` - Optimal Trade Entry zones
   - `fvg.ts` - Fair Value Gaps
   - `orderBlocks.ts` - Order Blocks
   - `structure.ts` - BOS/CHoCH market structure
   - `liquidity.ts` - Liquidity zones
   - `swingPoints.ts` - Swing high/low detection

3. **Chart Primitives** (`/src/lib/chart/primitives/`)
   - Custom lightweight-charts plugins for rendering indicators on canvas

4. **API Routes** (`/src/app/api/`)
   - `/auth/` - JWT authentication
   - `/user/` - User settings, API configs, positions
   - `/admin/` - Invite code management
   - `/analysis/` - Tower management, grid strategies

5. **K-line Server** (`/kline-server/src/`)
   - `main.rs` - WebSocket server entry point
   - `exchanges/` - Exchange adapters (Binance, etc.)
   - `binance/` - Binance-specific implementation
   - Multi-timeframe K-line aggregation and real-time streaming

### Database Schema

SQLite database (`/data/`) with tables:
- `users` - User accounts with roles
- `invite_codes` - Invitation system
- `api_configs` - Exchange API keys (encrypted with AES-256-GCM)
- `notification_configs` - DingTalk notification settings

### Environment Variables

Required in `.env.local`:
```
JWT_SECRET=<jwt-signing-key>
API_ENCRYPTION_KEY=<32-byte-hex-key>
```

### Path Alias

- `@/*` → `./src/*`

## 注意事项

1. 用中文交互
2. 尽量用 agent 模式
3. 尽可能不删除现有逻辑
4. 所有数据保证真实
