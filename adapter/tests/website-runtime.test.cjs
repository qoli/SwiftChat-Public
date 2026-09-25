const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-website-runtime.js'), 'utf8');

function fixture(delayedHome = false) {
  const calls = [], listeners = new Set();
  const node = (name, attrs = {}, content = []) => ({
    type: {name}, attrs, content,
    descendants(visitor) {
      const walk = value => {
        for (const child of value.content ?? []) {
          visitor(child);
          walk(child);
        }
      };
      walk(this);
    }
  });
  const nodeType = name => ({create(attrs, content) { return node(name, attrs ?? {}, content ?? []); }});
  const schema = {nodes: {
    doc: nodeType('doc'), paragraph: nodeType('paragraph'),
    chatGptLibraryFileMention: nodeType('chatGptLibraryFileMention'), atMention: nodeType('atMention')
  }};
  const parsePromptText = text => {
    const values = [];
    const pattern = /\[\[swiftchat-reference:([^:]+):([^\]]+)\]\]/g;
    for (const match of text.matchAll(pattern)) {
      values.push(node(match[1], JSON.parse(decodeURIComponent(match[2]))));
    }
    return node('doc', {}, values);
  };
  const controller = {view:{state:{schema}},markdownEditor:{serialize(document) {
    let reference = null;
    document.descendants(value => {
      if (['chatGptLibraryFileMention','atMention'].includes(value.type.name)) reference = value;
    });
    return `[[swiftchat-reference:${reference.type.name}:${encodeURIComponent(JSON.stringify(reference.attrs))}]]`;
  }},parsePromptText};
  const location = {pathname: '/'};
  const owner = {
    isPrimaryComposer: false, composerController: controller, conversationId: 'local-conversation',
    conversationOrigin: null, attachments: [], selectedModel: {slug:'server-default', versionId:null, thinkingEffort:null},
    models: {}, selectedSystemHints: [], isSubmitting:false, submissionBlocked:false,
    isStreaming:false, isStopping:false, readOnly:false, submitDisabled:false,
    onModelChange(model) { calls.push({model}); owner.selectedModel = model; commit(); },
    onSystemHintsChange(hints) { calls.push({hints}); owner.selectedSystemHints = hints; commit(); },
    onAttachmentRemove(value) { calls.push({removed:value}); owner.attachments = owner.attachments.filter(item => item.uploadId !== value); commit(); }
  };
  const fileInputOwner = {attachments:owner.attachments,selectedSystemHints:owner.selectedSystemHints,
    fileInputRef() {},fileAttachmentDisabled:false,fileUploadLimitReached:false,filesOnly:false,
    onFilesSelected(files) { calls.push({files});owner.attachments=files.map((file,index)=>({id:`file-${index}`,uploadId:`upload-${index}`,name:file.name,size:file.size,mimeType:file.type,status:'uploading'}));commit();queueMicrotask(()=>{owner.attachments=owner.attachments.map(value=>({...value,status:'ready'}));commit();}); }};
  const referenceOwner = {composerController:controller,
    async onLibraryFileMentionSelected(file) {
      calls.push({referenceFile:true});
      if (!owner.attachments.some(value => value.libraryFileId === file.id)) {
        owner.attachments = [...owner.attachments, {id:`library-${owner.attachments.length}`,
          uploadId:`library-upload-${owner.attachments.length}`,source:'library',libraryFileId:file.id,
          name:file.file_name,mimeType:file.mime_type,size:file.file_size_bytes ?? 1,status:'ready'}];
        commit();
      }
      return true;
    }};
  const stopOwner = {composerController:controller,stopEnabled:false,
    onStop() { calls.push({stop:true});owner.isStreaming=false;stopOwner.stopEnabled=false;commit(); }};
  function onSubmit(text, options, parent, timestamp, background) {
    calls.push({text, options, parent, timestamp, background});
    owner.isStreaming = true; stopOwner.stopEnabled = true; commit();
    return Promise.resolve(true);
  }
  const sendOwner = {onSubmit, prompt:'', canSubmit:true, conversationId:'local-conversation'};
  const modeOwner = {composerController:controller,mode:'chat',canSwitchMode:true,workModeAllowed:true,
    onModeChange(mode, source) { calls.push({mode,source}); modeOwner.mode=mode; owner.conversationOrigin=mode==='work'?'tpp':null; commit(); }};
  const window = {};
  const router = {window,state:{location},async navigate(path){
    calls.push({navigate:path});const previous=location.pathname;location.pathname=path;
    if(path==='/'&&previous!=='/'){
      if(delayedHome){root.child=null;for(const listener of listeners)listener();setTimeout(()=>{
        owner.conversationId='local-home';sendOwner.conversationId='local-home';commit();
      },0);}else{owner.conversationId='local-home';sendOwner.conversationId='local-home';commit();}
    }
  }};
  const root = {stateNode:null}; root.stateNode = {current:root};
  function commit() {
    fileInputOwner.attachments=owner.attachments;fileInputOwner.selectedSystemHints=owner.selectedSystemHints;
    root.child = null; let previous = root;
    for (const props of [owner, fileInputOwner, referenceOwner, sendOwner, stopOwner, modeOwner, {value:{basename:'/',static:false,router}}]) {
      const fiber = {memoizedProps:props,pendingProps:props,return:root}; previous.child=fiber; previous=fiber;
    }
    for (const listener of listeners) listener();
  }
  const roots = {current:()=>[root],subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}};
  window.__SwiftChatRuntimeRoots = roots;
  commit();
  const context = vm.createContext({window,location,crypto:webcrypto,performance,setTimeout,clearTimeout,File});
  vm.runInContext(source, context);
  return {api:window.__SwiftChatWebsiteRuntime,owner,fileInputOwner,referenceOwner,
    sendOwner,stopOwner,modeOwner,router,calls,commit,location};
}

