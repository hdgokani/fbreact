/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

let React;
let ReactDOM;
let ReactDOMServer;
let ReactFeatureFlags;
let Suspense;
let act;

describe('ReactDOMServerPartialHydration', () => {
  beforeEach(() => {
    jest.resetModuleRegistry();

    ReactFeatureFlags = require('shared/ReactFeatureFlags');
    ReactFeatureFlags.enableSuspenseServerRenderer = true;

    React = require('react');
    ReactDOM = require('react-dom');
    act = require('react-dom/test-utils').act;
    ReactDOMServer = require('react-dom/server');
    Suspense = React.Suspense;
  });

  it('hydrates a parent even if a child Suspense boundary is blocked', async () => {
    let suspend = false;
    let resolve;
    let promise = new Promise(resolvePromise => (resolve = resolvePromise));
    let ref = React.createRef();

    function Child() {
      if (suspend) {
        throw promise;
      } else {
        return 'Hello';
      }
    }

    function App() {
      return (
        <div>
          <Suspense fallback="Loading...">
            <span ref={ref}>
              <Child />
            </span>
          </Suspense>
        </div>
      );
    }

    // First we render the final HTML. With the streaming renderer
    // this may have suspense points on the server but here we want
    // to test the completed HTML. Don't suspend on the server.
    suspend = false;
    let finalHTML = ReactDOMServer.renderToString(<App />);

    let container = document.createElement('div');
    container.innerHTML = finalHTML;

    let span = container.getElementsByTagName('span')[0];

    // On the client we don't have all data yet but we want to start
    // hydrating anyway.
    suspend = true;
    let root = ReactDOM.unstable_createRoot(container, {hydrate: true});
    root.render(<App />);
    jest.runAllTimers();

    expect(ref.current).toBe(null);

    // Resolving the promise should continue hydration
    suspend = false;
    resolve();
    await promise;
    jest.runAllTimers();

    // We should now have hydrated with a ref on the existing span.
    expect(ref.current).toBe(span);
  });

  it('can insert siblings before the dehydrated boundary', () => {
    let suspend = false;
    let promise = new Promise(() => {});
    let showSibling;

    function Child() {
      if (suspend) {
        throw promise;
      } else {
        return 'Second';
      }
    }

    function Sibling() {
      let [visible, setVisibilty] = React.useState(false);
      showSibling = () => setVisibilty(true);
      if (visible) {
        return <div>First</div>;
      }
      return null;
    }

    function App() {
      return (
        <div>
          <Sibling />
          <Suspense fallback="Loading...">
            <span>
              <Child />
            </span>
          </Suspense>
        </div>
      );
    }

    suspend = false;
    let finalHTML = ReactDOMServer.renderToString(<App />);
    let container = document.createElement('div');
    container.innerHTML = finalHTML;

    // On the client we don't have all data yet but we want to start
    // hydrating anyway.
    suspend = true;

    act(() => {
      ReactDOM.hydrate(<App />, container);
    });

    expect(container.firstChild.firstChild.tagName).not.toBe('DIV');

    // In this state, we can still update the siblings.
    act(() => showSibling());

    expect(container.firstChild.firstChild.tagName).toBe('DIV');
    expect(container.firstChild.firstChild.textContent).toBe('First');
  });

  it('can delete the dehydrated boundary before it is hydrated', () => {
    let suspend = false;
    let promise = new Promise(() => {});
    let hideMiddle;

    function Child() {
      if (suspend) {
        throw promise;
      } else {
        return (
          <React.Fragment>
            <div>Middle</div>
            Some text
          </React.Fragment>
        );
      }
    }

    function App() {
      let [visible, setVisibilty] = React.useState(true);
      hideMiddle = () => setVisibilty(false);

      return (
        <div>
          <div>Before</div>
          {visible ? (
            <Suspense fallback="Loading...">
              <Child />
            </Suspense>
          ) : null}
          <div>After</div>
        </div>
      );
    }

    suspend = false;
    let finalHTML = ReactDOMServer.renderToString(<App />);
    let container = document.createElement('div');
    container.innerHTML = finalHTML;

    // On the client we don't have all data yet but we want to start
    // hydrating anyway.
    suspend = true;
    act(() => {
      ReactDOM.hydrate(<App />, container);
    });

    expect(container.firstChild.children[1].textContent).toBe('Middle');

    // In this state, we can still delete the boundary.
    act(() => hideMiddle());

    expect(container.firstChild.children[1].textContent).toBe('After');
  });

  it('regenerates the content if props have changed before hydration completes', async () => {
    let suspend = false;
    let resolve;
    let promise = new Promise(resolvePromise => (resolve = resolvePromise));
    let ref = React.createRef();

    function Child({text}) {
      if (suspend) {
        throw promise;
      } else {
        return text;
      }
    }

    function App({text, className}) {
      return (
        <div>
          <Suspense fallback="Loading...">
            <span ref={ref} className={className}>
              <Child text={text} />
            </span>
          </Suspense>
        </div>
      );
    }

    suspend = false;
    let finalHTML = ReactDOMServer.renderToString(
      <App text="Hello" className="hello" />,
    );
    let container = document.createElement('div');
    container.innerHTML = finalHTML;

    let span = container.getElementsByTagName('span')[0];

    // On the client we don't have all data yet but we want to start
    // hydrating anyway.
    suspend = true;
    let root = ReactDOM.unstable_createRoot(container, {hydrate: true});
    root.render(<App text="Hello" className="hello" />);
    jest.runAllTimers();

    expect(ref.current).toBe(null);
    expect(span.textContent).toBe('Hello');

    // Render an update, which will be higher or the same priority as pinging the hydration.
    root.render(<App text="Hi" className="hi" />);

    // At the same time, resolving the promise so that rendering can complete.
    suspend = false;
    resolve();
    await promise;

    // Flushing both of these in the same batch won't be able to hydrate so we'll
    // probably throw away the existing subtree.
    jest.runAllTimers();

    // Pick up the new span. In an ideal implementation this might be the same span
    // but patched up. At the time of writing, this will be a new span though.
    span = container.getElementsByTagName('span')[0];

    // We should now have fully rendered with a ref on the new span.
    expect(ref.current).toBe(span);
    expect(span.textContent).toBe('Hi');
    // If we ended up hydrating the existing content, we won't have properly
    // patched up the tree, which might mean we haven't patched the className.
    expect(span.className).toBe('hi');
  });

  it('shows the fallback if props have changed before hydration completes and is still suspended', async () => {
    let suspend = false;
    let resolve;
    let promise = new Promise(resolvePromise => (resolve = resolvePromise));
    let ref = React.createRef();

    function Child({text}) {
      if (suspend) {
        throw promise;
      } else {
        return text;
      }
    }

    function App({text, className}) {
      return (
        <div>
          <Suspense fallback="Loading...">
            <span ref={ref} className={className}>
              <Child text={text} />
            </span>
          </Suspense>
        </div>
      );
    }

    suspend = false;
    let finalHTML = ReactDOMServer.renderToString(
      <App text="Hello" className="hello" />,
    );
    let container = document.createElement('div');
    container.innerHTML = finalHTML;

    // On the client we don't have all data yet but we want to start
    // hydrating anyway.
    suspend = true;
    let root = ReactDOM.unstable_createRoot(container, {hydrate: true});
    root.render(<App text="Hello" className="hello" />);
    jest.runAllTimers();

    expect(ref.current).toBe(null);

    // Render an update, but leave it still suspended.
    root.render(<App text="Hi" className="hi" />);

    // Flushing now should delete the existing content and show the fallback.
    jest.runAllTimers();

    expect(container.getElementsByTagName('span').length).toBe(0);
    expect(ref.current).toBe(null);
    expect(container.textContent).toBe('Loading...');

    // Unsuspending shows the content.
    suspend = false;
    resolve();
    await promise;

    jest.runAllTimers();

    let span = container.getElementsByTagName('span')[0];
    expect(span.textContent).toBe('Hi');
    expect(span.className).toBe('hi');
    expect(ref.current).toBe(span);
    expect(container.textContent).toBe('Hi');
  });

  it('shows the fallback of the outer if fallback is missing', async () => {
    // This is the same exact test as above but with a nested Suspense without a fallback.
    // This should be a noop.
    let suspend = false;
    let resolve;
    let promise = new Promise(resolvePromise => (resolve = resolvePromise));
    let ref = React.createRef();

    function Child({text}) {
      if (suspend) {
        throw promise;
      } else {
        return text;
      }
    }

    function App({text, className}) {
      return (
        <div>
          <Suspense fallback="Loading...">
            <span ref={ref} className={className}>
              <Suspense maxDuration={200}>
                <Child text={text} />
              </Suspense>
            </span>
          </Suspense>
        </div>
      );
    }

    suspend = false;
    let finalHTML = ReactDOMServer.renderToString(
      <App text="Hello" className="hello" />,
    );
    let container = document.createElement('div');
    container.innerHTML = finalHTML;

    // On the client we don't have all data yet but we want to start
    // hydrating anyway.
    suspend = true;
    let root = ReactDOM.unstable_createRoot(container, {hydrate: true});
    root.render(<App text="Hello" className="hello" />);
    jest.runAllTimers();

    expect(ref.current).toBe(null);

    // Render an update, but leave it still suspended.
    root.render(<App text="Hi" className="hi" />);

    // Flushing now should delete the existing content and show the fallback.
    jest.runAllTimers();

    expect(container.getElementsByTagName('span').length).toBe(0);
    expect(ref.current).toBe(null);
    expect(container.textContent).toBe('Loading...');

    // Unsuspending shows the content.
    suspend = false;
    resolve();
    await promise;

    jest.runAllTimers();

    let span = container.getElementsByTagName('span')[0];
    expect(span.textContent).toBe('Hi');
    expect(span.className).toBe('hi');
    expect(ref.current).toBe(span);
    expect(container.textContent).toBe('Hi');
  });

  it('clears nested suspense boundaries if they did not hydrate yet', async () => {
    let suspend = false;
    let resolve;
    let promise = new Promise(resolvePromise => (resolve = resolvePromise));
    let ref = React.createRef();

    function Child({text}) {
      if (suspend) {
        throw promise;
      } else {
        return text;
      }
    }

    function App({text, className}) {
      return (
        <div>
          <Suspense fallback="Loading...">
            <Suspense fallback="Never happens">
              <Child text={text} />
            </Suspense>{' '}
            <span ref={ref} className={className}>
              <Child text={text} />
            </span>
          </Suspense>
        </div>
      );
    }

    suspend = false;
    let finalHTML = ReactDOMServer.renderToString(
      <App text="Hello" className="hello" />,
    );
    let container = document.createElement('div');
    container.innerHTML = finalHTML;

    // On the client we don't have all data yet but we want to start
    // hydrating anyway.
    suspend = true;
    let root = ReactDOM.unstable_createRoot(container, {hydrate: true});
    root.render(<App text="Hello" className="hello" />);
    jest.runAllTimers();

    expect(ref.current).toBe(null);

    // Render an update, but leave it still suspended.
    root.render(<App text="Hi" className="hi" />);

    // Flushing now should delete the existing content and show the fallback.
    jest.runAllTimers();

    expect(container.getElementsByTagName('span').length).toBe(0);
    expect(ref.current).toBe(null);
    expect(container.textContent).toBe('Loading...');

    // Unsuspending shows the content.
    suspend = false;
    resolve();
    await promise;

    jest.runAllTimers();

    let span = container.getElementsByTagName('span')[0];
    expect(span.textContent).toBe('Hi');
    expect(span.className).toBe('hi');
    expect(ref.current).toBe(span);
    expect(container.textContent).toBe('Hi Hi');
  });

  it('regenerates the content if context has changed before hydration completes', async () => {
    let suspend = false;
    let resolve;
    let promise = new Promise(resolvePromise => (resolve = resolvePromise));
    let ref = React.createRef();
    let Context = React.createContext(null);

    function Child() {
      let {text, className} = React.useContext(Context);
      if (suspend) {
        throw promise;
      } else {
        return (
          <span ref={ref} className={className}>
            {text}
          </span>
        );
      }
    }

    const App = React.memo(function App() {
      return (
        <div>
          <Suspense fallback="Loading...">
            <Child />
          </Suspense>
        </div>
      );
    });

    suspend = false;
    let finalHTML = ReactDOMServer.renderToString(
      <Context.Provider value={{text: 'Hello', className: 'hello'}}>
        <App />
      </Context.Provider>,
    );
    let container = document.createElement('div');
    container.innerHTML = finalHTML;

    let span = container.getElementsByTagName('span')[0];

    // On the client we don't have all data yet but we want to start
    // hydrating anyway.
    suspend = true;
    let root = ReactDOM.unstable_createRoot(container, {hydrate: true});
    root.render(
      <Context.Provider value={{text: 'Hello', className: 'hello'}}>
        <App />
      </Context.Provider>,
    );
    jest.runAllTimers();

    expect(ref.current).toBe(null);
    expect(span.textContent).toBe('Hello');

    // Render an update, which will be higher or the same priority as pinging the hydration.
    root.render(
      <Context.Provider value={{text: 'Hi', className: 'hi'}}>
        <App />
      </Context.Provider>,
    );

    // At the same time, resolving the promise so that rendering can complete.
    suspend = false;
    resolve();
    await promise;

    // Flushing both of these in the same batch won't be able to hydrate so we'll
    // probably throw away the existing subtree.
    jest.runAllTimers();

    // Pick up the new span. In an ideal implementation this might be the same span
    // but patched up. At the time of writing, this will be a new span though.
    span = container.getElementsByTagName('span')[0];

    // We should now have fully rendered with a ref on the new span.
    expect(ref.current).toBe(span);
    expect(span.textContent).toBe('Hi');
    // If we ended up hydrating the existing content, we won't have properly
    // patched up the tree, which might mean we haven't patched the className.
    expect(span.className).toBe('hi');
  });

  it('shows the fallback if context has changed before hydration completes and is still suspended', async () => {
    let suspend = false;
    let resolve;
    let promise = new Promise(resolvePromise => (resolve = resolvePromise));
    let ref = React.createRef();
    let Context = React.createContext(null);

    function Child() {
      let {text, className} = React.useContext(Context);
      if (suspend) {
        throw promise;
      } else {
        return (
          <span ref={ref} className={className}>
            {text}
          </span>
        );
      }
    }

    const App = React.memo(function App() {
      return (
        <div>
          <Suspense fallback="Loading...">
            <Child />
          </Suspense>
        </div>
      );
    });

    suspend = false;
    let finalHTML = ReactDOMServer.renderToString(
      <Context.Provider value={{text: 'Hello', className: 'hello'}}>
        <App />
      </Context.Provider>,
    );
    let container = document.createElement('div');
    container.innerHTML = finalHTML;

    // On the client we don't have all data yet but we want to start
    // hydrating anyway.
    suspend = true;
    let root = ReactDOM.unstable_createRoot(container, {hydrate: true});
    root.render(
      <Context.Provider value={{text: 'Hello', className: 'hello'}}>
        <App />
      </Context.Provider>,
    );
    jest.runAllTimers();

    expect(ref.current).toBe(null);

    // Render an update, but leave it still suspended.
    root.render(
      <Context.Provider value={{text: 'Hi', className: 'hi'}}>
        <App />
      </Context.Provider>,
    );

    // Flushing now should delete the existing content and show the fallback.
    jest.runAllTimers();

    expect(container.getElementsByTagName('span').length).toBe(0);
    expect(ref.current).toBe(null);
    expect(container.textContent).toBe('Loading...');

    // Unsuspending shows the content.
    suspend = false;
    resolve();
    await promise;

    jest.runAllTimers();

    let span = container.getElementsByTagName('span')[0];
    expect(span.textContent).toBe('Hi');
    expect(span.className).toBe('hi');
    expect(ref.current).toBe(span);
    expect(container.textContent).toBe('Hi');
  });

  it('replaces the fallback with client content if it is not rendered by the server', async () => {
    let suspend = false;
    let promise = new Promise(resolvePromise => {});
    let ref = React.createRef();

    function Child() {
      if (suspend) {
        throw promise;
      } else {
        return 'Hello';
      }
    }

    function App() {
      return (
        <div>
          <Suspense fallback="Loading...">
            <span ref={ref}>
              <Child />
            </span>
          </Suspense>
        </div>
      );
    }

    // First we render the final HTML. With the streaming renderer
    // this may have suspense points on the server but here we want
    // to test the completed HTML. Don't suspend on the server.
    suspend = true;
    let finalHTML = ReactDOMServer.renderToString(<App />);
    let container = document.createElement('div');
    container.innerHTML = finalHTML;

    expect(container.getElementsByTagName('span').length).toBe(0);

    // On the client we have the data available quickly for some reason.
    suspend = false;
    let root = ReactDOM.unstable_createRoot(container, {hydrate: true});
    root.render(<App />);
    expect(() => jest.runAllTimers()).toWarnDev(
      [
        'Warning: Did not expect server HTML to contain the text node "Loading..." in <div>.',
      ],
      {withoutStack: true},
    );

    expect(container.textContent).toBe('Hello');

    let span = container.getElementsByTagName('span')[0];
    expect(ref.current).toBe(span);
  });
});
