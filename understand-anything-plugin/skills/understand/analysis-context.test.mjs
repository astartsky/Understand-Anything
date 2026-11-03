import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const skill = process.env.UNDERSTAND_SKILL_DIR ?? dirname(fileURLToPath(import.meta.url));
const contextScript = join(skill, 'analysis-context.mjs');
function run(command, args, options={}) {
  const r = spawnSync(command, args, { encoding:'utf8', ...options });
  assert.equal(r.status, 0, r.stderr || r.stdout || String(r.error));
  return r.stdout.trim();
}
function git(root, ...args) {return run('git',['-C', root, ...args]);}
function setup() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ua-worktree-')));
  const main = join(temp,'main'); mkdirSync(main);
  git(main,'init','-q'); git(main,'config','user.email','fixture@example.invalid'); git(main,'config','user.name','Fixture');
  writeFileSync(join(main,'.gitignore'),'.ua/\n.understand-anything/\n');
  writeFileSync(join(main,'main-only.ts'),'export const mainOnly = true;\n');
  git(main,'add','.'); git(main,'commit','-qm','main');
  const worktree = join(temp,'feature checkout'); git(main,'worktree','add','-qb','feature',worktree);
  writeFileSync(join(worktree,'worktree-only.ts'),'export const worktreeOnly = true;\n');
  git(worktree,'rm','-q','main-only.ts'); git(worktree,'add','.'); git(worktree,'commit','-qm','feature');
  mkdirSync(join(main,'.ua')); writeFileSync(join(main,'.ua','knowledge-graph.json'),'main graph sentinel');
  return {temp,main,worktree};
}
function context(path,args=[],cwd) {
  return JSON.parse(run(process.execPath,[contextScript,'context',...(path === undefined ? [] : [path]),...args],{cwd}));
}
test('worktree scan and graph metadata refer to the selected checkout; main graph untouched',()=>{
 const f=setup();
 try {
  const ctx=context(f.worktree,[],f.worktree);
  mkdirSync(join(ctx.uaDir,'intermediate'),{recursive:true});
  const scanPath=join(ctx.uaDir,'intermediate','scan-result.json');
  run(process.execPath,[join(skill,'scan-project.mjs'),ctx.sourceRoot,scanPath,'--exclude-analysis-data']);
  const scan=JSON.parse(readFileSync(scanPath));
  assert.ok(scan.files.some(x=>x.path==='worktree-only.ts'),'scan must include worktree-only.ts from feature');
  assert.ok(!scan.files.some(x=>x.path==='main-only.ts'),'scan must not contain main branch source');
  // Analyzer output is a controlled fixture: no model invocation is claimed.
  writeFileSync(join(ctx.uaDir,'intermediate','batch-0.json'), JSON.stringify({nodes:scan.files.map(x=>({id:`file:${x.path}`,type:'file',name:x.path,filePath:x.path,summary:'Fixture file',tags:['fixture']})),edges:[]}));
  run('python3',[join(skill,'merge-batch-graphs.py'),ctx.sourceRoot]);
  const assembled=JSON.parse(readFileSync(join(ctx.uaDir,'intermediate','assembled-graph.json')));
  const graph={version:'1.0.0',project:{gitCommitHash:ctx.gitCommitHash},...assembled,layers:[],tour:[]};
  writeFileSync(join(ctx.uaDir,'knowledge-graph.json'),JSON.stringify(graph));
  assert.ok(graph.nodes.some(x=>x.id==='file:worktree-only.ts'));
  assert.equal(graph.project.gitCommitHash,git(f.worktree,'rev-parse','HEAD'));
  assert.notEqual(graph.project.gitCommitHash,git(f.main,'rev-parse','HEAD'));
  const fingerprintInput=join(ctx.uaDir,'intermediate','fingerprint-input.json');
  writeFileSync(fingerprintInput,JSON.stringify({projectRoot:ctx.sourceRoot,filePaths:scan.files.map(x=>x.path),gitCommitHash:ctx.gitCommitHash}));
  run(process.execPath,[join(skill,'build-fingerprints.mjs'),fingerprintInput]);
  const contextPath=join(ctx.uaDir,'intermediate','context.json');
  writeFileSync(contextPath,JSON.stringify(ctx));
  run(process.execPath,[contextScript,'save-meta',contextPath]);
  const meta=JSON.parse(readFileSync(join(ctx.uaDir,'meta.json')));
  assert.equal(meta.sourceRoot,f.worktree);
  assert.equal(meta.gitCommitHash,git(f.worktree,'rev-parse','HEAD'));
  assert.equal(meta.gitBranch,'feature');
  assert.equal(meta.workingTreeDirty,false);
  assert.equal(context(f.worktree).baselineAction,'CURRENT');
  assert.equal(readFileSync(join(f.main,'.ua','knowledge-graph.json'),'utf8'),'main graph sentinel');
 }finally{rmSync(f.temp,{recursive:true,force:true});}
});

