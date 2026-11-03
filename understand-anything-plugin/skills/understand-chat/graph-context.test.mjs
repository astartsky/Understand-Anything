import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
const modulePath = fileURLToPath(new URL('./graph-context.mjs', import.meta.url));
const { inspectGraph, selectContext } = await import(pathToFileURL(modulePath));
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ua-chat-tests-')));
after(() => rmSync(temp, { recursive: true, force: true }));
let counter=0;
function git(root,...args) {
 const r=spawnSync('git',['-C',root,...args],{encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
 assert.equal(r.status,0,r.stderr);return r.stdout.trim();
}
function fixture() {
 const root=join(temp,String(counter++));mkdirSync(root);
 git(root,'init','-q');git(root,'config','user.email','tests@example.invalid');git(root,'config','user.name','Local test');
 writeFileSync(join(root,'auth.js'),'export const auth = 1;\n');git(root,'add','auth.js');git(root,'commit','-qm','baseline');
 mkdirSync(join(root,'.ua'));const commit=git(root,'rev-parse','HEAD');
 const graph={version:'1',project:{name:'Fixture',sourceRoot:root,gitCommitHash:commit,workingTreeDirty:false},nodes:[
 {id:'file:auth',name:'Auth',summary:'login',tags:['security'],filePath:'auth.js'},
 {id:'file:db',name:'Database'},{id:'file:api',name:'API'},{id:'file:other',name:'Other'},
 ],edges:[
 {source:'file:auth',target:'file:db',type:'imports',direction:'forward',weight:1},
 {source:'file:api',target:'file:auth',type:'calls',direction:'backward',weight:0.8},
 {source:'file:db',target:'file:auth',type:'related',direction:'bidirectional',weight:0.2,knowledgeMeta:{confidence:0.5}},
 {source:'file:other',target:'file:db',type:'imports',direction:'forward',weight:1}],
 layers:[{id:'app',name:'App',nodeIds:['file:auth','file:api','file:other']}]};
 function save(value=graph, legacy=false){writeFileSync(join(root,legacy?'.understand-anything':'.ua','knowledge-graph.json'),JSON.stringify(value,null,2));}
 save();return {root,graph,commit,save};
}
function codes(value){return value.freshness.warnings.map(x=>x.code);}
test('all exact-ID neighbors retain full typed and directed edges, endpoints and layers',()=>{
 const {graph}=fixture();const r=selectContext(graph,{nodeIds:['file:auth']});
 assert.deepEqual(r.edges.map(e=>[e.source,e.target,e.type,e.direction]),[
 ['file:auth','file:db','imports','forward'],['file:api','file:auth','calls','backward'],['file:db','file:auth','related','bidirectional']]);
 assert.deepEqual(r.neighborNodes.map(x=>x.id),['file:db','file:api']);
 assert.deepEqual(r.edges[2].knowledgeMeta,{confidence:0.5});
 assert.deepEqual(r.layers[0].nodeIds,['file:auth','file:api']);
 assert.equal(r.layers[0].totalNodeCount,3);
});
test('bounded edge pages expose totals and exhaust neighbors without silently truncating',()=>{
 const {graph}=fixture();let ids=[];
 for(const edgeOffset of [0,1,2]) {const r=selectContext(graph,{nodeIds:['file:auth'],edgeOffset,edgeLimit:1});
 assert.equal(r.counts.totalEdges,3);assert.equal(r.edges.length,1);ids.push(r.edges[0].type);}
 assert.deepEqual(ids,['imports','calls','related']);
 assert.throws(()=>selectContext(graph,{edgeLimit:0}),/edgeLimit/);
 assert.throws(()=>selectContext(graph,{limit:101}),/limit/);
});
test('search is literal, supports tags/path/summary and unmatched input stays empty',()=>{
 const {graph}=fixture();
 for(const query of ['SECURITY','auth.js','login']) assert.equal(selectContext(graph,{query}).matchedNodes[0].id,'file:auth');
 assert.deepEqual(selectContext(graph,{query:'.*'}).matchedNodes,[]);
 assert.throws(()=>selectContext(graph,{nodeIds:['file:missing']}),/Unknown node/);
});
test('clean matching checkout is current and does not rewrite Git index or graph',()=>{
 const {root}=fixture();const before=readFileSync(join(root,'.git','index'));const graphBefore=readFileSync(join(root,'.ua','knowledge-graph.json'));
 // A stat-only source change would let git refresh cached index metadata if optional locks were allowed.
 const sourceFile=join(root,'auth.js');const stat=statSync(sourceFile);
 utimesSync(sourceFile, stat.atime, new Date(stat.mtimeMs + 5_000));
 const r=inspectGraph(root);assert.equal(r.freshness.status,'current');assert.deepEqual(r.freshness.warnings,[]);
 assert.deepEqual(readFileSync(join(root,'.git','index')),before);assert.deepEqual(readFileSync(join(root,'.ua','knowledge-graph.json')),graphBefore);
});
test('staged, unstaged and untracked files all warn, generated graph files do not',()=>{
 const {root}=fixture();writeFileSync(join(root,'auth.js'),'changed\n');writeFileSync(join(root,'new.js'),'new\n');git(root,'add','new.js');writeFileSync(join(root,'untracked.js'),'new\n');
 const r=inspectGraph(root);assert.equal(r.freshness.status,'stale');assert.ok(codes(r).includes('WORKTREE_CHANGED'));
 assert.deepEqual(r.freshness.changedFiles,['auth.js','new.js','untracked.js']);
});
test('committed project changes warn, but a sibling-only commit does not make a nested project stale',()=>{
 const {root,graph}=fixture();writeFileSync(join(root,'auth.js'),'changed\n');git(root,'add','auth.js');git(root,'commit','-qm','source change');
 assert.ok(codes(inspectGraph(root)).includes('COMMITTED_CHANGED'));
 const project=join(root,'nested');mkdirSync(project);writeFileSync(join(project,'nested.js'),'x\n');git(root,'add','nested');git(root,'commit','-qm','nested baseline');
 mkdirSync(join(project,'.ua'));graph.project={...graph.project,sourceRoot:project,gitCommitHash:git(root,'rev-parse','HEAD')};
 writeFileSync(join(project,'.ua','knowledge-graph.json'),JSON.stringify(graph));
 writeFileSync(join(root,'sibling.js'),'x\n');git(root,'add','sibling.js');git(root,'commit','-qm','sibling only');
 const r=inspectGraph(project);assert.equal(r.freshness.status,'current');assert.notEqual(r.freshness.graphCommit,r.freshness.currentCommit);
});
test('copied graph and missing binding never appear current; matching legacy meta can bind it',()=>{
 const {root,graph,commit,save}=fixture();graph.project.sourceRoot='/not/this/checkout';save();
 assert.ok(codes(inspectGraph(root)).includes('SOURCE_MISMATCH'));
 delete graph.project.sourceRoot;save();assert.ok(codes(inspectGraph(root)).includes('SOURCE_UNBOUND'));
 writeFileSync(join(root,'.ua','meta.json'),JSON.stringify({sourceRoot:root,gitCommitHash:commit,workingTreeDirty:false}));
 assert.equal(inspectGraph(root).freshness.status,'current');
});
test('dirty analysis baseline and unknown baseline cleanliness are explicit',()=>{
 const {root,graph,save}=fixture();graph.project.workingTreeDirty=true;save();assert.ok(codes(inspectGraph(root)).includes('BASELINE_DIRTY'));
 delete graph.project.workingTreeDirty;save();assert.ok(codes(inspectGraph(root)).includes('BASELINE_DIRTY_UNKNOWN'));
});
test('invalid commit and absent Git remain best-effort, not fresh',()=>{
 const {root,graph,save}=fixture();graph.project.gitCommitHash='--output=/tmp/not-allowed';save();assert.ok(codes(inspectGraph(root)).includes('GRAPH_COMMIT_INVALID'));
 const plain=join(temp,String(counter++));mkdirSync(plain);mkdirSync(join(plain,'.ua'));graph.project.sourceRoot=plain;
 writeFileSync(join(plain,'.ua','knowledge-graph.json'),JSON.stringify(graph));const r=inspectGraph(plain);
 assert.equal(r.freshness.status,'unverified');assert.ok(codes(r).includes('GIT_UNAVAILABLE'));
});
test('legacy directory wins and malformed/missing graph produces a useful error',()=>{
 const {root,graph,save}=fixture();mkdirSync(join(root,'.understand-anything'));assert.throws(()=>inspectGraph(root),/Run.*understand/);
 graph.project.name='Legacy';save(graph,true);assert.equal(inspectGraph(root).graph.project.name,'Legacy');
 writeFileSync(join(root,'.understand-anything','knowledge-graph.json'),'{bad');assert.throws(()=>inspectGraph(root),/Invalid JSON/);
});
test('CLI works as a standalone copied helper with no packages and treats query text as data',()=>{
 const {root}=fixture();const helper=join(temp,'standalone.mjs');writeFileSync(helper,readFileSync(modulePath));
 const r=spawnSync(process.execPath,[helper,root,'--node','file:auth','--edge-limit','1'],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const value=JSON.parse(r.stdout);assert.equal(value.edges.length,1);assert.equal(value.counts.totalEdges,3);assert.equal(value.freshness.status,'current');assert.equal(value.graph,undefined);
 const query=spawnSync(process.execPath,[helper,root,'--query','$(touch injected)'],{encoding:'utf8'});assert.equal(query.status,0);assert.equal(JSON.parse(query.stdout).counts.matchedNodes,0);
 assert.ok(!readdirSync(root).includes('injected'));
 const bad=spawnSync(process.execPath,[helper,root,'--oops'],{encoding:'utf8'});assert.equal(bad.status,1);assert.match(bad.stderr,/Unknown option/);
});
test('incomplete edge cannot silently disappear from an otherwise parsed graph',()=>{
 const {root,graph,save}=fixture();graph.edges[0]={source:'file:auth'};save();
 assert.throws(()=>inspectGraph(root),/Invalid graph structure/);
});
test('selected Git worktree uses its own source binding, graph and HEAD',()=>{
 const {root,graph}=fixture();const branchRoot=join(temp,String(counter++));git(root,'worktree','add','-qb','selected',branchRoot);
 writeFileSync(join(branchRoot,'branch-only.js'),'branch content\n');git(branchRoot,'add','branch-only.js');git(branchRoot,'commit','-qm','branch-only');
 mkdirSync(join(branchRoot,'.ua'));graph.project={...graph.project,sourceRoot:branchRoot,gitCommitHash:git(branchRoot,'rev-parse','HEAD')};
 writeFileSync(join(branchRoot,'.ua','knowledge-graph.json'),JSON.stringify(graph));const r=inspectGraph(branchRoot);
 assert.equal(r.sourceRoot,branchRoot);assert.equal(r.freshness.status,'current');assert.equal(r.freshness.currentCommit,graph.project.gitCommitHash);
 assert.notEqual(r.freshness.currentCommit,git(root,'rev-parse','HEAD'));assert.equal(r.dataDir,join(branchRoot,'.ua'));
});
test('conflicting analysis metadata does not inherit a clean current result',()=>{
 const {root,commit}=fixture();writeFileSync(join(root,'.ua','meta.json'),JSON.stringify({sourceRoot:'/elsewhere',gitCommitHash:commit,workingTreeDirty:false}));
 const r=inspectGraph(root);assert.equal(r.freshness.status,'stale');assert.ok(codes(r).includes('META_MISMATCH'));
});
test('content-aware checks preserve tabs/newlines in paths and detect file mode changes',()=>{
 const {root,graph,save}=fixture();const name='tab\tand\nnewline.js';
 writeFileSync(join(root,name),'original\n');git(root,'add',name);git(root,'commit','-qm','path baseline');
 graph.project.gitCommitHash=git(root,'rev-parse','HEAD');save();
 writeFileSync(join(root,name),'changed\n');git(root,'config','core.fileMode','true');chmodSync(join(root,'auth.js'),0o755);
 const r=inspectGraph(root);assert.equal(r.freshness.status,'stale');assert.deepEqual(r.freshness.changedFiles,['auth.js',name]);
});
test('CLI caps many changed paths with explicit totals while the inspection API remains complete',()=>{
 const {root}=fixture();
 for(let i=0;i<650;i++) writeFileSync(join(root,`${String(i).padStart(4,'0')}-${'x'.repeat(230)}.js`),'new\n');
 const full=inspectGraph(root);assert.equal(full.freshness.changedFiles.length,650);
 const r=spawnSync(process.execPath,[modulePath,root],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 assert.ok(Buffer.byteLength(r.stdout,'utf8')<=131072,`stdout exceeds 128 KiB: ${Buffer.byteLength(r.stdout,'utf8')} bytes`);
 const value=JSON.parse(r.stdout);assert.equal(value.freshness.changedFileCount,650);
 assert.equal(value.freshness.changedFiles.length,50);assert.equal(value.freshness.changedFilesTruncated,true);
 assert.deepEqual(value.freshness.changedFiles,full.freshness.changedFiles.slice(0,50));
});
test('CLI rejects oversized full knowledge nodes before emitting JSON even with one selected node and edge',()=>{
 const {root,graph,save}=fixture();
 graph.nodes[0].knowledgeMeta={content:'я'.repeat(80000),provenance:[{source:'source:archive',locator:'p. 4'}]};save();
 assert.equal(inspectGraph(root).graph.nodes[0].knowledgeMeta.content.length,80000);
 const r=spawnSync(process.execPath,[modulePath,root,'--node','file:auth','--limit','1','--edge-limit','1'],{encoding:'utf8'});
 assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/128 KiB/);assert.match(r.stderr,/limits|query/);assert.match(r.stderr,/source files/);
});
test('normal CLI payload preserves identifiers, full edges and provenance without mutating the graph',()=>{
 const {root,graph,save}=fixture();
 graph.nodes[0].knowledgeMeta={content:'Краткий первоисточник',provenance:[{source:'source:archive',locator:'p. 4'}]};
 graph.edges[0].knowledgeMeta={provenance:[{source:'source:call',locator:'line:42'}],confidence:0.8};save();
 const before=readFileSync(join(root,'.ua','knowledge-graph.json'));
 const r=spawnSync(process.execPath,[modulePath,root,'--node','file:auth','--edge-limit','1'],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const value=JSON.parse(r.stdout);
 assert.deepEqual(value.matchedNodes[0],graph.nodes[0]);assert.deepEqual(value.edges[0],graph.edges[0]);
 assert.equal(value.neighborNodes[0].id,'file:db');assert.equal(value.freshness.changedFileCount,0);assert.equal(value.freshness.changedFilesTruncated,false);
 assert.deepEqual(readFileSync(join(root,'.ua','knowledge-graph.json')),before);
});
