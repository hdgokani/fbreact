/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  MutableSource,
  MutableSourceGetSnapshotFn,
  MutableSourceSubscribeFn,
  ReactEventResponder,
  ReactContext,
  ReactEventResponderListener,
  ReactScopeMethods,
} from 'shared/ReactTypes';
import type {Fiber} from './ReactFiber';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {HookEffectTag} from './ReactHookEffectTags';
import type {SuspenseConfig} from './ReactFiberSuspenseConfig';
import type {ReactPriorityLevel} from './SchedulerWithReactIntegration';
import type {FiberRoot} from './ReactFiberRoot';
import type {
  ReactListenerEvent,
  ReactListenerMap,
  ReactListener,
} from './ReactFiberHostConfig';

import ReactSharedInternals from 'shared/ReactSharedInternals';
import {enableUseEventAPI} from 'shared/ReactFeatureFlags';

import {markRootExpiredAtTime} from './ReactFiberRoot';
import {NoWork, Sync} from './ReactFiberExpirationTime';
import {readContext} from './ReactFiberNewContext';
import {createDeprecatedResponderListener} from './ReactFiberDeprecatedEvents';
import {
  Update as UpdateEffect,
  Passive as PassiveEffect,
} from './ReactSideEffectTags';
import {
  NoEffect as NoHookEffect,
  HasEffect as HookHasEffect,
  Layout as HookLayout,
  Passive as HookPassive,
} from './ReactHookEffectTags';
import {
  getWorkInProgressRoot,
  scheduleUpdateOnFiber,
  computeExpirationForFiber,
  requestCurrentTimeForUpdate,
  warnIfNotCurrentlyActingEffectsInDEV,
  warnIfNotCurrentlyActingUpdatesInDev,
  warnIfNotScopedWithMatchingAct,
  markRenderEventTimeAndConfig,
  markUnprocessedUpdateTime,
} from './ReactFiberWorkLoop';
import {
  registerEvent,
  mountEventListener as mountHostEventListener,
  unmountEventListener as unmountHostEventListener,
  validateEventListenerTarget,
} from './ReactFiberHostConfig';

import invariant from 'shared/invariant';
import getComponentName from 'shared/getComponentName';
import is from 'shared/objectIs';
import {markWorkInProgressReceivedUpdate} from './ReactFiberBeginWork';
import {requestCurrentSuspenseConfig} from './ReactFiberSuspenseConfig';
import {
  UserBlockingPriority,
  NormalPriority,
  runWithPriority,
  getCurrentPriorityLevel,
} from './SchedulerWithReactIntegration';
import {
  getFirstPendingExpirationTime,
  getWorkInProgressVersion,
  markSourceAsDirty,
  setPendingExpirationTime,
  setWorkInProgressVersion,
  warnAboutMultipleRenderersDEV,
} from './ReactMutableSource';
import {getRootHostContainer} from './ReactFiberHostContext';

const {ReactCurrentDispatcher, ReactCurrentBatchConfig} = ReactSharedInternals;

export type Dispatcher = {|
  readContext<T>(
    context: ReactContext<T>,
    observedBits: void | number | boolean,
  ): T,
  useState<S>(initialState: (() => S) | S): [S, Dispatch<BasicStateAction<S>>],
  useReducer<S, I, A>(
    reducer: (S, A) => S,
    initialArg: I,
    init?: (I) => S,
  ): [S, Dispatch<A>],
  useContext<T>(
    context: ReactContext<T>,
    observedBits: void | number | boolean,
  ): T,
  useRef<T>(initialValue: T): {|current: T|},
  useEffect(
    create: () => (() => void) | void,
    deps: Array<mixed> | void | null,
  ): void,
  useLayoutEffect(
    create: () => (() => void) | void,
    deps: Array<mixed> | void | null,
  ): void,
  useCallback<T>(callback: T, deps: Array<mixed> | void | null): T,
  useMemo<T>(nextCreate: () => T, deps: Array<mixed> | void | null): T,
  useImperativeHandle<T>(
    ref: {|current: T | null|} | ((inst: T | null) => mixed) | null | void,
    create: () => T,
    deps: Array<mixed> | void | null,
  ): void,
  useDebugValue<T>(value: T, formatterFn: ?(value: T) => mixed): void,
  useResponder<E, C>(
    responder: ReactEventResponder<E, C>,
    props: Object,
  ): ReactEventResponderListener<E, C>,
  useDeferredValue<T>(value: T, config: TimeoutConfig | void | null): T,
  useTransition(
    config: SuspenseConfig | void | null,
  ): [(() => void) => void, boolean],
  useMutableSource<Source, Snapshot>(
    source: MutableSource<Source>,
    getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
    subscribe: MutableSourceSubscribeFn<Source, Snapshot>,
  ): Snapshot,
  useEvent(event: ReactListenerEvent): ReactListenerMap,
|};

type Update<S, A> = {|
  expirationTime: ExpirationTime,
  suspenseConfig: null | SuspenseConfig,
  action: A,
  eagerReducer: ((S, A) => S) | null,
  eagerState: S | null,
  next: Update<S, A>,
  priority?: ReactPriorityLevel,
|};

type UpdateQueue<S, A> = {|
  pending: Update<S, A> | null,
  dispatch: (A => mixed) | null,
  lastRenderedReducer: ((S, A) => S) | null,
  lastRenderedState: S | null,
|};

export type HookType =
  | 'useState'
  | 'useReducer'
  | 'useContext'
  | 'useRef'
  | 'useEffect'
  | 'useLayoutEffect'
  | 'useCallback'
  | 'useMemo'
  | 'useImperativeHandle'
  | 'useDebugValue'
  | 'useResponder'
  | 'useDeferredValue'
  | 'useTransition'
  | 'useMutableSource'
  | 'useEvent';

let didWarnAboutMismatchedHooksForComponent;
if (__DEV__) {
  didWarnAboutMismatchedHooksForComponent = new Set();
}

export type Hook = {|
  memoizedState: any,
  baseState: any,
  baseQueue: Update<any, any> | null,
  queue: UpdateQueue<any, any> | null,
  next: Hook | null,
|};

export type Effect = {|
  tag: HookEffectTag,
  create: () => (() => void) | void,
  destroy: (() => void) | void,
  deps: Array<mixed> | null,
  next: Effect,
|};

export type FunctionComponentUpdateQueue = {|lastEffect: Effect | null|};

export type TimeoutConfig = {|
  timeoutMs: number,
|};

type BasicStateAction<S> = (S => S) | S;

type Dispatch<A> = A => void;

// These are set right before calling the component.
let renderExpirationTime: ExpirationTime = NoWork;
// The work-in-progress fiber. I've named it differently to distinguish it from
// the work-in-progress hook.
let currentlyRenderingFiber: Fiber = (null: any);

// Hooks are stored as a linked list on the fiber's memoizedState field. The
// current hook list is the list that belongs to the current fiber. The
// work-in-progress hook list is a new list that will be added to the
// work-in-progress fiber.
let currentHook: Hook | null = null;
let workInProgressHook: Hook | null = null;

// Whether an update was scheduled at any point during the render phase. This
// does not get reset if we do another render pass; only when we're completely
// finished evaluating this component. This is an optimization so we know
// whether we need to clear render phase updates after a throw.
let didScheduleRenderPhaseUpdate: boolean = false;

const RE_RENDER_LIMIT = 25;

// In DEV, this is the name of the currently executing primitive hook
let currentHookNameInDev: ?HookType = null;

// In DEV, this list ensures that hooks are called in the same order between renders.
// The list stores the order of hooks used during the initial render (mount).
// Subsequent renders (updates) reference this list.
let hookTypesDev: Array<HookType> | null = null;
let hookTypesUpdateIndexDev: number = -1;

// In DEV, this tracks whether currently rendering component needs to ignore
// the dependencies for Hooks that need them (e.g. useEffect or useMemo).
// When true, such Hooks will always be "remounted". Only used during hot reload.
let ignorePreviousDependencies: boolean = false;

function mountHookTypesDev() {
  if (__DEV__) {
    const hookName = ((currentHookNameInDev: any): HookType);

    if (hookTypesDev === null) {
      hookTypesDev = [hookName];
    } else {
      hookTypesDev.push(hookName);
    }
  }
}

function updateHookTypesDev() {
  if (__DEV__) {
    const hookName = ((currentHookNameInDev: any): HookType);

    if (hookTypesDev !== null) {
      hookTypesUpdateIndexDev++;
      if (hookTypesDev[hookTypesUpdateIndexDev] !== hookName) {
        warnOnHookMismatchInDev(hookName);
      }
    }
  }
}

function checkDepsAreArrayDev(deps: mixed) {
  if (__DEV__) {
    if (deps !== undefined && deps !== null && !Array.isArray(deps)) {
      // Verify deps, but only on mount to avoid extra checks.
      // It's unlikely their type would change as usually you define them inline.
      console.error(
        '%s received a final argument that is not an array (instead, received `%s`). When ' +
          'specified, the final argument must be an array.',
        currentHookNameInDev,
        typeof deps,
      );
    }
  }
}

function warnOnHookMismatchInDev(currentHookName: HookType) {
  if (__DEV__) {
    const componentName = getComponentName(currentlyRenderingFiber.type);
    if (!didWarnAboutMismatchedHooksForComponent.has(componentName)) {
      didWarnAboutMismatchedHooksForComponent.add(componentName);

      if (hookTypesDev !== null) {
        let table = '';

        const secondColumnStart = 30;

        for (let i = 0; i <= ((hookTypesUpdateIndexDev: any): number); i++) {
          const oldHookName = hookTypesDev[i];
          const newHookName =
            i === ((hookTypesUpdateIndexDev: any): number)
              ? currentHookName
              : oldHookName;

          let row = `${i + 1}. ${oldHookName}`;

          // Extra space so second column lines up
          // lol @ IE not supporting String#repeat
          while (row.length < secondColumnStart) {
            row += ' ';
          }

          row += newHookName + '\n';

          table += row;
        }

        console.error(
          'React has detected a change in the order of Hooks called by %s. ' +
            'This will lead to bugs and errors if not fixed. ' +
            'For more information, read the Rules of Hooks: https://fb.me/rules-of-hooks\n\n' +
            '   Previous render            Next render\n' +
            '   ------------------------------------------------------\n' +
            '%s' +
            '   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n',
          componentName,
          table,
        );
      }
    }
  }
}

function throwInvalidHookError() {
  invariant(
    false,
    'Invalid hook call. Hooks can only be called inside of the body of a function component. This could happen for' +
      ' one of the following reasons:\n' +
      '1. You might have mismatching versions of React and the renderer (such as React DOM)\n' +
      '2. You might be breaking the Rules of Hooks\n' +
      '3. You might have more than one copy of React in the same app\n' +
      'See https://fb.me/react-invalid-hook-call for tips about how to debug and fix this problem.',
  );
}

