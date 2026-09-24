import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
const map=new Map(v.rewrites.map(x=>[x.source,x.destination]));
const expected={
 '/':'/api/simple-root',
 '/admin':'/api/simple-home',
 '/c/:id':'/api/simple-admin?path=c/:id',
 '/leaderboard/:id':'/api/simple-leaderboard?path=leaderboard/:id',
 '/api/simple/competition/:id/add':'/api/simple-actions?path=api/simple/competition/:id/add',
 '/api/simple/competition/:id/points':'/api/simple-actions?path=api/simple/competition/:id/points'
};
for(const [route,dest] of Object.entries(expected)) if(map.get(route)!==dest) throw new Error(`${route} -> ${map.get(route)} attendu ${dest}`);
console.log('Launch V1 routing: OK');
