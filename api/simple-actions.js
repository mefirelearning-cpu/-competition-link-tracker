import { randomBytes } from "node:crypto";
import { query, withTransaction } from "../lib/db.js";
import { adminAuthConfigured, getAdminSession } from "../lib/admin-auth.js";
import { syncTrackingCache, captureCompetitionRank } from "../lib/simple-sync.js";

const DEFAULT_CLICK_POINTS=5;
const go=(res,url)=>{res.statusCode=303;res.setHeader("Location",url);res.end();};
const clean=v=>String(v??"").trim();
const id=(prefix)=>prefix+"_"+randomBytes(12).toString("hex");
const randomCode=()=>randomBytes(5).toString("hex");
const slugify=v=>clean(v).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,48);
const validUrl=v=>{try{const u=new URL(clean(v));return (u.protocol==="https:"||u.protocol==="http:")?u.toString():"";}catch{return "";}};

async function authorized(req){return !adminAuthConfigured() || Boolean(await getAdminSession(req));}

async function addParticipant(client,competitionId,name,referral){
 const participantId=id("p"),membershipId=id("cp");
 await client.query(`INSERT INTO participants (id,pseudonym,status) VALUES ($1,$2,'active')`,[participantId,name]);
 await client.query(`INSERT INTO competition_participants (id,competition_id,participant_id,referral_code,status) VALUES ($1,$2,$3,$4,'active')`,[membershipId,competitionId,participantId,referral]);
}

async function ensureDefaultClickRule(competitionId,client=null){
 const run=(text,params)=>client?client.query(text,params):query(text,params);
 await run(`INSERT INTO point_rules (id,competition_id,action_type,enabled,base_points,multiplier,daily_cap_points,settings)
            VALUES ('rule_simple_'||substr(md5($1),1,20),$1,'valid_click',TRUE,$2,1,NULL,'{"simpleMode":true}'::jsonb)
            ON CONFLICT (competition_id,action_type) DO NOTHING`,[competitionId,DEFAULT_CLICK_POINTS]);
}

async function parseCreateRequest(req){
 const type=String(req.headers["content-type"]||"");
 if(!type.includes("multipart/form-data"))return {fields:req.body||{},file:null};
 const request=new Request("https://local.invalid",{method:"POST",headers:{"content-type":type},body:req,duplex:"half"});
 const form=await request.formData();
 return {fields:Object.fromEntries([...form.entries()].filter(([,v])=>typeof v==="string")),file:form.get("cover")};
}

