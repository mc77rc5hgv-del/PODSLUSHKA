import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createBot } from '../src/bot.mjs';
import { publication, readContent } from '../src/content.mjs';
import { openStore } from '../src/store.mjs';
import { TelegramError } from '../src/telegram.mjs';

const adminId = 10;
const channelId = -1001234567890;
const userId = 502030405060;
const identity = { id: 99, username: 'podslushka_example_bot' };
const config = { adminId, channelId: '@podslushka_example' };

function privateMessage(messageId, body, username = 'sender_example') {
  return { message: {
    message_id: messageId,
    chat: { type: 'private', id: userId },
    from: { id: userId, username },
    ...body,
  } };
}

function callback(row, action, from = adminId) {
  return { callback_query: {
    id: 'callback',
    from: { id: from },
    message: { message_id: row.card_id, chat: { id: adminId } },
    data: `${action}:${row.id}:${row.version}`,
  } };
}

function signatureCallback(button, username = 'sender_example', sender = userId) {
  return { callback_query: {
    id: 'signature',
    from: { id: sender, username },
    message: { message_id: 20, chat: { id: sender } },
    data: button.callback_data,
  } };
}

function draftButtons(f) {
  return f.calls.filter(call => call.params.text?.includes('Черновик №')
    && call.params.reply_markup?.inline_keyboard.length).at(-1).params.reply_markup.inline_keyboard.flat();
}

async function submitDraft(f, action = 'anonymous') {
  await f.bot.work();
  const button = draftButtons(f).find(({ callback_data }) => callback_data.startsWith(`draft:${action}:`));
  assert.ok(button);
  await f.bot.update(signatureCallback(button));
  await f.bot.work();
}

function fixture(t, path = ':memory:') {
  const calls = [];
  let nextMessageId = 0;
  let clock = 10_000;
  let fail;
  let membership = { status: 'member' };
  let store;
  let bot;
  const api = async (method, params) => {
    calls.push({ method, params });
    if (method === 'getChat') return { type: 'channel', id: channelId, username: 'podslushka_example' };
    if (method === 'getChatMember') {
      if (params.user_id === identity.id) return { status: 'administrator', can_post_messages: true };
      if (membership instanceof Error) throw membership;
      return membership;
    }
    if (fail?.method === method && params.chat_id === channelId) {
      const error = fail;
      fail = undefined;
      throw new TelegramError(method, error.code);
    }
    if (method === 'sendMediaGroup') return params.media.map(() => ({ message_id: ++nextMessageId }));
    return { message_id: ++nextMessageId };
  };
  const restart = async () => {
    store?.close();
    store = openStore(path);
    bot = createBot({ api, store, config, identity, now: () => clock, log: () => {} });
    assert.match(await bot.check(), /Канал подключён/);
    await bot.recover();
  };
  t.after(() => store?.close());
  return {
    calls,
    restart,
    get store() { return store; },
    get bot() { return bot; },
    advance: () => { clock += 2000; },
    setMembership: member => { membership = member; },
    failOnce: (method, code) => { fail = { method, code }; },
    channelPosts: () => calls.filter(call => call.method.startsWith('send') && call.params.chat_id === channelId),
  };
}

test('private intake, exact admin authorization and one anonymous publication', async t => {
  const f = fixture(t);
  await f.restart();
  await f.bot.update(privateMessage(1, { text: '/start' }));
  assert.match(f.calls.at(-1).params.text, /Подписка подтверждена/);
  const text = '😀 Привет!';
  const bold = { type: 'bold', offset: 3, length: 7 };
  const update = privateMessage(2, {
    text,
    entities: [bold],
    forward_origin: { type: 'user', sender_user: { id: userId, username: 'original_sender' } },
  });
  await f.bot.update(update);
  await f.bot.update(update);
  await submitDraft(f);
  const row = f.store.get(1);
  const adminCalls = f.calls.filter(call => call.params.chat_id === adminId);
  assert.equal(adminCalls[0].params.text, text);
  assert.match(adminCalls[1].params.text, /@sender_example/);
  assert.match(adminCalls[1].params.text, new RegExp(String(userId)));
  assert.match(adminCalls[1].params.text, /В канале: анонимно/);
  assert.deepEqual(adminCalls[1].params.reply_markup.inline_keyboard[0].map(button => button.style), ['success', 'danger']);
  assert.equal(adminCalls[1].params.reply_parameters.message_id, row.preview_id);
  assert.deepEqual(f.channelPosts(), []);

  await f.bot.update(callback(row, 'approve', userId));
  await f.bot.work();
  assert.equal(f.store.get(1).status, 'pending');
  await f.bot.update(callback(row, 'approve'));
  await f.bot.update(callback(row, 'approve'));
  await f.bot.work();
  await f.bot.update(callback(row, 'approve'));
  await f.bot.work();
  assert.equal(f.store.get(1).status, 'published');
  assert.equal(f.channelPosts().length, 1);
  const { params } = f.channelPosts()[0];
  assert.equal(params.text, `${text}\n\n📣 ПОДСЛУШКА ВМЕДА · ✍️ Предложить пост`);
  assert.deepEqual(params.entities[0], bold);
  assert.equal(params.entities[1].offset, text.length + 2);
  assert.equal(params.entities[1].url, 'https://t.me/podslushka_example');
  assert.equal(params.entities[2].url, 'https://t.me/podslushka_example_bot');
  assert.doesNotMatch(JSON.stringify(params), /sender_example|original_sender|502030405060|forward_origin/);
});

