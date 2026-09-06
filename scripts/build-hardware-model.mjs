import * as T from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { writeFile } from 'node:fs/promises';
// GLTFExporter only needs this browser API to encode its binary buffer.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); }); }
};
const root = new T.Group(); root.name = 'SkyMesh concept - not manufacturing CAD';
const metal = new T.MeshStandardMaterial({ color: '#303b47', metalness: .65, roughness: .35 });
const fabric = new T.MeshStandardMaterial({ color: '#d3d9d7', roughness: .95 });
const solar = new T.MeshStandardMaterial({ color: '#103571', metalness: .5, roughness: .25 });
const silver = new T.MeshStandardMaterial({ color: '#708fae', metalness: .65, roughness: .4 });
function mesh(name, geometry, material, x=0,y=0,z=0) {
 const m = new T.Mesh(geometry,material); m.name=name; m.position.set(x,y,z); root.add(m); return m;
}
// Units are metres. Reference dimensions are approximate concept targets.
mesh('Acoustic fabric dome', new T.SphereGeometry(.048,64,32,0,Math.PI*2,0,Math.PI/2),fabric,0,.020,0);
mesh('Solar cap',new T.SphereGeometry(.0487,64,20,0,Math.PI*2,0,.88),solar,0,.020,0);
mesh('Rugged base chassis',new T.CylinderGeometry(.05,.05,.008,64),metal,0,.020,0);
mesh('Sealed underside',new T.CylinderGeometry(.045,.046,.005,64),metal,0,.014,0);
for(let i=0;i<4;i++) {
 const a=i*Math.PI/2;
 const curve=new T.CatmullRomCurve3(Array.from({length:25},(_,j)=>{const t=j/24*Math.PI/2;return new T.Vector3(Math.sin(t)*.0495*Math.cos(a),.020+Math.cos(t)*.0495,Math.sin(t)*.0495*Math.sin(a));}));
 mesh(`Protective rib ${i+1}`,new T.TubeGeometry(curve,32,.0017,8,false),metal);
 const foot=mesh(`Mounting foot ${i+1}`,new T.ConeGeometry(.007,.022,16),metal,Math.cos(a+Math.PI/4)*.038,.006,Math.sin(a+Math.PI/4)*.038); foot.rotation.z=Math.PI;
}
mesh('Antenna collar',new T.CylinderGeometry(.004,.005,.008,24),metal,0,.071,0);
mesh('Radio antenna',new T.CylinderGeometry(.002,.003,.021,24),metal,0,.084,0);
mesh('Antenna tip',new T.SphereGeometry(.002,16,8),metal,0,.0945,0);
// Thin photovoltaic cell seams follow the curved cap.
for (const theta of [.29,.58,.87]) {
 const r=.049*Math.sin(theta), y=.020+.049*Math.cos(theta);
 const ring=mesh('Solar cell seam',new T.TorusGeometry(r,.00018,4,64),silver,0,y,0); ring.rotation.x=Math.PI/2;
}
for(let i=0;i<12;i++) {
 const a=i*Math.PI/6;
 const points=Array.from({length:18},(_,j)=>{const t=.10+j/17*.77;return new T.Vector3(.049*Math.sin(t)*Math.cos(a),.020+.049*Math.cos(t),.049*Math.sin(t)*Math.sin(a));});
 mesh('Solar cell division',new T.TubeGeometry(new T.CatmullRomCurve3(points),20,.00012,4,false),silver);
}
mesh('Sealed service port',new T.BoxGeometry(.009,.003,.004),metal,0,.010,.035);
root.userData={status:'Concept visualization only',reference:'Supplied SkyMesh hardware blueprint',units:'metres',dimensions:'100 mm diameter target. Other proportions illustrative.'};
const result=await new GLTFExporter().parseAsync(root,{binary:true});
await writeFile(new URL('../public/models/skymesh-node.glb',import.meta.url),Buffer.from(result));
console.log(`Hardware GLB: ${result.byteLength} bytes`);
