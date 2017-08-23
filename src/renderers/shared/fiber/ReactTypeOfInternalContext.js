/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactTypeOfInternalContext
 * @flow
 */

'use strict';

export type TypeOfInternalContext = number;

export const NoContext = 0;
export const AsyncUpdates = 1;
