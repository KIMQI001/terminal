import { apiConfigQueries } from '@/lib/db';
import { decrypt } from '@/lib/crypto';

// 获取解密后的 API 配置
export async function getDecryptedApiConfig(userId: number, exchange: string) {
  const config = apiConfigQueries.findByUserAndExchange(userId, exchange);
  if (!config) {
    return null;
  }

  return {
    exchange: config.exchange,
    apiKey: config.api_key,
    apiSecret: decrypt(config.api_secret_encrypted),
    passphrase: config.passphrase_encrypted ? decrypt(config.passphrase_encrypted) : undefined,
    isTestnet: config.is_testnet === 1,
  };
}
