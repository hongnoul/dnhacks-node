import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestVisibleDrone } from '../app/lib/mascotGaze.ts';
const eye={x:500,y:400}, panel={left:300,top:200,right:700,bottom:600}, viewport={left:0,top:0,right:1000,bottom:800};
const drone=(id:string,x:number,y:number)=>({id,box:{left:x-10,top:y-10,right:x+10,bottom:y+10}});
test('nearest visible drone excludes nearer occluded, partially occluded and offscreen candidates',()=>{
  const found=nearestVisibleDrone(eye,[drone('hidden',510,410),drone('partial',705,410),drone('offscreen',-20,400),drone('far',100,400),drone('near',740,400)],panel,viewport);
  assert.deepEqual(found,{id:'near',gaze:'right'});
});
test('no eligible drones returns neutral target',()=>{
  assert.equal(nearestVisibleDrone(eye,[drone('hidden',500,400)],panel,viewport),null);
  assert.equal(nearestVisibleDrone(eye,[],panel,viewport),null);
});
test('gaze covers eight directions',()=>{
  for(const [x,y,gaze] of [[800,400,'right'],[800,700,'downRight'],[500,700,'down'],[200,700,'downLeft'],[200,400,'left'],[200,100,'upLeft'],[500,100,'up'],[800,100,'upRight']] as const)
    assert.equal(nearestVisibleDrone(eye,[drone('one',x,y)],panel,viewport)?.gaze,gaze);
});
