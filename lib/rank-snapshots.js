import { query } from "./db.js";
import { createNotification } from "./notifications.js";

export async function snapshotCompetitionRanks(competitionId) {
  const result = await query(
    `WITH ranked AS (
       SELECT cp.participant_id,
              ROW_NUMBER() OVER (
                ORDER BY cp.total_points_cache DESC,
                         cp.valid_clicks_cache DESC,
                         cp.unique_clicks_cache DESC,
                         cp.raw_clicks_cache DESC,
                         cp.joined_at ASC
              )::int AS rank,
              cp.total_points_cache::int AS points,
              cp.valid_clicks_cache::int AS valid_clicks,
              cp.unique_clicks_cache::int AS unique_clicks
       FROM competition_participants cp
       JOIN participants p ON p.id=cp.participant_id
       WHERE cp.competition_id=$1
         AND cp.status='active'
         AND p.status='active'
     ),
     bucket AS (
       SELECT date_trunc('hour',NOW()) AS bucket_at
     )
     INSERT INTO rank_snapshots
       (competition_id,participant_id,bucket_at,rank,points,valid_clicks,unique_clicks)
     SELECT $1,r.participant_id,b.bucket_at,r.rank,r.points,r.valid_clicks,r.unique_clicks
     FROM ranked r
     CROSS JOIN bucket b
     ON CONFLICT (competition_id,participant_id,bucket_at)
     DO UPDATE SET
       rank=EXCLUDED.rank,
       points=EXCLUDED.points,
       valid_clicks=EXCLUDED.valid_clicks,
       unique_clicks=EXCLUDED.unique_clicks
     RETURNING participant_id,rank,points,valid_clicks,unique_clicks,bucket_at`,
    [competitionId]
  );

  const bucketAt=result.rows[0]?.bucket_at || null;
  let notificationsCreated=0;

  if(bucketAt && result.rowCount){
    const state=await query(
      `SELECT rs.participant_id,rs.rank,rs.points,c.winner_count,
              prev.rank AS previous_rank
       FROM rank_snapshots rs
       JOIN competitions c ON c.id=rs.competition_id
       LEFT JOIN LATERAL (
         SELECT old.rank
         FROM rank_snapshots old
         WHERE old.competition_id=rs.competition_id
           AND old.participant_id=rs.participant_id
           AND old.bucket_at < rs.bucket_at
         ORDER BY old.bucket_at DESC
         LIMIT 1
       ) prev ON TRUE
       WHERE rs.competition_id=$1
         AND rs.bucket_at=$2`,
      [competitionId,bucketAt]
    );

    const bucketKey=new Date(bucketAt).toISOString();
    for(const row of state.rows){
      const currentRank=Number(row.rank||0);
      const previousRank=Number(row.previous_rank||0);
      const winnerCount=Math.max(1,Number(row.winner_count||1));
      if(!previousRank || !currentRank) continue;

      if(previousRank>winnerCount && currentRank<=winnerCount){
        const created=await createNotification({
          competitionId,
          participantId:row.participant_id,
          kind:"rank",
          title:"Tu es entré dans le Top "+winnerCount,
          body:"Ta position actuelle est #"+currentRank+". Continue à générer de l’activité réelle.",
          actionUrl:"/leaderboard/"+encodeURIComponent(competitionId),
          idempotencyKey:"rank-top:"+competitionId+":"+row.participant_id+":"+bucketKey,
          metadata:{previousRank,currentRank,winnerCount,bucketAt:bucketKey}
        });
        if(created) notificationsCreated++;
        continue;
      }

      const gained=previousRank-currentRank;
      if(gained>=3){
        const created=await createNotification({
          competitionId,
          participantId:row.participant_id,
          kind:"rank",
          title:"Tu viens de gagner "+gained+" places",
          body:"Tu es maintenant #"+currentRank+" au classement.",
          actionUrl:"/leaderboard/"+encodeURIComponent(competitionId),
          idempotencyKey:"rank-rise:"+competitionId+":"+row.participant_id+":"+bucketKey,
          metadata:{previousRank,currentRank,gained,bucketAt:bucketKey}
        });
        if(created) notificationsCreated++;
      }
    }
  }

  return {
    competitionId,
    captured:result.rowCount,
    bucketAt,
    notificationsCreated
  };
}

export async function getParticipantRankEvolution(competitionId,participantId) {
  const [current,history] = await Promise.all([
    query(
      `WITH ranked AS (
         SELECT cp.participant_id,
                ROW_NUMBER() OVER (
                  ORDER BY cp.total_points_cache DESC,
                           cp.valid_clicks_cache DESC,
                           cp.unique_clicks_cache DESC,
                           cp.raw_clicks_cache DESC,
                           cp.joined_at ASC
                )::int AS rank,
                cp.total_points_cache::int AS points
         FROM competition_participants cp
         JOIN participants p ON p.id=cp.participant_id
         WHERE cp.competition_id=$1
           AND cp.status='active'
           AND p.status='active'
       )
       SELECT rank,points
       FROM ranked
       WHERE participant_id=$2`,
      [competitionId,participantId]
    ),
    query(
      `SELECT bucket_at,rank,points,valid_clicks,unique_clicks
       FROM rank_snapshots
       WHERE competition_id=$1
         AND participant_id=$2
         AND bucket_at >= NOW()-interval '14 days'
       ORDER BY bucket_at DESC
       LIMIT 337`,
      [competitionId,participantId]
    )
  ]);

  const currentRow=current.rows[0]||null;
  const latestSnapshot=history.rows[0]||null;
  const olderSnapshot=history.rows[1]||null;
  const currentRank=Number(currentRow?.rank || latestSnapshot?.rank || 0) || null;
  const currentPoints=Number(currentRow?.points ?? latestSnapshot?.points ?? 0);

  // If the live state already equals the newest snapshot, compare with the
  // preceding bucket. Otherwise the newest snapshot itself is the baseline.
  // This prevents us from inventing a movement when no historical baseline
  // exists, while still surfacing changes that happened after the last capture.
  const liveMatchesLatest=Boolean(
    currentRow && latestSnapshot &&
    Number(currentRow.rank)===Number(latestSnapshot.rank) &&
    Number(currentRow.points)===Number(latestSnapshot.points)
  );
  const baselineSnapshot=liveMatchesLatest ? olderSnapshot : latestSnapshot;
  const previousRank=Number(baselineSnapshot?.rank || 0) || null;
  const rankDelta=currentRank && previousRank ? previousRank-currentRank : null;

  return {
    currentRank,
    currentPoints,
    previousRank,
    previousSnapshotAt:baselineSnapshot?.bucket_at || null,
    latestSnapshotAt:latestSnapshot?.bucket_at || null,
    rankDelta,
    history:history.rows
  };
}
