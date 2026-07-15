// Minimal Svelte-runes shim for the unit runner. The unit suite deliberately
// skips the Svelte vite plugin, so `.svelte.ts` modules that use runes at module
// scope (e.g. a `$state` field initializer) would hit an undefined `$state`.
// These identity/no-op globals let such modules import so their PURE logic and
// data (the shortcut registry) can be exercised. This is a load-time shim, not a
// reactivity implementation - tests here assert plain values, never reactivity.
const g = globalThis as unknown as Record<string, unknown>;
g.$state = (v?: unknown) => v;
(g.$state as { raw: (v?: unknown) => unknown }).raw = (v?: unknown) => v;
(g.$state as { snapshot: (v?: unknown) => unknown }).snapshot = (v?: unknown) => v;
g.$derived = (v?: unknown) => v;
(g.$derived as { by: (fn: () => unknown) => unknown }).by = (fn: () => unknown) => fn();
g.$effect = (_fn?: unknown) => {};
g.$props = () => ({});
