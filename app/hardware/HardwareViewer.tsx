"use client";
import { useEffect, useRef, useState } from 'react';
import styles from './hardware.module.css';
const parts = [
  { title: 'Acoustic array', text: 'Four proposed MEMS microphones behind an acoustically transparent band. The phone demo uses your phone’s microphone instead.', view: [1, .45, 1] },
  { title: 'Solar-assisted power', text: 'A curved photovoltaic cap and internal battery are design targets. Endurance depends on the measured power budget and available sunlight.', view: [.6, 1.8, .6] },
  { title: 'Radio antenna', text: 'Proposed LoRa peer links. Today’s browser demonstration exchanges messages through a WebSocket relay, not a radio mesh.', view: [.7, .8, 1] },
  { title: 'Rugged enclosure', text: 'Protective ribs, four mounting feet, and a sealed service port. Weather resistance and dimensions require engineering validation.', view: [1, -.5, 1] },
];
export default function HardwareViewer() {
  const host = useRef<HTMLDivElement>(null);
  const controls = useRef<(index: number) => void>(() => {});
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState('Loading 3D concept…');
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      try {
        const [T, { GLTFLoader }, { OrbitControls }] = await Promise.all([
          import('three'), import('three/addons/loaders/GLTFLoader.js'), import('three/addons/controls/OrbitControls.js'),
        ]);
        if (disposed || !host.current) return;
        const container = host.current;
        const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setClearColor(0x000000, 0);
        renderer.domElement.setAttribute('aria-label', 'Interactive SkyMesh hardware concept. Use component buttons to change viewpoint, or drag to rotate and scroll to zoom.');
        renderer.domElement.setAttribute('role', 'img');
        container.appendChild(renderer.domElement);
        const scene = new T.Scene();
        const camera = new T.PerspectiveCamera(35, 1, .001, 10);
        const orbit = new OrbitControls(camera, renderer.domElement);
        orbit.target.set(0,.045,0); orbit.enablePan=false; orbit.minDistance=.13; orbit.maxDistance=.45;
        const render = () => renderer.render(scene,camera);
        const view = (index: number) => {
          const v = parts[index]?.view ?? [1,.6,1];
          camera.position.set(v[0],v[1],v[2]).normalize().multiplyScalar(.23).add(orbit.target);
          orbit.update(); render();
        };
        controls.current=view;
        scene.add(new T.HemisphereLight(0xddefff,0x52687c,3));
        const light = new T.DirectionalLight(0xffffff,4); light.position.set(1,2,2); scene.add(light);
        const rim = new T.DirectionalLight(0x56bbff,3); rim.position.set(-1,.5,-1); scene.add(rim);
        const observer = new ResizeObserver(() => {
          const {width,height}=container.getBoundingClientRect();
          if (!width || !height) return;
          camera.aspect=width/height;camera.updateProjectionMatrix();renderer.setSize(width,height);render();
        });
        observer.observe(container); orbit.addEventListener('change',render);
        const lost = (event: Event) => { event.preventDefault(); setStatus('3D unavailable. Component descriptions and the downloadable model are still available.'); };
        renderer.domElement.addEventListener('webglcontextlost',lost);
        const disposeScene = () => scene.traverse(object => {
          if (object instanceof T.Mesh) {
            object.geometry.dispose();
            const materials=Array.isArray(object.material)?object.material:[object.material];
            materials.forEach(material=>material.dispose());
          }
        });
        cleanup = () => { observer.disconnect();orbit.dispose();disposeScene();renderer.dispose();renderer.domElement.remove();controls.current=()=>{}; };
        view(0);
        const gltf = await new GLTFLoader().loadAsync('/models/skymesh-node.glb');
        scene.add(gltf.scene);
        if (disposed) { disposeScene(); return; }
        render();setStatus('');
      } catch {
        cleanup();
        if (!disposed) setStatus('3D unavailable. Component descriptions and the downloadable model are still available.');
      }
    })();
    return () => { disposed=true;cleanup(); };
  }, []);
  return <section aria-label="Hardware explorer" className={styles.explorer}>
    <div className={styles.viewport}>
      <span className={styles.index}>SM-01 / CONCEPT STUDY</span>
      <div ref={host} className={styles.canvas} />
      {status && <div className={styles.fallback}><img src="/hardware-poster.svg" alt="Illustration of the proposed dome-shaped SkyMesh acoustic sensor with solar cap, antenna, and mounting feet" /><p role="status">{status}</p></div>}
      <span className={styles.dimension}>Ø 100 mm target · proportions illustrative</span>
    </div>
    <div className={styles.inspector}>
      <p className={styles.eyebrow}>Explore the node</p>
      <div className={styles.tabs} role="group" aria-label="Component viewpoints">
        {parts.map((part,i)=><button key={part.title} type="button" aria-pressed={selected===i} onClick={()=>{setSelected(i);controls.current(i);}}><span>0{i+1}</span>{part.title}</button>)}
      </div>
      <p className={styles.description} aria-live="polite">{parts[selected].text}</p>
      <p className={styles.hint}>Drag to orbit · Scroll or pinch to zoom<br/>Component buttons also change the viewpoint.</p>
      <button type="button" className={styles.reset} onClick={()=>{setSelected(0);controls.current(0);}}>Reset view</button>
    </div>
  </section>;
}
