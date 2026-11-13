import { adminButton, adminPanel, isReviewable } from './admin.mjs';
import { preview, publication, readContent } from './content.mjs';
import { channelButton, channelName, publicKeyboard, publicScreen, signaturePrompt } from './public-menu.mjs';
import { TelegramError } from './telegram.mjs';

const setupNotice = 'Бот ещё настраивается. Приём сообщений откроется после настройки.';
const draftLifetime = 24 * 60 * 60 * 1000;

const statusText = {
  pending: '🕒 Ожидает решения. Выберите действие ниже.',
  approved: '⏳ Публикуется',
  published: '✅ Опубликовано',
  rejected: '❌ Отклонено',
  failed: '⚠️ Telegram отклонил отправку. Проверьте /check и повторите.',
  uncertain: '🔎 Telegram мог принять отправку. Проверьте этот шаг в канале перед выбором.',
};

function card(row) {
  const buttons = {
    pending: [['✅ Опубликовать', 'approve', 'success'], ['❌ Отклонить', 'reject', 'danger']],
    failed: [['🔄 Повторить отправку', 'retry', 'primary']],
    uncertain: [['✅ Шаг есть в канале', 'confirm', 'success'], ['🔄 Шага нет · повторить', 'retry', 'primary']],
  }[row.status] ?? [];
  const keyboard = buttons.map(([text, action, style]) => ({
    text,
    callback_data: `${action}:${row.id}:${row.version}`,
    style,
  }));
  let status = statusText[row.status];
  if (row.status === 'uncertain') {
    status += row.step === 0 ? ' Шаг: материал заявки.' : ' Шаг: сообщение с подписью или ссылками.';
  }
  const author = row.username
    ? `@${row.username.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}`
    : 'без @username';
  const actions = row.status === 'uncertain' ? keyboard.map(button => [button]) : keyboard.length ? [keyboard] : [];
  const signature = row.public_username ? `@${row.public_username}` : 'анонимно';
  return {
    text: `📨 <b>Заявка №${row.id}</b>\n👤 Автор: ${author}\n🆔 Telegram ID: <code>${row.chat_id}</code>\n📣 В канале: ${signature}\n\n${status}`,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [...actions, [adminButton]] },
  };
}

function retryAt(error, now) {
  return now + 1000 * (error.retryAfter ?? 15);
}

