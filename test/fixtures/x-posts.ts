/**
 * Raw X API v2 payloads, shaped like what the two stream paths deliver.
 * Activity API: {data: {event_type: "post.create", payload: Tweet, includes}}
 * Filtered Stream: {data: Tweet, includes, matching_rules}
 * Mints are random 32-byte keys (no real token), except where noted.
 */

export const ADIN = "759660076214853632";
export const BANKS = "363811679";
export const TEST = "1000000000000000001";
export const STRANGER = "4444444444";

export const MINT = {
  plain: "6gaHBt2GVzj81inCZJJkNGSLjjphxM3VkJT5bFLRLbLC",
  pump: "En8Ltt7MV1nhqTnUFecEzo5Fxbqy8XspwvCHmx6yeHJy",
  dexPair: "9NgejEkx3cXSsKAb3RmF9RCpJqyfsGM8mYPrpSV27gGe",
  tco: "3ihvup3ETdydWeNYdpxm6yKAo5SdEMPA6ARBDNuFtcMc",
  replyOwn: "DFY8cBXUw8xAmtsja9Nxmq5pX9qyhzQfpWsTZReRVxdF",
  replyParent: "EJBDMo4f3QgNRj1JU9usPpV73pXerJNpJrmEyxwPoQR3",
  /** The one printed in test/fixtures/images/ca-screenshot.png (BONK's real mint). */
  image: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  /** accounts.yaml blocked_mints entry. */
  blocked: "Ce8nnx1XqLBEE6ChG44xEwcSsK6PS2uv4NX9B7bYpump",
};

const CREATED = "2026-11-19T17:00:00.000Z";

export const activityEvent = (payload: object, includes: object = {}, userId = (payload as { author_id: string }).author_id) => ({
  data: {
    event_uuid: "2080761390344937796",
    created_at: CREATED,
    filter: { user_id: userId },
    event_type: "post.create",
    tag: "gta6-sniper",
    payload,
    includes,
  },
});

export const streamMessage = (data: object, includes: object = {}) => ({
  data,
  includes,
  matching_rules: [{ id: "1", tag: "gta6-sniper" }],
});

/** 1. Plain address in the text. */
export const plainAddress = activityEvent({
  id: "1900000000000000001",
  author_id: ADIN,
  created_at: CREATED,
  text: `GTA 6 RP coin is live. CA: ${MINT.plain}`,
});

/** 2. pump.fun link (X already expanded the t.co). */
export const pumpFunUrl = streamMessage({
  id: "1900000000000000002",
  author_id: BANKS,
  created_at: CREATED,
  text: "we're live https://t.co/pUmPfUn123",
  entities: {
    urls: [{ url: "https://t.co/pUmPfUn123", expanded_url: `https://pump.fun/coin/${MINT.pump}`, display_url: "pump.fun/coin/En8L…" }],
  },
});

/** 3. dexscreener link: the path usually holds the PAIR address. */
export const dexscreenerUrl = streamMessage({
  id: "1900000000000000003",
  author_id: ADIN,
  created_at: CREATED,
  text: "chart https://t.co/dExScReEn1",
  entities: { urls: [{ url: "https://t.co/dExScReEn1", expanded_url: `https://dexscreener.com/solana/${MINT.dexPair}` }] },
});

/** 4. Bare t.co link X didn't expand: t.co → bit.ly → jup.ag. The test's fake fetch serves the redirects. */
export const tcoLink = activityEvent({
  id: "1900000000000000004",
  author_id: ADIN,
  created_at: CREATED,
  text: "buy here https://t.co/ShOrT0001",
  entities: { urls: [{ url: "https://t.co/ShOrT0001" }] },
});
export const TCO_REDIRECTS: Record<string, string> = {
  "https://t.co/ShOrT0001": "https://bit.ly/gta6coin",
  "https://bit.ly/gta6coin": `https://jup.ag/swap/SOL-${MINT.tco}`,
};

/** 5. Address only inside an attached screenshot. Media comes in includes. */
export const IMAGE_URL = "https://pbs.twimg.com/media/GTA6caShot.png";
export const imageAddress = streamMessage(
  {
    id: "1900000000000000005",
    author_id: ADIN,
    created_at: CREATED,
    text: "here it is 👇 https://t.co/pIcPiC0005",
    attachments: { media_keys: ["3_1900000000000000005"] },
    entities: { urls: [{ url: "https://t.co/pIcPiC0005", expanded_url: "https://x.com/adinross/status/1900000000000000005/photo/1", media_key: "3_1900000000000000005" }] },
  },
  { media: [{ media_key: "3_1900000000000000005", type: "photo", url: IMAGE_URL }] },
);

/** 6. "This is FAKE" warning that quotes the fake address. */
export const fakeWarning = activityEvent({
  id: "1900000000000000006",
  author_id: ADIN,
  created_at: CREATED,
  text: `⚠️ This is FAKE, not mine. Don’t buy ${MINT.blocked}`,
});

/** 7a. Adin replies to a stranger. The parent (in includes) carries a different address. */
export const replyWithDifferentAddress = streamMessage(
  {
    id: "1900000000000000007",
    author_id: ADIN,
    created_at: CREATED,
    text: `@randomguy no. the real one is ${MINT.replyOwn}`,
    in_reply_to_user_id: STRANGER,
    conversation_id: "1900000000000000000",
    referenced_tweets: [{ type: "replied_to", id: "1900000000000000000" }],
  },
  {
    tweets: [{ id: "1900000000000000000", author_id: STRANGER, text: `adin is this your coin? ${MINT.replyParent}` }],
    users: [{ id: ADIN, username: "adinross" }, { id: STRANGER, username: "randomguy" }],
  },
);

/** 7b. A stranger's reply under Adin's post with its own address. Must never become a signal. */
export const strangerReply = streamMessage(
  {
    id: "1900000000000000008",
    author_id: STRANGER,
    created_at: CREATED,
    text: `@adinross real CA here ${MINT.replyParent}`,
    in_reply_to_user_id: ADIN,
    referenced_tweets: [{ type: "replied_to", id: "1900000000000000001" }],
  },
);

/** Quote post: Adin quotes a stranger whose post has an address; Adin's own text has none. */
export const quoteOfStranger = streamMessage(
  {
    id: "1900000000000000009",
    author_id: ADIN,
    created_at: CREATED,
    text: "lmao no",
    referenced_tweets: [{ type: "quoted", id: "1900000000000000010" }],
  },
  { tweets: [{ id: "1900000000000000010", author_id: STRANGER, text: `CA ${MINT.replyParent}` }] },
);

/** The owner's test account posting a plain address. */
export const testAccountPost = activityEvent({
  id: "1900000000000000011",
  author_id: TEST,
  created_at: CREATED,
  text: `dry run test ${MINT.plain}`,
});
