import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bambooAngleAt, bambooBottomAt, bambooCordX, bambooCordY,
  bambooDropEnd, bambooOffsetAt, bambooRevealAt,
} from "../packages/config/src/effect/rainlit/bamboo-02-motion.ts";

// Pure production kinematics: Node's native TS stripping needs no SDK bridge,
// compositor, module alias loader or live configuration.
const near = (a: number, b: number, tolerance = 1e-7) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test("creep stays local to the mount instead of scaling to window height", () => {
  const small = bambooOffsetAt(104.99, 222.5, 1, bambooDropEnd(222.5, 1));
  const tall = bambooOffsetAt(104.99, 1242.5, 1, bambooDropEnd(1242.5, 1));
  assert.ok(small > 0 && small <= 24);
  assert.ok(tall > 0 && tall <= 24);
  assert.ok(tall < 2 * small);
});

test("fall duration grows with distance; floor contact precedes the girl", () => {
  const short = bambooDropEnd(222.5, 1);
  const tall = bambooDropEnd(1242.5, 1);
  assert.ok(short < tall);
  assert.ok(short > 105 && tall + 0.6 < 110);
  for (const distance of [222.5, 902.5, 1242.5]) {
    const land = bambooDropEnd(distance, 1);
    near(bambooOffsetAt(land, distance, 1, land), distance);
    assert.ok(bambooOffsetAt(land + 0.12, distance, 1, land) < distance - 0.1);
    near(bambooOffsetAt(land + 0.6, distance, 1, land), distance);
    near(bambooOffsetAt(111.2, distance, 1, land), distance);
    assert.ok(bambooOffsetAt(112, distance, 1, land) < distance);
  }
});

test("landing has two visible diminishing hops with floor contact between them", () => {
  for (const scale of [0.5, 1]) {
    const distance = 902.5 * scale;
    const land = bambooDropEnd(distance, scale);
    const clearanceAt = (elapsed: number) => {
      const t = land + elapsed;
      return distance + 44.5 * scale -
        bambooOffsetAt(t, distance, scale, land) -
        bambooBottomAt(bambooAngleAt(t, land), bambooRevealAt(t, land), scale);
    };
    const firstHop = clearanceAt(0.2);
    const secondHop = clearanceAt(0.5);
    assert.ok(firstHop > 18 * scale && firstHop <= 24 * scale);
    assert.ok(secondHop > 3 * scale && secondHop <= 6 * scale);
    assert.ok(secondHop < firstHop / 3);
    for (const contact of [0, 0.4, 0.6, 0.8]) near(clearanceAt(contact), 0);
    for (const contact of [0.4, 0.6]) {
      near(clearanceAt(contact - 1e-7), clearanceAt(contact + 1e-7), 0.001);
    }
  }
});

test("rigid tilt and recoil never drive exposed bamboo through the floor", () => {
  for (const [distance, scale] of [[10, 0.5], [111.75, 0.5], [222.5, 1], [1242.5, 1]]) {
    const land = bambooDropEnd(distance, scale);
    for (const t of [104.7, 105.1, land - 0.001, land, land + 0.09, land + 0.2, land + 0.4, land + 0.5, land + 0.6, 111.2, 112, 114.5, 114.65]) {
      const reveal = bambooRevealAt(t, land);
      const angle = bambooAngleAt(t, land);
      const offset = bambooOffsetAt(t, distance, scale, land);
      const bottom = offset + bambooBottomAt(angle, reveal, scale);
      assert.ok(offset >= 0 && Number.isFinite(offset));
      assert.ok(bottom <= distance + 44.5 * scale + 1e-7, `floor penetration at ${t}`);
    }
  }
});

test("exposure is not normalized descent and stays open during floor recoil", () => {
  const distance = 902.5;
  const land = bambooDropEnd(distance, 1);
  const t = (105 + land) / 2;
  const reveal = bambooRevealAt(t, land);
  assert.ok(Math.abs(reveal - bambooOffsetAt(t, distance, 1, land) / distance) > 0.1);
  near(bambooRevealAt(land + 0.12, land), 1);
  assert.ok(bambooOffsetAt(land + 0.12, distance, 1, land) < distance);
  near(bambooRevealAt(114.3, land), 0);
  assert.ok(bambooOffsetAt(114.3, distance, 1, land) > 0);
});

test("cord bearings follow the rotated bundle, not the fixed upper bindings", () => {
  near(bambooCordX(0, 1, 0, 1), 70.5);
  near(bambooCordX(1, 1, 0, 1), 174.5);
  near(bambooCordY(0, 462.5, 1, 0, 1), 505);
  near(bambooCordY(1, 462.5, 1, 0, 1), 505);
  // Quarter turn is an independent geometry oracle, not an animation pose.
  near(bambooCordX(0, 1, Math.PI / 2, 1), 82.25);
  near(bambooCordY(0, 100, 1, Math.PI / 2, 1), 48.75);
  near(bambooCordY(1, 100, 1, Math.PI / 2, 1), 152.75);
  near(bambooCordY(0, 200, 1, 0, 0.5), 221.25);
});

test("both contacts settle and the loop has no residual movement", () => {
  const land = bambooDropEnd(902.5, 1);
  assert.ok(bambooOffsetAt(114.65, 902.5, 1, land) > 0);
  for (const t of [0, 99.99, 100, 115, 119.999, 120]) {
    near(bambooOffsetAt(t, 902.5, 1, land), 0);
    near(bambooRevealAt(t, land), 0);
    near(bambooAngleAt(t, land), 0);
  }
  for (const boundary of [100, 105, land, land + 0.6, 111.2, 114.5, 115]) {
    const before = bambooOffsetAt(boundary - 1e-7, 902.5, 1, land);
    const after = bambooOffsetAt(boundary + 1e-7, 902.5, 1, land);
    assert.ok(Math.abs(after - before) < 0.01, `position jump at ${boundary}`);
  }
  near(bambooOffsetAt(105.5, 0, 0.1, bambooDropEnd(0, 0.1)), 0);
});
