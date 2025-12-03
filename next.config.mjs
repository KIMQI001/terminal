/** @type {import('next').NextConfig} */
const nextConfig = {
  // 移除了 serverExternalPackages: ['ws']
  // 因为 liquidation API 现在使用 HTTP 而不是 WebSocket
};

export default nextConfig;