export default async function handler(req,res){
 const raw=String(req.query?.path||"");
 if(req.method!=="POST"){res.statusCode=405;res.setHeader("Allow","POST");return res.end("Method not allowed");}
 if(!(await authorized(req))){res.statusCode=401;return res.end("Unauthorized");}

 if(raw==="api/simple/competition/create"){
  try{
   const {fields,file}=await parseCreateRequest(req),name=clean(fields.name).slice(0,100),destination=validUrl(fields.destination),prizes=clean(fields.prizes).slice(0,500);
   if(!name)return go(res,"/admin?error="+encodeURIComponent("Nom de compétition requis"));
   if(!destination)return go(res,"/admin?error="+encodeURIComponent("Lien principal valide requis (https://...)"));
   let coverImage=null,coverMimeType=null;
   if(file&&typeof file!=="string"&&Number(file.size||0)>0){
    if(!["image/jpeg","image/png","image/webp"].includes(file.type))return go(res,"/admin?error="+encodeURIComponent("Photo invalide : JPG, PNG ou WebP uniquement"));
    if(file.size>8*1024*1024)return go(res,"/admin?error="+encodeURIComponent("Photo trop lourde (8 Mo maximum)"));
    coverImage=Buffer.from(await file.arrayBuffer());
    coverMimeType=file.type;
   }
   const competitionId=id("cmp"),slug=(slugify(name)||"competition")+"-"+randomBytes(3).toString("hex");
   await withTransaction(async client=>{
    await client.query(`INSERT INTO competitions (id,slug,name,cover_url,cover_image,cover_mime_type,status,registrations_open,leaderboard_visible,settings)
                        VALUES ($1,$2,$3,NULL,$4,$5,'active',true,true,$6::jsonb)`,[competitionId,slug,name,coverImage,coverMimeType,JSON.stringify({redirectUrl:destination,prizes:prizes||"Lots annoncés par l’organisateur"})]);
    await ensureDefaultClickRule(competitionId,client);
   });
   await captureCompetitionRank(competitionId);
   return go(res,"/c/"+encodeURIComponent(competitionId)+"?createdCompetition=1");
  }catch(e){
   console.error("create competition:",e);
   return go(res,"/admin?error="+encodeURIComponent("Création impossible"));
  }
 }

 const m=raw.match(/^api\/simple\/competition\/([^/]+)\/(add|bulk|points|clicks|destination|delete|click-value)$/);
 if(!m){res.statusCode=404;return res.end("Not found");}
 const competitionId=decodeURIComponent(m[1]),action=m[2],back="/c/"+encodeURIComponent(competitionId);

 try{
  if(action==="destination"){
   const destination=validUrl(req.body?.destination);
   if(!destination)return go(res,back+"?error="+encodeURIComponent("Lien de redirection invalide"));
   await query(`UPDATE competitions SET settings=COALESCE(settings,'{}'::jsonb)||jsonb_build_object('redirectUrl',$2::text),updated_at=NOW() WHERE id=$1`,[competitionId,destination]);
   return go(res,back+"?destination=ok");
  }

  if(action==="click-value"){
   const points=Math.trunc(Number(req.body?.points));
   if(!Number.isFinite(points)||points<0||points>100000)return go(res,back+"?error="+encodeURIComponent("Valeur par clic invalide"));
   await withTransaction(async client=>{
    await ensureDefaultClickRule(competitionId,client);
    const before=await client.query(`SELECT base_points,multiplier,daily_cap_points FROM point_rules WHERE competition_id=$1 AND action_type='valid_click' LIMIT 1 FOR UPDATE`,[competitionId]);
    await client.query(`UPDATE point_rules
                        SET enabled=TRUE,base_points=$2,multiplier=1,daily_cap_points=NULL,
                            settings=COALESCE(settings,'{}'::jsonb)||'{"simpleMode":true}'::jsonb,updated_at=NOW()
                        WHERE competition_id=$1 AND action_type='valid_click'`,[competitionId,points]);
    await client.query(`INSERT INTO admin_audit_logs (id,admin_id,action,entity_type,entity_id,description,metadata)
                        VALUES ($1,'admin','click_value_updated','competition',$2,$3,$4::jsonb)`,[
      id("audit"),competitionId,`Valeur d'une personne distincte modifiée à ${points} point(s)`,JSON.stringify({before:before.rows[0]||null,after:{basePoints:points,multiplier:1,dailyCapPoints:null}})
    ]);
   });
   return go(res,back+"?clickValue=ok");
  }

  if(action==="add"){
   const name=clean(req.body?.name);
   let referral=clean(req.body?.code).toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,32);
   if(!name)return go(res,back+"?error="+encodeURIComponent("Nom requis"));
   if(!referral)referral=randomCode();
   await withTransaction(async client=>{await addParticipant(client,competitionId,name,referral);});
   await captureCompetitionRank(competitionId);
   return go(res,back+"?created="+encodeURIComponent(referral));
  }

  if(action==="bulk"){
   const count=Math.max(1,Math.min(200,Math.trunc(Number(req.body?.count)||0)));
   if(!count)return go(res,back+"?error="+encodeURIComponent("Nombre invalide"));
   const existing=await query(`SELECT p.pseudonym FROM competition_participants cp JOIN participants p ON p.id=cp.participant_id WHERE cp.competition_id=$1 AND p.pseudonym ~ '^P-[0-9]+$'`,[competitionId]);
   let max=0;
   for(const r of existing.rows){const n=Number(String(r.pseudonym).split("-")[1]);if(Number.isFinite(n))max=Math.max(max,n);}
   await withTransaction(async client=>{
    for(let i=1;i<=count;i++){
     const n=max+i,name=`P-${String(n).padStart(3,"0")}`;
     await addParticipant(client,competitionId,name,randomCode());
    }
   });
   await captureCompetitionRank(competitionId);
   return go(res,back+"?bulk="+count);
  }

  const referral=clean(req.body?.code);
  if(!referral)return go(res,back+"?error="+encodeURIComponent("Participant introuvable"));

  if(action==="delete"){
   await withTransaction(async client=>{
    const found=await client.query(`SELECT cp.id,cp.participant_id,p.pseudonym
                                    FROM competition_participants cp
                                    JOIN participants p ON p.id=cp.participant_id
                                    WHERE cp.competition_id=$1 AND cp.referral_code=$2 AND cp.status='active'
                                    FOR UPDATE OF cp`,[competitionId,referral]);
    const row=found.rows[0];
    if(!row)throw Object.assign(new Error("Participant introuvable"),{publicMessage:"Participant introuvable ou déjà supprimé"});
    await client.query(`UPDATE competition_participants
                        SET status='withdrawn',metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('removedAt',NOW()::text,'removedBy','admin')
                        WHERE id=$1`,[row.id]);
    await client.query(`INSERT INTO admin_audit_logs (id,admin_id,action,entity_type,entity_id,description,metadata)
                        VALUES ($1,'admin','participant_removed','competition_participant',$2,$3,$4::jsonb)`,[
      id("audit"),row.id,`Participant ${row.pseudonym} retiré de la compétition`,JSON.stringify({competitionId,participantId:row.participant_id,referralCode:referral})
    ]);
   });
   await captureCompetitionRank(competitionId);
   return go(res,back+"?deleted=ok");
  }

  if(action==="clicks"){
   const requested=Math.trunc(Number(req.body?.amount));
   if(!Number.isFinite(requested)||requested===0||Math.abs(requested)>100000)return go(res,back+"?error="+encodeURIComponent("Nombre de clics invalide"));
   await ensureDefaultClickRule(competitionId);
   await withTransaction(async client=>{
    const found=await client.query(`SELECT participant_id,raw_clicks_cache,unique_clicks_cache,valid_clicks_cache,total_points_cache
                                    FROM competition_participants
                                    WHERE competition_id=$1 AND referral_code=$2 AND status='active'
                                    FOR UPDATE`,[competitionId,referral]);
    const row=found.rows[0];
    if(!row)throw Object.assign(new Error("Participant introuvable"),{publicMessage:"Participant introuvable"});
    const ruleResult=await client.query(`SELECT base_points,multiplier FROM point_rules WHERE competition_id=$1 AND action_type='valid_click' LIMIT 1`,[competitionId]);
    const rule=ruleResult.rows[0]||{};
    const clickPoints=Math.max(0,Math.round(Number(rule.base_points||DEFAULT_CLICK_POINTS)*Number(rule.multiplier||1)));
    const rawBefore=Math.max(0,Number(row.raw_clicks_cache||0));
    const uniqueBefore=Math.max(0,Number(row.unique_clicks_cache||0));
    const validBefore=Math.max(0,Number(row.valid_clicks_cache||0));
    const rawAfter=Math.max(0,rawBefore+requested);
    const delta=rawAfter-rawBefore;
    if(delta===0)return;
    const uniqueAfter=Math.max(0,uniqueBefore+delta);
    const validAfter=Math.max(0,validBefore+delta);
    const distinctDelta=uniqueAfter-uniqueBefore;
    const desiredPointsDelta=distinctDelta*clickPoints;
    const currentPoints=Math.max(0,Number(row.total_points_cache||0));
    const appliedPointsDelta=desiredPointsDelta<0?Math.max(desiredPointsDelta,-currentPoints):desiredPointsDelta;
    await client.query(`INSERT INTO point_transactions
      (id,competition_id,participant_id,type,base_points,multiplier,final_points,idempotency_key,description,created_by,metadata)
      VALUES ($1,$2,$3,'admin_adjustment',$4,1,$4,$5,$6,'admin',$7::jsonb)`,[
       id("pt"),competitionId,row.participant_id,appliedPointsDelta,id("clickop"),
       `Ajustement manuel : ${distinctDelta>0?"+":""}${distinctDelta} personne(s) distincte(s) × ${clickPoints} pts`,
       JSON.stringify({source:"manual_click_adjustment",clickDelta:delta,distinctDelta,pointsPerClick:clickPoints,desiredPointsDelta,appliedPointsDelta,rawBefore,rawAfter,uniqueBefore,uniqueAfter,validBefore,validAfter})
    ]);
    await client.query(`UPDATE competition_participants
                        SET raw_clicks_cache=$3,
                            unique_clicks_cache=$4,
                            valid_clicks_cache=$5,
                            total_points_cache=total_points_cache+$6
                        WHERE competition_id=$1 AND referral_code=$2`,[competitionId,referral,rawAfter,uniqueAfter,validAfter,appliedPointsDelta]);
   });
   await syncTrackingCache(competitionId,referral);
   await captureCompetitionRank(competitionId);
   return go(res,back+"?clicks=ok");
  }

  const requestedAmount=Math.trunc(Number(req.body?.amount)),reason=clean(req.body?.reason).slice(0,120);
  if(!Number.isFinite(requestedAmount)||requestedAmount===0||!reason)return go(res,back+"?error="+encodeURIComponent("Points et motif requis"));
  await withTransaction(async client=>{
   const found=await client.query(`SELECT participant_id,total_points_cache
                                   FROM competition_participants
                                   WHERE competition_id=$1 AND referral_code=$2 AND status='active'
                                   FOR UPDATE`,[competitionId,referral]);
   const row=found.rows[0];
   if(!row)throw Object.assign(new Error("Participant introuvable"),{publicMessage:"Participant introuvable"});
   const currentPoints=Math.max(0,Number(row.total_points_cache||0));
   const appliedAmount=requestedAmount<0?Math.max(requestedAmount,-currentPoints):requestedAmount;
   if(appliedAmount===0)throw Object.assign(new Error("Points déjà à zéro"),{publicMessage:"Les points sont déjà à zéro"});
   await client.query(`INSERT INTO point_transactions
     (id,competition_id,participant_id,type,base_points,multiplier,final_points,idempotency_key,description,created_by)
     VALUES ($1,$2,$3,'admin_adjustment',$4,1,$4,$5,$6,'admin')`,[id("pt"),competitionId,row.participant_id,appliedAmount,id("op"),reason]);
   await client.query(`UPDATE competition_participants SET total_points_cache=total_points_cache+$3 WHERE competition_id=$1 AND participant_id=$2`,[competitionId,row.participant_id,appliedAmount]);
  });
  await syncTrackingCache(competitionId,referral);
  await captureCompetitionRank(competitionId);
  return go(res,back+"?points=ok");
 }catch(e){
  console.error("simple-action:",e);
  const message=e?.publicMessage||(e?.code==="23505"?"Ce code existe déjà":"Action impossible");
  return go(res,back+"?error="+encodeURIComponent(message));
 }
}
