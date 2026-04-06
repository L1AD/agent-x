import { createServer } from "http";
import {
  getRules,
  addRule,
  deleteRule,
  getPending,
  getAllPosts,
  getPostById,
  setStatus,
  getStats,
  getWatchlist,
  addWatchlistAccount,
  deleteWatchlistAccount,
  updateClassification,
  setSetting,
  getAllSettings,
} from "./db.js";
import { restartStream } from "./stream.js";
import { createActionsClient, postReply, postQuote, likePost, followUser } from "./actions.js";
import { classify } from "./classifier.js";
import { TwitterApi } from "twitter-api-v2";
import { getKeys } from "./keys.js";
import { getAuthUrl, exchangeCode, getOAuth2Client } from "./oauth2.js";

let xClient: TwitterApi;
let myUserId: string;

async function getWriteClient(): Promise<TwitterApi> {
  return await getOAuth2Client() || xClient;
}

export async function startServer(port = 3000) {
  const keys = getKeys();

  // Try to init write client, but don't crash if keys are missing
  if (keys.appKey && keys.accessToken) {
    try {
      xClient = createActionsClient({
        appKey: keys.appKey,
        appSecret: keys.appSecret,
        accessToken: keys.accessToken,
        accessSecret: keys.accessSecret,
      });
      const me = await xClient.v2.me();
      myUserId = me.data.id;
      console.log(`[server] Authenticated as @${me.data.username}`);
    } catch (err: any) {
      console.warn(`[server] X write auth failed: ${err.message}. Configure keys in Settings.`);
    }
  } else {
    console.log("[server] X write keys not configured. Set them in Settings.");
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`);

    // CORS
    res.setHeader("Content-Type", "application/json");

    // Parse body for POST/DELETE
    let body = "";
    if (req.method === "POST" || req.method === "DELETE") {
      for await (const chunk of req) body += chunk;
    }

    try {
      // --- API Routes ---
      if (url.pathname === "/api/rules" && req.method === "GET") {
        const rules = getRules.all();
        res.end(JSON.stringify(rules));
        return;
      }

      if (url.pathname === "/api/rules" && req.method === "POST") {
        const { keyword } = JSON.parse(body);
        if (!keyword?.trim()) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "keyword required" }));
          return;
        }
        addRule.run({ keyword: keyword.trim() });
        restartStream();
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname.startsWith("/api/rules/") && req.method === "DELETE") {
        const id = url.pathname.split("/").pop();
        deleteRule.run({ id: Number(id) });
        restartStream();
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === "/api/posts" && req.method === "GET") {
        const filter = url.searchParams.get("filter") || "pending";
        let posts;
        if (filter === "pending") {
          posts = getPending.all();
        } else {
          posts = getAllPosts.all();
        }
        res.end(JSON.stringify(posts));
        return;
      }

      if (url.pathname === "/api/reply" && req.method === "POST") {
        const { postId, text, authorId } = JSON.parse(body);
        const result = await postReply(await getWriteClient(), postId, text, authorId);
        res.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/api/quote" && req.method === "POST") {
        const { postId, text, authorUsername, authorId } = JSON.parse(body);
        const result = await postQuote(await getWriteClient(), postId, text, authorUsername, authorId);
        res.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/api/like" && req.method === "POST") {
        const { postId, authorId } = JSON.parse(body);
        await likePost(await getWriteClient(), myUserId, postId, authorId);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === "/api/follow" && req.method === "POST") {
        const { postId, authorId } = JSON.parse(body);
        await followUser(await getWriteClient(), myUserId, authorId, postId);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === "/api/skip" && req.method === "POST") {
        const { postId } = JSON.parse(body);
        setStatus.run({ id: postId, status: "skipped" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === "/api/regenerate" && req.method === "POST") {
        const { postId } = JSON.parse(body);
        const post = getPostById.get({ id: postId }) as any;
        if (!post) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "post not found" }));
          return;
        }
        const result = await classify({
          text: post.text,
          author_username: post.author_username,
          author_name: post.author_name,
          author_followers: post.author_followers,
          author_bio: post.author_bio ?? undefined,
          thread_context: post.thread_context ?? undefined,
        });
        updateClassification.run({
          id: postId,
          quality: result.quality,
          draft_reply: result.reply,
          should_follow: result.should_follow ? 1 : 0,
          suggest_quote: result.suggest_quote ? 1 : 0,
        });
        setStatus.run({ id: postId, status: "pending" });
        res.end(JSON.stringify({ ok: true, reply: result.reply }));
        return;
      }

      // Watchlist
      if (url.pathname === "/api/watchlist" && req.method === "GET") {
        res.end(JSON.stringify(getWatchlist.all()));
        return;
      }

      if (url.pathname === "/api/watchlist" && req.method === "POST") {
        const { username } = JSON.parse(body);
        if (!username?.trim()) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "username required" }));
          return;
        }
        addWatchlistAccount.run({ username: username.trim().replace(/^@/, "") });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname.startsWith("/api/watchlist/") && req.method === "DELETE") {
        const id = url.pathname.split("/").pop();
        deleteWatchlistAccount.run({ id: Number(id) });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === "/api/stats" && req.method === "GET") {
        const stats = getStats.all();
        res.end(JSON.stringify(stats));
        return;
      }

      // Settings
      if (url.pathname === "/api/settings" && req.method === "GET") {
        const SECRET_KEYS = new Set(["x_client_id", "x_client_secret", "x_bearer_token", "x_app_key", "x_app_secret", "x_access_token", "x_access_secret", "anthropic_api_key", "oauth2_access_token", "oauth2_refresh_token"]);
        const rows = getAllSettings.all() as { key: string; value: string }[];
        const settings: Record<string, string> = {};
        for (const r of rows) {
          settings[r.key] = SECRET_KEYS.has(r.key) && r.value ? "********" : r.value;
        }
        res.end(JSON.stringify(settings));
        return;
      }

      if (url.pathname === "/api/settings" && req.method === "POST") {
        const data = JSON.parse(body);
        for (const [key, value] of Object.entries(data)) {
          setSetting.run({ key, value: String(value) });
        }
        res.end(JSON.stringify({ ok: true }));
        return;
      }


      // --- OAuth2 ---
      if (url.pathname === "/auth/x" && req.method === "GET") {
        const redirectUri = `http://127.0.0.1:${port}/auth/x/callback`;
        const authUrl = getAuthUrl(redirectUri);
        res.writeHead(302, { Location: authUrl });
        res.end();
        return;
      }

      if (url.pathname === "/auth/x/callback" && req.method === "GET") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const redirectUri = `http://127.0.0.1:${port}/auth/x/callback`;

        if (!code || !state) {
          res.setHeader("Content-Type", "text/html");
          res.end("<h3>Error: missing code or state</h3><a href='/'>Back</a>");
          return;
        }

        const result = await exchangeCode(code, state, redirectUri);
        res.setHeader("Content-Type", "text/html");
        if (result.ok) {
          res.end("<h3>Authenticated as @" + result.username + "</h3><p>OAuth 2.0 connected. Replies should now work.</p><a href='/'>Back to Agent-X</a>");
        } else {
          res.end("<h3>Error: " + result.error + "</h3><a href='/'>Back</a>");
        }
        return;
      }

      if (url.pathname === "/api/auth/status" && req.method === "GET") {
        const oauth2 = await getOAuth2Client();
        res.end(JSON.stringify({ oauth2: !!oauth2 }));
        return;
      }

      // --- HTML ---
      const htmlPaths = ["/", "/feed", "/keywords", "/watchlist", "/context", "/settings"];
      if (htmlPaths.includes(url.pathname)) {
        res.setHeader("Content-Type", "text/html");
        res.end(HTML);
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err: any) {
      console.error("[server]", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[server] http://127.0.0.1:${port}`);
  });
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent-X</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0A0A0A;
    --surface: #111111;
    --surface-2: #181818;
    --border: #242424;
    --border-2: #2E2E2E;
    --text: #E8E8E8;
    --text-muted: #888888;
    --text-dim: #555555;
    --accent: #CDFF3E;
    --accent-dim: rgba(205,255,62,0.10);
    --deny: #FF3232;
    --deny-dim: rgba(255,50,50,0.12);
    --allow: #22C55E;
    --allow-dim: rgba(34,197,94,0.12);
    --warning: #F59E0B;
    --font-mono: "IBM Plex Mono", monospace;
    --font-sans: "DM Sans", sans-serif;
    --radius: 4px;
    --radius-sm: 2px;
    --t-fast: 0.15s ease;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--font-sans); background: var(--bg); color: var(--text); font-weight: 300; }

  /* Nav */
  .nav { display: flex; align-items: center; border-bottom: 1px solid var(--border); background: rgba(10,10,10,0.95); backdrop-filter: blur(12px); position: sticky; top: 0; z-index: 10; height: 56px; padding: 0 24px; }
  .nav-brand { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--accent); letter-spacing: 0.05em; margin-right: 32px; }
  .tabs { display: flex; gap: 0; height: 100%; }
  .tab { padding: 0 20px; cursor: pointer; border-bottom: 2px solid transparent; color: var(--text-muted); font-family: var(--font-mono); font-size: 11px; font-weight: 400; letter-spacing: 0.15em; text-transform: uppercase; display: flex; align-items: center; transition: color var(--t-fast); }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .panel { display: none; padding: 24px; max-width: 860px; margin: 0 auto; }
  .panel.active { display: block; }

  /* Forms */
  .keyword-form { display: flex; gap: 8px; margin-bottom: 24px; }
  .keyword-form input { flex: 1; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-family: var(--font-mono); font-size: 13px; outline: none; transition: border-color var(--t-fast); }
  .keyword-form input:focus { border-color: var(--accent); }
  .keyword-form button { padding: 10px 20px; background: var(--accent); color: var(--bg); border: none; border-radius: var(--radius); cursor: pointer; font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; transition: opacity var(--t-fast); }
  .keyword-form button:hover { opacity: 0.85; }
  .rule { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 1px; }
  .rule code { font-family: var(--font-mono); font-size: 13px; color: var(--accent); }
  .rule .delete { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px; padding: 4px 8px; transition: color var(--t-fast); }
  .rule .delete:hover { color: var(--deny); }
  .empty { color: var(--text-dim); text-align: center; padding: 48px; font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.05em; }

  /* Cost bar */

  /* Filter */
  .filter-bar { display: flex; gap: 8px; margin-bottom: 20px; }
  .filter-btn { padding: 6px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-muted); cursor: pointer; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; transition: all var(--t-fast); }
  .filter-btn.active { background: var(--surface-2); color: var(--text); border-color: var(--accent); }

  /* Posts */
  .post { position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 1px; }
  .post-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .post-author { font-family: var(--font-sans); font-weight: 500; color: var(--text); font-size: 15px; }
  .post-handle { font-family: var(--font-mono); color: var(--text-dim); font-size: 12px; }
  .post-followers { font-family: var(--font-mono); color: var(--text-dim); font-size: 11px; letter-spacing: 0.02em; }
  .post-bio { color: var(--text-muted); font-size: 13px; margin-bottom: 10px; font-weight: 300; line-height: 1.5; }
  .post-thread { background: var(--bg); border-left: 2px solid var(--accent); padding: 10px 16px; margin-bottom: 12px; font-size: 13px; color: var(--text-muted); font-weight: 300; line-height: 1.5; }
  .post-text { font-size: 15px; line-height: 1.6; margin-bottom: 12px; white-space: pre-wrap; color: var(--text); font-weight: 300; }
  .post-text a { color: var(--accent); text-decoration: none; }
  .post-text a:hover { text-decoration: underline; }

  /* Badges */
  .post-badges { display: flex; gap: 6px; margin-bottom: 14px; align-items: center; }
  .post-quality { font-family: var(--font-mono); font-size: 10px; font-weight: 600; text-transform: uppercase; padding: 2px 8px; border-radius: var(--radius-sm); letter-spacing: 0.1em; }
  .post-quality.high { background: var(--allow-dim); border: 1px solid rgba(34,197,94,0.3); color: var(--allow); }
  .post-quality.medium { background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.3); color: var(--warning); }
  .post-quality.low { background: var(--deny-dim); border: 1px solid rgba(255,50,50,0.3); color: var(--deny); }
  .badge { font-family: var(--font-mono); font-size: 10px; font-weight: 600; text-transform: uppercase; padding: 2px 8px; border-radius: var(--radius-sm); letter-spacing: 0.1em; }
  .badge-quote { background: var(--accent-dim); border: 1px solid rgba(205,255,62,0.3); color: var(--accent); }
  .badge-liked { background: var(--surface-2); border: 1px solid var(--border); color: var(--text-dim); }

  /* Reply textarea */
  .post-reply { width: 100%; padding: 12px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-family: var(--font-sans); font-size: 14px; font-weight: 300; resize: vertical; min-height: 120px; line-height: 1.5; margin-bottom: 10px; transition: border-color var(--t-fast); }
  .post-reply:focus { border-color: var(--accent); outline: none; }

  /* Dismiss */
  .post-dismiss { position: absolute; top: 14px; right: 14px; background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 18px; padding: 4px 8px; line-height: 1; transition: color var(--t-fast); }
  .post-dismiss:hover { color: var(--deny); }

  /* Buttons */
  .post-actions-row { display: flex; align-items: center; justify-content: space-between; }
  .post-actions-primary { display: flex; gap: 8px; }
  .post-actions-primary .btn { padding: 10px 24px; font-size: 11px; }
  .post-actions-secondary { display: flex; gap: 6px; align-items: center; }
  .post-actions-secondary .btn { padding: 5px 10px; font-size: 9px; border-color: transparent; color: var(--text-dim); }
  .post-actions-secondary .btn:hover { color: var(--text-muted); border-color: var(--border); }
  .post-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .btn { padding: 7px 14px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; transition: all var(--t-fast); }
  .btn-send { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .btn-send:hover { opacity: 0.85; }
  .btn-quote { background: var(--accent-dim); color: var(--accent); border-color: rgba(205,255,62,0.3); }
  .btn-quote:hover { background: rgba(205,255,62,0.18); }
  .btn-like { background: transparent; color: var(--deny); border-color: rgba(255,50,50,0.3); }
  .btn-like:hover { background: var(--deny-dim); }
  .btn-skip { background: var(--surface-2); color: var(--text-muted); border-color: var(--border); }
  .btn-skip:hover { color: var(--text); border-color: var(--border-2); }
  .btn-follow { background: var(--allow-dim); color: var(--allow); border-color: rgba(34,197,94,0.3); }
  .btn-follow:hover { background: rgba(34,197,94,0.18); }
  .btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .post-link { font-family: var(--font-mono); color: var(--text-dim); text-decoration: none; font-size: 10px; margin-left: auto; letter-spacing: 0.05em; transition: color var(--t-fast); }
  .post-link:hover { color: var(--accent); }
  .post-status { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); padding: 4px 8px; letter-spacing: 0.1em; text-transform: uppercase; }

  /* Carousel */
  .carousel-nav { display: flex; align-items: center; justify-content: center; gap: 16px; margin-bottom: 16px; }
  .dots { display: flex; justify-content: center; gap: 6px; padding: 12px 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border-2); cursor: pointer; transition: background var(--t-fast); }
  .dot.active { background: var(--accent); }
  .dot:hover { background: var(--text-dim); }

  /* Form fields */
  .field { margin-bottom: 20px; }
  .field-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.15em; color: var(--text-dim); text-transform: uppercase; display: block; margin-bottom: 6px; }
  .field-hint { font-size: 12px; color: var(--text-dim); margin-top: 4px; line-height: 1.4; }
  .field-input { width: 100%; padding: 8px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-family: var(--font-mono); font-size: 13px; outline: none; transition: border-color var(--t-fast); }
  .field-input:focus { border-color: var(--accent); }
  .field-textarea { width: 100%; padding: 12px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-family: var(--font-sans); font-size: 14px; font-weight: 300; line-height: 1.6; resize: vertical; outline: none; transition: border-color var(--t-fast); }
  .field-textarea:focus { border-color: var(--accent); }
  .field-textarea.mono { font-family: var(--font-mono); font-size: 13px; }
  .section-label { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.15em; color: var(--text-dim); margin-bottom: 16px; }
  .section-label span { color: var(--accent); }
  .links-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; }
  .links-row input { flex: 1; }
  .links-row .delete { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px; padding: 4px 8px; transition: color var(--t-fast); }
  .links-row .delete:hover { color: var(--deny); }
