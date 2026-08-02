-- DEPLOY ORDER: before-worker
-- migrations/0017_chain_publication.sql
--
-- Publication is opt-in, per project. A chain names pull request numbers, head
-- and base SHAs, tree oids, actor GitHub ids and free-text override reasons.
-- That is public for a public repository and nobody else's business for a
-- private one, so the chain endpoint must not serve it just because a caller
-- knows the numeric repository id.
ALTER TABLE queue_projects ADD COLUMN chain_public INTEGER NOT NULL DEFAULT 0;

-- Thwip's own repository stays open: its chain is already the worked example
-- in the documentation, and the repository itself is public.
UPDATE queue_projects SET chain_public = 1 WHERE github_repository_id = '1315419165' AND base_ref = 'refs/heads/main';
