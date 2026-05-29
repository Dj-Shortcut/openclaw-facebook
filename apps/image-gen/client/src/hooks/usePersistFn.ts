import { useRef } from "react";

type GenericFunction<TArgs extends unknown[] = unknown[], TResult = unknown> = (
  ...args: TArgs
) => TResult;

/**
 * usePersistFn instead of useCallback to reduce cognitive load
 */
export function usePersistFn<TArgs extends unknown[], TResult>(
  fn: GenericFunction<TArgs, TResult>,
): GenericFunction<TArgs, TResult> {
  const fnRef = useRef<GenericFunction<TArgs, TResult>>(fn);
  fnRef.current = fn;

  const persistFnRef = useRef<GenericFunction<TArgs, TResult> | null>(null);

  if (persistFnRef.current === null) {
    persistFnRef.current = (...args: TArgs) => {
      return fnRef.current(...args);
    };
  }

  return persistFnRef.current;
}
