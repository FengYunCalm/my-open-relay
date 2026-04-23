export class HumanGuard {
  private readonly pausedSessions = new Map<string, string>();

  pauseSession(sessionID: string, reason = "human takeover"): void {
    this.pausedSessions.set(sessionID, reason);
  }

  resumeSession(sessionID: string): void {
    this.pausedSessions.delete(sessionID);
  }

  isPaused(sessionID?: string): boolean {
    if (!sessionID) {
      return false;
    }

    return this.pausedSessions.has(sessionID);
  }

  reason(sessionID?: string): string | undefined {
    if (!sessionID) {
      return undefined;
    }

    return this.pausedSessions.get(sessionID);
  }

  listPausedSessions(): Array<{ sessionID: string; reason: string }> {
    return [...this.pausedSessions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sessionID, reason]) => ({ sessionID, reason }));
  }
}
