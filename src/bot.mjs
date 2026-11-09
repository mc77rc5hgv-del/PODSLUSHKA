import { preview, publication, readContent } from './content.mjs';
import { TelegramError } from './telegram.mjs';

const channelName = 'Подслушка в мида';
const instructions = `Хотите предложить пост в «${channelName}»?

Просто пришлите сюда текст, фото, видео, GIF, файл или стикер. К медиа можно добавить подпись в Telegram. Альбом можно отправить одним сообщением.

Администратор увидит ваш Telegram ID и @username, если он у вас есть. После одобрения бот опубликует только присланный материал со ссылками на канал и бота.`;
const setupNotice = 'Бот ещё настраивается. Приём сообщений откроется после настройки.';

const statusText = {
  pending: 'Ожидает решения',
  approved: '⏳ Публикуется',
  published: '✅ Опубликовано',
  rejected: '❌ Отклонено',
  failed: 'Telegram отклонил отправку. Проверьте /check и повторите.',
  uncertain: 'Telegram мог принять отправку. Проверьте этот шаг в канале перед выбором.',
};

function card(row) {
  const buttons = {
    pending: [['✅ Опубликовать', 'approve'], ['❌ Отклонить', 'reject']],
    failed: [['Повторить отправку', 'retry']],
    uncertain: [['Этот шаг есть в канале', 'confirm'], ['Шага в канале нет. Повторить', 'retry']],
  }[row.status] ?? [];
  const keyboard = buttons.map(([text, action]) => ({
    text,
    callback_data: `${action}:${row.id}:${row.version}`,
  }));
  let status = statusText[row.status];
  if (row.status === 'uncertain') {
    status += row.step === 0 ? ' Шаг: материал заявки.' : ' Шаг: сообщение со ссылками под альбомом.';
  }
  return {
    text: `Заявка №${row.id}\nАвтор: ${row.username ? `@${row.username}` : 'без @username'}\nTelegram ID: ${row.chat_id}\n\n${status}`,
    reply_markup: { inline_keyboard: keyboard.length ? [keyboard] : [] },
  };
}

function retryAt(error, now) {
  return now + 1000 * (error.retryAfter ?? 15);
}

