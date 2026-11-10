import type { AccountsConfig, ValidatorConfig } from "../config/schemas.ts";
import type { ChainPresence } from "../evm/locate.ts";
import type { FetchFn } from "../extract/expand.ts";
import { extractFromPost, type PostContent } from "../extract/extract.ts";
import type { OcrEngine } from "../extract/ocr.ts";
import type { Logger } from "../log/logger.ts";
import { audit } from "../state/audit.ts";
import type { Db } from "../state/db.ts";
import {
  assessEvm,
  assessSignal,
  buildEvmSightings,
  buildSignals,
  recordSignal,
  type AddressSignal,
  type Assessment,
  type EvmSighting,
  type Source,
  type WatchedAccount,
} from "./signal.ts";
import type { PostKind } from "./x/normalize.ts";

/**
 * One post from an allowlisted account, already matched by numeric ID by the watcher that
 * received it. Every source (X, Kick, Twitch) is reduced to this before extraction.
 */
export interface SourcePost {
  source: Source;
  path: string;
  id: string;
  url: string;
  account: WatchedAccount;
  kind: PostKind;
  referencesWatchedAuthor: boolean;
  createdAt: string | undefined;
  /** The post's OWN text, links and images. Never a parent, quoted post or someone else's chat line. */
  content: PostContent;
}

export interface PipelineDeps {
  accounts: AccountsConfig;
  validator: ValidatorConfig;
  db: Db;
  log: Logger;
  ocr?: OcrEngine | undefined;
  fetch?: FetchFn | undefined;
  /** A Solana address signal, written to the DB. `signalId` is its row id. */
  onSignal: (s: AddressSignal, a: Assessment, signalId: number) => void;
  /** An Ethereum-style address. Alert only. Omit to just log it. */
  onEvm?: ((s: EvmSighting, a: Assessment) => void) | undefined;
  /** Looks up which chain a 0x address is on. Omit to skip the lookup. */
  locateEvm?: ((address: string) => Promise<ChainPresence[]>) | undefined;
}

export interface PipelineResult {
  signals: AddressSignal[];
  newSignals: number;
  evm: EvmSighting[];
}

/** Extraction → log → audit → signals. Shared by every watcher so the rules can't drift between sources. */
export async function processPost(post: SourcePost, receivedAt: number, deps: PipelineDeps): Promise<PipelineResult> {
  const { log, db, accounts } = deps;
  const extraction = await extractFromPost(post.content, {
    warningKeywords: deps.validator.params.warning_keywords,
    ocr: deps.ocr,
    fetch: deps.fetch,
  });

  log.info(`${post.source}.post`, {
    path: post.path,
    post_id: post.id,
    url: post.url,
    handle: post.account.handle,
    test_account: post.account.isTest,
    kind: post.kind,
    text: post.content.text,
    links: post.content.urls.length,
    images: post.content.images.length,
    mints: extraction.mints.map((m) => m.mint),
    evm: extraction.evm.map((e) => e.address),
    ignored: extraction.ignored,
    warning_keywords: extraction.warning.keywords,
    ocr: extraction.ocr,
    lag_ms: post.createdAt ? receivedAt - Date.parse(post.createdAt) : null,
  });
  audit(db, log.redactor, `${post.source}.post`, { path: post.path, post_id: post.id, account: post.account, kind: post.kind, extraction });

  const base = {
    source: post.source,
    path: post.path,
    postId: post.id,
    postUrl: post.url,
    accountId: post.account.userId,
    account: post.account,
    postKind: post.kind,
    referencesWatchedAuthor: post.referencesWatchedAuthor,
    warningKeywords: extraction.warning.keywords,
    postCreatedAt: post.createdAt,
    receivedAt,
  };

  const signals = buildSignals({ ...base, postText: post.content.text }, extraction.mints, accounts);
  let newSignals = 0;
  for (const s of signals) {
    const signalId = recordSignal(db, log.redactor, s);
    if (signalId === null) continue;
    newSignals++;
    const a = assessSignal(s);
    log.info("signal", { mint: s.mint, source: s.source, post_id: s.postId, handle: post.account.handle, severity: a.severity, reasons: a.reasons, origins: s.origins });
    deps.onSignal(s, a, signalId);
  }

  // Ethereum-style addresses: alert only. They never become signals, so nothing downstream can buy them.
  let evm: EvmSighting[] = [];
  if (extraction.evm.length > 0) {
    const located = new Map<string, ChainPresence[]>();
    if (deps.locateEvm) {
      const locate = deps.locateEvm;
      await Promise.all(
        extraction.evm.map(async (e) => {
          try {
            located.set(e.address, await locate(e.address));
          } catch {
            located.set(e.address, []);
          }
        }),
      );
    }
    evm = buildEvmSightings(base, extraction.evm, (address) => located.get(address) ?? []);
    for (const s of evm) {
      const a = assessEvm(s);
      log.info("evm.address", { address: s.address, source: s.source, post_id: s.postId, handle: post.account.handle, severity: a.severity, reasons: a.reasons, chains: s.chains, note: "alert only: never bought" });
      audit(db, log.redactor, "evm.address", { sighting: s, assessment: a });
      deps.onEvm?.(s, a);
    }
  }

  return { signals, newSignals, evm };
}
