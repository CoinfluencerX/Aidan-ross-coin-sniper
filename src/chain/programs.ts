/** Well-known Solana program and mint addresses. Kept apart from sdk.ts so importing them doesn't load the SDKs. */
export const PROGRAMS = {
  splToken: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  system: "11111111111111111111111111111111",
  pump: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  pumpAmm: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  metaplex: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  wsol: "So11111111111111111111111111111111111111112",
} as const;
