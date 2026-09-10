import type { Config } from 'tailwindcss';

// Colours are CSS variables (app/globals.css) so the light direction is a token swap.
const token = (name: string) => `var(--${name})`;

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './src/ui/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        panel: token('panel'),
        'panel-2': token('panel-2'),
        surface: token('surface'),
        line: token('line'),
        'line-raised': token('line-raised'),
        text: token('text'),
        'text-2': token('text-2'),
        dim: token('dim'),
        'dim-2': token('dim-2'),
        accent: token('accent'),
        'accent-ink': token('accent-ink'),
        ok: token('ok'),
        err: token('err'),
        select: token('select'),
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
