const path=require('path'),os=require('os'),fs=require('fs');
const {execFileSync}=require('child_process');
const {MongoMemoryServer}=require('mongodb-memory-server');
const APP=__dirname,PORT=4605,BASE=`http://127.0.0.1:${PORT}`;
let pass=0,fail=0;const ck=(n,c,d='')=>c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} -- ${d}`));
async function main(){
  const mongo=await MongoMemoryServer.create();
  const keysDir=fs.mkdtempSync(path.join(os.tmpdir(),'k-'));
  execFileSync('node',[path.join(APP,'scripts','rotate-jwt-keys.js'),keysDir],{env:{...process.env,TOKEN_SECRET:'e2e'},stdio:'ignore'});
  Object.assign(process.env,{MONGO_URI:mongo.getUri(),PORT:String(PORT),KEYS_DIR:keysDir,TOKEN_SECRET:'e2e',ENCRYPTION_SECRET:'e'});
  process.chdir(APP);
  require(path.join(APP,'src','app.js'));
  await new Promise(r=>setTimeout(r,1500));
  const mongoose=require(path.join(APP,'node_modules','mongoose'));
  const assessorService=require(path.join(APP,'src','service','assessor.service'));
  const post=async(p,b)=>{const r=await fetch(BASE+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});let d=null;try{d=await r.json()}catch{};return{status:r.status,data:d};};

  // Create via the fixed service (req can be undefined; writeAuditLog tolerates it).
  await assessorService.createAssessor({
    name:'Newly Created', email:'newass@ex.com', password:'Secret123',
    contactInfo:{phone:'0700',email:'newass@ex.com'}
  }, { headers:{}, method:'POST', originalUrl:'/assessors/create' });

  console.log('\n== Newly created assessor login ==');
  const wrong=await post('/assessors/login',{email:'newass@ex.com',password:'WRONG'});
  ck('wrong password -> 401',wrong.status===401,`got ${wrong.status}`);
  const good=await post('/assessors/login',{email:'newass@ex.com',password:'Secret123'});
  ck('correct password -> 200 + tokens (no double-hash)',good.status===200&&!!good.data.tokens,`got ${good.status} ${JSON.stringify(good.data).slice(0,120)}`);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  await mongoose.disconnect();await mongo.stop();fs.rmSync(keysDir,{recursive:true,force:true});
  process.exit(fail?1:0);
}
main().catch(e=>{console.error('FATAL',e);process.exit(2);});
