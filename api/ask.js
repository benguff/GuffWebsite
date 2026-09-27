// Vercel serverless function: /api/ask
// Calls Groq's free-tier API (OpenAI-compatible) running an open-source model,
// with optional live data lookups for stocks, indices, and crypto.
//
// Detection: an explicit "$TICKER" in the question is used directly for a single stock
// (no extra API call). Otherwise, a small, fast Groq call reads the question and returns
// up to 3 assets it names, each tagged as a STOCK, INDEX, or CRYPTO with its symbol. This
// means company names ("Is Chipotle a good buy?"), comparisons ("AAPL vs MSFT"), index
// names ("how's the S&P 500 doing"), and crypto ("what's Bitcoin at") all work.
//
// Data sources:
//   Stocks & indices (as ETF proxies) - Finnhub (https://finnhub.io)
//   Crypto - CoinGecko's free public API (no key required)
//
// Requires two environment variables in Vercel:
//   GROQ_API_KEY    - from https://console.groq.com
//   FINNHUB_API_KEY - free key from https://finnhub.io/register

const SYSTEM_PROMPT = `You are Guff, a warm and encouraging AI that helps total beginners understand stocks, crypto, and investing.
Rules for every answer:
- Write in plain English, sentence case, no jargon without explaining it immediately.
- Never give a definitive "buy" or "sell" recommendation on a specific stock or crypto asset. Instead, explain relevant factors, trade-offs, and what a beginner should think about or research further.
- If live price data is provided to you below (marked "LIVE DATA"), you may reference those specific numbers naturally in your answer — that data is real and current as of the timestamp given. Do not invent or guess numbers beyond what's provided.
- If asked to compare two or more assets and live data for more than one is provided, walk through the comparison factually and neutrally — what each one is, how they differ, what tends to move each one — without declaring a "winner."
- If an index (like the S&P 500) is asked about, live data is usually shown via a tracking ETF as a close stand-in for the index itself — mention this naturally if relevant, without dwelling on it.
- If no live data is provided and the question needs a current price, news, or recent performance figure, say plainly that you don't have that specific data and explain what the person should check instead. Never invent a number.
- Keep answers focused and readable: 3-6 short paragraphs at most, no headers, no bullet-point walls.
- End with one short, genuinely encouraging or clarifying sentence, not a generic disclaimer (the page already shows a disclaimer).
- If the question is not about money, investing, or markets, gently redirect back to what Guff can help with.`;

const ASSET_EXTRACTION_PROMPT = `You identify financial assets named in a user's question. Look for stocks (by company name OR ticker symbol), stock market indices (like the S&P 500, Nasdaq, Dow Jones, Russell 2000), and cryptocurrencies (by name or symbol). A company name alone (no ticker, no word "stock") still counts — e.g. "chipotle" means the company Chipotle Mexican Grill, ticker CMG.

Reply with a comma-separated list of up to 3 assets, each in the exact format TYPE:SYMBOL, where TYPE is one of STOCK, INDEX, or CRYPTO, and SYMBOL is:
- for STOCK: the ticker symbol (e.g. AAPL)
- for INDEX: one of SPX (S&P 500), IXIC (Nasdaq), DJI (Dow Jones), or RUT (Russell 2000)
- for CRYPTO: the common ticker (e.g. BTC, ETH, SOL, DOGE, XRP, ADA, BNB, MATIC, LTC, AVAX, DOT, LINK, SHIB, TRX)

Examples:
"What is chipotle trading at?" -> STOCK:CMG
"Is Tesla a good buy?" -> STOCK:TSLA
"Should I get Apple or Microsoft stock?" -> STOCK:AAPL,STOCK:MSFT
"How's the S&P 500 doing today?" -> INDEX:SPX
"What's Bitcoin worth right now?" -> CRYPTO:BTC
"Compare Bitcoin and Ethereum" -> CRYPTO:BTC,CRYPTO:ETH
"Should I diversify my portfolio?" -> NONE
"What's a P/E ratio?" -> NONE
"Is it too late to start investing at 40?" -> NONE

If no specific company, index, or crypto asset is named, reply with exactly: NONE
Reply with ONLY the list or NONE. No explanation, no other text.`;

// Index symbols are tracked via a well-known ETF as a close, freely available stand-in
const INDEX_PROXIES = {
  SPX: { ticker: 'SPY', label: 'S&P 500 (via SPY ETF)' },
  IXIC: { ticker: 'QQQ', label: 'Nasdaq-100 (via QQQ ETF)' },
  DJI: { ticker: 'DIA', label: 'Dow Jones (via DIA ETF)' },
  RUT: { ticker: 'IWM', label: 'Russell 2000 (via IWM ETF)' }
};