function areHookInputsEqual(
  nextDeps: Array<mixed>,
  prevDeps: Array<mixed> | null,
) {
  if (__DEV__) {
    if (ignorePreviousDependencies) {
      // Only true when this component is being hot reloaded.
      return false;
    }
  }

  if (prevDeps === null) {
    if (__DEV__) {
      console.error(
        '%s received a final argument during this render, but not during ' +
          'the previous render. Even though the final argument is optional, ' +
          'its type cannot change between renders.',
        currentHookNameInDev,
      );
    }
    return false;
  }

  if (__DEV__) {
    // Don't bother comparing lengths in prod because these arrays should be
    // passed inline.
    if (nextDeps.length !== prevDeps.length) {
      console.error(
        'The final argument passed to %s changed size between renders. The ' +
          'order and size of this array must remain constant.\n\n' +
          'Previous: %s\n' +
          'Incoming: %s',
        currentHookNameInDev,
        `[${prevDeps.join(', ')}]`,
        `[${nextDeps.join(', ')}]`,
      );
    }
  }
  for (let i = 0; i < prevDeps.length && i < nextDeps.length; i++) {
    if (is(nextDeps[i], prevDeps[i])) {
      continue;
    }
    return false;
  }
  return true;
}

export function renderWithHooks<Props, SecondArg>(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: (p: Props, arg: SecondArg) => any,
  props: Props,
  secondArg: SecondArg,
  nextRenderExpirationTime: ExpirationTime,
): any {
  renderExpirationTime = nextRenderExpirationTime;
  currentlyRenderingFiber = workInProgress;

  if (__DEV__) {
    hookTypesDev =
      current !== null
        ? ((current._debugHookTypes: any): Array<HookType>)
        : null;
    hookTypesUpdateIndexDev = -1;
    // Used for hot reloading:
    ignorePreviousDependencies =
      current !== null && current.type !== workInProgress.type;
  }

  workInProgress.memoizedState = null;
  workInProgress.updateQueue = null;
  workInProgress.expirationTime = NoWork;

  // The following should have already been reset
  // currentHook = null;
  // workInProgressHook = null;

  // didScheduleRenderPhaseUpdate = false;

  // TODO Warn if no hooks are used at all during mount, then some are used during update.
  // Currently we will identify the update render as a mount because memoizedState === null.
  // This is tricky because it's valid for certain types of components (e.g. React.lazy)

  // Using memoizedState to differentiate between mount/update only works if at least one stateful hook is used.
  // Non-stateful hooks (e.g. context) don't get added to memoizedState,
  // so memoizedState would be null during updates and mounts.
  if (__DEV__) {
    if (current !== null && current.memoizedState !== null) {
      ReactCurrentDispatcher.current = HooksDispatcherOnUpdateInDEV;
    } else if (hookTypesDev !== null) {
      // This dispatcher handles an edge case where a component is updating,
      // but no stateful hooks have been used.
      // We want to match the production code behavior (which will use HooksDispatcherOnMount),
      // but with the extra DEV validation to ensure hooks ordering hasn't changed.
      // This dispatcher does that.
      ReactCurrentDispatcher.current = HooksDispatcherOnMountWithHookTypesInDEV;
    } else {
      ReactCurrentDispatcher.current = HooksDispatcherOnMountInDEV;
    }
  } else {
    ReactCurrentDispatcher.current =
      current === null || current.memoizedState === null
        ? HooksDispatcherOnMount
        : HooksDispatcherOnUpdate;
  }

  let children = Component(props, secondArg);

  // Check if there was a render phase update
  if (workInProgress.expirationTime === renderExpirationTime) {
    // Keep rendering in a loop for as long as render phase updates continue to
    // be scheduled. Use a counter to prevent infinite loops.
    let numberOfReRenders: number = 0;
    do {
      workInProgress.expirationTime = NoWork;

      invariant(
        numberOfReRenders < RE_RENDER_LIMIT,
        'Too many re-renders. React limits the number of renders to prevent ' +
          'an infinite loop.',
      );

      numberOfReRenders += 1;
      if (__DEV__) {
        // Even when hot reloading, allow dependencies to stabilize
        // after first render to prevent infinite render phase updates.
        ignorePreviousDependencies = false;
      }

      // Start over from the beginning of the list
      currentHook = null;
      workInProgressHook = null;

      workInProgress.updateQueue = null;

      if (__DEV__) {
        // Also validate hook order for cascading updates.
        hookTypesUpdateIndexDev = -1;
      }

      ReactCurrentDispatcher.current = __DEV__
        ? HooksDispatcherOnRerenderInDEV
        : HooksDispatcherOnRerender;

      children = Component(props, secondArg);
    } while (workInProgress.expirationTime === renderExpirationTime);
  }

  // We can assume the previous dispatcher is always this one, since we set it
  // at the beginning of the render phase and there's no re-entrancy.
  ReactCurrentDispatcher.current = ContextOnlyDispatcher;

  if (__DEV__) {
    workInProgress._debugHookTypes = hookTypesDev;
  }

  // This check uses currentHook so that it works the same in DEV and prod bundles.
  // hookTypesDev could catch more cases (e.g. context) but only in DEV bundles.
  const didRenderTooFewHooks =
    currentHook !== null && currentHook.next !== null;

  renderExpirationTime = NoWork;
  currentlyRenderingFiber = (null: any);

  currentHook = null;
  workInProgressHook = null;

  if (__DEV__) {
    currentHookNameInDev = null;
    hookTypesDev = null;
    hookTypesUpdateIndexDev = -1;
  }

  didScheduleRenderPhaseUpdate = false;

  invariant(
    !didRenderTooFewHooks,
    'Rendered fewer hooks than expected. This may be caused by an accidental ' +
      'early return statement.',
  );

  return children;
}

export function bailoutHooks(
  current: Fiber,
  workInProgress: Fiber,
  expirationTime: ExpirationTime,
) {
  workInProgress.updateQueue = current.updateQueue;
  workInProgress.effectTag &= ~(PassiveEffect | UpdateEffect);
  if (current.expirationTime <= expirationTime) {
    current.expirationTime = NoWork;
  }
}

export function resetHooksAfterThrow(): void {
  // We can assume the previous dispatcher is always this one, since we set it
  // at the beginning of the render phase and there's no re-entrancy.
  ReactCurrentDispatcher.current = ContextOnlyDispatcher;

  if (didScheduleRenderPhaseUpdate) {
    // There were render phase updates. These are only valid for this render
    // phase, which we are now aborting. Remove the updates from the queues so
    // they do not persist to the next render. Do not remove updates from hooks
    // that weren't processed.
    //
    // Only reset the updates from the queue if it has a clone. If it does
    // not have a clone, that means it wasn't processed, and the updates were
    // scheduled before we entered the render phase.
    let hook: Hook | null = currentlyRenderingFiber.memoizedState;
    while (hook !== null) {
      const queue = hook.queue;
      if (queue !== null) {
        queue.pending = null;
      }
      hook = hook.next;
    }
  }

  renderExpirationTime = NoWork;
  currentlyRenderingFiber = (null: any);

  currentHook = null;
  workInProgressHook = null;

  if (__DEV__) {
    hookTypesDev = null;
    hookTypesUpdateIndexDev = -1;

    currentHookNameInDev = null;
  }

  didScheduleRenderPhaseUpdate = false;
}

function mountWorkInProgressHook(): Hook {
  const hook: Hook = {
    memoizedState: null,

    baseState: null,
    baseQueue: null,
    queue: null,

    next: null,
  };

  if (workInProgressHook === null) {
    // This is the first hook in the list
    currentlyRenderingFiber.memoizedState = workInProgressHook = hook;
  } else {
    // Append to the end of the list
    workInProgressHook = workInProgressHook.next = hook;
  }
  return workInProgressHook;
}

function updateWorkInProgressHook(): Hook {
  // This function is used both for updates and for re-renders triggered by a
  // render phase update. It assumes there is either a current hook we can
  // clone, or a work-in-progress hook from a previous render pass that we can
  // use as a base. When we reach the end of the base list, we must switch to
  // the dispatcher used for mounts.
  let nextCurrentHook: null | Hook;
  if (currentHook === null) {
    const current = currentlyRenderingFiber.alternate;
    if (current !== null) {
      nextCurrentHook = current.memoizedState;
    } else {
      nextCurrentHook = null;
    }
  } else {
    nextCurrentHook = currentHook.next;
  }

  let nextWorkInProgressHook: null | Hook;
  if (workInProgressHook === null) {
    nextWorkInProgressHook = currentlyRenderingFiber.memoizedState;
  } else {
    nextWorkInProgressHook = workInProgressHook.next;
  }

  if (nextWorkInProgressHook !== null) {
    // There's already a work-in-progress. Reuse it.
    workInProgressHook = nextWorkInProgressHook;
    nextWorkInProgressHook = workInProgressHook.next;

    currentHook = nextCurrentHook;
  } else {
    // Clone from the current hook.

    invariant(
      nextCurrentHook !== null,
      'Rendered more hooks than during the previous render.',
    );
    currentHook = nextCurrentHook;

    const newHook: Hook = {
      memoizedState: currentHook.memoizedState,

      baseState: currentHook.baseState,
      baseQueue: currentHook.baseQueue,
      queue: currentHook.queue,

      next: null,
    };

    if (workInProgressHook === null) {
      // This is the first hook in the list.
      currentlyRenderingFiber.memoizedState = workInProgressHook = newHook;
    } else {
      // Append to the end of the list.
      workInProgressHook = workInProgressHook.next = newHook;
    }
  }
  return workInProgressHook;
}

function createFunctionComponentUpdateQueue(): FunctionComponentUpdateQueue {
  return {
    lastEffect: null,
  };
}

function basicStateReducer<S>(state: S, action: BasicStateAction<S>): S {
  // $FlowFixMe: Flow doesn't like mixed types
  return typeof action === 'function' ? action(state) : action;
}

function mountReducer<S, I, A>(
  reducer: (S, A) => S,
  initialArg: I,
  init?: I => S,
): [S, Dispatch<A>] {
  const hook = mountWorkInProgressHook();
  let initialState;
  if (init !== undefined) {
    initialState = init(initialArg);
  } else {
    initialState = ((initialArg: any): S);
  }
  hook.memoizedState = hook.baseState = initialState;
  const queue = (hook.queue = {
    pending: null,
    dispatch: null,
    lastRenderedReducer: reducer,
    lastRenderedState: (initialState: any),
  });
  const dispatch: Dispatch<A> = (queue.dispatch = (dispatchAction.bind(
    null,
    currentlyRenderingFiber,
    queue,
  ): any));
  return [hook.memoizedState, dispatch];
}

