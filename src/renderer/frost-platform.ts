/**
 * The renderer's frosted-glass platform, resolved once and synchronously at module load from the
 * preload bridge (`window.api.platform`) through `toFrostPlatform`, so the first React render of
 * Settings already knows whether the Frosted glass group applies and which variant to show.
 * Components read it through `useFrostPlatform()`; tests inject a value through
 * `FrostPlatformContext.Provider`. `null` means frosted glass does not apply (Windows, or no bridge).
 *
 * Never import `./api` here: it dereferences `window.api` at import and throws under node tests.
 */
import { createContext, useContext } from 'react';
import { toFrostPlatform, type FrostPlatform } from '@shared/frosted-glass';

interface PlatformBridge { readonly api?: { readonly platform?: string } }

export const RUNTIME_FROST_PLATFORM: FrostPlatform | null = toFrostPlatform(
  (globalThis as { window?: PlatformBridge }).window?.api?.platform,
);

export const FrostPlatformContext = createContext<FrostPlatform | null>(RUNTIME_FROST_PLATFORM);

export function useFrostPlatform(): FrostPlatform | null {
  return useContext(FrostPlatformContext);
}