test('only subscribers can submit and users can verify a new subscription', async t => {
  const f = fixture(t);
  await f.restart();
  f.setMembership({ status: 'left' });
  await f.bot.update(privateMessage(1, { text: 'Первая заявка' }));
  const prompt = f.calls.at(-1).params;
  assert.match(prompt.text, /Подпишитесь на канал/);
  assert.equal(prompt.reply_markup.inline_keyboard[0][0].url, 'https://t.me/podslushka_example');
  assert.equal(prompt.reply_markup.inline_keyboard[0][0].style, 'primary');
  assert.equal(prompt.reply_markup.inline_keyboard[1][0].style, 'success');
  assert.equal(f.store.get(1), undefined);

  f.setMembership({ status: 'member' });
  await f.bot.update({ callback_query: {
    id: 'subscription', from: { id: userId }, message: { message_id: 5, chat: { id: userId } },
    data: prompt.reply_markup.inline_keyboard[1][0].callback_data,
  } });
  assert.equal(f.calls.at(-1).method, 'editMessageText');
  assert.match(f.calls.at(-1).params.text, /Вы сами выбираете подпись/);
  assert.doesNotMatch(f.calls.at(-1).params.text, /администратор|Telegram ID/i);
  const buttons = f.calls.at(-1).params.reply_markup.inline_keyboard.flat();
  const openGuide = { id: 'guide', from: { id: userId }, message: { message_id: 5, chat: { id: userId } } };
  await f.bot.update({ callback_query: { ...openGuide, data: buttons.find(button => button.callback_data === 'public:help').callback_data } });
  assert.match(f.calls.at(-1).params.text, /Что можно отправить/);
  const goHome = f.calls.at(-1).params.reply_markup.inline_keyboard.flat().find(button => button.callback_data === 'public:home');
  await f.bot.update({ callback_query: { ...openGuide, data: goHome.callback_data } });
  assert.match(f.calls.at(-1).params.text, /Как предложить пост/);
  await f.bot.update(privateMessage(2, { text: 'Вторая заявка' }));
  assert.equal(f.store.get(1).status, 'draft');

  f.setMembership({ status: 'left' });
  await f.bot.update(privateMessage(3, { text: 'После отписки' }));
  assert.equal(f.store.get(2), undefined);
  f.setMembership(new TelegramError('getChatMember', 503));
  await f.bot.update(privateMessage(4, { text: 'При недоступности Telegram' }));
  assert.equal(f.store.get(2), undefined);
  assert.match(f.calls.at(-1).params.text, /Статус подписки пока недоступен/);
});

test('only the admin can open the queue and recover an actionable moderation card', async t => {
  const f = fixture(t);
  await f.restart();
  await f.bot.update(privateMessage(1, { text: 'Материал для модерации' }));
  await submitDraft(f);
  const previous = f.store.get(1);
  await f.bot.update(privateMessage(2, { text: '/admin' }));
  assert.equal(f.calls.at(-1).params.text, 'Панель доступна администратору.');
  assert.equal(f.store.get(2), undefined);
  const open = callback(previous, 'reject', userId);
  open.callback_query.data = 'panel:open:1';
  await f.bot.update(open);
  assert.equal(f.calls.at(-1).params.text, 'Доступ закрыт.');
  assert.equal(f.store.get(1).card_id, previous.card_id);

  await f.bot.update({ message: {
    chat: { id: adminId, type: 'private' }, from: { id: adminId }, text: '/admin',
  } });
  const panel = f.calls.at(-1).params;
  assert.match(panel.text, /На рассмотрении · 1/);
  open.callback_query.from.id = adminId;
  open.callback_query.data = 'panel:page:0:attention';
  await f.bot.update(open);
  assert.match(f.calls.at(-1).params.text, /В этой категории пока нет заявок/);
  open.callback_query.data = 'panel:page:0:pending';
  await f.bot.update(open);
  open.callback_query.data = f.calls.at(-1).params.reply_markup.inline_keyboard.flat()
    .find(button => button.callback_data === 'panel:open:1').callback_data;
  await f.bot.update(open);
  const reopened = f.store.get(1);
  assert.notEqual(reopened.card_id, previous.card_id);
  assert.equal(reopened.status, 'pending');
  await f.bot.update(callback(previous, 'reject'));
  assert.equal(f.store.get(1).status, 'pending');
  await f.bot.update(callback(reopened, 'reject'));
  assert.equal(f.store.get(1).status, 'rejected');
});

