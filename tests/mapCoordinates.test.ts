import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAP_ANCHOR, roomLatLon, validAnchor } from '../app/lib/mapCoordinates.ts';
const room = {w:12,h:8};
test('room centre maps to display anchor without changing live coordinates', () => {
  assert.deepEqual(roomLatLon(DEFAULT_MAP_ANCHOR,room,6,4),[DEFAULT_MAP_ANCHOR.lat,DEFAULT_MAP_ANCHOR.lon]);
});
test('room east and south axes retain metre scale and orientation', () => {
  const anchor = {lat:45,lon:10};
  const [lat,lon] = roomLatLon(anchor,room,12,8);
  assert(Math.abs((anchor.lat-lat)*111320-4)<1e-6);
  assert(Math.abs((lon-anchor.lon)*111320*Math.cos(Math.PI/4)-6)<1e-6);
});
test('invalid display anchors are rejected before projecting participant positions', () => {
  for (const anchor of [{lat:NaN,lon:0},{lat:90,lon:0},{lat:0,lon:181},{lat:0,lon:Infinity}]) {
    assert.equal(validAnchor(anchor),false);
    assert.throws(() => roomLatLon(anchor,room,0,0),/Invalid map anchor/);
  }
});
