import { sleep, checkAbort } from './model.js';
import { httpStatus, retryAfterMs } from '../shared/http.js';
export class RetryCoordinator {
  constructor({now=Date.now,wait=sleep,random=Math.random,rateBaseMs=15000,transientBaseMs=100,
    maxRateRetries=1,maxTransientRetries=1,maxForbiddenRetries=1,forbiddenBaseMs=100}={}) {
    Object.assign(this,{now,wait,random,rateBaseMs,transientBaseMs,maxRateRetries,maxTransientRetries,maxForbiddenRetries,forbiddenBaseMs});
    this.until=0;this.last=null;this.listeners=new Set();this.gates=new Map();
  }
  subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener)}
  emit(){for(const listener of this.listeners)listener(this.info)}
  get info(){return this.until>this.now()?{...this.last,until:this.until}:null}
  restore(info){
    if(!info||info.scope==='local'||(info.status&&info.status!==429))return;
    if(info.rateKey){const old=this.gates.get(info.rateKey);if(!old||info.until>old.until)this.gates.set(info.rateKey,{...info});}
    else if(info.until>this.until){this.until=info.until;this.last={...info};}
    this.emit();
  }
  deferred(info={}){
    const error=new Error(info.status===429?'此下载地址正在冷却，本轮已跳过':'本项已达到 2 秒处理预算，本轮已跳过');
    Object.assign(error,{httpStatus:info.status||0,retryExhausted:true,retryUntil:info.until||this.now(),rateKey:info.rateKey});return error;
  }
  async ready(signal,{rateKey=null,deadline=Infinity}={}){
    while(true){
      checkAbort(signal);
      const info=rateKey?this.gates.get(rateKey):this.last;
      const until=rateKey?(info?.until||0):this.until,remaining=deadline-this.now();
      if(remaining<=0)throw this.deferred();
      if(until<=this.now()){
        if(rateKey)this.gates.delete(rateKey);
        else if(this.last){this.last=null;this.until=0;this.emit()}
        return;
      }
      if(until-this.now()>=remaining)throw this.deferred(info);
      await this.wait(Math.min(60000,until-this.now(),remaining),signal);
    }
  }
  async run(operation,{signal,onRetry,label='请求',retryForbidden=false,maxRetries=Infinity,deadline=Infinity,rateKey=null}={}){
    for(let attempt=0;;attempt++){
      await this.ready(signal,{rateKey,deadline});
      try{return await operation()}
      catch(error){
        checkAbort(signal);
        const status=httpStatus(error),rate=status===429,forbidden=retryForbidden&&status===403;
        const transient=error.retryable===true||[408,425,500,502,503,504].includes(status)||(!status&&/Failed to fetch|network(?:\s*error)?|connection (?:reset|closed|aborted)|网络|超时|timed out|fetch failed/i.test(error.message||''));
        if(!rate&&!forbidden&&!transient)throw error;
        const max=Math.min(maxRetries,rate?this.maxRateRetries:forbidden?this.maxForbiddenRetries:this.maxTransientRetries);
        const base=(rate?this.rateBaseMs:forbidden?this.forbiddenBaseMs:this.transientBaseMs)*2**Math.min(attempt,5);
        const serverDelay=retryAfterMs(error.retryAfter,this.now());
        const delay=Math.max(serverDelay,Math.min(base,rate?300000:30000)*(1+this.random()*.2));
        const exhausted=attempt>=max||delay>=deadline-this.now();
        const previous=rateKey?(this.gates.get(rateKey)?.until||0):this.until;
        const until=rate?Math.max(previous,this.now()+Math.ceil(delay)):this.now()+(exhausted?0:Math.ceil(delay));
        const info={until,status,attempt:attempt+1,maxRetries:max,label,scope:rate?(rateKey?'host':'global'):'local',rateKey,
          reason:rate?'HTTP 429 限流':forbidden?'媒体暂不可访问，稍后重试':'暂时性请求失败',exhausted};
        if(rate){if(rateKey)this.gates.set(rateKey,info);else{this.until=until;this.last=info}this.emit()}
        await onRetry?.(info);
        if(exhausted){Object.assign(error,{retryExhausted:true,retryUntil:until,rateKey});error.message+='；本轮已暂缓';throw error}
        if(!rate)await this.wait(Math.min(delay,Math.max(0,deadline-this.now())),signal);
      }
    }
  }
}
