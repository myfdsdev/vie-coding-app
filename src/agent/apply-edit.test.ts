import { describe, expect, it } from 'vitest';
import { applyEdit, isEditMarker } from './apply-edit';

const APP = `import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  );
}
`;

describe('applyEdit', () => {
  it('splices each run between its unchanged first and last lines', () => {
    const body = `// ... existing code ...
import Home from './pages/Home';
import About from './pages/About';

export default function App() {
// ... existing code ...
      <Route path="/" element={<Home />} />
      <Route path="/about" element={<About />} />
    </Routes>
// ... existing code ...
`;
    expect(applyEdit(APP, body)).toEqual({
      ok: true,
      content: `import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import About from './pages/About';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/about" element={<About />} />
    </Routes>
  );
}
`,
    });
  });

  it('refuses a run whose anchor line is not in the file', () => {
    // The spec's own example: a new import with no unchanged line around it.
    const result = applyEdit(APP, "// ... existing code ...\nimport { Card } from './components/Card';\n// ... existing code ...\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/isn't in the file/);
  });

  it('refuses an anchor that appears more than once', () => {
    const result = applyEdit('a\nx\nb\nx\nc\n', '// ... existing code ...\nx\nnew line\nb\n// ... existing code ...\n');
    expect(result.ok).toBe(true); // "x" twice, but "x" followed by... only the first x is followed by b
    const ambiguous = applyEdit('a\nx\nb\nx\nb\n', '// ... existing code ...\nx\nchanged\nb\n// ... existing code ...\n');
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.reason).toMatch(/more than once/);
  });

  it('matches copied lines even when the model re-indented them', () => {
    const original = 'function f() {\n  const a = 1;\n  return a;\n}\n';
    const body = '// ... existing code ...\n  const a = 1;\n    const b = 2;\n    return a;\n// ... existing code ...\n';
    expect(applyEdit(original, body)).toEqual({ ok: true, content: 'function f() {\n  const a = 1;\n    const b = 2;\n    return a;\n}\n' });
  });

  it('anchors to the start or end of the file when there is no marker there', () => {
    const original = "import a from 'a';\nconst x = 1;\nexport default x;\n";
    const top = "import a from 'a';\nimport b from 'b';\nconst x = 1;\n// ... existing code ...\n";
    expect(applyEdit(original, top)).toEqual({ ok: true, content: "import a from 'a';\nimport b from 'b';\nconst x = 1;\nexport default x;\n" });
    const bottom = '// ... existing code ...\nconst x = 1;\nexport const y = 2;\nexport default x;\n';
    expect(applyEdit(original, bottom)).toEqual({
      ok: true,
      content: "import a from 'a';\nconst x = 1;\nexport const y = 2;\nexport default x;\n",
    });
  });

  it('accepts a whole file sent without markers, but not a fragment', () => {
    const original = 'one\ntwo\nthree\nfour\n';
    expect(applyEdit(original, 'one\n2\nthree\nfour\n')).toEqual({ ok: true, content: 'one\n2\nthree\nfour\n' });
    expect(applyEdit(original, 'two\n').ok).toBe(false);
  });

  it('refuses a placement that would delete far more than it writes', () => {
    const middle = Array.from({ length: 80 }, (_, i) => `  line ${i};`).join('\n');
    const original = `start\nBEGIN\n${middle}\nEND\nfinish\n`;
    const result = applyEdit(original, '// ... existing code ...\nBEGIN\nEND\n// ... existing code ...\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/would delete 80 lines/);
  });
});

describe('isEditMarker', () => {
  it('recognises the marker in its comment forms', () => {
    for (const line of ['// ... existing code ...', '    {/* ... existing code ... */}', '# ... existing code ...', '<!-- ... existing code ... -->']) {
      expect(isEditMarker(line)).toBe(true);
    }
    expect(isEditMarker('const existing = code;')).toBe(false);
  });
});
