/**
 * pm2 部署配置 —— 前端(Next.js)
 *
 * 用法(在项目根目录):
 *   npm run build                 # ① 必须先构建
 *   pm2 start ecosystem.config.js  # ② 启动
 *   pm2 reload ecosystem.config.js # ③ 重新加载(滚动重启)
 *   pm2 logs terminal-web          # ④ 看日志
 *   pm2 delete terminal-web        # ⑤ 停止
 *
 * ⚠️ 重要:NEXT_PUBLIC_* 会被**内联进浏览器 bundle**,只能在 `npm run build` 之前生效,
 *    放到 pm2 的 env 里运行时再设是**无效**的。生产环境请写进 `.env.production`,
 *    或在 build 时用 `NEXT_PUBLIC_KLINE_API=... npm run build` 一次性传入。
 *
 *    需要在**运行时**读取的变量(如 JWT_SECRET / API_ENCRYPTION_KEY)放 `.env.production`
 *    或 pm2 的 env 都可以 —— Next.js 的 `next start` 会自动读取 `.env` / `.env.production`。
 */

const fs = require("fs");
const path = require("path");

// pm2 不会自动创建日志目录,这里先建好
const logDir = path.join(__dirname, "logs");
fs.mkdirSync(logDir, { recursive: true });

module.exports = {
  apps: [
    {
      name: "terminal-web",
      // 直接指向 next 的 CLI,少一层 npm 进程
      script: path.join(__dirname, "node_modules/next/dist/bin/next"),
      args: "start",
      // cwd 必须是项目根 —— .env / data(SQLite)/ public 的相对路径都基于它
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      // Next.js 单实例常驻内存不小,给到 1G 再重启
      max_memory_restart: "1G",
      // 启动慢时给足时间,避免被 pm2 判定为启动失败
      listen_timeout: 20000,
      kill_timeout: 10000,
      exp_backoff_restart_delay: 1000,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        HOSTNAME: "0.0.0.0",
      },
      error_file: path.join(logDir, "error.log"),
      out_file: path.join(logDir, "out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      time: true,
    },
  ],
};
