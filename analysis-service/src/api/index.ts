/**
 * HTTP API 服务器
 * 提供信号和绩效数据的 REST API
 */

import express from 'express';
import cors from 'cors';
import { signalRoutes } from './routes/signals';
import { performanceRoutes } from './routes/performance';

/**
 * 启动 HTTP API 服务器
 */
export function startApiServer(port: number = 3002): void {
  const app = express();

  // 中间件
  app.use(cors());
  app.use(express.json());

  // 健康检查
  app.get('/api/health', (_req, res) => {
    res.json({
      success: true,
      message: 'Analysis Service API is running',
      timestamp: new Date().toISOString(),
    });
  });

  // 路由
  app.use('/api/signals', signalRoutes);
  app.use('/api/performance', performanceRoutes);

  // 404 处理
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: 'Endpoint not found',
    });
  });

  // 错误处理
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[API] Error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Internal server error',
    });
  });

  // 启动服务器 (只监听本地，通过 Next.js 代理访问)
  app.listen(port, '127.0.0.1', () => {
    console.log(`[API] HTTP 服务器运行在 http://127.0.0.1:${port}`);
    console.log('[API] 可用端点:');
    console.log('  - GET /api/health');
    console.log('  - GET /api/signals?status=all|pending|entered|completed&days=30');
    console.log('  - GET /api/signals/stats?days=30');
    console.log('  - GET /api/signals/:id');
    console.log('  - GET /api/performance/daily');
    console.log('  - GET /api/performance/weekly');
    console.log('  - GET /api/performance/stats?days=30');
    console.log('  - GET /api/performance/equity-curve?days=30');
    console.log('  - GET /api/performance/overview');
  });
}
