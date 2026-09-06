import HardwareViewer from './HardwareViewer';
import styles from './hardware.module.css';
export const metadata = { title: 'Hardware concept', description: 'Explore the SkyMesh acoustic sensor hardware concept in 3D.' };
export default function HardwarePage() {
  return <main className={styles.page}>
    <nav className={styles.nav}><a href="/">SkyMesh / Hardware</a><a href="/">Try the phone demo ↗</a></nav>
    <header className={styles.header}><p className={styles.eyebrow}>Distributed sensing. Physical form.</p><h1>A small node.<br/><span>A shared sky.</span></h1><p>A proposed acoustic sensor for a distributed detection network. Local processing, radio links, and solar-assisted power in one compact enclosure.</p><span className={styles.badge}>HARDWARE CONCEPT · NOT MANUFACTURING CAD</span></header>
    <HardwareViewer />
    <section className={styles.bridge} aria-labelledby="bridge-title"><div><p className={styles.eyebrow}>From concept to working software</p><h2 id="bridge-title">The node is proposed.<br/>The phone demo is live.</h2><p>Try the sensing and distributed software today using your phone. The demo does not establish hardware performance.</p><a className={styles.download} href="/models/skymesh-node.glb" download>Download concept model (.glb) ↓</a></div><dl><div><dt>Microphone array</dt><dd>Phone microphone in the demo</dd></div><div><dt>Embedded processing</dt><dd>Browser-local ONNX inference today</dd></div><div><dt>Direct radio links</dt><dd>WebSocket relay transport today</dd></div><div><dt>Solar-assisted battery</dt><dd>Phone battery with the screen kept open</dd></div></dl></section>
    <footer className={styles.footer}>Design targets, not verified specifications. Radio range, ingress protection, embedded inference compatibility, and endurance require engineering validation. Exterior visualization based on the supplied SkyMesh concept drawing.</footer>
  </main>;
}