test('a sticker without an author username can be rejected', async t => {
  const f = fixture(t);
  await f.restart();
  await f.bot.update(privateMessage(1, { sticker: { file_id: 'sticker_id' } }, null));
  await f.bot.work();
  assert.equal(draftButtons(f).some(button => button.callback_data.includes(':signed:')), false);
  await f.bot.update(signatureCallback(draftButtons(f)[0], null));
  await f.bot.work();
  assert.equal(f.calls.find(call => call.method === 'sendSticker').params.sticker, 'sticker_id');
  assert.match(f.calls.at(-1).params.text, /без @username/);
  await f.bot.update(callback(f.store.get(1), 'reject'));
  await f.bot.work();
  assert.equal(f.store.get(1).status, 'rejected');
  assert.deepEqual(f.channelPosts(), []);
});

test('the album survives restarts and retries just its footer after a definite error', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'podslushka-test-'));
  const f = fixture(t, join(directory, 'test.sqlite'));
  t.after(() => rmSync(directory, { recursive: true }));
  await f.restart();
  const first = privateMessage(1, { media_group_id: 'album', photo: [{ file_id: 'photo' }], caption: 'я'.repeat(1024) });
  const second = privateMessage(2, { media_group_id: 'album', video: { file_id: 'video' } });
  await f.bot.update(second);
  await f.restart();
  await f.bot.update(first);
  await f.bot.update(second);
  await f.bot.work();
  assert.equal(f.store.get(1).status, 'draft');
  f.advance();
  await submitDraft(f, 'signed');
  assert.equal(f.store.get(2), undefined);
  await f.bot.update(callback(f.store.get(1), 'approve'));
  f.failOnce('sendMessage', 403);
  await f.bot.work();
  assert.equal(f.store.get(1).status, 'failed');
  assert.equal(f.store.get(1).step, 1);
  await f.restart();
  await f.bot.update(callback(f.store.get(1), 'retry'));
  await f.bot.work();
  assert.equal(f.store.get(1).status, 'published');
  assert.deepEqual(f.channelPosts().map(call => call.method), ['sendMediaGroup', 'sendMessage', 'sendMessage']);
  const [album, , footer] = f.channelPosts();
  assert.deepEqual(album.params.media.map(part => part.media), ['photo', 'video']);
  assert.equal(album.params.media[0].caption, 'я'.repeat(1024));
  assert.equal(footer.params.entities.length, 3);
  assert.equal(footer.params.entities[0].url, 'https://t.me/sender_example');
});

test('an ambiguous send needs confirmation before the bot can finish', async t => {
  const f = fixture(t);
  await f.restart();
  await f.bot.update(privateMessage(1, { text: 'Заявка' }));
  await submitDraft(f);
  await f.bot.update(callback(f.store.get(1), 'approve'));
  f.failOnce('sendMessage');
  await f.bot.work();
  assert.equal(f.store.get(1).status, 'uncertain');
  await f.bot.work();
  assert.equal(f.channelPosts().length, 1);
  await f.bot.update(callback(f.store.get(1), 'confirm'));
  await f.bot.work();
  assert.equal(f.store.get(1).status, 'published');
  assert.equal(f.channelPosts().length, 1);
});

