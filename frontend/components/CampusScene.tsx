'use client';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows } from '@react-three/drei/core/ContactShadows';
import { OrbitControls } from '@react-three/drei/core/OrbitControls';
import { Text } from '@react-three/drei/core/Text';
import { useRef, useState } from 'react';
import * as THREE from 'three';
import { useRouter } from 'next/navigation';
import { RotateCcw, Leaf, LoaderCircle } from 'lucide-react';
import { BIN_INFO, type BinId } from '@/lib/types';
import { useBackendStatus } from './useBackendStatus';

function Tree({ position, scale=1 }: {position:[number,number,number];scale?:number}) { return <group position={position} scale={scale}><mesh castShadow position={[0,.23,0]}><cylinderGeometry args={[.055,.075,.46,7]}/><meshStandardMaterial color="#8d765b"/></mesh><mesh castShadow position={[0,.62,0]}><coneGeometry args={[.3,.68,7]}/><meshStandardMaterial color="#58866b" roughness={.9}/></mesh><mesh castShadow position={[0,.91,0]}><coneGeometry args={[.21,.45,7]}/><meshStandardMaterial color="#79a17b" roughness={.9}/></mesh></group>; }
function Building({x,z,w,d,h,color='#ecebe4',roof='#d6d5cd'}:{x:number;z:number;w:number;d:number;h:number;color?:string;roof?:string}) {
 return <group position={[x,0,z]}><mesh castShadow receiveShadow position={[0,h/2,0]}><boxGeometry args={[w,h,d]}/><meshStandardMaterial color={color} roughness={.82}/></mesh><mesh castShadow position={[0,h+.025,0]}><boxGeometry args={[w+.08,.06,d+.08]}/><meshStandardMaterial color={roof}/></mesh>{Array.from({length:Math.max(2,Math.floor(w/.38))},(_,i)=><mesh key={i} position={[-w/2+.2+i*(w-.4)/Math.max(1,Math.floor(w/.38)-1),h*.55,d/2+.006]}><boxGeometry args={[.12,.22,.02]}/><meshStandardMaterial color="#91b5b1" emissive="#334e4a"/></mesh>)}</group>
}
function BinMarker({id,position,onPick}:{id:BinId;position:[number,number,number];onPick:(id:BinId)=>void}) {
 const [hover,setHover]=useState(false); const ref=useRef<THREE.Group>(null); const info=BIN_INFO[id];
 useFrame((state)=>{ if(ref.current) ref.current.position.y=position[1]+.08+Math.sin(state.clock.elapsedTime*2.2+(id==='bin-02'?1:0))*.07; });
 return <group ref={ref} position={position} onPointerOver={(e)=>{e.stopPropagation();setHover(true);document.body.style.cursor='pointer';}} onPointerOut={()=>{setHover(false);document.body.style.cursor='auto';}} onClick={(e)=>{e.stopPropagation();onPick(id);}}>
  <mesh position={[0,.18,0]} castShadow><cylinderGeometry args={[.14,.17,.34,8]}/><meshStandardMaterial color={hover?'#f4fff7':info.accent} metalness={.24} roughness={.42}/></mesh>
  <mesh position={[0,.38,0]}><cylinderGeometry args={[.16,.16,.055,8]}/><meshStandardMaterial color="#183a34"/></mesh>
  <mesh position={[0,.23,.151]}><planeGeometry args={[.2,.2]}/><meshBasicMaterial color="#e8fff2" transparent opacity={.94}/></mesh>
  <Text position={[0,.23,.165]} fontSize={.14} color="#167951" anchorX="center" anchorY="middle">♻</Text>
  <mesh position={[0,.53,0]}><sphereGeometry args={[.055,16,12]}/><meshBasicMaterial color={info.color}/></mesh>
  <mesh position={[0,.02,0]}><circleGeometry args={[hover?.34:.24,24]}/><meshBasicMaterial color={info.color} transparent opacity={hover?.28:.13}/></mesh>
  <Text position={[0,.69,0]} fontSize={.075} color="#244237" anchorX="center" anchorY="middle" outlineWidth={.007} outlineColor="#eff6ed">{info.name}</Text>
  {hover&&<group position={[0,.78,0]}><mesh><planeGeometry args={[1.55,.4]}/><meshBasicMaterial color="#10241f" transparent opacity={.92}/></mesh><mesh position={[-.59,.065,.002]}><planeGeometry args={[.025,.16]}/><meshBasicMaterial color={info.color}/></mesh><Text position={[0,.055,.006]} fontSize={.095} color="white" anchorX="center" anchorY="middle">{info.name}</Text><Text position={[0,-.09,.006]} fontSize={.062} color="#b8ccc2" anchorX="center" anchorY="middle">{info.location}</Text></group>}
 </group>;
}
function CampusMap({onPick}:{onPick:(id:BinId)=>void}) {
 return <group rotation={[-.06,0,0]}>
  <mesh receiveShadow rotation={[-Math.PI/2,0,0]} position={[0,-.12,0]}><planeGeometry args={[26,20]}/><meshStandardMaterial color="#a6bb96" roughness={1}/></mesh>
  {/* paths form a simple campus circulation network */}
  <mesh rotation={[-Math.PI/2,0,0]} position={[0,-.095,0]}><planeGeometry args={[1.1,18]}/><meshStandardMaterial color="#e6e0d1"/></mesh>
  <mesh rotation={[-Math.PI/2,0,0]} position={[-1,-.09,0]}><planeGeometry args={[17,.72]}/><meshStandardMaterial color="#e9e4d8"/></mesh>
  <mesh rotation={[-Math.PI/2,0,0]} position={[5,-.08,-1.4]}><planeGeometry args={[.8,14]}/><meshStandardMaterial color="#d9d5c9"/></mesh>
  <mesh rotation={[-Math.PI/2,0,0]} position={[-5,-.08,2]}><planeGeometry args={[.6,8]}/><meshStandardMaterial color="#e8e3d7"/></mesh>
  {/* water and its planted bank */}
  <mesh rotation={[-Math.PI/2,0,0]} position={[-8,-.045,-5]}><circleGeometry args={[3.05,48]}/><meshStandardMaterial color="#7eb7c2" roughness={.28} metalness={.08}/></mesh>
  <mesh rotation={[-Math.PI/2,0,0]} position={[-8,-.052,-5]}><ringGeometry args={[3.05,3.22,48]}/><meshStandardMaterial color="#c7d6be"/></mesh>
  {/* academic core */}
  <Building x={-4} z={-2} w={2.7} d={1.7} h={1.2}/><Building x={-1.5} z={-3.1} w={1.8} d={1.35} h={.82} color="#f2efe7"/>
  <Building x={1.9} z={-3} w={3.2} d={1.5} h={1.45} color="#e5e4dc"/><Building x={3.2} z={.4} w={2.2} d={2.2} h={1.05}/>
  <Building x={-3.8} z={1.4} w={2.1} d={2.6} h={.84} color="#e7e7e0"/><Building x={-.8} z={2.8} w={3} d={1.5} h={1.15}/>
  {/* residential zone */}
  <Building x={7} z={-4.6} w={2.1} d={1.4} h={.8} color="#f0eee6"/><Building x={9.3} z={-2.7} w={2.7} d={1.55} h={1.05}/>
  <Building x={7.2} z={-.8} w={2.4} d={1.8} h={.72}/><Building x={10} z={1} w={2.4} d={1.8} h={.88} color="#e7e4db"/>
  {[[ -7,2],[-6,5],[-3,5],[1,5],[5,4],[6,2],[5,-5],[2,0],[-6,-1],[8,3],[11,-5],[.2,-5]] .map(([x,z],i)=><Tree key={i} position={[x,.03,z]} scale={i%3===0?1.1:.85}/>) }
  <BinMarker id="bin-01" position={[1.2,.04,1.25]} onPick={onPick}/><BinMarker id="bin-02" position={[8.8,.04,-.9]} onPick={onPick}/>
  <ContactShadows position={[0,-.02,0]} opacity={.25} scale={28} blur={2.5} far={10}/>
 </group>;
}
function FocusControls(){const controls=useRef<any>(null);const destination=useRef<THREE.Vector3|null>(null);useFrame((_,delta)=>{if(controls.current&&destination.current){const c=controls.current;const shift=destination.current.clone().sub(c.target);c.target.lerp(destination.current,1-Math.exp(-3.8*delta));c.object.position.addScaledVector(shift,1-Math.exp(-3.8*delta));if(c.target.distanceTo(destination.current)<.035)destination.current=null;c.update();}});React.useEffect(()=>{const focus=(event:Event)=>{const [x,z]=(event as CustomEvent<[number,number]>).detail;destination.current=new THREE.Vector3(x,0,z)};const reset=()=>{destination.current=null;if(controls.current){controls.current.target.set(0,0,0);controls.current.object.position.set(15,18,21);controls.current.update();}};window.addEventListener('campus-focus',focus);window.addEventListener('campus-reset',reset);return()=>{window.removeEventListener('campus-focus',focus);window.removeEventListener('campus-reset',reset)}},[]);return <OrbitControls ref={controls} makeDefault target={[0,0,0]} minPolarAngle={.38} maxPolarAngle={1.2} minDistance={15} maxDistance={34} enableDamping dampingFactor={.06} rotateSpeed={.38}/>;}
function MapCanvas({onPick}:{onPick:(id:BinId)=>void}) { const select=(id:BinId)=>{const point:[number,number]=id==='bin-01'?[1.2,1.25]:[8.8,-.9];window.dispatchEvent(new CustomEvent('campus-focus',{detail:point}));onPick(id);};return <Canvas shadows dpr={[1,1.8]} gl={{antialias:true, alpha:false}} camera={{position:[15,18,21],fov:38}}><color attach="background" args={['#dce6df']}/><fog attach="fog" args={['#dce6df',28,55]}/><ambientLight intensity={1.15}/><directionalLight castShadow position={[-8,16,9]} intensity={2.2} shadow-mapSize={[2048,2048]}/><hemisphereLight args={['#f3fbff','#7a9473',.65]}/><CampusMap onPick={select}/><FocusControls/></Canvas>; }
export default function CampusScene() {
 const router=useRouter(); const [selected,setSelected]=useState<BinId|null>(null); const [failed,setFailed]=useState(false); const status=useBackendStatus();
 const pick=(id:BinId)=>{setSelected(id);window.setTimeout(()=>router.push(`/bins/${id}`),650);};
 return <main className="campus-shell">
  <div className="campus-canvas">{failed?<div className="webgl-fallback"><Leaf size={34}/><strong>EcoTwin campus</strong><p>3D rendering is unavailable in this browser. Try enabling WebGL to explore the campus.</p><button onClick={()=>setFailed(false)}>Try again</button></div>:<CanvasErrorFallback onError={()=>setFailed(true)}><MapCanvas onPick={pick}/></CanvasErrorFallback>}</div>
  <header className="home-header"><div className="brand-mark"><span className="brand-icon"><Leaf size={19}/></span><div><strong>EcoTwin</strong><small>Campus Digital Twin</small></div></div><div className="home-actions"><span className={`connection-pill ${status==='connected'?'is-connected':''}`}><i/>{status==='connected'?'Backend online':status==='checking'?'Connecting':'Backend offline'}</span><button className="icon-button" aria-label="Reset camera" title="Reset view" onClick={()=>window.dispatchEvent(new Event('campus-reset'))}><RotateCcw size={17}/></button></div></header>
  <div className="map-label map-label-core">ACADEMIC CORE</div><div className="map-label map-label-hostel">HOSTEL ZONE</div>
  <div className="home-legend"><span><i className="legend-dot green"/>Bin 01 <small>Main Campus</small></span><span><i className="legend-dot blue"/>Bin 02 <small>Hostel Zone</small></span></div>
  <div className="home-hint">{selected?<><LoaderCircle className="spin" size={15}/> Opening {BIN_INFO[selected].name}…</>:'Select a recycling bin to explore its live data.'}</div>
 </main>;
}

// A failed WebGL context reports through Canvas; this wrapper also catches construction errors.
function CanvasErrorFallback({children,onError}:{children:React.ReactNode;onError:()=>void}) { return <ErrorBoundary onError={onError}>{children}</ErrorBoundary>; }
import React from 'react';
class ErrorBoundary extends React.Component<{children:React.ReactNode;onError:()=>void},{failed:boolean}> { state={failed:false}; static getDerivedStateFromError(){return {failed:true};} componentDidCatch(){this.props.onError();} render(){return this.state.failed?null:this.props.children;} }
