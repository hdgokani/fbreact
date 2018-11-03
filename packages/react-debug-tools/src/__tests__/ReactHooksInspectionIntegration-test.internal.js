/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment node
 */

'use strict';

let React;
let ReactTestRenderer;
let ReactDebugTools;

describe('ReactHooksInspectionIntergration', () => {
  beforeEach(() => {
    jest.resetModules();
    let ReactFeatureFlags = require('shared/ReactFeatureFlags');
    // TODO: Switch this test to non-internal once the flag is on by default.
    ReactFeatureFlags.enableHooks = true;
    React = require('react');
    ReactTestRenderer = require('react-test-renderer');
    ReactDebugTools = require('react-debug-tools');
  });

  it('should inspect the current state of useState hooks', () => {
    let useState = React.useState;
    function Foo(props) {
      let [state1, setState1] = useState('hello');
      let [state2, setState2] = useState('world');
      return (
        <div onMouseDown={setState1} onMouseUp={setState2}>
          {state1} {state2}
        </div>
      );
    }
    let renderer = ReactTestRenderer.create(<Foo prop="prop" />);

    let childFiber = renderer.root.findByType(Foo)._currentFiber();
    let tree = ReactDebugTools.inspectHooksOfFiber(childFiber);
    expect(tree).toEqual([
      {name: 'State', value: 'hello', subHooks: []},
      {name: 'State', value: 'world', subHooks: []},
    ]);

    let {
      onMouseDown: setStateA,
      onMouseUp: setStateB,
    } = renderer.root.findByType('div').props;

    setStateA('Hi');

    childFiber = renderer.root.findByType(Foo)._currentFiber();
    tree = ReactDebugTools.inspectHooksOfFiber(childFiber);

    expect(tree).toEqual([
      {name: 'State', value: 'Hi', subHooks: []},
      {name: 'State', value: 'world', subHooks: []},
    ]);

    setStateB('world!');

    childFiber = renderer.root.findByType(Foo)._currentFiber();
    tree = ReactDebugTools.inspectHooksOfFiber(childFiber);

    expect(tree).toEqual([
      {name: 'State', value: 'Hi', subHooks: []},
      {name: 'State', value: 'world!', subHooks: []},
    ]);
  });

  it('should inspect the current state of all stateful hooks', () => {
    let outsideRef = React.createRef();
    function effect() {}
    function Foo(props) {
      let [state1, setState] = React.useState('a');
      let [state2, dispatch] = React.useReducer((s, a) => a.value, 'b');
      let ref = React.useRef('c');

      React.useMutationEffect(effect);
      React.useLayoutEffect(effect);
      React.useEffect(effect);

      React.useImperativeMethods(
        outsideRef,
        () => {
          // Return a function so that jest treats them as non-equal.
          return function Instance() {};
        },
        [],
      );

      React.useMemo(() => state1 + state2, [state1]);

      function update() {
        setState('A');
        dispatch({value: 'B'});
        ref.current = 'C';
      }
      let memoizedUpdate = React.useCallback(update, []);
      return (
        <div onClick={memoizedUpdate}>
          {state1} {state2}
        </div>
      );
    }
    let renderer = ReactTestRenderer.create(<Foo prop="prop" />);

    let childFiber = renderer.root.findByType(Foo)._currentFiber();

    let {onClick: updateStates} = renderer.root.findByType('div').props;

    let tree = ReactDebugTools.inspectHooksOfFiber(childFiber);
    expect(tree).toEqual([
      {name: 'State', value: 'a', subHooks: []},
      {name: 'Reducer', value: 'b', subHooks: []},
      {name: 'Ref', value: 'c', subHooks: []},
      {name: 'MutationEffect', value: effect, subHooks: []},
      {name: 'LayoutEffect', value: effect, subHooks: []},
      {name: 'Effect', value: effect, subHooks: []},
      {name: 'ImperativeMethods', value: outsideRef.current, subHooks: []},
      {name: 'Memo', value: 'ab', subHooks: []},
      {name: 'Callback', value: updateStates, subHooks: []},
    ]);

    updateStates();

    childFiber = renderer.root.findByType(Foo)._currentFiber();
    tree = ReactDebugTools.inspectHooksOfFiber(childFiber);

    expect(tree).toEqual([
      {name: 'State', value: 'A', subHooks: []},
      {name: 'Reducer', value: 'B', subHooks: []},
      {name: 'Ref', value: 'C', subHooks: []},
      {name: 'MutationEffect', value: effect, subHooks: []},
      {name: 'LayoutEffect', value: effect, subHooks: []},
      {name: 'Effect', value: effect, subHooks: []},
      {name: 'ImperativeMethods', value: outsideRef.current, subHooks: []},
      {name: 'Memo', value: 'Ab', subHooks: []},
      {name: 'Callback', value: updateStates, subHooks: []},
    ]);
  });
});
