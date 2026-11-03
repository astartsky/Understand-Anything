import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectContext, writeOverlay } from './diff-context.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ua-diff-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding:'utf8'}).trim();
  const put = (path, data) => { mkdirSync(join(root, path, '..'), {recursive:true}); writeFileSync(join(root,path),data); };
  git('init','-q'); git('config','user.name','Test'); git('config','user.email','test@example.invalid');
  put('app/a.js','base\n'); put('app/old.js','delete me\n'); put('sibling/x.js','base\n');
  git('add','.'); git('commit','-qm','base');
  const base = git('rev-parse','HEAD');
  const graph = (project = {}) => {
    put('app/.ua/knowledge-graph.json', JSON.stringify({
      project:{sourceRoot:join(root,'app'),gitCommitHash:base,workingTreeDirty:false,...project},
      nodes:[{id:'file:a',filePath:'a.js'},{id:'file:old',filePath:'old.js'},{id:'file:caller',filePath:'caller.js'}],
      edges:[{source:'file:caller',target:'file:a',type:'imports',direction:'forward',weight:1}],
      layers:[{id:'core',nodeIds:['file:a','file:caller']}]
    }));
  };
  graph();
  return {root,sourceRoot:join(root,'app'),git,put,base,graph};
}

test('all local classes are retained, including spaces/newlines/deletions and unmapped files', t => {
  const f=fixture(t);
  f.put('app/new staged.js','staged\n'); f.git('add','app/new staged.js');
  f.put('app/a.js','unstaged\n'); f.git('rm','-q','app/old.js');
  f.put('app/new\nfile.js','untracked\n'); f.put('sibling/x.js','outside\n');
  const c=collectContext({sourceRoot:f.sourceRoot});
  assert.deepEqual(c.changedFiles,['a.js','new\nfile.js','new staged.js','old.js']);
  assert.deepEqual(c.changeSources.staged,['new staged.js','old.js']);
  assert.deepEqual(c.changeSources.unstaged,['a.js']);
  assert.deepEqual(c.changeSources.untracked,['new\nfile.js']);
  assert.deepEqual(c.unmappedFiles,['new\nfile.js','new staged.js']);
  assert.deepEqual(c.changedNodeIds,['file:a','file:old']);
  assert.deepEqual(c.affectedNodeIds,['file:caller']);
  assert.equal(c.edges[0].type,'imports');
  assert.equal(c.baseCommitHash,f.base); assert.equal(c.headCommitHash,f.base); assert.equal(c.graphCommitHash,f.base);
});

test('explicit branch base uses merge-base and retains committed plus all local changes', t => {
  const f=fixture(t); f.git('branch','target');
  f.put('app/a.js','feature\n'); f.git('add','app/a.js'); f.git('commit','-qm','feature');
  const head=f.git('rev-parse','HEAD');
  f.git('checkout','-q','target'); f.put('app/target-only.js','target\n'); f.git('add','app/target-only.js'); f.git('commit','-qm','target');
  const target=f.git('rev-parse','HEAD'); f.git('checkout','-q','--detach',head);
  f.put('app/new.js','local\n');
  const c=collectContext({sourceRoot:f.sourceRoot,baseRef:'target'});
  assert.equal(c.baseCommitHash,f.base); assert.equal(c.baseRefCommitHash,target); assert.equal(c.headCommitHash,head);
  assert.deepEqual(c.changeSources.committed,['a.js']); assert.deepEqual(c.changedFiles,['a.js','new.js']);
});

test('PR refs exclude unrelated local files and never change checkout', t => {
  const f=fixture(t); f.put('app/a.js','feature\n'); f.git('add','app/a.js'); f.git('commit','-qm','feature');
  const head=f.git('rev-parse','HEAD'); f.git('checkout','-q','--detach',f.base); f.put('app/local.js','local\n');
  const c=collectContext({sourceRoot:f.sourceRoot,baseRef:f.base,headRef:head,committedOnly:true});
  assert.equal(f.git('rev-parse','HEAD'),f.base); assert.deepEqual(c.changedFiles,['a.js']); assert.deepEqual(c.changeSources.untracked,[]);
  assert.equal(c.headCommitHash,head);
});

