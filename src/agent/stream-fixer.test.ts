import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import ICON_LIST from './lucide-icons.json';
import { fixSource, importSpecifiers, isLucideExport, nearestIcon } from './stream-fixer';

const files = (...paths: string[]) => new Set(paths);

describe('fixSource', () => {
  it('rewrites "@/" imports, which the template cannot resolve, as relative paths', () => {
    const out = fixSource('src/pages/Home.tsx', "import { InvoiceTable } from '@/components/InvoiceTable';\n", files('src/components/InvoiceTable.tsx'));
    expect(out.content).toBe("import { InvoiceTable } from '../components/InvoiceTable';\n");
    expect(out.fixes).toEqual([{ rule: 'alias', detail: '@/components/InvoiceTable → ../components/InvoiceTable' }]);
  });

  it('points an import one folder off at the only file with that path', () => {
    const out = fixSource('src/components/InvoiceTable.tsx', "import { formatMoney } from './lib/format';\n", files('src/lib/format.ts', 'src/components/InvoiceTable.tsx'));
    expect(out.content).toBe("import { formatMoney } from '../lib/format';\n");
    expect(out.fixes[0]).toMatchObject({ rule: 'path' });
  });

  it('fixes the case of a path (the sandbox file system is case-sensitive)', () => {
    const out = fixSource('src/components/List.tsx', "import Card from './card';\n", files('src/components/Card.tsx'));
    expect(out.content).toBe("import Card from './Card';\n");
  });

  it('leaves imports that resolve, and ambiguous ones, alone', () => {
    const ok = "import Card from './Card';\n";
    expect(fixSource('src/components/List.tsx', ok, files('src/components/Card.tsx')).fixes).toEqual([]);
    const ambiguous = "import { format } from './format';\n";
    expect(fixSource('src/pages/Home.tsx', ambiguous, files('src/lib/format.ts', 'src/utils/format.ts')).content).toBe(ambiguous);
  });

  it('swaps an invented icon for the nearest real one, keeping the name the code uses', () => {
    const out = fixSource(
      'src/pages/Home.tsx',
      "import { LayoutDashbaord, CircleDollarSign as Money, ArrowUpRightIcon } from 'lucide-react';\n<LayoutDashbaord />",
      files(),
    );
    expect(out.content).toBe("import { LayoutDashboard as LayoutDashbaord, CircleDollarSign as Money, ArrowUpRightIcon } from 'lucide-react';\n<LayoutDashbaord />");
    expect(out.fixes).toEqual([{ rule: 'icon', detail: 'LayoutDashbaord → LayoutDashboard' }]);
  });

  it('does not touch non-code files', () => {
    expect(fixSource('src/index.css', "@import '@/x.css';", files()).fixes).toEqual([]);
  });
});

describe('icons', () => {
  it('knows real icons and their aliases', () => {
    for (const name of ['Sparkles', 'SparklesIcon', 'LucideSparkles', 'LayoutDashboard', 'LucideIcon']) expect(isLucideExport(name)).toBe(true);
    expect(isLucideExport('LayoutDashbaord')).toBe(false);
  });

  it('falls back to a safe default when nothing is close', () => {
    expect(nearestIcon('NonexistentThingamajig')).toBe('Circle');
  });

  it('matches the lucide-react version the template pins', () => {
    const template = JSON.parse(fs.readFileSync('docker/template/package.json', 'utf8')) as { dependencies: Record<string, string> };
    expect(ICON_LIST.version).toBe(template.dependencies['lucide-react']);
  });
});

describe('importSpecifiers', () => {
  it('finds static, side-effect and dynamic imports, but not ones in comments', () => {
    const code = "import a from 'a';\nimport './b.css';\nexport { c } from \"c\";\nconst d = import('d');\n// import e from 'e';\n/* import f from 'f' */";
    expect(importSpecifiers(code)).toEqual(['a', './b.css', 'c', 'd']);
  });
});