function usernameOf(user) {
  return /^[a-zA-Z0-9_]{1,32}$/.test(user.username ?? '') ? user.username : null;
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

  function publicOptions(userId, subscribed) {
    return { url: target.links[0].url, subscribed, isAdmin: userId === adminId };
  }

  function subscriptionPrompt(subscribed) {
    const prompt = subscribed === false
      ? '🔔 <b>Подпишитесь на канал</b>\nОткройте канал, подпишитесь и нажмите «Проверить подписку».'
      : '⚠️ <b>Статус подписки пока недоступен</b>\nНажмите «Проверить подписку», чтобы повторить проверку.';
    return `${prompt}\n\n📨 После подтверждения отправьте материал ещё раз.`;
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
        { text: `📣 ${channelName}`, url, style: 'primary' },
        { text: '✍️ Предложить пост', url: `https://t.me/${identity.username}`, style: 'success' },
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
      const screen = command === '/help' ? 'help' : 'home';
      return attempt('sendMessage', { chat_id: id, ...publicScreen(screen, publicOptions(id, await membership(id))) });
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
          text: subscriptionPrompt(subscribed),
          parse_mode: 'HTML',
          reply_markup: publicKeyboard(publicOptions(id, subscribed)),
        });
      }
      return;
    }
    store.accept(message, content, now(), usernameOf(message.from));
  }

  async function refreshCard(id) {
    const row = store.get(id);
    await attempt('editMessageText', { chat_id: adminId, message_id: row.card_id, ...card(row) });
  }

  async function onSignature(query, match, respond) {
    const [, action, id, version] = match;
    const sender = query.from.id;
    const row = store.get(Number(id));
    if (row?.chat_id !== sender || query.message?.chat?.id !== sender) return respond('Черновик недоступен.');
    if (row.status !== 'awaiting_signature' || row.due <= now()) return respond('Выбор уже закрыт.');
    const edit = params => attempt('editMessageText', { chat_id: sender, message_id: query.message.message_id, ...params });
    if (row.version !== Number(version)) {
      await respond('Проверьте обновлённую подпись и выберите снова.');
      return edit(signaturePrompt(row));
    }
    if (action === 'cancel') {
      store.finish(row.id, 'cancelled');
      await respond('Черновик отменён.');
      return edit({ text: `Черновик №${row.id} отменён. Чтобы начать заново, пришлите материал.`, reply_markup: { inline_keyboard: [] } });
    }
    if (!target) return respond(setupNotice);
    const username = action === 'signed' ? usernameOf(query.from) : null;
    if (action === 'signed' && username !== row.username) {
      store.updateDraftUsername(row.id, username);
      await respond('Ваш @username изменился. Проверьте подпись и выберите снова.');
      return edit(signaturePrompt(store.get(row.id)));
    }
    if (action === 'signed' && !username) return respond('Укажите @username в Telegram или выберите «Анонимно».');
    const subscribed = await membership(sender);
    if (subscribed !== true) {
      return respond(subscribed === false ? 'Подпишитесь на канал и повторите выбор.' : 'Проверка подписки недоступна. Попробуйте ещё раз.');
    }
    store.chooseSignature(row.id, username, now());
    await respond('Заявка отправлена на модерацию.');
    return edit({
      text: `✅ <b>Заявка №${row.id} принята</b>\n\n📣 В канале: ${username ? `@${username}` : 'анонимно'}.\n🕒 Пост появится после одобрения.`,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[channelButton(target.links[0].url)]] },
    });
  }

  async function onCallback(query) {
    const respond = text => attempt('answerCallbackQuery', { callback_query_id: query.id, text });
    const signature = /^draft:(anonymous|signed|cancel):(\d{1,15}):(\d{1,15})$/.exec(query.data ?? '');
    if (signature) return onSignature(query, signature, respond);
    if (['subscribe:check', 'public:home', 'public:help'].includes(query.data)) {
      if (query.message?.chat?.id !== query.from.id) return respond('Откройте личный чат с ботом.');
      if (!target) return respond(setupNotice);
      const checking = query.data === 'subscribe:check';
      if (!checking) await respond();
      const subscribed = await membership(query.from.id);
      if (checking && subscribed !== true) {
        return respond(subscribed === false ? 'Подписка пока не найдена. Подпишитесь и повторите.' : 'Не удалось проверить подписку. Попробуйте ещё раз.');
      }
      if (checking) await respond('Подписка подтверждена. Можно отправлять заявку.');
      await attempt('editMessageText', {
        chat_id: query.from.id,
        message_id: query.message.message_id,
        ...publicScreen(query.data === 'public:help' ? 'help' : 'home', publicOptions(query.from.id, subscribed)),
      });
      return;
    }
    if (query.from.id !== adminId || query.message?.chat?.id !== adminId) return respond('Доступ закрыт.');
    if (query.data === 'panel:home') {
      await respond();
      return showAdmin();
    }
    const panelAction = /^panel:(page|open):(\d{1,15})(?::(all|pending|attention))?$/.exec(query.data ?? '');
    if (panelAction) {
      const [, action, value, filter] = panelAction;
      if (action === 'page') {
        await respond('Панель обновлена.');
        return attempt('editMessageText', {
          chat_id: adminId,
          message_id: query.message.message_id,
          ...adminPanel(store, Number(value), filter),
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
        store.approve(row.id, publication(target.chatId, store.parts(row.id), target.links, row.public_username), now());
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
      if (row.status === 'awaiting_signature') return store.finish(row.id, 'cancelled');
      try {
        if (row.status === 'draft') {
          await api('sendMessage', {
            chat_id: row.chat_id,
            reply_parameters: { message_id: store.firstMessageId(row.id), allow_sending_without_reply: true },
            ...signaturePrompt(row),
          });
          store.awaitSignature(row.id, now() + draftLifetime);
        } else {
          await sendPreview(row);
        }
      } catch (error) {
        if (!(error instanceof TelegramError)) throw error;
        log(error.message);
        if (row.status === 'draft' && error.code === 403) return store.finish(row.id, 'cancelled');
        store.defer(row.id, retryAt(error, now()));
      }
    },
  };
}
