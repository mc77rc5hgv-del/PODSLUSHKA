const mediaMethods = {
  animation: 'sendAnimation',
  audio: 'sendAudio',
  document: 'sendDocument',
  photo: 'sendPhoto',
  sticker: 'sendSticker',
  video: 'sendVideo',
  video_note: 'sendVideoNote',
  voice: 'sendVoice',
};

function entitiesOf(entities = []) {
  return entities.filter(({ type }) => type !== 'custom_emoji');
}

export function readContent(message) {
  if (message.text) {
    return { type: 'text', text: message.text, entities: entitiesOf(message.entities) };
  }

  // Telegram sets both animation and document for GIFs.
  for (const type of Object.keys(mediaMethods)) {
    const media = type === 'photo' ? message.photo?.at(-1) : message[type];
    if (media?.file_id) {
      return {
        type,
        fileId: media.file_id,
        text: message.caption ?? '',
        entities: entitiesOf(message.caption_entities),
        spoiler: Boolean(message.has_media_spoiler),
      };
    }
  }
  return null;
}

function albumItem(part) {
  return {
    type: part.type,
    media: part.fileId,
    caption: part.text,
    caption_entities: part.entities,
    ...(part.spoiler ? { has_spoiler: true } : {}),
  };
}

function mediaFields(part) {
  const fields = { [part.type]: part.fileId };
  if (part.type !== 'sticker' && part.type !== 'video_note') {
    fields.caption = part.text;
    fields.caption_entities = part.entities;
  }
  if (part.spoiler) fields.has_spoiler = true;
  return fields;
}

function messageStep(chatId, part, extra = {}) {
  const params = { chat_id: chatId, ...extra };
  if (part.type === 'text') {
    return ['sendMessage', {
      ...params,
      text: part.text,
      entities: part.entities,
      link_preview_options: { is_disabled: true },
    }];
  }
  return [mediaMethods[part.type], { ...params, ...mediaFields(part) }];
}

function albumStep(chatId, parts, extra = {}) {
  return ['sendMediaGroup', { chat_id: chatId, media: parts.map(albumItem), ...extra }];
}

export function preview(chatId, parts) {
  const extra = { protect_content: true };
  return parts.length === 1 ? messageStep(chatId, parts[0], extra) : albumStep(chatId, parts, extra);
}

function withFooter(part, links, username) {
  let text = part.text ? `${part.text}\n\n` : '';
  const entities = [...part.entities];
  if (username) {
    text += '✍️ Автор: ';
    const label = `@${username}`;
    entities.push({ type: 'text_link', offset: text.length, length: label.length, url: `https://t.me/${username}` });
    text += label + '\n';
  }
  for (const [index, { text: label, url }] of links.entries()) {
    if (index > 0) text += ' · ';
    // Telegram measures entity offsets in UTF-16 code units, like JS string.length.
    entities.push({ type: 'text_link', offset: text.length, length: label.length, url });
    text += label;
  }
  return { ...part, text, entities };
}

export function publication(chatId, parts, links, username) {
  const separateFooter = () => messageStep(chatId, withFooter({ type: 'text', text: '', entities: [] }, links, username));
  if (parts.length > 1) {
    // A single album caption appears beneath the album in Telegram.
    const captionIndex = parts.findIndex(part => part.text);
    const index = captionIndex === -1 ? 0 : captionIndex;
    const caption = withFooter(parts[index], links, username);
    if ([...caption.text].length <= 1024) {
      const album = parts.with(index, caption);
      return [albumStep(chatId, album)];
    }

    return [albumStep(chatId, parts), separateFooter()];
  }

  const [part] = parts;
  const footer = withFooter(part, links, username);
  const limit = part.type === 'text' ? 4096 : 1024;
  if (part.type !== 'sticker' && part.type !== 'video_note' && [...footer.text].length <= limit) {
    return [messageStep(chatId, footer)];
  }
  if (username) return [messageStep(chatId, part), separateFooter()];
  return [messageStep(chatId, part, { reply_markup: { inline_keyboard: [links] } })];
}
