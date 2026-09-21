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
           date_trunc('day', NOW()) - interval '13 days',
           date_trunc('day', NOW()),
           interval '1 day'
         ) AS day
       )
       SELECT d.day::date AS day,
              COUNT(v.id)::int AS raw_clicks,
              COUNT(v.id) FILTER (WHERE v.is_unique)::int AS unique_clicks,
              COUNT(v.id) FILTER (WHERE v.is_valid)::int AS valid_clicks,
              COUNT(DISTINCT i.id)::int AS interests,
              COUNT(DISTINCT l.id)::int AS leads,
              COUNT(DISTINCT s.id)::int AS sales
       FROM days d
       LEFT JOIN visits v
         ON v.competition_id=$1
        AND v.created_at >= d.day
        AND v.created_at < d.day + interval '1 day'
       LEFT JOIN interests i
         ON i.competition_id=$1
        AND i.created_at >= d.day
        AND i.created_at < d.day + interval '1 day'
       LEFT JOIN leads l
         ON l.competition_id=$1
        AND l.confirmed_at >= d.day
        AND l.confirmed_at < d.day + interval '1 day'
       LEFT JOIN sales s
         ON s.competition_id=$1
        AND s.confirmed_at >= d.day
        AND s.confirmed_at < d.day + interval '1 day'
       GROUP BY d.day
       ORDER BY d.day ASC`,
      [competitionId]
    ),
    query(
      `SELECT c.id,c.name,c.product,c.status,
              COUNT(DISTINCT v.id)::int AS raw_clicks,
              COUNT(DISTINCT v.id) FILTER (WHERE v.is_unique)::int AS unique_clicks,
              COUNT(DISTINCT v.id) FILTER (WHERE v.is_valid)::int AS valid_clicks,
              COUNT(DISTINCT i.id)::int AS interests,
              COUNT(DISTINCT l.id)::int AS leads,
              COUNT(DISTINCT s.id)::int AS sales,
              COALESCE(SUM(DISTINCT CASE WHEN s.status='confirmed' THEN s.amount ELSE 0 END),0) AS revenue
       FROM campaigns c
       LEFT JOIN visits v ON v.campaign_id=c.id
       LEFT JOIN interests i ON i.campaign_id=c.id
       LEFT JOIN leads l ON l.campaign_id=c.id AND l.status='confirmed'
       LEFT JOIN sales s ON s.campaign_id=c.id AND s.status='confirmed'
       WHERE c.competition_id=$1
       GROUP BY c.id
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
