-- A returned bank load (docs/BALANCE-POLICY.md, item 4): the `fund_return` transaction runs from the account's wallet to Nuclear Bank and reverses what
-- the original `fund` did: the funded-balance part is taken back (amount - credit_amount) and the credit principal the load had repaid is drawn
-- again (credit_amount). So a fund_return carries credit_amount like its fund, and its effect on the account is the mirror image of the fund's.
ALTER TABLE public.transactions DROP CONSTRAINT transactions_credit_types;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_credit_types CHECK (credit_amount = 0 OR type IN ('pay', 'fund', 'refund', 'fund_return'));

CREATE OR REPLACE VIEW public.account_effects AS
SELECT t.id AS tx_id, t.created_at, fw.account_id, t.from_wallet_id AS wallet_id,
       CASE t.type WHEN 'send' THEN -t.amount WHEN 'pay' THEN -(t.amount - t.credit_amount) WHEN 'refund' THEN -t.amount
                   WHEN 'purchase' THEN -t.amount WHEN 'claim' THEN -t.amount WHEN 'settle' THEN -t.amount
                   WHEN 'fund_return' THEN -(t.amount - t.credit_amount) WHEN 'adjustment' THEN -t.amount ELSE 0 END AS delta,
       CASE t.type WHEN 'pay' THEN t.credit_amount WHEN 'fund_return' THEN t.credit_amount ELSE 0 END AS credit_delta,
       CASE WHEN fw.type IN ('benefits', 'escrow') THEN
         CASE t.type WHEN 'pay' THEN -(t.amount - t.credit_amount) WHEN 'purchase' THEN -t.amount WHEN 'claim' THEN -t.amount
                     WHEN 'move' THEN -t.amount WHEN 'send' THEN -t.amount ELSE 0 END
       ELSE 0 END AS wdelta
  FROM public.transactions t JOIN public.wallets fw ON fw.id = t.from_wallet_id
 WHERE t.status = 'completed' AND fw.type <> 'system'
UNION ALL
SELECT t.id, t.created_at, tw.account_id, t.to_wallet_id,
       CASE t.type WHEN 'fund' THEN t.amount - t.credit_amount WHEN 'send' THEN t.amount WHEN 'pay' THEN t.amount
                   WHEN 'refund' THEN t.amount - t.credit_amount WHEN 'claim' THEN t.amount WHEN 'settle_return' THEN t.amount
                   WHEN 'collect' THEN t.amount WHEN 'adjustment' THEN t.amount ELSE 0 END,
       CASE t.type WHEN 'fund' THEN -t.credit_amount WHEN 'refund' THEN -t.credit_amount ELSE 0 END,
       CASE WHEN tw.type IN ('benefits', 'escrow') THEN
         CASE t.type WHEN 'send' THEN t.amount WHEN 'refund' THEN t.amount - t.credit_amount WHEN 'claim' THEN t.amount
                     WHEN 'allocate' THEN t.amount WHEN 'move' THEN t.amount ELSE 0 END
       ELSE 0 END
  FROM public.transactions t JOIN public.wallets tw ON tw.id = t.to_wallet_id
 WHERE t.status = 'completed' AND tw.type <> 'system';