function updateReducer<S, I, A>(
  reducer: (S, A) => S,
  initialArg: I,
  init?: I => S,
): [S, Dispatch<A>] {
  const hook = updateWorkInProgressHook();
  const queue = hook.queue;
  invariant(
    queue !== null,
    'Should have a queue. This is likely a bug in React. Please file an issue.',
  );

  queue.lastRenderedReducer = reducer;

  const current: Hook = (currentHook: any);

  // The last rebase update that is NOT part of the base state.
  let baseQueue = current.baseQueue;

  // The last pending update that hasn't been processed yet.
  const pendingQueue = queue.pending;
  if (pendingQueue !== null) {
    // We have new updates that haven't been processed yet.
    // We'll add them to the base queue.
    if (baseQueue !== null) {
      // Merge the pending queue and the base queue.
      const baseFirst = baseQueue.next;
      const pendingFirst = pendingQueue.next;
      baseQueue.next = pendingFirst;
      pendingQueue.next = baseFirst;
    }
    if (__DEV__) {
      if (current.baseQueue !== baseQueue) {
        // Internal invariant that should never happen, but feasibly could in
        // the future if we implement resuming, or some form of that.
        console.error(
          'Internal error: Expected work-in-progress queue to be a clone. ' +
            'This is a bug in React.',
        );
      }
    }
    current.baseQueue = baseQueue = pendingQueue;
    queue.pending = null;
  }

  if (baseQueue !== null) {
    // We have a queue to process.
    const first = baseQueue.next;
    let newState = current.baseState;

    let newBaseState = null;
    let newBaseQueueFirst = null;
    let newBaseQueueLast = null;
    let update = first;
    do {
      const updateExpirationTime = update.expirationTime;
      if (updateExpirationTime < renderExpirationTime) {
        // Priority is insufficient. Skip this update. If this is the first
        // skipped update, the previous update/state is the new base
        // update/state.
        const clone: Update<S, A> = {
          expirationTime: update.expirationTime,
          suspenseConfig: update.suspenseConfig,
          action: update.action,
          eagerReducer: update.eagerReducer,
          eagerState: update.eagerState,
          next: (null: any),
        };
        if (newBaseQueueLast === null) {
          newBaseQueueFirst = newBaseQueueLast = clone;
          newBaseState = newState;
        } else {
          newBaseQueueLast = newBaseQueueLast.next = clone;
        }
        // Update the remaining priority in the queue.
        if (updateExpirationTime > currentlyRenderingFiber.expirationTime) {
          currentlyRenderingFiber.expirationTime = updateExpirationTime;
          markUnprocessedUpdateTime(updateExpirationTime);
        }
      } else {
        // This update does have sufficient priority.

        if (newBaseQueueLast !== null) {
          const clone: Update<S, A> = {
            expirationTime: Sync, // This update is going to be committed so we never want uncommit it.
            suspenseConfig: update.suspenseConfig,
            action: update.action,
            eagerReducer: update.eagerReducer,
            eagerState: update.eagerState,
            next: (null: any),
          };
          newBaseQueueLast = newBaseQueueLast.next = clone;
        }

        // Mark the event time of this update as relevant to this render pass.
        // TODO: This should ideally use the true event time of this update rather than
        // its priority which is a derived and not reverseable value.
        // TODO: We should skip this update if it was already committed but currently
        // we have no way of detecting the difference between a committed and suspended
        // update here.
        markRenderEventTimeAndConfig(
          updateExpirationTime,
          update.suspenseConfig,
        );

        // Process this update.
        if (update.eagerReducer === reducer) {
          // If this update was processed eagerly, and its reducer matches the
          // current reducer, we can use the eagerly computed state.
          newState = ((update.eagerState: any): S);
        } else {
          const action = update.action;
          newState = reducer(newState, action);
        }
      }
      update = update.next;
    } while (update !== null && update !== first);

    if (newBaseQueueLast === null) {
      newBaseState = newState;
    } else {
      newBaseQueueLast.next = (newBaseQueueFirst: any);
    }

    // Mark that the fiber performed work, but only if the new state is
    // different from the current state.
    if (!is(newState, hook.memoizedState)) {
      markWorkInProgressReceivedUpdate();
    }

    hook.memoizedState = newState;
    hook.baseState = newBaseState;
    hook.baseQueue = newBaseQueueLast;

    queue.lastRenderedState = newState;
  }

  const dispatch: Dispatch<A> = (queue.dispatch: any);
  return [hook.memoizedState, dispatch];
}

function rerenderReducer<S, I, A>(
  reducer: (S, A) => S,
  initialArg: I,
  init?: I => S,
): [S, Dispatch<A>] {
  const hook = updateWorkInProgressHook();
  const queue = hook.queue;
  invariant(
    queue !== null,
    'Should have a queue. This is likely a bug in React. Please file an issue.',
  );

  queue.lastRenderedReducer = reducer;

  // This is a re-render. Apply the new render phase updates to the previous
  // work-in-progress hook.
  const dispatch: Dispatch<A> = (queue.dispatch: any);
  const lastRenderPhaseUpdate = queue.pending;
  let newState = hook.memoizedState;
  if (lastRenderPhaseUpdate !== null) {
    // The queue doesn't persist past this render pass.
    queue.pending = null;

    const firstRenderPhaseUpdate = lastRenderPhaseUpdate.next;
    let update = firstRenderPhaseUpdate;
    do {
      // Process this render phase update. We don't have to check the
      // priority because it will always be the same as the current
      // render's.
      const action = update.action;
      newState = reducer(newState, action);
      update = update.next;
    } while (update !== firstRenderPhaseUpdate);

    // Mark that the fiber performed work, but only if the new state is
    // different from the current state.
    if (!is(newState, hook.memoizedState)) {
      markWorkInProgressReceivedUpdate();
    }

    hook.memoizedState = newState;
    // Don't persist the state accumulated from the render phase updates to
    // the base state unless the queue is empty.
    // TODO: Not sure if this is the desired semantics, but it's what we
    // do for gDSFP. I can't remember why.
    if (hook.baseQueue === null) {
      hook.baseState = newState;
    }

    queue.lastRenderedState = newState;
  }
  return [newState, dispatch];
}

type MutableSourceMemoizedState<Source, Snapshot> = {|
  refs: {
    getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
    setSnapshot: Snapshot => void,
  },
  source: MutableSource<any>,
  subscribe: MutableSourceSubscribeFn<Source, Snapshot>,
|};

function readFromUnsubcribedMutableSource<Source, Snapshot>(
  root: FiberRoot,
  source: MutableSource<Source>,
  getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
): Snapshot {
  if (__DEV__) {
    warnAboutMultipleRenderersDEV(source);
  }

  const getVersion = source._getVersion;
  const version = getVersion(source._source);

  // Is it safe for this component to read from this source during the current render?
  let isSafeToReadFromSource = false;

  // Check the version first.
  // If this render has already been started with a specific version,
  // we can use it alone to determine if we can safely read from the source.
  const currentRenderVersion = getWorkInProgressVersion(source);
  if (currentRenderVersion !== null) {
    isSafeToReadFromSource = currentRenderVersion === version;
  } else {
    // If there's no version, then we should fallback to checking the update time.
    const pendingExpirationTime = getFirstPendingExpirationTime(root);

    if (pendingExpirationTime === NoWork) {
      isSafeToReadFromSource = true;
    } else {
      // If the source has pending updates, we can use the current render's expiration
      // time to determine if it's safe to read again from the source.
      isSafeToReadFromSource = pendingExpirationTime >= renderExpirationTime;
    }

    if (isSafeToReadFromSource) {
      // If it's safe to read from this source during the current render,
      // store the version in case other components read from it.
      // A changed version number will let those components know to throw and restart the render.
      setWorkInProgressVersion(source, version);
    }
  }

  if (isSafeToReadFromSource) {
    return getSnapshot(source._source);
  } else {
    // This handles the special case of a mutable source being shared beween renderers.
    // In that case, if the source is mutated between the first and second renderer,
    // The second renderer don't know that it needs to reset the WIP version during unwind,
    // (because the hook only marks sources as dirty if it's written to their WIP version).
    // That would cause this tear check to throw again and eventually be visible to the user.
    // We can avoid this infinite loop by explicitly marking the source as dirty.
    //
    // This can lead to tearing in the first renderer when it resumes,
    // but there's nothing we can do about that (short of throwing here and refusing to continue the render).
    markSourceAsDirty(source);

    invariant(
      false,
      'Cannot read from mutable source during the current render without tearing. This is a bug in React. Please file an issue.',
    );
  }
}

