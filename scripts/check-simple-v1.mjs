import fs from 'node:fs';
const vercel=JSON.parse(fs.readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
const sources=new Set(vercel.rewrites.map(r=>r.source));
for(const route of ['/admin','/c/:id','/leaderboard/:id','/r/:id/:code','/api/simple/competition/:id/add','/api/simple/competition/:id/points']){
 if(!sources.has(route)) throw new Error('Route manquante: '+route);
}
for(const file of ['api/simple-home.js','api/simple-admin.js','api/simple-actions.js','api/simple-leaderboard.js']){
 if(!fs.existsSync(new URL('../'+file,import.meta.url))) throw new Error('Fichier manquant: '+file);
}
console.log('Simple V1 routes: OK');
