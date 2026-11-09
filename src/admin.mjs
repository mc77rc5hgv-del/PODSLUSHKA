const reviewLabels = {
  pending: '🕒 Ожидает решения',
  failed: '⚠️ Ошибка отправки',
  uncertain: '🔎 Нужна проверка',
};
const filters = {
  all: { text: '📋 Все', statuses: Object.keys(reviewLabels) },
  pending: { text: '🕒 Ожидают', statuses: ['pending'] },
  attention: { text: '⚠️ Проверить', statuses: ['failed', 'uncertain'] },
};
const pageSize = 6;

export const adminButton = { text: '🛠 Панель модерации', callback_data: 'panel:home', style: 'primary' };

export function isReviewable(status) {
  return Object.hasOwn(reviewLabels, status);
}

export function adminPanel(store, requestedPage, filter = 'all') {
  const counts = store.statusCounts();
  const count = status => counts[status] ?? 0;
  const { text: selected, statuses } = filters[filter];
  const waiting = statuses.reduce((total, status) => total + count(status), 0);
  const pages = Math.max(1, Math.ceil(waiting / pageSize));
  const page = Math.min(requestedPage, pages - 1);
  const queue = store.reviewQueue(pageSize, page * pageSize, statuses);
  const keyboard = [Object.entries(filters).map(([key, { text }]) => ({
    text,
    callback_data: `panel:page:0:${key}`,
    ...(key === filter ? { style: 'primary' } : {}),
  }))];
  keyboard.push(...queue.map(({ id, status }) => [{
    text: `№${id} · ${reviewLabels[status]}`,
    callback_data: `panel:open:${id}`,
  }]));
  const navigation = [];
  if (page > 0) navigation.push({ text: '⬅️ Назад', callback_data: `panel:page:${page - 1}:${filter}` });
  if (page + 1 < pages) navigation.push({ text: '➡️ Далее', callback_data: `panel:page:${page + 1}:${filter}` });
  if (navigation.length) keyboard.push(navigation);
  keyboard.push([{ text: '🔄 Обновить', callback_data: `panel:page:${page}:${filter}` }]);

  return {
    text: [
      '🛠 <b>Панель модерации</b>',
      '',
      `🕒 На рассмотрении · ${count('pending')}`,
      `📤 Готовятся или отправляются · ${count('collecting') + count('approved') + count('sending')}`,
      `⚠️ Требуют внимания · ${count('failed') + count('uncertain')}`,
      `✅ Опубликовано · ${count('published')}`,
      `❌ Отклонено · ${count('rejected')}`,
      '',
      `<b>Заявки · ${selected}</b>`,
      waiting ? `Нажмите на номер, чтобы открыть материал. Страница ${page + 1} из ${pages}.` : 'В этой категории пока нет заявок.',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
  };
}
