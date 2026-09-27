const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SOURCE_DB = path.join(__dirname, 'data', 'db.json');
const DEFAULT_TIME = 15;
const CATEGORIES = ['Basic','Basic To Control Panel','Microsoft Word','Overall','Graphic Design','Web Development'];

app.use(express.json({limit:'4mb'}));
app.use((req,res,next)=>{res.setHeader('Cache-Control','no-store'); next();});

function requireEnv(name){ if(!process.env[name]) throw new Error(`${name} is not configured.`); return process.env[name]; }
function db(){ return neon(requireEnv('DATABASE_URL')); }
function clone(x){ return JSON.parse(JSON.stringify(x)); }
function cleanText(v,max=120){ return String(v??'').trim().slice(0,max); }
function makeId(){ return crypto.randomUUID(); }
function signToken(payload){
  const secret=requireEnv('ADMIN_SESSION_SECRET');
  const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig=crypto.createHmac('sha256',secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token){
  try{
    const [body,sig]=String(token||'').split('.'); if(!body||!sig) return null;
    const expected=crypto.createHmac('sha256',requireEnv('ADMIN_SESSION_SECRET')).update(body).digest('base64url');
    if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return null;
    const p=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(!p.exp || p.exp < Date.now()) return null; return p;
  }catch{return null;}
}
function requireAdmin(req,res,next){
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if(!verifyToken(token)) return res.status(401).json({error:'Admin authentication required.'});
  next();
}
const attempts=new Map();
function rateLimit(key,max=8,windowMs=60000){
  const now=Date.now(); const arr=(attempts.get(key)||[]).filter(t=>now-t<windowMs); arr.push(now); attempts.set(key,arr); return arr.length<=max;
}

let initPromise=null;
async function init(){
  if(initPromise) return initPromise;
  initPromise=(async()=>{
    const sql=db();
    await sql`CREATE TABLE IF NOT EXISTS kt_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS kt_settings (id INTEGER PRIMARY KEY, student_pin TEXT NOT NULL, admin_pin TEXT NOT NULL, time_per_question INTEGER NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS kt_questions (id TEXT PRIMARY KEY, category TEXT NOT NULL, question TEXT NOT NULL, options JSONB NOT NULL, answer INTEGER NOT NULL, marks INTEGER NOT NULL)`;
    await sql`CREATE INDEX IF NOT EXISTS kt_questions_category_idx ON kt_questions(category)`;
    await sql`CREATE TABLE IF NOT EXISTS kt_passing (category TEXT PRIMARY KEY, marks INTEGER NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS kt_live (id INTEGER PRIMARY KEY, status TEXT NOT NULL, session_id TEXT, started_at TIMESTAMPTZ)`;
    await sql`CREATE TABLE IF NOT EXISTS kt_participants (id TEXT PRIMARY KEY, name TEXT NOT NULL, fname TEXT NOT NULL, caste TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT, current_index INTEGER NOT NULL DEFAULT 0, question_deadline BIGINT, obtained_marks INTEGER NOT NULL DEFAULT 0, answers JSONB NOT NULL DEFAULT '{}'::jsonb, joined_at TIMESTAMPTZ NOT NULL, finished_at TIMESTAMPTZ)`;
    await sql`CREATE INDEX IF NOT EXISTS kt_participants_session_idx ON kt_participants(session_id)`;
    await sql`CREATE TABLE IF NOT EXISTS kt_results (id TEXT PRIMARY KEY, participant_id TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL, fname TEXT NOT NULL, caste TEXT NOT NULL, category TEXT NOT NULL, total_marks INTEGER NOT NULL, obtained_marks INTEGER NOT NULL, percentage NUMERIC(5,1) NOT NULL, finished_at TIMESTAMPTZ NOT NULL)`;
    await sql`CREATE INDEX IF NOT EXISTS kt_results_category_idx ON kt_results(category)`;
    const meta=await sql`SELECT value FROM kt_meta WHERE key='seeded' LIMIT 1`;
    if(!meta.length){
      let source={}; try{source=JSON.parse(fs.readFileSync(SOURCE_DB,'utf8'));}catch{}
      const s=source.settings||{};
      await sql`INSERT INTO kt_settings(id,student_pin,admin_pin,time_per_question) VALUES(1,${String(s.studentPin||'1234')},${String(s.adminPin||'9988')},${Math.min(600,Math.max(5,Number(s.timePerQuestion)||DEFAULT_TIME))}) ON CONFLICT(id) DO NOTHING`;
      for(const cat of CATEGORIES){
        const passing=Number((source.passingScores||{})[cat]);
        await sql`INSERT INTO kt_passing(category,marks) VALUES(${cat},${Number.isFinite(passing)?Math.max(0,Math.floor(passing)):1}) ON CONFLICT(category) DO NOTHING`;
        const qs=Array.isArray((source.questions||{})[cat])?(source.questions||{})[cat]:[];
        for(const q of qs){
          const options=Array.isArray(q.options)?q.options.slice(0,4).map(x=>String(x??'').trim()):[];
          const ans=Number(q.answer), marks=Number(q.marks)||1;
          if(String(q.q||'').trim() && options.length===4 && options.every(Boolean) && Number.isInteger(ans)&&ans>=0&&ans<=3)
            await sql`INSERT INTO kt_questions(id,category,question,options,answer,marks) VALUES(${String(q.id||makeId())},${cat},${String(q.q).trim()},${JSON.stringify(options)},${ans},${Math.max(1,Math.floor(marks))}) ON CONFLICT(id) DO NOTHING`;
        }
      }
      await sql`INSERT INTO kt_live(id,status,session_id,started_at) VALUES(1,'WAITING',NULL,NULL) ON CONFLICT(id) DO NOTHING`;
      await sql`INSERT INTO kt_meta(key,value) VALUES('seeded','1') ON CONFLICT(key) DO NOTHING`;
    }
    await sql`INSERT INTO kt_settings(id,student_pin,admin_pin,time_per_question) VALUES(1,'1234','9988',15) ON CONFLICT(id) DO NOTHING`;
    for(const cat of CATEGORIES) await sql`INSERT INTO kt_passing(category,marks) VALUES(${cat},1) ON CONFLICT(category) DO NOTHING`;
    await sql`INSERT INTO kt_live(id,status,session_id,started_at) VALUES(1,'WAITING',NULL,NULL) ON CONFLICT(id) DO NOTHING`;
  })();
  try{return await initPromise;}catch(e){initPromise=null;throw e;}
}
async function settings(){const rows=await db()`SELECT student_pin,admin_pin,time_per_question FROM kt_settings WHERE id=1`;return rows[0];}
async function live(){const rows=await db()`SELECT status,session_id,started_at FROM kt_live WHERE id=1`;return rows[0]||{status:'WAITING',session_id:null,started_at:null};}
async function categories(){return CATEGORIES.slice();}
function publicParticipant(p){return {id:p.id,name:p.name,fname:p.fname,caste:p.caste,category:p.category,status:p.status,joinedAt:p.joined_at,sessionId:p.session_id,currentIndex:Number(p.current_index||0)};}
function publicQuestion(q){return {id:q.id,q:q.question,options:q.options,marks:Number(q.marks)};}
async function questionList(category){return db()`SELECT id,question,options,answer,marks FROM kt_questions WHERE category=${category} ORDER BY id`;}
async function totalMarks(category){const r=await db()`SELECT COALESCE(SUM(marks),0)::int AS total FROM kt_questions WHERE category=${category}`;return Number(r[0]?.total||0);}
async function finalizeExpired(p){
  const now=Date.now(); if(p.status!=='RUNNING'||!p.question_deadline||Number(p.question_deadline)>=now)return p;
  const qs=await questionList(p.category); const idx=Number(p.current_index||0);
  if(idx>=qs.length) return finish(p);
  const answers={...(p.answers||{})}; answers[qs[idx].id]=-1;
  const next=idx+1;
  if(next>=qs.length) return finish({...p,current_index:next,answers});
  const s=await settings(); const deadline=now+Number(s.time_per_question)*1000;
  const rows=await db()`UPDATE kt_participants SET answers=${JSON.stringify(answers)},current_index=${next},question_deadline=${deadline} WHERE id=${p.id} RETURNING *`;
  return rows[0];
}
async function finish(p){
  const total=await totalMarks(p.category); const obtained=Number(p.obtained_marks||0); const pct=total?Number(((obtained/total)*100).toFixed(1)):0; const finishedAt=new Date();
  const sql=db();
  await sql`UPDATE kt_participants SET status='FINISHED',question_deadline=NULL,finished_at=${finishedAt} WHERE id=${p.id}`;
  await sql`INSERT INTO kt_results(id,participant_id,session_id,name,fname,caste,category,total_marks,obtained_marks,percentage,finished_at) VALUES(${makeId()},${p.id},${p.session_id},${p.name},${p.fname},${p.caste},${p.category},${total},${obtained},${pct},${finishedAt})`;
  const running=await sql`SELECT COUNT(*)::int AS n FROM kt_participants WHERE session_id=${p.session_id} AND status<>'FINISHED'`;
  if(Number(running[0].n)===0) await sql`UPDATE kt_live SET status='WAITING',session_id=NULL,started_at=NULL WHERE id=1 AND session_id=${p.session_id}`;
  return {...p,status:'FINISHED',total_marks:total,obtained_marks:obtained,percentage:pct};
}

app.get('/api/health',async(req,res)=>{try{await init();res.json({ok:true,service:'KineTEX'})}catch(e){res.status(500).json({ok:false,error:e.message})}});
app.get('/api/public-config',async(req,res)=>{try{await init();const s=await settings(), l=await live();res.json({categories:CATEGORIES,timePerQuestion:Number(s.time_per_question),live:{status:l.status,sessionId:l.session_id,startedAt:l.started_at}})}catch(e){res.status(500).json({error:e.message})}});

app.post('/api/admin/login',async(req,res)=>{try{await init();if(!rateLimit(`admin:${req.ip}`))return res.status(429).json({error:'Too many login attempts. Please wait one minute.'});const s=await settings();if(String(req.body?.pin||'')!==s.admin_pin)return res.status(401).json({error:'Incorrect Admin PIN.'});const token=signToken({role:'admin',exp:Date.now()+12*60*60*1000});res.json({token,expiresIn:43200})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/admin/data',requireAdmin,async(req,res)=>{try{await init();const sql=db(),s=await settings(),l=await live();const [ps,qs,passing,results]=await Promise.all([sql`SELECT * FROM kt_participants ORDER BY joined_at`,sql`SELECT id,category,question,options,answer,marks FROM kt_questions ORDER BY category,id`,sql`SELECT category,marks FROM kt_passing`,sql`SELECT * FROM kt_results ORDER BY finished_at DESC`]);const qmap=Object.fromEntries(CATEGORIES.map(c=>[c,[]]));qs.forEach(q=>qmap[q.category].push({...q,q:q.question,options:q.options}));const pmap=passing.reduce((a,r)=>(a[r.category]=Number(r.marks),a),{});res.json({settings:{studentPin:s.student_pin,timePerQuestion:Number(s.time_per_question)},categories:CATEGORIES,passingScores:pmap,questions:qmap,participants:ps.map(publicParticipant),results})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/admin/start',requireAdmin,async(req,res)=>{try{await init();const sql=db(),l=await live();if(l.status==='RUNNING')return res.status(409).json({error:'A live test is already running.'});const ps=await sql`SELECT * FROM kt_participants WHERE status='READY'`;if(!ps.length)return res.status(400).json({error:'No ready students.'});for(const p of ps){const n=await totalMarks(p.category);if(n<=0)return res.status(400).json({error:`No questions are available for ${p.category}. Add questions before starting.`})}const sid=makeId(),now=new Date();await sql`UPDATE kt_live SET status='RUNNING',session_id=${sid},started_at=${now} WHERE id=1 AND status='WAITING'`;const s=await settings();for(const p of ps){const deadline=Date.now()+Number(s.time_per_question)*1000;await sql`UPDATE kt_participants SET status='RUNNING',session_id=${sid},current_index=0,question_deadline=${deadline},obtained_marks=0,answers='{}'::jsonb WHERE id=${p.id}`;}res.json({ok:true,students:ps.length,sessionId:sid})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/admin/end-test',requireAdmin,async(req,res)=>{try{await init();const l=await live();if(l.status!=='RUNNING')return res.json({ok:true});const ps=await db()`SELECT * FROM kt_participants WHERE status='RUNNING' AND session_id=${l.session_id}`;for(const p of ps)await finish(p);await db()`UPDATE kt_live SET status='WAITING',session_id=NULL,started_at=NULL WHERE id=1`;res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/admin/reset-session',requireAdmin,async(req,res)=>{try{await init();const l=await live();if(l.status==='RUNNING')return res.status(409).json({error:'End the running test before resetting the lobby.'});await db()`DELETE FROM kt_participants`;await db()`UPDATE kt_live SET status='WAITING',session_id=NULL,started_at=NULL WHERE id=1`;res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/admin/settings',requireAdmin,async(req,res)=>{try{await init();const s=await settings();const sp=req.body?.studentPin,ap=req.body?.adminPin,tp=Number(req.body?.timePerQuestion);const studentPin=sp!==undefined&&cleanText(sp,30)?cleanText(sp,30):s.student_pin;const adminPin=ap!==undefined&&cleanText(ap,30)?cleanText(ap,30):s.admin_pin;const time=Number.isFinite(tp)?Math.min(600,Math.max(5,Math.floor(tp))):Number(s.time_per_question);await db()`UPDATE kt_settings SET student_pin=${studentPin},admin_pin=${adminPin},time_per_question=${time} WHERE id=1`;res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/admin/passing-score',requireAdmin,async(req,res)=>{try{await init();const c=cleanText(req.body?.category,80),m=Number(req.body?.marks);if(!CATEGORIES.includes(c)||!Number.isFinite(m)||m<0)return res.status(400).json({error:'Invalid passing score.'});await db()`INSERT INTO kt_passing(category,marks) VALUES(${c},${Math.floor(m)}) ON CONFLICT(category) DO UPDATE SET marks=EXCLUDED.marks`;res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/admin/question',requireAdmin,async(req,res)=>{try{await init();const c=cleanText(req.body?.category,80),q=cleanText(req.body?.q,1000),opts=Array.isArray(req.body?.options)?req.body.options.map(x=>cleanText(x,500)):[],ans=Number(req.body?.answer),marks=Number(req.body?.marks)||1;if(!CATEGORIES.includes(c)||!q||opts.length!==4||opts.some(v=>!v)||!Number.isInteger(ans)||ans<0||ans>3)return res.status(400).json({error:'Complete question data is required.'});const id=makeId();await db()`INSERT INTO kt_questions(id,category,question,options,answer,marks) VALUES(${id},${c},${q},${JSON.stringify(opts)},${ans},${Math.max(1,Math.floor(marks))})`;res.json({ok:true,id})}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/admin/question/:category/:id',requireAdmin,async(req,res)=>{try{await init();const c=decodeURIComponent(req.params.category),id=req.params.id;if(!CATEGORIES.includes(c))return res.status(400).json({error:'Invalid category.'});const r=await db()`DELETE FROM kt_questions WHERE category=${c} AND id=${id} RETURNING id`;if(!r.length)return res.status(404).json({error:'Question not found.'});res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/admin/import',requireAdmin,async(req,res)=>{try{await init();const c=cleanText(req.body?.category,80),incoming=req.body?.questions;if(!CATEGORIES.includes(c)||!Array.isArray(incoming))return res.status(400).json({error:'Invalid import.'});let count=0;for(const q of incoming){const opts=Array.isArray(q.options)?q.options.map(x=>cleanText(x,500)):[];const ans=Number(q.answer),marks=Number(q.marks)||1;if(String(q.q||'').trim()&&opts.length===4&&opts.every(Boolean)&&Number.isInteger(ans)&&ans>=0&&ans<=3){await db()`INSERT INTO kt_questions(id,category,question,options,answer,marks) VALUES(${makeId()},${c},${String(q.q).trim()},${JSON.stringify(opts)},${ans},${Math.max(1,Math.floor(marks))})`;count++;}}if(!count)return res.status(400).json({error:'No valid questions were found.'});res.json({ok:true,count})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/admin/results',requireAdmin,async(req,res)=>{try{await init();const c=cleanText(req.query.category||'All',80),sql=db();const rows=c==='All'?await sql`SELECT * FROM kt_results ORDER BY finished_at DESC`:await sql`SELECT * FROM kt_results WHERE category=${c} ORDER BY finished_at DESC`;const p=await sql`SELECT category,marks FROM kt_passing`;res.json({results:rows,passingScores:p.reduce((a,r)=>(a[r.category]=Number(r.marks),a),{})})}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/admin/results',requireAdmin,async(req,res)=>{try{await init();await db()`DELETE FROM kt_results`;res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});

app.post('/api/student/register',async(req,res)=>{try{await init();const s=await settings(),l=await live();if(String(req.body?.pin||'')!==s.student_pin)return res.status(401).json({error:'Incorrect Student PIN.'});if(l.status==='RUNNING')return res.status(409).json({error:'A test is already running. Please wait for the next test.'});const name=cleanText(req.body?.name,80),fname=cleanText(req.body?.fname,80),caste=cleanText(req.body?.caste,80),category=cleanText(req.body?.category,80);if(!name||!fname||!caste||!CATEGORIES.includes(category))return res.status(400).json({error:'Please complete all fields.'});const existing=await db()`SELECT id FROM kt_participants WHERE lower(name)=lower(${name}) AND category=${category} LIMIT 1`;if(existing.length)return res.status(409).json({error:'This student is already registered in this test.'});const id=makeId(),joined=new Date();const r=await db()`INSERT INTO kt_participants(id,name,fname,caste,category,status,joined_at) VALUES(${id},${name},${fname},${caste},${category},'READY',${joined}) RETURNING *`;res.json({participant:publicParticipant(r[0])})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/student/session/:id',async(req,res)=>{try{await init();let rows=await db()`SELECT * FROM kt_participants WHERE id=${req.params.id}`;if(!rows.length)return res.status(404).json({error:'Student session not found.'});let p=rows[0];if(p.status==='RUNNING')p=await finalizeExpired(p);const l=await live();let question=null;if(p.status==='RUNNING'&&l.status==='RUNNING'&&p.session_id===l.session_id){const qs=await questionList(p.category),q=qs[Number(p.current_index||0)];if(q){question={sessionId:p.session_id,participantId:p.id,index:Number(p.current_index||0),total:qs.length,question:publicQuestion(q),deadline:Number(p.question_deadline),serverNow:Date.now()}}else p=await finish(p);}res.json({participant:publicParticipant(p),live:{status:l.status,sessionId:l.session_id},question})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/student/answer',async(req,res)=>{try{await init();let rows=await db()`SELECT * FROM kt_participants WHERE id=${req.body?.participantId}`;if(!rows.length)return res.status(404).json({error:'Student session not found.'});let p=rows[0];if(p.status==='RUNNING')p=await finalizeExpired(p);const l=await live();if(p.status!=='RUNNING'||l.status!=='RUNNING'||p.session_id!==req.body?.sessionId||l.session_id!==req.body?.sessionId)return res.status(409).json({error:'This test session is no longer active.'});const qs=await questionList(p.category),idx=Number(p.current_index||0),q=qs[idx];if(!q||q.id!==req.body?.questionId)return res.status(409).json({error:'Question is out of sync. Refreshing…'});if(Date.now()>Number(p.question_deadline||0)+500)return res.status(409).json({error:'Time expired.','expired':true});const selected=Number(req.body?.selectedIndex);if(!Number.isInteger(selected)||selected<0||selected>3)return res.status(400).json({error:'Invalid answer.'});const answers={...(p.answers||{})};if(Object.prototype.hasOwnProperty.call(answers,q.id))return res.status(409).json({error:'Answer already submitted.'});answers[q.id]=selected;const obtained=Number(p.obtained_marks||0)+(selected===Number(q.answer)?Number(q.marks):0);const next=idx+1;if(next>=qs.length){p={...p,answers,obtained_marks:obtained,current_index:next};const r=await db()`UPDATE kt_participants SET answers=${JSON.stringify(answers)},obtained_marks=${obtained},current_index=${next},question_deadline=NULL WHERE id=${p.id} RETURNING *`;const f=await finish(r[0]);return res.json({ok:true,finished:true,result:{obtainedMarks:f.obtained_marks,totalMarks:f.total_marks,percentage:f.percentage}})}const s=await settings(),deadline=Date.now()+Number(s.time_per_question)*1000;await db()`UPDATE kt_participants SET answers=${JSON.stringify(answers)},obtained_marks=${obtained},current_index=${next},question_deadline=${deadline} WHERE id=${p.id}`;res.json({ok:true,finished:false})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/student/timeout',async(req,res)=>{try{await init();const rows=await db()`SELECT * FROM kt_participants WHERE id=${req.body?.participantId}`;if(!rows.length)return res.status(404).json({error:'Student session not found.'});let p=rows[0];if(p.status==='RUNNING')p=await finalizeExpired(p);if(p.status==='FINISHED')return res.json({ok:true,finished:true});res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});

app.use(express.static(PUBLIC_DIR));
app.get('*',(req,res)=>res.sendFile(path.join(PUBLIC_DIR,'index.html')));

if(require.main===module){app.listen(PORT,()=>console.log(`KineTEX running on ${PORT}`));}
module.exports=app;
