-- Run after every routing number has been converted to plain digits (0027): checks all existing rows against bank_routing_format.
ALTER TABLE bank_accounts VALIDATE CONSTRAINT bank_routing_format;
