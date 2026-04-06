import { TwitterApi } from "twitter-api-v2";
import {
  insertPost, updateClassification, getRules, setStatus,
  getRecentEngagement, hasFollowed, getWatchlist, getSettingValue,
} from "./db.js";
import { classify } from "./classifier.js";

let bearerClient: TwitterApi;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let lastSeenId: string | undefined;
let lastWatchlistSeenIds: Record<string, string> = {};
let watchlistUserIds: Record<string, string> = {};

function splitCSV(s: string): string[] {
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

function buildQuery(): string | null {
  const rules = getRules.all() as { id: number; keyword: string }[];
  if (rules.length === 0) return null;

  const parts = rules.map((r) => `(${r.keyword})`);
  let query = `(${parts.join(" OR ")}) lang:en -is:retweet -is:reply`;

  const excludedTerms = getSettingValue("excluded_terms", "");
  if (excludedTerms) {
    for (const term of splitCSV(excludedTerms)) query += ` -${term}`;
  }

  const excluded = getSettingValue("excluded_accounts", "");
  if (excluded) {
    for (const acc of splitCSV(excluded)) query += ` -from:${acc}`;
  }

  return query;
}

async function fetchThreadContext(tweetId: string): Promise<string | null> {
  try {
    const tweet = await bearerClient.v2.singleTweet(tweetId, {
      "tweet.fields": ["referenced_tweets", "text", "author_id"],
      expansions: ["referenced_tweets.id", "referenced_tweets.id.author_id"],
      "user.fields": ["username"],
    });

    const parent = tweet.data?.referenced_tweets?.find((r) => r.type === "replied_to");
    if (!parent) return null;

    const parentTweet = tweet.includes?.tweets?.find((t) => t.id === parent.id);
    const parentAuthor = tweet.includes?.users?.find((u) => u.id === parentTweet?.author_id);

    if (parentTweet) {
      return `@${parentAuthor?.username ?? "unknown"}: ${parentTweet.text}`;
    }
    return null;
  } catch {
    return null;
  }
}

async function processTweet(tweet: any, author: any) {
  if (!tweet || !author) return;

  const minFollowers = parseInt(getSettingValue("min_followers", "250"));
  if ((author.public_metrics?.followers_count ?? 0) < minFollowers) return;

  // Author bio comes from the search expansion (description field)
  const authorBio = author.description ?? null;

  // Fetch thread context only if this is a reply
  const threadContext = tweet.referenced_tweets?.length
    ? await fetchThreadContext(tweet.id)
    : null;

  const postData = {
    id: tweet.id,
    author_id: tweet.author_id ?? author.id,
    author_username: author.username,
    author_name: author.name,
    author_followers: author.public_metrics?.followers_count ?? 0,
    text: tweet.text,
    created_at: tweet.created_at ?? new Date().toISOString(),
    author_bio: authorBio,
    thread_context: threadContext,
    reply_settings: tweet.reply_settings ?? "everyone",
  };

  const result = insertPost.run(postData);
  if (result.changes === 0) return;

  console.log(`[poll] @${author.username}: ${tweet.text.slice(0, 80)}...`);

  const recentReply = getRecentEngagement.get({ author_id: postData.author_id, action: "reply" });
  const alreadyFollowed = hasFollowed.get({ author_id: postData.author_id });

  try {
    const classification = await classify({
      text: tweet.text,
      author_username: author.username,
      author_name: author.name,
      author_followers: postData.author_followers,
      author_bio: authorBio ?? undefined,
      thread_context: threadContext ?? undefined,
      already_engaged: !!recentReply,
    });

    if (!classification.relevant) {
      setStatus.run({ id: tweet.id, status: "skipped" });
      console.log(`[classify] SKIP @${author.username}: ${classification.relevant_reason}`);
      return;
    }

    updateClassification.run({
      id: tweet.id,
      quality: classification.quality,
      draft_reply: classification.reply,
      should_follow: (classification.should_follow && !alreadyFollowed) ? 1 : 0,
      suggest_quote: classification.suggest_quote ? 1 : 0,
    });

    console.log(
      `[classify] ${classification.quality}${classification.suggest_quote ? " [QUOTE]" : ""} | follow: ${classification.should_follow && !alreadyFollowed} | reply: ${(classification.reply ?? "—").slice(0, 60)}`
    );
  } catch (err: any) {
    setStatus.run({ id: tweet.id, status: "skipped" });
    console.error(`[classify] Error classifying ${tweet.id}:`, err.message || err);
  }
}

const TWEET_FIELDS = ["created_at", "author_id", "text", "referenced_tweets", "reply_settings"] as const;
const USER_FIELDS = ["username", "name", "public_metrics", "description"] as const;

async function poll() {
  const query = buildQuery();
  if (!query) return;

  try {
    const isFirstRun = !lastSeenId;
    const paginator = await bearerClient.v2.search(query, {
      max_results: isFirstRun ? 10 : 100,
      ...(lastSeenId ? { since_id: lastSeenId } : {}),
      "tweet.fields": [...TWEET_FIELDS],
      "user.fields": [...USER_FIELDS],
      expansions: ["author_id"],
    });

    const allTweets = paginator.data?.data ?? [];
    const allUsers = paginator.data?.includes?.users ?? [];

    if (!isFirstRun) {
      let pages = 0;
      while (!paginator.done && pages < 10) {
        await paginator.fetchNext();
        if (paginator.data?.data) allTweets.push(...paginator.data.data);
        if (paginator.data?.includes?.users) allUsers.push(...paginator.data.includes.users);
        pages++;
      }
    }

    if (!allTweets.length) return;

    lastSeenId = allTweets[0].id;

    for (const tweet of allTweets) {
      const author = allUsers.find((u) => u.id === tweet.author_id);
      await processTweet(tweet, author);
    }
  } catch (err: any) {
    console.error("[poll] Error:", err.data || err.message);
  }
}

async function pollWatchlist() {
  const accounts = getWatchlist.all() as { id: number; username: string }[];
  if (!accounts.length) return;

  for (const account of accounts) {
    try {
      // Cache username -> ID resolution
      if (!watchlistUserIds[account.username]) {
        const user = await bearerClient.v2.userByUsername(account.username, {
          "user.fields": ["id"],
        });
        if (!user.data) continue;
        watchlistUserIds[account.username] = user.data.id;
      }

      const userId = watchlistUserIds[account.username];

      const timeline = await bearerClient.v2.userTimeline(userId, {
        max_results: 5,
        ...(lastWatchlistSeenIds[account.username] ? { since_id: lastWatchlistSeenIds[account.username] } : {}),
        "tweet.fields": [...TWEET_FIELDS],
        "user.fields": [...USER_FIELDS],
        expansions: ["author_id"],
        exclude: ["retweets", "replies"],
      });

      const tweets = timeline.data?.data;
      const users = timeline.data?.includes?.users;
      if (!tweets?.length) continue;

      lastWatchlistSeenIds[account.username] = tweets[0].id;

      for (const tweet of tweets) {
        const author = users?.find((u) => u.id === tweet.author_id) ?? {
          id: userId,
          username: account.username,
          name: account.username,
          public_metrics: { followers_count: 10000 },
        };
        await processTweet(tweet, author);
      }
    } catch (err: any) {
      console.error(`[watchlist] Error polling @${account.username}:`, err.data || err.message);
    }
  }
}

export async function startStream(bearerToken: string) {
  bearerClient = new TwitterApi(bearerToken);

  const query = buildQuery();
  if (!query) {
    console.log("[poll] No rules — waiting for keywords to be added via UI");
  } else {
    console.log(`[poll] Query: ${query}`);
  }

  await poll();
  await pollWatchlist();

  const interval = parseInt(getSettingValue("poll_interval", "30"));
  pollInterval = setInterval(async () => {
    await poll();
    await pollWatchlist();
  }, interval * 1000);
  console.log(`[poll] Polling every ${interval}s`);
}

export function restartStream() {
  const query = buildQuery();
  if (query) {
    console.log(`[poll] Rules updated, query: ${query}`);
  } else {
    console.log("[poll] All rules removed");
  }
  lastSeenId = undefined;
  poll();
}
