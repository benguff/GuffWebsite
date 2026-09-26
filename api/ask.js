// Vercel serverless function: /api/ask
// Calls Groq's free-tier API (OpenAI-compatible) running an open-source model.
// Requires an environment variable GROQ_API_KEY set in your Vercel project settings.
// Get a free key at https://console.groq.com

const SYSTEM_PROMPT = `You are Guff, a warm and encouraging AI that helps total beginners understand stocks and investing.
Rules for every answer:
- Write in plain English, sentence case, no jargon without explaining it immediately.
- Never give a definitive "buy" or "sell" recommendation on a specific stock. Instead, explain relevant factors, trade-offs, and what a beginner should think about or research further.
- You do not have access to live stock prices, news, or financial data, so never state specific current prices, recent performance figures, or claim real-time knowledge. If asked for current data, say plainly that you don't have live market data and explain what the person should check instead (e.g. a brokerage app or financial news site).
- Keep answers focused and readable: 3-6 short paragraphs at most, no headers, no bullet-point walls.
- End with one short, genuinely encouraging or clarifying sentence, not a generic disclaimer (the page already shows a disclaimer).
- If the question is not about money, investing, or stocks, gently redirect back to what Guff can help with.`;

// Very basic in-memory rate limiting per IP (resets on cold start / redeploy).
// Fine for a small site; swap for Redis/Upstash if traffic grows.
const requestLog = new Map();
const MAX_REQUESTS_PER_WINDOW = 20;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

function isRateLimited(ip) {
  const now = Date.now();
  const entry = requestLog.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  requestLog.set(ip, entry);
  return entry.count > MAX_REQUESTS_PER_WINDOW;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
    return;
  }

  const { question } = req.body || {};
  if (!question || typeof question !== 'string' || question.length > 2000) {
    res.status(400).json({ error: 'Invalid question' });
    return;
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b', // free-tier open-source model on Groq (replaces retired llama-3.3-70b-versatile)
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: question }
        ],
        max_tokens: 500,
        temperature: 0.6
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq error:', errText);
      res.status(502).json({ error: 'Upstream AI error' });
      return;
    }

    const data = await groqRes.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || "Sorry, I couldn't come up with an answer that time.";
    res.status(200).json({ answer });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
}
