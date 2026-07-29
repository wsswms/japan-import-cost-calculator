import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';

import {
  parseHistoryText,
  parseChinaMoney,
  parseSafeHtml,
  queryWindow,
  reconcileRecords,
  selectApplicableRecord,
  updateHistoryText,
  updateHtmlDefault,
  updateHtmlRateData
} from '../scripts/customs-rate-lib.mjs';

const SAFE_FIXTURE = `<!doctype html>
<html><body>
<table id="ratesTable">
  <tr>
    <th>日期</th>
    <th>美元</th>
    <th>欧元</th>
    <th><!-- <s:property value="currency"/>&nbsp; -->日元</th>
  </tr>
  <tr>
    <td>2026-06-17</td>
    <td>680.96</td>
    <td>787.76</td>
    <td>4.2346</td>
  </tr>
</table>
</body></html>`;
const WORKFLOW=readFileSync(
  new URL('../.github/workflows/pages.yml',import.meta.url),
  'utf8'
);
const PAGE=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const HISTORY=`# 海关计征汇率历史
# 适用月份 | 取值日期 | 币种 | 人民币/100外币
2026-01 | 2025-12-17 | JPY | 4.5516
2026-06 | 2026-05-20 | JPY | 4.2961
2026-07 | 2026-06-17 | JPY | 4.2346
`;

function runCli(args,env={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['scripts/update-customs-rate.mjs',...args],{
      cwd:new URL('..',import.meta.url),
      env:{...process.env,...env}
    });
    let stdout='';
    let stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk);
    child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',reject);
    child.on('close',status=>resolve({status,stdout,stderr}));
  });
}

function temporaryProject(){
  const root=mkdtempSync(join(tmpdir(),'customs-rate-test-'));
  mkdirSync(join(root,'data'));
  writeFileSync(
    join(root,'index.html'),
    '<input id="customsRate" value="4.1847" data-customs-rate-default="4.1847">'+
    '<script type="application/json" id="customsRateHistory">[]</script>'
  );
  writeFileSync(
    join(root,'data/customs-rates.txt'),
    '# 海关计征汇率历史\n# 适用月份 | 取值日期 | 币种 | 人民币/100外币\n'
  );
  return root;
}

test('calculates the previous month third-Wednesday query window',()=>{
  assert.deepEqual(queryWindow('2026-07'),{
    applicableMonth:'2026-07',
    startDate:'2026-06-17',
    endDate:'2026-06-23'
  });
});

test('calculates the query window across a year boundary',()=>{
  assert.deepEqual(queryWindow('2026-01'),{
    applicableMonth:'2026-01',
    startDate:'2025-12-17',
    endDate:'2025-12-23'
  });
});

test('rejects an invalid applicable month',()=>{
  assert.throws(()=>queryWindow('2026-13'),/Invalid applicable month/);
});

test('parses the selected 100JPY/CNY China Money record',()=>{
  assert.deepEqual(parseChinaMoney({
    head:{rep_code:'200'},
    records:[{date:'2026-06-17',values:['4.2346']}]
  }),[{date:'2026-06-17',rate:'4.2346'}]);
});

test('rejects an unsuccessful or empty China Money response',()=>{
  assert.throws(
    ()=>parseChinaMoney({head:{rep_code:'500'},records:[]}),
    /China Money/
  );
  assert.throws(
    ()=>parseChinaMoney({head:{rep_code:'200'},records:[]}),
    /China Money/
  );
});

test('parses SAFE by its date and yen headers instead of fixed columns',()=>{
  assert.deepEqual(parseSafeHtml(SAFE_FIXTURE),[
    {date:'2026-06-17',rate:'4.2346'}
  ]);
});

test('rejects SAFE responses without the required headers',()=>{
  assert.throws(
    ()=>parseSafeHtml('<table id="InfoTable"><tr><th>日期</th><th>美元</th></tr></table>'),
    /SAFE/
  );
});

test('selects the first published record on or after the reference date',()=>{
  assert.deepEqual(selectApplicableRecord([
    {date:'2026-06-19',rate:'4.2000'},
    {date:'2026-06-18',rate:'4.2100'}
  ],'2026-06-17','2026-06-23'),{date:'2026-06-18',rate:'4.2100'});
});

