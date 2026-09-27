import { query } from "../lib/db.js";

export default async function handler(req,res){
 const id=String(req.query?.id||"").trim();
 if(!id){res.statusCode=400;return res.end("Competition requise");}
 const result=await query("SELECT cover_image,cover_mime_type FROM competitions WHERE id=$1 LIMIT 1",[id]);
 const row=result.rows[0];
 if(!row?.cover_image){res.statusCode=404;return res.end("Photo introuvable");}
 const allowed=new Set(["image/jpeg","image/png","image/webp"]);
 const type=allowed.has(row.cover_mime_type)?row.cover_mime_type:"application/octet-stream";
 res.statusCode=200;
 res.setHeader("Content-Type",type);
 res.setHeader("Cache-Control","public, max-age=3600, s-maxage=86400");
 res.setHeader("X-Content-Type-Options","nosniff");
 res.end(row.cover_image);
}
