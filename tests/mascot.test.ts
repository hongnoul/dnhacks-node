import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mascotFrame, type EyeFrame } from '../app/lib/mascotFrames.ts';
const frames: EyeFrame[] = ['open','half','closed','left','right','happy','up','down','upLeft','upRight','downLeft','downRight'];
test('mascot emotion frames keep dimensions and all non-eye cells fixed', () => {
  const base=mascotFrame('open').split('\n');
  for(const frame of frames){
    const rows=mascotFrame(frame).split('\n');
    assert.equal(rows.length,23);
    rows.forEach((row,y)=>{
      assert.equal(row.length,40);
      for(let x=0;x<40;x++) if(!(y>=7&&y<15&&((x>=4&&x<16)||(x>=24&&x<36)))) assert.equal(row[x],base[y][x]);
    });
  }
  assert.equal(new Set(frames.map(frame => mascotFrame(frame))).size,12);
});

test('larger eye apertures move as a whole in both axes', () => {
  const measure=(direction:EyeFrame) => {
    const rows=mascotFrame('open',direction).split('\n');
    const points:{x:number;y:number}[]=[];
    for(let y=7;y<15;y++)for(let x=4;x<16;x++)if(rows[y][x]===' ')points.push({x,y});
    return {area:points.length,x:points.reduce((s,p)=>s+p.x,0)/points.length,y:points.reduce((s,p)=>s+p.y,0)/points.length};
  };
  const neutral=measure('open'), right=measure('right'), up=measure('up');
  assert.equal(neutral.area,38); // Original 6x5 mask had only 18 open cells.
  assert.equal(right.area,neutral.area);
  assert.equal(right.x-neutral.x,1);
  assert.equal(up.y-neutral.y,-1);
  assert.notEqual(mascotFrame('closed','left'),mascotFrame('closed','right'));
});