test('invalid or ambiguous comparison inputs fail instead of silently selecting main', t => {
  const f=fixture(t);
  assert.throws(()=>collectContext({sourceRoot:f.sourceRoot,baseRef:'missing-ref'}),/commit/i);
  assert.throws(()=>collectContext({sourceRoot:f.sourceRoot,headRef:f.base}),/committed-only/i);
  assert.throws(()=>collectContext({sourceRoot:f.sourceRoot,committedOnly:true}),/base/i);
});

test('sibling-only commits and data artifacts do not mark graph stale', t => {
  const f=fixture(t); f.put('sibling/x.js','new\n'); f.git('add','sibling/x.js'); f.git('commit','-qm','sibling');
  f.put('app/.ua/diff-overlay.json','{}'); f.put('app/.understand-anything-other','source\n');
  const c=collectContext({sourceRoot:f.sourceRoot});
  assert.deepEqual(c.graphDrift.committed,[]); assert.deepEqual(c.changedFiles,['.understand-anything-other']);
  rmSync(join(f.sourceRoot,'.understand-anything-other'));
  assert.deepEqual(collectContext({sourceRoot:f.sourceRoot}).warnings,[]);
});

test('unbound, copied, dirty or invalid graph baselines warn but still map changed nodes', t => {
  const f=fixture(t); f.graph({sourceRoot:'/different/checkout',workingTreeDirty:true,gitCommitHash:'bad-ref'});
  f.put('app/a.js','changed\n');
  const c=collectContext({sourceRoot:f.sourceRoot});
  assert.ok(c.warnings.some(x=>/source root/i.test(x))); assert.ok(c.warnings.some(x=>/dirty|uncommitted/i.test(x)));
  assert.ok(c.warnings.some(x=>/commit/i.test(x))); assert.deepEqual(c.changedNodeIds,['file:a']);
  f.graph({sourceRoot:undefined,workingTreeDirty:undefined});
  assert.ok(collectContext({sourceRoot:f.sourceRoot}).warnings.some(x=>/source root/i.test(x)));
});

test('content and graph digests prevent writing an overlay after inputs change', t => {
  const f=fixture(t); f.put('app/a.js','first\n');
  const c=collectContext({sourceRoot:f.sourceRoot});
  f.put('app/a.js','second\n'); assert.throws(()=>writeOverlay(c),/changed/i);
  const fresh=collectContext({sourceRoot:f.sourceRoot});
  const path=writeOverlay(fresh); const overlay=JSON.parse(readFileSync(path,'utf8'));
  assert.deepEqual(overlay.changedNodeIds,['file:a']); assert.equal(overlay.baseCommitHash,f.base); assert.equal(overlay.graphContentHash,fresh.graphContentHash);
  assert.equal(collectContext({sourceRoot:f.sourceRoot}).workingTreeHash,fresh.workingTreeHash);
  f.graph({description:'new graph'}); assert.throws(()=>writeOverlay(fresh),/changed/i);
});

test('staged content identity differs when final file content is the same', t => {
  const f=fixture(t); f.put('app/a.js','staged one\n'); f.git('add','app/a.js'); f.put('app/a.js','final\n');
  const a=collectContext({sourceRoot:f.sourceRoot});
  f.put('app/a.js','staged two\n'); f.git('add','app/a.js'); f.put('app/a.js','final\n');
  assert.notEqual(collectContext({sourceRoot:f.sourceRoot}).workingTreeHash,a.workingTreeHash);
});