test('paid profile applies model state and invokes the five-argument website command exactly once', async () => {
  const f=fixture();
  const result=await f.api.submit({text:'synthetic fixture',serializedText:'synthetic fixture',mode:'chat',conversationID:'local-conversation',
    model:{slug:'chosen',versionId:'v',thinkingEffort:'high'},systemHints:[],references:[],attachmentTokens:[]});
  assert.equal(result.accepted,true);assert.equal(result.profile,'paid-on-submit-5-v1');
  const send=f.calls.find(call=>call.text==='synthetic fixture');
  assert.deepEqual(JSON.parse(JSON.stringify(send.options.model)),{slug:'chosen',versionId:'v',thinkingEffort:'high'});
  assert.deepEqual(Array.from(send.options.systemHints),[]);assert.equal(send.parent,undefined);
  assert.equal(typeof send.timestamp,'number');assert.equal(send.background,false);
  assert.equal(f.calls.filter(call=>call.text).length,1);
});
test('website empty-editor disable state does not block a native text envelope', async () => {
  const f=fixture();f.owner.submitDisabled=true;f.commit();
  const result=await f.api.submit({text:'native draft',serializedText:'native draft',mode:'chat',conversationID:'local-conversation',
    model:f.owner.selectedModel,systemHints:[],references:[],attachmentTokens:[]});
  assert.equal(result.accepted,true);
  assert.equal(f.calls.filter(call=>call.text==='native draft').length,1);
});
test('composer and file input bindings follow their positive capability owners', () => {
  const f=fixture();
  assert.equal(f.owner.isPrimaryComposer,false);
  assert.equal(f.fileInputOwner.onFilesSelected.length,1);
  assert.equal(f.api.context().conversationID,'local-conversation');
});
test('references serialize through an ephemeral website document and register library state', async () => {
  const f=fixture(), text='Use @Fixture File';
  const reference={token:'local-reference',kind:'file',location:4,length:13,
    file:{id:'library-file',file_name:'Fixture File',mime_type:'text/plain'},
    attrs:{entrypoint:'at_mention',fileId:'file-id',libraryArtifactType:'',
      libraryFileId:'library-file',mimeType:'text/plain',title:'Fixture File'}};
  const serializedText=f.api.serializeReferences(text,[reference]);
  assert.notEqual(serializedText,text);
  const result=await f.api.submit({text,serializedText,mode:'chat',conversationID:'local-conversation',
    model:f.owner.selectedModel,systemHints:[],references:[reference],attachmentTokens:[]});
  assert.equal(result.accepted,true);
  assert.equal(f.calls.filter(call=>call.referenceFile).length,1);
  assert.equal(f.calls.find(call=>call.text)?.text,serializedText);
  assert.equal(f.owner.attachments.some(value=>value.libraryFileId==='library-file'),true);
});
test('website attachment hook registers, verifies, submits and removes opaque handles', async () => {
  const f=fixture(), file=new File(['fixture'],'fixture.txt',{type:'text/plain'});
  const handle=await f.api.uploadAttachment(file);assert.match(handle.token,/^[0-9a-f-]{36}$/);
  assert.equal(f.api.attachmentState(handle.token).status,'ready');
  const result=await f.api.submit({text:'with file',serializedText:'with file',mode:'chat',conversationID:'local-conversation',
    model:f.owner.selectedModel,systemHints:[],references:[],attachmentTokens:[handle.token]});
  assert.equal(result.accepted,true);assert.throws(()=>f.api.attachmentState(handle.token),/handle-unavailable/);
  f.owner.isStreaming=false;f.stopOwner.stopEnabled=false;f.commit();
  const second=await f.api.uploadAttachment(file);await f.api.removeAttachment(second.token);
  assert.equal(f.owner.attachments.length,0);
});
test('new conversation uses router and versioned mode command without DOM', async () => {
  const f=fixture();f.location.pathname='/c/old';
  assert.equal(await f.api.newConversation('work'),true);
  assert.deepEqual(f.calls.filter(call=>call.navigate||call.mode),[{navigate:'/'},{mode:'work',source:'mode_picker'}]);
  assert.equal(f.api.context().conversationID,'local-home');
  assert.equal(f.api.context().mode,'work');
});
test('new conversation waits across the expected empty-root navigation window', async () => {
  const f=fixture(true);f.location.pathname='/c/old';
  assert.equal(await f.api.newConversation('chat'),true);
  assert.equal(f.api.context().conversationID,'local-home');
});
test('stop belongs to the active website-command generation', async () => {
  const f=fixture();await f.api.submit({text:'fixture',serializedText:'fixture',mode:'chat',conversationID:'local-conversation',
    model:f.owner.selectedModel,systemHints:[],references:[],attachmentTokens:[]});
  assert.equal(f.api.stop(),true);assert.equal(f.calls.filter(call=>call.stop).length,1);
});
test('changed runtime profiles fail explicitly before dispatch', async () => {
  const f=fixture();f.sendOwner.onSubmit=async()=>true;f.commit();
  await assert.rejects(f.api.submit({text:'fixture',serializedText:'fixture',mode:'chat',conversationID:'local-conversation',
    model:f.owner.selectedModel,systemHints:[],references:[],attachmentTokens:[]}),/paid-submit-profile-unavailable/);
  assert.equal(f.calls.length,0);
});