function useMutableSource<Source, Snapshot>(
  hook: Hook,
  source: MutableSource<Source>,
  getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
  subscribe: MutableSourceSubscribeFn<Source, Snapshot>,
): Snapshot {
  const root = ((getWorkInProgressRoot(): any): FiberRoot);
  invariant(
    root !== null,
    'Expected a work-in-progress root. This is a bug in React. Please file an issue.',
  );

  const getVersion = source._getVersion;
  const version = getVersion(source._source);

  const dispatcher = ReactCurrentDispatcher.current;

  // eslint-disable-next-line prefer-const
  let [currentSnapshot, setSnapshot] = dispatcher.useState(() =>
    readFromUnsubcribedMutableSource(root, source, getSnapshot),
  );
  let snapshot = currentSnapshot;

  // Grab a handle to the state hook as well.
  // We use it to clear the pending update queue if we have a new source.
  const stateHook = ((workInProgressHook: any): Hook);

  const memoizedState = ((hook.memoizedState: any): MutableSourceMemoizedState<
    Source,
    Snapshot,
  >);
  const refs = memoizedState.refs;
  const prevGetSnapshot = refs.getSnapshot;
  const prevSource = memoizedState.source;
  const prevSubscribe = memoizedState.subscribe;

  const fiber = currentlyRenderingFiber;

  hook.memoizedState = ({
    refs,
    source,
    subscribe,
  }: MutableSourceMemoizedState<Source, Snapshot>);

  // Sync the values needed by our subscribe function after each commit.
  dispatcher.useEffect(() => {
    const didGetSnapshotChange = !is(refs.getSnapshot, getSnapshot);
    refs.getSnapshot = getSnapshot;

    // Normally the dispatch function for a state hook never changes,
    // but in the case of this hook, it will change if getSnapshot changes.
    // In that case, the subscription below will have cloesd over the previous function,
    // so we use a ref to ensure that handleChange() always has the latest version.
    refs.setSnapshot = setSnapshot;

    // This effect runs on mount, even though getSnapshot hasn't changed.
    // In that case we can avoid the additional checks for a changed snapshot,
    // because the subscription effect below will cover this.
    if (didGetSnapshotChange) {
      // Because getSnapshot is shared with subscriptions via a ref,
      // we don't resubscribe when getSnapshot changes.
      // This means that we also don't check for any missed mutations
      // between the render and the passive commit though.
      // So we need to check here, just like when we newly subscribe.
      const maybeNewVersion = getVersion(source._source);
      if (!is(version, maybeNewVersion)) {
        const maybeNewSnapshot = getSnapshot(source._source);
        if (!is(snapshot, maybeNewSnapshot)) {
          setSnapshot(maybeNewSnapshot);

          const currentTime = requestCurrentTimeForUpdate();
          const suspenseConfig = requestCurrentSuspenseConfig();
          const expirationTime = computeExpirationForFiber(
            currentTime,
            fiber,
            suspenseConfig,
          );
          setPendingExpirationTime(root, expirationTime);

          // If the source mutated between render and now,
          // there may be state updates already scheduled from the old getSnapshot.
          // Those updates should not commit without this value.
          // There is no mechanism currently to associate these updates though,
          // so for now we fall back to synchronously flushing all pending updates.
          // TODO: Improve this later.
          markRootExpiredAtTime(root, getFirstPendingExpirationTime(root));
        }
      }
    }
  }, [getSnapshot]);

  // If we got a new source or subscribe function,
  // we'll need to subscribe in a passive effect,
  // and also check for any changes that fire between render and subscribe.
  dispatcher.useEffect(() => {
    const handleChange = () => {
      const latestGetSnapshot = refs.getSnapshot;
      const latestSetSnapshot = refs.setSnapshot;

      try {
        latestSetSnapshot(latestGetSnapshot(source._source));

        // Record a pending mutable source update with the same expiration time.
        const currentTime = requestCurrentTimeForUpdate();
        const suspenseConfig = requestCurrentSuspenseConfig();
        const expirationTime = computeExpirationForFiber(
          currentTime,
          fiber,
          suspenseConfig,
        );

        setPendingExpirationTime(root, expirationTime);
      } catch (error) {
        // A selector might throw after a source mutation.
        // e.g. it might try to read from a part of the store that no longer exists.
        // In this case we should still schedule an update with React.
        // Worst case the selector will throw again and then an error boundary will handle it.
        latestSetSnapshot(
          (() => {
            throw error;
          }: any),
        );
      }
    };

    const unsubscribe = subscribe(source._source, handleChange);
    if (__DEV__) {
      if (typeof unsubscribe !== 'function') {
        console.error(
          'Mutable source subscribe function must return an unsubscribe function.',
        );
      }
    }

    // Check for a possible change between when we last rendered and when we just subscribed.
    const maybeNewVersion = getVersion(source._source);
    if (!is(version, maybeNewVersion)) {
      const maybeNewSnapshot = getSnapshot(source._source);
      if (!is(snapshot, maybeNewSnapshot)) {
        setSnapshot(maybeNewSnapshot);

        const currentTime = requestCurrentTimeForUpdate();
        const suspenseConfig = requestCurrentSuspenseConfig();
        const expirationTime = computeExpirationForFiber(
          currentTime,
          fiber,
          suspenseConfig,
        );
        setPendingExpirationTime(root, expirationTime);

        // We missed a mutation before committing.
        // It's possible that other components using this source also have pending updates scheduled.
        // In that case, we should ensure they all commit together.
        markRootExpiredAtTime(root, getFirstPendingExpirationTime(root));
      }
    }

    return unsubscribe;
  }, [source, subscribe]);

  // If any of the inputs to useMutableSource change, reading is potentially unsafe.
  //
  // If either the source or the subscription have changed we can't can't trust the update queue.
  // Maybe the source changed in a way that the old subscription ignored but the new one depends on.
  //
  // If the getSnapshot function changed, we also shouldn't rely on the update queue.
  // It's possible that the underlying source was mutated between the when the last "change" event fired,
  // and when the current render (with the new getSnapshot function) is processed.
  //
  // In both cases, we need to throw away pending udpates (since they are no longer relevant)
  // and treat reading from the source as we do in the mount case.
  const didGetSnapshotChange = !is(prevGetSnapshot, getSnapshot);
  if (
    !is(prevSource, source) ||
    !is(prevSubscribe, subscribe) ||
    didGetSnapshotChange
  ) {
    if (didGetSnapshotChange) {
      // Create a new queue and setState method,
      // So if there are interleaved updates, they get pushed to the older queue.
      // When this becomes current, the previous queue and dispatch method will be discarded,
      // including any interleaving updates that occur.
      const newQueue = {
        pending: null,
        dispatch: null,
        lastRenderedReducer: basicStateReducer,
        lastRenderedState: snapshot,
      };
      newQueue.dispatch = setSnapshot = (dispatchAction.bind(
        null,
        currentlyRenderingFiber,
        newQueue,
      ): any);
      stateHook.queue = newQueue;
    }

    stateHook.baseQueue = null;
    snapshot = readFromUnsubcribedMutableSource(root, source, getSnapshot);
    stateHook.memoizedState = stateHook.baseState = snapshot;
  }

  return snapshot;
}

function mountMutableSource<Source, Snapshot>(
  source: MutableSource<Source>,
  getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
  subscribe: MutableSourceSubscribeFn<Source, Snapshot>,
): Snapshot {
  const hook = mountWorkInProgressHook();
  hook.memoizedState = ({
    refs: {
      getSnapshot,
      setSnapshot: (null: any),
    },
    source,
    subscribe,
  }: MutableSourceMemoizedState<Source, Snapshot>);
  return useMutableSource(hook, source, getSnapshot, subscribe);
}

function updateMutableSource<Source, Snapshot>(
  source: MutableSource<Source>,
  getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
  subscribe: MutableSourceSubscribeFn<Source, Snapshot>,
): Snapshot {
  const hook = updateWorkInProgressHook();
  return useMutableSource(hook, source, getSnapshot, subscribe);
}

function mountState<S>(
  initialState: (() => S) | S,
): [S, Dispatch<BasicStateAction<S>>] {
  const hook = mountWorkInProgressHook();
  if (typeof initialState === 'function') {
    // $FlowFixMe: Flow doesn't like mixed types
    initialState = initialState();
  }
  hook.memoizedState = hook.baseState = initialState;
  const queue = (hook.queue = {
    pending: null,
    dispatch: null,
    lastRenderedReducer: basicStateReducer,
    lastRenderedState: (initialState: any),
  });
  const dispatch: Dispatch<
    BasicStateAction<S>,
  > = (queue.dispatch = (dispatchAction.bind(
    null,
    currentlyRenderingFiber,
    queue,
  ): any));
  return [hook.memoizedState, dispatch];
}

function updateState<S>(
  initialState: (() => S) | S,
): [S, Dispatch<BasicStateAction<S>>] {
  return updateReducer(basicStateReducer, (initialState: any));
}

function rerenderState<S>(
  initialState: (() => S) | S,
): [S, Dispatch<BasicStateAction<S>>] {
  return rerenderReducer(basicStateReducer, (initialState: any));
}

function pushEffect(tag, create, destroy, deps) {
  const effect: Effect = {
    tag,
    create,
    destroy,
    deps,
    // Circular
    next: (null: any),
  };
  let componentUpdateQueue: null | FunctionComponentUpdateQueue = (currentlyRenderingFiber.updateQueue: any);
  if (componentUpdateQueue === null) {
    componentUpdateQueue = createFunctionComponentUpdateQueue();
    currentlyRenderingFiber.updateQueue = (componentUpdateQueue: any);
    componentUpdateQueue.lastEffect = effect.next = effect;
  } else {
    const lastEffect = componentUpdateQueue.lastEffect;
    if (lastEffect === null) {
      componentUpdateQueue.lastEffect = effect.next = effect;
    } else {
      const firstEffect = lastEffect.next;
      lastEffect.next = effect;
      effect.next = firstEffect;
      componentUpdateQueue.lastEffect = effect;
    }
  }
  return effect;
}

function mountRef<T>(initialValue: T): {|current: T|} {
  const hook = mountWorkInProgressHook();
  const ref = {current: initialValue};
  if (__DEV__) {
    Object.seal(ref);
  }
  hook.memoizedState = ref;
  return ref;
}

function updateRef<T>(initialValue: T): {|current: T|} {
  const hook = updateWorkInProgressHook();
  return hook.memoizedState;
}

function mountEffectImpl(fiberEffectTag, hookEffectTag, create, deps): void {
  const hook = mountWorkInProgressHook();
  const nextDeps = deps === undefined ? null : deps;
  currentlyRenderingFiber.effectTag |= fiberEffectTag;
  hook.memoizedState = pushEffect(
    HookHasEffect | hookEffectTag,
    create,
    undefined,
    nextDeps,
  );
}

function updateEffectImpl(fiberEffectTag, hookEffectTag, create, deps): void {
  const hook = updateWorkInProgressHook();
  const nextDeps = deps === undefined ? null : deps;
  let destroy = undefined;

  if (currentHook !== null) {
    const prevEffect = currentHook.memoizedState;
    destroy = prevEffect.destroy;
    if (nextDeps !== null) {
      const prevDeps = prevEffect.deps;
      if (areHookInputsEqual(nextDeps, prevDeps)) {
        pushEffect(hookEffectTag, create, destroy, nextDeps);
        return;
      }
    }
  }

  currentlyRenderingFiber.effectTag |= fiberEffectTag;

  hook.memoizedState = pushEffect(
    HookHasEffect | hookEffectTag,
    create,
    destroy,
    nextDeps,
  );
}

function mountEffect(
  create: () => (() => void) | void,
  deps: Array<mixed> | void | null,
): void {
  if (__DEV__) {
    // $FlowExpectedError - jest isn't a global, and isn't recognized outside of tests
    if ('undefined' !== typeof jest) {
      warnIfNotCurrentlyActingEffectsInDEV(currentlyRenderingFiber);
    }
  }
  return mountEffectImpl(
    UpdateEffect | PassiveEffect,
    HookPassive,
    create,
    deps,
  );
}

function updateEffect(
  create: () => (() => void) | void,
  deps: Array<mixed> | void | null,
): void {
  if (__DEV__) {
    // $FlowExpectedError - jest isn't a global, and isn't recognized outside of tests
    if ('undefined' !== typeof jest) {
      warnIfNotCurrentlyActingEffectsInDEV(currentlyRenderingFiber);
    }
  }
  return updateEffectImpl(
    UpdateEffect | PassiveEffect,
    HookPassive,
    create,
    deps,
  );
}

