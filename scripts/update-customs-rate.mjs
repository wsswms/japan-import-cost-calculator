#!/usr/bin/env node

import {readFile,rename,stat,unlink,writeFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {resolve} from 'node:path';

import {
  nextMonth,
  parseHistoryText,
  parseChinaMoney,
  parseSafeHtml,
  queryWindow,
  reconcileRecords,
  updateHistoryText,
  updateHtmlRateData
} from './customs-rate-lib.mjs';

const DEFAULT_CHINA_MONEY_URL=
  'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew';
const DEFAULT_SAFE_URL=
  'https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do';

function parseArguments(argv){
  const options={
    root:process.cwd(),
    month:null,
    useNextMonth:false,
    preserveDefault:false
  };
  for(let index=0;index<argv.length;index++){
    const argument=argv[index];
    if(argument==='--month'){
      options.month=argv[++index];
    }else if(argument==='--root'){
      options.root=argv[++index];
    }else if(argument==='--next-month'){
      options.useNextMonth=true;
      continue;
    }else if(argument==='--preserve-default'){
      options.preserveDefault=true;
      continue;
    }else{
      throw new Error(`Unknown argument: ${argument}`);
    }
    if(options[argument.slice(2)]===undefined){
      throw new Error(`Missing value for ${argument}`);
    }
  }
  if(options.month&&options.useNextMonth){
    throw new Error('--month and --next-month cannot be used together');
  }
  const currentMonth=currentShanghaiMonth();
  return{
    month:options.useNextMonth?nextMonth(currentMonth):options.month??currentMonth,
    preserveDefault:options.preserveDefault,
    root:resolve(options.root)
  };
}

function currentShanghaiMonth(){
  const parts=new Intl.DateTimeFormat('en',{
    timeZone:'Asia/Shanghai',
    year:'numeric',
    month:'2-digit'
  }).formatToParts(new Date());
  const value=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return`${value.year}-${value.month}`;
}

function delay(milliseconds){
  return new Promise(resolveDelay=>setTimeout(resolveDelay,milliseconds));
}

async function requestWithRetry(url,body,responseType){
  let lastError;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const text=await postForm(url,body,responseType);
      return responseType==='json'?JSON.parse(text):text;
    }catch(error){
      lastError=error;
      if(attempt<3)await delay(1000*attempt);
    }
  }
  throw new Error(
    `Request failed for ${new URL(url).host}: ${describeError(lastError)}`
  );
}

function describeError(error){
  if(Array.isArray(error?.errors)){
    return error.errors.map(describeError).join('; ');
  }
  return[
    error?.code,
    error?.name,
    error?.message
  ].filter(Boolean).join(' ')||'unknown network error';
}

function postForm(url,body,responseType){
  return new Promise((resolveRequest,rejectRequest)=>{
    const target=new URL(url);
    const encoded=new URLSearchParams(body).toString();
    const request=target.protocol==='https:'?httpsRequest:httpRequest;
    const outgoing=request(target,{
      method:'POST',
      headers:{
        'user-agent':'japan-import-cost-calculator/1.0 (+https://github.com/wsswms/japan-import-cost-calculator)',
        accept:responseType==='json'?'application/json':'text/html,application/xhtml+xml',
        'content-type':'application/x-www-form-urlencoded',
        'content-length':Buffer.byteLength(encoded)
      },
      family:4,
      timeout:15000
    },response=>{
      let text='';
      response.setEncoding('utf8');
      response.on('data',chunk=>text+=chunk);
      response.on('end',()=>{
        if((response.statusCode??500)<200||(response.statusCode??500)>=300){
          rejectRequest(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        resolveRequest(text);
      });
    });
    outgoing.on('timeout',()=>outgoing.destroy(new Error('Request timed out')));
    outgoing.on('error',rejectRequest);
    outgoing.end(encoded);
  });
}

async function ignoreMissing(operation){
  try{
    await operation;
  }catch(error){
    if(error.code!=='ENOENT')throw error;
  }
}

async function replaceFilesSafely(files){
  if(!files.length)return;
  const token=`${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const states=await Promise.all(files.map(async(file,index)=>{
    const metadata=await stat(file.path);
    return{
      ...file,
      temp:`${file.path}.${token}-${index}.tmp`,
      backup:`${file.path}.${token}-${index}.bak`,
      mode:metadata.mode&0o777,
      backedUp:false,
      installed:false
    };
  }));
  const staged=await Promise.allSettled(states.map(state=>
    writeFile(state.temp,state.content,{encoding:'utf8',mode:state.mode})
  ));
  const stagingFailure=staged.find(result=>result.status==='rejected');
  if(stagingFailure){
    await Promise.all(states.map(state=>ignoreMissing(unlink(state.temp))));
    throw stagingFailure.reason;
  }
  try{
    for(const state of states){
      await rename(state.path,state.backup);
      state.backedUp=true;
    }
    for(const state of states){
      await rename(state.temp,state.path);
      state.installed=true;
    }
  }catch(error){
    for(const state of [...states].reverse()){
      if(state.installed)await ignoreMissing(unlink(state.path));
      if(state.backedUp)await rename(state.backup,state.path);
      await ignoreMissing(unlink(state.temp));
    }
    throw error;
  }
  await Promise.all(states.map(state=>ignoreMissing(unlink(state.backup))));
}

async function main(){
  const{month,preserveDefault,root}=parseArguments(process.argv.slice(2));
  const window=queryWindow(month);
  const common={
    startDate:window.startDate,
    endDate:window.endDate
  };
  const[chinaMoneyPayload,safeHtml]=await Promise.all([
    requestWithRetry(
      process.env.CHINA_MONEY_URL??DEFAULT_CHINA_MONEY_URL,
      {...common,currency:'100JPY/CNY',pageNum:'1',pageSize:'10'},
      'json'
    ),
    requestWithRetry(
      process.env.SAFE_URL??DEFAULT_SAFE_URL,
      {...common,queryYN:'true'},
      'text'
    )
  ]);
  const official=reconcileRecords(
    parseChinaMoney(chinaMoneyPayload),
    parseSafeHtml(safeHtml),
    window.startDate,
    window.endDate
  );
  const record={
    applicableMonth:month,
    date:official.date,
    rate:official.rate
  };
  const historyPath=resolve(root,'data/customs-rates.txt');
  const htmlPath=resolve(root,'index.html');
  const[history,html]=await Promise.all([
    readFile(historyPath,'utf8'),
    readFile(htmlPath,'utf8')
  ]);
  const nextHistory=updateHistoryText(history,record);
  const nextHtml=updateHtmlRateData(
    html,
    parseHistoryText(nextHistory),
    {preserveDefault}
  );
  const changed=nextHistory!==history||nextHtml!==html;
  const files=[];
  if(nextHistory!==history)files.push({path:historyPath,content:nextHistory});
  if(nextHtml!==html)files.push({path:htmlPath,content:nextHtml});
  await replaceFilesSafely(files);
  console.log(
    `month=${month} sourceDate=${official.date} rate=${official.rate} `+
    `changed=${changed} preserveDefault=${preserveDefault}`
  );
}

main().catch(error=>{
  console.error(`customs-rate update failed: ${error.message}`);
  process.exitCode=1;
});
