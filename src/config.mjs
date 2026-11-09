export function readBotConfig(env) {
  const token = env.BOT_TOKEN?.trim();
  const admin = env.ADMIN_ID?.trim();
  const channel = env.CHANNEL_ID?.trim();
  const channelUrl = env.CHANNEL_URL?.trim() || undefined;
  if (!token || !/^\d+:[a-zA-Z0-9_-]+$/.test(token)) throw new Error('Укажите токен BotFather в BOT_TOKEN.');
  if (admin && (!/^\d+$/.test(admin) || !Number.isSafeInteger(Number(admin)) || Number(admin) <= 0)) {
    throw new Error('ADMIN_ID должен быть числовым Telegram ID. Его покажет команда /id.');
  }
  if (channel && !/^@[a-zA-Z0-9_]+$/.test(channel) && !/^-100\d+$/.test(channel)) {
    throw new Error('CHANNEL_ID должен иметь вид @имя_канала (латиницей) или -100…');
  }
  if (channelUrl && !/^https:\/\/t\.me\/(?:\+|joinchat\/)?[a-zA-Z0-9_-]+$/.test(channelUrl)) {
    throw new Error('CHANNEL_URL должен содержать ссылку на канал или ссылку-приглашение https://t.me/…');
  }
  return {
    token,
    adminId: admin ? Number(admin) : undefined,
    channelId: channel ? (channel.startsWith('@') ? channel : Number(channel)) : undefined,
    channelUrl,
  };
}
