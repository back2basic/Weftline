// Only call with the listener's size-bounded raw bytes. JSON.parse establishes
// the grammar; this linear lexical pass checks decoded keys in every object.
export function parseGuardedJson(bytes) {
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  const value=JSON.parse(text);
  const stack=[];
  for(let i=0;i<text.length;i++) {
    const ch=text[i];
    if(ch==='"') {
      const start=i++;
      while(i<text.length && text[i]!=='"') {
        if(text[i]==='\\') i++;
        i++;
      }
      let next=i+1;
      while(next<text.length && (text[next]===' ' || text[next]==='\n' || text[next]==='\r' || text[next]==='\t')) next++;
      if(text[next]===':') {
        const keys=stack[stack.length-1];
        const key=JSON.parse(text.slice(start,i+1));
        if(!(keys instanceof Set) || keys.has(key)) throw Error('Duplicate JSON key');
        keys.add(key);
      }
    } else if(ch==='{') stack.push(new Set());
    else if(ch==='[') stack.push(null);
    else if(ch==='}' || ch===']') stack.pop();
  }
  return value;
}
