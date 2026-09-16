/**
 * The SDK's error surface, in one place.
 *
 * @module
 */

export {
  ArcNowError,
  isArcNowError,
  SDK_CODES_THAT_ARE_CONTRACT_ERRORS,
  SDK_ERROR_CODES,
} from "./error.js";
export type { ArcNowErrorCode, ArcNowErrorOptions, SdkErrorCode } from "./error.js";
export { mapError, withMappedErrors } from "./map.js";
export type { WrappedLayer } from "./map.js";
export type { ErrorContext } from "./messages.js";
export {
  decodeRevertData,
  ERROR_REGISTRY,
  ERROR_STRING_SELECTOR,
  errorSignature,
  lookupSelector,
  PANIC_SELECTOR,
  selectorOf,
  WRAPPED_ERROR_SELECTOR,
} from "./registry.js";
export type { DecodedRevert, RegisteredError } from "./registry.js";
