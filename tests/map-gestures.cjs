const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const cameraSource = source.slice(source.indexOf('const MIN_ZOOM'), source.indexOf('const tip ='));
const clock = { now: 0 };
const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) nodes.set(id, {
    id, attrs: {}, style: {}, textContent: '', disabled: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    classList: { add() {}, remove() {} }
  });
  return nodes.get(id);
}
const handlers = new Map(), capture = new Set();
const map = node('map');
map.attrs.viewBox = '0 0 1000 600';
map.addEventListener = (type, fn) => {
  if (!handlers.has(type)) handlers.set(type, []);
  handlers.get(type).push(fn);
};
map.getScreenCTM = () => ({ inverse() {
  const [x, y, w, h] = map.attrs.viewBox.split(' ').map(Number);
  return { a: w / 1000, b: 0, c: 0, d: h / 600, e: x, f: y };
} });
map.setPointerCapture = id => capture.add(id);
map.hasPointerCapture = id => capture.has(id);
map.releasePointerCapture = id => capture.delete(id);
class DOMPoint {
  constructor(x, y) { this.x = x; this.y = y; }
  matrixTransform(m) { return new DOMPoint(m.a * this.x + m.c * this.y + m.e, m.b * this.x + m.d * this.y + m.f); }
}
const selectedCalls = [];
const context = vm.createContext({
  map, P: { W: 1000, H: 600 }, $: node, DOMPoint,
  performance: { now: () => clock.now },
  setSelected: value => selectedCalls.push(value)
});
vm.runInContext(cameraSource + '\napplyCamera(camera);', context);
const inspect = () => vm.runInContext('({ camera: {...camera}, pointers: [...pointers.keys()], suppressClickUntil, gestureInteracted })', context);
const evalCode = code => vm.runInContext(code, context);
function emit(type, overrides = {}) {
  const e = { pointerId: 1, button: 0, clientX: 400, clientY: 250, target: map,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides };
  for (const fn of handlers.get(type) || []) fn(e);
  return e;
}
const city = { dataset: { city: '杭州' }, closest: selector => selector === '.city' ? city : null };
const childCircle = { closest: selector => selector === '.city' ? city : null };
map.closest = () => null;
const approx = (a,b) => assert.ok(Math.abs(a-b) < 1e-8, `${a} != ${b}`);

// Implicit capture transfers from a circle to the map without ending the pointer.
evalCode('zoomAt(2)');
emit('pointerdown', { target: childCircle });
emit('pointermove', { target: childCircle, clientX: 420 });
assert.equal(inspect().pointers.length, 1);
const beforeLoss = inspect().camera.x;
emit('lostpointercapture', { target: childCircle });
assert.equal(inspect().pointers.length, 1);
emit('pointermove', { clientX: 450 });
assert.notEqual(inspect().camera.x, beforeLoss);
emit('pointerup', { clientX: 450 });
assert.equal(inspect().pointers.length, 0);
console.log('PASS child lostpointercapture bubbles without clearing active drag');

// Pinch becomes a one-finger stationary hold for longer than the old timer.
node('resetView').onclick(); clock.now = 1000;
emit('pointerdown', { pointerId: 1, clientX: 400, clientY: 300, target: childCircle });
emit('pointerdown', { pointerId: 2, clientX: 500, clientY: 300, target: childCircle });
emit('pointermove', { pointerId: 2, clientX: 600, clientY: 300 });
clock.now = 1200;
emit('pointerup', { pointerId: 2, clientX: 600, clientY: 300 });
assert.equal(inspect().pointers.length, 1);
assert.equal(inspect().gestureInteracted, true);
clock.now = 2200;
emit('pointerup', { pointerId: 1, clientX: 400, clientY: 300 });
assert.equal(inspect().pointers.length, 0);
assert.equal(inspect().gestureInteracted, false);
assert.equal(inspect().suppressClickUntil, 2700);
const suppressed = emit('click', { target: childCircle });
assert.equal(suppressed.prevented, true); assert.equal(suppressed.stopped, true);
assert.equal(selectedCalls.length, 0);
clock.now = 2800;
emit('click', { target: childCircle });
assert.deepEqual(selectedCalls, ['杭州']);
console.log('PASS pinch → one-finger hold >500ms → release still suppresses synthetic click; later tap works');

// Buttons, wheel, direct zoom, and large pinch all respect the 6× limit.
node('resetView').onclick();
for (let i=0; i<50; i++) node('zoomIn').onclick();
approx(inspect().camera.w, 1000 / 6);
assert.equal(node('zoomIn').disabled, true); assert.equal(node('zoomLevel').textContent, '600%');
emit('wheel', { deltaY: -99999 }); approx(inspect().camera.w, 1000 / 6);
evalCode('zoomAt(1e9)'); approx(inspect().camera.w, 1000 / 6);
node('resetView').onclick();
clock.now = 3000;
emit('pointerdown', { pointerId: 1, clientX: 400, clientY: 300 });
emit('pointerdown', { pointerId: 2, clientX: 500, clientY: 300 });
emit('pointermove', { pointerId: 2, clientX: 9999, clientY: 300 });
approx(inspect().camera.w, 1000 / 6);
emit('pointerup', { pointerId: 2 }); emit('pointerup', { pointerId: 1 });
for (let i=0; i<50; i++) node('zoomOut').onclick();
approx(inspect().camera.w, 1000); assert.equal(node('zoomOut').disabled, true);
console.log('PASS zoom buttons/wheel/pinch clamp to 1×–6× with correct disabled states');

// True map capture loss and cancellation still clear the pointer.
clock.now = 4000;
emit('pointerdown'); emit('pointermove', { clientX: 440 });
capture.delete(1); emit('lostpointercapture'); assert.equal(inspect().pointers.length, 0);
emit('pointerdown'); emit('pointercancel'); assert.equal(inspect().pointers.length, 0);
console.log('PASS true map capture loss and pointercancel clean up pointers');
console.log('All 4 gesture regression checks passed.');
