import { prefersReducedMotion } from 'svelte/motion';

/** Svelte-átmenetek időtartama: ha a rendszer csökkentett mozgást kér, 0 (azonnali). */
export const ms = (duration: number) => (prefersReducedMotion.current ? 0 : duration);
