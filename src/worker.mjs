import { DurableObject } from 'cloudflare:workers';
import { createBot } from './bot.mjs';
import { readBotConfig } from './config.mjs';
import { createStore } from './store-core.mjs';
import { telegram } from './telegram.mjs';

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/healthz') {
      const ready = env.BOT_TOKEN && env.WEBHOOK_SECRET && env.ADMIN_ID && env.CHANNEL_ID;
      return new Response(ready ? 'ok' : 'configuration required', { status: ready ? 200 : 503 });
    }
    const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (path !== '/telegram' || request.method !== 'POST' || !env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return new Response('Not found', { status: 404 });
    }
    return env.QUEUE.getByName('moderation').fetch(request);
  },
};

export class ModerationQueue extends DurableObject {
  #store;
  #bot;
  #tail = Promise.resolve();

  constructor(ctx, env) {
    super(ctx, env);
    const { sql } = ctx.storage;
    this.#store = createStore({
      exec: query => sql.exec(query).toArray(),
      prepare: query => ({
        all: (...args) => sql.exec(query, ...args).toArray(),
        get: (...args) => sql.exec(query, ...args).toArray()[0],
        run: (...args) => sql.exec(query, ...args).toArray(),
      }),
    }, operation => ctx.storage.transactionSync(operation));
  }

  // An alarm and a webhook can arrive together, including during a Telegram API call.
  #serialize(operation) {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  async #getBot() {
    if (!this.#bot) {
      const config = readBotConfig(this.env);
      const api = telegram(config.token);
      const identity = await api('getMe');
      const bot = createBot({ api, store: this.#store, config, identity });
      await bot.check();
      this.#bot = bot;
    }
    return this.#bot;
  }

  async #schedule(bot, replace = false) {
    const { storage } = this.ctx;
    const row = this.#store.next();
    if (!row) {
      if (replace) await storage.deleteAlarm();
      return;
    }
    const due = Math.max(row.due, Date.now() + (bot.isReady() ? 1 : 60_000));
    const current = await storage.getAlarm();
    if (replace || current === null || due < current) await storage.setAlarm(due);
  }

  async fetch(request) {
    let update;
    try {
      update = await request.json();
      if (!Number.isSafeInteger(update?.update_id)) throw new Error('Invalid update');
    } catch {
      return new Response('Invalid update', { status: 400 });
    }

    return this.#serialize(async () => {
      const bot = await this.#getBot();
      await bot.update(update);
      await this.#schedule(bot);
      return new Response('ok');
    });
  }

  alarm() {
    return this.#serialize(async () => {
      // If the instance stops during an external send, recheck the saved status.
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      const bot = await this.#getBot();
      await bot.recover();
      if (!bot.isReady() && this.#store.next()) await bot.check();
      await bot.work();
      await this.#schedule(bot, true);
    });
  }
}
