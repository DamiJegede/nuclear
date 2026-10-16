-- Admin Access Tokens are server-generated and final: there is no forced replacement after sign-in.
ALTER TABLE admins DROP COLUMN must_change_access_token;
