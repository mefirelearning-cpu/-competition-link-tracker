import { randomBytes } from "node:crypto";
import { query } from "../lib/db.js";
import { adminAuthConfigured, getAdminSession } from "../lib/admin-auth.js";

const go=(res,url)=>{res.statusCode=303;res.setHeader("Location",url);res.end();};
const clean=v=>String(v??"").trim();
const id=(prefix)=>prefix+"_"+randomBytes(12).toString("hex");
const code=()=>randomBytes(5).toString("hex");

async function authorized(req){return !adminAuthConfigured() || Boolean(await getAdminSession(req));}

export default async function handler(req,res){
  const raw=String(req.query?.path||"");
  const m=raw.match(/^api\/simple\/competition\/([^/]+)\/(add|points)$/);
  if(!m){res.statusCode=404;return res.end("Not found");}
  const competitionId=decodeURIComponent(m[1]);
  const action=m[2];
  if(req.method!=="POST"){res.statusCode=405;res.setHeader("Allow","POST");return res.end("Method not allowed");}
  if(!(await authorized(req))){res.statusCode=401;return res.end("Unauthorized");}
  const back="/c/"+encodeURIComponent(competitionId);
  try{
    if(action==="add"){
      const name=clean(req.body?.name);
      let referral=clean(req.body?.code).toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,32);
      if(!name){return go(res,back+"?error="+encodeURIComponent("Nom requis"));}
      if(!referral) referral=code();
      const participantId=id("p");
      const membershipId=id("cp");
      await query("BEGIN");
      try{
        await query(`INSERT INTO participants (id,pseudonym,status) VALUES ($1,$2,'active')`,[participantId,name]);
        await query(`INSERT INTO competition_participants (id,competition_id,participant_id,referral_code,status) VALUES ($1,$2,$3,$4,'active')`,[membershipId,competitionId,participantId,referral]);
        await query("COMMIT");
      }catch(e){await query("ROLLBACK");throw e;}
      return go(res,back+"?created="+encodeURIComponent(referral));
    }
    const referral=clean(req.body?.code);
    const amount=Math.trunc(Number(req.body?.amount));
    const reason=clean(req.body?.reason).slice(0,120);
    if(!referral||!Number.isFinite(amount)||amount===0||!reason) return go(res,back+"?error="+encodeURIComponent("Points et motif requis"));
    const found=await query(`SELECT participant_id FROM competition_participants WHERE competition_id=$1 AND referral_code=$2 AND status='active' LIMIT 1`,[competitionId,referral]);
    const participantId=found.rows[0]?.participant_id;
    if(!participantId) return go(res,back+"?error="+encodeURIComponent("Participant introuvable"));
    await query("BEGIN");
    try{
      await query(`INSERT INTO point_transactions (id,competition_id,participant_id,type,base_points,multiplier,final_points,idempotency_key,description,created_by) VALUES ($1,$2,$3,'admin_adjustment',$4,1,$4,$5,$6,'admin')`,[id("pt"),competitionId,participantId,amount,id("op"),reason]);
      await query(`UPDATE competition_participants SET total_points_cache=GREATEST(0,total_points_cache+$3) WHERE competition_id=$1 AND participant_id=$2`,[competitionId,participantId,amount]);
      await query("COMMIT");
    }catch(e){await query("ROLLBACK");throw e;}
    return go(res,back+"?points=ok");
  }catch(e){console.error("simple-action:",e);return go(res,back+"?error="+encodeURIComponent(e?.code==="23505"?"Ce code existe déjà":"Action impossible"));}
}
