-- when the morning digest (and its "more ready" follow-up) was posted for the day's run, so a
-- retried or re-polled run never posts either message twice
alter table autopilot_runs add column digest_at timestamptz;
alter table autopilot_runs add column digest2_at timestamptz;
