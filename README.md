# Guff — deployment guide

This folder has everything needed to run Guff on your own domain, using a free
open-source model (via Groq's free API tier) instead of a per-user Claude account.

## Files
- `index.html` — the site itself
- `api/ask.js` — a Vercel serverless function that talks to Groq's API

## Steps

1. **Get a free Groq API key**
   Sign up at https://console.groq.com and create an API key.

2. **Push this folder to GitHub**
   Create a new repo and push these files (`index.html`, `api/ask.js`).

3. **Deploy on Vercel**
   - Go to https://vercel.com, sign up free, click "Add New Project"
   - Import your GitHub repo
   - In Project Settings → Environment Variables, add:
     `GROQ_API_KEY` = your key from step 1
   - Click Deploy

4. **Connect your domain**
   In the Vercel project → Settings → Domains, add your domain and follow
   the DNS instructions from wherever you bought it (Namecheap, GoDaddy, etc).

5. **Test it**
   Visit your domain, ask Guff a question, confirm you get a real answer.

6. **Add ads / payments once it's live**
   - Ads: apply for Google AdSense once the site has real content/traffic,
     then paste their script into `index.html`'s `<head>`.
   - Payments: create a Stripe account, set up a Payment Link or Checkout,
     and gate any premium feature behind it in `api/ask.js`.

## Notes
- The rate limiter in `api/ask.js` is basic (resets on redeploy) — fine to
  start, worth upgrading to something like Upstash Redis if traffic grows.
- Groq's free tier has rate limits; if you outgrow it, either upgrade your
  Groq plan or swap in a different provider — only `api/ask.js` needs to change.
