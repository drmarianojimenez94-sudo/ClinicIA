import {createTraining,trainingSchema} from './training.mjs';
import {createPayments,paymentSchema} from './payments.mjs';
import {randomBytes,randomUUID,scrypt as scryptCallback,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {restore} from '../public/learn/engine.mjs';
import {questions,courses} from '../public/learn/courses.mjs';
import {BANK_REVISION,restoreExam,examTemplates} from '../public/learn/exams.mjs';
const scrypt=promisify(scryptCallback),digest=s=>createHash('sha256').update(s).digest('hex');
export async function hashPassword(password){const salt=randomBytes(16).toString('hex');return `${salt}:${(await scrypt(password,salt,64)).toString('hex')}`;}
export async function verifyPassword(password,hash){try{const [salt,key]=hash.split(':');const actual=await scrypt(password,salt,64),expected=Buffer.from(key,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);}catch{return false;}}
export const schema=`
CREATE TABLE IF NOT EXISTS clinic_users(id text PRIMARY KEY,username text NOT NULL,username_key text UNIQUE NOT NULL,password_hash text NOT NULL,recovery_hash text NOT NULL,role text NOT NULL DEFAULT 'student',must_change boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),last_seen timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS clinic_sessions(token_hash text PRIMARY KEY,user_id text NOT NULL REFERENCES clinic_users(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS clinic_progress(user_id text PRIMARY KEY REFERENCES clinic_users(id) ON DELETE CASCADE,payload jsonb NOT NULL DEFAULT '{}',version integer NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS clinic_events(id bigserial PRIMARY KEY,user_id text REFERENCES clinic_users(id) ON DELETE CASCADE,name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS clinic_events_date ON clinic_events(created_at);
CREATE TABLE IF NOT EXISTS clinic_limits(key text PRIMARY KEY,count integer NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS clinic_question_reports(user_id text NOT NULL REFERENCES clinic_users(id) ON DELETE CASCADE,question_id text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,question_id,reason));
CREATE TABLE IF NOT EXISTS clinic_settings(key text PRIMARY KEY,value jsonb NOT NULL);
`;
function fail(status,message){throw Object.assign(new Error(message),{status});}
function publicUser(u){return {id:u.id,username:u.username,role:u.role,mustChange:u.must_change};}
const allowedEvents=new Set(['practice','answer','exam','review','market','tutor','guard','plans','install','plus_interest']);
// Deliberately copy only academic fields. Never persist chat, clinical free text or arbitrary keys.
export function cleanProgress(raw){
 if(!raw||typeof raw!=='object'||!raw.state||typeof raw.state!=='object')fail(400,'Progreso inválido.');
 const s=restore(raw.state);
 s.examHistory=s.examHistory.map(cleanExamResult).filter(Boolean);
 const exam=restoreExam(raw.exam);if(exam&&!/^exam-[0-9-]{1,90}$/.test(exam.id))fail(400,'Identificador de simulacro inválido.');return {state:s,exam};
}
// Old results are historical snapshots: never grade them against today's answer key.
function cleanExamResult(e){
 const revision=Number.isInteger(e.bankRevision)?e.bankRevision:1;
 const courseId=courses.find(c=>c.id===e.courseId)?.id||'examen-unico';
 if(revision<1||revision>BANK_REVISION||e.rows.length!==e.total||new Set(e.rows.map(r=>r.id)).size!==e.rows.length||e.rows.some(r=>questions.find(q=>q.id===r.id)?.courseId!==courseId))return null;
 const rows=e.rows.map(r=>{const q=questions.find(q=>q.id===r.id),selected=Number.isInteger(r.selected)&&r.selected>=0&&r.selected<q.options.length?r.selected:null;
  return {id:q.id,area:q.area,selected,right:revision===BANK_REVISION?selected===q.answer:r.right===true,omitted:revision===BANK_REVISION?selected===null:r.omitted===true};});
 if(revision!==BANK_REVISION&&(rows.filter(r=>r.right).length!==e.correct||rows.some(r=>r.right&&r.omitted)))return null;
 return {bankRevision:revision,id:/^exam-[0-9-]+$/.test(e.id)?e.id.slice(0,100):'exam-0',courseId,templateId:examTemplates.find(t=>t.id===e.templateId)?.id||'',completedAt:e.completedAt,elapsedMs:e.elapsedMs,correct:rows.filter(r=>r.right).length,total:rows.length,omitted:rows.filter(r=>r.omitted).length,rows,areas:[...new Set(rows.map(r=>r.area))].map(area=>({area,total:rows.filter(r=>r.area===area).length,correct:rows.filter(r=>r.area===area&&r.right).length}))};
}
export async function createAccounts({db,origin='http://localhost:3000',secure=true,adminName,adminHash}){
 await db.exec(schema+paymentSchema+trainingSchema);
 const training=createTraining({db});
 const payments=createPayments({db,origin});
 if(adminName&&adminHash){await db.query(`INSERT INTO clinic_users(id,username,username_key,password_hash,recovery_hash,role,must_change) VALUES($1,$2,$3,$4,$5,'admin',true) ON CONFLICT(username_key) DO NOTHING`,[randomUUID(),adminName,adminName.toLowerCase(),adminHash,digest(randomBytes(32).toString('hex'))]);}
 const dummy=await hashPassword(randomBytes(24).toString('hex'));
 async function limit(key,max,seconds){const r=await db.query(`INSERT INTO clinic_limits(key,count,expires_at) VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN clinic_limits.expires_at<now() THEN 1 ELSE clinic_limits.count+1 END,expires_at=CASE WHEN clinic_limits.expires_at<now() THEN EXCLUDED.expires_at ELSE clinic_limits.expires_at END RETURNING count`,[digest(key),seconds]);if(r.rows[0].count>max)fail(429,'Demasiados intentos. Esperá unos minutos.');}
 async function identify(req){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('clinic_session='))?.slice(15);if(!token||!/^[a-f0-9]{64}$/.test(token))return null;const r=await db.query(`SELECT u.* FROM clinic_sessions s JOIN clinic_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`,[digest(token)]);return r.rows[0]||null;}
 async function issue(res,u){const token=randomBytes(32).toString('hex');await db.query(`INSERT INTO clinic_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')`,[digest(token),u.id]);res.setHeader('Set-Cookie',`clinic_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure?'; Secure':''}`);}
 async function event(u,name){if(allowedEvents.has(name))await db.query('INSERT INTO clinic_events(user_id,name) VALUES($1,$2)',[u.id,name]);}
 async function handler(req,res,url){
  const path=url.pathname;
  if(!path.startsWith('/api/account')&&!path.startsWith('/api/admin')&&path!=='/api/events'&&path!=='/api/offer'&&path!=='/api/payments/webhook')return false;
  res.setHeader('Cache-Control','no-store');
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return true;};
  try{
   if(path==='/api/payments/webhook'){
    if(req.method!=='POST')fail(405,'Método no permitido.');
    req.resume();const result=await payments.webhook({signature:req.headers['x-signature'],requestId:req.headers['x-request-id'],dataId:url.searchParams.get('data.id'),type:url.searchParams.get('type')||url.searchParams.get('topic')});
    return send(200,{received:true,handled:result.handled});
   }
   if(!['GET','POST','PUT','DELETE'].includes(req.method))fail(405,'Método no permitido.');
   if(req.method!=='GET'&&req.headers.origin!==origin)fail(403,'Origen no autorizado.');
   let body={};if(req.method!=='GET'){if(!String(req.headers['content-type']||'').startsWith('application/json'))fail(415,'Se requiere JSON.');let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>500000)fail(413,'Datos demasiado grandes.');}try{body=JSON.parse(text||'{}');}catch{fail(400,'JSON inválido.');}if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'Datos inválidos.');}
   if(path==='/api/offer'&&req.method==='GET'){const r=await db.query("SELECT value FROM clinic_settings WHERE key='offer'");return send(200,{pilotOpen:true,offer:r.rows[0]?.value||null,payments:payments.offer()});}
   if(path==='/api/account/register'||path==='/api/account/login'||path==='/api/account/recover'){
    if(req.method!=='POST')fail(405,'Método no permitido.');
    const username=typeof body.username==='string'?body.username.trim():'',key=username.toLowerCase(),password=body.password;
    const ip=secure?(req.headers['x-forwarded-for']||'unknown').split(',').at(-1).trim():req.socket.remoteAddress;
    await limit('auth-ip:'+ip,40,900);await limit('auth-user:'+key,10,900);
    if(!/^[A-Za-z0-9_]{3,30}$/.test(username)||typeof password!=='string'||password.length>128)fail(400,'Usá un nombre de 3 a 30 letras, números o guiones bajos.');
    if(path.endsWith('/register')){
     if(password.length<10)fail(400,'Elegí una contraseña de al menos 10 caracteres.');if(body.accepted!==true)fail(400,'Aceptá las condiciones y la política de datos.');
     const recovery=randomBytes(24).toString('hex'),u={id:randomUUID(),username,role:'student',must_change:false};
     try{await db.query('INSERT INTO clinic_users(id,username,username_key,password_hash,recovery_hash) VALUES($1,$2,$3,$4,$5)',[u.id,username,key,await hashPassword(password),digest(recovery)]);}catch(e){if(e.code==='23505')fail(409,'Ese nombre no está disponible.');throw e;}
     await issue(res,u);return send(201,{user:publicUser(u),recoveryCode:recovery});
    }
    const found=(await db.query('SELECT * FROM clinic_users WHERE username_key=$1',[key])).rows[0];
    if(path.endsWith('/recover')){
     const code=typeof body.recoveryCode==='string'?body.recoveryCode.trim():'';
     if(!found||code.length!==48||!timingSafeEqual(Buffer.from(digest(code)),Buffer.from(found.recovery_hash)))fail(401,'No pudimos validar esos datos.');
     if(password.length<10)fail(400,'Elegí una contraseña de al menos 10 caracteres.');const recovery=randomBytes(24).toString('hex');
     await db.query('UPDATE clinic_users SET password_hash=$1,recovery_hash=$2,must_change=false WHERE id=$3',[await hashPassword(password),digest(recovery),found.id]);await db.query('DELETE FROM clinic_sessions WHERE user_id=$1',[found.id]);await issue(res,found);return send(200,{user:publicUser({...found,must_change:false}),recoveryCode:recovery});
    }
    if(!await verifyPassword(password,found?.password_hash||dummy)||!found)fail(401,'Usuario o contraseña incorrectos.');
    await db.query('UPDATE clinic_users SET last_seen=now() WHERE id=$1',[found.id]);await issue(res,found);return send(200,{user:publicUser(found)});
   }
   const u=await identify(req);
   if(path==='/api/account/me'&&req.method==='GET')return send(200,{user:u?publicUser(u):null,configured:true});
   if(!u)fail(401,'Ingresá a tu cuenta para continuar.');
   if(path==='/api/account/logout'&&req.method==='POST'){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('clinic_session='))?.slice(15);if(token)await db.query('DELETE FROM clinic_sessions WHERE token_hash=$1',[digest(token)]);res.setHeader('Set-Cookie',`clinic_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`);return send(200,{ok:true});}
   if(path==='/api/account/password'&&req.method==='POST'){
    await limit('password:'+u.id,10,900);if(typeof body.currentPassword!=='string'||!await verifyPassword(body.currentPassword,u.password_hash))fail(401,'La contraseña actual no coincide.');if(typeof body.password!=='string'||body.password.length<10||body.password.length>128)fail(400,'Elegí una contraseña de 10 a 128 caracteres.');
    const recovery=randomBytes(24).toString('hex');await db.query('UPDATE clinic_users SET password_hash=$1,recovery_hash=$2,must_change=false WHERE id=$3',[await hashPassword(body.password),digest(recovery),u.id]);await db.query('DELETE FROM clinic_sessions WHERE user_id=$1',[u.id]);await issue(res,u);return send(200,{user:publicUser({...u,must_change:false}),recoveryCode:recovery});
   }
   if(u.must_change)fail(403,'Cambiá tu contraseña inicial antes de continuar.');
   if(path==='/api/account/training'){await limit('training:'+req.method+u.id,60,3600);return send(200,await training.assessment(u,req.method,body));}
   if(path==='/api/account/rooms'||/^\/api\/account\/rooms\/[a-f0-9]{12}$/.test(path)){await limit('rooms:'+req.method+u.id,req.method==='GET'?600:120,3600);const code=path.split('/')[4];if(!code&&req.method==='POST')await limit('room-create:'+u.id,5,86400);return send(200,await training.rooms(u,req.method,body,code));}
   if(path==='/api/account/billing'&&req.method==='GET')return send(200,{offer:payments.offer(),orders:await payments.orders(u.id)});
   if(path==='/api/account/checkout'&&req.method==='POST'){await limit('checkout:'+u.id,5,60);return send(200,await payments.checkout(u.id,body));}
   if(path==='/api/account/payment-status'&&req.method==='POST'){await limit('payment-check:'+u.id,20,60);if(typeof body.orderId!=='string'||body.orderId.length>50)fail(400,'Orden inválida.');return send(200,await payments.verify(u.id,body.orderId));}
   if(path==='/api/account/question-report'&&req.method==='POST'){await limit('report:'+u.id,20,3600);if(!questions.some(q=>q.id===body.questionId)||!['ambiguous','incorrect','obvious'].includes(body.reason))fail(400,'Reporte inválido.');await db.query('INSERT INTO clinic_question_reports(user_id,question_id,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[u.id,body.questionId,body.reason]);return send(200,{ok:true});}
   if(path==='/api/account/progress'){
    if(req.method==='GET'){const r=await db.query('SELECT payload,version,updated_at FROM clinic_progress WHERE user_id=$1',[u.id]);return send(200,r.rows[0]||{payload:null,version:0});}
    if(req.method==='PUT'){
     if(!Number.isInteger(body.version)||body.version<0)fail(400,'Versión inválida.');const data=cleanProgress(body.payload);
     await db.query('INSERT INTO clinic_progress(user_id) VALUES($1) ON CONFLICT DO NOTHING',[u.id]);const r=await db.query('UPDATE clinic_progress SET payload=$1,version=version+1,updated_at=now() WHERE user_id=$2 AND version=$3 RETURNING version,updated_at',[JSON.stringify(data),u.id,body.version]);if(!r.rows.length)fail(409,'Otro dispositivo guardó cambios. Descargá tu copia y recargá la versión de la cuenta.');await db.query('UPDATE clinic_users SET last_seen=now() WHERE id=$1',[u.id]);return send(200,r.rows[0]);
    }
   }
   if(path==='/api/events'&&req.method==='POST'){await limit('events:'+u.id,120,60);if(!allowedEvents.has(body.name))fail(400,'Evento no permitido.');await event(u,body.name);return send(200,{ok:true});}
   if(path==='/api/account/export'&&req.method==='GET'){const r=await db.query('SELECT payload,version,updated_at FROM clinic_progress WHERE user_id=$1',[u.id]);return send(200,{user:publicUser(u),progress:r.rows[0]||null,training:await training.assessment(u,'GET',{}),roomMessages:(await db.query("SELECT code,data->'messages' AS messages FROM clinic_rooms WHERE expires_at>now() AND data->'members' @> $1::jsonb",[JSON.stringify([{id:u.id}])])).rows.map(r=>({code:r.code,messages:r.messages.filter(m=>m.name===u.username)}))});}
   if(path==='/api/account/delete'&&req.method==='POST'){await limit('delete:'+u.id,5,900);if(u.role==='admin')fail(403,'La cuenta administradora no se elimina desde aquí.');if(typeof body.password!=='string'||!await verifyPassword(body.password,u.password_hash))fail(401,'Contraseña incorrecta.');await db.query("DELETE FROM clinic_rooms WHERE data->'members' @> $1::jsonb",[JSON.stringify([{id:u.id}])]);await db.query('DELETE FROM clinic_users WHERE id=$1',[u.id]);res.setHeader('Set-Cookie',`clinic_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`);return send(200,{ok:true});}
   if(path.startsWith('/api/admin')){
    if(u.role!=='admin')fail(403,'Acceso exclusivo para administración.');
    if(path==='/api/admin/payments/reconcile'&&req.method==='POST'){await limit('reconcile:'+u.id,6,60);return send(200,await payments.reconcilePending());}
    if(path==='/api/admin/training'&&req.method==='GET')return send(200,await training.roster());
    if(path==='/api/admin/telemetry'&&req.method==='GET'){
     const counts=(await db.query(`SELECT count(*) AS accounts,count(*) FILTER(WHERE last_seen>now()-interval '7 days') AS active7,count(*) FILTER(WHERE created_at>now()-interval '1 day') AS new24 FROM clinic_users WHERE role='student'`)).rows[0];
     const events=(await db.query(`SELECT name,count(*) AS count FROM clinic_events WHERE created_at>now()-interval '30 days' GROUP BY name ORDER BY count DESC`)).rows;
     const daily=(await db.query(`SELECT to_char(created_at,'YYYY-MM-DD') AS day,count(*) AS events,count(DISTINCT user_id) AS users FROM clinic_events WHERE created_at>now()-interval '14 days' GROUP BY day ORDER BY day`)).rows;
     const users=(await db.query(`SELECT u.username,u.role,u.created_at,u.last_seen,p.updated_at AS saved_at,p.version FROM clinic_users u LEFT JOIN clinic_progress p ON p.user_id=u.id ORDER BY u.created_at DESC LIMIT 100`)).rows;
     const reports=(await db.query('SELECT question_id,reason,count(*) AS count FROM clinic_question_reports GROUP BY question_id,reason ORDER BY count DESC LIMIT 100')).rows;
     return send(200,{counts,events,daily,users,reports,pilotOpen:true,paymentsActive:payments.offer().enabled,paymentSetup:payments.offer()});
    }
   }
   fail(404,'Ruta no encontrada.');
  }catch(e){if(!e.status)console.error('account_request_failed',e.code||'internal');return send(e.status||503,{error:e.status?e.message:'El guardado no está disponible. Reintentá sin cerrar esta página.'});}
 }
 return {handler,identify,event,limit};
}
let cached;
export async function getAccounts(){if(!process.env.DATABASE_URL)return null;if(!cached)cached=(async()=>{const {Pool}=await import('pg');const pool=new Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:8000,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:undefined});pool.on('error',()=>console.error('database_connection_error'));const api=await createAccounts({db:{query:(...a)=>pool.query(...a),exec:s=>pool.query(s)},origin:process.env.APP_ORIGIN||'https://clinicia-heef.onrender.com',secure:process.env.NODE_ENV!=='test',adminName:process.env.ADMIN_USERNAME,adminHash:process.env.ADMIN_PASSWORD_HASH});const timer=setInterval(()=>pool.query("DELETE FROM clinic_training_attempts WHERE result IS NULL AND created_at<now()-interval '1 day'; DELETE FROM clinic_rooms WHERE expires_at<now(); DELETE FROM clinic_sessions WHERE expires_at<now(); DELETE FROM clinic_limits WHERE expires_at<now(); DELETE FROM clinic_events WHERE created_at<now()-interval '90 days'").catch(()=>{}),3600000);timer.unref();return api;})().catch(e=>{cached=null;throw e;});return cached;}
