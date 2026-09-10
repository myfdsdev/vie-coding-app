/** Minimal renderer for model prose: paragraphs and `inline code`. No HTML is ever injected. */
export function Prose({ text, className }: { text: string; className?: string }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <div className={'flex flex-col gap-2 ' + (className ?? '')}>
      {paragraphs.map((p, i) => (
        <p key={i} className="m-0 whitespace-pre-wrap break-words">
          {p.split(/(`[^`\n]+`)/g).map((part, j) =>
            part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
              <code key={j} className="font-mono text-[0.92em] text-text">
                {part.slice(1, -1)}
              </code>
            ) : (
              part
            ),
          )}
        </p>
      ))}
    </div>
  );
}