const { parseArguments, resolveContext, saveMeta } = await import(pathToFileURL(contextScript).href);
test('flag values are never interpreted as paths; relative path resolves from invoking cwd',()=>{
 const f=setup(); try {
  assert.equal(context(undefined,['--language','ru','--exclude','tests/*'],f.worktree).sourceRoot,f.worktree);
  assert.equal(context('feature checkout',['--review','--language','ru'],f.temp).gitCommitHash,git(f.worktree,'rev-parse','HEAD'));
  assert.throws(()=>parseArguments(['--language'],f.worktree),/requires a value/);
  assert.throws(()=>parseArguments(['--unknown'],f.worktree),/Unknown option/);
  assert.throws(()=>parseArguments([f.main,f.worktree]),/only one project/);
  assert.throws(()=>parseArguments(['--auto-update','--no-auto-update'],f.worktree),/conflict/);
 } finally {rmSync(f.temp,{recursive:true,force:true});}
});
test('legacy output stays in selected checkout; absent runtime fails before creating data',async()=>{
 const f=setup(); try {
  mkdirSync(join(f.worktree,'.understand-anything'));
  assert.equal(context(f.worktree).uaDir,join(f.worktree,'.understand-anything'));
  await assert.rejects(resolveContext([f.worktree],{pluginRoot:join(f.temp,'missing')}),/runtime missing.*No install or build was run/);
  assert.ok(!existsSync(join(f.worktree,'.ua')));
  writeFileSync(join(f.main,'.understand-anything'),'not a directory');
  assert.throws(()=>parseArguments([f.main]),/Data path is not a directory/);
 } finally {rmSync(f.temp,{recursive:true,force:true});}
});
function baseline(f, overrides={}) {
 const dir=join(f.worktree,'.ua');mkdirSync(dir,{recursive:true});
 const hash=git(f.worktree,'rev-parse','HEAD');
 writeFileSync(join(dir,'meta.json'),JSON.stringify({sourceRoot:f.worktree,gitCommitHash:hash,workingTreeDirty:false,...overrides}));
 writeFileSync(join(dir,'knowledge-graph.json'),JSON.stringify({project:{gitCommitHash:hash},nodes:[],edges:[]}));
 writeFileSync(join(dir,'fingerprints.json'),JSON.stringify({gitCommitHash:hash,files:{}}));
 return dir;
}
test('copied graph, mismatched commits, dirty current or previous source cannot report CURRENT',()=>{
 const f=setup();try {
  const dir=baseline(f);
  assert.equal(context(f.worktree).baselineAction,'CURRENT');
  baseline(f,{sourceRoot:f.main}); assert.equal(context(f.worktree).baselineAction,'FULL');
  baseline(f,{workingTreeDirty:true}); assert.equal(context(f.worktree).baselineAction,'FULL');
  baseline(f);writeFileSync(join(dir,'knowledge-graph.json'),JSON.stringify({project:{gitCommitHash:'different'}}));
  assert.equal(context(f.worktree).baselineAction,'FULL');
  baseline(f);writeFileSync(join(f.worktree,'untracked.ts'),'export const fresh=1;');
  assert.equal(context(f.worktree).baselineAction,'FULL');
  git(f.worktree,'add','.');git(f.worktree,'commit','-qm','next');
  assert.equal(context(f.worktree).baselineAction,'INCREMENTAL');
 } finally {rmSync(f.temp,{recursive:true,force:true});}
});
test('save refuses changed HEAD or wrong saved commit and preserves previous metadata',()=>{
 const f=setup();try {
  const dir=baseline(f);const ctx=context(f.worktree);const before=readFileSync(join(dir,'meta.json'),'utf8');
  mkdirSync(join(dir,'intermediate'));writeFileSync(join(dir,'intermediate','scan-result.json'),JSON.stringify({files:[]}));
  writeFileSync(join(dir,'knowledge-graph.json'),JSON.stringify({project:{gitCommitHash:'wrong'}}));
  assert.throws(()=>saveMeta(ctx),/differs from selected source/);
  assert.equal(readFileSync(join(dir,'meta.json'),'utf8'),before);
  writeFileSync(join(f.worktree,'later.ts'),'export const later=1;');git(f.worktree,'add','.');git(f.worktree,'commit','-qm','moved HEAD');
  assert.throws(()=>saveMeta(ctx),/HEAD changed/);
  assert.equal(readFileSync(join(dir,'meta.json'),'utf8'),before);
 }finally {rmSync(f.temp,{recursive:true,force:true});}
});
test('non-git directory uses full snapshot mode without inventing a commit',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'ua-no-git-')));
 try {const ctx=context(root);assert.equal(ctx.gitCommitHash,'');assert.equal(ctx.baselineAction,'FULL');}
 finally {rmSync(root,{recursive:true,force:true});}
});
test('incremental finalizer rejects a stale plan after source HEAD moves',()=>{
 const f=setup();try {
  const dir=baseline(f);const ctx=context(f.worktree);mkdirSync(join(dir,'intermediate'));
  const plan={action:'SKIP',baseCommit:ctx.gitCommitHash,headCommit:ctx.gitCommitHash,generatedArtifactFiles:[],filesToReanalyze:[],deletedFiles:[],cosmeticFiles:['worktree-only.ts'],ignoredFiles:[]};
  writeFileSync(join(dir,'intermediate','incremental-plan.json'),JSON.stringify(plan));
  writeFileSync(join(dir,'intermediate','fingerprint-patch.json'),JSON.stringify({baseCommit:ctx.gitCommitHash,headCommit:ctx.gitCommitHash,files:{},deletedFiles:[]}));
  writeFileSync(join(dir,'intermediate','scan-result.json'),JSON.stringify({files:[],totalFiles:0}));
  const before=readFileSync(join(dir,'meta.json'),'utf8');
  writeFileSync(join(f.worktree,'later.ts'),'export const later=1;');git(f.worktree,'add','.');git(f.worktree,'commit','-qm','moved HEAD');
  const result=spawnSync(process.execPath,[join(skill,'finalize-incremental.mjs'),f.worktree],{encoding:'utf8'});
  assert.notEqual(result.status,0,'stale plan must not advance metadata');
  assert.match(result.stderr,/HEAD changed/);
  assert.equal(readFileSync(join(dir,'meta.json'),'utf8'),before);
 }finally{rmSync(f.temp,{recursive:true,force:true});}
});
