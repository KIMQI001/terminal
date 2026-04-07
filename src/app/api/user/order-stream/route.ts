/**
 * 订单实时更新 SSE 代理
 * 前端通过此端点订阅订单更新，后端转发到 analysis-service
 */

import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const userId = 1; // TODO: 从 session 获取

  // 创建 SSE 连接
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // 发送初始连接消息
      controller.enqueue(encoder.encode('data: {"type":"connecting"}\n\n'));

      try {
        // 连接到 analysis-service
        const response = await fetch(`http://127.0.0.1:3002/api/user-stream/order`, {
          headers: {
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });

        if (!response.ok) {
          controller.enqueue(encoder.encode(`data: {"type":"error","message":"连接失败: ${response.statusText}"}\n\n`));
          controller.close();
          return;
        }

        // 转发数据
        const reader = response.body?.getReader();
        if (!reader) {
          controller.enqueue(encoder.encode(`data: {"type":"error","message":"无法获取响应流"}\n\n`));
          controller.close();
          return;
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }

        controller.close();
      } catch (error) {
        console.error('[OrderStream] SSE 代理错误:', error);
        controller.enqueue(encoder.encode(`data: {"type":"error","message":"${error instanceof Error ? error.message : '连接失败'}"}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
