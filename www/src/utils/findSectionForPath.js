/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
*/

'use strict';

import slugify from './slugify';

/**
 * Helper method to locate the section containing the current URL/path.
 * This method specifically works with the nav_*.yml format.
 */
const findSectionForPath = (pathname, sections) => {
  let activeSection;

  for (let index = 0; index < sections.length; index++) {
    const match = sections[index].items.some(
      item =>
        pathname.includes(slugify(item.id)) ||
        (item.subitems &&
          item.subitems.some(subitem =>
            pathname.includes(slugify(subitem.id)),
          )),
    );
    if (match) {
      activeSection = sections[index];
      break;
    }
  }

  return activeSection;
};

export default findSectionForPath;
