export class TelegramError extends Error {
  constructor(method, code, retryAfter) {
    super(`${method}: ${code ?? 'нет ответа Telegram'}`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function telegram(token) {
  return async (method, params = {}) => {
    let response;
    let payload;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout((params.timeout ?? 0) * 1000 + 15000),
      });
      payload = await response.json();
    } catch {
      throw new TelegramError(method);
    }
    if (!payload?.ok) {
      throw new TelegramError(method, payload?.error_code ?? response.status, payload?.parameters?.retry_after);
    }
    return payload.result;
  };
}
