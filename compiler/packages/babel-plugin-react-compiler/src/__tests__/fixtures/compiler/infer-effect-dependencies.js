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
<<<<<<< HEAD
=======

  // No inserted deps for non-configured calls
  useNotEffect(() => {
    console.log(foo);
  });

  // Inserted deps because of configuration
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
>>>>>>> 1cd3d66b58 ([compiler] Make required args number configurable)
}