test('linked worktree is analyzed in place; legacy graph directory wins', t => {
  const f=fixture(t); const wt=join(f.root,'wt'); f.git('worktree','add','-q','--detach',wt);
  const sourceRoot=join(wt,'app'); mkdirSync(join(sourceRoot,'.understand-anything'));
  const graph=JSON.parse(readFileSync(join(f.sourceRoot,'.ua/knowledge-graph.json'),'utf8')); graph.project.sourceRoot=sourceRoot;
  writeFileSync(join(sourceRoot,'.understand-anything/knowledge-graph.json'),JSON.stringify(graph));
  writeFileSync(join(sourceRoot,'unique.js'),'worktree\n');
  const c=collectContext({sourceRoot}); assert.equal(c.sourceRoot,sourceRoot); assert.equal(c.uaDir,join(sourceRoot,'.understand-anything'));
  assert.deepEqual(c.changedFiles,['unique.js']);
});

test('untracked symlink hashes its link text without reading external target', t => {
  const f=fixture(t); symlinkSync('/no/such/target',join(f.sourceRoot,'link'));
  assert.deepEqual(collectContext({sourceRoot:f.sourceRoot}).changedFiles,['link']);
});

test('CLI works through a client skill symlink and writes the captured overlay', t => {
  const f=fixture(t);
  const link=join(f.root,'client-helper.mjs');
  symlinkSync(new URL('./diff-context.mjs',import.meta.url),link);
  f.put('app/a.js','changed\n');
  const output=execFileSync(process.execPath,[link,f.sourceRoot],{encoding:'utf8'});
  const context=JSON.parse(output);
  assert.deepEqual(context.changedFiles,['a.js']);
  const contextFile=join(f.root,'context.json'); writeFileSync(contextFile,output);
  const path=execFileSync(process.execPath,[link,'--write-overlay',contextFile],{encoding:'utf8'}).trim();
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')).changedNodeIds,['file:a']);
});

test('index reversal and rename endpoints remain visible even when net worktree diff is empty', t => {
  const f=fixture(t); f.put('app/a.js','staged change\n'); f.git('add','app/a.js'); f.put('app/a.js','base\n');
  f.git('mv','app/old.js','app/renamed.js');
  const c=collectContext({sourceRoot:f.sourceRoot});
  assert.deepEqual(c.changedFiles,['a.js','old.js','renamed.js']);
  assert.deepEqual(c.changeSources.staged,['a.js','old.js','renamed.js']);
  assert.deepEqual(c.changeSources.unstaged,['a.js']);
});

test('mtime-only changes stay clean without rewriting the index', t => {
  const f=fixture(t);
  const index=join(f.root,'.git','index');
  const before=readFileSync(index);
  utimesSync(join(f.sourceRoot,'a.js'),1234567890,1234567890);
  const result=collectContext({sourceRoot:f.sourceRoot});
  assert.deepEqual(result.changeSources.unstaged,[]);
  assert.deepEqual(result.changedFiles,[]);
  assert.deepEqual(readFileSync(index),before);
});

test('content-aware unstaged paths retain tabs, newlines, and mode-only changes', t => {
  const f=fixture(t);
  const filename='tab\tline\n.js';
  f.put('app/'+filename,'before\n'); f.git('add','app/'+filename); f.git('commit','-qm','odd path');
  f.put('app/'+filename,'after\n'); chmodSync(join(f.sourceRoot,'a.js'),0o755);
  const result=collectContext({sourceRoot:f.sourceRoot});
  assert.deepEqual(result.changeSources.unstaged,['a.js',filename]);
});

