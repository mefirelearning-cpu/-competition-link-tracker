import { randomBytes } from "node:crypto";
import { put } from "@vercel/blob";
import { query } from "../lib/db.js";
import { adminAuthConfigured, getAdminSession } from "../lib/admin-auth.js";
const go=(res,url)=>{res.statusCode=303;res.setHeader("Location",url);res.end();};
const clean=v=>String(v??"").trim();
const id=(prefix)=>prefix+"_"+randomBytes(12).toString("hex");
const randomCode=()=>randomBytes(5).toString("hex");
const slugify=v=>clean(v).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,48);
const validUrl=v=>{try{const u=new URL(clean(v));return (u.protocol==="https:"||u.protocol==="http:")?u.toString():"";}catch{return "";}};
async function authorized(req){return !adminAuthConfigured() || Boolean(await getAdminSession(req));}
async function addParticipant(competitionId,name,referral){const participantId=id("p"),membershipId=id("cp");await query(`INSERT INTO participants (id,pseudonym,status) VALUES ($1,$2,'active')`,[participantId,name]);await query(`INSERT INTO competition_participants (id,competition_id,participant_id,referral_code,status) VALUES ($1,$2,$3,$4,'active')`,[membershipId,competitionId,participantId,referral]);}
async function parseCreateRequest(req){const type=String(req.headers["content-type"]||"");if(!type.includes("multipart/form-data"))return {fields:req.body||{},file:null};const request=new Request("https://local.invalid",{method:"POST",headers:{"content-type":type},body:req,duplex:"half"});const form=await request.formData();return {fields:Object.fromEntries([...form.entries()].filter(([,v])=>typeof v==="string")),file:form.get("cover")};}
export default async function handler(req,res){
 const raw=String(req.query?.path||"");
 if(req.method!=="POST"){res.statusCode=405;res.setHeader("Allow","POST");return res.end("Method not allowed");}
 if(!(await authorized(req))){res.statusCode=401;return res.end("Unauthorized");}
 if(raw==="api/simple/competition/create"){
  try{
   const {fields,file}=await parseCreateRequest(req),name=clean(fields.name).slice(0,100),destination=validUrl(fields.destination),prizes=clean(fields.prizes).slice(0,500);
   if(!name)return go(res,"/admin?error="+encodeURIComponent("Nom de compétition requis"));
   if(!destination)return go(res,"/admin?error="+encodeURIComponent("Lien principal valide requis (https://...)"));
   let cover="";
   if(file&&typeof file!=="string"&&Number(file.size||0)>0){if(!["image/jpeg","image/png","image/webp"].includes(file.type))return go(res,"/admin?error="+encodeURIComponent("Photo invalide : JPG, PNG ou WebP uniquement"));if(file.size>8*1024*1024)return go(res,"/admin?error="+encodeURIComponent("Photo trop lourde (8 Mo maximum)"));const ext=file.type==="image/png"?"png":file.type==="image/webp"?"webp":"jpg";const blob=await put(`competitions/${Date.now()}-${randomBytes(5).toString("hex")}.${ext}`,file,{access:"public",addRandomSuffix:false});cover=blob.url;}
   const competitionId=id("cmp");let slug=(slugify(name)||"competition")+"-"+randomBytes(3).toString("hex");
   await query(`INSERT INTO competitions (id,slug,name,cover_url,status,registrations_open,leaderboard_visible,settings) VALUES ($1,$2,$3,$4,'active',true,true,$5::jsonb)`,[competitionId,slug,name,cover||null,JSON.stringify({redirectUrl:destination,prizes:prizes||"Lots annoncés par l’organisateur"})]);
   return go(res,"/c/"+encodeURIComponent(competitionId)+"?createdCompetition=1");
  }catch(e){console.error("create competition:",e);const msg=String(e?.message||"").includes("BLOB")?"Stockage photo non configuré sur Vercel":"Création impossible";return go(res,"/admin?error="+encodeURIComponent(msg));}
 }
 const m=raw.match(/^api\/simple\/competition\/([^/]+)\/(add|bulk|points|destination)$/);if(!m){res.statusCode=404;return res.end("Not found");}
 const competitionId=decodeURIComponent(m[1]),action=m[2],back="/c/"+encodeURIComponent(competitionId);
 try{
  if(action==="destination"){const destination=validUrl(req.body?.destination);if(!destination)return go(res,back+"?error="+encodeURIComponent("Lien de redirection invalide"));await query(`UPDATE competitions SET settings=COALESCE(settings,'{}'::jsonb)||jsonb_build_object('redirectUrl',$2::text),updated_at=NOW() WHERE id=$1`,[competitionId,destination]);return go(res,back+"?destination=ok");}
  if(action==="add"){const name=clean(req.body?.name);let referral=clean(req.body?.code).toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,32);if(!name)return go(res,back+"?error="+encodeURIComponent("Nom requis"));if(!referral)referral=randomCode();await query("BEGIN");try{await addParticipant(competitionId,name,referral);await query("COMMIT");}catch(e){await query("ROLLBACK");throw e;}return go(res,back+"?created="+encodeURIComponent(referral));}
  if(action==="bulk"){const count=Math.max(1,Math.min(200,Math.trunc(Number(req.body?.count)||0)));if(!count)return go(res,back+"?error="+encodeURIComponent("Nombre invalide"));const existing=await query(`SELECT p.pseudonym FROM competition_participants cp JOIN participants p ON p.id=cp.participant_id WHERE cp.competition_id=$1 AND p.pseudonym ~ '^P-[0-9]+$'`,[competitionId]);let max=0;for(const r of existing.rows){const n=Number(String(r.pseudonym).split("-")[1]);if(Number.isFinite(n))max=Math.max(max,n);}await query("BEGIN");try{for(let i=1;i<=count;i++){const n=max+i,name=`P-${String(n).padStart(3,"0")}`;await addParticipant(competitionId,name,randomCode());}await query("COMMIT");}catch(e){await query("ROLLBACK");throw e;}return go(res,back+"?bulk="+count);}
  const referral=clean(req.body?.code),amount=Math.trunc(Number(req.body?.amount)),reason=clean(req.body?.reason).slice(0,120);if(!referral||!Number.isFinite(amount)||amount===0||!reason)return go(res,back+"?error="+encodeURIComponent("Points et motif requis"));const found=await query(`SELECT participant_id FROM competition_participants WHERE competition_id=$1 AND referral_code=$2 AND status='active' LIMIT 1`,[competitionId,referral]);const participantId=found.rows[0]?.participant_id;if(!participantId)return go(res,back+"?error="+encodeURIComponent("Participant introuvable"));await query("BEGIN");try{await query(`INSERT INTO point_transactions (id,competition_id,participant_id,type,base_points,multiplier,final_points,idempotency_key,description,created_by) VALUES ($1,$2,$3,'admin_adjustment',$4,1,$4,$5,$6,'admin')`,[id("pt"),competitionId,participantId,amount,id("op"),reason]);await query(`UPDATE competition_participants SET total_points_cache=GREATEST(0,total_points_cache+$3) WHERE competition_id=$1 AND participant_id=$2`,[competitionId,participantId,amount]);await query("COMMIT");}catch(e){await query("ROLLBACK");throw e;}return go(res,back+"?points=ok");
 }catch(e){console.error("simple-action:",e);return go(res,back+"?error="+encodeURIComponent(e?.code==="23505"?"Ce code existe déjà":"Action impossible"));}
}
