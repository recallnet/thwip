-- DEPLOY ORDER: before-worker
-- Link 42 is the first signed record on this repository's chain.
--
-- Everything below it is a merge commit id padded with zeroes, written before
-- records existed. Recording the boundary lets a verifier report that history as
-- history instead of as forty-one broken signatures.
UPDATE queue_projects
   SET attested_from_sequence = 42
 WHERE github_repository_id = '1315419165' AND base_ref = 'refs/heads/main';