// Common crypto tickers mapped to CoinGecko's internal ids
const CRYPTO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', DOGE: 'dogecoin', XRP: 'ripple',
  ADA: 'cardano', BNB: 'binancecoin', MATIC: 'matic-network', LTC: 'litecoin',
  AVAX: 'avalanche-2', DOT: 'polkadot', LINK: 'chainlink', SHIB: 'shiba-inu', TRX: 'tron'
};

async function callGroq(messages, { maxTokens = 500, temperature = 0.6, reasoningEffort = 'low' } = {}) {
  return fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages,
      max_tokens: maxTokens,
      temperature,
      reasoning_effort: reasoningEffort, // keep the reasoning model's thinking short
      reasoning_format: 'hidden' // return only the final answer, not the thinking trace
    })
  });
}

async function detectAssets(question) {
  // Explicit $TICKER always wins for a single stock and skips the extra API call
  const dollarMatch = question.match(/\$([A-Za-z]{1,5})\b/);
  if (dollarMatch) return [{ type: 'STOCK', symbol: dollarMatch[1].toUpperCase() }];

  try {
    const res = await callGroq(
      [
        { role: 'system', content: ASSET_EXTRACTION_PROMPT },
        { role: 'user', content: question }
      ],
      { maxTokens: 60, temperature: 0, reasoningEffort: 'low' }
    );
    if (!res.ok) return [];

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim().toUpperCase() || 'NONE';
    if (raw === 'NONE') return [];

    const assets = raw.split(',').map(s => s.trim()).map(entry => {
      const [type, symbol] = entry.split(':').map(s => s && s.trim());
      if (!type || !symbol) return null;
      if (!['STOCK', 'INDEX', 'CRYPTO'].includes(type)) return null;
      if (!/^[A-Z0-9]{1,6}$/.test(symbol)) return null;
      return { type, symbol };
    }).filter(Boolean);

    return assets.slice(0, 3);
  } catch (err) {
    console.error('Asset detection error:', err);
    return [];
  }
}

async function getStockQuote(ticker, label) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;

  try {
    const [quoteRes, profileRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${key}`),
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${key}`)
    ]);
    if (!quoteRes.ok) return null;

    const quote = await quoteRes.json();
    if (!quote || quote.c === 0) return null;

    const profile = profileRes.ok ? await profileRes.json() : {};
    const changePct = quote.dp !== undefined ? quote.dp.toFixed(2) : null;

    return {
      label: label || `${profile?.name || ticker} (${ticker})`,
      price: quote.c,
      previousClose: quote.pc,
      dayHigh: quote.h,
      dayLow: quote.l,
      changePct,
      asOf: new Date(quote.t * 1000).toISOString()
    };
  } catch (err) {
    console.error('Finnhub error:', err);
    return null;
  }
}

async function getCryptoQuote(symbol) {
  const id = CRYPTO_IDS[symbol];
  if (!id) return null;

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`
    );
    if (!res.ok) return null;

    const data = await res.json();
    const entry = data[id];
    if (!entry) return null;

    return {
      label: `${symbol} (crypto)`,
      price: entry.usd,
      changePct: entry.usd_24h_change !== undefined ? entry.usd_24h_change.toFixed(2) : null,
      asOf: new Date(entry.last_updated_at * 1000).toISOString()
    };
  } catch (err) {
    console.error('CoinGecko error:', err);
    return null;
  }
}

async function getQuoteForAsset(asset) {
  if (asset.type === 'STOCK') {
    return getStockQuote(asset.symbol);
  }
  if (asset.type === 'INDEX') {
    const proxy = INDEX_PROXIES[asset.symbol];
    if (!proxy) return null;
    return getStockQuote(proxy.ticker, proxy.label);
  }
  if (asset.type === 'CRYPTO') {
    return getCryptoQuote(asset.symbol);
  }
  return null;
}

function formatQuoteLine(quote) {
  const changeText = quote.changePct !== null
    ? `${quote.changePct >= 0 ? 'up' : 'down'} ${Math.abs(quote.changePct)}% in the last 24h, `
    : '';
  const rangeText = quote.dayLow !== undefined
    ? `previous close $${quote.previousClose}, day range $${quote.dayLow}–$${quote.dayHigh}, `
    : '';
  return `${quote.label}: $${quote.price}, ${changeText}${rangeText}as of ${quote.asOf}`;
}

// Very basic in-memory rate limiting per IP (resets on cold start / redeploy).
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

  let userContent = question;
  const assets = await detectAssets(question);
  if (assets.length > 0) {
    const quotes = (await Promise.all(assets.map(getQuoteForAsset))).filter(Boolean);
    if (quotes.length > 0) {
      const lines = quotes.map(formatQuoteLine).join('\n');
      userContent = `LIVE DATA:\n${lines}\n\nUser question: ${question}`;
    }
  }

  try {
    const groqRes = await callGroq([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent }
    ]);

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
