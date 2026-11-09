import { adminButton, adminPanel, isReviewable } from './admin.mjs';
import { preview, publication, readContent } from './content.mjs';
import { TelegramError } from './telegram.mjs';

const channelName = 'ПОДСЛУШКА ВМЕДА';
const instructions = `Хотите предложить пост в «${channelName}»?

Подпишитесь на канал, чтобы отправить заявку. Просто пришлите сюда текст, фото, видео, GIF, файл или стикер. Можно добавить подпись или отправить альбом.

Публикации в канале полностью анонимны. Бот не раскрывает вашу личность подписчикам. Чтобы сохранить анонимность, не указывайте личные данные в тексте и вложениях.

После одобрения бот опубликует присланный материал со ссылками на канал и бота.`;
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
    reply_markup: { inline_keyboard: [...(keyboard.length ? [keyboard] : []), [adminButton]] },
  };
}

function retryAt(error, now) {
  return now + 1000 * (error.retryAfter ?? 15);
}

export function createBot({ api, store, config, identity, now = Date.now, log = console.warn }) {
  let target;
  let lastAlbum;
  const { adminId, channelId, channelUrl } = config;
  async function attempt(method, params) {
    try {
      await api(method, params);
    } catch (error) {
      log(error.message);
    }
  }

  const say = (chatId, text) => attempt('sendMessage', { chat_id: chatId, text });
  const showAdmin = () => attempt('sendMessage', {
    chat_id: adminId,
    protect_content: true,
    ...adminPanel(store, 0),
  });

  async function membership(userId) {
    try {
      const { status, is_member } = await api('getChatMember', { chat_id: target.chatId, user_id: userId });
      return ['creator', 'administrator', 'member'].includes(status) || (status === 'restricted' && is_member === true);
    } catch (error) {
      log(error.message);
      return undefined;
    }
  }

  function subscriberMenu(userId, subscribed) {
    const keyboard = [[{ text: 'Открыть канал', url: target.links[0].url }]];
    if (subscribed !== true) keyboard.push([{ text: 'Я подписался', callback_data: 'subscribe:check' }]);
    if (userId === adminId) keyboard.push([adminButton]);
    return { inline_keyboard: keyboard };
  }

  function subscriptionPrompt(subscribed, retry = false) {
    const prompt = subscribed === false
      ? 'Подпишитесь на канал и нажмите «Я подписался».'
      : 'Telegram пока не подтвердил подписку. Нажмите «Я подписался», чтобы проверить её ещё раз.';
    return retry ? `${prompt} Затем отправьте заявку ещё раз.` : prompt;
  }

  function welcome(userId, subscribed) {
    return {
      text: subscribed === true ? instructions : `${instructions}\n\n${subscriptionPrompt(subscribed)}`,
      reply_markup: subscriberMenu(userId, subscribed),
    };
  }

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
    if (command === '/admin') return id === adminId ? showAdmin() : say(id, 'Панель доступна администратору.');
    if (command === '/start' || command === '/help') {
      if (!target) return say(id, setupNotice);
      return attempt('sendMessage', { chat_id: id, ...welcome(id, await membership(id)) });
    }
    if (!target) return say(id, setupNotice);

    const content = readContent(message);
    if (!content) return say(id, 'Пришлите текст, фото, видео, GIF, файл или стикер.');
    const album = message.media_group_id;
    const sameAlbum = album && lastAlbum?.id === album && lastAlbum.sender === id && lastAlbum.until > now();
    const subscribed = sameAlbum ? lastAlbum.subscribed : await membership(id);
    if (album && !sameAlbum) lastAlbum = { id: album, sender: id, subscribed, until: now() + 10_000 };
    if (subscribed !== true) {
      if (!sameAlbum) {
        await attempt('sendMessage', {
          chat_id: id,
          text: subscriptionPrompt(subscribed, true),
          reply_markup: subscriberMenu(id, subscribed),
        });
      }
      return;
    }
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
    if (query.data === 'subscribe:check') {
      if (query.message?.chat?.id !== query.from.id) return respond('Откройте личный чат с ботом.');
      if (!target) return respond(setupNotice);
      const subscribed = await membership(query.from.id);
      if (subscribed !== true) {
        return respond(subscribed === false ? 'Подписка пока не найдена. Подпишитесь и повторите.' : 'Не удалось проверить подписку. Попробуйте ещё раз.');
      }
      await respond('Подписка подтверждена. Можно отправлять заявку.');
      await attempt('editMessageText', {
        chat_id: query.from.id,
        message_id: query.message.message_id,
        ...welcome(query.from.id, true),
      });
      return;
    }
    if (query.from.id !== adminId || query.message?.chat?.id !== adminId) return respond('Доступ закрыт.');
    if (query.data === 'panel:home') {
      await respond();
      return showAdmin();
    }
    const panelAction = /^panel:(page|open):(\d{1,15})$/.exec(query.data ?? '');
    if (panelAction) {
      const [, action, value] = panelAction;
      if (action === 'page') {
        await respond('Панель обновлена.');
        return attempt('editMessageText', {
          chat_id: adminId,
          message_id: query.message.message_id,
          ...adminPanel(store, Number(value)),
        });
      }
      const row = store.get(Number(value));
      if (!row || !isReviewable(row.status)) return respond('Заявка уже обработана. Обновите панель.');
      await respond(`Открываю заявку №${row.id}.`);
      try {
        const previewId = await deliverPreview(row.id);
        const message = await sendCard(row, previewId);
        store.replaceCard(row.id, message.message_id, previewId);
        await attempt('editMessageReplyMarkup', {
          chat_id: adminId,
          message_id: row.card_id,
          reply_markup: { inline_keyboard: [[adminButton]] },
        });
      } catch (error) {
        if (!(error instanceof TelegramError)) throw error;
        log(error.message);
        await say(adminId, 'Не удалось открыть заявку. Попробуйте ещё раз.');
      }
      return;
    }
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

  async function deliverPreview(id) {
    const [method, params] = preview(adminId, store.parts(id));
    const sent = await api(method, params);
    return (Array.isArray(sent) ? sent[0] : sent).message_id;
  }

  function sendCard(row, previewId) {
    return api('sendMessage', {
      chat_id: adminId,
      protect_content: true,
      reply_parameters: { message_id: previewId, allow_sending_without_reply: true },
      ...card(row),
    });
  }

  async function sendPreview(row) {
    let previewId = row.preview_id;
    if (!previewId) {
      previewId = await deliverPreview(row.id);
      store.previewSent(row.id, previewId);
    }
    const message = await sendCard({ ...row, status: 'pending' }, previewId);
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
