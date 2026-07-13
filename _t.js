const path=require('path'),os=require('os'),fs=require('fs');
const {execFileSync}=require('child_process');
const {MongoMemoryServer}=require('mongodb-memory-server');
const APP=__dirname,PORT=4607,BASE=`http://127.0.0.1:${PORT}`;
let pass=0,fail=0;const ck=(n,c,d='')=>c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗',n,d));
async function main(){
  const mongo=await MongoMemoryServer.create();
  const keysDir=fs.mkdtempSync(path.join(os.tmpdir(),'k-'));
  execFileSync('node',[path.join(APP,'scripts','rotate-jwt-keys.js'),keysDir],{env:{...process.env,TOKEN_SECRET:'e2e'},stdio:'ignore'});
  Object.assign(process.env,{MONGO_URI:mongo.getUri(),PORT:String(PORT),KEYS_DIR:keysDir,TOKEN_SECRET:'e2e',ENCRYPTION_SECRET:'e'});
  process.chdir(APP);
  require(path.join(APP,'src','app.js'));
  await new Promise(r=>setTimeout(r,1500));
  const mongoose=require(path.join(APP,'node_modules','mongoose'));
  const post=async(p,b)=>{const r=await fetch(BASE+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});let d=null;try{d=await r.json()}catch{};return{status:r.status,data:d};};
  const base={firstName:'P',lastName:'W',username:'pw1',phone:'07',policyNumber:'PN1',policyType:'motor',Insurer:'AVE'};

  console.log('\n== Password policy enforced on register ==');
  const weak=await post('/customers/register',{...base,email:'a@x.com',password:'weak'});
  ck('weak password rejected (400)',weak.status===400,`got ${weak.status} ${JSON.stringify(weak.data)}`);
  ck('error explains requirement',/must contain/i.test(JSON.stringify(weak.data)));
  const strong=await post('/customers/register',{...base,email:'b@x.com',username:'pw2',policyNumber:'PN2',password:'Strong@123'});
  ck('strong password accepted (201)',strong.status===201,`got ${strong.status} ${JSON.stringify(strong.data).slice(0,100)}`);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  await mongoose.disconnect();await mongo.stop();fs.rmSync(keysDir,{recursive:true,force:true});process.exit(fail?1:0);
}
main().catch(e=>{console.error('FATAL',e);process.exit(2)});
