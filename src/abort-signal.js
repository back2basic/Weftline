import {types} from 'node:util';

// Node's signal internals and process intrinsics are trusted, not a sandbox.
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const reason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get;
const add = EventTarget.prototype.addEventListener;
const remove = EventTarget.prototype.removeEventListener;

// Do not give the caller's instance to APIs that read overridable properties.
export function bridgeSignal(source) {
  checkSignal(source);
  if (source === undefined) return {signal:undefined, dispose() {}};
  const controller = new AbortController();
  const onAbort = () => controller.abort(reason.call(source));
  add.call(source, 'abort', onAbort, {once:true});
  try { if (aborted.call(source)) onAbort(); }
  catch (error) { remove.call(source, 'abort', onAbort); throw error; }
  return {signal:controller.signal, dispose() { remove.call(source, 'abort', onAbort); }};
}

export function checkSignal(signal) {
  if (signal === undefined) return;
  if (types.isProxy(signal)) throw Error('Invalid request');
  let isAborted;
  try { isAborted = aborted.call(signal); } catch { throw Error('Invalid request'); }
  if (isAborted) throw reason.call(signal);
}
