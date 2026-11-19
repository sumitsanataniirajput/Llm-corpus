/* Test-only canvas bridge for the real Chart.js UMD build.
 * jsdom's HTMLCanvasElement has no 2D renderer. @napi-rs/canvas provides a
 * real renderer, while this adapter keeps Chart.js bound to the jsdom canvas
 * element so DOM sizing/listeners remain under test control.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CHART_UMD_URL = new URL('../../node_modules/chart.js/dist/chart.umd.js', import.meta.url);

function canvasSize(element) {
  const width = Number(element.width) || Number(element.clientWidth) || 300;
  const height = Number(element.height) || Number(element.clientHeight) || 150;
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

export function installChartCanvas(window) {
  const { createCanvas } = require('@napi-rs/canvas');
  const contexts = new WeakMap();
  window.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
    if (kind !== '2d') return null;
    if (contexts.has(this)) return contexts.get(this);
    const { width, height } = canvasSize(this);
    const real = createCanvas(width, height).getContext('2d');
    const element = this;
    const context = new Proxy(real, {
      get(target, prop) {
        if (prop === 'canvas') return element;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, prop, value) {
        return Reflect.set(target, prop, value);
      },
    });
    contexts.set(this, context);
    return context;
  };
  if (!Object.getOwnPropertyDescriptor(window.HTMLCanvasElement.prototype, 'clientWidth')) {
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return 300; },
    });
  }
  if (!Object.getOwnPropertyDescriptor(window.HTMLCanvasElement.prototype, 'clientHeight')) {
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientHeight', {
      configurable: true,
      get() { return 150; },
    });
  }
  window.HTMLCanvasElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const { width, height } = canvasSize(this);
    return {
      x: 0, y: 0, left: 0, top: 0, right: width, bottom: height,
      width, height, toJSON() { return {}; },
    };
  };
  if (!window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // Chart.js's DOM platform creates an attach/detach MutationObserver. With a
  // native canvas renderer bridged into jsdom it may receive a non-jsdom
  // Document; ignore that optional observation rather than fire an uncaught
  // exception from the test environment.
  const MutationObserverCtor = window.MutationObserver;
  if (MutationObserverCtor && !MutationObserverCtor.__corpusNodeGuard) {
    const realObserve = MutationObserverCtor.prototype.observe;
    MutationObserverCtor.prototype.observe = function observe(target, options) {
      const isNode = !!(window.Node && target instanceof window.Node);
      if (!isNode) return undefined;
      return realObserve.call(this, target, options);
    };
    MutationObserverCtor.__corpusNodeGuard = true;
  }
  window.devicePixelRatio = 1;
}

export function installRealChartJs(window, fileUrl = CHART_UMD_URL) {
  const url = fileUrl instanceof URL ? fileUrl : new URL(String(fileUrl), import.meta.url);
  const source = fs.readFileSync(url, 'utf8');
  window.eval(source + '\n;window.__CORPUS_TEST_CHART_VERSION = window.Chart && window.Chart.version;');
  if (!window.Chart || !window.__CORPUS_TEST_CHART_VERSION) {
    throw new Error('Real Chart.js UMD did not install window.Chart');
  }
  return window.Chart;
}