test('rejects a query window without a published record',()=>{
  assert.throws(
    ()=>selectApplicableRecord([
      {date:'2026-06-16',rate:'4.2200'}
    ],'2026-06-17','2026-06-23'),
    /No applicable official record/
  );
});

test('rejects records after the query window and impossible dates',()=>{
  assert.throws(
    ()=>selectApplicableRecord([
      {date:'2026-07-01',rate:'4.2200'}
    ],'2026-06-17','2026-06-23'),
    /No applicable official record/
  );
  assert.throws(
    ()=>parseChinaMoney({
      head:{rep_code:'200'},
      records:[{date:'2026-02-30',values:['4.2200']}]
    }),
    /China Money/
  );
});

test('accepts official records only when date and rate agree',()=>{
  assert.deepEqual(reconcileRecords(
    [{date:'2026-06-17',rate:'4.2346'}],
    [{date:'2026-06-17',rate:'4.2346'}],
    '2026-06-17',
    '2026-06-23'
  ),{date:'2026-06-17',rate:'4.2346'});

  assert.throws(
    ()=>reconcileRecords(
      [{date:'2026-06-17',rate:'4.2346'}],
      [{date:'2026-06-17',rate:'4.2347'}],
      '2026-06-17',
      '2026-06-23'
    ),
    /Official sources disagree/
  );
});

test('adds, sorts, replaces, and deduplicates customs rate history',()=>{
  const initial='# 海关计征汇率历史\n# 适用月份 | 取值日期 | 币种 | 人民币/100外币\n';
  const august=updateHistoryText(initial,{
    applicableMonth:'2026-08',
    date:'2026-07-15',
    rate:'4.1847'
  });
  const july=updateHistoryText(august,{
    applicableMonth:'2026-07',
    date:'2026-06-17',
    rate:'4.2346'
  });

  assert.match(july,/2026-07 \| 2026-06-17 \| JPY \| 4\.2346/);
  assert.ok(july.indexOf('2026-07')<july.indexOf('2026-08'));
  assert.equal(updateHistoryText(july,{
    applicableMonth:'2026-07',
    date:'2026-06-17',
    rate:'4.2346'
  }),july);

  const replaced=updateHistoryText(july,{
    applicableMonth:'2026-07',
    date:'2026-06-18',
    rate:'4.2000'
  });
  assert.doesNotMatch(replaced,/2026-06-17/);
  assert.equal((replaced.match(/^2026-07 /gm)||[]).length,1);
});

test('rejects malformed existing customs rate history',()=>{
  assert.throws(
    ()=>updateHistoryText('# history\nnot a valid record\n',{
      applicableMonth:'2026-07',
      date:'2026-06-17',
      rate:'4.2346'
    }),
    /Invalid customs rate history/
  );
});

test('parses validated customs rate history records',()=>{
  assert.deepEqual(parseHistoryText(HISTORY),[
    {month:'2026-01',date:'2025-12-17',rate:'4.5516'},
    {month:'2026-06',date:'2026-05-20',rate:'4.2961'},
    {month:'2026-07',date:'2026-06-17',rate:'4.2346'}
  ]);
});

test('embeds complete history and keeps the newest month as the page default',()=>{
  const html='<input id="customsRate" value="4.1847" '+
    'data-customs-rate-default="4.1847">'+
    '<script type="application/json" id="customsRateHistory">[]</script>';
  const records=parseHistoryText(HISTORY);
  const updated=updateHtmlRateData(html,records);

  assert.match(updated,/value="4\.2346"/);
  assert.match(updated,/data-customs-rate-default="4\.2346"/);
  assert.match(
    updated,
    /id="customsRateHistory">\[{"month":"2026-01","date":"2025-12-17","rate":"4.5516"},/
  );
  assert.match(updated,/"month":"2026-07","date":"2026-06-17","rate":"4.2346"}\]<\/script>/);
});

