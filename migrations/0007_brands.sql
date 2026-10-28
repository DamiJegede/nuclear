-- Brands and the banks they run on. A neobank (Mercury, Brex) holds its customers' money at a partner bank (Column, Choice Financial Group), so a routing
-- number names the partner and cannot say which brand the customer uses. The partner is an institution of its own (the "host": what the routing number
-- links to, and what is shown until the merchant says otherwise); a brand lists the hosts it runs on in `institution_hosts`. When a routing number's
-- institution has brands, the merchant picks the brand and the pick is kept on their own bank account (`bank_accounts.institution_id`): it changes
-- nothing for anyone else who uses that routing number. A brand with hosts is reached only by that pick, never by matching a directory name.
CREATE TABLE public.institution_hosts (
    brand_id uuid NOT NULL,
    host_id uuid NOT NULL,
    CONSTRAINT institution_hosts_pkey PRIMARY KEY (brand_id, host_id),
    CONSTRAINT institution_hosts_brand_fkey FOREIGN KEY (brand_id) REFERENCES public.institutions(id) ON DELETE CASCADE,
    CONSTRAINT institution_hosts_host_fkey FOREIGN KEY (host_id) REFERENCES public.institutions(id) ON DELETE CASCADE,
    CONSTRAINT institution_hosts_distinct CHECK (brand_id <> host_id)
);
CREATE INDEX institution_hosts_host_idx ON public.institution_hosts USING btree (host_id);

ALTER TABLE public.bank_accounts ADD COLUMN institution_id uuid;
ALTER TABLE public.bank_accounts ADD CONSTRAINT bank_accounts_institution_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE SET NULL;
CREATE INDEX bank_accounts_institution_idx ON public.bank_accounts USING btree (institution_id) WHERE institution_id IS NOT NULL;
