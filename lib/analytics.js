import { query } from "./db.js";

export async function getCompetitionAnalytics(competitionId) {
  const [summary,daily,campaigns,pointTypes,sources] = await Promise.all([
    query(
      `SELECT
         (SELECT COUNT(*) FROM competition_participants WHERE competition_id=$1)::int AS participants,
         (SELECT COUNT(*) FROM competition_participants WHERE competition_id=$1 AND status='active')::int AS active_participants,
         (SELECT COUNT(DISTINCT participant_id) FROM point_transactions WHERE competition_id=$1 AND created_at >= NOW()-interval '24 hours')::int AS active_24h,
         (SELECT COUNT(*) FROM visits WHERE competition_id=$1)::int AS raw_clicks,
         (SELECT COUNT(*) FROM visits WHERE competition_id=$1 AND is_unique=TRUE)::int AS unique_clicks,
         (SELECT COUNT(*) FROM visits WHERE competition_id=$1 AND is_valid=TRUE)::int AS valid_clicks,
         (SELECT COUNT(*) FROM interests WHERE competition_id=$1)::int AS interests,
         (SELECT COUNT(*) FROM leads WHERE competition_id=$1 AND status='confirmed')::int AS leads,
         (SELECT COUNT(*) FROM sales WHERE competition_id=$1 AND status='confirmed')::int AS sales,
         COALESCE((SELECT SUM(amount) FROM sales WHERE competition_id=$1 AND status='confirmed'),0) AS attributed_revenue,
         COALESCE((SELECT SUM(final_points) FROM point_transactions WHERE competition_id=$1),0)::int AS points_generated`,
      [competitionId]
    ),
    query(
      `WITH days AS (
         SELECT generate_series(
           date_trunc('day',NOW())-interval '13 days',
           date_trunc('day',NOW()),
           interval '1 day'
         ) AS day
       )
       SELECT d.day::date AS day,
              (SELECT COUNT(*) FROM visits v
               WHERE v.competition_id=$1
                 AND v.created_at>=d.day
                 AND v.created_at<d.day+interval '1 day')::int AS raw_clicks,
              (SELECT COUNT(*) FROM visits v
               WHERE v.competition_id=$1
                 AND v.is_unique=TRUE
                 AND v.created_at>=d.day
                 AND v.created_at<d.day+interval '1 day')::int AS unique_clicks,
              (SELECT COUNT(*) FROM visits v
               WHERE v.competition_id=$1
                 AND v.is_valid=TRUE
                 AND v.created_at>=d.day
                 AND v.created_at<d.day+interval '1 day')::int AS valid_clicks,
              (SELECT COUNT(*) FROM interests i
               WHERE i.competition_id=$1
                 AND i.created_at>=d.day
                 AND i.created_at<d.day+interval '1 day')::int AS interests,
              (SELECT COUNT(*) FROM leads l
               WHERE l.competition_id=$1
                 AND l.status='confirmed'
                 AND l.confirmed_at>=d.day
                 AND l.confirmed_at<d.day+interval '1 day')::int AS leads,
              (SELECT COUNT(*) FROM sales s
               WHERE s.competition_id=$1
                 AND s.status='confirmed'
                 AND s.confirmed_at>=d.day
                 AND s.confirmed_at<d.day+interval '1 day')::int AS sales
       FROM days d
       ORDER BY d.day ASC`,
      [competitionId]
    ),
    query(
      `SELECT c.id,c.name,c.product,c.status,
              (SELECT COUNT(*) FROM visits v WHERE v.campaign_id=c.id)::int AS raw_clicks,
              (SELECT COUNT(*) FROM visits v WHERE v.campaign_id=c.id AND v.is_unique=TRUE)::int AS unique_clicks,
              (SELECT COUNT(*) FROM visits v WHERE v.campaign_id=c.id AND v.is_valid=TRUE)::int AS valid_clicks,
              (SELECT COUNT(*) FROM interests i WHERE i.campaign_id=c.id)::int AS interests,
              (SELECT COUNT(*) FROM leads l WHERE l.campaign_id=c.id AND l.status='confirmed')::int AS leads,
              (SELECT COUNT(*) FROM sales s WHERE s.campaign_id=c.id AND s.status='confirmed')::int AS sales,
              COALESCE((SELECT SUM(s.amount) FROM sales s WHERE s.campaign_id=c.id AND s.status='confirmed'),0) AS revenue
       FROM campaigns c
       WHERE c.competition_id=$1
       ORDER BY c.created_at DESC`,
      [competitionId]
    ),
    query(
      `SELECT type, COUNT(*)::int AS transactions,
              COALESCE(SUM(final_points),0)::int AS points
       FROM point_transactions
       WHERE competition_id=$1
       GROUP BY type
       ORDER BY points DESC, type ASC`,
      [competitionId]
    ),
    query(
      `SELECT channel,COUNT(*)::int AS shares,
              COUNT(*) FILTER (WHERE rewarded)::int AS rewarded_shares,
              COALESCE(SUM(points_awarded),0)::int AS points
       FROM campaign_share_events
       WHERE competition_id=$1
       GROUP BY channel
       ORDER BY shares DESC,channel ASC`,
      [competitionId]
    )
  ]);

  return {
    summary: summary.rows[0] || {},
    daily: daily.rows,
    campaigns: campaigns.rows,
    pointTypes: pointTypes.rows,
    sources: sources.rows
  };
}
