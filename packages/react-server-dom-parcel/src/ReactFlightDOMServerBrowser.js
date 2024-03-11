/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactClientValue} from 'react-server/src/ReactFlightServer';
import type {
  ReactFormState,
  Thenable,
} from 'shared/ReactTypes';
import {
  preloadModule,
  requireModule,
  resolveServerReference,
  type ServerManifest,
  type ServerReferenceId,
} from './ReactFlightClientConfigBundlerParcel';

import {
  createRequest,
  startWork,
  startFlowing,
  stopFlowing,
  abort,
} from 'react-server/src/ReactFlightServer';

import {
  createResponse,
  close,
  getRoot,
} from 'react-server/src/ReactFlightReplyServer';

import {
  decodeAction as decodeActionImpl,
  decodeFormState as decodeFormStateImpl,
} from 'react-server/src/ReactFlightActionServer';

export {
  createClientReference,
  registerServerReference,
} from './ReactFlightParcelReferences';

type Options = {
  environmentName?: string,
  identifierPrefix?: string,
  signal?: AbortSignal,
  onError?: (error: mixed) => void,
  onPostpone?: (reason: string) => void,
};

export function renderToReadableStream(
  model: ReactClientValue,
  options?: Options,
): ReadableStream {
  const request = createRequest(
    model,
    null,
    options ? options.onError : undefined,
    options ? options.identifierPrefix : undefined,
    options ? options.onPostpone : undefined,
    options ? options.environmentName : undefined,
  );
  if (options && options.signal) {
    const signal = options.signal;
    if (signal.aborted) {
      abort(request, (signal: any).reason);
    } else {
      const listener = () => {
        abort(request, (signal: any).reason);
        signal.removeEventListener('abort', listener);
      };
      signal.addEventListener('abort', listener);
    }
  }
  const stream = new ReadableStream(
    {
      type: 'bytes',
      start: (controller): ?Promise<void> => {
        startWork(request);
      },
      pull: (controller): ?Promise<void> => {
        startFlowing(request, controller);
      },
      cancel: (reason): ?Promise<void> => {
        stopFlowing(request);
        abort(request, reason);
      },
    },
    // $FlowFixMe[prop-missing] size() methods are not allowed on byte streams.
    {highWaterMark: 0},
  );
  return stream;
}

let serverManifest = {};
export function registerServerActions(manifest: ServerManifest) {
  // This function is called by the bundler to register the manifest.
  serverManifest = manifest;
}

export function decodeReply<T>(body: string | FormData): Thenable<T> {
  if (typeof body === 'string') {
    const form = new FormData();
    form.append('0', body);
    body = form;
  }
  const response = createResponse(serverManifest, '', body);
  const root = getRoot<T>(response);
  close(response);
  return root;
}

export function decodeAction<T>(body: FormData): Promise<() => T> | null {
  return decodeActionImpl(body, serverManifest);
}

export function decodeFormState<S>(
  actionResult: S,
  body: FormData,
): Promise<ReactFormState<S, ServerReferenceId> | null> {
  return decodeFormStateImpl(actionResult, body, serverManifest);
}

export function loadServerAction<F: (...any[]) => any>(id: string): Promise<F> {
  const reference = resolveServerReference<any>(serverManifest, id);
  return Promise.resolve(reference)
    .then(() => preloadModule(reference))
    .then(() => {
      const fn = requireModule(reference);
      if (typeof fn !== 'function') {
        throw new Error('Server actions must be functions');
      }
      return fn;
    });
}