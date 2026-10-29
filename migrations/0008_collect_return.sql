-- A collection the bank returns AFTER it arrived (an ACH return can come days later): the `collect` credited the merchant, so the return takes the
-- money back and the debt stands again. `collect_return` runs from the merchant's wallet to Nuclear Bank, relates to its `collect` and belongs to the
-- same settlement row; its effect on the merchant is `- amount`, the mirror image of the collect (account_effects below).
ALTER TABLE public.transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('fund', 'fund_return', 'send', 'pay', 'refund', 'purchase', 'allocate', 'claim', 'move', 'settle', 'settle_return', 'collect', 'collect_return', 'adjustment'));
ALTER TABLE public.transactions DROP CONSTRAINT transactions_related_types;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_related_types CHECK (related_id IS NULL OR type IN ('refund', 'fund_return', 'settle_return', 'collect_return', 'adjustment'));
ALTER TABLE public.transactions DROP CONSTRAINT transactions_settlement_scope;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_settlement_scope CHECK (settlement_id IS NULL OR type IN ('settle', 'settle_return', 'collect', 'collect_return'));

CREATE OR REPLACE VIEW public.account_effects AS
SELECT t.id AS tx_id, t.created_at, fw.account_id, t.from_wallet_id AS wallet_id,
       CASE t.type WHEN 'send' THEN -t.amount WHEN 'pay' THEN -(t.amount - t.credit_amount) WHEN 'refund' THEN -t.amount
                   WHEN 'purchase' THEN -t.amount WHEN 'claim' THEN -t.amount WHEN 'settle' THEN -t.amount WHEN 'collect_return' THEN -t.amount
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
