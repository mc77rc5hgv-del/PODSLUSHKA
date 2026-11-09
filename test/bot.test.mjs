import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function fixture(t, path = ':memory:') {
  const calls = [];
  let nextMessageId = 0;
  let clock = 10_000;
  let fail;
  let store;
  let bot;
  const api = async (method, params) => {
    calls.push({ method, params });
    if (method === 'getChat') return { type: 'channel', id: channelId, username: 'podslushka_example' };
    if (method === 'getChatMember') return { status: 'administrator', can_post_messages: true };
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
    failOnce: (method, code) => { fail = { method, code }; },
    channelPosts: () => calls.filter(call => call.method.startsWith('send') && call.params.chat_id === channelId),
  };
}

test('private intake, exact admin authorization and one anonymous publication', async t => {
  const f = fixture(t);
  await f.restart();
  await f.bot.update(privateMessage(1, { text: '/start' }));
  assert.match(f.calls.at(-1).params.text, /Просто пришлите/);
  const text = '😀 Привет!';
  const bold = { type: 'bold', offset: 3, length: 7 };
  const update = privateMessage(2, {
    text,
    entities: [bold],
    forward_origin: { type: 'user', sender_user: { id: userId, username: 'original_sender' } },
  });
  await f.bot.update(update);
  await f.bot.update(update);
  await f.bot.work();
  const row = f.store.get(1);
  const adminCalls = f.calls.filter(call => call.params.chat_id === adminId);
  assert.equal(adminCalls[0].params.text, text);
  assert.match(adminCalls[1].params.text, /@sender_example/);
  assert.match(adminCalls[1].params.text, new RegExp(String(userId)));
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
  assert.equal(params.text, `${text}\n\nПодслушка в мида · Предложить пост`);
  assert.deepEqual(params.entities[0], bold);
  assert.equal(params.entities[1].offset, text.length + 2);
  assert.equal(params.entities[1].url, 'https://t.me/podslushka_example');
  assert.equal(params.entities[2].url, 'https://t.me/podslushka_example_bot');
  assert.doesNotMatch(JSON.stringify(params), /sender_example|original_sender|502030405060|forward_origin/);
});

test('a sticker without an author username can be rejected', async t => {
  const f = fixture(t);
  await f.restart();
  await f.bot.update(privateMessage(1, { sticker: { file_id: 'sticker_id' } }, null));
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
  assert.equal(f.store.get(1).status, 'collecting');
  f.advance();
  await f.bot.work();
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
  assert.equal(footer.params.entities.length, 2);
});

test('an ambiguous send needs confirmation before the bot can finish', async t => {
  const f = fixture(t);
  await f.restart();
  await f.bot.update(privateMessage(1, { text: 'Заявка' }));
  await f.bot.work();
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

test('supported media is sent by file ID and full captions are preserved', () => {
  const links = [{ text: 'Канал', url: 'https://t.me/channel' }, { text: 'Бот', url: 'https://t.me/bot' }];
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
  }
});
