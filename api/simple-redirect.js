import { query } from "../lib/db.js";
import { trackReferralVisit } from "../lib/referral-tracking.js";
import { getAdminSession } from "../lib/admin-auth.js";
const send=(res,status,msg)=>{res.statusCode=status;res.setHeader("Content-Type","text/plain; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(msg);};
export default async function handler(req,res){
 const raw=String(req.query?.path||""),m=raw.match(/^r\/([^/]+)\/([^/]+)$/);if(!m)return send(res,404,"Lien inconnu");
 const competitionId=decodeURIComponent(m[1]),referralCode=decodeURIComponent(m[2]);
 try{
  const r=await query(`SELECT c.status,c.settings,cp.participant_id,p.status participant_status,cp.status membership_status FROM competitions c JOIN competition_participants cp ON cp.competition_id=c.id JOIN participants p ON p.id=cp.participant_id WHERE c.id=$1 AND cp.referral_code=$2 LIMIT 1`,[competitionId,referralCode]);
  const row=r.rows[0];if(!row||row.participant_status!=="active"||row.membership_status!=="active")return send(res,404,"Lien inconnu");
  if(!["active","scheduled"].includes(row.status))return send(res,410,"Cette compétition n’accepte actuellement plus de participations.");
  const destination=String(row.settings?.redirectUrl||"").trim();let u;try{u=new URL(destination);}catch{return send(res,503,"Le lien principal de cette compétition n’est pas encore configuré.");}if(!["http:","https:"].includes(u.protocol))return send(res,503,"Le lien principal de cette compétition est invalide.");
  const adminSession=await getAdminSession(req).catch(()=>null);
  const tracked=await trackReferralVisit({req,res,competitionId,referralCode,isAdmin:Boolean(adminSession),isSelf:false});
  if(tracked?.stats){await query(`UPDATE competition_participants SET raw_clicks_cache=$3,unique_clicks_cache=$4,valid_clicks_cache=$5,total_points_cache=GREATEST(total_points_cache,$6) WHERE competition_id=$1 AND referral_code=$2`,[competitionId,referralCode,Number(tracked.stats.clicks||0),Number(tracked.stats.unique||0),Number(tracked.stats.valid||0),Number(tracked.stats.points||0)]).catch(()=>{});}
  res.statusCode=302;res.setHeader("Location",u.toString());res.setHeader("Cache-Control","no-store");res.end();
 }catch(e){console.error("simple-redirect:",e);return send(res,500,"Redirection temporairement indisponible.");}
}
