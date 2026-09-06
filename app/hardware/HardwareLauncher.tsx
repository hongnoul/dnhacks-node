"use client";
import { useRef, useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useDesktopDrag } from '../lib/useDesktopDrag';
import desktopStyles from '../lib/SensorDesktop.module.css';
import styles from './hardware.module.css';
const Viewer = dynamic(() => import('./HardwareViewer'), { ssr: false, loading: () => <p>Loading hardware viewer…</p> });
export default function HardwareLauncher({ desktop = false }: { desktop?: boolean }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const iconDrag = useDesktopDrag<HTMLButtonElement>();
  const launcher = iconDrag.ref;
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  function close() { dialog.current?.close(); setOpen(false); launcher.current?.focus(); }
  return <>
    <button ref={launcher} style={desktop ? iconDrag.style : undefined} {...(desktop ? iconDrag.handlers : {})} type="button" className={desktop ? `${desktopStyles.videoFile} ${desktopStyles.hardwareFile}` : styles.launcher} onClick={() => setOpen(true)} aria-haspopup="dialog">
      {desktop ? <><span className={`${desktopStyles.videoImage} ${desktopStyles.hardwareImage}`} aria-hidden="true"><svg viewBox="0 0 64 56" fill="none" shapeRendering="crispEdges"><path d="M32 3 59 17v25L32 55 5 42V17Z" fill="#eee" stroke="#171717" strokeWidth="2"/><path d="m5 17 27 14 27-14M32 31v24M18 10l28 14M18 24l28-14" stroke="#171717" strokeWidth="2"/></svg><small>GLB</small></span><span className={desktopStyles.fileName}>skymesh-node.glb</span></> : 'Hardware reference'}
    </button>
    {open && <dialog ref={dialog} className={styles.dialog} aria-labelledby="hardware-window-title" onCancel={event => { event.preventDefault(); close(); }} onClose={() => { setOpen(false); launcher.current?.focus(); }}>
      <header className={styles.titlebar}><span id="hardware-window-title">▧ skymesh-node.glb · Hardware Viewer</span><button type="button" aria-label="Close hardware viewer" onClick={close}>×</button></header>
      <Viewer />
      <footer className={styles.windowFooter}><span>Concept model · Not connected hardware</span><a href="/models/skymesh-node.glb" download>Save GLB ↓</a></footer>
    </dialog>}
  </>;
}
