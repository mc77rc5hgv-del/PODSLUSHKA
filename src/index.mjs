import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createBot } from './bot.mjs';
import { readBotConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { telegram } from './telegram.mjs';

function readConfig() {
  if (existsSync('.env')) loadEnvFile('.env');
  const value = key => process.env[key]?.trim() || undefined;
  const volumePath = value('RAILWAY_VOLUME_MOUNT_PATH');
  if (value('RAILWAY_ENVIRONMENT_ID') && !volumePath) {
    throw new Error('Подключите постоянный диск Railway к сервису. Путь монтирования: /data.');
  }
  return {
    ...readBotConfig(process.env),
    dbPath: volumePath ? join(volumePath, 'submissions.sqlite') : value('DB_PATH') ?? 'data/submissions.sqlite',
  };
}

async function run() {
  const config = readConfig();
  const api = telegram(config.token);
  const identity = await api('getMe');
  const webhook = await api('getWebhookInfo');
  if (webhook.url) throw new Error('У бота уже настроен webhook. Для этого приложения нужен бот с отключённым webhook.');
  const store = openStore(config.dbPath);
  try {
    const bot = createBot({ api, store, config, identity });
    console.log(`Бот @${identity.username}. ${await bot.check()}`);
    await bot.recover();
    let offset;
    let lastUpdate = Date.now();
    let backoff = 1;
    while (true) {
      // After a week without updates Telegram can start from a new random update ID.
      if (Date.now() - lastUpdate > 86400000) offset = undefined;
      let updates;
      try {
        updates = await api('getUpdates', {
          offset,
          timeout: bot.pollTimeout(),
          allowed_updates: ['message', 'callback_query'],
        });
        backoff = 1;
      } catch (error) {
        if (error.code === 401) throw error;
        if (error.code === 409) throw new Error('Telegram уже обслуживает этот токен другим экземпляром бота или через webhook.');
        console.warn(error.message);
        await sleep(1000 * (error.retryAfter ?? backoff));
        backoff = Math.min(backoff * 2, 30);
        continue;
      }
      for (const update of updates) {
        await bot.update(update);
        offset = update.update_id + 1;
        lastUpdate = Date.now();
      }
      await bot.work();
    }
  } finally {
    store.close();
  }
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
