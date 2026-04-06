import "dotenv/config";
import * as readline from "readline";
import { getPending, setStatus, getStats } from "./db.js";
import { getKeys } from "./keys.js";
import { createActionsClient, postReply, followUser } from "./actions.js";

const keys = getKeys();
const client = createActionsClient({
  appKey: keys.appKey,
  appSecret: keys.appSecret,
  accessToken: keys.accessToken,
  accessSecret: keys.accessSecret,
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

async function main() {
  // Get our user ID for follow actions
  const me = await client.v2.me();
  const myUserId = me.data.id;

  const posts = getPending.all() as any[];

  if (posts.length === 0) {
    console.log("\nNo pending posts to review.");
    const stats = getStats.all() as any[];
    console.log("\nStats:");
    stats.forEach((s: any) => console.log(`  ${s.status}: ${s.count}`));
    rl.close();
    return;
  }

  console.log(`\n${posts.length} posts to review\n`);

  for (const post of posts) {
    console.log("─".repeat(60));
    console.log(
      `@${post.author_username} (${post.author_name}) · ${post.author_followers} followers`
    );
    console.log(`Quality: ${post.quality} | Follow recommended: ${post.should_follow ? "yes" : "no"}`);
    console.log(`\n${post.text}\n`);
    console.log(`Draft reply: ${post.draft_reply}\n`);
    console.log(`https://x.com/${post.author_username}/status/${post.id}`);
    console.log("");

    const action = await ask(
      "[a]pprove  [e]dit  [s]kip  [q]uit → "
    );

    switch (action.trim().toLowerCase()) {
      case "a": {
        await postReply(client, post.id, post.draft_reply, post.author_id);
        if (post.should_follow) {
          const doFollow = await ask("Follow this user? [y/n] → ");
          if (doFollow.trim().toLowerCase() === "y") {
            await followUser(client, myUserId, post.author_id, post.id);
          }
        }
        break;
      }
      case "e": {
        const edited = await ask("Your reply: ");
        if (edited.trim()) {
          await postReply(client, post.id, edited.trim(), post.author_id);
          if (post.should_follow) {
            const doFollow = await ask("Follow this user? [y/n] → ");
            if (doFollow.trim().toLowerCase() === "y") {
              await followUser(client, myUserId, post.author_id, post.id);
            }
          }
        }
        break;
      }
      case "s": {
        setStatus.run({ id: post.id, status: "skipped" });
        console.log("Skipped.\n");
        break;
      }
      case "q": {
        console.log("Done.");
        rl.close();
        return;
      }
      default: {
        console.log("Skipping (unrecognised input).\n");
        setStatus.run({ id: post.id, status: "skipped" });
      }
    }
  }

  console.log("\nAll caught up!");
  const stats = getStats.all() as any[];
  console.log("\nStats:");
  stats.forEach((s: any) => console.log(`  ${s.status}: ${s.count}`));
  rl.close();
}

main().catch(console.error);
