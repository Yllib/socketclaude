export interface TurnAbortState {
  hardAborted: boolean;
}

/** Keeps abort suppression attached to one run, even when a session object is reused. */
export class TurnAbortTracker<TSession extends object> {
  private readonly active = new WeakMap<TSession, TurnAbortState>();

  begin(session: TSession): TurnAbortState {
    const state = { hardAborted: false };
    this.active.set(session, state);
    return state;
  }

  markHardAborted(session: TSession): void {
    const state = this.active.get(session);
    if (state) state.hardAborted = true;
  }

  finish(session: TSession, state: TurnAbortState): boolean {
    if (this.active.get(session) === state) this.active.delete(session);
    return state.hardAborted;
  }
}
