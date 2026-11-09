const reviewLabels = {
  pending: 'Ожидает решения',
  failed: 'Ошибка отправки',
  uncertain: 'Нужна проверка',
};
const pageSize = 6;

export const adminButton = { text: 'Панель модерации', callback_data: 'panel:home' };

export function isReviewable(status) {
  return Object.hasOwn(reviewLabels, status);
}

export function adminPanel(store, requestedPage) {
  const counts = store.statusCounts();
  const count = status => counts[status] ?? 0;
  const waiting = Object.keys(reviewLabels).reduce((total, status) => total + count(status), 0);
  const pages = Math.max(1, Math.ceil(waiting / pageSize));
  const page = Math.min(requestedPage, pages - 1);
  const queue = store.reviewQueue(pageSize, page * pageSize);
  const keyboard = queue.map(({ id, status }) => [{
    text: `№${id} · ${reviewLabels[status]}`,
    callback_data: `panel:open:${id}`,
  }]);
  const navigation = [];
  if (page > 0) navigation.push({ text: 'Назад', callback_data: `panel:page:${page - 1}` });
  if (page + 1 < pages) navigation.push({ text: 'Далее', callback_data: `panel:page:${page + 1}` });
  if (navigation.length) keyboard.push(navigation);
  keyboard.push([{ text: 'Обновить', callback_data: `panel:page:${page}` }]);

  return {
    text: [
      'Панель модерации',
      '',
      `На рассмотрении · ${count('pending')}`,
      `Готовятся или отправляются · ${count('collecting') + count('approved') + count('sending')}`,
      `Требуют внимания · ${count('failed') + count('uncertain')}`,
      `Опубликовано · ${count('published')}`,
      `Отклонено · ${count('rejected')}`,
      '',
      waiting ? `Выберите заявку. Страница ${page + 1} из ${pages}.` : 'Очередь на рассмотрение пуста.',
    ].join('\n'),
    reply_markup: { inline_keyboard: keyboard },
  };
}