test('backfilling an older month does not roll back the page default',()=>{
  const withOlderMonth=updateHistoryText(HISTORY,{
    applicableMonth:'2026-02',
    date:'2026-01-21',
    rate:'4.4095'
  });
  const html='<input id="customsRate" value="4.2346" '+
    'data-customs-rate-default="4.2346">'+
    '<script type="application/json" id="customsRateHistory">[]</script>';
  const updated=updateHtmlRateData(html,parseHistoryText(withOlderMonth));

  assert.match(updated,/value="4\.2346"/);
  assert.match(updated,/"month":"2026-02","date":"2026-01-21","rate":"4.4095"/);
});

test('updates only the marked customs-rate input defaults',()=>{
  const html='<input value="4.1847" id="other">'+
    '<input id="customsRate" type="number" value="4.1847" '+
    'data-customs-rate-default="4.1847"><span>4.1847</span>';
  const updated=updateHtmlDefault(html,'4.2346');

  assert.match(updated,/id="customsRate"[^>]*value="4\.2346"/);
  assert.match(updated,/data-customs-rate-default="4\.2346"/);
  assert.match(updated,/id="other"/);
  assert.match(updated,/<span>4\.1847<\/span>/);
});

test('requires exactly one marked customs-rate input',()=>{
  assert.throws(()=>updateHtmlDefault('<input id="customsRate">','4.2346'),/exactly one/);
  const marked='<input id="customsRate" value="4.1" data-customs-rate-default="4.1">';
  assert.throws(()=>updateHtmlDefault(marked+marked,'4.2346'),/exactly one/);
});

test('does not confuse data-value with the input value attribute',()=>{
  const html='<input id="customsRate" data-value="keep" value="4.1847" '+
    'data-customs-rate-default="4.1847">';
  const updated=updateHtmlDefault(html,'4.2346');
  assert.match(updated,/data-value="keep"/);
  assert.match(updated,/\svalue="4\.2346"/);
});