</style>
</head>
<body>

<div class="nav">
  <span class="nav-brand">// AGENT-X</span>
  <div class="tabs">
    <div class="tab" data-tab="feed">Feed</div>
    <div class="tab" data-tab="keywords">Keywords</div>
    <div class="tab" data-tab="watchlist">Watchlist</div>
    <div class="tab" data-tab="context">Context</div>
    <div class="tab" data-tab="settings">Settings</div>
  </div>
</div>

<div id="feed" class="panel">
  <div class="filter-bar">
    <button class="filter-btn active" data-filter="pending">Filtered</button>
    <button class="filter-btn" data-filter="all">All</button>
  </div>
  <div class="carousel-nav">
    <button class="btn btn-skip" onclick="prevPost()">&larr;</button>
    <span id="post-counter" style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)"></span>
    <button class="btn btn-skip" onclick="nextPost()">&rarr;</button>
  </div>
  <div id="posts"></div>
  <div id="post-dots" class="dots"></div>
  <div style="text-align:center;padding:16px"><button class="btn btn-skip" onclick="loadPosts()" style="padding:8px 24px">Refresh</button></div>
</div>

<div id="keywords" class="panel">
  <div class="keyword-form">
    <input type="text" id="keyword-input" placeholder='e.g. "Model Context Protocol" or MCP server'>
    <button onclick="addKeyword()">Add</button>
  </div>
  <div id="rules"></div>
