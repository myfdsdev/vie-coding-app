'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { FileChange } from '@/agent/types';

interface TreeNode {
  name: string;
  path: string;
  /** null for a file */
  children: TreeNode[] | null;
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children!.find((c) => c.name === part && (c.children === null) === isFile);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join('/'), children: isFile ? null : [] };
        node.children!.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      if ((a.children === null) !== (b.children === null)) return a.children === null ? 1 : -1; // folders first
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.children) sort(n.children);
    return nodes;
  };
  return sort(root.children!);
}

// Green = created this turn, amber = modified this turn (BUILD-PROMPT §8).
const DOT: Partial<Record<FileChange, string>> = { created: 'bg-ok', renamed: 'bg-ok', modified: 'bg-accent' };

interface FileTreeProps {
  files: string[];
  /** Changes made in the latest turn. */
  marks: Record<string, FileChange>;
  /** The file being written right now, if any. */
  writing?: string;
}

export function FileTree({ files, marks, writing }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const render = (nodes: TreeNode[], depth: number): ReactNode[] =>
    nodes.flatMap((n) => {
      const indent = 8 + depth * 14;
      if (n.children) {
        const open = !collapsed.has(n.path);
        return [
          <button
            key={n.path}
            onClick={() => toggle(n.path)}
            className="flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-[11.5px] text-dim hover:bg-panel-2"
            style={{ paddingLeft: indent }}
          >
            {open ? <ChevronDown size={12} className="shrink-0 text-dim-2" /> : <ChevronRight size={12} className="shrink-0 text-dim-2" />}
            <span className="truncate">{n.name}</span>
          </button>,
          ...(open ? render(n.children, depth + 1) : []),
        ];
      }
      const mark = marks[n.path];
      const active = writing === n.path;
      return [
        <div
          key={n.path}
          title={n.path}
          className={
            'flex items-center gap-[7px] rounded py-1 pr-2 text-[11.5px] ' +
            (active ? 'bg-surface text-text' : mark ? 'text-text' : 'text-[#8b847b]')
          }
          style={{ paddingLeft: indent + 18 }}
        >
          {active ? (
            <span className="spinner" />
          ) : (
            mark && DOT[mark] && <span className={`h-[5px] w-[5px] shrink-0 rounded-full ${DOT[mark]}`} />
          )}
          <span className="truncate">{n.name}</span>
        </div>,
      ];
    });

  return (
    <nav className="flex w-[216px] shrink-0 flex-col border-r border-line bg-[#141312]">
      <div className="flex h-[34px] shrink-0 items-center border-b border-line px-3 text-[11px] font-semibold uppercase tracking-[0.05em] text-dim-2">
        Files
      </div>
      <div className="thin-scroll flex flex-1 flex-col gap-px overflow-y-auto px-1.5 py-2 font-mono">
        {files.length ? render(tree, 0) : <span className="px-2 py-1 font-sans text-xs text-dim-2">No files yet</span>}
      </div>
    </nav>
  );
}
