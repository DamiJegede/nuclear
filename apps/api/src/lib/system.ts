/**
 * The system account ("Nuclear") and its two system wallets have fixed ids, created by the schema migration, so nothing is ever looked up.
 * A system wallet is the other side of a transaction that crosses the edge of the scheme: the bank (loads, payouts, returns, collections)
 * and the Nuclear store (purchases). The money paths never update their balance rows; the nightly snapshot derives them.
 */
export const SYSTEM_ACCOUNT = "00000000-0000-7000-8000-000000000001";
export const BANK_WALLET = "00000000-0000-7000-8000-000000000002";
export const SHOP_WALLET = "00000000-0000-7000-8000-000000000003";
