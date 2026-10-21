// A small store around the reducer: it keeps the state, tells subscribers, and hands each effect
// to the runner. The runner answers with data events through `dispatch`.
import { update, type Effect, type TuiEvent, type TuiState } from './state.js';

export type Dispatch = (event: TuiEvent) => void;
export type EffectRunner = (effect: Effect, dispatch: Dispatch) => void;

export interface Store {
  getState: () => TuiState;
  dispatch: Dispatch;
  subscribe: (listener: () => void) => () => void;
}

export function createStore(initial: TuiState, runEffect: EffectRunner): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  const dispatch: Dispatch = (event) => {
    const next = update(state, event);
    if (next.state !== state) {
      state = next.state;
      for (const listener of listeners) listener();
    }
    for (const effect of next.effects) runEffect(effect, dispatch);
  };
  return {
    getState: () => state,
    dispatch,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