function mountLayoutEffect(
  create: () => (() => void) | void,
  deps: Array<mixed> | void | null,
): void {
  return mountEffectImpl(UpdateEffect, HookLayout, create, deps);
}

function updateLayoutEffect(
  create: () => (() => void) | void,
  deps: Array<mixed> | void | null,
): void {
  return updateEffectImpl(UpdateEffect, HookLayout, create, deps);
}

function imperativeHandleEffect<T>(
  create: () => T,
  ref: {|current: T | null|} | ((inst: T | null) => mixed) | null | void,
) {
  if (typeof ref === 'function') {
    const refCallback = ref;
    const inst = create();
    refCallback(inst);
    return () => {
      refCallback(null);
    };
  } else if (ref !== null && ref !== undefined) {
    const refObject = ref;
    if (__DEV__) {
      if (!refObject.hasOwnProperty('current')) {
        console.error(
          'Expected useImperativeHandle() first argument to either be a ' +
            'ref callback or React.createRef() object. Instead received: %s.',
          'an object with keys {' + Object.keys(refObject).join(', ') + '}',
        );
      }
    }
    const inst = create();
    refObject.current = inst;
    return () => {
      refObject.current = null;
    };
  }
}

function mountImperativeHandle<T>(
  ref: {|current: T | null|} | ((inst: T | null) => mixed) | null | void,
  create: () => T,
  deps: Array<mixed> | void | null,
): void {
  if (__DEV__) {
    if (typeof create !== 'function') {
      console.error(
        'Expected useImperativeHandle() second argument to be a function ' +
          'that creates a handle. Instead received: %s.',
        create !== null ? typeof create : 'null',
      );
    }
  }

  // TODO: If deps are provided, should we skip comparing the ref itself?
  const effectDeps =
    deps !== null && deps !== undefined ? deps.concat([ref]) : null;

  return mountEffectImpl(
    UpdateEffect,
    HookLayout,
    imperativeHandleEffect.bind(null, create, ref),
    effectDeps,
  );
}

function updateImperativeHandle<T>(
  ref: {|current: T | null|} | ((inst: T | null) => mixed) | null | void,
  create: () => T,
  deps: Array<mixed> | void | null,
): void {
  if (__DEV__) {
    if (typeof create !== 'function') {
      console.error(
        'Expected useImperativeHandle() second argument to be a function ' +
          'that creates a handle. Instead received: %s.',
        create !== null ? typeof create : 'null',
      );
    }
  }

  // TODO: If deps are provided, should we skip comparing the ref itself?
  const effectDeps =
    deps !== null && deps !== undefined ? deps.concat([ref]) : null;

  return updateEffectImpl(
    UpdateEffect,
    HookLayout,
    imperativeHandleEffect.bind(null, create, ref),
    effectDeps,
  );
}

function mountDebugValue<T>(value: T, formatterFn: ?(value: T) => mixed): void {
  // This hook is normally a no-op.
  // The react-debug-hooks package injects its own implementation
  // so that e.g. DevTools can display custom hook values.
}

const updateDebugValue = mountDebugValue;

function mountCallback<T>(callback: T, deps: Array<mixed> | void | null): T {
  const hook = mountWorkInProgressHook();
  const nextDeps = deps === undefined ? null : deps;
  hook.memoizedState = [callback, nextDeps];
  return callback;
}

function updateCallback<T>(callback: T, deps: Array<mixed> | void | null): T {
  const hook = updateWorkInProgressHook();
  const nextDeps = deps === undefined ? null : deps;
  const prevState = hook.memoizedState;
  if (prevState !== null) {
    if (nextDeps !== null) {
      const prevDeps: Array<mixed> | null = prevState[1];
      if (areHookInputsEqual(nextDeps, prevDeps)) {
        return prevState[0];
      }
    }
  }
  hook.memoizedState = [callback, nextDeps];
  return callback;
}

function mountMemo<T>(
  nextCreate: () => T,
  deps: Array<mixed> | void | null,
): T {
  const hook = mountWorkInProgressHook();
  const nextDeps = deps === undefined ? null : deps;
  const nextValue = nextCreate();
  hook.memoizedState = [nextValue, nextDeps];
  return nextValue;
}

function updateMemo<T>(
  nextCreate: () => T,
  deps: Array<mixed> | void | null,
): T {
  const hook = updateWorkInProgressHook();
  const nextDeps = deps === undefined ? null : deps;
  const prevState = hook.memoizedState;
  if (prevState !== null) {
    // Assume these are defined. If they're not, areHookInputsEqual will warn.
    if (nextDeps !== null) {
      const prevDeps: Array<mixed> | null = prevState[1];
      if (areHookInputsEqual(nextDeps, prevDeps)) {
        return prevState[0];
      }
    }
  }
  const nextValue = nextCreate();
  hook.memoizedState = [nextValue, nextDeps];
  return nextValue;
}

function mountDeferredValue<T>(
  value: T,
  config: TimeoutConfig | void | null,
): T {
  const [prevValue, setValue] = mountState(value);
  mountEffect(() => {
    const previousConfig = ReactCurrentBatchConfig.suspense;
    ReactCurrentBatchConfig.suspense = config === undefined ? null : config;
    try {
      setValue(value);
    } finally {
      ReactCurrentBatchConfig.suspense = previousConfig;
    }
  }, [value, config]);
  return prevValue;
}

function updateDeferredValue<T>(
  value: T,
  config: TimeoutConfig | void | null,
): T {
  const [prevValue, setValue] = updateState(value);
  updateEffect(() => {
    const previousConfig = ReactCurrentBatchConfig.suspense;
    ReactCurrentBatchConfig.suspense = config === undefined ? null : config;
    try {
      setValue(value);
    } finally {
      ReactCurrentBatchConfig.suspense = previousConfig;
    }
  }, [value, config]);
  return prevValue;
}

function rerenderDeferredValue<T>(
  value: T,
  config: TimeoutConfig | void | null,
): T {
  const [prevValue, setValue] = rerenderState(value);
  updateEffect(() => {
    const previousConfig = ReactCurrentBatchConfig.suspense;
    ReactCurrentBatchConfig.suspense = config === undefined ? null : config;
    try {
      setValue(value);
    } finally {
      ReactCurrentBatchConfig.suspense = previousConfig;
    }
  }, [value, config]);
  return prevValue;
}

function startTransition(setPending, config, callback) {
  const priorityLevel = getCurrentPriorityLevel();
  runWithPriority(
    priorityLevel < UserBlockingPriority ? UserBlockingPriority : priorityLevel,
    () => {
      setPending(true);
    },
  );
  runWithPriority(
    priorityLevel > NormalPriority ? NormalPriority : priorityLevel,
    () => {
      const previousConfig = ReactCurrentBatchConfig.suspense;
      ReactCurrentBatchConfig.suspense = config === undefined ? null : config;
      try {
        setPending(false);
        callback();
      } finally {
        ReactCurrentBatchConfig.suspense = previousConfig;
      }
    },
  );
}

function mountTransition(
  config: SuspenseConfig | void | null,
): [(() => void) => void, boolean] {
  const [isPending, setPending] = mountState(false);
  const start = mountCallback(startTransition.bind(null, setPending, config), [
    setPending,
    config,
  ]);
  return [start, isPending];
}

function updateTransition(
  config: SuspenseConfig | void | null,
): [(() => void) => void, boolean] {
  const [isPending, setPending] = updateState(false);
  const start = updateCallback(startTransition.bind(null, setPending, config), [
    setPending,
    config,
  ]);
  return [start, isPending];
}

function rerenderTransition(
  config: SuspenseConfig | void | null,
): [(() => void) => void, boolean] {
  const [isPending, setPending] = rerenderState(false);
  const start = updateCallback(startTransition.bind(null, setPending, config), [
    setPending,
    config,
  ]);
  return [start, isPending];
}

function dispatchAction<S, A>(
  fiber: Fiber,
  queue: UpdateQueue<S, A>,
  action: A,
) {
  if (__DEV__) {
    if (typeof arguments[3] === 'function') {
      console.error(
        "State updates from the useState() and useReducer() Hooks don't support the " +
          'second callback argument. To execute a side effect after ' +
          'rendering, declare it in the component body with useEffect().',
      );
    }
  }

  const currentTime = requestCurrentTimeForUpdate();
  const suspenseConfig = requestCurrentSuspenseConfig();
  const expirationTime = computeExpirationForFiber(
    currentTime,
    fiber,
    suspenseConfig,
  );

  const update: Update<S, A> = {
    expirationTime,
    suspenseConfig,
    action,
    eagerReducer: null,
    eagerState: null,
    next: (null: any),
  };

  if (__DEV__) {
    update.priority = getCurrentPriorityLevel();
  }

  // Append the update to the end of the list.
  const pending = queue.pending;
  if (pending === null) {
    // This is the first update. Create a circular list.
    update.next = update;
  } else {
    update.next = pending.next;
    pending.next = update;
  }
  queue.pending = update;

  const alternate = fiber.alternate;
  if (
    fiber === currentlyRenderingFiber ||
    (alternate !== null && alternate === currentlyRenderingFiber)
  ) {
    // This is a render phase update. Stash it in a lazily-created map of
    // queue -> linked list of updates. After this render pass, we'll restart
    // and apply the stashed updates on top of the work-in-progress hook.
    didScheduleRenderPhaseUpdate = true;
    update.expirationTime = renderExpirationTime;
    currentlyRenderingFiber.expirationTime = renderExpirationTime;
  } else {
    if (
      fiber.expirationTime === NoWork &&
      (alternate === null || alternate.expirationTime === NoWork)
    ) {
      // The queue is currently empty, which means we can eagerly compute the
      // next state before entering the render phase. If the new state is the
      // same as the current state, we may be able to bail out entirely.
      const lastRenderedReducer = queue.lastRenderedReducer;
      if (lastRenderedReducer !== null) {
        let prevDispatcher;
        if (__DEV__) {
          prevDispatcher = ReactCurrentDispatcher.current;
          ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnUpdateInDEV;
        }
        try {
          const currentState: S = (queue.lastRenderedState: any);
          const eagerState = lastRenderedReducer(currentState, action);
          // Stash the eagerly computed state, and the reducer used to compute
          // it, on the update object. If the reducer hasn't changed by the
          // time we enter the render phase, then the eager state can be used
          // without calling the reducer again.
          update.eagerReducer = lastRenderedReducer;
          update.eagerState = eagerState;
          if (is(eagerState, currentState)) {
            // Fast path. We can bail out without scheduling React to re-render.
            // It's still possible that we'll need to rebase this update later,
            // if the component re-renders for a different reason and by that
            // time the reducer has changed.
            return;
          }
        } catch (error) {
          // Suppress the error. It will throw again in the render phase.
        } finally {
          if (__DEV__) {
            ReactCurrentDispatcher.current = prevDispatcher;
          }
        }
      }
    }
    if (__DEV__) {
      // $FlowExpectedError - jest isn't a global, and isn't recognized outside of tests
      if ('undefined' !== typeof jest) {
        warnIfNotScopedWithMatchingAct(fiber);
        warnIfNotCurrentlyActingUpdatesInDev(fiber);
      }
    }
    scheduleUpdateOnFiber(fiber, expirationTime);
  }
}

