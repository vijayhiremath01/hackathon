import BinDashboard from '@/components/BinDashboard';
export default async function BinPage({params}:{params:Promise<{binId:string}>}){const {binId}=await params;return <BinDashboard binId={binId}/>;}
