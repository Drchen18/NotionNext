import { Interface } from 'ethers';
import { display } from './chains.js';

export const PANCAKE_ROUTER='0x10ED43C718714eb63d5aA57B78B54704E256024E';
const factoryAddress='0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const abi=new Interface(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)','function getPair(address,address) view returns(address)','function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)']);
export async function pancakeQuote(adapter, chain, side, amountRaw, snapshot) {
  const c=adapter.config(), v=c.bnb, from=side==='buy'?v.stable:v.token, to=side==='buy'?v.token:v.stable;
  const call=async(target,fn,args=[])=>abi.decodeFunctionResult(fn,await adapter.rpc.call('bnb','eth_call',[{to:target,data:abi.encodeFunctionData(fn,args)},'latest']));
  const [t0,t1,factory,reserves,pair]=await Promise.all([call(v.pool,'token0'),call(v.pool,'token1'),call(v.pool,'factory'),call(v.pool,'getReserves'),call(factoryAddress,'getPair',[from,to])]);
  const equal=(a,b)=>a.toLowerCase()===b.toLowerCase();
  if (!equal(factory[0],factoryAddress) || !equal(pair[0],v.pool) || ![t0[0],t1[0]].some(t=>equal(t,from)) || ![t0[0],t1[0]].some(t=>equal(t,to))) throw new Error('指定池必须是 PancakeSwap V2 的代币/计价币直接交易对；其他池请选择 OKX 路由');
  const [reserveIn,reserveOut]=equal(t0[0],from)?[reserves[0],reserves[1]]:[reserves[1],reserves[0]], input=BigInt(amountRaw);
  if (reserveIn<=0n || reserveOut<=0n || input<=0n) throw new Error('交易池储备不足');
  const afterFee=input*9975n, output=afterFee*reserveOut/(reserveIn*10000n+afterFee);
  if (output<=0n) throw new Error('输出数量低于最小精度');
  const minimum=output*BigInt(Math.floor((100-c.risk.maxSlippagePct)*10000))/1000000n;
  const route={venue:'PancakeSwap V2 · 指定池',pool:v.pool,tx:{to:PANCAKE_ROUTER,from:adapter.vault.publicWallet('bnb').address,value:'0',gas:'350000',data:abi.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens',[input,minimum,[from,to],adapter.vault.publicWallet('bnb').address,BigInt(Math.floor(Date.now()/1000)+120)])}};
  const gas=await adapter.chains.gas('bnb',route.tx,snapshot.bnb);
  return {chain:'bnb',side,amountRaw,outRaw:output.toString(),inDecimals:await adapter.chains.decimals('bnb',from),outDecimals:await adapter.chains.decimals('bnb',to),impact: Number(input)*100/Number(reserveIn+input),gas,route,spender:PANCAKE_ROUTER,at:new Date().toISOString(),fromToken:from,toToken:to};
}
