# Agent-X

Your brand's AI teammate on X. It watches the conversations that matter to you, drafts replies in your voice, and queues everything for your approval.

You define the keywords, the brand context, and the goals. Agent-X finds the right posts, writes replies that match your tone, and lets you send them with one click.

```bash
npx @l1ad/agent-x
```

## What it does

1. **Finds relevant posts** -- monitors X for keywords you care about, every 30 seconds
2. **Filters the noise** -- AI reads each post against your brand context and skips anything irrelevant
3. **Drafts replies aligned to your goals** -- want partnerships? It writes "let's talk" replies. Want awareness? It suggests quote tweets. Want community? It's helpful and follows back
4. **You stay in control** -- review one post at a time. Edit the draft, hit Reply, Quote, Like, Skip, or regenerate

## Quick start

```bash
npx @l1ad/agent-x
```

Open `http://127.0.0.1:3000`. Three steps:

1. **Settings** -- paste your X API keys and Anthropic key
2. **Context** -- tell it about your brand, your product, your tone, your goals
3. **Keywords** -- add what you want to monitor (e.g. `"headless CMS"`, `react server components`, `your competitor's name`)

Posts start appearing in the Feed within 30 seconds.

## The Context tab is the product

This is where you shape the AI. Fill in:

- **Profile** -- brand name, X handle, website, one-liner
- **Product** -- what you build, your features, what makes you different
- **Links** -- URLs the AI can drop into replies (it picks the right one per conversation)
- **Goals** -- what you want from engagement. This directly shapes how the AI drafts replies and who it suggests you follow
- **Tone** -- how you sound. Technical? Casual? Opinionated? The AI matches it
- **Things to avoid** -- guardrails. "Never fabricate experiences. No emojis. Don't be salesy"
- **Relevant topics** -- what conversations to surface
- **Irrelevant topics** -- what to auto-skip

The more specific you are, the better the drafts.

## How it works

```
Keywords  -->  X Search API  -->  AI Classifier  -->  Review Queue  -->  You
                (every 30s)       (filter + draft)     (one at a time)
```

The AI makes two decisions per post:

1. **Is this relevant?** Based on your context, goals, and topic rules
2. **What should we say?** Drafts a reply using your tone, product knowledge, and goals

You review each post with the draft pre-filled. Edit if you want, then:
- **Reply** -- opens X with the text pre-filled, you hit post
- **Quote** -- posts a quote tweet via the API
- **Like** / **Follow** -- one click, via the API
- **Regen** -- asks the AI for a fresh draft
- **Skip** -- moves to the next post

## Setup

### X API keys

Create an app at [developer.x.com](https://developer.x.com):

1. Set permissions to **Read and Write**
2. Set app type to **Web App, Automated App or Bot**
3. Add `http://127.0.0.1:3000/auth/x/callback` as a callback URL (X rejects `localhost`, use `127.0.0.1`)
4. Copy your Bearer Token, App Key/Secret, Access Token/Secret, Client ID/Secret

### Anthropic key

Get one from [console.anthropic.com](https://console.anthropic.com). Agent-X uses Claude to classify posts and draft replies.

### Configure

Paste all keys in the Settings tab, or use a `.env` file:

```bash
cp .env.example .env
# fill in your keys
npm start
```

Then click **Authenticate with X** in Settings to connect OAuth 2.0.

## Features

- **Keyword monitoring** -- add any search terms, X query operators supported
- **Account watchlist** -- monitor specific accounts regardless of keywords
- **AI-drafted replies** -- written in your voice, aligned to your goals
- **Quote tweets** -- posted via API for higher visibility
- **Likes and follows** -- one-click engagement
- **Regenerate** -- don't like the draft? Get a new one
- **Thread context** -- sees the parent tweet so replies fit the conversation
- **Author bios** -- the AI knows who it's replying to
- **Engagement tracking** -- won't suggest following someone you already follow, avoids replying to the same person twice in a day
- **Follower threshold** -- skip low-follower accounts
- **Excluded terms and accounts** -- filter out noise at the search level

## Configuration

| Setting | Default | What it does |
|---------|---------|--------------|
| Poll interval | 30s | How often to check for new posts |
| Min followers | 250 | Ignore accounts below this |
| Excluded accounts | -- | Your own handles, competitors, spam |
| Excluded terms | -- | Filter noise from search results |
| AI Model | Claude Sonnet 4 | Sonnet (smarter) or Haiku (faster, cheaper) |

## Known limitations

- **Replies via API are blocked** on X's pay-per-use plan. The Reply button opens X's web intent as a workaround. Quote tweets, likes, and follows work via API
- **2M reads/month cap** on pay-per-use. Enterprise tier for higher volume
- **Polls every 30s**, not real-time streaming. Fast enough for most use cases

## Stack

TypeScript, Node.js 22, SQLite, Anthropic Claude, X API v2. Single-file HTML dashboard. No build step. No external database.

## License

MIT