const noOpMount = () => {};

function validateNotInFunctionRender(): boolean {
  if (currentlyRenderingFiber === null) {
    return true;
  }
  if (__DEV__) {
    console.warn(
      'Event listener methods from useEvent() cannot be called during render.' +
        ' These methods should be called in an effect or event callback outside the render.',
    );
  }
  return false;
}

function createReactListener(
  event: ReactListenerEvent,
  callback: Event => void,
  target: EventTarget | ReactScopeMethods,
  destroy: Node => void,
): ReactListener {
  return {
    callback,
    destroy,
    event,
    target,
  };
}

function mountEventListener(event: ReactListenerEvent): ReactListenerMap {
  if (enableUseEventAPI) {
    const hook = mountWorkInProgressHook();
    const listenerMap: Map<
      EventTarget | ReactScopeMethods,
      ReactListener,
    > = new Map();
    const rootContainerInstance = getRootHostContainer();

    // Register the event to the current root to ensure event
    // replaying can pick up the event ahead of time.
    registerEvent(event, rootContainerInstance);

    const clear = () => {
      if (validateNotInFunctionRender()) {
        const listeners = Array.from(listenerMap.values());
        for (let i = 0; i < listeners.length; i++) {
          unmountHostEventListener(listeners[i]);
        }
        listenerMap.clear();
      }
    };

    const destroy = (target: Node) => {
      // We don't need to call detachListenerFromInstance
      // here as this method should only ever be called
      // from renderers that need to remove the instance
      // from the map representing an instance that still
      // holds a reference to the listenerMap. This means
      // things like "window" listeners on ReactDOM should
      // never enter this call path as the the instance in
      // those cases would be that of "window", which
      // should be handled via an optimized route in the
      // renderer, making less overhead here. If we change
      // this heuristic we should update this path to make
      // sure we call detachListenerFromInstance.
      listenerMap.delete(target);
    };

    const reactListenerMap: ReactListenerMap = {
      clear,
      setListener(
        target: EventTarget | ReactScopeMethods,
        callback: ?(Event) => void,
      ): void {
        if (
          validateNotInFunctionRender() &&
          validateEventListenerTarget(target, callback)
        ) {
          let listener = listenerMap.get(target);
          if (listener === undefined) {
            if (callback == null) {
              return;
            }
            listener = createReactListener(event, callback, target, destroy);
            listenerMap.set(target, listener);
          } else {
            if (callback == null) {
              listenerMap.delete(target);
              unmountHostEventListener(listener);
              return;
            }
            listener.callback = callback;
          }
          mountHostEventListener(listener);
        }
      },
    };
    // In order to clear up upon the hook unmounting,
    // we ensure we set the effecrt tag so that we visit
    // this effect in the commit phase, so we can handle
    // clean-up accordingly.
    currentlyRenderingFiber.effectTag |= UpdateEffect;
    pushEffect(NoHookEffect, noOpMount, clear, null);
    hook.memoizedState = [reactListenerMap, event, clear];
    return reactListenerMap;
  }
  // To make Flow not complain
  return (undefined: any);
}

function updateEventListener(event: ReactListenerEvent): ReactListenerMap {
  if (enableUseEventAPI) {
    const hook = updateWorkInProgressHook();
    const [reactListenerMap, memoizedEvent, clear] = hook.memoizedState;
    if (__DEV__) {
      if (memoizedEvent.type !== event.type) {
        console.warn(
          'The event type argument passed to the useEvent() hook was different between renders.' +
            ' The event type is static and should never change between renders.',
        );
      }
      if (memoizedEvent.capture !== event.capture) {
        console.warn(
          'The "capture" option passed to the useEvent() hook was different between renders.' +
            ' The "capture" option is static and should never change between renders.',
        );
      }
      if (memoizedEvent.priority !== event.priority) {
        console.warn(
          'The "priority" option passed to the useEvent() hook was different between renders.' +
            ' The "priority" option is static and should never change between renders.',
        );
      }
      if (memoizedEvent.passive !== event.passive) {
        console.warn(
          'The "passive" option passed to the useEvent() hook was different between renders.' +
            ' The "passive" option is static and should never change between renders.',
        );
      }
    }
    // In order to clear up upon the hook unmounting,
    // we ensure we set the effecrt tag so that we visit
    // this effect in the commit phase, so we can handle
    // clean-up accordingly.
    currentlyRenderingFiber.effectTag |= UpdateEffect;
    pushEffect(NoHookEffect, noOpMount, clear, null);
    return reactListenerMap;
  }
  // To make Flow not complain
  return (undefined: any);
}

export const ContextOnlyDispatcher: Dispatcher = {
  readContext,

  useCallback: throwInvalidHookError,
  useContext: throwInvalidHookError,
  useEffect: throwInvalidHookError,
  useImperativeHandle: throwInvalidHookError,
  useLayoutEffect: throwInvalidHookError,
  useMemo: throwInvalidHookError,
  useReducer: throwInvalidHookError,
  useRef: throwInvalidHookError,
  useState: throwInvalidHookError,
  useDebugValue: throwInvalidHookError,
  useResponder: throwInvalidHookError,
  useDeferredValue: throwInvalidHookError,
  useTransition: throwInvalidHookError,
  useMutableSource: throwInvalidHookError,
  useEvent: throwInvalidHookError,
};

const HooksDispatcherOnMount: Dispatcher = {
  readContext,

  useCallback: mountCallback,
  useContext: readContext,
  useEffect: mountEffect,
  useImperativeHandle: mountImperativeHandle,
  useLayoutEffect: mountLayoutEffect,
  useMemo: mountMemo,
  useReducer: mountReducer,
  useRef: mountRef,
  useState: mountState,
  useDebugValue: mountDebugValue,
  useResponder: createDeprecatedResponderListener,
  useDeferredValue: mountDeferredValue,
  useTransition: mountTransition,
  useMutableSource: mountMutableSource,
  useEvent: mountEventListener,
};

const HooksDispatcherOnUpdate: Dispatcher = {
  readContext,

  useCallback: updateCallback,
  useContext: readContext,
  useEffect: updateEffect,
  useImperativeHandle: updateImperativeHandle,
  useLayoutEffect: updateLayoutEffect,
  useMemo: updateMemo,
  useReducer: updateReducer,
  useRef: updateRef,
  useState: updateState,
  useDebugValue: updateDebugValue,
  useResponder: createDeprecatedResponderListener,
  useDeferredValue: updateDeferredValue,
  useTransition: updateTransition,
  useMutableSource: updateMutableSource,
  useEvent: updateEventListener,
};

const HooksDispatcherOnRerender: Dispatcher = {
  readContext,

  useCallback: updateCallback,
  useContext: readContext,
  useEffect: updateEffect,
  useImperativeHandle: updateImperativeHandle,
  useLayoutEffect: updateLayoutEffect,
  useMemo: updateMemo,
  useReducer: rerenderReducer,
  useRef: updateRef,
  useState: rerenderState,
  useDebugValue: updateDebugValue,
  useResponder: createDeprecatedResponderListener,
  useDeferredValue: rerenderDeferredValue,
  useTransition: rerenderTransition,
  useMutableSource: updateMutableSource,
  useEvent: updateEventListener,
};

let HooksDispatcherOnMountInDEV: Dispatcher | null = null;
let HooksDispatcherOnMountWithHookTypesInDEV: Dispatcher | null = null;
let HooksDispatcherOnUpdateInDEV: Dispatcher | null = null;
let HooksDispatcherOnRerenderInDEV: Dispatcher | null = null;
let InvalidNestedHooksDispatcherOnMountInDEV: Dispatcher | null = null;
let InvalidNestedHooksDispatcherOnUpdateInDEV: Dispatcher | null = null;
let InvalidNestedHooksDispatcherOnRerenderInDEV: Dispatcher | null = null;

