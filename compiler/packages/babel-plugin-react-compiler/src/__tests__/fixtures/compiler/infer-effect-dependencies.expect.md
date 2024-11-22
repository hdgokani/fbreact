
## Input

```javascript
// @inferEffectDependencies
const moduleNonReactive = 0;

function Component({foo, bar}) {
  const localNonreactive = 0;
  const ref = useRef(0);
  const localNonPrimitiveReactive = {
    foo,
  };
  const localNonPrimitiveNonreactive = {};
  useEffect(() => {
    console.log(foo);
    console.log(bar);
    console.log(moduleNonReactive);
    console.log(localNonreactive);
    console.log(globalValue);
    console.log(ref.current);
    console.log(localNonPrimitiveReactive);
    console.log(localNonPrimitiveNonreactive);
  });

  // Optional chains and property accesses
  // TODO: we may be able to save bytes by omitting property accesses if the
  // object of the member expression is already included in the inferred deps
  useEffect(() => {
    console.log(bar?.baz);
    console.log(bar.qux);
  });

  function f() {
    console.log(foo);
  }

  // No inferred dep array, the argument is not a lambda
  useEffect(f);

  // No inserted deps for non-configured calls
  useNotEffect(() => {
    console.log(foo);
  });

  // Inserted deps because of config
  useSpecialEffect(() => {
    console.log(foo);
  }, [foo]);

  // No inserted deps because second array is already provided
  useSpecialEffect(
    () => {
      console.log(foo);
    },
    [foo],
    [foo]
  );
}

```

## Code

```javascript
import { c as _c } from "react/compiler-runtime"; // @inferEffectDependencies
const moduleNonReactive = 0;

function Component(t0) {
  const $ = _c(21);
  const { foo, bar } = t0;

  const ref = useRef(0);
  let t1;
  if ($[0] !== foo) {
    t1 = { foo };
    $[0] = foo;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const localNonPrimitiveReactive = t1;
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = {};
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const localNonPrimitiveNonreactive = t2;
  let t3;
  if ($[3] !== bar || $[4] !== foo || $[5] !== localNonPrimitiveReactive) {
    t3 = () => {
      console.log(foo);
      console.log(bar);
      console.log(moduleNonReactive);
      console.log(0);
      console.log(globalValue);
      console.log(ref.current);
      console.log(localNonPrimitiveReactive);
      console.log(localNonPrimitiveNonreactive);
    };
    $[3] = bar;
    $[4] = foo;
    $[5] = localNonPrimitiveReactive;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  useEffect(t3);
  let t4;
  if ($[7] !== bar.baz || $[8] !== bar.qux) {
    t4 = () => {
      console.log(bar?.baz);
      console.log(bar.qux);
    };
    $[7] = bar.baz;
    $[8] = bar.qux;
    $[9] = t4;
  } else {
    t4 = $[9];
  }
  useEffect(t4);
  let t5;
  if ($[10] !== foo) {
    t5 = function f() {
      console.log(foo);
    };
    $[10] = foo;
    $[11] = t5;
  } else {
    t5 = $[11];
  }
  const f = t5;

  useEffect(f);
  let t6;
  if ($[12] !== foo) {
    t6 = () => {
      console.log(foo);
    };
    $[12] = foo;
    $[13] = t6;
  } else {
    t6 = $[13];
  }
  useNotEffect(t6);
  let t7;
  let t8;
  if ($[14] !== foo) {
    t7 = () => {
      console.log(foo);
    };
    t8 = [foo];
    $[14] = foo;
    $[15] = t7;
    $[16] = t8;
  } else {
    t7 = $[15];
    t8 = $[16];
  }
  useSpecialEffect(t7, t8);
  let t10;
  let t11;
  let t9;
  if ($[17] !== foo) {
    t9 = () => {
      console.log(foo);
    };

    t10 = [foo];
    t11 = [foo];
    $[17] = foo;
    $[18] = t10;
    $[19] = t11;
    $[20] = t9;
  } else {
    t10 = $[18];
    t11 = $[19];
    t9 = $[20];
  }
  useSpecialEffect(t9, t10, t11);
}

```
      
### Eval output
(kind: exception) Fixture not implemented