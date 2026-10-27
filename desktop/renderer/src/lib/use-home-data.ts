import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { errorMessage, updateQueryData, usePoll } from '../hooks';
import type { AccountPolicyResponse } from '../types';
import type { HomeBindingsResponse } from './home-presentation';
import { useDraftProtection } from '../components/DraftProtectionProvider';

type Operation = { accountId: string; generation: number; busy: boolean; uncertain?: boolean; error?: string; notice?: string };
export function useHomeData(accountId: string | undefined) {
  const path = accountId ? `/accounts/${encodeURIComponent(accountId)}/policy` : null;
  const policy = usePoll<AccountPolicyResponse>(path,8000,true);
  const bindings = usePoll<HomeBindingsResponse>(accountId ? `/accounts/${encodeURIComponent(accountId)}/role-bindings` : null,10000,true);
  const [operation,setOperation] = useState<Operation>();
  const epoch = useRef({ accountId, generation: 0 });
  if (epoch.current.accountId !== accountId) epoch.current = { accountId, generation: epoch.current.generation + 1 };
  const mounted = useRef(true);
  const job = useRef<{ accountId: string; controller: AbortController; generation: number } | undefined>(undefined);
  const { registry } = useDraftProtection();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; job.current?.controller.abort(); };
  }, []);
  useEffect(() => registry.register({ id: 'home-agent-operation', owner: 'page', getSnapshot: () => ({
    label: '主页自动回复状态', accountId: job.current?.accountId, dirty: false, busy: Boolean(job.current), revision: 0, discard: () => {}
  }) }), [registry]);
  useEffect(() => () => { if(job.current?.accountId===accountId){job.current?.controller.abort();job.current=undefined;} }, [accountId]);
  const activeOperation = operation && operation.accountId === accountId && operation.generation===epoch.current.generation ? operation : undefined;
  const release = (id:string,generation:number) => { if(job.current?.generation===generation&&job.current.accountId===id)job.current=undefined; };
  const current = (id: string, generation: number) => mounted.current && epoch.current.accountId === id && epoch.current.generation === generation;
  const request = async (id: string, generation: number, target: string, init?: RequestInit) => {
    const controller = new AbortController();
    job.current = { accountId: id, generation, controller };
    const timeout = setTimeout(() => controller.abort(),12000);
    try {
      const response=await api<AccountPolicyResponse>(target,{ ...init, signal: controller.signal });
      if(!response?.policy || (response.policy.agentEnabled!==undefined&&typeof response.policy.agentEnabled!=='boolean'))throw new Error('账号策略返回格式无效');
      return response;
    }
    finally { clearTimeout(timeout); }
  };
  const reloadPolicy = async (): Promise<void> => {
    if (!accountId || !path || job.current) return;
    const id = accountId, generation = epoch.current.generation;
    setOperation({ accountId:id,generation,busy:true,uncertain:activeOperation?.uncertain });
    try {
      const response = await request(id,generation,path);
      if (current(id,generation)) { updateQueryData(path,response); setOperation({accountId:id,generation,busy:false}); }
    } catch(error) { if (current(id,generation)) setOperation({accountId:id,generation,busy:false,uncertain:true,error:errorMessage(error)}); }
    finally { release(id,generation); }
  };
  const setAgent = async (enabled: boolean): Promise<void> => {
    if (!accountId || !path || !policy.data?.policy || policy.error || activeOperation?.uncertain || job.current) return;
    const id = accountId, generation = epoch.current.generation;
    setOperation({ accountId:id,generation,busy:true });
    try {
      const response = await request(id,generation,`/accounts/${encodeURIComponent(id)}/agent`,{method:'POST',body:JSON.stringify({enabled})});
      if (current(id,generation)) { updateQueryData(path,response); setOperation({accountId:id,generation,busy:false,notice:enabled?'账号自动回复已开启，按各会话规则生效。':'账号自动回复已暂停；QQ 连接继续保留。'}); }
    } catch(error) {
      if (!current(id,generation)) return;
      const unknown=!(error instanceof ApiError)||error.status===0||error.status>=500;
      setOperation({accountId:id,generation,busy:true,uncertain:true,error:`操作结果待核对：${errorMessage(error)}`});
      try {
        const response = await request(id,generation,path);
        if (current(id,generation)) { updateQueryData(path,response); setOperation({accountId:id,generation,busy:false,uncertain:unknown,error:`操作未确认成功，已回读当前状态${unknown?'；请再次读取核对后再操作':''}：${errorMessage(error)}`}); }
      } catch { if (current(id,generation)) setOperation({accountId:id,generation,busy:false,uncertain:true,error:'操作结果尚未确认，请重新读取状态后再操作。'}); }
    } finally { release(id,generation); }
  };
  return { policy, bindings, operation:activeOperation, setAgent, reloadPolicy };
}
