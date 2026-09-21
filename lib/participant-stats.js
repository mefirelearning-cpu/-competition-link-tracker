import { query } from "./db.js";
import { getParticipantRankEvolution } from "./rank-snapshots.js";

export async function getParticipantDetailedStats(competitionId, participantId) {
  const config=await query(
    "SELECT timezone FROM competitions WHERE id=$1 LIMIT 1",
    [competitionId]
  );
  const timezone=config.rows[0]?.timezone || "UTC";

  const [summary,campaigns,history,rankEvolution]=await Promise.all([
    query(
      `SELECT
         COALESCE((SELECT SUM(final_points) FROM point_transactions
                   WHERE competition_id=$1 AND participant_id=$2),0)::int AS total_points,
         COALESCE((SELECT SUM(final_points) FROM point_transactions
                   WHERE competition_id=$1 AND participant_id=$2
                     AND created_at >= (date_trunc('day',NOW() AT TIME ZONE $3) AT TIME ZONE $3)
                     AND created_at < ((date_trunc('day',NOW() AT TIME ZONE $3)+interval '1 day') AT TIME ZONE $3)),0)::int AS points_today,
         (SELECT COUNT(*) FROM campaign_share_events
          WHERE competition_id=$1 AND participant_id=$2)::int AS shares,
         (SELECT COUNT(*) FROM visits
          WHERE competition_id=$1 AND participant_id=$2)::int AS clicks,
         (SELECT COUNT(*) FROM visits
          WHERE competition_id=$1 AND participant_id=$2 AND is_unique=TRUE)::int AS unique_clicks,
         (SELECT COUNT(*) FROM visits
          WHERE competition_id=$1 AND participant_id=$2 AND is_valid=TRUE)::int AS valid_clicks,
         (SELECT COUNT(*) FROM interests
          WHERE competition_id=$1 AND source_participant_id=$2)::int AS interests,
         (SELECT COUNT(*) FROM leads
          WHERE competition_id=$1 AND participant_id=$2 AND status='confirmed')::int AS leads,
         (SELECT COUNT(*) FROM sales
          WHERE competition_id=$1 AND participant_id=$2 AND status='confirmed')::int AS sales,
         (SELECT COUNT(*) FROM daily_claims
          WHERE competition_id=$1 AND participant_id=$2)::int AS checkins,
         (SELECT COUNT(*) FROM mission_completions
          WHERE competition_id=$1 AND participant_id=$2 AND status='confirmed')::int AS missions_completed`,
      [competitionId,participantId,timezone]
    ),
    query(
      `SELECT c.id,c.name,c.product,
              (SELECT COUNT(*) FROM campaign_share_events s
               WHERE s.campaign_id=c.id AND s.participant_id=$2)::int AS shares,
              (SELECT COUNT(*) FROM visits v
               WHERE v.campaign_id=c.id AND v.participant_id=$2)::int AS clicks,
              (SELECT COUNT(*) FROM visits v
               WHERE v.campaign_id=c.id AND v.participant_id=$2 AND v.is_unique=TRUE)::int AS unique_clicks,
              (SELECT COUNT(*) FROM visits v
               WHERE v.campaign_id=c.id AND v.participant_id=$2 AND v.is_valid=TRUE)::int AS valid_clicks,
              (SELECT COUNT(*) FROM interests i
               WHERE i.campaign_id=c.id AND i.source_participant_id=$2)::int AS interests,
              (SELECT COUNT(*) FROM leads l
               WHERE l.campaign_id=c.id AND l.participant_id=$2 AND l.status='confirmed')::int AS leads,
              (SELECT COUNT(*) FROM sales s
               WHERE s.campaign_id=c.id AND s.participant_id=$2 AND s.status='confirmed')::int AS sales,
              COALESCE((SELECT SUM(final_points) FROM point_transactions pt
                        WHERE pt.competition_id=$1 AND pt.participant_id=$2 AND pt.campaign_id=c.id),0)::int AS points_generated
       FROM campaigns c
       WHERE c.competition_id=$1
       ORDER BY c.featured DESC,c.created_at DESC`,
      [competitionId,participantId]
    ),
    query(
      `SELECT id,type,base_points,multiplier,final_points,description,created_at
       FROM point_transactions
       WHERE competition_id=$1 AND participant_id=$2
       ORDER BY created_at DESC
       LIMIT 40`,
      [competitionId,participantId]
    ),
    getParticipantRankEvolution(competitionId,participantId)
  ]);

  return {
    timezone,
    summary:summary.rows[0]||{},
    campaigns:campaigns.rows,
    history:history.rows,
    rankEvolution
  };
}