test('untracked nested repository remains an opaque directory without breaking overlay writes', t => {
  const f=fixture(t); const nested=join(f.sourceRoot,'nested');
  execFileSync('git',['init','-q',nested]);
  writeFileSync(join(nested,'private.txt'),'nested content\n');
  const beforeGit=readFileSync(join(nested,'.git','config'));
  const c=collectContext({sourceRoot:f.sourceRoot});
  assert.deepEqual(c.changeSources.untracked,['nested/']);
  assert.deepEqual(c.untrackedBoundaries,[{path:'nested/',type:'directory'}]);
  assert.ok(c.warnings.some(message=>/nested\//.test(message) && /not fingerprinted/i.test(message)));
  const overlay=JSON.parse(readFileSync(writeOverlay(c),'utf8'));
  assert.deepEqual(overlay.untrackedBoundaries,c.untrackedBoundaries);
  writeFileSync(join(nested,'private.txt'),'different nested content\n');
  assert.equal(collectContext({sourceRoot:f.sourceRoot}).workingTreeHash,c.workingTreeHash);
  assert.deepEqual(readFileSync(join(nested,'.git','config')),beforeGit);
  f.put('app/plain.txt','first'); const plain=collectContext({sourceRoot:f.sourceRoot});
  f.put('app/plain.txt','second'); assert.notEqual(collectContext({sourceRoot:f.sourceRoot}).workingTreeHash,plain.workingTreeHash);
  symlinkSync('plain.txt',join(f.sourceRoot,'link')); const link=collectContext({sourceRoot:f.sourceRoot});
  rmSync(join(f.sourceRoot,'link')); symlinkSync('nested/private.txt',join(f.sourceRoot,'link'));
  assert.notEqual(collectContext({sourceRoot:f.sourceRoot}).workingTreeHash,link.workingTreeHash);
});

test('untracked linked worktree inside selected project is retained without reading its directory', t => {
  const f=fixture(t); const nested=join(f.sourceRoot,'worktree');
  f.git('worktree','add','-q','--detach',nested);
  const nestedGit=readFileSync(join(nested,'.git'));
  const c=collectContext({sourceRoot:f.sourceRoot});
  assert.deepEqual(c.changeSources.untracked,['worktree/']);
  assert.deepEqual(c.untrackedBoundaries,[{path:'worktree/',type:'directory'}]);
  writeOverlay(c);
  assert.deepEqual(readFileSync(join(nested,'.git')),nestedGit);
});

test('a file replaced by FIFO after classification never blocks the CLI', t => {
  const f=fixture(t); const fifo=join(f.sourceRoot,'pipe'); writeFileSync(fifo,'ordinary file');
  const preload=join(f.root,'replace-after-lstat.mjs');
  // Inject the exact concurrent-writer timing; the file and FIFO are real.
  writeFileSync(preload,`import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {execFileSync} from 'node:child_process';
const original=fs.lstatSync;
fs.lstatSync=(path,...args)=>{
  const stat=original(path,...args);
  if(path===process.env.UA_FIFO){fs.unlinkSync(path);execFileSync('mkfifo',[path]);}
  return stat;
};
syncBuiltinESMExports();
`);
  const context=JSON.parse(execFileSync(process.execPath,['--import',preload,new URL('./diff-context.mjs',import.meta.url).pathname,f.sourceRoot],{
    encoding:'utf8',timeout:3000,env:{...process.env,UA_FIFO:fifo},
  }));
  assert.deepEqual(context.changeSources.untracked,['pipe']);
  assert.deepEqual(context.untrackedBoundaries,[{path:'pipe',type:'fifo'}]);
  assert.ok(context.warnings.some(message=>/fifo/i.test(message) && /not fingerprinted/i.test(message)));
});

test('tracked gitlink is fingerprinted by Git patches without reading its directory', t => {
  const f=fixture(t); f.git('commit','--allow-empty','-qm','alternate target');
  const other=f.git('rev-parse','HEAD'); const dependency=join(f.sourceRoot,'dependency');
  f.git('worktree','add','-q','--detach',dependency,f.base);
  f.git('update-index','--add','--cacheinfo',`160000,${f.base},app/dependency`);
  const nestedGit=readFileSync(join(dependency,'.git'));
  const first=collectContext({sourceRoot:f.sourceRoot});
  assert.deepEqual(first.changeSources.staged,['dependency']);
  assert.deepEqual(first.changeSources.untracked,[]);
  assert.deepEqual(first.untrackedBoundaries,[]);
  f.git('update-index','--cacheinfo',`160000,${other},app/dependency`);
  assert.notEqual(collectContext({sourceRoot:f.sourceRoot}).workingTreeHash,first.workingTreeHash);
  assert.deepEqual(readFileSync(join(dependency,'.git')),nestedGit);
});
