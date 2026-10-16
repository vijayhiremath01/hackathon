type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export class GroqApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const BASE_URL = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = Math.max(5_000, Math.min(60_000, Number(process.env.GROQ_TIMEOUT_MS) || 30_000));

export async function complete(messages: ChatMessage[], maxTokens = 700, jsonMode = false): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new GroqApiError(503, 'AI assistant is not configured on the server.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.3,
        max_completion_tokens: Math.max(64, Math.min(2400, maxTokens)),
        ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
        stream: false,
      }),
    });
    if (!response.ok) {
      // Do not return or log provider bodies; they can contain sensitive request details.
      const status = response.status;
      if (status === 401 || status === 403) throw new GroqApiError(502, 'Groq rejected the server credentials. Check GROQ_API_KEY.');
      if (status === 429) throw new GroqApiError(503, 'Groq is rate limited. Please try again shortly.');
      throw new GroqApiError(502, `Groq request failed (${status}). Please try again.`);
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new GroqApiError(502, 'Groq returned an empty response. Please try again.');
    return content.trim().slice(0, 3900);
  } catch (error) {
    if (error instanceof GroqApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new GroqApiError(504, 'Groq request timed out. Please try again.');
    if (error instanceof Error) {
      const cause = error.cause;
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'unknown';
      console.error(`[groq] transport failure (${error.name}; ${code})`);
    }
    throw new GroqApiError(502, 'Could not reach Groq. Please try again.');
  } finally {
    clearTimeout(timeout);
  }
}
