(function(global){
  "use strict";
  const esc=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function decode(s){
    return String(s||"").replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi,(entity,decimal,hex)=>{
      if(decimal)return String.fromCodePoint(Number(decimal));
      if(hex)return String.fromCodePoint(parseInt(hex,16));
      return({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&apos;":"'"})[entity.toLowerCase()]||entity;
    });
  }
  const norm=s=>decode(s).toLowerCase().normalize("NFKD").replace(/&/g," and ").replace(/[^\p{L}\p{N}]+/gu," ").trim();
  function sim(a,b){const A=new Set(norm(a).split(" ").filter(Boolean)),B=new Set(norm(b).split(" ").filter(Boolean));if(!A.size||!B.size)return 0;let n=0;A.forEach(x=>B.has(x)&&n++);return 2*n/(A.size+B.size);}
  function appearsInOriginal(original,value){const haystack=norm(original),needle=norm(value);return Boolean(needle&&haystack.includes(needle));}
  function block(text){return{text,rawText:text,html:esc(text),italics:[],bolds:[],page:null};}
  function pageForQuote(items,quote){
    const needle=norm(quote);if(!needle)return null;
    const found=(items||[]).find(item=>{const text=norm(item.text);return text&&(text.includes(needle)||needle.includes(text));});
    return found?.page||null;
  }
  function localAnalysis(body,referenceTexts,richBlocks,bodyBlocks){
    const blocks=richBlocks&&richBlocks.length===referenceTexts.length?richBlocks:referenceTexts.map(block);
    const parsed=blocks.map((b,i)=>{const p=parseReferenceEntry(b.text);if(p){p._idx=i;p.page=b.page||null;p.italics=b.italics||[];}return p;}).filter(Boolean);
    const refsByKey=new Map();parsed.forEach(p=>p.keys.forEach(k=>{if(!refsByKey.has(k))refsByKey.set(k,p);}));
    const citations=extractCitationsFromBody(body||"");
    const citeItems=citations.map(c=>({...c,keys:buildKeys(c.authors,c.etal,c.year)})).filter(c=>c.keys.length);
    const fullIssues=[];
    const seen=new Set();
    citeItems.forEach(c=>{const id=c.keys[0];if(seen.has(id))return;seen.add(id);if(!c.keys.some(k=>refsByKey.has(k)))fullIssues.push({tag:"引用缺失",quote:c.raw,page:pageForQuote(bodyBlocks,c.raw),desc:"正文中出现该作者与年份，但参考文献列表中没有匹配条目。"});});
    parsed.forEach(p=>{if(!citeItems.some(c=>c.keys.some(k=>p.keys.includes(k))))fullIssues.push({tag:"未被引用",quote:p.raw,page:p.page,desc:"该参考文献未在正文中被识别为已引用。"});});
    for(const c of detectInTextMismatches(citations,parsed,refsByKey)){if(c.tag!=="引用缺失"){const quote=c.quote||c.raw||"";fullIssues.push({tag:c.tag,quote,page:pageForQuote(bodyBlocks,quote)||pageForQuote(blocks,quote),desc:String(c.desc||"").replace(/<[^>]+>/g,"")});}}
    for(const c of [...detectInTextStructural(citations,parsed),...detectInTextStyleWarnings(citations,parsed)]){const quote=c.quote||c.raw||"";fullIssues.push({tag:c.tag,quote,page:pageForQuote(bodyBlocks,quote)||pageForQuote(blocks,quote),desc:String(c.desc||"").replace(/<[^>]+>/g,"")});}
    const globalItalic=blocks.some(b=>(b.italics||[]).length);
    const formatIssues=[];
    blocks.forEach((b,i)=>{const r=lintReference(b,globalItalic);(r.issues||[]).forEach(x=>formatIssues.push({tag:x.label||"格式问题",quote:b.text,page:b.page||null,desc:x.message||String(x)}));if(i&&parsed[i]&&parsed[i-1]&&refOrderKey(parsed[i])<refOrderKey(parsed[i-1]))formatIssues.push({tag:"字母顺序",quote:b.text,page:b.page||null,desc:`该条目按作者姓氏应排在上一条之前。`});});
    return{blocks,parsed,citations,fullIssues,formatIssues};
  }
  // 分布页只需要条目与正文引用。不要调用全文/格式规则，避免把 APA 规则模块
  // 变成图表分析的隐式依赖。
  function distributionAnalysis(body,referenceTexts,richBlocks){
    const blocks=richBlocks&&richBlocks.length===referenceTexts.length?richBlocks:referenceTexts.map(block);
    const parsed=blocks.map((b,i)=>{const p=parseReferenceEntry(b.text);if(p){p._idx=i;p.page=b.page||null;}return p;}).filter(Boolean);
    const citations=extractCitationsFromBody(body||"").map(c=>({...c,keys:buildKeys(c.authors,c.etal,c.year)})).filter(c=>c.keys.length);
    return{blocks,parsed,citations,fullIssues:[],formatIssues:[]};
  }
  function distribution(analysis){
    const citeMap=new Map();analysis.citations.forEach(c=>{const names=c.authors.map(a=>normalizeSpace(a.surname)).filter(Boolean);if(!names.length)return;const key=names.join("&").toLowerCase()+"|"+c.year;const label=names.length>2?`${names[0]} et al. (${c.year})`:names.join(" & ")+` (${c.year})`;const x=citeMap.get(key)||{label,count:0};x.count++;citeMap.set(key,x);});
    const years=analysis.parsed.map(p=>Number((p.year||"").match(/\d{4}/)?.[0])).filter(Boolean);
    const yearMap=new Map();years.forEach(y=>{const label=String(y);yearMap.set(label,(yearMap.get(label)||0)+1);});
    const journals=new Map();analysis.blocks.forEach(b=>{const m=b.text.match(/\)\.\s+.+?\.\s+(.+?),\s*\d+(?:\(\d+\))?,/);if(m){const name=m[1].trim(),key=norm(name);const x=journals.get(key)||{label:name,count:0};x.count++;journals.set(key,x);}});
    const countItems=values=>{const map=new Map();values.filter(Boolean).forEach(label=>map.set(label,(map.get(label)||0)+1));return[...map].map(([label,count])=>({label,count})).sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label));};
    const hasDoi=text=>/(?:doi\.org\/|doi:\s*)10\.\d{4,9}\//i.test(text);
    const inferType=text=>/\b(?:proceedings|conference|symposium)\b/i.test(text)?"会议论文":/\b(?:thesis|dissertation)\b|学位论文/i.test(text)?"学位论文":/https?:\/\/\S+/i.test(text)&&!hasDoi(text)&&!/\b\d+\s*\(\d+\)/.test(text)?"网页/在线资料":/\b(?:press|publisher|publishing)\b/i.test(text)&&!/\b\d+\s*\(\d+\)/.test(text)?"图书/章节":hasDoi(text)||/\b\d+\s*\(\d+\)\s*,\s*\d+/.test(text)?"期刊论文":"其他/待识别";
    const stop=new Set("about after again also among been being between can could data from have into more most other over paper papers research results such than that their these those through using were which with within study studies review based method methods analysis approach article articles journal university press https doi org".split(/\s+/));
    const keywords=text=>{const m=text.match(/\((?:19|20)\d{2}[a-z]?\)\.\s*(.+)/i),title=(m?(m[1].split(/\.\s+(?=[A-Z\u4e00-\u9fff])/)[0]||m[1]):text).replace(/https?:\/\/\S+|10\.\d{4,9}\/\S+/gi," ").toLowerCase();return[...(title.match(/[a-z][a-z-]{3,}/g)||[]),...(title.match(/[\u4e00-\u9fff]{2,6}/g)||[])].filter(word=>!stop.has(word)&&!/^[0-9]+$/.test(word));};
    const types=countItems(analysis.blocks.map(b=>inferType(b.text)));
    const coverage=[{label:"正文已引用",count:analysis.parsed.filter(ref=>analysis.citations.some(c=>c.keys?.some(k=>ref.keys?.includes(k)))).length},{label:"正文未识别引用",count:Math.max(0,analysis.parsed.length-analysis.parsed.filter(ref=>analysis.citations.some(c=>c.keys?.some(k=>ref.keys?.includes(k)))).length)}].filter(x=>x.count);
    const keywordItems=countItems(analysis.blocks.flatMap(b=>keywords(b.text)));
    return[
      {title:"文中引用按出现次数排序",subtitle:`共识别 ${citeMap.size} 个不同引用，总出现 ${[...citeMap.values()].reduce((s,x)=>s+x.count,0)} 次（同一作者+年份合并计数）。`,items:[...citeMap.values()].sort((a,b)=>b.count-a.count)},
      {title:"参考文献年份分布",subtitle:years.length?`共 ${years.length} 条参考文献含有效年份，年份跨度为 ${Math.min(...years)}–${Math.max(...years)}。`:"未识别到有效年份。",items:[...yearMap].map(([label,count])=>({label,count})).sort((a,b)=>Number(a.label)-Number(b.label))},
      {title:"参考文献中期刊名字出现次数排序",subtitle:`共识别 ${journals.size} 种期刊。`,items:[...journals.values()].sort((a,b)=>b.count-a.count)},
      {title:"文献类型分布",subtitle:"根据 DOI、卷期页码、出版社与网址等线索推断文献类型。",items:types},
      {title:"正文引用覆盖",subtitle:"统计参考文献是否在正文中被识别引用。",items:coverage},
      {title:"关键词分布",subtitle:"从参考文献标题与条目文本提取高频关键词，不等同于主题分类。",items:keywordItems}
    ];
  }
  function extractDOI(text){const m=String(text).match(/(?:doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[-._;()/:a-z0-9]+)/i);return m?m[1].replace(/[.,;)]$/,""):"";}
  function cross(x){return{title:x.title?.[0]||"",authors:(x.author||[]).map(a=>[a.given,a.family].filter(Boolean).join(" ")),year:String(x.issued?.["date-parts"]?.[0]?.[0]||x.published?.["date-parts"]?.[0]?.[0]||""),venue:x["container-title"]?.[0]||x.publisher||"",volume:x.volume||"",issue:x.issue||"",pages:x.page||"",doi:x.DOI||"",url:x.URL||"",source:"Crossref"};}
  function open(x){return{title:x.title||"",authors:(x.authorships||[]).map(a=>a.author?.display_name).filter(Boolean),year:String(x.publication_year||""),venue:x.primary_location?.source?.display_name||"",volume:x.biblio?.volume||"",issue:x.biblio?.issue||"",pages:[x.biblio?.first_page,x.biblio?.last_page].filter(Boolean).join("-")||"",doi:String(x.doi||"").replace(/^https:\/\/doi\.org\//i,""),url:x.doi||x.id||"",source:"OpenAlex"};}
  function sourceText(r){return[r.authors.join(" "),r.title,r.venue,r.year,r.volume,r.issue,r.pages,r.doi].join(" ");}
  function assess(original,r,sources){
    const doi=extractDOI(original),checks=[];
    const add=(label,value,ok)=>value&&checks.push({label,value,status:ok?"match":"mismatch"});
    add("题名",r.title,appearsInOriginal(original,r.title));add("作者",r.authors.slice(0,4).join("、"),r.authors.some(a=>norm(original).includes(norm(a).split(" ").pop())));add("年份",r.year,!r.year||original.includes(r.year));add("期刊或出版者",r.venue,appearsInOriginal(original,r.venue));add("卷",r.volume,!r.volume||new RegExp(`(?:vol\\.?\\s*)?${r.volume}(?:\\s*\\(|[,;:])`,`i`).test(original));add("期",r.issue,!r.issue||new RegExp(`\\(\\s*${r.issue}\\s*\\)|(?:no|issue)\\.?\\s*${r.issue}`,"i").test(original));add("页码或文章号",r.pages,!r.pages||original.replace(/[–—]/g,"-").includes(r.pages.replace(/[–—]/g,"-")));add("DOI",r.doi,!doi||norm(doi)===norm(r.doi));
    const review=checks.some(x=>x.status==="mismatch");return{original,record:r,checks,status:review?"review":"matched",score:checks.length?Math.round(checks.filter(x=>x.status==="match").length/checks.length*100):0,sources};
  }
  async function verifyOne(original){
    original=decode(original);
    const doi=extractDOI(original),sources=[];let candidates=[];
    try{const url=doi?`https://api.crossref.org/works/${encodeURIComponent(doi)}`:`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(original)}&rows=3`;const z=await fetch(url);if(z.ok){const j=await z.json(),xs=Array.isArray(j.message?.items)?j.message.items:[j.message];candidates.push(...xs.filter(Boolean).map(cross));if(xs.length)sources.push("Crossref");}}catch(e){}
    if(!candidates.length)try{const q=doi?`filter=doi:${encodeURIComponent(doi)}`:`search=${encodeURIComponent(original)}`;const z=await fetch(`https://api.openalex.org/works?${q}&per-page=3`);if(z.ok){const j=await z.json();candidates.push(...(j.results||[]).map(open));if(candidates.length)sources.push("OpenAlex");}}catch(e){}
    candidates.sort((a,b)=>sim(original,sourceText(b))-sim(original,sourceText(a)));
    return candidates[0]?assess(original,candidates[0],sources):{original,status:"unmatched",score:0,checks:[],sources:["Crossref","OpenAlex"],error:"未在当前公开索引中找到可信记录；这不等于文献不存在"};
  }
  async function verifyAll(refs,onProgress){const out=[];for(let i=0;i<refs.length;i++){onProgress?.(i,refs.length);out.push(await verifyOne(refs[i]));}onProgress?.(refs.length,refs.length);return out;}
  function combineParagraphs(group){
    let text="",html="";const italics=[],bolds=[];for(const p of group){const gap=text?1:0,base=text.length+gap;if(gap){text+=" ";html+=" ";}text+=p.text;html+=p.html;(p.italics||[]).forEach(([s,e])=>italics.push([s+base,e+base]));(p.bolds||[]).forEach(([s,e])=>bolds.push([s+base,e+base]));}return{text,rawText:text,html,italics,bolds,page:group[0]?.page||null};
  }
  async function parseDocx(file){
    const imported=await global.CitationDocxImporter.parse(file);
    const paras=imported.paragraphs;
    const full=paras.map(x=>x.text).join("\n");
    const sections=global.CitationReferenceSplitter.findDocumentSectionBounds(paras,p=>p&&p.text);
    if(!sections.found)return{body:"",references:full,text:full,bodyBlocks:[],referenceBlocks:global.CitationReferenceSplitter.groupReferenceLines(paras).map(combineParagraphs),footnoteCount:imported.footnoteCount,hasPageInfo:imported.hasPageInfo};
    const bodyParas=[...paras.slice(0,sections.headingIndex),...paras.slice(sections.appendixIndex)];
    const referenceParas=paras.slice(sections.referenceStart,sections.referenceEnd);
    const referenceBlocks=global.CitationReferenceSplitter.groupReferenceLines(referenceParas).map(combineParagraphs);
    return{body:bodyParas.map(x=>x.text).join("\n"),references:referenceBlocks.map(x=>x.text).join("\n\n"),bodyBlocks:bodyParas,referenceBlocks,text:full,footnoteCount:imported.footnoteCount,hasPageInfo:imported.hasPageInfo};
  }
  global.CitationReportEngine=Object.freeze({localAnalysis,distributionAnalysis,distribution,verifyAll,parseDocx});
})(window);
