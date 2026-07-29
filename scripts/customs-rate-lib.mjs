const MONTH=/^\d{4}-(0[1-9]|1[0-2])$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const RATE=/^\d+(\.\d+)?$/;

function isoDate(value){
  return value.toISOString().slice(0,10);
}

function validIsoDate(value){
  if(!DATE.test(value))return false;
  const parsed=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())&&isoDate(parsed)===value;
}

function normalize(date,rate){
  const cleanDate=String(date).trim();
  const cleanRate=String(rate).trim();
  if(!validIsoDate(cleanDate)||!RATE.test(cleanRate)){
    throw new Error('Invalid rate record');
  }
  const number=Number(cleanRate);
  if(!Number.isFinite(number)||number<=0){
    throw new Error('Invalid rate record');
  }
  return{date:cleanDate,rate:number.toFixed(4)};
}

function decodeHtml(value){
  const named={
    amp:'&',
    apos:"'",
    gt:'>',
    lt:'<',
    nbsp:' ',
    quot:'"'
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(match,entity)=>{
    if(entity[0]==='#'){
      const hex=entity[1].toLowerCase()==='x';
      const code=Number.parseInt(entity.slice(hex?2:1),hex?16:10);
      return Number.isFinite(code)?String.fromCodePoint(code):match;
    }
    return named[entity.toLowerCase()]??match;
  });
}