export function createBot({ api, store, config, identity, now = Date.now, log = console.warn }) {
  let target;
  const { adminId, channelId, channelUrl } = config;
  async function attempt(method, params) {
    try {
      await api(method, params);
    } catch (error) {
      log(error.message);
    }
  }

  const say = (chatId, text) => attempt('sendMessage', { chat_id: chatId, text });

  async function checkTarget() {
    if (!adminId || !channelId) throw new Error('Заполните ADMIN_ID и CHANNEL_ID.');
    const chat = await api('getChat', { chat_id: channelId });
    if (chat.type !== 'channel') throw new Error('CHANNEL_ID должен указывать на канал.');
    const member = await api('getChatMember', { chat_id: chat.id, user_id: identity.id });
    if (member.status !== 'creator' && !member.can_post_messages) {
      throw new Error('Выдайте боту право публиковать сообщения в канале.');
    }
    const url = channelUrl || (chat.username && `https://t.me/${chat.username}`);
    if (!url) throw new Error('Укажите ссылку-приглашение в CHANNEL_URL.');
    target = {
      chatId: chat.id,
      links: [
        { text: channelName, url },
        { text: 'Предложить пост', url: `https://t.me/${identity.username}` },
      ],
    };
  }

  async function check() {
    try {
      await checkTarget();
      return 'Канал подключён. Бот может публиковать сообщения.';
    } catch (error) {
      target = undefined;
      return `Настройка: ${error.message}`;
    }
  }

  async function onMessage(message) {
    if (message.chat.type !== 'private' || !message.from || message.from.is_bot) return;
    const id = message.from.id;
    const command = message.text?.split(/\s+/, 1)[0];
    if (command === '/id') return say(id, `Ваш Telegram ID: ${id}`);
    if (command === '/check' && id === adminId) return say(id, await check());
    if (command === '/start' || command === '/help') return say(id, target ? instructions : setupNotice);
    if (!target) return say(id, setupNotice);

    const content = readContent(message);
    if (!content) return say(id, 'Пришлите текст, фото, видео, GIF, файл или стикер.');
    const accepted = store.accept(message, content, now());
    if (accepted?.first) {
      await attempt('sendMessage', { chat_id: id, text: `Заявка №${accepted.id} принята. Администратор её проверит.` });
    }
  }

  async function refreshCard(id) {
    const row = store.get(id);
    await attempt('editMessageText', { chat_id: adminId, message_id: row.card_id, ...card(row) });
  }

  async function onCallback(query) {
    const respond = text => attempt('answerCallbackQuery', { callback_query_id: query.id, text });
    if (query.from.id !== adminId || query.message?.chat?.id !== adminId) return respond('Доступ закрыт.');
    const match = /^(approve|reject|retry|confirm):(\d+):(\d+)$/.exec(query.data ?? '');
    const row = match && store.get(Number(match[2]));
    if (!row || row.card_id !== query.message.message_id) return respond('Эта карточка больше не действует.');

    const action = match[1];
    let result = 'Решение уже изменилось.';
    if (row.version === Number(match[3])) {
      if (action === 'reject' && row.status === 'pending') {
        store.finish(row.id, 'rejected');
        result = 'Заявка отклонена.';
      } else if (!target) {
        return respond('Сначала проверьте подключение канала через /check.');
      } else if (action === 'approve' && row.status === 'pending') {
        store.approve(row.id, publication(target.chatId, store.parts(row.id), target.links), now());
        result = 'Заявка отправлена на публикацию.';
      } else if (action === 'retry' && ['failed', 'uncertain'].includes(row.status)) {
        store.resume(row.id, now());
        result = 'Повторяю отправку.';
      } else if (action === 'confirm' && row.status === 'uncertain') {
        store.resume(row.id, now(), 1);
        result = 'Отправка этого шага подтверждена.';
      }
    }
    await respond(result);
    await refreshCard(row.id);
  }

  async function sendPreview(row) {
    let previewId = row.preview_id;
    if (!previewId) {
      const [method, params] = preview(adminId, store.parts(row.id));
      const sent = await api(method, params);
      previewId = (Array.isArray(sent) ? sent[0] : sent).message_id;
      store.previewSent(row.id, previewId);
    }
    const message = await api('sendMessage', {
      chat_id: adminId,
      protect_content: true,
      reply_parameters: { message_id: previewId, allow_sending_without_reply: true },
      ...card({ ...row, status: 'pending' }),
    });
    store.pending(row.id, message.message_id);
  }

  async function publish(row) {
    const plan = JSON.parse(row.plan);
    if (plan[0][1].chat_id !== target.chatId) {
      store.publicationError(row.id, 'failed');
      return refreshCard(row.id);
    }
    for (const [method, params] of plan.slice(row.step)) {
      store.startStep(row.id);
      try {
        await api(method, params);
      } catch (error) {
        log(error.message);
        const definite = error.code >= 400 && error.code < 500;
        store.publicationError(row.id, error.code === 429 ? 'approved' : definite ? 'failed' : 'uncertain');
        if (error.code === 429) store.defer(row.id, retryAt(error, now()));
        return refreshCard(row.id);
      }
      store.stepDone(row.id);
    }
    store.finish(row.id, 'published');
    await refreshCard(row.id);
  }

  return {
    check,
    async recover() {
      if (!adminId) return;
      for (const { id } of store.recover()) await refreshCard(id);
    },
    async update(update) {
      if (update.message) await onMessage(update.message);
      if (update.callback_query) await onCallback(update.callback_query);
    },
    isReady: () => Boolean(target),
    pollTimeout() {
      const row = target && store.next();
      return row ? Math.max(0, Math.min(20, Math.ceil((row.due - now()) / 1000))) : 20;
    },
    async work() {
      const row = target && store.next();
      if (!row || row.due > now()) return;
      if (row.status === 'approved') return publish(row);
      try {
        await sendPreview(row);
      } catch (error) {
        if (!(error instanceof TelegramError)) throw error;
        log(error.message);
        store.defer(row.id, retryAt(error, now()));
      }
    },
  };
}
