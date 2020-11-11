/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Request, ReactModel} from 'react-server/src/ReactFlightServer';

import JSResourceReferenceImpl from 'JSResourceReferenceImpl';

export type ModuleReference<T> = JSResourceReferenceImpl<T>;

import type {
  Destination,
  BundlerConfig,
  ModuleMetaData,
} from 'ReactFlightNativeRelayServerIntegration';

import {resolveModelToJSON} from 'react-server/src/ReactFlightServer';

import {
  emitModel,
  emitModule,
  emitError,
  resolveModuleMetaData as resolveModuleMetaDataImpl,
} from 'ReactFlightNativeRelayServerIntegration';

export type {
  Destination,
  BundlerConfig,
  ModuleMetaData,
} from 'ReactFlightNativeRelayServerIntegration';

export function isModuleReference(reference: Object): boolean {
  return reference instanceof JSResourceReferenceImpl;
}

export function resolveModuleMetaData<T>(
  config: BundlerConfig,
  resource: ModuleReference<T>,
): ModuleMetaData {
  return resolveModuleMetaDataImpl(config, resource);
}

type JSONValue =
  | string
  | number
  | boolean
  | null
  | {+[key: string]: JSONValue}
  | Array<JSONValue>;

export type Chunk =
  | {
      type: 'json',
      id: number,
      json: JSONValue,
    }
  | {
      type: 'module',
      id: number,
      json: ModuleMetaData,
    }
  | {
      type: 'error',
      id: number,
      json: {
        message: string,
        stack: string,
        ...
      },
    };

export function processErrorChunk(
  request: Request,
  id: number,
  message: string,
  stack: string,
): Chunk {
  return {
    type: 'error',
    id: id,
    json: {
      message,
      stack,
    },
  };
}

const hasOwnProperty = Object.prototype.hasOwnProperty;

function convertModelToJSON(
  request: Request,
  parent: {+[key: string]: ReactModel} | $ReadOnlyArray<ReactModel>,
  key: string,
  model: ReactModel,
): JSONValue {
  const json = resolveModelToJSON(request, parent, key, model);
  if (typeof json === 'object' && json !== null) {
    if (Array.isArray(json)) {
      const jsonArray: Array<JSONValue> = [];
      for (let i = 0; i < json.length; i++) {
        jsonArray[i] = convertModelToJSON(request, json, '' + i, json[i]);
      }
      return jsonArray;
    } else {
      const jsonObj: {[key: string]: JSONValue} = {};
      for (const nextKey in json) {
        if (hasOwnProperty.call(json, nextKey)) {
          jsonObj[nextKey] = convertModelToJSON(
            request,
            json,
            nextKey,
            json[nextKey],
          );
        }
      }
      return jsonObj;
    }
  }
  return json;
}

export function processModelChunk(
  request: Request,
  id: number,
  model: ReactModel,
): Chunk {
  const json = convertModelToJSON(request, {}, '', model);
  return {
    type: 'json',
    id: id,
    json: json,
  };
}

export function processModuleChunk(
  request: Request,
  id: number,
  moduleMetaData: ModuleMetaData,
): Chunk {
  // The moduleMetaData is already a JSON serializable value.
  return {
    type: 'module',
    id: id,
    json: moduleMetaData,
  };
}

export function scheduleWork(callback: () => void) {
  callback();
}

export function flushBuffered(destination: Destination) {}

export function beginWriting(destination: Destination) {}

export function writeChunk(destination: Destination, chunk: Chunk): boolean {
  if (chunk.type === 'json') {
    emitModel(destination, chunk.id, chunk.json);
  } else if (chunk.type === 'module') {
    emitModule(destination, chunk.id, chunk.json);
  } else {
    emitError(destination, chunk.id, chunk.json.message, chunk.json.stack);
  }
  return true;
}

export function completeWriting(destination: Destination) {}

export {close} from 'ReactFlightNativeRelayServerIntegration';
