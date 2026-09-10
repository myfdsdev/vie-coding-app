import { Sparkles } from 'lucide-react';

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-50 flex items-center justify-center p-8">
      <div className="max-w-md flex flex-col items-center gap-3 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-900 text-white">
          <Sparkles size={18} />
        </span>
        <h1 className="text-xl font-semibold text-zinc-900">Ready to build</h1>
        <p className="text-sm leading-relaxed text-zinc-500">
          Describe what you want and this page will be replaced.
        </p>
      </div>
    </main>
  );
}
