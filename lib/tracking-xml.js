'use strict';
// Lecteur XML restreint aux réponses du webservice public Chronopost.
// Pas de DTD, entités personnalisées, expansion externe ni exécution de code.
// Le document, sa profondeur et le nombre de nœuds sont bornés.
function parseTrackingXml(xml){
  if(typeof xml!=='string'||xml.length>1024*1024||/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml))throw new Error('XML invalide.');
  const decode=s=>String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,v)=>{
    if(v[0]!=='#')return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[v.toLowerCase()];
    const n=v[1]?.toLowerCase()==='x'?parseInt(v.slice(2),16):parseInt(v.slice(1),10);
    if(!n||n>0x10ffff||n>=0xd800&&n<=0xdfff)throw new Error('Entité XML invalide.');
    return String.fromCodePoint(n);
  });
  let pos=0,count=0,root=null;const stack=[];
  const add=(parent,name,value)=>{
    if(Object.prototype.hasOwnProperty.call(parent,name)){
      if(!Array.isArray(parent[name]))parent[name]=[parent[name]];
      parent[name].push(value);
    }else parent[name]=value;
  };
  while(pos<xml.length){
    if(xml.startsWith('<!--',pos)){
      const end=xml.indexOf('-->',pos+4);if(end<0)throw new Error('Commentaire XML incomplet.');pos=end+3;continue;
    }
    if(xml.startsWith('<?',pos)){
      const end=xml.indexOf('?>',pos+2);if(end<0)throw new Error('Instruction XML incomplète.');pos=end+2;continue;
    }
    if(xml.startsWith('<![CDATA[',pos)){
      const end=xml.indexOf(']]>',pos+9);if(end<0||!stack.length)throw new Error('CDATA XML invalide.');
      stack.at(-1).text+=xml.slice(pos+9,end);pos=end+3;continue;
    }
    if(xml[pos]==='<'){
      const end=xml.indexOf('>',pos+1);if(end<0)throw new Error('Balise XML incomplète.');
      const token=xml.slice(pos+1,end),closing=token.startsWith('/'),selfClosing=/\/\s*$/.test(token);
      const m=token.match(/^\/?([A-Za-z_][\w.:-]*)(?=\s|\/|$)/);
      if(!m)throw new Error('Balise XML invalide.');
      const fullName=m[1],name=fullName.split(':').at(-1);
      if(closing){
        const node=stack.pop();if(!node||node.fullName!==fullName||!/\s*$/.test(token.slice(m[0].length)))throw new Error('Balises XML non concordantes.');
        const value=Object.keys(node.children).length?node.children:node.text.trim();
        if(stack.length)add(stack.at(-1).children,name,value);else if(!root)root={[name]:value};else throw new Error('Plusieurs racines XML.');
      }else{
        if(++count>30000||stack.length>=64)throw new Error('XML trop complexe.');
        // Seuls les attributs XML ordinaires sont acceptés ; ils ne sont pas
        // utilisés pour fabriquer un statut de livraison.
        const attrs=token.slice(m[0].length).replace(/\/\s*$/,'');
        if(attrs&&!/^(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*$/.test(attrs))throw new Error('Attribut XML invalide.');
        const node={name,fullName,children:Object.create(null),text:''};stack.push(node);
        if(selfClosing){stack.pop();if(stack.length)add(stack.at(-1).children,name,'');else if(!root)root={[name]:''};else throw new Error('Plusieurs racines XML.');}
      }
      pos=end+1;continue;
    }
    const end=xml.indexOf('<',pos),next=end<0?xml.length:end,chunk=decode(xml.slice(pos,next));
    if(stack.length)stack.at(-1).text+=chunk;
    else if(chunk.trim())throw new Error('Texte hors racine XML.');
    pos=next;
  }
  if(stack.length||!root)throw new Error('Document XML incomplet.');
  return root;
}
module.exports={parseTrackingXml};
