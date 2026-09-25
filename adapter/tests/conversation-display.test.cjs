const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const script=fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-conversation-display.js'),'utf8');
class Element {
 constructor(tag='div',attrs={}){this.tagName=tag.toUpperCase();this.attrs=new Map(Object.entries(attrs));this.childNodes=[];this.parentElement=null;this.nodeType=1;this.textContent='';this.writes=0;}
 get children(){return this.childNodes.filter(n=>n.nodeType===1);}
 get isConnected(){let e=this;while(e.parentElement)e=e.parentElement;return e.tagName==='HTML';}
 appendChild(child){child.remove?.();child.parentElement=this;this.childNodes.push(child);return child;}
 remove(){if(this.parentElement){this.parentElement.childNodes=this.parentElement.childNodes.filter(n=>n!==this);this.parentElement=null;}}
 contains(element){return element===this||this.children.some(c=>c.contains(element));}
 getAttribute(name){return this.attrs.has(name)?this.attrs.get(name):null;}
 setAttribute(name,value){this.attrs.set(name,String(value));this.writes++;}
 removeAttribute(name){if(this.attrs.delete(name))this.writes++;}
 matches(selector){const tag=selector.match(/^[a-z]+/i)?.[0];if(tag&&tag.toUpperCase()!==this.tagName)return false;const id=selector.match(/#([\w-]+)/)?.[1];if(id&&this.getAttribute('id')!==id)return false;for(const m of selector.matchAll(/\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/g)){const value=this.getAttribute(m[1]);if(value===null)return false;if(m[2]==='='&&value!==m[3])return false;if(m[2]==='^='&&!value.startsWith(m[3]))return false;}return true;}
 querySelectorAll(selector){const parts=selector.split(' ');const found=[];function visit(node){for(const child of node.children){if(child.matches(parts.at(-1))){let ancestor=child.parentElement,index=parts.length-2;while(index>=0&&ancestor){if(ancestor.matches(parts[index]))index--;ancestor=ancestor.parentElement;}if(index<0)found.push(child);}visit(child);}}visit(this);return found;}
}
function fixture(documentReady=true){
 const html=new Element('html'),head=html.appendChild(new Element('head')),body=html.appendChild(new Element('body'));
 const listeners=new Map(),observed=[];
 const document={body,head,documentElement:documentReady?html:null,createElement:tag=>new Element(tag),querySelectorAll:selector=>html.querySelectorAll(selector),
  addEventListener(name,listener){listeners.set(name,listener);},removeEventListener(name,listener){if(listeners.get(name)===listener)listeners.delete(name);}};
 class MutationObserver{constructor(listener){this.listener=listener;}observe(node,options){observed.push({node,options});}disconnect(){}}
 const window={};vm.runInNewContext(script,{window,document,MutationObserver,crypto:{randomUUID:()=> 'fixture-scope'},Object,Map,Set});
 return {api:window.__SwiftChatConversationDisplay,document,html,head,body,listeners,observed};
}
const hidden=e=>e.getAttribute('data-swiftchat-display-hidden')==='fixture-scope';
function shell(f){
 const shell=f.body.appendChild(new Element()),side=shell.appendChild(new Element('aside',{'style':'color:red','aria-hidden':'false'})),main=shell.appendChild(new Element('main'));
 const header=main.appendChild(new Element('header')),timeline=main.appendChild(new Element('div',{'data-app-action-timeline-scroll':''}));
 const wrapper=timeline.appendChild(new Element()),transcript=wrapper.appendChild(new Element('div',{'data-thread-user-message-navigation-content':''})),messages=transcript;
 const message=messages.appendChild(new Element('div',{'data-chatgpt-conversation-selection-target':''}));
 const assistant=message.appendChild(new Element()),disclaimer=wrapper.appendChild(new Element('div',{'data-markdown-copy':''}));
 const footer=timeline.appendChild(new Element('div')),suggestions=footer.appendChild(new Element()),form=footer.appendChild(new Element('form',{'data-thread-find-composer':'true'}));
 const editor=form.appendChild(new Element('div',{'contenteditable':'true','role':'textbox'}));
 const overlay=f.body.appendChild(new Element());
 return {shell,side,main,header,timeline,transcript,messages,message,assistant,disclaimer,footer,suggestions,form,editor,overlay};
}
test('positive transcript retains original DOM parents and hides every outside sibling without a chrome blacklist',()=>{
 const f=fixture(),n=shell(f);const parents=new Map(Object.values(n).map(e=>[e,e.parentElement]));const result=f.api.apply();assert.equal(result.mode,'matched');assert.equal(result.transcript,n.transcript);
 for(const e of [n.side,n.header,n.footer,n.suggestions,n.form,n.overlay,n.disclaimer])assert.equal(hidden(e)||hidden(e.parentElement),true);
 for(const e of [n.main,n.timeline,n.transcript,n.message,n.assistant])assert.equal(hidden(e),false);
 assert.equal(n.form.getAttribute('data-swiftchat-display-transport'),null);
 for(const [e,parent]of parents)assert.equal(e.parentElement,parent);
 assert.equal(n.side.getAttribute('style'),'color:red');assert.equal(n.side.getAttribute('aria-hidden'),'false');
});
test('body-level semantic live status remains available beside the displayed transcript',()=>{
 const f=fixture(),n=shell(f);
 const status=f.body.appendChild(new Element('span',{class:'sr-only select-none','aria-atomic':'true','aria-live':'polite',role:'status'}));
 const unrelated=f.body.appendChild(new Element('span'));
 assert.equal(f.api.apply().mode,'matched');
 assert.equal(hidden(status),false);assert.equal(status.getAttribute('aria-live'),'polite');assert.equal(status.getAttribute('role'),'status');
 assert.equal(hidden(unrelated),true);assert.equal(hidden(n.overlay),true);
});
test('a filtered body sibling is restored when it becomes a semantic live status',()=>{
 const f=fixture();shell(f);const status=f.body.appendChild(new Element('span'));
 f.api.apply();assert.equal(hidden(status),true);
 status.setAttribute('role','status');status.setAttribute('aria-live','assertive');
 f.api.apply();assert.equal(hidden(status),false);
});
test('native composer inset is applied only through the Display adapter stylesheet',()=>{
 const f=fixture(),n=shell(f);const result=f.api.setBottomInset(137);assert.equal(result.mode,'matched');
 assert.match(f.head.children[0].textContent,/padding-bottom: 137px/);
 assert.equal(n.transcript.getAttribute('data-swiftchat-display-transcript'),'fixture-scope');
 assert.throws(()=>f.api.setBottomInset(-1),/invalid-bottom-inset/);
});
test('document-start observation waits for the document root without throwing',()=>{
 const f=fixture(false);let changes=0;const stop=f.api.observe(()=>changes++);assert.equal(f.observed.length,0);
 f.document.documentElement=f.html;f.listeners.get('DOMContentLoaded')();assert.equal(f.observed.length,1);assert.equal(f.observed[0].node,f.html);assert.equal(f.observed[0].options.attributes,true);assert.equal(f.observed[0].options.attributeFilter.join(','),'role,aria-live,data-radix-popper-content-wrapper');assert.equal(changes,1);stop();
});
test('homepage without a positively identified transcript remains original usable page',()=>{
 const f=fixture();const form=f.body.appendChild(new Element('form',{'data-thread-find-composer':'true'}));form.appendChild(new Element('div',{'contenteditable':'true','role':'textbox'}));
 assert.equal(f.api.apply().mode,'raw');assert.equal(f.head.children.length,0);assert.equal(form.attrs.size,1);assert.equal(f.html.attrs.size,0);
});
test('ambiguous or replaced transcript restores all attributes and removes its stylesheet',()=>{
 const f=fixture(),n=shell(f);n.side.setAttribute('data-swiftchat-display-hidden','original');f.api.apply();const style=f.head.children[0];n.timeline.appendChild(new Element('div',{'data-thread-user-message-navigation-content':''}));
 const result=f.api.apply();assert.equal(result.mode,'raw');assert.equal(n.side.getAttribute('data-swiftchat-display-hidden'),'original');assert.equal(n.header.getAttribute('data-swiftchat-display-hidden'),null);assert.equal(n.form.getAttribute('data-swiftchat-display-transport'),null);assert.equal(style.isConnected,false);assert.equal(f.head.children.length,0);
});
test('reapplying unchanged display adds no DOM mutations and new outside branches are hidden',()=>{
 const f=fixture(),n=shell(f);f.api.apply();const style=f.head.children[0],writes=Object.values(n).reduce((sum,e)=>sum+e.writes,0);f.api.apply();assert.equal(f.head.children[0],style);assert.equal(Object.values(n).reduce((sum,e)=>sum+e.writes,0),writes);
 const added=n.main.appendChild(new Element('section'));f.api.apply();assert.equal(hidden(added),true);f.api.restore();assert.equal(hidden(added),false);
});
test('unwrapped outside text falls back without changing or removing the text node',()=>{
 const f=fixture(),n=shell(f);f.api.apply();const text={nodeType:3,textContent:'Website chrome',parentElement:n.main};n.main.childNodes.push(text);assert.equal(f.api.apply().reason,'unwrapped-content-on-path');assert.equal(n.main.childNodes.includes(text),true);assert.equal(hidden(n.side),false);
});
test('legacy conversation-turn articles use their shared transcript parent, not the whole thread',()=>{
 const f=fixture(),thread=f.body.appendChild(new Element('div',{id:'thread'})),transcript=thread.appendChild(new Element()),bottom=thread.appendChild(new Element('div',{id:'thread-bottom'})),form=bottom.appendChild(new Element('form'));
 transcript.appendChild(new Element('article',{'data-testid':'conversation-turn-0'}));transcript.appendChild(new Element('article',{'data-testid':'conversation-turn-1'}));form.appendChild(new Element('div',{'contenteditable':'true','role':'textbox'}));
 const result=f.api.apply();assert.equal(result.mode,'matched');assert.equal(result.variant,'legacy');assert.equal(result.transcript,transcript);assert.equal(form.parentElement,bottom);
});
test('remounting to a different transcript restores retired nodes and matches the new tree',()=>{
 const f=fixture(),old=shell(f);f.api.apply();old.shell.remove();old.overlay.remove();const next=shell(f);assert.equal(f.api.apply().transcript,next.transcript);assert.equal(old.side.getAttribute('data-swiftchat-display-hidden'),null);assert.equal(old.form.getAttribute('data-swiftchat-display-transport'),null);assert.equal(hidden(next.side),true);f.api.restore();assert.equal(hidden(next.side),false);
});
test('duplicate timeline and empty message list stay raw without partially applying display changes',()=>{
 const f=fixture(),n=shell(f);n.message.remove();assert.equal(f.api.apply().mode,'raw');n.messages.appendChild(new Element('div',{'data-chatgpt-conversation-selection-target':''}));f.body.appendChild(new Element('div',{'data-app-action-timeline-scroll':''}));assert.equal(f.api.apply().reason,'timeline-ambiguous');assert.equal(f.head.children.length,0);
});

test('transparent surface is scoped to the ancestor path and fully restored on contract loss',()=>{
 const f=fixture(),n=shell(f);
 n.main.setAttribute('data-swiftchat-display-surface','prior');
 f.api.apply();
 for(const e of [f.html,f.body,n.shell,n.main,n.timeline,n.transcript]) assert.equal(e.getAttribute('data-swiftchat-display-surface'),'fixture-scope');
 for(const e of [n.message,n.assistant,n.side]) assert.equal(e.getAttribute('data-swiftchat-display-surface'),null);
 n.message.remove();
 assert.equal(f.api.apply().mode,'raw');
 assert.equal(n.main.getAttribute('data-swiftchat-display-surface'),'prior');
 for(const e of [f.html,f.body,n.shell,n.timeline,n.transcript]) assert.equal(e.getAttribute('data-swiftchat-display-surface'),null);
 assert.equal(f.head.children.length,0);
});

for (const attrs of [{'data-radix-popper-content-wrapper':''},{role:'menu'},{role:'tooltip'},{role:'dialog'},{role:'alertdialog'}]) {
 test(`website overlay ${JSON.stringify(attrs)} retains its path, styling and children`,()=>{
  const f=fixture(),n=shell(f),host=n.overlay;
  f.api.apply();assert.equal(hidden(host),true);
  const wrapper=host.appendChild(new Element()),panel=wrapper.appendChild(new Element('div',attrs));
  const content=panel.appendChild(new Element('button')),unrelated=host.appendChild(new Element('aside'));
  panel.setAttribute('style','position:fixed;background:black');
  f.api.apply();
  for(const e of [host,wrapper,panel,content]) {
   assert.equal(hidden(e),false);
   assert.equal(e.getAttribute('data-swiftchat-display-surface'),null);
  }
  assert.equal(hidden(unrelated),true);assert.equal(hidden(n.side),true);assert.equal(hidden(n.footer),true);
  assert.equal(panel.getAttribute('style'),'position:fixed;background:black');assert.equal(panel.parentElement,wrapper);
  panel.remove();f.api.apply();assert.equal(hidden(host),true);
  f.api.restore();assert.equal(hidden(host),false);assert.equal(hidden(unrelated),false);
 });
}
test('overlay nested within the transcript never hides its message siblings',()=>{
 const f=fixture(),n=shell(f);n.message.appendChild(new Element('div',{role:'menu'}));
 f.api.apply();assert.equal(hidden(n.assistant),false);assert.equal(hidden(n.message),false);
});
test('an existing outside node becomes an overlay and returns to hidden after losing its role',()=>{
 const f=fixture(),n=shell(f);f.api.apply();assert.equal(hidden(n.overlay),true);
 n.overlay.setAttribute('role','menu');f.api.apply();assert.equal(hidden(n.overlay),false);
 n.overlay.removeAttribute('role');f.api.apply();assert.equal(hidden(n.overlay),true);
});