if (__DEV__) {
  const warnInvalidContextAccess = () => {
    console.error(
      'Context can only be read while React is rendering. ' +
        'In classes, you can read it in the render method or getDerivedStateFromProps. ' +
        'In function components, you can read it directly in the function body, but not ' +
        'inside Hooks like useReducer() or useMemo().',
    );
  };

  const warnInvalidHookAccess = () => {
    console.error(
      'Do not call Hooks inside useEffect(...), useMemo(...), or other built-in Hooks. ' +
        'You can only call Hooks at the top level of your React function. ' +
        'For more information, see ' +
        'https://fb.me/rules-of-hooks',
    );
  };

  HooksDispatcherOnMountInDEV = {
    readContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      return readContext(context, observedBits);
    },

    useCallback<T>(callback: T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useCallback';
      mountHookTypesDev();
      checkDepsAreArrayDev(deps);
      return mountCallback(callback, deps);
    },
    useContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      currentHookNameInDev = 'useContext';
      mountHookTypesDev();
      return readContext(context, observedBits);
    },
    useEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useEffect';
      mountHookTypesDev();
      checkDepsAreArrayDev(deps);
      return mountEffect(create, deps);
    },
    useImperativeHandle<T>(
      ref: {|current: T | null|} | ((inst: T | null) => mixed) | null | void,
      create: () => T,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useImperativeHandle';
      mountHookTypesDev();
      checkDepsAreArrayDev(deps);
      return mountImperativeHandle(ref, create, deps);
    },
    useLayoutEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useLayoutEffect';
      mountHookTypesDev();
      checkDepsAreArrayDev(deps);
      return mountLayoutEffect(create, deps);
    },
    useMemo<T>(create: () => T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useMemo';
      mountHookTypesDev();
      checkDepsAreArrayDev(deps);
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnMountInDEV;
      try {
        return mountMemo(create, deps);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useReducer<S, I, A>(
      reducer: (S, A) => S,
      initialArg: I,
      init?: I => S,
    ): [S, Dispatch<A>] {
      currentHookNameInDev = 'useReducer';
      mountHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnMountInDEV;
      try {
        return mountReducer(reducer, initialArg, init);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useRef<T>(initialValue: T): {|current: T|} {
      currentHookNameInDev = 'useRef';
      mountHookTypesDev();
      return mountRef(initialValue);
    },
    useState<S>(
      initialState: (() => S) | S,
    ): [S, Dispatch<BasicStateAction<S>>] {
      currentHookNameInDev = 'useState';
      mountHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnMountInDEV;
      try {
        return mountState(initialState);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useDebugValue<T>(value: T, formatterFn: ?(value: T) => mixed): void {
      currentHookNameInDev = 'useDebugValue';
      mountHookTypesDev();
      return mountDebugValue(value, formatterFn);
    },
    useResponder<E, C>(
      responder: ReactEventResponder<E, C>,
      props,
    ): ReactEventResponderListener<E, C> {
      currentHookNameInDev = 'useResponder';
      mountHookTypesDev();
      return createDeprecatedResponderListener(responder, props);
    },
    useDeferredValue<T>(value: T, config: TimeoutConfig | void | null): T {
      currentHookNameInDev = 'useDeferredValue';
      mountHookTypesDev();
      return mountDeferredValue(value, config);
    },
    useTransition(
      config: SuspenseConfig | void | null,
    ): [(() => void) => void, boolean] {
      currentHookNameInDev = 'useTransition';
      mountHookTypesDev();
      return mountTransition(config);
    },
    useMutableSource<Source, Snapshot>(
      source: MutableSource<Source>,
      getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
      subscribe: MutableSourceSubscribeFn<Source, Snapshot>,
    ): Snapshot {
      currentHookNameInDev = 'useMutableSource';
      mountHookTypesDev();
      return mountMutableSource(source, getSnapshot, subscribe);
    },
    useEvent(event: ReactListenerEvent): ReactListenerMap {
      currentHookNameInDev = 'useEvent';
      mountHookTypesDev();
      return mountEventListener(event);
    },
  };

  HooksDispatcherOnMountWithHookTypesInDEV = {
    readContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      return readContext(context, observedBits);
    },

    useCallback<T>(callback: T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useCallback';
      updateHookTypesDev();
      return mountCallback(callback, deps);
    },
    useContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      currentHookNameInDev = 'useContext';
      updateHookTypesDev();
      return readContext(context, observedBits);
    },
    useEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useEffect';
      updateHookTypesDev();
      return mountEffect(create, deps);
    },
    useImperativeHandle<T>(
      ref: {|current: T | null|} | ((inst: T | null) => mixed) | null | void,
      create: () => T,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useImperativeHandle';
      updateHookTypesDev();
      return mountImperativeHandle(ref, create, deps);
    },
    useLayoutEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useLayoutEffect';
      updateHookTypesDev();
      return mountLayoutEffect(create, deps);
    },
    useMemo<T>(create: () => T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useMemo';
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnMountInDEV;
      try {
        return mountMemo(create, deps);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useReducer<S, I, A>(
      reducer: (S, A) => S,
      initialArg: I,
      init?: I => S,
    ): [S, Dispatch<A>] {
      currentHookNameInDev = 'useReducer';
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnMountInDEV;
      try {
        return mountReducer(reducer, initialArg, init);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useRef<T>(initialValue: T): {|current: T|} {
      currentHookNameInDev = 'useRef';
      updateHookTypesDev();
      return mountRef(initialValue);
    },
    useState<S>(
      initialState: (() => S) | S,
    ): [S, Dispatch<BasicStateAction<S>>] {
      currentHookNameInDev = 'useState';
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnMountInDEV;
      try {
        return mountState(initialState);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useDebugValue<T>(value: T, formatterFn: ?(value: T) => mixed): void {
      currentHookNameInDev = 'useDebugValue';
      updateHookTypesDev();
      return mountDebugValue(value, formatterFn);
    },
    useResponder<E, C>(
      responder: ReactEventResponder<E, C>,
      props,
    ): ReactEventResponderListener<E, C> {
      currentHookNameInDev = 'useResponder';
      updateHookTypesDev();
      return createDeprecatedResponderListener(responder, props);
    },
    useDeferredValue<T>(value: T, config: TimeoutConfig | void | null): T {
      currentHookNameInDev = 'useDeferredValue';
      updateHookTypesDev();
      return mountDeferredValue(value, config);
    },
    useTransition(
      config: SuspenseConfig | void | null,
    ): [(() => void) => void, boolean] {
      currentHookNameInDev = 'useTransition';
      updateHookTypesDev();
      return mountTransition(config);
    },
    useMutableSource<Source, Snapshot>(
      source: MutableSource<Source>,
      getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
      subscribe: MutableSourceSubscribeFn<Source, Snapshot>,
    ): Snapshot {
      currentHookNameInDev = 'useMutableSource';
      updateHookTypesDev();
      return mountMutableSource(source, getSnapshot, subscribe);
    },
    useEvent(event: ReactListenerEvent): ReactListenerMap {
      currentHookNameInDev = 'useEvent';
      updateHookTypesDev();
      return mountEventListener(event);
    },
  };

  HooksDispatcherOnUpdateInDEV = {
    readContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      return readContext(context, observedBits);
    },

    useCallback<T>(callback: T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useCallback';
      updateHookTypesDev();
      return updateCallback(callback, deps);
    },
    useContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      currentHookNameInDev = 'useContext';
      updateHookTypesDev();
      return readContext(context, observedBits);
    },
    useEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useEffect';
      updateHookTypesDev();
      return updateEffect(create, deps);
    },
    useImperativeHandle<T>(
      ref: {|current: T | null|} | ((inst: T | null) => mixed) | null | void,
      create: () => T,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useImperativeHandle';
      updateHookTypesDev();
      return updateImperativeHandle(ref, create, deps);
    },
    useLayoutEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useLayoutEffect';
      updateHookTypesDev();
      return updateLayoutEffect(create, deps);
    },
    useMemo<T>(create: () => T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useMemo';
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnUpdateInDEV;
      try {
        return updateMemo(create, deps);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useReducer<S, I, A>(
      reducer: (S, A) => S,
      initialArg: I,
      init?: I => S,
    ): [S, Dispatch<A>] {
      currentHookNameInDev = 'useReducer';
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnUpdateInDEV;
      try {
        return updateReducer(reducer, initialArg, init);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useRef<T>(initialValue: T): {|current: T|} {
      currentHookNameInDev = 'useRef';
      updateHookTypesDev();
      return updateRef(initialValue);
    },
    useState<S>(
      initialState: (() => S) | S,
    ): [S, Dispatch<BasicStateAction<S>>] {
      currentHookNameInDev = 'useState';
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnUpdateInDEV;
      try {
        return updateState(initialState);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useDebugValue<T>(value: T, formatterFn: ?(value: T) => mixed): void {
      currentHookNameInDev = 'useDebugValue';
      updateHookTypesDev();
      return updateDebugValue(value, formatterFn);
    },
    useResponder<E, C>(
      responder: ReactEventResponder<E, C>,
      props,
    ): ReactEventResponderListener<E, C> {
      currentHookNameInDev = 'useResponder';
      updateHookTypesDev();
      return createDeprecatedResponderListener(responder, props);
    },
    useDeferredValue<T>(value: T, config: TimeoutConfig | void | null): T {
      currentHookNameInDev = 'useDeferredValue';
      updateHookTypesDev();
      return updateDeferredValue(value, config);
    },
    useTransition(
      config: SuspenseConfig | void | null,
    ): [(() => void) => void, boolean] {
      currentHookNameInDev = 'useTransition';
      updateHookTypesDev();
      return updateTransition(config);
    },
    useMutableSource<Source, Snapshot>(
      source: MutableSource<Source>,
      getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
      subscribe: MutableSourceSubscribeFn<Source, Snapshot>,
    ): Snapshot {
      currentHookNameInDev = 'useMutableSource';
      updateHookTypesDev();
      return updateMutableSource(source, getSnapshot, subscribe);
    },
    useEvent(event: ReactListenerEvent): ReactListenerMap {
      currentHookNameInDev = 'useEvent';
      updateHookTypesDev();
      return updateEventListener(event);
    },
  };

  HooksDispatcherOnRerenderInDEV = {
    readContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      return readContext(context, observedBits);
    },

    useCallback<T>(callback: T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useCallback';
      updateHookTypesDev();
      return updateCallback(callback, deps);
    },
    useContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      currentHookNameInDev = 'useContext';
      updateHookTypesDev();
      return readContext(context, observedBits);
    },
    useEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useEffect';
      updateHookTypesDev();
      return updateEffect(create, deps);
    },
    useImperativeHandle<T>(
      ref: {|current: T | null|} | ((inst: T | null) => mixed) | null | void,
      create: () => T,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useImperativeHandle';
      updateHookTypesDev();
      return updateImperativeHandle(ref, create, deps);
    },
    useLayoutEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useLayoutEffect';
      updateHookTypesDev();
      return updateLayoutEffect(create, deps);
    },
    useMemo<T>(create: () => T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useMemo';
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnRerenderInDEV;
      try {
        return updateMemo(create, deps);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useReducer<S, I, A>(
      reducer: (S, A) => S,
      initialArg: I,
      init?: I => S,
    ): [S, Dispatch<A>] {
      currentHookNameInDev = 'useReducer';
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnRerenderInDEV;
      try {
        return rerenderReducer(reducer, initialArg, init);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useRef<T>(initialValue: T): {|current: T|} {
      currentHookNameInDev = 'useRef';
      updateHookTypesDev();
      return updateRef(initialValue);
    },
    useState<S>(
      initialState: (() => S) | S,
    ): [S, Dispatch<BasicStateAction<S>>] {
      currentHookNameInDev = 'useState';
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnRerenderInDEV;
      try {
        return rerenderState(initialState);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useDebugValue<T>(value: T, formatterFn: ?(value: T) => mixed): void {
      currentHookNameInDev = 'useDebugValue';
      updateHookTypesDev();
      return updateDebugValue(value, formatterFn);
    },
    useResponder<E, C>(
      responder: ReactEventResponder<E, C>,
      props,
    ): ReactEventResponderListener<E, C> {
      currentHookNameInDev = 'useResponder';
      updateHookTypesDev();
      return createDeprecatedResponderListener(responder, props);
    },
    useDeferredValue<T>(value: T, config: TimeoutConfig | void | null): T {
      currentHookNameInDev = 'useDeferredValue';
      updateHookTypesDev();
      return rerenderDeferredValue(value, config);
    },
    useTransition(
      config: SuspenseConfig | void | null,
    ): [(() => void) => void, boolean] {
      currentHookNameInDev = 'useTransition';
      updateHookTypesDev();
      return rerenderTransition(config);
    },
    useMutableSource<Source, Snapshot>(
      source: MutableSource<Source>,
      getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
      subscribe: MutableSourceSubscribeFn<Source, Snapshot>,
    ): Snapshot {
      currentHookNameInDev = 'useMutableSource';
      updateHookTypesDev();
      return updateMutableSource(source, getSnapshot, subscribe);
    },
    useEvent(event: ReactListenerEvent): ReactListenerMap {
      currentHookNameInDev = 'useEvent';
      updateHookTypesDev();
      return updateEventListener(event);
    },
  };

  InvalidNestedHooksDispatcherOnMountInDEV = {
    readContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      warnInvalidContextAccess();
      return readContext(context, observedBits);
    },

    useCallback<T>(callback: T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useCallback';
      warnInvalidHookAccess();
      mountHookTypesDev();
      return mountCallback(callback, deps);
    },
    useContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      currentHookNameInDev = 'useContext';
      warnInvalidHookAccess();
      mountHookTypesDev();
      return readContext(context, observedBits);
    },
    useEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useEffect';
      warnInvalidHookAccess();
      mountHookTypesDev();
      return mountEffect(create, deps);
    },
    useImperativeHandle<T>(
      ref: {|current: T | null|} | ((inst: T | null) => mixed) | null | void,
      create: () => T,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useImperativeHandle';
      warnInvalidHookAccess();
      mountHookTypesDev();
      return mountImperativeHandle(ref, create, deps);
    },
    useLayoutEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useLayoutEffect';
      warnInvalidHookAccess();
      mountHookTypesDev();
      return mountLayoutEffect(create, deps);
    },
    useMemo<T>(create: () => T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useMemo';
      warnInvalidHookAccess();
      mountHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnMountInDEV;
      try {
        return mountMemo(create, deps);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useReducer<S, I, A>(
      reducer: (S, A) => S,
      initialArg: I,
      init?: I => S,
    ): [S, Dispatch<A>] {
      currentHookNameInDev = 'useReducer';
      warnInvalidHookAccess();
      mountHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnMountInDEV;
      try {
        return mountReducer(reducer, initialArg, init);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useRef<T>(initialValue: T): {|current: T|} {
      currentHookNameInDev = 'useRef';
      warnInvalidHookAccess();
      mountHookTypesDev();
      return mountRef(initialValue);
    },
    useState<S>(
      initialState: (() => S) | S,
    ): [S, Dispatch<BasicStateAction<S>>] {
      currentHookNameInDev = 'useState';
      warnInvalidHookAccess();
      mountHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnMountInDEV;
      try {
        return mountState(initialState);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useDebugValue<T>(value: T, formatterFn: ?(value: T) => mixed): void {
      currentHookNameInDev = 'useDebugValue';
      warnInvalidHookAccess();
      mountHookTypesDev();
      return mountDebugValue(value, formatterFn);
    },
    useResponder<E, C>(
      responder: ReactEventResponder<E, C>,
      props,
    ): ReactEventResponderListener<E, C> {
      currentHookNameInDev = 'useResponder';
      warnInvalidHookAccess();
      mountHookTypesDev();
      return createDeprecatedResponderListener(responder, props);
    },
    useDeferredValue<T>(value: T, config: TimeoutConfig | void | null): T {
      currentHookNameInDev = 'useDeferredValue';
      warnInvalidHookAccess();
      mountHookTypesDev();
      return mountDeferredValue(value, config);
    },
    useTransition(
      config: SuspenseConfig | void | null,
    ): [(() => void) => void, boolean] {
      currentHookNameInDev = 'useTransition';
      warnInvalidHookAccess();
      mountHookTypesDev();
      return mountTransition(config);
    },
    useMutableSource<Source, Snapshot>(
      source: MutableSource<Source>,
      getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
      subscribe: MutableSourceSubscribeFn<Source, Snapshot>,
    ): Snapshot {
      currentHookNameInDev = 'useMutableSource';
      warnInvalidHookAccess();
      mountHookTypesDev();
      return mountMutableSource(source, getSnapshot, subscribe);
    },
    useEvent(event: ReactListenerEvent): ReactListenerMap {
      currentHookNameInDev = 'useEvent';
      warnInvalidHookAccess();
      mountHookTypesDev();
      return mountEventListener(event);
    },
  };

  InvalidNestedHooksDispatcherOnUpdateInDEV = {
    readContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      warnInvalidContextAccess();
      return readContext(context, observedBits);
    },

    useCallback<T>(callback: T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useCallback';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateCallback(callback, deps);
    },
    useContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      currentHookNameInDev = 'useContext';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return readContext(context, observedBits);
    },
    useEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useEffect';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateEffect(create, deps);
    },
    useImperativeHandle<T>(
      ref: {|current: T | null|} | ((inst: T | null) => mixed) | null | void,
      create: () => T,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useImperativeHandle';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateImperativeHandle(ref, create, deps);
    },
    useLayoutEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useLayoutEffect';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateLayoutEffect(create, deps);
    },
    useMemo<T>(create: () => T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useMemo';
      warnInvalidHookAccess();
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnUpdateInDEV;
      try {
        return updateMemo(create, deps);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useReducer<S, I, A>(
      reducer: (S, A) => S,
      initialArg: I,
      init?: I => S,
    ): [S, Dispatch<A>] {
      currentHookNameInDev = 'useReducer';
      warnInvalidHookAccess();
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnUpdateInDEV;
      try {
        return updateReducer(reducer, initialArg, init);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useRef<T>(initialValue: T): {|current: T|} {
      currentHookNameInDev = 'useRef';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateRef(initialValue);
    },
    useState<S>(
      initialState: (() => S) | S,
    ): [S, Dispatch<BasicStateAction<S>>] {
      currentHookNameInDev = 'useState';
      warnInvalidHookAccess();
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnUpdateInDEV;
      try {
        return updateState(initialState);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useDebugValue<T>(value: T, formatterFn: ?(value: T) => mixed): void {
      currentHookNameInDev = 'useDebugValue';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateDebugValue(value, formatterFn);
    },
    useResponder<E, C>(
      responder: ReactEventResponder<E, C>,
      props,
    ): ReactEventResponderListener<E, C> {
      currentHookNameInDev = 'useResponder';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return createDeprecatedResponderListener(responder, props);
    },
    useDeferredValue<T>(value: T, config: TimeoutConfig | void | null): T {
      currentHookNameInDev = 'useDeferredValue';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateDeferredValue(value, config);
    },
    useTransition(
      config: SuspenseConfig | void | null,
    ): [(() => void) => void, boolean] {
      currentHookNameInDev = 'useTransition';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateTransition(config);
    },
    useMutableSource<Source, Snapshot>(
      source: MutableSource<Source>,
      getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
      subscribe: MutableSourceSubscribeFn<Source, Snapshot>,
    ): Snapshot {
      currentHookNameInDev = 'useMutableSource';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateMutableSource(source, getSnapshot, subscribe);
    },
    useEvent(event: ReactListenerEvent): ReactListenerMap {
      currentHookNameInDev = 'useEvent';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateEventListener(event);
    },
  };

  InvalidNestedHooksDispatcherOnRerenderInDEV = {
    readContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      warnInvalidContextAccess();
      return readContext(context, observedBits);
    },

    useCallback<T>(callback: T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useCallback';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateCallback(callback, deps);
    },
    useContext<T>(
      context: ReactContext<T>,
      observedBits: void | number | boolean,
    ): T {
      currentHookNameInDev = 'useContext';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return readContext(context, observedBits);
    },
    useEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useEffect';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateEffect(create, deps);
    },
    useImperativeHandle<T>(
      ref: {|current: T | null|} | ((inst: T | null) => mixed) | null | void,
      create: () => T,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useImperativeHandle';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateImperativeHandle(ref, create, deps);
    },
    useLayoutEffect(
      create: () => (() => void) | void,
      deps: Array<mixed> | void | null,
    ): void {
      currentHookNameInDev = 'useLayoutEffect';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateLayoutEffect(create, deps);
    },
    useMemo<T>(create: () => T, deps: Array<mixed> | void | null): T {
      currentHookNameInDev = 'useMemo';
      warnInvalidHookAccess();
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnUpdateInDEV;
      try {
        return updateMemo(create, deps);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useReducer<S, I, A>(
      reducer: (S, A) => S,
      initialArg: I,
      init?: I => S,
    ): [S, Dispatch<A>] {
      currentHookNameInDev = 'useReducer';
      warnInvalidHookAccess();
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnUpdateInDEV;
      try {
        return rerenderReducer(reducer, initialArg, init);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useRef<T>(initialValue: T): {|current: T|} {
      currentHookNameInDev = 'useRef';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateRef(initialValue);
    },
    useState<S>(
      initialState: (() => S) | S,
    ): [S, Dispatch<BasicStateAction<S>>] {
      currentHookNameInDev = 'useState';
      warnInvalidHookAccess();
      updateHookTypesDev();
      const prevDispatcher = ReactCurrentDispatcher.current;
      ReactCurrentDispatcher.current = InvalidNestedHooksDispatcherOnUpdateInDEV;
      try {
        return rerenderState(initialState);
      } finally {
        ReactCurrentDispatcher.current = prevDispatcher;
      }
    },
    useDebugValue<T>(value: T, formatterFn: ?(value: T) => mixed): void {
      currentHookNameInDev = 'useDebugValue';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateDebugValue(value, formatterFn);
    },
    useResponder<E, C>(
      responder: ReactEventResponder<E, C>,
      props,
    ): ReactEventResponderListener<E, C> {
      currentHookNameInDev = 'useResponder';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return createDeprecatedResponderListener(responder, props);
    },
    useDeferredValue<T>(value: T, config: TimeoutConfig | void | null): T {
      currentHookNameInDev = 'useDeferredValue';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return rerenderDeferredValue(value, config);
    },
    useTransition(
      config: SuspenseConfig | void | null,
    ): [(() => void) => void, boolean] {
      currentHookNameInDev = 'useTransition';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return rerenderTransition(config);
    },
    useMutableSource<Source, Snapshot>(
      source: MutableSource<Source>,
      getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>,
      subscribe: MutableSourceSubscribeFn<Source, Snapshot>,
    ): Snapshot {
      currentHookNameInDev = 'useMutableSource';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateMutableSource(source, getSnapshot, subscribe);
    },
    useEvent(event: ReactListenerEvent): ReactListenerMap {
      currentHookNameInDev = 'useEvent';
      warnInvalidHookAccess();
      updateHookTypesDev();
      return updateEventListener(event);
    },
  };
}
