'use client';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows } from '@react-three/drei/core/ContactShadows';
import { OrbitControls } from '@react-three/drei/core/OrbitControls';
import { Text } from '@react-three/drei/core/Text';
import { useRef } from 'react';
import * as THREE from 'three';
import type { BinCapacity, BinId } from '@/lib/types';
import { BIN_INFO } from '@/lib/types';

function SmartBinModel({id,capacity,stale}:{id:BinId;capacity:BinCapacity|null;stale:boolean}){const group=useRef<THREE.Group>(null);const info=BIN_INFO[id];useFrame((state,delta)=>{if(group.current)group.current.rotation.y+=delta*.12;});return <group ref={group}>
 <mesh castShadow receiveShadow position={[0,1.35,0]}><boxGeometry args={[1.7,2.5,1.25]}/><meshStandardMaterial color="#d9e2dc" roughness={.38} metalness={.12}/></mesh>
 <mesh castShadow position={[0,2.62,0]}><boxGeometry args={[1.84,.22,1.38]}/><meshStandardMaterial color={info.accent} roughness={.34} metalness={.22}/></mesh>
 <mesh position={[0,2.745,0]}><boxGeometry args={[.72,.035,.72]}/><meshStandardMaterial color="#152b27"/></mesh>
 <mesh position={[0,2.78,0]}><boxGeometry args={[.44,.018,.5]}/><meshStandardMaterial color="#070f0d"/></mesh>
 {/* front inset panel */}<mesh position={[0,1.55,.635]}><boxGeometry args={[.9,.82,.045]}/><meshStandardMaterial color="#263d37" metalness={.25} roughness={.4}/></mesh>
 <mesh position={[0,1.68,.67]}><planeGeometry args={[.68,.48]}/><meshStandardMaterial color="#15302a" emissive="#163a31" emissiveIntensity={.32}/></mesh>
 <Text position={[0,1.77,.697]} fontSize={.095} color="#a7e4c1" anchorX="center" anchorY="middle">ECOTWIN • SMART BIN</Text>
 <Text position={[0,1.59,.698]} fontSize={.12} color="white" anchorX="center" anchorY="middle">{id.toUpperCase()} · {capacity?`${Math.round(capacity.capacity_percentage)}%`:'—'}</Text>
 <Text position={[0,1.48,.698]} fontSize={.05} color="#a7e4c1" anchorX="center" anchorY="middle">{capacity?`${capacity.current_fill_liters.toFixed(1)}/${capacity.capacity_liters.toFixed(0)} L · ${stale?'STALE':capacity.status}`:'CAPACITY UNAVAILABLE'}</Text>
 <mesh position={[0,1.31,.698]}><sphereGeometry args={[.055,20,16]}/><meshStandardMaterial color="#7ee1a8" emissive="#49d98b" emissiveIntensity={2.2}/></mesh>
 <Text position={[0,.72,.64]} fontSize={.48} color={info.accent} anchorX="center" anchorY="middle">♻</Text>
 {[-.59,.59].map((x)=><mesh key={x} castShadow position={[x,.12,0]}><cylinderGeometry args={[.09,.09,.18,16]}/><meshStandardMaterial color="#43554f"/></mesh>)}
 <mesh receiveShadow rotation={[-Math.PI/2,0,0]} position={[0,.015,0]}><circleGeometry args={[1.65,48]}/><meshStandardMaterial color={info.color} transparent opacity={.08}/></mesh>
 </group>}
export default function BinScene({id,capacity,stale=false}:{id:BinId;capacity:BinCapacity|null;stale?:boolean}){return <Canvas shadows dpr={[1,1.8]} camera={{position:[4.7,3.6,6.8],fov:38}}><color attach="background" args={['#e7eee8']}/><ambientLight intensity={1.2}/><directionalLight castShadow position={[-4,8,5]} intensity={2.1} shadow-mapSize={[2048,2048]}/><directionalLight position={[4,4,-5]} intensity={.55} color="#d9eadd"/><mesh receiveShadow rotation={[-Math.PI/2,0,0]} position={[0,-.04,0]}><planeGeometry args={[200,200]}/><meshStandardMaterial color="#e7eee8"/></mesh><SmartBinModel id={id} capacity={capacity} stale={stale}/><ContactShadows position={[0,-.02,0]} scale={7} opacity={.22} blur={2}/><OrbitControls makeDefault target={[0,1.2,0]} minDistance={4.3} maxDistance={9} minPolarAngle={.55} maxPolarAngle={1.35} enablePan={false} enableDamping/></Canvas>}
