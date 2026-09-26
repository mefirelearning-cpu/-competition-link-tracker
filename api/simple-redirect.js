import { query } from "../lib/db.js";
import { trackReferralVisit } from "../lib/referral-tracking.js";
import { getAdminSession } from "../lib/admin-auth.js";
import { syncTrackingCache, captureCompetitionRank } from "../lib/simple-sync.js";

const CLICK_POINTS=5;
const send=(res,status,msg)=>{res.statusCode=status;res.setHeader("Content-Type","text/plain; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(msg);};

async function ensureFivePointClickRule(competitionId){
 await query(`INSERT INTO point_rules (id,competition_id,action_type,enabled,base_points,multiplier,daily_cap_points,settings)
              VALUES ('rule_simple_'||substr(md5($1),1,20),$1,'valid_click',TRUE,$2,1,NULL,'{"simpleMode":true}'::jsonb)
              ON CONFLICT (competition_id,action_type) DO UPDATE SET
                enabled=TRUE,
                base_points=EXCLUDED.base_points,
                multiplier=1,
                daily_cap_points=NULL,
                settings=COALESCE(point_rules.settings,'{}'::jsonb)||'{"simpleMode":true}'::jsonb,
                updated_at=NOW()`,[competitionId,CLICK_POINTS]);
}

export default async function handler(req,res){
 const raw=String(req.query?.path||""),m=raw.match(/^r\/([^/]+)\/([^/]+)$/);
 if(!m)return send(res,404,"Lien inconnu");
 const competitionId=decodeURIComponent(m[1]),referralCode=decodeURIComponent(m[2]);

 try{
  const r=await query(`SELECT c.status,c.settings,cp.participant_id,p.status participant_status,cp.status membership_status
                       FROM competitions c
                       JOIN competition_participants cp ON cp.competition_id=c.id
                       JOIN participants p ON p.id=cp.participant_id
                       WHERE c.id=$1 AND cp.referral_code=$2
                       LIMIT 1`,[competitionId,referralCode]);
  const row=r.rows[0];
  if(!row||row.participant_status!=="active"||row.membership_status!=="active")return send(res,404,"Lien inconnu");
  if(!["active","scheduled"].includes(row.status))return send(res,410,"Cette compétition n’accepte actuellement plus de participations.");

  const destination=String(row.settings?.redirectUrl||"").trim();
  let u;
  try{u=new URL(destination);}catch{return send(res,503,"Le lien principal de cette compétition n’est pas encore configuré.");}
  if(!["http:","https:"].includes(u.protocol))return send(res,503,"Le lien principal de cette compétition est invalide.");

  await ensureFivePointClickRule(competitionId);
  const adminSession=await getAdminSession(req).catch(()=>null);
  let tracked=null;
  try{
   tracked=await trackReferralVisit({req,res,competitionId,referralCode,isAdmin:Boolean(adminSession),isSelf:false});
  }catch(trackError){
   console.error("simple-redirect-tracking:",trackError);
  }

  if(!adminSession&&tracked?.raw){
   try{
    await query(`UPDATE competition_participants
                 SET raw_clicks_cache=raw_clicks_cache+1,
                     unique_clicks_cache=unique_clicks_cache+$3,
                     valid_clicks_cache=valid_clicks_cache+$4
                 WHERE competition_id=$1 AND referral_code=$2`,[competitionId,referralCode,tracked.isUnique?1:0,tracked.isValid?1:0]);
    await syncTrackingCache(competitionId,referralCode);
    await captureCompetitionRank(competitionId);
   }catch(syncError){
    console.error("simple-redirect-sync:",syncError);
   }
  }

  res.statusCode=302;
  res.setHeader("Location",u.toString());
  res.setHeader("Cache-Control","no-store");
  res.end();
 }catch(e){
  console.error("simple-redirect:",e);
  return send(res,500,"Redirection temporairement indisponible.");
 }
}
