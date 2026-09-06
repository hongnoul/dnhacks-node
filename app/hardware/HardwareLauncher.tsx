"use client";
import { useRef, useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import styles from './hardware.module.css';
const Viewer = dynamic(() => import('./HardwareViewer'), { ssr: false, loading: () => <p>Loading hardware viewer…</p> });
export default function HardwareLauncher({ desktop = false }: { desktop?: boolean }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  function close() { dialog.current?.close(); setOpen(false); launcher.current?.focus(); }
  return <>
    <button ref={launcher} type="button" className={desktop ? styles.desktopFile : styles.launcher} onClick={() => setOpen(true)} aria-haspopup="dialog">
      {desktop ? <><img src="/hardware-poster.svg" alt="" /><span>skymesh-node.glb</span></> : 'Hardware reference'}
    </button>
    {open && <dialog ref={dialog} className={styles.dialog} aria-labelledby="hardware-window-title" onCancel={event => { event.preventDefault(); close(); }} onClose={() => { setOpen(false); launcher.current?.focus(); }}>
      <header className={styles.titlebar}><span id="hardware-window-title">▧ skymesh-node.glb · Hardware Viewer</span><button type="button" aria-label="Close hardware viewer" onClick={close}>×</button></header>
      <Viewer />
      <footer className={styles.windowFooter}><span>Concept model · Not connected hardware</span><a href="/models/skymesh-node.glb" download>Save GLB ↓</a></footer>
    </dialog>}
  </>;
}
