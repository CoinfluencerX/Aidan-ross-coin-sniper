import type { PostContent } from "../../extract/extract.ts";

/** The subset of the X API v2 Post object we read. Everything optional: payloads vary by path. */
export interface XTweet {
  id: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  in_reply_to_tweet_id?: string;
  referenced_tweets?: { type: "replied_to" | "quoted" | "retweeted"; id: string }[];
  entities?: { urls?: XUrlEntity[] };
  attachments?: { media_keys?: string[] };
  note_tweet?: { text?: string; entities?: { urls?: XUrlEntity[] } };
}

export interface XUrlEntity {
  url: string;
  expanded_url?: string;
  unwound_url?: string;
  media_key?: string;
}

export interface XMedia {
  media_key: string;
  type?: string;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
}

export interface XIncludes {
  media?: XMedia[];
  users?: { id: string; username?: string }[];
  tweets?: XTweet[];
}

export type PostKind = "original" | "reply" | "quote" | "repost";

export interface XPost {
  id: string;
  authorId: string;
  authorUsername: string | undefined;
  createdAt: string | undefined;
  kind: PostKind;
  /** Other posts this one points at, with their authors when X included them. Never mined for addresses. */
  referenced: { type: string; id: string; authorId: string | undefined }[];
  inReplyToUserId: string | undefined;
  content: PostContent;
  /** The post has media keys that `includes.media` didn't resolve, so a lookup could add images. */
  mediaMissing: boolean;
}

export function postKind(t: XTweet): PostKind {
  const types = new Set((t.referenced_tweets ?? []).map((r) => r.type));
  if (types.has("retweeted")) return "repost";
  if (types.has("replied_to") || t.in_reply_to_tweet_id) return "reply";
  if (types.has("quoted")) return "quote";
  return "original";
}

/**
 * Builds our post from a Tweet + includes. Only the tweet's own text, URL entities and
 * attached media go into `content`. `includes.tweets` (parents, quoted posts) are only
 * used to record who the referenced author is.
 */
export function normalizeTweet(t: XTweet, includes: XIncludes = {}): XPost | null {
  if (!t.id || !t.author_id) return null;
  // Long posts: the full text and its entities live in note_tweet.
  const text = t.note_tweet?.text ?? t.text ?? "";
  const urlEntities = [...(t.entities?.urls ?? []), ...(t.note_tweet?.entities?.urls ?? [])];

  const mediaByKey = new Map((includes.media ?? []).map((m) => [m.media_key, m]));
  const keys = t.attachments?.media_keys ?? [];
  const images: PostContent["images"] = [];
  let mediaMissing = false;
  for (const key of keys) {
    const m = mediaByKey.get(key);
    if (!m) {
      mediaMissing = true;
      continue;
    }
    const url = m.type === "photo" ? m.url : (m.preview_image_url ?? m.url);
    if (url) images.push({ url, altText: m.alt_text });
  }

  const seen = new Set<string>();
  const urls: PostContent["urls"] = [];
  for (const u of urlEntities) {
    if (u.media_key || seen.has(u.url)) continue; // pic.x.com links point at the media we already handle
    seen.add(u.url);
    urls.push({ url: u.url, expandedUrl: u.expanded_url, unwoundUrl: u.unwound_url });
  }

  const tweetsById = new Map((includes.tweets ?? []).map((x) => [x.id, x]));
  const username = includes.users?.find((u) => u.id === t.author_id)?.username;

  return {
    id: t.id,
    authorId: t.author_id,
    authorUsername: username,
    createdAt: t.created_at,
    kind: postKind(t),
    referenced: (t.referenced_tweets ?? []).map((r) => ({ type: r.type, id: r.id, authorId: tweetsById.get(r.id)?.author_id })),
    inReplyToUserId: t.in_reply_to_user_id,
    content: { text, urls, images },
    mediaMissing,
  };
}

/** Filtered Stream line: {data: Tweet, includes, matching_rules}. */
export function fromFilteredStream(msg: unknown): XPost | null {
  const m = msg as { data?: XTweet; includes?: XIncludes };
  return m?.data ? normalizeTweet(m.data, m.includes) : null;
}

/** Activity API line: {data: {event_type, payload: Tweet, includes, filter}}. Only post.create is a post. */
export function fromActivityEvent(msg: unknown): { post: XPost | null; eventType: string | undefined; filterUserId: string | undefined } {
  const d = (msg as { data?: { event_type?: string; payload?: XTweet; includes?: XIncludes; filter?: { user_id?: string } } })?.data;
  const eventType = d?.event_type;
  const filterUserId = d?.filter?.user_id;
  if (eventType !== "post.create" || !d?.payload) return { post: null, eventType, filterUserId };
  return { post: normalizeTweet(d.payload, d.includes), eventType, filterUserId };
}