function cellText(value){
  const withoutComments=value.replace(/<!--[\s\S]*?-->/g,' ');
  return decodeHtml(withoutComments.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
}

function tableRows(table){
  return[...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row=>
    [...row[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
      .map(cell=>cellText(cell[2]))
  ).filter(row=>row.length);
}

export function queryWindow(applicableMonth){
  if(!MONTH.test(applicableMonth)){
    throw new Error('Invalid applicable month');
  }
  const[year,month]=applicableMonth.split('-').map(Number);
  const previous=new Date(Date.UTC(year,month-2,1));
  const offset=(3-previous.getUTCDay()+7)%7;
  const start=new Date(Date.UTC(
    previous.getUTCFullYear(),
    previous.getUTCMonth(),
    1+offset+14
  ));
  const end=new Date(start);
  end.setUTCDate(end.getUTCDate()+6);
  return{
    applicableMonth,
    startDate:isoDate(start),
    endDate:isoDate(end)
  };
}

export function parseChinaMoney(payload){
  if(payload?.head?.rep_code!=='200'||!Array.isArray(payload.records)){
    throw new Error('Invalid China Money response');
  }
  let records;
  try{
    records=payload.records.map(record=>{
      if(!Array.isArray(record?.values)||record.values.length!==1){
        throw new Error('Unexpected selected-currency values');
      }
      return normalize(record.date,record.values[0]);
    });
  }catch(error){
    throw new Error(`Invalid China Money response: ${error.message}`);
  }
  if(!records.length){
    throw new Error('Invalid China Money response: no records');
  }
  return records;
}

export function parseSafeHtml(html){
  if(typeof html!=='string'){
    throw new Error('Invalid SAFE response');
  }
  const candidates=[];
  for(const opening of html.matchAll(/<table\b[^>]*>/gi)){
    const end=html.toLowerCase().indexOf('</table>',opening.index+opening[0].length);
    if(end<0)continue;
    const table=html.slice(opening.index,end+'</table>'.length);
    const rows=tableRows(table);
    const headerIndex=rows.findIndex(row=>row.includes('日期')&&row.includes('日元'));
    if(headerIndex>=0)candidates.push({table,rows,headerIndex});
  }
  if(!candidates.length){
    throw new Error('Invalid SAFE response: required headers not found');
  }
  candidates.sort((left,right)=>left.table.length-right.table.length);
  const{rows,headerIndex}=candidates[0];
  const headers=rows[headerIndex];
  const dateIndex=headers.indexOf('日期');
  const rateIndex=headers.indexOf('日元');
  const records=[];
  for(const row of rows.slice(headerIndex+1)){
    if(!row[dateIndex]&&!row[rateIndex])continue;
    try{
      records.push(normalize(row[dateIndex],row[rateIndex]));
    }catch{
      continue;
    }
  }
  if(!records.length){
    throw new Error('Invalid SAFE response: no records');
  }
  return records;
}

export function selectApplicableRecord(records,startDate,endDate){
  if(
    !Array.isArray(records)||
    !validIsoDate(startDate)||
    !validIsoDate(endDate)||
    startDate>endDate
  ){
    throw new Error('Invalid applicable record query');
  }
  const selected=records
    .map(record=>normalize(record.date,record.rate))
    .sort((left,right)=>left.date.localeCompare(right.date))
    .find(record=>record.date>=startDate&&record.date<=endDate);
  if(!selected){
    throw new Error(`No applicable official record between ${startDate} and ${endDate}`);
  }
  return selected;
}

export function reconcileRecords(chinaMoneyRecords,safeRecords,startDate,endDate){
  const chinaMoney=selectApplicableRecord(chinaMoneyRecords,startDate,endDate);
  const safe=selectApplicableRecord(safeRecords,startDate,endDate);
  if(chinaMoney.date!==safe.date||chinaMoney.rate!==safe.rate){
    throw new Error(
      `Official sources disagree: China Money ${chinaMoney.date} ${chinaMoney.rate}; `+
      `SAFE ${safe.date} ${safe.rate}`
    );
  }
  return chinaMoney;
}

export function updateHistoryText(text,record){
  if(typeof text!=='string'||!MONTH.test(record?.applicableMonth)){
    throw new Error('Invalid customs rate history update');
  }
  const normalized=normalize(record.date,record.rate);
  const linePattern=/^(\d{4}-(?:0[1-9]|1[0-2])) \| (\d{4}-\d{2}-\d{2}) \| JPY \| (\d+\.\d{4})$/;
  const comments=[];
  const records=new Map();
  for(const line of text.split(/\r?\n/)){
    if(!line)continue;
    if(line.startsWith('#')){
      comments.push(line);
      continue;
    }
    const match=line.match(linePattern);
    if(!match){
      throw new Error(`Invalid customs rate history line: ${line}`);
    }
    records.set(match[1],{
      applicableMonth:match[1],
      date:match[2],
      rate:match[3]
    });
  }
  records.set(record.applicableMonth,{
    applicableMonth:record.applicableMonth,
    ...normalized
  });
  const data=[...records.values()]
    .sort((left,right)=>left.applicableMonth.localeCompare(right.applicableMonth))
    .map(value=>
      `${value.applicableMonth} | ${value.date} | JPY | ${value.rate}`
    );
  return[...comments,...data].join('\n')+'\n';
}

export function updateHtmlDefault(html,rate){
  if(typeof html!=='string'||!RATE.test(String(rate))){
    throw new Error('Invalid HTML customs rate update');
  }
  const normalized=Number(rate).toFixed(4);
  if(Number(normalized)<=0){
    throw new Error('Invalid HTML customs rate update');
  }
  const inputs=[...html.matchAll(/<input\b[^>]*>/gi)]
    .map(match=>match[0])
    .filter(input=>
      /\sid=["']customsRate["']/i.test(input)&&
      /\sdata-customs-rate-default=["'][^"']+["']/i.test(input)
    );
  if(inputs.length!==1){
    throw new Error('Expected exactly one marked customs-rate input');
  }
  const target=inputs[0];
  if(!/\svalue=["'][^"']+["']/i.test(target)){
    throw new Error('Marked customs-rate input has no value');
  }
  const updated=target
    .replace(/(\s)value=(["'])[^"']+\2/i,`$1value="${normalized}"`)
    .replace(
      /(\s)data-customs-rate-default=(["'])[^"']+\2/i,
      `$1data-customs-rate-default="${normalized}"`
    );
  return html.replace(target,updated);
}
