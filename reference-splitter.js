(function(global){
  "use strict";

  const MIN_REFERENCE_LENGTH=8;
  const DATE_RE=/\((?:19|20)\d{2}[a-z]?\)/i;
  const SURNAME="(?:\\p{Lu}[\\p{L}\\p{M}'’\\p{Pd}]*|de|van|von|der|den|dem|ter|ten|la|du|des|del|da|dos|y)(?:\\s+(?:\\p{Lu}[\\p{L}\\p{M}'’\\p{Pd}]*|de|van|von|der|den|dem|ter|ten|la|du|des|del|da|dos|y)){0,5}";
  const INITIAL="\\p{Lu}\\p{M}*\\.";
  // S.-K. 等带连接号的名字首字母仍属于同一作者。
  const AUTHOR=SURNAME+"\\s*,\\s*"+INITIAL+"(?:\\s*(?:\\p{Pd}\\s*)?"+INITIAL+"){0,5}\\s*";
  const AUTHOR_START_RE=new RegExp("^"+AUTHOR,"u");
  // 长作者名单中的省略号也属于作者分隔符，不能让最后一位作者
  // 单独产生起点，或让跨行年份导致整条文献并入上一条。
  const AUTHOR_SEPARATOR="(?:,\\s*(?:&\\s*|(?:\\.\\s*){3}|…\\s*)?|&\\s*|and\\s*|(?:\\.\\s*){3}|…\\s*)";
  const AUTHOR_DATE_RE=new RegExp("(^|\\s)("+AUTHOR+"(?:"+AUTHOR_SEPARATOR+AUTHOR+")*\\s*\\((?:19|20)\\d{2}[a-z]?\\))","gu");

  // 完整作者名单只产生一个起点，避免把 Barnett 等合作者拆成新文献。
  function referenceStartOffsets(text=""){
    const source=String(text),offsets=[];
    AUTHOR_DATE_RE.lastIndex=0;
    let match;
    while((match=AUTHOR_DATE_RE.exec(source)))offsets.push(match.index+match[1].length);
    return offsets;
  }
  // 卷号可能单独换行成“49. https://doi.org/...”，它是上一条文献的
  // 延续，不能据此把整份作者—年份列表切换成编号列表。
  const NUMBERED_REFERENCE_RE=/^[ \t]*\d{1,3}[.)]\s+(?!https?:\/\/|doi\b|10\.\d{4,9}\/)(?=\S)/i;
  const REFERENCE_HEADING_RE=/^[ \t#*0-9.)\-–—]*(?:references?|reference\s+list|works\s+cited|works\s+consulted|sources?|bibliograph(?:y|ies)|literature\s+cited|参考文献|参考资料)[ \t.:：·•0-9\-–—]*$/i;

  function normalizeBreaks(text=""){
    return String(text)
      .replace(/\r\n?/g,"\n")
      .replace(/([\p{L}\p{N}])-\n([\p{L}\p{N}])/gu,"$1-$2");
  }

  function isLikelyReferenceStart(line=""){
    const text=String(line).trim();
    if(!text)return false;
    if(/^\[\d+\]\s+/.test(text)||NUMBERED_REFERENCE_RE.test(text))return true;
    // DOI 和 URL 路径中的四位数字不是作者后的出版年份。
    // 例如“System, 109. doi:10.1016/j.system.2022.102870”是期刊续行。
    const header=text.replace(/(?:https?:\/\/|doi\s*:\s*|10\.\d{4,9}\/)[^\s]+/gi, "");
    const hasYear=/(?:^|[\s(,.;])(?:19|20)\d{2}[a-z]?(?:[\s),.;:]|$)/i.test(header);
    if(!hasYear)return false;
    return /^(?:[A-Z\p{Lu}][\p{L}\p{M}'’.\p{Pd}]+(?:\s+[A-Z\p{Lu}][\p{L}\p{M}'’.\p{Pd}]+){0,5}\s*,|[A-Z\p{Lu}][\p{L}\p{M}'’.\p{Pd}]+\s+(?:[A-Z]\.?\s*){1,4}(?:,|\s)|[^.!?\n]{2,120}\.\s*\((?:19|20)\d{2}|[\p{Script=Han}]{2,}(?:[，,、]|\s))/u.test(text);
  }

  function isReferenceHeading(line=""){
    return REFERENCE_HEADING_RE.test(String(line||"").trim());
  }

  function isReferenceEndHeading(line=""){
    const text=String(line).replace(/\s+/g," ").trim();
    if(!text||text.length>90)return false;
    // 附录编号后可直接接标题，如“Appendix A Interview protocol”。
    if(/^(?:\d+[.)]\s*)?(?:appendix|appendices|appendixes)(?:\s+(?:[A-Z]|\d+|[IVX]+)(?:\s+[^.!?]{1,60})?)?(?:\s*[:.\-–—]\s*[^.!?]{1,60})?$/i.test(text))return true;
    return /^(?:\d+[.)]\s*)?附录(?:\s*[A-Z0-9IVX一二三四五六七八九十]+)?(?:\s*[:：.\-–—]\s*[^。！？]{1,60})?$/.test(text);
  }

  function referenceEndOffset(text=""){
    const source=String(text),lines=source.split("\n");
    let offset=0;
    for(const line of lines){
      if(isReferenceEndHeading(line))return offset;
      offset+=line.length+1;
    }
    return source.length;
  }

  // 对纯文本行、Word 段落和 PDF 行统一返回分段边界。
  function findDocumentSectionBounds(items=[],getText=item=>item&&item.text||""){
    const list=Array.isArray(items)?items:[];
    let headingIndex=-1;
    for(let i=list.length-1;i>=0;i--){
      const text=String(getText(list[i])||"").trim();
      if(text.length<=60&&isReferenceHeading(text)){headingIndex=i;break;}
    }
    if(headingIndex<0)return{found:false,headingIndex:-1,referenceStart:-1,referenceEnd:list.length,appendixIndex:-1};
    let appendixIndex=list.length;
    for(let i=headingIndex+1;i<list.length;i++){
      if(isReferenceEndHeading(getText(list[i]))){appendixIndex=i;break;}
    }
    return{found:true,headingIndex,referenceStart:headingIndex+1,referenceEnd:appendixIndex,appendixIndex};
  }

  function splitReferences(text=""){
    const source=normalizeBreaks(text);
    const bracketed=source.match(/(?:^|\n|\s)\[\d+\]\s+/g);
    if(bracketed&&bracketed.length>=2){
      return source.split(/(?:^|\n|\s)\[\d+\]\s+/).map(x=>x.trim()).filter(x=>x.length>=MIN_REFERENCE_LENGTH);
    }
    const numbered=source.match(new RegExp(NUMBERED_REFERENCE_RE.source,"gim"));
    if(numbered&&numbered.length>=2){
      return source.split(new RegExp(NUMBERED_REFERENCE_RE.source,"gim")).map(x=>x.trim()).filter(x=>x.length>=MIN_REFERENCE_LENGTH);
    }
    if(/\n\s*\n/.test(source)){
      return source.split(/\n\s*\n/).map(x=>x.trim()).filter(x=>x.length>=MIN_REFERENCE_LENGTH);
    }

    const out=[];
    let current=null;
    for(const rawLine of source.split("\n")){
      const line=rawLine.trim();
      if(!line)continue;
      if(/^(?:\[\d+\]|\d{1,3}[.)]?)\s*$/.test(line)){
        if(current!==null){out.push(current);current=null;}
        continue;
      }
      if(current===null){current=line;continue;}
      const indented=/^\s/.test(rawLine);
      if(!indented&&isLikelyReferenceStart(line)){out.push(current);current=line;}
      else current+=" "+line;
    }
    if(current!==null)out.push(current);

    let result=out.filter(x=>x.length>=MIN_REFERENCE_LENGTH);
    if(result.length<=1&&source.length>250){
      const cuts=[];
      const startRe=/([\s>\]})"']|^)((?:\d{1,3}[.)]\s|\[\d+\]\s)?[A-Z][a-z'’.-]+(?:-[A-Z][a-z]+)?,\s+(?:[A-Z]|\())/g;
      let match;
      while((match=startRe.exec(source))){
        const position=match.index+match[1].length;
        if(position>0)cuts.push(position);
      }
      if(cuts.length){
        const parts=[];
        let start=0;
        for(const cut of cuts){parts.push(source.slice(start,cut).trim());start=cut;}
        parts.push(source.slice(start).trim());
        const candidates=parts.filter(x=>x.length>=MIN_REFERENCE_LENGTH);
        if(candidates.length>1)result=candidates;
      }
    }
    return result;
  }

  function splitDocumentSections(text=""){
    const source=normalizeBreaks(text);
    const lines=source.split("\n");
    const bounds=findDocumentSectionBounds(lines,line=>line);
    if(!bounds.found)return{found:false,body:"",references:source.trim(),heading:"",appendix:"",bounds};
    const lineOffset=index=>lines.slice(0,index).reduce((n,line)=>n+line.length+1,0);
    const headingStart=lineOffset(bounds.headingIndex);
    const referenceStart=lineOffset(bounds.referenceStart);
    const referenceEnd=lineOffset(bounds.referenceEnd);
    const bodyParts=[source.slice(0,headingStart),bounds.appendixIndex<lines.length?source.slice(referenceEnd):""]
      .map(x=>x.trim()).filter(Boolean);
    return{
      found:true,
      body:bodyParts.join("\n\n"),
      references:source.slice(referenceStart,referenceEnd).trim(),
      appendix:bounds.appendixIndex<lines.length?source.slice(referenceEnd).trim():"",
      heading:lines[bounds.headingIndex].trim(),
      bounds
    };
  }

  // 富文本编辑器使用：返回原对象组成的条目组，从而保留斜体、粗体和页码。
  function groupReferenceLines(items=[],getText=item=>item&&item.text||""){
    const prepared=items.map(item=>({item,text:String(getText(item)||"").replace(/\s+/g," ").trim()}));
    const nonEmpty=prepared.filter(x=>x.text);
    if(!nonEmpty.length)return[];
    const bracketMode=nonEmpty.filter(x=>/^\[\d+\]\s+/.test(x.text)).length>=2;
    const numberMode=!bracketMode&&nonEmpty.filter(x=>NUMBERED_REFERENCE_RE.test(x.text)).length>=2;
    const blankMode=!bracketMode&&!numberMode&&prepared.some(x=>!x.text);
    const groups=[];
    let current=[];
    const flush=()=>{
      if(current.length&&current.map(x=>x.text).join(" ").length>=MIN_REFERENCE_LENGTH)groups.push(current.map(x=>x.item));
      current=[];
    };
    for(let index=0;index<prepared.length;index++){
      const entry=prepared[index];
      if(!entry.text){if(blankMode)flush();continue;}
      if(/^(?:\[\d+\]|\d{1,3}[.)]?)\s*$/.test(entry.text)){flush();continue;}
      let starts=false;
      if(bracketMode)starts=/^\[\d+\]\s+/.test(entry.text);
      else if(numberMode)starts=NUMBERED_REFERENCE_RE.test(entry.text);
      else if(!blankMode){
        starts=isLikelyReferenceStart(entry.text);
        if(!starts&&AUTHOR_START_RE.test(entry.text)){
          const header=prepared.slice(index,index+8).map(x=>x.text).join(" ").slice(0,1200);
          starts=referenceStartOffsets(header)[0]===0;
        }
      }
      const previous=current.length?current[current.length-1].text:"";
      // 作者名单未读到年份时，下一行仍属于该名单。已读到年份后，
      // 题名/卷期行末的逗号不能阻止下一条参考文献开始。
      const currentText=current.map(x=>x.text).join(" ");
      const authorListContinues=!bracketMode&&!numberMode&&!DATE_RE.test(currentText)&&
        (AUTHOR_START_RE.test(currentText)||/(?:[,&]|\band)\s*$/i.test(previous));
      if(current.length&&starts&&!authorListContinues)flush();
      current.push(entry);
    }
    flush();
    return groups;
  }

  global.CitationReferenceSplitter=Object.freeze({
    MIN_REFERENCE_LENGTH,
    normalizeBreaks,
    isLikelyReferenceStart,
    referenceStartOffsets,
    isReferenceHeading,
    isReferenceEndHeading,
    findDocumentSectionBounds,
    splitReferences,
    splitDocumentSections,
    groupReferenceLines
  });
})(window);