test('CLI cross-checks both official publishers before updating files',async()=>{
  const requests=[];
  const server=createServer((request,response)=>{
    let body='';
    request.setEncoding('utf8');
    request.on('data',chunk=>body+=chunk);
    request.on('end',()=>{
      requests.push({
        url:request.url,
        method:request.method,
        headers:request.headers,
        body
      });
      if(request.url==='/china-money'){
        response.setHeader('content-type','application/json');
        response.end(JSON.stringify({
          head:{rep_code:'200'},
          records:[{date:'2026-06-17',values:['4.2346']}]
        }));
        return;
      }
      if(request.url==='/safe'){
        response.setHeader('content-type','text/html;charset=utf-8');
        response.end(SAFE_FIXTURE);
        return;
      }
      response.statusCode=404;
      response.end();
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=temporaryProject();
  try{
    const {port}=server.address();
    const result=await runCli(['--month','2026-07','--root',root],{
      CHINA_MONEY_URL:`http://127.0.0.1:${port}/china-money`,
      SAFE_URL:`http://127.0.0.1:${port}/safe`
    });

    assert.equal(result.status,0,result.stderr);
    assert.match(
      result.stdout,
      /month=2026-07 sourceDate=2026-06-17 rate=4\.2346 changed=true/
    );
    assert.match(
      readFileSync(join(root,'data/customs-rates.txt'),'utf8'),
      /2026-07 \| 2026-06-17 \| JPY \| 4\.2346/
    );
    assert.match(
      readFileSync(join(root,'index.html'),'utf8'),
      /data-customs-rate-default="4\.2346"/
    );
    assert.match(
      readFileSync(join(root,'index.html'),'utf8'),
      /id="customsRateHistory">\[{"month":"2026-07","date":"2026-06-17","rate":"4.2346"}\]<\/script>/
    );
  assert.deepEqual(requests.map(request=>request.method),['POST','POST']);
  assert.match(requests[0].headers['user-agent'],/japan-import-cost-calculator/);
  assert.match(requests[1].headers.accept,/text\/html/);
    assert.match(requests[0].body,/currency=100JPY%2FCNY/);
    assert.match(requests[1].body,/startDate=2026-06-17/);
    assert.match(requests[1].body,/endDate=2026-06-23/);
    assert.match(requests[1].body,/queryYN=true/);
  }finally{
    rmSync(root,{recursive:true,force:true});
    await new Promise(resolve=>server.close(resolve));
  }
});

test('CLI leaves both files unchanged when official publishers disagree',async()=>{
  const server=createServer((request,response)=>{
    request.resume();
    request.on('end',()=>{
      if(request.url==='/china-money'){
        response.setHeader('content-type','application/json');
        response.end(JSON.stringify({
          head:{rep_code:'200'},
          records:[{date:'2026-06-17',values:['4.2346']}]
        }));
        return;
      }
      response.setHeader('content-type','text/html;charset=utf-8');
      response.end(SAFE_FIXTURE.replace('4.2346</td>','4.2347</td>'));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=temporaryProject();
  const historyPath=join(root,'data/customs-rates.txt');
  const htmlPath=join(root,'index.html');
  const originalHistory=readFileSync(historyPath,'utf8');
  const originalHtml=readFileSync(htmlPath,'utf8');
  try{
    const {port}=server.address();
    const result=await runCli(['--month','2026-07','--root',root],{
      CHINA_MONEY_URL:`http://127.0.0.1:${port}/china-money`,
      SAFE_URL:`http://127.0.0.1:${port}/safe`
    });

    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Official sources disagree/);
    assert.equal(readFileSync(historyPath,'utf8'),originalHistory);
    assert.equal(readFileSync(htmlPath,'utf8'),originalHtml);
  }finally{
    rmSync(root,{recursive:true,force:true});
    await new Promise(resolve=>server.close(resolve));
  }
});

test('CLI leaves both targets unchanged when one staged write fails',async()=>{
  const server=createServer((request,response)=>{
    request.resume();
    request.on('end',()=>{
      if(request.url==='/china-money'){
        response.setHeader('content-type','application/json');
        response.end(JSON.stringify({
          head:{rep_code:'200'},
          records:[{date:'2026-06-17',values:['4.2346']}]
        }));
        return;
      }
      response.setHeader('content-type','text/html;charset=utf-8');
      response.end(SAFE_FIXTURE);
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=temporaryProject();
  const dataDirectory=join(root,'data');
  const historyPath=join(root,'data/customs-rates.txt');
  const htmlPath=join(root,'index.html');
  const originalHistory=readFileSync(historyPath,'utf8');
  const originalHtml=readFileSync(htmlPath,'utf8');
  chmodSync(historyPath,0o400);
  chmodSync(dataDirectory,0o500);
  try{
    const {port}=server.address();
    const result=await runCli(['--month','2026-07','--root',root],{
      CHINA_MONEY_URL:`http://127.0.0.1:${port}/china-money`,
      SAFE_URL:`http://127.0.0.1:${port}/safe`
    });

    assert.notEqual(result.status,0);
    assert.equal(readFileSync(historyPath,'utf8'),originalHistory);
    assert.equal(readFileSync(htmlPath,'utf8'),originalHtml);
  }finally{
    chmodSync(dataDirectory,0o700);
    chmodSync(historyPath,0o600);
    rmSync(root,{recursive:true,force:true});
    await new Promise(resolve=>server.close(resolve));
  }
});

test('Pages workflow exposes scheduled and manual customs-rate updates',()=>{
  assert.match(WORKFLOW,/cron: ['"]17 8 1 \* \*['"]/);
  assert.match(WORKFLOW,/timezone:\s*Asia\/Shanghai/);
  assert.match(WORKFLOW,/update_customs_rate:/);
  assert.match(WORKFLOW,/applicable_month:/);
  assert.match(WORKFLOW,/commit_changes:/);
  assert.match(WORKFLOW,/deploy:/);
  assert.match(WORKFLOW,/permissions:\s*[\s\S]*?contents:\s*write/);
  assert.match(WORKFLOW,/node --test tests\/\*\.test\.mjs/);
  assert.match(WORKFLOW,/node scripts\/update-customs-rate\.mjs/);
  assert.match(WORKFLOW,/github-actions\[bot\]/);
});

test('Pages deployment checks out the updated ref and honors manual opt-out',()=>{
  assert.match(WORKFLOW,/ref:\s*\$\{\{ github\.ref_name \}\}/);
  assert.match(WORKFLOW,/deploy:[\s\S]*?default:\s*false/);
  assert.match(
    WORKFLOW,
    /github\.event_name == 'workflow_dispatch'[\s\S]*inputs\.deploy/
  );
  assert.match(
    WORKFLOW,
    /github\.ref_name == github\.event\.repository\.default_branch/
  );
  const deployJob=WORKFLOW.slice(WORKFLOW.indexOf('\n  deploy:'));
  assert.doesNotMatch(deployJob,/github\.event_name == 'schedule'/);
});

test('workflow preserves rate updates and serializes all Pages deployments',()=>{
  const beforeJobs=WORKFLOW.slice(0,WORKFLOW.indexOf('\njobs:'));
  const deployJob=WORKFLOW.slice(WORKFLOW.indexOf('\n  deploy:'));
  assert.doesNotMatch(beforeJobs,/concurrency:/);
  assert.match(deployJob,/concurrency:\s*[\s\S]*?group:\s*pages/);
  assert.match(deployJob,/cancel-in-progress:\s*false/);
});

function historyQueryScript(){
  const scripts=[...PAGE.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match=>match[1]);
  const script=scripts.find(source=>source.includes('customsRateHistoryMonth'));
  assert.ok(script,'customs rate history query script should exist');
  return script;
}

function renderHistoryQuery(payload){
  let changeListener;
  const nodes={
    customsRateHistory:{textContent:payload},
    customsRateHistoryMonth:{
      innerHTML:'',
      value:'',
      disabled:false,
      addEventListener:(name,listener)=>{
        if(name==='change')changeListener=listener;
      }
    },
    customsRateHistoryRate:{textContent:''},
    customsRateHistoryDate:{
      textContent:'',
      dateTime:'',
      removeAttribute(name){
        if(name==='datetime')this.dateTime='';
      }
    },
    customsRateHistoryStatus:{textContent:''},
    customsRate:{value:'9.9999'}
  };
  vm.runInNewContext(historyQueryScript(),{
    document:{getElementById:id=>nodes[id]??null}
  });
  return{
    nodes,
    selectMonth(month){
      nodes.customsRateHistoryMonth.value=month;
      changeListener();
    }
  };
}

test('history query renders newest-first options and the latest official record',()=>{
  const query=renderHistoryQuery(JSON.stringify(parseHistoryText(HISTORY)));

  assert.ok(
    query.nodes.customsRateHistoryMonth.innerHTML.indexOf('2026年7月')<
      query.nodes.customsRateHistoryMonth.innerHTML.indexOf('2026年6月')
  );
  assert.equal(query.nodes.customsRateHistoryMonth.value,'2026-07');
  assert.equal(query.nodes.customsRateHistoryRate.textContent,'4.2346 人民币/100日元');
  assert.equal(query.nodes.customsRateHistoryDate.textContent,'2026年6月17日');
  assert.equal(query.nodes.customsRateHistoryDate.dateTime,'2026-06-17');
});

test('history query changes displayed records without changing calculator state',()=>{
  const query=renderHistoryQuery(JSON.stringify(parseHistoryText(HISTORY)));
  query.selectMonth('2026-01');

  assert.equal(query.nodes.customsRateHistoryRate.textContent,'4.5516 人民币/100日元');
  assert.equal(query.nodes.customsRateHistoryDate.textContent,'2025年12月17日');
  assert.equal(query.nodes.customsRate.value,'9.9999');
});

test('history query handles empty and malformed embedded data',()=>{
  for(const payload of ['[]','not-json']){
    const query=renderHistoryQuery(payload);
    assert.equal(query.nodes.customsRateHistoryMonth.disabled,true);
    assert.match(query.nodes.customsRateHistoryStatus.textContent,/暂无可用/);
    assert.equal(query.nodes.customsRateHistoryRate.textContent,'—');
    assert.equal(query.nodes.customsRateHistoryDate.textContent,'—');
  }
});
