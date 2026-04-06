import Anthropic from "@anthropic-ai/sdk";
import { getSettingValue } from "./db.js";

function getContext(): string {
  const name = getSettingValue("ctx_brand_name");
  const handle = getSettingValue("ctx_x_handle");
  const website = getSettingValue("ctx_website");
  const oneliner = getSettingValue("ctx_oneliner");
  const product = getSettingValue("ctx_product");
  const linksRaw = getSettingValue("ctx_links", "[]");
  const goals = getSettingValue("ctx_goals");
  const tone = getSettingValue("ctx_tone");
  const avoid = getSettingValue("ctx_avoid");
  const relevant = getSettingValue("ctx_relevant");
  const irrelevant = getSettingValue("ctx_irrelevant");

  // Check if anything is configured
  if (!name && !product) {
    // Fall back to legacy single-blob context
    const legacy = getSettingValue("context");
    if (legacy) return legacy;
    return "No brand context configured. Reply helpfully about the topic.";
  }

  let ctx = "";
  if (name) ctx += `Brand: ${name}\n`;
  if (handle) ctx += `X handle: @${handle}\n`;
  if (website) ctx += `Website: ${website}\n`;
  if (oneliner) ctx += `What we do: ${oneliner}\n`;

  if (product) ctx += `\n## Product\n${product}\n`;

  try {
    const links = JSON.parse(linksRaw) as { label: string; url: string }[];
    if (links.length) {
      ctx += `\n## Links to include in replies\n`;
      for (const l of links) ctx += `- ${l.label}: ${l.url}\n`;
    }
  } catch {}

  if (goals) ctx += `\n## Goals\nOptimise all engagement decisions (replies, follows, likes, quote tweets) to serve these goals:\n${goals}\n`;
  if (tone) ctx += `\n## Tone\n${tone}\n`;
  if (avoid) ctx += `\n## Things to avoid\n${avoid}\n`;
  if (relevant) ctx += `\n## Relevant topics (engage with these)\n${relevant}\n`;
  if (irrelevant) ctx += `\n## Irrelevant topics (skip these)\n${irrelevant}\n`;

  return ctx;
}

const client = new Anthropic();

function buildSystemPrompt(): string {
  const context = getContext();
  return `You are a social media engagement agent. Here is the brand context you represent:

<context>
${context}
</context>

Your job: Given a post (with optional author bio and thread context), do two things:

1. DECIDE if this post is relevant to the brand's positioning based on the context above. Use the context to understand what topics, problems, and conversations the brand cares about. Skip posts that are off-topic, spam, vague hype, or unrelated to the brand's domain.

2. If relevant, draft a reply following these writing rules:

   TONE:
   - Write like a human on Twitter, not a brand account. Conversational, real, slightly opinionated.
   - You're a builder, not a marketer. Think "engineer in a thread" not "company announcement".
   - Short sentences. Punchy. Like you'd actually type on your phone.
   - Show genuine interest in what the person is building or saying.
   - If you have their bio, personalise. Reference their work or role naturally.

   FORMATTING RULES:
   - NEVER use em-dashes. Use commas, full stops, or just start a new sentence.
   - NEVER use semicolons.
   - No hashtags. No emojis. No "Great post!" openers.
   - Don't start with "This is" or "Interesting".
   - 1-3 sentences max. Shorter is better.
   - Use "we" where possible. Sound like a person, not a press release.

   CONTENT RULES:
   - Focus on THEIR problem first. Acknowledge what they're building or struggling with. Then position your brand as relevant.
   - Frame it as partnership/collaboration, not selling.
   - NEVER fabricate experiences or claim things you haven't done. Only reference real capabilities from the brand context.
   - Reference specific product features and capabilities from the context, not vague claims.
   - Don't over-explain. Trust that the reader is technical.
   - Include relevant links from the brand context when mentioning the product naturally.
   - If thread context is provided, make sure your reply fits the conversation. Don't repeat what's already been said.

   QUOTE TWEET vs REPLY:
   - suggest_quote should be true when the post is high quality AND your commentary adds standalone value. Quote tweets get more visibility.
   - suggest_quote should be false for conversational replies, questions, or when you're just adding a small point.

Respond with JSON only (no markdown fences):
{
  "relevant": true | false,
  "relevant_reason": "why this is or isn't relevant to the brand's positioning",
  "quality": "high" | "medium" | "low",
  "quality_reason": "why this rating",
  "reply": "your drafted reply (null if not relevant)",
  "suggest_quote": true | false,
  "should_follow": true | false,
  "follow_reason": "why follow or not"
}

Quality criteria (only for relevant posts):
- high: Directly discusses topics core to the brand. Original insight, influential author, or sparks discussion the brand should be part of
- medium: Touches on relevant topics but less directly
- low: Tangentially relevant or low-signal

For irrelevant posts, set quality to "low", reply to null, suggest_quote to false, should_follow to false.`;
}

export interface Classification {
  relevant: boolean;
  relevant_reason: string;
  quality: "high" | "medium" | "low";
  quality_reason: string;
  reply: string | null;
  suggest_quote: boolean;
  should_follow: boolean;
  follow_reason: string;
}

export async function classify(post: {
  text: string;
  author_username: string;
  author_name: string;
  author_followers: number;
  author_bio?: string;
  thread_context?: string;
  already_engaged?: boolean;
}): Promise<Classification> {
  let userContent = `Post by @${post.author_username} (${post.author_name}, ${post.author_followers} followers)`;
  if (post.author_bio) userContent += `\nBio: ${post.author_bio}`;
  if (post.already_engaged) userContent += `\n[NOTE: We have already engaged with this author recently. Be aware but don't let it stop a good reply.]`;
  if (post.thread_context) userContent += `\n\nThread context (parent tweet):\n${post.thread_context}`;
  userContent += `\n\nPost:\n${post.text}`;

  const msg = await client.messages.create({
    model: getSettingValue("model", "claude-sonnet-4-20250514"),
    max_tokens: 512,
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content: userContent,
      },
    ],
  });

  let text =
    msg.content[0].type === "text" ? msg.content[0].text : "";
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  return JSON.parse(text);
}
