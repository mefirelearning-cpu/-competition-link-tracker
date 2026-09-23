-- Keep competition membership status consistent with a global participant suspension.
-- This migration was first validated on a temporary Neon branch before production application.

CREATE OR REPLACE RULE sync_participant_global_suspension AS
ON UPDATE TO participants
WHERE NEW.status = 'suspended'
  AND OLD.status IS DISTINCT FROM NEW.status
DO ALSO
  UPDATE competition_participants
  SET status = 'suspended'
  WHERE participant_id = NEW.id
    AND status = 'active';

-- Repair any pre-existing inconsistent memberships safely.
UPDATE competition_participants cp
SET status = 'suspended'
FROM participants p
WHERE p.id = cp.participant_id
  AND p.status = 'suspended'
  AND cp.status = 'active';
