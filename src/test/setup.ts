import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom lacks ResizeObserver, which @tanstack/react-virtual uses to observe
// the scroll container. An inert stub keeps virtualizer logic runnable.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom does not implement matchMedia; the theme hook reads the OS colour
// scheme through it.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// Testing Library auto-cleanup relies on a global afterEach; vitest runs here
// without globals, so register it explicitly (DOM environments only).
if (typeof document !== 'undefined') {
  afterEach(() => {
    cleanup();
  });
}

// jsdom reports 0×0 layout with clientWidth/clientHeight 0; give the grid's
// scroll container a plausible viewport so virtualized row windows actually
// render in component tests. Other elements get a small non-zero size.
if (typeof window !== 'undefined' && typeof HTMLElement !== 'undefined') {
  try {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        return this.classList.contains('grid-scroll') ? 600 : 40;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement): number {
        return this.classList.contains('grid-scroll') ? 1000 : 200;
      },
    });
  } catch {
    // prototype getters not configurable here — bounded-row assertions stay
    // tolerant of whatever the virtualizer manages to render.
  }
}
