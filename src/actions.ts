import { TwitterApi } from "twitter-api-v2";
import { setReplied, setFollowed, setLiked, setError, logEngagement } from "./db.js";

export function createActionsClient(credentials: {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}) {
  return new TwitterApi(credentials);
}

export async function postReply(
  client: TwitterApi,
  postId: string,
  replyText: string,
  authorId: string
): Promise<{ ok: boolean; error?: string; fallback?: string }> {
  try {
    await client.v2.tweet({
      text: replyText,
      reply: { in_reply_to_tweet_id: postId },
    });
    setReplied.run({ id: postId });
    logEngagement.run({ author_id: authorId, action: "reply", post_id: postId });
    console.log(`[action] Replied to ${postId}`);
    return { ok: true };
  } catch (err: any) {
    const msg = err.data?.detail || err.message;
    // If reply is blocked, suggest quote tweet as fallback
    if (err.code === 403 && msg.includes("not allowed")) {
      console.log(`[action] Reply blocked for ${postId}, suggesting quote tweet`);
      return { ok: false, error: "Reply restricted by author. Use Quote instead.", fallback: "quote" };
    }
    setError.run({ id: postId, error: msg });
    console.error(`[action] Failed to reply to ${postId}:`, msg);
    return { ok: false, error: msg };
  }
}

export async function postQuote(
  client: TwitterApi,
  postId: string,
  quoteText: string,
  authorUsername: string,
  authorId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.v2.tweet({
      text: quoteText,
      quote_tweet_id: postId,
    });
    setReplied.run({ id: postId });
    logEngagement.run({ author_id: authorId, action: "quote", post_id: postId });
    console.log(`[action] Quoted ${postId}`);
    return { ok: true };
  } catch (err: any) {
    const msg = err.data?.detail || err.message;
    setError.run({ id: postId, error: msg });
    console.error(`[action] Failed to quote ${postId}:`, msg);
    return { ok: false, error: msg };
  }
}

export async function likePost(
  client: TwitterApi,
  myUserId: string,
  postId: string,
  authorId: string
) {
  try {
    await client.v2.like(myUserId, postId);
    setLiked.run({ id: postId });
    logEngagement.run({ author_id: authorId, action: "like", post_id: postId });
    console.log(`[action] Liked ${postId}`);
  } catch (err: any) {
    console.error(`[action] Failed to like ${postId}:`, err.message);
  }
}

export async function followUser(
  client: TwitterApi,
  myUserId: string,
  targetUserId: string,
  postId: string
) {
  try {
    await client.v2.follow(myUserId, targetUserId);
    setFollowed.run({ id: postId });
    logEngagement.run({ author_id: targetUserId, action: "follow", post_id: postId });
    console.log(`[action] Followed user ${targetUserId}`);
  } catch (err: any) {
    console.error(
      `[action] Failed to follow ${targetUserId}:`,
      err.message
    );
  }
}
