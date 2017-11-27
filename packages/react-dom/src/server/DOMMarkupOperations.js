/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  ID_ATTRIBUTE_NAME,
  ROOT_ATTRIBUTE_NAME,
  getPropertyInfo,
  shouldAttributeAcceptBooleanValue,
  shouldSetAttribute,
  isAttributeNameSafe,
} from '../shared/DOMProperty';
import quoteAttributeValueForBrowser from './quoteAttributeValueForBrowser';

// shouldIgnoreValue() is currently duplicated in DOMPropertyOperations.
// TODO: Find a better place for this.
function shouldIgnoreValue(propertyInfo, value) {
  return (
    value == null ||
    (propertyInfo.hasBooleanValue && !value) ||
    (propertyInfo.hasNumericValue && isNaN(value)) ||
    (propertyInfo.hasPositiveNumericValue && value < 1) ||
    (propertyInfo.hasOverloadedBooleanValue && value === false)
  );
}

/**
 * Operations for dealing with DOM properties.
 */

/**
 * Creates markup for the ID property.
 *
 * @param {string} id Unescaped ID.
 * @return {string} Markup string.
 */
export function createMarkupForID(id) {
  return ID_ATTRIBUTE_NAME + '=' + quoteAttributeValueForBrowser(id);
}

export function createMarkupForRoot() {
  return ROOT_ATTRIBUTE_NAME + '=""';
}

/**
 * Creates markup for a property.
 *
 * @param {string} name
 * @param {*} value
 * @return {?string} Markup string, or null if the property was invalid.
 */
export function createMarkupForProperty(name, value) {
  const propertyInfo = getPropertyInfo(name);
  if (propertyInfo) {
    if (shouldIgnoreValue(propertyInfo, value)) {
      return '';
    }
    const attributeName = propertyInfo.attributeName;
    if (
      propertyInfo.hasBooleanValue ||
      (propertyInfo.hasOverloadedBooleanValue && value === true)
    ) {
      return attributeName + '=""';
    } else if (
      typeof value !== 'boolean' ||
      shouldAttributeAcceptBooleanValue(name, false)
    ) {
      return attributeName + '=' + quoteAttributeValueForBrowser(value);
    }
  } else if (shouldSetAttribute(name, value, false)) {
    if (value == null) {
      return '';
    }
    return name + '=' + quoteAttributeValueForBrowser(value);
  }
  return null;
}

/**
 * Creates markup for a custom property.
 *
 * @param {string} name
 * @param {*} value
 * @return {string} Markup string, or empty string if the property was invalid.
 */
export function createMarkupForCustomAttribute(name, value) {
  if (!isAttributeNameSafe(name) || value == null) {
    return '';
  }
  return name + '=' + quoteAttributeValueForBrowser(value);
}