test('signed submission requires current explicit consent from its author', async t => {
  const f = fixture(t);
  await f.restart();
  await f.bot.update(privateMessage(1, { text: '🙂 Материал' }));
  await f.bot.work();
  assert.equal(f.store.get(1).status, 'awaiting_signature');
  assert.equal(f.calls.some(call => call.params.chat_id === adminId), false);
  const signed = draftButtons(f).find(button => button.callback_data.includes(':signed:'));
  await f.bot.update(signatureCallback(signed, 'another_user', userId + 1));
  assert.equal(f.store.get(1).status, 'awaiting_signature');
  f.setMembership({ status: 'left' });
  await f.bot.update(signatureCallback(signed));
  assert.equal(f.store.get(1).status, 'awaiting_signature');
  f.setMembership({ status: 'member' });
  await f.bot.update(signatureCallback(signed, 'new_name'));
  assert.equal(f.store.get(1).public_username, null);
  await f.bot.update(signatureCallback(signed, 'new_name'));
  assert.equal(f.store.get(1).status, 'awaiting_signature');
  const updated = draftButtons(f).find(button => button.callback_data.includes(':signed:'));
  assert.match(updated.text, /@new_name/);
  await f.bot.update(signatureCallback(updated, 'new_name'));
  await f.bot.update(signatureCallback(updated, 'new_name'));
  await f.bot.work();
  const row = f.store.get(1);
  assert.equal(row.status, 'pending');
  assert.match(f.calls.at(-1).params.text, /В канале: @new_name/);
  await f.bot.update(callback(row, 'approve'));
  await f.bot.work();
  const [{ params }] = f.channelPosts();
  const [signature] = params.entities;
  assert.equal(signature.url, 'https://t.me/new_name');
  assert.equal(params.text.slice(signature.offset, signature.offset + signature.length), '@new_name');
  assert.doesNotMatch(JSON.stringify(params), /sender_example|502030405060/);
});

test('cancelling a draft discards its content and prevents moderation', async t => {
  const f = fixture(t);
  await f.restart();
  await f.bot.update(privateMessage(1, { text: 'Отменить' }));
  await f.bot.work();
  const [anonymous, , cancel] = draftButtons(f);
  await f.bot.update(signatureCallback(cancel));
  await f.bot.update(signatureCallback(anonymous));
  await f.bot.work();
  assert.equal(f.store.get(1).status, 'cancelled');
  assert.deepEqual(f.store.parts(1), [null]);
  assert.equal(f.calls.some(call => call.params.chat_id === adminId), false);
});

test('existing submissions still publish anonymously after the SQLite schema upgrade', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'podslushka-migration-'));
  const path = join(directory, 'queue.sqlite');
  openStore(path).close();
  const old = new DatabaseSync(path);
  try {
    old.exec('ALTER TABLE submissions DROP COLUMN public_username');
    old.prepare("INSERT INTO submissions (id, chat_id, username, status, due, card_id) VALUES (1, ?, 'old_author', 'pending', 0, 50)")
      .run(userId);
    old.prepare('INSERT INTO parts VALUES (?, 1, 1, ?)').run(userId, JSON.stringify(readContent({ text: 'Старая заявка' })));
  } finally {
    old.close();
  }
  const f = fixture(t, path);
  t.after(() => rmSync(directory, { recursive: true }));
  await f.restart();
  await f.bot.update(callback(f.store.get(1), 'approve'));
  await f.bot.work();
  assert.equal(f.store.get(1).status, 'published');
  assert.match(f.channelPosts()[0].params.text, /Старая заявка/);
  assert.doesNotMatch(JSON.stringify(f.channelPosts()), /old_author|502030405060/);
});

test('supported media is sent by file ID and full captions are preserved', () => {
  const links = [
    { text: '📣 Канал', url: 'https://t.me/channel', style: 'primary' },
    { text: '✍️ Бот', url: 'https://t.me/bot', style: 'success' },
  ];
  const cases = [
    [{ animation: { file_id: 'gif' }, document: { file_id: 'ignored' } }, 'sendAnimation', 'animation', 'gif'],
    [{ photo: [{ file_id: 'small' }, { file_id: 'large' }] }, 'sendPhoto', 'photo', 'large'],
    [{ video: { file_id: 'video' } }, 'sendVideo', 'video', 'video'],
    [{ document: { file_id: 'file' } }, 'sendDocument', 'document', 'file'],
    [{ sticker: { file_id: 'sticker' } }, 'sendSticker', 'sticker', 'sticker'],
  ];
  for (const [message, expectedMethod, field, fileId] of cases) {
    const caption = 'x'.repeat(1024);
    const [[method, params]] = publication(channelId, [readContent({ ...message, caption })], links);
    assert.equal(method, expectedMethod);
    assert.equal(params[field], fileId);
    assert.equal(params.caption, field === 'sticker' ? undefined : caption);
    assert.deepEqual(params.reply_markup.inline_keyboard[0], links);
    const [media, [footerMethod, footer]] = publication(channelId, [readContent({ ...message, caption })], links, 'author_name');
    assert.equal(media[1].caption, params.caption);
    assert.equal(footerMethod, 'sendMessage');
    assert.equal(footer.entities[0].url, 'https://t.me/author_name');
  }
});
