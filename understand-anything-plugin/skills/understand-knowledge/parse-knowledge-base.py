#!/usr/bin/env python3
"""Scan an existing Karpathy wiki without modifying its sources.

Usage: python3 parse-knowledge-base.py <wiki-directory>
Writes <selected-root>/.ua/intermediate/scan-manifest.json (existing legacy
.understand-anything takes precedence). Python standard library only.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

WIKILINK_RE = re.compile(r"(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
INFRA_FILES = {"index.md", "log.md", "claude.md", "agents.md", "soul.md"}


def resolve_ua_dir(root: Path) -> Path:
    legacy = root / ".understand-anything"
    selected = legacy if legacy.is_dir() else root / ".ua"
    # Never write through an existing symlink, including a linked intermediate.
    for path in (selected, selected / "intermediate"):
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise ValueError(f"Generated data path must be a real directory: {path}")
    return selected


def visible_files(root: Path, *, exclude_raw=False):
    """Prune hidden trees and symlinks before traversal, including our own output."""
    if root.is_symlink() or not root.is_dir():
        return
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.')
                         and not (exclude_raw and d == 'raw')
                         and not (Path(current) / d).is_symlink())
        for name in sorted(files):
            path = Path(current) / name
            if not name.startswith('.') and not path.is_symlink() and path.is_file():
                yield path


def markdown_files(root: Path):
    return [p for p in visible_files(root, exclude_raw=True) if p.suffix.lower() == '.md']


def find_markdown_case_insensitive(parent: Path, name: str) -> Path:
    candidate = parent / name
    if candidate.is_file() and not candidate.is_symlink():
        return candidate
    if parent.is_dir() and not parent.is_symlink():
        for child in sorted(parent.iterdir()):
            if child.is_file() and not child.is_symlink() and child.name.lower() == name.lower():
                return child
    if candidate.is_symlink():
        raise ValueError(f'Refusing symlink infrastructure: {candidate}')
    return candidate


def detect_format(root: Path) -> dict:
    wiki_root = root / 'wiki' if (root / 'wiki').is_dir() else root
    files = markdown_files(wiki_root)
    signals = {
        'wiki_root': str(wiki_root), 'md_count': len(files),
        'has_index': any(find_markdown_case_insensitive(p, 'index.md').is_file() for p in (root, wiki_root)),
        'has_log': any(find_markdown_case_insensitive(p, 'log.md').is_file() for p in (root, wiki_root)),
        'has_raw': (root / 'raw').is_dir() and not (root / 'raw').is_symlink(),
        'has_schema': any((p / n).is_file() for p in (root, wiki_root) for n in ('CLAUDE.md', 'AGENTS.md')),
    }
    signals['detected'] = signals['has_index'] and len(files) >= 3
    signals['format'] = 'karpathy' if signals['detected'] else 'unknown'
    return signals


def extract_frontmatter(text: str) -> dict:
    """Best-effort scalar hints, not a YAML parser or authority for instructions."""
    match = FRONTMATTER_RE.match(text)
    return {key.strip(): value.strip().strip('\"\'')
            for line in match.group(1).splitlines() if ':' in line
            for key, value in [line.split(':', 1)]} if match else {}


def prose_only(text: str) -> str:
    """Mask examples/comments so their wikilinks do not become graph edges."""
    text = FRONTMATTER_RE.sub('', text)
    text = re.sub(r'<!--.*?-->|%%.*?%%', '', text, flags=re.DOTALL)
    lines, fence = [], None
    for line in text.splitlines():
        match = re.match(r'^\s{0,3}(`{3,}|~{3,})', line)
        if match:
            marker = match.group(1)
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence):
                fence = None
            lines.append('')
        else:
            lines.append('' if fence else line)
    return re.sub(r'(`+).*?\1', '', '\n'.join(lines))


def extract_wikilinks(text: str) -> list[dict]:
    links = []
    for match in WIKILINK_RE.finditer(prose_only(text)):
        target = match.group(2).strip()
        page, sep, subpath = target.partition('#')
        links.append({'target': target, 'page': page.strip(),
                      'subpath': subpath if sep else None,
                      'display': match.group(3).strip() if match.group(3) else None,
                      'embed': bool(match.group(1))})
    return links


def extract_headings(text: str) -> list[dict]:
    return [{'level': len(m.group(1)), 'text': m.group(2).strip()}
            for m in HEADING_RE.finditer(prose_only(text))]


def extract_h1(text: str) -> str:
    return next((h['text'] for h in extract_headings(text) if h['level'] == 1), '')


def extract_first_paragraph(text: str) -> str:
    paragraphs = re.split(r'\n\s*\n', HEADING_RE.sub('', prose_only(text)).strip())
    value = next((' '.join(p.split()) for p in paragraphs if p.strip() and not p.lstrip().startswith(('#', '>'))), '')
    return value[:197] + '...' if len(value) > 200 else value


def parse_index(path: Path) -> list[dict]:
    if not path.is_file() or path.is_symlink():
        return []
    categories, current = [], None
    for line in prose_only(path.read_text(encoding='utf-8')).splitlines():
        heading = re.match(r'^##\s+(.+)$', line)
        if heading:
            current = {'name': heading.group(1).strip(), 'articles': []}
            categories.append(current)
        elif current is not None:
            current['articles'].extend(link['target'] for link in extract_wikilinks(line))
    return categories


def parse_log(path: Path) -> list[dict]:
    if not path.is_file() or path.is_symlink():
        return []
    return [{'date': m[0], 'operation': m[1], 'title': m[2]}
            for m in re.findall(r'^##\s+\[(\d{4}-\d{2}-\d{2})\]\s+(\w+)\s*\|\s*(.+)$',
                                path.read_text(encoding='utf-8'), re.MULTILINE)]


def build_name_to_stem_map(wiki_root: Path) -> dict[str, str]:
    """Keep exact relative paths and only unique short/suffix paths."""
    candidates = {}
    for path in markdown_files(wiki_root):
        stem = path.relative_to(wiki_root).with_suffix('').as_posix()
        parts = stem.split('/')
        for i in range(len(parts)):
            candidates.setdefault('/'.join(parts[i:]).lower(), set()).add(stem)
    return {name: next(iter(stems)) for name, stems in candidates.items() if len(stems) == 1}


def resolve_wikilink(target, name_map, node_ids=None, root_prefix=None, current_id=None):
    page = target.split('|', 1)[0].partition('#')[0].strip()
    if not page:
        return current_id
    if page.lower().endswith('.md'):
        page = page[:-3]
    key = page.lower()
    keys = [key]
    if root_prefix and key.startswith(root_prefix.lower() + '/'):
        keys.insert(0, key[len(root_prefix) + 1:])
    for key in keys:
        if key in name_map:
            candidate = f'article:{name_map[key]}'
            if node_ids is None or candidate in node_ids:
                return candidate
    return None


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def source_snapshot(root):
    """Only the files used by this scanner; output/hidden trees cannot feed back."""
    wiki_root = root / 'wiki' if (root / 'wiki').is_dir() else root
    files = set(markdown_files(wiki_root)) | set(visible_files(root / 'raw'))
    for name in ('index.md', 'log.md', 'CLAUDE.md', 'AGENTS.md'):
        path = find_markdown_case_insensitive(root, name)
        if path.is_file() and not path.is_symlink():
            files.add(path)
    return {p.relative_to(root).as_posix(): file_hash(p) for p in sorted(files)}


def source_state(root, input_files=None):
    # Content-aware status must not refresh the index stat cache.
    def git(args):
        result = subprocess.run(['git', '--no-optional-locks', '-C', str(root), *args], capture_output=True, text=True, timeout=5)
        return result.stdout.strip() if result.returncode == 0 else None
    try:
        commit = git(['rev-parse', '--verify', 'HEAD']) or ''
        status = git(['status', '--porcelain=v1', '--untracked-files=all', '--', '.', ':(exclude).ua', ':(exclude).understand-anything'])
        tracked = git(['ls-files', '--cached', '-z', '--', '.'])
        untracked_inputs = bool(input_files) and (tracked is None or bool(set(input_files) - set(tracked.split('\0'))))
        return {'sourceRoot': str(root), 'gitCommitHash': commit,
                'workingTreeDirty': not commit or status is None or bool(status) or untracked_inputs}
    except (OSError, subprocess.TimeoutExpired):
        return {'sourceRoot': str(root), 'gitCommitHash': '', 'workingTreeDirty': True}


def atomic_json(path, value):
    if path.is_symlink():
        raise ValueError(f'Refusing symlink output: {path}')
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def parse_wiki(root: Path) -> dict:
    root = root.resolve()
    detection = detect_format(root)
    if not detection['detected']:
        print(json.dumps({'error': 'Not a Karpathy-pattern wiki', 'detection': detection}), file=sys.stderr)
        raise SystemExit(1)
    snapshot = source_snapshot(root)
    wiki_root = Path(detection['wiki_root'])
    prefix = wiki_root.name if wiki_root != root else None
    articles = [p for p in markdown_files(wiki_root)
                if not (p.parent == wiki_root and p.name.lower() in INFRA_FILES)]
    name_map = build_name_to_stem_map(wiki_root)
    article_ids = {f'article:{p.relative_to(wiki_root).with_suffix("").as_posix()}' for p in articles}
    index = find_markdown_case_insensitive(wiki_root, 'index.md')
    if not index.is_file():
        index = find_markdown_case_insensitive(root, 'index.md')
    categories = parse_index(index)
    category_by_id = {}
    for category in categories:
        for target in category['articles']:
            article_id = resolve_wikilink(target, name_map, article_ids, prefix)
            if article_id:
                category_by_id[article_id] = category['name']
    nodes, edges, warnings = [], [], []
    stats = {'articles': 0, 'sources': 0, 'topics': 0, 'wikilinks': 0, 'unresolved': 0}
    source_names = {}
    for path in visible_files(root / 'raw'):
        rel = path.relative_to(root).as_posix()
        source_id = f'source:{rel}'  # keep extension: paper.md and paper.pdf differ
        nodes.append({'id': source_id, 'type': 'source', 'name': path.name, 'filePath': rel,
                      'summary': f'Raw source inventory: {path.name}', 'tags': ['raw'], 'complexity': 'simple',
                      'knowledgeMeta': {'extraction': 'inventory-only', 'sourceRoot': str(root),
                                        'sha256': snapshot[rel], 'sizeBytes': path.stat().st_size}})
        stats['sources'] += 1
        for name in (rel, path.relative_to(root / 'raw').as_posix(), path.name):
            source_names.setdefault(name.lower(), set()).add(source_id)
    for path in articles:
        rel = path.relative_to(root).as_posix()
        stem = path.relative_to(wiki_root).with_suffix('').as_posix()
        node_id = f'article:{stem}'
        text = path.read_text(encoding='utf-8')
        links = extract_wikilinks(text)
        category = category_by_id.get(node_id, '')
        frontmatter = extract_frontmatter(text)
        tags = {category.lower()} if category else set()
        parent = path.relative_to(wiki_root).parent
        if parent != Path('.'):
            tags.add(parent.as_posix())
        if frontmatter.get('tags'):
            tags.update(tag.strip() for tag in frontmatter['tags'].split(',') if tag.strip())
        for link in links:
            target = resolve_wikilink(link['target'], name_map, article_ids, prefix, node_id)
            if target is None:
                candidates = source_names.get(link['page'].lower(), set())
                target = next(iter(candidates)) if len(candidates) == 1 else None
            link['resolvedId'] = target
            # Fragment is retained, not claimed to have been validated against headings/blocks.
            link['anchorValidated'] = False if link['subpath'] is not None else None
            if target and target != node_id:
                edges.append({'source': node_id, 'target': target, 'type': 'related', 'direction': 'forward', 'weight': 0.7})
            elif not target:
                stats['unresolved'] += 1
                warnings.append(f"Unresolved wikilink: [[{link['target']}]] in {rel}")
        nodes.append({'id': node_id, 'type': 'article', 'name': extract_h1(text) or path.stem,
                      'filePath': rel, 'summary': extract_first_paragraph(text) or f'Wiki article: {path.stem}',
                      'tags': sorted(tags),
                      'complexity': 'complex' if len(links) > 15 else 'moderate' if len(links) > 5 else 'simple',
                      'knowledgeMeta': {'wikilinks': [link['target'] for link in links], 'links': links,
                                        'sourceRoot': str(root), 'sha256': snapshot[rel],
                                        'content': text[:3000], 'contentTruncated': len(text) > 3000,
                                        'frontmatter': frontmatter,
                                        **({'category': category} if category else {})}})
        stats['articles'] += 1
        stats['wikilinks'] += len(links)
    for category in categories:
        topic_id = 'topic:' + category['name'].lower().replace(' ', '-')
        if not any(n['id'] == topic_id for n in nodes):
            nodes.append({'id': topic_id, 'type': 'topic', 'name': category['name'], 'summary': f"Index category: {category['name']}", 'tags': ['category'], 'complexity': 'simple'})
            stats['topics'] += 1
        for target in category['articles']:
            article_id = resolve_wikilink(target, name_map, article_ids, prefix)
            if article_id:
                edges.append({'source': article_id, 'target': topic_id, 'type': 'categorized_under', 'direction': 'forward', 'weight': 0.6})
    edges = list({(e['source'], e['target'], e['type']): e for e in edges}.values())
    for node in nodes:
        if node['type'] == 'article':
            node['knowledgeMeta']['backlinks'] = [e['source'] for e in edges if e['type'] == 'related' and e['target'] == node['id']]
    log = find_markdown_case_insensitive(wiki_root, 'log.md')
    if not log.is_file():
        log = find_markdown_case_insensitive(root, 'log.md')
    if source_snapshot(root) != snapshot:
        raise ValueError('Source changed during scan; rerun before analysis')
    return {'format': 'karpathy', 'scanId': uuid.uuid4().hex, **source_state(root, snapshot), 'inputFiles': snapshot,
            'stats': stats, 'categories': [{'name': c['name'], 'count': len(c['articles'])} for c in categories],
            'logEntries': len(parse_log(log)), 'nodes': nodes, 'edges': edges, 'warnings': warnings[:50]}


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('wiki_directory', type=Path)
    args = cli.parse_args()
    root = args.wiki_directory.resolve()
    if not root.is_dir():
        cli.error(f'Not a directory: {root}')
    try:
        out = resolve_ua_dir(root) / 'intermediate'
        manifest = parse_wiki(root)
        out.mkdir(parents=True, exist_ok=True)
        atomic_json(out / 'scan-manifest.json', manifest)
        print(f"[parse] Candidate Karpathy wiki: {manifest['stats']}", file=sys.stderr)
        print(f'[parse] Output: {out / "scan-manifest.json"}', file=sys.stderr)
    except (OSError, ValueError) as error:
        cli.exit(1, f'[parse] {error}\n')

if __name__ == '__main__':
    main()
