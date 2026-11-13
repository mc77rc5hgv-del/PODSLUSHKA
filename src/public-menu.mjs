import { adminButton } from './admin.mjs';

export const channelName = 'ПОДСЛУШКА ВМЕДА';

export const botDescription = `💬 ${channelName}

📣 1. Подпишитесь на канал.
✅ 2. Проверьте подписку в боте.
📨 3. Пришлите материал и выберите, как его подписать.

🔒 Вы можете отправить пост анонимно или добавить свой @username. Пост выйдет после одобрения.

Откройте /start, чтобы начать.`;

const guideButton = { text: '📖 Что можно отправить', callback_data: 'public:help' };
export const channelButton = url => ({ text: '📣 Открыть канал', url, style: 'primary' });

export function publicKeyboard({ url, subscribed, isAdmin, screen = 'home' }) {
  const buttons = [[channelButton(url)]];
  if (subscribed !== true) {
    buttons.push([{ text: '✅ Проверить подписку', callback_data: 'subscribe:check', style: 'success' }]);
  }
  buttons.push([screen === 'help'
    ? { text: '🏠 Главное меню', callback_data: 'public:home' }
    : guideButton]);
  if (isAdmin) buttons.push([adminButton]);
  return { inline_keyboard: buttons };
}

export function publicScreen(screen, options) {
  const { subscribed } = options;
  const subscription = subscribed === true
    ? '✅ <b>Подписка подтверждена</b> · можно отправлять заявку.'
    : subscribed === false
      ? '🔔 <b>Нужна подписка</b> · откройте канал, подпишитесь и вернитесь сюда для проверки.'
      : '⚠️ <b>Статус подписки пока недоступен</b> · попробуйте проверить её ещё раз.';
  const steps = subscribed === true
    ? '✍️ <b>1.</b> Пришлите текст или вложение.\n🔒 <b>2.</b> Выберите «Анонимно» или «С моим @username».\n🧾 <b>3.</b> Получите номер заявки.'
    : '📣 <b>1.</b> Подпишитесь на канал.\n✅ <b>2.</b> Нажмите «Проверить подписку».\n📨 <b>3.</b> Отправьте материал сюда обычным сообщением.';

  const home = `💬 <b>${channelName}</b>
Привет! Здесь можно предложить пост для канала.

${subscription}

<b>Как предложить пост</b>
${steps}

📎 Текст, фото, видео, GIF, файлы, стикеры и альбомы.
🕒 Пост выйдет после одобрения.

🔒 <b>Вы сами выбираете подпись.</b> При анонимной отправке бот не добавит ваш @username. Уберите личные данные из текста и вложений, если хотите их скрыть.`;

  const help = `📖 <b>Что можно отправить</b>

✍️ <b>Текст</b> — напишите или вставьте его в чат.
📷 <b>Фото, видео или GIF</b> — добавьте подпись в Telegram, если она нужна.
🖼 <b>Альбом</b> — выберите несколько медиа и отправьте их вместе.
📎 <b>Файл или стикер</b> — прикрепите и отправьте в этот чат.

📨 После отправки выберите подпись. До выбора заявка остаётся черновиком.
🔒 <b>Анонимно</b> — бот не добавит ваш @username к посту.
✍️ <b>С моим @username</b> — бот добавит ссылку на ваш профиль.

${subscription}`;

  return {
    text: screen === 'help' ? help : home,
    parse_mode: 'HTML',
    reply_markup: publicKeyboard({ ...options, screen }),
  };
}

export function signaturePrompt({ id, username, version }) {
  const buttons = [[{ text: '🔒 Анонимно', callback_data: `draft:anonymous:${id}:${version}`, style: 'primary' }]];
  if (username) {
    buttons.push([{ text: `✍️ С @${username}`, callback_data: `draft:signed:${id}:${version}`, style: 'success' }]);
  }
  buttons.push([{ text: 'Отменить черновик', callback_data: `draft:cancel:${id}:${version}` }]);
  return {
    text: [
      `📨 <b>Черновик №${id}</b>`,
      '',
      'Как подписать пост, если его одобрят?',
      '🔒 <b>Анонимно</b> — бот не добавит данные автора к посту.',
      username
        ? `✍️ <b>С подписью</b> — в посте появится ссылка @${username}.`
        : '✍️ Для подписи нужен @username в профиле Telegram. Укажите его и отправьте материал заново.',
      '',
      '🕒 Черновик доступен 24 часа.',
    ].join('\n'),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: buttons },
  };
}