</div>

<div id="watchlist" class="panel">
  <div class="keyword-form">
    <input type="text" id="watchlist-input" placeholder="@username">
    <button onclick="addWatch()">Add</button>
  </div>
  <div id="watchlist-items"></div>
</div>

<div id="context" class="panel">

  <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:24px">
    <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;color:var(--accent);margin-bottom:8px">GETTING STARTED</div>
    <p style="font-size:13px;color:var(--text-muted);line-height:1.6;margin-bottom:0">
      Tell Agent-X about your brand so it knows which posts to surface and how to draft replies. Fill in as much as you can. The more context, the better the AI drafts.
    </p>
  </div>

  <div class="section-label"><span>//</span> PROFILE</div>

  <div class="field">
    <label class="field-label">Brand name</label>
    <input id="ctx-brand-name" class="field-input" style="width:300px" placeholder="e.g. Acme Corp">
  </div>

  <div class="field">
    <label class="field-label">X handle</label>
    <input id="ctx-x-handle" class="field-input" style="width:300px" placeholder="e.g. AcmeCorp (without @)">
    <div class="field-hint">Auto-excluded from search results so you don't see your own posts.</div>
  </div>

  <div class="field">
    <label class="field-label">Website</label>
    <input id="ctx-website" class="field-input" style="width:400px" placeholder="e.g. https://acme.com">
    <div class="field-hint">Included in replies when mentioning your product.</div>
  </div>

  <div class="field">
    <label class="field-label">One-liner</label>
    <input id="ctx-oneliner" class="field-input" placeholder="e.g. The control layer for AI agents">
    <div class="field-hint">One sentence that describes what you do.</div>
  </div>

  <div class="section-label" style="margin-top:32px"><span>//</span> PRODUCT</div>

  <div class="field">
    <label class="field-label">What you do</label>
    <textarea id="ctx-product" class="field-textarea" style="min-height:200px" placeholder="Describe your product, features, and capabilities. The AI uses this to understand what you offer and draft relevant replies."></textarea>
    <div class="field-hint">Be specific. List features, technical details, install commands. The more concrete, the better the replies.</div>
  </div>

  <div class="field">
    <label class="field-label">Links to include in replies</label>
    <div id="ctx-links"></div>
    <button class="btn btn-skip" onclick="addLinkRow()" style="margin-top:4px">+ Add link</button>
    <div class="field-hint">Label + URL pairs. The AI picks the most relevant link for each reply.</div>
  </div>

  <div class="section-label" style="margin-top:32px"><span>//</span> GOALS</div>

  <div class="field">
    <label class="field-label">What do you want from this?</label>
    <textarea id="ctx-goals" class="field-textarea" style="min-height:100px" placeholder="e.g. Drive awareness among developers. Start conversations that lead to partnerships. Get people to try our product."></textarea>
    <div class="field-hint">The AI uses this to decide how to engage. Partnerships = "let's talk" replies. Awareness = quote tweets and bold takes. Community = helpful replies and follows.</div>
  </div>

  <div class="section-label" style="margin-top:32px"><span>//</span> ENGAGEMENT RULES</div>

  <div class="field">
    <label class="field-label">Tone</label>
    <textarea id="ctx-tone" class="field-textarea" style="min-height:100px" placeholder="How should replies sound? e.g. Conversational, technical, like an engineer in a thread. Not salesy."></textarea>
  </div>

  <div class="field">
    <label class="field-label">Things to avoid</label>
    <textarea id="ctx-avoid" class="field-textarea" style="min-height:100px" placeholder="e.g. Never fabricate experiences. No emojis. No em-dashes. Don't claim we've witnessed incidents."></textarea>
  </div>

  <div class="field">
    <label class="field-label">Relevant topics</label>
    <textarea id="ctx-relevant" class="field-textarea" style="min-height:100px" placeholder="What topics should the bot engage with? One per line."></textarea>
    <div class="field-hint">Posts matching these topics will appear in your feed with draft replies.</div>
  </div>

  <div class="field">
    <label class="field-label">Irrelevant topics</label>
    <textarea id="ctx-irrelevant" class="field-textarea" style="min-height:100px" placeholder="What should be auto-skipped? One per line."></textarea>
    <div class="field-hint">Posts matching these topics will be silently filtered out.</div>
  </div>

  <div style="margin-top:16px">
    <button class="btn btn-send" onclick="saveContext()">Save</button>
    <span id="context-status" style="font-family:var(--font-mono);font-size:11px;color:var(--allow);margin-left:12px"></span>
  </div>
