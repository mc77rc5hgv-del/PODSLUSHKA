import { adminButton } from './admin.mjs';

export const channelName = 'ПОДСЛУШКА ВМЕДА';

export const botDescription = `💬 ${channelName}

📣 1. Подпишитесь на канал.
✅ 2. Проверьте подписку в боте.
📨 3. Пришлите текст, фото, видео, GIF, файл или стикер.

🔒 Публикации в канале полностью анонимны. Уберите личные данные из материала перед отправкой.

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
    ? '✍️ <b>1.</b> Напишите текст или прикрепите материал.\n📨 <b>2.</b> Отправьте его сюда обычным сообщением.\n🧾 <b>3.</b> Дождитесь номера заявки.'
    : '📣 <b>1.</b> Подпишитесь на канал.\n✅ <b>2.</b> Нажмите «Проверить подписку».\n📨 <b>3.</b> Отправьте материал сюда обычным сообщением.';

  const home = `💬 <b>${channelName}</b>
Привет! Здесь можно предложить пост для канала.

${subscription}

<b>Как предложить пост</b>
${steps}

📎 Текст, фото, видео, GIF, файлы, стикеры и альбомы.
🕒 Пост выйдет после одобрения.

🔒 <b>Публикации в канале полностью анонимны.</b> Уберите личные данные из текста и вложений.`;

  const help = `📖 <b>Что можно отправить</b>

✍️ <b>Текст</b> — напишите или вставьте его в чат.
📷 <b>Фото, видео или GIF</b> — добавьте подпись в Telegram, если она нужна.
🖼 <b>Альбом</b> — выберите несколько медиа и отправьте их вместе.
📎 <b>Файл или стикер</b> — прикрепите и отправьте в этот чат.

📨 После отправки дождитесь номера заявки.
🔒 <b>Публикации в канале полностью анонимны.</b> Уберите личные данные из материала перед отправкой.

${subscription}`;

  return {
    text: screen === 'help' ? help : home,
    parse_mode: 'HTML',
    reply_markup: publicKeyboard({ ...options, screen }),
  };
}
