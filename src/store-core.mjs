export function createStore(db, transaction) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      username TEXT,
      album TEXT,
      status TEXT NOT NULL DEFAULT 'collecting',
      due INTEGER NOT NULL,
      preview_id INTEGER,
      card_id INTEGER,
      plan TEXT,
      step INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS parts (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      submission_id INTEGER NOT NULL REFERENCES submissions(id),
      content TEXT,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS parts_submission ON parts (submission_id, message_id);
    CREATE INDEX IF NOT EXISTS submissions_due ON submissions (status, due);
    CREATE INDEX IF NOT EXISTS submissions_album ON submissions (chat_id, album, status);
    CREATE TABLE IF NOT EXISTS moderator_cards (
      submission_id INTEGER NOT NULL REFERENCES submissions(id),
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      PRIMARY KEY (submission_id, chat_id)
    );
  `);

  transaction(() => {
    if (!db.prepare('PRAGMA table_info(submissions)').all().some(({ name }) => name === 'public_username')) {
      db.exec('ALTER TABLE submissions ADD COLUMN public_username TEXT');
    }
  });

  function accept(message, content, now, username) {
    const chatId = message.from.id;
    const messageId = message.message_id;
    const album = message.media_group_id ?? null;
    const due = album ? now + 1800 : now;
    return transaction(() => {
      if (db.prepare('SELECT 1 FROM parts WHERE chat_id = ? AND message_id = ?').get(chatId, messageId)) {
        return null;
      }
      const existing = album && db.prepare(`
        SELECT id, status FROM submissions WHERE chat_id = ? AND album = ?
          AND (status IN ('draft', 'awaiting_signature') OR (status = 'collecting' AND preview_id IS NULL))
      `).get(chatId, album);
      const id = existing?.id ?? db.prepare(`
        INSERT INTO submissions (chat_id, username, album, due, status)
        VALUES (?, ?, ?, ?, 'draft') RETURNING id
      `).get(chatId, username, album, due).id;
      db.prepare('INSERT INTO parts VALUES (?, ?, ?, ?)').run(chatId, messageId, id, JSON.stringify(content));
      if (existing && existing.status !== 'awaiting_signature') {
        db.prepare('UPDATE submissions SET due = ? WHERE id = ?').run(due, id);
      }
    });
  }

  function get(id) {
    return db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
  }

  function finish(id, status) {
    transaction(() => {
      db.prepare('UPDATE submissions SET status = ?, plan = NULL WHERE id = ?').run(status, id);
      db.prepare('UPDATE parts SET content = NULL WHERE submission_id = ?').run(id);
    });
  }

  return {
    accept,
    get,
    finish,
    statusCounts: () => Object.fromEntries(db.prepare(
      'SELECT status, COUNT(*) AS total FROM submissions GROUP BY status',
    ).all().map(({ status, total }) => [status, total])),
    reviewQueue: (limit, offset, statuses) => db.prepare(`
      SELECT id, status FROM submissions
      WHERE status IN (${statuses.map(() => '?').join(', ')})
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...statuses, limit, offset),
    parts: id => db.prepare('SELECT content FROM parts WHERE submission_id = ? ORDER BY message_id')
      .all(id).map(({ content }) => JSON.parse(content)),
    firstMessageId: id => db.prepare(
      'SELECT message_id FROM parts WHERE submission_id = ? ORDER BY message_id LIMIT 1',
    ).get(id).message_id,
    next: () => db.prepare(`
      SELECT * FROM submissions WHERE status IN ('draft', 'awaiting_signature', 'collecting', 'approved')
      ORDER BY due, id LIMIT 1
    `).get(),
    awaitSignature: (id, due) => db.prepare(`
      UPDATE submissions SET status = 'awaiting_signature', due = ? WHERE id = ?
    `).run(due, id),
    chooseSignature: (id, username, due) => db.prepare(`
      UPDATE submissions SET status = 'collecting', public_username = ?, due = ? WHERE id = ?
    `).run(username, due, id),
    updateDraftUsername: (id, username) => db.prepare(`
      UPDATE submissions SET username = ?, version = version + 1 WHERE id = ?
    `).run(username, id),
    previewSent: (id, previewId) => db.prepare('UPDATE submissions SET preview_id = ? WHERE id = ?').run(previewId, id),
    pending: (id, cardId) => db.prepare(`
      UPDATE submissions SET status = 'pending', card_id = ? WHERE id = ?
    `).run(cardId, id),
    replaceCard: (id, cardId, previewId) => db.prepare(`
      UPDATE submissions SET card_id = ?, preview_id = ? WHERE id = ?
    `).run(cardId, previewId, id),
    moderatorCard: (id, chatId) => db.prepare(
      'SELECT message_id FROM moderator_cards WHERE submission_id = ? AND chat_id = ?',
    ).get(id, chatId)?.message_id,
    saveModeratorCard: (id, chatId, messageId) => db.prepare(`
      INSERT INTO moderator_cards VALUES (?, ?, ?)
      ON CONFLICT(submission_id, chat_id) DO UPDATE SET message_id = excluded.message_id
    `).run(id, chatId, messageId),
    defer: (id, due) => db.prepare('UPDATE submissions SET due = ? WHERE id = ?').run(due, id),
    approve: (id, plan, now) => db.prepare(`
      UPDATE submissions SET status = 'approved', plan = ?, due = ?, version = version + 1 WHERE id = ?
    `).run(JSON.stringify(plan), now, id),
    resume: (id, now, steps = 0) => db.prepare(`
      UPDATE submissions SET status = 'approved', due = ?, step = step + ?, version = version + 1 WHERE id = ?
    `).run(now, steps, id),
    startStep: id => db.prepare("UPDATE submissions SET status = 'sending' WHERE id = ?").run(id),
    stepDone: id => db.prepare(`
      UPDATE submissions SET status = 'approved', step = step + 1 WHERE id = ?
    `).run(id),
    publicationError: (id, status) => db.prepare('UPDATE submissions SET status = ? WHERE id = ?').run(status, id),
    recover: () => db.prepare("UPDATE submissions SET status = 'uncertain' WHERE status = 'sending' RETURNING id").all(),
  };
}