</div>

<div id="settings" class="panel">

  <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:24px">
    <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;color:var(--accent);margin-bottom:8px">SETUP</div>
    <p style="font-size:13px;color:var(--text-muted);line-height:1.6;margin-bottom:8px">
      Agent-X needs API keys from X and Anthropic to work.
    </p>
    <p style="font-size:13px;color:var(--text-muted);line-height:1.6;margin-bottom:4px">
      <strong style="color:var(--text)">1.</strong> Create an X app at <a href="https://developer.x.com" target="_blank" style="color:var(--accent)">developer.x.com</a>. Set permissions to Read and Write. Set app type to Web App/Bot. Copy your Bearer Token, App Key/Secret, Access Token/Secret, Client ID/Secret.
    </p>
    <p style="font-size:13px;color:var(--text-muted);line-height:1.6;margin-bottom:4px">
      <strong style="color:var(--text)">2.</strong> Get an Anthropic key at <a href="https://console.anthropic.com" target="_blank" style="color:var(--accent)">console.anthropic.com</a>.
    </p>
    <p style="font-size:13px;color:var(--text-muted);line-height:1.6;margin-bottom:4px">
      <strong style="color:var(--text)">3.</strong> Paste all keys below, save, then click Authenticate with X.
    </p>
    <p style="font-size:13px;color:var(--text-muted);line-height:1.6;margin-bottom:0">
      <strong style="color:var(--text)">4.</strong> Add <code style="color:var(--accent);font-family:var(--font-mono);font-size:12px">http://127.0.0.1:3000/auth/x/callback</code> as a callback URL in your X app's auth settings. X rejects <code style="font-family:var(--font-mono);font-size:12px;color:var(--text-dim)">http://localhost</code>, use <code style="font-family:var(--font-mono);font-size:12px;color:var(--text-dim)">127.0.0.1</code> instead.
    </p>
  </div>

  <div class="section-label"><span>//</span> KEYS</div>
  <p class="field-hint" style="margin-bottom:16px">Can also be set via .env file. UI values take priority. Restart required after changes.</p>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
    <div><label class="field-label">X Bearer Token</label><input id="set-x-bearer" class="field-input" type="password"></div>
    <div><label class="field-label">Anthropic API Key</label><input id="set-anthropic-key" class="field-input" type="password"></div>
    <div><label class="field-label">X Client ID</label><input id="set-x-client-id" class="field-input" type="password"></div>
    <div><label class="field-label">X Client Secret</label><input id="set-x-client-secret" class="field-input" type="password"></div>
    <div><label class="field-label">X App Key</label><input id="set-x-app-key" class="field-input" type="password"></div>
    <div><label class="field-label">X App Secret</label><input id="set-x-app-secret" class="field-input" type="password"></div>
    <div><label class="field-label">X Access Token</label><input id="set-x-access-token" class="field-input" type="password"></div>
    <div><label class="field-label">X Access Secret</label><input id="set-x-access-secret" class="field-input" type="password"></div>
  </div>

  <div class="section-label" style="margin-top:24px"><span>//</span> X ACCOUNT</div>
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px">
    <div id="oauth2-status"></div>
    <a href="/auth/x" class="btn btn-send" style="text-decoration:none;display:inline-block">Authenticate with X</a>
    <span class="field-hint">OAuth 2.0. Required for posting.</span>
  </div>

  <div class="section-label"><span>//</span> BEHAVIOUR</div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
    <div>
      <label class="field-label">Min followers</label>
      <input id="set-min-followers" class="field-input" type="number" style="width:120px" value="250">
    </div>
    <div>
      <label class="field-label">Poll interval (seconds)</label>
      <input id="set-poll-interval" class="field-input" type="number" style="width:120px" value="30">
    </div>
    <div>
      <label class="field-label">AI Model</label>
      <select id="set-model" class="field-input" style="width:100%">
        <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
        <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
      </select>
    </div>
  </div>

  <div class="field">
    <label class="field-label">Excluded accounts</label>
    <input id="set-excluded-accounts" class="field-input" placeholder="MyBrand, PersonalHandle">
  </div>

  <div class="field">
    <label class="field-label">Excluded terms</label>
    <input id="set-excluded-terms" class="field-input" placeholder='"market cap", DEXScreener, pump'>
  </div>

  <div style="margin-top:16px">
    <button class="btn btn-send" onclick="saveSettings()">Save</button>
    <span id="settings-status" style="font-family:var(--font-mono);font-size:11px;color:var(--allow);margin-left:12px"></span>
  </div>
