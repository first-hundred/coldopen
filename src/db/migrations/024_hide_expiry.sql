-- "Skip this company" on Ready to send is temporary (60 days); "Not for me" on Network this
-- week and Jobs stays permanent. null keeps today's behaviour: hidden until unhidden by hand.
alter table target_hides add column until timestamptz;
