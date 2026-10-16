'use client';
import { useEffect, useState } from 'react';
import { getHealth } from '@/lib/api';
export type BackendStatus='checking'|'connected'|'offline';
export function useBackendStatus(){ const [status,setStatus]=useState<BackendStatus>('checking'); useEffect(()=>{let active=true; const check=()=>getHealth().then(()=>{if(active)setStatus('connected')}).catch(()=>{if(active)setStatus('offline')});check();const timer=window.setInterval(check,20000);return()=>{active=false;window.clearInterval(timer)}},[]);return status; }
