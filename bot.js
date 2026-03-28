import { TwitterApi } from "twitter-api-v2";
import dotenv from "dotenv";

dotenv.config();

// ── Twitter client (OAuth 1.0a – needed for posting tweets) ──────────────────
const client = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

const rwClient = client.readWrite;

// ── State ────────────────────────────────────────────────────────────────────
let lastMentionId = process.env.SINCE_ID || null; // persist across restarts via .env

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the topic from a mention tweet.
 * e.g. "@echochamber_bot what do you think about iran vs usa?"
 * → "what do you think about iran vs usa?"
 */
function extractTopic(text) {
  // Strip all @mentions from the front of the text
  const cleaned = text.replace(/^(@\w+\s*)+/i, "").trim();
  return cleaned || "a hot-button topic";
}

/**
 * Simulate generating a workflow/video link.
 * In production this will call your n8n webhook or Veo pipeline.
 */
function generateWorkflowLink(topic) {
  // TODO: replace with real n8n webhook trigger + Veo video generation
  const encoded = encodeURIComponent(topic.slice(0, 60));
  return `https://echochamber.app/debate?topic=${encoded}`;
}

/**
 * Build the reply text.
 */
function buildReply(authorUsername, topic, link) {
  return (
    `@${authorUsername} 🎬 Two AI agents are about to go head-to-head on:\n` +
    `"${topic.slice(0, 80)}"\n\n` +
    `Watch the debate 👇\n${link}`
  );
}

// ── Core polling loop ────────────────────────────────────────────────────────
async function pollMentions() {
  try {
    console.log(`[${new Date().toISOString()}] Polling for mentions…`);

    const me = await rwClient.v2.me();
    const params = {
      max_results: 10,
      "tweet.fields": ["author_id", "text", "conversation_id"],
      expansions: ["author_id"],
      "user.fields": ["username"],
    };

    if (lastMentionId) params.since_id = lastMentionId;

    const mentions = await rwClient.v2.userMentionTimeline(me.data.id, params);

    if (!mentions.data?.data?.length) {
      console.log("  No new mentions.");
      return;
    }

    // Build a userId → username lookup
    const userMap = {};
    for (const u of mentions.data?.includes?.users ?? []) {
      userMap[u.id] = u.username;
    }

    // Process newest-first so lastMentionId ends up as the highest id
    const tweets = [...mentions.data.data].reverse();

    for (const tweet of tweets) {
      const authorUsername = userMap[tweet.author_id] ?? tweet.author_id;
      const topic = extractTopic(tweet.text);
      const link = generateWorkflowLink(topic);
      const reply = buildReply(authorUsername, topic, link);

      console.log(`  ↳ Replying to @${authorUsername}: ${reply}`);

      await rwClient.v2.reply(reply, tweet.id);

      // Track highest id seen
      if (!lastMentionId || BigInt(tweet.id) > BigInt(lastMentionId)) {
        lastMentionId = tweet.id;
      }
    }

    console.log(`  ✅ Processed ${tweets.length} mention(s). Last id: ${lastMentionId}`);
  } catch (err) {
    // Rate-limit: back off gracefully
    if (err?.code === 429) {
      console.warn("  ⚠️  Rate limited – will retry next cycle.");
    } else {
      console.error("  ❌ Error:", err?.message ?? err);
    }
  }
}

// ── Start ────────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 60 * 1000; // poll every 60 s (safe for Basic tier)

console.log("🤖 EchoChamber bot starting…");
pollMentions(); // run immediately on start
setInterval(pollMentions, POLL_INTERVAL_MS);
