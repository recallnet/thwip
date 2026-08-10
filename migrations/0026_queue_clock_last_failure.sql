-- DEPLOY ORDER: before-worker
--
-- Why the last tick that failed, failed.
--
-- `queue_clock` says when a tick started and when one finished, which answers
-- "has the queue stopped" and nothing else. On 5 August the trigger fired twelve
-- times an hour and died every time, and every diagnostic anybody had reported
-- the same thing: an age. Working out that the cause was `exceededResources`
-- took reading Cloudflare's invocation analytics against `webhook_deliveries`
-- minute by minute, by hand.
--
-- A tick that throws now leaves the reason here, and `/health` publishes it, so
-- the watchdog that already notices a stopped clock can say what stopped it. The
-- row is overwritten rather than appended: the current failure is the one
-- anybody acts on, and a history of them belongs in the tail rather than in a
-- document the sweep re-serialises on every pass.
ALTER TABLE queue_clock ADD COLUMN last_error TEXT;
ALTER TABLE queue_clock ADD COLUMN last_error_at TEXT;