</div>

<script>
// Tabs with URL routing
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const tab = document.querySelector('.tab[data-tab="' + tabName + '"]');
  if (tab) tab.classList.add('active');
  const panel = document.getElementById(tabName);
  if (panel) panel.classList.add('active');
  history.replaceState(null, '', '/' + (tabName === 'feed' ? '' : tabName));
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// Init tab from URL
const path = location.pathname.replace(/^\\//, '') || 'feed';
switchTab(path);

// Filter
let currentFilter = 'pending';
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    loadPosts();
  });
});

// Keywords
async function loadRules() {
  const res = await fetch('/api/rules');
  const rules = await res.json();
  const el = document.getElementById('rules');
  if (rules.length === 0) {
    el.innerHTML = '<div class="empty">No keywords yet. Add one above to start monitoring.</div>';
    return;
  }
  el.innerHTML = rules.map(r => \`
    <div class="rule">
      <code>\${esc(r.keyword)}</code>
      <button class="delete" onclick="removeRule(\${r.id})">&times;</button>
    </div>
  \`).join('');
}

async function addKeyword() {
  const input = document.getElementById('keyword-input');
  const keyword = input.value.trim();
  if (!keyword) return;
  input.value = '';
  await fetch('/api/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword })
  });
  loadRules();
}

document.getElementById('keyword-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addKeyword();
});

async function removeRule(id) {
  await fetch('/api/rules/' + id, { method: 'DELETE' });
  loadRules();
}

// Posts
let allPosts = [];
let currentIndex = 0;

async function loadPosts() {
  const res = await fetch('/api/posts?filter=' + currentFilter);
  allPosts = await res.json();
  currentIndex = 0;
  renderCurrentPost();
}

function renderCurrentPost() {
  const el = document.getElementById('posts');
  const counter = document.getElementById('post-counter');
  const dots = document.getElementById('post-dots');

  if (allPosts.length === 0) {
    el.innerHTML = '<div class="empty">No posts to review. Hit Refresh to check for new ones.</div>';
    counter.textContent = '';
    dots.innerHTML = '';
    return;
  }

  if (currentIndex >= allPosts.length) currentIndex = allPosts.length - 1;
  if (currentIndex < 0) currentIndex = 0;

  counter.textContent = (currentIndex + 1) + ' / ' + allPosts.length;

  // Dots (max 20 visible)
  const maxDots = Math.min(allPosts.length, 20);
  const start = Math.max(0, currentIndex - 10);
  const end = Math.min(allPosts.length, start + maxDots);
  dots.innerHTML = '';
  for (let i = start; i < end; i++) {
    const dot = document.createElement('span');
    dot.className = 'dot' + (i === currentIndex ? ' active' : '');
    dot.onclick = () => { currentIndex = i; renderCurrentPost(); };
    dots.appendChild(dot);
  }

  const p = allPosts[currentIndex];
  el.innerHTML = '<div class="post" id="post-' + p.id + '">'
    + '<div class="post-header">'
    + '<span class="post-author">' + esc(p.author_name) + '</span>'
    + '<span class="post-handle">@' + esc(p.author_username) + '</span>'
    + '<span class="post-followers">&middot; ' + (p.author_followers || 0).toLocaleString() + ' followers</span>'
    + '<a class="post-link" style="margin-left:auto" href="https://x.com/'+p.author_username+'/status/'+p.id+'" target="_blank">View on X &rarr;</a>'
    + '</div>'
    + (p.author_bio ? '<div class="post-bio">' + esc(p.author_bio) + '</div>' : '')
    + '<hr style="border:none;border-top:1px solid var(--border);margin:12px 0">'
    + (p.thread_context ? '<div class="post-thread">' + esc(p.thread_context) + '</div>' : '')
    + '<div class="post-text">' + linkify(p.text) + '</div>'
    + (p.suggest_quote || p.liked ? '<div class="post-badges">'
    + (p.suggest_quote ? '<span class="badge badge-quote">quote suggested</span>' : '')
    + (p.liked ? '<span class="badge badge-liked">liked</span>' : '')
    + '</div>' : '')
    + (p.status === 'pending' && p.draft_reply
      ? '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'
        + '<span class="field-label" style="margin:0">Proposed reply</span>'
        + '<button class="btn btn-skip" onclick="regenerateReply(\\''+p.id+'\\')">Regen</button>'
        + '</div>'
        + '<textarea class="post-reply" id="reply-' + p.id + '">' + esc(p.draft_reply) + '</textarea>'
        + '<div class="post-actions-row">'
        + '<div class="post-actions-primary">'
        + '<button class="btn btn-send" onclick="openReply(\\''+p.id+'\\')">Reply</button>'
        + '<button class="btn btn-quote" onclick="sendQuote(\\''+p.id+'\\', \\''+p.author_username+'\\', \\''+p.author_id+'\\')">Quote</button>'
        + '<button class="btn btn-skip" onclick="doSkip(\\''+p.id+'\\')">Skip</button>'
        + '</div>'
        + '<div class="post-actions-secondary">'
        + '<button class="btn" onclick="likePost(\\''+p.id+'\\', \\''+p.author_id+'\\')">Like</button>'
        + (p.should_follow ? '<button class="btn" onclick="followAuthor(\\''+p.id+'\\', \\''+p.author_id+'\\')">Follow</button>' : '')
        + '</div>'
        + '</div>'
      : '<div class="post-actions-secondary">'
        + (!p.liked && p.status !== 'skipped' ? '<button class="btn" onclick="likePost(\\''+p.id+'\\', \\''+p.author_id+'\\')">Like</button>' : '')
        + '<span class="post-status">' + p.status + '</span>'
        + (p.error ? '<span style="color:#f87171;font-size:12px;margin-left:8px">' + esc(p.error) + '</span>' : '')
        + '</div>'
    )
    + '</div>';
}

function nextPost() { if (currentIndex < allPosts.length - 1) { currentIndex++; renderCurrentPost(); } }
function prevPost() { if (currentIndex > 0) { currentIndex--; renderCurrentPost(); } }

// Skip and advance
async function doSkip(postId) {
  await fetch('/api/skip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postId }) });
  allPosts.splice(currentIndex, 1);
  renderCurrentPost();
}

function showError(postId, msg) {
  let el = document.getElementById('error-' + postId);
  if (!el) {
    el = document.createElement('div');
    el.id = 'error-' + postId;
    el.style.cssText = 'color:#f87171;font-size:12px;padding:6px 0;';
    document.getElementById('post-' + postId).appendChild(el);
  }
  el.textContent = msg;
}

function openReply(postId) {
  const text = document.getElementById('reply-' + postId).value.trim();
  if (!text) return;
  const url = 'https://x.com/intent/tweet?in_reply_to=' + postId + '&text=' + encodeURIComponent(text);
  window.open(url, '_blank');
  doSkip(postId);
}

async function sendQuote(postId, authorUsername, authorId) {
  const text = document.getElementById('reply-' + postId).value.trim();
  if (!text) return;
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Quoting...';
  const res = await fetch('/api/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId, text, authorUsername, authorId })
  });
  const data = await res.json();
  if (data.ok) {
    allPosts.splice(currentIndex, 1);
    renderCurrentPost();
  } else {
    btn.disabled = false;
    btn.textContent = 'Quote';
    showError(postId, data.error || 'Quote failed');
  }
}

async function regenerateReply(postId) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Generating...';
  const res = await fetch('/api/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId })
  });
  const data = await res.json();
  if (data.ok) {
    loadPosts();
  } else {
    btn.disabled = false;
    btn.textContent = 'Regen';
    showError(postId, data.error || 'Regeneration failed');
  }
}

async function likePost(postId, authorId) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Liked';
  await fetch('/api/like', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId, authorId })
  });
}


async function followAuthor(postId, authorId) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Followed';
  await fetch('/api/follow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId, authorId })
  });
}

// Watchlist
async function loadWatchlist() {
  const res = await fetch('/api/watchlist');
  const items = await res.json();
  const el = document.getElementById('watchlist-items');
  if (items.length === 0) {
    el.innerHTML = '<div class="empty">No accounts watched. Add accounts to monitor their posts.</div>';
    return;
  }
  el.innerHTML = items.map(w => \`
    <div class="rule">
      <code>@\${esc(w.username)}</code>
      <button class="delete" onclick="removeWatch(\${w.id})">&times;</button>
    </div>
  \`).join('');
}

async function addWatch() {
  const input = document.getElementById('watchlist-input');
  const username = input.value.trim();
  if (!username) return;
  input.value = '';
  await fetch('/api/watchlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  });
  loadWatchlist();
}

document.getElementById('watchlist-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addWatch();
});

async function removeWatch(id) {
  await fetch('/api/watchlist/' + id, { method: 'DELETE' });
  loadWatchlist();
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function linkify(s) {
  return esc(s).replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank">$1</a>');
}

// Links
function addLinkRow(label, url) {
  const container = document.getElementById('ctx-links');
  const row = document.createElement('div');
  row.className = 'links-row';
  row.innerHTML = '<input class="field-input" style="width:150px" placeholder="Label" value="' + esc(label || '') + '">'
    + '<input class="field-input" placeholder="URL" value="' + esc(url || '') + '">'
    + '<button class="delete" onclick="this.parentElement.remove()">&times;</button>';
  container.appendChild(row);
}

function getLinks() {
  const rows = document.querySelectorAll('#ctx-links .links-row');
  const links = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const label = inputs[0].value.trim();
    const url = inputs[1].value.trim();
    if (label && url) links.push({ label, url });
  });
  return links;
}

// Context
async function loadContext() {
  const res = await fetch('/api/settings');
  const s = await res.json();
  document.getElementById('ctx-brand-name').value = s.ctx_brand_name || '';
  document.getElementById('ctx-x-handle').value = s.ctx_x_handle || '';
  document.getElementById('ctx-website').value = s.ctx_website || '';
  document.getElementById('ctx-oneliner').value = s.ctx_oneliner || '';
  document.getElementById('ctx-product').value = s.ctx_product || '';
  document.getElementById('ctx-goals').value = s.ctx_goals || '';
  document.getElementById('ctx-tone').value = s.ctx_tone || '';
  document.getElementById('ctx-avoid').value = s.ctx_avoid || '';
  document.getElementById('ctx-relevant').value = s.ctx_relevant || '';
  document.getElementById('ctx-irrelevant').value = s.ctx_irrelevant || '';

  // Links
  document.getElementById('ctx-links').innerHTML = '';
  try {
    const links = JSON.parse(s.ctx_links || '[]');
    links.forEach(l => addLinkRow(l.label, l.url));
  } catch {}
  if (!document.querySelectorAll('#ctx-links .links-row').length) addLinkRow();
}

async function saveContext() {
  const data = {
    ctx_brand_name: document.getElementById('ctx-brand-name').value,
    ctx_x_handle: document.getElementById('ctx-x-handle').value,
    ctx_website: document.getElementById('ctx-website').value,
    ctx_oneliner: document.getElementById('ctx-oneliner').value,
    ctx_product: document.getElementById('ctx-product').value,
    ctx_links: JSON.stringify(getLinks()),
    ctx_goals: document.getElementById('ctx-goals').value,
    ctx_tone: document.getElementById('ctx-tone').value,
    ctx_avoid: document.getElementById('ctx-avoid').value,
    ctx_relevant: document.getElementById('ctx-relevant').value,
    ctx_irrelevant: document.getElementById('ctx-irrelevant').value,
  };

  // Auto-add X handle to excluded accounts
  const handle = data.ctx_x_handle.replace(/^@/, '');
  if (handle) {
    const excl = document.getElementById('set-excluded-accounts').value;
    if (!excl.includes(handle)) {
      document.getElementById('set-excluded-accounts').value = excl ? excl + ', ' + handle : handle;
    }
  }

  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const el = document.getElementById('context-status');
  el.textContent = 'Saved';
  setTimeout(() => el.textContent = '', 2000);
}

// Settings
const KEY_FIELDS = ['x_client_id', 'x_client_secret', 'x_bearer_token', 'x_app_key', 'x_app_secret', 'x_access_token', 'x_access_secret', 'anthropic_api_key'];
const KEY_IDS = ['set-x-client-id', 'set-x-client-secret', 'set-x-bearer', 'set-x-app-key', 'set-x-app-secret', 'set-x-access-token', 'set-x-access-secret', 'set-anthropic-key'];

async function loadSettings() {
  const res = await fetch('/api/settings');
  const s = await res.json();
  document.getElementById('set-min-followers').value = s.min_followers || '250';
  document.getElementById('set-poll-interval').value = s.poll_interval || '30';
  document.getElementById('set-excluded-accounts').value = s.excluded_accounts || '';
  document.getElementById('set-excluded-terms').value = s.excluded_terms || '';
  document.getElementById('set-model').value = s.model || 'claude-sonnet-4-20250514';

  // OAuth2 status
  try {
    const authRes = await fetch('/api/auth/status');
    const authData = await authRes.json();
    const el = document.getElementById('oauth2-status');
    if (authData.oauth2) {
      el.innerHTML = '<span style="font-family:var(--font-mono);font-size:11px;color:var(--allow)">CONNECTED</span>';
    } else {
      el.innerHTML = '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim)">NOT CONNECTED</span>';
    }
  } catch {}

  // Show masked placeholder for existing keys
  KEY_FIELDS.forEach((key, i) => {
    const el = document.getElementById(KEY_IDS[i]);
    if (s[key]) {
      el.placeholder = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (saved)';
    }
  });
}

async function saveSettings() {
  const data = {
    min_followers: document.getElementById('set-min-followers').value,
    poll_interval: document.getElementById('set-poll-interval').value,
    excluded_accounts: document.getElementById('set-excluded-accounts').value,
    excluded_terms: document.getElementById('set-excluded-terms').value,
    model: document.getElementById('set-model').value,
  };

  // Only save keys that were actually entered (not blank)
  KEY_FIELDS.forEach((key, i) => {
    const val = document.getElementById(KEY_IDS[i]).value.trim();
    if (val) data[key] = val;
  });

  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const el = document.getElementById('settings-status');
  el.textContent = 'Saved. Restart to apply key changes.';
  setTimeout(() => el.textContent = '', 3000);
}

// Init
loadRules();
loadPosts();
loadWatchlist();
loadContext();
loadSettings();
</script>
</body>
</html>`;
