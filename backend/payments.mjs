import {randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
export const paymentSchema=`CREATE TABLE IF NOT EXISTS clinic_orders(id text PRIMARY KEY,user_id text NOT NULL REFERENCES clinic_users(id) ON DELETE CASCADE,request_key text NOT NULL,title text NOT NULL,amount_cents integer NOT NULL,currency text NOT NULL DEFAULT 'ARS',status text NOT NULL DEFAULT 'creating',preference_id text,checkout_url text,collector_id text,payment_id text UNIQUE,valid_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,request_key));`;
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function paymentConfig(env=process.env){
 const price=String(env.CLINICIA_PRICE_ARS||'');const cents=/^\d{1,7}(\.\d{1,2})?$/.test(price)?Math.round(Number(price)*100):0;
 const title=String(env.CLINICIA_PRODUCT_TITLE||'').slice(0,100),description=String(env.CLINICIA_PRODUCT_DESCRIPTION||'').slice(0,1200),seller=String(env.CLINICIA_SELLER_NAME||'').slice(0,120),support=String(env.CLINICIA_SUPPORT_EMAIL||'');
 const ready=Boolean(env.MERCADOPAGO_ACCESS_TOKEN&&cents>0&&cents<=100000000&&title&&description&&seller&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support));
 return {ready,enabled:ready&&env.CLINICIA_PAYMENTS_ENABLED==='true',token:env.MERCADOPAGO_ACCESS_TOKEN||'',cents,title,description,seller,support,currency:'ARS'};
}
export function publicPaymentOffer(config=paymentConfig()){return {enabled:config.enabled,ready:config.ready,title:config.title,description:config.description,amount:config.cents/100,currency:config.currency,seller:config.seller,support:config.support,durationDays:30,pilotOpen:true};}
export function createPayments({db,origin,env=process.env,request=fetch}){
 const config=()=>paymentConfig(env);
 async function mp(path,method='GET',body){const c=config();if(!c.token)fail(503,'Mercado Pago todavía no está conectado.');const r=await request('https://api.mercadopago.com'+path,{method,headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});if(!r.ok)fail(502,'Mercado Pago no pudo completar la consulta. No vuelvas a pagar; revisá el estado de tu orden.');return r.json();}
 const safe=o=>({id:o.id,title:o.title,amount:Number(o.amount_cents)/100,currency:o.currency,status:o.status,createdAt:o.created_at,validUntil:o.valid_until,checkoutUrl:o.checkout_url});
 async function orders(userId){return (await db.query('SELECT * FROM clinic_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30',[userId])).rows.map(safe);}
 async function checkout(userId,body){const c=config();if(!c.enabled)fail(503,'Los cobros siguen desactivados. El piloto está abierto y podés estudiar gratis.');if(body.accepted!==true)fail(400,'Confirmá que leíste el alcance, precio y condiciones.');if(!/^[a-f0-9-]{36}$/.test(body.requestKey||''))fail(400,'Solicitud de compra inválida.');
  const id=randomUUID();const inserted=await db.query('INSERT INTO clinic_orders(id,user_id,request_key,title,amount_cents) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,request_key) DO NOTHING RETURNING *',[id,userId,body.requestKey,c.title,c.cents]);
  if(!inserted.rows.length){const old=(await db.query('SELECT * FROM clinic_orders WHERE user_id=$1 AND request_key=$2',[userId,body.requestKey])).rows[0];if(old.checkout_url)return safe(old);fail(409,'La orden se está preparando o necesita revisión. Consultá tus órdenes antes de reintentar.');}
  try{const preference=await mp('/checkout/preferences','POST',{items:[{id:'clinicia-30',title:c.title,description:c.description,quantity:1,currency_id:'ARS',unit_price:c.cents/100}],external_reference:id,back_urls:{success:origin+'/pagos.html',pending:origin+'/pagos.html',failure:origin+'/pagos.html'},auto_return:'approved',expires:true,expiration_date_to:new Date(Date.now()+86400000).toISOString()});
   let url;try{url=new URL(preference.init_point);}catch{fail(502,'No se recibió un enlace de pago válido.');}
   if(url.protocol!=='https:'||!['www.mercadopago.com.ar','mercadopago.com.ar'].includes(url.hostname)||!preference.id||!preference.collector_id)fail(502,'El proveedor no devolvió una preferencia válida para Argentina.');
   const r=await db.query("UPDATE clinic_orders SET preference_id=$1,checkout_url=$2,collector_id=$3,status='pending',updated_at=now() WHERE id=$4 RETURNING *",[String(preference.id),url.href,String(preference.collector_id),id]);return safe(r.rows[0]);
  }catch(e){await db.query("UPDATE clinic_orders SET status='error',updated_at=now() WHERE id=$1",[id]);throw e;}
 }
 async function applyPayment(order,payment){
  if(payment.external_reference!==order.id||String(payment.collector_id)!==order.collector_id||payment.currency_id!==order.currency||Math.round(Number(payment.transaction_amount)*100)!==order.amount_cents)fail(409,'El pago no coincide con esta orden. Contactá al soporte sin repetir el pago.');
  const status=['approved','pending','in_process','rejected','cancelled','refunded','charged_back','authorized'].includes(payment.status)?payment.status:'review';
  const approvedAt=Date.parse(payment.date_approved);if(status==='approved'&&!Number.isFinite(approvedAt))fail(502,'El proveedor no informó la fecha de aprobación.');
  const until=status==='approved'?new Date(approvedAt+30*86400000).toISOString():null;
  // Only a verified approval is bound permanently. A failed attempt must not hide a later approved retry.
  const paymentId=['approved','refunded','charged_back'].includes(status)?String(payment.id):null;
  const r=await db.query('UPDATE clinic_orders SET status=$1,payment_id=$2,valid_until=$3,updated_at=now() WHERE id=$4 RETURNING *',[status,paymentId,until,order.id]);return safe(r.rows[0]);
 }
 async function verify(userId,id){const order=(await db.query('SELECT * FROM clinic_orders WHERE id=$1 AND user_id=$2',[id,userId])).rows[0];if(!order)fail(404,'Orden no encontrada.');if(!order.preference_id)return safe(order);
  let payment;if(order.payment_id){payment=await mp('/v1/payments/'+encodeURIComponent(order.payment_id));}else{const found=await mp('/v1/payments/search?external_reference='+encodeURIComponent(id)+'&sort=date_created&criteria=desc&limit=50');const candidates=Array.isArray(found.results)?found.results:[];const match=candidates.find(p=>p.status==='approved')||candidates[0];if(!match)return safe(order);if(!/^\d+$/.test(String(match.id)))fail(502,'Respuesta de pago inválida.');payment=await mp('/v1/payments/'+match.id);}
  return applyPayment(order,payment);
 }

 // Webhook: the signature authenticates the notification, but the payment is always re-read from Mercado Pago before any state changes.
 function signatureValid({signature,requestId,dataId}){const secret=env.MERCADOPAGO_WEBHOOK_SECRET;if(!secret||typeof signature!=='string'||!dataId)return false;
  const parts=Object.fromEntries(signature.split(',').map(x=>x.trim().split('=')).filter(x=>x.length===2));if(!/^\d{10,13}$/.test(parts.ts||'')||!/^[a-f0-9]{64}$/.test(parts.v1||''))return false;
  const expected=createHmac('sha256',secret).update(`id:${String(dataId).toLowerCase()};request-id:${requestId||''};ts:${parts.ts};`).digest();return timingSafeEqual(expected,Buffer.from(parts.v1,'hex'));}
 async function reconcilePayment(paymentId){if(!/^\d{1,20}$/.test(String(paymentId)))fail(400,'Pago inválido.');const payment=await mp('/v1/payments/'+paymentId);
  const order=(await db.query('SELECT * FROM clinic_orders WHERE id=$1',[String(payment.external_reference||'')])).rows[0];if(!order)return {handled:false,reason:'unknown_order'};return {handled:true,order:await applyPayment(order,payment)};}
 async function webhook({signature,requestId,dataId,type}){
  if(!signatureValid({signature,requestId,dataId}))fail(401,'Firma inválida.');
  if(type&&type!=='payment')return {handled:false,reason:'ignored_type'};
  return reconcilePayment(dataId);
 }
 async function reconcilePending(){const rows=(await db.query("SELECT id,user_id FROM clinic_orders WHERE preference_id IS NOT NULL AND (status IN ('pending','in_process','authorized') OR (status='approved' AND valid_until>now())) AND updated_at<now()-interval '5 minutes' ORDER BY updated_at LIMIT 100")).rows;
  const summary={checked:0,changed:0,errors:0};for(const r of rows){summary.checked++;try{const before=(await db.query('SELECT status FROM clinic_orders WHERE id=$1',[r.id])).rows[0].status;const after=await verify(r.user_id,r.id);if(after.status!==before)summary.changed++;}catch{summary.errors++;}}return summary;}
 return {offer:()=>publicPaymentOffer(config()),orders,checkout,verify,webhook,reconcilePending};
}
