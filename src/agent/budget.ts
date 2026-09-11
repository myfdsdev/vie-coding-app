/**
 * Deterministic loop termination (BUILD-PROMPT §3.2, §6d). The model never
 * decides when to stop: a counter per error signature and one per turn do.
 */
export class LoopBudget {
  private readonly perSignature = new Map<string, number>();
  private total = 0;

  constructor(
    readonly maxPerSignature = 3,
    readonly maxTotal = 5,
  ) {}

  /** The same failure gets the same signature: quoted identifiers and numbers are stripped. */
  signature(e: { type: string; message: string }): string {
    const core = e.message
      .replace(/(["'`]).*?\1/g, 'X')
      .replace(/\d+/g, 'N')
      .replace(/\s+/g, ' ')
      .trim();
    return `${e.type}|${core.slice(0, 120)}`;
  }

  /** Repair attempts already made for this failure. */
  attempts(e: { type: string; message: string }): number {
    return this.perSignature.get(this.signature(e)) ?? 0;
  }

  canRetry(e: { type: string; message: string }): boolean {
    return this.attempts(e) < this.maxPerSignature && this.total < this.maxTotal;
  }

  record(e: { type: string; message: string }): void {
    const sig = this.signature(e);
    this.perSignature.set(sig, (this.perSignature.get(sig) ?? 0) + 1);
    this.total++;
  }

  /** The same failure twice means the approach is wrong, not that it needs another go. */
  isStuck(e: { type: string; message: string }): boolean {
    return this.attempts(e) >= 2;
  }

  get used(): number {
    return this.total;
  }
}
