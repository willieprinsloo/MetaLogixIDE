-- Point P2P settings at the actual running mrsignald on remote.metalogix.solutions:7100.
-- Only rewrites the row when it still holds the never-reachable 0003 default
-- (signal.metalogix.solutions:7000); a user who typed their own relay keeps it.
UPDATE p2p_settings
   SET relay_url = 'remote.metalogix.solutions',
       relay_port = 7100
 WHERE id = 1
   AND relay_url = 'signal.metalogix.solutions'
   AND relay_port = 7000;
