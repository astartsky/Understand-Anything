import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SKILL = Path(os.environ.get('KNOWLEDGE_SKILL_DIR', Path(__file__).resolve().parents[1]))

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), SKILL / name)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

parser = load('parse-knowledge-base.py')
merger = load('merge-knowledge-graph.py')

class KnowledgeSafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='knowledge-safety-')
        self.root = Path(self.temp.name).resolve()
        self.write('index.md', '# Research\n## Ideas\n[[wiki/A#Section|A]]\n[[wiki/B.md]]\n')
        self.write('wiki/A.md', '# A\n\nA claim is a statement. ^a\n\n## Section\n[[B#Section|label]] ![[B#^b]] [[B.md]] [[#Section]] [[#^a]]\n')
        self.write('wiki/B.md', '# B\n\nA different statement. ^b\n\n## Section\n')
        self.write('wiki/log.md', '# Log\n')

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def scan(self):
        manifest = parser.parse_wiki(self.root)
        out = parser.resolve_ua_dir(self.root) / 'intermediate'
        out.mkdir(parents=True, exist_ok=True)
        (out / 'scan-manifest.json').write_text(json.dumps(manifest))
        return manifest, out

    def batch(self, out, manifest, nodes, edges=None):
        (out / 'analysis-batch-1.json').write_text(json.dumps({
            'scanId': manifest.get('scanId'), 'nodes': nodes, 'edges': edges or []}))

    def claim(self, **kwargs):
        return {'id': 'claim:a:statement', 'name': 'Statement', 'type': 'claim',
                'summary': 'A claim is a statement.', **kwargs}

    def test_heading_block_alias_embed_and_md_extension(self):
        m, _ = self.scan()
        self.assertEqual(m['stats']['unresolved'], 0, m['warnings'])
        self.assertIn(('article:A', 'article:B'), {(e['source'], e['target']) for e in m['edges']})
        a = next(n for n in m['nodes'] if n['id'] == 'article:A')
        links = a['knowledgeMeta']['links']
        self.assertTrue(any(l['embed'] and l['subpath'] == '^b' and l['resolvedId'] == 'article:B' for l in links))
        self.assertTrue(any(l['display'] == 'label' and l['subpath'] == 'Section' for l in links))
        self.assertEqual(a['knowledgeMeta']['category'], 'Ideas')

    def test_hidden_raw_symlink_and_own_output_excluded_on_repeat(self):
        self.write('wiki/.ua/intermediate/copied.md', '[[Ghost]]')
        self.write('wiki/.understand-anything/old.md', '[[Ghost]]')
        self.write('wiki/.hidden/hidden.md', '[[Ghost]]')
        self.write('wiki/raw/inside.md', '[[Ghost]]')
        self.write('raw/.hidden/secret.md', 'secret')
        self.write('raw/source.md', '# Source')
        (self.root / 'wiki' / 'external.md').symlink_to(self.root / 'raw/source.md')
        one, _ = self.scan()
        two, _ = self.scan()
        self.assertEqual([n['id'] for n in two['nodes'] if n['type'] == 'article'], ['article:A', 'article:B'])
        self.assertEqual(one['stats'], two['stats'])
        self.assertEqual(two['stats']['sources'], 1)

    def test_ambiguous_short_link_stays_unresolved(self):
        self.write('wiki/one/Duplicate.md', '# One')
        self.write('wiki/two/Duplicate.md', '# Two')
        self.write('wiki/A.md', '# A\n[[Duplicate]] [[one/Duplicate]]')
        m, _ = self.scan()
        self.assertEqual(m['stats']['unresolved'], 1)
        related = [e['target'] for e in m['edges'] if e['source'] == 'article:A' and e['type'] == 'related']
        self.assertEqual(related, ['article:one/Duplicate'])

    def test_raw_extensions_have_unique_ids_and_embeds_resolve(self):
        self.write('raw/paper.md', 'Source text')
        self.write('raw/paper.pdf', 'test PDF inventory')
        self.write('wiki/A.md', '# A\n![[raw/paper.pdf#page=2]] [[raw/paper.md]]')
        m, _ = self.scan()
        sources = [n for n in m['nodes'] if n['type'] == 'source']
        self.assertEqual(len({n['id'] for n in sources}), 2)
        self.assertEqual(m['stats']['unresolved'], 0, m['warnings'])
        self.assertTrue(all(n['knowledgeMeta']['extraction'] == 'inventory-only' for n in sources))

    def test_article_paths_are_relative_to_selected_source_root(self):
        m, _ = self.scan()
        for n in m['nodes']:
            if n['type'] == 'article':
                self.assertTrue((self.root / n['filePath']).is_file(), n['filePath'])
                self.assertEqual(n['knowledgeMeta']['sourceRoot'], str(self.root))
                self.assertEqual(len(n['knowledgeMeta']['sha256']), 64)

    def test_analysis_cannot_overwrite_base_nodes_or_invent_sources(self):
        m, out = self.scan()
        self.batch(out, m, [{'id': 'article:A', 'type': 'article', 'name': 'overwrite'},
                            {'id': 'source:fake', 'type': 'source', 'name': 'Fake'}])
        g = merger.merge(self.root)
        self.assertEqual(next(n['name'] for n in g['nodes'] if n['id'] == 'article:A'), 'A')
        self.assertNotIn('source:fake', {n['id'] for n in g['nodes']})

    def test_claim_requires_traceable_quote_and_preserves_provenance(self):
        m, out = self.scan()
        good = self.claim(knowledgeMeta={'provenance': [{'articleId': 'article:A', 'quote': 'A claim is a statement.'}]})
        bad = self.claim(id='claim:invented', knowledgeMeta={'provenance': [{'articleId': 'article:B', 'quote': 'Not in text'}]})
        self.batch(out, m, [good, bad, self.claim(id='claim:unattributed')])
        g = merger.merge(self.root)
        self.assertEqual([n['id'] for n in g['nodes'] if n['type'] == 'claim'], ['claim:a:statement'])
        self.assertEqual(next(n for n in g['nodes'] if n['id'] == good['id'])['knowledgeMeta']['provenance'][0]['articleId'], 'article:A')

    def test_stale_batch_is_not_merged(self):
        m, out = self.scan()
        self.batch(out, m, [self.claim()])
        self.scan()
        g = merger.merge(self.root)
        self.assertFalse(any(n['type'] == 'claim' for n in g['nodes']))

    def test_save_preserves_originals_and_unknown_intermediate_files(self):
        m, out = self.scan()
        keep = self.write('.ua/intermediate/user-data.md', 'keep me')
        original = (self.root / 'wiki/A.md').read_bytes()
        result = subprocess.run([sys.executable, str(SKILL / 'merge-knowledge-graph.py'), str(self.root), '--save'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        graph_path = self.root / '.ua/knowledge-graph.json'
        self.assertTrue(graph_path.is_file())
        graph = json.loads(graph_path.read_text())
        meta = json.loads((graph_path.parent / 'meta.json').read_text())
        self.assertEqual(meta['sourceRoot'], str(self.root))
        self.assertEqual(graph['project']['sourceRoot'], str(self.root))
        self.assertTrue(meta['workingTreeDirty'])  # non-Git source has no clean baseline
        self.assertEqual(keep.read_text(), 'keep me')
        self.assertEqual((self.root / 'wiki/A.md').read_bytes(), original)

    def test_changed_input_cannot_be_saved_as_current_scan(self):
        self.scan()
        self.write('wiki/A.md', '# A\nChanged after scan')
        result = subprocess.run([sys.executable, str(SKILL / 'merge-knowledge-graph.py'), str(self.root), '--save'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / '.ua/knowledge-graph.json').exists())

    def test_code_examples_are_not_edges(self):
        self.write('wiki/A.md', '# A\n`[[Ghost]]`\n```md\n[[Ghost]]\n```\n~~~md\n[[Ghost]]\n~~~\n<!-- [[Ghost]] -->\n%% [[Ghost]] %%\n[[B]]')
        m, _ = self.scan()
        self.assertEqual(m['stats']['unresolved'], 0)
        self.assertEqual(m['stats']['wikilinks'], 1)

    def test_invalid_inference_edge_does_not_crash_or_publish(self):
        m, out = self.scan()
        evidence = {'provenance': [{'articleId': 'article:A', 'quote': 'A claim is a statement.'}]}
        self.batch(out, m, [], [
            {'source': [], 'target': 'article:B', 'type': 'related', 'knowledgeMeta': evidence},
            {'source': 'article:A', 'target': 'article:B', 'type': 'related', 'weight': 2, 'knowledgeMeta': evidence},
            {'source': 'article:A', 'target': 'article:B', 'type': 'related', 'direction': 'wrong', 'knowledgeMeta': evidence}])
        g = merger.merge(self.root, save=True)
        self.assertTrue(all(0 <= e['weight'] <= 1 and e['direction'] in ('forward', 'backward', 'bidirectional') for e in g['edges']))

    def test_symlink_index_is_rejected(self):
        external = self.write('outside.md', '# Outside\n## Secret\n[[B]]')
        (self.root / 'index.md').unlink()
        (self.root / 'index.md').symlink_to(external)
        self.write('wiki/index.md', '# Real\n## Ideas\n[[B]]')
        with self.assertRaises(ValueError):
            self.scan()

    def test_symlink_output_cannot_overwrite_an_original(self):
        self.scan()
        original = self.root / 'wiki/A.md'
        (self.root / '.ua/knowledge-graph.json').symlink_to(original)
        before = original.read_bytes()
        result = subprocess.run([sys.executable, str(SKILL / 'merge-knowledge-graph.py'), str(self.root), '--save'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(original.read_bytes(), before)

    def test_manifest_symlink_is_not_trusted(self):
        _, out = self.scan()
        target = self.root / 'scan-copy.json'
        (out / 'scan-manifest.json').rename(target)
        (out / 'scan-manifest.json').symlink_to(target)
        result = subprocess.run([sys.executable, str(SKILL / 'merge-knowledge-graph.py'), str(self.root), '--save'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_added_article_invalidates_scan(self):
        self.scan()
        self.write('wiki/New.md', '# New')
        result = subprocess.run([sys.executable, str(SKILL / 'merge-knowledge-graph.py'), str(self.root), '--save'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_entity_dedup_retains_all_article_attribution(self):
        m, out = self.scan()
        entity = {'id': 'entity:statement', 'type': 'entity', 'name': 'Statement',
                  'knowledgeMeta': {'provenance': [{'articleId': 'article:A', 'quote': 'A claim is a statement.'}]}}
        duplicate = {'id': 'entity:statement', 'type': 'entity', 'name': 'Statement',
                     'knowledgeMeta': {'provenance': [{'articleId': 'article:B', 'quote': 'A different statement.'}]}}
        self.batch(out, m, [entity, duplicate])
        g = merger.merge(self.root)
        evidence = next(n for n in g['nodes'] if n['id'] == 'entity:statement')['knowledgeMeta']['provenance']
        self.assertEqual({item['articleId'] for item in evidence}, {'article:A', 'article:B'})

    def test_malformed_inferred_node_does_not_block_base_graph(self):
        m, out = self.scan()
        self.batch(out, m, [self.claim(tags='wrong type', knowledgeMeta={'provenance': [{'articleId': 'article:A', 'quote': 'A claim is a statement.'}]})])
        merger.merge(self.root, save=True)
        g = json.loads((self.root / '.ua/knowledge-graph.json').read_text())
        self.assertFalse(any(n['type'] == 'claim' for n in g['nodes']))

    def test_flat_wiki_raw_markdown_is_only_a_source(self):
        for file in (self.root / 'wiki').iterdir():
            file.rename(self.root / file.name)
        (self.root / 'wiki').rmdir()
        self.write('raw/source.md', '# Raw\n[[Ghost]]')
        m, _ = self.scan()
        self.assertEqual(m['stats']['articles'], 2)
        self.assertEqual(m['stats']['sources'], 1)
        self.assertEqual(m['stats']['unresolved'], 0)

    def test_legacy_output_cli_and_repeat_scan(self):
        (self.root / '.understand-anything').mkdir()
        for _ in range(2):
            scan = subprocess.run([sys.executable, str(SKILL / 'parse-knowledge-base.py'), str(self.root)], capture_output=True, text=True)
            self.assertEqual(scan.returncode, 0, scan.stderr)
            merge = subprocess.run([sys.executable, str(SKILL / 'merge-knowledge-graph.py'), str(self.root), '--save'], capture_output=True, text=True)
            self.assertEqual(merge.returncode, 0, merge.stderr)
        g = json.loads((self.root / '.understand-anything/knowledge-graph.json').read_text())
        self.assertEqual({n['id'] for n in g['nodes'] if n['type'] == 'article'}, {'article:A', 'article:B'})
        self.assertFalse((self.root / '.ua').exists())

    def test_summary_keeps_paragraph_immediately_after_heading(self):
        self.write('wiki/A.md', '# A\nA paragraph without an intervening blank line.\n')
        m, _ = self.scan()
        article = next(n for n in m['nodes'] if n['id'] == 'article:A')
        self.assertEqual(article['summary'], 'A paragraph without an intervening blank line.')

    def test_git_without_commit_is_never_a_clean_baseline(self):
        git = subprocess.run(['git', 'init', '-q', str(self.root)], capture_output=True, text=True)
        self.assertEqual(git.returncode, 0, git.stderr)
        self.write('.gitignore', '*\n')
        m, _ = self.scan()
        self.assertEqual(m['gitCommitHash'], '')
        self.assertTrue(m['workingTreeDirty'])

    def test_duplicate_implicit_edges_keep_all_evidence(self):
        self.write('wiki/A.md', '# A\nA builds on B.\n')
        self.write('wiki/B.md', '# B\nA builds on B.\n')
        m, out = self.scan()
        edges = [{'source': 'article:A', 'target': 'article:B', 'type': 'builds_on',
                  'knowledgeMeta': {'provenance': [{'articleId': article, 'quote': 'A builds on B.'}]}}
                 for article in ('article:A', 'article:B')]
        self.batch(out, m, [], edges)
        g = merger.merge(self.root)
        edge = next(e for e in g['edges'] if e['type'] == 'builds_on')
        self.assertEqual({p['articleId'] for p in edge['knowledgeMeta']['provenance']}, {'article:A', 'article:B'})

    @patch.dict(os.environ, {'GIT_OPTIONAL_LOCKS': '1'})
    def test_parse_and_merge_preserve_index_bytes_and_mtime_with_content_aware_cleanliness(self):
        def git(*args):
            return subprocess.run(['git', '-C', str(self.root), *args],
                                  check=True, capture_output=True, text=True)
        git('init', '-q')
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.invalid')
        self.write('.gitignore', '.ua/\n.understand-anything/\n')
        git('add', '.')
        git('commit', '-qm', 'Wiki baseline')
        index = self.root / '.git/index'
        article = self.root / 'wiki/A.md'
        for dirty in (False, True):
            with self.subTest(content_changed=dirty):
                if dirty:
                    article.write_text('# A\nChanged source bytes.\n', encoding='utf-8')
                # Force stale stat-cache data, even on coarse timestamp filesystems.
                os.utime(article, (1234567890, 1234567890))
                os.utime(index, (1234567880, 1234567880))
                before = (index.read_bytes(), index.stat().st_mtime_ns)
                manifest, _ = self.scan()
                self.assertEqual(manifest['workingTreeDirty'], dirty)
                self.assertEqual((index.read_bytes(), index.stat().st_mtime_ns), before,
                                 'parse refreshed the Git index')
                graph = merger.merge(self.root, save=True)
                self.assertEqual(graph['project']['workingTreeDirty'], dirty)
                self.assertEqual((index.read_bytes(), index.stat().st_mtime_ns), before,
                                 'merge refreshed the Git index')

if __name__ == '__main__':
    unittest.main()
